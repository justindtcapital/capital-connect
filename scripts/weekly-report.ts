// Phase 0 — weekly Signal Reader scorecard one-pager.
//
// Reads live Sheets tabs (Signal Feedback, Time Advantage, Signal Overflow,
// Ops Log) and writes reports/signals-weekly-YYYY-MM-DD.md.
//
// Run:   npx tsx scripts/weekly-report.ts [--days 7]
//
// Metrics (90+ scorecard):
//   precision@10, duplicate rate, verdict histogram by source host,
//   time-advantage distribution, cap-overflow count, pipeline success skim.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(path: string) {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (e) {
    console.error("Failed to load .env:", e);
    process.exit(1);
  }
}
loadEnv(resolve(process.cwd(), ".env"));

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const DAYS = Number(argOf("days", "7")) || 7;

const { isFeedbackVerdict } = await import("../src/lib/feedback");
const { auditEvidenceCompleteness } = await import("../src/lib/evidence-completeness");
const {
  loadSignalFeedback,
  loadTimeAdvantage,
  loadSignalOverflow,
  ensureSignalV2Tabs,
} = await import("../src/utils/event-store.server");
const { buildOpsLog } = await import("../src/utils/sheets.server");
const { fetchStoredSignals } = await import("../src/utils/signal-store.server");

await ensureSignalV2Tabs();

const feedback = await loadSignalFeedback({ sinceDays: DAYS });
const advantage = await loadTimeAdvantage({ sinceDays: DAYS });
const overflow = await loadSignalOverflow({ sinceDays: DAYS });
const ops = await buildOpsLog(200);
const storedSignals = await fetchStoredSignals();

const recentStored = storedSignals.filter((s) => {
  const t = Date.parse(s.dateFound || "");
  return Number.isFinite(t) && t >= Date.now() - DAYS * 86_400_000;
});
const evidence = auditEvidenceCompleteness(
  recentStored.map((s) => ({
    id: s.id,
    scoreBreakdown: s.scoreBreakdown,
    rankScore: s.rankScore,
  })),
  { onlySurfaced: true, minRank: 1 },
);

const verdicts = feedback.filter((r) => isFeedbackVerdict(r.action));
const interactions = feedback.filter((r) => !isFeedbackVerdict(r.action));

// Precision@10: among feedback rows with rankPosition 1–10, share marked useful.
const top10Verdicts = verdicts.filter(
  (r) => r.rankPosition != null && r.rankPosition >= 1 && r.rankPosition <= 10,
);
const usefulTop10 = top10Verdicts.filter((r) => r.action === "useful").length;
const precisionAt10 =
  top10Verdicts.length > 0 ? usefulTop10 / top10Verdicts.length : null;

// Duplicate rate among all partner verdicts.
const dupish = verdicts.filter(
  (r) => r.action === "duplicate" || r.action === "already_knew",
).length;
const duplicateRate = verdicts.length > 0 ? dupish / verdicts.length : null;

// Verdict histogram by source host.
const byHost = new Map<string, Map<string, number>>();
for (const r of verdicts) {
  const host = String(r.featureVector.sourceHost || "(unknown)");
  if (!byHost.has(host)) byHost.set(host, new Map());
  const m = byHost.get(host)!;
  m.set(r.action, (m.get(r.action) || 0) + 1);
}

// Verdict action totals.
const verdictCounts = new Map<string, number>();
for (const r of verdicts) {
  verdictCounts.set(r.action, (verdictCounts.get(r.action) || 0) + 1);
}

// Time-advantage distribution.
const advDays = advantage.map((a) => a.advantageDays).sort((a, b) => a - b);
const pct = (arr: number[], p: number): number | null => {
  if (arr.length === 0) return null;
  const i = Math.min(arr.length - 1, Math.max(0, Math.floor((p / 100) * (arr.length - 1))));
  return arr[i];
};
const advMedian = pct(advDays, 50);
const advP25 = pct(advDays, 25);
const advP75 = pct(advDays, 75);
const advMean =
  advDays.length > 0 ? advDays.reduce((s, x) => s + x, 0) / advDays.length : null;

// Pipeline success from Ops Log (signals_scan + signals_reconcile).
const sinceMs = Date.now() - DAYS * 86_400_000;
const pipelineOps = ops.filter((e) => {
  const t = Date.parse(e.timestamp || "");
  if (!Number.isFinite(t) || t < sinceMs) return false;
  const src = (e.source || "").toLowerCase();
  return src.includes("signal") || src.includes("intel");
});
const okOps = pipelineOps.filter((e) => (e.status || "").toLowerCase() === "ok").length;
const errOps = pipelineOps.filter((e) => (e.status || "").toLowerCase() === "error").length;
const pipelineRate =
  pipelineOps.length > 0 ? okOps / pipelineOps.length : null;

