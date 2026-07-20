/**
 * Map free-text PortCo intro names onto canonical names from the
 * Google Sheets "Portfolio Companies" tab (case-insensitive).
 * Example: "ibex" → "IBEX"
 */

export function portCoKey(name: string): string {
  return (name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** lowercased key → canonical display name from the Portfolio Companies tab */
export function buildPortCoCanonicalMap(canonicalNames: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of canonicalNames) {
    const trimmed = (name || "").trim().replace(/\s+/g, " ");
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    // First spelling from the sheet wins when duplicates differ only by case
    if (!map.has(key)) map.set(key, trimmed);
  }
  return map;
}

/** Resolve an intro/label to the sheet's PortCo name; leave unmatched names as trimmed. */
export function canonicalizePortCo(name: string, map: Map<string, string>): string {
  const trimmed = (name || "").trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return map.get(trimmed.toLowerCase()) ?? trimmed;
}

export function canonicalizePortCoList(names: string[], map: Map<string, string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const c = canonicalizePortCo(n, map);
    if (!c) continue;
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}
