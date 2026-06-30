// Maps the real signal sources (Gemini scan recommendations + awareness news,
// LinkedIn company posts, shared-drive PDFs) into one unified FeedCard model for
// the Signals card-grid. Pure functions — safe to run client-side.

import type { SignalRecommendation, SignalAwarenessItem } from "@/utils/gemini.server";
import type { LinkedInPost } from "@/utils/linkedin.server";
import type { DriveDoc } from "@/utils/drive.server";
import type { GmailSignal } from "@/utils/gmail.functions";
import type { Contact, PortfolioCompany } from "@/lib/types";
import { makeScorer, type SignalInsight } from "@/lib/signal-strength";

export type SignalSourceType =
  | "Portco Blog"
  | "Public News Articles"
  | "Press Release"
  | "LinkedIn"
  | "Email"
  | "Internal Report"
  | "Industry Analysis";

// Canonical filter taxonomies (shown in full in the sidebar regardless of what's
// currently in the feed, so the panel always looks complete).
export const SOURCE_TYPES: SignalSourceType[] = [
  "Portco Blog",
  "Public News Articles",
  "Press Release",
  "LinkedIn",
  "Email",
  "Internal Report",
  "Industry Analysis",
];
export const SEGMENTS = ["AI", "Data", "Security", "Other"];
export const INDUSTRIES = [
  "Retail",
  "Manufacturing",
  "Healthcare",
  "Financial Services",
  "Public Sector",
  "Media",
  "Energy",
  "Telecom",
  "Education",
  "Logistics",
];

// Collapse a rich segment (portfolio domain or inferred) into one of the 4 buckets.
export function bucketOf(segment: string): string {
  return segment === "AI" || segment === "Data" || segment === "Security" ? segment : "Other";
}

// Map a signal category to the content-origin source type.
function sourceTypeForCategory(cat?: string): SignalSourceType {
  switch (cat) {
    case "Thought Leadership":
    case "Industry Trend":
      return "Industry Analysis";
    case "Product/Milestone":
      return "Press Release";
    default:
      return "Public News Articles";
  }
}

export interface FeedCard {
  id: string;
  sourceType: SignalSourceType;
  company: string;
  /** Rich segment (portfolio domain or inferred) shown on the badge. */
  segment: string;
  /** One of AI/Data/Security/Other — used by the sidebar filter. */
  segmentBucket: string;
  industry?: string;
  headline: string;
  summary: string;
  /** Full body, rendered as Markdown when the card is expanded. */
  body: string;
  sourceUrl?: string;
  /** True when sourceUrl is a web search (model-provided article URLs are unreliable). */
  sourceIsSearch?: boolean;
  /** Company domain for the logo (portfolio website or the contact's email domain). */
  logoDomain?: string;
  /** Avatar fallback initial. */
  initial: string;
  /** Epoch ms for sorting + date-range filter (0 if unknown). */
  sortTs: number;
  timeLabel: string;
  // Recommendation extras (used by Broadcast email defaults + badges).
  person?: string;
  email?: string;
  relevance?: number;
  category?: string;
  urgency?: string;
  /** Grounded strength scores + "why it matters / why now" (attached post-dedup). */
  insight?: SignalInsight;
}

// ── Helpers ──────────────────────────────────────────────────────
function hostFromUrl(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Free/personal email providers — their domain is NOT a company logo domain.
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "msn.com",
  "gmx.com",
]);

// Best-guess company domain from a contact's email (first address). "" for free
// providers or malformed addresses.
function emailDomain(email?: string): string {
  const first = (email || "").split(/[;,]/)[0].trim().toLowerCase();
  const at = first.indexOf("@");
  if (at < 0) return "";
  const d = first.slice(at + 1).trim();
  if (!d || FREE_EMAIL_DOMAINS.has(d)) return "";
  return d;
}

function initialOf(name: string): string {
  const t = (name || "").trim();
  return t ? t[0].toUpperCase() : "•";
}

