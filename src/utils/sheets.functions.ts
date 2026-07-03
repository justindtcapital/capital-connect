import { createServerFn } from "@tanstack/react-start";
import {
  buildContacts,
  buildTargets,
  buildPortfolioCompanies,
  buildAppEvents,
  addContactRow,
  appendSheetRow,
  appendInteractionRows,
  ensureTab,
  ensureColumn,
  fetchSheetTab,
  updateSheetCell,
  TAB_NAMES,
  APP_EVENT_HEADERS,
  recalculateRatings as recalculateRatingsServer,
  setContactRating as setContactRatingServer,
  clearContactRatingOverride as clearContactRatingOverrideServer,
  bulkUpdateContacts as bulkUpdateContactsServer,
  bulkDeleteContacts as bulkDeleteContactsServer,
  bulkDeleteTargets as bulkDeleteTargetsServer,
  mergeContactFields as mergeContactFieldsServer,
  bulkMergeContactFields as bulkMergeContactFieldsServer,
  storeApolloRaw as storeApolloRawServer,
  logEmailActivity as logEmailActivityServer,
  buildEmailActivity as buildEmailActivityServer,
  fetchContactEmails as fetchContactEmailsServer,
  logImportResult as logImportResultServer,
  buildImportHistory,
  buildRatingTransitions,
  buildEventSynopses,
  setEventSynopsis as setEventSynopsisServer,
  appendTargetOutreach as appendTargetOutreachServer,
  saveTargetStrategy as saveTargetStrategyServer,
  updateTargetFields as updateTargetFieldsServer,
  appendTargetRows as appendTargetRowsServer,
  recordDailySnapshot as recordDailySnapshotServer,
  type ImportResultInput,
  type DailyMetrics,
  type SnapshotResult,
  type BulkMergeUpdate,
} from "./sheets.server";
import { enrichPerson } from "./apollo.server";
import { sampleContacts, sampleTargets, samplePortfolioCompanies } from "@/lib/sample-data";
import { normalizeInteractionType } from "@/lib/types";
import type {
  AsanaEvent,
  Temperature,
  EngagementSource,
  BulkEditField,
  ConnectionPlan,
} from "@/lib/types";

export const fetchContacts = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await buildContacts();
  } catch (error) {
    console.error("Failed to fetch contacts from Google Sheets:", error);
    return sampleContacts;
  }
});

export const fetchTargets = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await buildTargets();
  } catch (error) {
    console.error("Failed to fetch targets from Google Sheets:", error);
    return sampleTargets;
  }
});

export const fetchPortfolioCompanies = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await buildPortfolioCompanies();
  } catch (error) {
    console.error("Failed to fetch portfolio companies from Google Sheets:", error);
    return samplePortfolioCompanies;
  }
});

// App-added events (stored in the Sheet's "App Events" tab — never written to Asana).
export const fetchAppEvents = createServerFn({ method: "GET" }).handler(
  async (): Promise<AsanaEvent[]> => {
    try {
      return await buildAppEvents();
    } catch (error) {
      console.error("Failed to fetch app events from Google Sheets:", error);
      return [];
    }
  },
);

export const addAppEvent = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      name: string;
      date: string;
      status?: string;
      type?: string;
      lead?: string;
      format?: string;
      role?: string;
      sectors?: string[];
      portcos?: string[];
    }) => data,
  )
  .handler(async ({ data }) => {
    await ensureTab(TAB_NAMES.appEvents, APP_EVENT_HEADERS);
    // Column order must match APP_EVENT_HEADERS:
    // Name, Date, Status, Type, Lead, Format, Role, Sectors, PortCos
    await appendSheetRow(TAB_NAMES.appEvents, [
      data.name,
      data.date,
      data.status || "",
      data.type || "",
      data.lead || "",
      data.format || "",
      data.role || "",
      (data.sectors || []).join(", "),
      (data.portcos || []).join(", "),
    ]);
    return { success: true };
  });

