import { createServerFn } from "@tanstack/react-start";
import {
  searchGmail,
  isGmailConfigured,
  getActivityAliases,
  getNewsAliases,
  downloadGmailAttachment,
  type GmailMessage,
  type GmailAttachment,
} from "./gmail.server";
import {
  emailPdfFolderId,
  findDriveFileByGmailAttachment,
  uploadDriveFile,
  gmailAttachmentKey,
  GMAIL_ATTACH_PROP,
  MAX_ARCHIVE_PDF_BYTES,
  type DriveDoc,
} from "./drive.server";
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
import { parseResearchSubject } from "@/lib/news-subject";
import { guessDomainFromCompanyName } from "@/lib/domain-utils";
import { companiesMatch } from "@/lib/attribution-score";
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
  /** Durable Drive copy of an attached PDF (when archived). */
  docUrl?: string;
  /** Preferred feed source-type when subject names a research publisher. */
  sourceHint?: "Industry Reports" | "Industry News" | "PortCo Blogs";
}

export interface GmailFeedResult {
  configured: boolean;
  found: boolean;
  emails: GmailSignal[];
  error?: string;
}

/** A PDF forwarded to the NEWS@ alias — reference only; the scan downloads the
 *  bytes on demand and feeds them to Gemini as document grounding. */
export interface NewsAliasDoc extends GmailAttachment {
  messageId: string;
  subject: string;
  permalink: string;
  /** Drive webViewLink after archive (preferred citation / Open in Drive). */
  driveWebViewLink?: string;
}

/**
 * Archive one Gmail PDF into Drive (deduped by appProperties). Best-effort —
 * failures return null and never block the feed or scan.
 */
