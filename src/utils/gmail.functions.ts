import { createServerFn } from "@tanstack/react-start";
import {
  searchGmail,
  isGmailConfigured,
  getActivityAliases,
  type GmailMessage,
} from "./gmail.server";
import { buildContacts, buildPortfolioCompanies } from "./sheets.server";
import { fetchLinkPreviews, type LinkPreview } from "./link-preview.server";
import { appendDigestLinkSignals } from "./signal-store.server";
import {
  isLinkDigest,
  titleFromSlug,
  hostOfUrl,
  companyFromHost,
  matchCompanyByHost,
} from "@/lib/link-digest";
import type { Contact, PortfolioCompany } from "@/lib/types";

// One email mapped to the Signals feed, tagged with its CRM contact/company.
// When the email is a link digest (e.g. the weekly "Portco blogs" forward) it
// is exploded into one signal PER ARTICLE LINK: `linkUrl` carries the article,
// subject/snippet hold the article's real title/description, and `company` is
// the article's company — not the email sender's.
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
  /** The article URL this signal was exploded from (digest emails only). */
  linkUrl?: string;
  /** Subject of the digest email the link arrived in (provenance). */
  digestSubject?: string;
}

export interface GmailFeedResult {
  configured: boolean;
  found: boolean;
  emails: GmailSignal[];
  error?: string;
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
// `persistDigest` archives exploded digest-link signals to the Signals tab
// (URL-deduped) — set by the feed path only; the scan has its own store flow.
export async function gatherNetworkEmails(pre?: {
  contacts?: Contact[];
  portfolio?: PortfolioCompany[];
  persistDigest?: boolean;
}): Promise<{ configured: boolean; ok: boolean; emails: GmailSignal[]; error?: string }> {
  if (!isGmailConfigured()) return { configured: false, ok: false, emails: [] };

  const contacts = pre?.contacts ?? (await buildContacts());
  const portfolio = pre?.portfolio ?? (await buildPortfolioCompanies());

  // Email → contact lookup for attribution.
  const byEmail = new Map<string, { name: string; company: string }>();
  for (const c of contacts) {
    for (const e of (c.email || "")
      .split(";")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)) {
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
  const base = custom
    ? /(newer_than|older_than|after:|before:)/.test(custom)
      ? custom
      : `newer_than:${windowDays}d ${custom}`
    : `newer_than:${windowDays}d (${terms})`;

  // Keep BD/GTM activity-tracking aliases OUT of Signals — those emails belong to
  // the activity-sync pipeline (BD & GTM sheets), not the news feed. Exclude at the
  // query level (from/to/cc) and again defensively after fetch.
  const aliases = getActivityAliases();
  const aliasSet = new Set(aliases);
  // deliveredto: also catches mail auto-forwarded INTO an alias inbox, where the
  // alias never appears in the visible From/To/Cc headers.
  const exclude = aliases
    .flatMap((a) => [`-from:${a}`, `-to:${a}`, `-cc:${a}`, `-deliveredto:${a}`])
    .join(" ");
  const q = exclude ? `${base} ${exclude}` : base;

  const res = await searchGmail(q, max);
  if (!res.ok) return { configured: true, ok: false, emails: [], error: res.error };

  const involvesAlias = (m: (typeof res.messages)[number]): boolean =>
    [m.fromEmail, ...m.toEmails, ...m.ccEmails].some((e) => aliasSet.has((e || "").toLowerCase()));
  const kept = res.messages.filter((m) => !involvesAlias(m));

  // Link-digest emails (e.g. the weekly "Portco blogs" forward) become one
  // signal per article, attributed to the ARTICLE's company — the raw email
  // card (headers + a wall of URLs) is meaningless and is dropped.
  const maxDigestLinks = Number(process.env.GMAIL_DIGEST_MAX_LINKS) || 40;
  const digestLinks = new Map<string, string[]>();
  for (const m of kept) {
    const links = (m.links || []).slice(0, maxDigestLinks);
    if (isLinkDigest(m.subject, links)) digestLinks.set(m.id, links);
  }
  // Grounded enrichment: each article's own <title> + meta description.
  let previews = new Map<string, LinkPreview>();
  if (digestLinks.size > 0) {
    try {
      previews = await fetchLinkPreviews([...digestLinks.values()].flat());
    } catch (e) {
      console.error("[gmail] link previews failed (falling back to slug titles):", e);
    }
  }
  // host → company from portfolio websites + CRM contact email domains, so a
  // link to a portco's blog is attributed to the portco by name.
  const domainToCompany = new Map<string, string>();
  for (const p of portfolio) {
    const h = hostFromUrl(p.website);
    if (h) domainToCompany.set(h, p.name);
  }
  for (const c of contacts) {
    const d = emailDomain(c.email);
    if (d && c.company && !domainToCompany.has(d)) domainToCompany.set(d, c.company);
  }

  const emails: GmailSignal[] = kept.flatMap((m) => {
    const links = digestLinks.get(m.id);
    if (links?.length)
      return links.map((url, n) => linkSignal(m, url, n, previews, domainToCompany));

    const candidates = [m.fromEmail, ...m.toEmails];
    const matchEmail = candidates.find((e) => byEmail.has(e)) || "";
    const contact = matchEmail ? byEmail.get(matchEmail) : undefined;
    const partyEmail = matchEmail || m.fromEmail;
    const dom = emailDomain(partyEmail) || partyEmail.split("@")[1] || "";
    return [
      {
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
      },
    ];
  });

  // Archive the exploded digest links to the Signals sheet so they outlive the
  // Gmail search window. Best-effort — a Sheets hiccup never breaks the feed.
  if (pre?.persistDigest && digestLinks.size > 0) {
    try {
      const portcoNames = new Set(portfolio.map((p) => p.name.trim().toLowerCase()));
      const added = await appendDigestLinkSignals(emails, portcoNames);
      if (added > 0) console.log(`[gmail] archived ${added} digest link signal(s) to Signals tab`);
    } catch (e) {
      console.error("[gmail] digest signal archiving failed (feed unaffected):", e);
    }
  }

  return { configured: true, ok: true, emails };
}

// One digest link → one signal about the article's company. Title/description
// come from the fetched page; the URL slug is the grounded fallback.
function linkSignal(
  m: GmailMessage,
  url: string,
  n: number,
  previews: Map<string, LinkPreview>,
  domainToCompany: Map<string, string>,
): GmailSignal {
  const host = hostOfUrl(url);
  const p = previews.get(url);
  // Prefer the article's declared publish time; fall back to the email's date.
  const published =
    p?.publishedTs && p.publishedTs > 0 && p.publishedTs <= Date.now() + 86_400_000
      ? p.publishedTs
      : 0;
  const date = published || m.date;
  return {
    id: `${m.id}-l${n}`,
    subject: (p?.title || titleFromSlug(url)).trim() || titleFromSlug(url),
    fromName: m.fromName,
    fromEmail: m.fromEmail,
    company: matchCompanyByHost(host, domainToCompany) || companyFromHost(host) || host,
    snippet: p?.description || "",
    body: "",
    date,
    dateLabel: date ? new Date(date).toISOString().slice(0, 10) : "",
    permalink: m.permalink,
    logoDomain: host || undefined,
    linkUrl: url,
    digestSubject: m.subject,
  };
}

// Recent emails to/from the firm's network, mapped into the Signals feed. Returns
// { configured:false } when GMAIL_SIGNALS_ENABLED isn't set so the UI shows a hint.
export const fetchGmailFeed = createServerFn({ method: "GET" }).handler(
  async (): Promise<GmailFeedResult> => {
    try {
      const r = await gatherNetworkEmails({ persistDigest: true });
      if (!r.configured) return { configured: false, found: false, emails: [] };
      if (!r.ok) return { configured: true, found: false, emails: [], error: r.error };
      return { configured: true, found: true, emails: r.emails };
    } catch (e) {
      console.error("fetchGmailFeed failed:", e);
      return { configured: false, found: false, emails: [], error: "Gmail fetch failed." };
    }
  },
);
