// Audit log for the LLM Query Tab (§5). Write-on-receipt, finalize-in-place,
// keyed by query_id. List-valued fields are JSON strings. Confidential content
// is never logged verbatim — redactions are recorded as events (§8).
import {
  ensureTab,
  appendSheetRow,
  writeSheetRow,
  fetchSheetTab,
  TAB_NAMES,
  LLM_QUERY_LOG_HEADERS,
} from "./sheets.server";

export interface LogRecord {
  query_id: string;
  session_id: string;
  user: string;
  timestamp_received: string;
  timestamp_completed?: string;
  latency_ms?: number;
  input_text: string;
  attachments?: unknown[];
  clarification?: unknown[];
  tools_called?: unknown[];
  sources?: unknown[];
  output_text?: string;
  output_artifacts?: unknown[];
  model: string;
  token_usage?: { input_tokens: number; output_tokens: number };
  status: "received" | "clarifying" | "running" | "complete" | "error" | "declined";
  review_required?: boolean;
  approved_by?: string;
  approved_at?: string;
  error_detail?: string;
}

const j = (v: unknown) => (v == null ? "" : JSON.stringify(v));

function rowFromLog(r: LogRecord): string[] {
  return [
    r.query_id,
    r.session_id,
    r.user,
    r.timestamp_received,
    r.timestamp_completed || "",
    r.latency_ms != null ? String(r.latency_ms) : "",
    r.input_text,
    j(r.attachments || []),
    j(r.clarification || []),
    j(r.tools_called || []),
    j(r.sources || []),
    r.output_text || "",
    j(r.output_artifacts || []),
    r.model,
    j(r.token_usage || null),
    r.status,
    r.review_required ? "TRUE" : "FALSE",
    r.approved_by || "",
    r.approved_at || "",
    r.error_detail || "",
  ];
}

// ── Write serialization + row cache ──────────────────────────────
// All log writes for this server process run one-at-a-time, and each query_id's
// sheet row number is remembered after the first write. Together these stop the
// duplicate-row race where a finalize re-reads the tab before its own append is
// visible (or two finalizes interleave) and appends a second row for the query.
let logChain: Promise<void> = Promise.resolve();
function serialized(fn: () => Promise<void>): Promise<void> {
  const next = logChain.then(fn, fn);
  logChain = next.catch(() => {});
  return next;
}

const MAX_CACHED_ROWS = 500;
const rowNumberByQueryId = new Map<string, number>();
function cacheRowNumber(queryId: string, rowNumber: number): void {
  if (rowNumberByQueryId.size >= MAX_CACHED_ROWS) {
    const oldest = rowNumberByQueryId.keys().next().value;
    if (oldest !== undefined) rowNumberByQueryId.delete(oldest);
  }
  rowNumberByQueryId.set(queryId, rowNumber);
}

// Append the initial row (status = received). Best-effort: never throws.
export async function logReceived(r: LogRecord): Promise<void> {
  return serialized(async () => {
    try {
      await ensureTab(TAB_NAMES.llmLog, LLM_QUERY_LOG_HEADERS);
      // Read current length first so the appended row's number can be cached.
      let rowNumber = 0;
      try {
        rowNumber = (await fetchSheetTab(TAB_NAMES.llmLog)).length + 1;
      } catch {
        /* cache miss is fine — logUpdate falls back to scanning */
      }
      await appendSheetRow(TAB_NAMES.llmLog, rowFromLog(r));
      if (rowNumber > 1) cacheRowNumber(r.query_id, rowNumber);
    } catch (e) {
      console.error("[llm-log] logReceived failed:", e);
    }
  });
}

// Finalize/update the row in place by query_id. Falls back to the cached row
// number when the scan misses (append not yet visible); appends only when the
// query has never been written by this process.
export async function logUpdate(r: LogRecord): Promise<void> {
  return serialized(async () => {
    try {
      await ensureTab(TAB_NAMES.llmLog, LLM_QUERY_LOG_HEADERS);
      const rows = await fetchSheetTab(TAB_NAMES.llmLog);
      const headers = (rows[0] || []).map((h) => h.trim().toLowerCase());
      const idIdx = headers.indexOf("query_id");
      let rowNumber = -1;
      if (idIdx !== -1) {
        for (let i = 1; i < rows.length; i++) {
          if ((rows[i][idIdx] || "").trim() === r.query_id) { rowNumber = i + 1; break; }
        }
      }
      if (rowNumber === -1) rowNumber = rowNumberByQueryId.get(r.query_id) ?? -1;
      if (rowNumber > 0) {
        await writeSheetRow(TAB_NAMES.llmLog, rowNumber, rowFromLog(r));
      } else {
        await appendSheetRow(TAB_NAMES.llmLog, rowFromLog(r));
        rowNumber = rows.length + 1;
      }
      cacheRowNumber(r.query_id, rowNumber);
    } catch (e) {
      console.error("[llm-log] logUpdate failed:", e);
    }
  });
}

function parseJson<T>(raw: string, fallback: T): T {
  if (!raw || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function logFromRow(headers: string[], row: string[]): LogRecord | null {
  const g = (name: string) => {
    const i = headers.indexOf(name);
    return i >= 0 ? (row[i] || "").trim() : "";
  };
  const query_id = g("query_id");
  if (!query_id) return null;
  const status = (g("status") || "complete") as LogRecord["status"];
  const tokens = parseJson<{ input_tokens?: number; output_tokens?: number } | null>(
    g("token_usage_json"),
    null,
  );
  return {
    query_id,
    session_id: g("session_id"),
    user: g("user"),
    timestamp_received: g("timestamp_received"),
    timestamp_completed: g("timestamp_completed") || undefined,
    latency_ms: g("latency_ms") ? Number(g("latency_ms")) : undefined,
    input_text: g("input_text"),
    attachments: parseJson(g("attachments_json"), []),
    clarification: parseJson(g("clarification_json"), []),
    tools_called: parseJson(g("tools_called_json"), []),
    sources: parseJson(g("sources_json"), []),
    output_text: g("output_text") || undefined,
    output_artifacts: parseJson(g("output_artifacts_json"), []),
    model: g("model"),
    token_usage: tokens
      ? { input_tokens: tokens.input_tokens || 0, output_tokens: tokens.output_tokens || 0 }
      : undefined,
    status,
    review_required: g("review_required").toUpperCase() === "TRUE",
    approved_by: g("approved_by") || undefined,
    approved_at: g("approved_at") || undefined,
    error_detail: g("error_detail") || undefined,
  };
}

/** Chronological log rows for a session (oldest → newest). */
export async function fetchLogsForSession(sessionId: string): Promise<LogRecord[]> {
  const sid = sessionId.trim();
  if (!sid) return [];
  try {
    const rows = await fetchSheetTab(TAB_NAMES.llmLog);
    if (rows.length < 2) return [];
    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const sidIdx = headers.indexOf("session_id");
    if (sidIdx < 0) return [];
    const out: LogRecord[] = [];
    for (const row of rows.slice(1)) {
      if ((row[sidIdx] || "").trim() !== sid) continue;
      const rec = logFromRow(headers, row);
      if (rec) out.push(rec);
    }
    out.sort((a, b) =>
      (a.timestamp_received || "").localeCompare(b.timestamp_received || ""),
    );
    return out;
  } catch (e) {
    console.error("[llm-log] fetchLogsForSession failed:", e);
    return [];
  }
}
