import { createFileRoute } from "@tanstack/react-router";

/**
 * Inngest serve endpoint — required for cron + durable jobs.
 * Sync this URL in Inngest Cloud (or Lovable's Inngest connector) after deploy.
 *
 * All Inngest imports stay inside handlers so the client route tree never
 * pulls Node-only packages into the browser bundle.
 */
export const Route = createFileRoute("/api/inngest")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { serve } = await import("inngest/edge");
        const { inngest } = await import("@/inngest/client");
        const { functions } = await import("@/inngest/functions");
        return serve({ client: inngest, functions })(request);
      },
      POST: async ({ request }) => {
        const { serve } = await import("inngest/edge");
        const { inngest } = await import("@/inngest/client");
        const { functions } = await import("@/inngest/functions");
        return serve({ client: inngest, functions })(request);
      },
      PUT: async ({ request }) => {
        const { serve } = await import("inngest/edge");
        const { inngest } = await import("@/inngest/client");
        const { functions } = await import("@/inngest/functions");
        return serve({ client: inngest, functions })(request);
      },
    },
  },
});
