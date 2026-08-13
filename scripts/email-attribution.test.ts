// BD/GTM alias attribution — golden fixtures modeled on the real traffic
// patterns from the 2026-08-13 live diagnostic (scripts/gmail-alias-check.ts):
// quoted/unquoted comma display names, FW: self-forwards where the only human
// in the headers is the internal forwarder, Asana intake co-recipients,
// multi-message reply chains, and Asana×Gmail cross-source twins.
// Run: npx tsx scripts/email-attribution.test.ts

import {
  parseAddressList,
  extractForwardedBlock,
  isInternalEmail,
  type InternalMailConfig,
} from "../src/lib/email-participants";
import { pickPrimaryCounterparty, type Counterparty } from "../src/lib/email-noise";
import {
  threadToActivity,
  threadsToActivities,
  type ActivityMessage,
} from "../src/lib/email-activity-build";
import {
  canonicalizeGmailActivities,
  dropCrossSourceDupes,
  matchActivitiesToContact,
  normalizeSubjectKey,
} from "../src/lib/activity-match";
import type { AsanaActivity, Contact } from "../src/lib/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ALIASES = new Set(["bd-tracking@dt-capital.net", "bd-tracking@gmail.com"]);
const INTERNAL: InternalMailConfig = {
  domains: new Set(["dt-capital.net"]),
  addresses: new Set(["chris.falloon@dell.com", "justin.adorante@dell.com"]),
};

function msg(over: Partial<ActivityMessage> & { id: string }): ActivityMessage {
  return {
    threadId: over.id,
    subject: "(no subject)",
    fromName: "",
    fromEmail: "",
    toAddrs: [],
    ccAddrs: [],
    date: Date.parse("2026-08-12T15:00:00Z"),
    dateLabel: "2026-08-12",
    snippet: "",
    body: "",
    permalink: `https://mail.google.com/mail/u/0/#all/${over.id}`,
    ...over,
  };
}

console.log("— parseAddressList (RFC 5322, display names kept) —");
{
  const parsed = parseAddressList(
    '"Jain, Vrashank" <Vrashank.J@Dell.com>, Falloon, Chris <chris.falloon@dell.com>, not-an-address, raj@maxiq.ai',
  );
  check("quoted comma name is ONE entry", parsed.length === 3, `got ${parsed.length}`);
  check(
    "quoted display name kept",
    parsed[0]?.name === "Jain, Vrashank" && parsed[0]?.email === "vrashank.j@dell.com",
    JSON.stringify(parsed[0]),
  );
  check(
    "UNquoted comma name repaired",
    parsed[1]?.name === "Falloon, Chris" && parsed[1]?.email === "chris.falloon@dell.com",
    JSON.stringify(parsed[1]),
  );
  check("bare email accepted", parsed[2]?.email === "raj@maxiq.ai");
  check(
    "junk token never becomes a recipient",
    parsed.every((p) => p.email.includes("@")),
  );
  check("empty list on garbage", parseAddressList("Undisclosed recipients:;").length === 0);

  // Live-mailbox regressions (2026-08-13 diagnostic):
  const nestedMailto = parseAddressList(
    "Schmitt, Doug <douglas.schmitt@dell.com<mailto:douglas.schmitt@dell.com>>",
  );
  check(
    "Outlook nested <mailto:> never leaks a bracket into the name",
    nestedMailto.length === 1 &&
      nestedMailto[0].name === "Schmitt, Doug" &&
      nestedMailto[0].email === "douglas.schmitt@dell.com",
    JSON.stringify(nestedMailto),
  );
  const nameOnlyList = parseAddressList(
    "Falloon, Chris, Kohl, Neal, Karan Goel, Gibbard, James <james@cartesia.ai>",
  );
  check(
    "name-only list never glues into one giant display name",
    nameOnlyList.length === 1 && nameOnlyList[0].name === "Gibbard, James",
    JSON.stringify(nameOnlyList),
  );
}

console.log("— internal classification —");
{
  check("domain match", isInternalEmail("anyone@dt-capital.net", INTERNAL));
  check("roster address match", isInternalEmail("Chris.Falloon@dell.com", INTERNAL));
  check(
    "other dell.com people are EXTERNAL (Dell BUs are counterparties)",
    !isInternalEmail("vrashank.j@dell.com", INTERNAL),
  );
}

