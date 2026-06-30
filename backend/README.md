# DTC CRM — Python Backend

A Python/FastAPI port of the TypeScript backend that lived in `src/utils/*.server.ts`
and `src/utils/*.functions.ts`. It exposes the same three integrations
(**Asana**, **Google Sheets**, **Apollo.io**) as REST endpoints the existing
React frontend can call.

## What was ported

| TypeScript source | Python module | Notes |
|---|---|---|
| `src/utils/asana.server.ts` | `app/asana.py` | Tasks/portco fields/events, 5-min cache |
| `src/utils/sheets.server.ts` | `app/sheets.py` | OAuth2 refresh-token auth, read/append/update, data builders |
| `src/utils/apollo.server.ts` | `app/apollo.py` | `/people/match` → `/contacts/search` fallback |
| `src/utils/*.functions.ts` | `app/main.py` | TanStack server fns → FastAPI routes |
| `src/lib/types.ts` | `app/models.py` | Pydantic models (camelCase JSON via aliases) |

The JSON shape is unchanged: response models serialize with camelCase aliases
(`linkedinUrl`, `followUpPending`, …), so the frontend sees the same payloads it
got from the TanStack server functions.

## Endpoint map

| Method | Path | Replaces (server fn) |
|---|---|---|
| GET  | `/api/contacts` | `fetchContacts` |
| GET  | `/api/targets` | `fetchTargets` |
| GET  | `/api/portfolio-companies` | `fetchPortfolioCompanies` |
| POST | `/api/notes` | `addNote` |
| POST | `/api/events` | `addEvent` |
| POST | `/api/portco-intros` | `addPortcoIntro` |
| POST | `/api/contacts` | `addContact` |
| POST | `/api/targets` | `addTarget` |
| POST | `/api/resolve-follow-up` | `resolveFollowUp` |
| GET  | `/api/asana/portco-data` | `fetchAsanaPortcoData` |
| GET  | `/api/asana/events` | `fetchAsanaEvents` |
| POST | `/api/apollo/enrich` | `enrichContact` |
| GET  | `/api/health` | _(new)_ liveness probe |

POST bodies accept the same field names as the original `inputValidator`s
(camelCase, e.g. `{ "contactEmail": "...", "noteContent": "...", "requiresFollowUp": true }`).

## Configure

Reuse the existing project `.env` (the same vars as `.env.example`). The loader
looks for `.env` at the project root and next to the `backend/` package. Each
integration degrades gracefully: with its vars missing, the GET routes return
empty data instead of erroring.

Optionally set `CORS_ORIGINS` (comma-separated) to allow your frontend origin.
Defaults to `http://localhost:5173,http://localhost:3000`.

## Run

```powershell
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

Interactive API docs: http://localhost:8000/docs

> **Note on Python version:** developed/tested against Python 3.9. If you create
> a virtualenv with the Microsoft Store build of Python and `venv` misbehaves
> (a known Store-Python quirk), install into your user site with
> `python -m pip install --user -r requirements.txt` instead, or use a
> python.org / pyenv interpreter.

## Test

An offline smoke test (no network, no creds) exercises the builders, the Asana
field parsing, and the Apollo extraction with mocked data:

```powershell
python test_smoke.py
```

## Differences from the TypeScript version

- **Sample-data fallback:** the TS `fetch*` functions fell back to bundled
  `src/lib/sample-data.ts` on error. This port follows the documented
  `.env.example` contract instead ("returns no data instead of crashing") and
  returns an empty list. If you want sample data, drop fixtures into a module and
  return them from the `except` blocks in `app/main.py`.
- **Caching** is in-process and per-worker (same as the original module-level
  `Map`). Run a single Uvicorn worker, or move to a shared cache (e.g. Redis) if
  you scale out.
