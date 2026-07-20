/**
 * Server-side apply for Query write tools (approval-gated).
 * Single source of truth — the client only approves/declines; Sheets mutations
 * happen here so the agent log and CRM can't disagree.
 */
import {
  fetchSheetTab,
  updateSheetCell,
  addContactRow,
  appendSheetRow,
  ensureTab,
  ensureEventAttendanceBatch,
  primarySheetEmail,
  logOpsEvent,
  appendInteractionRows,
  appendTargetRows,
  updateTargetFields,
  bulkUpdateContacts,
  buildTargets,
  TAB_NAMES,
  APP_EVENT_HEADERS,
} from "./sheets.server";
import { normalizeInteractionType, targetKeyOf } from "@/lib/types";
import type { JsonValue } from "./llm.server";

// A1 column letters for any index (0 → A, 26 → AA, …).
function colLetters(idx: number): string {
  let out = "";
  let n = idx;
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export type ApplyWriteResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

function asRecord(input: JsonValue): Record<string, JsonValue> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, JsonValue>)
    : {};
}
function str(v: JsonValue | undefined): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function list(v: JsonValue | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function applyQueryWrite(
  toolName: string,
  rawInput: JsonValue,
): Promise<ApplyWriteResult> {
  const d = asRecord(rawInput);
  try {
    switch (toolName) {
      case "sheets_update_contact": {
        const email = str(d.email).trim();
        if (!email) return { ok: false, error: "Missing email" };
        const rows = await fetchSheetTab(TAB_NAMES.contacts);
        if (rows.length < 2) return { ok: false, error: "Contacts tab empty" };
        const headers = rows[0].map((h) => h.trim().toLowerCase());
        const emailIdx = headers.indexOf("email");
        if (emailIdx === -1) return { ok: false, error: "No Email column" };
        const FIELD_HEADERS: Record<string, string> = {
          title: "role",
          company: "company",
          phone: "phone number",
          location: "location",
          sector: "industry category",
          prime: "relationship prime",
        };
        const target = email.toLowerCase();
        for (let i = 1; i < rows.length; i++) {
          if ((rows[i][emailIdx] || "").trim().toLowerCase() !== target) continue;
          let updated = 0;
          const parts: string[] = [];
          for (const [field, header] of Object.entries(FIELD_HEADERS)) {
            if (d[field] === undefined || d[field] === null) continue;
            const value = str(d[field]);
            const colIdx = headers.indexOf(header);
            if (colIdx === -1) continue;
            await updateSheetCell(TAB_NAMES.contacts, `${colLetters(colIdx)}${i + 1}`, value);
            updated++;
            parts.push(`${field}=${value}`);
          }
          // Temperature goes through the rating path so the manual tier is
          // locked against the auto-scorecard and logged to Rating History.
          if (d.temperature !== undefined && d.temperature !== null) {
            const temp = str(d.temperature);
            await bulkUpdateContacts([email], "status", temp);
            updated++;
            parts.push(`temperature=${temp} (locked)`);
          }
          if (updated === 0) return { ok: false, error: "No writable fields provided" };
          return {
            ok: true,
            summary: `Approved & applied (sheets_update_contact): ${email} — ${parts.join(", ")}`,
          };
        }
        return { ok: false, error: `No contact with email ${email}` };
      }

      case "sheets_add_note": {
        const email = primarySheetEmail(str(d.contactEmail));
        const note = str(d.note).trim();
        if (!email || !note) return { ok: false, error: "Missing contactEmail or note" };
        const type = normalizeInteractionType(str(d.type));
        await appendInteractionRows([
          {
            email,
            date: new Date().toISOString().split("T")[0],
            summary: note,
            type,
            requiresFollowUp: d.requiresFollowUp === true,
          },
        ]);
        return {
          ok: true,
          summary: `Approved & applied (sheets_add_note): ${email} — ${type}${d.requiresFollowUp === true ? " (follow-up)" : ""}: ${note.slice(0, 120)}`,
        };
      }

      case "sheets_add_target": {
        const name = str(d.name).trim();
        if (!name) return { ok: false, error: "Missing target name" };
        const email = str(d.email).trim();
        const company = str(d.company).trim();
        // Authoritative dedup against the live pipeline (same rule as importTargets).
        try {
          const existing = await buildTargets();
          const key = targetKeyOf({ email, name, company });
          if (key && existing.some((t) => targetKeyOf(t) === key)) {
            return { ok: false, error: `${name} is already in the Targeting pipeline` };
          }
        } catch {
          /* dedup read failed — proceed with the add */
        }
        const parts = name.split(/\s+/).filter(Boolean);
        await appendTargetRows([
          {
            firstName: parts[0] || "",
            lastName: parts.slice(1).join(" "),
            company,
            role: str(d.title),
            linkedin: str(d.linkedin),
            email,
            location: str(d.location),
            sector: str(d.sector),
            stage: str(d.stage) || "Prospecting",
            source: "Manual Entry",
            researchPurpose: str(d.researchPurpose),
            reasonSurfaced: str(d.reasonSurfaced),
          },
        ]);
        return {
          ok: true,
          summary: `Approved & applied (sheets_add_target): ${name}${company ? ` · ${company}` : ""} — ${str(d.stage) || "Prospecting"}`,
        };
      }

      case "sheets_update_target": {
        const fields = asRecord(d.fields);
        const email = str(d.email).trim();
        const name = str(d.name).trim();
        const company = str(d.company).trim();
        if (!email && !name) return { ok: false, error: "Need email or name to identify the target" };
        const key = targetKeyOf({ email, name, company });
        if (!key) return { ok: false, error: "Could not derive a target key" };
        const updates: Record<string, string | undefined> = {};
        for (const f of ["stage", "sector", "title", "location", "notes"] as const) {
          if (fields[f] !== undefined && fields[f] !== null) updates[f] = str(fields[f]);
        }
        if (Object.keys(updates).length === 0) {
          return { ok: false, error: "No fields to update" };
        }
        const res = await updateTargetFields(key, updates);
        if (!res.success) {
          return { ok: false, error: `No target found for ${email || `${name} @ ${company}`}` };
        }
        return {
          ok: true,
          summary: `Approved & applied (sheets_update_target): ${email || name} — ${Object.entries(
            updates,
          )
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`,
        };
      }

      case "sheets_add_contact": {
        const name = str(d.name);
        const email = str(d.email);
        if (!name && !email) return { ok: false, error: "Missing name/email" };
        await addContactRow({
          name,
          role: str(d.title),
          company: str(d.company),
          email,
          phone: str(d.phone),
          location: str(d.location),
          prime: str(d.prime),
          sector: str(d.sector),
          temperature: str(d.temperature) || "Warm",
          source: "Manual Entry",
        });
        return {
          ok: true,
          summary: `Approved & applied (sheets_add_contact): ${name || email}`,
        };
      }

      case "sheets_add_event": {
        const name = str(d.name);
        if (!name) return { ok: false, error: "Missing event name" };
        await ensureTab(TAB_NAMES.appEvents, APP_EVENT_HEADERS);
        await appendSheetRow(TAB_NAMES.appEvents, [
          name,
          str(d.date),
          "",
          str(d.type),
          str(d.lead),
          str(d.format),
          str(d.role),
          list(d.sectors).join(", "),
          list(d.portcos).join(", "),
        ]);
        await logOpsEvent({
          action: "sync",
          source: "app_event",
          status: "ok",
          summary: `App event catalog · ${name}${d.date ? ` · ${str(d.date)}` : ""}`,
          records: 1,
          details: { name, date: str(d.date), type: str(d.type) },
          items: [name],
        });
        return {
          ok: true,
          summary: `Approved & applied (sheets_add_event): ${name}`,
        };
      }

      case "sheets_add_attendees": {
        const eventName = str(d.eventName).trim();
        const emails = list(d.emails);
        const type = str(d.type).toLowerCase() === "invited" ? "invited" : "attended";
        if (!eventName || emails.length === 0) {
          return { ok: false, error: "Missing eventName or emails" };
        }
        let written = 0;
        for (const raw of emails) {
          const email = primarySheetEmail(raw);
          if (!email) continue;
          const res = await ensureEventAttendanceBatch([
            {
              email,
              eventName,
              type,
              ensureCatalog: true,
              catalogType: "meeting",
            },
          ]);
          written += res.attendanceWritten;
        }
        return {
          ok: true,
          summary: `Approved & applied (sheets_add_attendees): ${eventName} · ${emails.length} ${type} (${written} rows)`,
        };
      }

      default:
        return { ok: false, error: `Unknown write tool ${toolName}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Write failed" };
  }
}
