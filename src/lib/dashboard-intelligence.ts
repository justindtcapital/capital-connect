import type { Contact } from "@/lib/types";

const DAY_MS = 86_400_000;
const TEMP_RANK: Record<string, number> = { Cold: 1, Warm: 2, Hot: 3 };

export type InstrumentTone = "default" | "positive" | "caution" | "critical";

export interface Instrument {
  key: string;
  label: string;
  value: string;
  detail: string;
  tone: InstrumentTone;
  /** Optional 0–100 for radial / bar display */
  score?: number;
}

export interface PulseInsight {
  id: string;
  headline: string;
  detail: string;
  actionLabel: string;
  /** Dim/value to focus when Act is pressed */
  focus?: { dim: string; value: string };
  contactId?: string;
  severity: "info" | "opportunity" | "warning";
}

export interface Recommendation {
  id: string;
  kind: "decay" | "opportunity" | "coverage" | "followup";
  title: string;
  detail: string;
  focus?: { dim: string; value: string };
  contactId?: string;
}

export interface IntelligenceBundle {
  instruments: Instrument[];
  summaryLines: string[];
  pulse: PulseInsight;
  recommendations: Recommendation[];
  networkCount: number;
  hotCount: number;
  followUpCount: number;
  totalIntros: number;
}

function daysSince(date?: string): number | null {
  const ms = Date.parse(date || "");
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / DAY_MS));
}

