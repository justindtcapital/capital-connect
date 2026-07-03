import { createServerFn } from "@tanstack/react-start";
import {
  draftEmail as runDraftEmail,
  scanSignals as runScanSignals,
  isGeminiConfigured,
  geminiGenerate,
  responseText,
  type EmailDraftResult,
  type SignalScanResult,
  type SignalPerson,
  type SignalRecommendation,
  type SignalAwarenessItem,
  type SignalDocument,
} from "./gemini.server";
import { isDriveConfigured, listDriveDocs, downloadDriveFile } from "./drive.server";
import { isNewsConfigured, fetchNewsForCompanies } from "./news.server";
import { gatherNetworkEmails, type GmailSignal } from "./gmail.functions";
import {
  buildContacts,
  buildPortfolioCompanies,
  fetchSheetTab,
  appendSheetRows,
  ensureTab,
  ensureHeaderRow,
  TAB_NAMES,
  SIGNAL_HEADERS,
} from "./sheets.server";

// Draft an outreach email with Gemini. Runs server-side so the API key stays secret.
export const draftEmail = createServerFn({ method: "POST" })
  .inputValidator((data: {
    contactName: string;
    contactTitle?: string;
    contactCompany?: string;
    contactSector?: string;
    purpose: string;
    tone?: string;
    notes?: string;
    history?: string[];
    senderName?: string;
    senderOrg?: string;
    emailType?: string;
    linkedPortcos?: string[];
    linkedEvent?: string;
  }) => data)
  .handler(async ({ data }): Promise<EmailDraftResult> => {
    try {
      return await runDraftEmail(data);
    } catch (err) {
      console.error("[gemini] draftEmail failed:", err);
      return { found: false, error: err instanceof Error ? err.message : "Draft failed" };
    }
  });

const STRENGTH_BY_TEMPERATURE: Record<string, string> = {
  Hot: "strong",
  Warm: "medium",
  Cold: "weak",
};

// Pull readable article-ish URLs out of email bodies for Gemini's URL-context tool.
// Drops obvious junk (unsubscribe/tracking/preferences) and caps the count (the
// URL-context tool reads up to ~20 URLs per request).
function extractEmailLinks(emails: GmailSignal[], cap = 20): string[] {
  const urls = new Set<string>();
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  for (const e of emails) {
    for (const match of (e.body || "").matchAll(re)) {
      if (urls.size >= cap) break;
      const u = match[0].replace(/[.,;)]+$/, "");
      const low = u.toLowerCase();
      if (u.length > 300) continue;
      if (/(unsubscribe|list-manage|\/preferences|mailto:|utm_|email-settings|opt-?out)/.test(low)) continue;
      urls.add(u);
    }
    if (urls.size >= cap) break;
  }
  return [...urls];
}

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "msn.com",
]);

function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function emailDomainOf(email?: string): string {
  const first = (email || "").split(/[;,]/)[0].trim().toLowerCase();
  const at = first.indexOf("@");
  if (at < 0) return "";
  const d = first.slice(at + 1).trim();
  return !d || FREE_EMAIL_DOMAINS.has(d) ? "" : d;
}

// domain → company name, from portfolio websites + (non-free) contact email domains.
function buildDomainToCompany(
  contacts: Array<{ company?: string; email?: string }>,
  portfolio: Array<{ name: string; website?: string }>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of portfolio) {
    const h = hostOf(p.website);
    if (h) m.set(h, p.name);
  }
  for (const c of contacts) {
    const d = emailDomainOf(c.email);
    if (d && c.company && !m.has(d)) m.set(d, c.company);
  }
  return m;
}

// Match a link's domain (or registrable parent) to a known company.
function companyForLink(url: string, m: Map<string, string>): string {
  const host = hostOf(url);
  if (!host) return "";
  if (m.has(host)) return m.get(host) as string;
  for (const [k, v] of m) {
    if (host === k || host.endsWith(`.${k}`) || k.endsWith(`.${host}`)) return v;
  }
  return "";
}

// How many shared-drive PDFs to feed into a scan, and the per-file size ceiling.
// Kept conservative: each PDF re-feeds as input tokens, which compounds against
// per-minute quotas. Override the count with GOOGLE_SIGNALS_MAX_DOCS in .env.
const MAX_SIGNAL_DOCS = Number(process.env.GOOGLE_SIGNALS_MAX_DOCS) || 4;
const MAX_SIGNAL_DOC_BYTES = 8_000_000; // ~8 MB per file

