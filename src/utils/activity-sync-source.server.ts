// Auto-create CRM contacts for external people on BD/GTM activities during sync.
// Uses the machine-readable People line (Gmail) or email scan (Asana). Skips
// internals, aliases, noise, and name-only calendar placeholders. Idempotent
// by email against the Contacts tab.

import { peopleEntriesFromActivity } from "@/lib/activity-canonical";
import { isNameOnlyAttendeeEmail, isPlausibleAddress, sanitizeEmailToken } from "@/lib/email-address";
import { contactImportRejectReason, isGarbageContactName } from "@/lib/contact-noise";
import { isInternalEmail, isNoiseEmail } from "@/lib/email-noise";
import { normalizeSector } from "@/lib/sectors";
import type { AsanaActivity } from "@/lib/types";
import { enrichPerson } from "./apollo.server";
import { getActivityAliases, getInternalConfig } from "./gmail.server";
import {
  addContactRow,
  ensureColumn,
  fetchContactEmails,
  logOpsEvent,
  TAB_NAMES,
} from "./sheets.server";

function nameParts(name: string): { firstName?: string; lastName?: string } {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export interface SyncSourceContactsResult {
  createdCount: number;
  existingCount: number;
  enrichedCount: number;
  skippedInternal: number;
  created: string[];
  apolloUnavailable: boolean;
}

const EMPTY: SyncSourceContactsResult = {
  createdCount: 0,
  existingCount: 0,
  enrichedCount: 0,
  skippedInternal: 0,
  created: [],
  apolloUnavailable: false,
};

function companyFromEmail(email: string): string {
  if (isNameOnlyAttendeeEmail(email)) return "";
  const domain = (email.split("@")[1] || "").toLowerCase();
  if (!domain || domain === "attendee.local") return "";
  const sld = domain.split(".")[0] || "";
  if (!sld) return "";
  return sld.charAt(0).toUpperCase() + sld.slice(1);
}

/**
 * Domains that must never be auto-sourced into Contacts during BD/GTM sync.
 * Matches manual Source contacts (`parseActivityThreads` defaults to dell.com):
 * Dell teammates show up on PortCo threads but are not CRM counterparties.
 * Override with ACTIVITY_SYNC_SKIP_DOMAINS (comma-separated).
 */
function autoSourceSkipDomains(): string[] {
  const raw = (process.env.ACTIVITY_SYNC_SKIP_DOMAINS || "dell.com").trim();
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isAutoSourceSkippedDomain(email: string): boolean {
  const domain = (email.split("@")[1] || "").toLowerCase();
  if (!domain) return true;
  return autoSourceSkipDomains().some(
    (d) => domain === d || domain.endsWith(`.${d}`),
  );
}

/** True unless ACTIVITY_SYNC_AUTO_SOURCE is explicitly "false". */
export function isActivitySyncAutoSourceEnabled(): boolean {
  const v = (process.env.ACTIVITY_SYNC_AUTO_SOURCE || "true").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

/**
 * Create Contacts rows for external people on these activities who are not
 * already in the CRM. Safe to call on every sync — never duplicates by email.
 */
export async function sourceMissingContactsFromActivities(
  activities: AsanaActivity[],
): Promise<SyncSourceContactsResult> {
  if (!isActivitySyncAutoSourceEnabled() || activities.length === 0) {
    return { ...EMPTY };
  }

  const maxCreate = Math.max(1, Number(process.env.ACTIVITY_SYNC_SOURCE_MAX) || 100);
  const wantApollo = (process.env.ACTIVITY_SYNC_SOURCE_APOLLO || "true")
    .trim()
    .toLowerCase() !== "false";

  const internal = getInternalConfig();
  const aliases = new Set(getActivityAliases().map((e) => e.toLowerCase()));

  const candidates = new Map<
    string,
    { name: string; email: string; company: string }
  >();
  let skippedInternal = 0;

  for (const a of activities) {
    for (const p of peopleEntriesFromActivity(a)) {
      const email = sanitizeEmailToken(p.email || "");
      if (!email || !isPlausibleAddress(email) || candidates.has(email)) continue;
      if (aliases.has(email) || isNoiseEmail(email) || isNameOnlyAttendeeEmail(email)) {
        skippedInternal++;
        continue;
      }
      if (isInternalEmail(email, internal) || isAutoSourceSkippedDomain(email)) {
        skippedInternal++;
        continue;
      }
      // Skip parse debris / garbage display names.
      let name = (p.name || "").trim();
      if (!name || /^[(\[{]/.test(name) || /[<>@%]/.test(name)) {
        name = email.split("@")[0] || email;
      }
      if (
        isGarbageContactName(name) ||
        contactImportRejectReason({ name, email, company: companyFromEmail(email) })
      ) {
        skippedInternal++;
        continue;
      }
      // Employer = email domain (or Apollo later). Never use the activity's
      // Company/PortCo tags — those are accounts on the thread, not the person.
      candidates.set(email, {
        name,
        email,
        company: companyFromEmail(email),
      });
    }
  }

  if (candidates.size === 0) return { ...EMPTY, skippedInternal };

  const existing = new Set((await fetchContactEmails()).map((e) => e.toLowerCase()));
  await ensureColumn(TAB_NAMES.contacts, "Source");
  await ensureColumn(TAB_NAMES.contacts, "Source Context");
  await ensureColumn(TAB_NAMES.contacts, "LinkedIn");
  await ensureColumn(TAB_NAMES.contacts, "Sector");

  const created: string[] = [];
  let existingCount = 0;
  let enrichedCount = 0;
  let apolloOff = !wantApollo;

  for (const p of candidates.values()) {
    if (existing.has(p.email)) {
      existingCount++;
      continue;
    }
    if (created.length >= maxCreate) break;

    let name = p.name;
    let role = "";
    let company = p.company;
    let phone = "";
    let location = "";
    let linkedin = "";
    let sector = "";

    if (!apolloOff) {
      try {
        const { firstName, lastName } = nameParts(name);
        const ap = await enrichPerson({
          email: p.email,
          organizationName: company || undefined,
          firstName,
          lastName,
        });
        if (ap.accessDenied) {
          apolloOff = true;
        } else if (ap.found) {
          if (ap.name) name = ap.name;
          if (ap.title) role = ap.title;
          if (ap.company) company = ap.company;
          if (ap.phone) phone = ap.phone;
          if (ap.linkedinUrl) linkedin = ap.linkedinUrl;
          if (ap.industry) sector = normalizeSector(ap.industry);
          const loc = [ap.city, ap.state, ap.country].filter(Boolean).join(", ");
          if (loc) location = loc;
          enrichedCount++;
        }
      } catch (err) {
        console.error("[activity] sync auto-source Apollo failed:", err);
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
      linkedin,
      prime: "",
      sector,
      temperature: "Cold",
      source: "Activity Sync",
      sourceContext: "Auto-sourced from BD/GTM activity sync",
      // PortCo engagement is tagged separately; don't stamp Sector=Portfolio
      // just because Apollo/company text mentions a portfolio name.
      skipPortfolioSector: true,
    });
    existing.add(p.email);
    created.push(`${name} (${p.email})`);
  }

  if (created.length > 0) {
    await logOpsEvent({
      action: "enrich",
      source: "activity_sync_source",
      status: "ok",
      summary: `Auto-sourced ${created.length} contact${created.length !== 1 ? "s" : ""} from BD/GTM sync`,
      records: created.length,
      details: {
        created: created.length,
        existing: existingCount,
        enriched: enrichedCount,
        skippedInternal,
        apolloUnavailable: apolloOff && wantApollo,
      },
      items: created.map((c) => `[contact] ${c}`),
    });
  }

  return {
    createdCount: created.length,
    existingCount,
    enrichedCount,
    skippedInternal,
    created,
    apolloUnavailable: apolloOff && wantApollo,
  };
}
