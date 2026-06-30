# Venture Pulse CRM — Comprehensive Architecture & Workflow Audit

> Prepared as a Principal Software Architect / Product Architect / Staff Data Engineer / Enterprise CRM consultant review.
> Scope: the full `DTC_CRM_Local` codebase (~32.5K lines TS/TSX across `src/`, plus a Python `backend/`). Method: 13 subsystem deep-reads → 5 cross-cutting syntheses, every load-bearing claim re-verified against source with `file:line` citations.

---

## Executive Summary

Venture Pulse (a.k.a. DTC CRM / "VenturePulse — DTC Network Intelligence") is a polished, ambitious, AI-rich **single-firm internal prototype** that has hit the structural ceiling of its data layer and would not survive contact with real multi-user, multi-firm use. It looks like a relationship-intelligence platform; it behaves like a demo with persistence holes.

Four findings dominate everything else, and every other issue in this report is downstream of one of them:

1. **The "database" is a single Google Spreadsheet (~24 tabs) with no primary keys, no foreign keys, no transactions, no locking, and no indexes.** Every read is a full-tab REST fetch; every targeted write is an O(n) linear scan; every cross-entity relationship is joined at render time on free-text strings (lowercased email, `name|company`, normalized company name, exact event name) that the app *itself lets users edit* — silently orphaning the related rows. Record "IDs" are array indices (`c-${idx}`, `t-${idx}`) that renumber on any sheet edit. The existence of hand-written repair scripts (`backend/fix_carmen.py` rewrites a single misaligned contact row; `backend/cleanup_duplicates.py` removes re-added duplicates) is direct proof this corruption has already happened in production.

2. **Core user actions silently do not persist.** The entire Targeting pipeline — stage changes, "Promote to CRM," manual/paste/CSV lead creation — mutates React state only and never calls a server function, so it **resets to "Prospecting" and loses hand-entered leads on every refresh**. The same optimistic-local-with-no-server-write anti-pattern recurs across interaction edits, intro/event removals, bulk notes, applied LinkedIn URLs, and every AI artifact. The UI reports success; the data is gone on reload. This is a systemic *trust* failure, not a set of minor bugs.

3. **AI output is generated and thrown away.** Of ~12 AI features, only two persist anything. DNA scores, connection plans, drafts, daily briefings, broadcast rankings, intro insights, and signal attributions are computed, displayed once, and discarded — so the CRM never accumulates intelligence, identical inferences are re-billed on every panel open, and two users (or the same user twice) see different "top opportunities" and different scores for the same record. There is no embedding/retrieval layer, so relevance is recomputed by sending raw rows to Gemini every time, with hard caps (120 contacts, 150 people) that silently hide the rest of the network.

4. **The richest behavioral data is read but never feeds the relationship score.** Asana BD/GTM activity and inbound Gmail are both ingested and attributed to contacts, then the attribution is discarded. `scoreContact` sees only manually-entered Sheet notes, so a contact with ten logged BD activities and real two-way email traffic scores **Cold** — which then drives the wrong "who to contact today" queue. The product's headline ("automatic network scorecard") is structurally disconnected from the data that would make it true.

Layered on top: **authentication is client-side theater** (a hardcoded single-email allowlist in `localStorage`; server functions have no auth gate and accept an arbitrary `user` string defaulting to `"tester"`), the app is **single-tenant by construction** (one spreadsheet, one allowlist), and there are **three-to-four parallel, drifting backends** writing the same sheet (the live TS pipeline, an orphaned Python `radar` signals worker, a dead FastAPI mirror, and a pile of manual mutation scripts).

**Bottom line for the CTO:** the TanStack/React frontend is salvageable, but the persistence and execution substrate must be replaced before this scales even to a handful of firms — let alone the 100-firm / 10M-contact / 100M-signal target. The good news is that much of the plumbing for the highest-value fixes (non-destructive enrichment merge, email attribution, dedup, a `urid` surrogate-key column) *already exists in the code and is merely unused or disconnected*. The roadmap in Part 15 is therefore front-loaded with high-leverage "wire what's already built" work ahead of the inevitable re-platform.

---

# Part 1 — Overall Architecture

## 1.1 Stack at a glance

| Layer | Technology | Notes |
|---|---|---|
| Framework | **TanStack Start** (SSR) + **React 19** | File-based routing via TanStack Router (`src/routes/*`, generated `routeTree.gen.ts`) |
| UI | Radix UI primitives + Tailwind CSS v4 (shadcn-style `src/components/ui/*`), `recharts`, `lucide-react`, `react-hook-form` + `zod`, `sonner` toasts | ~50 vendored UI components |
| "Backend" | **TanStack `createServerFn`** server functions in `src/utils/*.functions.ts`, delegating to `*.server.ts` modules | No separate API server in the live path; server fns run on the SSR/edge runtime |
| Data store | **Single Google Spreadsheet (~24 tabs)** via Sheets REST v4 | OAuth2 refresh-token auth (`sheets.server.ts:42-106`); the *entire* system of record |
| LLM | **Gemini on Vertex AI** (`@google-cloud/vertexai`) | Actual model `gemini-2.5-flash` (`gemini.server.ts:18`) despite docs/memory saying 2.5-pro; Anthropic deprecated/removed |
| Auth | **Client-side `localStorage` email allowlist** (`auth-context.tsx`) | No server-side authn/authz on any server fn |
| Deploy target | **Cloudflare Workers** (apparent) | `wrangler.jsonc`, `@cloudflare/vite-plugin` — serverless, which invalidates the per-instance in-process caches |
| Client state | 9 hand-rolled React Contexts + route-loader data + per-component `useState` | React Query is installed but **used nowhere** (0 source imports) |

## 1.2 Integrations

| Integration | Purpose | Auth | In the live app? |
|---|---|---|---|
| Google Sheets | The database | OAuth refresh token | Yes — core |
| Gemini / Vertex AI | All LLM features | ADC / service-account JSON | Yes — core |
| Asana | PortCo / Events / BD / GTM activity (read) | Personal Access Token | Yes (display-only; not scored) |
| Apollo | Person/org enrichment + people search | API key | Yes (manual, one-at-a-time; write-back path dead) |
| Sumble | Technographics + org/people intelligence | API key | Yes (results never persisted; re-billed per view) |
| Gmail | Inbound email → signal grounding | Reuses Google OAuth token | Yes (attribution discarded) |
| Google Drive | PDF grounding for signal scan | Reuses Google OAuth token | Yes (re-downloads bytes each scan) |
| LinkedIn | Firm's own org posts | Separate ~60-day non-refreshing token (`mint-linkedin-token.mjs`) | Yes (own page only; silent 401s) |
| News (Event Registry) | Signal grounding | `NEWSAPI_KEY` | Yes (substring company match → false positives) |

## 1.3 What does *not* exist

- **No real database / no ORM / no migrations** — schema "evolves" via best-effort `ensureTab`/`ensureColumn`/`ensureHeaderRow` on the hot path.
- **No background jobs / queues** — signal scans, bulk imports, enrichment, and AI generation all run **inline in request handlers**.
- **No shared cache** — only a 5-minute per-process in-memory `Map` (`sheets.server.ts:28-37`), useless on serverless/multi-instance and a stale-read hazard inside read-modify-write flows.
- **No vector store / embeddings / retrieval** — relevance is recomputed by re-sending raw rows to the LLM.
- **No object/blob storage** — large AI payloads are JSON-stuffed into single spreadsheet cells (50K-char cell ceiling risk).
- **No server-side auth, no multi-tenancy, no per-user data scoping.**
- **No React Query usage** despite the dependency — there is no normalized client cache or entity store.

## 1.4 Parallel / dead backends (a maintenance and data-integrity hazard)

The repo contains **four** data backends competing for the same spreadsheet:

1. **Live path** — TanStack server fns (TS) → Sheets. The only one users touch.
2. **`backend/app/` FastAPI** — a Python mirror of `apollo`/`asana`/`sheets` with a hand-maintained Pydantic copy of `types.ts`. **Zero frontend references** — dead, drifting code.
3. **`backend/radar/`** — a structured-signal ingestion pipeline (EDGAR, ATS jobs, GitHub, Google News) that targets *Anthropic* and writes a `Radar Signals` tab. **No FastAPI route, no scheduler, no UI read path** — 100% of its (high-trust) output is invisible to the app.
4. **One-off mutation scripts** (`cleanup_duplicates.py`, `fix_carmen.py`, `reorder_contacts.py`, `provision_sheet.py`) — the *de facto* data pipeline, performing destructive `deleteDimension`/`values:clear` against the live sheet with no dry-run. Three of them define **conflicting** Contacts column orders, proving the canonical schema is undefined.

## 1.5 Architecture diagram (text)

```
                                  ┌──────────────────────────────────────────────┐
                                  │                 BROWSER (React 19)             │
                                  │  TanStack Router routes (file-based)           │
                                  │   / index dashboard · /crm · /targeting        │
                                  │   /portfolio · /companies · /signals           │
                                  │   /dashboard · /events · /query (AI agent)     │
                                  │                                                │
                                  │  CLIENT STATE (3 uncoordinated systems):       │
                                  │   1) route loader data → useLoaderData()       │
                                  │   2) 9 React Contexts (filters/selection/auth) │
                                  │   3) per-component useState (often "the truth") │
                                  │  ── React Query installed but UNUSED ──        │
                                  │  AUTH = localStorage email allowlist (client)  │
                                  └───────────────┬────────────────────────────────┘
                                                  │ TanStack server-fn RPC (no authz)
                                                  ▼
                ┌─────────────────────────────────────────────────────────────────────┐
                │            SERVER FUNCTIONS  (src/utils/*.functions.ts)               │
                │   sheets · llm · gemini · sumble · apollo · asana · gmail · drive     │
                │   linkedin · news · discovery · prospects · accounts · insights ·     │
                │   broadcast · activity-sourcing · gems(registry/run) · llm-log        │
                │            delegate to  →  *.server.ts (raw fetch/httpx)              │
                │   Cache: ONE 5-min in-process Map (per instance) · no queue/jobs      │
                └───┬───────────────┬───────────────┬───────────────┬─────────────────┘
                    │               │               │               │
            ┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼──────┐ ┌──────▼─────────────────┐
            │ GOOGLE SHEETS│ │  GEMINI /    │ │  ASANA     │ │ APOLLO · SUMBLE · GMAIL │
            │ ~24 tabs =   │ │  VERTEX AI   │ │ (PortCo/   │ │ DRIVE · LINKEDIN · NEWS │
            │ THE DATABASE │ │ 2.5-flash    │ │  Events/   │ │ (bare fetch, no retry/  │
            │ full-tab R/W │ │ +googleSearch│ │  BD/GTM)   │ │  backoff/rate-limit)    │
            │ no PK/FK/txn │ │ no schema    │ │ display    │ │ enrichment mostly       │
            │ index-as-ID  │ │ no streaming │ │ only       │ │ discarded / write-only  │
            └──────────────┘ └──────────────┘ └────────────┘ └─────────────────────────┘
                    ▲
                    │ writes the SAME sheet, out of band  (DATA-INTEGRITY HAZARD)
          ┌─────────┴───────────────────────────────────────────────┐
          │  DEAD / ORPHANED BACKENDS (Python, backend/)             │
          │   • FastAPI mirror (app/)        → no frontend refs      │
          │   • radar/ signals (Anthropic)   → "Radar Signals" tab,  │
          │                                     never read by app    │
          │   • cleanup_duplicates / fix_carmen / reorder_contacts   │
          │     → manual destructive edits = the real data pipeline  │
          └─────────────────────────────────────────────────────────┘

JOIN MODEL (the root defect): every cross-tab relationship is resolved at READ time by
free-text key — lowercased email · name|company · normCompany · exact event name —
with NO stable surrogate id (a `urid` column is mapped at sheets.server.ts:823 but never written).
```

---


# Part 2 — End-to-End Data Flow

The app's universal data path is: **UI → TanStack `createServerFn` (`*.functions.ts`) → server builder/primitive (`*.server.ts`) → Google Sheets REST**, with React Router loaders for reads and `router.invalidate()` for refresh. There is **no React Query** anywhere (it is a dependency with zero source imports) and **no transform/normalization layer** beyond per-builder ad-hoc coercion. Below, each feature is traced with the precise mutation points flagged.

## 2.1 Contacts (the core CRM record)

**Read:** route loader → `fetchContacts` → `buildContacts` (`sheets.server.ts:943`) runs `Promise.all` of **six full-tab fetches** (Contacts, Events, Notes/"interactions", PortCos Introduced, Rating Overrides, Field Provenance), then `mapRows` (header-name) + `groupBy` on **lowercased email** (`:960-962`) → per-contact object with **computed** `activityScore` (`scoreContact`, `:1044`), `ratingLocked`, `fieldProvenance`.

**Mutation points (data changes shape or value, not just storage):**
- `id` is assigned as the **array index** `c-${idx}` (`:1018`) — *invented at read time, unstable.*
- `temperature` is coerced: `rawTemp === "Hot"|"Warm"|"Cold" ? rawTemp : "Cold"` (`:1013-1015`) — *silent value mutation.*
- `eventsInvited = [...new Set([...eventsInvited, ...eventsAttended])]` (`:1032`) — *fabricated union; invited can never be distinguished from attended.*
- `lastContact = c.dateAdded || interactions[0]?.date` (`:1034`) — *misnomer; `interactions[0]` is sheet order, not most-recent.*
- Every interaction is read back as `type: "note"` (`:990`) — *the user-chosen InteractionType is discarded.*
- `areasOfInterest` is **inferred** from title/company/sector when the cell is blank (`:1007-1010`) — *read-time synthesis the UI cannot tell from stored data.*
- `source` is run through `normalizeSource` (`types.ts:45-56`) collapsing the stored free text into one of five buckets.

**Write (field edit):** `mergeContactFields` (`sheets.server.ts` ~1230-1315) fetches the **whole Contacts tab**, linear-scans for the email row, computes A1 ranges, `updateSheetCells`, then `appendSheetRows` to Field Provenance. The `source:"apollo"` branch (`:1287-1294`) is a careful non-destructive fill-only merge — **but it is dead code**: every caller passes `source:"user"` (`shouldWrite=true` always, `:1284-1285`), so the provenance-protection engine is never exercised in production.

**Write (add):** `addContactRow` (`:680-714`) is **header-aware** — it places each value into the column whose header matches, so single-contact adds survive column reordering. This is the *one* safe write path and stands in direct contrast to the Targets path below.

## 2.2 Targets / Prospecting pipeline (the split-brain core)

**Read:** `buildTargets` joins three full-tab reads (Targets, Target Outreach, Target Strategy) on `targetKeyOf` = email else `name|company` lowercased (`types.ts:192-196`). Stage is cast `(t.stage||"Prospecting")` with no whitelist.

**Write (add):** `addTarget` (`sheets.functions.ts:206-221`) does a **positional 14-column append** that must match `TARGET_HEADERS` (`sheets.server.ts:869-884`). The prospect importer (`prospects.functions.ts:436-451`) appends positionally too, with an explicit comment "phone has no target column" — **phone is dropped from Targets entirely** and only written to an audit tab nobody reads (`:452-454`). Reads are header-named (`TARGET_COLS:848-864`). **This positional-write / named-read asymmetry is the schema's central fragility:** a single column insert via the Sheets UI silently misaligns every future append.

**Mutation points:** target `id` = `t-${idx}` (read-time index); the Apollo path optimistically uses `t-apollo-${id}` which won't match the reloaded `t-${idx}`. `targetKeyOf` is **derived, not stored** — `updateTargetFields` can edit email/name/company (`:1682-1696`), which **changes the key and silently detaches all saved outreach + AI connection plans**.

**Critical non-persistence:** stage changes, "Promote to CRM", manual New Target, paste, and CSV import all call `setTargets()` only and **never hit a server fn** (`targeting.tsx:517-606, 809-818`). `buildTargets` always defaults stage to "Prospecting", so **the entire pipeline silently resets on reload** — the page's reason to exist does not survive a refresh.

## 2.3 Notes / Interactions / Follow-ups

