"""FastAPI router for normativa document ingestion."""

from __future__ import annotations

import logging
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, Form, UploadFile
from fastapi.responses import JSONResponse

from backend.normativa.models import NormDocMetadata, NormDocument
from backend.normativa.graph import run_ingestion
from backend.normativa.vectorstore import (
    delete_document, get_chunks, get_chunks_l2, get_doc_stats,
    list_stored_documents, retrieve_chunks_l2, update_doc_metadata,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/normativa", tags=["normativa"])

# In-memory store (rebuilt from Qdrant on startup)
norm_documents: dict[str, NormDocument] = {}


def _rebuild_from_qdrant() -> None:
    """Rebuild norm_documents from Qdrant so documents survive server restarts."""
    try:
        stored = list_stored_documents()
        for sd in stored:
            doc_id = sd["doc_id"]
            norm_documents[doc_id] = NormDocument(
                id=doc_id,
                filename=sd.get("nome_legge", doc_id),
                uploaded_at="",
                status="done",
                progress="Completato",
                metadata=NormDocMetadata(
                    nome_legge=sd.get("nome_legge", ""),
                    titolo_esteso=sd.get("titolo_esteso", ""),
                    data_inizio_validita=sd.get("data_inizio_validita"),
                    data_fine_validita=sd.get("data_fine_validita"),
                ),
                chunk_count=sd.get("chunk_count", 0),
            )
        if stored:
            logger.info("Rebuilt %d documents from Qdrant", len(stored))
    except Exception:
        logger.exception("Failed to rebuild documents from Qdrant")


_rebuild_from_qdrant()


def _run_ingestion_background(
    doc_id: str, pdf_path: str, doc_metadata: dict
) -> None:
    """Background task: runs the full ingestion pipeline."""
    doc = norm_documents.get(doc_id)
    if not doc:
        return

    def update_status(status: str):
        doc.progress = status
        logger.info("[Normativa %s] %s", doc_id, status)

    try:
        result = run_ingestion(
            pdf_path, doc_id,
            doc_metadata=doc_metadata,
            status_callback=update_status,
        )
        doc.metadata = NormDocMetadata(**result["doc_metadata"])
        doc.chunk_count = result["chunk_count"]
        doc.status = "done"
        doc.progress = "Completato"
        logger.info("[Normativa %s] Ingestion done: %d chunks", doc_id, doc.chunk_count)
    except Exception as e:
        doc.status = "error"
        doc.error = str(e)
        doc.progress = "Errore"
        logger.exception("[Normativa %s] Ingestion failed", doc_id)
    finally:
        Path(pdf_path).unlink(missing_ok=True)


@router.post("/upload")
async def upload_norm(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    nome_legge: str = Form(...),
    titolo_esteso: str = Form(""),
    data_inizio_validita: str = Form(""),
    data_fine_validita: str = Form(""),
):
    filename = file.filename or "norma.pdf"
    suffix = Path(filename).suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    # Build metadata from user input
    doc_metadata = {
        "nome_legge": nome_legge.strip(),
        "titolo_esteso": titolo_esteso.strip(),
        "data_inizio_validita": data_inizio_validita.strip() or None,
        "data_fine_validita": data_fine_validita.strip() or None,
        "keywords": [],
    }

    doc_id = uuid.uuid4().hex[:8]
    doc = NormDocument(
        id=doc_id,
        filename=filename,
        uploaded_at=datetime.now().isoformat(timespec="seconds"),
        status="processing",
        progress="In coda...",
        metadata=NormDocMetadata(**doc_metadata),
    )
    norm_documents[doc_id] = doc

    background_tasks.add_task(
        _run_ingestion_background, doc_id, tmp_path, doc_metadata
    )
    return doc.model_dump()


@router.get("/documents")
async def list_documents():
    # Get stats from Qdrant in one pass (efficient)
    stored = {s["doc_id"]: s for s in list_stored_documents()}

    docs = []
    for d in norm_documents.values():
        st = stored.get(d.id, {})
        docs.append({
            "id": d.id,
            "filename": d.filename,
            "uploaded_at": d.uploaded_at,
            "status": d.status,
            "nome_legge": d.metadata.nome_legge if d.metadata else None,
            "chunk_count": d.chunk_count,
            "total_chars": st.get("total_chars", 0),
            "page_min": st.get("page_min"),
            "page_max": st.get("page_max"),
        })
    return docs


@router.get("/documents/{doc_id}")
async def get_document(doc_id: str):
    doc = norm_documents.get(doc_id)
    if not doc:
        return JSONResponse({"error": "not found"}, status_code=404)
    return doc.model_dump()


@router.patch("/documents/{doc_id}/metadata")
async def patch_metadata(doc_id: str, body: dict):
    """Update document metadata and propagate to all chunks in Qdrant."""
    doc = norm_documents.get(doc_id)
    if not doc:
        return JSONResponse({"error": "not found"}, status_code=404)

    # Update in-memory document
    if doc.metadata is None:
        doc.metadata = NormDocMetadata(nome_legge=body.get("nome_legge", ""))
    for field in ("nome_legge", "titolo_esteso", "data_inizio_validita", "data_fine_validita"):
        if field in body:
            val = body[field]
            if field.startswith("data_") and not val:
                val = None
            setattr(doc.metadata, field, val)

    # Also update hierarchy_path on chunks if nome_legge changed
    updated = update_doc_metadata(doc_id, body)
    logger.info("[Normativa %s] Metadata updated, %d chunks patched", doc_id, updated)
    return {"ok": True, "chunks_updated": updated}


@router.get("/documents/{doc_id}/status")
async def get_document_status(doc_id: str):
    doc = norm_documents.get(doc_id)
    if not doc:
        return JSONResponse({"error": "not found"}, status_code=404)
    return {
        "status": doc.status,
        "progress": doc.progress,
        "error": doc.error,
        "chunk_count": doc.chunk_count,
    }


@router.get("/chunks")
async def list_chunks(
    doc_id: str | None = None,
    keyword: str | None = None,
    chunk_index: int | None = None,
    limit: int = 200,
    offset: int = 0,
):
    """Browse chunks with optional doc_id, keyword and chunk_index filters."""
    chunks = get_chunks(
        doc_id=doc_id, keyword=keyword, chunk_index=chunk_index,
        limit=limit, offset=offset,
    )
    return {"chunks": chunks, "count": len(chunks)}


@router.get("/chunks_l2")
async def list_chunks_l2(
    doc_id: str,
    parent_chunk_index: int | None = None,
    limit: int = 200,
    offset: int = 0,
):
    """Browse L2 sub-chunks for a document, optionally filtered by parent L1 chunk."""
    chunks = get_chunks_l2(
        doc_id=doc_id, parent_chunk_index=parent_chunk_index,
        limit=limit, offset=offset,
    )
    return {"chunks": chunks, "count": len(chunks)}


@router.post("/retrieve")
async def retrieve(
    query: str = Form(...),
    mode: str = Form("hybrid"),
    k: int = Form(10),
    score_threshold: float | None = Form(None),
    doc_id: str | None = Form(None),
):
    """Semantic retrieve on L2 sub-chunks. Modes: vector, bm25, hybrid."""
    if mode not in ("vector", "bm25", "hybrid"):
        return JSONResponse(status_code=400, content={"error": f"Invalid mode: {mode}"})
    if k < 1 or k > 100:
        return JSONResponse(status_code=400, content={"error": "k must be 1-100"})

    results = retrieve_chunks_l2(
        query=query, mode=mode, k=k,
        score_threshold=score_threshold if score_threshold and score_threshold > 0 else None,
        doc_id=doc_id if doc_id else None,
    )
    return {"results": results, "count": len(results), "mode": mode, "k": k}


@router.delete("/documents/{doc_id}")
async def remove_document(doc_id: str):
    # Delete from Qdrant even if not in memory (handles rebuilt docs)
    delete_document(doc_id)
    norm_documents.pop(doc_id, None)
    return {"ok": True}