async function archiveGmailPdfToDrive(opts: {
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
}): Promise<DriveDoc | null> {
  if (!emailPdfFolderId()) return null;
  if (!opts.messageId || !opts.attachmentId) return null;
  if (opts.sizeBytes && opts.sizeBytes > MAX_ARCHIVE_PDF_BYTES) {
    console.warn(
      `[gmail→drive] skip ${opts.filename}: ${opts.sizeBytes} bytes exceeds ${MAX_ARCHIVE_PDF_BYTES}`,
    );
    return null;
  }

  try {
    const existing = await findDriveFileByGmailAttachment(opts.messageId, opts.attachmentId);
    if (existing?.webViewLink) return existing;

    const base64 = await downloadGmailAttachment(opts.messageId, opts.attachmentId);
    if (!base64) return null;

    const safeName = (opts.filename || "attachment.pdf").replace(/[\\/:*?"<>|]+/g, "_");
    return await uploadDriveFile({
      name: safeName,
      mimeType: opts.mimeType || "application/pdf",
      base64,
      appProperties: {
        [GMAIL_ATTACH_PROP]: gmailAttachmentKey(opts.messageId, opts.attachmentId),
      },
    });
  } catch (e) {
    console.error(`[gmail→drive] archive failed for ${opts.filename}:`, e);
    return null;
  }
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
}): Promise<{
  configured: boolean;
  ok: boolean;
  emails: GmailSignal[];
  /** PDFs forwarded to the NEWS@ alias (refs only — bytes downloaded on demand). */
  newsDocs: NewsAliasDoc[];
  error?: string;
}> {
  if (!isGmailConfigured()) return { configured: false, ok: false, emails: [], newsDocs: [] };

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
  // NEWS@ ingestion alias: anything the team forwards there is signal by
  // definition, so it's ORed in regardless of domain matching. deliveredto:
  // catches alias-inbox delivery where the alias never shows in To/Cc.
  const newsAliases = getNewsAliases();
  const newsAliasSet = new Set(newsAliases);
  const aliasClause = newsAliases
    .flatMap((a) => [`deliveredto:${a}`, `to:${a}`, `cc:${a}`])
    .join(" OR ");
  if (!custom && domList.length === 0 && newsAliases.length === 0)
    return { configured: true, ok: true, emails: [], newsDocs: [] };

  // Match a portfolio/network domain ANYWHERE in the message (headers OR body) so
  // internal digests that merely LINK to those sites (e.g. a "Portco blogs"
  // forward) are caught — not just direct emails with the network.
  const clauses = [
    domList.length > 0 ? `(${domList.join(" OR ")})` : "",
    aliasClause ? `(${aliasClause})` : "",
  ].filter(Boolean);
  const terms = clauses.join(" OR ");
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
  if (!res.ok) return { configured: true, ok: false, emails: [], newsDocs: [], error: res.error };

  const involvesAlias = (m: (typeof res.messages)[number]): boolean =>
    [m.fromEmail, ...m.toEmails, ...m.ccEmails].some((e) => aliasSet.has((e || "").toLowerCase()));
  const kept = res.messages.filter((m) => !involvesAlias(m));

  // PDF attachments on NEWS@-alias messages become scan grounding documents —
  // the diagram's "scraper needs to handle PDFs" lane. Refs only; the scan
  // downloads bytes for the few it can afford to feed Gemini.
  const isNewsAliasMsg = (m: GmailMessage): boolean =>
    newsAliasSet.size > 0 &&
    [...m.toEmails, ...m.ccEmails, ...m.deliveredTo].some((e) => newsAliasSet.has(e));
  const newsDocs: NewsAliasDoc[] = kept
    .filter(isNewsAliasMsg)
    .flatMap((m) =>
      (m.attachments || []).map((a) => ({
        ...a,
        messageId: m.id,
        subject: m.subject,
        permalink: m.permalink,
      })),
    );

  // Archive PDF attachments from the feed window into Drive so analysts can
  // open/read them later. Deduped by Gmail attachment key; best-effort.
  // Prefer NEWS@ docs first, then any other kept-message PDFs.
  const driveByMessage = new Map<string, string>();
  if (emailPdfFolderId()) {
    const seenAttach = new Set<string>();
    const toArchive: Array<{
      messageId: string;
      attachmentId: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
    }> = [];
    const pushAttach = (m: GmailMessage, a: GmailAttachment) => {
      const k = `${m.id}:${a.attachmentId}`;
      if (seenAttach.has(k)) return;
      seenAttach.add(k);
      toArchive.push({
        messageId: m.id,
        attachmentId: a.attachmentId,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      });
    };
    for (const m of kept.filter(isNewsAliasMsg)) {
      for (const a of m.attachments || []) pushAttach(m, a);
    }
    for (const m of kept) {
      for (const a of m.attachments || []) pushAttach(m, a);
    }

    for (const job of toArchive) {
      const archived = await archiveGmailPdfToDrive(job);
      if (!archived?.webViewLink) continue;
      if (!driveByMessage.has(job.messageId)) {
        driveByMessage.set(job.messageId, archived.webViewLink);
      }
      const news = newsDocs.find(
        (d) => d.messageId === job.messageId && d.attachmentId === job.attachmentId,
      );
      if (news) news.driveWebViewLink = archived.webViewLink;
    }
    if (driveByMessage.size > 0) {
      console.log(`[gmail→drive] archived/linked ${driveByMessage.size} message PDF(s)`);
    }
  }

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
    const newsAlias = isNewsAliasMsg(m);

    // NEWS@ is a forward inbox — From:/To: domains are provenance (Dell, DTC),
    // not the story. Prefer the research house named in the subject
    // ("FW: 451 Research: Siemens AG, …") and explode listed entities into
    // their own cards so Siemens/EnergyHub/etc. attribute as themselves.
    if (newsAlias) {
      const parsed = parseResearchSubject(m.subject);
      const publisher = parsed.publisher;
      const docUrl = driveByMessage.get(m.id);
      const pubLabel = publisher?.name || "Industry Report";

      if (parsed.entities.length > 0) {
        return parsed.entities.map((entity, n) => {
          const resolved = resolveResearchEntity(entity, portfolio, contacts, byEmail);
          return {
            id: `${m.id}-r${n}`,
            subject: `${resolved.company} — ${pubLabel}`,
            fromName: m.fromName,
            fromEmail: m.fromEmail,
            company: resolved.company,
            contactName: contact?.name,
            snippet:
              m.snippet?.trim() ||
              `Covered in ${pubLabel}${m.dateLabel ? ` (${m.dateLabel})` : ""}.`,
            body: m.body,
            date: m.date,
            dateLabel: m.dateLabel,
            permalink: m.permalink,
            logoDomain: resolved.logoDomain,
            docUrl,
            digestSubject: m.subject,
            sourceHint: "Industry Reports" as const,
          };
        });
      }

      // No entity list — one card per PDF title when attachments exist.
      const pdfs = m.attachments || [];
      if (pdfs.length > 0) {
        return pdfs.map((a, n) => {
          const title = (a.filename || "Research PDF").replace(/\.pdf$/i, "").trim();
          return {
            id: `${m.id}-p${n}`,
            subject: title,
            fromName: m.fromName,
            fromEmail: m.fromEmail,
            company: title,
            contactName: contact?.name,
            snippet: `From ${pubLabel}${m.snippet ? `: ${m.snippet}` : ""}`,
            body: m.body,
            date: m.date,
            dateLabel: m.dateLabel,
            permalink: m.permalink,
            logoDomain: publisher?.domain || guessDomainFromCompanyName(title) || undefined,
            docUrl,
            digestSubject: m.subject,
            sourceHint: "Industry Reports" as const,
          };
        });
      }

      return [
        {
          id: m.id,
          subject: m.subject,
          fromName: m.fromName,
          fromEmail: m.fromEmail,
          company: pubLabel,
          contactName: contact?.name,
          snippet: m.snippet,
          body: m.body,
          date: m.date,
          dateLabel: m.dateLabel,
          permalink: m.permalink,
          logoDomain: publisher?.domain,
          docUrl,
          sourceHint: "Industry Reports" as const,
        },
      ];
    }

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
        docUrl: driveByMessage.get(m.id),
      },
    ];
  });

  // Archive the exploded digest links to the Signals sheet so they outlive the
  // Gmail search window. Best-effort — a Sheets hiccup never breaks the feed.
  if (pre?.persistDigest && digestLinks.size > 0) {
    try {
      const portcoNames = new Set(portfolio.map((p) => p.name.trim().toLowerCase()));
      const networkCompanyNames = new Set(
        contacts.map((c) => (c.company || "").trim().toLowerCase()).filter(Boolean),
      );
      let watchNames = new Set<string>();
      try {
        // Dynamic import avoids a top-level gmail ↔ platform cycle (platform
        // pulls gemini.server, which gmail also reaches via the scan path).
        const { buildRadarWatchlist } = await import("./platform.server");
        watchNames = new Set(
          (await buildRadarWatchlist()).map((w) => w.company.trim().toLowerCase()),
        );
      } catch {
        /* watchlist unavailable — proxy falls back to portco/network only */
      }
      const added = await appendDigestLinkSignals(emails, portcoNames, {
        watchNames,
        networkCompanyNames,
      });
      if (added > 0) console.log(`[gmail] archived ${added} digest link signal(s) to Signals tab`);
    } catch (e) {
      console.error("[gmail] digest signal archiving failed (feed unaffected):", e);
    }
  }

  return { configured: true, ok: true, emails, newsDocs };
}

