import { createServerFn } from "@tanstack/react-start";
import { randomUUID, createHash } from "node:crypto";
import {
  runAgent,
  resumeAgent,
  emptyProvenance,
  LLM_MODEL,
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_STEPS,
  type AgentState,
  type AgentOutcome,
  type JsonValue,
  type Provenance,
} from "./llm.server";
import type { GeminiPart } from "./gemini.server";
import {
  logReceived,
  logUpdate,
  fetchLogsForSession,
  type LogRecord,
} from "./llm-log.server";
import {
  buildContacts,
  buildTargets,
  buildPortfolioCompanies,
  appendInteractionRows,
  appendTargetOutreach,
  ensureEventAttendanceBatch,
  primarySheetEmail,
  logOpsEvent,
} from "./sheets.server";
import { savePlatformContent } from "./platform.server";
import { targetKeyOf } from "@/lib/types";
import type { DiligenceDimension } from "@/lib/platform-content";
import {
  getQuerySession,
  saveQuerySession,
  setQueryProgress,
  clearQuerySession,
  type QueryMeta,
  type UiTurn,
  type QueryProgress,
} from "./query-session.server";
import { applyQueryWrite } from "./apply-query-write.server";

export type { QueryMeta, UiTurn, QueryProgress };

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
    try {
      sha256 = createHash("sha256").update(Buffer.from(a.dataBase64, "base64")).digest("hex");
    } catch {
      /* */
    }
    const level = a.level || "internal";
    const confidential = level === "confidential" || level === "restricted";
    let sent = false;
    let reason = "";

    if (confidential) {
      blocked++;
      reason = "confidential";
      sources.push({ type: "redaction", excluded_count: 1, level, ref: "attachment" });
    } else if (INLINE_IMAGE.has(a.mimeType) || a.mimeType === "application/pdf") {
      blocks.push({ inlineData: { mimeType: a.mimeType, data: a.dataBase64 } });
      sent = true;
    } else if (INLINE_TEXT.has(a.mimeType)) {
      let text = "";
      try {
        text = Buffer.from(a.dataBase64, "base64").toString("utf8").slice(0, MAX_TEXT_CHARS);
      } catch {
        /* */
      }
      blocks.push({ text: `Attached file "${a.filename}":\n${text}` });
      sent = true;
    } else {
      reason = "unsupported_type";
    }

    audit.push({
      filename: a.filename,
      drive_file_id: "",
      mime_type: a.mimeType,
      size_bytes: a.sizeBytes,
      sha256,
      level,
      sent,
      reason,
    });
  }
  return { blocks, audit, sources, blocked };
}

/** Client-facing outcome — never includes full Gemini message history. */
export type ClientOutcome =
  | { status: "complete"; answer: string; prov: Provenance; partial?: boolean }
  | {
      status: "needs_input";
      pause: {
        kind: "clarification" | "write_approval";
        toolUseId: string;
        name: string;
        input: JsonValue;
      };
      prov: Provenance;
    }
  | { status: "error"; error: string; prov: Provenance };

export interface QueryResponse {
  meta: QueryMeta;
  outcome: ClientOutcome;
  /** True when a write was applied server-side on this resume (client should invalidate). */
  wrote?: boolean;
}

export interface LoadQuerySessionResult {
  sessionId: string;
  turns: UiTurn[];
  /** Restored pending pause when the live AgentState is still in memory. */
  pending: QueryResponse | null;
  /** Live server session still holds Gemini state (approvals can resume). */
  alive: boolean;
  /** Last log row was mid-approval but memory session is gone. */
  pendingLost?: boolean;
}

function statusFor(outcome: AgentOutcome): LogRecord["status"] {
  if (outcome.status === "complete") return "complete";
  if (outcome.status === "error") return "error";
  return outcome.pause.kind === "clarification" ? "clarifying" : "running";
}

function toClient(outcome: AgentOutcome): ClientOutcome {
  if (outcome.status === "complete") {
    return {
      status: "complete",
      answer: outcome.answer,
      prov: outcome.state.prov,
      partial: outcome.partial,
    };
  }
  if (outcome.status === "error") {
    return { status: "error", error: outcome.error, prov: outcome.state.prov };
  }
  return {
    status: "needs_input",
    pause: outcome.pause,
    prov: outcome.state.prov,
  };
}

