import { createServerFn } from "@tanstack/react-start";
import { fetchAllAsanaEvents } from "./asana.server";
import {
  buildContacts,
  buildAppEvents,
  buildPortcoExposures,
  fetchSheetTab,
  appendSheetRows,
  appendPortcoIntroRows,
  mergePortcoIntroSource,
  ensureTab,
  logOpsEvent,
  TAB_NAMES,
  PORTCO_EXPOSURE_HEADERS,
  type PortcoIntroRowInput,
} from "./sheets.server";
import { engagementSourcesInclude } from "@/lib/engagement-source";
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
export async function runSyncEventExposure(): Promise<SyncExposureResult> {
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

    if (events.length === 0) {
      await logOpsEvent({
        action: "sync",
        source: "event_exposure",
        status: "ok",
        summary: "No completed portco-tagged events to sync",
        records: 0,
      });
      return EMPTY;
    }

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

    // Existing PortCo engagements: email|portco → raw Engagement Source cell.
    // "event exposure" may already be one of several multi-select sources.
    const introRows = await fetchSheetTab(TAB_NAMES.portcoIntros).catch(
      () => [] as string[][],
    );
    const existingEngagementSources = new Map<string, string>();
    if (introRows.length > 0) {
      const header = (introRows[0] || []).map((h) => norm(h));
      const emailIdx = header.indexOf("contact email");
      const portcoIdx = header.indexOf("portco name");
      const srcIdx = header.indexOf("engagement source");
      for (const r of introRows.slice(1)) {
        const email = emailIdx === -1 ? "" : norm(r[emailIdx] || "");
        const portco = portcoIdx === -1 ? "" : norm(r[portcoIdx] || "");
        if (!email || !portco) continue;
        existingEngagementSources.set(
          `${email}|${portco}`,
          srcIdx === -1 ? "" : r[srcIdx] || "",
        );
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const newExposures: string[][] = [];
    const newEngagements: PortcoIntroRowInput[] = [];
    const mergeEngagements: { email: string; portco: string; urid?: string }[] = [];
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
          if (queuedEng.has(engKey)) continue;
          const existingRaw = existingEngagementSources.get(engKey);
          if (existingRaw !== undefined) {
            if (engagementSourcesInclude(existingRaw, "event exposure")) continue;
            queuedEng.add(engKey);
            mergeEngagements.push({ email, portco, urid: c.urid });
            continue;
          }
          queuedEng.add(engKey);
          newEngagements.push({
            email,
            portcoName: portco,
            date: e.date || today,
            source: "event exposure",
            urid: c.urid,
          });
        }
      }
    }

    if (newExposures.length > 0) {
      await appendSheetRows(TAB_NAMES.portcoExposure, newExposures);
    }
    if (newEngagements.length > 0) {
      await appendPortcoIntroRows(newEngagements);
    }
    let mergedCount = 0;
    for (const m of mergeEngagements) {
      const res = await mergePortcoIntroSource(m.email, m.portco, "event exposure", m.urid);
      if (res.success && res.merged) mergedCount++;
    }

    const result = {
      ok: true as const,
      events: events.length,
      exposuresLogged: newExposures.length,
      engagementsLogged: newEngagements.length + mergedCount,
      skipped,
    };
    const items = [
      ...newExposures.map(
        (r) => `[exposure] ${r[0]} ← ${r[1]}${r[2] ? ` · ${r[2]}` : ""}${r[4] ? ` · via ${r[4]}` : ""}`,
      ),
      ...newEngagements.map(
        (r) =>
          `[attendee] ${r.email} ← ${r.portcoName}${r.date ? ` · ${r.date}` : ""}`,
      ),
      ...mergeEngagements.map(
        (m) => `[attendee-merge] ${m.email} ← ${m.portco} + event exposure`,
      ),
    ];
    await logOpsEvent({
      action: "sync",
      source: "event_exposure",
      status: "ok",
      summary: `Event exposure sync · ${result.exposuresLogged} companies · ${result.engagementsLogged} attendees`,
      records: result.exposuresLogged + result.engagementsLogged,
      details: {
        events: result.events,
        exposuresLogged: result.exposuresLogged,
        engagementsLogged: result.engagementsLogged,
        merged: mergedCount,
        skipped: result.skipped,
      },
      items,
    });
    return result;
  } catch (err) {
    console.error("[exposure] syncEventExposure failed:", err);
    const message = err instanceof Error ? err.message : "Sync failed";
    await logOpsEvent({
      action: "sync",
      source: "event_exposure",
      status: "error",
      summary: message,
      records: 0,
    });
    return { ...EMPTY, ok: false, error: message };
  }
}

export const syncEventExposure = createServerFn({ method: "POST" }).handler(
  async (): Promise<SyncExposureResult> => runSyncEventExposure(),
);