// Pull recent PDFs from the shared drive and base64-encode them for Gemini.
// Best-effort: any failure logs and returns whatever loaded, so a scan never
// fails just because Drive is unreachable or unconfigured.
async function loadSignalDocuments(): Promise<SignalDocument[]> {
  if (!isDriveConfigured()) return [];
  try {
    const feed = await listDriveDocs(MAX_SIGNAL_DOCS * 3);
    const picked = feed.docs
      .filter((d) => !d.sizeBytes || d.sizeBytes <= MAX_SIGNAL_DOC_BYTES)
      .slice(0, MAX_SIGNAL_DOCS);
    const loaded = await Promise.all(
      picked.map(async (d) => {
        const file = await downloadDriveFile(d.id);
        if (!file) return null;
        return {
          name: d.name,
          base64: file.base64,
          mediaType: file.mediaType,
          link: d.webViewLink,
        } as SignalDocument;
      }),
    );
    return loaded.filter((d): d is SignalDocument => d !== null);
  } catch (e) {
    console.error("[gemini] loadSignalDocuments failed (continuing without):", e);
    return [];
  }
}

// ── Signal persistence (Google Sheet "Signals" tab) ──────────────

interface StoredSignal {
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
function keyForStored(s: StoredSignal): string {
  return s.type === "recommendation"
    ? signalId("recommendation", s.email || s.person || "", s.sourceUrl || s.signal || "")
    : signalId("awareness", s.person || s.company || "", s.sourceUrl || s.signal || "");
}

function storedFromRec(r: SignalRecommendation, dateFound: string): StoredSignal {
  const who = r.email || r.person || "";
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
    body: r.body || "",
    relevance: r.relevance ?? 0,
    justification: r.justification || "",
    urgency: String(r.urgency || ""),
    timing: r.timing || "",
  };
}

function storedFromAwareness(a: SignalAwarenessItem, dateFound: string): StoredSignal {
  const who = a.person || a.company || "";
  return {
    id: signalId("awareness", who, a.sourceUrl || a.summary || ""),
    dateFound,
    type: "awareness",
    status: "New",
    person: a.person || "",
    company: a.company || "",
    email: "",
    category: a.category || "",
    signal: a.summary || "",
    sourceUrl: a.sourceUrl || "",
    subject: "",
    body: "",
    relevance: 0,
    justification: "",
    urgency: "",
    timing: "",
  };
}

function rowFromStored(s: StoredSignal): string[] {
  return [
    s.id, s.dateFound, s.type, s.status, s.person, s.company, s.email, s.category,
    s.signal, s.sourceUrl, s.subject, s.body, String(s.relevance), s.justification, s.urgency, s.timing,
  ];
}

async function fetchStoredSignals(): Promise<StoredSignal[]> {
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
  return data
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
      body: g(row, 11),
      relevance: Number(g(row, 12)) || 0,
      justification: g(row, 13),
      urgency: g(row, 14),
      timing: g(row, 15),
    }))
    // Keep only rows that are real signals (valid type + some content).
    .filter((s) => (s.type === "recommendation" || s.type === "awareness") && (s.signal || s.company || s.person));
}

function resultFromStored(stored: StoredSignal[], compliance: string[], newCount: number): SignalScanResult {
  const recommendations: SignalRecommendation[] = stored
    .filter((s) => s.type === "recommendation")
    .sort((a, b) => b.relevance - a.relevance || (b.dateFound > a.dateFound ? 1 : -1))
    .map((s) => ({
      person: s.person, company: s.company, email: s.email, category: s.category,
      signal: s.signal, sourceUrl: s.sourceUrl, subject: s.subject, body: s.body,
      relevance: s.relevance, justification: s.justification, urgency: s.urgency, timing: s.timing,
      dateFound: s.dateFound,
    }));
  const otherSignals: SignalAwarenessItem[] = stored
    .filter((s) => s.type === "awareness")
    .map((s) => ({ company: s.company, person: s.person, category: s.category, summary: s.signal, sourceUrl: s.sourceUrl, dateFound: s.dateFound }));
  return { found: true, recommendations, otherSignals, compliance, newCount };
}

