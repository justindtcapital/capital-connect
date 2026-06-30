# Deliverables

Two artifacts written to `/mnt/documents/` — no app code changes.

## 1. `VenturePulse_DataMap.pdf` (printable, US Letter)

A clean one-pager (likely 2 pages) covering the same content from the previous summary, formatted for print:

- **Header**: VenturePulse — Data & Integration Map, Dell Blue accent bar
- **Section 1 — External systems** (table): Google Sheets, Asana, Apollo, Lovable AI Gateway — role, auth, direction
- **Section 2 — Sheets/tabs** (table): Contacts, Events (attendance), Targets, Portfolio — owns / app writes?
- **Section 3 — Asana projects** (table): Events project, Portfolio project — fields surfaced, where consumed
- **Section 4 — Per-page data flow**: /crm, /events, /portfolio, /targeting, /dashboard — reads / writes / cross-refs
- **Section 5 — Source-of-truth matrix** (table): each data domain → SoR → app role (record / updates / reporting)
- **Section 6 — Seams & caveats**: event-name string linkage, name-based portco match, domain-based contact↔portco match, 5-min cache, no Asana write-back, one-shot Apollo

Built with `reportlab` (Platypus), Inter-substitute (Helvetica), Dell Blue (#0076CE) headings, light-grey table shading. Visual QA: render to JPG with `pdftoppm`, inspect every page for clipping/overflow, fix and re-render until clean.

## 2. `VenturePulse_Architecture.mmd` (Mermaid diagram)

A `flowchart LR` showing:

- **Sources** (left): Asana Events project, Asana Portfolio project, Apollo API
- **App** (middle): server functions (`asana.server`, `sheets.server`, `apollo.server`) → routes (`/crm`, `/events`, `/portfolio`, `/targeting`, `/dashboard`)
- **Store** (right): Google Sheets tabs (Contacts, Events, Targets, Portfolio)
- **Edge labels** indicate direction: read-only (dashed), read/write (solid), on-demand enrichment (dotted)
- Legend node clarifying line styles

Delivered as `text/vnd.mermaid` artifact so it renders inline and stays editable.

## Notes

- No code changes, no new routes, no dependencies added.
- Both files versioned (`_v1`) so future revisions can iterate cleanly.
- After approval I'll generate, QA the PDF visually, and post both artifacts.
