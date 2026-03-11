"""LangGraph ingestion pipeline for regulatory documents.

Simplified approach:
  extract_text_with_fonts → chunk_and_store

- Metadata (nome_legge, dates) comes from user input, not LLM
- Chunking: extract headings → 1 LLM call to identify first-level chapters
  → deterministic text slicing → embed → store progressively
"""

from __future__ import annotations

import difflib
import json
import logging
import os
import re
from typing import Any, TypedDict

import fitz  # PyMuPDF
from langgraph.graph import END, StateGraph
from openai import OpenAI

from backend.normativa.models import NormChunk, NormDocMetadata
from backend.normativa.prompts import CHUNKING_SYSTEM, CHUNKING_L2_SYSTEM
from backend.normativa.vectorstore import upsert_chunks, upsert_chunks_l2

logger = logging.getLogger(__name__)

MODEL = "gpt-5-mini"


# ── Helpers ──────────────────────────────────────────────────────

def _get_client() -> OpenAI:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY non impostata")
    return OpenAI(api_key=api_key)


def _log_usage(description: str, resp) -> None:
    usage = resp.usage
    if not usage:
        logger.info("[GPT] %s — no usage data", description)
        return
    cached = getattr(usage, "prompt_tokens_details", None)
    cached_tokens = getattr(cached, "cached_tokens", 0) if cached else 0
    logger.info(
        "[GPT] %s — input: %d tokens (cached: %d), output: %d tokens",
        description,
        usage.prompt_tokens,
        cached_tokens,
        usage.completion_tokens,
    )


# ── State ────────────────────────────────────────────────────────

class IngestionState(TypedDict, total=False):
    pdf_path: str
    doc_id: str
    doc_metadata: dict            # user-provided metadata
    status_callback: Any          # callable(status_str)
    annotated_pages: list[dict]   # [{page_number, annotated_text}]
    plain_pages: list[dict]       # [{page_number, text}]
    plain_text: str
    chunk_count: int
    chunk_count_l2: int
    l1_chunks: list[dict]         # L1 chunk dicts passed to L2 splitter


# ── Node 1: Extract text with font annotations ──────────────────

def _classify_font(size: float, is_bold: bool, max_size: float) -> str:
    if size >= max_size * 0.9 or size >= 16:
        return "H1"
    if size >= 13 or (size >= 11.5 and is_bold):
        return "H2"
    if is_bold and size >= 10:
        return "H3"
    return "BODY"


def _table_to_markdown(table) -> str:
    """Convert a PyMuPDF table to markdown format (fallback when LlamaParse unavailable)."""
    try:
        data = table.extract()
    except Exception:
        return ""
    if not data or not data[0]:
        return ""
    rows = []
    for row in data:
        cleaned = [(cell or "").strip().replace("\n", " ") for cell in row]
        rows.append(cleaned)
    if all(not cell for row in rows for cell in row):
        return ""
    ncols = max(len(r) for r in rows)
    for r in rows:
        while len(r) < ncols:
            r.append("")
    lines = []
    lines.append("| " + " | ".join(rows[0]) + " |")
    lines.append("| " + " | ".join(["---"] * ncols) + " |")
    for row in rows[1:]:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def _extract_table_blocks(markdown: str) -> list[str]:
    """Parse markdown text and extract table blocks (sequences of | lines)."""
    tables: list[str] = []
    current_lines: list[str] = []

    for line in markdown.split("\n"):
        stripped = line.strip()
        if stripped.startswith("|") and stripped.endswith("|"):
            current_lines.append(stripped)
        else:
            if current_lines:
                # Need at least 2 lines for a real table (header + separator)
                if len(current_lines) >= 2:
                    tables.append("\n".join(current_lines))
                current_lines = []

    # Flush last block
    if current_lines and len(current_lines) >= 2:
        tables.append("\n".join(current_lines))

    return tables


