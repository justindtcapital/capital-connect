import { createFileRoute } from "@tanstack/react-router";

/**
 * Secret-protected Signal Radar v2 intel sweep for external schedulers.
 * Mirrors /api/cron/scan-signals: Bearer/x-cron-secret auth, queue on Inngest
 * by default (202), `{ "sync": true }` to run inline.
 * Optional body: { "limit": 15, "tier": "portco" }.
 */
export const Route = createFileRoute("/api/cron/intel-scan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorizeCronRequest } = await import("@/utils/cron-auth.server");
        const { inngest } = await import("@/inngest/client");
        const { runIntelSweep } = await import("@/utils/intel.server");

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

        let limit: number | undefined;
        let tier: string | undefined;
        let sync = false;
        try {
          const body = (await request.json()) as {
            limit?: number;
            tier?: string;
            sync?: boolean;
          };
          if (typeof body?.limit === "number" && body.limit > 0) limit = body.limit;
          if (typeof body?.tier === "string" && body.tier.trim()) tier = body.tier.trim();
          if (body?.sync === true) sync = true;
        } catch {
          // empty / non-JSON body is fine
        }

        if (!sync) {
          try {
            await Promise.race([
              inngest.send({
                name: "intel/sweep.requested",
                data: { limit, tier, source: "http-cron" },
              }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Inngest send timed out")), 4000),
              ),
            ]);
            return Response.json({ ok: true, queued: true, limit, tier }, { status: 202 });
          } catch (err) {
            console.error("[cron] Inngest queue failed; falling back to sync sweep:", err);
          }
        }

        const res = await runIntelSweep({ limit, tier });
        return Response.json({
          ok: res.ok,
          queued: false,
          error: res.error || null,
          entitiesScanned: res.entitiesScanned,
          observations: res.observations,
          signalsEmitted: res.signalsEmitted,
        });
      },
    },
  },
});