// ── Write-back functions ─────────────────────────────────────

export const addNote = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      contactEmail: string;
      noteContent: string;
      requiresFollowUp: boolean;
      /** Interaction type for the trail entry; defaults to "note". */
      type?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const now = new Date().toISOString().split("T")[0];
    await appendInteractionRows([
      {
        email: data.contactEmail,
        date: now,
        summary: data.noteContent,
        type: normalizeInteractionType(data.type),
        requiresFollowUp: data.requiresFollowUp,
      },
    ]);
    return { success: true };
  });

export const addEvent = createServerFn({ method: "POST" })
  .inputValidator((data: { contactEmail: string; eventName: string; type: string }) => data)
  .handler(async ({ data }) => {
    const now = new Date().toISOString().split("T")[0];
    await appendSheetRow(TAB_NAMES.events, [data.contactEmail, data.eventName, now, data.type]);
    return { success: true };
  });

export const addPortcoIntro = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { contactEmail: string; portcoName: string; source?: EngagementSource }) => data,
  )
  .handler(async ({ data }) => {
    const now = new Date().toISOString().split("T")[0];
    // Make sure the tab has the Engagement Source column before writing it.
    await ensureColumn(TAB_NAMES.portcoIntros, "Engagement Source");
    await appendSheetRow(TAB_NAMES.portcoIntros, [
      data.contactEmail,
      data.portcoName,
      now,
      data.source || "direct introduction",
    ]);
    return { success: true };
  });

export const addContact = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      name: string;
      role: string;
      company: string;
      email: string;
      phone: string;
      location: string;
      prime: string;
      sector: string;
      temperature: string;
      /** Canonical RecordSource; defaults to "Manual Entry". */
      source?: string;
      sourceContext?: string;
      /** Apollo enrichment extras. */
      headline?: string;
      employmentHistory?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    // Ensure the Source columns exist before the header-aware append writes them.
    await ensureColumn(TAB_NAMES.contacts, "Source");
    if (data.sourceContext) await ensureColumn(TAB_NAMES.contacts, "Source Context");
    await addContactRow({ ...data, source: data.source || "Manual Entry" });
    return { success: true };
  });

export const addTarget = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      firstName: string;
      lastName: string;
      company: string;
      role: string;
      linkedin: string;
      email: string;
      location: string;
      sector: string;
      stage: string;
      source: string;
      researchPurpose: string;
      reasonSurfaced?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    // Header-aware append (stamps a stable URID; tolerant of column order).
    await appendTargetRowsServer([
      {
        firstName: data.firstName,
        lastName: data.lastName,
        company: data.company,
        role: data.role,
        linkedin: data.linkedin,
        email: data.email,
        location: data.location,
        sector: data.sector,
        stage: data.stage,
        source: data.source,
        researchPurpose: data.researchPurpose,
        reasonSurfaced: data.reasonSurfaced || "",
      },
    ]);
    return { success: true };
  });

// Persist a single outreach attempt for a target (Target Outreach tab).
export const logTargetOutreach = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      targetKey: string;
      id: string;
      date: string;
      method: string;
      summary: string;
      urid?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    if (!data.targetKey?.trim() && !data.urid?.trim()) return { success: false };
    await appendTargetOutreachServer(
      data.targetKey,
      { id: data.id, date: data.date, method: data.method, summary: data.summary },
      data.urid,
    );
    return { success: true };
  });

// Persist edited / Apollo-enriched target fields back to the Targets tab.
export const updateTargetFields = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { targetKey: string; fields: Record<string, string | undefined>; urid?: string }) =>
      data,
  )
  .handler(async ({ data }) => {
    if (!data.targetKey?.trim() && !data.urid?.trim()) return { success: false };
    return await updateTargetFieldsServer(data.targetKey, data.fields || {}, data.urid);
  });

