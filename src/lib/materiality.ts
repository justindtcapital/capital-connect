// WS2 — materiality scoring & the final ranking formula (pure functions).
//
// Relevance answers "is this connected to our network?"; materiality answers
// "does this objectively matter?" — scored independently and multiplied in:
//
//   rank = 100 × (materialityAdj/10)^α × (relevance/10)^β × actionability^γ
//
// Suppression rule: materialityAdj below the config floor caps rank regardless
// of relevance — a beloved contact's routine minor release must not surface.
//
// Same design rule as attribution-score.ts / signal-strength.ts: every number
// decomposes into evidence actually held, and the parts are stored so any
// score is reconstructible from its own row. LLMs may PROPOSE an event type or
// a magnitude; the validators here dispose. A magnitude that does not appear
// verbatim in grounded source text is discarded (the event survives).

import type { SignalConfig, SignalEventType } from "@/lib/signal-config";

export interface ScorePart {
  name: string;
  value: number;
  why: string;
}

// ── Magnitude validation (LLM proposes → verbatim check disposes) ─

export interface MagnitudeProposal {
  value: number;
  unit: string;
  /** The exact substring of the grounded source text the number came from. */
  quote: string;
}

export interface ValidatedMagnitude {
  value: number;
  unit: string;
  verbatim: string;
}

const ws = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

/** Parse a money quote ("$20M", "€1.5 billion") to absolute units. */
export function parseMoneyQuote(quote: string): number | null {
  const m = (quote || "").match(
    /[$€£]\s?(\d+(?:[.,]\d+)?)\s*(billion|million|thousand|bn|b|mm|m|k)?\b/i,
  );
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || "").toLowerCase();
  const mult = unit.startsWith("b")
    ? 1e9
    : unit === "k" || unit === "thousand"
      ? 1e3
      : unit
        ? 1e6
        : 1;
  return Math.round(n * mult);
}