def _extract_tables_llamaparse(pdf_path: str, status_callback=None) -> list[str]:
    """Extract tables via LlamaParse with cross-page merge.

    Returns list of markdown table strings in document order.
    Returns empty list if API key not set or on error (fallback to PyMuPDF).
    """
    api_key = os.environ.get("LLAMA_CLOUD_API_KEY")
    if not api_key:
        logger.warning("LLAMA_CLOUD_API_KEY not set — tables will use PyMuPDF fallback")
        return []

    try:
        from llama_parse import LlamaParse
    except ImportError:
        logger.warning("llama-parse not installed — tables will use PyMuPDF fallback")
        return []

    if status_callback:
        status_callback("LlamaParse: estrazione tabelle cross-page...")

    try:
        parser = LlamaParse(
            api_key=api_key,
            result_type="markdown",
            merge_tables_across_pages_in_markdown=True,
            language="it",
        )
        docs = parser.load_data(pdf_path)
        full_md = "\n".join(d.text for d in docs)
        tables = _extract_table_blocks(full_md)
        logger.info("[LlamaParse] Extracted %d tables from document", len(tables))
        return tables
    except Exception:
        logger.exception("[LlamaParse] Failed — falling back to PyMuPDF tables")
        return []


def _table_fingerprint(md_text: str) -> str:
    """Extract a text fingerprint from a markdown table for matching.

    Takes the first data row (skipping header separator) and extracts
    non-empty cell values, lowercased and concatenated.
    """
    cells: list[str] = []
    for line in md_text.split("\n"):
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        # Skip separator lines (| --- | --- |)
        if re.match(r"^\|[\s\-:|]+\|$", stripped):
            continue
        # Extract cell values
        parts = [c.strip() for c in stripped.split("|")[1:-1]]
        for p in parts:
            if p and len(p) > 1:
                cells.append(p.lower()[:60])
        if len(cells) >= 8:
            break
    return " ".join(cells)


def _match_llamaparse_to_regions(
    llamaparse_tables: list[str],
    table_regions: list[dict],
) -> dict[int, str]:
    """Match LlamaParse tables to PyMuPDF regions by text fingerprint similarity.

    Returns {region_index: llamaparse_markdown}.
    Regions without a good match get no entry (use fallback_md).
    A LlamaParse table is only inserted once (at the first matching region).
    """
    if not llamaparse_tables or not table_regions:
        return {}

    # Pre-compute fingerprints for all LlamaParse tables
    lp_fingerprints = [_table_fingerprint(t) for t in llamaparse_tables]

    result: dict[int, str] = {}
    used_lp: set[int] = set()  # track which LP tables have been assigned

    for ri, region in enumerate(table_regions):
        fallback = region.get("fallback_md", "")
        if not fallback:
            continue

        region_fp = _table_fingerprint(fallback)
        if not region_fp:
            continue

        best_score = 0.0
        best_idx = -1

        for li, lp_fp in enumerate(lp_fingerprints):
            if not lp_fp:
                continue
            score = difflib.SequenceMatcher(None, region_fp, lp_fp).ratio()
            if score > best_score:
                best_score = score
                best_idx = li

        if best_score >= 0.35 and best_idx >= 0:
            if best_idx not in used_lp:
                # First time this LP table is matched — assign it
                result[ri] = llamaparse_tables[best_idx]
                used_lp.add(best_idx)
                logger.debug(
                    "[Match] Region %d (p.%d) → LP table %d (score=%.2f)",
                    ri, region["page"], best_idx, best_score,
                )
            # else: same LP table matched again (cross-page continuation) — skip

    logger.info(
        "[Match] Matched %d/%d regions to LlamaParse tables (%d LP tables used)",
        len(result), len(table_regions), len(used_lp),
    )
    return result


