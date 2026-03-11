"""FastAPI router for RAG chat with normativa documents."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Form
from fastapi.responses import JSONResponse, StreamingResponse

from backend.normativa.rag_graph import run_rag_query

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["chat"])

# ── In-memory conversation store ─────────────────────────────────
# {conv_id: {id, title, created_at, messages: [{role, content, sources?, timestamp}]}}
conversations: dict[str, dict] = {}


@router.get("/conversations")
async def list_conversations():
    """List all conversations, most recent first."""
    convs = sorted(
        conversations.values(),
        key=lambda c: c["created_at"],
        reverse=True,
    )
    return [
        {
            "id": c["id"],
            "title": c["title"],
            "created_at": c["created_at"],
            "message_count": len(c["messages"]),
        }
        for c in convs
    ]


@router.post("/conversations")
async def create_conversation(title: str = Form("")):
    """Create a new conversation."""
    conv_id = uuid.uuid4().hex[:8]
    conv = {
        "id": conv_id,
        "title": title or "Nuova conversazione",
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "messages": [],
    }
    conversations[conv_id] = conv
    logger.info("[Chat] Created conversation %s", conv_id)
    return conv


@router.get("/conversations/{conv_id}")
async def get_conversation(conv_id: str):
    """Get a conversation with all messages."""
    conv = conversations.get(conv_id)
    if not conv:
        return JSONResponse(status_code=404, content={"error": "Conversation not found"})
    return conv


@router.delete("/conversations/{conv_id}")
async def delete_conversation(conv_id: str):
    """Delete a conversation."""
    if conv_id in conversations:
        del conversations[conv_id]
        logger.info("[Chat] Deleted conversation %s", conv_id)
    return {"ok": True}


@router.post("/conversations/{conv_id}/message")
async def send_message(
    conv_id: str,
    message: str = Form(...),
    k_per_query: int = Form(5),
    search_mode: str = Form("hybrid"),
):
    """Send a message and get a streaming SSE response.

    The response is a Server-Sent Events stream with events:
      - routing: search queries generated
      - retrieval: chunks found
      - chunk: text piece of the answer (streaming)
      - sources: final source citations
      - done: generation complete
      - error: something went wrong
    """
    conv = conversations.get(conv_id)
    if not conv:
        # Auto-create
        conv = {
            "id": conv_id,
            "title": message[:50] + ("..." if len(message) > 50 else ""),
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "messages": [],
        }
        conversations[conv_id] = conv

    # Add user message
    conv["messages"].append({
        "role": "user",
        "content": message,
        "timestamp": datetime.now().isoformat(timespec="seconds"),
    })

    # Update title if first message
    if len(conv["messages"]) == 1:
        conv["title"] = message[:50] + ("..." if len(message) > 50 else "")

    logger.info(
        "[Chat] Message in conv %s: %s (%d history msgs)",
        conv_id, message[:60], len(conv["messages"]) - 1,
    )

    # Build history (all messages except the last user message)
    history = [
        {"role": m["role"], "content": m["content"]}
        for m in conv["messages"][:-1]
    ]

    def event_stream():
        full_answer = []
        final_sources = []

        for event in run_rag_query(
            user_query=message,
            history=history,
            k_per_query=k_per_query,
            search_mode=search_mode,
        ):
            event_type = event["type"]

            if event_type == "chunk":
                full_answer.append(event["data"])

            if event_type == "sources":
                final_sources = event["data"]

            # Send SSE event
            yield f"event: {event_type}\ndata: {json.dumps(event.get('data', ''), ensure_ascii=False)}\n\n"

            if event_type == "done":
                # Save assistant message
                conv["messages"].append({
                    "role": "assistant",
                    "content": "".join(full_answer),
                    "sources": final_sources,
                    "timestamp": datetime.now().isoformat(timespec="seconds"),
                })
                logger.info(
                    "[Chat] Response saved to conv %s (%d chars, %d sources)",
                    conv_id, len("".join(full_answer)), len(final_sources),
                )

            if event_type == "error":
                # Save error as assistant message
                conv["messages"].append({
                    "role": "assistant",
                    "content": f"Errore: {event.get('data', 'sconosciuto')}",
                    "timestamp": datetime.now().isoformat(timespec="seconds"),
                })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
