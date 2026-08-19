// Thorough event follow-up tests against the live test spreadsheet.
// Writes to Sheets (safe on a test workbook).
//
// Steps:
//   1) Unit-style checks (no Sheets) for date/email helpers
//   2) Backfill Follow Up Flag on every contact with an "attended" Events row
//   3) E2E: create a throwaway contact → tag attended → assert Follow Up + Events row
//   4) Re-tag same person (idempotent) → assert no duplicate Events row
//   5) Coverage snapshot after backfill
//
// Run: npx tsx scripts/test-event-followup-e2e.ts
// Cleanup: leaves the test contact tagged (search email "e2e-followup-") so you can delete later.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(path: string) {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (e) {
    console.error("Failed to load .env:", e);
    process.exit(1);
  }
}
loadEnv(resolve(process.cwd(), ".env"));

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let last: unknown;
  for (let a = 1; a <= attempts; a++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/429|RATE_LIMIT|RESOURCE_EXHAUSTED/i.test(msg) || a === attempts) throw e;
      const wait = Math.min(a * 15_000, 60_000);
      console.warn(`[retry] ${label} quota — wait ${wait / 1000}s (${a}/${attempts})`);
      await sleep(wait);
    }
  }
  throw last;
}

function primaryEmail(raw: string): string {
  return (raw || "").split(";")[0]?.trim().toLowerCase() || "";
}

