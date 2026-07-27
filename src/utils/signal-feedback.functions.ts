// WS5 — per-card interaction logging + quality metrics (server functions).
//
// Every top-N card interaction lands in the Signal Feedback tab with a FROZEN
// feature-vector snapshot, so a learned ranker can be trained offline later
// without re-deriving anything. The client sends what it knows (event/signal
// id, action, rank position); the handler enriches the snapshot server-side
// from the Signal Events row at write time — full fidelity, still frozen.

import { createServerFn } from "@tanstack/react-start";
import {
  appendSignalFeedback,
  loadSignalEvents,
  loadSignalMetrics,
  type FeedbackAction,
  type FeedbackRow,
} from "./event-store.server";

export interface FeedbackInput {
  events: Array<{
    eventId?: string;
    signalId?: string;
    action: FeedbackAction;
    rankPosition?: number | null;
    /** Client-known extras (opportunity score, badges) — merged into the snapshot. */
    features?: Record<string, unknown>;
  }>;
  user?: string;
}

export const logSignalFeedback = createServerFn({ method: "POST" })
  .inputValidator((data: FeedbackInput) => data)
  .handler(async ({ data }): Promise<{ ok: boolean; logged: number }> => {
    try {
      const items = (data?.events || []).filter((e) => e.action);
      if (items.length === 0) return { ok: true, logged: 0 };
      // Enrich snapshots from the event rows (cached tab read, one call).
      const events = await loadSignalEvents({ sinceDays: 120 });
      const byId = new Map(events.map((e) => [e.eventId, e]));
      const nowIso = new Date().toISOString();
      const rows: FeedbackRow[] = items.map((e) => {
        const ev = e.eventId ? byId.get(e.eventId) : undefined;
        return {
          dateIso: nowIso,
          eventId: e.eventId || "",
          signalId: e.signalId || "",
          action: e.action,
          user: data.user || "unknown",
          rankPosition: e.rankPosition ?? null,
          featureVector: {
            ...(e.features || {}),
            ...(ev
              ? {
                  eventType: ev.eventType,
                  materiality: ev.materiality,
                  materialityAdj: ev.materialityAdj,
                  relevance: ev.relevance,
                  actionability: ev.actionability,
                  surprise: ev.surprise,
                  rankScore: ev.rankScore,
                  confidence: ev.confidence,
                  sourceCount: ev.sourceCount,
                  sourceTier: ev.topTier,
                  badges: ev.badges,
                  pipelineOrigin: ev.intelEventId ? "fused" : "news",
                }
              : {}),
          },
        };
      });
      await appendSignalFeedback(rows);
      return { ok: true, logged: rows.length };
    } catch (e) {
      console.error("[signal-feedback] log failed:", e);
      return { ok: false, logged: 0 };
    }
  });

export const fetchSignalQualityMetrics = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    precisionAt10: Array<{ date: string; value: number }>;
  }> => {
    try {
      const series = await loadSignalMetrics("precision_at_10", { sinceDays: 30 });
      return { precisionAt10: series.map(({ date, value }) => ({ date, value })) };
    } catch {
      return { precisionAt10: [] };
    }
  },
);
