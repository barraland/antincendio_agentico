"""Pydantic models for regulatory document ingestion."""

from __future__ import annotations

from pydantic import BaseModel, Field


class NormChunk(BaseModel):
    """A single semantic chunk from a regulatory document."""
    chunk_index: int
    text: str
    annotated_text: str = ""     # text with font tags [H1|18pt], [H2|14pt], etc.
    hierarchy_path: str  # e.g. "DM 03/08/2015 > Titolo I - Generalità"
    page_start: int
    page_end: int


class NormChunkL2(BaseModel):
    """A second-level sub-chunk (split from a first-level chunk by LLM)."""
    parent_chunk_index: int       # index of the L1 parent chunk
    sub_chunk_index: int          # sequential index within parent
    text: str
    annotated_text: str = ""
    hierarchy_path: str           # e.g. "DM > Titolo I > Art. 1-3"
    page_start: int
    page_end: int
    title: str = ""               # sub-chunk title (from LLM)
    parent_title: str = ""        # L1 parent chunk title
    doc_name: str = ""            # document short name (nome_legge)
    keywords: list[str] = Field(default_factory=list)  # extracted by LLM


class NormDocMetadata(BaseModel):
    """Metadata for a regulatory document (user-provided)."""
    nome_legge: str                          # short name, e.g. "DM 03/08/2015"
    titolo_esteso: str = ""                  # full title
    data_inizio_validita: str | None = None  # "YYYY-MM-DD"
    data_fine_validita: str | None = None    # null se ancora in vigore
    keywords: list[str] = Field(default_factory=list)


class NormDocument(BaseModel):
    """A stored regulatory document with processing status."""
    id: str
    filename: str
    uploaded_at: str
    status: str = "processing"       # "processing" | "done" | "error"
    progress: str | None = None      # human-readable step description
    error: str | None = None
    metadata: NormDocMetadata | None = None
    chunk_count: int = 0
