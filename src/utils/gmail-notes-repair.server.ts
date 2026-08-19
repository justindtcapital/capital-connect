// One-time repair of Gmail-sourced Notes rows:
//   1) Thread dedupe — group by audit "thread <id>", keep newest, delete rest,
//      rewrite Source Ref to the stable gmail-${threadId} gid.
//   2) Body backfill — rewrite Note Content for chrome-only rows.
//
// Safe to re-run: already-deduped / already-bodied rows are skipped.

import { emailBodyExcerpt } from "../lib/email-excerpt";
import { isEmailChromeText, sanitizeEmailText } from "@/lib/email-body-clean";
import { threadIdFromNotes } from "@/lib/activity-canonical";
import { fetchGmailMessageById, NOTES_BUDGET } from "./gmail.server";
import {
  TAB_NAMES,
  colLetters,
  deleteSheetRows,
  fetchSheetTab,
  logOpsEvent,
  updateSheetCells,
} from "./sheets.server";

export interface RepairGmailNotesResult {
  ok: boolean;
  error?: string;
  /** Notes rows whose Source Ref points at a Gmail message/thread. */
  scanned: number;
  /** Rows that looked like the bad (no real body) shape. */
  candidates: number;
  /** Cells actually rewritten (body). */
  repaired: number;
  /** Messages that could no longer be fetched (deleted / no access). */
  unresolved: number;
  /** Rows already fine or with nothing substantive to add. */
  skipped: number;
  /** Duplicate thread rows removed. */
  deduped: number;
  /** Source Ref cells rewritten to gmail-${threadId}. */
  refsUpdated: number;
  /** Sample of repaired rows, for the UI. */
  samples: string[];
}

// Lines we keep verbatim when rebuilding a note (machine-readable joins + audit).
const KEEP_LINE =
  /^(inbound email|outbound email|people:|gmail:|email:|meeting:|from:\s|subject:)/i;

/** Gmail message id from a Notes "Source Ref" value, or "" when not Gmail. */
export function gmailIdFromSourceRef(ref: string): string {
  const r = (ref || "").trim();
  if (!r) return "";
  if (r.startsWith("gmail-crm-")) return r.slice("gmail-crm-".length);
  if (r.startsWith("gmail-")) return r.slice("gmail-".length);
  if (r.startsWith("gmail:")) return r.slice("gmail:".length).trim();
  return "";
}

