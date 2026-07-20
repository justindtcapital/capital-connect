import { createServerFn } from "@tanstack/react-start";
import { fetchActivities } from "./asana.server";
import { fetchAliasActivities } from "./gmail.server";
import {
  buildContacts,
  buildPortfolioCompanies,
  appendInteractionRows,
  appendSheetRows,
  ensureColumn,
  fetchSheetTab,
  syncActivityTracks as syncActivityTracksToSheets,
  logOpsEvent,
  shipNotesToEventAttendance,
  TAB_NAMES,
  type InteractionRowInput,
  type ActivityTrackSyncResult,
} from "./sheets.server";
import { isGmailCrmSyncConfigured } from "./gmail.server";
import { matchActivitiesToContact, resolvePortcosMentioned } from "@/lib/activity-match";
import type { AsanaActivity, Contact, InteractionType } from "@/lib/types";

// Classify a BD/GTM activity into the CRM interaction taxonomy from its
// free-text name + type/channel. Emails from Gmail aliases always land as "email".
function activityInteractionType(a: AsanaActivity): InteractionType {
  if (a.gid.startsWith("gmail-") || (a.type || "").toLowerCase() === "email") return "email";
  const hay = `${a.type || ""} ${a.name || ""}`.toLowerCase();
  if (/\bintro(duction|s|ed|ing)?\b/.test(hay)) return "intro";
  if (/meeting|met with|met w\/|onsite|on-site|dinner|lunch|coffee|visit|qbr|demo\b/.test(hay)) return "meeting";
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
function syncKey(email: string, gid: string): string {
  return `${email.toLowerCase()}|${gid}`;
}

function portcoEngKey(email: string, portco: string): string {
  return `${email.trim().toLowerCase()}|${portco.trim().toLowerCase()}`;
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
}

const EMPTY: SyncActivitiesResult = {
  ok: true,
  activities: 0,
  matched: 0,
  logged: 0,
  skipped: 0,
  contactsTouched: 0,
  portcosLogged: 0,
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

/** Existing PortCos Introduced keys (email|portco), case-insensitive. */
async function existingPortcoEngagementKeys(): Promise<Set<string>> {
  const rows = await fetchSheetTab(TAB_NAMES.portcoIntros).catch(() => [] as string[][]);
  const keys = new Set<string>();
  if (rows.length < 2) return keys;
  const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const emailIdx = header.indexOf("contact email");
  const portcoIdx = header.indexOf("portco name");
  if (emailIdx === -1 || portcoIdx === -1) return keys;
  for (const row of rows.slice(1)) {
    const email = (row[emailIdx] || "").trim();
    const portco = (row[portcoIdx] || "").trim();
    if (email && portco) keys.add(portcoEngKey(email, portco));
  }
  return keys;
}

async function loadAllTrackActivities(): Promise<AsanaActivity[]> {
  const [asana, gmail] = await Promise.all([fetchActivities(), fetchAliasActivities()]);
  return [...asana, ...gmail];
}

// Pull every BD/GTM activity from Asana + Gmail aliases and log each one as a
// read-only interaction on the CRM contacts it matches. When the activity
// mentions a portfolio company, also write a PortCos Introduced row (source =
// "activity interaction"). Idempotent on Notes (email|gid) and PortCo (email|portco).
export const syncAsanaActivities = createServerFn({ method: "POST" }).handler(
  async (): Promise<SyncActivitiesResult> => {
    try {
      const activities = await loadAllTrackActivities();
      if (activities.length === 0) {
        await logOpsEvent({
          action: "sync",
          source: "bd_gtm_activities",
          status: "ok",
          summary: "No BD/GTM activities found (Asana + Gmail aliases)",
          records: 0,
        });
        return EMPTY;
      }

      const [contacts, already, portcoKeys, companies] = await Promise.all([
        buildContacts(),
        existingSyncKeys(),
        existingPortcoEngagementKeys(),
        buildPortfolioCompanies().catch(() => [] as { name: string }[]),
      ]);
      const portfolioNames = companies.map((c) => c.name).filter(Boolean);

      const today = new Date().toISOString().slice(0, 10);
      const queued = new Set<string>();
      const rows: InteractionRowInput[] = [];
      const portcoRows: string[][] = [];
      const queuedPortco = new Set<string>();
      const matchedGids = new Set<string>();
      const touchedEmails = new Set<string>();
      let skipped = 0;

      for (const contact of contacts) {
        const email = primaryEmail(contact);
        if (!email) continue;
        const contactEmail = (contact.email || "").split(";")[0]?.trim() || email;
        const matches = matchActivitiesToContact(activities, contact);
        for (const a of matches) {
          matchedGids.add(a.gid);
          const portcos = resolvePortcosMentioned(a, portfolioNames);

          // PortCo tags: also backfill for already-synced Notes pairs so a
          // re-run after this feature ships picks up missing engagements.
          for (const portco of portcos) {
            const pk = portcoEngKey(email, portco);
            if (portcoKeys.has(pk) || queuedPortco.has(pk)) continue;
            queuedPortco.add(pk);
            // Order mirrors addPortcoIntro: email, portco, date, engagement source.
            portcoRows.push([contactEmail, portco, a.date || today, "activity interaction"]);
          }

          const key = syncKey(email, a.gid);
          if (already.has(key)) {
            skipped++;
            continue;
          }
          if (queued.has(key)) continue; // same pair reached via two match rules
          queued.add(key);

          const summary =
            portcos.length > 0
              ? `${a.name} · PortCo: ${portcos.join(", ")}`
              : a.name;

          rows.push({
            email: contactEmail,
            date: a.date || today,
            summary,
            type: activityInteractionType(a),
            requiresFollowUp: false,
            urid: contact.urid,
            sourceRef: sourceRefFor(a),
            owner: a.owner || undefined,
          });
          touchedEmails.add(email);
        }
      }

      if (rows.length > 0) await appendInteractionRows(rows);
      if (portcoRows.length > 0) {
        await ensureColumn(TAB_NAMES.portcoIntros, "Engagement Source");
        await appendSheetRows(TAB_NAMES.portcoIntros, portcoRows);
      }

      const result = {
        ok: true as const,
        activities: activities.length,
        matched: matchedGids.size,
        logged: rows.length,
        skipped,
        contactsTouched: touchedEmails.size,
        portcosLogged: portcoRows.length,
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
        summary: `Synced ${result.activities} BD/GTM activities · logged ${result.logged} notes · ${result.portcosLogged} PortCo tags`,
        records: result.logged,
        details: {
          activities: result.activities,
          matched: result.matched,
          skipped: result.skipped,
          contactsTouched: result.contactsTouched,
          portcosLogged: result.portcosLogged,
          fromAsana: byOrigin.asana,
          fromGmail: byOrigin.gmail,
        },
        items: [
          ...rows.map((r) => {
            const origin = (r.sourceRef || "").startsWith("gmail") ? "gmail" : "asana";
            return `${r.email} ← ${r.summary || "(no subject)"} [${r.type || "note"} · ${origin}${r.date ? ` · ${r.date}` : ""}]`;
          }),
          ...portcoRows.map((r) => `[portco] ${r[0]} ← ${r[1]} · ${r[2]}`),
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
      });
      return { ...EMPTY, ok: false, error: message };
    }
  },
);

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

// Mirror every BD/GTM activity from Asana + Gmail aliases into the "BD" and
// "GTM" sheet tabs. Creates the tabs on first run; dedupes by Activity GID.
export const syncActivityTracks = createServerFn({ method: "POST" }).handler(
  async (): Promise<ActivityTrackResult> => {
    try {
      const activities = await loadAllTrackActivities();
      if (activities.length === 0) {
        await logOpsEvent({
          action: "sync",
          source: "bd_gtm_tabs",
          status: "ok",
          summary: "No BD/GTM activities to mirror into sheet tabs",
          records: 0,
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
        summary: `Mirrored activities into BD/GTM tabs · BD +${res.bdLogged}, GTM +${res.gtmLogged}`,
        records: res.bdLogged + res.gtmLogged,
        details: {
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
      });
      return { ...EMPTY_TRACK, ok: false, error: message };
    }
  },
);
