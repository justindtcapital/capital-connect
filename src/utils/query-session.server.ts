/**
 * In-memory Query agent sessions — keeps Gemini AgentState server-side so the
 * client never round-trips full message history (and follow-ups keep tool context).
 * Also stores UI turns + live progress for refresh / polling.
 */
import type { AgentState, JsonValue } from "./llm.server";

const TTL_MS = 60 * 60 * 1000; // 1 hour

export interface QueryMeta {
  queryId: string;
  sessionId: string;
  user: string;
  inputText: string;
  timestampReceived: string;
}

export interface QueryPause {
  kind: "clarification" | "write_approval";
  toolUseId: string;
  name: string;
  input: JsonValue;
}

export interface UiTurn {
  role: "user" | "assistant";
  text: string;
  attachments?: string[];
  artifacts?: JsonValue[];
  prov?: {
    tools: JsonValue[];
    sources: JsonValue[];
    tokensIn: number;
    tokensOut: number;
  };
  /** True when the agent stopped early (timeout / step limit) with a partial answer. */
  partial?: boolean;
}

export interface QueryProgress {
  step: number;
  maxSteps: number;
  phase: "thinking" | "tool" | "paused" | "done";
  tool?: string;
  message: string;
  updatedAt: number;
}

export interface StoredQuerySession {
  state: AgentState;
  meta: QueryMeta;
  pause?: QueryPause;
  turns: UiTurn[];
  progress?: QueryProgress;
  updatedAt: number;
}

const sessions = new Map<string, StoredQuerySession>();

function prune(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > TTL_MS) sessions.delete(id);
  }
}

export function getQuerySession(sessionId: string): StoredQuerySession | undefined {
  prune();
  const s = sessions.get(sessionId);
  if (!s) return undefined;
  if (Date.now() - s.updatedAt > TTL_MS) {
    sessions.delete(sessionId);
    return undefined;
  }
  return s;
}

export function saveQuerySession(
  sessionId: string,
  data: Omit<StoredQuerySession, "updatedAt">,
): void {
  prune();
  const prev = sessions.get(sessionId);
  sessions.set(sessionId, {
    ...data,
    turns: data.turns ?? prev?.turns ?? [],
    progress: data.progress ?? prev?.progress,
    updatedAt: Date.now(),
  });
}

export function setQueryProgress(sessionId: string, progress: QueryProgress): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.progress = progress;
  s.updatedAt = Date.now();
}

export function clearQuerySession(sessionId: string): void {
  sessions.delete(sessionId);
}
