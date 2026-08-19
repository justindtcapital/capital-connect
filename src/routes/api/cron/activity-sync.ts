import { createFileRoute } from "@tanstack/react-router";

/**
 * Secret-protected activity sync for Cloud Scheduler (and curl, etc.).
 *
 * Auth: Authorization: Bearer <CRON_SECRET>  OR  x-cron-secret: <CRON_SECRET>
 *
 * Runs:
 *   - Asana + Gmail BD/GTM → Notes + BD/GTM tabs
 *   - Gmail CRM deepen (sent + calendar → Notes / Events attendance)
 *   - Event exposure PortCo tagging
 *
 * Logs fetched/new/deduped/error counts via logOpsEvent so a broken run shows
 * up in App Events. Server deps are imported inside the handler.
 */
export const Route = createFileRoute("/api/cron/activity-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorizeCronRequest } = await import("@/utils/cron-auth.server");
        const { syncAsanaActivities, syncActivityTracks } = await import(
          "@/utils/activity-sync.functions"
        );
        const { syncGmailCrmTouches } = await import("@/utils/gmail-crm-sync.functions");
        const { syncEventExposure } = await import("@/utils/event-exposure.functions");
        const { logOpsEvent } = await import("@/utils/sheets.server");

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

        const started = Date.now();
        try {
          const [notes, tracks, gmailCrm, exposure] = await Promise.all([
            syncAsanaActivities({ data: { source: "all" } }),
            syncActivityTracks({ data: { source: "all" } }),
            syncGmailCrmTouches(),
            syncEventExposure(),
          ]);

          const fetched = notes.activities;
          const logged =
            notes.logged +
            tracks.bdLogged +
            tracks.gtmLogged +
            (gmailCrm.skipped ? 0 : gmailCrm.logged) +
            (gmailCrm.skipped ? 0 : gmailCrm.eventsLogged);
          const deduped = notes.skipped + tracks.bdSkipped + tracks.gtmSkipped;
          const ok = notes.ok && tracks.ok && gmailCrm.ok && exposure.ok;
          const error =
            notes.error || tracks.error || gmailCrm.error || exposure.error || null;

          await logOpsEvent({
            action: "sync",
            source: "activity_sync_cron",
            status: ok ? "ok" : "error",
            summary: ok
              ? `Activity cron · fetched ${fetched} · new ${logged} · deduped ${deduped}` +
                (gmailCrm.skipped ? "" : ` · gmail-crm notes ${gmailCrm.logged} events ${gmailCrm.eventsLogged}`)
              : `Activity cron failed: ${error}`,
            records: logged,
            details: {
              fetched,
              new: logged,
              deduped,
              notesLogged: notes.logged,
              notesSkipped: notes.skipped,
              bdLogged: tracks.bdLogged,
              gtmLogged: tracks.gtmLogged,
              gmailCrmLogged: gmailCrm.skipped ? 0 : gmailCrm.logged,
              gmailCrmEvents: gmailCrm.skipped ? 0 : gmailCrm.eventsLogged,
              exposureCompanies: exposure.exposuresLogged ?? 0,
              ms: Date.now() - started,
            },
          });

          return Response.json({
            ok,
            error,
            fetched,
            new: logged,
            deduped,
            notes,
            tracks,
            gmailCrm,
            exposure,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await logOpsEvent({
            action: "sync",
            source: "activity_sync_cron",
            status: "error",
            summary: `Activity cron failed: ${message}`,
            records: 0,
          });
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
