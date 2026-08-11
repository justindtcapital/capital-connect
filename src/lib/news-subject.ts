// Subject-line publisher extraction for NEWS@ / forwarded research digests.
// Pure — safe to unit-test without Gmail.
//
// NEWS@ mail is almost always a human forward. The From: domain (Dell, DTC,
// etc.) is provenance, NOT the news subject. Prefer the research house named
// in the subject ("FW: 451 Research: Siemens AG, …").

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

/**
 * Pull the research/publisher house from a forwarded digest subject.
 * Returns null when we can't confidently name a publisher (caller should
 * avoid falling back to the forwarder's email domain for NEWS@).
 */
export function researchPublisherFromSubject(subject: string): ResearchPublisher | null {
  const s = stripReplyForwardPrefixes(subject);
  if (!s) return null;

  for (const k of KNOWN_PUBLISHERS) {
    if (k.re.test(s)) return { name: k.name, domain: k.domain };
  }

  // Generic "Publisher Name: rest…" / "Publisher Name — rest…"
  // Keep the left side short and free of person-name commas.
  const m = s.match(/^([A-Z0-9][\w&.''' +-]{0,48}?)\s*[:—–-]\s+\S/);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, " ").trim();
  if (!name || /,/.test(name)) return null;
  if (/^(internal|confidential|urgent|update|notes?|fyi)\b/i.test(name)) return null;
  // Require at least one letter and look like a title, not a full sentence.
  if (!/[A-Za-z]/.test(name) || name.split(/\s+/).length > 6) return null;

  const domain = guessDomainFromCompanyName(name);
  if (!domain) return null;
  return { name, domain };
}