// Persist the latest AI connection plan for a target (Target Strategy tab).
export const saveTargetConnectionStrategy = createServerFn({ method: "POST" })
  .inputValidator((data: { targetKey: string; plan: ConnectionPlan; urid?: string }) => data)
  .handler(async ({ data }) => {
    if (!data.targetKey?.trim() && !data.urid?.trim()) return { success: false, savedAt: "" };
    const savedAt = await saveTargetStrategyServer(data.targetKey, data.plan, data.urid);
    return { success: true, savedAt };
  });

// Record today's headline counts and return the baseline to diff against (Home deltas).
export const recordHomeSnapshot = createServerFn({ method: "POST" })
  .inputValidator((data: DailyMetrics) => data)
  .handler(async ({ data }): Promise<SnapshotResult> => recordDailySnapshotServer(data));

export const resolveFollowUp = createServerFn({ method: "POST" })
  .inputValidator((data: { contactEmail: string; noteContent: string; resolved: boolean }) => data)
  .handler(async ({ data }) => {
    const rows = await fetchSheetTab(TAB_NAMES.interactions);
    if (rows.length < 2) return { success: false };

    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const emailIdx = headers.indexOf("contact email");
    const noteIdx = headers.indexOf("note content");
    const resolvedIdx = headers.indexOf("follow up resolved");

    if (emailIdx === -1 || noteIdx === -1 || resolvedIdx === -1) {
      throw new Error("Could not find required columns in Notes tab");
    }

    // Find matching row (skip header, so data row 1 = sheet row 2)
    const emailLower = data.contactEmail.toLowerCase();
    for (let i = 1; i < rows.length; i++) {
      const rowEmail = (rows[i][emailIdx] || "").trim().toLowerCase();
      const rowNote = (rows[i][noteIdx] || "").trim();
      if (rowEmail === emailLower && rowNote === data.noteContent.trim()) {
        const colLetter = String.fromCharCode(65 + resolvedIdx); // A=0, B=1, ...
        const cellRange = `${colLetter}${i + 1}`;
        await updateSheetCell(TAB_NAMES.interactions, cellRange, data.resolved ? "TRUE" : "FALSE");
        return { success: true };
      }
    }
    return { success: false };
  });

// Update fields on an existing contact row (matched by email). Used to persist
// Apollo enrichment back to the sheet. Only the provided fields are written, and
// only those that have a matching column in the Contacts tab. Email is the match
// key and is never changed here (it identifies the row across the other tabs).
export const updateContact = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      email: string;
      title?: string;
      company?: string;
      phone?: string;
      location?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const rows = await fetchSheetTab(TAB_NAMES.contacts);
    if (rows.length < 2) return { success: false, updated: 0 };

    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const emailIdx = headers.indexOf("email");
    if (emailIdx === -1) throw new Error("Could not find Email column in Contacts tab");

    // Map our field names to the actual Contacts sheet column headers.
    const FIELD_HEADERS: Record<string, string> = {
      title: "role",
      company: "company",
      phone: "phone number",
      location: "location",
    };

    const target = data.email.trim().toLowerCase();
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][emailIdx] || "").trim().toLowerCase() !== target) continue;

      let updated = 0;
      for (const [field, header] of Object.entries(FIELD_HEADERS)) {
        const value = (data as Record<string, string | undefined>)[field];
        if (value === undefined) continue;
        const colIdx = headers.indexOf(header);
        if (colIdx === -1) continue;
        const colLetter = String.fromCharCode(65 + colIdx); // Contacts is A–L, single letter
        await updateSheetCell(TAB_NAMES.contacts, `${colLetter}${i + 1}`, value);
        updated++;
      }
      return { success: true, updated };
    }
    return { success: false, updated: 0 };
  });

// Recompute all unlocked contacts' ratings from activity, persist changes, and
// log them to the Rating History tab.
export const recalculateRatings = createServerFn({ method: "POST" }).handler(async () =>
  recalculateRatingsServer(),
);

