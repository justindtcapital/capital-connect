// Dedupe Contacts tab: for duplicate Name (col A), keep one row and delete the rest.
// Prefer same-email true dupes; for same-name / different-email keep ALL (different people).
// Among same-email (or blank-email) groups, keep the richest row.
//
// Dry-run:  npx tsx scripts/dedupe-contacts.ts
// Apply:    npx tsx scripts/dedupe-contacts.ts --apply

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
} from "../src/utils/sheets.server";

function hdrIndex(headers: string[], ...names: string[]): number {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const n of names) {
    const i = lower.indexOf(n.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function primaryEmail(raw: string): string {
  return (raw || "")
    .split(/[;,|]/)[0]
    ?.trim()
    .toLowerCase()
    .replace(/^[\s"'([{<]+/, "")
    .replace(/[\s"')\]}>]+$/, "") || "";
}

function richness(row: string[], idxs: { email: number; company: number; linkedin: number; sector: number; role: number; phone: number }): number {
  let score = 0;
  const fields = [idxs.email, idxs.company, idxs.linkedin, idxs.sector, idxs.role, idxs.phone];
  for (const i of fields) {
    if (i >= 0 && (row[i] || "").trim()) score += 1;
  }
  // Prefer longer non-empty cells overall
  for (const cell of row) {
    if ((cell || "").trim()) score += 0.05;
  }
  return score;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await fetchSheetTab(TAB_NAMES.contacts);
  if (rows.length < 2) {
    console.log("No contacts.");
    return;
  }

  const headers = rows[0].map((h) => (h || "").trim());
  const nameIdx = 0; // column A
  const emailIdx = hdrIndex(headers, "email", "email address");
  const companyIdx = hdrIndex(headers, "company", "organization");
  const linkedinIdx = hdrIndex(headers, "linkedin", "linkedin url");
  const sectorIdx = hdrIndex(headers, "sector", "industry category");
  const roleIdx = hdrIndex(headers, "role", "title");
  const phoneIdx = hdrIndex(headers, "phone", "phone number");

  type RowRef = { sheetRow: number; row: string[]; email: string; score: number };
  const byName = new Map<string, RowRef[]>();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = (row[nameIdx] || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const email = emailIdx >= 0 ? primaryEmail(row[emailIdx] || "") : "";
    const score = richness(row, {
      email: emailIdx,
      company: companyIdx,
      linkedin: linkedinIdx,
      sector: sectorIdx,
      role: roleIdx,
      phone: phoneIdx,
    });
    const list = byName.get(key) || [];
    list.push({ sheetRow: i + 1, row, email, score });
    byName.set(key, list);
  }

  const toDelete = new Set<number>();
  const report: string[] = [];
  let keptDifferentPeople = 0;

  for (const [, group] of byName) {
    if (group.length < 2) continue;

    // Partition by primary email (blank emails share one bucket per name).
    const byEmail = new Map<string, RowRef[]>();
    for (const g of group) {
      const ek = g.email || `__blank__:${(g.row[nameIdx] || "").toLowerCase()}`;
      const list = byEmail.get(ek) || [];
      list.push(g);
      byEmail.set(ek, list);
    }

    // Different emails under same name → different people; keep all.
    const realEmails = [...byEmail.keys()].filter((k) => !k.startsWith("__blank__"));
    if (realEmails.length > 1) {
      keptDifferentPeople++;
      // Still collapse blank-email dupes of the same name if a named email exists:
      // prefer deleting blank rows that duplicate a name we already have with email.
      for (const [ek, list] of byEmail) {
        if (!ek.startsWith("__blank__")) continue;
        for (const blank of list) {
          toDelete.add(blank.sheetRow);
          report.push(
            `DEL row ${blank.sheetRow} blank-email dupe of name "${blank.row[nameIdx]}" (other emails exist)`,
          );
        }
      }
      // Also dedupe within each same-email bucket
      for (const [ek, list] of byEmail) {
        if (ek.startsWith("__blank__") || list.length < 2) continue;
        list.sort((a, b) => b.score - a.score || a.sheetRow - b.sheetRow);
        const keep = list[0];
        for (const drop of list.slice(1)) {
          toDelete.add(drop.sheetRow);
          report.push(
            `DEL row ${drop.sheetRow} same-email dupe of row ${keep.sheetRow} (${keep.email}) name="${keep.row[nameIdx]}"`,
          );
        }
      }
      continue;
    }

    // Single email bucket (or all blank): keep richest, delete rest.
    const all = [...group].sort((a, b) => b.score - a.score || a.sheetRow - b.sheetRow);
    const keep = all[0];
    for (const drop of all.slice(1)) {
      toDelete.add(drop.sheetRow);
      report.push(
        `DEL row ${drop.sheetRow} name-dupe of row ${keep.sheetRow} name="${keep.row[nameIdx]}"` +
          (keep.email ? ` email=${keep.email}` : " (no email)"),
      );
    }
  }

  const deleteRows = [...toDelete].sort((a, b) => b - a); // descending for safe delete
  console.log(`Name-dupe groups kept as different people (multi-email): ${keptDifferentPeople}`);
  console.log(`Rows to delete: ${deleteRows.length}`);
  console.log("");
  for (const line of report.slice(0, 100)) console.log(`  ${line}`);
  if (report.length > 100) console.log(`  … and ${report.length - 100} more`);

  if (!apply) {
    console.log("\nDry-run only. Re-run with --apply to delete these rows.");
    return;
  }

  if (deleteRows.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  // deleteSheetRows may expect ascending or a batch API — check implementation.
  await deleteSheetRows(TAB_NAMES.contacts, deleteRows);
  console.log(`\nDeleted ${deleteRows.length} duplicate contact rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