/** Resolve a research-subject entity to a CRM/portco name + logo domain. */
function resolveResearchEntity(
  entity: string,
  portfolio: PortfolioCompany[],
  contacts: Contact[],
  byEmail: Map<string, { name: string; company: string }>,
): { company: string; logoDomain?: string } {
  const raw = entity.trim();
  if (!raw) return { company: "Industry Report" };

  for (const p of portfolio) {
    if (!p.name?.trim()) continue;
    if (companiesMatch(p.name, raw)) {
      return { company: p.name, logoDomain: hostFromUrl(p.website) || undefined };
    }
  }
  for (const c of contacts) {
    if (!c.company?.trim()) continue;
    if (companiesMatch(c.company, raw)) {
      const d = emailDomain(c.email);
      return { company: c.company, logoDomain: d || guessDomainFromCompanyName(c.company) || undefined };
    }
  }
  // Rare: entity string is literally an email we know.
  const asEmail = raw.toLowerCase();
  if (asEmail.includes("@") && byEmail.has(asEmail)) {
    const hit = byEmail.get(asEmail)!;
    return {
      company: hit.company || raw,
      logoDomain: emailDomain(asEmail) || undefined,
    };
  }

  return {
    company: raw,
    logoDomain: guessDomainFromCompanyName(raw) || undefined,
  };
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
