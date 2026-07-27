// Deterministic fixtures for the intel detection/fusion layer.
// Run: npx tsx scripts/intel-detect.test.ts   (exit 0 = all pass)
// No test framework needed — pure functions, plain assertions.

import {
  evaluateChange,
  fuseChanges,
  computeStats,
  median,
  robustSigma,
  peerPercentile,
  type Anomaly,
  type ChangeInput,
} from "../src/utils/intel-detect.server";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function hist(values: number[], startDay = 1): Array<[string, number]> {
  return values.map((v, i) => [
    `2026-0${1 + Math.floor((startDay + i * 7) / 31)}-${String(((startDay + i * 7) % 31) + 1).padStart(2, "0")}`,
    v,
  ]);
}

function change(partial: Partial<ChangeInput> & Pick<ChangeInput, "metric" | "prev" | "next" | "history">): ChangeInput {
  return { daysSinceLastFire: Number.POSITIVE_INFINITY, ...partial };
}

console.log("— statistics —");
check("median odd", median([3, 1, 2]) === 2);
check("median even", median([1, 2, 3, 10]) === 2.5);
check("robust sigma resists one outlier", robustSigma([10, 10, 10, 10, 500], 10) < 50, `got ${robustSigma([10, 10, 10, 10, 500], 10)}`);
{
  const flat = computeStats(hist([5, 5, 5, 5, 5]), 5);
  check("flat series → z 0", flat.z === 0, `z=${flat.z}`);
}

console.log("— small-denominator guard —");
{
  // 1 → 2 is +100% but |Δ| < minAbsDelta(3) → must NOT fire.
  const v = evaluateChange(change({ metric: "ats_open_roles", prev: 1, next: 2, history: hist([1, 1, 1, 1, 2]) }));
  check("1→2 open roles does not fire", v.action === "record", v.action);
}

console.log("— large-base override —");
{
  // 80 → 105 is +31% — fires via bigAbsOverride(20) even though z path may be borderline.
  const v = evaluateChange(change({ metric: "ats_open_roles", prev: 80, next: 105, history: hist([78, 80, 79, 81, 80, 105]) }));
  check("80→105 open roles fires", v.action === "record_anomaly", v.action);
  if (v.action === "record_anomaly") check("direction up", v.anomaly.direction === "up");
}

console.log("— genuine anomaly —");
{
  const v = evaluateChange(change({ metric: "ats_open_roles", prev: 9, next: 14, history: hist([9, 9, 10, 9, 14]) }));
  check("9→14 with flat history fires", v.action === "record_anomaly", v.action);
}

console.log("— insufficient history —");
{
  const v = evaluateChange(change({ metric: "ats_open_roles", prev: 9, next: 20, history: hist([9, 20]) }));
  check("2 points never fires", v.action === "record", v.action);
}

console.log("— cooldown —");
{
  const v = evaluateChange(change({ metric: "ats_open_roles", prev: 9, next: 14, history: hist([9, 9, 10, 9, 14]), daysSinceLastFire: 5 }));
  check("within 21d cooldown does not fire", v.action === "record", v.action);
}

console.log("— drop-to-zero confirmation —");
{
  const h = hist([12, 12, 13, 12, 0]);
  const first = evaluateChange(change({ metric: "ats_open_roles", prev: 12, next: 0, history: h }));
  check("first 0 sighting held", first.action === "hold_unconfirmed", first.action);
  const blip = evaluateChange(change({ metric: "ats_open_roles", prev: 12, next: 12, history: h, pendingZeroSince: "2026-07-21" }));
  check("recovery discards blip", blip.action === "discard_blip", blip.action);
  const confirmed = evaluateChange(change({ metric: "ats_open_roles", prev: 12, next: 0, history: h, pendingZeroSince: "2026-07-21" }));
  check("second consecutive 0 believed", confirmed.action === "record_anomaly" || confirmed.action === "record", confirmed.action);
}

console.log("— filings —");
{
  const v = evaluateChange(change({ metric: "sec_formd_filings", prev: 1, next: 2, history: hist([1, 2]) }));
  check("new Form D fires without z", v.action === "record_anomaly", v.action);
  const cool = evaluateChange(change({ metric: "sec_formd_filings", prev: 1, next: 2, history: hist([1, 2]), daysSinceLastFire: 10 }));
  check("filing cooldown respected", cool.action === "record", cool.action);
}

console.log("— peer benchmarking —");
{
  const cohort = [0.0, 0.05, -0.1, 0.1, 0.02, -0.05, 0.15, 0.08, 0.01];
  const up = peerPercentile(cohort, 0.5, "up");
  check("strong up-move beats whole cohort", up !== null && up.percentile === 100 && up.n === 9, JSON.stringify(up));
  const mid = peerPercentile(cohort, 0.06, "up");
  check("middling move → middling percentile", mid !== null && mid.percentile > 30 && mid.percentile < 90, JSON.stringify(mid));
  const down = peerPercentile(cohort, -0.4, "down");
  check("down direction counts peers above", down !== null && down.percentile === 100, JSON.stringify(down));
  const small = peerPercentile([0.1, 0.2, 0.3], 0.5, "up");
  check("cohort < 8 → null (no fake precision)", small === null);
}

