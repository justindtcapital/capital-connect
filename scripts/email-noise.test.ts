// BD/GTM sync noise filters + contact matching.
// Run: npx tsx scripts/email-noise.test.ts

import {
  isBulkOrAutomatedMail,
  isNoiseEmail,
  pickPrimaryCounterparty,
} from "../src/lib/email-noise";
import { matchActivitiesToContact } from "../src/lib/activity-match";
import type { AsanaActivity, Contact } from "../src/lib/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("— isNoiseEmail —");
check("real person passes", !isNoiseEmail("jane.doe@acme.com"));
check("noreply drops", isNoiseEmail("noreply@acme.com"));
check("no-reply drops", isNoiseEmail("no-reply@acme.com"));
check("newsletter local drops", isNoiseEmail("newsletter@acme.com"));
check("info@ drops", isNoiseEmail("info@acme.com"));
check("booking@ drops", isNoiseEmail("booking@mavenagi.com"));
check("bd-tracking@ drops", isNoiseEmail("bd-tracking@dt-capital.net"));
check("gtm-tracking@ drops", isNoiseEmail("gtm-tracking@dt-capital.net"));
check("scheduler@ drops", isNoiseEmail("scheduler@acme.com"));
check("mailchimp domain drops", isNoiseEmail("hello@mailchimp.com"));
check("sendgrid drops", isNoiseEmail("bounce@sendgrid.net"));
check("empty drops", isNoiseEmail(""));

console.log("— isBulkOrAutomatedMail —");
check(
  "List-Unsubscribe is bulk",
  isBulkOrAutomatedMail({ listUnsubscribe: "<mailto:unsub@x.com>" }),
);
check(
  "Precedence bulk",
  isBulkOrAutomatedMail({ precedence: "bulk" }),
);
check(
  "Auto-Submitted auto",
  isBulkOrAutomatedMail({ autoSubmitted: "auto-generated" }),
);
check(
  "Feedback-ID alone is NOT bulk",
  !isBulkOrAutomatedMail({ feedbackId: "1.example:2" }),
);
check("clean mail not bulk", !isBulkOrAutomatedMail({}));

console.log("— pickPrimaryCounterparty —");
const people = [
  { name: "Alice", email: "alice@co.com", role: "from" as const },
  { name: "Bob", email: "bob@co.com", role: "to" as const },
  { name: "Carol", email: "carol@co.com", role: "cc" as const },
];
check(
  "inbound prefers From",
  pickPrimaryCounterparty(people, false)?.email === "alice@co.com",
);
check(
  "outbound prefers To",
  pickPrimaryCounterparty(people, true)?.email === "bob@co.com",
);
check(
  "noise From skipped for inbound",
  pickPrimaryCounterparty(
    [
      { name: "Sys", email: "noreply@co.com", role: "from" },
      { name: "Bob", email: "bob@co.com", role: "to" },
    ],
    false,
  )?.email === "bob@co.com",
);

console.log("— matchActivitiesToContact (gmail email-only) —");
const contact: Contact = {
  id: "1",
  name: "Jane Smith",
  email: "jane@acme.com",
  company: "Acme",
} as Contact;

const gmailHit: AsanaActivity = {
  gid: "gmail-abc",
  track: "BD",
  name: "Intro call",
  notes: "Inbound email\nPeople: Jane Smith <jane@acme.com>",
  person: "Jane Smith",
  company: "Acme",
};

const gmailNameOnly: AsanaActivity = {
  gid: "gmail-xyz",
  track: "BD",
  name: "Re: Jane Smith dinner invite",
  notes: "Inbound email\nPeople: Other Person <other@elsewhere.com>",
  person: "Other Person",
  company: "Elsewhere",
};

const asanaName: AsanaActivity = {
  gid: "12345",
  track: "GTM",
  name: "Met Jane Smith at summit",
  person: "Jane Smith",
  company: "Acme",
};

check(
  "gmail matches on email in notes",
  matchActivitiesToContact([gmailHit], contact).length === 1,
);
check(
  "gmail does NOT match on name in subject alone",
  matchActivitiesToContact([gmailNameOnly], contact).length === 0,
);
check(
  "asana still matches on name",
  matchActivitiesToContact([asanaName], contact).length === 1,
);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll email-noise / match tests passed.");
