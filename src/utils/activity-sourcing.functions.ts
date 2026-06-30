import { createServerFn } from "@tanstack/react-start";
import { parseActivityThreads, type ParsedActivityPerson } from "./asana.server";
import {
  fetchContactEmails,
  addContactRow,
  appendSheetRows,
  appendInteractionRows,
  ensureColumn,
  ensureTab,
  fetchSheetTab,
  buildAppEvents,
  APP_EVENT_HEADERS,
  TAB_NAMES,
  type InteractionRowInput,
} from "./sheets.server";
import { enrichPerson } from "./apollo.server";
import { readThreads, type ThreadParticipant, type ThreadInteractionType } from "./thread-reader.server";
import type { InteractionType } from "@/lib/types";

// Map the LLM's classified thread type onto the CRM interaction taxonomy. BD/GTM
// activities are pasted email threads by construction, so an unclassified ("other")
// or unread thread is attributed as an "email" rather than a generic "note" — the
// LLM upgrades it to meeting / call / Portfolio Intro when the text says so.
function crmInteractionType(t: ThreadInteractionType | undefined): InteractionType {
  switch (t) {
    case "meeting":
      return "meeting";
    case "call":
      return "call";
    case "intro":
      return "intro";
    case "email":
      return "email";
    default:
      return "email";
  }
}

export interface SourceContactsResult {
  found: boolean;
  error?: string;
  /** People parsed across the activities (external, deduped within the batch). */
  peopleCount: number;
  /** New contacts created. */
  createdCount: number;
  /** People already in the CRM (logged onto, not duplicated). */
  existingCount: number;
  /** New contacts that Apollo successfully enriched (title/company/phone/location). */
  enrichedCount: number;
  /** True when Apollo couldn't be used (no key / plan lacks enrichment access). */
  apolloUnavailable: boolean;
  /** Activity-log rows written across all involved people. */
  notesLogged: number;
  /** Activities whose trail row carries a real LLM summary (not the fallback label). */
  summariesWritten: number;
  /** Trail rows flagged as an open follow-up by the LLM reader. */
  followUpsFlagged: number;
  /** New events created in the catalog from event mentions in the threads. */
  eventsCreated: number;
  /** Attendance/invite links written for people on event-bearing threads. */
  eventsTagged: number;
  /** Who-talked-to edges written (unordered co-participant pairs across threads). */
  connectionsLogged: number;
  /** Display strings for the contacts created (name + email). */
  created: string[];
}

const empty = { peopleCount: 0, createdCount: 0, existingCount: 0, enrichedCount: 0, apolloUnavailable: false, notesLogged: 0, summariesWritten: 0, followUpsFlagged: 0, eventsCreated: 0, eventsTagged: 0, connectionsLogged: 0, created: [] as string[] };

// Who-talked-to graph: one undirected edge per pair of people on the same thread.
// Person A is always the lexicographically-smaller email so a pair keys identically
// regardless of order; Source GID ties the edge to its activity for dedup/trace.
const ACTIVITY_CONNECTIONS_HEADERS = [
  "Person A Email",
  "Person A Name",
  "Person B Email",
  "Person B Name",
  "Date",
  "Activity",
  "Track",
  "Source GID",
];

