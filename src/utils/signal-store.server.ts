// Signal persistence for the Google Sheet "Signals" tab — the single owner of
// the POSITIONAL row contract (SIGNAL_HEADERS order). Extracted from
// gemini.functions.ts so the Gmail digest pipeline can also archive signals
// without importing the scan module (which imports gmail.functions — cycle).

// NOTE: this module is retained in the CLIENT bundle (via gmail.functions), so
// it must never import the event pipeline (whose chain reaches node-only
// google-auth-library). Digest rows are stored unenriched here; the nightly
// signals-reconcile job (server-only) clusters any recent rows missing an
// Event ID.
import type { SignalRecommendation, SignalAwarenessItem } from "./gemini.server";
import type { GmailSignal } from "./gmail.functions";
import { newsSourceType } from "@/lib/signal-feed";
import { DEFAULT_SIGNAL_CONFIG } from "@/lib/signal-config";
import {
  awarenessRelevanceProxy,
  digestHeadline,
  passesAwarenessQualityGate,
} from "@/lib/signal-quality";
import { fetchSheetTab, appendSheetRows, updateSheetCells, colLetters, TAB_NAMES } from "./sheets.server";
import { articleUrlKey } from "./news.server";
import { isWeakResearchSnippet } from "@/lib/email-body-clean";
import {
  citedDriveIdsFromUrls,
  storyContentKey,
} from "@/lib/signal-dedup";

export interface StoredSignal {
  id: string;
  dateFound: string;
  type: "recommendation" | "awareness";
  status: string;
  person: string;
  company: string;
  email: string;
  category: string;
  signal: string;
  sourceUrl: string;
  subject: string;
  body: string;
  relevance: number;
  justification: string;
  urgency: string;
  timing: string;
  /** Source-type bucket (taxonomy) persisted at write time. */
  sourceType: string;
  /** Durable Drive doc/PDF link (archived copy), when the source is a Drive file. */
  docUrl: string;
  /** Whether the stored row has a non-empty Body (drives lazy-load on the feed). */
  hasBody: boolean;
  // ── Signals v2 event layer (additive columns; "" / null on legacy rows) ──
  /** Real-world event this row belongs to (Signal Events tab FK). */
  eventId?: string;
  /** Adjusted materiality 0–10 stamped by the event pipeline. */
  materiality?: number | null;
  /** Final rank score 0–100 (materiality^α × relevance^β × actionability^γ). */
  rankScore?: number | null;
  /** Semicolon-separated badge slugs (DETECTED_BEFORE_PRESS, CONFIRMED_BY_PRESS…). */
  badges?: string;
  /** JSON component breakdown — every stored score reconstructible from this. */
  scoreBreakdown?: string;
  /** Phase 1 — resolved Intel Entities URID (when known). */
  entityUrid?: string;
  /** Phase 1 — resolve ladder rung (domain | alias_exact | ambiguous | …). */
  resolveRung?: string;
  /** Phase 1 — 0–1 confidence from resolveEntity. */
  resolveConfidence?: number | null;
}

// Write-time size caps that keep the hot read path light. The Summary is the
// indexable/queryable field, so it stays short; the outreach Body is bounded and
// (via fetchStoredSignals lite mode) lazy-loaded on expand rather than pulled on
// every feed load. Both env-overridable.
const SIGNAL_SUMMARY_MAX = Number(process.env.SIGNALS_SUMMARY_MAX) || 500;
/** Card headline (`signal`) — keep scannable: ~2 short sentences. */
const SIGNAL_HEADLINE_MAX = Number(process.env.SIGNALS_HEADLINE_MAX) || 220;
const SIGNAL_BODY_MAX = Number(process.env.SIGNALS_BODY_MAX) || 4000;
function clampText(s: string, max: number): string {
  const t = s || "";
  return t.length > max ? t.slice(0, max).trimEnd() + "…" : t;
}

/** Keep card headlines to at most 1–2 sentences (and a hard char cap). */
function clampHeadline(s: string, maxSentences = 2, maxChars = SIGNAL_HEADLINE_MAX): string {
  const t = (s || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  const sentences = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [t];
  const kept = sentences
    .slice(0, maxSentences)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" ");
  return clampText(kept, maxChars);
}

// A Google Drive / Docs link is a durable "saved copy" we can preserve alongside
// the signal (vs. an external article URL that may rot). "" for anything else.
function driveDocUrl(url?: string): string {
  const u = (url || "").trim();
  return /^https?:\/\/(drive|docs)\.google\.com\//i.test(u) ? u : "";
}

