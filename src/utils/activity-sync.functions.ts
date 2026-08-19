import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { fetchActivities } from "./asana.server";
import { fetchAliasActivities } from "./gmail.server";
import {
  buildContacts,
  buildPortfolioCompanies,
  buildActivities,
  appendInteractionRows,
  upsertPortcoIntros,
  fetchSheetTab,
  syncActivityTracks as syncActivityTracksToSheets,
  logOpsEvent,
  shipNotesToEventAttendance,
  TAB_NAMES,
  type InteractionRowInput,
  type PortcoIntroUpsert,
  type ActivityTrackSyncResult,
} from "./sheets.server";
import { isGmailCrmSyncConfigured } from "./gmail.server";
import { parseToIsoDate, todayIso } from "@/lib/sheet-date";
import { matchActivitiesToContact, resolvePortcosMentioned } from "@/lib/activity-match";
import {
  applyAttributionCorrections,
  canonicalizeActivities,
  dedupeAcrossSources,
  subjectTwinKey,
} from "@/lib/activity-canonical";
import { inferEngagementSource } from "@/lib/engagement-source";
import { loadAttributionCorrections, refineAttribution } from "./activity-attribution.server";
import { sourceMissingContactsFromActivities } from "./activity-sync-source.server";
import type { AsanaActivity, Contact, InteractionType } from "@/lib/types";

/** Which mailbox/tracker to pull BD/GTM activities from. */
export type ActivitySyncSource = "all" | "asana" | "gmail";

const sourceSchema = z
  .object({ source: z.enum(["all", "asana", "gmail"]).optional() })
  .optional();

// Classify a BD/GTM activity into the CRM interaction taxonomy from its
// free-text name + type/channel. Gmail calendar appointments land as "meeting";
// other Gmail alias mail defaults to "email".
function activityInteractionType(a: AsanaActivity): InteractionType {
  const t = (a.type || "").toLowerCase();
  if (t === "meeting" || t === "call" || t === "event" || t === "intro") {
    return t as InteractionType;
  }
  if (t === "email" || a.gid.startsWith("gmail-")) return "email";
  const hay = `${a.type || ""} ${a.name || ""}`.toLowerCase();
  if (/\bintro(duction|s|ed|ing)?\b/.test(hay)) return "intro";
  if (/meeting|met with|met w\/|onsite|on-site|dinner|lunch|coffee|visit|qbr|demo\b/.test(hay))
    return "meeting";
  if (/\bcall\b|phone|zoom|webex|dial|spoke with/.test(hay)) return "call";
  if (/conference|webinar|summit|event|booth|expo/.test(hay)) return "event";
  if (/email|e-mail|outreach|reached out|follow[- ]?up email|sent/.test(hay)) return "email";
  return "note";
}

function sourceRefFor(a: AsanaActivity): string {
  // Gmail activities already carry a `gmail-` prefix as their gid.
  if (a.gid.startsWith("gmail-")) return a.gid;
  return `asana:${a.gid}`;
}

// The primary email for a contact (Notes rows join on the first address).
function primaryEmail(c: Contact): string {
  return (c.email || "").split(";")[0]?.trim().toLowerCase() || "";
}

// A synced Notes row is keyed by (contact email, activity gid) so re-running the
// sync never double-logs the same activity onto the same person.
export function syncKey(email: string, gid: string): string {
  return `${email.toLowerCase()}|${gid}`;
}

/**
 * Auto follow-up: last touch was outbound, and it's older than N days.
 * With thread-collapsed activities, "no inbound since" is already encoded in
 * status === "Sent" (an inbound reply would make the newest message Received).
 */
export function activityRequiresFollowUp(
  a: Pick<AsanaActivity, "status" | "date">,
  nowMs: number = Date.now(),
  minAgeDays: number = Number(process.env.ACTIVITY_FOLLOWUP_DAYS) || 7,
): boolean {
  if ((a.status || "").toLowerCase() !== "sent") return false;
  if (!a.date) return false;
  const iso = parseToIsoDate(a.date);
  if (!iso) return false;
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return (nowMs - t) / 86_400_000 >= Math.max(1, minAgeDays);
}

/** How many (email|gid) pairs would be newly logged against an existing key set. */
export function countNewSyncRows(
  pairs: { email: string; gid: string }[],
  existing: Set<string>,
): number {
  let n = 0;
  const queued = new Set<string>();
  for (const p of pairs) {
    const key = syncKey(p.email, p.gid);
    if (existing.has(key) || queued.has(key)) continue;
    queued.add(key);
    n++;
  }
  return n;
}

