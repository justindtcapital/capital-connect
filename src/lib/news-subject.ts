// Subject-line publisher extraction for NEWS@ / forwarded research digests.
// Pure — safe to unit-test without Gmail.
//
// NEWS@ mail is almost always a human forward. The From: domain (employer /
// mailbox owner) is provenance, NOT the news subject. Prefer the research
// house named in the subject ("FW: Publisher: EntityA, EntityB, …"), and
// explode the listed companies/themes into their own feed cards.

import { guessDomainFromCompanyName } from "./domain-utils";

/** Well-known research / analyst / trade-press houses we see in NEWS@ subjects. */
const KNOWN_PUBLISHERS: Array<{ re: RegExp; name: string; domain: string }> = [
  { re: /\b451\s*Research\b/i, name: "451 Research", domain: "451research.com" },
  { re: /\bGartner\b/i, name: "Gartner", domain: "gartner.com" },
  { re: /\bForrester\b/i, name: "Forrester", domain: "forrester.com" },
  { re: /\bIDC\b/, name: "IDC", domain: "idc.com" },
  { re: /\bCB\s*Insights\b/i, name: "CB Insights", domain: "cbinsights.com" },
  { re: /\bPitchBook\b/i, name: "PitchBook", domain: "pitchbook.com" },
  { re: /\bS&P\s*Global\b/i, name: "S&P Global", domain: "spglobal.com" },
  { re: /\bMoody'?s\b/i, name: "Moody's", domain: "moodys.com" },
  { re: /\bMorningstar\b/i, name: "Morningstar", domain: "morningstar.com" },
  { re: /\bCrunchbase\b/i, name: "Crunchbase", domain: "crunchbase.com" },
  { re: /\bTechCrunch\b/i, name: "TechCrunch", domain: "techcrunch.com" },
  { re: /\bAxios\b/i, name: "Axios", domain: "axios.com" },
  { re: /\bBloomberg\b/i, name: "Bloomberg", domain: "bloomberg.com" },
  { re: /\bReuters\b/i, name: "Reuters", domain: "reuters.com" },
  { re: /\bThe\s+Information\b/i, name: "The Information", domain: "theinformation.com" },
  { re: /\bMeritech\b/i, name: "Meritech", domain: "meritechcapital.com" },
  { re: /\bBessemer\b/i, name: "Bessemer", domain: "bvp.com" },
  { re: /\ba16z\b|\bAndreessen\s+Horowitz\b/i, name: "a16z", domain: "a16z.com" },
];

/** Strip repeated FW:/RE:/Fwd: prefixes. */
export function stripReplyForwardPrefixes(subject: string): string {
  return (subject || "").replace(/^((FW|Fwd|RE|Re|AW|SV)\s*:\s*)+/gi, "").trim();
}

export interface ResearchPublisher {
  name: string;
  domain: string;
}

export interface ResearchSubjectParse {
  publisher: ResearchPublisher | null;
  /** Companies / themes after "Publisher: A, B, C" (empty when none). */
  entities: string[];
}

/**
 * Pull the research/publisher house from a forwarded digest subject.
 * Returns null when we can't confidently name a publisher (caller should
 * avoid falling back to the forwarder's email domain for NEWS@).
 */
export function researchPublisherFromSubject(subject: string): ResearchPublisher | null {
  return parseResearchSubject(subject).publisher;
}

/**
 * Parse a NEWS@ research subject into publisher + listed entities.
 * Works for any "Publisher: A, B, C" subject — known houses (Gartner, 451, …)
 * get a stable domain; unknown labels still explode the entity list.
 */
export function parseResearchSubject(subject: string): ResearchSubjectParse {
  const s = stripReplyForwardPrefixes(subject);
  if (!s) return { publisher: null, entities: [] };

  let publisher: ResearchPublisher | null = null;
  let remainder = "";

  for (const k of KNOWN_PUBLISHERS) {
    if (!k.re.test(s)) continue;
    publisher = { name: k.name, domain: k.domain };
    // Prefer "Publisher: rest" / "Publisher — rest"; else drop the publisher token.
    const afterColon = s.match(new RegExp(`${k.re.source}\\s*[:—–-]\\s*(.+)$`, "i"));
    if (afterColon?.[1]) remainder = afterColon[1].trim();
    break;
  }

  if (!publisher) {
    const m = s.match(/^([A-Z0-9][\w&.''' +-]{0,48}?)\s*[:—–-]\s+(\S.*)$/);
    if (m) {
      const name = m[1].replace(/\s+/g, " ").trim();
      if (
        name &&
        !/,/.test(name) &&
        !/^(internal|confidential|urgent|update|notes?|fyi)\b/i.test(name) &&
        /[A-Za-z]/.test(name) &&
        name.split(/\s+/).length <= 6
      ) {
        const domain = guessDomainFromCompanyName(name) || "";
        publisher = { name, domain };
        remainder = m[2].trim();
      }
    }
  }

  // Still no remainder, but the subject looks like "Label: A, B, C" — explode
  // the list even when the left-hand label isn't a known research house.
  if (!remainder && /[,;|·]/.test(s)) {
    const m = s.match(/^([^,:;|·\n]{2,60}?)\s*[:—–-]\s+(.+)$/);
    if (m && /[,;|·]/.test(m[2])) {
      const name = m[1].replace(/\s+/g, " ").trim();
      if (name && !/^(internal|confidential|fw|re|fwd)\b/i.test(name)) {
        if (!publisher) {
          publisher = { name, domain: guessDomainFromCompanyName(name) || "" };
        }
        remainder = m[2].trim();
      }
    }
  }

  const entities = splitResearchEntities(remainder);
  return { publisher, entities };
}

/** Split a subject-list remainder into entities (companies / themes). */
export function splitResearchEntities(remainder: string): string[] {
  const raw = (remainder || "").trim();
  if (!raw) return [];

  // Comma / semicolon / " · " / " | " lists. Keep multi-word names intact.
  const parts = raw
    .split(/\s*[,;|·]\s*|\s+\/\s+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    // Drop leftover reply crumbs / confidentiality stamps.
    if (/^(internal use|confidential|fw|re|fwd)\b/i.test(p)) continue;
    if (p.length < 2 || p.length > 80) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