// Source contacts from the email threads in the given BD/GTM activities: parse the
// To/From/Cc people (excluding the firm's own domain), create the ones not already
// in the CRM (deduped by email — never a duplicate), and log each activity as a
// note onto every involved contact (new AND existing). An LLM "read" step
// (readThreads) turns each thread into structured insight, so the trail row gets a
// real summary + follow-up flag and new contacts get LLM-resolved name/company/title.
// When a thread references an event, the event is added to the catalog (deduped by
// name) and the people on that thread are tagged as attendees/invitees (deduped).
// People sharing a thread are also linked as who-talked-to edges (Activity
// Connections tab) so the conversation network can be reconstructed later.
export const sourceContactsFromActivities = createServerFn({ method: "POST" })
  .inputValidator((data: { activityGids: string[]; defaultCompany?: string }) => data)
  .handler(async ({ data }): Promise<SourceContactsResult> => {
    try {
      const threads = await parseActivityThreads(data.activityGids);

      // Union of people across the activities (deduped by email).
      const peopleByEmail = new Map<string, ParsedActivityPerson>();
      for (const t of threads) for (const p of t.people) if (!peopleByEmail.has(p.email)) peopleByEmail.set(p.email, p);
      const people = [...peopleByEmail.values()];
      if (people.length === 0) return { found: true, ...empty };

      // LLM read step: turn each thread's raw text into structured insight
      // (summary, interaction type, follow-up, resolved participants). Degrades
      // to empty insights if Gemini is unavailable, so sourcing still works.
      const insightByGid = await readThreads(threads);

      // LLM-resolved participant details, keyed by email, used to seed new
      // contacts before Apollo (better names/companies/titles than the regex parse).
      const insightPersonByEmail = new Map<string, ThreadParticipant>();
      for (const t of threads) {
        for (const pp of insightByGid.get(t.gid)?.participants || []) {
          if (pp.email && !insightPersonByEmail.has(pp.email)) insightPersonByEmail.set(pp.email, pp);
        }
      }

      // Dedupe against the existing Contacts tab by email.
      const existing = new Set((await fetchContactEmails()).map((e) => e.toLowerCase()));
      await ensureColumn(TAB_NAMES.contacts, "Source");
      await ensureColumn(TAB_NAMES.contacts, "Source Context");

      const created: string[] = [];
      let existingCount = 0;
      let enrichedCount = 0;
      // Once Apollo proves unusable (no key / plan can't enrich), stop calling it
      // for the rest of the batch and just keep the parsed fields.
      let apolloOff = false;

      for (const p of people) {
        if (existing.has(p.email)) {
          existingCount++;
          continue;
        }

        // Seed from the LLM-resolved participant, fall back to the regex parse;
        // Apollo overrides each field below only when it has a value.
        const lp = insightPersonByEmail.get(p.email);
        let name = lp?.name || p.name || p.email;
        let role = lp?.role || "";
        let company = lp?.company || p.company || data.defaultCompany || "";
        let phone = "";
        let location = "";

        if (!apolloOff) {
          try {
            const ap = await enrichPerson({ email: p.email, organizationName: company || undefined });
            if (ap.accessDenied) {
              apolloOff = true; // key/plan can't enrich — degrade to parsed values
            } else if (ap.found) {
              if (ap.name) name = ap.name;
              if (ap.title) role = ap.title;
              if (ap.company) company = ap.company;
              if (ap.phone) phone = ap.phone;
              const loc = [ap.city, ap.state, ap.country].filter(Boolean).join(", ");
              if (loc) location = loc;
              enrichedCount++;
            }
          } catch (err) {
            // No key, rate limit, or transient error — stop trying, keep parsed.
            console.error("[activity] Apollo enrich failed:", err);
            apolloOff = true;
          }
        }

        await addContactRow({
          name,
          role,
          company,
          email: p.email,
          phone,
          location,
          prime: "",
          sector: "",
          temperature: "Cold",
          source: "Manual Entry",
          sourceContext: "Sourced from Asana BD/GTM activity",
        });
        existing.add(p.email); // guard against the same new email recurring in the batch
        created.push(`${name} (${p.email})`);
      }

      // Log each activity onto every person in it (new + existing). One batched
      // write. The trail row carries the LLM summary (falling back to the task
      // label), the LLM-inferred follow-up flag, and the interaction type the LLM
      // classified (so a sourced thread lands as Email / Meeting / Call /
      // Portfolio Intro instead of a generic Note).
      const today = new Date().toISOString().split("T")[0];
      const noteRows: InteractionRowInput[] = [];
      let summariesWritten = 0;
      let followUpsFlagged = 0;
      for (const t of threads) {
        const insight = insightByGid.get(t.gid);
        const hasSummary = !!insight?.summary?.trim();
        const summary = hasSummary
          ? `[${t.track}] ${insight!.summary}`
          : `Activity · [${t.track}] ${t.name}`;
        const owed = !!insight?.followUp.owed;
        const type = crmInteractionType(insight?.interactionType);
        if (hasSummary) summariesWritten++;
        for (const p of t.people) {
          noteRows.push({
            email: p.email,
            date: t.date || today,
            summary,
            type,
            requiresFollowUp: owed,
          });
          if (owed) followUpsFlagged++;
        }
      }
      if (noteRows.length) await appendInteractionRows(noteRows);

      // ── Phase 2: event detection + attendance tagging ──
      // Collect the events the LLM flagged across the threads (deduped by name),
      // unioning the people on every thread that referenced each event.
      const eventByName = new Map<
        string,
        { name: string; date?: string; type?: string; people: Set<string> }
      >();
      for (const t of threads) {
        const ev = insightByGid.get(t.gid)?.event;
        const evName = ev?.name?.trim();
        if (!ev?.mentioned || !evName) continue;
        const key = evName.toLowerCase();
        let entry = eventByName.get(key);
        if (!entry) {
          entry = { name: evName, date: ev.date, type: ev.type, people: new Set() };
          eventByName.set(key, entry);
        }
        if (!entry.date && ev.date) entry.date = ev.date;
        if (!entry.type && ev.type) entry.type = ev.type;
        for (const p of t.people) entry.people.add(p.email);
      }

      let eventsCreated = 0;
      let eventsTagged = 0;
      if (eventByName.size > 0) {
        const isIso = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
        const CATALOG_TYPES = new Set(["conference", "dinner", "webinar", "meeting"]);

        // Dedupe: existing catalog event names + existing attendance (email|event).
        const existingCatalog = new Set(
          (await buildAppEvents()).map((e) => e.name.trim().toLowerCase()),
        );
        const existingAttendance = new Set<string>();
        const evRows = await fetchSheetTab(TAB_NAMES.events).catch(() => [] as string[][]);
        if (evRows.length > 1) {
          // Header-aware (the legacy Events tab is "Contact Email, Event Name, Date, Type").
          const hdr = evRows[0].map((h) => (h || "").trim().toLowerCase());
          const emailIdx = hdr.indexOf("contact email") >= 0 ? hdr.indexOf("contact email") : 0;
          const nameIdx = hdr.indexOf("event name") >= 0 ? hdr.indexOf("event name") : 1;
          for (const r of evRows.slice(1)) {
            const em = (r[emailIdx] || "").trim().toLowerCase();
            const nm = (r[nameIdx] || "").trim().toLowerCase();
            if (em && nm) existingAttendance.add(`${em}|${nm}`);
          }
        }

        const catalogRows: string[][] = [];
        const attendanceRows: string[][] = [];
        for (const ev of eventByName.values()) {
          const nameKey = ev.name.toLowerCase();
          if (!existingCatalog.has(nameKey)) {
            const typeRaw = (ev.type || "").toLowerCase();
            const type = CATALOG_TYPES.has(typeRaw) ? typeRaw : "meeting";
            // APP_EVENT_HEADERS: Name, Date, Status, Type, Lead, Format, Role, Sectors, PortCos
            catalogRows.push([ev.name, isIso(ev.date) ? ev.date! : "", "", type, "", "", "", "", ""]);
            existingCatalog.add(nameKey);
            eventsCreated++;
          }
          // A future event date means people were invited, not yet attended.
          const linkType = isIso(ev.date) && ev.date! > today ? "invited" : "attended";
          for (const email of ev.people) {
            const pairKey = `${email.toLowerCase()}|${nameKey}`;
            if (existingAttendance.has(pairKey)) continue;
            // Legacy Events-tab shape: Contact Email, Event Name, Date, Type.
            attendanceRows.push([email, ev.name, isIso(ev.date) ? ev.date! : today, linkType]);
            existingAttendance.add(pairKey);
            eventsTagged++;
          }
        }
        if (catalogRows.length) {
          await ensureTab(TAB_NAMES.appEvents, APP_EVENT_HEADERS);
          await appendSheetRows(TAB_NAMES.appEvents, catalogRows);
        }
        if (attendanceRows.length) {
          await ensureTab(TAB_NAMES.events, ["Contact Email", "Event Name", "Date", "Type"]);
          await appendSheetRows(TAB_NAMES.events, attendanceRows);
        }
      }

      // ── Phase 3: who-talked-to graph ──
      // People on the same thread form an undirected clique — every pair "talked".
      // Persist each unordered pair once per activity (keyed by sorted emails +
      // source gid) so the network can be queried later. Storage only — no UI yet.
      const nameFor = (email: string, fallback: string) =>
        insightPersonByEmail.get(email)?.name || fallback || email;

      const existingEdges = new Set<string>();
      const connRows = await fetchSheetTab(TAB_NAMES.activityConnections).catch(
        () => [] as string[][],
      );
      for (const r of connRows.slice(1)) {
        const a = (r[0] || "").trim().toLowerCase();
        const b = (r[2] || "").trim().toLowerCase();
        const gid = (r[7] || "").trim();
        if (a && b) existingEdges.add(`${a}|${b}|${gid}`);
      }

      const connectionRows: string[][] = [];
      for (const t of threads) {
        const ppl = t.people;
        if (ppl.length < 2) continue;
        for (let i = 0; i < ppl.length; i++) {
          for (let j = i + 1; j < ppl.length; j++) {
            // Order the pair by email so the same two people key identically.
            const [pa, pb] =
              ppl[i].email.toLowerCase() <= ppl[j].email.toLowerCase()
                ? [ppl[i], ppl[j]]
                : [ppl[j], ppl[i]];
            const key = `${pa.email.toLowerCase()}|${pb.email.toLowerCase()}|${t.gid}`;
            if (existingEdges.has(key)) continue;
            existingEdges.add(key);
            connectionRows.push([
              pa.email,
              nameFor(pa.email, pa.name),
              pb.email,
              nameFor(pb.email, pb.name),
              t.date || today,
              t.name,
              t.track,
              t.gid,
            ]);
          }
        }
      }
      if (connectionRows.length) {
        await ensureTab(TAB_NAMES.activityConnections, ACTIVITY_CONNECTIONS_HEADERS);
        await appendSheetRows(TAB_NAMES.activityConnections, connectionRows);
      }

      return {
        found: true,
        peopleCount: people.length,
        createdCount: created.length,
        existingCount,
        enrichedCount,
        apolloUnavailable: apolloOff,
        notesLogged: noteRows.length,
        summariesWritten,
        followUpsFlagged,
        eventsCreated,
        eventsTagged,
        connectionsLogged: connectionRows.length,
        created,
      };
    } catch (err) {
      console.error("[activity] sourceContactsFromActivities failed:", err);
      return { found: false, error: err instanceof Error ? err.message : "Sourcing failed", ...empty };
    }
  });