def _line_in_any_rect(line_bbox, table_rects, tolerance=2.0) -> bool:
    """Check if a text line's vertical center falls inside any table rect."""
    y_mid = (line_bbox[1] + line_bbox[3]) / 2
    for rect in table_rects:
        if (rect[0] - tolerance <= line_bbox[0]
                and rect[1] - tolerance <= y_mid <= rect[3] + tolerance):
            return True
    return False


def extract_text_with_fonts(state: IngestionState) -> IngestionState:
    """Extract text from PDF with LlamaParse for tables, PyMuPDF for text+fonts.

    1. PyMuPDF: extract text with font annotations, detect table regions (bbox only)
    2. LlamaParse: extract tables with cross-page merge (fallback: PyMuPDF per-page)
    3. Merge: insert LlamaParse tables where PyMuPDF detected table regions
    """
    cb = state.get("status_callback")
    if cb:
        cb("Estrazione testo con analisi font...")

    pdf_path = state["pdf_path"]
    doc = fitz.open(pdf_path)

    # First pass: find max font size
    max_font_size = 12.0
    for page in doc:
        blocks = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)["blocks"]
        for block in blocks:
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    if span["size"] > max_font_size:
                        max_font_size = span["size"]

    # ── Phase 1: PyMuPDF — text lines + table regions ─────────
    all_table_regions: list[dict] = []  # {page, bbox, fallback_md}
    page_text_data: list[dict] = []     # per-page text lines

    for page_idx, page in enumerate(doc):
        page_num = page_idx + 1
        blocks = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)["blocks"]

        # Detect table regions (used for text filtering + fallback content)
        tables = page.find_tables()
        table_rects = [t.bbox for t in tables.tables] if tables.tables else []

        for t in (tables.tables if tables.tables else []):
            fallback_md = _table_to_markdown(t)
            all_table_regions.append({
                "page": page_num,
                "bbox": t.bbox,
                "fallback_md": fallback_md,
            })

        # Collect text lines (skip lines inside table regions)
        text_lines = []
        for block in blocks:
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                line_bbox = line["bbox"]
                if _line_in_any_rect(line_bbox, table_rects):
                    continue

                line_text = ""
                line_size = 0.0
                line_bold = False
                for span in line["spans"]:
                    line_text += span["text"]
                    if span["size"] > line_size:
                        line_size = span["size"]
                    if "bold" in span["font"].lower() or (span["flags"] & 2**4):
                        line_bold = True

                text = line_text.strip()
                if not text:
                    continue
                tag = _classify_font(line_size, line_bold, max_font_size)
                text_lines.append({
                    "annotated": f"[{tag}|{line_size:.0f}pt] {text}",
                    "plain": text,
                    "y": line_bbox[1],
                })

        page_text_data.append({
            "page_number": page_num,
            "text_lines": text_lines,
            "table_rects": table_rects,
        })

    doc.close()

    # ── Phase 2: LlamaParse — extract tables with cross-page merge ──
    llamaparse_tables = _extract_tables_llamaparse(pdf_path, status_callback=cb)

    # Match LlamaParse tables to PyMuPDF regions by content similarity
    matched = _match_llamaparse_to_regions(llamaparse_tables, all_table_regions)

    # Build lookup: page_number → list of table markdown strings to insert
    tables_for_page: dict[int, list[str]] = {}

    for ri, region in enumerate(all_table_regions):
        if ri in matched:
            md = matched[ri]
        else:
            md = region.get("fallback_md", "")
        if md:
            tables_for_page.setdefault(region["page"], []).append(md)

    # ── Phase 3: Assemble final output per page ──────────────
    annotated_pages = []
    plain_pages = []

    for pd in page_text_data:
        page_num = pd["page_number"]
        annotated_lines = []
        plain_lines = []

        # Insert tables assigned to this page
        for md in tables_for_page.get(page_num, []):
            annotated_lines.append(f"[TABLE]\n{md}")
            plain_lines.append(md)

        for tl in pd["text_lines"]:
            annotated_lines.append(tl["annotated"])
            plain_lines.append(tl["plain"])

        annotated_pages.append({
            "page_number": page_num,
            "annotated_text": "\n".join(annotated_lines),
        })
        plain_pages.append({
            "page_number": page_num,
            "text": "\n".join(plain_lines),
        })

    plain_text = "\n\n".join(p["text"] for p in plain_pages)
    total_tables = sum(
        p["annotated_text"].count("[TABLE]") for p in annotated_pages
    )
    logger.info(
        "Extracted %d pages, %d chars plain text, %d tables",
        len(annotated_pages), len(plain_text), total_tables,
    )

    return {
        "annotated_pages": annotated_pages,
        "plain_pages": plain_pages,
        "plain_text": plain_text,
    }


