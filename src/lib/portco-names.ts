// Fuzzy portfolio-company name matching (Sheet ↔ Asana).
// Handles "VAST" ↔ "VAST Data", "Bland" ↔ "Bland AI", "SiMa" ↔ "SiMa.ai", etc.
// Pure — safe client-side / fixture-testable.

/** Strip legal/product suffixes and punctuation for loose comparison. */
export function normalizePortcoName(name: string): string {
  return (name || "")
    .toLowerCase()
    // Turn domain-style suffixes into tokens before punctuation wipe ("sima.ai" → "sima ai").
    .replace(/\.ai\b/g, " ai ")
    .replace(/[.,'’]/g, "")
    .replace(
      /\b(incorporated|inc|corporation|corp|company|co|llc|llp|lp|ltd|limited|labs|technologies|ai)\b/g,
      "",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Score how well two company names refer to the same portco.
 * 0 = no match; higher is better. Exact / normalized equality beat substrings.
 */
export function scorePortcoNameMatch(a: string, b: string): number {
  const la = (a || "").trim().toLowerCase();
  const lb = (b || "").trim().toLowerCase();
  if (!la || !lb) return 0;
  if (la === lb) return 1000;

  const na = normalizePortcoName(a);
  const nb = normalizePortcoName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 900;
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const longer = Math.max(na.length, nb.length);
    // Prefer tighter containment ("vast"/"vast data" ≫ "a"/"alation").
    if (shorter < 2) return 0;
    return 100 + Math.round((100 * shorter) / longer);
  }
  return 0;
}

export function portcoNamesMatch(a: string, b: string): boolean {
  return scorePortcoNameMatch(a, b) > 0;
}

/**
 * Greedy 1:1 map from sheet company names → Asana lookup keys.
 * Each Asana key and each sheet name is claimed at most once (best score first).
 */
export function matchSheetToAsanaKeys(
  sheetNames: string[],
  asanaKeys: string[],
  asanaDisplayName?: (key: string) => string,
): Map<string, string> {
  const display = asanaDisplayName || ((k: string) => k);
  type Pair = { sheet: string; asanaKey: string; score: number };
  const pairs: Pair[] = [];

  for (const sheet of sheetNames) {
    for (const key of asanaKeys) {
      const score = Math.max(
        scorePortcoNameMatch(sheet, key),
        scorePortcoNameMatch(sheet, display(key)),
      );
      if (score > 0) pairs.push({ sheet, asanaKey: key, score });
    }
  }

  pairs.sort((a, b) => b.score - a.score || b.asanaKey.length - a.asanaKey.length);

  const bySheet = new Map<string, string>();
  const usedSheet = new Set<string>();
  const usedAsana = new Set<string>();
  for (const p of pairs) {
    if (usedSheet.has(p.sheet) || usedAsana.has(p.asanaKey)) continue;
    usedSheet.add(p.sheet);
    usedAsana.add(p.asanaKey);
    bySheet.set(p.sheet, p.asanaKey);
  }
  return bySheet;
}
