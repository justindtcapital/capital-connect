// Deterministic fixtures for grounded attribution relevance.
// Run: npx tsx scripts/attribution-score.test.ts

import {
  scoreAttribution,
  companiesMatch,
  isSelfCompanyAttribution,
  type AttributionContact,
} from "../src/lib/attribution-score";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const TODAY = "2026-07-22T12:00:00Z";

const hotCiso: AttributionContact = {
  name: "Jane Doe",
  email: "jane@acme.com",
  company: "Acme Security",
  title: "Chief Information Security Officer",
  sector: "Security",
  temperature: "Hot",
  prime: "Justin",
  lastContact: "2026-04-01",
  activityScore: 80,
  areasOfInterest: "AI security, zero trust",
};

const coldIc: AttributionContact = {
  name: "Bob Smith",
  email: "bob@bigco.com",
  company: "BigCo",
  title: "Software Engineer",
  sector: "Retail",
  temperature: "Cold",
  lastContact: "2026-07-20",
};

console.log("— company matching —");
check("exact-ish match", companiesMatch("Acme Security Inc.", "Acme Security"));
check("substring match", companiesMatch("Acme", "Acme Security"));
check("different companies", !companiesMatch("Acme Security", "Globex"));

console.log("— high-relevance case —");
{
  const r = scoreAttribution(
    {
      person: "Jane Doe",
      email: "jane@acme.com",
      company: "Acme Security",
      category: "Funding/M&A",
      signal: "Acme Security raised a Series B to expand its AI security platform",
      llmRelevance: 8,
    },
    { contact: hotCiso, isPortcoCompany: false, isWatchlistCompany: true, portfolioSectors: ["security"], todayIso: TODAY },
  );
  check("hot CISO + funding + interest match scores high", r.relevance >= 7.5, String(r.relevance));
  check("verified", r.verified);
  check("no company mismatch", !r.companyMismatch);
  check("summary names interest hit", r.summary.includes("ai security"), r.summary);
  check("summary shows components", r.summary.includes("relationship") && r.summary.includes("actionability"));
}

console.log("— low-relevance case —");
{
  const r = scoreAttribution(
    {
      person: "Bob Smith",
      email: "bob@bigco.com",
      company: "BigCo",
      category: "Industry Trend",
      signal: "Manufacturing supply chains adopt new logistics software",
      llmRelevance: 8, // LLM overestimates; grounded evidence should pull it down
    },
    { contact: coldIc, isPortcoCompany: false, isWatchlistCompany: false, portfolioSectors: ["security", "ai"], todayIso: TODAY },
  );
  check("cold IC + irrelevant trend scores low despite LLM 8", r.relevance <= 4, String(r.relevance));
  const sectorHit = scoreAttribution(
    {
      person: "Bob Smith",
      email: "bob@bigco.com",
      company: "BigCo",
      category: "Industry Trend",
      signal: "Retail sector sees broad adoption of self-checkout",
      llmRelevance: 8,
    },
    { contact: coldIc, isPortcoCompany: false, isWatchlistCompany: false, portfolioSectors: ["security", "ai"], todayIso: TODAY },
  );
  check("sector-matching trend ranks above irrelevant trend", sectorHit.relevance > r.relevance, `${sectorHit.relevance} vs ${r.relevance}`);
}