// Scan recent news for the firm's portfolio + network companies and attribute
// signals to network people. Pulls portcos + contacts from the sheet server-side
// so the client just triggers the run.
// Narrow a scan result to a single company (used by the PortCo Signals panel).
// `scoped` is the lowercased company name; "" means no scoping (returns as-is).
function scopeResult(r: SignalScanResult, scoped: string): SignalScanResult {
  if (!scoped) return r;
  const match = (co?: string) => {
    const c = (co || "").trim().toLowerCase();
    if (!c) return false;
    return c === scoped || c.includes(scoped) || (scoped.includes(c) && c.length > 2);
  };
  const recommendations = r.recommendations.filter((x) => match(x.company));
  const otherSignals = r.otherSignals.filter((x) => match(x.company));
  return { ...r, recommendations, otherSignals, newCount: undefined };
}

export const scanSignals = createServerFn({ method: "POST" })
  .inputValidator((data: { windowDays?: number; maxPeople?: number; maxCompanies?: number; companyName?: string }) => data)
  .handler(async ({ data }): Promise<SignalScanResult> => {
    const windowDays = data.windowDays ?? 14;
    const maxPeople = data.maxPeople ?? 150;
    const maxCompanies = data.maxCompanies ?? 12;
    // When set, the scan is scoped to a single portfolio company (the PortCo
    // profile's Signals panel): only that company is scanned, only people
    // connected to it are in the attribution pool, and the result is filtered to it.
    const scoped = (data.companyName || "").trim().toLowerCase();

    try {
      const [contacts, portfolio] = await Promise.all([
        buildContacts(),
        buildPortfolioCompanies(),
      ]);

      const allPortcos = portfolio.map((p) => ({
        name: p.name,
        sector: p.sector,
        themes: p.description,
      }));
      const portcoNames = new Set(allPortcos.map((p) => p.name.trim().toLowerCase()));
      const portcos = scoped
        ? allPortcos.filter((p) => p.name.trim().toLowerCase() === scoped)
        : allPortcos;

      // Attribution pool: everyone, or — when scoped — only contacts who work at
      // the company or have an intro to it.
      const peopleSource = scoped
        ? contacts.filter(
            (c) =>
              (c.company || "").trim().toLowerCase() === scoped ||
              (c.portCoIntros || []).some((p) => p.trim().toLowerCase() === scoped),
          )
        : contacts;

      const tempRank: Record<string, number> = { Hot: 0, Warm: 1, Cold: 2 };
      const people: SignalPerson[] = peopleSource
        .filter((c) => c.email)
        .sort((a, b) => (tempRank[a.temperature] ?? 3) - (tempRank[b.temperature] ?? 3))
        .slice(0, maxPeople)
        .map((c) => ({
          name: c.name,
          title: c.title,
          company: c.company,
          strength: STRENGTH_BY_TEMPERATURE[c.temperature] || "weak",
          sector: c.sector,
          email: c.email?.split(";")[0]?.trim(),
          lastContact: c.lastContact,
        }));

      // Broad network companies only matter for an unscoped scan.
      let companies: string[] = [];
      if (!scoped) {
        const counts = new Map<string, number>();
        for (const c of contacts) {
          const name = (c.company || "").trim();
          if (!name || portcoNames.has(name.toLowerCase())) continue;
          counts.set(name, (counts.get(name) || 0) + 1);
        }
        companies = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, maxCompanies)
          .map(([name]) => name);
      } else if (portcos.length === 0 && data.companyName) {
        // Scoped to a name that isn't a portfolio company — scan it as a company.
        companies = [data.companyName.trim()];
      }

      // Internal PDFs from the shared drive (best-effort — empty if unconfigured).
      const documents = await loadSignalDocuments();

      // Already-stored signals — used both to dedupe new signals AND to skip
      // articles we've already turned into signals on a prior scan.
      const existing = await fetchStoredSignals();
      const seenUrls = new Set(
        existing.map((s) => (s.sourceUrl || "").trim().toLowerCase()).filter((u) => /^https?:\/\//.test(u)),
      );

      // Real articles from NewsAPI to ground the scan with durable source URLs
      // (best-effort — empty if unconfigured; then Gemini uses Google Search).
      let articles: Awaited<ReturnType<typeof fetchNewsForCompanies>> = [];
      try {
        if (isNewsConfigured()) {
          articles = await fetchNewsForCompanies([...portcos.map((p) => p.name), ...companies], windowDays);
        }
      } catch (e) {
        console.error("[gemini] fetchNewsForCompanies failed (continuing without):", e);
      }

      // Drop articles already processed in a previous scan so we don't re-source
      // the same stories (saves tokens and stops repeats).
      const hadArticles = articles.length > 0;
      articles = articles.filter((a) => !seenUrls.has(a.url.trim().toLowerCase()));
      if (hadArticles && articles.length === 0) {
        // Every article NewsAPI surfaced has already been turned into a signal —
        // nothing new. Return the stored set without spending a Gemini call.
        return scopeResult(resultFromStored(existing, [], 0), scoped);
      }

      // Links from the network's recent emails — pre-attributed to a company by
      // domain, then read by Gemini via the URL-context tool.
      let emailLinks: Array<{ url: string; company?: string }> = [];
      try {
        const g = await gatherNetworkEmails({ contacts, portfolio });
        if (g.ok) {
          const d2c = buildDomainToCompany(contacts, portfolio);
          emailLinks = extractEmailLinks(g.emails)
            .filter((u) => !seenUrls.has(u.toLowerCase()))
            .map((u) => ({ url: u, company: companyForLink(u, d2c) || undefined }));
        }
      } catch (e) {
        console.error("[gemini] gatherNetworkEmails for scan failed (continuing):", e);
      }

      const fresh = await runScanSignals({ windowDays, portcos, companies, people, documents, articles, emailLinks });
      if (!fresh.found) return fresh;

      const dateFound = new Date().toISOString().split("T")[0];
      const candidates = [
        ...fresh.recommendations.map((r) => storedFromRec(r, dateFound)),
        ...fresh.otherSignals.map((a) => storedFromAwareness(a, dateFound)),
      ];

      // Dedup on the recomputed content key (not the stored ID column), so
      // re-scans don't double-store the same signal even if older rows carry a
      // legacy/mangled ID.
      const seen = new Set(existing.map(keyForStored));
      const toAppend: StoredSignal[] = [];
      for (const c of candidates) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        toAppend.push(c);
      }

      if (toAppend.length > 0) {
        await ensureTab(TAB_NAMES.signals, SIGNAL_HEADERS);
        await ensureHeaderRow(TAB_NAMES.signals, SIGNAL_HEADERS);
        await appendSheetRows(TAB_NAMES.signals, toAppend.map(rowFromStored));
      }

      return scopeResult(resultFromStored([...existing, ...toAppend], fresh.compliance, toAppend.length), scoped);
    } catch (err) {
      console.error("[gemini] scanSignals failed:", err);
      return {
        found: false,
        error: err instanceof Error ? err.message : "Signal scan failed",
        recommendations: [],
        otherSignals: [],
        compliance: [],
      };
    }
  });

