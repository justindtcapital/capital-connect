// Quality gate for "reach out to X" signal recommendations.
//
// Contract (quality over quantity — an empty suggestion list is a fine
// outcome):
//  - A story about a portfolio company must NEVER suggest outreach to anyone
//    employed at ANY portfolio company (their own or a sibling's). Portfolio
//    news routes to the external network only.
//  - A portfolio-company story additionally requires a CRM-verified recipient:
//    if the suggested email/name doesn't resolve to a contact, we can't rule
//    out that they work at a portco, so the suggestion is dropped.
//  - Every suggestion must clear a minimum grounded relevance; weaker ones are
//    demoted to awareness (the story is kept, the outreach suggestion is not).
//
// Applied on BOTH the scan write path (gemini.functions) and the stored-signal
// read path, so legacy rows written before the gate are cleaned up on display.
//
// Pure functions — safe client-side, fixture-testable (same design rule as
// attribution-score.ts).

import { companiesMatch, type AttributionContact } from "@/lib/attribution-score";

/** Grounded relevance (0–10) below which a recommendation is demoted. */
export const MIN_OUTREACH_RELEVANCE = 6;

export interface OutreachVerdict {
  ok: boolean;
  /** Human-readable demotion reason (audit trail / ops log). */
  reason?: string;
}

/** True when `company` loosely matches any portfolio-company name. */
export function matchesAnyPortco(
  company: string | undefined,
  portcoNames: Iterable<string>,
): boolean {
  if (!company) return false;
  for (const p of portcoNames) if (companiesMatch(p, company)) return true;
  return false;
}

export function outreachVerdict(args: {
  /** CRM contact resolved from the rec (undefined = not found / ambiguous). */
  contact?: AttributionContact;
  /** Company the story is about (the rec's `company`). */
  storyCompany: string;
  /** Relevance 0–10 (grounded where available, LLM prior on legacy rows). */
  relevance: number;
  /** Portfolio-company names (any casing; matched loosely). */
  portcoNames: Iterable<string>;
}): OutreachVerdict {
  if (matchesAnyPortco(args.storyCompany, args.portcoNames)) {
    if (!args.contact) {
      return {
        ok: false,
        reason: "portfolio story — recipient not verified in CRM, can't rule out a portco employer",
      };
    }
    if (matchesAnyPortco(args.contact.company, args.portcoNames)) {
      return {
        ok: false,
        reason: `portfolio story — ${args.contact.name || "recipient"} works at a portfolio company (${args.contact.company})`,
      };
    }
  }
  if ((args.relevance ?? 0) < MIN_OUTREACH_RELEVANCE) {
    return {
      ok: false,
      reason: `below outreach quality bar (${args.relevance ?? 0}/10 < ${MIN_OUTREACH_RELEVANCE})`,
    };
  }
  return { ok: true };
}
