// Deterministic fixtures for WS2 materiality scoring & ranking.
// Run: npx tsx scripts/materiality.test.ts   (exit 0 = all pass)

import {
  validateMagnitude,
  parseMoneyQuote,
  parseCountQuote,
  scoreMateriality,
  applySurprise,
  eventRelevance,
  eventActionability,
  rankScore,
} from "../src/lib/materiality";
import { DEFAULT_SIGNAL_CONFIG, validateEventType } from "../src/lib/signal-config";

const cfg = DEFAULT_SIGNAL_CONFIG;

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("— closed-set type validation —");
check("valid type accepted", validateEventType("funding_round").valid);
check("unknown type → other, flagged", !validateEventType("meme_stock").valid && validateEventType("meme_stock").type === "other");
check("empty type → other, flagged", validateEventType(undefined).type === "other" && !validateEventType(undefined).valid);
check("'other' is valid, unflagged", validateEventType("other").valid);

console.log("— magnitude: verbatim-or-discard —");
{
  const grounded = "Acme announced today it has raised $20M in Series B funding led by Foo Ventures.";
  const ok = validateMagnitude({ value: 20_000_000, unit: "usd", quote: "$20M" }, grounded);
  check("verbatim quote persists", ok?.value === 20_000_000 && ok.verbatim === "$20M");
  const notInText = validateMagnitude({ value: 50_000_000, unit: "usd", quote: "$50M" }, grounded);
  check("quote absent from grounded text → discarded", notInText === null);
  const wrongValue = validateMagnitude({ value: 25_000_000, unit: "usd", quote: "$20M" }, grounded);
  check("quote contradicts proposed value → discarded", wrongValue === null);
  const invented = validateMagnitude({ value: 20_000_000, unit: "usd", quote: "" }, grounded);
  check("empty quote → discarded", invented === null);
}
{
  const grounded = "The company will lay off 1,200 employees, about 15% of staff.";
  const ok = validateMagnitude({ value: 1200, unit: "people", quote: "1,200 employees" }, grounded);
  check("people-count quote persists", ok?.value === 1200);
}
check("parseMoneyQuote $1.5 billion", parseMoneyQuote("$1.5 billion") === 1_500_000_000);
check("parseCountQuote 1,200", parseCountQuote("1,200 employees") === 1200);

console.log("— materiality: taxonomy priors —");
{
  const funding = scoreMateriality(
    { eventType: "funding_round", magnitude: null, isPortco: false, isWatch: true, atsOpenRoles: null },
    cfg,
  );
  const launch = scoreMateriality(
    { eventType: "product_launch", magnitude: null, isPortco: false, isWatch: true, atsOpenRoles: null },
    cfg,
  );
  const other = scoreMateriality(
    { eventType: "other", magnitude: null, isPortco: false, isWatch: false, atsOpenRoles: null },
    cfg,
  );
  check("funding > launch > other priors", funding.materiality > launch.materiality && launch.materiality > other.materiality);
  check("parts always recorded", funding.parts.length > 0);
}

console.log("— materiality: magnitude normalized to company size —");
{
  const mag = { value: 20_000_000, unit: "usd", verbatim: "$20M" };
  const seedCo = scoreMateriality(
    { eventType: "funding_round", magnitude: mag, isPortco: false, isWatch: true, atsOpenRoles: 8 },
    cfg,
  );
  const growthCo = scoreMateriality(
    { eventType: "funding_round", magnitude: mag, isPortco: true, isWatch: false, atsOpenRoles: 120 },
    cfg,
  );
  check(
    "a $20M raise scores HIGHER for a small company than a large one",
    seedCo.materiality > growthCo.materiality,
    `small ${seedCo.materiality} vs large ${growthCo.materiality}`,
  );
}
{
  const bigLayoff = scoreMateriality(
    {
      eventType: "layoffs_restructuring",
      magnitude: { value: 300, unit: "people", verbatim: "300 employees" },
      isPortco: false, isWatch: false, atsOpenRoles: 50, // proxy headcount 500 → 60%
    },
    cfg,
  );
  const smallLayoff = scoreMateriality(
    {
      eventType: "layoffs_restructuring",
      magnitude: { value: 10, unit: "people", verbatim: "10 employees" },
      isPortco: false, isWatch: false, atsOpenRoles: 50, // 500 → 2%
    },
    cfg,
  );
  check(
    "layoff % of proxy headcount separates severity",
    bigLayoff.materiality > smallLayoff.materiality,
    `${bigLayoff.materiality} vs ${smallLayoff.materiality}`,
  );
}