// Manually set + lock a contact's rating (stops auto-updates for that contact).
export const setContactRating = createServerFn({ method: "POST" })
  .inputValidator((data: { email: string; tier: Temperature; urid?: string }) => data)
  .handler(async ({ data }) => setContactRatingServer(data.email, data.tier, data.urid));

// Unlock a contact so the automatic scorecard governs its rating again.
export const clearContactRatingOverride = createServerFn({ method: "POST" })
  .inputValidator((data: { email: string; urid?: string }) => data)
  .handler(async ({ data }) => clearContactRatingOverrideServer(data.email, data.urid));

// Bulk-edit one profile field (status/location/sector/prime/title/company)
// across many contacts, persisted to the Contacts sheet in one batched write.
export const bulkUpdateContacts = createServerFn({ method: "POST" })
  .inputValidator((data: { emails: string[]; field: BulkEditField; value: string }) => data)
  .handler(async ({ data }) => bulkUpdateContactsServer(data.emails, data.field, data.value));

// Hard-delete the given contacts (by email) from the Contacts sheet. Permanent.
export const bulkDeleteContacts = createServerFn({ method: "POST" })
  .inputValidator((data: { emails: string[] }) => data)
  .handler(async ({ data }) => bulkDeleteContactsServer(data.emails));

// Hard-delete the given targets (by stable URID, or derived target key) from the
// Targets sheet. Permanent.
export const bulkDeleteTargets = createServerFn({ method: "POST" })
  .inputValidator((data: { entries: { key?: string; urid?: string }[] }) => data)
  .handler(async ({ data }) => bulkDeleteTargetsServer(data.entries));

// Non-destructive contact field merge. source "user" = human edit (writes all,
// stamps user-owned); source "apollo" = fill-only enrichment that never
// overwrites human-edited fields. Single path for edits and enrichment.
export const mergeContactFields = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      email: string;
      fields: Record<string, string | undefined>;
      source: "user" | "apollo";
      urid?: string;
    }) => data,
  )
  .handler(async ({ data }) =>
    mergeContactFieldsServer(data.email, data.fields, data.source, data.urid),
  );

// Archive the full Apollo payload for a contact (nothing is ever lost).
export const storeApolloRaw = createServerFn({ method: "POST" })
  .inputValidator((data: { email: string; payload: unknown }) => data)
  .handler(async ({ data }) => {
    await storeApolloRawServer(data.email, data.payload);
    return { success: true };
  });

// ── Bulk actions (multi-contact) ─────────────────────────────

// Mass Apollo enrichment: enrich each selected contact and non-destructively
// fill blank fields (title/company/phone/location/sector/headline/employment
// history) in ONE batched sheet write. Apollo never overwrites human-edited
// fields; a portfolio-company employer forces sector "Portfolio". The full
// payload is archived per matched contact.
export const bulkEnrichContacts = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { contacts: { email: string; name: string; company?: string; urid?: string }[] }) => data,
  )
  .handler(async ({ data }) => {
    const updates: BulkMergeUpdate[] = [];
    let matched = 0;
    let notFound = 0;
    let failed = 0;

    for (const c of data.contacts) {
      const email = (c.email || "").trim();
      if (!email) { failed++; continue; }
      const parts = (c.name || "").trim().split(/\s+/);
      try {
        const r = await enrichPerson({
          email,
          firstName: parts[0] || undefined,
          lastName: parts.slice(1).join(" ") || undefined,
          organizationName: c.company || undefined,
        });
        if (!r.found) { notFound++; continue; }
        matched++;
        // Archive the raw payload (best-effort).
        storeApolloRawServer(email, r).catch(() => {});
        const location = [r.city, r.state].filter(Boolean).join(", ");
        const employment = (r.employmentHistory || [])
          .map((j) => {
            const base = [j.title, j.company].filter(Boolean).join(" @ ");
            return j.current ? `${base} (current)` : base;
          })
          .filter(Boolean)
          .join("; ");
        updates.push({
          email,
          urid: c.urid,
          fields: {
            title: r.title || undefined,
            company: r.company || undefined,
            phone: r.phone || undefined,
            location: location || undefined,
            sector: r.industry || undefined,
            headline: r.headline || undefined,
            employmentHistory: employment || undefined,
          },
        });
      } catch (e) {
        console.error("[bulkEnrichContacts] enrich failed for", email, e);
        failed++;
      }
    }

    const res = await bulkMergeContactFieldsServer(updates, "apollo");
    return { matched, notFound, failed, updated: res.updated };
  });

