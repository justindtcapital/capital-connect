"""Environment configuration.

Mirrors the env vars documented in the project's `.env.example`. All values are
read server-side only. Each integration degrades gracefully: if its vars are
missing, that feature simply returns no data instead of crashing the app.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

# Load a `.env` file sitting at the project root (one level above `backend/`),
# falling back to a `.env` next to this package. `load_dotenv` is a no-op if the
# file is absent, so this is safe in every environment.
load_dotenv()


def get(name: str) -> str | None:
    """Return an env var, treating empty strings as unset (matching the TS code,
    where `process.env.FOO` being `""` is falsy)."""
    value = os.environ.get(name)
    return value if value else None


# ── Asana ────────────────────────────────────────────────────────────────────
ASANA_ACCESS_TOKEN = get("ASANA_ACCESS_TOKEN")
ASANA_PORTCO_PROJECT_GID = get("ASANA_PORTCO_PROJECT_GID")
ASANA_EVENTS_PROJECT_GID = get("ASANA_EVENTS_PROJECT_GID")

# ── Google Sheets ────────────────────────────────────────────────────────────
GOOGLE_CLIENT_ID = get("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = get("GOOGLE_CLIENT_SECRET")
GOOGLE_REFRESH_TOKEN = get("GOOGLE_REFRESH_TOKEN")
GOOGLE_SPREADSHEET_ID = get("GOOGLE_SPREADSHEET_ID")

# ── Apollo ───────────────────────────────────────────────────────────────────
APOLLO_API_KEY = get("APOLLO_API_KEY")

# ── Anthropic (Claude) ───────────────────────────────────────────────────────
# Used by the Signal Radar worker's LLM seam (triage scoring/classification).
ANTHROPIC_API_KEY = get("ANTHROPIC_API_KEY")

# ── CORS ─────────────────────────────────────────────────────────────────────
# Comma-separated list of allowed origins for the React frontend. Defaults to the
# common Vite dev-server ports.
CORS_ORIGINS = [
    o.strip()
    for o in (get("CORS_ORIGINS") or "http://localhost:5173,http://localhost:3000").split(",")
    if o.strip()
]
