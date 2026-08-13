/**
 * Phase 3 Stage B — per-document extraction schema + validators (pure).
 * LLM proposes; quote-in-document checks dispose. Mirrors validateMagnitude.
 */

import {
  validateEventType,
  type SignalEventType,
} from "@/lib/signal-config";
import { validateMagnitude, type MagnitudeProposal } from "@/lib/materiality";

const ws = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

export interface SubjectCompanyClaim {
  name: string;
  /** Verbatim substring from the document that supports the subject claim. */
  quote: string;
}

export interface ExtractedPerson {
  name: string;
  roleChange?: string;
  quote: string;
}

/** Raw LLM JSON for one document (before validation). */
export interface ExtractProposal {
  subject_companies?: SubjectCompanyClaim[];
  mentioned_companies?: string[];
  event_type?: string;
  magnitude?: MagnitudeProposal | null;
  people?: ExtractedPerson[];
  summary?: string;
  published_claim_date?: string;
}

export interface ValidatedExtract {
  /** Primary story subject (first validated subject claim). */
  subjectCompany: string;
  subjectQuote: string;
  /** Other companies named in the doc (not subjects). */
  mentionedCompanies: string[];
  eventType: SignalEventType;
  eventTypeValid: boolean;
  magnitude: { value: number; unit: string; verbatim: string } | null;
  people: Array<{ name: string; roleChange: string; quote: string }>;
  summary: string;
  publishedClaimDate: string;
  /** Why claims were dropped (inspectable). */
  discarded: string[];
}

/**
 * Subject claim persists ONLY when its quote appears (whitespace-normalized)
 * in the grounded document text and the name token appears in the quote or text.
 */
export function validateSubjectClaim(
  claim: SubjectCompanyClaim | null | undefined,
  groundedText: string,
): { name: string; quote: string } | null {
  if (!claim) return null;
  const name = (claim.name || "").trim();
  const quote = (claim.quote || "").trim();
  if (name.length < 2 || name.length > 120) return null;
  if (quote.length < 2 || quote.length > 240) return null;
  const g = ws(groundedText);
  if (!g.includes(ws(quote))) return null;
  // Name must appear in quote or somewhere in grounded text (guards inventing "Acme").
  const nameWs = ws(name);
  if (!ws(quote).includes(nameWs) && !g.includes(nameWs)) return null;
  return { name, quote };
}

/** Map closed event types to the legacy Signals category labels. */
export function categoryFromEventType(t: SignalEventType): string {
  switch (t) {
    case "funding_round":
    case "acquisition_or_exit":
      return "Funding/M&A";
    case "exec_change":
      return "Executive Movement";
    case "layoffs_restructuring":
    case "regulatory_legal":
    case "security_incident":
      return "Crisis/Regulatory";
    case "product_launch":
      return "Product/Milestone";
    case "major_customer_or_partnership":
      return "Partnership/Customer Win";
    case "strategy_pivot":
      return "Industry Trend";
    default:
      return "Industry Trend";
  }
}

/**
 * Validate a Stage B proposal against grounded document text.
 * Subject vs mentioned is structural: only quote-backed subjects become subjects.
 */
export function validateExtract(
  proposal: ExtractProposal | null | undefined,
  groundedText: string,
): ValidatedExtract | null {
  if (!proposal || !groundedText.trim()) return null;
  const discarded: string[] = [];

  const subjects: Array<{ name: string; quote: string }> = [];
  for (const c of proposal.subject_companies || []) {
    const ok = validateSubjectClaim(c, groundedText);
    if (ok) subjects.push(ok);
    else discarded.push(`subject dropped: ${(c?.name || "").slice(0, 40)}`);
  }
  if (subjects.length === 0) {
    discarded.push("no validated subject_companies");
    return null;
  }

  const mentioned = [
    ...new Set(
      (proposal.mentioned_companies || [])
        .map((n) => (n || "").trim())
        .filter((n) => n.length >= 2)
        .filter((n) => !subjects.some((s) => ws(s.name) === ws(n))),
    ),
  ].slice(0, 12);

  const typeRes = validateEventType(proposal.event_type);
  if (!typeRes.valid) discarded.push(`event_type ${proposal.event_type || "?"} → other`);

  const magnitude = validateMagnitude(proposal.magnitude, groundedText);

  const people: ValidatedExtract["people"] = [];
  for (const p of proposal.people || []) {
    const name = (p.name || "").trim();
    const quote = (p.quote || "").trim();
    if (!name || quote.length < 2) {
      discarded.push(`person dropped: ${name || "?"}`);
      continue;
    }
    if (!ws(groundedText).includes(ws(quote))) {
      discarded.push(`person quote missing: ${name}`);
      continue;
    }
    people.push({
      name,
      roleChange: (p.roleChange || "").trim(),
      quote,
    });
  }

  return {
    subjectCompany: subjects[0].name,
    subjectQuote: subjects[0].quote,
    mentionedCompanies: mentioned,
    eventType: typeRes.type,
    eventTypeValid: typeRes.valid,
    magnitude,
    people: people.slice(0, 8),
    summary: (proposal.summary || "").trim().slice(0, 800),
    publishedClaimDate: (proposal.published_claim_date || "").trim().slice(0, 32),
    discarded,
  };
}

/** JSON schema sketch embedded in the Stage B system prompt. */
export const EXTRACT_JSON_SHAPE = `{
  "documents": [
    {
      "url": "",
      "subject_companies": [{"name": "", "quote": ""}],
      "mentioned_companies": [""],
      "event_type": "funding_round | acquisition_or_exit | exec_change | layoffs_restructuring | product_launch | regulatory_legal | major_customer_or_partnership | strategy_pivot | security_incident | other",
      "magnitude": {"value": 0, "unit": "usd|people|percent", "quote": ""} | null,
      "people": [{"name": "", "role_change": "", "quote": ""}],
      "summary": "",
      "published_claim_date": "YYYY-MM-DD"
    }
  ]
}`;