// Web-search "find the source" link. Used instead of the model's sourceUrl, which
// is hallucinated (404s) — and instead of Vertex grounding redirect URLs, which
// expire and would 404 once a signal is persisted and shown later.
function searchUrl(company: string, headline: string): string {
  const q = [company, headline].filter(Boolean).join(" ").trim().slice(0, 220);
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

function parseTs(dateStr?: string): number {
  if (!dateStr) return 0;
  const t = Date.parse(dateStr);
  return Number.isNaN(t) ? 0 : t;
}

export function relativeTime(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const day = 86_400_000;
  const days = Math.floor(diff / day);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const w = Math.floor(days / 7);
    return `${w} week${w !== 1 ? "s" : ""} ago`;
  }
  const m = Math.floor(days / 30);
  return `${m} month${m !== 1 ? "s" : ""} ago`;
}

const SEGMENT_RULES: Array<[string, RegExp]> = [
  [
    "Security",
    /\b(security|cyber|zero[- ]?trust|threat|encryption|identity|soc|siem|malware|ransomware)\b/i,
  ],
  [
    "AI",
    /\b(ai|a\.i\.|artificial intelligence|machine learning|ml|llm|genai|generative|inference|model)\b/i,
  ],
  ["Data", /\b(data|analytics|database|warehouse|lakehouse|etl|pipeline|observability)\b/i],
  ["Cloud", /\b(cloud|kubernetes|k8s|devops|serverless|infrastructure|platform)\b/i],
];

function inferSegment(text: string): string {
  for (const [seg, re] of SEGMENT_RULES) if (re.test(text)) return seg;
  return "Other";
}

const INDUSTRY_RULES: Array<[string, RegExp]> = [
  ["Healthcare", /\b(health|healthcare|clinical|patient|medical|pharma|biotech|hospital)\b/i],
  ["Financial Services", /\b(bank|fintech|financial|payments|insurance|trading|lending)\b/i],
  ["Retail", /\b(retail|ecommerce|e-commerce|consumer|shopper|merchand)\b/i],
  ["Manufacturing", /\b(manufactur|industrial|factory|assembly)\b/i],
  ["Public Sector", /\b(government|federal|defense|public sector|\bgov\b|municipal)\b/i],
  ["Energy", /\b(energy|utility|grid|oil|gas|renewable|solar)\b/i],
  ["Telecom", /\b(telecom|5g|network operator|carrier|wireless)\b/i],
  ["Media", /\b(media|entertainment|streaming|advertis|gaming)\b/i],
  ["Education", /\b(education|edtech|university|student|school|academic)\b/i],
  ["Logistics", /\b(logistics|supply chain|shipping|freight|warehouse|fulfillment)\b/i],
];

function inferIndustry(text: string): string | undefined {
  for (const [ind, re] of INDUSTRY_RULES) if (re.test(text)) return ind;
  return undefined;
}