export interface SyncActivitiesResult {
  ok: boolean;
  error?: string;
  /** Total BD/GTM activities pulled from Asana + Gmail aliases. */
  activities: number;
  /** Activities that matched at least one CRM contact. */
  matched: number;
  /** New interaction rows written this run. */
  logged: number;
  /** (contact, activity) pairs skipped because they were already synced. */
  skipped: number;
  /** Distinct contacts that received at least one new row. */
  contactsTouched: number;
  /** New PortCo engagement rows written from mentioned portfolio companies. */
  portcosLogged: number;
  /** Existing PortCos Introduced rows that had blank fields filled. */
  portcosBackfilled: number;
  /** New Contacts rows auto-created from external People on activities. */
  contactsCreated: number;
}

const EMPTY: SyncActivitiesResult = {
  ok: true,
  activities: 0,
  matched: 0,
  logged: 0,
  skipped: 0,
  contactsTouched: 0,
  portcosLogged: 0,
  portcosBackfilled: 0,
  contactsCreated: 0,
};

// Read the existing Notes tab and collect the set of already-synced
// (email|gid) keys, so we only append genuinely-new activity rows.
async function existingSyncKeys(): Promise<Set<string>> {
  const rows = await fetchSheetTab(TAB_NAMES.interactions).catch(() => [] as string[][]);
  const keys = new Set<string>();
  if (rows.length === 0) return keys;
  const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const emailIdx = header.indexOf("contact email");
  const refIdx = header.indexOf("source ref");
  if (emailIdx === -1 || refIdx === -1) return keys; // columns not present yet → nothing synced
  for (const row of rows.slice(1)) {
    const ref = (row[refIdx] || "").trim();
    const email = (row[emailIdx] || "").trim();
    if (!email || !ref) continue;
    let gid = "";
    if (ref.startsWith("asana:")) gid = ref.slice("asana:".length).trim();
    else if (ref.startsWith("gmail-")) gid = ref;
    else if (ref.startsWith("gmail:")) gid = `gmail-${ref.slice("gmail:".length).trim()}`;
    if (gid) keys.add(syncKey(email, gid));
  }
  return keys;
}

/**
 * Asana Notes already on the sheet, keyed by email|normalizedSubject.
 * Lets Gmail sync skip twins even when the Asana task is outside the current
 * fetch window (or was synced on a prior run).
 */
async function existingAsanaSubjectTwinKeys(): Promise<Set<string>> {
  const rows = await fetchSheetTab(TAB_NAMES.interactions).catch(() => [] as string[][]);
  const keys = new Set<string>();
  if (rows.length < 2) return keys;
  const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const emailIdx = header.indexOf("contact email");
  const noteIdx = header.indexOf("note content");
  const refIdx = header.indexOf("source ref");
  if (emailIdx === -1 || noteIdx === -1 || refIdx === -1) return keys;
  for (const row of rows.slice(1)) {
    const ref = (row[refIdx] || "").trim();
    if (!ref.startsWith("asana:")) continue;
    const email = (row[emailIdx] || "").trim();
    const note = row[noteIdx] || "";
    const subject = note.split(/\s·\sPortCo:/i)[0] || note;
    const key = subjectTwinKey(email, subject);
    if (key) keys.add(key);
  }
  return keys;
}

