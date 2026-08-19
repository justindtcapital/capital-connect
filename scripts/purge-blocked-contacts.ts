// Delete Contacts rows whose Name is on the never-add blocklist
// (Julia Beech, Chris Hillock, Chris Falloon).
//
// Dry-run: npx tsx scripts/purge-blocked-contacts.ts
// Apply:   npx tsx scripts/purge-blocked-contacts.ts --apply

import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadEnv() {
  const text = readFileSync(join(process.cwd(), ".env"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

import {
  BLOCKED_CONTACT_NAMES,
  isBlockedContactEmail,
  isBlockedContactName,
} from "../src/lib/contact-noise";
import { isNameOnlyAttendeeEmail } from "../src/lib/email-address";
import { fetchSheetTab, TAB_NAMES, deleteSheetRows } from "../src/utils/sheets.server";

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await fetchSheetTab(TAB_NAMES.contacts);
  if (rows.length < 2) {
    console.log("No contacts.");
    return;
  }

  const emailIdx = rows[0].map((h) => h.trim().toLowerCase()).indexOf("email");
  const toDelete: number[] = [];
  const report: string[] = [];

  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][0] || "").trim();
    const email = emailIdx >= 0 ? (rows[i][emailIdx] || "").trim() : "";
    const blocked =
      isBlockedContactName(name) ||
      isBlockedContactEmail(email) ||
      // Also scrub any leftover calendar placeholders while we're here for these people.
      (isNameOnlyAttendeeEmail(email) && isBlockedContactName(name));
    if (!blocked) continue;
    const sheetRow = i + 1;
    toDelete.push(sheetRow);
    report.push(`row ${sheetRow}  ${name}${email ? `  <${email}>` : ""}`);
  }

  console.log(`Blocklist: ${BLOCKED_CONTACT_NAMES.join(", ")}`);
  console.log(`Matching rows: ${toDelete.length}`);
  for (const line of report) console.log(`  ${line}`);

  if (!apply) {
    console.log("\nDry-run only. Re-run with --apply to delete.");
    return;
  }
  if (toDelete.length === 0) {
    console.log("Nothing to delete.");
    return;
  }
  await deleteSheetRows(TAB_NAMES.contacts, toDelete);
  console.log(`\nDeleted ${toDelete.length} contact row(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
