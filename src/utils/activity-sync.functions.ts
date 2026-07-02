import { createServerFn } from "@tanstack/react-start";
import { fetchActivities } from "./asana.server";
import {
  buildContacts,
  appendInteractionRows,
  fetchSheetTab,
  TAB_NAMES,
  type InteractionRowInput,
} from "./sheets.server";
import { matchActivitiesToContact } from "@/lib/activity-match";
import type { AsanaActivity, Contact, InteractionType } from "@/lib/types";

// Classify an Asana BD/GTM activity into the CRM interaction taxonomy from its
// free-text name + type/channel. These are curated touchpoints, so we only
// upgrade to a specific type when the text clearly says so; otherwise "note".
function activityInteractionType(a: AsanaActivity): InteractionType {
  const hay = `${a.type || ""} ${a.name || ""}`.toLowerCase();
  if (/\bintro(duction|s|ed|ing)?\b/.test(hay)) return "intro";
  if (/meeting|met with|met w\/|onsite|on-site|dinner|lunch|coffee|visit|qbr|demo\b/.test(hay)) return "meeting";
  if (/\bcall\b|phone|zoom|webex|dial|spoke with/.test(hay)) return "call";
  if (/conference|webinar|summit|event|booth|expo/.test(hay)) return "event";
  if (/email|e-mail|outreach|reached out|follow[- ]?up email|sent/.test(hay)) return "email";
  return "note";
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

export interface SyncActivitiesResult {
  ok: boolean;
  error?: string;
  /** Total BD/GTM activities pulled from Asana. */
  activities: number;
  /** Activities that matched at least one CRM contact. */
  matched: number;
  /** New interaction rows written this run. */
  logged: number;
  /** (contact, activity) pairs skipped because they were already synced. */
  skipped: number;
  /** Distinct contacts that received at least one new row. */
  contactsTouched: number;
}

const EMPTY: SyncActivitiesResult = {
  ok: true,
  activities: 0,
  matched: 0,
  logged: 0,
  skipped: 0,
  contactsTouched: 0,
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
    if (!ref.startsWith("asana:")) continue;
    const gid = ref.slice("asana:".length).trim();
    const email = (row[emailIdx] || "").trim();
    if (gid && email) keys.add(syncKey(email, gid));
  }
  return keys;
}

// Pull every BD/GTM activity from Asana and log each one as a read-only
// interaction on the CRM contacts it matches. Idempotent: deduped by
// (contact email, activity gid), so it's safe to run repeatedly — a re-run only
// picks up activities added/newly-matched since last time. Asana remains the
// source of truth; synced rows are tagged and not hand-editable.
export const syncAsanaActivities = createServerFn({ method: "POST" }).handler(
  async (): Promise<SyncActivitiesResult> => {
    try {
      const activities = await fetchActivities();
      if (activities.length === 0) return EMPTY;

      const [contacts, already] = await Promise.all([buildContacts(), existingSyncKeys()]);

      const today = new Date().toISOString().slice(0, 10);
      const queued = new Set<string>();
      const rows: InteractionRowInput[] = [];
      const matchedGids = new Set<string>();
      const touchedEmails = new Set<string>();
      let skipped = 0;

      for (const contact of contacts) {
        const email = primaryEmail(contact);
        if (!email) continue;
        const matches = matchActivitiesToContact(activities, contact);
        for (const a of matches) {
          matchedGids.add(a.gid);
          const key = syncKey(email, a.gid);
          if (already.has(key)) {
            skipped++;
            continue;
          }
          if (queued.has(key)) continue; // same pair reached via two match rules
          queued.add(key);
          rows.push({
            email: (contact.email || "").split(";")[0]?.trim() || email,
            date: a.date || today,
            summary: a.name,
            type: activityInteractionType(a),
            requiresFollowUp: false,
            urid: contact.urid,
            sourceRef: `asana:${a.gid}`,
          });
          touchedEmails.add(email);
        }
      }

      if (rows.length > 0) await appendInteractionRows(rows);

      return {
        ok: true,
        activities: activities.length,
        matched: matchedGids.size,
        logged: rows.length,
        skipped,
        contactsTouched: touchedEmails.size,
      };
    } catch (err) {
      console.error("[asana] syncAsanaActivities failed:", err);
      return { ...EMPTY, ok: false, error: err instanceof Error ? err.message : "Sync failed" };
    }
  },
);