// Pull BD/GTM activities from Asana and/or Gmail aliases, drop Gmail twins of
// Asana tasks when both are loaded, then canonicalize Person/Company against
// the CRM so sheets and contact pages always agree on spelling.
async function loadAllTrackActivities(
  contacts?: Contact[],
  portfolioNames?: string[],
  source: ActivitySyncSource = "all",
): Promise<AsanaActivity[]> {
  const wantAsana = source === "all" || source === "asana";
  const wantGmail = source === "all" || source === "gmail";
  // Gmail-only sync does not hit Asana — twins are dropped via Notes sheet keys.
  // When both feeds are requested, a down Asana/Gmail must not fail the other.
  const [asana, gmail] = await Promise.all([
    wantAsana
      ? fetchActivities().catch((err) => {
          console.error("[activity] Asana fetch failed:", err);
          if (!wantGmail) throw err;
          return [] as AsanaActivity[];
        })
      : Promise.resolve([] as AsanaActivity[]),
    wantGmail
      ? fetchAliasActivities().catch((err) => {
          console.error("[activity] Gmail alias fetch failed:", err);
          if (!wantAsana) throw err;
          return [] as AsanaActivity[];
        })
      : Promise.resolve([] as AsanaActivity[]),
  ]);
  const crm = contacts ?? (await buildContacts().catch(() => [] as Contact[]));
  const names =
    portfolioNames ??
    (await buildPortfolioCompanies().catch(() => [] as { name: string }[]))
      .map((c) => c.name)
      .filter(Boolean);
  const merged =
    gmail.length > 0 && asana.length > 0
      ? dedupeAcrossSources([...asana, ...gmail])
      : { activities: [...asana, ...gmail], dropped: 0 };
  if (merged.dropped > 0) {
    console.log(`[activity] dropped ${merged.dropped} Gmail duplicates of Asana tasks`);
  }
  // Keep only the feed(s) the caller asked to log.
  let forLog = merged.activities;
  if (source === "gmail") forLog = forLog.filter((a) => a.gid.startsWith("gmail-"));
  else if (source === "asana") forLog = forLog.filter((a) => !a.gid.startsWith("gmail-"));
  const canonical = canonicalizeActivities(forLog, crm, names);
  // Replay human corrections, then let Gemini decide only the ambiguous rest.
  return await refineAttribution(canonical, crm, names).catch(() => canonical);
}

/** Live feed plus BD/GTM sheet rows (live wins on GID) so PortCo tags backfill
 *  even when this run's Asana/Gmail fetch is partial. */
async function activitiesIncludingSheet(live: AsanaActivity[]): Promise<AsanaActivity[]> {
  const fromSheets = await buildActivities().catch(() => [] as AsanaActivity[]);
  const byGid = new Map<string, AsanaActivity>();
  for (const a of fromSheets) {
    if (a.gid) byGid.set(a.gid, a);
  }
  for (const a of live) {
    if (a.gid) byGid.set(a.gid, a);
  }
  const merged = [...byGid.values()];
  const corrections = await loadAttributionCorrections().catch(() => []);
  return applyAttributionCorrections(merged, corrections);
}

function contactUridByEmail(contacts: Contact[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of contacts) {
    const urid = (c.urid || "").trim();
    if (!urid) continue;
    for (const e of (c.email || "").split(/[;,]/)) {
      const key = e.trim().toLowerCase();
      if (key.includes("@") && !map.has(key)) map.set(key, urid);
    }
  }
  return map;
}

function sourceLabel(source: ActivitySyncSource): string {
  if (source === "asana") return "Asana";
  if (source === "gmail") return "Gmail aliases";
  return "Asana + Gmail aliases";
}