# ── Node 2: First-level chunking + embed + store ────────────────

CHAPTER_SCHEMA = {
    "type": "object",
    "properties": {
        "chapters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_marker": {
                        "type": "string",
                        "description": "Primi ~60 caratteri esatti dell'inizio del capitolo (senza tag font)",
                    },
                    "page": {
                        "type": "integer",
                        "description": "Numero della pagina dove inizia",
                    },
                    "title": {
                        "type": "string",
                        "description": "Titolo completo del capitolo/sezione",
                    },
                },
                "required": ["start_marker", "page", "title"],
            },
        }
    },
    "required": ["chapters"],
}


def _extract_headings(annotated_pages: list[dict]) -> str:
    """Extract heading lines (H1, H2, H3) with page numbers.

    The first few pages are included in full (all lines, not just headings)
    because they often contain a Table of Contents (INDICE) that the LLM
    needs to see. TOC entries are typically BODY text, not headings.
    """
    lines = []

    # Include first pages in full to capture TOC/INDICE
    # (up to 3 pages or until we find a clear heading after TOC)
    full_pages = min(3, len(annotated_pages))
    for page in annotated_pages[:full_pages]:
        lines.append(f"[PAGINA {page['page_number']}]")
        for line in page["annotated_text"].split("\n"):
            if line.strip():
                lines.append(line)

    # Rest: headings only
    for page in annotated_pages[full_pages:]:
        page_headings = []
        for line in page["annotated_text"].split("\n"):
            if line.startswith("[H1|") or line.startswith("[H2|") or line.startswith("[H3|"):
                page_headings.append(line)
        if page_headings:
            lines.append(f"[PAGINA {page['page_number']}]")
            lines.extend(page_headings)
    return "\n".join(lines)


def _find_marker_position(plain_text: str, marker: str, search_from: int = 0) -> int:
    """Find the position of a marker in plain text. Falls back to fuzzy match."""
    # Exact match
    pos = plain_text.find(marker, search_from)
    if pos >= 0:
        return pos

    # Try with normalized whitespace
    normalized_marker = re.sub(r"\s+", " ", marker.strip())
    normalized_text = re.sub(r"\s+", " ", plain_text[search_from:])
    pos = normalized_text.find(normalized_marker)
    if pos >= 0:
        return search_from + pos

    # Fuzzy: find the closest matching line
    marker_lower = marker.lower().strip()
    lines = plain_text[search_from:].split("\n")
    best_ratio = 0.0
    best_offset = search_from
    current_offset = search_from

    for line in lines:
        if len(line.strip()) < 5:
            current_offset += len(line) + 1
            continue
        line_start = line.strip()[:len(marker) + 20].lower()
        ratio = difflib.SequenceMatcher(None, marker_lower, line_start).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_offset = current_offset + (len(line) - len(line.lstrip()))
        current_offset += len(line) + 1

    if best_ratio > 0.5:
        logger.warning(
            "Fuzzy match for marker (ratio=%.2f): '%s...'",
            best_ratio, marker[:40],
        )
        return best_offset

    logger.warning(
        "Could not find marker: '%s...' — using search_from=%d",
        marker[:40], search_from,
    )
    return search_from


