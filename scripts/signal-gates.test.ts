// Phase 2 — trust gates + novelty fixtures.
// Run: npx tsx scripts/signal-gates.test.ts

import { gateSignal, DEFAULT_GATE_CONFIG } from "../src/lib/signal-gates";
import { classifyNovelty } from "../src/lib/novelty";
import { independentSourceCount, tokensOf } from "../src/lib/event-cluster";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

{
  const g = gateSignal({
    resolveConfidence: 0.4,
    resolveRung: "ambiguous",
    independentSources: 2,
    hasIntelEvidence: false,
    noveltyClass: "new",
  });
  assert(g.outcome === "needs_review", `ambiguous → needs_review got ${g.outcome}`);
}

{
  const g = gateSignal({
    resolveConfidence: 0.9,
    resolveRung: "alias_exact",
    independentSources: 0,
    hasIntelEvidence: false,
    noveltyClass: "new",
  });
  assert(g.outcome === "hold", `thin → hold got ${g.outcome}`);
}

{
  // Lone Tier C aggregator → abCount 0 → hold gate input.
  const onlyC = independentSourceCount([
    {
      url: "https://random-aggregator.com/acme-20m",
      tier: "C",
      dateIso: "2026-07-01",
      tokens: tokensOf("Acme raises $20M", ""),
    },
  ]);
  assert(onlyC.abCount === 0, `Tier C alone abCount=0 got ${onlyC.abCount}`);
  assert(onlyC.count === 1, `Tier C still counts in total: ${onlyC.why}`);
}

{
  const g = gateSignal({
    resolveConfidence: 0.9,
    resolveRung: "alias_exact",
    independentSources: 0,
    hasIntelEvidence: true,
    noveltyClass: "new",
  });
  assert(g.outcome === "pass", `intel evidence clears hold: ${g.outcome}`);
}

{
  const g = gateSignal({
    resolveConfidence: 0.9,
    resolveRung: "alias_exact",
    independentSources: 1,
    hasIntelEvidence: false,
    noveltyClass: "recycled",
  });
  assert(g.outcome === "withhold", `recycled → withhold got ${g.outcome}`);
}

{
  const prior = [
    {
      eventId: "sev-old",
      company: "Acme",
      eventType: "funding_round",
      firstSeen: "2026-01-01",
      lastUpdated: "2026-01-01",
      tokens: tokensOf("Acme raises $20M Series B", "Acme announced a $20M Series B round led by Bar Capital"),
      magnitudeKey: "usd:20000000",
    },
  ];
  const recycled = classifyNovelty(
    {
      company: "Acme",
      eventType: "funding_round",
      title: "Acme raises $20M Series B",
      text: "Acme announced a $20M Series B round led by Bar Capital — looking back months later",
      dateIso: "2026-04-01",
      magnitudeKey: "usd:20000000",
    },
    prior,
  );
  assert(recycled.class === "recycled", recycled.why);
  assert(recycled.matchedEventId === "sev-old", "matched prior");
}

{
  // Synthetic 10-reprint: one Tier A + many same-day Tier B/C copies → count 1.
  const aTok = tokensOf("Acme raises $20M", "Acme announced a $20M Series B led by Bar");
  const sources = [
    {
      url: "https://www.businesswire.com/news/acme",
      tier: "A" as const,
      dateIso: "2026-07-01",
      tokens: aTok,
    },
    ...Array.from({ length: 9 }, (_, i) => ({
      url: `https://aggregator${i}.com/acme-20m`,
      tier: "C" as const,
      dateIso: "2026-07-01",
      tokens: aTok,
    })),
  ];
  const indep = independentSourceCount(sources);
  assert(indep.count === 1, `expected 1 independent got ${indep.count}: ${indep.why}`);
  assert(indep.abCount === 1, `expected 1 Tier A/B got ${indep.abCount}: ${indep.why}`);
  assert(indep.syndicated >= 1, `expected syndications: ${indep.why}`);
}

console.log("signal-gates.test.ts: all assertions passed");
