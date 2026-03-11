"""RAG graph for querying normativa documents.

Flow:
  1. router: LLM receives user query + chat history + available docs metadata.
     Decides which retrieval queries to run (1-5, executed in parallel).
  2. retriever: For each query, runs hybrid/vector search on L2 collection (parallel).
  3. selector: LLM filters retrieved chunks — removes redundant/irrelevant ones.
  4. generator: LLM receives query + history + selected chunks, streams answer
     with source citations.
"""

from __future__ import annotations

import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Generator

from openai import OpenAI

from backend.normativa.vectorstore import retrieve_chunks_l2, list_stored_documents

logger = logging.getLogger(__name__)

MODEL = os.environ.get("RAG_MODEL", "gpt-5-mini")
ROUTER_MODEL = os.environ.get("RAG_ROUTER_MODEL", "gpt-5-mini")


def _get_client() -> OpenAI:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY non impostata")
    return OpenAI(api_key=api_key, max_retries=5)


# ── Available documents context ──────────────────────────────────

def _build_docs_context() -> str:
    """Build a summary of all available documents for the router."""
    docs = list_stored_documents()
    if not docs:
        return "Nessun documento caricato nel sistema."

    lines = ["Documenti normativi disponibili nel sistema:"]
    for d in docs:
        nome = d.get("nome_legge", "Sconosciuto")
        titolo = d.get("titolo_esteso", "")
        chunks = d.get("chunk_count", 0)
        doc_id = d.get("doc_id", "")
        validity = d.get("data_inizio_validita", "")
        line = f"- {nome}"
        if titolo:
            line += f": {titolo}"
        line += f" (doc_id={doc_id}, {chunks} chunks"
        if validity:
            line += f", dal {validity}"
        line += ")"
        lines.append(line)
    return "\n".join(lines)


# ── Router node ──────────────────────────────────────────────────

ROUTER_SYSTEM = """\
Sei un esperto di normativa antincendio italiana. \
Ricevi una domanda dall'utente e la cronologia della conversazione. \
Il tuo compito è generare le query di ricerca per trovare i passaggi normativi rilevanti.

{docs_context}

## ISTRUZIONI

1. Analizza la domanda nel contesto della conversazione precedente.
2. Genera da 1 a 5 query di ricerca semantica per trovare i chunk normativi più pertinenti.
3. Ogni query deve essere una frase breve e specifica, focalizzata su un aspetto della domanda.
4. Se la domanda è ambigua o generica, genera query che coprano le interpretazioni più probabili.
5. Se la domanda riguarda un documento specifico, includi il nome nella query.
6. Se servono, puoi filtrare per doc_id specifico.

## REGOLE CRITICHE PER LA DECOMPOSIZIONE

- Se la domanda tocca PIÙ argomenti distinti (es. "Rvita, Rbeni e Rambiente"), genera ALMENO \
una query dedicata per ciascun argomento. Non accorpare argomenti diversi in una sola query.
- Preferisci query specifiche e tecniche (es. "tabella G.3-3 calcolo Rvita δocc δα velocità crescita incendio") \
a query generiche (es. "profili di rischio").
- Per ogni argomento, cerca sia la definizione/procedura sia le tabelle/parametri di calcolo.
- Se la domanda chiede "come si calcola X", genera query che cerchino: la procedura, i parametri, le tabelle di riferimento.

Rispondi usando la funzione search_queries."""

ROUTER_SCHEMA = {
    "type": "object",
    "properties": {
        "queries": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Query di ricerca semantica",
                    },
                    "doc_id": {
                        "type": "string",
                        "description": "Filtra per doc_id specifico (opzionale, stringa vuota = tutti)",
                    },
                },
                "required": ["query"],
            },
        },
        "reasoning": {
            "type": "string",
            "description": "Breve ragionamento su come hai scelto le query",
        },
    },
    "required": ["queries", "reasoning"],
}


