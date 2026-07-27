// Live seed: PortCos + Radar Watchlist + Targets → Intel Entities.
// Run from DTC_CRM_Local: npx tsx scripts/seed-intel-entities.ts

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
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (e) {
    console.error("Failed to load .env:", e);
    process.exit(1);
  }
}

loadEnv(resolve(process.cwd(), ".env"));

const { seedIntelEntities, loadIntelEntities } = await import(
  "../src/utils/intel.server"
);

const before = await loadIntelEntities();
console.log(`Before: ${before.length} entities`);
const byTier = (rows: typeof before) => {
  const m = new Map<string, number>();
  for (const e of rows) m.set(e.tier, (m.get(e.tier) || 0) + 1);
  return [...m.entries()].map(([t, n]) => `${t}=${n}`).join(", ");
};
console.log(`  tiers: ${byTier(before)}`);

const res = await seedIntelEntities();
console.log(`Seed result: added=${res.added} total=${res.total}`);

const after = await loadIntelEntities();
console.log(`After: ${after.length} entities`);
console.log(`  tiers: ${byTier(after)}`);
if (res.added > 0) {
  const names = after.slice(-Math.min(res.added, 25)).map((e) => `${e.name} [${e.tier}]`);
  console.log(`  sample new: ${names.join("; ")}`);
}
