/**
 * Phase 4.4 — Ecosystem discovery (pure).
 * Thesis-keyword match for Form D / USPTO / extract subjects outside the roster.
 */

export interface RadarCandidate {
  name: string;
  domain?: string;
  evidenceText: string;
  source: "form_d" | "uspto" | "extract" | "other";
  sourceUrl?: string;
}

export interface RadarProposal {
  name: string;
  domain?: string;
  relationship: "sourced";
  matchedKeywords: string[];
  source: RadarCandidate["source"];
  sourceUrl?: string;
  why: string;
}

/** Default deep-tech thesis keywords (overridden by Signal Config topics when wired). */
export const DEFAULT_THESIS_KEYWORDS: string[] = [
  "artificial intelligence",
  "machine learning",
  "cybersecurity",
  "security",
  "data infrastructure",
  "semiconductor",
  "silicon",
  "robotics",
  "autonomous",
  "quantum",
  "supply chain",
  "climate",
  "defense",
  "enterprise saas",
  "developer tools",
  "infrastructure",
];

function norm(s: string): string {
  return (s || "").trim().toLowerCase();
}

export function matchThesisKeywords(
  text: string,
  keywords: string[] = DEFAULT_THESIS_KEYWORDS,
): string[] {
  const hay = norm(text);
  if (!hay) return [];
  const hits: string[] = [];
  for (const k of keywords) {
    const needle = norm(k);
    if (needle.length < 3) continue;
    if (hay.includes(needle)) hits.push(k);
  }
  return hits;
}

/**
 * Propose NEW TO RADAR entities: thesis match + not already in the roster.
 */
export function proposeRadarEntities(
  candidates: RadarCandidate[],
  existingNames: Set<string>,
  keywords: string[] = DEFAULT_THESIS_KEYWORDS,
): RadarProposal[] {
  const out: RadarProposal[] = [];
  const seen = new Set<string>();

  for (const c of candidates) {
    const name = (c.name || "").trim();
    if (!name || name.length < 2) continue;
    const key = norm(name);
    if (existingNames.has(key) || seen.has(key)) continue;
    const matched = matchThesisKeywords(
      `${name} ${c.evidenceText}`,
      keywords,
    );
    if (matched.length === 0) continue;
    seen.add(key);
    out.push({
      name,
      domain: c.domain,
      relationship: "sourced",
      matchedKeywords: matched.slice(0, 5),
      source: c.source,
      sourceUrl: c.sourceUrl,
      why: `Thesis match (${matched.slice(0, 3).join(", ")}) via ${c.source}`,
    });
  }
  return out;
}
