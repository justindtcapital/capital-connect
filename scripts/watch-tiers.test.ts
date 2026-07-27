// Deterministic fixtures for WS6 tiered watch universe.
// Run: npx tsx scripts/watch-tiers.test.ts   (exit 0 = all pass)

import { promotionCheck } from "../src/lib/fusion";
import { DEFAULT_SIGNAL_CONFIG } from "../src/lib/signal-config";

const cfg = DEFAULT_SIGNAL_CONFIG;
const TODAY = "2026-07-27";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("— promotion rule (Tier 3 → 2) —");
{
  const r = promotionCheck({ hiring: "2026-07-20", funding: "2026-07-11" }, TODAY, cfg);
  check("2 distinct families within 30d ⇒ promote", r.promote);
  check("evidence lists both families", r.evidence.length === 2);
}
{
  const r = promotionCheck({ hiring: "2026-07-20" }, TODAY, cfg);
  check("1 family is not enough", !r.promote);
}
{
  const r = promotionCheck({ hiring: "2026-07-20", engineering: "2026-05-01" }, TODAY, cfg);
  check("a stale family stamp outside the 30d window doesn't count", !r.promote);
}
{
  const r = promotionCheck({}, TODAY, cfg);
  check("reset stamps (manual demotion) ⇒ no instant re-promotion", !r.promote);
}
{
  // Same family firing twice is still ONE family — the map keys enforce it.
  const r = promotionCheck({ hiring: "2026-07-26" }, TODAY, cfg);
  check("repeated same-family fires never promote alone", !r.promote);
}
{
  const r = promotionCheck(
    { hiring: "2026-07-25", funding: "2026-07-24", commercial: "2026-07-23" },
    TODAY,
    cfg,
  );
  check("3 families promote too (≥ threshold)", r.promote && r.evidence.length === 3);
}

console.log("— tier cadence config sanity —");
check(
  "Tier 3 collector set is the cheap high-precision pair",
  cfg.watchTiers.tier3Collectors.join(",") === "ats,edgar",
);
check(
  "Tier 2 news day is a valid ISO weekday",
  cfg.watchTiers.tier2NewsScanIsoDay >= 1 && cfg.watchTiers.tier2NewsScanIsoDay <= 7,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