function lastTouchDays(c: Contact): number | null {
  const candidates = [
    c.lastContact,
    ...(c.interactions || []).map((i) => i.date),
    ...(c.portCoEngagements || []).map((e) => e.date),
  ].filter(Boolean) as string[];
  if (!candidates.length) return daysSince(c.dateAdded);
  let best = Infinity;
  for (const d of candidates) {
    const n = daysSince(d);
    if (n != null && n < best) best = n;
  }
  return best === Infinity ? null : best;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function pct(n: number, d: number): number {
  return d <= 0 ? 0 : Math.round((n / d) * 100);
}

/** Activity-weighted temperature mix by month (last 12) — proxy river. */
export function temperatureRiver(contacts: Contact[]): {
  month: string;
  Hot: number;
  Warm: number;
  Cold: number;
}[] {
  const now = new Date();
  const keys: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const buckets = new Map(keys.map((k) => [k, { Hot: 0, Warm: 0, Cold: 0 }]));

  for (const c of contacts) {
    const t = c.temperature;
    if (t !== "Hot" && t !== "Warm" && t !== "Cold") continue;
    const dates = [
      ...(c.portCoEngagements || []).map((e) => e.date),
      ...(c.interactions || []).map((i) => i.date),
      c.lastContact,
    ].filter(Boolean) as string[];
    const seen = new Set<string>();
    for (const date of dates) {
      const ms = Date.parse(date);
      if (Number.isNaN(ms)) continue;
      const d = new Date(ms);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (!buckets.has(k) || seen.has(k)) continue;
      seen.add(k);
      buckets.get(k)![t] += 1;
    }
  }

  return keys.map((month) => ({ month, ...buckets.get(month)! }));
}

export function sectorTreemapData(contacts: Contact[]): {
  name: string;
  size: number;
  health: number;
}[] {
  const map = new Map<string, { size: number; hotWarm: number }>();
  for (const c of contacts) {
    const name = (c.sector || "").trim();
    if (!name) continue;
    const cur = map.get(name) || { size: 0, hotWarm: 0 };
    cur.size += 1;
    if (c.temperature === "Hot" || c.temperature === "Warm") cur.hotWarm += 1;
    map.set(name, cur);
  }
  return [...map.entries()]
    .map(([name, v]) => ({
      name,
      size: v.size,
      health: pct(v.hotWarm, v.size),
    }))
    .sort((a, b) => b.size - a.size);
}

export function buildIntelligence(
  filtered: Contact[],
  allContacts: Contact[],
  transitions: { from: string; to: string; ts: string }[],
  investorByPortco: Record<string, string>,
  portcoNames: Record<string, string>,
): IntelligenceBundle {
  const networkCount = filtered.length;
  const hotCount = filtered.filter((c) => c.temperature === "Hot").length;
  const warmCount = filtered.filter((c) => c.temperature === "Warm").length;
  const followUpCount = filtered.filter((c) => c.followUpPending).length;
  const totalIntros = filtered.reduce((sum, c) => sum + c.portCoIntros.length, 0);

  // —— Relationship Health (0–100)
  const hotWarmPct = pct(hotCount + warmCount, networkCount);
  const followUpDebtPct = pct(followUpCount, networkCount);
  const freshnessDays = filtered
    .map(lastTouchDays)
    .filter((d): d is number => d != null);
  const medFresh = median(freshnessDays) ?? 90;
  const freshnessScore = Math.max(0, Math.min(100, 100 - medFresh));
  const health = Math.round(
    hotWarmPct * 0.45 + (100 - followUpDebtPct) * 0.25 + freshnessScore * 0.3,
  );

  // —— Network Momentum (30d vs prior 30d)
  const now = Date.now();
  const d30 = now - 30 * DAY_MS;
  const d60 = now - 60 * DAY_MS;
  const addedRecent = filtered.filter((c) => {
    const ms = Date.parse(c.dateAdded || "");
    return !Number.isNaN(ms) && ms >= d30;
  }).length;
  const addedPrior = filtered.filter((c) => {
    const ms = Date.parse(c.dateAdded || "");
    return !Number.isNaN(ms) && ms >= d60 && ms < d30;
  }).length;
  let upgrades = 0;
  let downgrades = 0;
  let upgradesPrior = 0;
  let downgradesPrior = 0;
  for (const t of transitions) {
    const ms = Date.parse(t.ts);
    if (Number.isNaN(ms)) continue;
    const up = (TEMP_RANK[t.to] ?? 0) > (TEMP_RANK[t.from] ?? 0);
    const down = (TEMP_RANK[t.to] ?? 0) < (TEMP_RANK[t.from] ?? 0);
    if (ms >= d30) {
      if (up) upgrades++;
      if (down) downgrades++;
    } else if (ms >= d60) {
      if (up) upgradesPrior++;
      if (down) downgradesPrior++;
    }
  }
  const engRecent = filtered.reduce((n, c) => {
    return (
      n +
      (c.portCoEngagements || []).filter((e) => {
        const ms = Date.parse(e.date || "");
        return !Number.isNaN(ms) && ms >= d30;
      }).length
    );
  }, 0);
  const engPrior = filtered.reduce((n, c) => {
    return (
      n +
      (c.portCoEngagements || []).filter((e) => {
        const ms = Date.parse(e.date || "");
        return !Number.isNaN(ms) && ms >= d60 && ms < d30;
      }).length
    );
  }, 0);
  const scoreRecent = addedRecent + upgrades - downgrades + engRecent * 0.25;
  const scorePrior = addedPrior + upgradesPrior - downgradesPrior + engPrior * 0.25;
  const momentumDelta =
    scorePrior === 0
      ? scoreRecent > 0
        ? 100
        : 0
      : Math.round(((scoreRecent - scorePrior) / Math.max(scorePrior, 1)) * 100);

  // —— Opportunity Velocity (Hot/Warm with follow-up or recent intro, per week)
  const d14 = now - 14 * DAY_MS;
  const opportunitySet = filtered.filter((c) => {
    if (c.temperature !== "Hot" && c.temperature !== "Warm") return false;
    if (c.followUpPending) return true;
    return (c.portCoEngagements || []).some((e) => {
      const ms = Date.parse(e.date || "");
      return !Number.isNaN(ms) && ms >= d14;
    });
  });
  const velocityPerWeek = Math.round((opportunitySet.length / 2) * 10) / 10;

  // —— Portfolio Coverage
  const allPortcos = new Set<string>();
  for (const key of Object.keys(investorByPortco)) {
    allPortcos.add(key);
  }
  for (const c of allContacts) {
    for (const p of c.portCoIntros || []) {
      if (p.trim()) allPortcos.add(p.trim().toLowerCase());
    }
  }
  const covered = new Set<string>();
  for (const c of filtered) {
    for (const p of c.portCoIntros || []) {
      const k = p.trim().toLowerCase();
      if (k) covered.add(k);
    }
  }
  // Also count Asana portcos that have at least one intro match by name
  let asanaCovered = 0;
  const asanaKeys = Object.keys(investorByPortco);
  for (const key of asanaKeys) {
    if (covered.has(key) || covered.has((portcoNames[key] || "").trim().toLowerCase())) {
      asanaCovered++;
    }
  }
  const coverageDenom = asanaKeys.length || allPortcos.size || 1;
  const coverageNum = asanaKeys.length ? asanaCovered : covered.size;
  const coveragePct = pct(coverageNum, coverageDenom);
  const coverageGaps = Math.max(0, coverageDenom - coverageNum);

  // —— Influence (prime intro diversity)
  const primeStats = new Map<string, { intros: number; portcos: Set<string> }>();
  for (const c of filtered) {
    const p = (c.prime || "").trim() || "—";
    const cur = primeStats.get(p) || { intros: 0, portcos: new Set<string>() };
    cur.intros += c.portCoIntros.length;
    for (const co of c.portCoIntros) cur.portcos.add(co);
    primeStats.set(p, cur);
  }
  const topPrimes = [...primeStats.entries()]
    .map(([name, v]) => ({
      name,
      score: v.intros * 0.5 + v.portcos.size,
    }))
    .sort((a, b) => b.score - a.score);
  const topPrime = topPrimes[0];

  const healthTone: InstrumentTone =
    health >= 70 ? "positive" : health >= 45 ? "caution" : "critical";
  const momentumTone: InstrumentTone =
    momentumDelta > 5 ? "positive" : momentumDelta < -5 ? "critical" : "default";
  const freshTone: InstrumentTone =
    medFresh <= 30 ? "positive" : medFresh <= 60 ? "caution" : "critical";

  const instruments: Instrument[] = [
    {
      key: "health",
      label: "Relationship Health",
      value: String(health),
      detail: `${hotWarmPct}% warm+ · ${followUpCount} follow-ups open`,
      tone: healthTone,
      score: health,
    },
    {
      key: "momentum",
      label: "Network Momentum",
      value: `${momentumDelta > 0 ? "+" : ""}${momentumDelta}%`,
      detail: `${addedRecent} added · ${upgrades}↑ ${downgrades}↓ · 30d`,
      tone: momentumTone,
    },
    {
      key: "velocity",
      label: "Opportunity Velocity",
      value: String(velocityPerWeek),
      detail: `${opportunitySet.length} active paths · /wk`,
      tone: velocityPerWeek >= 3 ? "positive" : "default",
    },
    {
      key: "coverage",
      label: "Portfolio Coverage",
      value: `${coveragePct}%`,
      detail:
        coverageGaps > 0
          ? `${coverageGaps} portco${coverageGaps === 1 ? "" : "s"} thin`
          : "Full intro coverage",
      tone: coveragePct >= 70 ? "positive" : coveragePct >= 40 ? "caution" : "critical",
      score: coveragePct,
    },
    {
      key: "freshness",
      label: "Relationship Freshness",
      value: medFresh != null ? `${Math.round(medFresh)}d` : "—",
      detail: "Median days since last touch",
      tone: freshTone,
      score: freshnessScore,
    },
    {
      key: "influence",
      label: "Network Influence",
      value: topPrime ? topPrime.name : "—",
      detail: topPrime
        ? `Top prime · ${Math.round(topPrime.score)} leverage`
        : "No prime activity",
      tone: "default",
    },
  ];

  // Sector momentum for summary
  const sectorWarm = new Map<string, number>();
  for (const c of filtered) {
    if (!c.sector) continue;
    if (c.temperature === "Hot" || c.temperature === "Warm") {
      sectorWarm.set(c.sector, (sectorWarm.get(c.sector) || 0) + 1);
    }
  }
  const topSector = [...sectorWarm.entries()].sort((a, b) => b[1] - a[1])[0];

  const summaryLines: string[] = [];
  if (momentumDelta > 5) {
    summaryLines.push(`Network momentum is up ${momentumDelta}% versus the prior 30 days.`);
  } else if (momentumDelta < -5) {
    summaryLines.push(`Network momentum softened ${Math.abs(momentumDelta)}% versus the prior 30 days.`);
  } else {
    summaryLines.push(`Network momentum is steady versus the prior 30 days.`);
  }
  if (topSector) {
    summaryLines.push(`${topSector[0]} relationships are carrying the most warmth (${topSector[1]} Hot/Warm).`);
  }
  if (opportunitySet.length > 0) {
    summaryLines.push(
      `${opportunitySet.length} warm path${opportunitySet.length === 1 ? "" : "s"} need attention in the next two weeks.`,
    );
  }
  if (coverageGaps > 0) {
    summaryLines.push(`${coverageGaps} portfolio compan${coverageGaps === 1 ? "y is" : "ies are"} thinly covered by intros.`);
  }
  if (followUpCount > 0) {
    summaryLines.push(`${followUpCount} follow-up${followUpCount === 1 ? "" : "s"} still open across the book.`);
  }

  // —— Pulse: pick the single most important shift
  let pulse: PulseInsight;
  if (coverageGaps >= 2) {
    pulse = {
      id: "coverage",
      headline: `${coverageGaps} portcos lack intro coverage`,
      detail: "Portfolio coverage is the binding constraint — open Investor Analytics or focus a thin portco.",
      actionLabel: "Review coverage",
      severity: "warning",
    };
  } else if (followUpCount >= 5) {
    const hotFollow = filtered.find((c) => c.followUpPending && c.temperature === "Hot");
    pulse = hotFollow
      ? {
          id: "followups",
          headline: `${followUpCount} follow-ups are open`,
          detail: `Highest priority: ${hotFollow.name}${hotFollow.company ? ` · ${hotFollow.company}` : ""}.`,
          actionLabel: `Open ${hotFollow.name.split(" ")[0]}`,
          contactId: hotFollow.id,
          severity: "opportunity",
        }
      : {
          id: "followups",
          headline: `${followUpCount} follow-ups are open`,
          detail: "Clear follow-up debt to protect relationship health.",
          actionLabel: "Show Hot",
          focus: { dim: "temperature", value: "Hot" },
          severity: "opportunity",
        };
  } else if (topSector && momentumDelta >= 0) {
    pulse = {
      id: "sector",
      headline: `${topSector[0]} warmth is rising`,
      detail: `${topSector[1]} Hot/Warm relationships · focus the constellation on this sector.`,
      actionLabel: `Focus ${topSector[0]}`,
      focus: { dim: "sector", value: topSector[0] },
      severity: "opportunity",
    };
  } else if (opportunitySet[0]) {
    const c = opportunitySet[0];
    pulse = {
      id: "path",
      headline: `Active path: ${c.name}`,
      detail: `${c.temperature}${c.portCoIntros[0] ? ` · intro path to ${c.portCoIntros[0]}` : ""} · ${c.prime || "unassigned"} prime`,
      actionLabel: "Focus contact",
      severity: "info",
    };
  } else {
    pulse = {
      id: "steady",
      headline: `${networkCount.toLocaleString()} relationships in view`,
      detail: "Filters applied · explore the constellation or expand instruments below.",
      actionLabel: "Clear focus",
      severity: "info",
    };
  }

  // —— Recommendations
  const recommendations: Recommendation[] = [];
  const stale = filtered
    .filter((c) => {
      const d = lastTouchDays(c);
      return d != null && d > 90 && (c.temperature === "Warm" || c.temperature === "Hot");
    })
    .slice(0, 3);
  for (const c of stale) {
    recommendations.push({
      id: `decay-${c.id}`,
      kind: "decay",
      title: `Relationship decay: ${c.name}`,
      detail: `${lastTouchDays(c)}d since last touch · was ${c.temperature}`,
      contactId: c.id,
    });
  }
  for (const c of opportunitySet.filter((x) => x.followUpPending).slice(0, 3)) {
    if (recommendations.some((r) => r.contactId === c.id)) continue;
    recommendations.push({
      id: `fu-${c.id}`,
      kind: "followup",
      title: `Follow up: ${c.name}`,
      detail: [c.title, c.company, c.temperature].filter(Boolean).join(" · "),
      contactId: c.id,
    });
  }
  if (coverageGaps > 0 && asanaKeys.length) {
    const uncovered = asanaKeys
      .filter((key) => {
        const name = (portcoNames[key] || key).trim().toLowerCase();
        return !covered.has(key) && !covered.has(name);
      })
      .slice(0, 3);
    for (const key of uncovered) {
      const name = portcoNames[key] || key;
      recommendations.push({
        id: `cov-${key}`,
        kind: "coverage",
        title: `Coverage gap: ${name}`,
        detail: `Lead: ${investorByPortco[key] || "—"} · no network intro path`,
        focus: { dim: "portco", value: portcoNames[key] || name },
      });
    }
  }
  if (topPrime && topPrime.name !== "—") {
    recommendations.push({
      id: "opp-prime",
      kind: "opportunity",
      title: `${topPrime.name} is concentrating intros`,
      detail: "Review intro quality and load-balance across primes.",
      focus: { dim: "prime", value: topPrime.name },
    });
  }

  return {
    instruments,
    summaryLines: summaryLines.slice(0, 5),
    pulse,
    recommendations: recommendations.slice(0, 8),
    networkCount,
    hotCount,
    followUpCount,
    totalIntros,
  };
}

export { lastTouchDays };
