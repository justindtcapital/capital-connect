import { createServerFn } from "@tanstack/react-start";
import {
  buildContacts,
  buildTargets,
  buildPortfolioCompanies,
  buildAppEvents,
  addPortfolioCompany as addPortfolioCompanyServer,
  deletePortfolioCompany as deletePortfolioCompanyServer,
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
  logOpsEvent as logOpsEventServer,
  buildImportHistory,
  buildOpsLog as buildOpsLogServer,
  type OpsLogEntry,
  buildOwnershipIndex as buildOwnershipIndexServer,
  buildMyContacts as buildMyContactsServer,
  buildRatingTransitions,
  buildEventSynopses,
  setEventSynopsis as setEventSynopsisServer,
  appendTargetOutreach as appendTargetOutreachServer,
  saveTargetStrategy as saveTargetStrategyServer,
  updateTargetFields as updateTargetFieldsServer,
  bulkUpdateTargetFields as bulkUpdateTargetFieldsServer,
  repairTargetUrids as repairTargetUridsServer,
  setPortcoIntroSource as setPortcoIntroSourceServer,
  appendTargetRows as appendTargetRowsServer,
  recordDailySnapshot as recordDailySnapshotServer,
  ensureEventAttendanceBatch,
  primarySheetEmail,
  type ImportResultInput,
  type OpsLogInput,
  type DailyMetrics,
  type SnapshotResult,
  type BulkMergeUpdate,
} from "./sheets.server";
import { enrichPerson } from "./apollo.server";
import { sampleContacts, sampleTargets, samplePortfolioCompanies } from "@/lib/sample-data";
import { normalizeInteractionType, targetKeyOf } from "@/lib/types";
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

// Add a portfolio company (new row in the "Portfolio Companies" tab).
export const addPortfolioCompany = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      name: string;
      website?: string;
      focusArea?: string;
      location?: string;
      description?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    if (!data.name?.trim()) throw new Error("Company name is required");
    return await addPortfolioCompanyServer({
      name: data.name,
      website: data.website,
      focusArea: data.focusArea,
      location: data.location,
      description: data.description,
    });
  });

