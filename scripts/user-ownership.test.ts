// Ownership matching for Mine filter + manual Add Contact.
// Run: npx tsx scripts/user-ownership.test.ts

import { isMyContact, ownerMatches, teamProfile } from "../src/lib/user-ownership";
import type { Contact } from "../src/lib/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const profile = teamProfile("justin.adorante@dell.com");
check("profile built", !!profile && profile.displayName === "Justin Adorante");

console.log("— ownerMatches —");
check("display name", !!profile && ownerMatches("Justin Adorante", profile));
check("email", !!profile && ownerMatches("justin.adorante@dell.com", profile));
check("other person no", !!profile && !ownerMatches("Chris Falloon", profile));

console.log("— isMyContact (prime) —");
const fresh: Contact = {
  id: "1",
  name: "Jane Doe",
  email: "jane@acme.com",
  company: "Acme",
  title: "CEO",
  phone: "",
  location: "",
  linkedinUrl: "",
  prime: "Justin Adorante",
  sector: "",
  temperature: "Warm",
  followUpFlag: false,
  followUpPending: false,
  dateAdded: "2026-08-11",
  interactions: [],
  eventsAttended: [],
  eventsInvited: [],
  portCoIntros: [],
  portCoEngagements: [],
  areasOfInterest: [],
} as Contact;

check(
  "fresh manual add with my prime is mine",
  !!profile && isMyContact(fresh, new Set(), profile),
);

const orphan = { ...fresh, prime: "" };
check(
  "no prime + no notes is NOT mine",
  !!profile && !isMyContact(orphan, new Set(), profile),
);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll user-ownership tests passed.");
