// Signal Radar v2 — deterministic detection & fusion (pure functions).
//
// This module is the system's "no-LLM zone": every number, threshold, and
// fusion decision here is deterministic and fixture-testable. It has ZERO app
// imports so scripts/intel-detect.test.ts can exercise it standalone.
//
// Layer separation (upgrade spec §D):
//   Observation — a value a collector saw            (collectors)
//   Change      — a validated difference             (evaluateChange, here)
//   Event       — related changes fused into a state (fuseChanges, here)
//   Inference   — the labeled interpretation text    (composed downstream,
//                 always marked as inference, never as fact)

// ── Metric policies (detector registry by metric type) ───────────

export type MetricKind =
  /** Absolute count with meaningful magnitude (roles, repos, subdomains). */
  | "count"
  /** Windowed/derived count that naturally wobbles (certs last 90d) — stricter. */
  | "windowed"
  /** Point-in-time filing count — ANY increase is an event; z-scores meaningless. */
  | "filing"
  /** 0/1 page-class presence (pricing page, security page). Appearance (0→1)
   *  fires; disappearance only records — sitemaps flap too much to trust removals. */
  | "flag";

export interface MetricPolicy {
  kind: MetricKind;
  /** Human label used in signal text. */
  label: string;
  /** Evidence family for fusion independence (same family ≠ corroboration). */
  family: "hiring" | "engineering" | "infrastructure" | "funding" | "commercial" | "ip";
  /** Minimum |current − baseline| before an anomaly can fire (small-denominator guard). */
  minAbsDelta: number;
  /** Minimum |relative| move (vs. baseline) before an anomaly can fire. */
  minRelDelta: number;
  /** A move at least this large in absolute terms fires even below minRelDelta
   *  (the 80 → 105 case: strategically meaningful despite <35%). 0 = disabled. */
  bigAbsOverride: number;
  /** Robust-z threshold vs. the metric's own history. */
  zThreshold: number;
  /** Minimum history points before anomalies are considered. */
  minHistory: number;
  /** Days before the same (entity, metric) anomaly may re-fire. */
  cooldownDays: number;
  /** A drop to exactly 0 needs a second consecutive observation before it is
   *  believed (job board glitch / parser blip protection). */
  confirmDropToZero: boolean;
}