// Delete a portfolio company (by stable URID, falling back to exact name match).
export const deletePortfolioCompany = createServerFn({ method: "POST" })
  .inputValidator((data: { urid?: string; name?: string }) => data)
  .handler(async ({ data }) => {
    return await deletePortfolioCompanyServer(data);
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
    await logOpsEventServer({
      action: "sync",
      source: "app_event",
      status: "ok",
      summary: `App event catalog · ${data.name}${data.date ? ` · ${data.date}` : ""}`,
      records: 1,
      details: {
        name: data.name,
        date: data.date,
        type: data.type || "",
        status: data.status || "",
      },
      items: [data.name],
    });
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
  .inputValidator(
    (data: {
      contactEmail: string;
      eventName: string;
      type: string;
      urid?: string;
      date?: string;
      /** Ensure App Events catalog row (default true). */
      ensureCatalog?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const email = primarySheetEmail(data.contactEmail);
    if (!email || !data.eventName.trim()) {
      return { success: false as const, error: "Missing email or event name" };
    }
    const type = (data.type || "attended").toLowerCase() === "invited" ? "invited" : "attended";
    const res = await ensureEventAttendanceBatch([
      {
        email,
        eventName: data.eventName.trim(),
        date: data.date,
        type,
        urid: data.urid,
        ensureCatalog: data.ensureCatalog !== false,
        catalogType: "meeting",
      },
    ]);
    await logOpsEventServer({
      action: "sync",
      source: "event_attendance",
      status: "ok",
      summary: `Event ${type} · ${email} ← ${data.eventName.trim()}`,
      records: res.attendanceWritten,
      details: {
        email,
        event: data.eventName.trim(),
        type,
        attendanceWritten: res.attendanceWritten,
        catalogWritten: res.catalogWritten,
        skipped: res.skipped,
      },
      items: [`${email} ← ${data.eventName.trim()} [${type}]`],
    });
    return { success: true as const, ...res };
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

// Reclassify an existing portfolio engagement's source in place (inline edit on
// the contact panel), without deleting/re-adding the intro.
export const setPortcoIntroSource = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { contactEmail: string; portcoName: string; source: EngagementSource; urid?: string }) =>
      data,
  )
  .handler(async ({ data }) =>
    setPortcoIntroSourceServer(data.contactEmail, data.portcoName, data.source, data.urid),
  );

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
      /** Sourced LinkedIn profile URL (written to the "LinkedIn" column). */
      linkedinUrl?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    // Ensure the Source columns exist before the header-aware append writes them.
    await ensureColumn(TAB_NAMES.contacts, "Source");
    if (data.sourceContext) await ensureColumn(TAB_NAMES.contacts, "Source Context");
    await addContactRow({
      ...data,
      linkedin: data.linkedinUrl,
      source: data.source || "Manual Entry",
    });
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
      phone?: string;
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
        phone: data.phone || "",
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

// Batch import for the Targeting paste/upload flows. Dedupes each incoming row
// against existing targets (by targetKeyOf) and within the batch, then appends
// the survivors in one header-aware write. Returns added + duplicate counts.
export const importTargets = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      targets: Array<{
        firstName: string;
        lastName: string;
        company: string;
        role: string;
        linkedin: string;
        email: string;
        phone?: string;
        location: string;
        sector: string;
        stage: string;
        source: string;
        researchPurpose: string;
        reasonSurfaced?: string;
      }>;
    }) => data,
  )
  .handler(async ({ data }): Promise<{ added: number; duplicates: number }> => {
    const incoming = (data.targets || []).filter(
      (t) => t.firstName || t.lastName || t.email || t.linkedin,
    );
    if (incoming.length === 0) return { added: 0, duplicates: 0 };

    // Authoritative dedup: re-read existing targets at commit time so a re-click
    // (or a concurrent import) can't double-create the same person.
    let existingKeys = new Set<string>();
    try {
      const existing = await buildTargets();
      existingKeys = new Set(existing.map((t) => targetKeyOf(t)).filter(Boolean));
    } catch (e) {
      console.error("importTargets: dedup read failed (proceeding):", e);
    }

    const seen = new Set<string>();
    const toAdd: typeof incoming = [];
    let duplicates = 0;
    for (const r of incoming) {
      const name = `${r.firstName} ${r.lastName}`.trim();
      const key = targetKeyOf({ email: r.email, name, company: r.company });
      if (key && (existingKeys.has(key) || seen.has(key))) {
        duplicates++;
        continue;
      }
      if (key) seen.add(key);
      toAdd.push(r);
    }

    if (toAdd.length > 0) {
      await appendTargetRowsServer(
        toAdd.map((t) => ({
          firstName: t.firstName,
          lastName: t.lastName,
          company: t.company,
          role: t.role,
          linkedin: t.linkedin,
          email: t.email,
          phone: t.phone || "",
          location: t.location,
          sector: t.sector,
          stage: t.stage,
          source: t.source,
          researchPurpose: t.researchPurpose,
          reasonSurfaced: t.reasonSurfaced || "",
        })),
      );
      await logOpsEventServer({
        action: "import",
        source: "targets",
        status: "ok",
        summary: `Imported ${toAdd.length} target${toAdd.length !== 1 ? "s" : ""}${duplicates ? ` · ${duplicates} duplicate${duplicates !== 1 ? "s" : ""} skipped` : ""}`,
        records: toAdd.length,
        details: { duplicates, source: toAdd[0]?.source },
        items: toAdd.map((t) =>
          [`${t.firstName} ${t.lastName}`.trim(), t.company].filter(Boolean).join(" · "),
        ),
      });
    }
    return { added: toAdd.length, duplicates };
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

// Backfill missing / de-duplicate URIDs on the Targets tab so every row is stably
// keyable (URID column only — data columns untouched). Idempotent.
export const repairTargetUrids = createServerFn({ method: "POST" }).handler(async () => {
  const res = await repairTargetUridsServer();
  if (res.filled > 0 || res.deduped > 0) {
    await logOpsEventServer({
      action: "maintenance",
      source: "targets_urid",
      status: "ok",
      summary: `Repaired target IDs · ${res.filled} filled, ${res.deduped} de-duplicated (of ${res.total})`,
      records: res.filled + res.deduped,
      details: { filled: res.filled, deduped: res.deduped, total: res.total },
    });
  }
  return res;
});

// Batch-set fields (e.g. Stage) across many targets in one write. Overwrites by
// default; pass fillOnly to leave non-blank cells untouched.
export const bulkUpdateTargetFields = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      entries: { key?: string; urid?: string; fields: Record<string, string | undefined> }[];
      fillOnly?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const res = await bulkUpdateTargetFieldsServer(data.entries, { fillOnly: data.fillOnly });
    if (res.updated > 0) {
      // Distinct field names touched across the batch (e.g. "stage").
      const fields = [...new Set(data.entries.flatMap((e) => Object.keys(e.fields || {})))].join(
        ", ",
      );
      await logOpsEventServer({
        action: "edit",
        source: "targets",
        status: "ok",
        summary: `Updated ${res.updated} target${res.updated !== 1 ? "s" : ""}${fields ? ` · ${fields}` : ""}`,
        records: res.updated,
        details: { fields },
      });
    }
    return res;
  });

