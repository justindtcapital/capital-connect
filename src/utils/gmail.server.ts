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
import { extractArticleLinks } from "@/lib/link-digest";
import type { AsanaActivity } from "@/lib/types";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  toEmails: string[];
  ccEmails: string[];
  /** Received time, epoch ms. */
  date: number;
  dateLabel: string;
  snippet: string;
  body: string;
  /** Cleaned candidate article links from the FULL body (pre-truncation) —
   *  used to detect + explode link-digest emails into per-article signals. */
  links: string[];
  permalink: string;
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
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Full body text + raw HTML part. Links must be extracted from these BEFORE
// the body is truncated for the feed — a digest email's later links would
// otherwise be silently lost to the length cap.
function extractParts(payload: any): { text: string; html: string } {
  const plain = findPart(payload, "text/plain");
  const html = findPart(payload, "text/html");
  const text =
    plain.trim() || (html ? stripHtml(html) : "") || decodeB64(payload?.body?.data).trim();
  return { text, html: html.slice(0, 300_000) };
}

function header(headers: any[], name: string): string {
  const h = (headers || []).find((x) => (x.name || "").toLowerCase() === name.toLowerCase());
  return h?.value || "";
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
  const parseList = (raw: string) =>
    raw
      .split(",")
      .map((s: string) => parseAddr(s).email)
      .filter(Boolean);
  const to = parseList(header(headers, "To"));
  const cc = parseList(header(headers, "Cc"));
  const date = Number(m.internalDate) || 0;
  const parts = extractParts(m.payload);
  return {
    id: String(m.id || id),
    threadId: String(m.threadId || ""),
    subject: header(headers, "Subject") || "(no subject)",
    fromName: from.name,
    fromEmail: from.email,
    toEmails: to,
    ccEmails: cc,
    date,
    dateLabel: toLabel(date),
    snippet: String(m.snippet || ""),
    body: parts.text.slice(0, 3000),
    links: extractArticleLinks(parts),
    permalink: `https://mail.google.com/mail/u/0/#all/${m.id}`,
  };
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

const FREE_EMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "msn.com",
]);

function companyFromEmail(email: string): string {
  const domain = (email.split("@")[1] || "").toLowerCase();
  if (!domain || FREE_EMAIL.has(domain)) return "";
  const sld = domain.split(".")[0] || "";
  if (!sld) return "";
  return sld.charAt(0).toUpperCase() + sld.slice(1);
}

function titleCaseLocal(local: string): string {
  return local
    .replace(/[._+]+/g, " ")
    .replace(/\d+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
    .slice(0, 80);
}

// Counterparties = people on the thread who are NOT our BD/GTM aliases (and not
// obvious noreply/system boxes). Their emails go into notes so contact matching
// can join on email the same way Asana matches on name.
function counterparties(m: GmailMessage, aliases: Set<string>): { name: string; email: string }[] {
  const system =
    /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|calendar|info|support|admin|team|hello|contact|help)$/i;
  const out = new Map<string, { name: string; email: string }>();
  const consider = (name: string, email: string) => {
    const e = (email || "").trim().toLowerCase();
    if (!e || aliases.has(e) || out.has(e)) return;
    const local = e.split("@")[0] || "";
    if (system.test(local)) return;
    out.set(e, { name: name || titleCaseLocal(local), email: e });
  };
  consider(m.fromName, m.fromEmail);
  for (const e of m.toEmails) consider("", e);
  for (const e of m.ccEmails) consider("", e);
  return [...out.values()];
}

function messageToActivity(
  m: GmailMessage,
  track: "BD" | "GTM",
  aliases: Set<string>,
): AsanaActivity {
  const others = counterparties(m, aliases);
  const primary = others[0];
  const fromEmail = (m.fromEmail || "").toLowerCase();
  const outbound = aliases.has(fromEmail);
  // Attribute ownership to the human on the From line when they mailed the
  // tracking alias (the usual BD/GTM workflow). When the alias itself sends,
  // Owner stays the alias address.
  const owner =
    fromEmail && !/^no-?reply/i.test(fromEmail.split("@")[0] || "") ? m.fromEmail : undefined;
  // The `People:` line carries the counterparty emails that contact-matching joins
  // on (matchActivitiesToContact). It comes BEFORE the free-text snippet so the
  // length cap below can only ever truncate the snippet, never the emails — else
  // real participants on a long thread would silently miss the attribution.
  const notesParts = [
    outbound ? "Outbound email" : "Inbound email",
    others.length ? `People: ${others.map((p) => `${p.name} <${p.email}>`).join("; ")}` : "",
    m.snippet || m.body.slice(0, 400),
  ].filter(Boolean);

  return {
    gid: `gmail-${m.id}`,
    track,
    name: m.subject,
    date: m.dateLabel || undefined,
    completed: true,
    status: outbound ? "Sent" : "Received",
    owner,
    type: "Email",
    company: primary ? companyFromEmail(primary.email) : undefined,
    person: primary?.name || undefined,
    notes: notesParts.join("\n").slice(0, 1000),
    url: m.permalink,
  };
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
  const aliasSet = new Set(aliases);
  return res.messages.map((m) => messageToActivity(m, track, aliasSet));
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