function assistantTurn(outcome: AgentOutcome): UiTurn | null {
  if (outcome.status === "complete") {
    return {
      role: "assistant",
      text: outcome.answer || "(no answer)",
      prov: {
        tools: outcome.state.prov.tools,
        sources: outcome.state.prov.sources,
        tokensIn: outcome.state.prov.tokensIn,
        tokensOut: outcome.state.prov.tokensOut,
      },
      artifacts: outcome.state.prov.artifacts,
      partial: outcome.partial,
    };
  }
  if (outcome.status === "error") {
    return { role: "assistant", text: `⚠️ ${outcome.error}` };
  }
  return null;
}

function turnsFromLogs(logs: LogRecord[]): UiTurn[] {
  const turns: UiTurn[] = [];
  for (const r of logs) {
    if (r.input_text?.trim()) {
      turns.push({ role: "user", text: r.input_text });
    }
    if (r.status === "error" && r.error_detail) {
      turns.push({ role: "assistant", text: `⚠️ ${r.error_detail}` });
    } else if (r.output_text?.trim()) {
      turns.push({
        role: "assistant",
        text: r.output_text,
        artifacts: (r.output_artifacts || []) as JsonValue[],
        prov: {
          tools: (r.tools_called || []) as JsonValue[],
          sources: (r.sources || []) as JsonValue[],
          tokensIn: r.token_usage?.input_tokens || 0,
          tokensOut: r.token_usage?.output_tokens || 0,
        },
      });
    }
  }
  return turns;
}

async function finalize(
  meta: QueryMeta,
  outcome: AgentOutcome,
  approval?: { by?: string; declined?: boolean },
): Promise<void> {
  const completed = new Date().toISOString();
  const prov = outcome.state.prov;
  const status = statusFor(outcome);
  await logUpdate({
    query_id: meta.queryId,
    session_id: meta.sessionId,
    user: meta.user,
    timestamp_received: meta.timestampReceived,
    timestamp_completed: outcome.status === "needs_input" ? "" : completed,
    latency_ms:
      outcome.status === "needs_input" ? undefined : Date.now() - Date.parse(meta.timestampReceived),
    input_text: meta.inputText,
    attachments: prov.attachments,
    clarification: prov.clarifications,
    tools_called: prov.tools,
    sources: prov.sources,
    output_text: outcome.status === "complete" ? outcome.answer : "",
    output_artifacts: prov.artifacts,
    model: LLM_MODEL,
    token_usage: { input_tokens: prov.tokensIn, output_tokens: prov.tokensOut },
    status: approval?.declined ? "declined" : status,
    review_required: prov.reviewRequired,
    approved_by: approval?.by,
    approved_at: approval?.by ? completed : undefined,
    error_detail: outcome.status === "error" ? outcome.error : undefined,
  });
}

function persistSession(
  meta: QueryMeta,
  outcome: AgentOutcome,
  turns: UiTurn[],
): void {
  saveQuerySession(meta.sessionId, {
    state: outcome.state,
    meta,
    pause: outcome.status === "needs_input" ? outcome.pause : undefined,
    turns,
    progress:
      outcome.status === "needs_input"
        ? {
            step: 0,
            maxSteps: MAX_STEPS,
            phase: "paused",
            message:
              outcome.pause.kind === "clarification"
                ? "Waiting for your answer…"
                : "Waiting for approval…",
            updatedAt: Date.now(),
          }
        : {
            step: MAX_STEPS,
            maxSteps: MAX_STEPS,
            phase: "done",
            message: "Done",
            updatedAt: Date.now(),
          },
  });
}

function agentOpts(sessionId: string) {
  return {
    deadlineAt: Date.now() + DEFAULT_AGENT_TIMEOUT_MS,
    onProgress: (p: {
      step: number;
      maxSteps: number;
      phase: QueryProgress["phase"];
      tool?: string;
      message: string;
    }) => {
      setQueryProgress(sessionId, { ...p, updatedAt: Date.now() });
    },
  };
}

