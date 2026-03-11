"""Custom entity extraction from documents using multimodal LLM."""

from __future__ import annotations

import base64
import json
import logging
import os
from pathlib import Path

import pdfplumber
from openai import OpenAI

logger = logging.getLogger(__name__)

MODEL = "gpt-5"

# Image file extensions handled via vision (multimodal)
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}


def _get_client() -> OpenAI:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY non impostata")
    return OpenAI(api_key=api_key, max_retries=5)


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


def _file_to_content_parts(file_path: str, mime_type: str) -> list[dict]:
    """Convert a file to OpenAI message content parts.

    Images → base64 image_url part (multimodal vision).
    PDFs   → extracted text part.
    """
    ext = Path(file_path).suffix.lower()

    if ext in IMAGE_EXTENSIONS:
        with open(file_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        media_type = mime_type or f"image/{ext.lstrip('.')}"
        if media_type == "image/jpg":
            media_type = "image/jpeg"
        return [
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:{media_type};base64,{b64}",
                    "detail": "high",
                },
            }
        ]

    # PDF → extract text
    if ext == ".pdf":
        pages: list[str] = []
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if text:
                    pages.append(text)
        full_text = "\n\n".join(pages)
        if not full_text.strip():
            return [{"type": "text", "text": "[Documento PDF vuoto o non leggibile]"}]
        return [{"type": "text", "text": full_text}]

    return [{"type": "text", "text": "[Formato file non supportato]"}]


def _build_extraction_tool(schema: list[dict]) -> dict:
    """Build an OpenAI function-calling tool from the user's schema."""
    properties = {}
    for field in schema:
        properties[field["nome"]] = {
            "type": ["string", "null"],
            "description": field.get("descrizione", ""),
        }

    return {
        "type": "function",
        "function": {
            "name": "report_entities",
            "description": "Riporta le entità estratte dal documento.",
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": list(properties.keys()),
                "additionalProperties": False,
            },
        },
    }


SYSTEM_PROMPT = """\
Sei un assistente esperto nell'analisi di documenti tecnici per ingegneri antincendio.

Ti vengono forniti uno o più documenti (PDF o immagini fotografiche di documenti).
Devi estrarre le informazioni richieste dallo schema fornito.

Regole:
- Estrai SOLO informazioni presenti nel documento. Non inventare.
- Se un campo non è presente nel documento, rispondi null.
- Per le immagini fotografiche, leggi il testo visibile nella foto.
- Sii preciso: copia i valori esattamente come appaiono nel documento.
- Se un valore appare in più formati, usa il più completo.
"""


def extract_entities_from_files(
    file_paths: list[str],
    file_names: list[str],
    mime_types: list[str],
    schema: list[dict],
) -> list[dict]:
    """Extract entities from multiple files using a single LLM call per file.

    Returns a list of {campo, valore, fonte} dicts.
    """
    client = _get_client()
    tool = _build_extraction_tool(schema)
    field_names = [f["nome"] for f in schema]

    # Results: campo → {valore, fonte}
    results: dict[str, dict] = {}

    for file_path, file_name, mime_type in zip(file_paths, file_names, mime_types):
        logger.info("[EntityExtraction] Processing %s (%s)", file_name, mime_type)

        content_parts = _file_to_content_parts(file_path, mime_type)

        # Add instruction text
        fields_desc = "\n".join(
            f"- {f['nome']}: {f.get('descrizione', '')}" for f in schema
        )
        instruction = (
            f"Analizza il seguente documento ({file_name}) ed estrai i campi richiesti.\n\n"
            f"Campi da estrarre:\n{fields_desc}\n\n"
            "Usa la funzione report_entities per riportare i risultati. "
            "Metti null per i campi non trovati."
        )

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [{"type": "text", "text": instruction}] + content_parts,
            },
        ]

        try:
            resp = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                tools=[tool],
                tool_choice={"type": "function", "function": {"name": "report_entities"}},
            )
            _log_usage(f"EntityExtraction:{file_name}", resp)

            tool_call = resp.choices[0].message.tool_calls[0]
            extracted = json.loads(tool_call.function.arguments)

            # Merge into results: first non-null value wins
            for campo in field_names:
                val = extracted.get(campo)
                if val is not None and campo not in results:
                    results[campo] = {"valore": val, "fonte": file_name}

        except Exception as e:
            logger.error("[EntityExtraction] Error processing %s: %s", file_name, e)
            continue

    # Build final entity list (preserving schema order)
    entities = []
    for campo in field_names:
        if campo in results:
            entities.append({
                "campo": campo,
                "valore": results[campo]["valore"],
                "fonte": results[campo]["fonte"],
            })
        else:
            entities.append({"campo": campo, "valore": None, "fonte": None})

    return entities
