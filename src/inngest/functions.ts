import { cron } from "inngest";
import { inngest } from "./client";

/**
 * Daily full Signal Radar scan at 6:00 AM America/New_York.
 * Also triggered by event `signals/scan.requested` (from POST /api/cron/scan-signals).
 *
 * Disable with SIGNALS_CRON_ENABLED=false (function still registers but no-ops).
 * Override lookback with SIGNALS_CRON_WINDOW_DAYS (default 14).
 */
export const dailySignalScan = inngest.createFunction(
  {
    id: "daily-signal-scan",
    name: "Daily Signal Scan",
    triggers: [
      cron("TZ=America/New_York 0 6 * * *"),
      { event: "signals/scan.requested" },
    ],
    retries: 2,
  },
  async ({ event, step }) => {
    if ((process.env["SIGNALS_CRON_ENABLED"] || "true").toLowerCase() === "false") {
      return { skipped: true, reason: "SIGNALS_CRON_ENABLED=false" };
    }

    const fromEvent =
      event && typeof event === "object" && "data" in event
        ? Number((event as { data?: { windowDays?: number } }).data?.windowDays)
        : NaN;
    const windowDays =
      (Number.isFinite(fromEvent) && fromEvent > 0
        ? fromEvent
        : Number(process.env["SIGNALS_CRON_WINDOW_DAYS"])) || 14;

    const result = await step.run("scan-signals", async () => {
      const { runScheduledSignalScan } = await import("@/utils/signals-scan.server");
      const scan = await runScheduledSignalScan({ windowDays });
      return {
        found: scan.found,
        error: scan.error || null,
        newCount: scan.newCount ?? 0,
        recommendations: scan.recommendations?.length ?? 0,
        otherSignals: scan.otherSignals?.length ?? 0,
      };
    });

    return { ok: result.found, windowDays, ...result };
  },
);

/**
 * Daily Signal Radar v2 intel sweep at 5:30 AM America/New_York — runs the
 * first-party collectors (ATS boards, GitHub, CT logs) BEFORE the 6:00 news
 * scan so the day's momentum signals land first. Also triggered by event
 * `intel/sweep.requested` (from POST /api/cron/intel-scan).
 * Disable with INTEL_CRON_ENABLED=false; batch size via INTEL_SWEEP_LIMIT.
 */
export const dailyIntelSweep = inngest.createFunction(
  {
    id: "daily-intel-sweep",
    name: "Daily Intel Sweep",
    triggers: [
      cron("TZ=America/New_York 30 5 * * *"),
      { event: "intel/sweep.requested" },
    ],
    retries: 2,
  },
  async ({ event, step }) => {
    if ((process.env["INTEL_CRON_ENABLED"] || "true").toLowerCase() === "false") {
      return { skipped: true, reason: "INTEL_CRON_ENABLED=false" };
    }
    const data =
      event && typeof event === "object" && "data" in event
        ? (event as { data?: { limit?: number; tier?: string } }).data
        : undefined;

    const result = await step.run("intel-sweep", async () => {
      const { runIntelSweep } = await import("@/utils/intel.server");
      const res = await runIntelSweep({ limit: data?.limit, tier: data?.tier });
      return {
        ok: res.ok,
        error: res.error || null,
        entitiesScanned: res.entitiesScanned,
        observations: res.observations,
        signalsEmitted: res.signalsEmitted,
      };
    });

    return result;
  },
);

/**
 * Nightly Signals v2 reconciliation at 9:30 PM America/New_York (WS3/WS5):
 * late news↔intel merges, DETECTED BEFORE PRESS badging, constituent-row
 * rescore sync. Also triggered by event `signals/reconcile.requested`
 * (from POST /api/cron/signals-reconcile).
 * Disable with SIGNALS_RECONCILE_ENABLED=false.
 */
export const nightlySignalsReconcile = inngest.createFunction(
  {
    id: "nightly-signals-reconcile",
    name: "Nightly Signals Reconcile",
    triggers: [
      cron("TZ=America/New_York 30 21 * * *"),
      { event: "signals/reconcile.requested" },
    ],
    retries: 2,
  },
  async ({ step }) => {
    if ((process.env["SIGNALS_RECONCILE_ENABLED"] || "true").toLowerCase() === "false") {
      return { skipped: true, reason: "SIGNALS_RECONCILE_ENABLED=false" };
    }
    const result = await step.run("signals-reconcile", async () => {
      const { runSignalsReconcile } = await import("@/utils/signal-reconcile.server");
      return runSignalsReconcile();
    });
    return result;
  },
);

export const functions = [dailySignalScan, dailyIntelSweep, nightlySignalsReconcile];