console.log("— pickPrimaryCounterparty (external-first) —");
{
  const people: Counterparty[] = [
    { name: "Chris Falloon", email: "chris.falloon@dell.com", role: "from", internal: true },
    { name: "Raj Patel", email: "raj@maxiq.ai", role: "to" },
  ];
  check(
    "internal From loses to external To",
    pickPrimaryCounterparty(people, false)?.email === "raj@maxiq.ai",
  );
  check(
    "internal fallback when nobody external",
    pickPrimaryCounterparty(
      [{ name: "Chris", email: "chris.falloon@dell.com", role: "from", internal: true }],
      false,
    )?.email === "chris.falloon@dell.com",
  );
}

console.log("— extractForwardedBlock —");
{
  const outlook = extractForwardedBlock(
    "FYI — forwarding for tracking.\n\n" +
      "From: Raj Patel <raj@maxiq.ai>\n" +
      "Sent: Tuesday, August 12, 2026 9:04 AM\n" +
      "To: Falloon, Chris <chris.falloon@dell.com>\n" +
      "Subject: MaxIQ > Dell DFS\n\n" +
      "Great speaking yesterday — sharing the deck. jane@treeverse.dev was mentioned in passing.",
  );
  check("Outlook block: original From found", outlook?.from[0]?.email === "raj@maxiq.ai");
  check(
    "Outlook block: To name repaired across comma",
    outlook?.to[0]?.email === "chris.falloon@dell.com" && outlook?.to[0]?.name === "Falloon, Chris",
    JSON.stringify(outlook?.to),
  );
  check(
    "body emails beyond the header block are NOT collected",
    !JSON.stringify(outlook).includes("treeverse"),
  );

  const inline = extractForwardedBlock(
    "FYI From: Raj Patel <raj@maxiq.ai> Sent: Tuesday, August 12, 2026 To: Falloon, Chris <chris.falloon@dell.com> Subject: MaxIQ intro Thanks all.",
  );
  check(
    "HTML-flattened (no newlines) block still parses",
    inline?.from[0]?.email === "raj@maxiq.ai",
  );

  const nested = extractForwardedBlock(
    "From: A One <a@one.com>\nTo: B Two <b@two.com>\nSubject: x\n\ntext\n\nFrom: C Three <c@three.com>\nTo: D Four <d@four.com>\n",
  );
  check(
    "only the FIRST forwarded hop is trusted",
    nested?.from.length === 1 &&
      nested.from[0].email === "a@one.com" &&
      nested.to[0]?.email === "b@two.com",
  );
  check("no block → null", extractForwardedBlock("just a normal email body") === null);
}

console.log("— FW: self-forward (the 35/39 failure mode) —");
{
  const act = threadToActivity(
    [
      msg({
        id: "fw1",
        subject: "FW: MaxIQ > Dell DFS",
        fromName: "Falloon, Chris",
        fromEmail: "chris.falloon@dell.com",
        toAddrs: [{ name: "", email: "bd-tracking@dt-capital.net" }],
        snippet: "FYI — forwarding for tracking.",
        body:
          "FYI — forwarding for tracking.\n\n" +
          "From: Raj Patel <raj@maxiq.ai>\n" +
          "Sent: Tuesday, August 12, 2026 9:04 AM\n" +
          "To: Falloon, Chris <chris.falloon@dell.com>\n" +
          "Subject: MaxIQ > Dell DFS\n\nGreat speaking yesterday.",
      }),
    ],
    "BD",
    ALIASES,
    INTERNAL,
  );
  check("activity created", !!act);
  check("Person = forwarded external, NOT the forwarder", act?.person === "Raj Patel", act?.person);
  check("personEmail carried for CRM join", act?.personEmail === "raj@maxiq.ai");
  check("direction from forwarded hop (external sent it) = Received", act?.status === "Received");
  check("Owner = the internal forwarder", act?.owner === "chris.falloon@dell.com", act?.owner);
  check("company guess from counterparty domain, not Dell", act?.company === "Maxiq", act?.company);
}

console.log("— internal fallback when truly nobody external —");
{
  const act = threadToActivity(
    [
      msg({
        id: "int1",
        subject: "BD pipeline sync notes",
        fromName: "Falloon, Chris",
        fromEmail: "chris.falloon@dell.com",
        toAddrs: [{ name: "", email: "bd-tracking@dt-capital.net" }],
        body: "Internal notes, no forward block.",
      }),
    ],
    "BD",
    ALIASES,
    INTERNAL,
  );
  check("still logs (falls back to internal person)", act?.person === "Falloon, Chris");
  check("internal From = outbound", act?.status === "Sent");
}

