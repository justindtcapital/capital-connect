import { createServerFn } from "@tanstack/react-start";
import { fetchAllAsanaEvents } from "./asana.server";
import {
  buildContacts,
  buildAppEvents,
  buildPortcoExposures,
  fetchSheetTab,
  appendSheetRows,
  ensureTab,
  ensureColumn,
  TAB_NAMES,
  PORTCO_EXPOSURE_HEADERS,
} from "./sheets.server";
import type { AsanaEvent, PortCoExposure } from "@/lib/types";

export interface SyncExposureResult {
  ok: boolean;
  error?: string;
  /** Completed, portco-tagged events considered this run. */
  events: number;
  /** New company-level exposure rows written. */
  exposuresLogged: number;
  /** New attendee "event exposure" engagements written. */
  engagementsLogged: number;
  /** Company/event exposures skipped because already logged. */
  skipped: number;
}

const EMPTY: SyncExposureResult = {
  ok: true,
  events: 0,
  exposuresLogged: 0,
  engagementsLogged: 0,
  skipped: 0,
};

const norm = (s: string) => (s || "").trim().toLowerCase();

// Read the persisted event-exposure tags (flattened). The portfolio route groups
// these back onto companies by name.
export const fetchPortcoExposures = createServerFn({ method: "GET" }).handler(
  async (): Promise<PortCoExposure[]> => {
    const map = await buildPortcoExposures();
    return [...map.values()].flat();
  },
);

// Post-event portfolio tagging. For every COMPLETED event that tags one or more
// portcos (from Asana events + manual App events), write:
//   1) a company-level "event exposure" row to the PortCo Event Exposure tab, and
//   2) an "event exposure" portfolio engagement onto every contact who attended
//      that event (so attendees carry the exposure through their profile).
// Idempotent: company exposures dedupe on company|event; attendee engagements
// dedupe on email|portco (an existing event-exposure engagement to that company
// is never re-written). No Asana write-back — Asana stays the source of truth.
export const syncEventExposure = createServerFn({ method: "POST" }).handler(
  async (): Promise<SyncExposureResult> => {
    try {
      const [asanaEvents, appEvents, contacts] = await Promise.all([
        fetchAllAsanaEvents().catch(() => [] as AsanaEvent[]),
        buildAppEvents().catch(() => [] as AsanaEvent[]),
        buildContacts(),
      ]);

      const events = [
        ...asanaEvents.map((e) => ({ e, src: "Asana" })),
        ...appEvents.map((e) => ({ e, src: "App" })),
      ].filter(({ e }) => e.status === "completed" && e.portcos.length > 0);

      if (events.length === 0) return EMPTY;

      // Existing company exposures (dedupe on company|event).
      await ensureTab(TAB_NAMES.portcoExposure, PORTCO_EXPOSURE_HEADERS);
      const exposureRows = await fetchSheetTab(TAB_NAMES.portcoExposure).catch(
        () => [] as string[][],
      );
      const existingExposure = new Set<string>();
      for (const r of exposureRows.slice(1)) {
        const company = norm(r[0] || "");
        const event = norm(r[1] || "");
        if (company && event) existingExposure.add(`${company}|${event}`);
      }

      // Existing event-exposure engagements (dedupe on email|portco).
      const introRows = await fetchSheetTab(TAB_NAMES.portcoIntros).catch(
        () => [] as string[][],
      );
      const existingEngagement = new Set<string>();
      if (introRows.length > 0) {
        const header = (introRows[0] || []).map((h) => norm(h));
        const emailIdx = header.indexOf("contact email");
        const portcoIdx = header.indexOf("portco name");
        const srcIdx = header.indexOf("engagement source");
        for (const r of introRows.slice(1)) {
          if (srcIdx === -1 || norm(r[srcIdx] || "") !== "event exposure") continue;
          const email = emailIdx === -1 ? "" : norm(r[emailIdx] || "");
          const portco = portcoIdx === -1 ? "" : norm(r[portcoIdx] || "");
          if (email && portco) existingEngagement.add(`${email}|${portco}`);
        }
      }

      const today = new Date().toISOString().slice(0, 10);
      const newExposures: string[][] = [];
      const newEngagements: string[][] = [];
      const queuedExp = new Set<string>();
      const queuedEng = new Set<string>();
      let skipped = 0;

      for (const { e, src } of events) {
        const eventKeyName = norm(e.name);
        const attendees = contacts.filter((c) =>
          c.eventsAttended.some((n) => norm(n) === eventKeyName),
        );
        for (const portco of e.portcos) {
          const pKey = norm(portco);
          if (!pKey) continue;

          const expKey = `${pKey}|${eventKeyName}`;
          if (existingExposure.has(expKey)) {
            skipped++;
          } else if (!queuedExp.has(expKey)) {
            queuedExp.add(expKey);
            // Order matches PORTCO_EXPOSURE_HEADERS.
            newExposures.push([portco, e.name, e.date || today, e.format || "", src, today]);
          }

          for (const c of attendees) {
            const email = (c.email || "").split(";")[0]?.trim() || "";
            if (!email) continue;
            const engKey = `${norm(email)}|${pKey}`;
            if (existingEngagement.has(engKey) || queuedEng.has(engKey)) continue;
            queuedEng.add(engKey);
            // Order mirrors addPortcoIntro: email, portco, date, engagement source.
            newEngagements.push([email, portco, e.date || today, "event exposure"]);
          }
        }
      }

      if (newExposures.length > 0) {
        await appendSheetRows(TAB_NAMES.portcoExposure, newExposures);
      }
      if (newEngagements.length > 0) {
        await ensureColumn(TAB_NAMES.portcoIntros, "Engagement Source");
        await appendSheetRows(TAB_NAMES.portcoIntros, newEngagements);
      }

      return {
        ok: true,
        events: events.length,
        exposuresLogged: newExposures.length,
        engagementsLogged: newEngagements.length,
        skipped,
      };
    } catch (err) {
      console.error("[exposure] syncEventExposure failed:", err);
      return { ...EMPTY, ok: false, error: err instanceof Error ? err.message : "Sync failed" };
    }
  },
);
