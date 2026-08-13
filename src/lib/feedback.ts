/**
 * Phase 0 — Signal feedback types + validation (pure, client-safe).
 * Verdicts land in the Signal Feedback tab Action column; feature vectors
 * freeze company / source / rank for weekly precision measurement.
 */

export type FeedbackVerdict =
  | "useful"
  | "not_useful"
  | "wrong_company"
  | "wrong_person"
  | "duplicate"
  | "already_knew"
  | "not_material"
  | "follow_more"
  | "follow_less"
  | "bad_source";

/** Interaction actions (WS5) plus partner verdicts (Phase 0). */
export type FeedbackAction =
  | "rendered"
  | "expanded"
  | "clicked_source"
  | "actioned"
  | "dismissed"
  | "ignored"
  | FeedbackVerdict;

export const FEEDBACK_VERDICTS: FeedbackVerdict[] = [
  "useful",
  "not_useful",
  "wrong_company",
  "wrong_person",
  "duplicate",
  "already_knew",
  "not_material",
  "follow_more",
  "follow_less",
  "bad_source",
];

/** Quick-tap buttons shown on every expanded card. */
export const PRIMARY_VERDICTS: Array<{ value: FeedbackVerdict; label: string }> = [
  { value: "useful", label: "Useful" },
  { value: "not_useful", label: "Not useful" },
  { value: "already_knew", label: "Already knew" },
];

/** Extra verdicts behind the "More" menu. */
export const MORE_VERDICTS: Array<{ value: FeedbackVerdict; label: string }> = [
  { value: "duplicate", label: "Duplicate" },
  { value: "not_material", label: "Not material" },
  { value: "wrong_company", label: "Wrong company" },
  { value: "wrong_person", label: "Wrong person" },
  { value: "bad_source", label: "Bad source" },
  { value: "follow_more", label: "Follow on radar" },
  { value: "follow_less", label: "Ignore / follow less" },
];

export interface SignalFeedback {
  signalId: string;
  eventId?: string;
  verdict: FeedbackVerdict;
  user: string;
  atIso: string;
  company: string;
  sourceType: string;
  rankScore?: number | null;
  sourceHost?: string;
  /** Free-text correction for wrong_company / wrong_person. */
  correction?: string;
}

export function isFeedbackVerdict(v: string): v is FeedbackVerdict {
  return (FEEDBACK_VERDICTS as string[]).includes(v);
}

export function isFeedbackAction(v: string): v is FeedbackAction {
  return (
    isFeedbackVerdict(v) ||
    ["rendered", "expanded", "clicked_source", "actioned", "dismissed", "ignored"].includes(v)
  );
}

/** Verdicts that need a one-field "which one?" correction. */
export function verdictNeedsCorrection(v: FeedbackVerdict): boolean {
  return v === "wrong_company" || v === "wrong_person";
}

/**
 * Map Phase 0 verdicts onto the older intel Signal Verdicts tab names
 * (dual-write for backward compatibility).
 */
export function toIntelVerdict(
  v: FeedbackVerdict,
):
  | "useful"
  | "not_useful"
  | "already_knew"
  | "incorrect_company"
  | "incorrect_interpretation"
  | "too_early"
  | "duplicate"
  | "followed_up"
  | null {
  switch (v) {
    case "useful":
      return "useful";
    case "not_useful":
      return "not_useful";
    case "already_knew":
      return "already_knew";
    case "wrong_company":
      return "incorrect_company";
    case "wrong_person":
      return "incorrect_interpretation";
    case "duplicate":
      return "duplicate";
    case "not_material":
      return "incorrect_interpretation";
    case "follow_more":
    case "follow_less":
      return "followed_up";
    case "bad_source":
      return "incorrect_interpretation";
    default:
      return null;
  }
}

/** Hostname for weekly histograms (no www). */
export function sourceHostFromUrl(raw?: string | null): string {
  const s = (raw || "").trim();
  if (!s || !/^https?:\/\//i.test(s)) return "";
  try {
    return new URL(s).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function validateSignalFeedback(
  input: Partial<SignalFeedback>,
): { ok: true; value: SignalFeedback } | { ok: false; error: string } {
  if (!input.signalId?.trim()) return { ok: false, error: "signalId required" };
  if (!input.verdict || !isFeedbackVerdict(input.verdict)) {
    return { ok: false, error: "invalid verdict" };
  }
  if (verdictNeedsCorrection(input.verdict) && !(input.correction || "").trim()) {
    return { ok: false, error: "correction required for wrong_company / wrong_person" };
  }
  return {
    ok: true,
    value: {
      signalId: input.signalId.trim(),
      eventId: input.eventId?.trim() || undefined,
      verdict: input.verdict,
      user: (input.user || "unknown").trim() || "unknown",
      atIso: input.atIso || new Date().toISOString(),
      company: (input.company || "").trim(),
      sourceType: (input.sourceType || "").trim(),
      rankScore: input.rankScore ?? null,
      sourceHost: input.sourceHost || undefined,
      correction: (input.correction || "").trim() || undefined,
    },
  };
}
