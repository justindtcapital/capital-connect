import { createFileRoute } from "@tanstack/react-router";

/**
 * Secret-protected Signals v2 nightly reconciliation for external schedulers.
 * Mirrors /api/cron/intel-scan: Bearer/x-cron-secret auth, queue on Inngest by
 * default (202), `{ "sync": true }` to run inline.
 */
export const Route = createFileRoute("/api/cron/signals-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorizeCronRequest } = await import("@/utils/cron-auth.server");
        const { inngest } = await import("@/inngest/client");
        const { runSignalsReconcile } = await import("@/utils/signal-reconcile.server");

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

        let sync = false;
        try {
          const body = (await request.json()) as { sync?: boolean };
          if (body?.sync === true) sync = true;
        } catch {
          // empty / non-JSON body is fine
        }

        if (!sync) {
          try {
            await Promise.race([
              inngest.send({
                name: "signals/reconcile.requested",
                data: { source: "http-cron" },
              }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Inngest send timed out")), 4000),
              ),
            ]);
            return Response.json({ ok: true, queued: true }, { status: 202 });
          } catch (err) {
            console.error("[cron] Inngest queue failed; falling back to sync reconcile:", err);
          }
        }

        const res = await runSignalsReconcile();
        return Response.json({ ...res, queued: false, error: res.error || null });
      },
    },
  },
});