// ── Areas-of-interest suggestion ─────────────────────────────────
// Suggest a contact's interest domains from their title/company/sector using
// Gemini, falling back to the deterministic rule-based inference when Gemini is
// unconfigured or errors. Returns a de-duplicated list of short domain labels.
export interface SuggestAreasResult {
  ok: boolean;
  areas: string[];
  source: "gemini" | "rules";
  error?: string;
}

export const suggestAreasOfInterest = createServerFn({ method: "POST" })
  .inputValidator((data: { title?: string; company?: string; sector?: string; existing?: string[] }) => data)
  .handler(async ({ data }): Promise<SuggestAreasResult> => {
    const { inferInterestAreas } = await import("@/lib/interest-domains");
    const rules = () => inferInterestAreas(data.title || "", data.company || "", data.sector || "");

    if (!isGeminiConfigured()) {
      return { ok: true, areas: rules(), source: "rules" };
    }
    try {
      const prompt = [
        "You classify a business contact into a few broad areas of professional interest.",
        "Given their title, company, and sector, return 3-6 short domain labels (1-2 words each)",
        "such as: AI, Data, Security, Cloud, Fintech, Healthcare, Sales, Marketing, Product, Finance,",
        "Operations, Supply Chain, Logistics, Investing, Energy, Public Sector, Legal, People.",
        "Prefer specific, useful labels over generic ones. Do NOT repeat labels already listed as existing.",
        "",
        `Title: ${data.title || "(unknown)"}`,
        `Company: ${data.company || "(unknown)"}`,
        `Sector: ${data.sector || "(unknown)"}`,
        `Existing areas (do not repeat): ${(data.existing || []).join(", ") || "(none)"}`,
        "",
        'Respond ONLY with a JSON array of strings, e.g. ["AI","Data","Security"]. No prose.',
      ].join("\n");

      const r = await geminiGenerate({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.3, thinkingConfig: { thinkingBudget: 256 } },
      });
      const text = responseText(r) || "";
      const match = text.match(/\[[\s\S]*\]/);
      let areas: string[] = [];
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) {
            areas = parsed.map((x) => String(x).trim()).filter(Boolean);
          }
        } catch { /* fall through to rules */ }
      }
      if (areas.length === 0) return { ok: true, areas: rules(), source: "rules" };
      return { ok: true, areas, source: "gemini" };
    } catch (err) {
      console.error("[gemini] suggestAreasOfInterest failed, using rules:", err);
      return { ok: true, areas: rules(), source: "rules" };
    }
  });

