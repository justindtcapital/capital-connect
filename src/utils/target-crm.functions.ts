import { createServerFn } from "@tanstack/react-start";
import {
  addContactRow,
  appendInteractionRows,
  buildContacts,
  bulkUpdateTargetFields,
  ensureColumn,
  logOpsEvent,
  TAB_NAMES,
  type InteractionRowInput,
} from "./sheets.server";
import { normalizeSource, type OutreachAttempt, type RecordSource } from "@/lib/types";

export interface PromoteTargetInput {
  urid?: string;
  /** Legacy join key (email or name|company). */
  key?: string;
  name: string;
  title?: string;
  company?: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedinUrl?: string;
  sector?: string;
  originSource?: string;
  reasonSurfaced?: string;
  notes?: string;
  outreach?: OutreachAttempt[];
}

export interface PromoteTargetsResult {
  ok: boolean;
  error?: string;
  /** New Contacts rows. */
  added: number;
  /** Already in CRM (dedupe). */
  duplicates: number;
  /** Couldn't identify / write. */
  failed: number;
  /** Targets whose Stage was set to Ready to Promote. */
  stagesUpdated: number;
  /** Notes rows written (promo summary + outreach). */
  notesLogged: number;
  created: string[];
}

function dedupeKeys(name: string, company: string, email: string, linkedin: string): string[] {
  const keys: string[] = [];
  const e = (email || "").trim().toLowerCase();
  if (e) keys.push(`e:${e}`);
  const li = (linkedin || "").trim().toLowerCase().replace(/\/$/, "");
  if (li) keys.push(`li:${li}`);
  const nc = `${(name || "").trim()}|${(company || "").trim()}`.toLowerCase();
  if (nc.length > 1) keys.push(`nc:${nc}`);
  return keys;
}

function recordSourceFromOrigin(origin?: string): RecordSource {
  return normalizeSource(origin);
}

/**
 * Promote Targets into the Network CRM: create Contacts (deduped), stamp stage
 * Ready to Promote, log a promo note (+ outreach history), Ops Log `targets_crm`.
 */
export const promoteTargetsToCrm = createServerFn({ method: "POST" })
  .inputValidator((data: { targets: PromoteTargetInput[] }) => data)
  .handler(async ({ data }): Promise<PromoteTargetsResult> => {
    const result: PromoteTargetsResult = {
      ok: true,
      added: 0,
      duplicates: 0,
      failed: 0,
      stagesUpdated: 0,
      notesLogged: 0,
      created: [],
    };
    const targets = (data.targets || []).filter((t) => t.name?.trim() || t.email?.trim());
    if (targets.length === 0) {
      return { ...result, ok: false, error: "No targets to promote" };
    }

    try {
      const existing = new Set<string>();
      try {
        const contacts = await buildContacts();
        for (const c of contacts) {
          for (const k of dedupeKeys(c.name, c.company, c.email, c.linkedinUrl || "")) {
            existing.add(k);
          }
        }
      } catch {
        /* proceed without full dedupe */
      }

      await ensureColumn(TAB_NAMES.contacts, "Source");
      await ensureColumn(TAB_NAMES.contacts, "Source Context");

      const noteRows: InteractionRowInput[] = [];
      const seen = new Set<string>();
      const today = new Date().toISOString().slice(0, 10);

      for (const t of targets) {
        const name = (t.name || "").trim();
        const email = (t.email || "").trim();
        const company = (t.company || "").trim();
        const linkedin = (t.linkedinUrl || "").trim();
        const keys = dedupeKeys(name, company, email, linkedin);

        if (keys.length === 0) {
          result.failed++;
          continue;
        }
        if (keys.some((k) => existing.has(k) || seen.has(k))) {
          result.duplicates++;
          // Still bump stage so the pipeline reflects CRM-readiness.
          continue;
        }

        const source = recordSourceFromOrigin(t.originSource);
        const sourceContext = [
          t.reasonSurfaced?.trim(),
          t.notes?.trim(),
          "Promoted from Targeting",
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 500);

        try {
          await addContactRow({
            name: name || email,
            role: t.title || "",
            company,
            email,
            phone: t.phone || "",
            location: t.location || "",
            prime: "",
            sector: t.sector || "",
            temperature: "Warm",
            linkedin,
            source,
            sourceContext,
          });
          keys.forEach((k) => {
            seen.add(k);
            existing.add(k);
          });
          result.added++;
          const label = `${name || email}${email ? ` <${email}>` : ""}${company ? ` · ${company}` : ""}`;
          result.created.push(label);

          // Promo note on the contact (needs an email to join Notes).
          if (email) {
            const outreachBits = (t.outreach || [])
              .slice(0, 8)
              .map((o) => `${o.date || "?"} ${o.method || "touch"}: ${(o.summary || "").slice(0, 120)}`);
            const summary = [
              `Promoted from Targeting${t.reasonSurfaced ? ` · ${t.reasonSurfaced}` : ""}`,
              outreachBits.length ? `Outreach history:\n${outreachBits.join("\n")}` : "",
            ]
              .filter(Boolean)
              .join("\n")
              .slice(0, 1500);

            noteRows.push({
              email,
              date: today,
              summary,
              type: "note",
              requiresFollowUp: false,
              sourceRef: t.urid ? `target:${t.urid}` : `target:${email.toLowerCase()}`,
            });
          }
        } catch (e) {
          console.error("[targets-crm] addContactRow failed:", e);
          result.failed++;
        }
      }

      // Stage bump for everyone requested (including duplicates already in CRM).
      const stageEntries = targets
        .filter((t) => t.urid || t.key)
        .map((t) => ({
          urid: t.urid,
          key: t.key,
          fields: { stage: "Ready to Promote" as const },
        }));
      if (stageEntries.length > 0) {
        try {
          const stageRes = await bulkUpdateTargetFields(stageEntries);
          result.stagesUpdated = stageRes.updated;
        } catch (e) {
          console.error("[targets-crm] stage update failed:", e);
        }
      }

      if (noteRows.length > 0) {
        await appendInteractionRows(noteRows);
        result.notesLogged = noteRows.length;
      }

      await logOpsEvent({
        action: "import",
        source: "targets_crm",
        status: result.added > 0 || result.duplicates > 0 ? "ok" : "error",
        summary:
          `Promoted to CRM · +${result.added} contacts` +
          (result.duplicates ? ` · ${result.duplicates} already in CRM` : "") +
          (result.notesLogged ? ` · ${result.notesLogged} notes` : ""),
        records: result.added,
        details: {
          requested: targets.length,
          added: result.added,
          duplicates: result.duplicates,
          failed: result.failed,
          stagesUpdated: result.stagesUpdated,
          notesLogged: result.notesLogged,
        },
        items: result.created,
      });

      if (result.added === 0 && result.duplicates === 0 && result.failed > 0) {
        return { ...result, ok: false, error: "Couldn't promote any targets to CRM" };
      }
      return result;
    } catch (err) {
      console.error("[targets-crm] promoteTargetsToCrm failed:", err);
      const message = err instanceof Error ? err.message : "Promote to CRM failed";
      await logOpsEvent({
        action: "import",
        source: "targets_crm",
        status: "error",
        summary: message,
        records: 0,
      });
      return { ...result, ok: false, error: message };
    }
  });
