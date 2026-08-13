// Deterministic fixtures for WS1 event clustering & source tiering.
// Run: npx tsx scripts/event-cluster.test.ts   (exit 0 = all pass)
// No test framework needed — pure functions, plain assertions.

import {
  tokensOf,
  tokenSim,
  magnitudeKeyOf,
  tierForUrl,
  bestTier,
  eventConfidence,
  normCompanyKey,
  matchEvent,
  mergeTokens,
  type ClusterCandidate,
  type OpenEventLite,
} from "../src/lib/event-cluster";
import { DEFAULT_SIGNAL_CONFIG } from "../src/lib/signal-config";

const cfg = DEFAULT_SIGNAL_CONFIG;

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function openEvent(partial: Partial<OpenEventLite>): OpenEventLite {
  return {
    eventId: "sev-test1",
    company: "Acme",
    eventType: "funding_round",
    firstSeen: "2026-07-20",
    lastUpdated: "2026-07-20",
    status: "open",
    tokens: tokensOf(
      "Acme raises $20M Series B led by Foo Ventures",
      "Acme, the supply chain AI startup, announced a $20M Series B round led by Foo Ventures to expand enterprise sales.",
    ),
    magnitudeKey: "usd:20000000",
    sourceUrls: ["https://techcrunch.com/2026/07/20/acme-series-b"],
    ...partial,
  };
}

function cand(partial: Partial<ClusterCandidate>): ClusterCandidate {
  return {
    company: "Acme",
    eventType: "funding_round",
    title: "Acme lands $20M Series B",
    text: "Acme announced a $20M Series B funding round led by Foo Ventures to grow its supply chain AI platform.",
    dateIso: "2026-07-21",
    sourceUrl: "https://www.businesswire.com/news/acme-series-b",
    ...partial,
  };
}

console.log("— normalization & similarity —");
check("normCompanyKey strips suffixes", normCompanyKey("Acme, Inc.") === normCompanyKey("Acme"));
check(
  "normCompanyKey keeps distinct companies distinct",
  normCompanyKey("Acme Security") !== normCompanyKey("Acme Robotics"),
);
check("tokensOf drops stopwords and short tokens", !tokensOf("The A An Of", "to in at").length);
{
  const a = tokensOf("Acme raises $20M Series B", "led by Foo Ventures for supply chain AI");
  const b = tokensOf("Acme lands $20M Series B round", "Foo Ventures leads investment in supply chain AI startup Acme");
  check("syndicated copies score high similarity", tokenSim(a, b) >= cfg.clustering.simHigh, `got ${tokenSim(a, b).toFixed(2)}`);
}
{
  const a = tokensOf("Acme raises $20M Series B", "funding round led by Foo Ventures");
  const b = tokensOf("Acme ships new observability dashboard", "product update adds real-time metrics and alerting for fleets");
  check("unrelated stories score low similarity", tokenSim(a, b) < cfg.clustering.simLow, `got ${tokenSim(a, b).toFixed(2)}`);
}

console.log("— magnitude extraction —");
check("$20M", magnitudeKeyOf("raised $20M in new funding") === "usd:20000000");
check("$1.5 billion", magnitudeKeyOf("a $1.5 billion valuation round of $300 million") === "usd:1500000000");
check("€40m", magnitudeKeyOf("secures €40m Series A") === "usd:40000000");
check("no magnitude → undefined", magnitudeKeyOf("hires a new CFO") === undefined);

console.log("— source tiering —");
check("SEC is Tier A", tierForUrl("https://www.sec.gov/Archives/edgar/data/1/formd.htm", undefined, cfg) === "A");
check("wire is Tier A", tierForUrl("https://www.businesswire.com/news/x", undefined, cfg) === "A");
check("first-party domain is Tier A", tierForUrl("https://blog.acme.com/series-b", "acme.com", cfg) === "A");
check("TechCrunch is Tier B", tierForUrl("https://techcrunch.com/2026/07/20/acme", "acme.com", cfg) === "B");
check("unknown aggregator is Tier C", tierForUrl("https://news-aggregator.example/acme", "acme.com", cfg) === "C");
check("bestTier prefers A", bestTier(["C", "B", "A"]) === "A");

