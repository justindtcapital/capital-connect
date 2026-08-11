// Signals retention prune — holds the Signals tab to a rolling window (default
// 365d) so the hot read path stays fast. Archive mode copies stale rows to the
// "Signals Archive" tab (same SIGNAL_HEADERS, full Body preserved) BEFORE
// deleting them from the hot tab; delete mode removes them outright.
//
// Server-only: called nightly from runSignalsReconcile (Pass F) and on demand
// via the pruneSignals server fn in gemini.functions.ts.

import {
  fetchSheetTab,
  appendSheetRows,
  deleteSheetRows,
  ensureTab,
  ensureHeaderWidth,
  logOpsEvent,
  TAB_NAMES,
  SIGNAL_HEADERS,
} from "./sheets.server";

export interface PruneSignalsOptions {
  retentionDays?: number;
  mode?: "archive" | "delete";
  pruneUndated?: boolean;
}

export interface PruneSignalsResult {
  /** Non-empty data rows examined. */
  scanned: number;
  /** Rows copied to the Signals Archive tab (0 in delete mode). */
  archived: number;
  /** Rows physically removed from the Signals tab. */
  deleted: number;
  /** Retention cutoff (YYYY-MM-DD); rows dated before this are stale. */
  cutoff: string;
}

// A row is stale when "Date Found" is a valid YYYY-MM-DD strictly before the
// cutoff. Blank/invalid dates are NOT stale by default (safe); pruneUndated
// flips that so undated rows are pruned too.
function signalIsStale(dateFound: string, cutoff: string, pruneUndated: boolean): boolean {
  const d = (dateFound || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return pruneUndated;
  return d < cutoff;
}

// Prune stale rows from the Signals tab to a rolling retention window.
// Deletion is bottom-up (handled by deleteSheetRows) so earlier deletes don't
// shift later sheet indices. Idempotent: a re-run after a successful prune finds
// nothing new (fetchSignals then returns only within-window rows).
export async function runSignalsPrune(opts: PruneSignalsOptions = {}): Promise<PruneSignalsResult> {
  const retentionDays =
    opts.retentionDays && opts.retentionDays > 0
      ? Math.floor(opts.retentionDays)
      : Number(process.env.SIGNALS_RETENTION_DAYS) || 365;
  const mode: "archive" | "delete" = opts.mode === "delete" ? "delete" : "archive";
  const pruneUndated = !!opts.pruneUndated;

  // Cutoff = today − retentionDays (UTC, YYYY-MM-DD), matching how "Date Found"
  // is written (new Date().toISOString().split("T")[0]).
  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - retentionDays);
  const cutoff = cutoffDate.toISOString().split("T")[0];

  let rows: string[][] = [];
  try {
    rows = await fetchSheetTab(TAB_NAMES.signals);
  } catch {
    return { scanned: 0, archived: 0, deleted: 0, cutoff };
  }
  if (rows.length === 0) return { scanned: 0, archived: 0, deleted: 0, cutoff };

  // Same header detection as fetchStoredSignals so the data-row → sheet-row
  // offset (for deleteDimension) stays correct.
  const isHeader = (r: string[]) =>
    (r[0] || "").trim().toLowerCase() === "id" && (r[2] || "").trim().toLowerCase() === "type";
  const startIdx = isHeader(rows[0]) ? 1 : 0;

  const staleRows: string[][] = [];
  const staleSheetRows: number[] = [];
  let scanned = 0;
  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => (c || "").trim() === "")) continue; // skip blank rows
    scanned++;
    const sheetRow = i + 1; // 1-based sheet row
    if (sheetRow < 2) continue; // never touch row 1 — keeps archive & delete in sync
    // "Date Found" is column index 1 in SIGNAL_HEADERS.
    if (signalIsStale((row[1] || "").trim(), cutoff, pruneUndated)) {
      staleRows.push(row);
      staleSheetRows.push(sheetRow);
    }
  }

  if (staleRows.length === 0) {
    return { scanned, archived: 0, deleted: 0, cutoff };
  }

  // Archive first (history survives), THEN delete from the hot tab.
  let archived = 0;
  if (mode === "archive") {
    await ensureTab(TAB_NAMES.signalsArchive, SIGNAL_HEADERS);
    // Widen a pre-v2 archive tab so archived rows keep header cells for the
    // event/score columns.
    await ensureHeaderWidth(TAB_NAMES.signalsArchive, SIGNAL_HEADERS);
    await appendSheetRows(TAB_NAMES.signalsArchive, staleRows);
    archived = staleRows.length;
  }
  const deleted = await deleteSheetRows(TAB_NAMES.signals, staleSheetRows);

  await logOpsEvent({
    action: "prune",
    source: "signals_retention",
    status: "ok",
    summary: `Pruned ${deleted} signal${deleted === 1 ? "" : "s"} older than ${cutoff} (${retentionDays}d · ${mode})`,
    records: deleted,
    details: { retentionDays, mode, cutoff, scanned, archived, pruneUndated },
  });

  return { scanned, archived, deleted, cutoff };
}