def chunk_and_store(state: IngestionState) -> IngestionState:
    """Extract headings → LLM identifies first-level chapters → slice → embed → store."""
    cb = state.get("status_callback")
    plain_text = state["plain_text"]
    plain_pages = state["plain_pages"]
    doc_id = state["doc_id"]
    meta_dict = state["doc_metadata"]
    metadata = NormDocMetadata(**meta_dict)
    nome_legge = metadata.nome_legge

    # ── Step 1: Extract headings ─────────────────────────────────
    if cb:
        cb("Estrazione heading dal documento...")

    headings_text = _extract_headings(state["annotated_pages"])
    heading_count = headings_text.count("\n")
    logger.info("Extracted %d heading lines for LLM", heading_count)

    # ── Step 2: LLM identifies first-level chapters ──────────────
    if cb:
        cb("LLM identifica capitoli di primo livello...")

    client = _get_client()
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": CHUNKING_SYSTEM},
            {"role": "user", "content": headings_text},
        ],
        tools=[{
            "type": "function",
            "function": {
                "name": "chapter_boundaries",
                "description": "Capitoli di primo livello del documento",
                "parameters": CHAPTER_SCHEMA,
            },
        }],
        tool_choice={"type": "function", "function": {"name": "chapter_boundaries"}},
        reasoning_effort="low",
    )
    _log_usage("First-level chunking", resp)

    tool_call = resp.choices[0].message.tool_calls[0]
    data = json.loads(tool_call.function.arguments)
    chapters = data.get("chapters", [])
    logger.info("LLM identified %d first-level chapters", len(chapters))

    for i, ch in enumerate(chapters):
        logger.info(
            "  Chapter %d: p.%d — %s",
            i, ch.get("page", "?"), ch.get("title", "?")[:80],
        )

    if not chapters:
        logger.warning("No chapters found — storing entire document as one chunk")
        chapters = [{
            "start_marker": plain_text[:60],
            "page": 1,
            "title": "Documento completo",
        }]

    # ── Step 3: Resolve positions in plain text ──────────────────
    if cb:
        cb("Risoluzione posizioni e taglio testo...")

    # Build page offset map
    page_offsets: dict[int, int] = {}
    offset = 0
    for p in plain_pages:
        page_offsets[p["page_number"]] = offset
        offset += len(p["text"]) + 2  # +2 for "\n\n"

    # Find each chapter's position
    positions: list[tuple[int, dict]] = []
    for ch in chapters:
        page = ch.get("page", 1)
        search_from = page_offsets.get(page, 0)
        search_from = max(0, search_from - 200)
        pos = _find_marker_position(plain_text, ch["start_marker"], search_from)
        positions.append((pos, ch))

    positions.sort(key=lambda x: x[0])

    # Build annotated page lookup: page_number → annotated_text
    annotated_by_page: dict[int, str] = {}
    for ap in state["annotated_pages"]:
        annotated_by_page[ap["page_number"]] = ap["annotated_text"]

    # ── Step 4: Slice text and build chunks ──────────────────────
    chunks: list[dict] = []
    for i, (pos, ch) in enumerate(positions):
        next_pos = positions[i + 1][0] if i + 1 < len(positions) else len(plain_text)
        text = plain_text[pos:next_pos].strip()
        if not text:
            continue

        page_start = ch.get("page", 1)
        if i + 1 < len(positions):
            page_end = positions[i + 1][1].get("page", page_start)
            page_end = max(page_start, page_end)
        else:
            page_end = plain_pages[-1]["page_number"] if plain_pages else page_start

        # Collect annotated text for this chunk's page range
        ann_parts = []
        for pn in range(page_start, page_end + 1):
            if pn in annotated_by_page:
                ann_parts.append(f"[PAGINA {pn}]\n{annotated_by_page[pn]}")
        annotated_text = "\n\n".join(ann_parts)

        title = ch.get("title", f"Sezione {i}")
        chunks.append({
            "chunk_index": i,
            "text": text,
            "annotated_text": annotated_text,
            "hierarchy_path": f"{nome_legge} > {title}",
            "page_start": page_start,
            "page_end": page_end,
        })

    logger.info("Resolved %d first-level chunks", len(chunks))

    # ── Step 5: Embed and store ──────────────────────────────────
    if cb:
        cb(f"Embedding e salvataggio {len(chunks)} chunks...")

    norm_chunks = [NormChunk(**c) for c in chunks]
    count = upsert_chunks(doc_id, norm_chunks, metadata)
    logger.info("Stored %d chunks in Qdrant for doc '%s'", count, doc_id)

    if cb:
        cb(f"L1 completato: {count} chunks. Avvio L2...")

    return {"chunk_count": count, "l1_chunks": chunks}


