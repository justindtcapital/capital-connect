/**
 * Parse Asana portco custom fields into ownership / investment / valuation
 * display values. Field names are matched case-insensitively with aliases
 * (Asana fields often carry trailing spaces or alternate labels).
 */

export interface OwnershipValuationField {
  key: string;
  label: string;
  display: string;
  /** Raw Asana / source string */
  raw: string;
  source: "asana" | "web";
  /** Numeric value when parseable (percent or $M) */
  numeric?: number;
  unit?: "%" | "$M";
}

function lowerMap(fields: Record<string, string>): Record<string, string> {
  return Object.keys(fields).reduce<Record<string, string>>((acc, k) => {
    const v = (fields[k] || "").trim();
    if (v) acc[k.toLowerCase().trim()] = v;
    return acc;
  }, {});
}

function lookup(lowered: Record<string, string>, aliases: string[]): string | undefined {
  for (const a of aliases) {
    const v = lowered[a.toLowerCase().trim()];
    if (v) return v;
  }
  return undefined;
}

/** Pattern scan for any field whose name looks like valuation / post-money. */
function lookupByPattern(fields: Record<string, string>, pattern: RegExp): string | undefined {
  for (const [k, v] of Object.entries(fields)) {
    if (v?.trim() && pattern.test(k)) return v.trim();
  }
  return undefined;
}

export function formatOwnershipPercent(raw: string): { display: string; numeric?: number } {
  const num = parseFloat(raw.replace(/[%,\s$]/g, ""));
  if (Number.isNaN(num)) return { display: raw };
  const pct = num <= 1 ? num * 100 : num;
  return { display: `${parseFloat(pct.toFixed(2))}%`, numeric: parseFloat(pct.toFixed(2)) };
}

/** Parse investment / valuation dollars into $M display. */
export function formatMoneyMillions(raw: string): { display: string; numeric?: number } {
  const cleaned = raw.replace(/[$,\s]/g, "").toLowerCase();
  // Already tagged as millions
  if (/m\b|million/.test(raw.toLowerCase()) || cleaned.endsWith("m")) {
    const num = parseFloat(cleaned.replace(/m.*$/, ""));
    if (!Number.isNaN(num)) {
      return {
        display: `$${num % 1 === 0 ? num : num.toFixed(1)}M`,
        numeric: num,
      };
    }
  }
  const num = parseFloat(cleaned.replace(/[^0-9.-]/g, ""));
  if (Number.isNaN(num)) return { display: raw };
  // Heuristic: values >= 1000 are dollars → convert to $M; else already $M
  const millions = Math.abs(num) >= 1000 ? num / 1_000_000 : num;
  return {
    display: `$${millions % 1 === 0 ? millions : millions.toFixed(1)}M`,
    numeric: parseFloat(millions.toFixed(2)),
  };
}

/** Extract the ownership & valuation snapshot from an Asana fields map. */
export function parseAsanaOwnershipValuation(
  fields: Record<string, string> | undefined | null,
): OwnershipValuationField[] {
  if (!fields || Object.keys(fields).length === 0) return [];
  const lowered = lowerMap(fields);
  const out: OwnershipValuationField[] = [];

  const ownership = lookup(lowered, ["DTC Ownership", "Ownership", "Ownership %", "DTC Ownership %"]);
  if (ownership) {
    const fmt = formatOwnershipPercent(ownership);
    out.push({
      key: "dtc_ownership",
      label: "DTC Ownership",
      display: fmt.display,
      raw: ownership,
      source: "asana",
      numeric: fmt.numeric,
      unit: "%",
    });
  }

  const investment = lookup(lowered, ["DTC Investment ($M)", "DTC Investment", "Investment ($M)"]);
  if (investment) {
    const fmt = formatMoneyMillions(investment);
    out.push({
      key: "dtc_investment",
      label: "DTC Investment",
      display: fmt.display,
      raw: investment,
      source: "asana",
      numeric: fmt.numeric,
      unit: "$M",
    });
  }

  const valuation =
    lookup(lowered, [
      "Valuation",
      "Post-Money",
      "Post Money",
      "Post-Money Valuation",
      "Post Money Valuation",
      "Last Round Valuation",
      "Company Valuation",
      "Current Valuation",
    ]) ||
    lookupByPattern(fields, /valuat|post[\s-]?money|pre[\s-]?money/i);
  if (valuation) {
    const fmt = formatMoneyMillions(valuation);
    out.push({
      key: "valuation",
      label: "Valuation (Asana)",
      display: fmt.display,
      raw: valuation,
      source: "asana",
      numeric: fmt.numeric,
      unit: "$M",
    });
  }

  const lead = lookup(lowered, ["Lead Investor"]);
  if (lead) {
    out.push({
      key: "lead_investor",
      label: "Lead Investor",
      display: lead,
      raw: lead,
      source: "asana",
    });
  }

  const stage = lookup(lowered, ["Company Stage", "Stage"]);
  if (stage) {
    out.push({
      key: "stage",
      label: "Company Stage",
      display: stage,
      raw: stage,
      source: "asana",
    });
  }

  const priority = lookup(lowered, ["DTC Priority"]);
  if (priority) {
    out.push({
      key: "dtc_priority",
      label: "DTC Priority",
      display: priority,
      raw: priority,
      source: "asana",
    });
  }

  return out;
}