const today = new Date().toISOString().split("T")[0];
const pctFmt = (n: number | null) =>
  n == null ? "n/a (no labels yet)" : `${(n * 100).toFixed(1)}%`;
const numFmt = (n: number | null, digits = 1) =>
  n == null ? "n/a" : n.toFixed(digits);

const hostLines = [...byHost.entries()]
  .sort((a, b) => {
    const sum = (m: Map<string, number>) => [...m.values()].reduce((s, x) => s + x, 0);
    return sum(b[1]) - sum(a[1]);
  })
  .slice(0, 15)
  .map(([host, m]) => {
    const parts = [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([a, c]) => `${a}:${c}`)
      .join(", ");
    return `- \`${host}\` — ${parts}`;
  });

const verdictLines = [...verdictCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([a, c]) => `- **${a}**: ${c}`);

const md = `# Signals weekly report — ${today}

Window: last **${DAYS}** days · generated ${new Date().toISOString()}

## Scorecard

| Metric | Value | 90+ target |
|---|---|---|
| Precision@10 (useful in ranked top-10 feedback) | ${pctFmt(precisionAt10)} | ≥ 80% |
| Duplicate rate (duplicate + already_knew) | ${pctFmt(duplicateRate)} | ≤ 3% |
| Partner verdicts collected | ${verdicts.length} | compounding |
| Time-advantage median (days) | ${numFmt(advMedian, 0)} (n=${advDays.length}) | > 3 |
| Cap overflow rows | ${overflow.length} | tune recall |
| Evidence completeness (scoreBreakdown why) | ${pctFmt(evidence.rate)} (${evidence.complete}/${evidence.checked}) | 100% |
| Pipeline success (Ops Log signal/intel) | ${pctFmt(pipelineRate)} (${okOps} ok / ${errOps} err / ${pipelineOps.length} total) | ≥ 99% |

## Verdicts

${verdictLines.length ? verdictLines.join("\n") : "_No partner verdicts in window._"}

Interaction events (rendered/expanded/…): **${interactions.length}**

## By source host

${hostLines.length ? hostLines.join("\n") : "_No sourceHost snapshots yet — expand cards and leave verdicts._"}

## Time advantage (intel → press)

- n = ${advDays.length}
- median = ${advMedian == null ? "n/a" : `${advMedian}d`} · p25 = ${advP25 == null ? "n/a" : `${advP25}d`} · p75 = ${advP75 == null ? "n/a" : `${advP75}d`} · mean = ${advMean == null ? "n/a" : `${advMean.toFixed(1)}d`}
${
  advantage.slice(0, 8)
    .map(
      (a) =>
        `- ${a.company || a.entityUrid || a.eventId}: **${a.advantageDays}d** (${a.intelFirstSeen} → ${a.pressFirstSeen})`,
    )
    .join("\n") || "_No CONFIRMED_BY_PRESS ledger rows yet._"
}

## Scan overflow (capped candidates)

- Total discarded rows: **${overflow.length}**
${(() => {
  const byKind = new Map<string, number>();
  for (const o of overflow) byKind.set(o.kind, (byKind.get(o.kind) || 0) + 1);
  return [...byKind.entries()]
    .map(([k, c]) => `- ${k}: ${c}`)
    .join("\n");
})() || "_No overflow this window (caps not hit or ledger empty)._"}

## Evidence completeness (Phase 3.3)

Surfaced signals (rank ≥ 1) in window with reconstructible \`scoreBreakdown\` parts:

- complete: **${evidence.complete}** / ${evidence.checked} (${pctFmt(evidence.rate)})
- incomplete samples:
${
  evidence.samples.length
    ? evidence.samples
        .map((s) => `- \`${s.id.slice(0, 48)}\`: ${s.missing.slice(0, 3).join("; ") || "missing meta"}`)
        .join("\n")
    : "_All checked rows decompose cleanly (or none scored yet)._"
}

## Ops notes

Pipeline skim is from the Sheets **Ops Log** (sources matching signal/intel). Inngest run history is not wired here — treat as N/A until cron dashboards land.

Phase 3 Stage B: set \`SIGNALS_PIPELINE_V3=shadow\` to extract-without-merge, or \`true\` to merge extract awareness into the feed. Postgres schema scaffold: \`scripts/sql/signals-v3-schema.sql\`.

---

_Phase 0–3 measurement + pipeline restructure. Re-run Mondays: \`npx tsx scripts/weekly-report.ts\`._
`;

const outDir = resolve(process.cwd(), "reports");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `signals-weekly-${today}.md`);
writeFileSync(outPath, md, "utf8");
console.log(md);
console.log(`\nWrote ${outPath}`);