console.log("— outbound CC'd alias + Asana intake co-recipient —");
{
  const act = threadToActivity(
    [
      msg({
        id: "out1",
        subject: "DTC: MaxIQ — GTM Discussion",
        fromName: "Falloon, Chris",
        fromEmail: "chris.falloon@dell.com",
        toAddrs: [{ name: "Jain, Vrashank", email: "vrashank.j@dell.com" }],
        ccAddrs: [
          { name: "", email: "bd-tracking@dt-capital.net" },
          { name: "", email: "x+12345@mail.asana.com" },
        ],
        snippet: "Following up on the DFS conversation.",
      }),
    ],
    "GTM",
    ALIASES,
    INTERNAL,
  );
  check("outbound because From is internal (alias only CC'd)", act?.status === "Sent");
  check(
    "Person = external recipient with real display name",
    act?.person === "Jain, Vrashank",
    act?.person,
  );
  check("Owner = internal sender", act?.owner === "chris.falloon@dell.com");
  check(
    "Asana intake address never a counterparty",
    !(act?.notes || "").includes("mail.asana.com"),
  );
}

console.log("— thread collapse (Treeverse 4-rows problem) —");
{
  const thread = [
    msg({
      id: "m1",
      threadId: "t1",
      subject: "Treeverse <> DTC",
      fromName: "Jane Lee",
      fromEmail: "jane@treeverse.dev",
      toAddrs: [{ name: "Falloon, Chris", email: "chris.falloon@dell.com" }],
      ccAddrs: [{ name: "", email: "bd-tracking@dt-capital.net" }],
      date: Date.parse("2026-08-10T10:00:00Z"),
      dateLabel: "2026-08-10",
    }),
    msg({
      id: "m2",
      threadId: "t1",
      subject: "RE: Treeverse <> DTC",
      fromName: "Falloon, Chris",
      fromEmail: "chris.falloon@dell.com",
      toAddrs: [{ name: "Jane Lee", email: "jane@treeverse.dev" }],
      ccAddrs: [{ name: "", email: "bd-tracking@dt-capital.net" }],
      date: Date.parse("2026-08-11T10:00:00Z"),
      dateLabel: "2026-08-11",
    }),
    msg({
      id: "m3",
      threadId: "t1",
      subject: "RE: Treeverse <> DTC",
      fromName: "Jane Lee",
      fromEmail: "jane@treeverse.dev",
      toAddrs: [{ name: "Falloon, Chris", email: "chris.falloon@dell.com" }],
      ccAddrs: [
        { name: "", email: "bd-tracking@dt-capital.net" },
        { name: "Sam CTO", email: "sam@treeverse.dev" },
      ],
      date: Date.parse("2026-08-12T10:00:00Z"),
      dateLabel: "2026-08-12",
    }),
    msg({
      id: "solo",
      subject: "Unrelated single",
      fromName: "Ana Solo",
      fromEmail: "ana@acme.com",
      toAddrs: [{ name: "", email: "bd-tracking@dt-capital.net" }],
    }),
  ];
  const acts = threadsToActivities(thread, "BD", ALIASES, INTERNAL);
  check(
    "4 messages → 2 activities (3-msg thread collapsed)",
    acts.length === 2,
    `got ${acts.length}`,
  );
  const t1 = acts.find((a) => a.gid === "gmail-t1");
  check("thread gid = gmail-<threadId>", !!t1);
  check("date/status from newest message", t1?.date === "2026-08-12" && t1?.status === "Received");
  check(
    "counterparties unioned across thread",
    !!t1 && ["jane@treeverse.dev", "sam@treeverse.dev"].every((e) => (t1.notes || "").includes(e)),
  );
  check(
    "single-message thread keeps legacy gid",
    acts.some((a) => a.gid === "gmail-solo"),
  );
}

