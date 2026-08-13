// Gmail integration — read the connected Google mailbox.
//
// Three consumers share this module:
//   1. Signals — network emails (gated by GMAIL_SIGNALS_ENABLED).
//   2. BD/GTM activity sync — messages to/from dedicated aliases
//      (GMAIL_BD_ALIAS / GMAIL_GTM_ALIAS), mirrored into the BD & GTM sheets
//      the same way Asana activities are.
//   3. CRM deepen — sent mail + calendar invites matched to contact emails
//      (GMAIL_CRM_SYNC_ENABLED), logged as Notes on Sync activity.
//
// Reuses the SAME Google OAuth refresh token as Sheets/Drive (getAccessToken).
// The token must be minted with gmail.readonly — re-run mint-google-token.mjs
// and paste the new GOOGLE_REFRESH_TOKEN. Enable the Gmail API in GCP too.

import { getAccessToken } from "./sheets.server";
import { sanitizeEmailText } from "@/lib/email-body-clean";
import { extractArticleLinks } from "@/lib/link-digest";
import { isBulkOrAutomatedMail } from "@/lib/email-noise";
import {
  parseAddressList,
  isPlausibleEmail,
  type EmailAddr,
  type InternalMailConfig,
} from "@/lib/email-participants";
import {
  isFreeEmailDomain,
  threadToActivity,
  threadsToActivities,
} from "@/lib/email-activity-build";
import { TEAM_MEMBER_EMAILS } from "@/lib/user-ownership";
import type { AsanaActivity } from "@/lib/types";
import { isActivityTrackingMessage as isActivityTrackingMessageLib } from "@/lib/email-activity";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** A PDF attached to a message — metadata only; bytes come via
 *  downloadGmailAttachment on demand (attachments can be large). */
export interface GmailAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  attachmentId: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  toEmails: string[];
  ccEmails: string[];
  /** To/Cc recipients WITH display names (proper address-list parse — quoted
   *  "Last, First" names survive; naive comma-splitting destroyed them). */
  toAddrs: EmailAddr[];
  ccAddrs: EmailAddr[];
  /** Delivered-To header values (lowercased) — how alias-forwarded mail is
   *  recognized even when the alias never appears in From/To/Cc. */
  deliveredTo: string[];
  /** Received time, epoch ms. */
  date: number;
  dateLabel: string;
  snippet: string;
  body: string;
  /** Cleaned candidate article links from the FULL body (pre-truncation) —
   *  used to detect + explode link-digest emails into per-article signals. */
  links: string[];
  /** PDF attachments (metadata only). */
  attachments: GmailAttachment[];
  permalink: string;
  /** True when List-Unsubscribe / Precedence / Auto-Submitted look like bulk mail. */
  isBulk?: boolean;
}
export interface GmailResult {
  ok: boolean;
  messages: GmailMessage[];
  error?: string;
}

export function isGmailConfigured(): boolean {
  return process.env.GMAIL_SIGNALS_ENABLED === "true";
}

/** True when at least one BD/GTM activity alias is configured. */
export function isGmailActivityConfigured(): boolean {
  return (
    parseAliasList(process.env.GMAIL_BD_ALIAS).length > 0 ||
    parseAliasList(process.env.GMAIL_GTM_ALIAS).length > 0
  );
}

function parseAliasList(raw?: string): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[;,]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes("@"));
}

/** Combined BD + GTM activity alias addresses (lowercased). These belong to the
 *  activity-sync pipeline (BD/GTM sheets) and must be kept OUT of the Signals feed. */
export function getActivityAliases(): string[] {
  return [
    ...parseAliasList(process.env.GMAIL_BD_ALIAS),
    ...parseAliasList(process.env.GMAIL_GTM_ALIAS),
  ];
}

/**
 * True when a Gmail message is BD/GTM activity-tracking mail — not a news signal.
 * Catches alias delivery (To/Cc/Delivered-To), DTC tracking subjects, and
 * meeting invites that belong on the Activity / GTM-Tracking pipeline.
 */
export function isActivityTrackingMessage(
  m: {
    fromEmail?: string;
    toEmails?: string[];
    ccEmails?: string[];
    deliveredTo?: string[];
    subject?: string;
    body?: string;
    snippet?: string;
  },
  aliasSet?: Set<string>,
): boolean {
  return isActivityTrackingMessageLib(m, aliasSet ?? new Set(getActivityAliases()));
}

/** NEWS@ ingestion alias addresses (lowercased) — the diagram's "forward it for
 *  processing" inbox. One alias is enough: the scan's own classification routes
 *  each item by type, so per-type aliases buy nothing. */
