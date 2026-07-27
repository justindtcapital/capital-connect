// Signals v2 replay harness (WS1/WS2 acceptance tooling).
//
// Reads the last N days of STORED signals (Signals + Signals Archive tabs),
// runs them through the new deterministic pipeline IN MEMORY (no LLM, no
// writes: category-map classification + clustering + materiality ranking),
// and reports:
//   1. the clusters formed (for the manual <10%-bad-merge spot check),
//   2. a before/after ranking diff (current feed order vs. rank_score order),
//   3. precision@10 for both orderings IF a hand-label file exists.
//
// Run:   npx tsx scripts/replay-signals.ts [--days 30] [--labels labels.json]
// Label file format (hand-made after reviewing the report):
//   { "important": ["<signal id>", ...] }   — ids judged genuinely important.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
const DAYS = Number(argOf("days", "30")) || 30;
const LABELS_PATH = argOf("labels", "scripts/replay-labels.json");

const { fetchStoredSignals } = await import("../src/utils/signal-store.server");
const { fetchSheetTab, TAB_NAMES } = await import("../src/utils/sheets.server");
const {
  matchEvent,
  mergeTokens,
  tokensOf,
  tierForUrl,
  bestTier,
  eventConfidence,
} = await import("../src/lib/event-cluster");
const { DEFAULT_SIGNAL_CONFIG, eventTypeFromCategory } = await import(
  "../src/lib/signal-config"
);
const { scoreMateriality, applySurprise, eventRelevance, eventActionability, rankScore } =
  await import("../src/lib/materiality");

const cfg = DEFAULT_SIGNAL_CONFIG;
const cutoff = new Date(Date.now() - DAYS * 86_400_000).toISOString().split("T")[0];

// ── Load stored signals (hot tab + archive) ──────────────────────
const hot = await fetchStoredSignals();
let archived: typeof hot = [];
try {
  const rows = await fetchSheetTab(TAB_NAMES.signalsArchive);
  // Archive shares SIGNAL_HEADERS; reuse the same positional mapping via a
  // tiny local parse (only the fields the replay needs).
  archived = rows.slice(1).map((r) => ({
    id: (r[0] || "").trim(),
    dateFound: (r[1] || "").trim(),
    type: ((r[2] || "").trim().toLowerCase() as "recommendation" | "awareness") || "awareness",
    status: r[3] || "",
    person: r[4] || "",
    company: (r[5] || "").trim(),
    email: r[6] || "",
    category: (r[7] || "").trim(),
    signal: (r[8] || "").trim(),
    sourceUrl: (r[9] || "").trim(),
    subject: (r[10] || "").trim(),
    body: "",
    relevance: Number(r[12]) || 0,
    justification: (r[13] || "").trim(),
    urgency: r[14] || "",
    timing: r[15] || "",
    sourceType: r[16] || "",
    docUrl: r[17] || "",
    hasBody: false,
  }));
} catch {
  /* no archive tab yet */
}
const signals = [...hot, ...archived]
  .filter((s) => s.dateFound >= cutoff && (s.company || "").trim())
  .sort((a, b) => a.dateFound.localeCompare(b.dateFound));

console.log(`Replaying ${signals.length} stored signals since ${cutoff}\n`);
if (signals.length === 0) process.exit(0);

// ── Cluster in memory (chronological, exactly like the pipeline) ─
interface ReplayEvent {
  eventId: string;
  company: string;
  eventType: ReturnType<typeof eventTypeFromCategory>;
  firstSeen: string;
  lastUpdated: string;
  status: string;
  tokens: string[];
  sourceUrls: string[];
  tiers: Array<"A" | "B" | "C">;
  members: typeof signals;
  recRelevances: number[];
}
const events: ReplayEvent[] = [];
let seq = 0;

for (const s of signals) {
  const eventType = eventTypeFromCategory(s.category);
  const title = s.subject || s.signal || "";
  const text = s.signal || s.justification || "";
  const url = /^https?:\/\//i.test(s.sourceUrl) ? s.sourceUrl : "";
  const m = matchEvent(
    {
      company: s.company,
      eventType,
      title,
      text,
      dateIso: s.dateFound,
      sourceUrl: url,
    },
    events.map((e) => ({
      eventId: e.eventId,
      company: e.company,
      eventType: e.eventType,
      firstSeen: e.firstSeen,
      lastUpdated: e.lastUpdated,
      status: e.status,
      tokens: e.tokens,
      sourceUrls: e.sourceUrls,
    })),
    cfg,
  );
  const tier = url ? tierForUrl(url, undefined, cfg) : "C";
  if (m.event) {
    const ev = events.find((e) => e.eventId === m.event!.eventId)!;
    if (url && !ev.sourceUrls.includes(url)) ev.sourceUrls.push(url);
    ev.tiers.push(tier);
    ev.tokens = mergeTokens(ev.tokens, tokensOf(title, text));
    ev.lastUpdated = s.dateFound;
    ev.members.push(s);
    if (s.type === "recommendation" && s.relevance > 0) ev.recRelevances.push(s.relevance);
  } else {
    events.push({
      eventId: `replay-${++seq}`,
      company: s.company,
      eventType,
      firstSeen: s.dateFound,
      lastUpdated: s.dateFound,
      status: "open",
      tokens: tokensOf(title, text),
      sourceUrls: url ? [url] : [],
      tiers: [tier],
      members: [s],
      recRelevances: s.type === "recommendation" && s.relevance > 0 ? [s.relevance] : [],
    });
  }
}

