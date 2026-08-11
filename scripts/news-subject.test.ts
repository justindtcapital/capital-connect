// NEWS@ subject publisher + entity extraction.
// Run: npx tsx scripts/news-subject.test.ts

import {
  parseResearchSubject,
  researchPublisherFromSubject,
  splitResearchEntities,
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

console.log("— parseResearchSubject entities —");
{
  const parsed = parseResearchSubject(
    "FW: 451 Research: Siemens AG, EnergyHub, Reco, Trianz, Generative AI",
  );
  check("publisher 451", parsed.publisher?.name === "451 Research", JSON.stringify(parsed));
  check(
    "5 entities",
    parsed.entities.length === 5 &&
      parsed.entities[0] === "Siemens AG" &&
      parsed.entities[1] === "EnergyHub" &&
      parsed.entities[4] === "Generative AI",
    JSON.stringify(parsed.entities),
  );
}
{
  const parsed = parseResearchSubject("RE: Gartner: Magic Quadrant update");
  check(
    "single theme entity",
    parsed.entities.length === 1 && parsed.entities[0] === "Magic Quadrant update",
    JSON.stringify(parsed.entities),
  );
}
check(
  "split keeps multi-word",
  splitResearchEntities("Siemens AG, EnergyHub").join("|") === "Siemens AG|EnergyHub",
);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll news-subject checks passed.");
