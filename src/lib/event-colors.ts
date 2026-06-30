// Color helpers for events. Lead drives the calendar item background;
// industry drives the small dot indicator. Values are oklch strings so
// they survive light/dark theming reasonably and align with the chart palette.

export interface ColorToken {
  /** Solid background color (used for calendar pills) */
  bg: string;
  /** Foreground text color used on the bg */
  fg: string;
  /** Border-friendly variant for outlined chips */
  border: string;
  /** Solid color used for dots / legend swatches */
  solid: string;
}

const palette: Record<string, ColorToken> = {
  blue: { bg: "oklch(0.546 0.162 241 / 0.15)", fg: "oklch(0.35 0.16 241)", border: "oklch(0.546 0.162 241 / 0.5)", solid: "oklch(0.546 0.162 241)" },
  green: { bg: "oklch(0.637 0.135 163 / 0.18)", fg: "oklch(0.32 0.13 163)", border: "oklch(0.637 0.135 163 / 0.5)", solid: "oklch(0.55 0.135 163)" },
  amber: { bg: "oklch(0.78 0.16 75 / 0.22)", fg: "oklch(0.42 0.14 60)", border: "oklch(0.78 0.16 75 / 0.6)", solid: "oklch(0.7 0.17 70)" },
  purple: { bg: "oklch(0.6 0.18 305 / 0.18)", fg: "oklch(0.36 0.18 305)", border: "oklch(0.6 0.18 305 / 0.5)", solid: "oklch(0.55 0.18 305)" },
  rose: { bg: "oklch(0.65 0.2 18 / 0.18)", fg: "oklch(0.4 0.18 18)", border: "oklch(0.65 0.2 18 / 0.5)", solid: "oklch(0.6 0.2 18)" },
  teal: { bg: "oklch(0.65 0.13 195 / 0.2)", fg: "oklch(0.36 0.12 195)", border: "oklch(0.65 0.13 195 / 0.5)", solid: "oklch(0.55 0.13 195)" },
  slate: { bg: "oklch(0.78 0.02 260 / 0.35)", fg: "oklch(0.3 0.02 260)", border: "oklch(0.6 0.02 260)", solid: "oklch(0.55 0.02 260)" },
};

// Lead colors. DTC-led and DTC-sponsored are visually distinct so the
// calendar can communicate "we ran it" vs "we paid for a seat at it".
const leadColorMap: Array<{ test: RegExp; key: keyof typeof palette }> = [
  // Order matters: more specific patterns first.
  { test: /dtc.*sponsor|sponsor.*dtc|dell.*sponsor/i, key: "teal" },
  { test: /dtc.*(led|host|hosted)|dell.*(led|host)|^dtc$|^dell/i, key: "blue" },
  { test: /portco|portfolio/i, key: "green" },
  { test: /partner/i, key: "purple" },
  { test: /external|3rd|third/i, key: "amber" },
];

// Sector colors (Asana column is "Industry" but we surface as "Sector").
// Only AI, Data, and Security get explicit colors; everything else is uncolored.
const sectorColorMap: Array<{ test: RegExp; key: keyof typeof palette }> = [
  { test: /security|cyber/i, key: "rose" },
  { test: /\bai\b|artificial|ml|machine/i, key: "purple" },
  { test: /data|analytic/i, key: "teal" },
  { test: /supply\s*chain|logistic/i, key: "amber" },
];

const fallbackKeys: (keyof typeof palette)[] = ["blue", "green", "amber", "purple", "rose", "teal"];

function fallbackFor(value: string): keyof typeof palette {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return fallbackKeys[h % fallbackKeys.length];
}

export function colorForLead(lead?: string): ColorToken {
  if (!lead) return palette.slate;
  for (const m of leadColorMap) if (m.test.test(lead)) return palette[m.key];
  return palette[fallbackFor(lead)];
}

/** Returns a color only for known sectors (AI / Data / Security). Others → null. */
export function colorForSector(sector?: string): ColorToken | null {
  if (!sector) return null;
  for (const m of sectorColorMap) if (m.test.test(sector)) return palette[m.key];
  return null;
}

/** @deprecated use colorForSector */
export const colorForIndustry = colorForSector;
