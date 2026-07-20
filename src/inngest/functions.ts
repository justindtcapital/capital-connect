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

export const functions = [dailySignalScan];