console.log("— page-class flags —");
{
  const appear = evaluateChange(change({ metric: "site_has_security", prev: 0, next: 1, history: hist([0, 1]) }));
  check("security page appearing fires", appear.action === "record_anomaly", appear.action);
  const vanish = evaluateChange(change({ metric: "site_has_security", prev: 1, next: 0, history: hist([1, 0]) }));
  check("page disappearing only records", vanish.action === "record", vanish.action);
  const cool = evaluateChange(change({ metric: "site_has_security", prev: 0, next: 1, history: hist([0, 1]), daysSinceLastFire: 30 }));
  check("flag cooldown respected", cool.action === "record", cool.action);
}

console.log("— USPTO trademark filings —");
{
  const first = evaluateChange(
    change({ metric: "uspto_trademark_filings", prev: 2, next: 3, history: hist([2, 3]) }),
  );
  check("new trademark filing fires", first.action === "record_anomaly", first.action);
  const flat = evaluateChange(
    change({ metric: "uspto_trademark_filings", prev: 3, next: 3, history: hist([3, 3]) }),
  );
  check("unchanged trademark count only records", flat.action === "record", flat.action);
}

console.log("— fusion: same family never corroborates —");
{
  const a = (metric: string, family: Anomaly["family"], dir: "up" | "down" = "up"): Anomaly => ({
    metric, family, label: metric, direction: dir, prev: 9, next: 14, baseline: 9, z: 2.5, relDelta: 0.5, absDelta: 5, slopeWk: 1, reason: "test",
  });
  const sameFamily = fuseChanges([a("ats_open_roles", "hiring"), a("ats_eng_roles", "hiring"), a("ats_gtm_roles", "hiring")]);
  check("3 hiring metrics → 1 event", sameFamily.length === 1, String(sameFamily.length));
  check("…with 1 independent family", sameFamily[0]?.independentFamilies === 1, String(sameFamily[0]?.independentFamilies));

  const crossFamily = fuseChanges([a("ats_open_roles", "hiring"), a("ct_subdomains", "infrastructure")]);
  check("hiring↑+infra↑ → composite Expansion preparation", crossFamily.length === 1 && crossFamily[0].state === "Expansion preparation", crossFamily.map((c) => c.state).join(","));
  check("composite counts 2 families", crossFamily[0]?.independentFamilies === 2);
  check("composite confidence > single-family", (crossFamily[0]?.confidence ?? 0) > (sameFamily[0]?.confidence ?? 1), `${crossFamily[0]?.confidence} vs ${sameFamily[0]?.confidence}`);

  const slowdown = fuseChanges([a("ats_open_roles", "hiring", "down"), a("gh_active_repos_90d", "engineering", "down")]);
  check("hiring↓+eng↓ → Operational slowdown", slowdown.length === 1 && slowdown[0].state === "Operational slowdown", slowdown.map((c) => c.state).join(","));

  const funding = fuseChanges([a("sec_formd_filings", "funding")]);
  check("Form D → Fundraising evidence", funding.length === 1 && funding[0].state === "Fundraising evidence");

  const trademarks = fuseChanges([a("uspto_trademark_filings", "ip")]);
  check(
    "USPTO trademarks → Product launch preparation",
    trademarks.length === 1 && trademarks[0].state === "Product launch preparation",
    trademarks.map((c) => c.state).join(","),
  );

  const entGtm = fuseChanges([a("ats_gtm_roles", "hiring"), a("site_has_enterprise", "commercial")]);
  check(
    "hiring↑+commercial↑ → Enterprise go-to-market expansion",
    entGtm.length === 1 && entGtm[0].state === "Enterprise go-to-market expansion",
    entGtm.map((c) => c.state).join(","),
  );

  const commercialOnly = fuseChanges([a("site_has_pricing", "commercial")]);
  check(
    "commercial alone → Commercial maturation",
    commercialOnly.length === 1 && commercialOnly[0].state === "Commercial maturation",
    commercialOnly.map((c) => c.state).join(","),
  );

  // Enterprise GTM (hiring+commercial) outranks Expansion preparation (hiring+infra)
  // when all three families move: hiring is consumed by the higher-priority rule.
  const triple = fuseChanges([
    a("ats_gtm_roles", "hiring"),
    a("site_has_enterprise", "commercial"),
    a("ct_subdomains", "infrastructure"),
  ]);
  check(
    "triple-family: enterprise GTM wins, infra falls through alone",
    triple.some((c) => c.state === "Enterprise go-to-market expansion") &&
      triple.some((c) => c.state === "Infrastructure expansion"),
    triple.map((c) => c.state).join(","),
  );

  const none = fuseChanges([]);
  check("no anomalies → no events", none.length === 0);
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