// Pull BD/GTM activities and log each one as a read-only interaction on the CRM
// contacts it matches. When the activity mentions a portfolio company, also
// write a PortCos Introduced row. Idempotent on Notes (email|gid) and PortCo
// (email|portco). Pass `{ source: "gmail" }` for alias mail only.
export const syncAsanaActivities = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => sourceSchema.parse(data) ?? {})
  .handler(async ({ data }): Promise<SyncActivitiesResult> => {
    const source: ActivitySyncSource = data?.source ?? "all";
    try {
      // CRM first: activities are canonicalized against Contacts + PortCo names.
      let [contacts, already, asanaSubjectKeys, companies] = await Promise.all([
        buildContacts(),
        existingSyncKeys(),
        existingAsanaSubjectTwinKeys(),
        buildPortfolioCompanies().catch(() => [] as { name: string }[]),
      ]);
      const portfolioNames = companies.map((c) => c.name).filter(Boolean);

      const activities = await loadAllTrackActivities(contacts, portfolioNames, source);
      const tagActivities = await activitiesIncludingSheet(activities);

      // Create missing external people (e.g. Zach on a Gmail BD row) before
      // matching Notes — otherwise sync only touches contacts already in CRM.
      let contactsCreated = 0;
      if (activities.length > 0) {
        try {
          const sourced = await sourceMissingContactsFromActivities(activities);
          contactsCreated = sourced.createdCount;
          if (contactsCreated > 0) {
            contacts = await buildContacts();
          }
        } catch (e) {
          console.error("[activity] auto-source contacts failed:", e);
        }
      }

      const today = todayIso();
      const queued = new Set<string>();
      const rows: InteractionRowInput[] = [];
      const portcoFills: PortcoIntroUpsert[] = [];
      /** Asana subjects queued this run — blocks same-batch Gmail twins. */
      const queuedAsanaSubjects = new Set<string>();
      const matchedGids = new Set<string>();
      const touchedEmails = new Set<string>();
      let skipped = 0;
      let skippedGmailTwins = 0;

      for (const contact of contacts) {
        const email = primaryEmail(contact);
        if (!email) continue;
        const contactEmail = (contact.email || "").split(";")[0]?.trim() || email;

        for (const a of matchActivitiesToContact(tagActivities, contact)) {
          for (const portco of resolvePortcosMentioned(a, portfolioNames)) {
            portcoFills.push({
              email: contactEmail,
              portcoName: portco,
              date: parseToIsoDate(a.date) || today,
              source: inferEngagementSource(a),
              urid: contact.urid,
            });
          }
        }

        const matches = matchActivitiesToContact(activities, contact);
        for (const a of matches) {
          matchedGids.add(a.gid);
          const portcos = resolvePortcosMentioned(a, portfolioNames);

          const key = syncKey(email, a.gid);
          if (already.has(key)) {
            skipped++;
            continue;
          }
          if (queued.has(key)) continue; // same pair reached via two match rules

          // Gmail twin of an Asana Note (already on sheet or queued this run) → skip.
          const twin = subjectTwinKey(email, a.name);
          if (
            a.gid.startsWith("gmail-") &&
            twin &&
            (asanaSubjectKeys.has(twin) || queuedAsanaSubjects.has(twin))
          ) {
            skipped++;
            skippedGmailTwins++;
            continue;
          }

          queued.add(key);
          if (!a.gid.startsWith("gmail-") && twin) {
            queuedAsanaSubjects.add(twin);
            asanaSubjectKeys.add(twin);
          }

          const summary = portcos.length > 0 ? `${a.name} · PortCo: ${portcos.join(", ")}` : a.name;

          rows.push({
            email: contactEmail,
            date: parseToIsoDate(a.date) || today,
            summary,
            type: activityInteractionType(a),
            requiresFollowUp: activityRequiresFollowUp(a),
            urid: contact.urid,
            sourceRef: sourceRefFor(a),
            owner: a.owner || undefined,
          });
          touchedEmails.add(email);
        }
      }

      if (rows.length > 0) await appendInteractionRows(rows);
      // #region agent log
      fetch("http://127.0.0.1:7724/ingest/5184a65b-0c76-4274-b203-81774fe31d23", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "3375d3" },
        body: JSON.stringify({
          sessionId: "3375d3",
          hypothesisId: "B",
          location: "activity-sync.functions.ts:sync",
          message: "Trail row dates vs today fallback",
          data: {
            today,
            queued: rows.length,
            skipped,
            skippedGmailTwins,
            usedToday: rows.filter((r) => r.date === today).length,
            usedParsed: rows.filter((r) => r.date && r.date !== today).length,
            undatedInput: rows.filter((r) => !r.date).length,
            byOrigin: {
              gmail: rows.filter((r) => (r.sourceRef || "").startsWith("gmail")).length,
              asana: rows.filter((r) => (r.sourceRef || "").startsWith("asana")).length,
            },
            samples: rows.slice(0, 8).map((r) => ({
              date: r.date,
              usedToday: r.date === today,
              origin: (r.sourceRef || "").startsWith("gmail")
                ? "gmail"
                : (r.sourceRef || "").startsWith("asana")
                  ? "asana"
                  : "other",
            })),
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      console.log(
        `[activity] PortCo intros: ${portcoFills.length} candidate fills from ${tagActivities.length} activities`,
      );
      const portcoRes = await upsertPortcoIntros(portcoFills, {
        uridByEmail: contactUridByEmail(contacts),
        canonicalPortcoNames: portfolioNames,
      });
      console.log(
        `[activity] PortCo intros wrote +${portcoRes.appended} rows, ${portcoRes.backfilled} backfilled, ${portcoRes.sourcesMerged} sources merged`,
      );
      const portcosMerged = portcoRes.sourcesMerged;

      const result = {
        ok: true as const,
        activities: activities.length,
        matched: matchedGids.size,
        logged: rows.length,
        skipped,
        contactsTouched: touchedEmails.size,
        portcosLogged: portcoRes.appended,
        portcosBackfilled: portcoRes.backfilled + portcosMerged,
        contactsCreated,
      };
      const byOrigin = { asana: 0, gmail: 0 };
      for (const r of rows) {
        if ((r.sourceRef || "").startsWith("gmail")) byOrigin.gmail++;
        else byOrigin.asana++;
      }
      await logOpsEvent({
        action: "sync",
        source: "bd_gtm_activities",
        status: "ok",
        summary:
          `Synced ${result.activities} BD/GTM activities (${sourceLabel(source)}) · logged ${result.logged} notes · ${result.portcosLogged} PortCo tags` +
          (result.portcosBackfilled ? ` · ${result.portcosBackfilled} backfilled` : "") +
          (skippedGmailTwins ? ` · ${skippedGmailTwins} Gmail/Asana twins skipped` : "") +
          (result.contactsCreated > 0 ? ` · +${result.contactsCreated} contacts` : ""),
        records: result.logged,
        details: {
          feed: source,
          activities: result.activities,
          matched: result.matched,
          skipped: result.skipped,
          skippedGmailTwins,
          contactsTouched: result.contactsTouched,
          portcosLogged: result.portcosLogged,
          portcosBackfilled: result.portcosBackfilled,
          portcosMerged,
          contactsCreated: result.contactsCreated,
          fromAsana: byOrigin.asana,
          fromGmail: byOrigin.gmail,
        },
        items: [
          ...rows.map((r) => {
            const origin = (r.sourceRef || "").startsWith("gmail") ? "gmail" : "asana";
            return `${r.email} ← ${r.summary || "(no subject)"} [${r.type || "note"} · ${origin}${r.date ? ` · ${r.date}` : ""}]`;
          }),
          ...portcoFills.slice(0, 40).map((r) => `[portco] ${r.email} ← ${r.portcoName} · ${r.date || ""}`),
        ],
      });

      // When Gmail CRM deepen is off, still backfill Events from Meeting: / [Event:] Notes.
      if (!isGmailCrmSyncConfigured()) {
        try {
          await shipNotesToEventAttendance();
        } catch (e) {
          console.error("[activity] shipNotesToEventAttendance failed:", e);
        }
      }

      return result;
    } catch (err) {
      console.error("[activity] syncAsanaActivities failed:", err);
      const message = err instanceof Error ? err.message : "Sync failed";
      await logOpsEvent({
        action: "sync",
        source: "bd_gtm_activities",
        status: "error",
        summary: message,
        records: 0,
        details: { feed: source },
      });
      return { ...EMPTY, ok: false, error: message };
    }
  });

export interface ActivityTrackResult extends ActivityTrackSyncResult {
  ok: boolean;
  error?: string;
}

const EMPTY_TRACK: ActivityTrackResult = {
  ok: true,
  bdLogged: 0,
  gtmLogged: 0,
  bdSkipped: 0,
  gtmSkipped: 0,
  bdItems: [],
  gtmItems: [],
};

// Mirror BD/GTM activities into the "BD" and "GTM" sheet tabs. Creates the tabs
// on first run; dedupes by Activity GID. Pass `{ source: "gmail" }` for aliases only.
export const syncActivityTracks = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => sourceSchema.parse(data) ?? {})
  .handler(async ({ data }): Promise<ActivityTrackResult> => {
    const source: ActivitySyncSource = data?.source ?? "all";
    try {
      const activities = await loadAllTrackActivities(undefined, undefined, source);
      if (activities.length === 0) {
        await logOpsEvent({
          action: "sync",
          source: "bd_gtm_tabs",
          status: "ok",
          summary: `No BD/GTM activities to mirror into sheet tabs (${sourceLabel(source)})`,
          records: 0,
          details: { feed: source },
        });
        return EMPTY_TRACK;
      }
      const res = await syncActivityTracksToSheets(activities);
      const items = [
        ...res.bdItems.map((t) => `[BD] ${t}`),
        ...res.gtmItems.map((t) => `[GTM] ${t}`),
      ];
      await logOpsEvent({
        action: "sync",
        source: "bd_gtm_tabs",
        status: "ok",
        summary: `Mirrored ${sourceLabel(source)} into BD/GTM tabs · BD +${res.bdLogged}, GTM +${res.gtmLogged}`,
        records: res.bdLogged + res.gtmLogged,
        details: {
          feed: source,
          bdLogged: res.bdLogged,
          gtmLogged: res.gtmLogged,
          bdSkipped: res.bdSkipped,
          gtmSkipped: res.gtmSkipped,
          activities: activities.length,
        },
        items,
      });
      return { ok: true, ...res };
    } catch (err) {
      console.error("[activity] syncActivityTracks failed:", err);
      const message = err instanceof Error ? err.message : "Sync failed";
      await logOpsEvent({
        action: "sync",
        source: "bd_gtm_tabs",
        status: "error",
        summary: message,
        records: 0,
        details: { feed: source },
      });
      return { ...EMPTY_TRACK, ok: false, error: message };
    }
  });
