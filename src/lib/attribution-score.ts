// Grounded attribution relevance for network-attributed signals.
//
// Problem this solves: the news-scan's "relevance 1–10" was purely the LLM's
// opinion (its criteria: direct > indirect > warm connection). This module
// recomputes relevance DETERMINISTICALLY from CRM evidence the model never
// sees — relationship warmth, engagement, role fit, stated interests,
// portfolio overlap, actionability — and validates the attribution itself
// (does the email exist in the CRM? does the CRM agree they work there?).
//
// Same design rule as signal-strength.ts: every number traces to evidence we
// actually hold. The LLM's score survives only as a 25% prior; the breakdown
// is appended to the signal's justification so partners can see exactly why.
//
// Pure functions — safe client-side, fixture-testable.

import { seniorityOf, departmentOf } from "@/lib/people-classify";

/** Minimal contact shape (subset of Contact) so tests don't need the full type. */
export interface AttributionContact {
  name: string;
  email?: string;
  company?: string;
  title?: string;
  sector?: string;
  temperature?: string;
  prime?: string;
  lastContact?: string;
  activityScore?: number;
  areasOfInterest?: string | string[];
}

export interface AttributionRec {
  person: string;
  email: string;
  company: string;
  category: string;
  signal: string;
  /** The LLM's 1–10 opinion — kept as a 25% prior, never the truth. */
  llmRelevance?: number;
}

export interface AttributionContext {
  /** CRM contact resolved from the rec (email first, unambiguous name second). */
  contact?: AttributionContact;
  isPortcoCompany: boolean;
  isWatchlistCompany: boolean;
  /** Contact's CRM employer is a portfolio company (competitor/market intel target). */
  isContactAtPortco?: boolean;
  /** Lowercased portfolio sectors, for thesis-space overlap. */
  portfolioSectors: string[];
  /** Today's date (ISO) — injected for deterministic tests. */
  todayIso?: string;
}

export interface AttributionComponent {
  name: string;
  score: number;
  max: number;
  why: string;
}

export interface AttributionScore {
  /** Final 0–10 (one decimal) — replaces the LLM's relevance on the stored signal. */
  relevance: number;
  /** Email (or unambiguous name) resolved to a real CRM contact. */
  verified: boolean;
  /** CRM lists the contact at a different company than the story claims. */
  companyMismatch: boolean;
  /** Contact works at the news-subject company (self-company attribution). */
  selfCompanyAttribution: boolean;
  components: AttributionComponent[];
  /** Compact, human-readable breakdown appended to the signal justification. */
  summary: string;
}

const EXEC_CATEGORIES = new Set([
  "funding/m&a",
  "executive movement",
  "crisis/regulatory",
  "partnership/customer win",
]);
const BUILD_CATEGORIES = new Set(["product/milestone", "thought leadership"]);

