// Count duplicate values in Contacts column A (Name).
// Run: npx tsx scripts/count-contact-name-dupes.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchSheetTab, TAB_NAMES } from "../src/utils/sheets.server";

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

async function main() {
  const rows = await fetchSheetTab(TAB_NAMES.contacts);
  if (rows.length < 2) {
    console.log("No contact rows found.");
    return;
  }
  const header = (rows[0][0] || "").trim() || "Column A";
  const counts = new Map<string, { display: string; rows: number[] }>();

  for (let i = 1; i < rows.length; i++) {
    const raw = (rows[i][0] || "").trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    const cur = counts.get(key);
    if (cur) cur.rows.push(i + 1);
    else counts.set(key, { display: raw, rows: [i + 1] });
  }

  const dupes = [...counts.values()]
    .filter((c) => c.rows.length > 1)
    .sort((a, b) => b.rows.length - a.rows.length || a.display.localeCompare(b.display));

  const filled = [...counts.values()].reduce((n, c) => n + c.rows.length, 0);
  const unique = counts.size;
  const extraRows = dupes.reduce((n, c) => n + (c.rows.length - 1), 0);

  console.log(`Contacts tab — column A ("${header}")`);
  console.log(`  Non-empty rows: ${filled}`);
  console.log(`  Unique names:   ${unique}`);
  console.log(`  Names with dupes: ${dupes.length}`);
  console.log(`  Extra duplicate rows: ${extraRows}`);
  console.log("");

  if (dupes.length === 0) {
    console.log("No duplicate names in column A.");
    return;
  }

  console.log("Duplicate names (count · sheet rows):");
  for (const d of dupes.slice(0, 80)) {
    console.log(`  ${d.rows.length}×  ${d.display}  → rows ${d.rows.join(", ")}`);
  }
  if (dupes.length > 80) console.log(`  … and ${dupes.length - 80} more`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
