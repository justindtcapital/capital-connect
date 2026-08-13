/**
 * Phase 2 — trust gates (pure). Run after scoring inputs exist; outcomes
 * decide whether a card reaches the feed, needs review, or is withheld.
 */

export type GateOutcome = "pass" | "needs_review" | "hold" | "withhold";

export interface GateResult {
  outcome: GateOutcome;
  reasons: string[];
}

export interface GateInput {
  resolveConfidence: number;
  resolveRung: string;
  attributionVerified?: boolean;
  companyMismatch?: boolean;
  independentSources: number;
  hasIntelEvidence: boolean;
  noveltyClass: "new" | "update" | "confirmation" | "recycled";
}

export interface GateConfig {
  /** Below this resolve confidence → needs_review. */
  minResolveConfidence: number;
  /** Hold thin stories this many hours (display uses badge; feed filters hold). */
  holdHoursWithoutCorroboration: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  minResolveConfidence: 0.7,
  holdHoursWithoutCorroboration: 24,
};

/**
 * Structural trust gate. Wrongness should be hard to ship.
 *
 * - resolveConfidence < 0.7 or rung ambiguous → needs_review
 * - companyMismatch on person attribution → needs_review
 * - zero independent Tier A/B and no intel → hold
 * - novelty recycled → withhold
 * - else → pass
 */
export function gateSignal(
  s: GateInput,
  cfg: GateConfig = DEFAULT_GATE_CONFIG,
): GateResult {
  const reasons: string[] = [];

  if (s.noveltyClass === "recycled") {
    reasons.push("novelty=recycled — attach as evidence, no new card");
    return { outcome: "withhold", reasons };
  }

  if (s.resolveRung === "ambiguous" || s.resolveConfidence < cfg.minResolveConfidence) {
    reasons.push(
      s.resolveRung === "ambiguous"
        ? "resolve rung ambiguous — pick the right company"
        : `resolve confidence ${s.resolveConfidence.toFixed(2)} < ${cfg.minResolveConfidence}`,
    );
  }

  if (s.companyMismatch) {
    reasons.push("CRM employer ≠ story company — attribution unverified");
  }

  if (reasons.length > 0) {
    return { outcome: "needs_review", reasons };
  }

  if (s.independentSources < 1 && !s.hasIntelEvidence) {
    reasons.push(
      `no independent Tier A/B source and no intel — hold ${cfg.holdHoursWithoutCorroboration}h`,
    );
    return { outcome: "hold", reasons };
  }

  if (s.noveltyClass === "confirmation") {
    reasons.push("novelty=confirmation — evidence only (low novelty mult)");
  }

  return { outcome: "pass", reasons: reasons.length ? reasons : ["cleared trust gates"] };
}

/** Badge slugs stamped when gates fire. */
export const GATE_BADGE = {
  needsReview: "NEEDS_REVIEW",
  hold: "HOLD_CORROBORATION",
  withheld: "WITHHELD_RECYCLED",
  updated: "UPDATED",
  disputed: "SOURCES_DISAGREE",
} as const;
