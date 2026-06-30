// Gmail integration — pull the associated account's recent emails into Signals.
//
// Reuses the SAME Google OAuth refresh token as Sheets/Drive (getAccessToken).
// The token must be minted with the Gmail read-only scope
// (https://www.googleapis.com/auth/gmail.readonly) — re-run mint-google-token.mjs
// and paste the new GOOGLE_REFRESH_TOKEN. The Gmail API must also be enabled in
// the Google Cloud project.
//
// Gated behind GMAIL_SIGNALS_ENABLED=true so it never calls Gmail until the user
// has set up the scope. Reads full message bodies (user's explicit choice).

import { getAccessToken } from "./sheets.server";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  toEmails: string[];
  /** Received time, epoch ms. */
  date: number;
  dateLabel: string;
  snippet: string;
  body: string;
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

function extractBody(payload: any): string {
  const plain = findPart(payload, "text/plain");
  if (plain) return plain.trim();
  const html = findPart(payload, "text/html");
  if (html) return stripHtml(html);
  if (payload?.body?.data) return decodeB64(payload.body.data).trim();
  return "";
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
  const to = header(headers, "To")
    .split(",")
    .map((s: string) => parseAddr(s).email)
    .filter(Boolean);
  const date = Number(m.internalDate) || 0;
  return {
    id: String(m.id || id),
    threadId: String(m.threadId || ""),
    subject: header(headers, "Subject") || "(no subject)",
    fromName: from.name,
    fromEmail: from.email,
    toEmails: to,
    date,
    dateLabel: toLabel(date),
    snippet: String(m.snippet || ""),
    body: extractBody(m.payload).slice(0, 3000),
    permalink: `https://mail.google.com/mail/u/0/#all/${m.id}`,
  };
}

// Search the mailbox with a Gmail query and return parsed messages (newest first).
export async function searchGmail(query: string, max = 25): Promise<GmailResult> {
  if (!isGmailConfigured()) return { ok: false, messages: [], error: "Gmail signals are disabled (set GMAIL_SIGNALS_ENABLED=true)." };

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
    if (listRes.status === 403 || /insufficient|scope|ACCESS_TOKEN_SCOPE|not been used|disabled/i.test(body)) {
      error = "Gmail not accessible — re-run mint-google-token.mjs (now requests gmail.readonly), update GOOGLE_REFRESH_TOKEN, and enable the Gmail API in the Google Cloud project.";
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
