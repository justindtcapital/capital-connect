// Signal persistence for the Google Sheet "Signals" tab — the single owner of
// the POSITIONAL row contract (SIGNAL_HEADERS order). Extracted from
// gemini.functions.ts so the Gmail digest pipeline can also archive signals
// without importing the scan module (which imports gmail.functions — cycle).

import type { SignalRecommendation, SignalAwarenessItem } from "./gemini.server";
import type { GmailSignal } from "./gmail.functions";
import { newsSourceType } from "@/lib/signal-feed";
import { fetchSheetTab, appendSheetRows, TAB_NAMES } from "./sheets.server";

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
}

// Write-time size caps that keep the hot read path light. The Summary is the
// indexable/queryable field, so it stays short; the outreach Body is bounded and
// (via fetchStoredSignals lite mode) lazy-loaded on expand rather than pulled on
// every feed load. Both env-overridable.
const SIGNAL_SUMMARY_MAX = Number(process.env.SIGNALS_SUMMARY_MAX) || 500;
const SIGNAL_BODY_MAX = Number(process.env.SIGNALS_BODY_MAX) || 4000;
function clampText(s: string, max: number): string {
  const t = s || "";
  return t.length > max ? t.slice(0, max).trimEnd() + "…" : t;
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
    signal: r.signal || "",
    sourceUrl: r.sourceUrl || "",
    subject: r.subject || "",
    body: clampText(r.body || "", SIGNAL_BODY_MAX),
    relevance: r.relevance ?? 0,
    justification: clampText(r.justification || "", SIGNAL_SUMMARY_MAX),
    urgency: String(r.urgency || ""),
    timing: r.timing || "",
    sourceType: newsSourceType(r.category, isPortco),
    docUrl: driveDocUrl(r.sourceUrl),
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
    signal: clampText(a.summary || "", SIGNAL_SUMMARY_MAX),
    sourceUrl: a.sourceUrl || "",
    subject: a.title || "",
    body: "",
    relevance: 0,
    justification: "",
    urgency: "",
    timing: "",
    sourceType: newsSourceType(a.category, isPortco),
    docUrl: driveDocUrl(a.sourceUrl),
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
      }))
      // Keep only rows that are real signals (valid type + some content).
      .filter(
        (s) =>
          (s.type === "recommendation" || s.type === "awareness") &&
          (s.signal || s.company || s.person),
      )
  );
}

// ── Digest-link archiving ────────────────────────────────────────

// Normalized URL identity for dedup: lowercased, no trailing slash.
function urlKey(u: string): string {
  return (u || "").trim().toLowerCase().replace(/\/+$/, "");
}

// One exploded digest link → an awareness row. The article title rides in the
// (otherwise rec-only) Subject column so the feed can show it as the headline;
// Timing records which digest email surfaced it.
function storedFromDigestLink(s: GmailSignal, portcoNames: Set<string>): StoredSignal {
  const isPortco = portcoNames.has((s.company || "").trim().toLowerCase());
  return {
    id: signalId("awareness", s.company || "", s.linkUrl || s.subject || ""),
    dateFound: s.dateLabel || new Date().toISOString().split("T")[0],
    type: "awareness",
    status: "New",
    person: "",
    company: s.company || "",
    email: "",
    category: "Thought Leadership",
    signal: clampText(s.snippet || `${s.company} published “${s.subject}”.`, SIGNAL_SUMMARY_MAX),
    sourceUrl: s.linkUrl || "",
    subject: clampText(s.subject || "", 200),
    body: "",
    relevance: 0,
    justification: "",
    urgency: "",
    timing: s.digestSubject ? `Shared in “${s.digestSubject}”` : "",
    sourceType: newsSourceType("Thought Leadership", isPortco),
    docUrl: "",
    hasBody: false,
  };
}

/**
 * Archive exploded digest-link signals to the Signals tab so they outlive the
 * Gmail search window. Deduped by source URL against EVERYTHING already stored
 * (scan signals included) and by content key within the batch — repeat feed
 * loads and re-forwarded digests append nothing. Returns rows appended.
 */
export async function appendDigestLinkSignals(
  signals: GmailSignal[],
  portcoNames: Set<string>,
): Promise<number> {
  const links = signals.filter((s) => s.linkUrl);
  if (links.length === 0) return 0;

  const existing = await fetchStoredSignals();
  const seenUrls = new Set(existing.map((s) => urlKey(s.sourceUrl)).filter(Boolean));
  const seenKeys = new Set(existing.map(keyForStored));

  const toAppend: StoredSignal[] = [];
  for (const s of links) {
    const u = urlKey(s.linkUrl || "");
    if (!u || seenUrls.has(u)) continue;
    const stored = storedFromDigestLink(s, portcoNames);
    const k = keyForStored(stored);
    if (seenKeys.has(k)) continue;
    seenUrls.add(u);
    seenKeys.add(k);
    toAppend.push(stored);
  }
  if (toAppend.length > 0) {
    await appendSheetRows(TAB_NAMES.signals, toAppend.map(rowFromStored));
  }
  return toAppend.length;
}