/** Parse a people-count quote ("1,200 employees", "300 jobs"). */
export function parseCountQuote(quote: string): number | null {
  const m = (quote || "").match(/(\d{1,3}(?:,\d{3})+|\d+)\s*(?:%|percent)?/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * A proposed magnitude persists ONLY when (a) its quote appears verbatim in the
 * grounded source text and (b) the number parsed from the quote matches the
 * proposed value. Otherwise the magnitude is discarded and the event kept.
 */
export function validateMagnitude(
  proposal: MagnitudeProposal | null | undefined,
  groundedText: string,
): ValidatedMagnitude | null {
  if (!proposal || !proposal.quote || !Number.isFinite(proposal.value)) return null;
  const quote = proposal.quote.trim();
  if (quote.length < 2 || quote.length > 120) return null;
  if (!ws(groundedText).includes(ws(quote))) return null;
  const unit = (proposal.unit || "").trim().toLowerCase();
  const parsed = unit === "people" || unit === "jobs" || unit === "percent"
    ? parseCountQuote(quote)
    : parseMoneyQuote(quote);
  if (parsed == null) return null;
  // The quote must support the proposed value (±1% for rounding).
  const tol = Math.max(1, Math.abs(parsed) * 0.01);
  if (Math.abs(parsed - proposal.value) > tol) return null;
  return { value: proposal.value, unit: unit || "usd", verbatim: quote };
}

// ── Materiality ──────────────────────────────────────────────────

export interface MaterialityContext {
  eventType: SignalEventType;
  magnitude: ValidatedMagnitude | null;
  isPortco: boolean;
  isWatch: boolean;
  /** Current ATS open-role count from the intel series (null = unknown). */
  atsOpenRoles: number | null;
  /** WS3 — intel-engine corroboration multiplier (1 = none). */
  corroborationMultiplier?: number;
}

function bracketFactor(brackets: Array<[number, number]>, value: number): number {
  for (const [min, factor] of brackets) if (value >= min) return factor;
  return 1;
}

function sizeBracket(
  atsOpenRoles: number | null,
  cfg: SignalConfig,
): "small" | "mid" | "large" {
  if (atsOpenRoles == null || atsOpenRoles <= cfg.magnitudeNorm.smallCompanyMaxRoles)
    return "small";
  if (atsOpenRoles >= cfg.magnitudeNorm.largeCompanyMinRoles) return "large";
  return "mid";
}

/**
 * Materiality 0–10 = taxonomy prior × magnitude factor × corroboration
 * multiplier. Magnitude factors are normalized RELATIVE TO THE COMPANY —
 * a $20M raise for a large portco scores low, the same raise for a small
 * watchlist company scores high (brief WS2.2).
 */
export function scoreMateriality(
  ctx: MaterialityContext,
  cfg: SignalConfig,
): { materiality: number; parts: ScorePart[] } {
  const parts: ScorePart[] = [];
  const t = cfg.eventTaxonomy[ctx.eventType] || cfg.eventTaxonomy.other;
  parts.push({ name: "type prior", value: t.prior, why: `${t.label} base prior` });

  let factor = 1;
  const bracket = sizeBracket(ctx.atsOpenRoles, cfg);
  if (ctx.magnitude && ctx.eventType === "funding_round" && ctx.magnitude.unit === "usd") {
    factor = bracketFactor(cfg.magnitudeNorm.funding[bracket], ctx.magnitude.value);
    parts.push({
      name: "magnitude",
      value: factor,
      why: `"${ctx.magnitude.verbatim}" vs ${bracket} company (${
        ctx.atsOpenRoles == null ? "no ATS data" : `${ctx.atsOpenRoles} open roles`
      })`,
    });
  } else if (
    ctx.magnitude &&
    ctx.eventType === "layoffs_restructuring" &&
    (ctx.magnitude.unit === "people" || ctx.magnitude.unit === "jobs")
  ) {
    const proxyHeadcount = Math.max(
      (ctx.atsOpenRoles ?? 0) * cfg.magnitudeNorm.postingToHeadcountRatio,
      ctx.magnitude.value,
      20,
    );
    const pct = ctx.magnitude.value / proxyHeadcount;
    factor = bracketFactor(cfg.magnitudeNorm.layoffPct, pct);
    parts.push({
      name: "magnitude",
      value: factor,
      why: `"${ctx.magnitude.verbatim}" ≈ ${(pct * 100).toFixed(0)}% of proxy headcount ${proxyHeadcount} (open roles × ${cfg.magnitudeNorm.postingToHeadcountRatio})`,
    });
  } else if (ctx.magnitude) {
    parts.push({ name: "magnitude", value: 1, why: `"${ctx.magnitude.verbatim}" recorded, no norm rule for ${ctx.eventType}` });
  }

  const corr = ctx.corroborationMultiplier ?? 1;
  if (corr !== 1) {
    parts.push({ name: "intel corroboration", value: corr, why: "independent intel-engine evidence for the same development" });
  }

  const materiality = Math.min(10, Math.round(t.prior * factor * corr * 10) / 10);
  return { materiality, parts };
}

/** WS4 — surprise modulation: materialityAdj = m × (base + span × surpriseNorm).
 *  surpriseNorm null (no baseline yet) leaves materiality unchanged. */
export function applySurprise(
  materiality: number,
  surpriseNorm: number | null,
  cfg: SignalConfig,
): { materialityAdj: number; part: ScorePart } {
  if (surpriseNorm == null) {
    return {
      materialityAdj: materiality,
      part: { name: "surprise", value: 1, why: "no cadence baseline — unmodulated" },
    };
  }
  const s = Math.min(1, Math.max(0, surpriseNorm));
  const mult = cfg.surprise.base + cfg.surprise.span * s;
  return {
    materialityAdj: Math.min(10, Math.round(materiality * mult * 10) / 10),
    part: {
      name: "surprise",
      value: Math.round(mult * 100) / 100,
      why: `cadence surprise ${s.toFixed(2)} → ×(${cfg.surprise.base} + ${cfg.surprise.span}·s)`,
    },
  };
}

// ── Relevance & actionability for events ─────────────────────────

export interface RelevanceContext {
  /** Grounded attribution relevances (0–10) of the event's recommendation rows. */
  recRelevances: number[];
  isPortco: boolean;
  isWatch: boolean;
  /** CRM contacts working at the company. */
  networkContactCount: number;
}

/** Event relevance 0–10: best attributed score when one exists, else a CRM-fact proxy. */
export function eventRelevance(
  ctx: RelevanceContext,
  cfg: SignalConfig,
): { relevance: number; part: ScorePart } {
  const attributed = ctx.recRelevances.filter((r) => Number.isFinite(r) && r > 0);
  if (attributed.length > 0) {
    const best = Math.max(...attributed);
    return {
      relevance: Math.min(10, best),
      part: {
        name: "relevance",
        value: Math.min(10, best),
        why: `best grounded attribution of ${attributed.length} rec${attributed.length === 1 ? "" : "s"}`,
      },
    };
  }
  const p = cfg.ranking.relevanceProxy;
  const [value, why] = ctx.isPortco
    ? [p.portco, "portfolio company"]
    : ctx.isWatch
      ? [p.watch, "competitive-radar watchlist"]
      : ctx.networkContactCount > 0
        ? [p.networked, `${ctx.networkContactCount} network contact(s) at company`]
        : [p.base, "no attribution, no network presence"];
  return { relevance: value, part: { name: "relevance", value, why: `proxy: ${why}` } };
}

export interface ActionabilityContext {
  hasContactEmail: boolean;
  hasPrime: boolean;
  /** Days since last touch with the best-known contact (null = never). */
  daysSinceLastContact: number | null;
}

/** Actionability 0–1 — same evidence semantics as attribution-score's component. */
export function eventActionability(
  ctx: ActionabilityContext,
  cfg: SignalConfig,
): { actionability: number; part: ScorePart } {
  const w = cfg.ranking.actionability;
  let v = 0;
  const whys: string[] = [];
  if (ctx.hasContactEmail) {
    v += w.email;
    whys.push("email on file");
  }
  if (ctx.hasPrime) {
    v += w.prime;
    whys.push("prime owner");
  }
  if (ctx.daysSinceLastContact == null || ctx.daysSinceLastContact > w.reengagementGapDays) {
    v += w.reengagement;
    whys.push(
      ctx.daysSinceLastContact == null
        ? "never contacted — fresh opening"
        : `${Math.round(ctx.daysSinceLastContact)}d since last touch`,
    );
  } else {
    v += w.recentTouch;
    whys.push(`recently active (${Math.round(ctx.daysSinceLastContact)}d)`);
  }
  const actionability = Math.min(1, Math.round(v * 100) / 100);
  return {
    actionability,
    part: { name: "actionability", value: actionability, why: whys.join(", ") || "no action evidence" },
  };
}

// ── Final rank ───────────────────────────────────────────────────

export interface RankInput {
  materialityAdj: number; // 0–10
  relevance: number; // 0–10
  actionability: number; // 0–1
}

export interface RankResult {
  /** 0–100 display scale. */
  rank: number;
  /** True when the materiality floor capped the rank. */
  suppressed: boolean;
  parts: ScorePart[];
}

export function rankScore(input: RankInput, cfg: SignalConfig): RankResult {
  const r = cfg.ranking;
  const m = Math.min(1, Math.max(0, input.materialityAdj / 10));
  const rel = Math.min(1, Math.max(0, input.relevance / 10));
  const act = Math.min(1, Math.max(0, input.actionability));
  let rank = Math.round(100 * Math.pow(m, r.alpha) * Math.pow(rel, r.beta) * Math.pow(act, r.gamma));
  const parts: ScorePart[] = [
    { name: "materialityAdj", value: input.materialityAdj, why: `^α=${r.alpha}` },
    { name: "relevance", value: input.relevance, why: `^β=${r.beta}` },
    { name: "actionability", value: input.actionability, why: `^γ=${r.gamma}` },
  ];
  // Below the materiality floor an event is ALWAYS suppressed (capped and
  // flagged) — relevance cannot rescue it, and the feed keeps it out of top-N.
  const suppressed = input.materialityAdj < r.materialityFloor;
  if (suppressed) {
    rank = Math.min(rank, r.floorRankCap);
    parts.push({
      name: "suppression",
      value: r.floorRankCap,
      why: `materialityAdj ${input.materialityAdj} < floor ${r.materialityFloor} — rank capped regardless of relevance`,
    });
  }
  return { rank, suppressed, parts };
}
