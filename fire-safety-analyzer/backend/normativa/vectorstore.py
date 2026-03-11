"""Qdrant vector store: init, upsert, delete for normativa chunks."""

from __future__ import annotations

import logging
import math
import os
import uuid
from collections import Counter
from pathlib import Path

from openai import OpenAI
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    NamedSparseVector,
    NamedVector,
    PointStruct,
    SparseVector,
    SparseVectorParams,
    VectorParams,
)

from backend.normativa.models import NormChunk, NormChunkL2, NormDocMetadata

logger = logging.getLogger(__name__)

COLLECTION = "normativa_antincendio"
COLLECTION_L2 = "normativa_antincendio_l2"
DENSE_DIM = 1536  # text-embedding-3-small
EMBED_MODEL = "text-embedding-3-small"
QDRANT_PATH = Path(__file__).resolve().parent.parent.parent / "qdrant_data"

# ── Italian stopwords (compact set) ──────────────────────────────
_STOPWORDS = frozenset(
    "il lo la i gli le un uno una di del dello della dei degli delle "
    "a al allo alla ai agli alle da dal dallo dalla dai dagli dalle "
    "in nel nello nella nei negli nelle con su sul sullo sulla sui sugli sulle "
    "per tra fra e o ma che chi cui non né se come più anche solo dove quando "
    "già mai sempre ancora molto poco tutto tutti questa questo questi queste "
    "quello quella quelli quelle essere è sono era erano stato stati essere "
    "avere ha hanno aveva avevano avuto fare fa fanno si no sì "
    "sono stata delle degli dalla nella delle loro suo sua suoi sue "
    "ad ed al del nel dal sul col pel "
    "ogni altro altra altri altre quale quali alcuno alcuna alcuni alcune "
    "ciascuno ciascuna nessuno nessuna tale tali certo certa certi certe "
    "proprio propria propri proprie stesso stessa stessi stesse".split()
)


_qdrant_client: QdrantClient | None = None


def _get_client() -> QdrantClient:
    global _qdrant_client
    if _qdrant_client is None:
        QDRANT_PATH.mkdir(parents=True, exist_ok=True)
        _qdrant_client = QdrantClient(path=str(QDRANT_PATH))
    return _qdrant_client


def _get_openai() -> OpenAI:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY non impostata")
    return OpenAI(api_key=api_key)


def init_collection() -> None:
    """Create collection if it doesn't exist."""
    qc = _get_client()
    if qc.collection_exists(COLLECTION):
        # singleton client — do not close
        return
    qc.create_collection(
        collection_name=COLLECTION,
        vectors_config={
            "dense": VectorParams(size=DENSE_DIM, distance=Distance.COSINE),
        },
        sparse_vectors_config={
            "bm25": SparseVectorParams(),
        },
    )
    logger.info("Created Qdrant collection '%s'", COLLECTION)
    # singleton client — do not close


# ── BM25 sparse vector ──────────────────────────────────────────

def _tokenize(text: str) -> list[str]:
    tokens = []
    for word in text.lower().split():
        clean = "".join(c for c in word if c.isalnum())
        if clean and clean not in _STOPWORDS and len(clean) > 1:
            tokens.append(clean)
    return tokens


def _compute_sparse(text: str) -> SparseVector:
    """Build a BM25-style sparse vector from text."""
    tokens = _tokenize(text)
    if not tokens:
        return SparseVector(indices=[0], values=[0.0])
    counts = Counter(tokens)
    total = len(tokens)
    indices = []
    values = []
    for token, count in counts.items():
        # Use hash as index (Qdrant sparse vectors use uint32 indices)
        idx = hash(token) % (2**31)
        tf = count / total
        # Simple TF weighting with sublinear scaling
        weight = 1.0 + math.log(1.0 + tf)
        indices.append(idx)
        values.append(weight)
    return SparseVector(indices=indices, values=values)


# ── Embedding ────────────────────────────────────────────────────