console.log("— surprise modulation (WS4 hook) —");
{
  const { materialityAdj: routine } = applySurprise(6, 0, cfg); // weekly shipper
  const { materialityAdj: quiet } = applySurprise(6, 1, cfg); // first launch in 6mo
  const { materialityAdj: none } = applySurprise(6, null, cfg); // no baseline
  check("routine cadence is discounted", routine < quiet, `${routine} vs ${quiet}`);
  check("no baseline leaves materiality unchanged", none === 6);
}

console.log("— relevance & actionability —");
{
  const attributed = eventRelevance(
    { recRelevances: [7.5, 4], isPortco: false, isWatch: false, networkContactCount: 0 },
    cfg,
  );
  check("best attributed score wins", attributed.relevance === 7.5);
  const portco = eventRelevance({ recRelevances: [], isPortco: true, isWatch: false, networkContactCount: 0 }, cfg);
  const cold = eventRelevance({ recRelevances: [], isPortco: false, isWatch: false, networkContactCount: 0 }, cfg);
  check("proxy: portco > cold", portco.relevance > cold.relevance);
}
{
  const hot = eventActionability({ hasContactEmail: true, hasPrime: true, daysSinceLastContact: 90 }, cfg);
  const cold = eventActionability({ hasContactEmail: false, hasPrime: false, daysSinceLastContact: 5 }, cfg);
  check("email+prime+re-engagement window beats none", hot.actionability > cold.actionability);
  check("actionability capped at 1", hot.actionability <= 1);
}

console.log("— final rank & suppression floor —");
{
  const material = rankScore({ materialityAdj: 8, relevance: 6, actionability: 0.7 }, cfg);
  const routine = rankScore({ materialityAdj: 2, relevance: 9.5, actionability: 1 }, cfg);
  check(
    "SUPPRESSION: a routine event from a beloved contact cannot outrank a material one",
    routine.rank <= cfg.ranking.floorRankCap && routine.suppressed && material.rank > routine.rank,
    `material ${material.rank} vs routine ${routine.rank}`,
  );
  check("suppression is recorded in the breakdown", routine.parts.some((p) => p.name === "suppression"));
}
{
  const a = rankScore({ materialityAdj: 7, relevance: 7, actionability: 0.6 }, cfg);
  const b = rankScore({ materialityAdj: 7, relevance: 7, actionability: 0.6 }, cfg);
  check("rank is deterministic", a.rank === b.rank);
  const low = rankScore({ materialityAdj: 0, relevance: 10, actionability: 1 }, cfg);
  check("zero materiality → zero-ish rank", low.rank <= cfg.ranking.floorRankCap);
}
{
  // Monotonicity: each factor raises rank, all else equal.
  const base = rankScore({ materialityAdj: 5, relevance: 5, actionability: 0.5 }, cfg).rank;
  check("higher materiality ⇒ higher rank", rankScore({ materialityAdj: 8, relevance: 5, actionability: 0.5 }, cfg).rank > base);
  check("higher relevance ⇒ higher rank", rankScore({ materialityAdj: 5, relevance: 9, actionability: 0.5 }, cfg).rank > base);
  check("higher actionability ⇒ higher rank", rankScore({ materialityAdj: 5, relevance: 5, actionability: 0.9 }, cfg).rank > base);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
