// Audit Contacts for noise / typo patterns from a pasted name list (or whole tab).
// Dry-run: npx tsx scripts/audit-contact-noise.ts
// Delete junk: npx tsx scripts/audit-contact-noise.ts --apply-junk
// Fix "Last, First" / "Last First" for known roster: --apply-flip

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

import { TEAM_MEMBER_EMAILS } from "../src/lib/user-ownership";
import {
  deleteSheetRows,
  fetchSheetTab,
  TAB_NAMES,
  updateSheetCells,
} from "../src/utils/sheets.server";
import { getInternalConfig } from "../src/utils/gmail.server";
import { isGarbageContactName } from "../src/lib/contact-noise";
import { isInternalEmail, isNoiseEmail } from "../src/lib/email-noise";
import { isPlausibleAddress, sanitizeEmailToken } from "../src/lib/email-address";

function hdrIndex(headers: string[], ...names: string[]): number {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const n of names) {
    const i = lower.indexOf(n.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function colLetter(idx0: number): string {
  let n = idx0 + 1;
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function primaryEmail(raw: string): string {
  return sanitizeEmailToken((raw || "").split(/[;,|]/)[0] || "") || "";
}

/** Single-token first name only (too thin to keep as a contact identity). */
function isTooThinName(name: string): boolean {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  return parts.length === 1 && parts[0].length <= 12 && !parts[0].includes("@");
}

/** "Falloon Chris" / "Beech Julia" → likely Last First when last is a known surname. */
const KNOWN_LAST_FIRST = new Map(
  [
    ["falloon chris", "Chris Falloon"],
    ["beech julia", "Julia Beech"],
    ["hillock chris", "Chris Hillock"],
    ["portillo becky", "Becky Portillo"],
    // Do NOT map "Portillo Chris" — usually Outlook "on behalf of" debris.
  ].map(([k, v]) => [k, v] as const),
);

type Bucket =
  | "junk_name"
  | "bad_email"
  | "internal_teammate"
  | "flip_name"
  | "thin_name"
  | "ok";

async function main() {
  const applyJunk = process.argv.includes("--apply-junk");
  const applyFlip = process.argv.includes("--apply-flip");
  const applyInternal = process.argv.includes("--apply-internal");

  const rows = await fetchSheetTab(TAB_NAMES.contacts);
  if (rows.length < 2) {
    console.log("No contacts.");
    return;
  }
  const headers = rows[0].map((h) => (h || "").trim());
  const nameIdx = 0;
  const emailIdx = hdrIndex(headers, "email", "email address");
  const companyIdx = hdrIndex(headers, "company", "organization");
  const internal = getInternalConfig();
  for (const e of TEAM_MEMBER_EMAILS) internal.addresses.add(e.toLowerCase());

  const buckets: Record<Bucket, { row: number; name: string; email: string; company: string; note?: string }[]> = {
    junk_name: [],
    bad_email: [],
    internal_teammate: [],
    flip_name: [],
    thin_name: [],
    ok: [],
  };

  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][nameIdx] || "").trim();
    const email = emailIdx >= 0 ? primaryEmail(rows[i][emailIdx] || "") : "";
    const company = companyIdx >= 0 ? (rows[i][companyIdx] || "").trim() : "";
    const sheetRow = i + 1;
    const entry = { row: sheetRow, name, email, company };

    if (isGarbageContactName(name) || /^portfolio/i.test(company)) {
      buckets.junk_name.push({ ...entry, note: "garbage name/company" });
      continue;
    }
    if (
      email &&
      (!isPlausibleAddress(email) ||
        isNoiseEmail(email) ||
        /\bon\.behalf(\.of)?\./i.test(email))
    ) {
      buckets.bad_email.push({ ...entry, note: "implausible/noise email" });
      continue;
    }
    if (email && isInternalEmail(email, internal)) {
      buckets.internal_teammate.push({ ...entry, note: "internal roster/domain" });
      continue;
    }
    const flip = KNOWN_LAST_FIRST.get(name.toLowerCase());
    if (flip) {
      buckets.flip_name.push({ ...entry, note: `→ ${flip}` });
      continue;
    }
    // Only flip explicitly known Last-First roster mistakes (never auto-reverse
    // normal "First Last" just because the email contains both tokens).
    if (isTooThinName(name) && !email) {
      buckets.thin_name.push({ ...entry, note: "single-token name, no email" });
      continue;
    }
    buckets.ok.push(entry);
  }

  const summarize = (b: Bucket, title: string) => {
    const list = buckets[b];
    console.log(`\n## ${title} (${list.length})`);
    for (const x of list.slice(0, 60)) {
      console.log(`  row ${x.row}: ${x.name} | ${x.email || "(no email)"} | ${x.company}${x.note ? ` — ${x.note}` : ""}`);
    }
    if (list.length > 60) console.log(`  … +${list.length - 60} more`);
  };

  console.log(`Contacts scanned: ${rows.length - 1}`);
  summarize("junk_name", "JUNK (safe to delete)");
  summarize("bad_email", "BAD EMAIL (safe to delete)");
  summarize("internal_teammate", "INTERNAL TEAMMATES (optional delete — usually not CRM contacts)");
  summarize("flip_name", "NAME FLIP (Last First → First Last)");
  summarize("thin_name", "THIN NAMES (review)");

  const junkRows = [
    ...buckets.junk_name.map((x) => x.row),
    ...buckets.bad_email.map((x) => x.row),
  ];

  // Flips MUST run before any deletes — otherwise sheet row numbers shift and
  // name writes land on the wrong people.
  if (applyFlip && buckets.flip_name.length) {
    const updates: { range: string; value: string }[] = [];
    for (const x of buckets.flip_name) {
      const known = KNOWN_LAST_FIRST.get(x.name.toLowerCase());
      let next = known;
      if (!next && x.note?.startsWith("→ ")) next = x.note.slice(2).split(" (")[0];
      if (!next) continue;
      updates.push({ range: `${colLetter(nameIdx)}${x.row}`, value: next });
    }
    if (updates.length) await updateSheetCells(TAB_NAMES.contacts, updates);
    console.log(`Flipped ${updates.length} names to First Last.`);
  } else if (!applyFlip) {
    console.log(`--apply-flip would fix ${buckets.flip_name.length} names.`);
  }

  if (applyJunk && junkRows.length) {
    await deleteSheetRows(TAB_NAMES.contacts, junkRows);
    console.log(`\nDeleted ${junkRows.length} junk/bad-email rows.`);
  } else if (!applyJunk) {
    console.log(`\nDry-run. --apply-junk would delete ${junkRows.length} rows.`);
  }

  if (applyInternal && buckets.internal_teammate.length) {
    await deleteSheetRows(
      TAB_NAMES.contacts,
      buckets.internal_teammate.map((x) => x.row),
    );
    console.log(`Deleted ${buckets.internal_teammate.length} internal teammate rows.`);
  } else if (!applyInternal) {
    console.log(`--apply-internal would delete ${buckets.internal_teammate.length} internal rows.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
