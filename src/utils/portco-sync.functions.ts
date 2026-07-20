import { createServerFn } from "@tanstack/react-start";
import { fetchPortcoFields, fetchPortfolioEvents } from "./asana.server";
import { runSyncEventExposure } from "./event-exposure.functions";
import { matchOrganization, isSumbleConfigured } from "./sumble.server";
import { fillBlankPortfolioFields, logOpsEvent } from "./sheets.server";
import type { PortfolioEvent } from "@/lib/types";

const norm = (s: string) => (s || "").trim().toLowerCase();

/** Pull a field by header pattern from an Asana custom-field map. */
function fieldByPattern(fields: Record<string, string>, pattern: RegExp): string {
  for (const [k, v] of Object.entries(fields)) {
    if (v && pattern.test(k)) return v;
  }
  return "";
}

function profileFromAsanaFields(fields: Record<string, string>) {
  return {
    website: fieldByPattern(fields, /website|^url$|web\s*site/i),
    linkedinUrl: fieldByPattern(fields, /linkedin/i),
    location: fieldByPattern(fields, /^hq$|headquarter|location|city|geograph/i),
    description: fieldByPattern(fields, /summary|description|about|overview/i),
    sector: fieldByPattern(fields, /industry|sector|vertical|theme|focus\s*area|category/i),
  };
}

export interface PortcoAsanaSyncResult {
  ok: boolean;
  error?: string;
  companyName: string;
  /** Fresh Asana custom fields for this company (empty if not found). */
  asanaFields: Record<string, string>;
  /** Fresh Asana events tagged to this company. */
  events: PortfolioEvent[];
  /** Sheet columns filled (never overwrote). */
  sheetFieldsUpdated: string[];
  fieldCount: number;
  eventCount: number;
  /** Event-exposure sync summary when that pass ran. */
  exposuresLogged: number;
  engagementsLogged: number;
}

export interface PortcoWebSyncResult {
  ok: boolean;
  error?: string;
  companyName: string;
  website?: string;
  linkedinUrl?: string;
  location?: string;
  description?: string;
  sheetFieldsUpdated: string[];
  /** Sumble org id when matched. */
  sumbleOrgId?: number;
  sumbleDomain?: string;
}

// Refresh one PortCo from Asana (fields + events), fill blank Portfolio sheet
// cells, and run event-exposure tagging. Logged as Ops source `portco_asana`.
export const syncPortcoFromAsana = createServerFn({ method: "POST" })
  .inputValidator((data: { companyName: string }) => data)
  .handler(async ({ data }): Promise<PortcoAsanaSyncResult> => {
    const companyName = (data.companyName || "").trim();
    const empty: PortcoAsanaSyncResult = {
      ok: true,
      companyName,
      asanaFields: {},
      events: [],
      sheetFieldsUpdated: [],
      fieldCount: 0,
      eventCount: 0,
      exposuresLogged: 0,
      engagementsLogged: 0,
    };
    if (!companyName) {
      return { ...empty, ok: false, error: "Company name is required" };
    }

    try {
      if (!process.env.ASANA_PORTCO_PROJECT_GID && !process.env.ASANA_EVENTS_PROJECT_GID) {
        const error = "Asana PortCo/Events project GIDs are not configured";
        await logOpsEvent({
          action: "sync",
          source: "portco_asana",
          status: "error",
          summary: error,
          records: 0,
          details: { company: companyName },
        });
        return { ...empty, ok: false, error };
      }

      const key = norm(companyName);
      const [fieldsMap, eventsMap] = await Promise.all([
        fetchPortcoFields().catch(
          () => new Map<string, { name: string; fields: Record<string, string> }>(),
        ),
        fetchPortfolioEvents().catch(() => new Map<string, PortfolioEvent[]>()),
      ]);

      const entry = fieldsMap.get(key);
      const asanaFields = entry?.fields || {};
      const events = eventsMap.get(key) || [];
      const profile = profileFromAsanaFields(asanaFields);

      const sheetFieldsUpdated = await fillBlankPortfolioFields(companyName, {
        website: profile.website,
        location: profile.location,
        description: profile.description,
        domain: profile.sector,
      }).catch(() => [] as string[]);

      // Attendance / exposure tagging shares the same Asana events source.
      const exposure = await runSyncEventExposure().catch(() => null);
      const exposuresLogged = exposure && exposure.ok ? exposure.exposuresLogged : 0;
      const engagementsLogged = exposure && exposure.ok ? exposure.engagementsLogged : 0;

      const result: PortcoAsanaSyncResult = {
        ok: true,
        companyName: entry?.name || companyName,
        asanaFields,
        events,
        sheetFieldsUpdated,
        fieldCount: Object.keys(asanaFields).length,
        eventCount: events.length,
        exposuresLogged,
        engagementsLogged,
      };

      await logOpsEvent({
        action: "sync",
        source: "portco_asana",
        status: "ok",
        summary: `Asana sync for ${result.companyName} · ${result.fieldCount} fields · ${result.eventCount} events`,
        records: result.fieldCount + result.eventCount,
        details: {
          company: result.companyName,
          fields: result.fieldCount,
          events: result.eventCount,
          sheetUpdated: result.sheetFieldsUpdated.join(", ") || "none",
          exposuresLogged,
          engagementsLogged,
          foundInAsana: !!entry || events.length > 0,
        },
        items: [
          ...Object.entries(asanaFields)
            .slice(0, 40)
            .map(([k, v]) => `[field] ${k}: ${v}`),
          ...events.map(
            (e) => `[event] ${e.name} · ${e.date}${e.status ? ` · ${e.status}` : ""}`,
          ),
          ...sheetFieldsUpdated.map((c) => `[sheet] filled blank ${c}`),
        ],
      });

      return result;
    } catch (err) {
      console.error("[portco] syncPortcoFromAsana failed:", err);
      const message = err instanceof Error ? err.message : "Asana PortCo sync failed";
      await logOpsEvent({
        action: "sync",
        source: "portco_asana",
        status: "error",
        summary: message,
        records: 0,
        details: { company: companyName },
      });
      return { ...empty, ok: false, error: message };
    }
  });