export const METRIC_POLICIES: Record<string, MetricPolicy> = {
  ats_open_roles: { kind: "count", label: "open roles", family: "hiring", minAbsDelta: 3, minRelDelta: 0.25, bigAbsOverride: 20, zThreshold: 2, minHistory: 4, cooldownDays: 21, confirmDropToZero: true },
  ats_eng_roles: { kind: "count", label: "engineering roles", family: "hiring", minAbsDelta: 3, minRelDelta: 0.3, bigAbsOverride: 12, zThreshold: 2, minHistory: 4, cooldownDays: 21, confirmDropToZero: true },
  ats_gtm_roles: { kind: "count", label: "go-to-market roles", family: "hiring", minAbsDelta: 3, minRelDelta: 0.3, bigAbsOverride: 12, zThreshold: 2, minHistory: 4, cooldownDays: 21, confirmDropToZero: true },
  gh_public_repos: { kind: "count", label: "public repos", family: "engineering", minAbsDelta: 2, minRelDelta: 0.2, bigAbsOverride: 10, zThreshold: 2, minHistory: 4, cooldownDays: 28, confirmDropToZero: true },
  gh_active_repos_90d: { kind: "windowed", label: "active repos (90d)", family: "engineering", minAbsDelta: 3, minRelDelta: 0.35, bigAbsOverride: 15, zThreshold: 2.5, minHistory: 5, cooldownDays: 28, confirmDropToZero: false },
  gh_stars: { kind: "count", label: "GitHub stars", family: "engineering", minAbsDelta: 50, minRelDelta: 0.25, bigAbsOverride: 2000, zThreshold: 2.5, minHistory: 5, cooldownDays: 28, confirmDropToZero: false },
  gh_followers: { kind: "count", label: "GitHub followers", family: "engineering", minAbsDelta: 25, minRelDelta: 0.25, bigAbsOverride: 1000, zThreshold: 2.5, minHistory: 5, cooldownDays: 28, confirmDropToZero: false },
  ct_subdomains: { kind: "count", label: "public subdomains", family: "infrastructure", minAbsDelta: 2, minRelDelta: 0.15, bigAbsOverride: 10, zThreshold: 2, minHistory: 4, cooldownDays: 28, confirmDropToZero: false },
  // Cert issuance renews in provider cycles (Let's Encrypt 90d) — deliberately strict.
  ct_certs_90d: { kind: "windowed", label: "TLS certs issued (90d)", family: "infrastructure", minAbsDelta: 5, minRelDelta: 0.5, bigAbsOverride: 40, zThreshold: 3, minHistory: 6, cooldownDays: 35, confirmDropToZero: false },
  changelog_releases_90d: { kind: "windowed", label: "changelog releases (90d)", family: "engineering", minAbsDelta: 3, minRelDelta: 0.5, bigAbsOverride: 15, zThreshold: 2.5, minHistory: 5, cooldownDays: 28, confirmDropToZero: false },
  sec_formd_filings: { kind: "filing", label: "SEC Form D filings", family: "funding", minAbsDelta: 1, minRelDelta: 0, bigAbsOverride: 0, zThreshold: 0, minHistory: 1, cooldownDays: 60, confirmDropToZero: false },
  // Registry-grade launch precursor — any new mark under a strict owner match fires.
  uspto_trademark_filings: { kind: "filing", label: "USPTO trademark filings", family: "ip", minAbsDelta: 1, minRelDelta: 0, bigAbsOverride: 0, zThreshold: 0, minHistory: 1, cooldownDays: 60, confirmDropToZero: false },
  // Website page-class flags (from sitemap classification, first-party artifacts).
  site_sitemap_urls: { kind: "count", label: "sitemap URLs", family: "commercial", minAbsDelta: 10, minRelDelta: 0.3, bigAbsOverride: 100, zThreshold: 2.5, minHistory: 5, cooldownDays: 35, confirmDropToZero: false },
  site_has_pricing: { kind: "flag", label: "pricing page", family: "commercial", minAbsDelta: 1, minRelDelta: 0, bigAbsOverride: 0, zThreshold: 0, minHistory: 1, cooldownDays: 90, confirmDropToZero: false },
  site_has_enterprise: { kind: "flag", label: "enterprise page", family: "commercial", minAbsDelta: 1, minRelDelta: 0, bigAbsOverride: 0, zThreshold: 0, minHistory: 1, cooldownDays: 90, confirmDropToZero: false },
  site_has_security: { kind: "flag", label: "security/trust page", family: "commercial", minAbsDelta: 1, minRelDelta: 0, bigAbsOverride: 0, zThreshold: 0, minHistory: 1, cooldownDays: 90, confirmDropToZero: false },
  site_has_customers: { kind: "flag", label: "customers/case-studies page", family: "commercial", minAbsDelta: 1, minRelDelta: 0, bigAbsOverride: 0, zThreshold: 0, minHistory: 1, cooldownDays: 90, confirmDropToZero: false },
  site_has_partners: { kind: "flag", label: "partners/integrations page", family: "commercial", minAbsDelta: 1, minRelDelta: 0, bigAbsOverride: 0, zThreshold: 0, minHistory: 1, cooldownDays: 90, confirmDropToZero: false },
  site_has_docs: { kind: "flag", label: "developer docs", family: "engineering", minAbsDelta: 1, minRelDelta: 0, bigAbsOverride: 0, zThreshold: 0, minHistory: 1, cooldownDays: 90, confirmDropToZero: false },
  site_has_changelog: { kind: "flag", label: "changelog/release notes", family: "engineering", minAbsDelta: 1, minRelDelta: 0, bigAbsOverride: 0, zThreshold: 0, minHistory: 1, cooldownDays: 90, confirmDropToZero: false },
};

export function policyFor(metric: string): MetricPolicy {
  return (
    METRIC_POLICIES[metric] || {
      kind: "count",
      label: metric,
      family: "engineering",
      minAbsDelta: 2,
      minRelDelta: 0.25,
      bigAbsOverride: 0,
      zThreshold: 2,
      minHistory: 4,
      cooldownDays: 21,
      confirmDropToZero: false,
    }
  );
}

// ── Robust series statistics ─────────────────────────────────────

