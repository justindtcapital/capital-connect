import { createFileRoute } from "@tanstack/react-router";

/**
 * Secret-protected signal scan for external schedulers
 * (Lovable Cloud Scheduled Jobs, GitHub Actions, curl, etc.).
 *
 * Auth: Authorization: Bearer <CRON_SECRET>  OR  x-cron-secret: <CRON_SECRET>
 *
 * Default: queues the scan on Inngest and returns 202 quickly (avoids
 * serverless timeouts). Pass `{ "sync": true }` to run inline instead.
 * Optional: `{ "windowDays": 14 }`
 *
 * Server deps are imported inside the handler so the client bundle stays clean.
 */
export const Route = createFileRoute("/api/cron/scan-signals")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorizeCronRequest } = await import("@/utils/cron-auth.server");
        const { inngest } = await import("@/inngest/client");
        const { runScheduledSignalScan } = await import("@/utils/signals-scan.server");

        if (!authorizeCronRequest(request)) {
          return Response.json(
            {
              ok: false,
              error: process.env["CRON_SECRET"]
                ? "Unauthorized"
                : "CRON_SECRET is not configured on the server",
            },
            { status: 401 },
          );
        }

        let windowDays = Number(process.env["SIGNALS_CRON_WINDOW_DAYS"]) || 14;
        let sync = false;
        try {
          const body = (await request.json()) as {
            windowDays?: number;
            sync?: boolean;
          };
          if (typeof body?.windowDays === "number" && body.windowDays > 0) {
            windowDays = body.windowDays;
          }
          if (body?.sync === true) sync = true;
        } catch {
          // empty / non-JSON body is fine
        }

        // Prefer durable queue so Lovable / edge timeouts don't kill the scan.
        if (!sync) {
          try {
            await Promise.race([
              inngest.send({
                name: "signals/scan.requested",
                data: { windowDays, source: "http-cron" },
              }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Inngest send timed out")), 4000),
              ),
            ]);
            return Response.json(
              { ok: true, queued: true, windowDays },
              { status: 202 },
            );
          } catch (err) {
            console.error(
              "[cron] Inngest queue failed; falling back to sync scan:",
              err,
            );
          }
        }

        const scan = await runScheduledSignalScan({ windowDays });
        return Response.json({
          ok: scan.found,
          queued: false,
          error: scan.error || null,
          newCount: scan.newCount ?? 0,
          recommendations: scan.recommendations?.length ?? 0,
          otherSignals: scan.otherSignals?.length ?? 0,
        });
      },
    },
  },
});