`addNote` stores content + follow-up flag only; type is not stored, so it round-trips as `note`. `resolveFollowUp` (`sheets.functions.ts:264-292`) matches the row by **exact note text** (`rowNote === data.noteContent.trim()`, `:284`) — editing a note orphans its follow-up toggle, and duplicate-text notes flip together. The column letter is computed `String.fromCharCode(65 + resolvedIdx)` (`:285`), correct only for columns A–Z (the correct `colLetters()` exists at `sheets.server.ts:351` but isn't reused).

## 2.4 AI caches (PortCo Intel, Customer Discovery, Signals)

All three use a **flat-columns + one "Data" JSON cell** shape, upserted by **read-find-then-writeSheetRow** keyed on `normKey(companyName)` — *free text, not an ID* (`sumble.functions.ts:89-98`, `discovery.functions.ts:58-67`). Signals append-only with content-hash dedup (`gemini.functions.ts:462-474`). **None have a TTL** for Intel/Discovery; a company cached once is served forever until a manual force-refresh. Customer Discovery serializes an entire `DiscoveryResult` (opportunities + decision-makers + outreach copy) into one cell — opaque to every other reader and at risk of the 50k-char cell limit. Signal grounded scores (`opportunity/network/competitive`) are **recomputed client-side every render** (`signal-feed.ts:418`) and never stored, so the same persisted signal shows a different score on every visit.

## 2.5 Snapshots / audit logs / append-only tables

`recordDailySnapshot` (`sheets.server.ts:474-516`) reads the **cached** tab for an idempotency check (`:492`), so two near-simultaneous Home opens both pass "no row today" and append duplicate rows. `LLM_Query_Log` finalize does read-full-tab + linear-scan + write-in-place by `query_id` (`llm-log.server.ts:74-91`) — a read-modify-write race where the cache can hide the just-appended row, forcing a duplicate.

## 2.6 The silent-mock fallback (worst data-flow hazard)

`fetchContacts/fetchTargets/fetchPortfolioCompanies` wrap the builders in try/catch and return `sampleContacts/Targets/PortfolioCompanies` on **any** error (`sheets.functions.ts:46-71`). A transient Sheets 429/500/auth blip renders fake DTC contacts (Glossier, Casper…) **indistinguishable from real data**, and any write attempted against a sample email no-ops or mis-targets.

---


# Part 3 — Connection Audit

This section maps every meaningful data flow by where it originates, whether it is live/cached/mocked/persisted, whether it survives a refresh, and how it can go inconsistent. The map readers did excellent forensic work; I have re-verified the load-bearing claims against source and the picture is worse than any single subsystem report conveys, because the failure modes compound across subsystems.

## 3.1 The core architectural defect that drives everything below

There is **no stable identity for any entity** and **no separate facts/events layer**. Every join in the application is computed at read time from one of three fragile free-text keys:

| Entity | Join key | Where derived | Failure mode |
|---|---|---|---|
| Contact | array index `c-${idx}` + lowercased `email` | `sheets.server.ts:1018`, `:960-962` | Renumbers on any row insert/delete; emailless contacts join to nothing |
| Target | array index `t-${idx}` + `targetKeyOf` (email, else `name\|company`) | `sheets.server.ts:1744`, `types.ts:192-196` | Editing email/name/company re-keys the row and orphans outreach + AI plans |
| Company | `normCompany` = trim+lowercase free text | `company-intel.ts:88`, `portfolio.tsx:32` | "Acme" / "Acme, Inc." / "acme.ai" fracture into distinct entities |
| Event/Synopsis | lowercased event **name** | `events.tsx:286` | Same-named events collide on one synopsis |
| Signal→Contact | none (synthetic `signal-${email}`) | `signals.tsx:364` | Acting on a signal touches no real record |

A `urid` column is even mapped in `CONTACT_COLS` (`sheets.server.ts:823`) but **never written, read, or joined** — the surrogate-key slot exists and is abandoned. Until this is fixed, every "connection" in the app is a substring coincidence, and every "missing connection" in Part 4 is ultimately a symptom of this one root cause.

## 3.2 Connection inventory by surface

### Contacts / CRM (`crm.tsx`, `ContactDetail.tsx`)

| Flow | State | Persisted | Survives refresh | Inconsistency risk |
|---|---|---|---|---|
| Field edit → Contacts + Field Provenance | live + optimistic | yes | yes | Row located by **old** `primaryEmail`; editing the email itself writes name/title to the old row and orphans provenance. No rollback on write failure — UI shows the edit, sheet doesn't. |
| Add interaction → Notes | optimistic + live | content yes, **type no** | partial | `addNote` stores no type; reader hardcodes `type:"note"` (`sheets.server.ts:990`). Every call/meeting/email returns as a generic Note on reload. |
| **Edit existing interaction** | **local only** | **NO** | **no** | `saveInteractionEdit` (`ContactDetail.tsx:590`) never calls a server fn. User believes it saved. |
| **Remove portco intro / event** | **local only** | **NO** | **no** | Adds persist, removes don't (`ContactDetail.tsx:719-731`). Lists drift from the sheet every reload. |
| Follow-up toggle → Notes | live | fragile | only if note text unique | `resolveFollowUp` matches by **exact summary text** (`sheets.functions.ts:284`); duplicate-text notes flip together. |
| Apollo apply → Contacts + Apollo Raw | live + optimistic | title/company/phone/location yes; **linkedinUrl NO** | linkedinUrl lost | UI shows LinkedIn as appliable (`canApply:true`) but only 4 fields written. |
| Email "sent" → Notes + Email Activity | live | yes | yes | `onSent` fires on **"Open in Outlook"** before any send — activity + scoring inflated by non-events. |
| Tech Stack (Sumble) | ephemeral | **NO** | no | Re-fetched + re-billed every panel open; never stamped on the record. |

### Targeting (`targeting.tsx`) — the most broken surface in the app

| Flow | State | Persisted | Survives refresh |
|---|---|---|---|
| **Stage dropdown / Promote / Promote All** | **memory only** | **NO** | **no** — verified: `updateStage`/`promoteSelected` only `setTargets` (`targeting.tsx:809-818`); `buildTargets` always defaults stage to `Prospecting` |
| **New Target / Bulk paste / CSV upload** | **memory only** | **NO** | **no** — `addTarget` server fn exists but is never called from these handlers |
| **"Promote to CRM"** | label change | **NO** | no — creates no Contact, establishes no link |
| Target Accounts dialog → pipeline | **wrong sheet** | yes, to **Contacts** | as a Contact, not a Target | `addAccountPeople` calls `addContactRow` (`accounts.functions.ts:257`); dialog passes `onImported=refreshTargets` which re-pulls Targets and shows nothing |
| Network Builder (Apollo) → Targets | live | yes | yes | No dedup; optimistic `t-apollo-${id}` ≠ reloaded `t-${idx}` |
| AI connection plan → Target Strategy + Outreach | live, **non-atomic** | yes | yes | Two independent appends, no transaction; re-keys orphan on edit |
| "Research (Apollo)" bulk button | dead | n/a | n/a | No `onClick` (`targeting.tsx:~931`) |

The entire reason this page exists — moving leads through Prospecting → Researching → Outreach → Ready to Promote — **does not survive a page reload**. This is not a degradation; it is silent total data loss of the page's primary unit of work.

### Portfolio / Companies (`portfolio.tsx`, `companies.tsx`)

- `buildPortfolioCompanies` hardcodes `contactName/Email/Phone=""`, `employees/events/introductions=[]` (verified `sheets.server.ts:1806-1811`). The rich `PortfolioCompany` type is only ever populated by sample data. The `company-intel` "Team" people band reads `p.employees` and is therefore **structurally dead** for every real portco.
- All cross-entity links (Key People by email domain, intros by exact name, outreach by `linkedPortco` membership) are recomputed in-memory and broken by any domain/name drift.
- **Stub buttons that imply working integrations:** `handleLinkedInSync`/`handleFetchPeople` are 2-second fake spinners; Edit and "Sync with Asana" have no handlers (`PortfolioDetail.tsx:108-116, 241, 484`).
- Two routes re-implement the identical Asana-merge + contact/intro/email join logic with no shared helper, and have **already diverged** on signal matching (substring in `PortcoSignalsPanel` vs exact `normCompany` in `company-intel`).

### Signals / Home / Dashboard / Events

- Signals persist their **headline** to the Signals tab but the **grounded scores and "Why now" are recomputed client-side on every render** (`signal-feed.ts:418`) using `Date.now()` for freshness — so the same stored signal shows a different opportunity score on every visit, and Home (sorts by ts+relevance) disagrees with /signals (sorts by opportunity) about the top signal.
- Home's daily briefing is regenerated and discarded every click despite a `Daily Briefing` tab and `readTodayBriefing` existing in the schema.
- Event tagging is a **sequential per-contact write loop** with no transaction; a mid-loop failure leaves a partial tag set while the toast reports partial success.
- Dashboard runs **two parallel filter systems** (URL `?cf=` cross-filters vs non-URL `DashboardFilterContext`), one of which is mutated by no UI in-subsystem and is effectively dead.

### Query agent / global shell

- Approved writes are committed **client-side** in `ApprovalCard` (`query.tsx:689-763`), re-implementing each write tool — so the server's audit "complete" status and the actual Sheet write can diverge.
- **No `router.invalidate()` anywhere in `query.tsx`** (verified: 0 matches) — a contact added via the agent is invisible on /crm until a hard reload.
- Chat state is component `useState`; refresh destroys an in-flight conversation including a pending write approval.
- Bulk Add Note/Event/PortCo from the sidebar mutate only local state via `onBulkUpdate` and never call a server fn (`app-sidebar.tsx:272-342`) — silent data loss, unlike the profile-field path right beside it.

### Mocked / silent-fallback hazards

Three core fetchers swallow all errors and return `sampleContacts/Targets/PortfolioCompanies` (`sheets.functions.ts:46-71`). A transient Sheets 429 renders 8 fake DTC brands (Glossier, Casper…) **indistinguishable from real loaded state**, and any write against a sample email no-ops or mis-targets.

---


# Part 4 — Missing Data Connections

For each, I give the current wiring, the correct design, and the concrete file-level work to build it.

## 4.1 Asana BD/GTM activity does NOT feed the relationship score (the marquee lie)

**Today:** `scoreContact` (`activity-score.ts`, verified — imports only `Contact`/`Temperature`) computes `activityScore` purely from Sheet-derived `interactions`, `eventsAttended`, `portCoIntros`, `lastContact` (`sheets.server.ts:1044`). Asana activities are matched **only at render time** in `ContactDetail.tsx:261` for display. A contact with 10 logged BD/GTM Asana activities and no Sheet interactions scores **Cold**, and that Cold score propagates into the Home attention queue (`index.tsx:91`).

**Should be:** Asana activity is the single most direct evidence of an active relationship and must be a first-class scoring input. Two-tier fix: (a) short term, have `matchActivitiesToContact` results contribute a recency+volume component to `scoreContact`; (b) correct, write matched Asana activities into a normalized `Interactions`/Activity facts tab (with a stable `activityGid` for idempotency) so they flow through the existing pipeline and the score, timeline, and analytics all see them.

**Wiring:** a server-side join keyed on a stable contact id (not name substring), persisted once with `activityGid`; `scoreContact` gains an `asanaActivity` component or simply reads the unified facts tab. Eliminate the client-side fuzzy `activity-match.ts` re-computation.

## 4.2 Inbound Gmail is read for Signals but never updates contacts

**Today:** `gatherNetworkEmails` (verified `gmail.functions.ts:62-104`) builds a `byEmail` map and resolves each message to a real contact (`matchEmail`), then **throws the attribution away** after producing a display `GmailSignal`. `logEmailActivity` is only ever called from the manual `EmailDraftDialog`. Relationship recency/temperature is therefore blind to real two-way traffic the app can already see.

**Should be:** Every matched inbound/outbound email appends an Email Activity row and bumps `lastContact`, exactly like a manually-sent draft — turning the recency component of the score into something real instead of dependent on manual note-taking.

**Wiring:** in `gatherNetworkEmails`, when `matchEmail` resolves, call `logEmailActivity` (idempotent on Gmail message id) and update last-touch. This is a ~10-line change reusing the attribution already computed.

## 4.3 Signals never write back to the CRM

**Today:** Acting on a signal builds a synthetic `{ id:"signal-${email}", interactions:[], portCoIntros:[] }` Contact (verified `signals.tsx:363-379`). Email/Broadcast leaves **no trace** on the real contact; the `status` column on `StoredSignal` exists but no UI ever advances it. The radar is fully read-only relative to the CRM.

**Should be:** Outreach from a signal logs an interaction on the attributed contact and can advance the signal's status (New → Actioned/Dismissed). A fresh high-opportunity signal should also bump the contact into the Home attention queue.

**Wiring:** resolve `signal.email` to a real contact id before opening `EmailDraftDialog`; on send, `addNote`/`logEmailActivity` against the real record; add a `setSignalStatus` server fn writing the existing Status column.

## 4.4 Apollo enrichment write-back path is dead code

**Today:** I verified that **no source calls `mergeContactFields` with `source:"apollo"`** — every caller passes `"user"`. The carefully-built non-destructive fill-only branch (`sheets.server.ts:1286-1294`) that protects human edits from automated refresh has **zero production callers**, and the Python backend's `/api/apollo/enrich` returns results it never persists. Enrichment is 100% manual, one contact, click-by-click. Apollo Raw payloads are archived but never read back.

**Should be:** A batch/background enrichment job that fills empty contacts using `source:"apollo"` (so human fields are protected), plus surfacing Apollo employment/headline data into the company-intel entity layer.

**Wiring:** a scheduled server fn iterating empty-field contacts → `enrichPerson` → `mergeContactFields(source:"apollo")`. The protection engine already exists; only the caller is missing.

## 4.5 Tech stack is isolated and re-billed, never reused

**Today:** `buildPortcoTechStack` returns straight to component `useState`; nothing persists. The same company's stack is computed independently in `PortfolioDetail` and `ContactDetail`, and `PortfolioDetail` re-runs `matchOrganization` + `/jobs/find` even though `intel.org.domain` and the full job list are already in state — **up to 3 billable `/organizations/match` calls per Load+Verify** (`sumble.server.ts:329,373`). `credits_used` is parsed but discarded.

**Should be:** Cache detected tech (and verify confidences) to a sheet tab keyed by **domain**, reuse across Contact/PortCo, feed it to Customer Discovery's comparable-tech profiling (which currently makes Gemini hallucinate comparables it could fetch), and expose it to the LLM agent. Log `credits_used` to a spend ledger.

## 4.6 Portfolio is disconnected from contacts at the data layer

**Today:** `buildPortfolioCompanies` never populates `contacts`/`employees`/`introductions` from any relational tab (verified). All portco↔contact linkage is in-memory email-domain matching that breaks on personal emails and domain variants, with no company-name fallback. The "Team" band in company-intel is dead.

**Should be:** A persisted company entity (with an id) that owns its employees/intros/events, and a contact↔company FK so Key People is a real relationship, not a domain coincidence.

## 4.7 Duplicate/overlapping "find people at a company" APIs with divergent behavior

**Today:** Three implementations — `findCompanyDecisionMakers` (prospects), `fetchProspectPeople` (sumble), `findAccountPeople` (accounts) — with **different dedup** (email-only vs email|LinkedIn|name+company) and **different destinations** (Targets vs Contacts). The same "prospect a named company" intent lands in two tables depending on which dialog opened, fragmenting the pipeline.

**Should be:** One shared `findPeopleAtCompany` service with one dedup policy (multi-key) writing to one destination (Targets) with a `reasonSurfaced`.

## 4.8 AI outputs are never stored (DNA scores, drafts, insights, broadcast rankings, connection plans-unless-saved)

**Today:** `score_company_dna`, `draftEmail`, `companyIntroInsights`, `suggestCompetitors`, `scoreNetworkTargets`, `draftLinkedInPost`, and home briefing all render to component state and are re-billed on every open. Broadcast re-ranks 120 contacts per open with no persistence. Only the Signals scan and (on explicit Save) the connection strategy persist.

**Should be:** AI artifacts attach to the record they concern (a DNA score on the target with confidence + rationale; an insight pinned to a company; a broadcast relevance edge cached on the signal). This both stops redundant spend and lets outputs be compared over time and trusted for prioritization.

## 4.9 reasonSurfaced / "why now" is frozen text, not a live link

**Today:** Surfaced leads carry a one-shot free-text reason; there is no reference to the originating signal/company/tech entity, so you cannot refresh, re-score, or cluster targets by the intelligence that surfaced them.

## 4.10 Outreach trail does not migrate on promotion

**Today:** the Target Outreach trail is keyed by `targetKeyOf` and never merged into a Contact's interaction history — and since "Promote to CRM" creates no Contact at all (4.1 of Targeting), the trail is stranded permanently.

## 4.11 The Python radar produces exactly the structured signals the app lacks — and nobody reads them

**Today:** `radar` writes to the `Radar Signals` tab; `/signals` reads the separate `Signals` tab. Two taxonomies, two score scales, two LLM providers (Anthropic vs Gemini). No FastAPI route, no scheduler, no UI read path. 100% of the EDGAR/ATS/GitHub structured intelligence is write-only dead data.

## 4.12 Activities/signals/events do not feed analytics

Dashboard charts only contact-derived dims; Events analytics only events; neither references signals. There is no unified network-health view tying event ROI, signal volume, and relationship velocity together — despite all three being one product.

---

## Recommended foundational rewire (in priority order)

1. **Introduce a stable `urid` per Contact/Target/Company**, write it on create, and re-key every join, React Query key, outreach/strategy/provenance map, and AI artifact to it. This single change defuses ~8 of the orphaning/fracture findings.
2. **Persist the Targeting pipeline** (stage, manual/CSV adds, real promotion) — stop silent data loss of the page's core function.
3. **Build a normalized facts/activity tab** that Asana, Gmail, signal-actions, and manual interactions all write into, idempotently, and make `scoreContact` + the timeline + analytics read from it. This connects 4.1, 4.2, 4.3 and 4.12 at once.
4. **Activate the Apollo `source:"apollo"` path** and persist AI artifacts to records (4.4, 4.8).
5. **Unify the company-finder service and dedup policy**, route all to Targets (4.7).
6. Retire or wire the parallel Python backend/radar (4.11).


# Part 5 — User Workflow Audit

This section walks each user journey end-to-end and names where work is duplicated, where automation is missing, where clicks pile up, where transitions break, and where the UI lies about what it saved. The recurring root cause across almost every journey is the same architectural choice: **the UI treats local React state as the source of truth and treats the server write as a fire-and-forget afterthought (or omits it entirely)**. There is no React Query in the app despite it being a dependency (`query-charts-shell-state` map; zero `useQuery` hits in source), so freshness depends on `router.invalidate()` re-running loaders — and most mutation paths never call it.

## 5.0 The cross-cutting failure: optimistic-local with no persistence and no rollback

Before the individual journeys, the single most important pattern to internalize, because it recurs everywhere:

| Workflow | What the user sees | What actually persists | Evidence |
|---|---|---|---|
| Pipeline stage change | Lead moves to "Researching"/"Outreach Sent" | Nothing — resets to "Prospecting" on reload | `targeting.tsx:809-818` |
| "Promote to CRM" | Lead marked "Ready to Promote" | Nothing — no Contact created, label lost on reload | `targeting.tsx:814-818, 1607-1611` |
| New / paste / CSV target | Leads appear in the list | Nothing — `setTargets` only, `addTarget` never called | `targeting.tsx:517-606` |
| Edit an interaction | Type/summary updates | Nothing — local only | `ContactDetail.tsx:590-602` |
| Remove portco intro / event | Item disappears | Nothing — re-appears on reload (adds persist, removes don't) | `ContactDetail.tsx:719-731` |
| Bulk Add Note/Event/Intro (sidebar) | Toast success | Nothing — `onBulkUpdate` local patch only | `app-sidebar.tsx:272-342` |
| Apply Apollo LinkedIn URL | Field shows applied | Lost on reload (only 4 of 5 fields written) | `ContactDetail.tsx:326 vs 456-460` |
| Broadcast AI scores / LinkedIn post | Scored targets + draft post | Nothing — ephemeral, re-billed each open | `BroadcastDialog.tsx:31-103` |
| Query-tab AI answer / DNA score | Rich synthesized answer | Nothing — chat is `useState`, lost on refresh | `query.tsx:88-101` |

This is not a collection of minor bugs; it is a **systemic trust failure**. A CRM whose core verbs silently discard work is worse than no CRM, because the user *believes* the data is captured. I confirmed each of these directly in source.

## 5.1 Import Contacts (CSV upload + Smart Paste)

The bulk-import loop in `BulkUploadDialog.tsx:322-374` runs **fully sequentially**: per row it awaits `enrichRow` (Apollo) → `addContact` → `addEvent` → `addPortcoIntro` → `addNote`. A 200-row import is ~1000 serial REST round-trips with **no progress bar, no cancel, no resume**, and the browser tab must stay open. Each `addContact` re-reads the Contacts header (`sheets.server.ts:713`). There is no concurrency, no batching, and no rate-limit handling, so a large import will hit Sheets quota and partially fail with only console errors.

Dedup is **email-only** at commit time (`prospects.functions.ts:424-429`; `cleanup_duplicates.py` exists *because* this failed in production — `backend/cleanup_duplicates.py:1-8`). Two different import dialogs use **divergent email regexes** (`BulkUploadDialog.tsx:82` anchored vs `SmartPasteDialog.tsx:38` unanchored), so the same paste validates differently depending on which dialog you opened.

**AI-assist opportunity:** import is the perfect place for LLM column-mapping (detect "Title" vs "Role" vs "Position"), fuzzy dedup against existing contacts (same person, two emails), and a single batched enrich call. None exists.

## 5.2 Customer Discovery

Flow: PortfolioCompany → Gemini seller profile → Sumble tech/org searches → scoreFit → Sumble jobs/people → Gemini outreach angles → cached JSON blob. Confirmed issues:

- **Stale forever.** The cache (`discovery.functions.ts:58-67`) is keyed by company *name* with **no TTL and no invalidation when the portfolio company's sector/description/website changes**. A "Saved <date>" label is the only staleness signal; the user must *know* to click Refresh.
- **It ignores data the app already has.** The seller profile is built from name/sector/website/description only (`sumble.server.ts:789`) — it never sees the company's *own* Sumble tech stack (already fetchable) or the firm's existing contacts at the prospect, so Gemini *guesses* "comparable technologies" and then spends Sumble credits searching on potentially hallucinated tool names.
- **No warm-coverage view.** Discovery returns decision-makers but never cross-references existing Contacts/Targets, so a partner can't see "we already know 2 of these 5" — duplicate-outreach risk and a wasted relationship-leverage insight.
- **The account itself is a dead end.** Only *people* can be added to Targets; the discovered *company* is never added to any pipeline. There is no "all prospects discovered for PortCo X" view.
- **Fake progress.** The serial Sumble/Gemini fan-out is hidden behind a staged spinner (`CustomerDiscoveryPanel.tsx:412`) that does not reflect real progress.

## 5.3 Network Finder / Network Search / Target Accounts (the split-pipeline mess)

This is the clearest example of **broken transitions and confusing UX**. The same user intent — "find decision-makers at a company and add them to my funnel" — lands in **two different tables depending on which dialog you opened**:

- Network Finder / Customer Discovery → **Targets** tab (`prospects.functions.ts:436`)
- Target Accounts → **Contacts** tab (`accounts.functions.ts:257-268`), as Cold contacts, with the *purpose* stuffed into the Source field and **no Reason Surfaced**.

The Target Accounts dialog sits under the Targeting "Discover" menu and is wired `onImported={refreshTargets}` (`targeting.tsx:1637-1641`). So the user clicks add, sees "Added N," then `refreshTargets()` re-pulls the Targets tab — which contains nothing — and **the pipeline shows zero new rows**. The feature looks broken because it writes to the wrong subsystem. This directly contradicts the documented Source-Attribution / Discovery→Targets contract in user memory.

Network Search additionally pulls the **entire Contacts + Targets tabs into the browser** for client-side substring matching (`NetworkSearchPanel.tsx:284-302`), rebuilding the haystack (including joined interaction summaries) on **every keystroke** (`:348-357`).

## 5.4 Signals

Signals is a polished read-only reel that **never closes the loop into the CRM**:

- **No triage.** `StoredSignal.status` exists and defaults to "New" (`gemini.functions.ts:218`) but **no UI ever changes it** — you cannot dismiss, snooze, or mark a signal actioned, so the feed never triages down and grows append-only forever.
- **Acting on a signal writes nothing back.** Email/Broadcast builds a **synthetic `Contact` with `id: signal-<email>` and empty interactions** (`signals.tsx:363-379`, confirmed). Outreach launched from a signal never attaches to the real contact, never updates `lastContact`/temperature, and never appears in Dashboard velocity or the attention queue. The product's implied loop (signal → action → tracked relationship) is severed.
- **Scores drift.** Grounded opportunity/network/competitive scores are computed **client-side on every render** (`signal-feed.ts:418`) using `Date.now()` (`signal-strength.ts:145`) and are never persisted. The same stored signal shows a different score each visit; Home sorts by ts+relevance while Signals sorts by opportunity, so the two pages disagree on the "top" signal.
- **Citations thrown away.** Model URLs are replaced with a Google-search link (`signal-feed.ts:141-146`), which then forces confidence to "Low" (`signal-strength.ts:173`) — a self-inflicted penalty that makes the whole search-grounded feed look untrustworthy.
- **Slow first paint.** The loader awaits six sources **sequentially** (`signals.tsx:63-70`) instead of `Promise.all`, so TTFB is the sum of Sheets + LinkedIn + Drive + Gmail latencies.

## 5.5 Portfolio & 5.6 Companies

The portfolio record is a **skeleton**: `fetchPortfolioCompanies` hardcodes `linkedinUrl`, `contactName/Email/Phone`, `employees`, `events`, `introductions` to empty (`sheets.server.ts:1803-1811`). Consequences:

- **Four fake buttons.** "Web Sync" and "Get more from LinkedIn" are 2-second fake spinners (`PortfolioDetail.tsx:108-116`); "Edit" (`:241`) and "Sync with Asana" (`:484`) have **no onClick**. The records are read-only husks dressed up as editable.
- **No portfolio health view at all** — the headline VC-CRM need. The only score is "momentum," explicitly disclaimed as *not* financial health (`company-intel.ts:10-12`). DTC Investment/Ownership/Stage exist only as display-only Asana strings; there is no roll-up, no at-risk flag, no board cadence, no runway.
- **Fragile string-match joins.** Key People is `extractDomain(website) === extractDomain(contact.email)` (`portfolio.tsx:174-190`), which breaks on personal emails and `.ai`/`.com` mismatches; intros are exact name-equality; the DTC Priority filter hardcodes a trailing-space alias `['DTC Priority'] || ['DTC Priority ']` (`portfolio.tsx:166`) — concrete proof the keying is unstable.
- **Duplicated join logic.** `portfolio.tsx` and `companies.tsx` re-implement the Asana merge and contact/intro/email joins verbatim, and the signal-matcher has **already diverged** (substring in `PortcoSignalsPanel.tsx:19-24` vs exact `normCompany` in `company-intel.ts`), so the PortCo panel and the /companies brief show different signals for the same company.
- **Per-company, manual everything.** No "scan all signals" or "refresh all intel"; every action is one sheet-open at a time, and the paid Sumble brief (~50 credits) can never be regenerated once present (`PortfolioDetail.tsx:825`).

## 5.7 Contacts & CRM Editing

- **Cannot create one contact.** The prominent gradient "Add Contact" CTA has **no onClick** (`crm.tsx:213-219`, confirmed). The only ways to create a contact are bulk upload, paste, or activity sourcing — a core CRM verb is a dead end.
- **Interaction type is lost on round-trip.** `addNote` stores no type; the reader hardcodes `type: 'note'` (`sheets.server.ts:990`). Every call/meeting/email you log re-reads as a generic Note, making the type icons cosmetic and type-based analytics meaningless.
- **Email logged on intent, not on send.** `openInMail` fires `onSent` (logs "Email sent" + Email Activity row) *before composing* (`EmailDraftDialog.tsx:178`, confirmed) — opening Outlook inflates the activity trail and Hot/Warm scoring with non-events.
- **Email-less and multi-email contacts are second-class.** All writes key on `primaryEmail = email.split(';')[0]` lowercased; rating bails entirely without an email (`ContactDetail.tsx:101`). LinkedIn-only contacts cannot be edited or rated.
- **No virtualization.** `ContactList`/`ContactTable` render the full filtered set with per-card external logo `<img>` fetches — hundreds of network requests and sluggish scroll past a few thousand contacts.
- **A 1577-line god component** (`ContactDetail.tsx`) with ~20 `useState` and 6 inline dialogs.

## 5.8 Notes / Relationship Intelligence (the score is a lie)

The "automatic network scorecard" is the product's headline, and it is **structurally disconnected from the richest data the app has**:

- `scoreContact` reads only Sheet-derived `interactions`/`eventsAttended`/`portCoIntros` (`activity-score.ts`, confirmed via map). **Asana BD/GTM activity never enters the score** — it is matched client-side at render time for display only (`ContactDetail.tsx:261`). A contact with 10 logged BD activities and no Sheet notes scores **Cold**.
- **Inbound Gmail is read and discarded.** `gatherNetworkEmails` already attributes each email to a contact (`gmail.functions.ts:62-103`) but throws the attribution away; `logEmailActivity` only fires on a manual draft send. So real two-way email traffic the app can see never updates last-touch, temperature, or the attention queue.
- The events component of the score (0–15) can only be filled by manual Sheet entry; Asana event attendance never credits a person.

Net effect: temperature tiers, the Home "who to contact today" queue (`index.tsx:91`), and pipeline prioritization are **systematically wrong** for anyone whose engagement lives in Asana or email — i.e. most real relationships.

## 5.9 Broadcast & Email Drafting

"Broadcast" **does not broadcast**. It either scores up to 120 contacts (Gemini, hard cap, `broadcast.functions.ts:29`) or drafts one LinkedIn post — both **ephemeral, never persisted, re-billed every open** (`BroadcastDialog.tsx:31-103`). There is no mass-send and no send tracking. Email drafting itself has no send path either — only a `mailto`/Outlook deep link — and the draft body is discarded; regenerating re-spends tokens, and the model is fed a thin profile (no tech stack, no areas-of-interest, no Apollo history) despite the app holding all of it.

## 5.10 Search & the Query agent

The agentic Query tab is the most ambitious surface and has two workflow-level dead-ends: (1) **chat does not survive refresh** — turns/sessionId/pending approval are `useState` (`query.tsx:88-101`), so a reload destroys an in-flight write approval even though every turn is logged server-side and *could* be rehydrated; (2) **AI answers never enrich the CRM** — DNA scores, drafted emails, invite lists are rendered once and discarded, never written to a Targets/Companies/Scores tab. After an approved write, the app never calls `router.invalidate()`, so CRM/Dashboard show stale data until manual reload. (Auth/security implications of the client-side write commit are out of scope here but compound the trust problem.)

---


# Part 6 — AI Workflow Audit

## Executive framing

Venture Pulse is, on paper, an AI-native relationship-intelligence CRM. In practice the AI layer is a set of expensive, stateless party tricks bolted onto a Google-Sheets spreadsheet. The defining failure mode across every AI feature is the same: **the model produces an answer, the UI shows it, and the answer is thrown away.** Nothing the AI infers — a DNA score, a connection plan, a competitor list, a daily briefing, a signal's "why now," a relevance ranking of 120 contacts — is written back to the contact/target/company it concerns. The consequence is threefold: (1) the CRM never accumulates knowledge, so it cannot get smarter with use; (2) the app re-bills Gemini/Sumble/Apollo for identical inferences on every panel open; and (3) outputs are non-reproducible, so two users (or the same user at two times) see different "top opportunities" and different scores for the same stored record.

Below I treat the AI features (Part 6), the integrations (Part 7), and the automation roadmap (Part 10) in turn, grounded in file-level evidence I confirmed by reading source.

---

### 6.1 The model is not what the docs claim, and there are no structured-output schemas

`gemini.server.ts:18` hardcodes `GEMINI_MODEL = "gemini-2.5-flash"`, while `gemini.functions.ts:7` comments "gemini-2.5-pro" and project memory asserts Pro. The audit log therefore records `flash` (`llm.functions.ts:113`). Every cost estimate, quality assumption, and the audit trail's own model field is based on a wrong/ambiguous name. This is a one-line fix but it poisons all downstream reasoning about spend and quality.

More serious: **`responseSchema` appears nowhere in the codebase** (confirmed by grep). `draftEmail` and `callGeminiJSON` set `responseMimeType: "application/json"` (`gemini.server.ts:254,289`) but supply no schema, so output validity rests entirely on `repairJson` (`gemini.server.ts:480-550`), a hand-rolled brace-balancer that, on truncation, **drops the half-written trailing element**. For the Signals scan this means signals can be silently missing from a "repaired" response rather than triggering a clean retry. Gemini on Vertex supports `responseSchema` with enum/required enforcement; not using it is the root cause of the JSON-repair tech debt, the positional Signals-tab read (`gemini.functions.ts:274`, adopted because header-name lookups "made stored signals vanish"), and the silent data loss.

### 6.2 Inventory of AI features and their persistence/grounding posture

| Feature | Provider | Output persisted? | Re-billed per view? | Confidence? | Key defect |
|---|---|---|---|---|---|
| Query agent | Gemini Flash | No (answer discarded; only approved writes) | n/a | No | Free-text parse, no schema, MAX_STEPS=8 dead-ends, full-tab read per tool call |
| Signal scan | Gemini Flash + googleSearch | Yes (Signals tab) | Scan on demand | Forced "Low" in search mode | Citations blanked (`gemini.server.ts:633-641`); scores recomputed client-side |
| Grounded strength / "Why now" | Deterministic | **No** (recomputed every render, `signal-feed.ts:418`) | Every render | Derived | Uses `Date.now()` → scores drift; Home and /signals disagree on "top" |
| Customer Discovery profile | Gemini Flash | Yes (JSON blob in one cell) | No (cached, **no TTL**) | No | Ignores the company's own Sumble tech stack; searches on hallucinated comparables |
| Discovery outreach angles | Gemini Flash | Yes (in blob) | No | No | Only runs when `usedClaude`; heuristic runs get template strings |
| Connection Strategist Gem | Gemini Flash | Only on manual Save | Yes if not saved | No | Re-reads ALL contacts + ALL portfolio per call (`insights.functions.ts:261`) |
| Email draft | Gemini Flash | **No** (draft discarded) | Every regenerate | n/a | Logs "Email sent" on intent, not send; misses tech-stack/interests context |
| Home daily briefing | Gemini Flash | **No** despite Daily Briefing tab existing | Every click | n/a | Bypasses audit layer; brittle bullet regex |
| Insights (intro/competitor/synopsis) | Gemini Flash | **No** | Every panel open | No | Pure ephemeral spend |
| score_company_dna | Gemini Flash | **No** (artifact rendered once) | Every ask | **No confidence field anywhere** | Non-reproducible, can't drive prioritization |
| scoreNetworkTargets (Broadcast) | Gemini Flash | **No** | Every Broadcast open | Score only | Hard cap 120 contacts; re-ranks whole network each time |
| draftLinkedInPost | Gemini Flash | **No** | Every open | n/a | "Broadcast" doesn't broadcast |

The pattern is unmissable: of ~12 AI features, only **two** (Signal scan, Customer Discovery) persist anything, and even those persist headlines/blobs rather than the structured intelligence (scores, attributions) that would let the rest of the app reason over them.

### 6.3 No memory, no retrieval, no embeddings — relevance is recomputed by LLM over raw rows

There is **no embedding or vector layer anywhere** (grep for embedding/vector/cosine/similarity returns nothing). Every relevance decision is a fresh LLM pass over raw Sheet rows: `scoreNetworkTargets` re-sends up to 120 contacts per signal (`broadcast.functions.ts:29`), `connectionStrategy` rebuilds grounding from two full-tab reads per target, and `scanSignals` re-feeds Drive PDF bytes as input tokens every run. This is the classic problem an embedding index solves. The hard caps (120 contacts in broadcast, 150 people in scan `gemini.functions.ts:338`, 50-company roster in strategy `insights.functions.ts:217`) exist purely to fit token budgets; past them, **relevant people are silently invisible to the AI** with no indication to the user. Cost and latency scale O(signals × contacts) and the app cannot scale past a few hundred contacts before these caps start hiding the network.

### 6.4 The audit/cost claim is false outside /query

The UI tells users "every query is logged" (`query.tsx:230`), but I confirmed only `llm.functions.ts` writes to `LLM_Query_Log`. Eight modules — `briefing.functions`, `broadcast.functions`, `gemini.functions`, `gems/run`, `insights.functions`, `sumble.server`, plus `draftEmail`/`generateHomeSummary` inside `gemini.server` — call Gemini directly with **zero audit or cost tracking** (`gemini.functions.ts:489-491` even comments that `generateHomeSummary` is "NOT the audited agent layer"). The majority of token spend and AI output is invisible to the one mechanism built to track it. Worse, the audit actor is unauthenticated: `submitQuery` defaults `user` to `"tester"` (`llm.functions.ts:138`) and approvals record `"tester"` (`query.tsx:772`), so the log is not trustworthy for compliance.

### 6.5 Confidentiality wall is shallow / dead code

The advertised Asana wall and confidential-row filtering are largely illusory. `filterContacts` keys off a `confidentiality` field the `Contact` type doesn't define, so `contactLevel` always returns `internal` (`llm.server.ts:342-356`) — it is a pass-through. Meanwhile `query_sheet` reads **every** non-Asana tab raw with no field-level redaction (`llm.server.ts:459-496`). The wall protects Asana data by *omission* (no Asana tool), not by classification; any sensitive column in any Sheet tab flows to the model verbatim, and any Asana data ever mirrored into a Sheet leaks instantly.

### 6.6 Streaming, timeouts, and the blocking 429 retry

There is no streaming anywhere — `generateContent` (blocking) is the only call shape, so a 30-90s Signals scan or an 8-step agent run holds a single response open. The 429 retry (`gemini.server.ts:137-140`) backs off **synchronously inside the request** up to 60s, tying up the server fn during quota pressure instead of queueing. There is no per-call timeout, so a hung Vertex call stalls indefinitely while the typing indicator spins.

---


# Part 7 — Integration Audit

### 7.1 The integration layer is a federation of bare fetch() with no shared resilience

Every connector (`apollo.server`, `news.server`, `gmail.server`, `drive.server`, `linkedin.server`, `sumble.server`, `asana.server`) is a raw `fetch`/`httpx` with **no retry, no backoff, no rate limiting** — the lone exception being Gemini's blocking 429 sleep. Asana's `asanaFetch` throws on any non-2xx including 429 with no Retry-After honoring (`asana.server.ts:64-67`), directly contradicting the file's own comment that caching exists to respect the 150 req/min limit. On serverless the per-process Asana/Sumble caches rarely survive cold starts, so the real request rate is far higher than the comments assume.

### 7.2 Per-integration assessment

| Integration | Purpose | Auth | Caching | Retry/RL | SSOT issue |
|---|---|---|---|---|---|
| Google Sheets | Entire DB | OAuth refresh token (shared) | 5-min per-process Map | None; quota throttling → silent sample-data fallback | The store; full-tab reads, no transactions/locking |
| Apollo | Person enrich + people search | X-Api-Key | None | None; `reveal_phone_number` disabled | Raw payload archived to Apollo Raw but **never read back** |
| Gmail | Signal grounding | Reuses Sheets Google token | None (N+1 per message) | None | Attributes emails to contacts then **discards** the attribution |
| Drive | PDF grounding | Reuses Sheets token | None (re-downloads bytes every scan) | None | Hardcoded `application/pdf` — Docs/Slides invisible |
| LinkedIn | Own-org posts | Separate non-refreshing ~60d token | None | None | Only firm's own page; not relationship intel; 401s silently until human re-mints |
| News (Event Registry) | Signal grounding | NEWSAPI_KEY | None | None | Substring company match → false positives ("Box", "Ramp") |
| Sumble | Technographics + people | SUMBLE_API_KEY | 10-min for find/match only | None; ~10 req/s undefended | Cache keyed by free-text **name**, not org id; tech stack never persisted |
| Gemini/Vertex | All LLM | ADC | Auth token only | Blocking 429 | n/a |
| Python radar | Structured signal ingest | Anthropic (stale) | per-run full-tab read | None; bare excepts | Writes "Radar Signals" tab **never read by the app** |
| FastAPI backend | Parallel port | Shared .env | per-worker TTL | swallow-to-empty | **Dead code** — zero frontend references |

### 7.3 Three parallel pipelines, no single source of truth

The most expensive integration sin is duplication. There are **three** signal/data backends writing the same spreadsheet: (1) the live TS Gemini pipeline (`Signals` tab), (2) the Python radar worker (`Radar Signals` tab) which targets Anthropic and is orphaned — no route, no scheduler, no UI read path (confirmed: `backend/app/main.py` has no `/api/radar`), and (3) a pile of manual mutation scripts (`cleanup_duplicates.py`, `fix_carmen.py`, `reorder_contacts.py`) that are the de-facto data pipeline, performing destructive `deleteDimension`/`values:clear` with no dry-run. The radar produces exactly the high-trust structured signals (SEC filings, exec hires, OSS releases) the Gemini web-search feed is weakest at, yet **100% of its output is invisible to users**. The FastAPI backend is a fourth, also-dead parallel backend. This is enormous maintenance tax (hand-maintained Pydantic mirror of `types.ts`, already ~10 server fns stale) with negative benefit.

### 7.4 Enrichment is write-only or thrown away

Three integrations already capture exactly the data the CRM needs and then discard it:
- **Apollo raw payloads** are appended to the Apollo Raw tab (`sheets.server.ts:1481`) and **never read by anything** — the richest external person/org JSON the firm pays for is pure archival.
- **Inbound Gmail** is attributed to contacts via `byEmail` (`gmail.functions.ts:62-103`) then dropped; `logEmailActivity` is only ever called from the manual `EmailDraftDialog` (confirmed: only caller is `ContactDetail.tsx`). Real two-way email traffic the app can read never touches last-touch, temperature, or the activity log.
- **Sumble tech stack** (`buildPortcoTechStack`) returns to component state and is never persisted, so the same company is re-billed (~5cr/tech verify, ~50cr brief) on every panel open, and the data can't feed Discovery, targeting, or the agent. Sumble even parses `credits_used` (`sumble.server.ts:154`) but, despite the comment "we surface so the UI can show the cost," it is **never displayed** (confirmed: no UI consumer) — there is no spend ledger for the costliest calls in the app.

### 7.5 Join-by-name is the structural integration weakness

Across Asana, Sumble, company-intel, and signals, entities are joined by **free-text name or email domain**, never by a stable id. Evidence: Asana portco fields keyed by `t.name.trim().toLowerCase()` with a hardcoded `['DTC Priority'] || ['DTC Priority ']` trailing-space hack (`portfolio.tsx:166`); Sumble intel cache keyed by `normKey(name)` (`sumble.functions.ts:44`); News attribution by substring `hay.includes(company)` (`news.server.ts:99`); company-intel by `normCompany` trim+lowercase (`company-intel.ts:88`). Any naming variance ("Acme" vs "Acme, Inc.") silently fragments or severs the integration with no error surfaced. There is no entity-resolution / alias layer anywhere.

---


# Part 8 — Database Audit

## 8.1 It is not a database; it is ~25 denormalized logs in one file

`TAB_NAMES` (`sheets.server.ts:414-439`) enumerates 24 tabs in one spreadsheet (`GOOGLE_SPREADSHEET_ID`). They divide into:

| Class | Tabs | Problem |
|---|---|---|
| Core entities | Contacts, Targets, Portfolio Companies | No surrogate key; index-based IDs |
| Child/side tables | Notes, Events, PortCos Introduced, Email Activity | FK = free-text email string |
| Append-only logs | Rating History, Field Provenance, Target Outreach, Target Strategy, Daily Snapshots, LLM_Query_Log, Sumble Prospects, Target Accounts | Grow unbounded; read in full every build |
| AI caches | PortCo Intel, Customer Discovery, Signals, Apollo Raw, Daily Briefing, Event Synopsis | JSON-in-a-cell; keyed by free-text name |

### Per-tab issues

- **Contacts** — Has a mapped `urid` column (`CONTACT_COLS:823`) that is **never written, joined, or surfaced** (the `Contact` type has no `urid`). The intended stable key exists in the schema and is *dead*. The join key is email, which the app simultaneously allows editing of. Three *different* column orders exist in-tree (provision_sheet, reorder_contacts, fix_carmen) — proof the layout is uncontrolled.
- **Targets** — `TARGET_HEADERS` (14 cols) has no Phone column, yet `TARGET_COLS` maps a "phone" header; phone is structurally lost on write. Positional append vs named read. No dedup of any kind on `addTarget`.
- **Portfolio Companies** — The richest type (`types.ts:274-290`: employees/events/introductions/contacts/linkedinUrl) is **hardcoded empty** in `buildPortfolioCompanies` (`:1803-1811`). The relational portfolio model is *never sourced from Sheets* — those views are blank for real data or fake under the sample fallback. `company-intel.ts`'s "team" relationship band (`:306-315`) is therefore structurally dead code.
- **Side tables (Notes/Events/Intros/Email Activity)** — FK is the literal email cell; `groupBy` joins on the **whole cell** (`:1894`), so a multi-email contact (`a@x.com; b@x.com`) only joins if the child row carries the identical multi-email string — practically never.
- **AI cache tabs** — JSON blobs keyed by `normKey(name)`; unqueryable by analytics or the LLM agent; corrupt JSON is silently treated as a cache miss and re-billed.

## 8.2 Normalization, duplication, and integrity defects

- **No primary keys.** IDs are array indices (`c-${idx}`, `t-${idx}`, `pc-${idx}`, `i-${idx}-${iIdx}`) — they renumber on any out-of-band insert/delete, breaking React Query keys, selection-by-id, and drill-downs.
- **No foreign keys / referential integrity / cascade.** No delete path exists for any record; side-tables are pure append-only logs keyed by email string. Orphan rows accumulate forever; re-adding a contact with a reused email *inherits a stranger's history*.
- **Duplicate storage.** Discovery decision-makers live in the Discovery JSON blob *and* (when added) as Target rows, never reconciled. Apollo Raw archives full payloads that are **never read back**. Source is stored as free text *and* re-normalized at read time, so the stored and surfaced values can disagree.
- **No indexes.** Every targeted write (`mergeContactFields`, `setContactRating`, `updateTargetFields`, `resolveFollowUp`, `logUpdate`) does a **full-tab fetch + O(n) linear scan** to find one row.
- **No transactions / locking.** Multi-step writes — rating cell + history append + override upsert (`:1144-1148, 1175-1187`), bulk update (`:1557-1564`), Apollo raw + merge (`ContactDetail.tsx:448,471`), save-strategy's dual append (`targeting.tsx:490-493`) — are non-atomic. The 5-min in-process cache (`:28-37`) is per-instance and invalidated only on the same instance, so multi-instance/serverless deploys read stale data and read-modify-write upserts race.
- **No migrations/versioning.** Schema evolves via best-effort `ensureTab`/`ensureColumn`/`ensureHeaderRow` on the hot path; two app versions can fight over column layout.

## 8.3 Scale ceilings

- Sheets hard limit: **10M cells**; eight append-only logs march toward it with no archival.
- Sheets API quota: ~60 read + 60 write/min/user; `buildContacts` is 4–6 reads and the app refetches per route — 429s trigger the mock fallback.
- Full-tab reads make latency/memory scale with **total historical rows**, not active records. `buildFieldProvenance` cost grows with total edits ever made.
- Effective concurrency ceiling is **one writer**.

## 8.4 Recommended target schema (Postgres) and when to move

**Move now, in phases — Sheets has already failed** (fix_carmen.py is the smoking gun). Concrete target:

```
contacts(id uuid pk, email citext unique, name, title, company_id fk→companies,
         temperature enum, source enum, source_context, date_added, created_at, updated_at)
companies(id uuid pk, canonical_name, name_aliases text[], domain citext, sector, domain_class, ...)
targets(id uuid pk, contact_id fk null, company_id fk, stage enum, origin_source enum,
        reason_surfaced, phone, ... , promoted_contact_id fk null)
interactions(id uuid pk, contact_id fk, type enum, summary, occurred_at, is_follow_up, resolved_at)
events(id uuid pk, name, gid), event_attendance(event_id fk, contact_id fk, status enum)  -- many-to-many
portco_intros(id uuid pk, contact_id fk, company_id fk, source, occurred_at)
field_provenance(contact_id fk, field, source enum, set_by, set_at)  -- (contact_id, field) PK, real upsert
ai_cache(entity_type, entity_id fk, kind, payload jsonb, fetched_at, ttl)  -- TTL + FK, not free-text name
signals(id uuid pk, company_id fk null, contact_id fk null, ..., scores jsonb, scored_at)  -- scores persisted
audit_log(id, actor, action, entity_type, entity_id, before jsonb, after jsonb, at)
```

Key wins: UUID surrogate keys (editing email no longer orphans anything), real FKs + `ON DELETE` cascade/tombstone, `citext`/`unique` for dedup at the constraint level, a `companies` table with `name_aliases` to fix entity fracturing, `jsonb` for AI payloads with a real TTL column, range/index reads instead of full-tab scans, and transactional multi-step writes. **Sheets becomes an import/export adapter, not the store.** Phase 1: stand up Postgres + dual-write contacts/targets; Phase 2: migrate side tables and AI caches; Phase 3: retire Sheets writes, keep a read-only export job. The existing Python backend (`backend/app/sheets.py`) and one-off scripts should be **deleted, not maintained** — they are a parallel, drifting second writer to the same live sheet (an active data-integrity hazard, not a migration path).

---


# Part 9 — State Management Audit

## 9.1 The core thesis: there is no state-management architecture, only loaders + `useState`

VenturePulse advertises React Query (it sits in `package.json`/`package-lock.json`) but **uses it nowhere** — a grep for `useQuery`/`QueryClientProvider`/`useMutation` returns zero source hits. The actual model is:

1. A TanStack Router `loader` fan-fetches Sheets tabs (`crm.tsx:41-47`, `signals.tsx:63-70`, `portfolio.tsx:22-27`, `companies.tsx:93-106`).
2. The component reads it via `Route.useLoaderData()`.
3. Mutations call a `createServerFn`, then *optionally* call `router.invalidate()` to re-run the loader.
4. Cross-cutting UI state lives in **nine hand-rolled React Contexts** (`auth`, `filter`, `dashboard-filter`, `targeting-filter`, `portfolio-filter`, `filter-options`, `selection`, `target-selection`, `sidebar`), all mounted for every authenticated page (`__root.tsx:100-129`).

This means the app has **three separate, uncoordinated state systems** — loader cache, React Contexts, and per-component `useState` — with no single source of truth and no cache layer that understands entities. Every "freshness" operation is a full reload of full tabs. There is no normalized client cache, no entity store, no optimistic-update framework with rollback, and no background revalidation.

## 9.2 Where state lives vs. where it should live

| State | Where it lives today | Where it should live | Problem |
|---|---|---|---|
| Server data (contacts/targets/etc.) | Loader data → copied into `useState` per component | Normalized query cache (React Query / RTK Query) keyed by entity id | Triple-copied; no invalidation on cross-page writes |
| Filters (CRM/dash/targeting/portfolio) | 4 separate non-URL Contexts | One URL-backed filter model | Lost on refresh, not shareable, duplicated logic |
| Filter *options* (dropdown values) | `filter-options-context` populated by per-route `useEffect` | Derived from the cache or computed server-side | Empty until a page is visited; last-writer-wins on shared keys |
| Chart cross-filters | URL `?cf=` param (good) | Same | The one correct design — see §9.6 |
| Selection / bulk ops | `selection-context` + a registered callback | Cache-aware mutation | Bulk note/event/intro writes never persist (§9.4) |
| Chat conversation | `query.tsx` `useState` | Server session keyed by `sessionId` | Lost on refresh incl. pending write approvals |

### Triple-stored contact state with no resync
`crm.tsx` holds loader data; `ContactList` copies it into `useState(contacts)` as `localContacts` (`ContactList.tsx:24`); `selection-context` holds `allFilteredContacts`. Critically, `localContacts` is **initialized once and never resynced** — there is no `useEffect(() => setLocalContacts(contacts), [contacts])`. So when `recalculateRatings` or bulk import calls `router.invalidate()` and a fresh `contacts` prop arrives, `ContactList` keeps showing the stale array until a full page reload (`ContactList.tsx:24`, `:123-126`). This is a textbook derived-state bug.

## 9.3 Missing cache invalidation — writes that don't refresh the views they affect

The single most damaging state bug class is **writes that succeed but never invalidate dependent loaders**:

- **Query agent writes** (`query.tsx:689-763`): after the agent adds/updates a contact or event, `query.tsx` *never* calls `router.invalidate()`. A user adds a contact via chat, switches to /crm, and it isn't there until a hard reload. Worse, the write is committed **client-side** by re-implementing each write tool (`ApprovalCard.commit`), so the server's audit "complete" status and the actual Sheet write can diverge.
- **Single-field edits / notes / events** in `ContactDetail` rely solely on the optimistic local copy and do **not** invalidate (only bulk import/recalc/activity-sourcing do). So after any sibling `invalidate()`, the un-resynced `localContacts` (§9.2) silently diverges.
- **Targeting** (`targeting.tsx`): discovery adds call `refreshTargets()` (full re-fetch), but the resulting array doesn't reconcile optimistic ids — `NetworkBuilderDialog` uses `t-apollo-${id}` while `buildTargets` assigns `t-${idx}` (`sheets.server.ts:1744`), so the same person has two identities across a refresh and selection (`Set<id>`) breaks.

## 9.4 "Saves" that are pure in-memory illusions (silent data loss)

A reviewer must call these out as data-integrity defects, not UX nits — the UI reports success and the data is gone on reload:

- **Pipeline stage changes / Promote to CRM** — `updateStage`/`promoteSelected` only `setTargets()` in memory; no server fn writes the Targets `Stage` column, and `buildTargets` always defaults stage to `Prospecting` (`targeting.tsx:809-818`). The entire pipeline silently resets on refresh. This is the core unit of work for that page.
- **Manual / CSV / paste target creation** — `handleNewTarget`/`handleBulkImport`/`handleCsvUpload` `setTargets()` only, even though `addTarget` exists (`targeting.tsx:517-606`).
- **Bulk Add Note / Add Event / Add PortCo Intro** — `app-sidebar.tsx:272-342` `handleBulkEditSubmit` for these branches calls only `onBulkUpdate` (local), unlike the profile-field branch which calls `bulkUpdateContacts`.
- **Edit existing interaction / remove portco intro / remove event** — `ContactDetail.tsx:590-602, 719-731` are local-only (adds persist, removes/edits don't → asymmetric persistence).
- **Interaction type** is never persisted; every note reads back as `type:'note'` (`sheets.server.ts:990`).

## 9.5 Optimistic updates without rollback; race conditions

Optimistic edits mutate local state *before* awaiting the server and only `toast.error` on failure (`ContactDetail.tsx:539-542`) — there is no rollback, so UI and sheet disagree on any write failure. On the server, every "upsert" is a **read-modify-write race** against a shared spreadsheet with no locking: `logUpdate` (`llm-log.server.ts:74-91`), `setRatingOverride` (`sheets.server.ts:1083-1089`), discovery/sumble cache upserts. The 5-minute in-process cache (`sheets.server.ts:28-37`) makes this worse: a row just appended by `logReceived` may be invisible to `logUpdate` within the TTL window, forcing duplicate appends. Multi-step writes (cells + history + overrides) are non-atomic (`sheets.server.ts:1144-1148`), so partial failure leaves inconsistent rating state.

## 9.6 The re-render bottleneck

`__root.tsx:100-129` nests eight providers, none of which memoize their context value:
- `filter-context.tsx:33` builds `{filters, setFilters}` fresh every render.
- `filter-options-context.tsx:51`, `selection-context.tsx:63` — same.
- `selection-context.tsx:52` computes `selectedContacts = allFilteredContacts.filter(...)` **outside `useMemo`** on every provider render.

`SidebarWithFilters` consumes all four filter contexts at once (`__root.tsx:144-160`) and renders the **1349-line `AppSidebar`**. The net effect: typing one character in the CRM search box produces a new context value object, which re-renders the entire sidebar (and its inline bulk-edit dialogs) plus every consumer. As the contact list grows this is perceptible jank with no data-side cause.

**The one thing done right:** `use-chart-drill.ts` encodes chart cross-filters in the URL `?cf=` param as the single source of truth (`use-chart-drill.ts:71-141`), making chart state deep-linkable and shareable. This is exactly the model the sidebar filters should adopt — and the fact that two parallel filter systems exist (URL charts vs. non-URL Contexts) that don't compose is itself a defect (`dashboard.tsx:128-137`).

## 9.7 Hydration, offline, loading states

There is no offline story (every interaction needs Sheets). Loading is loader-driven (route blocks until loaders resolve) with ad-hoc spinners; the signal scan blocks 30-90s behind a full-screen spinner with no streaming. The agent chat has no persistence, so a refresh destroys an in-flight workflow including a pending write approval — despite every turn being logged server-side and therefore rehydratable (`query.tsx:88-101`).

---


# Part 10 — Automation Opportunities

The good news: the plumbing for most high-value automation already exists and is merely disconnected. The roadmap below is ordered by value-to-effort.

1. **Auto-persist AI outputs to records (the keystone).** Add a `score`/`note`/`strategy` write-back so DNA scores, connection plans, briefings, and signal attributions attach to the contact/target/company. This single change converts every existing AI feature from a demo into an accumulating asset and eliminates most redundant spend. Prerequisite: stable record IDs.

2. **Inbound-email → activity automation.** Reuse the already-computed `byEmail` attribution to append an Email Activity row and bump last-touch/temperature on inbound mail. Closes the single largest gap between "data the app can see" and "data that drives the score."

3. **Background/batch auto-enrichment.** The non-destructive `source:"apollo"` merge branch (`sheets.server.ts:1286-1294`) is fully built and **dead** (every caller passes `"user"` — confirmed). Wire a scheduled job that enriches empty/new contacts through it. Zero new merge logic required.

4. **Auto-scoring with confidence + caching.** Persist deterministic strength/opportunity scores (currently recomputed client-side every render, `signal-feed.ts:418`) so Home and /signals agree, and add a confidence field (absent everywhere). Cache narrative insights keyed by inputs so panels stop re-billing.

5. **Tech-stack auto-enrichment + reuse.** Persist Sumble tech stacks to a domain-keyed tab; feed them into Customer Discovery's comparable-tech profile (currently Gemini guesses), into targeting, and into the agent. Eliminates triplicate match calls per Load+Verify (`sumble.server.ts:329,373`).

6. **Duplicate detection / lead routing at write time.** `addTarget` blind-appends with no dedup; CSV import dedups email-only. Build one cross-tab dedup service (email | linkedin | name+company, as `accounts.functions.ts` already does) used by every add path. Resolves the "person is both Contact and Target" fragmentation and the wrong-table routing (Target Accounts → Contacts).

7. **Company matching / entity resolution.** Introduce a canonical company-id + alias table to replace name/domain substring joins across Asana, Sumble, News, and company-intel.

8. **Signal triage automation.** Wire the orphaned Python radar's structured EDGAR/ATS/GitHub signals into the live feed, give signals a status workflow (the column exists, no UI writes it), and let a fresh high-opportunity signal auto-bump the attention queue.

9. **Auto-follow-up / reminders / pipeline updates.** Persist pipeline stage (currently in-memory only — lost on refresh) and add reminder generation off last-touch + open signals.

10. **Unified audited LLM gateway.** Route all Gemini calls through the logging/cost layer so the "every query logged" promise becomes true and spend is capped per plan.


# Part 11 — Data Quality Audit

## 11.1 The evidence that quality has already broken

The clearest signal isn't in the TypeScript — it's in `backend/`:
- **`fix_carmen.py`** ("rewrite the single misaligned Carmen row (1011)") hardcodes a full row and PUTs `Contacts!A1011`. This is **proof a positional append landed under the wrong headers and corrupted a live record**, "fixed" by a manual overwrite with no validation that row 1011 is still Carmen.
- **`cleanup_duplicates.py`** keeps the first occurrence per lowercased email and `deleteDimension`s the rest — **proof a CSV upload blindly re-added seeded contacts** because there is no write-time upsert. Its dedup skips blank-email rows (`:46-47`), so emailless dupes are never caught.
- **`reorder_contacts.py` + `provision_sheet.py`** define **two more, conflicting** Contacts column orders. Three column orders in one repo means the canonical schema is undefined and any positional writer is a time bomb.

A human running these scripts **is the data pipeline.**

## 11.2 Specific quality defects (confirmed in source)

| Defect | Evidence | Effect |
|---|---|---|
| Status silently → Cold | `sheets.server.ts:1013-1015` | Typos/legacy ("HOT","Lead","Qualified") misclassify; corrupts hot-leads count + scoring |
| Domain silently → Cloud | `:1789` first-keyword-wins default | Portfolio domain charts skewed |
| eventsInvited fabricated | `:1032` invited ∪ attended | Invite/attendance funnel meaningless |
| lastContact misnomer | `:1034` dateAdded ‖ unsorted[0] | Recency/scoring wrong |
| Interaction type lost | `:990` always `"note"` | Call/meeting/email all read as Note |
| Numbers→0 silently | snapshot `n()` `:480`, import `num()` `:1430`, signal relevance | Bad cells masked as 0 |
| Multi-email breaks joins | `:1894` joins whole cell | Multi-email contacts lose events/notes/intros |
| Email-only dedup (one path) | `prospects.functions.ts:424-429` | No-email prospects re-add endlessly; Targets has none at all |
| Company entity fracture | `company-intel.ts:88` trim+lowercase only | "Acme" / "Acme, Inc." become different entities; people/signals split |
| Cache keyed by free-text name | `sumble.functions.ts:44`, `discovery` upsert | Renames orphan cache; variants duplicate |
| Wrong-tab writes | `accounts.functions.ts:257-268` → Contacts not Targets | "Target Accounts" silently populates the wrong subsystem |
| Local-only "saves" | `targeting.tsx:809-818`, `ContactDetail.tsx:590-602,719-731`, `app-sidebar.tsx:272-342` | Stage moves, interaction edits, intro/event removals, bulk notes vanish on reload |

## 11.3 Identity & timestamp weaknesses
- **No stable IDs** (index-based) → identity is positional and breaks on any sheet edit.
- **Unstable/derived join keys** → editing email or name|company orphans outreach, strategy, provenance, events, notes.
- **Email-less and multi-email contacts are second-class** — cannot be rated (`ContactDetail.tsx:101` bails with no email), cannot be reliably joined.
- **Missing timestamps** — `updated_at` / `created_at` do not exist; provenance carries a timestamp but only for the two fields it tracks; no who-edited audit (the LLM log records "tester" as the actor).

## 11.4 Recommended hygiene processes (ordered)
1. **Stop positional writes immediately.** Convert `addTarget` and the prospect importer to the header-aware pattern already used by `addContactRow` — a one-file fix that removes the entire misalignment class that produced fix_carmen.
2. **Introduce a stable surrogate key now, even on Sheets.** Write the existing `urid` column with a UUID on every add; switch all cross-tab joins and the outreach/strategy/provenance keys to it. This decouples identity from email/name.
3. **Write-time dedup, not script-time.** A single `upsertContactByEmail`/`upsertTargetByKey(email||linkedin||name+company)` used by *all* import paths (CSV, paste, Apollo, prospects, accounts), replacing the four divergent dedup strategies.
4. **Validation gate on ingest** — reject/flag rows with invalid status, blank required fields, malformed email; surface a review queue instead of silently coercing to Cold/Cloud/0.
5. **Add TTL + freshness to AI caches** and key them by company UUID, not normalized name.
6. **Persist what the UI claims to save** — stage, interaction type, removals, bulk notes — or remove the controls; the current asymmetric persistence is the most user-corrosive bug.
7. **Migrate to Postgres** per §8.4 and retire the Python scripts/backend. Hygiene becomes constraints (unique, FK, enum, not-null) instead of cron-by-human.


# Part 12 — Performance Audit

## 12.1 Every read is a full-tab fetch — the original sin

`fetchSheetTab` GETs `/values/{tab}` with **no range, filter, or pagination** (`sheets.server.ts:83-106`). Consequences compound:

- **`buildContacts` does 6 tab fetches per cold load** (Contacts + Events + Notes + PortCos Introduced + Rating Overrides + Field Provenance, `sheets.server.ts:943-952`), then joins by lowercased email and computes `activityScore` per contact.
- **Append-only log tabs are read in full forever.** `buildFieldProvenance` scans *every historical edit* to build a last-wins map on *every* `buildContacts` (`sheets.server.ts:920-941`). Cost grows with total edit history, not active records.
- **The LLM agent re-fetches whole tabs per tool call.** `executeTool` calls `buildContacts()`/`fetchSheetTab()` on each invocation (`llm.server.ts:429,464,478`); `query_sheet` additionally calls `listSheetTabs()` every time to resolve a tab name. With `MAX_STEPS=8`, one query that touches contacts twice is 2+ full-tab reads × 8 steps.

## 12.2 O(n) linear scans + schema bootstrap on every targeted write

Every single-cell edit fetches the whole tab and linear-scans for the row: `mergeContactFields` (`:1266`), `setContactRating` (`:1172`), `updateTargetFields` (`:1663`), `resolveFollowUp`, `logUpdate`. There is no row-number index. On top of that, adds call `ensureColumn`/`ensureTab` (extra metadata GET + possible `batchUpdate`) *before* the real write (`sheets.functions.ts:150,179-180,205`), so each mutation is 2-3 sequential round-trips. **`recalculateRatings` is the heaviest op in the app**: `buildContacts()` (6 fetches) → re-fetch Contacts again → score every contact (`sheets.server.ts:1094-1096`).

## 12.3 Serial / N+1 API calls and blocking loaders

- **Signals loader awaits six server fns sequentially** (`signals.tsx:63-70`): `await fetchSignals(); await fetchLinkedInFeed(); await fetchDriveDocs(); await fetchGmailFeed(); await fetchPortfolioCompanies(); await fetchContacts();`. Page TTFB is the **sum** of all six remote latencies; the slowest connector (Gmail/LinkedIn) blocks the whole page. This is a one-line fix to `Promise.all` and is a clear regression.
- **Gmail is N+1**: one list call then a serial per-id `getMessage` GET, up to 50 (`gmail.server.ts:180-183`).
- **Bulk import is fully sequential**: per row, `await enrichRow; await addContact; await addEvent; await addPortcoIntro; await addNote` — up to 5 serial REST calls per contact (`BulkUploadDialog.tsx:322-374`). 200 rows ≈ 1000+ serial calls, minutes-long, no progress/cancel/resume.
- **Event tagging** writes one server call per attendee in a serial loop (`events.tsx:1789,1907`).
- **Per-prospect Apollo enrichment** loops serially inside a single server fn (`prospects.functions.ts:401-419`).
- **Discovery / Sumble fan-out** is serial per company, with `matchOrganization` called via *uncached* `sumbleFetch` 2-3× per Load+Verify of a single tech stack (`sumble.server.ts:329,373`) — billable credits burned on duplicate calls.

## 12.4 Missing virtualization / pagination

`ContactList` renders `filtered.map()` of all cards (`ContactList.tsx:159`) and `ContactTable` renders all rows — **no windowing anywhere in `src/components/crm`**. Each `ContactAvatar` fires an external logo `<img>`, so a few thousand contacts means thousands of DOM nodes plus hundreds of cross-origin logo fetches. The same pattern repeats in `targeting.tsx` (a 1994-line single component rendering all `sortedTargets`) and the signals feed (`signals.tsx:635` renders every card). The entire dataset is loaded into the browser; filtering, charting, selection, and export are all O(n) over the full array client-side.

## 12.5 Repeated/uncached AI work and per-render recomputation

- **Signal strength scores are recomputed client-side on every render** via `makeScorer` in `buildFeed` (`signal-feed.ts:418`), using `Date.now()` for freshness (`signal-strength.ts:145`). The same persisted signal shows a different "opportunity" score each visit; "Top opportunity" sort is unstable and the score is never stored.
- **`scoreNetworkTargets` re-ranks up to 120 contacts via Gemini on every Broadcast open** and persists nothing (`broadcast.functions.ts:26-49`).
- **`connectionStrategy` reloads ALL contacts + ALL portfolio per "How to Connect" click** (`insights.functions.ts:261`).
- **Insights / home briefing / competitor suggestions** re-bill Gemini on every panel open with no cache, despite a `Daily Briefing` tab existing in the schema that `generateHomeSummary` never uses (`gemini.functions.ts:539` vs `sheets.server.ts:521`).
- **`companies.tsx` precomputes `portcoExtras` for ALL portcos** though only the selected one is rendered — wasted O(portfolio × contacts × emails) per load (`companies.tsx:146-162`).

## 12.6 Large payloads and the giant route files

The map's flagged files are real maintainability *and* performance liabilities because they're single components that re-render wholesale and ship as large route bundles:

| File | Lines | Issue |
|---|---|---|
| `targeting.tsx` | ~1994 | Single `TargetingPage`; 10+ dialog booleans + apollo + strategy state in one component; re-renders the whole target grid on any change |
| `events.tsx` | ~1992 | All views/dialogs inline; `AnalyticsView` recomputes ~8 aggregations in one `useMemo` per cross-filter click |
| `app-sidebar.tsx` | ~1349 | Hosts 4 filter UIs + 2 bulk dialogs; re-renders on every filter keystroke (§9.6) |
| `companies.tsx` | ~1218 | Route + 8 sub-components + scoring helpers inline; duplicates portfolio join logic |
| `ContactDetail.tsx` | ~1577 | ~20 `useState` + 6 inline dialogs; client-side activity matching in render body, no `useMemo` |

The agent additionally serializes its **entire Gemini message history (incl. base64 attachment parts) to the client and back on every pause/resume** (`llm.server.ts:771`, `llm.functions.ts:181`) — payloads grow with conversation length toward a hard request-size ceiling, and token spend grows superlinearly.

## 12.7 Caching & background-processing opportunities (none exist today)
- The only cache is a 5-min in-process `Map` (`sheets.server.ts:28-37`), per-instance and invalidated only on the same instance — useless on serverless/multi-instance, and a stale-read hazard within read-modify-write flows. The Sumble (10-min) and Asana (5-min) in-process caches share the same defect.
- No HTTP connection pooling on the Python backend (new `httpx.AsyncClient` per call).
- Heavy work that should be async/background runs **inside the request**: signal scans, bulk imports, Apollo enrichment, the 429 retry that synchronously backs off up to 60s inside the request (`gemini.server.ts:140`).

---


# Part 13 — Product Gaps

A VC partner's day is: *who do I know, who can intro me, what changed overnight, which portfolio companies need me, who should I talk to today, and how is the fund doing.* VenturePulse answers almost none of these durably.

| Expected capability | Status | Why it matters to a VC | Closest thing today |
|---|---|---|---|
| **Relationship graph** (person↔person, person↔company, who-knows-whom) | **Absent** | The entire value of a VC CRM is the graph, not the rows | Flat Contacts list; joins are fragile string matches |
| **Warm-intro pathfinding** ("who can introduce me to X") | **Absent** | This is the #1 daily action for a partner | Connection Strategist Gem gives generic advice with no graph traversal (`insights.functions.ts:241`) |
| **Timeline / activity aggregation per relationship** | **Broken** | Meeting prep needs the full history at a glance | Interaction type lost on save; Asana + inbound email excluded |
| **Investment theses / fund strategy alignment** | **Absent** | Every signal/target should be scored against the fund's thesis | No thesis object anywhere; segment is a 4-bucket regex |
| **Partner dashboards / per-partner book** | **Absent** | Partners need *their* relationships and pipeline | Single hardcoded user; no ownership/attribution |
| **Company intelligence (meeting prep brief)** | **Ephemeral** | Walk into a meeting with one synthesized page | Insights generated then discarded; brief frozen once made |
| **Portfolio health / financial monitoring** | **Absent** | Knowing which portco needs help is core to the job | "Momentum" score explicitly *not* health |
| **Signal prioritization + triage workflow** | **Broken** | Overnight, what changed and what do I act on | Scores drift, no status write-back, no dismiss/snooze |
| **Relationship scoring that reflects reality** | **Wrong** | Temperature drives who-to-contact | Score ignores Asana activity + inbound email |
| **Fund analytics** (deal flow funnel, conversion, sourcing ROI) | **Absent** | LP reporting and process improvement | Dashboard is a Contacts dashboard; pipeline stages aren't even persisted |
| **Meeting prep automation** | **Absent** | Pull last touch, open signals, mutual connections | No "prep for my 3pm" view; signals not joined to contacts |
| **Feedback loop** (accepted/rejected leads, dismissed signals) | **Absent** | Without it, the AI suggests the same noise forever | Nothing captured anywhere |

The deepest structural reason these are all missing is the **lack of stable entity IDs and a relationship layer**. Everything is keyed by free-text name or email (`targetKeyOf`, `normCompany`, domain-match), so the app cannot build a graph, cannot do pathfinding, and fractures the same company/person across spelling variants. Until there is a `urid`-style surrogate key (a column that already exists but is never written — `CONTACT_COLS:823`) and an explicit edges layer, none of the Part-13 capabilities are buildable — they would all sit on sand.

A second structural reason is the **generate-and-discard pattern for all AI**: DNA scores, connection plans (unless manually saved), intro insights, competitor suggestions, broadcast rankings, daily briefings, and email drafts are computed and thrown away. A partner cannot pin an insight to a company, compare a score over time, or trust a number that re-rolls every render. The "intelligence" tier produces no durable, comparable, accumulating knowledge — which is precisely what a relationship-intelligence product is supposed to do.


# Part 14 — Scalability Review

**No — not within one or two orders of magnitude of any of those numbers.** The current architecture is a single-tenant prototype whose every layer fails the target. This is a re-platform.

## 14.1 Why Google-Sheets-as-DB breaks (hard, not soft, limits)
- **Cell ceiling.** A spreadsheet caps at **10,000,000 cells**. 10M contacts × ~30 columns = 300M cells — **30× over the limit for the Contacts tab alone**, before a single signal, note, or provenance row. 100M signals is structurally impossible. The append-only log tabs (Rating History, Field Provenance, Email Activity, Target Strategy, LLM_Query_Log, Daily Snapshots) already march monotonically toward the ceiling with no compaction.
- **API quota.** Default Sheets quota is ~60 read + 60 write req/min/user. `buildContacts` is 6 reads; the app re-fetches per route navigation and per agent tool call. 100 firms of concurrent users would saturate quota in seconds — and a 429 silently triggers the **sample-data fallback** (`sheets.functions.ts:46-71`), rendering 8 fake DTC contacts as if real. Outages become indistinguishable from loaded state.
- **Full-tab reads = latency ∝ total historical rows, not active records.** There is no range query, index, or query pushdown. Latency and memory grow without bound.
- **No transactions / no locking → effectively one writer.** Concurrent edits race on `updateCell`; multi-step writes are non-atomic. With multiple firms and multiple users this corrupts data, not just slows it.
- **Single OAuth token + single spreadsheet = single point of failure and a single throughput bottleneck.** No replicas, no sharding.

## 14.2 Why the *absence* of tenancy, queue, cache, and retrieval breaks
- **No multi-tenancy.** Auth is 100% client-side: `ALLOWED_EMAILS` is a hardcoded single-email array (`auth-context.tsx:5-7`); server fns take an arbitrary `user` string defaulting to `'tester'` (`llm.functions.ts:138`) and never authorize it. There is no per-tenant data scoping at all — all data is one workbook. 100 firms cannot share this without a complete data-isolation rebuild. (This is also a Part 5/security finding, but it is *the* blocker for "100 firms.")
- **No queue / background jobs.** Signal scans, enrichment, imports, and AI generations all run inline in request handlers and will time out at scale. "Millions of AI generations" requires a job queue with rate-limited workers, idempotency, and retry — none exist.
- **No real cache.** The per-instance `Map` cannot serve a fleet. There is no shared cache (Redis), no CDN for derived data, no materialized rollups.
- **No vector store / retrieval.** Signal→contact relevance and Discovery comparable-tech matching are done by re-sending raw rows to Gemini and re-scoring every time (hard caps of 120 contacts in `scoreNetworkTargets`, 150 people in `scanSignals`). This is O(signals × contacts) LLM cost and cannot scale past a few hundred contacts, let alone 10M.
- **No stable entity IDs.** Contacts/Targets are keyed by array index (`c-${idx}`/`t-${idx}`) and joined cross-tab by free-text email/name. At 250k companies, name-based joins (`normCompany`, `company-intel.ts:88`) fracture entities on every spelling variant — there is no entity-resolution layer.

## 14.3 Recommended target architecture

| Concern | Target |
|---|---|
| **Primary store** | Postgres (managed, e.g. Cloud SQL/AlloyDB) with proper schema, surrogate PKs, FKs, indexes. Signals → a partitioned/time-series store or columnar warehouse (BigQuery) at 100M scale. |
| **Multi-tenancy** | `tenant_id` on every row + Postgres Row-Level Security; server-side auth (OIDC) enforced in every server fn; per-tenant quotas. |
| **Caching** | React Query (already installed) on the client for normalized entity cache + invalidation; Redis server-side for hot reads, rollups, and the LLM/Sumble result cache (keyed by content hash, with TTL). |
| **Async / queues** | A job queue (Cloud Tasks / SQS + workers) for signal scans, enrichment, imports, and AI generations; idempotency keys; rate-limited, backoff-aware workers; the Python radar worker becomes a scheduled Cloud Run Job feeding the same DB. |
| **Vector store / retrieval** | pgvector or a managed vector DB; embed contacts/companies/signals once; replace per-signal LLM ranking and per-search re-profiling with ANN retrieval + a small re-rank. |
| **Background processing** | Materialized views / scheduled rollups for dashboard KPIs, momentum, activity scores — computed once, not per render. |
| **Frontend** | Adopt React Query end-to-end; memoize context values or replace the 9 contexts with a store (Zustand/Jotai); URL-back all filters; virtualize lists; split the 1500-2000 line route files; stream long AI runs; persist agent sessions server-side. |
| **Writes** | Transactional, server-committed (never client-committed as the agent does today), with optimistic-update + rollback on the client cache. |

The honest framing for the CTO: the current build is a credible *single-firm internal tool* that has hit the ceiling of its prototype data layer. Every Part-14 target number requires a different database, a tenancy model, a queue, a cache, and a vector index — i.e. the persistence and execution substrate must be replaced. The React/TanStack frontend is salvageable but needs a real client-cache and the giant components decomposed before it will perform even at single-tenant scale-up.


# Part 15 — Prioritized Improvement Roadmap

*Aggregated from 94 discrete findings across the five cross-cutting analyses (94 distinct after dedupe). Critical and High are given in full; Medium and Nice-to-have are tabulated.*

**Counts:** Critical 14 · High 43 · Medium 35 · Nice-to-have 2

## Critical (Must Fix — failures / silent data loss / security exposure)

#### 1. Targeting pipeline stage changes and manual/CSV adds are never persisted
- **Problem:** updateStage, promoteSelected, handleNewTarget, handleBulkImport, and handleCsvUpload all mutate only React state (setTargets); buildTargets always defaults stage to 'Prospecting'. Every pipeline stage change and every manually-added/pasted/CSV-imported target is silently lost on refresh.
- **Root cause:** No server function is called from these handlers (addTarget exists but is unused by them), and there is no Stage column write path; pipeline state lives only in component memory.
- **User impact:** Users move leads through the funnel, add prospects, and import lists, then lose all of it on reload — the entire purpose of the Targeting page does not survive a page refresh. Total silent loss of the page's primary unit of work.
- **Technical impact:** Pipeline analytics, the Home attention queue, and 'Ready to Promote' are all built on data that resets to Prospecting each load; no audit of stage transitions exists.
- **Recommended solution:** Add a Stage column write (updateTargetFields by stable id) called from updateStage/promoteSelected; call the existing addTarget server fn from the manual/CSV/paste handlers; record stage transitions for audit.
- **Complexity:** Medium · **Business value:** High

#### 2. Asana BD/GTM activity is display-only and never feeds the relationship score
- **Problem:** scoreContact derives temperature purely from Sheet-derived interactions/events/intros/lastContact; Asana activities are matched only at render time for display. A contact with 10 logged BD/GTM activities and no Sheet interactions scores Cold, and that Cold score drives the Home attention queue.
- **Root cause:** activity-score.ts has no AsanaActivity input; matched activities are recomputed client-side via fuzzy substring rules and never persisted into the scoring pipeline.
- **User impact:** The 'automatic network scorecard' systematically misranks everyone whose engagement lives in Asana; partners are told the wrong people need attention.
- **Technical impact:** The richest behavioral data source has zero effect on temperature; O(activities x records) fuzzy matching runs in the browser on every detail open with no audit trail.
- **Recommended solution:** Persist matched Asana activities (idempotent on activityGid) into a normalized activity/interactions tab keyed by a stable contact id, and make scoreContact read from it; remove client-side re-matching.
- **Complexity:** Medium · **Business value:** High

#### 3. No stable entity IDs — every join is fragile free-text matching
- **Problem:** Contacts/Targets use array-index ids (c-/t-${idx}) plus derived keys (email; targetKeyOf=email|name|company; normCompany free text; event name). Editing a key re-keys the row and orphans related data; out-of-band sheet edits renumber ids; company variants fracture into separate entities. A urid column is mapped but never written or joined.
- **Root cause:** There is no immutable surrogate key written on create and used for all cross-tab joins, React Query keys, and AI-artifact keys.
- **User impact:** Saved outreach trails and AI plans silently detach when a target's email/name changes; the same company appears as multiple disconnected entities; signals/intros/emails drop on any naming drift.
- **Technical impact:** All referential integrity is coincidental; no cascade, no FK, no migration path; selection-by-id breaks on any sheet edit.
- **Recommended solution:** Add a urid column, write it on every create, backfill existing rows, and re-key every join/outreach/strategy/provenance map and client id to it.
- **Complexity:** High · **Business value:** High

#### 4. No stable primary keys — record IDs are array indices
- **Problem:** Contact/Target/Portfolio IDs are assigned as array indices at read time (c-${idx} sheets.server.ts:1018, t-${idx}, pc-${idx}) and interaction IDs as i-${idx}-${iIdx} (:988). A mapped `urid` column exists in CONTACT_COLS (:823) but is never written, joined, or surfaced.
- **Root cause:** Sheets rows have no intrinsic identity; the code never generates or persists a surrogate key, so identity is purely positional.
- **User impact:** Any out-of-band sheet edit (insert/delete/reorder), or even the silent mock fallback, renumbers every record, so selections, drill-downs, and optimistic local patches target the wrong contact.
- **Technical impact:** React Query/router keys, id-based local updates, and cross-tab references are all unstable; impossible to build reliable cross-tab joins or audit trails.
- **Recommended solution:** Generate a UUID per row on creation and write it to the existing urid column; switch all cross-tab joins and outreach/strategy/provenance keys to urid. On Postgres, use uuid PKs.
- **Complexity:** Medium · **Business value:** High

#### 5. Editable join keys silently orphan all related rows
- **Problem:** Cross-tab relationships join on free-text email (Contacts↔Events/Notes/Intros, groupBy :960-962) or targetKeyOf=email||name|company (types.ts:192-196). updateTargetFields can edit email/name/company (:1682-1696) and contact email edits go through the write path, changing the derived key.
- **Root cause:** The foreign key is a mutable, user-editable business string with no immutable surrogate behind it; targetKeyOf is derived, not stored.
- **User impact:** Editing a target's email/name detaches its entire saved outreach trail and AI connection plan; editing a contact's email orphans its events/notes/intros — silently, with no warning.
- **Technical impact:** No referential integrity; every side table can be silently disconnected by a normal edit. Contacts is only safe because email is omitted from MERGE_FIELD_HEADERS by accident, not design.
- **Recommended solution:** Join on the surrogate urid (above). Until then, forbid email/name/company edits that change a key, or migrate child rows when a key changes. Long-term: real FKs in Postgres.
- **Complexity:** Medium · **Business value:** High

#### 6. Positional appends vs header-named reads (split-brain schema)
- **Problem:** addTarget (sheets.functions.ts:206-221) and the prospect importer (prospects.functions.ts:436-451) append 14 values positionally to match TARGET_HEADERS, while reads are header-name based (TARGET_COLS:848-864). Three different Contacts column orders exist in-tree (provision_sheet.py, reorder_contacts.py, fix_carmen.py).
- **Root cause:** Writes were implemented as raw positional appends instead of the header-aware pattern that addContactRow (sheets.server.ts:680-714) already uses.
- **User impact:** A single column insert/reorder via the Sheets UI silently writes all future rows under the wrong headers — exactly what corrupted Carmen's row 1011.
- **Technical impact:** Latent data-corruption class triggered by any schema change; already proven to have occurred (fix_carmen.py).
- **Recommended solution:** Convert addTarget and the prospect importer to the existing header-aware addContactRow pattern; delete positional appends entirely.
- **Complexity:** Low · **Business value:** High

#### 7. Silent sample-data fallback masks outages as real data
- **Problem:** fetchContacts/fetchTargets/fetchPortfolioCompanies return hardcoded sample VC contacts on ANY error (sheets.functions.ts:46-71).
- **Root cause:** Error handling swaps in mock data instead of surfacing failure.
- **User impact:** A transient Sheets 429/500/auth blip renders fake contacts (Glossier, Casper) indistinguishable from real ones; users cannot tell data loss from mock, and writes against a sample email no-op or mis-target.
- **Technical impact:** Outages are invisible; debugging is corrupted; writes can be silently lost or misdirected during the fallback window.
- **Recommended solution:** Remove the mock fallback from production paths; show an explicit error/empty state and retry with backoff. Reserve sample data for a dev-only flag.
- **Complexity:** Low · **Business value:** High

#### 8. AI outputs are never written back to CRM objects (keystone defect)
- **Problem:** DNA scores, connection plans, daily briefings, email drafts, competitor lists, network rankings, and signal attributions are computed, rendered once, and discarded. Only the Signal scan and Customer Discovery persist anything, and those persist headlines/blobs, not structured intelligence.
- **Root cause:** No write-back path exists from any AI feature to a contact/target/company record; the Query agent's answer is dropped (only 4 explicit write tools persist), insights/strategy/score/broadcast functions return to React state, and there is no concept of an AI-derived field on a record.
- **User impact:** The CRM never gets smarter with use; users must re-ask and re-generate the same answer; AI-surfaced reasons (why a contact was ranked, why a signal matters) vanish, breaking the signal→action→tracked-relationship loop the product implies.
- **Technical impact:** Identical inferences re-bill Gemini/Sumble/Apollo on every panel open; outputs are non-reproducible and unauditable; no data exists to compare scores over time or drive prioritization.
- **Recommended solution:** Add a persistence contract: after any AI generation, offer 'save to record' that writes a structured AI field (score/strategy/note) with provenance and a confidence value, keyed by a stable record id. Make score_company_dna, connectionStrategy, and signal attribution write back by default.
- **Complexity:** High · **Business value:** High

#### 9. Targeting pipeline does not persist (stage, promote, manual/paste/CSV adds all lost on reload)
- **Problem:** The core unit of work on the Targeting page — moving a lead through Prospecting → Researching → Outreach Sent → Ready to Promote — is never written to Sheets. updateStage/promoteSelected only call setTargets in memory (targeting.tsx:809-818), and handleNewTarget/handleBulkImport/handleCsvUpload create leads with setTargets only, never calling the existing addTarget server fn (targeting.tsx:517-606). buildTargets always defaults stage to 'Prospecting'.
- **Root cause:** UI treats local React state as source of truth; no server fn exists to write the Targets 'Stage' column, and the manual/import handlers were never wired to addTarget. No router.invalidate or persistence step.
- **User impact:** A partner spends a session triaging the pipeline and adding leads, refreshes or comes back tomorrow, and the entire pipeline has reset to Prospecting with hand-entered/CSV leads gone. The tool is untrustworthy for its primary purpose.
- **Technical impact:** Pipeline analytics, the Home attention queue, and 'Ready to Promote' are all built on data that resets. Stage has no whitelist validation on read either.
- **Recommended solution:** Add updateTargetStage server fn writing the Stage cell by targetKeyOf; call it from updateStage/promoteSelected. Wire handleNewTarget/handleBulkImport/handleCsvUpload to addTarget per row (it already exists). Add optimistic update + error rollback.
- **Complexity:** Medium · **Business value:** High

#### 10. 'Promote to CRM' is a no-op label change — the funnel has no exit
- **Problem:** 'Promote to CRM' / 'Promote All' only set stage='Ready to Promote' in memory (targeting.tsx:814-818, 1607-1611). No Contact is created, no link established, and even the label is lost on reload.
- **Root cause:** The promotion handoff was never implemented; there is no code path from a Target to a Contacts row.
- **User impact:** The prospecting funnel never actually delivers anyone to the CRM, defeating the product's core source→nurture loop. Partners cannot graduate a researched lead into a tracked relationship.
- **Technical impact:** Outreach trail and AI connection plan (keyed by targetKeyOf) are stranded; they are never migrated into the Contact's interaction history.
- **Recommended solution:** Implement promote: create/update a Contacts row (Cold) from the TargetLead, copy outreach trail into Notes/Interactions, stamp a back-link, mark the target promoted (persisted). Offer dedup against existing Contacts.
- **Complexity:** Medium · **Business value:** High

#### 11. Target Accounts writes to Contacts, not Targets, so the pipeline shows nothing after 'Added N'
- **Problem:** Target Accounts (filed under the Targeting Discover menu) calls addAccountPeople, which writes people to the CONTACTS tab as Cold contacts with purpose in the Source field and no Reason Surfaced (accounts.functions.ts:257-268). The dialog passes onImported=refreshTargets (targeting.tsx:1637), which re-pulls Targets and shows zero new rows.
- **Root cause:** Inconsistent destination across the three 'find people at a company' paths; Target Accounts reuses the contact-add path instead of the target-add path.
- **User impact:** User sees a success toast then an empty pipeline — the feature appears broken. The same intent (Network Finder/Discovery) goes to Targets, fragmenting the funnel and confusing users about where leads land.
- **Technical impact:** Provenance/Reason Surfaced lost; dedup semantics differ per path; refreshTargets is a silent no-op.
- **Recommended solution:** Route addAccountPeople to the Targets tab with originSource + reasonSurfaced (mirroring addProspectsToTargets), or consolidate all three paths into one shared 'find decision-makers → Targets' service.
- **Complexity:** Low · **Business value:** High

#### 12. Optimistic-local edits with no server write across CRM (interaction edits, intro/event removal, bulk note/event/intro)
- **Problem:** saveInteractionEdit, removePortCoIntro, removeEvent (ContactDetail.tsx:590-602, 719-731) and sidebar bulk Add Note/Event/Intro (app-sidebar.tsx:272-342) mutate only React state; no server fn is called. Adds persist but removals/edits do not (asymmetric).
- **Root cause:** These handlers were built to update the local list and the server write was never added; bulk edits only call onBulkUpdate (local patch).
- **User impact:** User edits an interaction, removes a wrong intro, or bulk-logs notes across 30 contacts, sees success, then loses it all on reload. Silent, confidence-destroying data loss.
- **Technical impact:** UI and Sheet permanently diverge; activity counts that feed scoring are based on data that never persisted; no rollback on the writes that do exist.
- **Recommended solution:** Add server fns for interaction edit/delete and intro/event removal; have bulk note/event/intro call addNote/addEvent/addPortcoIntro per contact (batched). Add optimistic rollback on failure.
- **Complexity:** Medium · **Business value:** High

#### 13. Critical 'saves' are in-memory only and silently lost on refresh
- **Problem:** Pipeline stage changes/Promote (targeting.tsx:809-818), manual/CSV/paste target creation (targeting.tsx:517-606), bulk Add Note/Event/PortCo (app-sidebar.tsx:272-342), interaction edits and intro/event removals (ContactDetail.tsx:590-602,719-731) update only React state with no server write.
- **Root cause:** Server functions exist (addTarget, etc.) but UI handlers were wired to setState only; persistence was never connected.
- **User impact:** Users believe work is saved (success toasts) but it vanishes on reload — direct data loss and erosion of trust.
- **Technical impact:** Core pipeline state (stage) always defaults to 'Prospecting' on read; the funnel never persists.
- **Recommended solution:** Wire each handler to its server fn (add a stage-write fn), then invalidate; remove the optimistic-only path or pair it with a confirmed write.
- **Complexity:** Medium · **Business value:** High

#### 14. Architecture cannot scale to target volumes: Sheets hard limits + no tenancy/queue/cache/vector layer
- **Problem:** 10M-cell spreadsheet ceiling, ~60 req/min/user quota, no transactions/locking/indexes, single workbook + single OAuth token, client-only single-email auth, inline AI/enrichment, LLM-over-raw-rows relevance with hard caps (120/150).
- **Root cause:** A single-tenant prototype data and execution substrate.
- **User impact:** At scale: throttling that silently swaps in fake sample data, data corruption under concurrency, multi-firm isolation impossible, timeouts on AI/import.
- **Technical impact:** 10M contacts × 30 cols = ~30x the cell limit on one tab; 100M signals is structurally impossible; no path to multi-tenant or horizontal scale.
- **Recommended solution:** Re-platform: Postgres/AlloyDB (signals to BigQuery/partitioned store) with surrogate keys+indexes; tenant_id + RLS + server-side OIDC auth; job queue (Cloud Tasks/SQS) for scans/enrichment/imports/AI; Redis cache + materialized rollups; pgvector/managed vector DB for retrieval-based relevance; transactional server-committed writes with client-cache optimistic updates.
- **Complexity:** High · **Business value:** High

## High Impact (correctness & daily experience)

#### 1. Target Accounts feature writes to Contacts, not the Targets pipeline it lives under
- **Problem:** addAccountPeople calls addContactRow (Contacts tab, temperature Cold, source=purpose) and never appends to Targets, while the dialog sits under the Targeting Discover menu and passes onImported=refreshTargets — which re-pulls Targets and shows nothing. No reasonSurfaced is stamped.
- **Root cause:** Divergent destination logic across the three company->people implementations; accounts path was wired to Contacts while network/discovery paths write Targets.
- **User impact:** User clicks 'Add', sees an 'Added N' toast, and sees zero new rows in the pipeline — the feature appears broken and fragments the prospect pipeline across two tables.
- **Technical impact:** Same intent ('prospect a named company') splits across Contacts and Targets with different dedup and source semantics; purpose tagging is lost to the pipeline.
- **Recommended solution:** Route addAccountPeople to the Targets tab with reasonSurfaced via a shared findPeopleAtCompany service and one dedup policy.
- **Complexity:** Low · **Business value:** Medium

#### 2. Signals never write back to the CRM (synthetic non-record outreach)
- **Problem:** Acting on a signal opens EmailDraftDialog with a synthetic Contact (id signal-${email}, empty interactions/portCoIntros). Outreach leaves no trace on the real contact; the StoredSignal.status column is never advanced from the UI.
- **Root cause:** No resolution from signal email/person to the real contact id, and no setSignalStatus write path; the radar is architected as read-only relative to the CRM.
- **User impact:** Signal-driven outreach is invisible in the contact timeline, in velocity analytics, and in the attention queue; the signal feed never triages down because nothing can mark a signal actioned/dismissed.
- **Technical impact:** Breaks the implied product loop (signal -> action -> tracked relationship); the existing Status column is dead.
- **Recommended solution:** Resolve signals to real contact ids; on send, log an interaction/email-activity against the real record; add a setSignalStatus server fn writing the existing column; feed fresh high-opportunity signals into the attention queue.
- **Complexity:** Medium · **Business value:** High

#### 3. Inbound Gmail attribution is computed then discarded — emails don't update contacts
- **Problem:** gatherNetworkEmails resolves each message to a real contact via a byEmail map but throws the attribution away after building a display GmailSignal. logEmailActivity is only called from the manual draft dialog, so real two-way email traffic never updates last-touch, temperature, or the Email Activity log.
- **Root cause:** The integration was scoped to render the Signals reel only; the already-computed contact match is unused for persistence.
- **User impact:** Relationship recency/heat is driven only by manual notes and manually-sent drafts; temperature and last-touch are systematically stale despite the app being able to read the inbox.
- **Technical impact:** The recency component of the score (40% weight) is blind to data the app already fetches; no idempotency layer for email-derived activity.
- **Recommended solution:** In gatherNetworkEmails, when matchEmail resolves, append an idempotent (keyed on Gmail message id) Email Activity row and bump lastContact — a small change reusing the existing attribution.
- **Complexity:** Low · **Business value:** High

#### 4. Apollo non-destructive merge path is dead code; enrichment is fully manual and not reused
- **Problem:** No source calls mergeContactFields with source:'apollo' (verified); every caller passes 'user'. The fill-only/human-edit-protecting branch has zero production callers. The Python backend returns Apollo enrichment but never persists it. Apollo Raw payloads are archived but never read back into the company graph.
- **Root cause:** No batch/background enrichment job was built; the protection engine exists but its only intended caller (automated refresh) was never wired.
- **User impact:** Enrichment is one contact at a time, click-by-click; new/empty contacts stay empty; the firm pays for enrichment data that is never fed into the source of truth or the company entity layer.
- **Technical impact:** The provenance system's reason to exist is untested in production; the richest external dataset is write-only archival.
- **Recommended solution:** Add a scheduled server fn that enriches empty-field contacts via enrichPerson and mergeContactFields(source:'apollo'); surface Apollo employment/headline data into company-intel.
- **Complexity:** Medium · **Business value:** High

#### 5. AI outputs are never persisted to the records they concern
- **Problem:** DNA scores, drafted emails, company-intro insights, competitor suggestions, broadcast network rankings (120 contacts/open), and home briefing all render to component state and are re-billed every open. Only the Signals scan and (on explicit Save) connection strategy persist. A Daily Briefing tab exists but is unused.
- **Root cause:** No write path attaches AI artifacts to a target/company/contact record with confidence/rationale; outputs are treated as transient UI.
- **User impact:** Expensive, non-reproducible outputs vanish each session; partners can't compare scores over time, can't trust a DNA score as canonical, and re-pay for identical inferences.
- **Technical impact:** O(signals x contacts) redundant LLM cost; no confidence field anywhere; scores drift and can't drive prioritization.
- **Recommended solution:** Persist AI artifacts to the relevant record (DNA score+confidence on the target, insight pinned to company, broadcast relevance edge cached on the signal); wire generateHomeSummary to the Daily Briefing tab.
- **Complexity:** Medium · **Business value:** Medium

#### 6. Bulk Add-Note/Event/Intro and edit/remove operations silently don't persist
- **Problem:** Sidebar bulk Add Note/Event/PortCo (app-sidebar.tsx) and ContactDetail saveInteractionEdit / removePortCoIntro / removeEvent mutate only local state via onBulkUpdate or setState, never calling a server fn — unlike the profile-field path beside them.
- **Root cause:** Inconsistent persistence wiring; add-counterparts call the sheet while edit/remove/bulk-activity paths were left local-only.
- **User impact:** Users believe they recorded activity in bulk or removed an intro/event; it silently vanishes on reload — a direct data-integrity hole.
- **Technical impact:** Asymmetric persistence guarantees (add persists, remove doesn't) guarantee UI/sheet divergence; bulk activity that feeds scoring is dropped.
- **Recommended solution:** Wire saveInteractionEdit, removePortCoIntro, removeEvent, and the bulk note/event/intro handlers to server functions with optimistic rollback on failure.
- **Complexity:** Medium · **Business value:** Medium

#### 7. Portfolio relational data (employees/events/intros/contacts) is never sourced from Sheets
- **Problem:** buildPortfolioCompanies hardcodes contactName/Email/Phone='' and employees/events/introductions=[]; the rich type is only filled by sample data. company-intel's 'team' band reads p.employees and is structurally dead for real portcos. Portfolio detail relational views are blank (real) or fake (fallback).
- **Root cause:** No relational tabs are joined for portfolio; the data model promises relationship storage that the builder never delivers.
- **User impact:** The portfolio module's richest views (Key People, team, company intros) are empty or fake; portco records are read-only husks.
- **Technical impact:** All portco<->contact linkage is in-memory email-domain matching that breaks on personal emails/variants; no portfolio health/financial view exists at all.
- **Recommended solution:** Persist a company entity with id owning employees/intros/events; add a contact<->company FK; populate buildPortfolioCompanies from the relational tabs.
- **Complexity:** High · **Business value:** High

#### 8. Query-agent writes do not invalidate other views; chat and writes can diverge
- **Problem:** query.tsx commits approved writes client-side (re-implementing each write tool) but never calls router.invalidate (verified 0 matches), so CRM/Dashboard/Events show stale data after an agent write. Chat/sessionId/pending live in useState and are lost on refresh, including a pending write approval. The server audit 'complete' status can diverge from the actual client-side write.
- **Root cause:** No cache invalidation after agent writes; no server-side session store; write logic duplicated between server WRITE_TOOLS and client ApprovalCard.
- **User impact:** A contact added via the agent is invisible on /crm until hard reload; reloading mid-workflow destroys an in-flight approval; users lose synthesized answers that were never saved to a record.
- **Technical impact:** Two sources of write truth must stay in sync; audit log can record success while the client write failed.
- **Recommended solution:** Call router.invalidate (or a shared store update) after commit; move write execution server-side; persist sessions keyed by session_id (the log already records every turn) for resume.
- **Complexity:** Medium · **Business value:** Medium

#### 9. Silent sample-data fallback makes outages indistinguishable from real data
- **Problem:** Three core fetchers swallow all errors and return sampleContacts/Targets/PortfolioCompanies on any failure (including transient 429s), rendering 8 fake DTC brands as if real. Writes against a sample email no-op or mis-target.
- **Root cause:** try/catch returns mock data as a production fallback instead of surfacing an error state.
- **User impact:** Users cannot tell data loss from mock data; they may act (edit, email) against fake records during an outage.
- **Technical impact:** Masks Sheets quota/auth failures; corrupts trust in every screen during transient errors.
- **Recommended solution:** Surface an explicit error/empty state instead of mock data in production; reserve sample data for an explicit demo flag.
- **Complexity:** Low · **Business value:** Medium

#### 10. No transactions, locking, or atomicity on multi-step writes
- **Problem:** Rating updates (cell+history+override :1144-1187), Apollo raw+merge (ContactDetail.tsx:448,471), save-strategy dual append (targeting.tsx:490-493), and snapshot/log upserts are all non-atomic. The 5-min cache (:28-37) is per-instance.
- **Root cause:** Google Sheets offers no transactions or row locks; the app does read-modify-write with no coordination.
- **User impact:** Partial failures leave inconsistent state (e.g. raw archived but merge failed); concurrent edits clobber each other; duplicate snapshot/log rows from races.
- **Technical impact:** Read-modify-write races on every upsert; cache can hide just-written rows, forcing duplicates; impossible to guarantee consistency under concurrency.
- **Recommended solution:** Migrate to a transactional store (Postgres). Interim: serialize writes per tab, batch related cell writes, and add idempotency keys to append-once operations.
- **Complexity:** High · **Business value:** High

#### 11. Read-time coercion fabricates data (Cold / Cloud / invited∪attended / lastContact / 0)
- **Problem:** Status not exactly Hot/Warm/Cold → Cold (:1013-1015); unmapped focus area → Cloud (:1789); eventsInvited=invited∪attended (:1032); lastContact=dateAdded||unsorted[0] (:1034); malformed numbers → 0 (:480,:1430).
- **Root cause:** Builders silently default/merge instead of validating and flagging bad input.
- **User impact:** Hot-lead counts, domain charts, invite/attendance funnels, recency, and scoring are all systematically wrong with no indication anything was malformed.
- **Technical impact:** Analytics and the activity scorecard are built on fabricated values; data-entry errors are permanently masked.
- **Recommended solution:** Validate on ingest; reject/flag invalid values into a review queue instead of coercing. Store invited vs attended distinctly; compute lastContact from the max interaction date.
- **Complexity:** Medium · **Business value:** High

#### 12. Portfolio relational model never sourced from Sheets
- **Problem:** buildPortfolioCompanies hardcodes contactName/Email/Phone='' and employees/events/introductions/linkedinUrl empty (sheets.server.ts:1803-1811); the rich PortfolioCompany type (types.ts:274-290) is only ever filled by sample data.
- **Root cause:** The portfolio tab only stores name/sector/website/location/description; the relational fields were typed but never wired.
- **User impact:** PortCo detail relational views (people, events, intros) are blank for real data or fake under fallback; company-intel 'team' band is dead.
- **Technical impact:** The data model promises relationships it never delivers; downstream features (company graph, discovery grounding) silently degrade.
- **Recommended solution:** Either populate these from real relational tabs/Asana joins, or remove the fields from the type and the UI affordances that imply them.
- **Complexity:** Medium · **Business value:** Medium

#### 13. AI caches keyed by free-text company name with no TTL
- **Problem:** PortCo Intel and Customer Discovery upsert by normKey(companyName) (sumble.functions.ts:44, discovery upsert :58-67) with no expiry; Customer Discovery stores an entire DiscoveryResult in one JSON cell.
- **Root cause:** Cache key is a free-text name, not a stable company ID; no freshness policy.
- **User impact:** Renamed companies orphan their cache (re-billed); variant spellings create duplicate cached rows; stale intel/leads served indefinitely until manual refresh.
- **Technical impact:** Unqueryable JSON blobs invisible to analytics/agent; risk of hitting the 50k-char cell limit; wasted Sumble/Gemini credits.
- **Recommended solution:** Key caches by company UUID, add a fetched_at+ttl, and store payloads in a normalized ai_cache table (jsonb in Postgres).
- **Complexity:** Medium · **Business value:** Medium

#### 14. Weak, inconsistent dedup; duplicate accumulation requires manual scripts
- **Problem:** addTarget has zero dedup; prospects dedups email-only (prospects.functions.ts:424-429); accounts uses email|linkedin|name+company (stricter); CSV import uses its own path. cleanup_duplicates.py exists because uploads re-add seeded rows.
- **Root cause:** No write-time upsert; four divergent dedup strategies; no constraint enforcing uniqueness.
- **User impact:** Duplicate contacts/targets accumulate; emailless people re-add endlessly; a person can be both a Contact and a Target with no link; cleanup needs a human running Python.
- **Technical impact:** Data set drifts toward duplicates; downstream counts and outreach are inflated/redundant.
- **Recommended solution:** Single upsert function (email||linkedin||name+company) used by every import path; in Postgres enforce unique(email) + dedup keys at the constraint level.
- **Complexity:** Medium · **Business value:** High

#### 15. Company entities fracture on free-text names (no canonicalization)
- **Problem:** company-intel keys companies by trim+lowercase name (company-intel.ts:88,250); Asana merge, intros, and email links all use exact name equality; portfolio↔Asana mismatches synthesize phantom 'asana-pc-' duplicate companies (portfolio.tsx:44-47).
- **Root cause:** No companies table, no alias/entity-resolution layer; every surface re-derives company identity from a raw string.
- **User impact:** 'Acme' vs 'Acme, Inc.' become different entities, splitting people/signals/momentum; intros and emails silently drop on any spelling drift; duplicate company cards.
- **Technical impact:** Entity graph is unreliable; competitor radar and rollups fracture; no single source of company truth.
- **Recommended solution:** Introduce a companies table with canonical_name + name_aliases[] + domain; resolve all entities through it. Interim: a normalization/alias map shared by all matchers.
- **Complexity:** Medium · **Business value:** High

#### 16. UI operations claim to save but persist nothing (or to the wrong tab)
- **Problem:** Target stage changes, manual/paste/CSV target adds (targeting.tsx:517-606,809-818), interaction edits / intro+event removals (ContactDetail.tsx:590-602,719-731), and bulk Add Note/Event/Intro (app-sidebar.tsx:272-342) update only local state. Target Accounts adds write to Contacts, not Targets (accounts.functions.ts:257-268).
- **Root cause:** Optimistic-local updates were never backed by server fns; one feature targets the wrong tab.
- **User impact:** Users believe they recorded pipeline progress/activity that silently vanishes on reload; 'Target Accounts' appears broken (refreshTargets shows nothing).
- **Technical impact:** Persistent divergence between UI and store; pipeline analytics built on data that resets; data-integrity hole.
- **Recommended solution:** Wire each operation to a server fn (addTarget exists; add stage-update, interaction-update, removal, bulk-activity fns) and invalidate the loader; route Target Accounts to Targets with reasonSurfaced.
- **Complexity:** Medium · **Business value:** High

#### 17. No referential integrity, deletes, or cascade — orphan rows accumulate forever
- **Problem:** No delete/tombstone path exists for any record; side tables (Notes/Events/Intros/Email Activity/Provenance/Override/History) are append-only logs keyed by email string (sheets.server.ts).
- **Root cause:** Append-only Sheets design with no cascade semantics.
- **User impact:** Deleting/cleaning a contact is impossible in-app; re-adding a contact with a reused email inherits a stranger's history.
- **Technical impact:** Unbounded orphan accumulation toward the 10M-cell limit; no way to enforce that child rows reference a live parent.
- **Recommended solution:** Add soft-delete/tombstone + cascade in a relational store with FKs; interim archival job to sweep orphaned side rows.
- **Complexity:** High · **Business value:** Medium

#### 18. Full-tab reads + O(n) linear-scan writes; no indexes or pagination
- **Problem:** fetchSheetTab GETs the entire tab (sheets.server.ts:83-106); buildContacts pulls 6 tabs in full per cold load; every targeted write (mergeContactFields:1266, setContactRating:1172, updateTargetFields:1663, resolveFollowUp:281, logUpdate:82) fetches and scans the whole tab to find one row.
- **Root cause:** No query pushdown, range reads, or index; Sheets cannot index.
- **User impact:** Latency and payload grow with total historical rows (already 1000+ contacts at Carmen's row 1011), not active records; recalc/imports burst the API into 429s (which trigger the mock fallback).
- **Technical impact:** O(rows) per micro-edit; provenance scan grows with total edits ever made; quota-bound; cannot scale.
- **Recommended solution:** Move to Postgres with indexed lookups and range queries; interim: a per-request row-number cache and batched cell writes.
- **Complexity:** High · **Business value:** Medium

#### 19. No structured-output schemas; JSON validity rests on a lossy hand-rolled repair
- **Problem:** responseMimeType:'application/json' is set but no responseSchema is ever supplied; outputs are validated by repairJson which, on truncation, silently drops the half-written trailing element.
- **Root cause:** Vertex responseSchema (enum/required enforcement) is unused anywhere in the codebase (confirmed by grep); the team instead built brace-balancing + positional Sheet reads to cope with malformed JSON.
- **User impact:** Signals and other list outputs can be silently missing entries; users see incomplete results with no error or retry indication.
- **Technical impact:** repairJson, the positional Signals-tab read (adopted because header lookups 'made signals vanish'), and recurring parse-failure fallbacks are all downstream symptoms; silent data loss instead of clean retry.
- **Recommended solution:** Define responseSchema for every callGeminiJSON/draftEmail/scan call; on schema-validation failure, retry once with a repair prompt rather than brace-balancing; remove repairJson and positional reads once schemas are enforced.
- **Complexity:** Medium · **Business value:** High

#### 20. Most AI spend bypasses the audit/cost log; the 'every query logged' claim is false
- **Problem:** Only the Query agent writes to LLM_Query_Log. draftEmail, scanSignals, all insights functions, generateHomeSummary, runGemJSON, broadcast scoring, and Sumble/Gemini Discovery calls are completely untracked.
- **Root cause:** Logging was implemented as a wrapper around the agent loop only, not as a shared gateway; eight modules call gemini.server directly (confirmed by grep), and one explicitly comments it is 'NOT the audited agent layer'.
- **User impact:** No cost monitoring, no audit review, no token-spend visibility despite the UI promising every query is logged; misleading compliance posture.
- **Technical impact:** Majority of token spend and AI output is invisible; cannot budget, cap, or attribute spend; Sumble credits (~50cr brief, ~5cr/tech) parsed but never logged or surfaced.
- **Recommended solution:** Introduce a single audited LLM gateway (and a Sumble/Apollo credit ledger) through which every model/enrichment call is routed; log model, tokens, cost, feature, latency; build an admin cost/audit view that reads the log (currently write-only).
- **Complexity:** Medium · **Business value:** High

#### 21. Inbound email is attributed to contacts then discarded instead of logging activity
- **Problem:** The Gmail integration already maps each inbound email to a contact via byEmail, but throws the attribution away after rendering the Signals reel; real email traffic never updates last-touch, temperature, or the Email Activity log.
- **Root cause:** logEmailActivity is only called from the manual EmailDraftDialog (confirmed: sole caller is ContactDetail.tsx); the inbound Gmail path has no write to the activity log or contact recency.
- **User impact:** Relationship recency/heat is driven only by manual notes and manually-sent drafts; temperature and the attention queue are systematically stale for anyone the firm actually emails.
- **Technical impact:** The richest behavioral signal the app can already read is wasted; scoring (activityScore) is blind to two-way email.
- **Recommended solution:** On Signals/Gmail load, append matched inbound emails to Email Activity (idempotently, keyed by message id) and bump lastContact; feed email recency into scoreContact.
- **Complexity:** Medium · **Business value:** High

#### 22. Non-destructive Apollo enrichment merge is dead code; all enrichment is manual
- **Problem:** mergeContactFields has a fully-built fill-only/provenance-protected 'apollo' branch, but every caller in the app passes source:'user' (confirmed by grep), so the branch never runs and enrichment is 100% manual, one contact at a time.
- **Root cause:** No background/batch enrichment job was ever built; the provenance system's reason to exist (protect human edits from automated refresh) has no production caller.
- **User impact:** Users must open each contact and click 'Update with Apollo' individually; new/empty contacts stay un-enriched at scale.
- **Technical impact:** A carefully designed merge engine and provenance log are untested in production; Apollo raw payloads are archived but never read back.
- **Recommended solution:** Add a scheduled batch job that enriches new/empty contacts via mergeContactFields(source:'apollo'); read Apollo Raw to backfill the company entity layer.
- **Complexity:** Medium · **Business value:** High

#### 23. No embedding/retrieval layer — relevance recomputed by LLM over raw rows with silent caps
- **Problem:** Every relevance decision (signal→contact ranking, comparable-tech matching, connection grounding) re-sends raw Sheet rows to Gemini; hard caps (120 contacts, 150 people, 50-company roster) silently hide the rest of the network.
- **Root cause:** No vector store or memory exists (confirmed: no embedding/vector/cosine references); relevance is a fresh LLM pass each time, capped only to fit token budgets.
- **User impact:** Beyond the caps, relevant people are invisible to the AI with no indication; scores are non-deterministic and slow (2-5s per Broadcast/strategy open).
- **Technical impact:** Cost/latency scale O(signals×contacts); cannot scale past a few hundred contacts; broadcast re-ranks the whole network every open and discards the result.
- **Recommended solution:** Build an embedding index over contacts/companies/signals; replace per-signal LLM ranking with vector similarity + a small re-rank; persist signal↔contact relevance edges.
- **Complexity:** High · **Business value:** High

#### 24. Three+ parallel pipelines write the same Sheet; Python radar and FastAPI backend are orphaned
- **Problem:** The live TS Gemini signal pipeline, the Python radar worker (Anthropic, writes 'Radar Signals'), manual mutation scripts, and a parallel FastAPI backend all target the same spreadsheet, but the radar and FastAPI backends have no frontend/route/scheduler and are never read.
- **Root cause:** Aspirational re-implementations and a deferred v2 ingestion slice were built but never wired in; no single source of truth or integration owner.
- **User impact:** Users see only the noisier Gemini web-search feed; the structured EDGAR/ATS/GitHub signals the radar produces (the highest-trust intel) never reach a screen.
- **Technical impact:** Massive maintenance tax (hand-maintained Pydantic mirror already stale), divergent schemas/taxonomies, destructive manual scripts as the de-facto data pipeline, and column-misalignment corruption (fix_carmen.py).
- **Recommended solution:** Either wire the radar output into the live feed via a read path + scheduler and retire the Gemini-only web-search portion for structured sources, or delete the orphaned backends; pick one signal store and one backend.
- **Complexity:** High · **Business value:** Medium

#### 25. Integrations have no retry/backoff/rate-limiting; Asana throws on 429
- **Problem:** Every connector is a bare fetch with no retry, backoff, or rate limiting except Gemini's blocking 429 sleep; asanaFetch throws on any non-2xx including 429 despite a comment claiming caching protects the rate limit.
- **Root cause:** No shared HTTP resilience layer; per-process caches don't survive serverless cold starts, so real request rates exceed assumptions.
- **User impact:** Transient upstream errors surface as empty data or hard failures; LinkedIn 401s silently until a human re-mints the token; large runs partially fail with only console errors.
- **Technical impact:** Sumble ~10 req/s and GitHub 60/hr undefended; Sheets 429s trigger the silent sample-data fallback; one flaky Apollo call disables enrichment for the whole batch.
- **Recommended solution:** Add a shared fetch wrapper with exponential backoff, Retry-After honoring, per-integration rate limiters, and circuit breaking; distinguish transient from permanent failures (don't disable enrichment on a single timeout).
- **Complexity:** Medium · **Business value:** Medium

#### 26. Entity joins are free-text name/domain matches with no canonical IDs or alias table
- **Problem:** Asana fields, Sumble caches, News attribution, signals, and company-intel all join on trimmed/lowercased names or email domains; any naming variance silently severs the link.
- **Root cause:** No entity-resolution layer; concrete evidence includes a hardcoded 'DTC Priority' trailing-space alias and substring company matching in News.
- **User impact:** Renamed/variant companies fragment into multiple entities or lose all intros/signals/intel; personal-email contacts never match their company.
- **Technical impact:** Caches orphan on rename and re-bill; News false-positives ground the model on irrelevant articles; portco↔signal matching even diverges between two code paths.
- **Recommended solution:** Introduce a canonical company-id + alias table; resolve all integration outputs to it; replace substring News matching with domain/entity disambiguation.
- **Complexity:** High · **Business value:** Medium

#### 27. No duplicate detection or lead routing at write time; AI adds land in the wrong table
- **Problem:** addTarget blind-appends with no dedup; Discovery/prospects dedup email-only (missing no-email people); Target Accounts adds people to the Contacts tab instead of the Targets pipeline it is filed under.
- **Root cause:** Each add path reimplements its own (or no) dedup; accounts.functions writes via addContactRow rather than addTarget; no shared routing service.
- **User impact:** Duplicate/competing records accumulate; a person can be both Contact and Target with no link; 'Target Accounts' appears broken (toast says added, pipeline shows nothing).
- **Technical impact:** Unbounded duplicate growth; fragmented pipeline; email-less enriched prospects re-added on every search.
- **Recommended solution:** Build one cross-tab dedup+routing service (email|linkedin|name+company) used by every add path; route 'find people at company' intents to a single destination with reasonSurfaced.
- **Complexity:** Medium · **Business value:** High

#### 28. Confidentiality wall is dead code; agent reads every Sheet tab unredacted
- **Problem:** filterContacts keys off a confidentiality field absent from the Contact type, so it always passes everything through; query_sheet reads every non-Asana tab raw with no field-level redaction.
- **Root cause:** The classification field was never added to the schema; the wall protects Asana by omission (no Asana tool) rather than by data classification.
- **User impact:** Sensitive columns in any Sheet tab flow to the model verbatim; any Asana data mirrored into a Sheet leaks instantly.
- **Technical impact:** The advertised data wall and confidential-row filtering provide no real protection; audit actor is the unauthenticated string 'tester'.
- **Recommended solution:** Add a confidentiality classification to records, enforce field-level redaction in query_sheet, and authenticate the agent's user/approver server-side.
- **Complexity:** Medium · **Business value:** Medium

#### 29. Relationship score ignores Asana BD/GTM activity and inbound Gmail — temperature is systematically wrong
- **Problem:** scoreContact reads only Sheet-derived interactions/events/intros; Asana activities are matched only at render time for display (ContactDetail.tsx:261), and inbound emails attributed in gatherNetworkEmails (gmail.functions.ts:62-103) are discarded. logEmailActivity fires only on manual draft send.
- **Root cause:** The scoring module has no link to the Asana activity subsystem or to inbound email; both are display/grounding-only.
- **User impact:** A contact with heavy BD activity in Asana and active email threads scores Cold and never surfaces in the 'who to contact today' attention queue (index.tsx:91). The headline 'automatic scorecard' is misleading.
- **Technical impact:** Temperature tiers, Home priority ranking, and pipeline prioritization are driven by an incomplete signal; the events component (0-15) is unreachable from Asana.
- **Recommended solution:** Persist matched Asana activities and inbound email attributions into the Interactions/Email Activity tabs (or feed counts/recency directly into scoreContact). Establish a stable contact key so attribution is reliable.
- **Complexity:** High · **Business value:** High

#### 30. Signals never close the loop into the CRM (no triage, no write-back, scores drift)
- **Problem:** Signal status defaults to 'New' but no UI ever advances it (gemini.functions.ts:218). Acting on a signal opens EmailDraftDialog with a synthetic Contact id `signal-<email>` and empty fields (signals.tsx:363-379), so outreach is never logged to the real contact. Grounded scores are recomputed client-side every render and never stored (signal-feed.ts:418).
- **Root cause:** Signals are architected as a read-only reel with no relation back to Contacts and no persisted scores or status.
- **User impact:** The feed never triages down (grows forever), signal-driven outreach is invisible in the contact timeline, and 'top opportunity' is unstable between sessions — a partner cannot rely on it to decide who to contact.
- **Technical impact:** No 'signals that led to outreach' reporting; Home and Signals disagree on top signal; append-only Signals tab grows unbounded.
- **Recommended solution:** Match signals to real contacts by stable key; on action, log an interaction and bump last-touch. Add dismiss/snooze/actioned status writes. Persist computed opportunity scores (or inputs) at scan time.
- **Complexity:** High · **Business value:** High

#### 31. Dead/non-functional UI controls (Add Contact, Research-Apollo bulk, portfolio Web Sync/LinkedIn/Edit/Asana sync)
- **Problem:** crm.tsx:213-219 'Add Contact' has no onClick; targeting.tsx:931-934 'Research (Apollo)' bulk button has no onClick; PortfolioDetail handleLinkedInSync/handleFetchPeople are 2s fake spinners (108-116) and 'Sync with Asana' (484) and 'Edit' (241) have no handlers.
- **Root cause:** UI scaffolding shipped ahead of (or instead of) the backing implementation; placeholder buttons left in the production surface.
- **User impact:** Users click prominent CTAs that do nothing or fake success, eroding trust and blocking core tasks (e.g. cannot create a single contact from the UI at all).
- **Technical impact:** Misleading affordances imply integrations (Asana write-back, LinkedIn enrichment) that don't exist.
- **Recommended solution:** Implement Add Contact (single-contact form → addContact), wire Research-Apollo to batch enrichment, and either implement or remove the portfolio sync/edit buttons. Replace fake spinners with real calls.
- **Complexity:** Medium · **Business value:** High

#### 32. Interaction type is lost on round-trip — all logged calls/meetings/emails read back as generic Notes
- **Problem:** addNote stores only content+followup; the reader hardcodes type:'note' (sheets.server.ts:990). The InteractionType chosen in the UI is never persisted.
- **Root cause:** The Notes tab schema/writer omits a type column; the reader defaults every row to 'note'.
- **User impact:** Logging a 'call' or 'meeting' is cosmetic — it reverts to Note on reload. Type-based timeline, icons, and any call/meeting analytics are meaningless.
- **Technical impact:** Interaction-type taxonomy is decorative; follow-up matching is by exact summary text (sheets.functions.ts:284), fragile and order-dependent.
- **Recommended solution:** Add a Type column to the Notes tab and persist/read it; key follow-ups by a stable id rather than note text.
- **Complexity:** Low · **Business value:** Medium

#### 33. AI outputs are generated then discarded everywhere (no durable, comparable intelligence)
- **Problem:** Broadcast scores/LinkedIn post (BroadcastDialog.tsx:31-103), Query DNA scores/drafts (query.tsx artifacts), company intro insights and competitor suggestions (PortfolioDetail.tsx:87-106), and daily briefing (index.tsx:468-508, despite a Daily Briefing tab existing) are rendered once and thrown away. Connection plans persist only on manual Save.
- **Root cause:** AI features render to component state with no persistence layer or 'pin/save to record' affordance; most calls also bypass the audit/cost layer.
- **User impact:** Partners can't pin an insight to a company, compare a DNA score over time, or reuse a draft; identical expensive inferences are re-run and re-billed on every panel open.
- **Technical impact:** Redundant Gemini/Sumble spend, non-reproducible outputs, no feedback loop to improve suggestions, untracked cost.
- **Recommended solution:** Add a 'save to record' path for each AI artifact (Scores/Insights tabs keyed by stable id), cache narratives by input hash, and auto-persist the daily briefing to the existing tab.
- **Complexity:** Medium · **Business value:** High

#### 34. No relationship graph or warm-intro pathfinding — the core VC capability is absent
- **Problem:** There is no edges layer; all relations are fragile string/domain matches (targetKeyOf, normCompany, domain match in portfolio.tsx:174-190). The Connection Strategist Gem gives generic advice with no graph traversal (insights.functions.ts:241).
- **Root cause:** No stable entity IDs (urid column mapped at CONTACT_COLS:823 but never written) and no person↔person/person↔company edge model.
- **User impact:** A partner cannot answer 'who can introduce me to X' — the #1 daily VC action — and cannot see mutual connections or a network map.
- **Technical impact:** Pathfinding, deduplication, and entity-centric analytics are unbuildable on free-text keys; the graph fractures on name variants.
- **Recommended solution:** Introduce a surrogate id column for Contacts/Targets/Companies, populate and join on it, and add an explicit edges store; then implement BFS-based warm-intro pathfinding over the network.
- **Complexity:** High · **Business value:** High

#### 35. No portfolio health view — the headline VC-CRM dashboard is missing
- **Problem:** Portfolio records are skeletal (employees/events/introductions/contact fields hardcoded empty, sheets.server.ts:1803-1811) and there is no health/financial roll-up. The only score is 'momentum', explicitly not health (company-intel.ts:10-12). DTC Investment/Ownership/Stage are display-only Asana strings with no aggregation.
- **Root cause:** Portfolio data model never sources relational/financial fields; no portfolio-level aggregation surface was built.
- **User impact:** A partner cannot see at a glance which portfolio companies are at risk, need a board touch, or are running low — a primary daily/weekly job is unsupported.
- **Technical impact:** No alerting on negative signals (Crisis/Regulatory drags momentum silently); no fund-level roll-up.
- **Recommended solution:** Add a portfolio health dashboard (runway, last round, ownership, board cadence, at-risk flags, negative-signal alerts) and populate the relational fields from Asana/Sheets with stable keys.
- **Complexity:** High · **Business value:** High

#### 36. React Query is installed but unused; data layer is loaders + ad-hoc useState with no cache invalidation
- **Problem:** All server data flows through TanStack route loaders into per-component useState; the only 'refresh' is router.invalidate() which re-runs loaders and re-fetches entire Sheets tabs. React Query (in package.json) has zero source usages.
- **Root cause:** No deliberate client-state architecture was chosen; loader+useState was extended ad hoc as features grew.
- **User impact:** Stale views after writes, lost selections, no background revalidation, full reloads to see changes.
- **Technical impact:** No normalized cache, no entity-keyed invalidation, no optimistic-update framework; cross-page consistency is impossible to reason about.
- **Recommended solution:** Adopt React Query (or RTK Query) as the single client cache keyed by entity id; back loaders with it; invalidate by query key on mutation; remove the per-component data copies.
- **Complexity:** High · **Business value:** High

#### 37. Query-agent and single-field writes never invalidate dependent loaders (cross-page staleness)
- **Problem:** After the LLM agent commits a contact/event (client-side in query.tsx:689-763) it never calls router.invalidate(); single-field edits/notes/events also skip invalidation.
- **Root cause:** Invalidation was bolted on only to a few flows (bulk import, recalc); there is no central post-mutation invalidation contract.
- **User impact:** User adds a contact in chat, opens CRM, and it's missing until a hard reload; edits silently fail to appear elsewhere.
- **Technical impact:** Client and server diverge; agent writes are committed client-side so server audit 'complete' can disagree with actual persistence.
- **Recommended solution:** Move writes server-side, return affected entity keys, and invalidate those keys centrally after every mutation.
- **Complexity:** Medium · **Business value:** High

#### 38. ContactList.localContacts is initialized once and never resynced to props
- **Problem:** ContactList copies the contacts prop into useState once (ContactList.tsx:24) with no useEffect to reset it when the prop changes after router.invalidate().
- **Root cause:** Classic derived-state-in-useState anti-pattern.
- **User impact:** After any sibling refresh (recalc, bulk import), the contact list shows stale data until a full page reload.
- **Technical impact:** Local optimistic copy permanently shadows fresh loader data.
- **Recommended solution:** Drive the list directly from cache/props (React Query) or add a key/effect that resyncs on prop change; eliminate the local copy.
- **Complexity:** Low · **Business value:** Medium

#### 39. Optimistic updates have no rollback; multi-step server writes are non-atomic and racy
- **Problem:** Edits mutate local state before awaiting the server and only toast on failure (ContactDetail.tsx:539-542). Server upserts are read-modify-write against a shared sheet with no locking (llm-log.server.ts:74-91, setRatingOverride, cache upserts); multi-step writes (cells+history+overrides) are non-atomic.
- **Root cause:** No transaction support in Sheets and no client rollback strategy.
- **User impact:** UI/sheet disagree on write failure; concurrent users clobber each other's rows or duplicate rows.
- **Technical impact:** Inconsistent state after partial failure; the 5-min cache can hide just-appended rows, forcing duplicate appends.
- **Recommended solution:** Move to a transactional DB; implement optimistic-update-with-rollback in the client cache; add idempotency keys to upserts.
- **Complexity:** High · **Business value:** High

#### 40. Nine non-memoized React Contexts re-render the 1349-line sidebar on every keystroke
- **Problem:** Eight providers nest in __root.tsx:100-129; none memoize their value object (filter-context.tsx:33, selection-context.tsx:63). SidebarWithFilters consumes four filter contexts and renders AppSidebar (1349 lines). selectedContacts is an O(n) filter outside useMemo (selection-context.tsx:52).
- **Root cause:** Provider-per-concern boilerplate with no value memoization or store abstraction.
- **User impact:** Perceptible input lag/jank that worsens as the dataset grows.
- **Technical impact:** Every filter change cascades re-renders through the sidebar and all consumers regardless of data changes.
- **Recommended solution:** Memoize context values, split selectors, or replace the contexts with a lightweight store (Zustand/Jotai); decompose AppSidebar.
- **Complexity:** Medium · **Business value:** Medium

#### 41. Every read is a full-tab Sheets fetch; buildContacts does 6 tab fetches per load and rescans all edit history
- **Problem:** fetchSheetTab GETs whole tabs with no range/filter (sheets.server.ts:83-106); buildContacts fetches 6 tabs (943-952); buildFieldProvenance scans every historical edit on every call (920-941).
- **Root cause:** No query layer/indexes; Sheets values API has no pushdown.
- **User impact:** Slow cold loads; latency grows with total history, not active records.
- **Technical impact:** MB-scale payloads, O(rows) parse per request, Sheets quota pressure.
- **Recommended solution:** Move to an indexed DB with range/filter queries; until then, batchGet + server-side rollups and a shared cache for derived data (provenance maps).
- **Complexity:** High · **Business value:** High

#### 42. Targeted writes are O(n) linear scans plus schema-bootstrap round-trips
- **Problem:** Each single-cell edit fetches the whole tab and scans for the row (mergeContactFields:1266, updateTargetFields:1663, setContactRating:1172); adds call ensureColumn/ensureTab first (sheets.functions.ts:150,179-180,205).
- **Root cause:** No row index; defensive runtime schema bootstrapping on the hot path.
- **User impact:** Slow edits; add latency doubled by 2-3 sequential round-trips.
- **Technical impact:** Cost per micro-edit scales with tab size; recalculateRatings rebuilds the world (buildContacts + re-fetch Contacts, sheets.server.ts:1094).
- **Recommended solution:** DB with primary-key lookups; cache a row-number index; do schema migrations offline, not per write.
- **Complexity:** Medium · **Business value:** Medium

#### 43. Serial N+1 and per-row API loops in import, enrichment, Gmail, event tagging, and Sumble
- **Problem:** Bulk import does up to 5 serial REST calls per row (BulkUploadDialog.tsx:322-374); Gmail is list+per-id serial GETs (gmail.server.ts:180-183); event tagging is one write per attendee (events.tsx:1789); Apollo enrich loops serially; Sumble matchOrganization fires 2-3x per Load+Verify via uncached fetch.
- **Root cause:** No batching, concurrency limiting, or batch-append; inline request execution.
- **User impact:** Minutes-long imports with no progress/cancel; slow panels; wasted API credits.
- **Technical impact:** Provider rate-limit/timeout risk; partial failures with only console errors.
- **Recommended solution:** Batch writes (Sheets batch append), bounded concurrency, dedup cached calls, and move long runs to a background queue with progress.
- **Complexity:** Medium · **Business value:** High

## Medium Impact (quality, performance, hygiene)

| # | Issue | Problem | Recommended solution | Cplx | Value |
|---|---|---|---|---|---|
| 1 | Interaction type is never persisted (collapses to 'note' on reload) | addNote stores only content+followup; buildContacts reads every interaction back as type:'note' (hardcoded). Call/meeting/email types chosen in the UI reset to Note on every reload. | Add a Type column to the Notes tab, write it from addNote, and read it in buildContacts. | Low | Medium |
| 2 | Tech-stack intel is isolated, re-billed, and never reused or fed to discovery | buildPortcoTechStack returns to component state with no persistence; the same company's stack is computed independently in PortfolioDetail and ContactDetail, and PortfolioDetail re-matches+re-fetches jobs already in state — up to 3 billable Sumble match calls per Load+Verify. credits_used is parsed but discarded. Customer Discovery profiles comparable tech via Gemini instead of using the verified stack the app can fetch. | Cache detected/verified tech to a sheet tab keyed by domain, reuse across views, feed it into Customer Discovery profiling, and log credits_used to a spend ledger. | Medium | Medium |
| 3 | Duplicate/overlapping company->people APIs with divergent dedup and destinations | findCompanyDecisionMakers, fetchProspectPeople, and findAccountPeople reimplement company->people with different filter/fallback logic, different dedup (email-only vs email|LinkedIn|name+company), and different destinations (Targets vs Contacts). | Consolidate into one findPeopleAtCompany service with one multi-key dedup policy writing to Targets with reasonSurfaced. | Medium | Medium |
| 4 | Company entities fracture across pages with no canonical resolution | Companies are keyed by trim+lowercase free-text name everywhere (company-intel, portfolio merge, signal matching) with no alias table or id. 'Acme'/'Acme, Inc.'/'acme.ai' become distinct entities; portfolio uses substring signal matching while company-intel uses exact match, so the same portco shows different signals in the panel vs the brief. Asana-only synthesis creates phantom duplicate companies. | Introduce a company id + alias table; share one enrichment/join helper between portfolio.tsx and companies.tsx; use one canonical company->signal matcher. | High | Medium |
| 5 | Two parallel signal stores: Python radar output is invisible to the app | The radar worker writes structured EDGAR/ATS/GitHub signals to a 'Radar Signals' tab; /signals reads a different 'Signals' tab produced by the Gemini scan. Different schemas, taxonomies, score scales, and LLM providers (Anthropic vs Gemini). No FastAPI route, scheduler, or UI read path exists for the radar output. | Either retire the radar or add a scheduled trigger + a read path that merges 'Radar Signals' into /signals with a taxonomy/score mapping; align the LLM provider to Gemini. | High | Medium |
| 6 | Signal grounded scores and 'Why now' are recomputed client-side and never persisted | makeScorer runs in buildFeed on every render using Date.now() for freshness; opportunity/network/competitive/confidence scores and Why-now text are never stored. The same persisted signal shows a different score on every visit, and Home (sort by ts+relevance) disagrees with /signals (sort by opportunity) about the top signal. | Persist component scores (or their inputs and a snapshot timestamp) alongside the signal; compute server-side once at scan time and re-validate on a schedule rather than per-render. | Medium | Medium |
| 7 | reasonSurfaced is frozen text with no link back to the originating signal/entity | Surfaced leads carry a one-shot free-text reason ('Uses Splunk') with no reference to the signal/company/tech entity that surfaced them; outreach trails never migrate into Contacts on promotion (and promotion creates no contact anyway). | Store a reference (signal id / company id / tech) on surfaced targets; implement real promote-to-CRM that creates/links a Contact and migrates the outreach trail. | Medium | Medium |
| 8 | Phone dropped from Targets; column-count mismatch in target schema | TARGET_HEADERS (sheets.server.ts:869-884) has no Phone column but TARGET_COLS maps a 'phone' header; the importer comment admits 'phone has no target column' and only logs it to an audit tab (prospects.functions.ts:452-454). | Add a Phone column to TARGET_HEADERS and the header-aware writer, or remove phone from TARGET_COLS. Validate header/mapping parity in CI. | Low | Medium |
| 9 | Interaction type and 'email sent' events are unreliable | addNote stores no type; reader hardcodes type:'note' (:990). resolveFollowUp matches notes by exact text (:284). 'Email sent' is logged on intent (openInMail before send, EmailDraftDialog.tsx:178; mailto click ContactDetail.tsx:883-901). | Persist interaction type; key follow-ups by interaction id; only log email activity on confirmed send. | Low | Medium |
| 10 | Parallel Python backend + one-off scripts are an uncoordinated second writer | backend/app/sheets.py reimplements the TS logic and several scripts (cleanup_duplicates.py, fix_carmen.py, reorder_contacts.py, provision_sheet.py) write to the SAME live spreadsheet with destructive ops and divergent column-order assumptions, reaching into private internals (sheets._get_access_token). | Delete the parallel FastAPI backend and ad-hoc scripts; replace hygiene with constraints + an ETL job after migrating to Postgres. | Low | Medium |
| 11 | Missing timestamps and unauthenticated who-edited audit | No created_at/updated_at on records; field provenance timestamps only the few merged fields; the LLM/audit actor defaults to 'tester' (llm.functions.ts:138, query.tsx:772) and auth is client-only. | Add created_at/updated_at to all records and an audit_log(before/after/actor/at); enforce server-side identity so the actor is trustworthy. | Medium | Medium |
| 12 | Signal scores and most AI outputs are never persisted (non-reproducible) | Signal grounded scores are recomputed client-side every render (signal-feed.ts:418) and never stored; agent DNA scores, drafted emails, insights, and broadcast rankings are ephemeral; daily briefing isn't written despite a Daily Briefing tab existing. | Persist computed scores + inputs alongside the signal; write AI artifacts back to the relevant entity record with a confidence and timestamp; cache briefings in the existing tab. | Medium | Medium |
| 13 | No confidence scores on any AI output | DNA scores, connection strategies, insights, and broadcast rankings carry no confidence value; the schema has no confidence field anywhere. | Add a confidence field to every AI artifact (model self-rated or derived from grounding coverage) and persist it; expose it in the UI and use it in sort/threshold. | Low | Medium |
| 14 | Redundant/duplicate Sumble calls and no tech-stack persistence | A single Load+Verify performs the org match 2-3 times via uncached sumbleFetch, and detected tech stacks are never persisted, so every panel open re-bills ~5cr/tech (and ~50cr briefs cannot be regenerated once present). | Persist tech stacks to a domain-keyed tab and reuse across Contact/PortCo; route match through the cache; pass already-loaded intel.jobs into TechStackSection; add a credit ledger and a brief-refresh path. | Medium | Medium |
| 15 | Signals lack citations and have drifting, non-persisted scores | In Google-Search grounding mode all model-written URLs are blanked (allow-list is empty), so persisted signals have no citation; grounded strength scores are recomputed client-side every render using Date.now(), so they drift and Home/Signals disagree on the top opportunity. | Persist the computed scores and inputs alongside each signal; in search mode capture and validate the grounding URLs returned by Vertex instead of blanking them; compute freshness from a stored timestamp. | Medium | Medium |
| 16 | Customer Discovery ignores the company's own technographics and has no cache TTL | Discovery profiles comparable technologies via Gemini guessing while the company's real Sumble tech stack (already fetchable) is unused; the resulting DiscoveryResult is cached as an opaque JSON blob in one cell with no TTL or invalidation on source change. | Seed the Discovery profile with the company's real Sumble tech stack; add a TTL and invalidate on portfolio-field change; store decision-makers relationally and cross-reference existing warm coverage. | Medium | Medium |
| 17 | Email drafts log activity on intent (not send) and are never persisted | 'Open in Outlook' / mailto click fires onSent before the user sends, logging 'Email sent' and an Email Activity row; the generated draft itself is never stored. | Log activity only on confirmed send (or a 'mark as sent' action); persist drafts to a tab linked to the contact for reuse/audit. | Low | Medium |
| 18 | Daily briefing is regenerated and discarded despite a Daily Briefing tab existing | generateHomeSummary computes an LLM briefing into component state on every click and never reads/writes the Daily Briefing tab (readTodayBriefing exists but is unused by Home). | Persist the briefing to the Daily Briefing tab keyed by date; reuse today's briefing if present; route through the audited gateway. | Low | Medium |
| 19 | No streaming, no per-call timeout, and a blocking 429 backoff in the request path | All LLM calls are blocking generateContent; the 429 retry sleeps synchronously inside the request up to 60s; there is no per-call timeout. | Add streaming for agent/scan responses, per-call timeouts, and an async job queue for long scans; move 429 handling to a queue rather than in-request sleep. | High | Medium |
| 20 | Apollo enrichment disabled for the whole batch on a single transient error | In the activity-sourcing loop, any thrown error (rate limit, transient network) sets apolloOff=true, disabling enrichment for all remaining people in the batch. | Distinguish accessDenied (permanent) from transient errors (retry with backoff); parallelize with a rate limiter; add a review queue before sourced contacts hit the sheet. | Low | Medium |
| 21 | 'Email sent' interaction logged on intent (opening Outlook), not on actual send | openInMail fires onSent (logs 'Email sent' + Email Activity row) before composing (EmailDraftDialog.tsx:178); the mailto click also logs immediately (ContactDetail.tsx:883-901). | Log on an explicit 'Mark as sent' confirmation, or detect/return from the compose flow before logging. At minimum, label it 'Drafted' vs 'Sent'. | Low | Medium |
| 22 | Customer Discovery and Sumble intel are stale-forever and ignore data the app already holds | Discovery cache is keyed by company name with no TTL and no invalidation on source change (discovery.functions.ts:58-67); the Sumble brief can never be regenerated once present (PortfolioDetail.tsx:825). Discovery profiles the seller from name/sector/description only, ignoring the company's own Sumble tech stack and existing CRM relationships. | Add TTL + source-change invalidation, key caches by org id/domain, allow brief refresh, feed the company's own tech stack into the discovery profile, and cross-reference decision-makers against Contacts/Targets. | Medium | Medium |
| 23 | Broadcast does not broadcast; no mass-send or send tracking anywhere | 'Broadcast' either scores up to 120 contacts (hard cap, broadcast.functions.ts:29) or drafts one LinkedIn post, both ephemeral; email drafting has no send path, only an Outlook/mailto deep link. No campaign send or tracking exists. | Persist scored signal→contact relevance, add batched send (or at least a tracked send-list with logging back to contact timelines), and remove the misleading 'Broadcast' framing or build real campaign send. | High | Medium |
| 24 | Import has no progress/cancel/resume and is fully sequential (2N+ serial calls) | Bulk import loops per row awaiting enrich+addContact+addEvent+addPortcoIntro+addNote (BulkUploadDialog.tsx:322-374); a 200-row import is ~1000 serial REST calls with no progress bar, cancel, resume, or batching, and each addContact re-reads the header. | Batch appends, add bounded concurrency for Apollo with rate-limit/backoff, surface a progress bar with cancel/resume, and unify the email-parsing regex. | Medium | Medium |
| 25 | Query agent chat is not persistent or resumable; AI answers never enrich the CRM | Chat turns/sessionId/pending approval are component useState (query.tsx:88-101), wiped on refresh even though every turn is logged server-side. After an approved write the app never calls router.invalidate, and AI answers/scores/drafts are never written to any record. | Persist sessions (rehydrate from LLM_Query_Log by session_id), invalidate the router after approved writes, and offer 'attach this answer/score to the contact/target'. | Medium | Medium |
| 26 | No meeting-prep view and no signal→contact join for daily prioritization | There is no 'prep for my next meeting' surface; the attention queue ignores signals entirely (index.tsx:73-121 uses only last-touch/temperature/intros), and signals aren't joined to contacts, so a fresh high-opportunity signal never bumps anyone into 'needs attention'. | Build a per-contact prep view aggregating timeline + open signals + warm-intro paths, and feed recent high-opportunity signals into the attention queue. | Medium | High |
| 27 | No list virtualization/pagination — UI degrades and triggers hundreds of logo fetches at a few thousand records | ContactList/ContactTable render the full filtered set with per-card external logo <img> fetches; targeting.tsx renders all targets without windowing; company directory rebuilt from scratch each render. | Add list virtualization (e.g. react-virtual), lazy/cached logo loading, and server-side pagination/query pushdown to replace full-tab reads. | Medium | Medium |
| 28 | Two parallel filter systems (URL chart cross-filters vs non-URL Contexts) that don't compose | Chart cross-filters live in ?cf= (use-chart-drill.ts:71-141) while sidebar filters live in React Contexts; they are ANDed but the sidebar state is invisible in drill chips and not shareable/persistent (dashboard.tsx:128-137). | Adopt the URL-backed model (already correct for charts) for all filters; render a unified active-filter summary. | Medium | Medium |
| 29 | Filter dropdown options are populated as a route side-effect; empty until visited; last-writer-wins | Each route's useEffect pushes distinct values via updateOptions (crm.tsx:144, portfolio.tsx:170); shared keys (allCities, portfolioCompanies) are overwritten by whichever page ran last. | Derive options from the shared cache or compute server-side; populate eagerly and merge instead of overwrite. | Low | Medium |
| 30 | Signals loader awaits six server fns sequentially (TTFB = sum of all) | signals.tsx:63-70 uses serial awaits for fetchSignals/LinkedIn/Drive/Gmail/portfolio/contacts instead of Promise.all. | Promise.all the independent fetches; defer non-critical connectors behind Suspense. | Low | Medium |
| 31 | No list virtualization or pagination; whole dataset rendered and processed client-side | ContactList/ContactTable render all rows (ContactList.tsx:159), targeting and signals render all cards; filtering/charting/selection/export are O(n) over the full in-memory array; each avatar fires an external logo image. | Virtualize lists/tables (e.g. TanStack Virtual), paginate server-side, and lazy-load logos. | Medium | Medium |
| 32 | AI relevance/insight outputs recomputed per render or re-billed per open; never cached | Signal strength scores recompute client-side every render with Date.now() freshness (signal-feed.ts:418, signal-strength.ts:145); scoreNetworkTargets re-ranks 120 contacts per Broadcast open (broadcast.functions.ts); connectionStrategy reloads all contacts+portfolio per click (insights.functions.ts:261); home briefing ignores its existing cache tab. | Persist scores/insights with inputs hash + TTL; compute server-side; serve from cache; use the existing Daily Briefing tab. | Medium | Medium |
| 33 | Agent serializes full Gemini history (incl. base64 attachments) client<->server every pause/resume | runAgent pushes verbatim model parts into state.messages (llm.server.ts:771) and the entire AgentState round-trips to the client and back (llm.functions.ts:181); chat is component useState, lost on refresh. | Server-side session store keyed by sessionId; send only deltas; rehydrate from the audit log on reload. | Medium | Medium |
| 34 | 1500-2000 line route/components re-render wholesale and ship as large bundles | targeting.tsx (~1994), events.tsx (~1992), companies.tsx (~1218), ContactDetail.tsx (~1577), app-sidebar.tsx (~1349) are single components mixing route, sub-components, dialogs, and helpers; client-side activity matching runs in render bodies without useMemo. | Split into subcomponents, memoize expensive derivations, lazy-load dialogs, and code-split routes. | Medium | Medium |
| 35 | Only caching is a per-instance 5-min Map; useless on serverless/multi-instance and a stale-read hazard | Module-level Map cache invalidated only on the same instance (sheets.server.ts:28-37,131); Sumble/Asana caches share the defect; serverless cold starts blow it away. | Move to a shared cache (Redis) with explicit invalidation keys; treat per-instance cache as best-effort only. | Medium | Medium |

## Nice to Have (long-term enhancements)

| # | Issue | Problem | Recommended solution | Cplx | Value |
|---|---|---|---|---|---|
| 1 | Stub buttons imply working integrations that don't exist | Portfolio Edit, 'Web Sync', 'Get more from LinkedIn', and 'Sync with Asana' are no-ops or 2-second fake spinners; the Targeting 'Research (Apollo)' bulk button and the sidebar 'Update with Apollo' bulk button have no onClick. | Either implement the handlers (bulk Apollo enrichment, portfolio field sync) or remove/disable the controls with a clear 'coming soon' state. | Low | Low |
| 2 | No feedback loop on AI suggestions; insight narratives and connection plans can't be pinned or improved | Dismissed signals, accepted/rejected leads, and edited AI drafts are never captured; insight narratives (intro commonalities, competitors) are throwaway and can't be saved to a record. | Capture accept/reject/dismiss events and let users pin insights to companies/contacts; use captured signals to down-rank repeats. | Medium | Medium |

## Suggested sequencing

**Phase 0 — Stop the bleeding (days):** convert positional writes (`addTarget`, prospect importer) to the header-aware pattern already in `addContactRow`; persist the Targeting pipeline (stage/add/promote); fix or remove every no-op button and local-only "save"; turn the silent sample-data fallback into a visible error; gate server functions with real auth.

**Phase 1 — Wire what already exists (1–3 wks):** write the dormant `urid` surrogate key on every add and re-key all joins to it; activate the non-destructive `source:"apollo"` merge for background enrichment; call `logEmailActivity` from the already-computed inbound-Gmail attribution; persist deterministic signal scores; route all Gemini calls through the audited LLM gateway.

**Phase 2 — Connect the intelligence (3–6 wks):** build a normalized facts/activity tab that Asana, Gmail, signal-actions, and manual interactions all write into idempotently, and have `scoreContact`, the timeline, and analytics read from it; persist AI artifacts to the records they concern; unify the company-finder service + dedup; introduce a canonical company entity + alias table.

**Phase 3 — Re-platform for scale (quarters):** migrate to Postgres (UUID PKs, FKs, indexes, RLS multi-tenancy); add a job queue for scans/enrichment/imports, a shared cache (Redis) + React Query, and a vector store (pgvector) for retrieval; demote Sheets to an import/export adapter and delete the parallel Python backends.