export function getNewsAliases(): string[] {
  return parseAliasList(process.env.GMAIL_NEWS_ALIAS);
}

function decodeB64(data?: string): string {
  if (!data) return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

// Recursively find the first part of a given MIME type and decode it.
function findPart(part: any, mime: string): string {
  if (!part) return "";
  if (part.mimeType === mime && part.body?.data) return decodeB64(part.body.data);
  for (const p of part.parts || []) {
    const r = findPart(p, mime);
    if (r) return r;
  }
  return "";
}

function stripHtml(html: string): string {
  // Drop mailto hrefs before stripping tags so we don't glue
  // "user@x.com" + "mailto:user@x.com" into one token.
  const withoutMailtoHref = html.replace(
    /<a\b[^>]*\bhref\s*=\s*["']?\s*mailto:[^"'>\s]+["']?[^>]*>/gi,
    "<a>",
  );
  return withoutMailtoHref
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/([\w.+-]+@[\w.-]+\.\w{2,})mailto:\1/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Full body text + raw HTML part. Links must be extracted from these BEFORE
// the body is truncated for the feed — a digest email's later links would
// otherwise be silently lost to the length cap.
function extractParts(payload: any): { text: string; html: string } {
  const plain = findPart(payload, "text/plain");
  const html = findPart(payload, "text/html");
  const text = sanitizeEmailText(
    plain.trim() || (html ? stripHtml(html) : "") || decodeB64(payload?.body?.data).trim(),
  );
  return { text, html: html.slice(0, 300_000) };
}

function header(headers: any[], name: string): string {
  const h = (headers || []).find((x) => (x.name || "").toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

// Some headers repeat (Delivered-To appears once per delivery hop) — collect all.
function headerAll(headers: any[], name: string): string[] {
  return (headers || [])
    .filter((x) => (x.name || "").toLowerCase() === name.toLowerCase())
    .map((x) =>
      String(x.value || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

// Recursively collect PDF attachment metadata. Attachment bytes are NOT
// fetched here — they're downloaded on demand (downloadGmailAttachment) only
// for messages the Signals pipeline actually wants documents from.
function collectPdfAttachments(part: any, out: GmailAttachment[]): void {
  if (!part) return;
  const filename = String(part.filename || "");
  const mime = String(part.mimeType || "");
  if (part.body?.attachmentId && (mime === "application/pdf" || /\.pdf$/i.test(filename))) {
    out.push({
      filename: filename || "attachment.pdf",
      mimeType: "application/pdf",
      sizeBytes: Number(part.body.size) || 0,
      attachmentId: String(part.body.attachmentId),
    });
  }
  for (const p of part.parts || []) collectPdfAttachments(p, out);
}

function parseAddr(v: string): { name: string; email: string } {
  const m = v.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: "", email: v.trim().toLowerCase() };
}

function toLabel(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function getMessage(token: string, id: string): Promise<GmailMessage | null> {
  let res: Response;
  try {
    res = await fetch(`${GMAIL_API}/messages/${id}?format=full`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const m = (await res.json()) as any;
  const headers = m.payload?.headers || [];
  const from = parseAddr(header(headers, "From"));
  // RFC 5322 address-list parse: respects quotes/angle brackets, keeps display
  // names, and drops any token without a plausible local@domain shape.
  const toAddrs = parseAddressList(header(headers, "To"));
  const ccAddrs = parseAddressList(header(headers, "Cc"));
  const deliveredTo = headerAll(headers, "Delivered-To")
    .map((v) => parseAddr(v).email)
    .filter((e) => isPlausibleEmail(e));
  const date = Number(m.internalDate) || 0;
  const parts = extractParts(m.payload);
  const attachments: GmailAttachment[] = [];
  collectPdfAttachments(m.payload, attachments);
  const isBulk = isBulkOrAutomatedMail({
    listUnsubscribe: header(headers, "List-Unsubscribe"),
    precedence: header(headers, "Precedence"),
    autoSubmitted: header(headers, "Auto-Submitted"),
    feedbackId: header(headers, "Feedback-ID") || header(headers, "X-Feedback-ID"),
    xMailer: header(headers, "X-Mailer"),
  });
  return {
    id: String(m.id || id),
    threadId: String(m.threadId || ""),
    subject: header(headers, "Subject") || "(no subject)",
    fromName: from.name,
    fromEmail: from.email,
    toEmails: toAddrs.map((a) => a.email),
    ccEmails: ccAddrs.map((a) => a.email),
    toAddrs,
    ccAddrs,
    deliveredTo,
    date,
    dateLabel: toLabel(date),
    snippet: String(m.snippet || ""),
    body: parts.text.slice(0, 3000),
    links: extractArticleLinks(parts),
    attachments,
    permalink: `https://mail.google.com/mail/u/0/#all/${m.id}`,
    isBulk,
  };
}

// Download one attachment's bytes as STANDARD base64 (Gmail returns base64url;
// Gemini inlineData wants classic base64). Null on any failure — callers treat
// attachments as best-effort grounding, never a scan blocker.
export async function downloadGmailAttachment(
  messageId: string,
  attachmentId: string,
): Promise<string | null> {
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return null;
  }
  try {
    const res = await fetch(
      `${GMAIL_API}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: string };
    if (!data.data) return null;
    return Buffer.from(data.data, "base64url").toString("base64");
  } catch {
    return null;
  }
}
// Low-level search — needs a valid Google token with gmail.readonly, not Signals.
async function searchGmailRaw(query: string, max = 25): Promise<GmailResult> {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (e) {
    console.error("[gmail] auth failed:", e);
    return { ok: false, messages: [], error: "Google auth failed." };
  }

  let listRes: Response;
  try {
    listRes = await fetch(
      `${GMAIL_API}/messages?${new URLSearchParams({ q: query, maxResults: String(Math.min(50, Math.max(1, max))) })}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch (e) {
    console.error("[gmail] network error:", e);
    return { ok: false, messages: [], error: "Could not reach Gmail." };
  }

  if (!listRes.ok) {
    const body = await listRes.text().catch(() => "");
    console.error(`[gmail] list ${listRes.status}: ${body.slice(0, 250)}`);
    let error = `Gmail API error ${listRes.status}.`;
    if (
      listRes.status === 403 ||
      /insufficient|scope|ACCESS_TOKEN_SCOPE|not been used|disabled/i.test(body)
    ) {
      error =
        "Gmail not accessible — re-run mint-google-token.mjs (now requests gmail.readonly), update GOOGLE_REFRESH_TOKEN, and enable the Gmail API in the Google Cloud project.";
    } else if (listRes.status === 401) {
      error = "Google token invalid or expired — re-mint it.";
    }
    return { ok: false, messages: [], error };
  }

  let listData: { messages?: Array<{ id: string }> };
  try {
    listData = (await listRes.json()) as { messages?: Array<{ id: string }> };
  } catch {
    return { ok: false, messages: [], error: "Gmail returned an unreadable response." };
  }

  const ids = (listData.messages || []).map((m) => m.id).filter(Boolean);
  const messages: GmailMessage[] = [];
  for (const id of ids) {
    const m = await getMessage(token, id);
    if (m) messages.push(m);
  }
  messages.sort((a, b) => b.date - a.date);
  return { ok: true, messages };
}

// Search the mailbox with a Gmail query and return parsed messages (newest first).
// Gated behind GMAIL_SIGNALS_ENABLED for the Signals consumer.
export async function searchGmail(query: string, max = 25): Promise<GmailResult> {
  if (!isGmailConfigured()) {
    return {
      ok: false,
      messages: [],
      error: "Gmail signals are disabled (set GMAIL_SIGNALS_ENABLED=true).",
    };
  }
  return searchGmailRaw(query, max);
}

/** Comma/semicolon list env var → lowercased entries (no @ requirement — domains). */
function parseDomainList(raw?: string): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[;,]/)
    .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

/**
 * Which addresses/domains count as "our side" for activity attribution:
 *   GMAIL_INTERNAL_DOMAINS    — whole domains (e.g. dt-capital.net). The
 *                               non-free domains of the tracking aliases are
 *                               always included automatically.
 *   GMAIL_INTERNAL_ADDRESSES  — specific internal people. The team roster in
 *                               user-ownership.ts is always included, so the
 *                               Dell teammates who forward threads are covered
 *                               without blanket-excluding all of dell.com
 *                               (Dell BUs are legitimate GTM counterparties).
 */
export function getInternalMailConfig(): InternalMailConfig {
  const domains = new Set(parseDomainList(process.env.GMAIL_INTERNAL_DOMAINS));
  for (const alias of getActivityAliases()) {
    const domain = alias.split("@")[1] || "";
    if (domain && !isFreeEmailDomain(domain)) domains.add(domain);
  }
  const addresses = new Set([
    ...parseAliasList(process.env.GMAIL_INTERNAL_ADDRESSES),
    ...TEAM_MEMBER_EMAILS.map((e) => e.toLowerCase()),
  ]);
  return { domains, addresses };
}

/** Convert a Gmail message into a BD/GTM activity, or null when it is noise.
 *  Thin wrapper over the pure builder (lib/email-activity-build) — kept for the
 *  diagnostic script and single-message callers; the sync itself groups by
 *  thread via threadsToActivities. */
export function messageToActivity(
  m: GmailMessage,
  track: "BD" | "GTM",
  aliases: Set<string>,
  internal: InternalMailConfig = getInternalMailConfig(),
): AsanaActivity | null {
  return threadToActivity([m], track, aliases, internal);
}
async function fetchTrackFromAliases(
  track: "BD" | "GTM",
  aliases: string[],
): Promise<AsanaActivity[]> {
  if (aliases.length === 0) return [];
  const windowDays = Number(process.env.GMAIL_ACTIVITY_WINDOW_DAYS) || 90;
  const max = Number(process.env.GMAIL_ACTIVITY_MAX) || 50;
  // Match mail sent as the alias OR received at the alias (To/Cc).
  const terms = aliases.flatMap((a) => [`from:${a}`, `to:${a}`, `cc:${a}`]).join(" OR ");
  const q = `newer_than:${windowDays}d (${terms})`;
  const res = await searchGmailRaw(q, max);
  if (!res.ok) {
    console.error(`[gmail] ${track} alias sync failed:`, res.error);
    return [];
  }
  // One activity per THREAD — reply chains collapse instead of producing a row
  // per message (counterparties are unioned across the thread's messages).
  return threadsToActivities(res.messages, track, new Set(aliases), getInternalMailConfig());
}

// Pull BD/GTM emails from the configured Gmail aliases into AsanaActivity-shaped
// records so they flow through the same sheet + contact-match pipeline as Asana.
// Requires the aliases to deliver into the Google mailbox backing GOOGLE_REFRESH_TOKEN.
export async function fetchAliasActivities(): Promise<AsanaActivity[]> {
  const bd = parseAliasList(process.env.GMAIL_BD_ALIAS);
  const gtm = parseAliasList(process.env.GMAIL_GTM_ALIAS);
  if (bd.length === 0 && gtm.length === 0) return [];

  const [bdActs, gtmActs] = await Promise.all([
    fetchTrackFromAliases("BD", bd),
    fetchTrackFromAliases("GTM", gtm),
  ]);
  const out = [...bdActs, ...gtmActs];
  out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return out;
}

/** Opt-in CRM deepen: sent mail + calendar invites → Notes on Sync activity. */
export function isGmailCrmSyncConfigured(): boolean {
  return process.env.GMAIL_CRM_SYNC_ENABLED === "true";
}

export interface CrmMailboxTouch {
  message: GmailMessage;
  /** "sent" = outbound mail; "calendar" = invite / update / RSVP. */
  kind: "sent" | "calendar";
}

/**
 * Recent sent mail + calendar invite traffic for CRM Notes sync.
 * Does not require GMAIL_SIGNALS_ENABLED — uses searchGmailRaw directly.
 */
export async function fetchCrmMailboxTouches(): Promise<{
  ok: boolean;
  error?: string;
  touches: CrmMailboxTouch[];
}> {
  if (!isGmailCrmSyncConfigured()) {
    return { ok: true, touches: [] };
  }
  const windowDays = Number(process.env.GMAIL_CRM_WINDOW_DAYS) || 30;
  const max = Number(process.env.GMAIL_CRM_MAX) || 40;

  const [sentRes, calRes] = await Promise.all([
    searchGmailRaw(`in:sent newer_than:${windowDays}d`, max),
    searchGmailRaw(
      `newer_than:${windowDays}d (filename:ics OR subject:(invitation OR invited OR "Invitation:" OR "Updated invitation" OR "Canceled event" OR accepted: OR declined:))`,
      max,
    ),
  ]);

  if (!sentRes.ok && !calRes.ok) {
    return {
      ok: false,
      error: sentRes.error || calRes.error || "Gmail CRM sync failed",
      touches: [],
    };
  }

  const seen = new Set<string>();
  const touches: CrmMailboxTouch[] = [];
  for (const m of sentRes.ok ? sentRes.messages : []) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    touches.push({ message: m, kind: "sent" });
  }
  for (const m of calRes.ok ? calRes.messages : []) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    touches.push({ message: m, kind: "calendar" });
  }
  touches.sort((a, b) => b.message.date - a.message.date);
  return { ok: true, touches };
}
