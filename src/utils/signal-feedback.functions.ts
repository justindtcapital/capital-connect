// WS5 — per-card interaction logging + quality metrics (server functions).
//
// Every top-N card interaction lands in the Signal Feedback tab with a FROZEN
// feature-vector snapshot, so a learned ranker can be trained offline later
// without re-deriving anything. The client sends what it knows (event/signal
// id, action, rank position); the handler enriches the snapshot server-side
// from the Signal Events row at write time — full fidelity, still frozen.
//
// Phase 0: partner verdicts (useful / wrong_company / …) also write here as
// Action values, with company/sourceType/rankScore/sourceHost frozen in the
// feature vector for weekly precision@10.

import { createServerFn } from "@tanstack/react-start";
import {
  appendSignalFeedback,
  loadSignalEvents,
  loadSignalMetrics,
  type FeedbackRow,
} from "./event-store.server";
import {
  isFeedbackAction,
  isFeedbackVerdict,
  toIntelVerdict,
  validateSignalFeedback,
  type FeedbackAction,
  type FeedbackVerdict,
} from "@/lib/feedback";
import { recordSignalVerdict } from "./intel.server";

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
      const items = (data?.events || []).filter((e) => e.action && isFeedbackAction(e.action));
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
                  company: ev.company,
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

/** Phase 0 partner verdict — primary write to Signal Feedback + dual-write intel. */
export const submitSignalVerdict = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      signalId: string;
      eventId?: string;
      verdict: FeedbackVerdict;
      user?: string;
      company?: string;
      sourceType?: string;
      rankScore?: number | null;
      sourceHost?: string;
      rankPosition?: number | null;
      correction?: string;
      features?: Record<string, unknown>;
    }) => data,
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const checked = validateSignalFeedback({
      signalId: data.signalId,
      eventId: data.eventId,
      verdict: data.verdict,
      user: data.user || "unknown",
      atIso: new Date().toISOString(),
      company: data.company || "",
      sourceType: data.sourceType || "",
      rankScore: data.rankScore,
      sourceHost: data.sourceHost,
      correction: data.correction,
    });
    if (!checked.ok) return { ok: false, error: checked.error };

    const fb = checked.value;
    try {
      const events = fb.eventId ? await loadSignalEvents({ sinceDays: 120 }) : [];
      const ev = fb.eventId ? events.find((e) => e.eventId === fb.eventId) : undefined;
      await appendSignalFeedback([
        {
          dateIso: fb.atIso,
          eventId: fb.eventId || "",
          signalId: fb.signalId,
          action: fb.verdict,
          user: fb.user,
          rankPosition: data.rankPosition ?? null,
          featureVector: {
            ...(data.features || {}),
            verdict: fb.verdict,
            company: fb.company || ev?.company || "",
            sourceType: fb.sourceType,
            rankScore: fb.rankScore ?? ev?.rankScore ?? null,
            sourceHost: fb.sourceHost || "",
            correction: fb.correction || "",
            ...(ev
              ? {
                  eventType: ev.eventType,
                  materialityAdj: ev.materialityAdj,
                  badges: ev.badges,
                }
              : {}),
          },
        },
      ]);

      // Dual-write to intel Signal Verdicts for backward compatibility.
      const intelV = toIntelVerdict(fb.verdict);
      if (intelV) {
        await recordSignalVerdict({
          signalId: fb.signalId,
          company: fb.company || ev?.company || "",
          verdict: intelV,
          user: fb.user,
          note: fb.correction || undefined,
        });
      }
      return { ok: true };
    } catch (e) {
      console.error("[signal-feedback] submitVerdict failed:", e);
      return { ok: false, error: e instanceof Error ? e.message : "write failed" };
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

// Re-export for callers that typed against this module.
export type { FeedbackAction, FeedbackVerdict };
export { isFeedbackVerdict };
