// Merge remaining same-name Contacts that have different emails into one row:
//   Email: semicolon-joined unique addresses
//   Company: " / "-joined unique companies
// Then delete the other rows.
//
// Dry-run: npx tsx scripts/merge-same-name-contacts.ts
// Apply:   npx tsx scripts/merge-same-name-contacts.ts --apply

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
  fetchSheetTab,
  TAB_NAMES,
  deleteSheetRows,
  updateSheetCells,
} from "../src/utils/sheets.server";

function hdrIndex(headers: string[], ...names: string[]): number {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const n of names) {
    const i = lower.indexOf(n.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function splitEmails(raw: string): string[] {
  return (raw || "")
    .split(/[;,|]/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

function splitCompanies(raw: string): string[] {
  return (raw || "")
    .split(/\s*\/\s*|\s*;\s*|\s*\|\s*/)
    .map((c) => c.trim())
    .filter(Boolean);
}

function uniqPreserve<T>(items: T[], keyFn: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = keyFn(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function richness(row: string[]): number {
  return row.reduce((n, c) => n + ((c || "").trim() ? 1 : 0), 0);
}

function normalizedLocal(email: string): string {
  return (email.split("@")[0] || "").toLowerCase().replace(/[._+\-]/g, "");
}

function longestCommonSubstringLen(a: string, b: string): number {
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

/**
 * True when emails likely belong to the same person:
 * normalized locals equal/contain each other, or share a distinctive
 * substring (≥ 5 chars). Blocks Anil↔Sanchez and Max Moldavsky↔Max Gokhman.
 */
function emailsLookSamePerson(emails: string[]): boolean {
  if (emails.length <= 1) return true;
  const norms = emails.map(normalizedLocal).filter(Boolean);
  if (norms.length <= 1) return true;
  for (let i = 0; i < norms.length; i++) {
    for (let j = i + 1; j < norms.length; j++) {
      const a = norms[i];
      const b = norms[j];
      if (a === b || a.includes(b) || b.includes(a)) continue;
      if (longestCommonSubstringLen(a, b) >= 5) continue;
      return false;
    }
  }
  return true;
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

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await fetchSheetTab(TAB_NAMES.contacts);
  if (rows.length < 2) return;

  const headers = rows[0].map((h) => (h || "").trim());
  const nameIdx = 0;
  const emailIdx = hdrIndex(headers, "email", "email address");
  const companyIdx = hdrIndex(headers, "company", "organization");
  const roleIdx = hdrIndex(headers, "role", "title");
  const linkedinIdx = hdrIndex(headers, "linkedin", "linkedin url");
  const sectorIdx = hdrIndex(headers, "sector", "industry category");
  const phoneIdx = hdrIndex(headers, "phone", "phone number");
  const locationIdx = hdrIndex(headers, "location", "city");

  if (emailIdx < 0 || companyIdx < 0) {
    throw new Error("Contacts tab missing Email or Company column");
  }

  type Ref = { sheetRow: number; row: string[] };
  const byName = new Map<string, Ref[]>();
  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][nameIdx] || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const list = byName.get(key) || [];
    list.push({ sheetRow: i + 1, row: rows[i] });
    byName.set(key, list);
  }

  const cellUpdates: { range: string; value: string }[] = [];
  const toDelete: number[] = [];

  for (const [, group] of byName) {
    if (group.length < 2) continue;

    // Only merge when there are at least 2 distinct emails (or one email + blanks).
    const emails = uniqPreserve(
      group.flatMap((g) => splitEmails(g.row[emailIdx] || "")),
      (e) => e,
    );
    if (group.length < 2) continue;

    if (emails.length >= 2 && !emailsLookSamePerson(emails)) {
      console.log(
        `SKIP "${group[0].row[nameIdx]}" — emails look like different people: ${emails.join(" | ")}`,
      );
      continue;
    }

    const sorted = [...group].sort(
      (a, b) => richness(b.row) - richness(a.row) || a.sheetRow - b.sheetRow,
    );
    const keep = sorted[0];
    const drop = sorted.slice(1);

    const mergedEmails = uniqPreserve(
      group.flatMap((g) => splitEmails(g.row[emailIdx] || "")),
      (e) => e,
    );
    const mergedCompanies = uniqPreserve(
      group.flatMap((g) => splitCompanies(g.row[companyIdx] || "")),
      (c) => c.toLowerCase(),
    );

    const pickField = (idx: number) => {
      if (idx < 0) return "";
      for (const g of sorted) {
        const v = (g.row[idx] || "").trim();
        if (v) return v;
      }
      return "";
    };

    const newEmail = mergedEmails.join("; ");
    const newCompany = mergedCompanies.join(" / ");
    const newRole = pickField(roleIdx);
    const newLinkedin = pickField(linkedinIdx);
    const newSector = pickField(sectorIdx);
    const newPhone = pickField(phoneIdx);
    const newLocation = pickField(locationIdx);

    console.log(`MERGE "${keep.row[nameIdx]}" → keep row ${keep.sheetRow}, delete ${drop.map((d) => d.sheetRow).join(", ")}`);
    console.log(`  Email:   ${newEmail}`);
    console.log(`  Company: ${newCompany}`);
    if (newRole) console.log(`  Role:    ${newRole}`);

    const write = (idx: number, value: string) => {
      if (idx < 0 || !value) return;
      cellUpdates.push({
        range: `${colLetter(idx)}${keep.sheetRow}`,
        value,
      });
    };
    write(emailIdx, newEmail);
    write(companyIdx, newCompany);
    write(roleIdx, newRole);
    write(linkedinIdx, newLinkedin);
    write(sectorIdx, newSector);
    write(phoneIdx, newPhone);
    write(locationIdx, newLocation);

    for (const d of drop) toDelete.push(d.sheetRow);
  }

  console.log(`\nWould update ${cellUpdates.length} cells, delete ${toDelete.length} rows.`);
  if (!apply) {
    console.log("Dry-run only. Re-run with --apply to merge.");
    return;
  }

  if (cellUpdates.length) await updateSheetCells(TAB_NAMES.contacts, cellUpdates);
  if (toDelete.length) await deleteSheetRows(TAB_NAMES.contacts, toDelete);
  console.log(`Merged: updated keepers, deleted ${toDelete.length} rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