_EMBED_MAX_CHARS = 24000  # Italian ≈ 3.4 chars/token → ~7000 tokens, under 8192


def _embed_texts(texts: list[str]) -> list[list[float]]:
    """Batch embed texts via OpenAI."""
    client = _get_openai()
    # Truncate any text that could exceed the 8192-token model limit
    safe_texts = []
    for t in texts:
        if len(t) > _EMBED_MAX_CHARS:
            logger.warning(
                "[Embedding] Truncating text from %d to %d chars", len(t), _EMBED_MAX_CHARS,
            )
            safe_texts.append(t[:_EMBED_MAX_CHARS])
        else:
            safe_texts.append(t)

    # OpenAI allows max 2048 inputs per call; chunk if needed
    all_embeddings: list[list[float]] = []
    batch_size = 512
    for i in range(0, len(safe_texts), batch_size):
        batch = safe_texts[i : i + batch_size]
        resp = client.embeddings.create(model=EMBED_MODEL, input=batch)
        all_embeddings.extend([d.embedding for d in resp.data])
        logger.info(
            "[Embedding] batch %d-%d: %d tokens",
            i, i + len(batch), resp.usage.total_tokens,
        )
    return all_embeddings


# ── Upsert & Delete ─────────────────────────────────────────────

def upsert_chunks(
    doc_id: str,
    chunks: list[NormChunk],
    metadata: NormDocMetadata,
    skip_embeddings: bool = True,
) -> int:
    """Store chunks in Qdrant. Embeddings are skipped for level-1 chunks."""
    if not chunks:
        return 0

    init_collection()

    # For level-1 chunks: use dummy vectors (text too large for embedding model).
    # Embeddings will be enabled for level-2 chunks later.
    if skip_embeddings:
        dummy_dense = [0.0] * DENSE_DIM
        dummy_sparse = SparseVector(indices=[0], values=[0.0])
        logger.info("Skipping embeddings for %d chunks (level-1)", len(chunks))
    else:
        texts = [c.text for c in chunks]
        embeddings = _embed_texts(texts)

    points = []
    for i, chunk in enumerate(chunks):
        point_id = str(uuid.uuid4())
        payload = {
            "doc_id": doc_id,
            "chunk_index": chunk.chunk_index,
            "text": chunk.text,
            "annotated_text": chunk.annotated_text,
            "hierarchy_path": chunk.hierarchy_path,
            "page_start": chunk.page_start,
            "page_end": chunk.page_end,
            "nome_legge": metadata.nome_legge,
            "titolo_esteso": metadata.titolo_esteso,
            "data_inizio_validita": metadata.data_inizio_validita,
            "data_fine_validita": metadata.data_fine_validita,
            "keywords": metadata.keywords,
        }
        dense_vec = dummy_dense if skip_embeddings else embeddings[i]
        sparse_vec = dummy_sparse if skip_embeddings else _compute_sparse(chunk.text)
        points.append(PointStruct(
            id=point_id,
            vector={
                "dense": dense_vec,
                "bm25": sparse_vec,
            },
            payload=payload,
        ))

    qc = _get_client()
    # Upsert in batches of 100
    batch_size = 100
    for i in range(0, len(points), batch_size):
        batch = points[i : i + batch_size]
        qc.upsert(
            collection_name=COLLECTION,
            points=batch,
        )
        logger.info(
            "[Qdrant] Upserted batch %d-%d (%d points) for doc '%s'",
            i, i + len(batch), len(batch), doc_id,
        )
    logger.info("[Qdrant] Total upserted: %d chunks for doc '%s'", len(points), doc_id)
    # singleton client — do not close
    return len(points)


