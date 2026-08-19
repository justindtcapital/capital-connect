/**
 * Remove Contacts auto-sourced from Activity Sync at @dell.com (teammates
 * incorrectly created with PortCo tags as Company).
 * Dry-run: npx tsx scripts/purge-dell-activity-sync.ts
 * Apply:   npx tsx scripts/purge-dell-activity-sync.ts --apply
 */
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

import { deleteSheetRows, fetchSheetTab, TAB_NAMES } from "../src/utils/sheets.server";

function hdrIndex(headers: string[], ...names: string[]): number {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const n of names) {
    const i = lower.indexOf(n.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await fetchSheetTab(TAB_NAMES.contacts);
  if (rows.length < 2) {
    console.log("No contacts.");
    return;
  }
  const headers = rows[0].map((h) => (h || "").trim());
  const emailIdx = hdrIndex(headers, "email", "email address");
  const sourceIdx = hdrIndex(headers, "source", "lead source", "origin");
  const companyIdx = hdrIndex(headers, "company", "organization");

  const hits: { row: number; name: string; email: string; company: string; source: string }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][0] || "").trim();
    const email = emailIdx >= 0 ? (rows[i][emailIdx] || "").trim().toLowerCase() : "";
    const primary = email.split(/[;,|]/)[0]?.trim() || "";
    const source = sourceIdx >= 0 ? (rows[i][sourceIdx] || "").trim() : "";
    const company = companyIdx >= 0 ? (rows[i][companyIdx] || "").trim() : "";
    const isDell = primary.endsWith("@dell.com");
    const isActivitySync = /activity\s*sync/i.test(source);
    if (isDell && isActivitySync) {
      hits.push({ row: i + 1, name, email: primary, company, source });
    }
  }

  console.log(`Found ${hits.length} Activity Sync @dell.com contact(s):`);
  for (const h of hits) {
    console.log(`  row ${h.row}: ${h.name} | ${h.email} | ${h.company.slice(0, 60)}`);
  }

  if (apply && hits.length) {
    await deleteSheetRows(
      TAB_NAMES.contacts,
      hits.map((h) => h.row),
    );
    console.log(`Deleted ${hits.length} row(s).`);
  } else if (!apply) {
    console.log(hits.length ? "Dry-run. Pass --apply to delete." : "Nothing to do.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
