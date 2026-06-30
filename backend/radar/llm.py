"""LLM provider seam (Vertex-ready).

All radar LLM calls go through `complete_json`. Today it targets the Anthropic
Messages API with the key already in the app. To move to Vertex AI Claude later,
swap the body/auth in `_call_anthropic` for a `_call_vertex` — callers don't change.

`available()` lets the pipeline degrade to deterministic heuristics when no key is
configured, so the structured-feed pipeline still runs end-to-end without an LLM.
"""

from __future__ import annotations

import json
import re

import httpx

from app import config as app_config
from .config import LLM_MODEL

_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
_ANTHROPIC_VERSION = "2023-06-01"


def available() -> bool:
    return bool(app_config.ANTHROPIC_API_KEY)


def _extract_json(text: str) -> str | None:
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.I)
    if fenced:
        return fenced.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        return text[start : end + 1]
    return None


async def _call_anthropic(system: str, user: str, max_tokens: int) -> str:
    api_key = app_config.ANTHROPIC_API_KEY
    body = {
        "model": LLM_MODEL,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.post(
            _ANTHROPIC_URL,
            headers={
                "Content-Type": "application/json",
                "x-api-key": api_key,
                "anthropic-version": _ANTHROPIC_VERSION,
            },
            json=body,
        )
    res.raise_for_status()
    data = res.json()
    return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()


async def complete_json(system: str, user: str, max_tokens: int = 1500) -> dict | None:
    """Return a parsed JSON object from the model, or None on any failure.

    Callers must handle None by falling back to a deterministic path.
    """
    if not available():
        return None
    try:
        text = await _call_anthropic(system, user, max_tokens)
    except Exception:  # noqa: BLE001 — network/HTTP/parse all degrade to heuristic
        return None
    raw = _extract_json(text)
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None