// Mass Apollo research over selected targets: enrich each person and
// NON-DESTRUCTIVELY fill blank fields (role/company/phone/location/sector/linkedin,
// plus name if the row is nameless) in ONE batched sheet write. Apollo never
// overwrites curated cells. Matched by stable URID with a target-key fallback.
export const bulkResearchTargets = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      targets: {
        key?: string;
        urid?: string;
        name?: string;
        email?: string;
        company?: string;
        linkedinUrl?: string;
      }[];
    }) => data,
  )
  .handler(async ({ data }) => {
    const entries: {
      key?: string;
      urid?: string;
      fields: Record<string, string | undefined>;
    }[] = [];
    let matched = 0;
    let notFound = 0;
    let failed = 0;

    for (const t of data.targets) {
      const parts = (t.name || "").trim().split(/\s+/).filter(Boolean);
      // Nothing to match on → count as a miss rather than calling Apollo blind.
      if (!t.email && !t.linkedinUrl && parts.length === 0) {
        notFound++;
        continue;
      }
      try {
        const r = await enrichPerson({
          email: t.email || undefined,
          firstName: parts[0] || undefined,
          lastName: parts.slice(1).join(" ") || undefined,
          organizationName: t.company || undefined,
          linkedinUrl: t.linkedinUrl || undefined,
        });
        if (!r.found) {
          notFound++;
          continue;
        }
        matched++;
        const location = [r.city, r.state].filter(Boolean).join(", ");
        const resolvedName = r.name || [r.firstName, r.lastName].filter(Boolean).join(" ");
        entries.push({
          key: t.key,
          urid: t.urid,
          fields: {
            name: resolvedName || undefined,
            title: r.title || undefined,
            company: r.company || undefined,
            email: r.email || undefined,
            phone: r.phone || undefined,
            location: location || undefined,
            sector: r.industry || undefined,
            linkedinUrl: r.linkedinUrl || undefined,
          },
        });
      } catch (e) {
        console.error("[bulkResearchTargets] enrich failed", e);
        failed++;
      }
    }

    const res = await bulkUpdateTargetFieldsServer(entries, { fillOnly: true });
    if (matched > 0 || res.updated > 0) {
      await logOpsEventServer({
        action: "enrich",
        source: "targets_apollo",
        status: "ok",
        summary: `Apollo research · matched ${matched}/${data.targets.length}, ${res.updated} updated${notFound ? `, ${notFound} no match` : ""}${failed ? `, ${failed} failed` : ""}`,
        records: res.updated,
        details: { matched, notFound, failed },
      });
    }
    return { matched, notFound, failed, updated: res.updated };
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
  .handler(async ({ data }) => {
    const res = await bulkUpdateContactsServer(data.emails, data.field, data.value);
    if (res.updated > 0) {
      await logOpsEventServer({
        action: "edit",
        source: "contacts",
        status: "ok",
        summary: `Bulk-edited ${res.updated} contact${res.updated !== 1 ? "s" : ""} · ${data.field} → ${data.value}`,
        records: res.updated,
        details: { field: data.field, value: data.value },
      });
    }
    return res;
  });

// Hard-delete the given contacts (by email) from the Contacts sheet. Permanent.
export const bulkDeleteContacts = createServerFn({ method: "POST" })
  .inputValidator((data: { emails: string[] }) => data)
  .handler(async ({ data }) => {
    const res = await bulkDeleteContactsServer(data.emails);
    if (res.deleted > 0) {
      await logOpsEventServer({
        action: "delete",
        source: "contacts",
        status: "ok",
        summary: `Deleted ${res.deleted} contact${res.deleted !== 1 ? "s" : ""}`,
        records: res.deleted,
        items: data.emails.filter(Boolean),
      });
    }
    return res;
  });

// Hard-delete the given targets (by stable URID, or derived target key) from the
// Targets sheet. Permanent.
export const bulkDeleteTargets = createServerFn({ method: "POST" })
  .inputValidator((data: { entries: { key?: string; urid?: string }[] }) => data)
  .handler(async ({ data }) => {
    const res = await bulkDeleteTargetsServer(data.entries);
    if (res.deleted > 0) {
      await logOpsEventServer({
        action: "delete",
        source: "targets",
        status: "ok",
        summary: `Deleted ${res.deleted} target${res.deleted !== 1 ? "s" : ""}`,
        records: res.deleted,
        items: data.entries.map((e) => e.key || e.urid || "").filter(Boolean),
      });
    }
    return res;
  });

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
    (data: { contacts: { email: string; name: string; company?: string; urid?: string }[] }) =>
      data,
  )
  .handler(async ({ data }) => {
    const updates: BulkMergeUpdate[] = [];
    let matched = 0;
    let notFound = 0;
    let failed = 0;

    for (const c of data.contacts) {
      const email = (c.email || "").trim();
      if (!email) {
        failed++;
        continue;
      }
      const parts = (c.name || "").trim().split(/\s+/);
      try {
        const r = await enrichPerson({
          email,
          firstName: parts[0] || undefined,
          lastName: parts.slice(1).join(" ") || undefined,
          organizationName: c.company || undefined,
        });
        if (!r.found) {
          notFound++;
          continue;
        }
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
        const today = new Date().toISOString().split("T")[0];
        updates.push({
          email,
          urid: c.urid,
          fields: {
            title: r.title || undefined,
            company: r.company || undefined,
            email: r.email || undefined,
            phone: r.phone || undefined,
            location: location || undefined,
            sector: r.industry || undefined,
            linkedinUrl: r.linkedinUrl || undefined,
            headline: r.headline || undefined,
            employmentHistory: employment || undefined,
            apolloEnriched: "TRUE",
            apolloEnrichedDate: today,
          },
        });
      } catch (e) {
        console.error("[bulkEnrichContacts] enrich failed for", email, e);
        failed++;
      }
    }

    const res = await bulkMergeContactFieldsServer(updates, "apollo");
    if (matched > 0 || res.updated > 0 || failed > 0 || notFound > 0) {
      await logOpsEventServer({
        action: "enrich",
        source: "contacts_apollo",
        status: failed > 0 && matched === 0 ? "error" : "ok",
        summary: `Apollo enrich · matched ${matched}/${data.contacts.length}, ${res.updated} updated${notFound ? `, ${notFound} no match` : ""}${failed ? `, ${failed} failed` : ""}`,
        records: res.updated,
        details: { matched, notFound, failed, requested: data.contacts.length },
        items: updates.slice(0, 40).map((u) => {
          const fields = Object.keys(u.fields || {}).join(", ");
          return `${u.email}${fields ? ` · ${fields}` : ""}`;
        }),
      });
    }
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

// Append a row to the unified Ops Log (import / export / sync audit trail).
export const logOpsEvent = createServerFn({ method: "POST" })
  .inputValidator((data: OpsLogInput) => data)
  .handler(async ({ data }) => {
    await logOpsEventServer(data);
    return { success: true };
  });

/** BD/GTM activity GIDs owned by the signed-in teammate. */
export const fetchOwnershipIndex = createServerFn({ method: "POST" })
  .inputValidator((data: { email: string }) => data)
  .handler(async ({ data }) => buildOwnershipIndexServer(data.email));

/** Personalized Home attention queue + follow-up count for the signed-in user. */
export const fetchMyAttention = createServerFn({ method: "POST" })
  .inputValidator((data: { email: string }) => data)
  .handler(async ({ data }) => {
    const { networkContacts, buildAttentionQueue, hasOpenFollowUp } =
      await import("@/lib/attention-queue");
    const { teamProfile } = await import("@/lib/user-ownership");
    const profile = teamProfile(data.email);
    const mine = networkContacts(await buildMyContactsServer(data.email));
    const queue = buildAttentionQueue(mine);
    return {
      firstName: profile?.firstName || "there",
      displayName: profile?.displayName || data.email,
      myContactCount: mine.length,
      openFollowUps: mine.filter(hasOpenFollowUp).length,
      attention: queue.slice(0, 4),
      attentionTotal: queue.length,
      ownedGids: (await buildOwnershipIndexServer(data.email)).ownedGids,
    };
  });

/** Contacts attributed to the signed-in user (for Network “My contacts”). */
export const fetchMyContacts = createServerFn({ method: "POST" })
  .inputValidator((data: { email: string }) => data)
  .handler(async ({ data }) => {
    const { networkContacts } = await import("@/lib/attention-queue");
    return networkContacts(await buildMyContactsServer(data.email));
  });

// Recent imports for the Import History panel (newest first).
export const fetchImportHistory = createServerFn({ method: "GET" }).handler(async () =>
  buildImportHistory(),
);

// The per-action audit trail (Ops Log tab), newest first — powers the /activity view.
export const fetchOpsLog = createServerFn({ method: "GET" }).handler(
  async (): Promise<OpsLogEntry[]> => {
    try {
      return await buildOpsLogServer();
    } catch (error) {
      console.error("Failed to fetch ops log from Google Sheets:", error);
      return [];
    }
  },
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

/**
 * Close the loop when a drafted email is opened/sent: Notes trail + Email
 * Activity + Ops Log. Used by EmailDraftDialog so every entry point (CRM,
 * Signals, Targeting, Home) persists the same way.
 */
export const recordEmailSent = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      contactEmail: string;
      contactName?: string;
      subject: string;
      emailType: string;
      linkedPortcos?: string[];
      linkedEvent?: string;
      urid?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const email = (data.contactEmail || "").split(";")[0]?.trim() || "";
    if (!email) return { ok: false as const, error: "No contact email" };

    const portcos = (data.linkedPortcos || []).map((p) => p.trim()).filter(Boolean);
    const tag =
      portcos.length > 0
        ? ` [PortCo: ${portcos.join(", ")}]`
        : data.linkedEvent
          ? ` [Event: ${data.linkedEvent}]`
          : data.emailType && data.emailType !== "General"
            ? ` [${data.emailType}]`
            : "";
    const subject = (data.subject || "").trim();
    const summary =
      (subject ? `Email sent: ${subject}` : `Email sent to ${email}`) + tag;
    const today = new Date().toISOString().slice(0, 10);
    const sourceRef = `email-sent:${email.toLowerCase()}:${today}:${subject.slice(0, 80).toLowerCase()}`;

    await appendInteractionRows([
      {
        email,
        date: today,
        summary,
        type: "email",
        requiresFollowUp: false,
        urid: data.urid,
        sourceRef,
      },
    ]);

    await logEmailActivityServer({
      contactEmail: email,
      subject,
      emailType: data.emailType || "General",
      linkedPortco: portcos.join("; ") || undefined,
      linkedEvent: data.linkedEvent,
    });

    if (data.linkedEvent?.trim()) {
      try {
        await ensureEventAttendanceBatch([
          {
            email,
            eventName: data.linkedEvent.trim(),
            date: today,
            type: "invited",
            urid: data.urid,
            ensureCatalog: true,
            catalogType: "meeting",
          },
        ]);
      } catch (e) {
        console.error("[recordEmailSent] event attendance failed:", e);
      }
    }

    await logOpsEventServer({
      action: "sync",
      source: "email_sent",
      status: "ok",
      summary: `Email sent · ${data.contactName || email} · ${subject || "(no subject)"}`,
      records: 1,
      details: {
        email,
        emailType: data.emailType || "General",
        portcos: portcos.join("; ") || "",
        event: data.linkedEvent || "",
      },
      items: [`${email} ← ${summary}`],
    });

    return { ok: true as const, summary };
  });
