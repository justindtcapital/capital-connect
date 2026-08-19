// Recover the real counterparties from a forwarded message body.
//
// The team's workflow is often "forward the thread to the tracking alias after
// the fact". The headers of such a message contain only internal people, so the
// only trace of the actual contact is the quoted original header block every
// mail client writes at the top of a forward:
//
//   ---------- Forwarded message ---------
//   From: Vrashank Jain <vrashank.j@dell.com>
//   Date: Tue, Aug 12, 2026 at 9:04 AM
//   Subject: MaxIQ > Dell DFS
//   To: Chris Falloon <chris@dt-capital.net>
//
// Outlook / Teams appointment copies use a similar block:
//
//   -----Original Appointment-----
//   From: Falloon, Chris
//   Sent: Tuesday, July 21, 2026 8:29 AM
//   To: Falloon, Chris; Or Zabludowski
//   Cc: Beech, Julia
//
// Conservative by design: only the FIRST forwarded/appointment block is trusted,
// and callers should only use it when header-level extraction found nobody
// external (or for calendar meetings that omit attendees from MIME headers).

import {
  parseAddressOrDisplayList,
  type EmailAddress,
} from "./email-address";
import { isInternalEmail, type InternalConfig } from "./email-noise";

export interface ForwardedHeaders {
  from?: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject?: string;
  /**
   * True when the original From belongs to our team. Only set when the caller
   * passes an InternalConfig — used so a self-forward of an inbound touch logs
   * as Received, not Sent.
   */
  fromIsInternal?: boolean;
}

const BLOCK_START =
  /(-{2,}\s*forwarded message\s*-{2,}|-{2,}\s*original (?:message|appointment)\s*-{2,}|\bbegin forwarded message:)/im;

/** True when the subject looks like a forward (FW:, Fwd:, TR:). */
export function isForwardedSubject(subject: string): boolean {
  return /^\s*(fw|fwd|tr)\s*:/i.test(subject || "");
}

/**
 * Extract addresses from the first quoted forwarded-header / Original
 * Appointment block in a body. Returns null when no parseable From/To/Cc is
 * found. Pass `internal` to populate `fromIsInternal` for direction attribution.
 *
 * Display names without emails (common on Outlook appointments) are kept as
 * name-only attendee placeholders.
 */
export function extractForwardedHeaders(
  body: string,
  internal?: InternalConfig,
): ForwardedHeaders | null {
  const text = (body || "").replace(/\r\n/g, "\n");
  if (!text.trim()) return null;

  const marker = text.match(BLOCK_START);
  // Some clients omit the banner and start straight into "From: ..." lines.
  const startIdx = marker
    ? (marker.index ?? 0) + marker[0].length
    : text.search(/^\s*>?\s*from\s*:/im);
  if (startIdx < 0) return null;

  // The header block is short: scan only the next ~40 lines / 4000 chars.
  const window = text.slice(startIdx, startIdx + 4000).split("\n").slice(0, 40);

  const out: ForwardedHeaders = { to: [], cc: [] };
  let sawFrom = false;
  for (const rawLine of window) {
    const line = rawLine.replace(/^\s*>+\s?/, "").trim();
    if (!line) {
      // A blank line after the From: line ends the header block.
      if (sawFrom) break;
      continue;
    }
    const m = line.match(/^(from|to|cc|subject|sent|date)\s*:\s*(.*)$/i);
    if (!m) {
      if (sawFrom) break; // body text started
      continue;
    }
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "from") {
      const addrs = parseAddressOrDisplayList(value);
      if (addrs.length > 0) {
        out.from = addrs[0];
        sawFrom = true;
      }
    } else if (field === "to") {
      out.to.push(...parseAddressOrDisplayList(value));
    } else if (field === "cc") {
      out.cc.push(...parseAddressOrDisplayList(value));
    } else if (field === "subject" && !out.subject) {
      out.subject = value.slice(0, 300);
    }
  }
  if (!out.from && out.to.length === 0 && out.cc.length === 0) return null;
  if (internal && out.from) {
    out.fromIsInternal =
      isInternalEmail(out.from.email, internal) ||
      nameMatchesInternal(out.from.name, internal);
  }
  return out;
}

/** Rough match: "Falloon, Chris" ↔ chris.falloon@… listed in internal addresses. */
export function nameMatchesInternal(name: string, cfg: InternalConfig): boolean {
  const tokens = nameTokens(name);
  if (tokens.length < 2) return false;
  for (const addr of cfg.addresses) {
    const local = (addr.split("@")[0] || "").toLowerCase();
    const parts = local.split(/[._+-]+/).filter((t) => t.length > 1);
    if (parts.length >= 2 && parts.every((p) => tokens.includes(p))) return true;
  }
  return false;
}

function nameTokens(name: string): string[] {
  let s = (name || "").toLowerCase().trim();
  const comma = s.match(/^([^,]+),\s*(.+)$/);
  if (comma) s = `${comma[2]} ${comma[1]}`;
  return s
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}