function idx(headers: string[], ...names: string[]): number {
  for (const n of names) {
    const i = headers.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

async function main() {
  console.log("— 1) pure helpers —");
  {
    const { primarySheetEmail } = await import("../src/utils/sheets.server");
    check("primarySheetEmail lowercases", primarySheetEmail("A@B.com") === "a@b.com");
    check("primarySheetEmail first of list", primarySheetEmail("a@x.com; b@y.com") === "a@x.com");
  }

  const {
    TAB_NAMES,
    fetchSheetTab,
    addContactRow,
    flagContactsForFollowUp,
    ensureEventAttendanceBatch,
    logOpsEvent,
  } = await import("../src/utils/sheets.server");

  console.log("\n— 2) backfill Follow Up on existing attended contacts —");
  const eventRows = await withRetry("Events read", () => fetchSheetTab(TAB_NAMES.events));
  const eh = (eventRows[0] || []).map((h) => h.trim().toLowerCase());
  const eEmailI = idx(eh, "contact email");
  const eTypeI = idx(eh, "type");
  check("Events has Contact Email", eEmailI >= 0);
  check("Events has Type", eTypeI >= 0);

  const attendedEmails = new Set<string>();
  for (const r of eventRows.slice(1)) {
    const type = (r[eTypeI] || "").trim().toLowerCase();
    if (type && type !== "attended") continue;
    const email = primaryEmail(r[eEmailI] || "");
    if (email) attendedEmails.add(email);
  }
  console.log(`  attended emails found: ${attendedEmails.size}`);

  const backfill = await withRetry("follow-up backfill", () =>
    flagContactsForFollowUp([...attendedEmails]),
  );
  console.log(`  Follow Up flags newly set: ${backfill.updated}`);
  check("backfill ran without throw", true);
  await withRetry("ops log backfill", () =>
    logOpsEvent({
      action: "maintenance",
      source: "event_followup_backfill",
      status: "ok",
      summary: `Backfilled Follow Up Flag on ${backfill.updated} attended contacts (${attendedEmails.size} attended emails scanned)`,
      records: backfill.updated,
      details: { attendedEmails: attendedEmails.size, updated: backfill.updated },
    }),
  );

  console.log("\n— 3) E2E write: create contact → tag attended → assert flag —");
  const stamp = Date.now();
  const testEmail = `e2e-followup-${stamp}@dtc-test.local`;
  const testName = `E2E FollowUp ${stamp}`;
  const testEvent = `E2E Follow-Up Probe ${new Date().toISOString().slice(0, 10)}`;

  await withRetry("addContactRow", () =>
    addContactRow({
      name: testName,
      role: "E2E Tester",
      company: "DTC Test Co",
      email: testEmail,
      phone: "",
      location: "",
      prime: "",
      sector: "",
      temperature: "Warm",
      source: "E2E Test",
      followUp: false,
    }),
  );
  check("test contact created", true, testEmail);

  const tag1 = await withRetry("ensureEventAttendance", () =>
    ensureEventAttendanceBatch([
      {
        email: testEmail,
        eventName: testEvent,
        type: "attended",
        date: new Date().toISOString().slice(0, 10),
        ensureCatalog: true,
        catalogType: "meeting",
      },
    ]),
  );
  check("attendance written", tag1.attendanceWritten === 1, String(tag1.attendanceWritten));

  const flagged = await withRetry("flag test contact", () => flagContactsForFollowUp([testEmail]));
  check("follow-up flag set on test contact", flagged.updated === 1, String(flagged.updated));

  // Re-read Contacts + Events to assert persistence.
  await sleep(1500);
  const contacts = await withRetry("Contacts re-read", () => fetchSheetTab(TAB_NAMES.contacts));
  const ch = (contacts[0] || []).map((h) => h.trim().toLowerCase());
  const cEmailI = idx(ch, "email");
  const cFlagI = idx(ch, "follow up flag");
  const cNameI = idx(ch, "name");
  let foundContact = false;
  let flagTrue = false;
  for (const r of contacts.slice(1)) {
    if (primaryEmail(r[cEmailI] || "") !== testEmail) continue;
    foundContact = true;
    flagTrue = (r[cFlagI] || "").trim().toLowerCase() === "true";
    check("contact name persisted", (r[cNameI] || "").includes("E2E FollowUp"));
    break;
  }
  check("test contact visible in Contacts", foundContact);
  check("Follow Up Flag is TRUE on sheet", flagTrue);

  const events2 = await withRetry("Events re-read", () => fetchSheetTab(TAB_NAMES.events));
  const eh2 = (events2[0] || []).map((h) => h.trim().toLowerCase());
  const eeI = idx(eh2, "contact email");
  const enI = idx(eh2, "event name");
  const etI = idx(eh2, "type");
  const matches = events2
    .slice(1)
    .filter(
      (r) =>
        primaryEmail(r[eeI] || "") === testEmail &&
        (r[enI] || "").trim().toLowerCase() === testEvent.toLowerCase(),
    );
  check("exactly one Events row for test pair", matches.length === 1, String(matches.length));
  check(
    "Events type is attended",
    (matches[0]?.[etI] || "").trim().toLowerCase() === "attended",
    matches[0]?.[etI],
  );

  console.log("\n— 4) idempotent re-tag —");
  const tag2 = await withRetry("re-tag attended", () =>
    ensureEventAttendanceBatch([
      {
        email: testEmail,
        eventName: testEvent,
        type: "attended",
        date: new Date().toISOString().slice(0, 10),
        ensureCatalog: true,
        catalogType: "meeting",
      },
    ]),
  );
  check("second tag writes 0 new attendance", tag2.attendanceWritten === 0, String(tag2.attendanceWritten));
  check("second tag skipped", tag2.skipped >= 1, String(tag2.skipped));

  const events3 = await withRetry("Events after re-tag", () => fetchSheetTab(TAB_NAMES.events));
  const matches2 = events3
    .slice(1)
    .filter(
      (r) =>
        primaryEmail(r[eeI] || "") === testEmail &&
        (r[enI] || "").trim().toLowerCase() === testEvent.toLowerCase(),
    );
  check("still exactly one Events row", matches2.length === 1, String(matches2.length));

  console.log("\n— 5) post-backfill coverage snapshot —");
  const contacts2 = await withRetry("Contacts coverage", () => fetchSheetTab(TAB_NAMES.contacts));
  const ch2 = (contacts2[0] || []).map((h) => h.trim().toLowerCase());
  const emailI = idx(ch2, "email");
  const flagI = idx(ch2, "follow up flag");
  const attended = [...attendedEmails];
  let flaggedCount = 0;
  let missingFlag = 0;
  // Match on any address in a multi-email Contacts cell.
  const flagByAny = new Map<string, string>();
  for (const r of contacts2.slice(1)) {
    const raw = r[emailI] || "";
    const flag = (r[flagI] || "").trim().toLowerCase();
    for (const part of raw.split(/[;,]/)) {
      const e = part.trim().toLowerCase();
      if (e) flagByAny.set(e, flag);
    }
  }
  for (const e of attended) {
    const f = flagByAny.get(e);
    if (f === undefined) continue; // not in Contacts
    if (f === "true") flaggedCount++;
    else missingFlag++;
  }
  console.log(`  attended emails also in Contacts: ${flaggedCount + missingFlag}`);
  console.log(`  of those, Follow Up TRUE:         ${flaggedCount}`);
  console.log(`  of those, Follow Up still false:  ${missingFlag}`);
  check(
    "≥95% of attended Contacts now flagged",
    flaggedCount + missingFlag > 0 && missingFlag / (flaggedCount + missingFlag) <= 0.05,
    `${flaggedCount} flagged / ${missingFlag} missing`,
  );

  await withRetry("ops log e2e", () =>
    logOpsEvent({
      action: "maintenance",
      source: "event_followup_e2e",
      status: failures === 0 ? "ok" : "error",
      summary:
        failures === 0
          ? `E2E passed · backfilled ${backfill.updated} · probe ${testEmail}`
          : `E2E finished with ${failures} failure(s) · probe ${testEmail}`,
      records: backfill.updated + 1,
      details: {
        backfillUpdated: backfill.updated,
        testEmail,
        testEvent,
        flaggedCount,
        missingFlag,
        failures,
      },
      items: [testEmail, testEvent],
    }),
  );

  console.log(
    failures === 0
      ? `\nAll event follow-up tests passed.\nProbe contact left in sheet: ${testName} <${testEmail}> · event "${testEvent}"`
      : `\n${failures} failure(s). Probe: ${testEmail}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
