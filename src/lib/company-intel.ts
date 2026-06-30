// Company Intelligence — the ENTITY LAYER.
//
// Collapses every piece of evidence we hold (stored signals, network contacts,
// portfolio intros, pipeline targets, the portfolio record's own team/events)
// into one record PER COMPANY. This is the foundation the graph / multi-hop /
// competitor-radar slices build on: instead of people and signals floating free,
// they all ROUTE to a durable company entity that accumulates a story over time.
//
// GROUNDING RULE (same as signal-strength): every number traces to evidence we
// actually have. The "momentum" score is explicitly an activity+sentiment read
// over signals & network depth — NOT a financial health score (we don't ingest
// hiring/patents/traffic/funding data). The UI labels it honestly.
//
// Pure functions — safe to run server-side (loader) or client-side.

import type {
  Contact,
  PortfolioCompany,
  PortfolioEvent,
  PortfolioIntro,
  TargetLead,
} from "@/lib/types";
import type { FeedCard } from "@/lib/signal-feed";
import { bucketOf } from "@/lib/signal-feed";

// How a person is connected to the company.
//   works-here = a network contact whose company IS this one
//   intro      = a contact we've introduced to this (portfolio) company
//   target     = a prospect in the pipeline at this company
//   team       = listed on the portfolio company's own roster
//   signal     = attributed in a signal but not (yet) a known contact
export type Relationship = "works-here" | "intro" | "target" | "team" | "signal";

export interface RelatedPerson {
  id: string;
  name: string;
  title: string;
  email: string;
  relationship: Relationship;
  /** Contact temperature, when the person is a known contact. */
  temperature?: string;
  /** Short context, e.g. "Intro · Mar 2026", "Target · Outreach Sent". */
  detail?: string;
  linkedinUrl?: string;
}

export interface MomentumScore {
  /** 0–100 activity + signal-sentiment read (NOT financial health). */
  score: number;
  /** Signed change vs the prior 30-day window. */
  trend: number;
  /** Human-readable, grounded reasons for the number. */
  drivers: string[];
}

export interface CompanyIntel {
  name: string;
  key: string; // normalized name (lookup key + ?c= value)
  logoDomain?: string;
  /** True when logoDomain came from real evidence (website/email); false when
   *  it's only a name-based guess (use a more cautious logo ladder in that case). */
  logoConfident?: boolean;
  /** AI / Data / Security / Other (portfolio domain or inferred from signals). */
  segment: string;
  isPortfolio: boolean;
  /** The full portfolio record (set for portcos) — lets the brief reuse the
   *  PortCo profile sheet with all its sections. */
  portfolioCompany?: PortfolioCompany;
  portfolioSector?: string;
  website?: string;
  industry?: string;
  /** Everyone related to the company, tagged by relationship + deduped. */
  people: RelatedPerson[];
  /** Count of genuinely-known people (works-here / intro / target). */
  networkCount: number;
  signals: FeedCard[]; // newest first
  signalCount: number;
  /** Engagement history from the portfolio record. */
  events: PortfolioEvent[];
  introductions: PortfolioIntro[];
  lastActivityTs: number;
  competitors: string[]; // other companies in the same segment (filled in pass 2)
  /** Best opportunity score across this company's signals (0–100). */
  opportunity: number;
  momentum: MomentumScore;
}

export function normCompany(s?: string): string {
  return (s || "").trim().toLowerCase();
}

// Signal categories + generic placeholders that leak into the `company` field
// (e.g. an awareness item with no real company, or the model echoing a category).
// These are NOT real entities — keep them out of the directory entirely so they
// don't pollute the index, competitor radar, or people lists.
const JUNK_COMPANIES = new Set([
  "funding/m&a",
  "product/milestone",
  "executive movement",
  "thought leadership",
  "partnership/customer win",
  "crisis/regulatory",
  "industry trend",
  "personal milestone",
  "industry",
  "industry update",
  "network",
  "signal",
  "email",
  "company page",
  "n/a",
  "none",
  "unknown",
]);

