"""FastAPI app: POST /analyze + multi-document storage + dashboard."""

from __future__ import annotations

import tempfile
import uuid
from datetime import datetime
from pathlib import Path

import json

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from backend.graph import run_extraction
from backend.normativa.api import router as normativa_router
from backend.normativa.chat_api import router as chat_router

BASE_DIR = Path(__file__).resolve().parent.parent
app = FastAPI(title="Fire Safety Analyzer")
app.include_router(normativa_router)
app.include_router(chat_router)

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

# In-memory store: {id: {id, filename, timestamp, result}}
analyses: dict[str, dict] = {}


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    filename = file.filename or "upload.pdf"
    suffix = Path(filename).suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    result = run_extraction(tmp_path)
    Path(tmp_path).unlink(missing_ok=True)

    doc_id = uuid.uuid4().hex[:8]
    entry = {
        "id": doc_id,
        "filename": filename,
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "result": result.model_dump(),
    }
    analyses[doc_id] = entry
    return entry


@app.get("/analyses")
async def list_analyses():
    return [
        {"id": a["id"], "filename": a["filename"], "timestamp": a["timestamp"]}
        for a in analyses.values()
    ]


@app.get("/analyses/{doc_id}")
async def get_analysis(doc_id: str):
    if doc_id not in analyses:
        from fastapi.responses import JSONResponse
        return JSONResponse({"error": "not found"}, status_code=404)
    return analyses[doc_id]


@app.get("/analyses/{doc_id}/export")
async def export_analysis(doc_id: str):
    if doc_id not in analyses:
        from fastapi.responses import JSONResponse
        return JSONResponse({"error": "not found"}, status_code=404)
    entry = analyses[doc_id]
    export_tpl = templates.get_template("export.html")
    html_content = export_tpl.render(
        filename=entry["filename"],
        timestamp=entry["timestamp"],
    )
    # Replace placeholder inside {% raw %} block (Jinja2 won't process it)
    data_json = json.dumps(entry["result"], ensure_ascii=False)
    html_content = html_content.replace("{{ DATA_PLACEHOLDER }}", data_json)
    safe_name = Path(entry["filename"]).stem + "_report.html"
    return HTMLResponse(
        content=html_content,
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
    )