/** Message id from the Gmail: permalink audit line (works when Source Ref is a thread id). */
export function gmailMessageIdFromNote(note: string): string {
  const m = (note || "").match(/#(?:all|inbox|sent|important|starred|search\/[^/\s]+)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : "";
}

/**
 * True when a note has no real message text: only the header/audit scaffold, or
 * a body that is nothing but email chrome.
 */
export function needsBodyRepair(note: string): boolean {
  const lines = (note || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const body = lines.filter((l) => !KEEP_LINE.test(l));
  if (body.length === 0) return true;
  const text = body.join(" ");
  return text.length < 40 || isEmailChromeText(text);
}

/** Rebuild the note: keep the scaffold lines, append the real message text. */
export function rebuildNote(existing: string, body: string, snippet: string): string {
  const kept = (existing || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && KEEP_LINE.test(l));
  const fixed = kept.join("\n");
  const remaining = NOTES_BUDGET - fixed.length - 1;
  if (remaining < 40) return existing;
  const excerpt =
    emailBodyExcerpt(body, remaining) ||
    (isEmailChromeText(snippet) ? "" : sanitizeEmailText(snippet).trim());
  if (!excerpt) return existing;
  return fixed ? `${fixed}\n${excerpt.slice(0, remaining)}` : excerpt.slice(0, NOTES_BUDGET);
}

/**
 * Pure planner: given Notes rows (0-based data index + fields), decide which
 * sheet row numbers to delete and which Source Refs to rewrite to the thread gid.
 * Exported for unit tests.
 */
export function planThreadDedupe(
  rows: { sheetRow: number; email: string; date: string; note: string; ref: string }[],
): { deleteRows: number[]; refUpdates: { sheetRow: number; value: string }[] } {
  const byThread = new Map<string, typeof rows>();
  for (const r of rows) {
    const tid = threadIdFromNotes(r.note);
    if (!tid) continue;
    // Key by contact+thread so two contacts sharing a thread keep their own row.
    const key = `${(r.email || "").toLowerCase()}|${tid}`;
    const list = byThread.get(key);
    if (list) list.push(r);
    else byThread.set(key, [r]);
  }

  const deleteRows: number[] = [];
  const refUpdates: { sheetRow: number; value: string }[] = [];

  for (const [key, group] of byThread) {
    const tid = key.split("|").slice(1).join("|");
    const stableRef = `gmail-${tid}`;
    // Newest by ISO date, then highest sheet row as tie-break.
    const ordered = [...group].sort((a, b) => {
      const d = (b.date || "").localeCompare(a.date || "");
      return d !== 0 ? d : b.sheetRow - a.sheetRow;
    });
    const keep = ordered[0];
    for (const dup of ordered.slice(1)) deleteRows.push(dup.sheetRow);
    if ((keep.ref || "").trim() !== stableRef) {
      refUpdates.push({ sheetRow: keep.sheetRow, value: stableRef });
    }
  }
  return { deleteRows, refUpdates };
}

/**
 * Scan the Notes tab: collapse per-thread duplicates, then overwrite bad Gmail
 * notes with the real message text. Safe to re-run.
 */
export async function repairGmailNotes(
  opts: { limit?: number; dryRun?: boolean } = {},
): Promise<RepairGmailNotesResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 400, 1000));
  const result: RepairGmailNotesResult = {
    ok: true,
    scanned: 0,
    candidates: 0,
    repaired: 0,
    unresolved: 0,
    skipped: 0,
    deduped: 0,
    refsUpdated: 0,
    samples: [],
  };

  let rows: string[][];
  try {
    rows = await fetchSheetTab(TAB_NAMES.interactions);
  } catch (e) {
    return { ...result, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const headers = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const noteIdx = headers.indexOf("note content");
  const refIdx = headers.indexOf("source ref");
  const emailIdx = headers.indexOf("contact email");
  const dateIdx = headers.indexOf("timestamp");
  if (noteIdx === -1 || refIdx === -1) {
    return { ...result, ok: false, error: "Notes tab is missing Note Content / Source Ref columns" };
  }

  // ── Phase 1: thread dedupe ───────────────────────────────────────────
  const gmailRows: {
    sheetRow: number;
    email: string;
    date: string;
    note: string;
    ref: string;
  }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const ref = row[refIdx] || "";
    if (!gmailIdFromSourceRef(ref)) continue;
    result.scanned++;
    gmailRows.push({
      sheetRow: i + 1,
      email: emailIdx >= 0 ? row[emailIdx] || "" : "",
      date: dateIdx >= 0 ? row[dateIdx] || "" : "",
      note: row[noteIdx] || "",
      ref,
    });
  }

  const plan = planThreadDedupe(gmailRows);
  if (!opts.dryRun) {
    try {
      if (plan.refUpdates.length > 0) {
        await updateSheetCells(
          TAB_NAMES.interactions,
          plan.refUpdates.map((u) => ({
            range: `${colLetters(refIdx)}${u.sheetRow}`,
            value: u.value,
          })),
        );
        result.refsUpdated = plan.refUpdates.length;
      }
      if (plan.deleteRows.length > 0) {
        result.deduped = await deleteSheetRows(TAB_NAMES.interactions, plan.deleteRows);
        // Re-fetch after deletes so body-repair indices stay valid.
        rows = await fetchSheetTab(TAB_NAMES.interactions);
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await logOpsEvent({
        action: "maintenance",
        source: "Gmail notes backfill",
        status: "error",
        summary: `Gmail thread dedupe failed: ${error}`,
      });
      return { ...result, ok: false, error };
    }
  } else {
    result.deduped = plan.deleteRows.length;
    result.refsUpdated = plan.refUpdates.length;
  }

  // ── Phase 2: body repair ─────────────────────────────────────────────
  const headers2 = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const noteIdx2 = headers2.indexOf("note content");
  const refIdx2 = headers2.indexOf("source ref");
  if (noteIdx2 === -1 || refIdx2 === -1) {
    return { ...result, ok: false, error: "Notes tab is missing Note Content / Source Ref columns" };
  }

  const updates: { range: string; value: string }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const ref = row[refIdx2] || "";
    const note = row[noteIdx2] || "";
    if (!gmailIdFromSourceRef(ref)) continue;
    // Prefer permalink message id (Source Ref may now be a thread id).
    const msgId = gmailMessageIdFromNote(note) || gmailIdFromSourceRef(ref);
    if (!msgId) {
      result.skipped++;
      continue;
    }
    if (!needsBodyRepair(note)) {
      result.skipped++;
      continue;
    }
    result.candidates++;
    if (updates.length >= limit) continue;

    const msg = await fetchGmailMessageById(msgId);
    if (!msg) {
      result.unresolved++;
      continue;
    }
    const next = rebuildNote(note, msg.body, msg.snippet);
    if (!next || next === note) {
      result.skipped++;
      continue;
    }
    // Sheet rows are 1-based and row 1 is the header.
    updates.push({ range: `${colLetters(noteIdx2)}${i + 1}`, value: next });
    if (result.samples.length < 20) {
      result.samples.push(`${msg.dateLabel || ""} ${msg.subject}`.trim());
    }
  }

  if (!opts.dryRun && updates.length > 0) {
    try {
      // Batch in chunks so one huge backfill stays within request limits.
      for (let i = 0; i < updates.length; i += 200) {
        await updateSheetCells(TAB_NAMES.interactions, updates.slice(i, i + 200));
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await logOpsEvent({
        action: "maintenance",
        source: "Gmail notes backfill",
        status: "error",
        summary: `Gmail note repair failed: ${error}`,
      });
      return { ...result, ok: false, error };
    }
  }
  result.repaired = opts.dryRun ? 0 : updates.length;

  await logOpsEvent({
    action: "maintenance",
    source: "Gmail notes backfill",
    status: "ok",
    summary: opts.dryRun
      ? `Dry run: ${result.deduped} duplicate thread rows, ${result.candidates} notes missing message text`
      : `Deduped ${result.deduped} thread rows · rewrote ${result.repaired} Gmail notes with the real message text`,
    records: result.repaired + result.deduped,
    details: {
      scanned: result.scanned,
      candidates: result.candidates,
      unresolved: result.unresolved,
      skipped: result.skipped,
      deduped: result.deduped,
      refsUpdated: result.refsUpdated,
      dryRun: opts.dryRun ? "true" : "false",
    },
    items: result.samples,
  });

  return result;
}
