/**
 * Phase 4.2 — Trajectory intelligence (pure).
 * Rolling slope + acceleration over metric history; reversal detection.
 */

export interface MetricPoint {
  dateIso: string;
  value: number;
}

export interface TrajectoryResult {
  valueNow: number;
  slope30d: number | null;
  slope90d: number | null;
  /** Second difference of short slopes (acceleration). */
  acceleration: number | null;
  /** Human sparkline-ish line for evidence. */
  sparkline: string;
  /** Sign flip in slope with material magnitude. */
  reversal: boolean;
  reversalWhy: string;
}

function parseDay(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t / 86_400_000 : NaN;
}

/** OLS slope in units/day over points inside the trailing window. */
export function slopeInWindow(points: MetricPoint[], windowDays: number): number | null {
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) => a.dateIso.localeCompare(b.dateIso));
  const last = parseDay(sorted[sorted.length - 1].dateIso);
  if (!Number.isFinite(last)) return null;
  const inWin = sorted.filter((p) => last - parseDay(p.dateIso) <= windowDays);
  if (inWin.length < 2) return null;
  const t0 = parseDay(inWin[0].dateIso);
  const xs = inWin.map((p) => parseDay(p.dateIso) - t0);
  const ys = inWin.map((p) => p.value);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 0 ? num / den : null;
}

function pctDelta(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}

/**
 * Compute trajectory features for one (entity, metric) series.
 * `reversalZBar` — minimum |short slope| (units/day) to call a sign flip material.
 */
export function computeTrajectory(
  points: MetricPoint[],
  opts?: { reversalZBar?: number },
): TrajectoryResult {
  const bar = opts?.reversalZBar ?? 0.05;
  const sorted = [...points].sort((a, b) => a.dateIso.localeCompare(b.dateIso));
  const valueNow = sorted.length ? sorted[sorted.length - 1].value : 0;
  const slope30d = slopeInWindow(sorted, 30);
  const slope90d = slopeInWindow(sorted, 90);

  // Acceleration: compare recent 30d slope vs prior 30d window ending 30d ago.
  let acceleration: number | null = null;
  if (sorted.length >= 4) {
    const last = parseDay(sorted[sorted.length - 1].dateIso);
    const prior = sorted.filter((p) => {
      const d = parseDay(p.dateIso);
      return last - d > 30 && last - d <= 60;
    });
    const recent = sorted.filter((p) => last - parseDay(p.dateIso) <= 30);
    const sPrior = slopeInWindow(prior, 30);
    const sRecent = slopeInWindow(recent, 30);
    if (sPrior != null && sRecent != null) acceleration = sRecent - sPrior;
  }

  // Sparkline from last up to 4 monthly-ish points.
  const tail = sorted.slice(-4);
  const pcts: string[] = [];
  for (let i = 1; i < tail.length; i++) {
    const d = pctDelta(tail[i - 1].value, tail[i].value);
    if (d == null) continue;
    const sign = d >= 0 ? "+" : "";
    pcts.push(`${sign}${Math.round(d)}%`);
  }
  const sparkline =
    pcts.length > 0
      ? `${tail[0]?.value ?? "?"} → ${pcts.join(" → ")} (${pcts.length + 0} steps)`
      : `${valueNow}`;

  let reversal = false;
  let reversalWhy = "";
  if (slope30d != null && slope90d != null && Math.abs(slope30d) >= bar && Math.abs(slope90d) >= bar) {
    if (Math.sign(slope30d) !== Math.sign(slope90d) && Math.sign(slope30d) !== 0) {
      reversal = true;
      reversalWhy =
        slope30d < 0 && slope90d > 0
          ? `Deceleration: 90d slope +${slope90d.toFixed(3)}/d flipped to 30d ${slope30d.toFixed(3)}/d`
          : `Acceleration flip: 90d ${slope90d.toFixed(3)}/d → 30d ${slope30d.toFixed(3)}/d`;
    }
  }

  return {
    valueNow,
    slope30d,
    slope90d,
    acceleration,
    sparkline,
    reversal,
    reversalWhy,
  };
}

/** Surprise multiplier nudge from acceleration (0.85–1.2). */
export function trajectorySurpriseMult(t: TrajectoryResult): {
  value: number;
  why: string;
} {
  if (t.reversal) {
    return { value: 1.15, why: `trajectory reversal — ${t.reversalWhy}` };
  }
  if (t.acceleration != null && t.acceleration > 0) {
    return {
      value: Math.min(1.2, 1 + Math.min(0.2, t.acceleration * 2)),
      why: `accelerating metric (Δslope ${t.acceleration.toFixed(3)})`,
    };
  }
  if (t.acceleration != null && t.acceleration < 0) {
    return {
      value: Math.max(0.85, 1 + Math.max(-0.15, t.acceleration * 2)),
      why: `decelerating metric (Δslope ${t.acceleration.toFixed(3)})`,
    };
  }
  return { value: 1, why: "flat trajectory" };
}
