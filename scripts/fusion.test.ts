// Deterministic fixtures for WS3 pipeline fusion.
// Run: npx tsx scripts/fusion.test.ts   (exit 0 = all pass)

import {
  matchIntelCorroboration,
  newsTypesForIntelState,
  isDetectedBeforePress,
  taxonomyTypeForIntelState,
  mergeBadges,
  BADGE,
  type IntelEventLite,
} from "../src/lib/fusion";
import { scoreMateriality, applySurprise, eventRelevance, eventActionability, rankScore } from "../src/lib/materiality";
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

function intelEvent(partial: Partial<IntelEventLite>): IntelEventLite {
  return {
    eventId: "ev-formd1",
    urid: "urid-acme",
    entity: "Acme",
    state: "Fundraising evidence",
    status: "emerging",
    firstDetected: "2026-07-11",
    lastUpdated: "2026-07-11",
    confidence: 0.8,
    evidenceLines: ["2026-07-11 sec_formd_filings: 0 → 1"],
    signalId: "s-intel-1",
    ...partial,
  };
}

console.log("— corroboration matching —");
{
  const m = matchIntelCorroboration(
    { newsType: "funding_round", company: "Acme", entityUrid: "urid-acme", newsFirstSeen: "2026-07-20" },
    [intelEvent({})],
    cfg,
  );
  check("Form D corroborates a funding story", m?.intel.eventId === "ev-formd1");
  check("intel was first → merge keeps intel's first_seen", m?.intelWasFirst === true);
}
{
  const m = matchIntelCorroboration(
    { newsType: "funding_round", company: "Globex", newsFirstSeen: "2026-07-20" },
    [intelEvent({})],
    cfg,
  );
  check("different company never corroborates", m === null);
}
{
  const m = matchIntelCorroboration(
    { newsType: "funding_round", company: "Acme", newsFirstSeen: "2026-07-20" },
    [intelEvent({ firstDetected: "2026-01-01", lastUpdated: "2026-01-01" })],
    cfg,
  );
  check("intel outside the 90d funding window doesn't corroborate", m === null);
}
{
  const m = matchIntelCorroboration(
    { newsType: "funding_round", company: "Acme", newsFirstSeen: "2026-07-20" },
    [intelEvent({ status: "invalidated" })],
    cfg,
  );
  check("invalidated intel events never corroborate", m === null);
}
{
  const m = matchIntelCorroboration(
    { newsType: "product_launch", company: "Acme", newsFirstSeen: "2026-07-20" },
    [intelEvent({ state: "Product launch preparation", firstDetected: "2026-07-01", lastUpdated: "2026-07-01" })],
    cfg,
  );
  check("launch prep corroborates a product launch", m !== null);
}
check(
  "inverse map: Fundraising evidence is confirmed by funding_round news",
  newsTypesForIntelState("Fundraising evidence", cfg).includes("funding_round"),
);

console.log("— ACCEPTANCE: funding story + stored Form D ranks above the identical story without one —");
{
  const score = (corroborated: boolean) => {
    const mat = scoreMateriality(
      {
        eventType: "funding_round",
        magnitude: { value: 20_000_000, unit: "usd", verbatim: "$20M" },
        isPortco: false,
        isWatch: true,
        atsOpenRoles: 10,
        corroborationMultiplier: corroborated ? cfg.fusion.materialityMultiplier : 1,
      },
      cfg,
    );
    const sur = applySurprise(mat.materiality, null, cfg);
    const rel = eventRelevance({ recRelevances: [6], isPortco: false, isWatch: true, networkContactCount: 1 }, cfg);
    const act = eventActionability({ hasContactEmail: true, hasPrime: false, daysSinceLastContact: 60 }, cfg);
    return rankScore(
      { materialityAdj: sur.materialityAdj, relevance: rel.relevance, actionability: act.actionability },
      cfg,
    ).rank;
  };
  const withFormD = score(true);
  const without = score(false);
  check("corroborated story ranks strictly higher", withFormD > without, `${withFormD} vs ${without}`);
}

console.log("— DETECTED BEFORE PRESS —");
{
  const ie = intelEvent({ firstDetected: "2026-07-10" });
  check("old, confident, uncovered intel event qualifies", isDetectedBeforePress(ie, false, "2026-07-27", cfg));
  check("news coverage disqualifies", !isDetectedBeforePress(ie, true, "2026-07-27", cfg));
  check(
    "too fresh doesn't qualify (press may simply not have arrived yet)",
    !isDetectedBeforePress(intelEvent({ firstDetected: "2026-07-26" }), false, "2026-07-27", cfg),
  );
  check(
    "low confidence doesn't qualify",
    !isDetectedBeforePress(intelEvent({ confidence: 0.4 }), false, "2026-07-27", cfg),
  );
  check(
    "resolved events don't qualify",
    !isDetectedBeforePress(intelEvent({ status: "resolved" }), false, "2026-07-27", cfg),
  );
}
check("intel state maps to a taxonomy type", taxonomyTypeForIntelState("Fundraising evidence", cfg) === "funding_round");
check("unknown state maps to other", taxonomyTypeForIntelState("Quantum vibes", cfg) === "other");

console.log("— badges —");
check("mergeBadges unions", mergeBadges("A;B", "B", "C") === "A;B;C");
check("mergeBadges from empty", mergeBadges("", BADGE.detectedBeforePress) === BADGE.detectedBeforePress);
check("mergeBadges idempotent", mergeBadges(mergeBadges("", "X"), "X") === "X");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
