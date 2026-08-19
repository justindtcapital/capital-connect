// Find Notes rows where the same contact has both an Asana and a Gmail
// Source Ref for the same subject (within 3 days). Optionally delete the
// Gmail twin (Asana wins).
//
// Dry-run: npx tsx scripts/audit-asana-gmail-dupes.ts
// Apply:   npx tsx scripts/audit-asana-gmail-dupes.ts --apply

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

import { normalizeSubjectKey } from "../src/lib/activity-canonical";
import { fetchSheetTab, TAB_NAMES, deleteSheetRows } from "../src/utils/sheets.server";

function dayNum(d: string): number | null {
  if (!d) return null;
  const t = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / 86_400_000) : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await fetchSheetTab(TAB_NAMES.interactions);
  if (rows.length < 2) {
    console.log("No Notes rows.");
    return;
  }
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const emailI = h.indexOf("contact email");
  const tsI = h.indexOf("timestamp");
  const noteI = h.indexOf("note content");
  const refI = h.indexOf("source ref");
  if (emailI < 0 || refI < 0 || noteI < 0) {
    throw new Error("Notes tab missing Contact Email / Note Content / Source Ref");
  }

  type Row = {
    sheetRow: number;
    email: string;
    date: string;
    note: string;
    ref: string;
    subject: string;
    key: string;
    origin: "asana" | "gmail";
  };
  const parsed: Row[] = [];
  for (let i = 1; i < rows.length; i++) {
    const ref = (rows[i][refI] || "").trim();
    let origin: "asana" | "gmail" | null = null;
    if (ref.startsWith("asana:")) origin = "asana";
    else if (ref.startsWith("gmail")) origin = "gmail";
    if (!origin) continue;
    const note = rows[i][noteI] || "";
    const subject = note.split(/\s·\sPortCo:/i)[0] || note;
    const key = normalizeSubjectKey(subject);
    parsed.push({
      sheetRow: i + 1,
      email: (rows[i][emailI] || "").trim().toLowerCase(),
      date: ((tsI >= 0 ? rows[i][tsI] : "") || "").trim().slice(0, 10),
      note,
      ref,
      subject,
      key,
      origin,
    });
  }

  const asana = parsed.filter((p) => p.origin === "asana");
  const gmail = parsed.filter((p) => p.origin === "gmail");
  console.log(`Notes with Source Ref: asana=${asana.length} gmail=${gmail.length}`);

  const asanaByEmail = new Map<string, Row[]>();
  for (const a of asana) {
    if (!a.email || a.key.length < 6) continue;
    const list = asanaByEmail.get(a.email) || [];
    list.push(a);
    asanaByEmail.set(a.email, list);
  }

  const toDelete = new Set<number>();
  const report: string[] = [];
  for (const g of gmail) {
    if (!g.email || g.key.length < 6) continue;
    const candidates = asanaByEmail.get(g.email) || [];
    const gd = dayNum(g.date);
    const hit = candidates.find((a) => {
      if (a.key !== g.key) return false;
      const ad = dayNum(a.date);
      if (ad === null || gd === null) return true;
      return Math.abs(ad - gd) <= 3;
    });
    if (!hit) continue;
    toDelete.add(g.sheetRow);
    report.push(
      `DEL gmail row ${g.sheetRow} (keep asana row ${hit.sheetRow}) · ${g.email} · "${g.subject.slice(0, 70)}" · ${g.date || "?"} vs ${hit.date || "?"}`,
    );
  }

  console.log(`Gmail twins of Asana (same contact + subject ±3d): ${toDelete.size}`);
  for (const line of report.slice(0, 40)) console.log(`  ${line}`);
  if (report.length > 40) console.log(`  … +${report.length - 40} more`);

  if (!apply) {
    console.log("\nDry-run only. Re-run with --apply to delete Gmail twin Notes (Asana kept).");
    return;
  }
  if (toDelete.size === 0) {
    console.log("Nothing to delete.");
    return;
  }
  const deleted = await deleteSheetRows(TAB_NAMES.interactions, [...toDelete]);
  console.log(`\nDeleted ${deleted} Gmail duplicate Note row(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
