// NEWS@ subject publisher extraction.
// Run: npx tsx scripts/news-subject.test.ts

import {
  researchPublisherFromSubject,
  stripReplyForwardPrefixes,
} from "../src/lib/news-subject";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("— stripReplyForwardPrefixes —");
check(
  "strips FW/RE chain",
  stripReplyForwardPrefixes("FW: RE: 451 Research: Siemens") === "451 Research: Siemens",
);

console.log("— researchPublisherFromSubject —");
{
  const p = researchPublisherFromSubject(
    "FW: 451 Research: Siemens AG, EnergyHub, Reco, Trianz, Generative AI",
  );
  check("451 from FW subject", p?.name === "451 Research", JSON.stringify(p));
  check("451 domain", p?.domain === "451research.com", JSON.stringify(p));
}
{
  const p = researchPublisherFromSubject("RE: Gartner: Magic Quadrant update");
  check("Gartner", p?.name === "Gartner" && p?.domain === "gartner.com", JSON.stringify(p));
}
{
  const p = researchPublisherFromSubject("Portco blogs for the week");
  check("no publisher → null", p === null, JSON.stringify(p));
}
{
  const p = researchPublisherFromSubject("Darling, Scott: FYI");
  check("person name not publisher", p === null, JSON.stringify(p));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll news-subject checks passed.");
