// Run: npx tsx scripts/portco-names.test.ts

import {
  matchSheetToAsanaKeys,
  normalizePortcoName,
  scorePortcoNameMatch,
} from "../src/lib/portco-names";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("— normalize —");
check("strips labs", normalizePortcoName("Quantum Source Labs") === "quantum source");
check("strips ai suffix", normalizePortcoName("Bland AI") === "bland");
check("strips .ai", normalizePortcoName("SiMa.ai") === "sima");

console.log("— score orphans from the portco page —");
const cases: Array<[string, string]> = [
  ["VAST Data", "VAST"],
  ["Bland AI", "Bland"],
  ["Series Entertainment", "Series"],
  ["Quantum Source Labs", "Quantum Source"],
  ["Terra", "Terra Security"],
  ["SiMa", "SiMa.ai"],
];
for (const [sheet, asana] of cases) {
  check(`${sheet} ↔ ${asana}`, scorePortcoNameMatch(sheet, asana) > 0);
}
check("unrelated no match", scorePortcoNameMatch("Redis", "Netskope") === 0);
check("tiny fragment ignored", scorePortcoNameMatch("Alation", "A") === 0);

console.log("— greedy 1:1 assignment —");
{
  const sheet = [
    "VAST Data",
    "Bland AI",
    "Series Entertainment",
    "Quantum Source Labs",
    "Terra",
    "SiMa",
    "Twine Security",
  ];
  const asana = [
    "vast",
    "bland",
    "series",
    "quantum source",
    "terra security",
    "sima.ai",
    "twine security",
  ];
  const map = matchSheetToAsanaKeys(sheet, asana, (k) => k);
  check("maps all six orphans", map.size === 7, String(map.size));
  check("VAST Data → vast", map.get("VAST Data") === "vast");
  check("Bland AI → bland", map.get("Bland AI") === "bland");
  check("SiMa → sima.ai", map.get("SiMa") === "sima.ai");
  check("Terra → terra security", map.get("Terra") === "terra security");
}

console.log("— Twine vs Twine Security prefers closer —");
{
  const map = matchSheetToAsanaKeys(
    ["Twine", "Twine Security"],
    ["twine security"],
    (k) => k,
  );
  check("only Twine Security claims the key", map.get("Twine Security") === "twine security");
  check("Twine left unmatched", !map.has("Twine"));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
