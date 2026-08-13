/**
 * Phase 4.1 — Composite weak-signal events (pure).
 * Multi-family evidence stacks that registry alerts cannot produce.
 */

export type EvidenceFamily =
  | "hiring"
  | "engineering"
  | "infrastructure"
  | "funding"
  | "commercial"
  | "ip";

export type CompositeRuleName =
  | "gtm_expansion"
  | "eng_acceleration"
  | "fundraise_prep"
  | "enterprise_pivot";

export interface EvidenceChange {
  id: string;
  entityId: string;
  company: string;
  family: EvidenceFamily;
  metric: string;
  dateIso: string;
  /** Human stack line, e.g. "+14 sales roles". */
  label: string;
  reason?: string;
  /** Set when this change was absorbed into a composite card. */
  composedInto?: string;
}

export interface CompositeRule {
  name: CompositeRuleName;
  /** One family from each inner list must be present. */
  requiredFamilies: EvidenceFamily[][];
  windowDays: number;
  minChanges: number;
  prior: number;
  label: string;
}

export const COMPOSITE_RULES: CompositeRule[] = [
  {
    name: "gtm_expansion",
    requiredFamilies: [["hiring"], ["commercial"]],
    windowDays: 45,
    minChanges: 2,
    prior: 8,
    label: "GTM expansion",
  },
  {
    name: "eng_acceleration",
    requiredFamilies: [["engineering"], ["hiring"]],
    windowDays: 45,
    minChanges: 2,
    prior: 6,
    label: "Engineering acceleration",
  },
  {
    name: "fundraise_prep",
    requiredFamilies: [["hiring"], ["funding", "ip"]],
    windowDays: 60,
    minChanges: 2,
    prior: 7,
    label: "Fundraise preparation",
  },
  {
    name: "enterprise_pivot",
    requiredFamilies: [["commercial"], ["hiring"]],
    windowDays: 60,
    minChanges: 2,
    prior: 7,
    label: "Enterprise pivot",
  },
];

export interface CompositeHit {
  rule: CompositeRuleName;
  ruleLabel: string;
  entityId: string;
  company: string;
  evidence: EvidenceChange[];
  why: string;
  /** Stable id for composedInto stamping. */
  compositeId: string;
  prior: number;
}

function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b) / 86_400_000;
}

function satisfiesRule(changes: EvidenceChange[], rule: CompositeRule): boolean {
  if (changes.length < rule.minChanges) return false;
  return rule.requiredFamilies.every((group) =>
    group.some((fam) => changes.some((c) => c.family === fam && !c.composedInto)),
  );
}

function stackLine(c: EvidenceChange): string {
  const d = (c.dateIso || "").slice(5); // MM-DD
  return `${c.label}${d ? ` (${d})` : ""}`;
}

/**
 * Detect composites per entity over the trailing window.
 * Marks matching evidence with composedInto on a copy (caller persists).
 */
export function detectComposites(
  changes: EvidenceChange[],
  todayIso: string,
  rules: CompositeRule[] = COMPOSITE_RULES,
): { hits: CompositeHit[]; stamped: EvidenceChange[] } {
  const stamped = changes.map((c) => ({ ...c }));
  const byEntity = new Map<string, EvidenceChange[]>();
  for (const c of stamped) {
    if (c.composedInto) continue;
    if (daysBetween(todayIso, c.dateIso) > 90) continue;
    const key = c.entityId || c.company.toLowerCase();
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key)!.push(c);
  }

  const hits: CompositeHit[] = [];
  // Prefer higher-prior rules first so they claim evidence.
  const ordered = [...rules].sort((a, b) => b.prior - a.prior);

  for (const [, all] of byEntity) {
    for (const rule of ordered) {
      const inWindow = all.filter(
        (c) => !c.composedInto && daysBetween(todayIso, c.dateIso) <= rule.windowDays,
      );
      if (!satisfiesRule(inWindow, rule)) continue;

      // Pick one change per required group (strongest = most recent).
      const picked: EvidenceChange[] = [];
      for (const group of rule.requiredFamilies) {
        const cand = inWindow
          .filter((c) => group.includes(c.family) && !picked.includes(c))
          .sort((a, b) => b.dateIso.localeCompare(a.dateIso));
        if (cand[0]) picked.push(cand[0]);
      }
      // Fill to minChanges with remaining recent.
      for (const c of inWindow.sort((a, b) => b.dateIso.localeCompare(a.dateIso))) {
        if (picked.length >= Math.max(rule.minChanges, picked.length)) break;
        if (!picked.includes(c)) picked.push(c);
      }
      if (picked.length < rule.minChanges) continue;

      const company = picked[0].company;
      const entityId = picked[0].entityId;
      const compositeId = `cmp-${rule.name}-${(entityId || company).slice(0, 24)}-${todayIso}`;
      const why = `${rule.label} signal: ${picked.map(stackLine).join("; ")}.`;
      hits.push({
        rule: rule.name,
        ruleLabel: rule.label,
        entityId,
        company,
        evidence: picked,
        why,
        compositeId,
        prior: rule.prior,
      });
      for (const p of picked) {
        p.composedInto = compositeId;
      }
    }
  }

  return { hits, stamped };
}

/** Map composite rule → Signals event taxonomy type. */
export function eventTypeForComposite(name: CompositeRuleName): string {
  switch (name) {
    case "gtm_expansion":
    case "enterprise_pivot":
      return "major_customer_or_partnership";
    case "eng_acceleration":
      return "product_launch";
    case "fundraise_prep":
      return "funding_round";
    default:
      return "unusual_activity";
  }
}