// Submit a new query: logs on receipt, runs the agent loop, finalizes the log.
// AgentState stays on the server keyed by sessionId.
export const submitQuery = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      prompt: string;
      sessionId?: string;
      user?: string;
      attachments?: AttachmentInput[];
    }) => data,
  )
  .handler(async ({ data }): Promise<QueryResponse> => {
    const sessionId = data.sessionId || randomUUID();
    const existing = data.sessionId ? getQuerySession(data.sessionId) : undefined;

    const meta: QueryMeta = {
      queryId: randomUUID(),
      sessionId,
      user: data.user?.trim() || "unknown",
      inputText: data.prompt,
      timestampReceived: new Date().toISOString(),
    };

    const att = processAttachments(data.attachments || []);
    await logReceived({
      query_id: meta.queryId,
      session_id: meta.sessionId,
      user: meta.user,
      timestamp_received: meta.timestampReceived,
      input_text: meta.inputText,
      attachments: att.audit,
      model: LLM_MODEL,
      status: "received",
    });

    const firstParts: GeminiPart[] = [];
    if (data.prompt && data.prompt.trim()) firstParts.push({ text: data.prompt });
    firstParts.push(...att.blocks);
    if (firstParts.length === 0) firstParts.push({ text: "(no text — see attachment)" });

    let state: AgentState;
    const prevTurns = existing?.turns || [];
    if (existing?.state) {
      // Continue the same Gemini conversation (keeps tool results / grounding).
      state = existing.state;
      state.messages = [...state.messages, { role: "user", parts: firstParts }];
      const prevReview = state.prov.reviewRequired;
      state.prov = emptyProvenance();
      state.prov.reviewRequired = prevReview;
      state.prov.attachments = att.audit;
      state.prov.sources.push(...att.sources);
      state.pendingResults = undefined;
      state.pausedCall = undefined;
    } else {
      state = {
        messages: [{ role: "user", parts: firstParts }],
        prov: emptyProvenance(),
      };
      state.prov.attachments = att.audit;
      state.prov.sources.push(...att.sources);
    }

    const userTurn: UiTurn = {
      role: "user",
      text: data.prompt || "(attachment only)",
      attachments: (data.attachments || []).map((a) => a.filename),
    };
    // Seed session so progress polling works during the run.
    saveQuerySession(sessionId, {
      state,
      meta,
      turns: [...prevTurns, userTurn],
      progress: {
        step: 1,
        maxSteps: MAX_STEPS,
        phase: "thinking",
        message: "Thinking…",
        updatedAt: Date.now(),
      },
    });

    const outcome = await runAgent(state, {}, agentOpts(sessionId));
    const nextTurns = [...prevTurns, userTurn];
    const asst = assistantTurn(outcome);
    if (asst) nextTurns.push(asst);
    persistSession(meta, outcome, nextTurns);
    await finalize(meta, outcome);
    return { meta, outcome: toClient(outcome) };
  });

