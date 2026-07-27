// Deterministic fixtures for WS4 surprise & burst detection.
// Run: npx tsx scripts/surprise.test.ts   (exit 0 = all pass)

import {
  eventSurprise,
  detectBurst,
  applySurprise,
  scoreMateriality,
} from "../src/lib/materiality";
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

// Weekly launch cadence: 12 launches, 7 days apart, ending 2026-07-20.
const weekly: string[] = [];
{
  const d = new Date("2026-07-20T00:00:00Z");
  for (let i = 0; i < 12; i++) {
    weekly.unshift(d.toISOString().split("T")[0]);
    d.setUTCDate(d.getUTCDate() - 7);
  }
}

console.log("— surprise vs. the company's own cadence —");
const routine = eventSurprise(
  { sameTypePriorDates: weekly, anyTypePriorDates: weekly, currentDate: "2026-07-27" },
  cfg,
);
const quiet = eventSurprise(
  { sameTypePriorDates: ["2025-11-01"], anyTypePriorDates: ["2025-11-01"], currentDate: "2026-07-27" },
  cfg,
);
check(
  "weekly shipper's on-schedule launch is unsurprising (≈0.5)",
  routine.surpriseNorm <= 0.55,
  `${routine.surpriseNorm} (${routine.why})`,
);
check(
  "six-months-quiet company scores high surprise",
  quiet.surpriseNorm >= 0.85,
  `${quiet.surpriseNorm} (${quiet.why})`,
);
{
  // Same cadence history but a LONG overdue gap → more surprising than routine.
  const overdue = eventSurprise(
    { sameTypePriorDates: weekly, anyTypePriorDates: weekly, currentDate: "2026-10-01" },
    cfg,
  );
  check(
    "breaking a steady cadence after a long gap is surprising",
    overdue.surpriseNorm > routine.surpriseNorm,
    `${overdue.surpriseNorm} vs ${routine.surpriseNorm}`,
  );
}
{
  const coldStart = eventSurprise(
    {
      sameTypePriorDates: [],
      anyTypePriorDates: ["2026-07-10", "2026-07-15"],
      currentDate: "2026-07-27",
    },
    cfg,
  );
  check("first-of-type amid activity uses cold-start default", coldStart.surpriseNorm === cfg.surprise.coldStartDefault);
}

console.log("— ACCEPTANCE: routine release scores lower materiality_adj than a quiet company's —");
{
  const mat = scoreMateriality(
    { eventType: "product_launch", magnitude: null, isPortco: true, isWatch: false, atsOpenRoles: 40 },
    cfg,
  ).materiality;
  const routineAdj = applySurprise(mat, routine.surpriseNorm, cfg).materialityAdj;
  const quietAdj = applySurprise(mat, quiet.surpriseNorm, cfg).materialityAdj;
  check(
    "same event type, same company profile: weekly shipper < 6-months-quiet",
    routineAdj < quietAdj,
    `${routineAdj} vs ${quietAdj}`,
  );
}

console.log("— burst detector —");
{
  const burstDates = ["2026-07-22", "2026-07-24", "2026-07-26"];
  const r = detectBurst(burstDates, "2026-07-27", cfg);
  check("3 events in 7d after quiet ⇒ burst", r.burst, r.why);
}
{
  const busy = [...weekly, "2026-07-22", "2026-07-24", "2026-07-26"];
  const r = detectBurst(busy, "2026-07-27", cfg);
  check("steadily active company never bursts", !r.burst, r.why);
}
{
  const r = detectBurst(["2026-07-22", "2026-07-26"], "2026-07-27", cfg);
  check("2 events isn't a burst", !r.burst);
}
{
  const r = detectBurst([], "2026-07-27", cfg);
  check("no events isn't a burst", !r.burst);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