// Collapse cards that point to the same real source URL (or, when there's no real
// URL, the same company+headline), keeping the most actionable one. Catches the
// same story arriving via multiple lanes AND stale duplicate rows in the sheet.
function dedupeCards(cards: FeedCard[]): FeedCard[] {
  const rank = (c: FeedCard): number => {
    if (c.person || c.relevance != null) return 0; // actionable recommendation
    if (
      c.sourceType === "Public News Articles" ||
      c.sourceType === "Press Release" ||
      c.sourceType === "Industry Analysis"
    )
      return 1;
    if (c.sourceType === "Email") return 2;
    if (c.sourceType === "LinkedIn") return 3;
    return 4; // Drive, etc.
  };
  const normUrl = (u: string): string => {
    try {
      const x = new URL(u);
      return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/$/, "")}`.toLowerCase();
    } catch {
      return u.toLowerCase();
    }
  };
  // Real URL → dedup by URL. No real URL → dedup by company + the SPECIFIC content
  // (headline + summary), not the generic "Company — Category" headline, so
  // distinct awareness items about the same company aren't wrongly collapsed.
  const keyOf = (c: FeedCard): string => {
    if (c.sourceUrl && !c.sourceIsSearch && /^https?:\/\//.test(c.sourceUrl))
      return `u:${normUrl(c.sourceUrl)}`;
    const content = `${c.headline || ""} ${c.summary || ""}`
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    return `h:${(c.company || "").toLowerCase()}|${content}`;
  };

  const best = new Map<string, FeedCard>();
  for (const c of cards) {
    const k = keyOf(c);
    const cur = best.get(k);
    if (!cur || rank(c) < rank(cur)) best.set(k, c);
  }
  const kept = new Set(best.values());
  return cards.filter((c) => kept.has(c)); // preserve original (sorted) order
}

// ── Mapper ───────────────────────────────────────────────────────
export interface BuildFeedInput {
  recommendations: SignalRecommendation[];
  otherSignals: SignalAwarenessItem[];
  linkedinPosts: LinkedInPost[];
  driveDocs: DriveDoc[];
  emails?: GmailSignal[];
  orgName?: string;
  portfolio: PortfolioCompany[];
  /** Network contacts — used to score network leverage on each card. */
  contacts?: Contact[];
}

export function buildFeed(input: BuildFeedInput): FeedCard[] {
  const portMap = new Map<string, PortfolioCompany>();
  for (const p of input.portfolio) portMap.set(p.name.trim().toLowerCase(), p);

  const segmentFor = (company: string, text: string): string => {
    const p = portMap.get(company.trim().toLowerCase());
    if (p?.domain) return p.domain;
    return inferSegment(`${company} ${text}`);
  };
  // Company logo domain: prefer the portfolio company's website, else the
  // contact's (non-free) email domain.
  const logoDomainFor = (company: string, email?: string): string | undefined => {
    const p = portMap.get(company.trim().toLowerCase());
    const fromSite = p?.website ? hostFromUrl(p.website) : "";
    return fromSite || emailDomain(email) || undefined;
  };

  const cards: FeedCard[] = [];

  input.recommendations.forEach((r, i) => {
    const text = `${r.signal} ${r.justification}`;
    const ts = parseTs(r.dateFound);
    const seg = segmentFor(r.company || "", text);
    // A real (NewsAPI) URL is durable → link it directly; otherwise search.
    const realUrl = r.sourceUrl && /^https?:\/\//.test(r.sourceUrl) ? r.sourceUrl : "";
    const body =
      `**Signal:** ${r.signal}\n\n` +
      `_${[r.justification, r.timing, r.relevance != null ? `relevance ${r.relevance}/10` : ""].filter(Boolean).join(" · ")}_\n\n` +
      (r.subject || r.body
        ? `**Suggested outreach${r.person ? ` to ${r.person}` : ""}**\n\n${r.subject ? `**${r.subject}**\n\n` : ""}${r.body || ""}`
        : "");
    cards.push({
      id: `rec-${i}-${r.email || r.person || r.company}`,
      sourceType: sourceTypeForCategory(r.category),
      company: r.company || r.person || "Network",
      segment: seg,
      segmentBucket: bucketOf(seg),
      industry: inferIndustry(text),
      headline: r.signal || "Signal",
      summary: r.justification || r.signal || "",
      body,
      sourceUrl: realUrl || searchUrl(r.company || "", r.signal || ""),
      sourceIsSearch: !realUrl,
      logoDomain: logoDomainFor(r.company || "", r.email),
      initial: initialOf(r.company || r.person || "N"),
      sortTs: ts,
      timeLabel: relativeTime(ts),
      person: r.person,
      email: r.email,
      relevance: r.relevance,
      category: r.category,
      urgency: r.urgency,
    });
  });

  input.otherSignals.forEach((s, i) => {
    const text = `${s.summary} ${s.category}`;
    const ts = parseTs(s.dateFound);
    const seg = segmentFor(s.company || "", text);
    const realUrl = s.sourceUrl && /^https?:\/\//.test(s.sourceUrl) ? s.sourceUrl : "";
    cards.push({
      id: `news-${i}-${s.company}`,
      sourceType: sourceTypeForCategory(s.category),
      company: s.company || "Industry",
      segment: seg,
      segmentBucket: bucketOf(seg),
      industry: inferIndustry(text),
      headline: `${s.company || "Industry"}${s.category ? ` — ${s.category}` : ""}`,
      summary: s.summary || "",
      body: s.summary || "",
      sourceUrl: realUrl || searchUrl(s.company || "", s.summary || s.category || ""),
      sourceIsSearch: !realUrl,
      logoDomain: logoDomainFor(s.company || ""),
      initial: initialOf(s.company || "I"),
      sortTs: ts,
      timeLabel: relativeTime(ts),
      category: s.category,
    });
  });

  input.linkedinPosts.forEach((p, i) => {
    const firstLine = (p.text || "").split("\n").find((l) => l.trim()) || "LinkedIn update";
    const headline = firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine;
    const company = input.orgName || "Company page";
    const seg = inferSegment(p.text || "");
    cards.push({
      id: `li-${i}-${p.id}`,
      sourceType: "LinkedIn",
      company,
      segment: seg,
      segmentBucket: bucketOf(seg),
      industry: inferIndustry(p.text || ""),
      headline,
      summary: p.text || "",
      body: p.text || "_(no text)_",
      sourceUrl: p.url,
      initial: initialOf(company),
      sortTs: p.createdAt || parseTs(p.createdAtLabel),
      timeLabel: p.createdAtLabel ? relativeTime(p.createdAt || parseTs(p.createdAtLabel)) : "",
    });
  });

  input.driveDocs.forEach((d, i) => {
    const ts = d.modifiedTime || parseTs(d.modifiedLabel);
    const seg = inferSegment(d.name);
    cards.push({
      id: `drive-${i}-${d.id}`,
      sourceType: "Internal Report",
      company: d.name,
      segment: seg,
      segmentBucket: bucketOf(seg),
      headline: d.name,
      summary: "Shared-drive document — included as context in scans.",
      body: `Shared-drive PDF.${d.webViewLink ? ` [Open in Drive](${d.webViewLink})` : ""}`,
      sourceUrl: d.webViewLink,
      initial: initialOf(d.name),
      sortTs: ts,
      timeLabel: relativeTime(ts),
    });
  });

  (input.emails || []).forEach((e, i) => {
    const blob = `${e.subject} ${e.body}`;
    const seg = segmentFor(e.company || "", blob);
    cards.push({
      id: `gmail-${i}-${e.id}`,
      sourceType: "Email",
      company: e.company || e.fromName || "Email",
      segment: seg,
      segmentBucket: bucketOf(seg),
      industry: inferIndustry(blob),
      headline: e.subject,
      summary: e.snippet || e.body.slice(0, 160),
      body: e.body || e.snippet || "_(no body)_",
      sourceUrl: e.permalink, // real Gmail permalink → durable
      sourceIsSearch: false,
      logoDomain: e.logoDomain,
      initial: initialOf(e.company || e.fromName || "E"),
      sortTs: e.date,
      timeLabel: relativeTime(e.date),
      person: e.contactName,
      email: e.fromEmail,
    });
  });

  // Newest first; undated (ts 0) sink to the bottom. Dedup collapses repeats.
  const deduped = dedupeCards(cards.sort((a, b) => b.sortTs - a.sortTs));

  // Attach grounded scores + insight to each surviving card (after dedup so we
  // only score what's actually shown).
  const scorer = makeScorer(input.contacts ?? [], input.portfolio);
  for (const c of deduped) c.insight = scorer(c);
  return deduped;
}
