/**
 * Phase 3.3 — evidence completeness: every surfaced score must decompose
 * into named parts with nonempty `why` strings (CI-able / weekly report).
 */

export interface EvidenceCompletenessResult {
  ok: boolean;
  checked: number;
  complete: number;
  incomplete: number;
  rate: number | null;
  samples: Array<{ id: string; missing: string[] }>;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * Walk a scoreBreakdown blob and collect ScorePart-like objects
 * (`{ name, value, why }`) plus known named why fields.
 */
export function collectWhyGaps(
  breakdown: unknown,
  path = "root",
): string[] {
  const gaps: string[] = [];
  if (breakdown == null) return [`${path}: empty breakdown`];
  if (typeof breakdown === "string") {
    try {
      return collectWhyGaps(JSON.parse(breakdown), path);
    } catch {
      return [`${path}: unparseable scoreBreakdown`];
    }
  }
  if (!isRecord(breakdown)) return gaps;

  // Classic ScorePart arrays (materiality.parts, etc.).
  for (const [k, v] of Object.entries(breakdown)) {
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (!isRecord(item)) return;
        if ("name" in item || "why" in item) {
          const why = item.why;
          if (typeof why !== "string" || !why.trim()) {
            gaps.push(`${path}.${k}[${i}].why`);
          }
        } else {
          gaps.push(...collectWhyGaps(item, `${path}.${k}[${i}]`));
        }
      });
      continue;
    }
    if (isRecord(v)) {
      // Named objects that should carry why: gate, novelty, independence, resolve, …
      if ("why" in v && (typeof v.why !== "string" || !String(v.why).trim())) {
        gaps.push(`${path}.${k}.why`);
      }
      if ("reasons" in v && Array.isArray(v.reasons) && v.reasons.length === 0) {
        // gate.reasons may be nonempty on pass ("cleared…"); empty is a gap only
        // when outcome is set without reasons — soft check skipped.
      }
      gaps.push(...collectWhyGaps(v, `${path}.${k}`));
    }
  }
  return gaps;
}

export function auditEvidenceCompleteness(
  rows: Array<{ id: string; scoreBreakdown?: string | null; rankScore?: number | null }>,
  opts?: { onlySurfaced?: boolean; minRank?: number },
): EvidenceCompletenessResult {
  const minRank = opts?.minRank ?? 0;
  const surfaced = rows.filter((r) => {
    if (!opts?.onlySurfaced) return Boolean(r.scoreBreakdown);
    return (r.rankScore ?? -1) >= minRank && Boolean(r.scoreBreakdown);
  });
  const samples: EvidenceCompletenessResult["samples"] = [];
  let complete = 0;
  for (const r of surfaced) {
    const missing = collectWhyGaps(r.scoreBreakdown, r.id || "row");
    // Require at least one reconstructible part with why, OR a known Phase 2 block.
    let parsed: Json = null;
    try {
      parsed = r.scoreBreakdown ? (JSON.parse(r.scoreBreakdown) as Json) : null;
    } catch {
      parsed = null;
    }
    const hasPhaseMeta =
      isRecord(parsed) &&
      (isRecord(parsed.gate) ||
        isRecord(parsed.novelty) ||
        isRecord(parsed.independence) ||
        isRecord(parsed.resolve) ||
        Array.isArray(parsed.parts) ||
        isRecord(parsed.materiality));

    if (!hasPhaseMeta || missing.length > 8) {
      // Soft: many legacy rows lack why on nested objects; flag empty/unparseable
      // and rows with many gaps. Perfect 100% lands after V3 dual-write ages in.
      if (!hasPhaseMeta || missing.length > 0) {
        samples.push({ id: r.id, missing: missing.slice(0, 6) });
      } else {
        complete++;
      }
    } else if (missing.length === 0) {
      complete++;
    } else {
      samples.push({ id: r.id, missing: missing.slice(0, 6) });
    }
  }
  const checked = surfaced.length;
  const incomplete = checked - complete;
  return {
    ok: checked === 0 ? true : incomplete === 0,
    checked,
    complete,
    incomplete,
    rate: checked > 0 ? complete / checked : null,
    samples: samples.slice(0, 12),
  };
}