def get_chunks(
    doc_id: str | None = None,
    keyword: str | None = None,
    chunk_index: int | None = None,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    """Retrieve chunks from Qdrant with optional filters. Returns payload dicts."""
    from qdrant_client.models import Filter, FieldCondition, MatchValue, MatchText

    qc = _get_client()
    if not qc.collection_exists(COLLECTION):
        # singleton client — do not close
        return []

    must_conditions = []
    if doc_id:
        must_conditions.append(
            FieldCondition(key="doc_id", match=MatchValue(value=doc_id))
        )
    if chunk_index is not None:
        must_conditions.append(
            FieldCondition(key="chunk_index", match=MatchValue(value=chunk_index))
        )
    if keyword:
        must_conditions.append(
            FieldCondition(key="text", match=MatchText(text=keyword))
        )

    scroll_filter = Filter(must=must_conditions) if must_conditions else None

    results, _next = qc.scroll(
        collection_name=COLLECTION,
        scroll_filter=scroll_filter,
        limit=limit,
        offset=offset,
        with_payload=True,
        with_vectors=False,
    )
    # singleton client — do not close

    chunks = []
    for point in results:
        p = point.payload or {}
        chunks.append(p)

    # Sort by doc_id then chunk_index
    chunks.sort(key=lambda c: (c.get("doc_id", ""), c.get("chunk_index", 0)))
    return chunks


def list_stored_documents() -> list[dict]:
    """Scan Qdrant and return unique documents with their metadata.

    Returns list of dicts with: doc_id, nome_legge, titolo_esteso,
    data_inizio_validita, data_fine_validita, chunk_count, total_chars.
    """
    qc = _get_client()
    if not qc.collection_exists(COLLECTION):
        # singleton client — do not close
        return []

    # Scroll all points, fetching only metadata fields
    all_points = []
    offset = None
    while True:
        results, next_offset = qc.scroll(
            collection_name=COLLECTION,
            limit=500,
            offset=offset,
            with_payload=["doc_id", "nome_legge", "titolo_esteso",
                          "data_inizio_validita", "data_fine_validita",
                          "text", "page_start", "page_end"],
            with_vectors=False,
        )
        all_points.extend(results)
        if next_offset is None:
            break
        offset = next_offset

    # singleton client — do not close

    # Group by doc_id
    docs: dict[str, dict] = {}
    for p in all_points:
        pl = p.payload or {}
        did = pl.get("doc_id", "")
        if not did:
            continue
        if did not in docs:
            docs[did] = {
                "doc_id": did,
                "nome_legge": pl.get("nome_legge", ""),
                "titolo_esteso": pl.get("titolo_esteso", ""),
                "data_inizio_validita": pl.get("data_inizio_validita"),
                "data_fine_validita": pl.get("data_fine_validita"),
                "chunk_count": 0,
                "total_chars": 0,
                "page_min": None,
                "page_max": None,
            }
        docs[did]["chunk_count"] += 1
        docs[did]["total_chars"] += len(pl.get("text", ""))
        ps = pl.get("page_start")
        pe = pl.get("page_end")
        if ps is not None:
            if docs[did]["page_min"] is None or ps < docs[did]["page_min"]:
                docs[did]["page_min"] = ps
        if pe is not None:
            if docs[did]["page_max"] is None or pe > docs[did]["page_max"]:
                docs[did]["page_max"] = pe

    return list(docs.values())


def get_doc_stats(doc_id: str) -> dict:
    """Get total character count for a document's chunks."""
    from qdrant_client.models import Filter, FieldCondition, MatchValue

    qc = _get_client()
    if not qc.collection_exists(COLLECTION):
        # singleton client — do not close
        return {"total_chars": 0}

    results, _ = qc.scroll(
        collection_name=COLLECTION,
        scroll_filter=Filter(
            must=[FieldCondition(key="doc_id", match=MatchValue(value=doc_id))]
        ),
        limit=1000,
        with_payload=["text"],
        with_vectors=False,
    )
    # singleton client — do not close

    total = sum(len(p.payload.get("text", "")) for p in results)
    return {"total_chars": total}


def update_doc_metadata(doc_id: str, updates: dict) -> int:
    """Update metadata fields on all chunks for a document.

    `updates` can contain: nome_legge, titolo_esteso,
    data_inizio_validita, data_fine_validita.
    Returns number of points updated.
    """
    from qdrant_client.models import Filter, FieldCondition, MatchValue

    allowed = {"nome_legge", "titolo_esteso", "data_inizio_validita", "data_fine_validita"}
    payload_updates = {k: v for k, v in updates.items() if k in allowed}
    if not payload_updates:
        return 0

    qc = _get_client()
    if not qc.collection_exists(COLLECTION):
        # singleton client — do not close
        return 0

    # Collect all point IDs for this doc
    point_ids = []
    offset = None
    while True:
        results, next_offset = qc.scroll(
            collection_name=COLLECTION,
            scroll_filter=Filter(
                must=[FieldCondition(key="doc_id", match=MatchValue(value=doc_id))]
            ),
            limit=500,
            offset=offset,
            with_payload=False,
            with_vectors=False,
        )
        point_ids.extend([p.id for p in results])
        if next_offset is None:
            break
        offset = next_offset

    if not point_ids:
        # singleton client — do not close
        return 0

    # Update payload on all points
    qc.set_payload(
        collection_name=COLLECTION,
        payload=payload_updates,
        points=point_ids,
    )
    logger.info(
        "Updated metadata on %d chunks for doc '%s': %s",
        len(point_ids), doc_id, list(payload_updates.keys()),
    )
    # singleton client — do not close
    return len(point_ids)


def init_collection_l2() -> None:
    """Create L2 collection if it doesn't exist."""
    qc = _get_client()
    if qc.collection_exists(COLLECTION_L2):
        # singleton client — do not close
        return
    qc.create_collection(
        collection_name=COLLECTION_L2,
        vectors_config={
            "dense": VectorParams(size=DENSE_DIM, distance=Distance.COSINE),
        },
        sparse_vectors_config={
            "bm25": SparseVectorParams(),
        },
    )
    logger.info("Created Qdrant collection '%s'", COLLECTION_L2)
    # singleton client — do not close


def upsert_chunks_l2(
    doc_id: str,
    chunks: list[NormChunkL2],
    metadata: NormDocMetadata,
) -> int:
    """Store L2 sub-chunks with real embeddings."""
    if not chunks:
        return 0

    init_collection_l2()

    texts = [c.text for c in chunks]
    embeddings = _embed_texts(texts)

    points = []
    for i, chunk in enumerate(chunks):
        point_id = str(uuid.uuid4())
        payload = {
            "doc_id": doc_id,
            "parent_chunk_index": chunk.parent_chunk_index,
            "sub_chunk_index": chunk.sub_chunk_index,
            "text": chunk.text,
            "annotated_text": chunk.annotated_text,
            "hierarchy_path": chunk.hierarchy_path,
            "page_start": chunk.page_start,
            "page_end": chunk.page_end,
            "title": chunk.title,
            "parent_title": chunk.parent_title,
            "doc_name": chunk.doc_name or metadata.nome_legge,
            "keywords": chunk.keywords,
            "nome_legge": metadata.nome_legge,
            "titolo_esteso": metadata.titolo_esteso,
            "data_inizio_validita": metadata.data_inizio_validita,
            "data_fine_validita": metadata.data_fine_validita,
        }
        sparse_vec = _compute_sparse(chunk.text)
        points.append(PointStruct(
            id=point_id,
            vector={
                "dense": embeddings[i],
                "bm25": sparse_vec,
            },
            payload=payload,
        ))

    qc = _get_client()
    batch_size = 100
    for i in range(0, len(points), batch_size):
        batch = points[i : i + batch_size]
        qc.upsert(collection_name=COLLECTION_L2, points=batch)
        logger.info(
            "[Qdrant L2] Upserted batch %d-%d (%d points) for doc '%s'",
            i, i + len(batch), len(batch), doc_id,
        )
    logger.info("[Qdrant L2] Total upserted: %d L2 chunks for doc '%s'", len(points), doc_id)
    # singleton client — do not close
    return len(points)


def get_chunks_l2(
    doc_id: str,
    parent_chunk_index: int | None = None,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    """Retrieve L2 sub-chunks from Qdrant."""
    from qdrant_client.models import Filter, FieldCondition, MatchValue

    qc = _get_client()
    if not qc.collection_exists(COLLECTION_L2):
        # singleton client — do not close
        return []

    must_conditions = [
        FieldCondition(key="doc_id", match=MatchValue(value=doc_id))
    ]
    if parent_chunk_index is not None:
        must_conditions.append(
            FieldCondition(key="parent_chunk_index", match=MatchValue(value=parent_chunk_index))
        )

    results, _ = qc.scroll(
        collection_name=COLLECTION_L2,
        scroll_filter=Filter(must=must_conditions),
        limit=limit,
        offset=offset,
        with_payload=True,
        with_vectors=False,
    )
    # singleton client — do not close

    chunks = [p.payload or {} for p in results]
    chunks.sort(key=lambda c: (c.get("parent_chunk_index", 0), c.get("sub_chunk_index", 0)))
    return chunks


def retrieve_chunks_l2(
    query: str,
    mode: str = "hybrid",  # "vector", "bm25", "hybrid"
    k: int = 10,
    score_threshold: float | None = None,
    doc_id: str | None = None,
) -> list[dict]:
    """Semantic retrieve on L2 sub-chunks.

    Modes:
      - vector: dense cosine similarity only
      - bm25: sparse BM25 only
      - hybrid: RRF fusion of dense + BM25 (prefetch both, fuse)

    Returns list of dicts with payload + score, sorted by relevance.
    """
    from qdrant_client.models import (
        Filter, FieldCondition, MatchValue,
        Prefetch, FusionQuery, Fusion,
    )

    qc = _get_client()
    if not qc.collection_exists(COLLECTION_L2):
        # singleton client — do not close
        return []

    # Optional doc filter
    q_filter = None
    if doc_id:
        q_filter = Filter(must=[
            FieldCondition(key="doc_id", match=MatchValue(value=doc_id))
        ])

    # Compute query vectors
    query_dense = _embed_texts([query])[0]
    query_sparse = _compute_sparse(query)

    if mode == "vector":
        results = qc.query_points(
            collection_name=COLLECTION_L2,
            query=query_dense,
            using="dense",
            query_filter=q_filter,
            limit=k,
            score_threshold=score_threshold,
            with_payload=True,
        )
    elif mode == "bm25":
        results = qc.query_points(
            collection_name=COLLECTION_L2,
            query=query_sparse,
            using="bm25",
            query_filter=q_filter,
            limit=k,
            score_threshold=score_threshold,
            with_payload=True,
        )
    else:  # hybrid — RRF fusion
        results = qc.query_points(
            collection_name=COLLECTION_L2,
            prefetch=[
                Prefetch(query=query_dense, using="dense", limit=k * 5, filter=q_filter),
                Prefetch(query=query_sparse, using="bm25", limit=k * 5, filter=q_filter),
            ],
            query=FusionQuery(fusion=Fusion.RRF),
            limit=k,
            score_threshold=score_threshold,
            with_payload=True,
        )

    # singleton client — do not close

    out = []
    for pt in results.points:
        item = dict(pt.payload or {})
        item["score"] = round(pt.score, 4) if pt.score is not None else None
        out.append(item)
    return out


def delete_document(doc_id: str) -> None:
    """Remove all chunks (L1 and L2) for a document from Qdrant."""
    from qdrant_client.models import Filter, FieldCondition, MatchValue

    qc = _get_client()
    filt = Filter(must=[FieldCondition(key="doc_id", match=MatchValue(value=doc_id))])

    if qc.collection_exists(COLLECTION):
        qc.delete(collection_name=COLLECTION, points_selector=filt)
    if qc.collection_exists(COLLECTION_L2):
        qc.delete(collection_name=COLLECTION_L2, points_selector=filt)

    logger.info("Deleted L1+L2 chunks for doc '%s'", doc_id)
    # singleton client — do not close
