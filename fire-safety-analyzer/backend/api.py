"""FastAPI app: POST /analyze + entity extraction + multi-document storage + dashboard."""

from __future__ import annotations

import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import json

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from backend.graph import run_extraction
from backend.entity_extraction import extract_entities_from_files
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


@app.post("/extract-entities")
async def extract_entities(
    extraction_schema: str = Form(..., alias="schema"),
    files: list[UploadFile] = File(...),
):
    """Extract custom entities from multiple files (PDF/images).

    - schema: JSON array of [{nome, descrizione}, ...]
    - files: one or more PDF/JPEG/PNG files
    """
    try:
        schema_list = json.loads(extraction_schema)
    except json.JSONDecodeError:
        return JSONResponse({"error": "Schema JSON non valido"}, status_code=400)

    if not schema_list:
        return JSONResponse({"error": "Schema vuoto"}, status_code=400)

    # Save uploaded files to temp dir
    tmp_paths: list[str] = []
    file_names: list[str] = []
    mime_types: list[str] = []

    try:
        for f in files:
            filename = f.filename or "file"
            suffix = Path(filename).suffix or ".bin"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(await f.read())
                tmp_paths.append(tmp.name)
            file_names.append(filename)
            mime_types.append(f.content_type or "application/octet-stream")

        entities = extract_entities_from_files(
            file_paths=tmp_paths,
            file_names=file_names,
            mime_types=mime_types,
            schema=schema_list,
        )
        return {"entities": entities}

    finally:
        for p in tmp_paths:
            Path(p).unlink(missing_ok=True)