// ── Home daily briefing ──────────────────────────────────────────
// A light, direct Gemini call (NOT the audited agent layer) that turns the
// home dashboard's already-loaded numbers into a short narrative briefing.
export interface HomeSummaryInput {
  metrics: { contacts: number; hotLeads: number; openFollowUps: number; targets: number; portfolio: number };
  deltas: { contacts: number | null; hotLeads: number | null; targets: number | null; portfolio: number | null };
  attention: Array<{ name: string; company?: string; reason: string; detail: string }>;
  attentionTotal: number;
  signals: Array<{ company: string; headline: string }>;
  newSignals?: number;
}

export interface HomeSummaryResult {
  ok: boolean;
  summary?: string;
  error?: string;
}

function buildHomeSummaryPrompt(d: HomeSummaryInput): string {
  const fmtDelta = (n: number | null) =>
    n == null ? "" : n > 0 ? ` (+${n} this week)` : n < 0 ? ` (${n} this week)` : " (flat this week)";
  const m = d.metrics;
  const lines: string[] = [
    "You are an analyst for the business-development team at Dell Technologies Capital (a venture capital firm).",
    "Write a concise daily briefing of the team's CRM home dashboard, in a confident, professional voice.",
    "",
    "TODAY'S NUMBERS:",
    `- Network contacts: ${m.contacts}${fmtDelta(d.deltas.contacts)}`,
    `- Hot leads: ${m.hotLeads}${fmtDelta(d.deltas.hotLeads)}`,
    `- Open follow-ups needing action: ${m.openFollowUps}`,
    `- Prospecting targets: ${m.targets}${fmtDelta(d.deltas.targets)}`,
    `- Portfolio companies tracked: ${m.portfolio}${fmtDelta(d.deltas.portfolio)}`,
    "",
    `ATTENTION QUEUE (${d.attentionTotal} people need follow-up; top items):`,
    ...(d.attention.length
      ? d.attention.map((a) => `- ${a.name}${a.company ? ` (${a.company})` : ""} — ${a.reason}: ${a.detail}`)
      : ["- (nobody is overdue right now)"]),
    "",
    `RECENT SIGNALS${d.newSignals ? ` (${d.newSignals} new)` : ""}:`,
    ...(d.signals.length
      ? d.signals.map((s) => `- ${s.company}: ${s.headline}`)
      : ["- (no recent signals)"]),
    "",
    "Write 3-4 short bullet points (each starting with '- ') covering what matters most today: the most urgent follow-ups, pipeline momentum, and any notable signal worth acting on.",
    "Reference real names and numbers from the data. Be specific and actionable. No greeting, no preamble, no sign-off, no markdown headers.",
  ];
  return lines.join("\n");
}

// Summarize the home dashboard. Server-side so the Gemini credentials stay secret.
export const generateHomeSummary = createServerFn({ method: "POST" })
  .inputValidator((data: HomeSummaryInput) => data)
  .handler(async ({ data }): Promise<HomeSummaryResult> => {
    if (!isGeminiConfigured()) {
      return { ok: false, error: "Gemini is not configured on the server." };
    }
    try {
      const r = await geminiGenerate({
        contents: [{ role: "user", parts: [{ text: buildHomeSummaryPrompt(data) }] }],
        generationConfig: { maxOutputTokens: 1300, temperature: 0.5, thinkingConfig: { thinkingBudget: 512 } },
      });
      const summary = responseText(r);
      if (!summary) return { ok: false, error: "The model returned an empty summary." };
      return { ok: true, summary };
    } catch (err) {
      console.error("[gemini] generateHomeSummary failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : "Summary failed" };
    }
  });

// Load previously stored signals (used by the Signals page loader so they
// survive a refresh without re-running / re-paying for a scan).
export const fetchSignals = createServerFn({ method: "GET" }).handler(
  async (): Promise<SignalScanResult> => {
    try {
      const stored = await fetchStoredSignals();
      return resultFromStored(stored, [], 0);
    } catch (err) {
      console.error("[gemini] fetchSignals failed:", err);
      return { found: true, recommendations: [], otherSignals: [], compliance: [], newCount: 0 };
    }
  },
);
