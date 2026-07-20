// Grounded signal scoring + "why it matters / why now" insight.
//
// DESIGN RULE: every number here traces to evidence we actually hold — never an
// LLM guess. No new Gemini call, no schema change: this runs purely over data
// already in the feed (the stored signal), the network contacts, and the
// portfolio. That's what makes a partner able to click a score and see *why*.
//
//   Freshness   = hours since the event (signal dateFound)
//   Network     = how many of YOUR contacts work at the company (who can intro)
//   Competitive = does it land in a portfolio company's space (threat/relevance)
//   Confidence  = source quality (real article/email link vs. a search guess)
//   Opportunity = a transparent weighted blend of the above
//
// Pure functions — safe to run client-side.

import type { Contact, PortfolioCompany } from "@/lib/types";

export type ConfidenceLevel = "High" | "Medium" | "Low";
export type ImpactLevel = "High" | "Medium" | "Low" | "None";
export type NetworkLevel = "Strong" | "Some" | "None";

export interface NetworkContact {
  name: string;
  title: string;
  email: string;
}

export interface SignalScores {
  /** 0–100 blended priority. */
  opportunity: number;
  freshnessHours: number | null;
  freshnessLabel: string;
  network: { count: number; level: NetworkLevel; contacts: NetworkContact[] };
  competitive: { level: ImpactLevel; portcos: string[]; aboutPortco: boolean };
  confidence: { level: ConfidenceLevel; reason: string };
}

export interface SignalInsight {
  scores: SignalScores;
  whyItMatters: string;
  whyNow: string;
  /** Portfolio companies this signal is relevant to (same space, excludes self). */
  suggestedPortcos: string[];
}

// Minimal structural input — a FeedCard satisfies this, but we don't import
// FeedCard here (signal-feed imports US, so importing back would be circular).
export interface ScoreInput {
  company: string;
  segmentBucket: string;
  industry?: string;
  sortTs: number;
  sourceType: string;
  sourceIsSearch?: boolean;
  relevance?: number;
  category?: string;
  summary?: string;
  headline?: string;
  person?: string;
}

// ── Helpers ──────────────────────────────────────────────────────
function norm(s?: string): string {
  return (s || "").trim().toLowerCase();
}

// Local segment bucketer (mirrors signal-feed.bucketOf — duplicated to avoid a
// circular import). Portfolio domains and inferred segments collapse to 4 buckets.
function bucket(s: string): string {
  if (s === "AI" || s === "Data" || s === "Security") return s;
  if (s === "Supply Chain" || s === "Logistics") return "Supply Chain";
  return "Other";
}

// Loose company-name match: normalized equality, or one clearly contains the
// other (guards against "Acme" vs "Acme, Inc."). Avoids matching on stub tokens.
function companyMatch(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length > 3 && y.length > 3) return x.includes(y) || y.includes(x);
  return false;
}