console.log("— confidence is a pure function of (count, tier, corroboration) —");
{
  const one = eventConfidence(1, "C", false, cfg);
  const many = eventConfidence(4, "C", false, cfg);
  const tierA = eventConfidence(1, "A", false, cfg);
  const intel = eventConfidence(1, "C", true, cfg);
  check("more sources raise confidence", many > one, `${one} → ${many}`);
  check("Tier A beats Tier C", tierA > one);
  check("intel corroboration raises confidence", intel > one);
  check("capped", eventConfidence(10, "A", true, cfg) <= cfg.confidence.cap);
  check(
    "reproducible from stored columns",
    eventConfidence(4, "C", false, cfg) === eventConfidence(4, "C", false, cfg),
  );
}

console.log("— clustering: echo coverage collapses —");
{
  const ev = openEvent({});
  const m = matchEvent(cand({}), [ev], cfg);
  check("second outlet joins the event", m.event?.eventId === "sev-test1", m.reason);
}
{
  // Five syndicated copies, slightly different headlines — all one event.
  const ev = openEvent({});
  const titles = [
    "Acme lands $20M Series B",
    "Acme secures $20M in Series B funding",
    "Foo Ventures leads $20M round in Acme",
    "Supply chain AI startup Acme raises $20M",
    "Acme announces $20M Series B to expand enterprise sales",
  ];
  const joined = titles.filter(
    (t) => matchEvent(cand({ title: t, sourceUrl: `https://outlet-${t.length}.example/${t.length}` }), [ev], cfg).event,
  );
  check("all five syndicated copies merge", joined.length === 5, `${joined.length}/5 merged`);
}
{
  const ev = openEvent({});
  const m = matchEvent(cand({ sourceUrl: "https://techcrunch.com/2026/07/20/acme-series-b" }), [ev], cfg);
  check("identical URL is trivially the same event", m.reason === "identical source URL");
}

console.log("— clustering: guards —");
{
  const ev = openEvent({});
  const m = matchEvent(
    cand({ company: "Globex", title: "Globex lands $20M Series B", text: "Globex announced a $20M Series B round." }),
    [ev],
    cfg,
  );
  check("never merges across companies", m.event === null);
}
{
  const ev = openEvent({});
  const m = matchEvent(
    cand({
      title: "Acme raises $50M Series C",
      text: "Acme announced a $50M Series C round led by Bar Capital.",
    }),
    [ev],
    cfg,
  );
  check(
    "conflicting magnitude → dispute merge (Phase 2.4), not a second event",
    Boolean(m.magnitudeDispute && m.event),
    m.reason,
  );
}
{
  const ev = openEvent({});
  const m = matchEvent(
    cand({
      eventType: "exec_change",
      title: "Acme hires new CRO from BigCo",
      text: "Acme announced a new chief revenue officer joining from BigCo.",
    }),
    [ev],
    cfg,
  );
  check("different event types never merge", m.event === null);
}
{
  const ev = openEvent({ lastUpdated: "2026-06-01", firstSeen: "2026-06-01" });
  const m = matchEvent(cand({ dateIso: "2026-07-21" }), [ev], cfg);
  check("events outside the trailing window don't accept new sources", m.event === null);
}
{
  const ev = openEvent({ status: "closed" });
  const m = matchEvent(cand({}), [ev], cfg);
  check("closed events never accept sources", m.event === null);
}

console.log("— clustering: 'other' classification noise doesn't split clusters —");
{
  const ev = openEvent({});
  const m = matchEvent(
    cand({
      eventType: "other",
      title: "Acme secures $20M Series B led by Foo Ventures",
      text: "Acme announced a $20M Series B round led by Foo Ventures for its supply chain AI platform.",
    }),
    [ev],
    cfg,
  );
  check("'other'-typed near-duplicate joins the typed event", m.event !== null, m.reason);
}
{
  // …but only at the HIGH similarity bar.
  const ev = openEvent({});
  const m = matchEvent(
    cand({
      eventType: "other",
      title: "Acme mentioned in industry roundup",
      text: "A weekly roundup of supply chain startups briefly mentions Acme among others.",
    }),
    [ev],
    cfg,
  );
  check("weakly-similar 'other' does NOT join", m.event === null);
}

console.log("— token centroid —");
{
  const merged = mergeTokens(["alpha", "beta"], ["beta", "gamma"], 60);
  check("mergeTokens unions in order", merged.join(",") === "alpha,beta,gamma");
  check("mergeTokens caps", mergeTokens(Array.from({ length: 60 }, (_, i) => `t${i}`), ["extra"]).length === 60);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
