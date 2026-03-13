"""FastAPI app: POST /analyze + entity extraction + file storage + dashboard."""

from __future__ import annotations

import mimetypes
import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import json

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from backend.graph import run_extraction
from backend.entity_extraction import extract_entities_from_files
from backend.normativa.api import router as normativa_router
from backend.normativa.chat_api import router as chat_router

BASE_DIR = Path(__file__).resolve().parent.parent
UPLOADS_DIR = BASE_DIR / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Fire Safety Analyzer")
app.include_router(normativa_router)
app.include_router(chat_router)

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

# In-memory store: {id: {id, filename, timestamp, result}}
analyses: dict[str, dict] = {}


def _save_upload(file_data: bytes, filename: str) -> tuple[str, str]:
    """Save file to uploads dir. Returns (file_id, url)."""
    file_id = uuid.uuid4().hex[:12]
    safe_name = f"{file_id}_{filename}"
    (UPLOADS_DIR / safe_name).write_bytes(file_data)
    return file_id, f"/uploads/{file_id}/{filename}"


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/upload-file")
async def upload_file(file: UploadFile = File(...)):
    """Upload a file and persist it. Returns file_id and URL."""
    filename = file.filename or "file"
    file_data = await file.read()
    file_id, url = _save_upload(file_data, filename)
    return {"file_id": file_id, "filename": filename, "url": url}


@app.get("/uploads/{file_id}/{filename}")
async def serve_upload(file_id: str, filename: str):
    """Serve a previously uploaded file."""
    matches = list(UPLOADS_DIR.glob(f"{file_id}_*"))
    if not matches:
        return JSONResponse({"error": "not found"}, status_code=404)
    file_path = matches[0]
    content_type, _ = mimetypes.guess_type(str(file_path))
    return FileResponse(
        file_path,
        media_type=content_type or "application/octet-stream",
        filename=filename,
    )


@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    filename = file.filename or "upload.pdf"
    file_data = await file.read()

    # Persist the original file
    file_id, file_url = _save_upload(file_data, filename)

    # Write to temp for extraction
    suffix = Path(filename).suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(file_data)
        tmp_path = tmp.name

    result = run_extraction(tmp_path)
    Path(tmp_path).unlink(missing_ok=True)

    doc_id = uuid.uuid4().hex[:8]
    entry = {
        "id": doc_id,
        "filename": filename,
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "result": result.model_dump(),
        "file_url": file_url,
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
        return JSONResponse({"error": "not found"}, status_code=404)
    return analyses[doc_id]


@app.get("/analyses/{doc_id}/export")
async def export_analysis(doc_id: str):
    if doc_id not in analyses:
        return JSONResponse({"error": "not found"}, status_code=404)
    entry = analyses[doc_id]
    export_tpl = templates.get_template("export.html")
    html_content = export_tpl.render(
        filename=entry["filename"],
        timestamp=entry["timestamp"],
    )
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
