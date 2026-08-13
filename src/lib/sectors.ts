/**
 * Canonical sector vocabulary for Targets / Contacts, plus helpers to normalize
 * free-text values and detect job titles that were mistakenly put in Sector.
 */

import { portfolioDomains } from "@/lib/types";

/** Preferred sector labels (Portfolio domains + common extras). */
export const CANONICAL_SECTORS = [
  ...portfolioDomains,
  "Fintech",
  "Healthcare",
  "DevTools",
  "Enterprise",
  "Consumer",
  "Climate",
  "Crypto",
  "Marketplace",
  "Robotics",
  "Other",
] as const;

export type CanonicalSector = (typeof CANONICAL_SECTORS)[number];

/** Lowercased token → canonical sector label. */
const SECTOR_ALIASES: Record<string, string> = {
  // Portfolio domains (aligned with focus-area-utils)
  ai: "AI",
  "a.i.": "AI",
  "a.i": "AI",
  "artificial intelligence": "AI",
  "machine learning": "AI",
  ml: "AI",
  genai: "AI",
  "gen ai": "AI",
  "generative ai": "AI",

  security: "Security",
  cyber: "Security",
  cybersecurity: "Security",
  "cyber security": "Security",
  infosec: "Security",

  data: "Data",
  analytics: "Data",
  "big data": "Data",
  "data analytics": "Data",
  "data infrastructure": "Data",

  cloud: "Cloud",
  infrastructure: "Cloud",
  infra: "Cloud",
  devops: "Cloud",
  saas: "Cloud",
  platform: "Cloud",
  "developer tooling": "Cloud",

  logistics: "Logistics",
  "supply chain": "Supply Chain",
  supplychain: "Supply Chain",

  silicon: "Silicon",
  semiconductor: "Silicon",
  semiconductors: "Silicon",
  chip: "Silicon",
  chips: "Silicon",
  hardware: "Silicon",

  // Extras
  fintech: "Fintech",
  "financial technology": "Fintech",
  payments: "Fintech",
  banking: "Fintech",

  healthcare: "Healthcare",
  health: "Healthcare",
  "health tech": "Healthcare",
  healthtech: "Healthcare",
  biotech: "Healthcare",
  "life sciences": "Healthcare",

  devtools: "DevTools",
  "dev tools": "DevTools",
  "developer tools": "DevTools",

  enterprise: "Enterprise",
  b2b: "Enterprise",

  consumer: "Consumer",
  b2c: "Consumer",

  climate: "Climate",
  cleantech: "Climate",
  "clean tech": "Climate",
  energy: "Climate",

  crypto: "Crypto",
  web3: "Crypto",
  blockchain: "Crypto",

  marketplace: "Marketplace",
  marketplaces: "Marketplace",

  robotics: "Robotics",
  autonomy: "Robotics",

  other: "Other",
};

// Title-ish tokens / patterns that belong in Role, not Sector.
const TITLE_EXACT = new Set([
  "ceo",
  "cto",
  "cfo",
  "coo",
  "cio",
  "ciso",
  "cpo",
  "cro",
  "cmo",
  "founder",
  "co-founder",
  "cofounder",
  "president",
  "partner",
  "principal",
  "associate",
  "intern",
  "consultant",
  "advisor",
  "board member",
]);

const TITLE_PHRASE_RE =
  /\b(chief\s+\w+|vice\s+president|vp|svp|evp|director|manager|head\s+of|engineer|engineering|architect|scientist|researcher|analyst|specialist|lead|owner|founder|co-?founder|president|partner)\b/i;

function smartCase(s: string): string {
  if (s === s.toUpperCase() && s.length <= 3) return s.toUpperCase();
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) return s;
  return s.toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());
}

/**
 * True when a Sector cell looks like a job title (e.g. "Chief Technology Officer")
 * rather than an industry / focus area.
 */
export function looksLikeJobTitle(raw?: string): boolean {
  const cleaned = (raw || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return false;
  const low = cleaned.toLowerCase();

  if (SECTOR_ALIASES[low]) return false;
  if (CANONICAL_SECTORS.some((s) => s.toLowerCase() === low)) return false;

  if (TITLE_EXACT.has(low)) return true;
  if (TITLE_PHRASE_RE.test(cleaned)) return true;

  // "Something Officer / Manager / Director" without a sector alias hit.
  if (/\b(officer|manager|director|engineer|architect)\b/i.test(cleaned) && cleaned.split(/\s+/).length >= 2) {
    return true;
  }

  return false;
}

/**
 * Collapse a free-text sector to a canonical label when possible.
 * Blank → "". Job-title-looking values are returned unchanged (callers should
 * relocate them via looksLikeJobTitle before normalizing).
 */
export function normalizeSector(raw?: string): string {
  if (!raw) return "";
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";

  const low = cleaned.toLowerCase();
  if (SECTOR_ALIASES[low]) return SECTOR_ALIASES[low];

  const exact = CANONICAL_SECTORS.find((s) => s.toLowerCase() === low);
  if (exact) return exact;

  // Phrase contains (longer aliases first).
  const entries = Object.entries(SECTOR_ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [kw, label] of entries) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`);
    if (re.test(low)) return label;
  }

  return smartCase(cleaned);
}

/** Sheet header aliases that map to the Targets sector field. */
export const TARGET_SECTOR_HEADERS = [
  "sector",
  "sector focus",
  "focus area",
  "focus areas",
  "focus area(s)",
  "industry",
] as const;

/** First matching sector-column index in a lowercased header row, or -1. */
export function findSectorColumnIndex(headers: string[]): number {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const alias of TARGET_SECTOR_HEADERS) {
    const idx = lower.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}