def _format_history(history: list[dict]) -> str:
    """Format chat history into a readable string for the LLM."""
    if not history:
        return ""
    lines = []
    for msg in history:
        role = "Utente" if msg["role"] == "user" else "Assistente"
        lines.append(f"{role}: {msg['content']}")
    return "\n".join(lines)


def route_query(
    user_query: str,
    history: list[dict],
) -> dict:
    """Router node: analyze query + history, generate search queries.

    Returns: {queries: [{query, doc_id?}], reasoning: str}
    """
    logger.info("[RAG:router] Query: %s (history: %d msgs)", user_query[:80], len(history))

    client = _get_client()
    docs_context = _build_docs_context()
    system = ROUTER_SYSTEM.format(docs_context=docs_context)

    messages = [{"role": "system", "content": system}]

    # Add history
    hist_text = _format_history(history)
    if hist_text:
        messages.append({"role": "user", "content": f"Conversazione precedente:\n{hist_text}"})
        messages.append({"role": "assistant", "content": "Ho letto la conversazione. Procedi con la domanda."})

    messages.append({"role": "user", "content": user_query})

    resp = client.chat.completions.create(
        model=ROUTER_MODEL,
        messages=messages,
        tools=[{
            "type": "function",
            "function": {
                "name": "search_queries",
                "description": "Query di ricerca da eseguire",
                "parameters": ROUTER_SCHEMA,
            },
        }],
        tool_choice={"type": "function", "function": {"name": "search_queries"}},
    )

    tool_call = resp.choices[0].message.tool_calls[0]
    data = json.loads(tool_call.function.arguments)
    queries = data.get("queries", [])
    reasoning = data.get("reasoning", "")

    usage = resp.usage
    logger.info(
        "[RAG:router] Generated %d queries (reasoning: %s) [tokens: %d in, %d out]",
        len(queries), reasoning[:80],
        usage.prompt_tokens if usage else 0,
        usage.completion_tokens if usage else 0,
    )

    return {"queries": queries, "reasoning": reasoning}


# ── Retriever node ───────────────────────────────────────────────

def _run_single_query(query_text: str, mode: str, k: int, doc_id: str | None) -> list[dict]:
    """Execute a single retrieval query (used by ThreadPoolExecutor)."""
    return retrieve_chunks_l2(query=query_text, mode=mode, k=k, doc_id=doc_id)


def retrieve(
    queries: list[dict],
    k_per_query: int = 8,
    mode: str = "hybrid",
) -> list[dict]:
    """Retriever node: execute search queries in parallel and collect unique chunks.

    Returns deduplicated list of chunks with metadata, sorted by best score.
    """
    logger.info("[RAG:retriever] Executing %d queries in parallel (k=%d, mode=%s)", len(queries), k_per_query, mode)

    # Filter valid queries
    valid_queries = [(q.get("query", ""), q.get("doc_id") or None) for q in queries if q.get("query")]
    if not valid_queries:
        return []

    # Run all queries in parallel
    query_results: list[tuple[str, list[dict]]] = []
    with ThreadPoolExecutor(max_workers=len(valid_queries)) as executor:
        futures = {
            executor.submit(_run_single_query, qt, mode, k_per_query, did): qt
            for qt, did in valid_queries
        }
        for future in as_completed(futures):
            qt = futures[future]
            results = future.result()
            query_results.append((qt, results))
            logger.info("[RAG:retriever] Query '%s' → %d results", qt[:60], len(results))

    # Dedup
    seen_ids: set[str] = set()
    all_chunks: list[dict] = []
    for query_text, results in query_results:
        for chunk in results:
            chunk_key = f"{chunk.get('doc_id', '')}:{chunk.get('parent_chunk_index', '')}:{chunk.get('sub_chunk_index', '')}"
            if chunk_key in seen_ids:
                continue
            seen_ids.add(chunk_key)
            chunk["_query"] = query_text
            all_chunks.append(chunk)

    # Sort by score (desc)
    all_chunks.sort(key=lambda c: c.get("score", 0), reverse=True)
    logger.info("[RAG:retriever] Total unique chunks: %d", len(all_chunks))
    return all_chunks