function isJunkCompany(key: string): boolean {
  return !key || JUNK_COMPANIES.has(key);
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

// Company domain from a person's email (first address), "" for free providers.
function emailDomainOf(email?: string): string {
  const first = (email || "").split(/[;,]/)[0].trim().toLowerCase();
  const at = first.indexOf("@");
  if (at < 0) return "";
  const d = first.slice(at + 1).trim();
  return !d || FREE_EMAIL_DOMAINS.has(d) ? "" : d;
}

// Last-resort logo domain from the company name (e.g. "Salesforce" → salesforce.com).
// Marked low-confidence: good enough to try Clearbit, never trusted for a favicon.
function guessDomain(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(inc|llc|ltd|corp|co|company|technologies|labs?|holdings)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
  return slug ? `${slug}.com` : "";
}

// Lower = higher priority when the same person arrives via multiple paths.
const REL_PRIORITY: Record<Relationship, number> = {
  "works-here": 0,
  intro: 1,
  target: 2,
  team: 3,
  signal: 4,
};

export const RELATIONSHIP_LABEL: Record<Relationship, string> = {
  "works-here": "Works here",
  intro: "Intro",
  target: "Target",
  team: "Team",
  signal: "In a signal",
};

// Category → sentiment weight for the momentum read. Positive business events
// lift it; crisis/regulatory drags it; movement/trends are mildly positive.
const CATEGORY_SENTIMENT: Record<string, number> = {
  "Funding/M&A": 1,
  "Product/Milestone": 0.9,
  "Partnership/Customer Win": 0.9,
  "Thought Leadership": 0.4,
  "Industry Trend": 0.3,
  "Executive Movement": 0.3,
  "Personal Milestone": 0.2,
  "Crisis/Regulatory": -1.5,
};

const DAY = 86_400_000;

function shortDate(d?: string): string {
  const t = Date.parse(d || "");
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function momentumFor(signals: FeedCard[], networkCount: number, now: number): MomentumScore {
  const sentiment = (c: FeedCard) =>
    c.category && c.category in CATEGORY_SENTIMENT ? CATEGORY_SENTIMENT[c.category] : 0.2;

  let recent = 0; // last 30d
  let prior = 0; // 30–60d ago
  let recentCount = 0;
  const cats = new Set<string>();
  for (const s of signals) {
    if (!s.sortTs) continue;
    const age = now - s.sortTs;
    if (age < 30 * DAY) {
      recent += sentiment(s);
      recentCount += 1;
      if (s.category) cats.add(s.category);
    } else if (age < 60 * DAY) {
      prior += sentiment(s);
    }
  }

  // Base 50, lifted by recent sentiment and a small bonus for network depth.
  const raw = 50 + recent * 9 + Math.min(networkCount, 5) * 2;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const trend = Math.round((recent - prior) * 9);

  const drivers: string[] = [];
  if (recentCount > 0) drivers.push(`${recentCount} signal${recentCount !== 1 ? "s" : ""} in 30d`);
  else drivers.push("No signals in the last 30 days");
  for (const c of cats) {
    if ((CATEGORY_SENTIMENT[c] ?? 0) >= 0.9) drivers.push(c);
    else if ((CATEGORY_SENTIMENT[c] ?? 0) < 0) drivers.push(`⚠ ${c}`);
  }
  if (networkCount > 0)
    drivers.push(`${networkCount} known ${networkCount !== 1 ? "people" : "person"}`);

  return { score, trend, drivers: drivers.slice(0, 4) };
}

export interface CompanyDirectoryInput {
  contacts: Contact[];
  portfolio: PortfolioCompany[];
  targets: TargetLead[];
  feed: FeedCard[];
  /** Injected current time (loader passes Date.now()); pure-fn friendly. */
  now: number;
}

// Build the per-company directory from all evidence. Companies are seeded from
// portfolio rows, contacts, intros, targets, and signals — whichever mention them.
export function buildCompanyDirectory(input: CompanyDirectoryInput): CompanyIntel[] {
  const { contacts, portfolio, targets, feed, now } = input;
  const map = new Map<string, CompanyIntel>();
  // Raw (pre-dedup) people per company key — collapsed in the rollup pass.
  const rawPeople = new Map<string, RelatedPerson[]>();

  const ensure = (rawName: string): CompanyIntel | null => {
    const name = (rawName || "").trim();
    const key = normCompany(name);
    if (isJunkCompany(key)) return null;
    let e = map.get(key);
    if (!e) {
      e = {
        name,
        key,
        segment: "Other",
        isPortfolio: false,
        people: [],
        networkCount: 0,
        signals: [],
        signalCount: 0,
        events: [],
        introductions: [],
        lastActivityTs: 0,
        competitors: [],
        opportunity: 0,
        momentum: { score: 0, trend: 0, drivers: [] },
      };
      map.set(key, e);
      rawPeople.set(key, []);
    }
    return e;
  };

  const addPerson = (companyName: string, p: RelatedPerson) => {
    const e = ensure(companyName);
    if (!e) return;
    rawPeople.get(e.key)!.push(p);
  };

  // 1) Portfolio rows — authoritative segment, logo, sector + the company's own
  //    roster, events, and introduction history.
  for (const p of portfolio) {
    const e = ensure(p.name);
    if (!e) continue;
    e.isPortfolio = true;
    e.portfolioCompany = p;
    e.portfolioSector = p.sector;
    e.website = p.website;
    e.segment = bucketOf(p.domain);
    e.events = p.events ?? [];
    e.introductions = p.introductions ?? [];
    if (p.website) {
      try {
        e.logoDomain = new URL(
          p.website.startsWith("http") ? p.website : `https://${p.website}`,
        ).hostname.replace(/^www\./, "");
        e.logoConfident = true;
      } catch {
        /* ignore malformed website */
      }
    }
    for (const emp of p.employees ?? []) {
      addPerson(p.name, {
        id: emp.id,
        name: emp.name,
        title: emp.title,
        email: emp.email,
        relationship: "team",
        linkedinUrl: emp.linkedinUrl,
      });
    }
  }

  // 2) Contacts — who we know at each company (works-here), plus any portfolio
  //    companies they've been introduced to (intro).
  for (const c of contacts) {
    addPerson(c.company, {
      id: c.id,
      name: c.name,
      title: c.title,
      email: c.email,
      relationship: "works-here",
      temperature: c.temperature,
      detail: c.title || undefined,
      linkedinUrl: c.linkedinUrl,
    });
    // Engagements carry a date/source; fall back to the plain intro list.
    const engByPortco = new Map<string, string>();
    for (const eng of c.portCoEngagements ?? []) {
      const when = shortDate(eng.date);
      engByPortco.set(normCompany(eng.portco), when ? `Intro · ${when}` : "Intro");
    }
    for (const portco of c.portCoIntros ?? []) {
      if (normCompany(portco) === normCompany(c.company)) continue; // already works-here
      addPerson(portco, {
        id: c.id,
        name: c.name,
        title: c.title,
        email: c.email,
        relationship: "intro",
        temperature: c.temperature,
        detail: engByPortco.get(normCompany(portco)) || "Introduced",
        linkedinUrl: c.linkedinUrl,
      });
    }
  }

  // 3) Targets — pipeline prospects at the company.
  for (const t of targets) {
    addPerson(t.company, {
      id: t.id,
      name: t.name,
      title: t.title,
      email: t.email,
      relationship: "target",
      detail: [t.stage, t.reasonSurfaced].filter(Boolean).join(" · ") || "In pipeline",
      linkedinUrl: t.linkedinUrl,
    });
  }

  // 4) Signals — the activity stream. Backfill segment/industry/logo, and route
  //    any attributed person to the company as a signal-sourced contact.
  for (const card of feed) {
    const e = ensure(card.company);
    if (!e) continue;
    e.signals.push(card);
    if (!e.isPortfolio && e.segment === "Other" && card.segmentBucket !== "Other") {
      e.segment = card.segmentBucket;
    }
    if (!e.industry && card.industry) e.industry = card.industry;
    if (!e.logoDomain && card.logoDomain) {
      e.logoDomain = card.logoDomain;
      e.logoConfident = true;
    }
    if (card.person) {
      addPerson(card.company, {
        id: `sig-${card.id}`,
        name: card.person,
        title: "",
        email: card.email || "",
        relationship: "signal",
        detail: card.headline,
      });
    }
  }

  // 5) Per-company rollups: dedupe people, sort signals, compute scores.
  for (const e of map.values()) {
    const seen = new Map<string, RelatedPerson>();
    for (const p of rawPeople.get(e.key) ?? []) {
      const k = normCompany(p.email) || normCompany(p.name);
      if (!k) continue;
      const cur = seen.get(k);
      if (!cur || REL_PRIORITY[p.relationship] < REL_PRIORITY[cur.relationship]) {
        seen.set(k, { ...p, detail: p.detail || cur?.detail });
      }
    }
    e.people = [...seen.values()].sort(
      (a, b) =>
        REL_PRIORITY[a.relationship] - REL_PRIORITY[b.relationship] || a.name.localeCompare(b.name),
    );
    e.networkCount = e.people.filter(
      (p) =>
        p.relationship === "works-here" ||
        p.relationship === "intro" ||
        p.relationship === "target",
    ).length;

    // Backfill a logo domain so EVERY company gets a logo. Prefer a real
    // corporate email domain from a related person; else guess from the name
    // (low-confidence → the UI only tries Clearbit, never a stray favicon).
    if (!e.logoDomain) {
      for (const p of e.people) {
        const d = emailDomainOf(p.email);
        if (d) {
          e.logoDomain = d;
          e.logoConfident = true;
          break;
        }
      }
    }
    if (!e.logoDomain) {
      const guess = guessDomain(e.name);
      if (guess) {
        e.logoDomain = guess;
        e.logoConfident = false;
      }
    }

    e.signals.sort((a, b) => b.sortTs - a.sortTs);
    e.signalCount = e.signals.length;
    e.lastActivityTs = e.signals.reduce((m, s) => Math.max(m, s.sortTs || 0), 0);
    e.opportunity = e.signals.reduce((m, s) => Math.max(m, s.insight?.scores.opportunity ?? 0), 0);
    e.momentum = momentumFor(e.signals, e.networkCount, now);
  }

  // 6) Competitor radar — companies sharing a segment that are themselves
  // "notable" (portfolio or signal-bearing), ranked by opportunity then signals.
  const notable = [...map.values()].filter((e) => e.isPortfolio || e.signalCount > 0);
  const bySegment = new Map<string, CompanyIntel[]>();
  for (const e of notable) {
    const arr = bySegment.get(e.segment) ?? [];
    arr.push(e);
    bySegment.set(e.segment, arr);
  }
  for (const e of map.values()) {
    if (e.segment === "Other") continue; // "Other" is a catch-all, not a real peer set
    const peers = (bySegment.get(e.segment) ?? [])
      .filter((p) => p.key !== e.key)
      .sort((a, b) => b.opportunity - a.opportunity || b.signalCount - a.signalCount)
      .slice(0, 6)
      .map((p) => p.name);
    e.competitors = peers;
  }

  return [...map.values()];
}
