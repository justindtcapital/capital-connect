import { createServerFn } from "@tanstack/react-start";
import { searchGmail, isGmailConfigured } from "./gmail.server";
import { buildContacts, buildPortfolioCompanies } from "./sheets.server";
import type { Contact, PortfolioCompany } from "@/lib/types";

// One email mapped to the Signals feed, tagged with its CRM contact/company.
export interface GmailSignal {
  id: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  company: string;
  contactName?: string;
  snippet: string;
  body: string;
  date: number;
  dateLabel: string;
  permalink: string;
  logoDomain?: string;
}

export interface GmailFeedResult {
  configured: boolean;
  found: boolean;
  emails: GmailSignal[];
  error?: string;
}

const FREE_EMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "msn.com",
]);

function hostFromUrl(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function emailDomain(email?: string): string {
  const first = (email || "").split(/[;,]/)[0].trim().toLowerCase();
  const at = first.indexOf("@");
  if (at < 0) return "";
  const d = first.slice(at + 1).trim();
  return !d || FREE_EMAIL.has(d) ? "" : d;
}

// Core gatherer (plain function, reused by the Signals loader AND the scan).
// Pass pre-built contacts/portfolio to avoid re-reading the sheet.
export async function gatherNetworkEmails(pre?: {
  contacts?: Contact[];
  portfolio?: PortfolioCompany[];
}): Promise<{ configured: boolean; ok: boolean; emails: GmailSignal[]; error?: string }> {
  if (!isGmailConfigured()) return { configured: false, ok: false, emails: [] };

  const contacts = pre?.contacts ?? (await buildContacts());
  const portfolio = pre?.portfolio ?? (await buildPortfolioCompanies());

  // Email → contact lookup for attribution.
  const byEmail = new Map<string, { name: string; company: string }>();
  for (const c of contacts) {
    for (const e of (c.email || "").split(";").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      byEmail.set(e, { name: c.name, company: c.company });
    }
  }

  // Relevant domains = portfolio websites + contact email domains (non-free).
  const domains = new Set<string>();
  for (const p of portfolio) {
    const h = hostFromUrl(p.website);
    if (h) domains.add(h);
  }
  for (const c of contacts) {
    const d = emailDomain(c.email);
    if (d) domains.add(d);
  }
  const domList = [...domains].slice(0, 30); // keep the Gmail query within limits

  const windowDays = Number(process.env.GMAIL_SIGNALS_WINDOW_DAYS) || 14;
  const max = Number(process.env.GMAIL_SIGNALS_MAX) || 25;

  // Optional manual override (e.g. `subject:"portco blogs" OR from:dell.com`).
  const custom = process.env.GMAIL_SIGNALS_QUERY?.trim();
  if (!custom && domList.length === 0) return { configured: true, ok: true, emails: [] };

  // Match a portfolio/network domain ANYWHERE in the message (headers OR body) so
  // internal digests that merely LINK to those sites (e.g. a "Portco blogs"
  // forward) are caught — not just direct emails with the network.
  const terms = domList.join(" OR ");
  const q = custom
    ? (/(newer_than|older_than|after:|before:)/.test(custom) ? custom : `newer_than:${windowDays}d ${custom}`)
    : `newer_than:${windowDays}d (${terms})`;

  const res = await searchGmail(q, max);
  if (!res.ok) return { configured: true, ok: false, emails: [], error: res.error };

  const emails: GmailSignal[] = res.messages.map((m) => {
    const candidates = [m.fromEmail, ...m.toEmails];
    const matchEmail = candidates.find((e) => byEmail.has(e)) || "";
    const contact = matchEmail ? byEmail.get(matchEmail) : undefined;
    const partyEmail = matchEmail || m.fromEmail;
    const dom = emailDomain(partyEmail) || partyEmail.split("@")[1] || "";
    return {
      id: m.id,
      subject: m.subject,
      fromName: m.fromName,
      fromEmail: m.fromEmail,
      company: contact?.company || dom || m.fromName || "Email",
      contactName: contact?.name,
      snippet: m.snippet,
      body: m.body,
      date: m.date,
      dateLabel: m.dateLabel,
      permalink: m.permalink,
      logoDomain: emailDomain(partyEmail) || undefined,
    };
  });

  return { configured: true, ok: true, emails };
}

// Recent emails to/from the firm's network, mapped into the Signals feed. Returns
// { configured:false } when GMAIL_SIGNALS_ENABLED isn't set so the UI shows a hint.
export const fetchGmailFeed = createServerFn({ method: "GET" }).handler(
  async (): Promise<GmailFeedResult> => {
    try {
      const r = await gatherNetworkEmails();
      if (!r.configured) return { configured: false, found: false, emails: [] };
      if (!r.ok) return { configured: true, found: false, emails: [], error: r.error };
      return { configured: true, found: true, emails: r.emails };
    } catch (e) {
      console.error("fetchGmailFeed failed:", e);
      return { configured: false, found: false, emails: [], error: "Gmail fetch failed." };
    }
  },
);