# ── Source selector node ──────────────────────────────────────────

SELECTOR_MODEL = os.environ.get("RAG_SELECTOR_MODEL", "gpt-5-mini")

SELECTOR_SYSTEM = """\
Sei un esperto di normativa antincendio italiana. \
Ricevi una domanda dell'utente e una lista di chunk normativi estratti dal sistema di ricerca. \
Il tuo compito è SELEZIONARE solo i chunk realmente utili per rispondere alla domanda, \
scartando quelli ridondanti, irrilevanti o fuori tema.

## CRITERI DI SELEZIONE

1. **Rilevanza**: il chunk deve contenere informazioni direttamente pertinenti alla domanda.
2. **Non ridondanza**: se due chunk dicono sostanzialmente la stessa cosa, tieni solo il migliore \
   (quello più completo o con score più alto).
3. **Copertura**: assicurati di mantenere chunk che coprano tutti gli aspetti della domanda. \
   Non eliminare un chunk solo perché ha score basso se copre un aspetto non coperto da altri.
4. **Qualità**: scarta chunk che contengono solo indici, sommari, o testo frammentato non informativo.

Rispondi usando la funzione select_chunks."""

SELECTOR_SCHEMA = {
    "type": "object",
    "properties": {
        "selections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "chunk_index": {
                        "type": "integer",
                        "description": "Indice del chunk (0-based)",
                    },
                    "keep": {
                        "type": "boolean",
                        "description": "true = tieni, false = scarta",
                    },
                    "reason": {
                        "type": "string",
                        "description": "Breve motivo (max 20 parole)",
                    },
                },
                "required": ["chunk_index", "keep"],
            },
        },
        "summary": {
            "type": "string",
            "description": "Breve riepilogo della selezione",
        },
    },
    "required": ["selections", "summary"],
}


def select_sources(
    user_query: str,
    chunks: list[dict],
) -> tuple[list[dict], str]:
    """Source selector node: filter chunks by relevance, remove redundancy.

    Returns (filtered_chunks, summary).
    """
    if len(chunks) <= 3:
        logger.info("[RAG:selector] Only %d chunks, skipping selection", len(chunks))
        return chunks, f"Solo {len(chunks)} chunk, nessuna selezione necessaria"

    logger.info("[RAG:selector] Selecting from %d chunks", len(chunks))

    client = _get_client()

    # Build chunk summaries for the LLM
    chunk_descriptions = []
    for i, c in enumerate(chunks):
        doc_name = c.get("doc_name") or c.get("nome_legge") or "Documento"
        title = c.get("title") or "—"
        parent = c.get("parent_title") or ""
        pages = ""
        if c.get("page_start"):
            pages = f"pp. {c['page_start']}-{c.get('page_end', '?')}"
        score = c.get("score", 0)
        text_preview = (c.get("text") or "")[:300]

        desc = f"[Chunk {i}] {doc_name}"
        if parent:
            desc += f" > {parent}"
        desc += f" > {title}"
        if pages:
            desc += f" ({pages})"
        desc += f" [score: {score:.3f}]"
        desc += f"\n{text_preview}..."
        chunk_descriptions.append(desc)

    chunks_text = "\n\n---\n\n".join(chunk_descriptions)

    messages = [
        {"role": "system", "content": SELECTOR_SYSTEM},
        {"role": "user", "content": f"Domanda: {user_query}\n\n## CHUNK ESTRATTI\n\n{chunks_text}"},
    ]

    resp = client.chat.completions.create(
        model=SELECTOR_MODEL,
        messages=messages,
        tools=[{
            "type": "function",
            "function": {
                "name": "select_chunks",
                "description": "Selezione dei chunk da mantenere",
                "parameters": SELECTOR_SCHEMA,
            },
        }],
        tool_choice={"type": "function", "function": {"name": "select_chunks"}},
    )

    tool_call = resp.choices[0].message.tool_calls[0]
    data = json.loads(tool_call.function.arguments)
    selections = data.get("selections", [])
    summary = data.get("summary", "")

    # Build set of kept indices
    keep_indices = set()
    for sel in selections:
        if sel.get("keep", False):
            keep_indices.add(sel["chunk_index"])

    # If selector kept nothing (error), return all
    if not keep_indices:
        logger.warning("[RAG:selector] No chunks selected, keeping all")
        return chunks, "Errore selezione, mantenuti tutti"

    filtered = [c for i, c in enumerate(chunks) if i in keep_indices]

    usage = resp.usage
    logger.info(
        "[RAG:selector] Kept %d/%d chunks (%s) [tokens: %d in, %d out]",
        len(filtered), len(chunks), summary[:80],
        usage.prompt_tokens if usage else 0,
        usage.completion_tokens if usage else 0,
    )

    return filtered, summary