console.log("— cross-source dedupe (Asana wins) —");
{
  check(
    "RE:/FW: stack strips",
    normalizeSubjectKey("RE: FW: MaxIQ > Dell DFS") === normalizeSubjectKey("MaxIQ > Dell DFS"),
  );
  const asana: AsanaActivity[] = [
    { gid: "111", track: "BD", name: "MaxIQ > Dell DFS", date: "2026-08-11", completed: true },
  ];
  const gmail: AsanaActivity[] = [
    {
      gid: "gmail-a",
      track: "BD",
      name: "FW: MaxIQ > Dell DFS",
      date: "2026-08-12",
      completed: true,
    },
    {
      gid: "gmail-b",
      track: "BD",
      name: "Totally different thread",
      date: "2026-08-12",
      completed: true,
    },
    {
      gid: "gmail-c",
      track: "BD",
      name: "FW: MaxIQ > Dell DFS",
      date: "2026-08-30",
      completed: true,
    },
  ];
  const kept = dropCrossSourceDupes(asana, gmail);
  check("same subject ±3d dropped", !kept.some((a) => a.gid === "gmail-a"));
  check(
    "different subject kept",
    kept.some((a) => a.gid === "gmail-b"),
  );
  check(
    "same subject outside window kept",
    kept.some((a) => a.gid === "gmail-c"),
  );
}

console.log("— CRM canonicalization (Person/Company) —");
{
  const contacts = [
    {
      id: "1",
      name: "Vrashank Jain",
      company: "Dell Financial Services",
      email: "vrashank.j@dell.com",
    } as Contact,
  ];
  const raw: AsanaActivity = {
    gid: "gmail-x",
    track: "GTM",
    name: "DTC: MaxIQ — GTM Discussion",
    person: "Jain, Vrashank",
    personEmail: "vrashank.j@dell.com",
    company: "Dell",
    notes: "Outbound email\nPeople: Jain, Vrashank <vrashank.j@dell.com>",
    completed: true,
  };
  const [withPortco] = canonicalizeGmailActivities([raw], contacts, ["MaxIQ", "Treeverse"]);
  check("Person → CRM canonical name", withPortco.person === "Vrashank Jain", withPortco.person);
  check(
    "Company → portco mentioned in subject beats all",
    withPortco.company === "MaxIQ",
    withPortco.company,
  );
  const [noPortco] = canonicalizeGmailActivities([{ ...raw, name: "Quick sync" }], contacts, [
    "Treeverse",
  ]);
  check(
    "Company → CRM company when no portco mention",
    noPortco.company === "Dell Financial Services",
  );
  const [unknown] = canonicalizeGmailActivities(
    [{ ...raw, personEmail: "stranger@newco.io", person: "Sam Stranger", company: "Newco" }],
    contacts,
    [],
  );
  check(
    "unknown email keeps header name + domain guess",
    unknown.person === "Sam Stranger" && unknown.company === "Newco",
  );
}

console.log("— notes: People line survives truncation; token-exact match —");
{
  const many = Array.from({ length: 15 }, (_, i) => ({
    name: `Person ${i}`,
    email: `person${i}@bigco.com`,
  }));
  const act = threadToActivity(
    [
      msg({
        id: "big1",
        subject: "Big CC thread",
        fromName: "Raj Patel",
        fromEmail: "raj@maxiq.ai",
        toAddrs: [{ name: "", email: "bd-tracking@dt-capital.net" }],
        ccAddrs: many,
        snippet: "x".repeat(2000),
      }),
    ],
    "BD",
    ALIASES,
    INTERNAL,
  );
  check("notes capped at 1000", (act?.notes || "").length <= 1000, String(act?.notes?.length));
  check(
    "ALL counterparty emails survive (snippet absorbed the cap)",
    many.every((p) => (act?.notes || "").includes(p.email)),
  );
  check("audit link present", (act?.notes || "").includes("Link: https://mail.google.com"));

  const contactJo = { id: "1", name: "Jo", email: "jo@x.com", company: "X" } as Contact;
  const actJjo: AsanaActivity = {
    gid: "gmail-tok",
    track: "BD",
    name: "hello",
    notes: "Inbound email\nPeople: JJo <jjo@x.com>",
    completed: true,
  };
  const actJo: AsanaActivity = {
    gid: "gmail-tok2",
    track: "BD",
    name: "hello",
    notes: "Inbound email\nPeople: Jo <jo@x.com>",
    completed: true,
  };
  check(
    "jo@x.com does NOT match inside jjo@x.com",
    matchActivitiesToContact([actJjo], contactJo).length === 0,
  );
  check("exact email still matches", matchActivitiesToContact([actJo], contactJo).length === 1);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll email-attribution fixtures passed.");
