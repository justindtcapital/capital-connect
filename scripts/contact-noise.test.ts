// Run: npx tsx scripts/contact-noise.test.ts

import {
  contactImportRejectReason,
  isBlockedContactEmail,
  isBlockedContactName,
  isGarbageContactName,
} from "../src/lib/contact-noise";
import { isNameOnlyAttendeeEmail } from "../src/lib/email-address";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}`);
  }
}

console.log("— isGarbageContactName —");
check("real person", !isGarbageContactName("Zachary Yaguda"));
check("Response bot", isGarbageContactName("Response"));
check("Dell.Com", isGarbageContactName("Dell.Com"));
check("Bd Tracking", isGarbageContactName("Bd Tracking"));
check("Gtm Tracking", isGarbageContactName("Gtm Tracking"));
check("Booking", isGarbageContactName("Booking"));
check("Portfolio Delltech", isGarbageContactName("Portfolio Delltech"));
check("URL-encoded portfolio", isGarbageContactName("Portfolio%bdelltech"));
check("hex mash", isGarbageContactName("Bafeacacdddcec"));
check("empty", isGarbageContactName(""));
check("blocked Julia Beech", isBlockedContactName("Julia Beech"));
check("blocked Beech Julia (reversed)", isBlockedContactName("Beech Julia"));
check("blocked Beech, Julia", isBlockedContactName("Beech, Julia"));
check("blocked Chris Hillock", isGarbageContactName("Chris Hillock"));
check("blocked Chris Falloon", isGarbageContactName("chris falloon"));
check("blocked email beech.julia@", isBlockedContactEmail("beech.julia@attendee.local"));
check("blocked email name:julia.beech@", isBlockedContactEmail("name:julia.beech@attendee.local"));
check("attendee.local always name-only", isNameOnlyAttendeeEmail("beech.julia@attendee.local"));
check("attendee.local name: prefix", isNameOnlyAttendeeEmail("name:chris.falloon@attendee.local"));

console.log("— contactImportRejectReason —");
check(
  "blocked name rejected",
  contactImportRejectReason({
    name: "Julia Beech",
    email: "julia@example.com",
  }) === "blocked name",
);
check(
  "reversed name rejected",
  contactImportRejectReason({
    name: "Beech Julia",
    email: "beech.julia@attendee.local",
  }) === "blocked name",
);
check(
  "ok contact",
  contactImportRejectReason({
    name: "Jane Doe",
    email: "jane@acme.com",
    company: "Acme",
  }) === null,
);
check(
  "garbage name rejected",
  contactImportRejectReason({ name: "Response", email: "a@b.com" }) ===
    "garbage name",
);
check(
  "noise email rejected",
  contactImportRejectReason({
    name: "Bot",
    email: "response@calendar-response.jifflenow.com",
  }) === "noise/implausible email",
);
check(
  "booking mailbox rejected",
  contactImportRejectReason({
    name: "Maven Booking",
    email: "booking@mavenagi.com",
  }) === "noise/implausible email",
);
check(
  "bd-tracking alias rejected",
  contactImportRejectReason({
    name: "Someone",
    email: "bd-tracking@dt-capital.net",
  }) === "noise/implausible email",
);
check(
  "Booking display name rejected",
  contactImportRejectReason({
    name: "Booking",
    email: "ccoye@skechers.com",
  }) === "garbage name",
);

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nAll contact-noise checks passed.");