# ── Generator node ───────────────────────────────────────────────

GENERATOR_SYSTEM = """\
Sei un esperto di normativa antincendio italiana. \
Rispondi alle domande basandoti ESCLUSIVAMENTE sui passaggi normativi forniti come contesto. \
Se il contesto non contiene informazioni sufficienti, dillo chiaramente.

## REGOLE

1. **Cita sempre le fonti**: per ogni affermazione, indica il documento e la pagina. \
   Usa il formato [Documento, pp. X-Y] o [Documento, Art. N]. Cita le fonti inline, \
   vicino all'affermazione corrispondente, non solo alla fine della risposta.
2. **Sii preciso**: usa il linguaggio tecnico-normativo appropriato.
3. **Non inventare**: se i chunk non contengono la risposta, dì \
   "Non ho trovato riferimenti specifici nei documenti caricati".
4. **Contestualizza**: se la domanda è nel contesto di una conversazione, rispondi coerentemente.

## FORMATO DELLA RISPOSTA

Struttura SEMPRE la risposta in modo chiaro e organizzato:

- **Sezioni numerate**: se la domanda tocca più argomenti (es. 3 profili di rischio), \
  dedica una sezione numerata (## 1. Titolo) a ciascun argomento.
- **Sottopunti**: usa elenchi puntati con **grassetto** per i concetti chiave e le definizioni.
- **Parametri e formule**: quando descrivi procedure di calcolo, elenca chiaramente \
  i parametri coinvolti con le loro definizioni e valori possibili.
- **Tabelle normative**: quando i documenti contengono tabelle rilevanti (es. tabelle di classificazione), \
  riproducile in formato strutturato con elenchi o descrizione dei valori.
- **Sintesi iniziale**: apri con 1-2 frasi che sintetizzano la risposta complessiva.
- **Livello di dettaglio**: sii esaustivo. Includi tutti i dettagli presenti nei chunk \
  (categorie, sottocategorie, valori, condizioni, eccezioni).

## CONTESTO NORMATIVO

{chunks_context}"""


def _build_chunks_context(chunks: list[dict]) -> str:
    """Format retrieved chunks into context for the generator."""
    if not chunks:
        return "Nessun passaggio normativo trovato."

    parts = []
    for i, c in enumerate(chunks):
        doc_name = c.get("doc_name") or c.get("nome_legge") or "Documento"
        title = c.get("title") or "—"
        parent = c.get("parent_title") or ""
        pages = ""
        if c.get("page_start"):
            if c["page_start"] == c.get("page_end"):
                pages = f"p. {c['page_start']}"
            else:
                pages = f"pp. {c['page_start']}-{c.get('page_end', '?')}"
        keywords = ", ".join(c.get("keywords", []))
        score = c.get("score", 0)

        header = f"[Fonte {i+1}] {doc_name}"
        if parent:
            header += f" > {parent}"
        header += f" > {title}"
        if pages:
            header += f" ({pages})"
        if keywords:
            header += f" [kw: {keywords}]"
        header += f" [score: {score:.3f}]"

        text = c.get("text", "")
        parts.append(f"{header}\n{text}")

    return "\n\n---\n\n".join(parts)


