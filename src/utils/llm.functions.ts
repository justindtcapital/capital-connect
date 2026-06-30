import { createServerFn } from "@tanstack/react-start";
import { randomUUID, createHash } from "node:crypto";
import {
  runAgent,
  resumeAgent,
  emptyProvenance,
  LLM_MODEL,
  type AgentState,
  type AgentOutcome,
  type JsonValue,
} from "./llm.server";
import type { GeminiPart } from "./gemini.server";
import { logReceived, logUpdate, type LogRecord } from "./llm-log.server";

// ── Attachments ──────────────────────────────────────────────────
// Sent INLINE as Gemini parts (inlineData) — never uploaded to Drive in this
// build. Confidential/restricted files are quarantined (hashed + logged, NOT sent
// to the model). Only metadata + hash are logged (§8).
export interface AttachmentInput {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** base64 (no data: prefix). */
  dataBase64: string;
  /** User-selected classification on upload. */
  level?: "public" | "internal" | "confidential" | "restricted";
}

const INLINE_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const INLINE_TEXT = new Set(["text/plain", "text/csv", "text/markdown"]);
const MAX_TEXT_CHARS = 20000;

interface ProcessedAttachments {
  blocks: GeminiPart[];
  audit: JsonValue[];
  sources: JsonValue[];
  blocked: number;
}

function processAttachments(items: AttachmentInput[]): ProcessedAttachments {
  const blocks: GeminiPart[] = [];
  const audit: JsonValue[] = [];
  const sources: JsonValue[] = [];
  let blocked = 0;

  for (const a of items) {
    let sha256 = "";
    try { sha256 = createHash("sha256").update(Buffer.from(a.dataBase64, "base64")).digest("hex"); } catch { /* */ }
    const level = a.level || "internal";
    const confidential = level === "confidential" || level === "restricted";
    let sent = false;
    let reason = "";

    if (confidential) {
      // Quarantine: do not send to the model.
      blocked++;
      reason = "confidential";
      sources.push({ type: "redaction", excluded_count: 1, level, ref: "attachment" });
    } else if (INLINE_IMAGE.has(a.mimeType) || a.mimeType === "application/pdf") {
      blocks.push({ inlineData: { mimeType: a.mimeType, data: a.dataBase64 } });
      sent = true;
    } else if (INLINE_TEXT.has(a.mimeType)) {
      let text = "";
      try { text = Buffer.from(a.dataBase64, "base64").toString("utf8").slice(0, MAX_TEXT_CHARS); } catch { /* */ }
      blocks.push({ text: `Attached file "${a.filename}":\n${text}` });
      sent = true;
    } else {
      reason = "unsupported_type";
    }

    // Log metadata + hash only — never content. drive_file_id empty (inline, Drive deferred).
    audit.push({ filename: a.filename, drive_file_id: "", mime_type: a.mimeType, size_bytes: a.sizeBytes, sha256, level, sent, reason });
  }
  return { blocks, audit, sources, blocked };
}

export interface QueryMeta {
  queryId: string;
  sessionId: string;
  user: string;
  inputText: string;
  timestampReceived: string;
}

export interface QueryResponse {
  meta: QueryMeta;
  outcome: AgentOutcome;
}

function statusFor(outcome: AgentOutcome): LogRecord["status"] {
  if (outcome.status === "complete") return "complete";
  if (outcome.status === "error") return "error";
  return outcome.pause.kind === "clarification" ? "clarifying" : "running";
}

async function finalize(meta: QueryMeta, outcome: AgentOutcome, approval?: { by?: string }): Promise<void> {
  const completed = new Date().toISOString();
  const prov = outcome.state.prov;
  await logUpdate({
    query_id: meta.queryId,
    session_id: meta.sessionId,
    user: meta.user,
    timestamp_received: meta.timestampReceived,
    timestamp_completed: outcome.status === "needs_input" ? "" : completed,
    latency_ms: outcome.status === "needs_input" ? undefined : Date.now() - Date.parse(meta.timestampReceived),
    input_text: meta.inputText,
    attachments: prov.attachments,
    clarification: prov.clarifications,
    tools_called: prov.tools,
    sources: prov.sources,
    output_text: outcome.status === "complete" ? outcome.answer : "",
    output_artifacts: prov.artifacts,
    model: LLM_MODEL,
    token_usage: { input_tokens: prov.tokensIn, output_tokens: prov.tokensOut },
    status: statusFor(outcome),
    review_required: prov.reviewRequired,
    approved_by: approval?.by,
    approved_at: approval?.by ? completed : undefined,
    error_detail: outcome.status === "error" ? outcome.error : undefined,
  });
}

// Submit a new query: logs on receipt, runs the agent loop, finalizes the log.
export const submitQuery = createServerFn({ method: "POST" })
  .inputValidator((data: {
    prompt: string;
    sessionId?: string;
    user?: string;
    attachments?: AttachmentInput[];
    /** Prior conversation turns (text only) so follow-ups keep context. */
    priorMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  }) => data)
  .handler(async ({ data }): Promise<QueryResponse> => {
    const meta: QueryMeta = {
      queryId: randomUUID(),
      sessionId: data.sessionId || randomUUID(),
      user: data.user || "tester",
      inputText: data.prompt,
      timestampReceived: new Date().toISOString(),
    };

    const att = processAttachments(data.attachments || []);
    await logReceived({
      query_id: meta.queryId, session_id: meta.sessionId, user: meta.user,
      timestamp_received: meta.timestampReceived, input_text: meta.inputText,
      attachments: att.audit, model: LLM_MODEL, status: "received",
    });

    // First user turn: prompt text + any allowed inline attachment parts.
    const firstParts: GeminiPart[] = [];
    if (data.prompt && data.prompt.trim()) firstParts.push({ text: data.prompt });
    firstParts.push(...att.blocks);
    if (firstParts.length === 0) firstParts.push({ text: "(no text — see attachment)" });
    // Prepend prior conversation (text-only) so follow-ups resolve references.
    // Gemini uses role "model" for the assistant.
    const prior = (data.priorMessages || []).filter((m) => m.content && m.content.trim());
    const state: AgentState = {
      messages: [
        ...prior.map((m) => ({ role: (m.role === "assistant" ? "model" : "user") as "user" | "model", parts: [{ text: m.content }] })),
        { role: "user" as const, parts: firstParts },
      ],
      prov: emptyProvenance(),
    };
    state.prov.attachments = att.audit;
    state.prov.sources.push(...att.sources);

    const outcome = await runAgent(state);
    await finalize(meta, outcome);
    return { meta, outcome };
  });

// Resume a paused query with a clarification answer or a write-approval decision.
export const resumeQuery = createServerFn({ method: "POST" })
  .inputValidator((data: {
    meta: QueryMeta;
    state: AgentState;
    toolUseId: string;
    resultText: string;
    approvedBy?: string;
  }) => data)
  .handler(async ({ data }): Promise<QueryResponse> => {
    // resumeAgent combines any stashed tool results with this answer/approval.
    const outcome = await resumeAgent(data.state, data.toolUseId, data.resultText);
    await finalize(data.meta, outcome, data.approvedBy ? { by: data.approvedBy } : undefined);
    return { meta: data.meta, outcome };
  });