# ── Node 3: Second-level chunking ─────────────────────────────────

SUB_CHUNK_SCHEMA = {
    "type": "object",
    "properties": {
        "sub_chunks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_marker": {
                        "type": "string",
                        "description": "Primi ~10 caratteri esatti dell'inizio del sotto-chunk (testo puro)",
                    },
                    "title": {
                        "type": "string",
                        "description": "Breve titolo descrittivo (max 80 caratteri)",
                    },
                    "keywords": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "3-7 parole chiave specifiche del contenuto di questo sotto-chunk (termini tecnici, nomi di articoli, concetti chiave)",
                    },
                },
                "required": ["start_marker", "title", "keywords"],
            },
        }
    },
    "required": ["sub_chunks"],
}


def _split_l1_into_l2(
    l1_chunk: dict,
    client: OpenAI,
    nome_legge: str,
) -> list[dict]:
    """Use LLM to split one L1 chunk into L2 sub-chunks.

    Returns list of dicts with: parent_chunk_index, sub_chunk_index, text,
    annotated_text, hierarchy_path, page_start, page_end.
    """
    annotated = l1_chunk["annotated_text"]
    plain = l1_chunk["text"]
    parent_idx = l1_chunk["chunk_index"]
    parent_title = l1_chunk["hierarchy_path"].split(" > ", 1)[-1] if " > " in l1_chunk["hierarchy_path"] else l1_chunk["hierarchy_path"]

    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": CHUNKING_L2_SYSTEM},
            {"role": "user", "content": annotated},
        ],
        tools=[{
            "type": "function",
            "function": {
                "name": "sub_chunk_boundaries",
                "description": "Sotto-chunk del capitolo",
                "parameters": SUB_CHUNK_SCHEMA,
            },
        }],
        tool_choice={"type": "function", "function": {"name": "sub_chunk_boundaries"}},
        reasoning_effort="low",
    )
    _log_usage(f"L2 chunking (L1#{parent_idx})", resp)

    tool_call = resp.choices[0].message.tool_calls[0]
    data = json.loads(tool_call.function.arguments)
    boundaries = data.get("sub_chunks", [])

    if not boundaries:
        boundaries = [{"start_marker": plain[:10], "title": parent_title}]

    # Resolve positions
    positions: list[tuple[int, dict]] = []
    for b in boundaries:
        pos = _find_marker_position(plain, b["start_marker"], 0)
        positions.append((pos, b))
    positions.sort(key=lambda x: x[0])

    # Deduplicate positions that map to the same offset
    deduped: list[tuple[int, dict]] = [positions[0]]
    for pos, b in positions[1:]:
        if pos > deduped[-1][0]:
            deduped.append((pos, b))
    positions = deduped

    # Build page offset map from annotated text (look for [PAGINA N] markers)
    page_markers: list[tuple[int, int]] = []  # (char_offset_in_plain, page_num)
    plain_offset = 0
    for line in annotated.split("\n"):
        m = re.match(r"^\[PAGINA\s+(\d+)\]$", line)
        if m:
            page_markers.append((plain_offset, int(m.group(1))))
        # Approximate: skip tag lines for offset tracking in plain
        stripped = line.strip()
        if stripped and not stripped.startswith("[PAGINA") and not stripped.startswith("[H") and stripped != "[TABLE]":
            plain_offset += len(stripped) + 1

    def _page_at(char_pos: int) -> int:
        """Find which page a character position falls on."""
        result = l1_chunk["page_start"]
        for offset, pn in page_markers:
            if offset <= char_pos:
                result = pn
            else:
                break
        return result

    # Slice into sub-chunks
    sub_chunks: list[dict] = []
    for i, (pos, b) in enumerate(positions):
        next_pos = positions[i + 1][0] if i + 1 < len(positions) else len(plain)
        text = plain[pos:next_pos].strip()
        if not text:
            continue

        page_start = _page_at(pos)
        page_end = _page_at(next_pos - 1) if next_pos > pos else page_start

        sub_title = b.get("title", f"Parte {i + 1}")
        hierarchy = f"{nome_legge} > {parent_title} > {sub_title}"
        kw = b.get("keywords", [])
        if not isinstance(kw, list):
            kw = []

        sub_chunks.append({
            "parent_chunk_index": parent_idx,
            "sub_chunk_index": i,
            "text": text,
            "annotated_text": "",  # L2 chunks don't need annotated text
            "hierarchy_path": hierarchy,
            "page_start": page_start,
            "page_end": page_end,
            "title": sub_title,
            "parent_title": parent_title,
            "doc_name": nome_legge,
            "keywords": kw,
        })

    return sub_chunks