console.log("— validation caps —");
{
  const unverified = scoreAttribution(
    { person: "Ghost Person", email: "ghost@nowhere.com", company: "Acme Security", category: "Funding/M&A", signal: "raised", llmRelevance: 10 },
    { contact: undefined, isPortcoCompany: true, isWatchlistCompany: false, portfolioSectors: [], todayIso: TODAY },
  );
  check("unverified capped at 3.5", unverified.relevance <= 3.5, String(unverified.relevance));
  check("unverified flagged", !unverified.verified && unverified.summary.includes("UNVERIFIED"));

  const moved = scoreAttribution(
    { person: "Jane Doe", email: "jane@acme.com", company: "Globex", category: "Executive Movement", signal: "joins Globex as CISO", llmRelevance: 9 },
    { contact: hotCiso, isPortcoCompany: false, isWatchlistCompany: false, portfolioSectors: [], todayIso: TODAY },
  );
  check("company mismatch capped at 5", moved.relevance <= 5, String(moved.relevance));
  check("mismatch explained", moved.companyMismatch && moved.summary.includes("possible job change"));

  const portcoExternal = scoreAttribution(
    {
      person: "Jane Doe",
      email: "jane@acme.com",
      company: "Redis",
      category: "Product/Milestone",
      signal: "Redis launched a real-time context layer for AI agents",
      llmRelevance: 9,
    },
    {
      contact: { ...hotCiso, company: "Acme Security" },
      isPortcoCompany: true,
      isWatchlistCompany: false,
      portfolioSectors: ["ai"],
      todayIso: TODAY,
    },
  );
  check(
    "portco story + external contact not mismatch-capped",
    portcoExternal.relevance > 5 && !portcoExternal.selfCompanyAttribution,
    String(portcoExternal.relevance),
  );

  const portcoEmployee = scoreAttribution(
    {
      person: "Rowan",
      email: "rowan@redis.com",
      company: "Redis",
      category: "Product/Milestone",
      signal: "Redis launched a real-time context layer for AI agents",
      llmRelevance: 9,
    },
    {
      contact: { ...hotCiso, name: "Rowan", email: "rowan@redis.com", company: "Redis" },
      isPortcoCompany: true,
      isWatchlistCompany: false,
      portfolioSectors: ["ai"],
      todayIso: TODAY,
    },
  );
  check(
    "portco story + employee rejected",
    portcoEmployee.relevance === 0 && portcoEmployee.selfCompanyAttribution,
    String(portcoEmployee.relevance),
  );
  check(
    "isSelfCompanyAttribution helper",
    isSelfCompanyAttribution({ company: "Redis Inc" }, "Redis") &&
      !isSelfCompanyAttribution({ company: "Twine Security" }, "Keycard"),
  );

  const competitorToPortco = scoreAttribution(
    {
      person: "Omri Green",
      email: "omri@twinesecurity.com",
      company: "Keycard",
      category: "Product/Milestone",
      signal: "Keycard launched an agentic IAM control plane",
      llmRelevance: 9,
    },
    {
      contact: {
        name: "Omri Green",
        email: "omri@twinesecurity.com",
        company: "Twine Security",
        title: "CEO",
        temperature: "Hot",
        activityScore: 60,
        areasOfInterest: "security",
      },
      isPortcoCompany: false,
      isWatchlistCompany: false,
      isContactAtPortco: true,
      portfolioSectors: ["security"],
      todayIso: TODAY,
    },
  );
  check(
    "competitor news to portco contact not mismatch-capped",
    competitorToPortco.relevance > 5,
    String(competitorToPortco.relevance),
  );
}

console.log("— evidence ordering —");
{
  const base = {
    person: "Jane Doe",
    email: "jane@acme.com",
    company: "Acme Security",
    category: "Funding/M&A",
    signal: "Acme Security raised a Series B for AI security",
    llmRelevance: 5,
  };
  const ctx = { isPortcoCompany: false, isWatchlistCompany: false, portfolioSectors: [] as string[], todayIso: TODAY };
  const hot = scoreAttribution(base, { ...ctx, contact: hotCiso });
  const cold = scoreAttribution(base, { ...ctx, contact: { ...hotCiso, temperature: "Cold", activityScore: 5, areasOfInterest: "" } });
  check("warmer relationship outranks colder, all else equal", hot.relevance > cold.relevance, `${hot.relevance} vs ${cold.relevance}`);

  const recent = scoreAttribution(base, { ...ctx, contact: { ...hotCiso, lastContact: "2026-07-20" } });
  check("stale contact gets re-engagement bump over recently-touched", hot.relevance > recent.relevance, `${hot.relevance} vs ${recent.relevance}`);
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