function freshLabel(hrs: number | null): string {
  if (hrs == null) return "—";
  if (hrs < 1) return "<1h";
  if (hrs < 24) return `${Math.round(hrs)}h`;
  const d = Math.round(hrs / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.round(d / 30);
  return `${mo}mo`;
}

const CATEGORY_TIMING: Record<string, string> = {
  "Executive Movement": "new leaders usually reset their tooling stack in their first 60–90 days.",
  "Funding/M&A":
    "fresh capital typically accelerates hiring and buying over the next 1–2 quarters.",
  "Product/Milestone": "a momentum moment — a relevant, value-add touch lands well right now.",
  "Partnership/Customer Win": "new partnerships often open up adjacent needs.",
  "Crisis/Regulatory": "an active situation — timely, genuinely helpful outreach stands out.",
  "Thought Leadership": "they're publicly active on this theme right now.",
  "Industry Trend": "the theme is moving — a point of view is timely.",
  "Personal Milestone": "a personal, no-ask note is well-timed.",
};

// ── Scorer factory ───────────────────────────────────────────────
// Builds indexes once over contacts + portfolio, returns a per-card scorer.
export function makeScorer(
  contacts: Contact[],
  portfolio: PortfolioCompany[],
): (card: ScoreInput) => SignalInsight {
  // company (normalized) → contacts who work there (can make a warm intro).
  const contactsByCompany = new Map<string, NetworkContact[]>();
  for (const c of contacts) {
    const key = norm(c.company);
    if (!key) continue;
    const arr = contactsByCompany.get(key) ?? [];
    arr.push({ name: c.name, title: c.title, email: c.email });
    contactsByCompany.set(key, arr);
  }

  const portfolioNames = new Set(portfolio.map((p) => norm(p.name)));
  // bucket → portfolio company names in that space.
  const portcosByBucket = new Map<string, string[]>();
  for (const p of portfolio) {
    const b = bucket(p.domain);
    const arr = portcosByBucket.get(b) ?? [];
    arr.push(p.name);
    portcosByBucket.set(b, arr);
  }

  const lookupContacts = (company: string): NetworkContact[] => {
    const exact = contactsByCompany.get(norm(company));
    if (exact) return exact;
    // Fall back to a loose scan only when there's no exact hit (keeps it cheap).
    const out: NetworkContact[] = [];
    for (const [key, list] of contactsByCompany) {
      if (companyMatch(company, key)) out.push(...list);
    }
    return out;
  };

  return (card: ScoreInput): SignalInsight => {
    // Freshness ----------------------------------------------------
    const freshnessHours = card.sortTs ? (Date.now() - card.sortTs) / 3_600_000 : null;

    // Network leverage ---------------------------------------------
    const netContacts = lookupContacts(card.company);
    const netCount = netContacts.length;
    const netLevel: NetworkLevel = netCount >= 2 ? "Strong" : netCount === 1 ? "Some" : "None";

    // Competitive / suggested portfolio ----------------------------
    const selfIsPortco = portfolioNames.has(norm(card.company));
    const sameSpace = (portcosByBucket.get(card.segmentBucket) ?? []).filter(
      (n) => !companyMatch(n, card.company),
    );
    const suggestedPortcos = sameSpace.slice(0, 4);
    // Threat reads only on EXTERNAL players moving into a portfolio space; news
    // about our own portfolio company isn't a competitive threat to us.
    const compLevel: ImpactLevel = selfIsPortco
      ? "None"
      : sameSpace.length >= 3
        ? "High"
        : sameSpace.length === 2
          ? "Medium"
          : sameSpace.length === 1
            ? "Low"
            : "None";

    // Confidence (source quality) ----------------------------------
    let confLevel: ConfidenceLevel;
    let confReason: string;
    if (card.sourceIsSearch) {
      confLevel = "Low";
      confReason = "No verified source link — points to a web search.";
    } else if (
      card.sourceType === "PortCo News" ||
      card.sourceType === "Industry News" ||
      card.sourceType === "PortCo Blogs"
    ) {
      confLevel = "High";
      confReason = `Grounded in a real ${card.sourceType.toLowerCase()} link.`;
    } else if (card.sourceType === "LinkedIn") {
      confLevel = "High";
      confReason = "First-party LinkedIn post.";
    } else if (card.sourceType === "Industry Reports" && card.category === "Thought Leadership") {
      // Blog/article cards (e.g. exploded from a link-digest email) carry a
      // real first-party URL — sourceIsSearch was already ruled out above.
      confLevel = "High";
      confReason = "Grounded in a real blog/article link.";
    } else {
      confLevel = "Medium";
      confReason = "Secondary/analysis source.";
    }
    // A high model-relevance recommendation nudges confidence up a notch.
    if (confLevel === "Medium" && (card.relevance ?? 0) >= 8) {
      confLevel = "High";
      confReason += " High attribution relevance.";
    }

    // Opportunity (transparent weighted blend) ---------------------
    const relScore = Math.min(Math.max(card.relevance ?? 4, 0), 10) / 10;
    const freshScore =
      freshnessHours == null
        ? 0.3
        : freshnessHours < 24
          ? 1
          : freshnessHours < 72
            ? 0.8
            : freshnessHours < 168
              ? 0.6
              : freshnessHours < 336
                ? 0.4
                : freshnessHours < 720
                  ? 0.2
                  : 0.05;
    const netScore = netLevel === "Strong" ? 1 : netLevel === "Some" ? 0.6 : 0.15;
    const compScore =
      compLevel === "High" ? 1 : compLevel === "Medium" ? 0.7 : compLevel === "Low" ? 0.4 : 0.1;
    const confScore = confLevel === "High" ? 1 : confLevel === "Medium" ? 0.7 : 0.4;
    const opportunity = Math.round(
      (relScore * 0.3 + freshScore * 0.2 + netScore * 0.25 + compScore * 0.15 + confScore * 0.1) *
        100,
    );

    const scores: SignalScores = {
      opportunity,
      freshnessHours,
      freshnessLabel: freshLabel(freshnessHours),
      network: { count: netCount, level: netLevel, contacts: netContacts.slice(0, 3) },
      competitive: { level: compLevel, portcos: suggestedPortcos, aboutPortco: selfIsPortco },
      confidence: { level: confLevel, reason: confReason },
    };

    // Why it matters (assembled from facts, seeded by the stored justification) -
    const parts: string[] = [];
    const seed = (card.summary || "").trim();
    if (seed) parts.push(seed.endsWith(".") ? seed : `${seed}.`);
    if (selfIsPortco) {
      parts.push("This is one of your portfolio companies.");
    } else if (suggestedPortcos.length > 0) {
      parts.push(
        `Same space as ${suggestedPortcos.slice(0, 3).join(", ")} in your portfolio${
          compLevel === "High" || compLevel === "Medium" ? " — worth watching competitively" : ""
        }.`,
      );
    }
    if (netCount > 0) {
      const lead = netContacts[0];
      const who = lead ? ` incl. ${lead.name}${lead.title ? ` (${lead.title})` : ""}` : "";
      parts.push(
        `You have ${netCount} contact${netCount !== 1 ? "s" : ""} at ${card.company}${who}.`,
      );
    }
    const whyItMatters =
      parts.join(" ") || card.headline || "Recent activity relevant to your network.";

    // Why now (freshness + a category-based timing tendency, phrased honestly) --
    const timing = card.category ? CATEGORY_TIMING[card.category] : undefined;
    const whyNow = [
      scores.freshnessLabel !== "—" ? `${scores.freshnessLabel} ago` : null,
      timing || "recent and relevant to your network.",
    ]
      .filter(Boolean)
      .join(" · ");

    return { scores, whyItMatters, whyNow, suggestedPortcos };
  };
}