// Mass "areas of interest" load: infer each contact's interest domains from
// title/company/sector and PERSIST them to the sheet. Fill-only — a contact
// whose "Areas of Interest" cell already has a value (manual curation) is left
// untouched (the merge decides this from the real sheet cell, since the client's
// areasOfInterest is often auto-inferred at read time). Deterministic + free.
export const bulkLoadInterests = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      contacts: {
        email: string;
        urid?: string;
        title?: string;
        company?: string;
        sector?: string;
      }[];
    }) => data,
  )
  .handler(async ({ data }) => {
    const { inferInterestAreas } = await import("@/lib/interest-domains");
    const updates: BulkMergeUpdate[] = [];
    let inferred = 0;

    for (const c of data.contacts) {
      const areas = inferInterestAreas(c.title || "", c.company || "", c.sector || "");
      if (areas.length === 0) continue;
      inferred++;
      updates.push({
        email: c.email,
        urid: c.urid,
        fields: { areasOfInterest: areas.join(", ") },
      });
    }

    // Fill-only: persist inferred areas only where the sheet cell is blank.
    const res = await bulkMergeContactFieldsServer(updates, "user", true);
    return { inferred, updated: res.updated };
  });

// Fresh existing-contact emails (lowercased), for commit-time dedup.
export const fetchContactEmails = createServerFn({ method: "GET" }).handler(async () =>
  fetchContactEmailsServer(),
);

// Persist a per-import summary row to the Import History tab.
export const logImportResult = createServerFn({ method: "POST" })
  .inputValidator((data: ImportResultInput) => data)
  .handler(async ({ data }) => {
    await logImportResultServer(data);
    return { success: true };
  });

// Recent imports for the Import History panel (newest first).
export const fetchImportHistory = createServerFn({ method: "GET" }).handler(async () =>
  buildImportHistory(),
);

// Per-event synopses (#3). { eventNameLower: synopsis }. Empty on failure.
export const fetchEventSynopses = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await buildEventSynopses();
  } catch (e) {
    console.error("fetchEventSynopses failed:", e);
    return {} as Record<string, string>;
  }
});

// Save (append) an event synopsis row.
export const saveEventSynopsis = createServerFn({ method: "POST" })
  .inputValidator((data: { eventName: string; synopsis: string }) => data)
  .handler(async ({ data }) => {
    await setEventSynopsisServer(data.eventName, data.synopsis);
    return { success: true };
  });

// Rating-change events (network progression, #9). Empty array on any failure.
export const fetchRatingTransitions = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await buildRatingTransitions();
  } catch (e) {
    console.error("fetchRatingTransitions failed:", e);
    return [];
  }
});

// All logged outreach emails (newest first) for Event/PortCo activity views.
export const fetchEmailActivity = createServerFn({ method: "GET" }).handler(async () =>
  buildEmailActivityServer(),
);

// Log a sent email with its type + linked portco/event (action tracking).
export const logEmailActivity = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      contactEmail: string;
      subject: string;
      emailType: string;
      linkedPortco?: string;
      linkedEvent?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    await logEmailActivityServer(data);
    return { success: true };
  });
