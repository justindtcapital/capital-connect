import { createServerFn } from "@tanstack/react-start";
import { buildCustomerDiscovery, type DiscoveryResult } from "./sumble.server";
import {
  fetchSheetTab,
  ensureTab,
  appendSheetRow,
  writeSheetRow,
  TAB_NAMES,
  CUSTOMER_DISCOVERY_HEADERS,
} from "./sheets.server";

// ── Sheet cache for Customer Discovery runs ──────────────────────
// A discovery run costs Sumble credits + Claude tokens, so results are cached to
// the "Customer Discovery" tab keyed by portfolio company name. Reopening a
// company reads from the sheet (no spend); "Refresh" forces a live re-run.
// The full DiscoveryResult is stored as JSON in the "Data" column.

const normKey = (name: string) => name.trim().toLowerCase();

function rowFromResult(name: string, r: DiscoveryResult): string[] {
  return [
    name,
    r.generatedAt || "",
    String(r.opportunities.length),
    r.usedClaude ? "yes" : "no",
    r.credits?.remaining != null ? String(r.credits.remaining) : "",
    JSON.stringify(r),
  ];
}

async function readCache(name: string): Promise<{ record: DiscoveryResult; rowNumber: number } | null> {
  let rows: string[][];
  try {
    rows = await fetchSheetTab(TAB_NAMES.customerDiscovery);
  } catch {
    return null; // tab doesn't exist yet
  }
  if (rows.length < 2) return null;
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const companyIdx = headers.indexOf("portfolio company");
  const dataIdx = headers.indexOf("data");
  if (companyIdx === -1 || dataIdx === -1) return null;

  const target = normKey(name);
  for (let i = 1; i < rows.length; i++) {
    if (normKey(rows[i][companyIdx] || "") !== target) continue;
    try {
      const record = JSON.parse(rows[i][dataIdx] || "{}") as DiscoveryResult;
      if (!Array.isArray(record.opportunities)) record.opportunities = [];
      return { record, rowNumber: i + 1 };
    } catch {
      return null; // corrupt JSON — treat as a miss so we re-run
    }
  }
  return null;
}

async function upsertCache(name: string, record: DiscoveryResult): Promise<void> {
  await ensureTab(TAB_NAMES.customerDiscovery, CUSTOMER_DISCOVERY_HEADERS);
  const existing = await readCache(name);
  const row = rowFromResult(name, record);
  if (existing) {
    await writeSheetRow(TAB_NAMES.customerDiscovery, existing.rowNumber, row);
  } else {
    await appendSheetRow(TAB_NAMES.customerDiscovery, row);
  }
}

// Find likely CUSTOMERS for a portfolio company. Served from the sheet cache
// unless `force` is set (Refresh), in which case it re-runs the engine.
export const discoverCustomers = createServerFn({ method: "POST" })
  .inputValidator((data: {
    name: string;
    sector?: string;
    description?: string;
    website?: string;
    force?: boolean;
    /** User-typed technologies — when present, runs a live tech-specific search. */
    technologies?: string[];
  }) => data)
  .handler(async ({ data }): Promise<DiscoveryResult> => {
    if (!data.name?.trim()) {
      return { found: false, error: "A portfolio company is required.", seller: "", opportunities: [], usedClaude: false };
    }
    // A user-typed technology search always runs live and is NOT cached under the
    // company key (it's a one-off, not the company's default discovery profile).
    const customTech = (data.technologies || []).map((t) => t.trim()).filter(Boolean);
    const useCustomTech = customTech.length > 0;

    try {
      // 1. Serve from cache unless a refresh / custom-tech search was requested.
      if (!data.force && !useCustomTech) {
        const cached = await readCache(data.name);
        if (cached) return { ...cached.record, cached: true };
      }

      // 2. Live run.
      const res = await buildCustomerDiscovery({
        companyName: data.name,
        sector: data.sector,
        description: data.description,
        website: data.website,
        technologies: useCustomTech ? customTech : undefined,
      });

      // 3. Cache successful runs (don't cache config errors / hard failures, or
      //    one-off custom-tech searches).
      if (res.found && !useCustomTech) {
        try {
          await upsertCache(data.name, res);
        } catch (e) {
          console.error("[discovery] cache write failed:", e); // non-fatal
        }
      }
      return { ...res, cached: false };
    } catch (err) {
      console.error("[discovery] discoverCustomers failed:", err);
      return {
        found: false,
        error: err instanceof Error ? err.message : "Customer discovery failed",
        seller: data.name,
        opportunities: [],
        usedClaude: false,
      };
    }
  });