function normCompany(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/[.,'’]/g, "")
    .replace(/\b(incorporated|inc|corporation|corp|company|co|llc|llp|lp|ltd|limited|labs|technologies|ai)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Loose company equality: normalized substring either way (handles "Acme" vs "Acme Security Inc"). */
export function companiesMatch(a: string, b: string): boolean {
  const na = normCompany(a);
  const nb = normCompany(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** True when the CRM contact works at the news-subject company. */
export function isSelfCompanyAttribution(
  contact: AttributionContact | undefined,
  subjectCompany: string,
): boolean {
  return Boolean(
    contact?.company && subjectCompany && companiesMatch(contact.company, subjectCompany),
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary term match — "ai" must not match inside "chains". */
function hasTerm(hay: string, term: string): boolean {
  if (!term) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}([^a-z0-9]|$)`, "i").test(hay);
}

function daysSince(iso: string | undefined, todayIso: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  const now = Date.parse(todayIso);
  if (!Number.isFinite(t) || !Number.isFinite(now)) return null;
  return Math.max(0, (now - t) / 86400000);
}

export function scoreAttribution(rec: AttributionRec, ctx: AttributionContext): AttributionScore {
  const todayIso = ctx.todayIso || new Date().toISOString();
  const c = ctx.contact;
  const category = (rec.category || "").trim().toLowerCase();
  const components: AttributionComponent[] = [];

  // 1) Relationship warmth (max 3) — temperature tier + engagement activity.
  {
    const temp = (c?.temperature || "").toLowerCase();
    const base = temp === "council" ? 3 : temp === "hot" ? 2.7 : temp === "warm" ? 1.8 : temp === "cold" ? 0.8 : 0;
    const activity = Math.min(0.3, ((c?.activityScore ?? 0) / 100) * 0.3);
    const score = Math.min(3, base + activity);
    components.push({
      name: "relationship",
      score,
      max: 3,
      why: c ? `${c.temperature || "untiered"}${c.activityScore ? `, engagement ${c.activityScore}` : ""}` : "not in CRM",
    });
  }

  // 2) Role fit (max 2) — is this person's seniority/department implicated by
  //    this KIND of story? A funding story matters to execs; a product story
  //    to builders; an industry trend to almost nobody specifically.
  {
    const sen = seniorityOf(c?.title);
    const dept = departmentOf(c?.title || "");
    let score = 0.3;
    let why = `${sen || "unknown seniority"}`;
    if (EXEC_CATEGORIES.has(category)) {
      score = sen === "C-Suite" || sen === "SVP" ? 2 : sen === "VP" ? 1.6 : sen === "Director" ? 1.2 : sen === "Manager" ? 0.7 : 0.3;
      why = `${sen || "IC"} × ${rec.category}`;
    } else if (BUILD_CATEGORIES.has(category)) {
      const buildDept = dept === "Engineering" || dept === "Product" || dept === "Data & AI";
      score = buildDept ? 1.4 : sen === "C-Suite" ? 1.2 : 0.6;
      why = `${dept || sen || "general"} × ${rec.category}`;
    } else {
      score = 0.5;
      why = `${rec.category || "uncategorized"} (broad)`;
    }
    components.push({ name: "role fit", score, max: 2, why });
  }

  // 3) Interest fit (max 2) — the contact's STATED areas of interest / sector
  //    matched against the story text. This is the field the old scoring never
  //    used, and it's the strongest personal-relevance evidence we hold.
  {
    const hay = `${rec.category} ${rec.signal} ${rec.company}`.toLowerCase();
    const rawInterests = Array.isArray(c?.areasOfInterest)
      ? c.areasOfInterest
      : (c?.areasOfInterest || "").split(/[,;]/);
    const terms = [...rawInterests, ...(c?.sector ? [c.sector] : [])]
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length >= 2);
    const hits = [...new Set(terms.filter((t) => hasTerm(hay, t)))].slice(0, 3);
    const score = Math.min(2, hits.length === 0 ? 0 : 1.2 + (hits.length - 1) * 0.4);
    components.push({
      name: "interests",
      score,
      max: 2,
      why: hits.length > 0 ? `matches "${hits.join('", "')}"` : "no stated-interest match",
    });
  }

  // 4) Portfolio fit (max 1.5) — does the story's company touch firm strategy?
  {
    let score = 0;
    let why = "outside portfolio space";
    if (ctx.isPortcoCompany) {
      score = 1.5;
      why = "portfolio company";
    } else if (ctx.isWatchlistCompany) {
      score = 1.2;
      why = "competitive-radar watchlist";
    } else {
      const hay = `${rec.signal} ${rec.category}`.toLowerCase();
      const hit = ctx.portfolioSectors.find((s) => hasTerm(hay, s));
      if (hit) {
        score = 0.8;
        why = `portfolio sector overlap (${hit})`;
      }
    }
    components.push({ name: "portfolio", score, max: 1.5, why });
  }

  // 5) Actionability (max 1.5) — can the firm actually act on this today?
  {
    let score = 0;
    const whys: string[] = [];
    if (c?.email || rec.email) {
      score += 0.5;
      whys.push("email on file");
    }
    if (c?.prime) {
      score += 0.4;
      whys.push(`prime: ${c.prime}`);
    }
    const gap = daysSince(c?.lastContact, todayIso);
    if (gap === null || gap > 45) {
      score += 0.6;
      whys.push(gap === null ? "never contacted — fresh opening" : `${Math.round(gap)}d since last touch — re-engagement window`);
    } else {
      score += 0.3;
      whys.push(`recently active (${Math.round(gap)}d)`);
    }
    components.push({ name: "actionability", score: Math.min(1.5, score), max: 1.5, why: whys.join(", ") });
  }

  const grounded = components.reduce((s, comp) => s + comp.score, 0); // max 10
  const llm = Math.min(10, Math.max(0, rec.llmRelevance ?? 5));
  let relevance = 0.75 * grounded + 0.25 * llm;

  // Validation caps — an attribution we can't verify must not outrank ones we can.
  const verified = Boolean(c);
  const selfCompanyAttribution = isSelfCompanyAttribution(c, rec.company);
  // "Mismatch" = CRM employer ≠ story company. For portfolio stories that is the
  // DESIRED pattern (external network, not employees). Only penalize mismatch
  // off-portfolio, where it more often means a job-change / bad attribution.
  const companyMismatch = Boolean(
    c && c.company && rec.company && !selfCompanyAttribution,
  );
  const notes: string[] = [];
  if (ctx.isPortcoCompany && selfCompanyAttribution) {
    // Hard reject: never suggest portco employees about their own company's news.
    relevance = 0;
    notes.push("REJECTED — contact works at this portfolio company; attribute to external network instead");
  } else if (!verified) {
    relevance = Math.min(relevance, 3.5);
    notes.push("UNVERIFIED — email/name not found in CRM (capped)");
  } else if (
    companyMismatch &&
    !ctx.isPortcoCompany &&
    !ctx.isContactAtPortco
  ) {
    relevance = Math.min(relevance, 5);
    notes.push(`CRM lists them at ${c?.company} not ${rec.company} — possible job change or misattribution (capped)`);
  }

  relevance = Math.round(relevance * 10) / 10;
  const summary =
    `Attribution ${relevance}/10 — ` +
    components.map((comp) => `${comp.name} ${comp.score.toFixed(1)}/${comp.max} (${comp.why})`).join(", ") +
    (notes.length > 0 ? `. ${notes.join(". ")}` : "") +
    `. LLM prior ${llm}/10 weighted 25%.`;

  return { relevance, verified, companyMismatch, selfCompanyAttribution, components, summary };
}
