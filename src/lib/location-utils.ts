// ─────────────────────────────────────────────────────────────────────────
// Location normalization.
//
// Contact "location" strings arrive in many shapes for the same place —
// "San Francisco, CA", "San Francisco, California, United States", "SF Bay
// Area", "san francisco". This collapses them to a single canonical label so a
// filter dropdown shows one entry per real place while still matching every
// contact that belongs there. The same function is used to BUILD the option
// list and to MATCH a contact against a selected option, so they always agree.
// ─────────────────────────────────────────────────────────────────────────

// US state full name → 2-letter abbreviation (plus DC).
const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};

// Valid 2-letter abbreviations, for detecting an already-abbreviated state part.
const STATE_ABBRS = new Set(Object.values(US_STATES));

// Country tokens to strip — they don't help distinguish a city.
const COUNTRIES = new Set([
  "united states", "united states of america", "usa", "us", "u.s.", "u.s.a.",
  "america", "united kingdom", "uk", "u.k.", "canada",
]);

// Common metro nicknames / variants → one canonical label. Keyed by the cleaned,
// lowercased city token. These are the duplicate-heavy places, so pinning them to
// a fixed "City, ST" guarantees every variant collapses together.
const CITY_ALIASES: Record<string, string> = {
  nyc: "New York, NY",
  "new york": "New York, NY",
  "new york city": "New York, NY",
  manhattan: "New York, NY",
  sf: "San Francisco, CA",
  "san fran": "San Francisco, CA",
  "san francisco": "San Francisco, CA",
  "bay area": "San Francisco, CA",
  "silicon valley": "San Francisco, CA",
  la: "Los Angeles, CA",
  "los angeles": "Los Angeles, CA",
  dc: "Washington, DC",
  "washington dc": "Washington, DC",
  washington: "Washington, DC",
  seattle: "Seattle, WA",
  boston: "Boston, MA",
  austin: "Austin, TX",
  chicago: "Chicago, IL",
  denver: "Denver, CO",
  atlanta: "Atlanta, GA",
  miami: "Miami, FL",
  "los angeles area": "Los Angeles, CA",
};

// Title-case a token unless it already has intentional mixed case (e.g. "McLean").
function smartCase(s: string): string {
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) return s;
  return s.toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());
}

// Strip metro qualifiers that don't change the underlying city.
function stripMetro(s: string): string {
  return s
    .replace(/^greater\s+/i, "")
    .replace(/\s+(bay area|metropolitan area|metro area|metro|area|region)$/i, "")
    .trim();
}

/**
 * Collapse a raw location string to a canonical "City, ST" (or "City") label.
 * Returns "" when there's nothing usable (blank, or country-only).
 */
export function normalizeLocation(raw?: string): string {
  if (!raw) return "";
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";

  const parts = cleaned
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !COUNTRIES.has(p.toLowerCase()));
  if (parts.length === 0) return "";

  const cityRaw = stripMetro(parts[0]) || parts[0].trim();

  // Pinned metros collapse every variant to one label.
  const alias = CITY_ALIASES[cityRaw.toLowerCase()];
  if (alias) return alias;

  // Otherwise detect a state from the remaining comma parts.
  let state = "";
  for (const p of parts.slice(1)) {
    const low = p.toLowerCase();
    if (US_STATES[low]) { state = US_STATES[low]; break; }
    const up = p.replace(/\./g, "").toUpperCase();
    if (STATE_ABBRS.has(up)) { state = up; break; }
  }

  const city = smartCase(cityRaw);
  return state ? `${city}, ${state}` : city;
}

/** Distinct, sorted canonical locations from a set of raw contact locations. */
export function canonicalLocations(raw: Array<string | undefined>): string[] {
  return [...new Set(raw.map((r) => normalizeLocation(r)).filter(Boolean))].sort();
}

/** Curated common metros, offered as suggestions in the location combobox. Free
 *  text is always allowed — these just cover the duplicate-heavy places. */
export const COMMON_LOCATIONS: string[] = [...new Set(Object.values(CITY_ALIASES))].sort();
