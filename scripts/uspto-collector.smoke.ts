// Smoke: USPTO collector without a key must no_source; name normalize is strict.
// Run: npx tsx scripts/uspto-collector.smoke.ts

import {
  collectUsptoTrademarks,
  normalizeTrademarkOwner,
} from "../src/utils/intel-collectors.server";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

check(
  "normalize strips Inc/LLC",
  normalizeTrademarkOwner("Acme Robotics, Inc.") === normalizeTrademarkOwner("Acme Robotics"),
);
check(
  "normalize distinguishes different owners",
  normalizeTrademarkOwner("Acme Robotics") !== normalizeTrademarkOwner("Acme Robotics Holdings Fund"),
);

const prev = process.env["USPTO_API_KEY"];
delete process.env["USPTO_API_KEY"];
const res = await collectUsptoTrademarks("Stripe, Inc.");
check("no key → not ok", res.ok === false);
check("no key → no_source", res.status === "no_source", res.status);
check("no key → mentions USPTO_API_KEY", Boolean(res.error?.includes("USPTO_API_KEY")), res.error);
check("no key → zero metrics", res.metrics.length === 0);
if (prev !== undefined) process.env["USPTO_API_KEY"] = prev;

console.log(failures === 0 ? "\nALL SMOKES PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
