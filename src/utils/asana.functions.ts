import { createServerFn } from "@tanstack/react-start";
import { fetchPortcoFields, fetchPortfolioEvents, discoverFields, fetchAllAsanaEvents } from "./asana.server";
import { buildActivities } from "./sheets.server";
import { loadAttributionCorrections } from "./activity-attribution.server";
import { applyAttributionCorrections } from "@/lib/activity-canonical";
import type { PortfolioEvent, AsanaEvent, AsanaActivity } from "@/lib/types";

export interface AsanaPortcoData {
  fieldsByCompanyName: Record<string, Record<string, string>>;
  /** Lowercased key -> original display name from the Asana portco project. */
  namesByCompanyName: Record<string, string>;
  eventsByCompanyName: Record<string, PortfolioEvent[]>;
}

let didDiscover = false;
// Bumping this version forces re-discovery on deploy when GIDs change.
const DISCOVERY_VERSION = "v2";
void DISCOVERY_VERSION;

export const fetchAsanaPortcoData = createServerFn({ method: "GET" }).handler(
  async (): Promise<AsanaPortcoData> => {
    try {
      // One-time field discovery logged to server output.
      if (!didDiscover) {
        didDiscover = true;
        const portcoGid = process.env.ASANA_PORTCO_PROJECT_GID;
        const eventsGid = process.env.ASANA_EVENTS_PROJECT_GID;
        const bdGid = process.env.ASANA_BD_PROJECT_GID;
        const gtmGid = process.env.ASANA_GTM_PROJECT_GID;
        if (portcoGid) await discoverFields(portcoGid, "portco");
        if (eventsGid) await discoverFields(eventsGid, "events");
        if (bdGid) await discoverFields(bdGid, "bd");
        if (gtmGid) await discoverFields(gtmGid, "gtm");
      }

      const [fieldsMap, eventsMap] = await Promise.all([
        fetchPortcoFields(),
        fetchPortfolioEvents(),
      ]);

      return {
        fieldsByCompanyName: Object.fromEntries(
          Array.from(fieldsMap.entries()).map(([k, v]) => [k, v.fields])
        ),
        namesByCompanyName: Object.fromEntries(
          Array.from(fieldsMap.entries()).map(([k, v]) => [k, v.name])
        ),
        eventsByCompanyName: Object.fromEntries(
          Array.from(eventsMap.entries()).map(([k, v]) => [k, v])
        ),
      };
    } catch (err) {
      console.error("[asana] fetchAsanaPortcoData failed:", err);
      return { fieldsByCompanyName: {}, namesByCompanyName: {}, eventsByCompanyName: {} };
    }
  }
);

// Flat list of all Asana events for the EventPicker + /events page.
export const fetchAsanaEvents = createServerFn({ method: "GET" }).handler(
  async (): Promise<AsanaEvent[]> => {
    try {
      return await fetchAllAsanaEvents();
    } catch (err) {
      console.error("[asana] fetchAsanaEvents failed:", err);
      return [];
    }
  }
);

// BD + GTM activities for display — read from the mirrored BD / GTM sheet tabs
// (populated by Sync activity from Asana + Gmail aliases). Attribution flags
// overlay immediately so a correction shows before the next sync rewrites the tab.
export const fetchAsanaActivities = createServerFn({ method: "GET" }).handler(
  async (): Promise<AsanaActivity[]> => {
    try {
      const activities = await buildActivities();
      const corrections = await loadAttributionCorrections().catch(() => []);
      return applyAttributionCorrections(activities, corrections);
    } catch (err) {
      console.error("[activity] fetchAsanaActivities (sheets) failed:", err);
      return [];
    }
  }
);