def generate_streaming(
    user_query: str,
    history: list[dict],
    chunks: list[dict],
) -> Generator[str, None, None]:
    """Generator node: stream the answer with citations.

    Yields text chunks as they arrive from the LLM.
    """
    logger.info(
        "[RAG:generator] Generating answer (query: %s, %d chunks, %d history msgs)",
        user_query[:80], len(chunks), len(history),
    )

    client = _get_client()
    chunks_context = _build_chunks_context(chunks)
    system = GENERATOR_SYSTEM.format(chunks_context=chunks_context)

    messages = [{"role": "system", "content": system}]

    # Add history (skip system messages)
    for msg in history:
        messages.append({"role": msg["role"], "content": msg["content"]})

    messages.append({"role": "user", "content": user_query})

    stream = client.chat.completions.create(
        model=MODEL,
        messages=messages,
        stream=True,
    )

    full_text = []
    for chunk in stream:
        delta = chunk.choices[0].delta
        if delta.content:
            full_text.append(delta.content)
            yield delta.content

    logger.info(
        "[RAG:generator] Generated %d chars",
        sum(len(t) for t in full_text),
    )


# ── Full RAG pipeline ────────────────────────────────────────────

def run_rag_query(
    user_query: str,
    history: list[dict] | None = None,
    k_per_query: int = 8,
    search_mode: str = "hybrid",
) -> Generator[dict, None, None]:
    """Run the full RAG pipeline, yielding events for SSE streaming.

    Yields dicts with:
      {"type": "routing", "data": {queries, reasoning}}
      {"type": "retrieval", "data": {chunks_count, sources}}
      {"type": "selection", "data": {kept, total, summary}}
      {"type": "chunk", "data": "text piece"}   (streaming answer)
      {"type": "sources", "data": [{doc_name, title, pages, score}]}
      {"type": "done"}
      {"type": "error", "data": "message"}
    """
    if history is None:
        history = []

    def _build_sources(chunk_list):
        return [
            {
                "doc_name": c.get("doc_name") or c.get("nome_legge") or "",
                "title": c.get("title") or "",
                "parent_title": c.get("parent_title") or "",
                "pages": f"pp. {c.get('page_start', '?')}-{c.get('page_end', '?')}",
                "score": c.get("score", 0),
                "keywords": c.get("keywords", []),
            }
            for c in chunk_list
        ]

    try:
        # Step 1: Route
        logger.info("[RAG] === Starting RAG pipeline ===")
        route_result = route_query(user_query, history)
        yield {
            "type": "routing",
            "data": {
                "queries": route_result["queries"],
                "reasoning": route_result["reasoning"],
            },
        }

        # Step 2: Retrieve (parallel)
        chunks = retrieve(
            route_result["queries"],
            k_per_query=k_per_query,
            mode=search_mode,
        )

        yield {
            "type": "retrieval",
            "data": {
                "chunks_count": len(chunks),
                "sources": _build_sources(chunks),
            },
        }

        # Step 3: Select sources (filter redundancy/irrelevance)
        filtered_chunks, selection_summary = select_sources(user_query, chunks)
        sources = _build_sources(filtered_chunks)

        yield {
            "type": "selection",
            "data": {
                "kept": len(filtered_chunks),
                "total": len(chunks),
                "summary": selection_summary,
            },
        }

        # Step 4: Generate (streaming)
        for text_piece in generate_streaming(user_query, history, filtered_chunks):
            yield {"type": "chunk", "data": text_piece}

        yield {"type": "sources", "data": sources}
        yield {"type": "done"}
        logger.info("[RAG] === Pipeline complete ===")

    except Exception as e:
        logger.exception("[RAG] Pipeline error")
        yield {"type": "error", "data": str(e)}