# Max words per L2 chunk — Italian words tokenize to ~1.5 tokens each
# 4000 words ≈ 6000 tokens, safely under the 8192 limit
_L2_MAX_WORDS = 4000


def _hard_split_chunk(chunk: dict, max_words: int) -> list[dict]:
    """Deterministically split an oversized chunk at paragraph/line boundaries.

    Used as last resort when the LLM produces chunks still too large.
    Tries to split at double-newlines first, then single newlines.
    Never splits inside a markdown table block (lines starting with |).
    """
    text = chunk["text"]
    words = text.split()
    if len(words) <= max_words:
        return [chunk]

    # Split into segments (paragraph-level)
    segments: list[str] = []
    current: list[str] = []
    in_table = False

    for line in text.split("\n"):
        stripped = line.strip()
        is_table_line = stripped.startswith("|")

        if is_table_line:
            in_table = True
            current.append(line)
        elif in_table and not stripped:
            # End of table block
            in_table = False
            current.append(line)
            segments.append("\n".join(current))
            current = []
        elif not in_table and not stripped and current:
            # Paragraph break
            segments.append("\n".join(current))
            current = []
        else:
            current.append(line)

    if current:
        segments.append("\n".join(current))

    # If we couldn't split into multiple segments, force split by words
    if len(segments) <= 1:
        words = text.split()
        segments = []
        for i in range(0, len(words), max_words):
            segments.append(" ".join(words[i : i + max_words]))

    # Merge segments into chunks under max_words
    result: list[dict] = []
    buf: list[str] = []
    buf_words = 0

    for seg in segments:
        seg_words = len(seg.split())
        if buf and buf_words + seg_words > max_words:
            # Flush buffer
            result.append({
                **chunk,
                "text": "\n\n".join(buf),
            })
            buf = [seg]
            buf_words = seg_words
        else:
            buf.append(seg)
            buf_words += seg_words

    if buf:
        result.append({
            **chunk,
            "text": "\n\n".join(buf),
        })

    # Re-index
    for i, c in enumerate(result):
        c["sub_chunk_index"] = chunk["sub_chunk_index"] * 100 + i
        if i > 0:
            sub_title = f"{chunk.get('title', 'Parte')} (cont. {i + 1})"
            c["hierarchy_path"] = " > ".join(chunk["hierarchy_path"].split(" > ")[:-1] + [sub_title])
            c["title"] = sub_title

    logger.info(
        "Hard-split oversized L2 chunk (%d words) → %d pieces",
        len(words), len(result),
    )
    return result