// Refresh one PortCo's public profile from Sumble (web org match) + any Asana
// LinkedIn/website fields still blank on the sheet. Logged as `portco_web`.
export const syncPortcoFromWeb = createServerFn({ method: "POST" })
  .inputValidator((data: { companyName: string; website?: string; location?: string }) => data)
  .handler(async ({ data }): Promise<PortcoWebSyncResult> => {
    const companyName = (data.companyName || "").trim();
    const empty: PortcoWebSyncResult = {
      ok: true,
      companyName,
      sheetFieldsUpdated: [],
    };
    if (!companyName) {
      return { ...empty, ok: false, error: "Company name is required" };
    }

    try {
      // Asana fields can still supply LinkedIn / website when Sumble is offline.
      const fieldsMap = await fetchPortcoFields().catch(() => new Map());
      const asanaProfile = profileFromAsanaFields(fieldsMap.get(norm(companyName))?.fields || {});

      let sumbleDomain = "";
      let sumbleOrgId: number | undefined;
      let sumbleError: string | undefined;

      if (isSumbleConfigured()) {
        const match = await matchOrganization(companyName, data.website, data.location);
        if (match.error && !match.org) sumbleError = match.error;
        if (match.org) {
          sumbleOrgId = match.org.id;
          sumbleDomain = match.org.domain || "";
        }
      } else if (!asanaProfile.website && !asanaProfile.linkedinUrl && !asanaProfile.location) {
        const error = "Sumble isn't configured (SUMBLE_API_KEY) and Asana has no profile fields";
        await logOpsEvent({
          action: "sync",
          source: "portco_web",
          status: "error",
          summary: error,
          records: 0,
          details: { company: companyName },
        });
        return { ...empty, ok: false, error };
      }

      const website =
        (sumbleDomain ? (sumbleDomain.startsWith("http") ? sumbleDomain : `https://${sumbleDomain}`) : "") ||
        asanaProfile.website ||
        "";
      const linkedinUrl = asanaProfile.linkedinUrl || "";
      const location = asanaProfile.location || "";
      const description = asanaProfile.description || "";

      const sheetFieldsUpdated = await fillBlankPortfolioFields(companyName, {
        website: website || undefined,
        location: location || undefined,
        description: description || undefined,
        domain: asanaProfile.sector || undefined,
      }).catch(() => [] as string[]);

      const result: PortcoWebSyncResult = {
        ok: true,
        companyName,
        website: website || undefined,
        linkedinUrl: linkedinUrl || undefined,
        location: location || undefined,
        description: description || undefined,
        sheetFieldsUpdated,
        sumbleOrgId,
        sumbleDomain: sumbleDomain || undefined,
      };

      if (!website && !linkedinUrl && !location && !sumbleOrgId) {
        const error =
          sumbleError ||
          `"${companyName}" wasn't found on Sumble and Asana has no web profile fields`;
        await logOpsEvent({
          action: "sync",
          source: "portco_web",
          status: "error",
          summary: error,
          records: 0,
          details: { company: companyName },
        });
        return { ...empty, ok: false, error };
      }

      await logOpsEvent({
        action: "sync",
        source: "portco_web",
        status: "ok",
        summary: `Web sync for ${companyName}${sumbleDomain ? ` · ${sumbleDomain}` : ""}`,
        records: sheetFieldsUpdated.length || 1,
        details: {
          company: companyName,
          sumbleOrgId: sumbleOrgId ?? "",
          domain: sumbleDomain || "",
          website: website || "",
          linkedin: linkedinUrl || "",
          sheetUpdated: sheetFieldsUpdated.join(", ") || "none",
        },
        items: [
          sumbleDomain ? `[sumble] matched ${sumbleDomain}` : undefined,
          website ? `[web] website ${website}` : undefined,
          linkedinUrl ? `[web] linkedin ${linkedinUrl}` : undefined,
          location ? `[web] location ${location}` : undefined,
          ...sheetFieldsUpdated.map((c) => `[sheet] filled blank ${c}`),
        ].filter(Boolean) as string[],
      });

      return result;
    } catch (err) {
      console.error("[portco] syncPortcoFromWeb failed:", err);
      const message = err instanceof Error ? err.message : "Web PortCo sync failed";
      await logOpsEvent({
        action: "sync",
        source: "portco_web",
        status: "error",
        summary: message,
        records: 0,
        details: { company: companyName },
      });
      return { ...empty, ok: false, error: message };
    }
  });