// Resume a paused query: clarification answer or write-approval decision.
// State is loaded from the server session — the client never sends AgentState.
export const resumeQuery = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      sessionId: string;
      queryId: string;
      toolUseId: string;
      /** clarification answer text, or unused when decision is set for writes */
      resultText?: string;
      decision?: "approved" | "declined";
      approvedBy?: string;
    }) => data,
  )
  .handler(async ({ data }): Promise<QueryResponse> => {
    const stored = getQuerySession(data.sessionId);
    if (!stored) {
      const meta: QueryMeta = {
        queryId: data.queryId,
        sessionId: data.sessionId,
        user: "unknown",
        inputText: "",
        timestampReceived: new Date().toISOString(),
      };
      return {
        meta,
        outcome: {
          status: "error",
          error: "Session expired — please ask again.",
          prov: emptyProvenance(),
        },
      };
    }

    const meta = { ...stored.meta, queryId: data.queryId || stored.meta.queryId };
    const pause = stored.pause;
    let resultText = data.resultText || "";
    let wrote = false;
    let declined = false;

    if (pause?.kind === "write_approval") {
      if (data.decision === "approved") {
        const applied = await applyQueryWrite(pause.name, pause.input);
        if (applied.ok) {
          resultText = applied.summary;
          wrote = true;
        } else {
          resultText = `Write failed for ${pause.name}: ${applied.error}`;
        }
      } else {
        declined = true;
        resultText = `User declined (${pause.name}).`;
      }
    } else if (!resultText.trim()) {
      resultText = "(no answer)";
    }

    const prevTurns = stored.turns || [];
    const resumeUserTurn: UiTurn | null =
      pause?.kind === "clarification"
        ? { role: "user", text: resultText }
        : pause?.kind === "write_approval"
          ? {
              role: "user",
              text: data.decision === "approved" ? "Approved write." : "Declined write.",
            }
          : null;
    const turnsDuring = resumeUserTurn ? [...prevTurns, resumeUserTurn] : [...prevTurns];
    saveQuerySession(data.sessionId, {
      ...stored,
      turns: turnsDuring,
      progress: {
        step: 1,
        maxSteps: MAX_STEPS,
        phase: "thinking",
        message: "Continuing…",
        updatedAt: Date.now(),
      },
    });

    const outcome = await resumeAgent(
      stored.state,
      data.toolUseId || pause?.toolUseId || "",
      resultText,
      {},
      agentOpts(data.sessionId),
    );
    const nextTurns = [...turnsDuring];
    const asst = assistantTurn(outcome);
    if (asst) nextTurns.push(asst);
    persistSession(meta, outcome, nextTurns);
    await finalize(meta, outcome, {
      by: data.decision === "approved" ? data.approvedBy || meta.user : undefined,
      declined,
    });
    return { meta, outcome: toClient(outcome), wrote };
  });

/** Restore chat + pending approval after refresh (memory first, then log). */
export const loadQuerySession = createServerFn({ method: "POST" })
  .inputValidator((data: { sessionId: string; user?: string }) => data)
  .handler(async ({ data }): Promise<LoadQuerySessionResult | null> => {
    const sessionId = (data.sessionId || "").trim();
    if (!sessionId) return null;

    const live = getQuerySession(sessionId);
    if (live) {
      const pending: QueryResponse | null =
        live.pause
          ? {
              meta: live.meta,
              outcome: {
                status: "needs_input",
                pause: live.pause,
                prov: live.state.prov,
              },
            }
          : null;
      return {
        sessionId,
        turns: live.turns || [],
        pending,
        alive: true,
      };
    }

    const logs = await fetchLogsForSession(sessionId);
    if (logs.length === 0) return null;
    if (data.user) {
      const u = data.user.trim().toLowerCase();
      if (logs.some((l) => (l.user || "").toLowerCase() === u) === false && u) {
        // Soft check — still allow if user field was "unknown"/tester historically.
      }
    }
    const turns = turnsFromLogs(logs);
    const last = logs[logs.length - 1];
    const pendingLost =
      !!last &&
      (last.status === "clarifying" || last.status === "running") &&
      !!last.review_required;
    return {
      sessionId,
      turns,
      pending: null,
      alive: false,
      pendingLost,
    };
  });

/** Coarse step progress while a query is running (polled by the UI). */
export const getQueryProgress = createServerFn({ method: "POST" })
  .inputValidator((data: { sessionId: string }) => data)
  .handler(async ({ data }): Promise<QueryProgress | null> => {
    const s = getQuerySession((data.sessionId || "").trim());
    return s?.progress || null;
  });

/** Drop the in-memory session (New chat). */
export const endQuerySession = createServerFn({ method: "POST" })
  .inputValidator((data: { sessionId?: string }) => data)
  .handler(async ({ data }) => {
    if (data.sessionId) clearQuerySession(data.sessionId);
    return { ok: true as const };
  });

// ── Artifact → CRM ───────────────────────────────────────────────
// Chat artifacts (drafts, invite lists, DNA scores) can be attached to real CRM
// records instead of dying with the conversation.

export type SaveArtifactResult =
  | { saved: true; savedTo: string }
  | { saved: false; error: string };

