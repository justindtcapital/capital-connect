import { createServerFn } from "@tanstack/react-start";
import {
  fetchCrmMailboxTouches,
  isGmailCrmSyncConfigured,
  type CrmMailboxTouch,
  type GmailMessage,
} from "./gmail.server";
import {
  buildContacts,
  appendInteractionRows,
  fetchSheetTab,
  logOpsEvent,
  logEmailActivity,
  TAB_NAMES,
  ensureEventAttendanceBatch,
  shipNotesToEventAttendance,
  cleanCalendarEventName,
  type InteractionRowInput,
  type EventAttendanceInput,
} from "./sheets.server";
import type { Contact, InteractionType } from "@/lib/types";

function syncKey(email: string, gid: string): string {
  return `${email.toLowerCase()}|${gid}`;
}

function primaryEmail(c: Contact): string {
  return (c.email || "").split(";")[0]?.trim().toLowerCase() || "";
}

function allEmails(c: Contact): string[] {
  return (c.email || "")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

/** Message participants we might match to CRM (from / to / cc). */
function participantEmails(m: GmailMessage): string[] {
  const out = new Set<string>();
  if (m.fromEmail) out.add(m.fromEmail.toLowerCase());
  for (const e of m.toEmails) out.add(e.toLowerCase());
  for (const e of m.ccEmails) out.add(e.toLowerCase());
  return [...out];
}

async function existingGmailSyncKeys(): Promise<Set<string>> {
  const rows = await fetchSheetTab(TAB_NAMES.interactions).catch(() => [] as string[][]);
  const keys = new Set<string>();
  if (rows.length === 0) return keys;
  const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const emailIdx = header.indexOf("contact email");
  const refIdx = header.indexOf("source ref");
  if (emailIdx === -1 || refIdx === -1) return keys;
  for (const row of rows.slice(1)) {
    const ref = (row[refIdx] || "").trim();
    const email = (row[emailIdx] || "").trim();
    if (!email || !ref) continue;
    // Normalize any gmail-* / gmail: / asana: refs into a comparable gid.
    let gid = "";
    if (ref.startsWith("asana:")) gid = ref.slice("asana:".length).trim();
    else if (ref.startsWith("gmail-")) gid = ref;
    else if (ref.startsWith("gmail:")) gid = `gmail-${ref.slice("gmail:".length).trim()}`;
    if (gid) keys.add(syncKey(email, gid));
  }
  return keys;
}

function messageGids(msgId: string): string[] {
  // CRM deepen uses gmail-crm-*; BD/GTM aliases use gmail-{id}. Dedup both.
  return [`gmail-crm-${msgId}`, `gmail-${msgId}`];
}

function alreadyLogged(keys: Set<string>, email: string, msgId: string): boolean {
  return messageGids(msgId).some((g) => keys.has(syncKey(email, g)));
}

function touchSummary(t: CrmMailboxTouch): string {
  const prefix = t.kind === "calendar" ? "Meeting" : "Email";
  return `${prefix}: ${t.message.subject}`;
}

function touchType(t: CrmMailboxTouch): InteractionType {
  return t.kind === "calendar" ? "meeting" : "email";
}

export interface SyncGmailCrmResult {
  ok: boolean;
  error?: string;
  /** True when GMAIL_CRM_SYNC_ENABLED is off — not an error. */
  skipped: boolean;
  /** Messages pulled from the mailbox. */
  messages: number;
  /** Distinct CRM contacts matched. */
  matchedContacts: number;
  /** New Notes rows written. */
  logged: number;
  /** Pairs already present (gmail-crm-* or alias gmail-*). */
  alreadySynced: number;
  /** Email Activity rows appended (sent mail only). */
  emailActivityLogged: number;
  /** Events-tab attendance rows written (calendar + Notes backfill). */
  eventsLogged: number;
  /** App Events catalog rows created. */
  eventCatalogLogged: number;
}

const EMPTY: SyncGmailCrmResult = {
  ok: true,
  skipped: false,
  messages: 0,
  matchedContacts: 0,
  logged: 0,
  alreadySynced: 0,
  emailActivityLogged: 0,
  eventsLogged: 0,
  eventCatalogLogged: 0,
};

/**
 * Sync recent Gmail sent mail + calendar invites onto CRM contacts as Notes
 * (and Email Activity for outbound). Matching is by email address. Idempotent
 * via Source Ref `gmail-crm-{messageId}` (also skips if BD/GTM alias already
 * logged the same message as `gmail-{id}`).
 */
export const syncGmailCrmTouches = createServerFn({ method: "POST" }).handler(
  async (): Promise<SyncGmailCrmResult> => {
    if (!isGmailCrmSyncConfigured()) {
      return { ...EMPTY, skipped: true };
    }

    try {
      const [fetch, contacts, already] = await Promise.all([
        fetchCrmMailboxTouches(),
        buildContacts(),
        existingGmailSyncKeys(),
      ]);

      if (!fetch.ok) {
        await logOpsEvent({
          action: "sync",
          source: "gmail_crm",
          status: "error",
          summary: fetch.error || "Gmail CRM sync failed",
          records: 0,
        });
        return { ...EMPTY, ok: false, error: fetch.error || "Gmail CRM sync failed" };
      }

      if (fetch.touches.length === 0) {
        let eventsLogged = 0;
        let eventCatalogLogged = 0;
        try {
          const backfill = await shipNotesToEventAttendance();
          eventsLogged = backfill.attendanceWritten;
          eventCatalogLogged = backfill.catalogWritten;
        } catch (e) {
          console.error("[gmail-crm] event backfill failed:", e);
        }
        await logOpsEvent({
          action: "sync",
          source: "gmail_crm",
          status: "ok",
          summary:
            eventsLogged > 0
              ? `Gmail CRM sync · no mailbox messages · backfilled ${eventsLogged} event links`
              : "Gmail CRM sync · no sent/calendar messages in window",
          records: eventsLogged,
          details: { eventsLogged, eventCatalogLogged },
        });
        return { ...EMPTY, eventsLogged, eventCatalogLogged };
      }

      // email → preferred contact display email + urid
      const byEmail = new Map<string, { email: string; urid?: string; name: string }>();
      for (const c of contacts) {
        const primary = primaryEmail(c);
        if (!primary) continue;
        for (const e of allEmails(c)) {
          if (!byEmail.has(e)) {
            byEmail.set(e, { email: (c.email || "").split(";")[0]?.trim() || primary, urid: c.urid, name: c.name });
          }
        }
      }

      const rows: InteractionRowInput[] = [];
      const eventItems: EventAttendanceInput[] = [];
      const queued = new Set<string>();
      const touched = new Set<string>();
      let alreadySynced = 0;
      let emailActivityLogged = 0;
      const today = new Date().toISOString().slice(0, 10);

      for (const t of fetch.touches) {
        const m = t.message;
        const matched = new Map<string, { email: string; urid?: string; name: string }>();
        // Sent: only To/Cc (outbound to CRM). Calendar: any participant on the thread.
        const pool =
          t.kind === "sent"
            ? [...m.toEmails, ...m.ccEmails]
            : participantEmails(m);
        for (const e of pool.map((x) => x.toLowerCase())) {
          const hit = byEmail.get(e);
          if (hit) matched.set(hit.email.toLowerCase(), hit);
        }

        for (const hit of matched.values()) {
          const keyEmail = hit.email.toLowerCase();
          if (alreadyLogged(already, keyEmail, m.id)) {
            alreadySynced++;
            // Calendar still ships attendance even if Notes already logged (backfill).
            if (t.kind === "calendar") {
              const eventName = cleanCalendarEventName(m.subject || "");
              if (eventName) {
                const date = m.dateLabel || today;
                eventItems.push({
                  email: hit.email,
                  eventName,
                  date,
                  type: date > today ? "invited" : "attended",
                  urid: hit.urid,
                  ensureCatalog: true,
                  catalogType: "meeting",
                });
              }
            }
            continue;
          }
          const qk = syncKey(keyEmail, `gmail-crm-${m.id}`);
          if (queued.has(qk)) continue;
          queued.add(qk);

          const date = m.dateLabel || today;
          rows.push({
            email: hit.email,
            date,
            summary: touchSummary(t),
            type: touchType(t),
            requiresFollowUp: false,
            urid: hit.urid,
            sourceRef: `gmail-crm-${m.id}`,
            owner: m.fromEmail || undefined,
          });
          touched.add(keyEmail);

          // Parallel Email Activity trail for outbound (feeds PortCo/Events modules).
          if (t.kind === "sent") {
            try {
              await logEmailActivity({
                contactEmail: hit.email,
                subject: m.subject,
                emailType: "General",
              });
              emailActivityLogged++;
            } catch (e) {
              console.error("[gmail-crm] logEmailActivity failed:", e);
            }
          }

          // Calendar invites → Events attendance + App Events catalog.
          if (t.kind === "calendar") {
            const eventName = cleanCalendarEventName(m.subject || "");
            if (eventName) {
              eventItems.push({
                email: hit.email,
                eventName,
                date,
                type: date > today ? "invited" : "attended",
                urid: hit.urid,
                ensureCatalog: true,
                catalogType: "meeting",
              });
            }
          }
        }
      }

      if (rows.length > 0) await appendInteractionRows(rows);

      let eventsLogged = 0;
      let eventCatalogLogged = 0;
      try {
        const live = await ensureEventAttendanceBatch(eventItems);
        // Also backfill Notes already shaped as Meeting: / [Event: …].
        const backfill = await shipNotesToEventAttendance();
        eventsLogged = live.attendanceWritten + backfill.attendanceWritten;
        eventCatalogLogged = live.catalogWritten + backfill.catalogWritten;
      } catch (e) {
        console.error("[gmail-crm] event attendance ship failed:", e);
      }

      const result: SyncGmailCrmResult = {
        ok: true,
        skipped: false,
        messages: fetch.touches.length,
        matchedContacts: touched.size,
        logged: rows.length,
        alreadySynced,
        emailActivityLogged,
        eventsLogged,
        eventCatalogLogged,
      };

      await logOpsEvent({
        action: "sync",
        source: "gmail_crm",
        status: "ok",
        summary: `Gmail CRM sync · logged ${result.logged} notes · ${result.eventsLogged} event links across ${result.matchedContacts} contacts`,
        records: result.logged + result.eventsLogged,
        details: {
          messages: result.messages,
          matchedContacts: result.matchedContacts,
          alreadySynced: result.alreadySynced,
          emailActivityLogged: result.emailActivityLogged,
          eventsLogged: result.eventsLogged,
          eventCatalogLogged: result.eventCatalogLogged,
          sent: fetch.touches.filter((t) => t.kind === "sent").length,
          calendar: fetch.touches.filter((t) => t.kind === "calendar").length,
        },
        items: rows.map(
          (r) =>
            `${r.email} ← ${r.summary}${r.date ? ` · ${r.date}` : ""} [${r.type}]`,
        ),
      });

      return result;
    } catch (err) {
      console.error("[gmail-crm] syncGmailCrmTouches failed:", err);
      const message = err instanceof Error ? err.message : "Gmail CRM sync failed";
      await logOpsEvent({
        action: "sync",
        source: "gmail_crm",
        status: "error",
        summary: message,
        records: 0,
      });
      return { ...EMPTY, ok: false, error: message };
    }
  },
);
