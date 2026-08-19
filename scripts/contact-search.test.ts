// Run: npx tsx scripts/contact-search.test.ts

import {
  matchesContactSearch,
  scoreContactSearch,
  searchTokens,
} from "../src/lib/contact-search";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const chris = { name: "Chris Falloon", company: "Dell", email: "chris.falloon@dell.com" };
const christopher = { name: "Christopher Nolan", company: "Syncopy", email: "chris@syncopy.com" };
const lastFirst = { name: "Hillock, Chris", company: "Dell", email: "chris.hillock@dell.com" };
const middle = { name: "Chris A. Falloon", company: "Dell", email: "caf@dell.com" };
const michael = { name: "Michael Scott", company: "Dunder Mifflin", email: "mscott@dm.com" };
const jose = { name: "José García", company: "Acme", email: "jose@acme.com" };
const obrien = { name: "Casey O'Brien", company: "Acme", email: "casey@acme.com" };
const chrysler = { name: "Pat Lee", company: "Chrysler", email: "pat@chrysler.com" };

console.log("— searchTokens —");
check("comma flip", searchTokens("Hillock, Chris").join(" ") === "chris hillock");
check("hyphen", searchTokens("Jean-Luc").includes("jean") && searchTokens("Jean-Luc").includes("luc"));
check("apostrophe collapsed", searchTokens("O'Brien").includes("obrien"));

console.log("— first / last / order —");
check("first name Chris", matchesContactSearch(chris, "Chris"));
check("Last, First", matchesContactSearch(lastFirst, "Chris"));
check("full name out of order", matchesContactSearch(lastFirst, "Chris Hillock"));
check("middle initial ignored", matchesContactSearch(middle, "Chris Falloon"));
check("two-token AND excludes other Chris", !matchesContactSearch(lastFirst, "Chris Falloon"));

console.log("— nicknames / prefix —");
check("Chris finds Christopher", matchesContactSearch(christopher, "Chris"));
check("Christopher finds Chris", matchesContactSearch(chris, "Christopher"));
check("Mike finds Michael", matchesContactSearch(michael, "Mike"));
check("Michael finds Mike", matchesContactSearch(michael, "Michael"));

console.log("— accents / punctuation —");
check("Jose finds José", matchesContactSearch(jose, "Jose"));
check("Garcia finds García", matchesContactSearch(jose, "Garcia"));
check("OBrien finds O'Brien", matchesContactSearch(obrien, "OBrien"));

console.log("— company / email fallback —");
check("company token", matchesContactSearch(chrysler, "Chrysler"));
check("email local", matchesContactSearch(chris, "chris.falloon"));
check("short query does not flood on company", !matchesContactSearch(chrysler, "ch"));

console.log("— ranking —");
const nameScore = scoreContactSearch(chris, "Chris");
const companyScore = scoreContactSearch(chrysler, "Chris");
check(
  "person named Chris ranks above company Chrysler",
  nameScore > companyScore,
  `name=${nameScore} company=${companyScore}`,
);
check("exact full name beats first-name-only", scoreContactSearch(chris, "Chris Falloon") > nameScore);
check("no match is 0", scoreContactSearch(chris, "Zaphod") === 0);

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nAll contact-search checks passed.");