// Log an outreach draft against the recipient: a Notes trail entry when they're
// a CRM contact, a Target Outreach row when they're a pipeline target.
export const saveDraftToCrm = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { email: string; subject: string; body: string; user?: string }) => data,
  )
  .handler(async ({ data }): Promise<SaveArtifactResult> => {
    const email = data.email.trim().toLowerCase();
    if (!email) return { saved: false, error: "The draft has no recipient email" };
    const today = new Date().toISOString().split("T")[0];
    const summary = `Outreach draft (via Query) — ${data.subject}\n\n${data.body}`.slice(0, 1500);

    const contacts = await buildContacts();
    const contact = contacts.find((c) => (c.email || "").trim().toLowerCase() === email);
    if (contact) {
      await appendInteractionRows([
        {
          email: contact.email,
          date: today,
          summary,
          type: "email",
          requiresFollowUp: false,
          urid: contact.urid,
        },
      ]);
      return { saved: true, savedTo: `Notes — ${contact.name}` };
    }

    const targets = await buildTargets();
    const target = targets.find((t) => (t.email || "").trim().toLowerCase() === email);
    if (target) {
      await appendTargetOutreach(
        targetKeyOf({ email: target.email, name: target.name, company: target.company }),
        { id: randomUUID(), date: today, method: "Email Draft", summary },
        target.urid,
      );
      return { saved: true, savedTo: `Target Outreach — ${target.name}` };
    }
    return { saved: false, error: `No contact or target with email ${email}` };
  });

// Persist a Query DNA score to the Platform Content tab (same record type the
// /platform diligence flow writes), linked to the PortCo when the name matches.
export const saveScoreToCrm = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      company: string;
      score: { score?: number; dimensions?: unknown[]; rationale?: string };
      user?: string;
    }) => data,
  )
  .handler(async ({ data }): Promise<SaveArtifactResult> => {
    const company = data.company.trim();
    if (!company) return { saved: false, error: "No company on the score" };
    const dimensions: DiligenceDimension[] = Array.isArray(data.score.dimensions)
      ? data.score.dimensions
          .map((d) => {
            const dim = d as { name?: unknown; score?: unknown; note?: unknown };
            return {
              name: String(dim?.name ?? ""),
              score: Number(dim?.score ?? 0),
              note: String(dim?.note ?? ""),
            };
          })
          .filter((d) => d.name)
      : [];
    let portcoUrid = "";
    try {
      const portcos = await buildPortfolioCompanies();
      portcoUrid =
        portcos.find((p) => p.name.trim().toLowerCase() === company.toLowerCase())?.urid || "";
    } catch {
      /* not a portco — fine */
    }
    await savePlatformContent({
      type: "diligence",
      subject: company,
      portcoUrid,
      title: `DNA score — ${company} (via Query)`,
      payload: {
        score: Number(data.score.score ?? 0),
        dimensions,
        rationale: String(data.score.rationale ?? ""),
        questions: [],
        sources: [],
      },
      sources: [],
      generatedBy: data.user?.trim() || "unknown",
    });
    return { saved: true, savedTo: "Platform Content — Diligence" };
  });

// Tag every contact on an invite-list artifact as invited to a named event.
export const saveInviteListToCrm = createServerFn({ method: "POST" })
  .inputValidator((data: { eventName: string; emails: string[]; user?: string }) => data)
  .handler(async ({ data }): Promise<SaveArtifactResult> => {
    const eventName = data.eventName.trim();
    const emails = (data.emails || []).map((e) => primarySheetEmail(e)).filter(Boolean);
    if (!eventName) return { saved: false, error: "Event name is required" };
    if (emails.length === 0) return { saved: false, error: "No contacts with emails on the list" };
    const res = await ensureEventAttendanceBatch(
      emails.map((email) => ({
        email,
        eventName,
        type: "invited" as const,
        ensureCatalog: true,
        catalogType: "meeting" as const,
      })),
    );
    await logOpsEvent({
      action: "sync",
      source: "event_attendance",
      status: "ok",
      summary: `Query invite list → ${eventName} · ${res.attendanceWritten} invited${res.skipped ? ` (${res.skipped} already tagged)` : ""}`,
      records: res.attendanceWritten,
      details: { event: eventName, invited: res.attendanceWritten, skipped: res.skipped, by: data.user || "unknown" },
      items: emails.map((e) => `${e} ← ${eventName} [invited]`),
    });
    return {
      saved: true,
      savedTo: `Events — ${eventName} (${res.attendanceWritten} invited${res.skipped ? `, ${res.skipped} already tagged` : ""})`,
    };
  });
