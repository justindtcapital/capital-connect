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

// Append the initial row (status = received). Best-effort: never throws.
export async function logReceived(r: LogRecord): Promise<void> {
  try {
    await ensureTab(TAB_NAMES.llmLog, LLM_QUERY_LOG_HEADERS);
    await appendSheetRow(TAB_NAMES.llmLog, rowFromLog(r));
  } catch (e) {
    console.error("[llm-log] logReceived failed:", e);
  }
}

// Finalize/update the row in place by query_id (append if not found).
export async function logUpdate(r: LogRecord): Promise<void> {
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
    if (rowNumber > 0) await writeSheetRow(TAB_NAMES.llmLog, rowNumber, rowFromLog(r));
    else await appendSheetRow(TAB_NAMES.llmLog, rowFromLog(r));
  } catch (e) {
    console.error("[llm-log] logUpdate failed:", e);
  }
}
