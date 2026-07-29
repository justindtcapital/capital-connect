import { portfolioDomains } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────
// Focus Area normalization.
//
// Portfolio "Focus Area(s)" arrives as free text — "AI", "Artificial
// Intelligence", "ai / ml", "Cybersecurity" — often several per company.
// This collapses synonyms + case variants to one canonical label so the
// filter dropdown shows one entry per real theme while still matching every
// company that belongs there.
// ─────────────────────────────────────────────────────────────────────────

/** Exact (lowercased) token → canonical label. Prefer PortfolioDomain names
 *  when the theme maps cleanly; keep a few common extras as-is. */
const FOCUS_ALIASES: Record<string, string> = {
  // AI
  ai: "AI",
  "a.i.": "AI",
  "a.i": "AI",
  "artificial intelligence": "AI",
  "machine learning": "AI",
  ml: "AI",
  genai: "AI",
  "gen ai": "AI",
  "generative ai": "AI",

  // Security
  security: "Security",
  cyber: "Security",
  cybersecurity: "Security",
  "cyber security": "Security",
  infosec: "Security",

  // Data
  data: "Data",
  analytics: "Data",
  "big data": "Data",
  "data analytics": "Data",
  "data infrastructure": "Data",

  // Cloud
  cloud: "Cloud",
  infrastructure: "Cloud",
  infra: "Cloud",
  devops: "Cloud",
  saas: "Cloud",
  platform: "Cloud",
  "developer tools": "Cloud",
  "dev tools": "Cloud",
  "developer tooling": "Cloud",

  // Logistics / Supply Chain
  logistics: "Logistics",
  "supply chain": "Supply Chain",
  supplychain: "Supply Chain",

  // Silicon
  silicon: "Silicon",
  semiconductor: "Silicon",
  semiconductors: "Silicon",
  chip: "Silicon",
  chips: "Silicon",
  hardware: "Silicon",
};

function smartCase(s: string): string {
  // Preserve known ALL-CAPS tokens like "AI".
  if (s === s.toUpperCase() && s.length <= 3) return s.toUpperCase();
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) return s;
  return s.toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());
}

/** Split a raw Focus Area(s) cell into discrete tokens. */
export function splitFocusAreas(raw?: string): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,;/|&]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Collapse a single focus-area token to a canonical label.
 * Returns "" when blank.
 */
export function normalizeFocusArea(raw?: string): string {
  if (!raw) return "";
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";

  const low = cleaned.toLowerCase();
  if (FOCUS_ALIASES[low]) return FOCUS_ALIASES[low];

  // Exact PortfolioDomain match (any casing).
  const domainHit = portfolioDomains.find((d) => d.toLowerCase() === low);
  if (domainHit) return domainHit;

  // Whole-word / phrase contains fallback (e.g. "AI Infrastructure" → AI).
  // Prefer longer aliases first; require word boundaries so "ai" doesn't hit "chain".
  const aliasEntries = Object.entries(FOCUS_ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [kw, label] of aliasEntries) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`);
    if (re.test(low)) return label;
  }

  return smartCase(cleaned);
}

/** Distinct, sorted canonical focus areas from raw tokens / cells. */
export function canonicalFocusAreas(raw: Array<string | undefined>): string[] {
  const byKey = new Map<string, string>();
  for (const cell of raw) {
    for (const token of splitFocusAreas(cell)) {
      const label = normalizeFocusArea(token);
      if (!label) continue;
      const key = label.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, label);
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/** True when any of a company's focus areas matches the selected canonical list. */
export function focusAreaMatches(
  rawSector: string | undefined,
  selected: string[],
): boolean {
  if (!selected.length) return true;
  const selectedKeys = new Set(
    selected.map((s) => normalizeFocusArea(s).toLowerCase()).filter(Boolean),
  );
  if (selectedKeys.size === 0) return true;
  const areas = splitFocusAreas(rawSector).map(normalizeFocusArea).filter(Boolean);
  if (areas.length === 0) return false;
  return areas.some((a) => selectedKeys.has(a.toLowerCase()));
}