// Stable identity for a signal so re-scans don't store the same item twice.
// Prefixed with "s" so the value is never a pure number — otherwise Google
// Sheets (USER_ENTERED) coerces an all-digit hash to scientific notation, which
// corrupts the ID on round-trip.
function signalId(type: string, who: string, what: string): string {
  const key = `${type}|${who.toLowerCase().trim()}|${what.toLowerCase().trim().slice(0, 200)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "s" + (h >>> 0).toString(16).padStart(8, "0");
}

// Recompute a signal's logical identity from its stored fields. Used for dedup so
// it stays stable even if the stored ID column was written in an older format or
// mangled by the sheet — we never trust the stored ID for dedup, only content.
export function keyForStored(s: StoredSignal): string {
  return s.type === "recommendation"
    ? signalId("recommendation", s.email || s.person || "", s.sourceUrl || s.signal || "")
    : signalId("awareness", s.person || s.company || "", s.sourceUrl || s.signal || "");
}

export function storedFromRec(
  r: SignalRecommendation,
  dateFound: string,
  portcoNames: Set<string>,
): StoredSignal {
  const who = r.email || r.person || "";
  const isPortco = portcoNames.has((r.company || "").trim().toLowerCase());
  return {
    id: signalId("recommendation", who, r.sourceUrl || r.signal || ""),
    dateFound,
    type: "recommendation",
    status: "New",
    person: r.person || "",
    company: r.company || "",
    email: r.email || "",
    category: r.category || "",
    signal: clampHeadline(r.signal || ""),
    sourceUrl: r.sourceUrl || "",
    subject: r.subject || "",
    body: clampText(r.body || "", SIGNAL_BODY_MAX),
    relevance: r.relevance ?? 0,
    justification: clampText(r.justification || "", SIGNAL_SUMMARY_MAX),
    urgency: String(r.urgency || ""),
    timing: r.timing || "",
    sourceType: newsSourceType(r.category, isPortco, r.sourceUrl),
    docUrl: (r.docUrl || "").trim() || driveDocUrl(r.sourceUrl),
    hasBody: Boolean((r.body || "").trim()),
  };
}

export function storedFromAwareness(
  a: SignalAwarenessItem,
  dateFound: string,
  portcoNames: Set<string>,
): StoredSignal {
  const who = a.person || a.company || "";
  const isPortco = portcoNames.has((a.company || "").trim().toLowerCase());
  return {
    id: signalId("awareness", who, a.sourceUrl || a.summary || ""),
    dateFound,
    type: "awareness",
    status: "New",
    person: a.person || "",
    company: a.company || "",
    email: "",
    category: a.category || "",
    signal: clampHeadline(a.summary || ""),
    sourceUrl: a.sourceUrl || "",
    subject: a.title || "",
    body: "",
    relevance: 0,
    justification: "",
    urgency: "",
    timing: "",
    sourceType: newsSourceType(a.category, isPortco, a.sourceUrl),
    docUrl: (a.docUrl || "").trim() || driveDocUrl(a.sourceUrl),
    hasBody: false,
  };
}

export function rowFromStored(s: StoredSignal): string[] {
  return [
    s.id,
    s.dateFound,
    s.type,
    s.status,
    s.person,
    s.company,
    s.email,
    s.category,
    s.signal,
    s.sourceUrl,
    s.subject,
    s.body,
    String(s.relevance),
    s.justification,
    s.urgency,
    s.timing,
    s.sourceType,
    s.docUrl,
    s.eventId || "",
    s.materiality == null ? "" : String(s.materiality),
    s.rankScore == null ? "" : String(s.rankScore),
    s.badges || "",
    (s.scoreBreakdown || "").slice(0, 4000),
    s.entityUrid || "",
    s.resolveRung || "",
    s.resolveConfidence == null ? "" : String(s.resolveConfidence),
  ];
}

// `withBody:false` (the default) elides the heavy Body column from the returned
// signals to keep the feed load light — the feed only needs it on card expand,
// which `fetchSignalBody` serves. `hasBody` still reflects whether a Body exists.
export async function fetchStoredSignals(
  opts: { withBody?: boolean } = {},
): Promise<StoredSignal[]> {
  const withBody = opts.withBody ?? false;
  let rows: string[][] = [];
  try {
    rows = await fetchSheetTab(TAB_NAMES.signals);
  } catch {
    return [];
  }
  if (rows.length === 0) return [];
  // The Signals tab is WRITTEN positionally in SIGNAL_HEADERS order, so we read
  // it positionally too. This is robust even when the header row is missing or
  // was edited — a header-NAME lookup silently returns nothing in that case,
  // which is exactly what made stored signals vanish on refresh. Skip a leading
  // header row if one is present.
  const isHeader = (r: string[]) =>
    (r[0] || "").trim().toLowerCase() === "id" && (r[2] || "").trim().toLowerCase() === "type";
  const data = rows.length && isHeader(rows[0]) ? rows.slice(1) : rows;
  const g = (row: string[], i: number) => (row[i] || "").trim();
  return (
    data
      .map((row) => ({
        id: g(row, 0),
        dateFound: g(row, 1),
        type: (g(row, 2).toLowerCase() as StoredSignal["type"]) || "awareness",
        status: g(row, 3) || "New",
        person: g(row, 4),
        company: g(row, 5),
        email: g(row, 6),
        category: g(row, 7),
        signal: g(row, 8),
        sourceUrl: g(row, 9),
        subject: g(row, 10),
        body: withBody ? g(row, 11) : "",
        relevance: Number(g(row, 12)) || 0,
        justification: g(row, 13),
        urgency: g(row, 14),
        timing: g(row, 15),
        sourceType: g(row, 16),
        docUrl: g(row, 17),
        hasBody: g(row, 11).length > 0,
        eventId: g(row, 18),
        materiality: g(row, 19) ? Number(g(row, 19)) : null,
        rankScore: g(row, 20) ? Number(g(row, 20)) : null,
        badges: g(row, 21),
        scoreBreakdown: g(row, 22),
        entityUrid: g(row, 23),
        resolveRung: g(row, 24),
        resolveConfidence: g(row, 25) ? Number(g(row, 25)) : null,
      }))
      // Keep only rows that are real signals (valid type + some content).
      .filter(
        (s) =>
          (s.type === "recommendation" || s.type === "awareness") &&
          (s.signal || s.company || s.person),
      )
  );
}

// ── Digest-link + NEWS@ research archiving ───────────────────────

function urlKey(u: string): string {
  return articleUrlKey(u);
}

// One exploded digest link → an awareness row. The article title rides in the
// (otherwise rec-only) Subject column so the feed can show it as the headline;
// Justification records which digest email surfaced it (Timing stays for urgency).
function storedFromDigestLink(
  s: GmailSignal,
  portcoNames: Set<string>,
  watchNames: Set<string>,
  networkCompanyNames: Set<string>,
): StoredSignal {
  const companyKey = (s.company || "").trim().toLowerCase();
  const isPortco = portcoNames.has(companyKey);
  const isWatch = watchNames.has(companyKey);
  const networkContactCount = networkCompanyNames.has(companyKey) ? 1 : 0;
  const cfg = DEFAULT_SIGNAL_CONFIG;
  const title = (s.subject || "").trim();
  const headline = digestHeadline(s.snippet || "", title || `${s.company} published an update`);
  const fallback = `${s.company} published “${title || "an update"}”.`;
  return {
    id: signalId("awareness", s.company || "", s.linkUrl || s.subject || ""),
    dateFound: s.dateLabel || new Date().toISOString().split("T")[0],
    type: "awareness",
    status: "New",
    person: "",
    company: s.company || "",
    email: "",
    category: "Thought Leadership",
    signal: clampHeadline(headline || fallback),
    sourceUrl: s.linkUrl || "",
    subject: clampText(title, 200),
    body: "",
    relevance: awarenessRelevanceProxy({ isPortco, isWatch, networkContactCount }, cfg),
    justification: s.digestSubject ? `Shared in “${s.digestSubject}”` : "",
    urgency: "",
    timing: "",
    sourceType: newsSourceType("Thought Leadership", isPortco, s.linkUrl),
    docUrl: "",
    hasBody: false,
  };
}

/** NEWS@ research entity (e.g. Siemens from a 451 subject list) → awareness row. */
function storedFromResearchDigest(
  s: GmailSignal,
  portcoNames: Set<string>,
  watchNames: Set<string>,
  networkCompanyNames: Set<string>,
): StoredSignal {
  const companyKey = (s.company || "").trim().toLowerCase();
  const isPortco = portcoNames.has(companyKey);
  const isWatch = watchNames.has(companyKey);
  const networkContactCount = networkCompanyNames.has(companyKey) ? 1 : 0;
  const cfg = DEFAULT_SIGNAL_CONFIG;
  const title = (s.subject || "").trim();
  const headline =
    digestHeadline(s.snippet || "", title) ||
    `${s.company} — industry research`;
  // Stable per company-within-email so multi-entity research forwards
  // don't collapse together (they share the Gmail permalink).
  const identity = `${s.permalink || ""}|${s.company || ""}|${title}`;
  const proxy = awarenessRelevanceProxy({ isPortco, isWatch, networkContactCount }, cfg);
  // NEWS@ is an intentional forward inbox — always clear the soft gate.
  const relevance = Math.max(proxy, 6);
  return {
    id: signalId("awareness", s.company || "", identity),
    dateFound: s.dateLabel || new Date().toISOString().split("T")[0],
    type: "awareness",
    status: "New",
    person: "",
    company: s.company || "",
    email: "",
    category: "Industry Research",
    signal: clampHeadline(headline),
    sourceUrl: s.permalink || "",
    subject: clampText(title, 200),
    body: clampText((s.body || "").trim(), 4000),
    relevance,
    justification: s.digestSubject
      ? `NEWS@ · ${s.digestSubject}`
      : "NEWS@ research forward",
    urgency: "",
    timing: "",
    sourceType: s.sourceHint || "Industry Reports",
    docUrl: (s.docUrl || "").trim(),
    hasBody: Boolean((s.body || "").trim()),
  };
}

export interface DigestArchiveOpts {
  watchNames?: Set<string>;
  /** Lowercased company names that appear on ≥1 CRM contact. */
  networkCompanyNames?: Set<string>;
}

/**
 * Archive exploded digest-link signals to the Signals tab so they outlive the
 * Gmail search window. Deduped by source URL against EVERYTHING already stored
 * (scan signals included) and by content key within the batch — repeat feed
 * loads and re-forwarded digests append nothing. Soft-gated by CRM relevance
 * proxy (no materiality at write time). Returns rows appended.
 */
export async function appendDigestLinkSignals(
  signals: GmailSignal[],
  portcoNames: Set<string>,
  opts: DigestArchiveOpts = {},
): Promise<number> {
  const links = signals.filter((s) => s.linkUrl);
  if (links.length === 0) return 0;

  const watchNames = opts.watchNames || new Set<string>();
  const networkCompanyNames = opts.networkCompanyNames || new Set<string>();
  const cfg = DEFAULT_SIGNAL_CONFIG;

  const existing = await fetchStoredSignals();
  const seenUrls = new Set(existing.map((s) => urlKey(s.sourceUrl)).filter(Boolean));
  const seenKeys = new Set(existing.map(keyForStored));
  const seenStories = new Set(
    existing
      .map((s) => storyContentKey(s.company, s.signal, s.subject, s.justification))
      .filter(Boolean),
  );
  const seenDriveIds = new Set<string>();
  for (const s of existing) {
    for (const id of citedDriveIdsFromUrls(s.sourceUrl, s.docUrl)) seenDriveIds.add(id);
  }

  const toAppend: StoredSignal[] = [];
  for (const s of links) {
    const u = urlKey(s.linkUrl || "");
    if (!u || seenUrls.has(u)) continue;
    const stored = storedFromDigestLink(s, portcoNames, watchNames, networkCompanyNames);
    if (!passesAwarenessQualityGate(stored, cfg)) continue;
    const k = keyForStored(stored);
    if (seenKeys.has(k)) continue;
    const driveIds = citedDriveIdsFromUrls(stored.sourceUrl, stored.docUrl);
    if (driveIds.some((id) => seenDriveIds.has(id))) continue;
    const story = storyContentKey(
      stored.company,
      stored.signal,
      stored.subject,
      stored.justification,
    );
    if (story && seenStories.has(story)) continue;
    seenUrls.add(u);
    seenKeys.add(k);
    if (story) seenStories.add(story);
    for (const id of driveIds) seenDriveIds.add(id);
    toAppend.push(stored);
  }
  if (toAppend.length > 0) {
    // Stored WITHOUT event clustering — see module header. The nightly
    // reconcile clusters rows that arrive here missing an Event ID.
    await appendSheetRows(TAB_NAMES.signals, toAppend.map(rowFromStored));
  }
  return toAppend.length;
}

/**
 * Archive NEWS@ research cards (451 / Gartner subject explosions, PDF titles)
 * to the Signals tab. Deduped by content key (company + permalink + headline)
 * so reloads don't duplicate. Returns rows appended.
 */
export async function appendResearchDigestSignals(
  signals: GmailSignal[],
  portcoNames: Set<string>,
  opts: DigestArchiveOpts = {},
): Promise<number> {
  const research = signals.filter(
    (s) => s.sourceHint === "Industry Reports" && !s.linkUrl && (s.company || s.subject),
  );
  if (research.length === 0) return 0;

  const watchNames = opts.watchNames || new Set<string>();
  const networkCompanyNames = opts.networkCompanyNames || new Set<string>();
  const cfg = DEFAULT_SIGNAL_CONFIG;

  const existing = await fetchStoredSignals();
  const seenKeys = new Set(existing.map(keyForStored));
  const seenStories = new Set(
    existing
      .map((s) => storyContentKey(s.company, s.signal, s.subject, s.justification))
      .filter(Boolean),
  );
  const seenDriveIds = new Set<string>();
  for (const s of existing) {
    for (const id of citedDriveIdsFromUrls(s.sourceUrl, s.docUrl)) seenDriveIds.add(id);
  }

  const toAppend: StoredSignal[] = [];
  for (const s of research) {
    const stored = storedFromResearchDigest(s, portcoNames, watchNames, networkCompanyNames);
    if (!passesAwarenessQualityGate(stored, cfg)) continue;
    const k = keyForStored(stored);
    if (seenKeys.has(k)) continue;
    const driveIds = citedDriveIdsFromUrls(stored.sourceUrl, stored.docUrl, s.driveWebViewLink);
    if (driveIds.some((id) => seenDriveIds.has(id))) continue;
    const story = storyContentKey(
      stored.company,
      stored.signal,
      stored.subject,
      stored.justification,
    );
    if (story && seenStories.has(story)) continue;
    seenKeys.add(k);
    if (story) seenStories.add(story);
    for (const id of driveIds) seenDriveIds.add(id);
    toAppend.push(stored);
  }
  if (toAppend.length > 0) {
    await appendSheetRows(TAB_NAMES.signals, toAppend.map(rowFromStored));
  }
  return toAppend.length;
}

/**
 * Upgrade weak NEWS@ research headlines already on the Signals tab once Gemini
 * has read the PDF. Matches on Gmail permalink + company. Returns rows patched.
 */
export async function patchWeakResearchSignalHeadlines(
  patches: Array<{ sourceUrl: string; company: string; signal: string; body?: string }>,
): Promise<number> {
  const usable = patches.filter(
    (p) =>
      (p.sourceUrl || "").trim() &&
      (p.company || "").trim() &&
      (p.signal || "").trim() &&
      !isWeakResearchSnippet(p.signal),
  );
  if (usable.length === 0) return 0;

  let rows: string[][] = [];
  try {
    rows = await fetchSheetTab(TAB_NAMES.signals);
  } catch {
    return 0;
  }
  if (rows.length === 0) return 0;

  const isHeader = (r: string[]) =>
    (r[0] || "").trim().toLowerCase() === "id" && (r[2] || "").trim().toLowerCase() === "type";
  const start = rows.length && isHeader(rows[0]) ? 1 : 0;
  const want = new Map<string, { signal: string; body?: string }>();
  for (const p of usable) {
    const k = `${urlKey(p.sourceUrl)}|${p.company.trim().toLowerCase()}`;
    if (k.startsWith("|")) continue;
    want.set(k, { signal: clampHeadline(p.signal), body: (p.body || "").trim() || undefined });
  }

  const cellUpdates: Array<{ range: string; value: string }> = [];
  for (let i = start; i < rows.length; i++) {
    const row = rows[i] || [];
    const company = (row[5] || "").trim().toLowerCase();
    const sourceUrl = (row[9] || "").trim();
    const current = (row[8] || "").trim();
    if (!company || !sourceUrl) continue;
    const hit = want.get(`${urlKey(sourceUrl)}|${company}`);
    if (!hit) continue;
    if (!isWeakResearchSnippet(current) && current.length >= hit.signal.length * 0.6) continue;
    const rowNum = i + 1; // sheets 1-indexed
    cellUpdates.push({ range: `${colLetters(8)}${rowNum}`, value: hit.signal }); // Signal
    if (hit.body) {
      cellUpdates.push({
        range: `${colLetters(11)}${rowNum}`,
        value: clampText(hit.body, SIGNAL_BODY_MAX),
      }); // Body
    }
  }
  if (cellUpdates.length === 0) return 0;
  await updateSheetCells(TAB_NAMES.signals, cellUpdates);
  return cellUpdates.filter((u) => u.range.startsWith(colLetters(8))).length;
}