def chunk_level2(state: IngestionState) -> IngestionState:
    """Split each L1 chunk into smaller L2 sub-chunks via LLM."""
    cb = state.get("status_callback")
    doc_id = state["doc_id"]
    meta_dict = state["doc_metadata"]
    metadata = NormDocMetadata(**meta_dict)
    nome_legge = metadata.nome_legge

    # Retrieve L1 chunks from state
    l1_chunks = state.get("l1_chunks", [])
    if not l1_chunks:
        logger.warning("No L1 chunks found for L2 splitting")
        return {}

    if cb:
        cb(f"Chunking di secondo livello ({len(l1_chunks)} capitoli)...")

    client = _get_client()
    all_l2: list[dict] = []

    for l1 in l1_chunks:
        if cb:
            cb(f"L2 chunking: capitolo {l1['chunk_index'] + 1}/{len(l1_chunks)}...")
        sub_chunks = _split_l1_into_l2(l1, client, nome_legge)

        # Post-check: hard-split any chunk still over the embedding limit
        final_subs: list[dict] = []
        for sc in sub_chunks:
            wc = len(sc["text"].split())
            if wc > _L2_MAX_WORDS:
                logger.warning(
                    "L2 sub-chunk too large (%d words), hard-splitting", wc,
                )
                final_subs.extend(_hard_split_chunk(sc, _L2_MAX_WORDS))
            else:
                final_subs.append(sc)

        # Re-index sub_chunk_index sequentially
        for i, sc in enumerate(final_subs):
            sc["sub_chunk_index"] = i

        all_l2.extend(final_subs)
        logger.info(
            "L1#%d → %d sub-chunks", l1["chunk_index"], len(final_subs),
        )

    logger.info("Total L2 sub-chunks: %d (from %d L1 chunks)", len(all_l2), len(l1_chunks))

    # Store in parallel collection
    if cb:
        cb(f"Salvataggio {len(all_l2)} sub-chunks...")

    from backend.normativa.models import NormChunkL2
    norm_l2 = [NormChunkL2(**c) for c in all_l2]
    count = upsert_chunks_l2(doc_id, norm_l2, metadata)
    logger.info("Stored %d L2 chunks for doc '%s'", count, doc_id)

    if cb:
        cb(f"Completato: {state.get('chunk_count', 0)} L1 + {count} L2 chunks")

    return {"chunk_count_l2": count}


# ── Graph assembly ───────────────────────────────────────────────

def build_ingestion_graph() -> StateGraph:
    graph = StateGraph(IngestionState)
    graph.add_node("extract_text_with_fonts", extract_text_with_fonts)
    graph.add_node("chunk_and_store", chunk_and_store)
    graph.add_node("chunk_level2", chunk_level2)
    graph.set_entry_point("extract_text_with_fonts")
    graph.add_edge("extract_text_with_fonts", "chunk_and_store")
    graph.add_edge("chunk_and_store", "chunk_level2")
    graph.add_edge("chunk_level2", END)
    return graph.compile()


def run_ingestion(
    pdf_path: str,
    doc_id: str,
    doc_metadata: dict,
    status_callback=None,
) -> dict:
    """Run the full ingestion pipeline. Returns {doc_metadata, chunk_count}."""
    app = build_ingestion_graph()
    result = app.invoke({
        "pdf_path": pdf_path,
        "doc_id": doc_id,
        "doc_metadata": doc_metadata,
        "status_callback": status_callback,
    })
    return {
        "doc_metadata": doc_metadata,
        "chunk_count": result.get("chunk_count", 0),
    }