export interface SeriesStats {
  baseline: number;
  sigma: number;
  z: number;
  slopeWk: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** MAD-based sigma with a floor so z stays finite on flat series. */
export function robustSigma(values: number[], center: number): number {
  const deviations = values.map((v) => Math.abs(v - center));
  const mad = median(deviations);
  const sigma = mad * 1.4826;
  return sigma > 0 ? sigma : Math.max(1, Math.abs(center) * 0.05);
}

/** OLS slope in units/week over the last N points (irregular spacing OK). */
export function slopePerWeek(history: Array<[string, number]>, lastN = 10): number {
  const pts = history.slice(-lastN);
  if (pts.length < 3) return 0;
  const t0 = Date.parse(pts[0][0]);
  const xs = pts.map(([d]) => (Date.parse(d) - t0) / (7 * 24 * 3600 * 1000));
  const ys = pts.map(([, v]) => v);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 0 ? num / den : 0;
}

export function computeStats(history: Array<[string, number]>, current: number): SeriesStats {
  const values = history.map(([, v]) => v);
  const past = values.length > 3 ? values.slice(0, -1) : values;
  const baseline = median(past);
  const sigma = robustSigma(past, baseline);
  return {
    baseline,
    sigma,
    z: sigma > 0 ? (current - baseline) / sigma : 0,
    slopeWk: slopePerWeek(history),
  };
}

// ── Change evaluation (Observation → Change) ─────────────────────

export interface ChangeInput {
  metric: string;
  prev: number;
  next: number;
  /** History INCLUDING the new point. */
  history: Array<[string, number]>;
  /** Days since this (entity, metric) last fired an anomaly (Infinity = never). */
  daysSinceLastFire: number;
  /** True when the previous observation was an unconfirmed drop-to-zero. */
  pendingZeroSince?: string;
}

export type ChangeVerdict =
  /** Record the change to the ledger; no anomaly. */
  | { action: "record" }
  /** Record + this change is anomalous → feed fusion. */
  | { action: "record_anomaly"; anomaly: Anomaly }
  /** Hold: drop-to-zero needs a second consecutive observation. */
  | { action: "hold_unconfirmed" }
  /** Previous pending zero turned out to be a blip; discard silently. */
  | { action: "discard_blip" };

export interface Anomaly {
  metric: string;
  family: MetricPolicy["family"];
  label: string;
  direction: "up" | "down";
  prev: number;
  next: number;
  baseline: number;
  z: number;
  relDelta: number;
  absDelta: number;
  slopeWk: number;
  /** Why it fired — audit trail for the signal card. */
  reason: string;
}

export function evaluateChange(input: ChangeInput): ChangeVerdict {
  const policy = policyFor(input.metric);
  const { prev, next } = input;

  // Drop-to-zero confirmation: a board/org vanishing is more often a glitch
  // than a company event. First sighting → hold; second consecutive → believe.
  if (policy.confirmDropToZero) {
    if (input.pendingZeroSince) {
      if (next === 0) {
        // confirmed — fall through and evaluate as a real change
      } else {
        return { action: "discard_blip" };
      }
    } else if (next === 0 && prev >= 5) {
      return { action: "hold_unconfirmed" };
    }
  }

  const stats = computeStats(input.history, next);
  const absDelta = Math.abs(next - stats.baseline);
  const relDelta = Math.abs(next - stats.baseline) / Math.max(Math.abs(stats.baseline), 1);
  const direction: "up" | "down" = next >= stats.baseline ? "up" : "down";

  // Flags: appearance (0→1) is an event; disappearance only records (sitemaps flap).
  if (policy.kind === "flag") {
    if (next > prev && input.daysSinceLastFire > policy.cooldownDays) {
      return {
        action: "record_anomaly",
        anomaly: {
          metric: input.metric,
          family: policy.family,
          label: policy.label,
          direction: "up",
          prev,
          next,
          baseline: prev,
          z: 0,
          relDelta: 0,
          absDelta: 1,
          slopeWk: 0,
          reason: `New ${policy.label} appeared on the company site (first-party artifact).`,
        },
      };
    }
    return { action: "record" };
  }

  // Filings: any increase is an event — no distribution to reason about.
  if (policy.kind === "filing") {
    if (next > prev && input.daysSinceLastFire > policy.cooldownDays) {
      return {
        action: "record_anomaly",
        anomaly: {
          metric: input.metric,
          family: policy.family,
          label: policy.label,
          direction: "up",
          prev,
          next,
          baseline: prev,
          z: 0,
          relDelta: 0,
          absDelta: next - prev,
          slopeWk: 0,
          reason: `New ${policy.label.replace(/s$/, "")} observed (${prev} → ${next}).`,
        },
      };
    }
    return { action: "record" };
  }

  if (input.history.length < policy.minHistory) return { action: "record" };
  if (input.daysSinceLastFire <= policy.cooldownDays) return { action: "record" };
  if (absDelta < policy.minAbsDelta) return { action: "record" };

  const bigMove = policy.bigAbsOverride > 0 && absDelta >= policy.bigAbsOverride;
  const relMove = relDelta >= policy.minRelDelta && Math.abs(stats.z) >= policy.zThreshold;
  if (!bigMove && !relMove) return { action: "record" };

  return {
    action: "record_anomaly",
    anomaly: {
      metric: input.metric,
      family: policy.family,
      label: policy.label,
      direction,
      prev,
      next,
      baseline: stats.baseline,
      z: stats.z,
      relDelta,
      absDelta,
      slopeWk: stats.slopeWk,
      reason: bigMove
        ? `Large absolute move: |Δ| ${absDelta.toFixed(0)} ≥ ${policy.bigAbsOverride} vs. baseline ${stats.baseline.toFixed(0)}.`
        : `Robust z ${stats.z.toFixed(1)} ≥ ${policy.zThreshold} and move ${(relDelta * 100).toFixed(0)}% ≥ ${policy.minRelDelta * 100}% (baseline ${stats.baseline.toFixed(0)}).`,
    },
  };
}

// ── Peer benchmarking ────────────────────────────────────────────
// Self-comparison says "unusual for this company"; peer comparison says
// "unusual among the companies we monitor". Cohort = every monitored entity
// with enough history on the SAME metric — an honest, explainable cohort whose
// size is always displayed. Values compared are relative deviations from each
// company's own baseline, so a 5-person seed co and a 500-person portco are
// on the same scale.

export const PEER_MIN_COHORT = 8;

/**
 * Percentile (0–100) of `mine` within `peerValues` in the given direction:
 * "up" → share of peers strictly below; "down" → share strictly above
 * (i.e. how much more extreme this move is than the cohort's).
 * Returns null when the cohort is too small to be meaningful.
 */
export function peerPercentile(
  peerValues: number[],
  mine: number,
  direction: "up" | "down",
): { percentile: number; n: number } | null {
  const n = peerValues.length;
  if (n < PEER_MIN_COHORT) return null;
  const more =
    direction === "up"
      ? peerValues.filter((v) => v < mine).length
      : peerValues.filter((v) => v > mine).length;
  return { percentile: Math.round((more / n) * 100), n };
}

// ── Fusion (Changes → Event candidates) ──────────────────────────
// Company states are estimated by explicit rules over anomaly families —
// transparent by design. Anomalies from the SAME family never corroborate each
// other (three ATS metrics = one hiring fact observed three ways).

export type CompanyState =
  | "Hiring acceleration"
  | "Hiring contraction"
  | "Engineering acceleration"
  | "Engineering slowdown"
  | "Infrastructure expansion"
  | "Fundraising evidence"
  | "Expansion preparation"
  | "Enterprise go-to-market expansion"
  | "Commercial maturation"
  | "Product launch preparation"
  | "Operational slowdown";

interface StateRule {
  state: CompanyState;
  /** family → required direction ("any" matches both). */
  requires: Array<{ family: MetricPolicy["family"]; direction: "up" | "down" | "any" }>;
  /** Rules with more requirements win over subsets (composite beats single). */
  priority: number;
  interpretation: string;
}

const STATE_RULES: StateRule[] = [
  {
    state: "Enterprise go-to-market expansion",
    requires: [
      { family: "hiring", direction: "up" },
      { family: "commercial", direction: "up" },
    ],
    priority: 35,
    interpretation:
      "Hiring growth combined with new commercial pages (pricing/enterprise/security/customers) — a pattern that typically precedes a broader enterprise sales push. This is an inference from the combined evidence, not a company announcement.",
  },
  {
    state: "Expansion preparation",
    requires: [
      { family: "hiring", direction: "up" },
      { family: "infrastructure", direction: "up" },
    ],
    priority: 30,
    interpretation:
      "Hiring and infrastructure are growing together — a pattern that often precedes a product, market, or enterprise expansion. This is an inference from the combined evidence, not an announcement.",
  },
  {
    state: "Operational slowdown",
    requires: [
      { family: "hiring", direction: "down" },
      { family: "engineering", direction: "down" },
    ],
    priority: 30,
    interpretation:
      "Hiring and engineering output are contracting together — consistent with a freeze, restructuring, or refocus. Inference only; verify before acting.",
  },
  {
    state: "Fundraising evidence",
    requires: [{ family: "funding", direction: "up" }],
    priority: 25,
    interpretation:
      "A regulatory filing indicates securities were sold — capital has likely been raised even if nothing was announced.",
  },
  {
    state: "Product launch preparation",
    requires: [{ family: "ip", direction: "up" }],
    priority: 22,
    interpretation:
      "New USPTO trademark filings under this owner — registry-grade evidence that often precedes a product or brand launch. Inference about intent, not an announcement.",
  },
  { state: "Commercial maturation", requires: [{ family: "commercial", direction: "up" }], priority: 10, interpretation: "New commercial pages (pricing/enterprise/security/customers) appeared on the company site — often the visible edge of a sales-motion change. Inference, not announcement." },
  { state: "Hiring acceleration", requires: [{ family: "hiring", direction: "up" }], priority: 10, interpretation: "Open-role growth beyond this company's own baseline. Often follows new capital or precedes a go-to-market push. Inference, not announcement." },
  { state: "Hiring contraction", requires: [{ family: "hiring", direction: "down" }], priority: 10, interpretation: "Open roles contracted well below this company's baseline — consistent with a freeze or slowdown. Inference, not announcement." },
  { state: "Engineering acceleration", requires: [{ family: "engineering", direction: "up" }], priority: 10, interpretation: "Public engineering activity is rising beyond baseline — often precedes releases. Inference, not announcement." },
  { state: "Engineering slowdown", requires: [{ family: "engineering", direction: "down" }], priority: 10, interpretation: "Public engineering activity fell well below baseline. Inference; could also reflect a move to private repos." },
  { state: "Infrastructure expansion", requires: [{ family: "infrastructure", direction: "up" }], priority: 10, interpretation: "New public infrastructure (subdomains/certificates) is appearing — often precedes launches or new regions. Inference, not announcement." },
];

export interface EventCandidate {
  state: CompanyState;
  /** 0–1 heuristic confidence, driven by independent families + strength. */
  confidence: number;
  independentFamilies: number;
  anomalies: Anomaly[];
  interpretation: string;
  /** Stable identity for lifecycle upserts: state only — entity added by caller. */
  fingerprint: string;
}

/**
 * Fuse one entity's anomalies (already within the sweep's time window) into
 * event candidates. Each anomaly is consumed by the highest-priority rule it
 * satisfies, so a composite event suppresses its single-family constituents.
 */
export function fuseChanges(anomalies: Anomaly[]): EventCandidate[] {
  if (anomalies.length === 0) return [];

  // Strongest anomaly per family (same-family metrics never corroborate).
  const byFamily = new Map<string, Anomaly[]>();
  for (const a of anomalies) {
    const arr = byFamily.get(a.family) || [];
    arr.push(a);
    byFamily.set(a.family, arr);
  }

  const familyDirection = (family: string): "up" | "down" | null => {
    const list = byFamily.get(family);
    if (!list || list.length === 0) return null;
    // Direction of the strongest anomaly (by |z| then |absDelta|).
    const strongest = [...list].sort(
      (a, b) => Math.abs(b.z) - Math.abs(a.z) || b.absDelta - a.absDelta,
    )[0];
    return strongest.direction;
  };

  const consumed = new Set<string>();
  const out: EventCandidate[] = [];
  const rules = [...STATE_RULES].sort((a, b) => b.priority - a.priority);

  for (const rule of rules) {
    const matchedFamilies: string[] = [];
    let ok = true;
    for (const req of rule.requires) {
      const dir = familyDirection(req.family);
      if (!dir || (req.direction !== "any" && dir !== req.direction)) {
        ok = false;
        break;
      }
      matchedFamilies.push(req.family);
    }
    if (!ok) continue;
    // Every matched family must still have an unconsumed anomaly.
    const evidence = matchedFamilies.flatMap((f) =>
      (byFamily.get(f) || []).filter((a) => !consumed.has(a.metric)),
    );
    if (evidence.length === 0 || new Set(evidence.map((e) => e.family)).size < rule.requires.length)
      continue;
    for (const a of evidence) consumed.add(a.metric);

    const families = new Set(evidence.map((e) => e.family)).size;
    const strength = Math.min(
      1,
      Math.max(...evidence.map((e) => (e.z !== 0 ? Math.abs(e.z) / 4 : e.family === "funding" || e.family === "ip" ? 0.9 : 0.5))),
    );
    // Base from strongest evidence; +0.15 per ADDITIONAL independent family.
    const confidence = Math.min(0.95, Math.round((0.45 + 0.35 * strength + 0.15 * (families - 1)) * 100) / 100);

    out.push({
      state: rule.state,
      confidence,
      independentFamilies: families,
      anomalies: evidence,
      interpretation: rule.interpretation,
      fingerprint: rule.state,
    });
  }
  return out;
}