// ── Report 1: clusters for the manual spot check ─────────────────
const multi = events.filter((e) => e.members.length > 1).sort((a, b) => b.members.length - a.members.length);
console.log(`=== CLUSTERS (${events.length} events from ${signals.length} rows; ${multi.length} multi-source) ===`);
console.log(`Spot-check the top clusters — a BAD merge = two distinct real-world events fused:\n`);
for (const e of multi.slice(0, 20)) {
  console.log(`  [${e.members.length}×] ${e.company} — ${e.eventType} (${e.firstSeen})`);
  for (const mm of e.members.slice(0, 6)) {
    console.log(`      · ${mm.dateFound} ${(mm.subject || mm.signal).slice(0, 90)}`);
  }
}

// ── Score events (no LLM: magnitudes off, surprise unmodulated) ──
interface Ranked {
  id: string;
  company: string;
  headline: string;
  eventType: string;
  members: number;
  oldScore: number; // current feed proxy: attribution relevance
  rank: number;
  suppressed: boolean;
}
const ranked: Ranked[] = events.map((e) => {
  const mat = scoreMateriality(
    { eventType: e.eventType, magnitude: null, isPortco: false, isWatch: false, atsOpenRoles: null },
    cfg,
  );
  const sur = applySurprise(mat.materiality, null, cfg);
  const rel = eventRelevance(
    { recRelevances: e.recRelevances, isPortco: false, isWatch: false, networkContactCount: 0 },
    cfg,
  );
  const act = eventActionability(
    { hasContactEmail: e.members.some((m2) => m2.email), hasPrime: false, daysSinceLastContact: null },
    cfg,
  );
  const r = rankScore(
    { materialityAdj: sur.materialityAdj, relevance: rel.relevance, actionability: act.actionability },
    cfg,
  );
  const best = e.members.reduce((a, b) => (b.relevance > a.relevance ? b : a), e.members[0]);
  return {
    id: best.id,
    company: e.company,
    headline: (best.subject || best.signal).slice(0, 80),
    eventType: e.eventType,
    members: e.members.length,
    oldScore: Math.max(...e.members.map((m2) => m2.relevance), 0),
    rank: r.rank,
    suppressed: r.suppressed,
  };
});

const byOld = [...ranked].sort((a, b) => b.oldScore - a.oldScore);
const byNew = [...ranked].sort((a, b) => b.rank - a.rank);

console.log(`\n=== RANKING DIFF (top 10) ===`);
console.log(`--- current ordering (attribution relevance) ---`);
byOld.slice(0, 10).forEach((r, i) => console.log(`  ${i + 1}. [rel ${r.oldScore}] ${r.company}: ${r.headline}`));
console.log(`--- new ordering (rank_score = materiality^α × relevance^β × actionability^γ) ---`);
byNew.slice(0, 10).forEach((r, i) =>
  console.log(`  ${i + 1}. [rank ${r.rank}${r.suppressed ? " SUPPRESSED" : ""}] ${r.company} (${r.eventType}, ${r.members} src): ${r.headline}`),
);

// ── Report 3: precision@10 when hand labels exist ────────────────
if (existsSync(LABELS_PATH)) {
  const labels = JSON.parse(readFileSync(LABELS_PATH, "utf8")) as { important: string[] };
  const important = new Set(labels.important || []);
  const p10 = (list: Ranked[]) =>
    list.slice(0, 10).filter((r) => important.has(r.id)).length / Math.min(10, list.length);
  console.log(`\n=== PRECISION@10 (${important.size} hand-labeled important) ===`);
  console.log(`  current ordering: ${(p10(byOld) * 100).toFixed(0)}%`);
  console.log(`  new ordering:     ${(p10(byNew) * 100).toFixed(0)}%`);
} else {
  // Emit a labeling template covering both top-10s so precision@10 is comparable.
  const union = new Map<string, Ranked>();
  for (const r of [...byOld.slice(0, 15), ...byNew.slice(0, 15)]) union.set(r.id, r);
  const template = {
    _instructions:
      "Mark genuinely important events by moving their id into `important`, then re-run with --labels",
    important: [] as string[],
    candidates: [...union.values()].map((r) => ({
      id: r.id,
      company: r.company,
      headline: r.headline,
      eventType: r.eventType,
    })),
  };
  writeFileSync(LABELS_PATH, JSON.stringify(template, null, 2));
  console.log(`\nNo label file found — wrote a labeling template to ${LABELS_PATH}.`);
  console.log(`Hand-mark important ids there, then re-run to get precision@10 for both orderings.`);
}
