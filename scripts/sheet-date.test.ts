// Calendar date parse/write for Notes / BD / GTM.
// Run: npx tsx scripts/sheet-date.test.ts

import {
  compareIsoDatesDesc,
  formatIsoMdY,
  isoToSheetDate,
  msToIsoDay,
  parseToIsoDate,
  sheetsSerialToIso,
} from "../src/lib/sheet-date";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("— parseToIsoDate —");
check("ISO", parseToIsoDate("2026-08-13") === "2026-08-13");
check("ISO datetime stripped", parseToIsoDate("2026-08-13T00:00:00.000Z") === "2026-08-13");
check("M/D/YYYY", parseToIsoDate("8/13/2026") === "2026-08-13");
check("MM/DD/YYYY", parseToIsoDate("08/13/2026") === "2026-08-13");
check("D/M/YYYY when day>12", parseToIsoDate("13/8/2026") === "2026-08-13");
check("M/D/YYYY with time", parseToIsoDate("8/12/2026 20:00:00") === "2026-08-12");
check("apostrophe-prefixed ISO", parseToIsoDate("'2026-08-13") === "2026-08-13");
check("named month", parseToIsoDate("August 13, 2026") === "2026-08-13");
check("short named month", parseToIsoDate("Jan 21, 2022") === "2022-01-21");
check("empty", parseToIsoDate("") === "");
check("undefined", parseToIsoDate(undefined) === "");

console.log("— sheets serial —");
check("45917 ≈ 2025-09-17 range", sheetsSerialToIso(45917).startsWith("2025-"));
check("serial string", parseToIsoDate("45917") === sheetsSerialToIso(45917));
check("small number not a serial", parseToIsoDate("13") === "");

console.log("— isoToSheetDate (no UTC ISO write) —");
check("ISO → M/D/YYYY", isoToSheetDate("2026-08-13") === "8/13/2026");
check("already M/D/YYYY round-trips", isoToSheetDate("8/13/2026") === "8/13/2026");
check("display alias", formatIsoMdY("2026-08-13") === "8/13/2026");

console.log("— timezone calendar day —");
// 2026-08-13 03:00 UTC = Aug 12 evening in America/New_York.
check(
  "late ET evening is previous calendar day",
  msToIsoDay(Date.UTC(2026, 7, 13, 3, 0, 0), "America/New_York") === "2026-08-12",
);
check(
  "afternoon ET stays the same day",
  msToIsoDay(Date.UTC(2026, 7, 13, 18, 0, 0), "America/New_York") === "2026-08-13",
);

console.log("— sort —");
check(
  "ISO vs M/D/YYYY newest first",
  compareIsoDatesDesc("8/13/2026", "2026-08-12") < 0,
);
check("undated last", compareIsoDatesDesc("", "2026-08-13") > 0);

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
