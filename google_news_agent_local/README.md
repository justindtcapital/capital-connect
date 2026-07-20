# PortCo News Bot — Google Apps Script

Pulls news from GDELT (free, no key), summarizes and sector-classifies each
article with Gemini on Vertex AI, and writes rows into the repository tabs from
the architecture diagram.

## What's built

The diagram shows eight boxes, but "PortCo Blogs" appears twice with identical
fields, so there are **seven distinct repositories**. Every one shares the same
schema — `[Entity] / Date / Sector / Source / URL / Summary` — where the entity
column is `PortCo`, `Company`, or absent.

| Tab | Entity column | Source |
|---|---|---|
| PortCo News | PortCo | ✅ GDELT |
| Industry News | — | ✅ GDELT |
| Major Company News | Company | ✅ GDELT |
| DTC Network Companies News | Company | ✅ GDELT |
| PortCo Blogs | PortCo | ⬜ not wired |
| Industry Reports | — | ⬜ not wired |
| PortCo LinkedIn Socials | Company | ⬜ not wired |

The three unwired tabs are created and formatted but stay empty. Each carries a
`note` in `Config.gs` explaining what it would actually need: RSS feeds for
blogs, a `filetype:pdf` web search for reports, and official API access for
LinkedIn (which can't be scraped without breaking their ToS).

## Setup

1. Create a Google Sheet. **Extensions → Apps Script**.
2. Copy each `.gs` file into the editor as a file of the same name. To use
   `clasp` instead: `clasp create --type sheets` then `clasp push`.
3. **Add your Vertex key.** Apps Script has no `.env` and no filesystem — the
   equivalent is Script Properties. Go to **Project Settings → Script
   Properties → Add property**, name it `VERTEX_SA_KEY`, and paste the *entire*
   service account JSON file as the value. Paste it verbatim; don't reformat it
   or strip the `\n` escapes out of `private_key`.
4. Set `VERTEX_PROJECT_ID` in `Config.gs` (the project **ID**, e.g.
   `my-project-123456` — not the number, not the display name). Check
   `VERTEX_LOCATION` serves your model.
5. Replace the placeholder entity lists in `Config.gs` (`PORTCOS`,
   `MAJOR_COMPANIES`, `DTC_NETWORK_COMPANIES`, `INDUSTRY_TOPICS`) and adjust
   `SECTORS` to your taxonomy.
6. Reload the Sheet. A **News Bot** menu appears.
7. **News Bot → Check Vertex auth.** Validates the key, signs a JWT, and
   exchanges it for a token without spending model quota. Do this before
   anything else — it fails loudly and specifically.
8. **News Bot → Set up tabs only**, and confirm the workbook looks right.
9. **News Bot → Run all repositories**. Authorize when prompted.
10. **News Bot → Install daily trigger (6am)** once you're happy with output.

The service account needs the **Vertex AI User** role, and the **Vertex AI API**
must be enabled on the project.

Prefer an API key over a service account? Set `GEMINI_BACKEND: 'ai_studio'` and
put a key from aistudio.google.com in the `GEMINI_API_KEY` Script Property. No
GCP project needed — easier for testing.

## How a run works

```
build queries → GDELT → drop URLs already in the tab → scrape article text
    → Gemini (relevance + summary + sector) → drop irrelevant → append rows
```

Dedupe happens **before** Gemini, so re-running costs nothing for stories you
already have. Rows append below existing data, newest-first within each run.

## Why GDELT and not Google News

Google News RSS is free and has better relevance, and it was tried first. It
can't work here. Its links are opaque `news.google.com/rss/articles/CBMi...`
redirectors, and all three ways out are closed:

- **Following the redirect** lands back on `news.google.com` — 594KB of
  JavaScript containing 11 characters of visible text.
- **Decoding the token** fails. Google moved to an opaque `AU_yqL...` format
  with no URL inside (0 of 6 decoded when tested). The `CBMi<base64-url>` trick
  older tutorials describe is dead.
- **Google's own `batchexecute` resolver** returns error `[3]` with a null
  payload.

No publisher URL means no article body, which means every summary silently
collapses to a headline rephrase — while still *looking* like it worked. GDELT
returns real publisher URLs (verified live: 4/4 article bodies readable), which
is the whole ballgame.

SerpAPI is the third option: Google News relevance *and* real URLs, but ~$75/mo
at a daily cadence.

## Things worth knowing

**GDELT is noisy, and Gemini is the filter.** GDELT full-text matches, so a
query for `Nike` genuinely returns stories about a Kudankulam nuclear plant and
a stolen Deliveroo bag (both observed live). Since Gemini reads each article
body anyway, it judges relevance in the same call and `Main.gs` drops the
misses.

The filter **fails open**: a failed Gemini call keeps the row. A missed filter
is fixable by eye; a silently deleted article isn't. Set `DROP_IRRELEVANT:
false` while tuning to see everything.

**Write the `about` line for every entity.** It's the highest-leverage thing in
`Config.gs` and it costs nothing:

```js
{ name: 'Away', about: 'DTC luggage and travel goods brand, New York' }
```

Gemini has no prior knowledge of a private Series B company, so "is this about
Away?" is unanswerable without context — and for a common-word name it's a coin
flip. One line makes it easy. Unlike a narrower query, `about` **cannot hide a
real article**: it sharpens judgment without restricting retrieval. Plain
strings still work for names the model already knows (`'Nike'`).

**Don't bother tuning queries for precision.** Tested against live GDELT, and
none of the intuitive levers work:

| Attempt | Result |
|---|---|
| `"Warby Parker" (eyewear OR glasses)` | same stock-spam and listicles as bare |
| `near20:"Warby eyewear"` | same stock-spam and listicles |
| `tone<-2` | 0 articles |

The noise isn't *wrong company* — it's *right company, worthless article*
(autogenerated stock filler, SEO listicles naming 20 brands). Those legitimately
contain the terms, so no query separates them. Only judgment does.

**Common-word names can't be retrieved at all.** `Away` returns WhatsApp
warnings and drone anniversaries; `Away (luggage OR suitcase)` returns car
reviews that mention luggage space. Narrowing just changes *which* noise. Gemini
correctly rejects it all, so your sheet stays clean — but you pay a call per
rejected article, every run. If that waste matters, the fix is a title
pre-filter (require the name in the headline before spending a call), not a
cleverer query.

**Syndication is deduped by title, not just URL.** Wire stories run on many
outlets under different URLs — one live run had the same story on 4 sites, and a
wire-heavy pull collapsed 14 articles to 10. Without this you pay a Gemini call
and write a row per copy.

The surviving copy is chosen deterministically (earliest seen, then domain
alphabetically), which is load-bearing: the diagram has no Title column, so
cross-run dedupe can only work through the URL check against existing rows —
and that holds only if every run elects the *same* copy. One caveat: GDELT's
`seendate` is when GDELT saw the article, not when it was published, so
"earliest" occasionally keeps an aggregator over the originating wire.

**Single-word entities must not be quoted.** GDELT rejects `"Nike"` with "The
specified phrase is too short" and returns nothing at all. `gdeltPhrase_` quotes
only multi-word names — `Nike` bare, `"Warby Parker"` quoted. A test locks this
down; it's a silent-starvation bug, not a loud one.

**GDELT rate-limits.** ~1 request per 5 seconds, and 5s still drew a 429 in
testing, so `GDELT_REQUEST_INTERVAL_MS` defaults to 6000 with retry/backoff on
top. Entity queries run **sequentially** — don't "optimize" them into
`fetchAll`. Budget ~6s per entity per run.

**Summaries still depend on scraping.** GDELT URLs are real, but paywalls,
consent walls, and JS-rendered pages still yield little. When a body can't be
retrieved, the prompt explicitly tells Gemini to work from the headline and not
invent detail. Check the log for the `unreadable` count.

**Sector is enforced by schema, not by prompt.** `SECTORS` is a response-schema
enum, so Gemini can't return a value outside your list. Keep `Other` as an
escape hatch or you'll force bad fits.

**Execution time limits.** 6 minutes on consumer accounts, 30 on Workspace.
Budget ~6s per entity (GDELT pacing) plus one Gemini call per new article. If a
full run times out, use the per-repository menu items or lower
`MAX_ARTICLES_PER_QUERY`.

**Thinking is off.** `GEMINI_THINKING_BUDGET: 0` — summarization doesn't need it
and it roughly doubles latency and cost. Set to `null` to re-enable, or if you
switch to a model that rejects the field.

## How to test

Five rungs, cheapest first. Each one can fail on its own terms, so climb in
order — don't debug a Gemini summary when the real problem is that GDELT never
heard of the company.

### 1. Logic — no keys, no network, instant

```
node tests/smoke.js
```

162 checks: GDELT query building and quoting, date parsing, HTML/entity
stripping, URL and syndication dedupe (including its order-independence),
failure-vs-empty handling, row/header alignment, Gemini payload shape, the
relevance rule and dossier injection, JWT assembly, and every auth and API
failure path.

Re-run after editing `Config.gs` — it verifies rows still line up with headers,
the sector enum still tracks your taxonomy, no repository emits a quoted
single-word query, and every PortCo still carries an `about` line.

### 2. Does GDELT find YOUR companies? — no keys, no deploy

```
node tests/preview.js            # all wired repositories
node tests/preview.js portco     # just PortCo News
```

**Run this the moment your real names are in `Config.gs`, before anything
else.** It runs the real fetch code against live GDELT and prints what comes
back per entity. No Gemini calls, nothing written.

You are looking for one thing: an entity where *nothing* returned is ever about
the company. That entity will never produce a row and will burn a Gemini call
per article forever — and no configuration fixes it. Some noise is normal and
expected; Gemini filters it.

It distinguishes "GDELT answered with nothing" (a verdict on the name) from
"GDELT never answered" (rate limiting, which says nothing about the name). If
you see the latter, wait a minute and re-run.

The same thing exists inside the Sheet as **News Bot → Preview: what GDELT
finds**, if you'd rather not run node.

### 3. Vertex auth — key required, no model spend

**News Bot → Check Vertex auth.** Parses the key, signs a JWT, exchanges it for
a real token, and warns if `VERTEX_PROJECT_ID` disagrees with the key's own
project. Every failure names its own fix. Costs nothing.

### 4. Dry run — real Gemini calls, still no writes

**News Bot → Dry run: PortCo News (no writes).** Runs the whole pipeline and
logs, per article: Gemini's KEEP/DROP verdict, the sector, how much article body
it actually got, and the summary.

This is the tool for tuning `about` lines:

- Real news showing **DROP** → that entity's `about` is wrong or too narrow.
- Junk showing **KEEP** → make `about` more specific.
- Body **UNREADABLE** on most articles → paywalls; those summaries are
  headline-only and thinner by necessity.

Set `MAX_ARTICLES_PER_QUERY: 3` while iterating so each pass is cheap.

### 5. For real

**News Bot → Set up tabs only**, confirm the workbook matches the diagram, then
**Run all repositories**. Check the execution log for the dropped-as-irrelevant
count and any `WARNING: n/m GDELT queries FAILED` line. Install the daily
trigger once you like what lands.
