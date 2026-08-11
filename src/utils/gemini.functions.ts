import { createServerFn } from "@tanstack/react-start";
import {
  draftEmail as runDraftEmail,
  scanSignals as runScanSignals,
  isGeminiConfigured,
  geminiGenerate,
  responseText,
  type EmailDraftResult,
  type SignalScanResult,
  type SignalPerson,
  type SignalRecommendation,
  type SignalAwarenessItem,
  type SignalDocument,
} from "./gemini.server";
import { isDriveConfigured, listDriveDocs, downloadDriveFile } from "./drive.server";
import { isNewsConfigured, fetchNewsForCompanies, articleUrlKey, uniqueSearchNames } from "./news.server";
import { isPerplexityConfigured, fetchPerplexityNews } from "./perplexity.server";
import { gatherNetworkEmails, type GmailSignal } from "./gmail.functions";
import { downloadGmailAttachment } from "./gmail.server";
import { buildRadarWatchlist } from "./platform.server";
import { scoreAttribution } from "@/lib/attribution-score";
import { outreachVerdict } from "@/lib/outreach-gate";
import type { Contact } from "@/lib/types";
// Signal persistence (Signals tab row contract) lives in signal-store.server —
// shared with the Gmail digest pipeline, which archives per-link signals too.
import {
  type StoredSignal,
  keyForStored,
  storedFromRec,
  storedFromAwareness,
  rowFromStored,
  fetchStoredSignals,
} from "./signal-store.server";
import {
  buildContacts,
  buildPortfolioCompanies,
  appendSheetRows,
  ensureTab,
  ensureHeaderRow,
  ensureHeaderWidth,
  logOpsEvent,
  TAB_NAMES,
  SIGNAL_HEADERS,
} from "./sheets.server";
import { processCandidatesIntoEvents } from "./event-pipeline.server";
import { loadSignalConfig } from "./event-store.server";

// Draft an outreach email with Gemini. Runs server-side so the API key stays secret.
export const draftEmail = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      contactName: string;
      contactTitle?: string;
      contactCompany?: string;
      contactSector?: string;
      purpose: string;
      tone?: string;
      notes?: string;
      history?: string[];
      senderName?: string;
      senderOrg?: string;
      emailType?: string;
      linkedPortcos?: string[];
      linkedEvent?: string;
    }) => data,
  )
  .handler(async ({ data }): Promise<EmailDraftResult> => {
    try {
      return await runDraftEmail(data);
    } catch (err) {
      console.error("[gemini] draftEmail failed:", err);
      return { found: false, error: err instanceof Error ? err.message : "Draft failed" };
    }
  });

const STRENGTH_BY_TEMPERATURE: Record<string, string> = {
  Hot: "strong",
  Warm: "medium",
  Cold: "weak",
};

// Pull readable article-ish URLs out of email bodies for Gemini's URL-context tool.
// Drops obvious junk (unsubscribe/tracking/preferences) and caps the count (the
// URL-context tool reads up to ~20 URLs per request).
function extractEmailLinks(emails: GmailSignal[], cap = 20): string[] {
  const urls = new Set<string>();
  // Digest emails arrive pre-exploded (one signal per article, links already
  // unwrapped + junk-filtered in lib/link-digest) — take those links first.
  for (const e of emails) {
    if (urls.size >= cap) break;
    if (e.linkUrl) urls.add(e.linkUrl);
  }
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  for (const e of emails) {
    for (const match of (e.body || "").matchAll(re)) {
      if (urls.size >= cap) break;
      const u = match[0].replace(/[.,;)]+$/, "");
      const low = u.toLowerCase();
      if (u.length > 300) continue;
      if (/(unsubscribe|list-manage|\/preferences|mailto:|utm_|email-settings|opt-?out)/.test(low))
        continue;
      // Skip auth-gated or bot-blocked hosts the URL-context tool can't read:
      // Drive/Docs links need a Google login (the internal PDFs already ride
      // along as inline attachments) and LinkedIn blocks automated fetches —
      // both otherwise surface as compliance flags on every scan.
      if (/^https?:\/\/([\w-]+\.)*(drive|docs)\.google\.com\//.test(low)) continue;
      if (/^https?:\/\/([\w-]+\.)*linkedin\.com\//.test(low)) continue;
      urls.add(u);
    }
    if (urls.size >= cap) break;
  }
  return [...urls];
}

const FREE_EMAIL_DOMAINS = new Set([
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

function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname
      .replace(/^www\./, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

function emailDomainOf(email?: string): string {
  const first = (email || "").split(/[;,]/)[0].trim().toLowerCase();
  const at = first.indexOf("@");
  if (at < 0) return "";
  const d = first.slice(at + 1).trim();
  return !d || FREE_EMAIL_DOMAINS.has(d) ? "" : d;
}

// domain → company name, from portfolio websites + (non-free) contact email domains.
function buildDomainToCompany(
  contacts: Array<{ company?: string; email?: string }>,
  portfolio: Array<{ name: string; website?: string }>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of portfolio) {
    const h = hostOf(p.website);
    if (h) m.set(h, p.name);
  }
  for (const c of contacts) {
    const d = emailDomainOf(c.email);
    if (d && c.company && !m.has(d)) m.set(d, c.company);
  }
  return m;
}

// Match a link's domain (or registrable parent) to a known company.
function companyForLink(url: string, m: Map<string, string>): string {
  const host = hostOf(url);
  if (!host) return "";
  if (m.has(host)) return m.get(host) as string;
  for (const [k, v] of m) {
    if (host === k || host.endsWith(`.${k}`) || k.endsWith(`.${host}`)) return v;
  }
  return "";
}

// How many shared-drive PDFs to feed into a scan, and the per-file size ceiling.
// Kept conservative: each PDF re-feeds as input tokens, which compounds against
// per-minute quotas. Override the count with GOOGLE_SIGNALS_MAX_DOCS in .env.
const MAX_SIGNAL_DOCS = Number(process.env.GOOGLE_SIGNALS_MAX_DOCS) || 4;
const MAX_SIGNAL_DOC_BYTES = 8_000_000; // ~8 MB per file

// Pull recent PDFs from the shared drive and base64-encode them for Gemini.
// Best-effort: any failure logs and returns whatever loaded, so a scan never
// fails just because Drive is unreachable or unconfigured.
async function loadSignalDocuments(): Promise<SignalDocument[]> {
  if (!isDriveConfigured()) return [];
  try {
    const feed = await listDriveDocs(MAX_SIGNAL_DOCS * 3);
    const picked = feed.docs
      .filter((d) => !d.sizeBytes || d.sizeBytes <= MAX_SIGNAL_DOC_BYTES)
      .slice(0, MAX_SIGNAL_DOCS);
    const loaded = await Promise.all(
      picked.map(async (d) => {
        const file = await downloadDriveFile(d.id);
        if (!file) return null;
        return {
          name: d.name,
          base64: file.base64,
          mediaType: file.mediaType,
          link: d.webViewLink,
        } as SignalDocument;
      }),
    );
    return loaded.filter((d): d is SignalDocument => d !== null);
  } catch (e) {
    console.error("[gemini] loadSignalDocuments failed (continuing without):", e);
    return [];
  }
}

function resultFromStored(
  stored: StoredSignal[],
  compliance: string[],
  newCount: number,
): SignalScanResult {
  const recommendations: SignalRecommendation[] = stored
    .filter((s) => s.type === "recommendation")
    .sort((a, b) => b.relevance - a.relevance || (b.dateFound > a.dateFound ? 1 : -1))
    .map((s) => ({
      person: s.person,
      company: s.company,
      email: s.email,
      category: s.category,
      signal: s.signal,
      sourceUrl: s.sourceUrl,
      subject: s.subject,
      body: s.body,
      relevance: s.relevance,
      justification: s.justification,
      urgency: s.urgency,
      timing: s.timing,
      dateFound: s.dateFound,
      sourceType: s.sourceType,
      docUrl: s.docUrl,
      storedId: s.id,
      hasBody: s.hasBody,
      eventId: s.eventId,
      materiality: s.materiality,
      rankScore: s.rankScore,
      badges: s.badges,
    }));
  const otherSignals: SignalAwarenessItem[] = stored
    .filter((s) => s.type === "awareness")
    .map((s) => ({
      company: s.company,
      person: s.person,
      category: s.category,
      summary: s.signal,
      // Awareness rows store an article title (digest links) in Subject.
      title: s.subject || undefined,
      sourceUrl: s.sourceUrl,
      dateFound: s.dateFound,
      sourceType: s.sourceType,
      docUrl: s.docUrl,
      eventId: s.eventId,
      materiality: s.materiality,
      rankScore: s.rankScore,
      badges: s.badges,
      storedId: s.id,
    }));
  return { found: true, recommendations, otherSignals, compliance, newCount };
}

// Resolve a rec's person to a CRM contact: email first, then name — but only
// when the name is unambiguous (never guess between namesakes).
function buildContactResolver(contacts: Contact[]) {
  const byEmail = new Map<string, Contact>();
  const byName = new Map<string, Contact[]>();
  for (const c of contacts) {
    for (const em of (c.email || "").split(";")) {
      const key = em.trim().toLowerCase();
      if (key && !byEmail.has(key)) byEmail.set(key, c);
    }
    const nameKey = c.name.trim().toLowerCase();
    if (nameKey) byName.set(nameKey, [...(byName.get(nameKey) || []), c]);
  }
  return (email: string, person: string): Contact | undefined => {
    const hit = byEmail.get((email || "").trim().toLowerCase());
    if (hit) return hit;
    const named = byName.get((person || "").trim().toLowerCase());
    return named && named.length === 1 ? named[0] : undefined;
  };
}

// Read-time outreach gate: demote stored recommendation rows that no longer
// clear the quality bar — legacy rows written before the gate existed, or
// contacts who have since joined a portfolio company. Display-only (the sheet
// rows are not rewritten): the story survives as an awareness card, the
// outreach suggestion does not. Dedups against rows that already exist as
// awareness (a prior scan may have stored the same story both ways).
function gateStoredRecs(
  stored: StoredSignal[],
  contacts: Contact[],
  portcoNames: Set<string>,
): StoredSignal[] {
  const resolve = buildContactResolver(contacts);
  const out: StoredSignal[] = [];
  const seen = new Set<string>();
  for (const s of stored) {
    let row = s;
    if (s.type === "recommendation") {
      const verdict = outreachVerdict({
        contact: resolve(s.email, s.person),
        storyCompany: s.company,
        relevance: s.relevance,
        portcoNames,
      });
      if (!verdict.ok) {
        row = {
          ...s,
          type: "awareness",
          person: "",
          email: "",
          subject: "",
          body: "",
          hasBody: false,
          relevance: 0,
        };
      }
    }
    const k = keyForStored(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

// Scan recent news for the firm's portfolio + network companies and attribute
// signals to network people. Pulls portcos + contacts from the sheet server-side
// so the client just triggers the run.
// Narrow a scan result to a single company (used by the PortCo Signals panel).
// `scoped` is the lowercased company name; "" means no scoping (returns as-is).
function scopeResult(r: SignalScanResult, scoped: string): SignalScanResult {
  if (!scoped) return r;
  const match = (co?: string) => {
    const c = (co || "").trim().toLowerCase();
    if (!c) return false;
    return c === scoped || c.includes(scoped) || (scoped.includes(c) && c.length > 2);
  };
  const recommendations = r.recommendations.filter((x) => match(x.company));
  const otherSignals = r.otherSignals.filter((x) => match(x.company));
  return { ...r, recommendations, otherSignals, newCount: undefined };
}

type SignalScanInput = {
  windowDays?: number;
  maxPeople?: number;
  maxCompanies?: number;
  companyName?: string;
  /** True for cron-driven scans — enables WS6 tier cadence (Tier 2 weekly). */
  scheduled?: boolean;
  /** Ad-hoc subject search ("agentic security") — the scan grabs recent
   *  stories about this topic instead of fanning out over the company
   *  universe. Stories are attributed to their actual companies and flow
   *  through clustering/scoring like any other signal. */
  topic?: string;
};

/**
 * Shared signal-scan runner used by the UI server fn (and schedulers via
 * `scanSignals`). Kept non-exported so the client never bundles Vertex/Sheets.
 */
async function executeSignalScan(data: SignalScanInput = {}): Promise<SignalScanResult> {
  const windowDays = data.windowDays ?? 14;
  const maxPeople = data.maxPeople ?? 150;
  const maxCompanies = data.maxCompanies ?? 12;
  // When set, the scan is scoped to a single portfolio company (the PortCo
  // profile's Signals panel): only that company is scanned, only people
  // connected to it are in the attribution pool, and the result is filtered to it.
  const scoped = (data.companyName || "").trim().toLowerCase();
  // Ad-hoc topic scan: search the SUBJECT, not the universe.
  const topic = (data.topic || "").trim().replace(/\s+/g, " ").slice(0, 80);

  try {
    const [contacts, portfolio] = await Promise.all([buildContacts(), buildPortfolioCompanies()]);

    const allPortcos = portfolio.map((p) => ({
      name: p.name,
      sector: p.sector,
      themes: p.description,
    }));
    const portcoNames = new Set(allPortcos.map((p) => p.name.trim().toLowerCase()));
    const portcos = topic
      ? []
      : scoped
        ? allPortcos.filter((p) => p.name.trim().toLowerCase() === scoped)
        : allPortcos;

    // Attribution pool: everyone, or — when scoped — only contacts who work at
    // the company or have an intro to it.
    const peopleSource = scoped
      ? contacts.filter(
          (c) =>
            (c.company || "").trim().toLowerCase() === scoped ||
            (c.portCoIntros || []).some((p) => p.trim().toLowerCase() === scoped),
        )
      : contacts;

    const tempRank: Record<string, number> = { Hot: 0, Warm: 1, Cold: 2 };
    const people: SignalPerson[] = peopleSource
      .filter((c) => c.email)
      .sort((a, b) => (tempRank[a.temperature] ?? 3) - (tempRank[b.temperature] ?? 3))
      .slice(0, maxPeople)
      .map((c) => ({
        name: c.name,
        title: c.title,
        company: c.company,
        strength: STRENGTH_BY_TEMPERATURE[c.temperature] || "weak",
        sector: c.sector,
        email: c.email?.split(";")[0]?.trim(),
        lastContact: c.lastContact,
      }));

    // Broad network companies only matter for an unscoped, non-topic scan.
    // WS6 tier cadence (scheduled scans only): most-connected + watchlist
    // companies are the Tier-2 band — news-scanned weekly on the configured
    // ISO weekday, not daily. Portcos (Tier 1) stay daily. Tier 3 never.
    // Topics: an ad-hoc scan searches just its subject; scheduled scans also
    // carry the PINNED watch topics from Signal Config (the tuneable keywords).
    let companies: string[] = [];
    let topics: string[] = topic ? [topic] : [];
    let tier2Skipped = false;
    if (!scoped && !topic) {
      let tier2Day = true;
      if (data.scheduled) {
        try {
          const cfg = await loadSignalConfig();
          const isoDay = ((new Date().getUTCDay() + 6) % 7) + 1; // 1=Mon…7=Sun
          tier2Day = isoDay === cfg.watchTiers.tier2NewsScanIsoDay;
          topics = cfg.topics.slice(0, 8);
        } catch {
          tier2Day = true; // config unavailable — fail open, never dark
        }
      }
      if (tier2Day) {
        const counts = new Map<string, number>();
        for (const c of contacts) {
          const name = (c.company || "").trim();
          if (!name || portcoNames.has(name.toLowerCase())) continue;
          counts.set(name, (counts.get(name) || 0) + 1);
        }
        companies = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, maxCompanies)
          .map(([name]) => name);
      } else {
        tier2Skipped = true;
      }
    } else if (!topic && portcos.length === 0 && data.companyName) {
      // Scoped to a name that isn't a portfolio company — scan it as a company.
      companies = [data.companyName.trim()];
    }

    // Internal PDFs from the shared drive (best-effort — empty if unconfigured).
    // Topic scans skip them: they're universe context, not subject context.
    const documents = topic ? [] : await loadSignalDocuments();

    // Already-stored signals — used both to dedupe new signals AND to skip
    // articles we've already turned into signals on a prior scan.
    const existing = await fetchStoredSignals();
    const seenUrls = new Set(
      existing.map((s) => articleUrlKey(s.sourceUrl)).filter(Boolean),
    );

    // Real articles to ground the scan with durable source URLs (best-effort —
    // empty if unconfigured; then Gemini uses Google Search). Two providers feed
    // the same pool: NewsAPI (Event Registry) + Perplexity (Sonar).
    //
    // IMPORTANT: pinned/ad-hoc topics are fetched in their OWN pass first.
    // Mixing them at the end of a long portco+company list used to drop them
    // under NewsAPI/Perplexity batch caps (topics never queried → no Robotics /
    // Quantum / Physical AI stories).
    const topicList = uniqueSearchNames(topics);
    topics = topicList;
    const topicLower = new Set(topicList.map((t) => t.toLowerCase()));
    // Don't re-query the same name as both a company and a pinned topic.
    const companyTargets = uniqueSearchNames([
      ...portcos.map((p) => p.name),
      ...companies,
    ]).filter((n) => !topicLower.has(n.toLowerCase()));
    let articles: Awaited<ReturnType<typeof fetchNewsForCompanies>> = [];
    const pushUnique = (incoming: typeof articles) => {
      const have = new Set(articles.map((a) => articleUrlKey(a.url)).filter(Boolean));
      for (const a of incoming) {
        const u = articleUrlKey(a.url);
        if (u && !have.has(u)) {
          have.add(u);
          articles.push(a);
        }
      }
    };
    try {
      if (isNewsConfigured()) {
        if (topicList.length > 0) {
          pushUnique(
            await fetchNewsForCompanies(topicList, windowDays, {
              maxBatches: Math.max(1, Math.ceil(topicList.length / 10)),
              max: 40,
            }),
          );
        }
        if (companyTargets.length > 0) {
          pushUnique(await fetchNewsForCompanies(companyTargets, windowDays));
        }
      }
    } catch (e) {
      console.error("[gemini] fetchNewsForCompanies failed (continuing without):", e);
    }
    try {
      if (isPerplexityConfigured()) {
        if (topicList.length > 0) {
          pushUnique(
            await fetchPerplexityNews(topicList, windowDays, {
              mode: "topics",
              maxBatches: Math.max(1, Math.ceil(topicList.length / 8)),
              max: 30,
            }),
          );
        }
        if (companyTargets.length > 0) {
          pushUnique(await fetchPerplexityNews(companyTargets, windowDays, { mode: "companies" }));
        }
      }
    } catch (e) {
      console.error("[gemini] fetchPerplexityNews failed (continuing without):", e);
    }

    // Drop articles already processed in a previous scan so we don't re-source
    // the same stories (saves tokens and stops repeats).
    const hadArticles = articles.length > 0;
    articles = articles.filter((a) => !seenUrls.has(articleUrlKey(a.url)));
    if (hadArticles && articles.length === 0) {
      // Every article NewsAPI surfaced has already been turned into a signal —
      // nothing new. Return the stored set without spending a Gemini call.
      await logOpsEvent({
        action: "sync",
        source: "signals_scan",
        status: "ok",
        summary: scoped
          ? `Signals scan for ${data.companyName} · no new articles`
          : topic
            ? `Topic scan "${topic}" · no new articles`
            : "Signals scan · no new articles to process",
        records: 0,
        details: {
          windowDays,
          scoped: scoped || "",
          topic: topic || "",
          existing: existing.length,
          reason: "all_articles_seen",
        },
      });
      return scopeResult(
        resultFromStored(gateStoredRecs(existing, contacts, portcoNames), [], 0),
        scoped,
      );
    }

    // Links from the network's recent emails — pre-attributed to a company by
    // domain, then read by Gemini via the URL-context tool. Skipped for topic
    // scans (subject searches, not inbox digestion).
    let emailLinks: Array<{ url: string; company?: string }> = [];
    if (!topic) {
      try {
        const g = await gatherNetworkEmails({ contacts, portfolio });
        if (g.ok) {
          const d2c = buildDomainToCompany(contacts, portfolio);
          emailLinks = extractEmailLinks(g.emails)
            .filter((u) => {
              const k = articleUrlKey(u);
              return k && !seenUrls.has(k);
            })
            .map((u) => ({ url: u, company: companyForLink(u, d2c) || undefined }));
          // Dedupe email links against each other (tracking-param variants).
          const linkSeen = new Set<string>();
          emailLinks = emailLinks.filter((l) => {
            const k = articleUrlKey(l.url);
            if (!k || linkSeen.has(k)) return false;
            linkSeen.add(k);
            return true;
          });
          // PDFs forwarded to the NEWS@ alias join the scan's document
          // grounding beside the shared-drive PDFs — own count budget so a
          // full Drive lane can't starve them; same per-file size ceiling.
          // Like Drive docs, they re-feed while inside the Gmail window
          // (the window rolling off is the retention cutoff).
          const pickedDocs = g.newsDocs
            .filter((d) => !d.sizeBytes || d.sizeBytes <= MAX_SIGNAL_DOC_BYTES)
            .slice(0, MAX_SIGNAL_DOCS);
          for (const d of pickedDocs) {
            const base64 = await downloadGmailAttachment(d.messageId, d.attachmentId);
            if (base64)
              documents.push({
                name: d.filename || d.subject,
                base64,
                mediaType: "application/pdf",
                // Prefer the archived Drive copy so citations stay openable.
                link: d.driveWebViewLink || d.permalink,
              });
          }
        }
      } catch (e) {
        console.error("[gemini] gatherNetworkEmails for scan failed (continuing):", e);
      }
    }

    // Cap Gemini input so the JSON reply fits under the output-token budget.
    // Topic articles first (pinned themes), then company news, email links, docs.
    const topicArts = articles.filter((a) => topicLower.has(a.company.toLowerCase()));
    const companyArts = articles.filter((a) => !topicLower.has(a.company.toLowerCase()));
    const ARTICLE_CAP = 36;
    const TOPIC_ART_CAP = 16;
    const cappedArticles = [
      ...topicArts.slice(0, TOPIC_ART_CAP),
      ...companyArts.slice(0, Math.max(0, ARTICLE_CAP - Math.min(topicArts.length, TOPIC_ART_CAP))),
    ];
    const cappedEmailLinks = emailLinks.slice(0, 20);
    const cappedDocuments = documents.slice(0, 8);

    const fresh = await runScanSignals({
      windowDays,
      portcos,
      companies,
      people,
      documents: cappedDocuments,
      articles: cappedArticles,
      emailLinks: cappedEmailLinks,
      topics,
    });
    if (!fresh.found) {
      await logOpsEvent({
        action: "sync",
        source: "signals_scan",
        status: "error",
        summary: fresh.error || "Signal scan returned no results",
        records: 0,
        details: {
          windowDays,
          scoped: scoped || "",
          articleCount: articles.length,
          cappedArticleCount: cappedArticles.length,
          topicArticleCount: topicArts.length,
          geminiError: fresh.error || "",
        },
      });
      return fresh;
    }

    // ── Grounded attribution relevance ──────────────────────────
    // The model's 1–10 relevance is only a prior. Recompute relevance from CRM
    // evidence (warmth, engagement, role fit, stated interests, portfolio
    // overlap, actionability), validate the attribution (email must resolve to
    // a real contact; CRM must agree on employer), and append the component
    // breakdown to the justification so every score is inspectable.
    let watchNames = new Set<string>();
    try {
      watchNames = new Set(
        (await buildRadarWatchlist()).map((w) => w.company.trim().toLowerCase()),
      );
    } catch {
      /* watchlist unavailable — portfolio fit falls back to sector overlap */
    }
    const portfolioSectors = [
      ...new Set(portfolio.map((p) => (p.sector || "").trim().toLowerCase()).filter(Boolean)),
    ];
    const resolveContact = buildContactResolver(contacts);
    const demotedToAwareness: typeof fresh.otherSignals = [];
    const rescoredRecs = [];
    for (const r of fresh.recommendations) {
      const contact = resolveContact(r.email, r.person);
      const isPortcoCompany = portcoNames.has((r.company || "").trim().toLowerCase());
      const att = scoreAttribution(
        {
          person: r.person,
          email: r.email,
          company: r.company,
          category: r.category,
          signal: r.signal,
          llmRelevance: r.relevance,
        },
        {
          contact,
          isPortcoCompany,
          isWatchlistCompany: watchNames.has((r.company || "").trim().toLowerCase()),
          isContactAtPortco: Boolean(
            contact?.company && portcoNames.has(contact.company.trim().toLowerCase()),
          ),
          portfolioSectors,
        },
      );
      // Outreach quality gate: portfolio stories never suggest portco people
      // (or unverified recipients), and weak fits don't become suggestions at
      // all — the story is kept as awareness, the outreach is dropped.
      const verdict = outreachVerdict({
        contact,
        storyCompany: r.company,
        relevance: att.relevance,
        portcoNames,
      });
      if (!verdict.ok) {
        demotedToAwareness.push({
          company: r.company,
          person: "",
          category: r.category,
          summary: r.signal,
          sourceUrl: r.sourceUrl,
        });
        continue;
      }
      rescoredRecs.push({
        ...r,
        relevance: att.relevance,
        // Grounded breakdown FIRST so it survives the justification length clamp.
        justification: [att.summary, r.justification].filter(Boolean).join(" — "),
      });
    }

    const dateFound = new Date().toISOString().split("T")[0];
    const candidates = [
      ...rescoredRecs.map((r) => storedFromRec(r, dateFound, portcoNames)),
      ...[...fresh.otherSignals, ...demotedToAwareness].map((a) =>
        storedFromAwareness(a, dateFound, portcoNames),
      ),
    ];

    // Dedup on content key AND source URL so re-scans / Gemini duplicates
    // don't double-store the same story (even with UTM / trailing-slash variants).
    const seen = new Set(existing.map(keyForStored));
    const seenSourceUrls = new Set(
      existing.map((s) => articleUrlKey(s.sourceUrl)).filter(Boolean),
    );
    const toAppend: StoredSignal[] = [];
    for (const c of candidates) {
      const k = keyForStored(c);
      if (seen.has(k)) continue;
      const u = articleUrlKey(c.sourceUrl);
      if (u && seenSourceUrls.has(u)) continue;
      seen.add(k);
      if (u) seenSourceUrls.add(u);
      toAppend.push(c);
    }

    if (toAppend.length > 0) {
      await ensureTab(TAB_NAMES.signals, SIGNAL_HEADERS);
      await ensureHeaderRow(TAB_NAMES.signals, SIGNAL_HEADERS);
      // Widen pre-v2 sheets so the appended event/score columns get header cells.
      await ensureHeaderWidth(TAB_NAMES.signals, SIGNAL_HEADERS);
      // Event clustering (WS1): one real-world event per card — candidates get
      // an eventId FK; new sources for known events join the existing event.
      // extraRows = synthetic burst meta-event cards (WS4).
      const { enriched, extraRows } = await processCandidatesIntoEvents(toAppend);
      await appendSheetRows(TAB_NAMES.signals, [...enriched, ...extraRows].map(rowFromStored));
    }

    await logOpsEvent({
      action: "sync",
      source: "signals_scan",
      status: "ok",
      summary: scoped
        ? `Signals scan for ${data.companyName} · +${toAppend.length} new`
        : topic
          ? `Topic scan "${topic}" · +${toAppend.length} new`
          : `Signals scan · +${toAppend.length} new · ${existing.length + toAppend.length} total`,
      records: toAppend.length,
      details: {
        windowDays,
        scoped: scoped || "",
        topic: topic || "",
        topics: topics.length,
        topicList: topics.join(", "),
        people: people.length,
        portcos: portcos.length,
        companies: companies.length,
        // WS6 cadence audit trail: true on scheduled non-Tier-2 days.
        tier2Skipped,
        articles: articles.length,
        emailLinks: emailLinks.length,
        documents: documents.length,
        existing: existing.length,
        new: toAppend.length,
        // Outreach suggestions the quality gate demoted to awareness this scan.
        demotedRecs: demotedToAwareness.length,
      },
      items: toAppend.slice(0, 40).map((s) => {
        const who = s.person || s.company || "—";
        const what = (s.signal || s.subject || s.id).slice(0, 120);
        return `[${s.type}] ${who} · ${what}`;
      }),
    });

    return scopeResult(
      resultFromStored(
        gateStoredRecs([...existing, ...toAppend], contacts, portcoNames),
        fresh.compliance,
        toAppend.length,
      ),
      scoped,
    );
  } catch (err) {
    console.error("[gemini] scanSignals failed:", err);
    const message = err instanceof Error ? err.message : "Signal scan failed";
    await logOpsEvent({
      action: "sync",
      source: "signals_scan",
      status: "error",
      summary: message,
      records: 0,
      details: { scoped: (data.companyName || "").trim() },
    });
    return {
      found: false,
      error: message,
      recommendations: [],
      otherSignals: [],
      compliance: [],
    };
  }
}

export const scanSignals = createServerFn({ method: "POST" })
  .inputValidator((data: SignalScanInput) => data)
  .handler(async ({ data }): Promise<SignalScanResult> => executeSignalScan(data));

// ── Areas-of-interest suggestion ─────────────────────────────────
// Suggest a contact's interest domains from their title/company/sector using
// Gemini, falling back to the deterministic rule-based inference when Gemini is
// unconfigured or errors. Returns a de-duplicated list of short domain labels.
export interface SuggestAreasResult {
  ok: boolean;
  areas: string[];
  source: "gemini" | "rules";
  error?: string;
}

export const suggestAreasOfInterest = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { title?: string; company?: string; sector?: string; existing?: string[] }) => data,
  )
  .handler(async ({ data }): Promise<SuggestAreasResult> => {
    const { inferInterestAreas } = await import("@/lib/interest-domains");
    const rules = () => inferInterestAreas(data.title || "", data.company || "", data.sector || "");

    if (!isGeminiConfigured()) {
      return { ok: true, areas: rules(), source: "rules" };
    }
    try {
      const prompt = [
        "You classify a business contact into a few broad areas of professional interest.",
        "Given their title, company, and sector, return 3-6 short domain labels (1-2 words each)",
        "such as: AI, Data, Security, Cloud, Fintech, Healthcare, Sales, Marketing, Product, Finance,",
        "Operations, Supply Chain, Logistics, Investing, Energy, Public Sector, Legal, People.",
        "Prefer specific, useful labels over generic ones. Do NOT repeat labels already listed as existing.",
        "",
        `Title: ${data.title || "(unknown)"}`,
        `Company: ${data.company || "(unknown)"}`,
        `Sector: ${data.sector || "(unknown)"}`,
        `Existing areas (do not repeat): ${(data.existing || []).join(", ") || "(none)"}`,
        "",
        'Respond ONLY with a JSON array of strings, e.g. ["AI","Data","Security"]. No prose.',
      ].join("\n");

      const r = await geminiGenerate({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 400,
          temperature: 0.3,
          thinkingConfig: { thinkingBudget: 256 },
        },
      });
      const text = responseText(r) || "";
      const match = text.match(/\[[\s\S]*\]/);
      let areas: string[] = [];
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) {
            areas = parsed.map((x) => String(x).trim()).filter(Boolean);
          }
        } catch {
          /* fall through to rules */
        }
      }
      if (areas.length === 0) return { ok: true, areas: rules(), source: "rules" };
      return { ok: true, areas, source: "gemini" };
    } catch (err) {
      console.error("[gemini] suggestAreasOfInterest failed, using rules:", err);
      return { ok: true, areas: rules(), source: "rules" };
    }
  });

// ── Home daily briefing ──────────────────────────────────────────
// A light, direct Gemini call (NOT the audited agent layer) that turns the
// home dashboard's already-loaded numbers into a short narrative briefing.
export interface HomeSummaryInput {
  metrics: {
    contacts: number;
    hotLeads: number;
    openFollowUps: number;
    targets: number;
    portfolio: number;
  };
  deltas: {
    contacts: number | null;
    hotLeads: number | null;
    targets: number | null;
    portfolio: number | null;
  };
  attention: Array<{ name: string; company?: string; reason: string; detail: string }>;
  attentionTotal: number;
  signals: Array<{ company: string; headline: string }>;
  newSignals?: number;
}

export interface HomeSummaryResult {
  ok: boolean;
  summary?: string;
  error?: string;
}

function buildHomeSummaryPrompt(d: HomeSummaryInput): string {
  const fmtDelta = (n: number | null) =>
    n == null
      ? ""
      : n > 0
        ? ` (+${n} this week)`
        : n < 0
          ? ` (${n} this week)`
          : " (flat this week)";
  const m = d.metrics;
  const lines: string[] = [
    "You are an analyst for the business-development team at Dell Technologies Capital (a venture capital firm).",
    "Write a concise daily briefing of the team's CRM home dashboard, in a confident, professional voice.",
    "",
    "TODAY'S NUMBERS:",
    `- Network contacts: ${m.contacts}${fmtDelta(d.deltas.contacts)}`,
    `- Hot leads: ${m.hotLeads}${fmtDelta(d.deltas.hotLeads)}`,
    `- Open follow-ups needing action: ${m.openFollowUps}`,
    `- Prospecting targets: ${m.targets}${fmtDelta(d.deltas.targets)}`,
    `- Portfolio companies tracked: ${m.portfolio}${fmtDelta(d.deltas.portfolio)}`,
    "",
    `ATTENTION QUEUE (${d.attentionTotal} people need follow-up; top items):`,
    ...(d.attention.length
      ? d.attention.map(
          (a) => `- ${a.name}${a.company ? ` (${a.company})` : ""} — ${a.reason}: ${a.detail}`,
        )
      : ["- (nobody is overdue right now)"]),
    "",
    `RECENT SIGNALS${d.newSignals ? ` (${d.newSignals} new)` : ""}:`,
    ...(d.signals.length
      ? d.signals.map((s) => `- ${s.company}: ${s.headline}`)
      : ["- (no recent signals)"]),
    "",
    "Write 3-4 short bullet points (each starting with '- ') covering what matters most today: the most urgent follow-ups, pipeline momentum, and any notable signal worth acting on.",
    "Reference real names and numbers from the data. Be specific and actionable. No greeting, no preamble, no sign-off, no markdown headers.",
  ];
  return lines.join("\n");
}

// Summarize the home dashboard. Server-side so the Gemini credentials stay secret.
export const generateHomeSummary = createServerFn({ method: "POST" })
  .inputValidator((data: HomeSummaryInput) => data)
  .handler(async ({ data }): Promise<HomeSummaryResult> => {
    if (!isGeminiConfigured()) {
      return { ok: false, error: "Gemini is not configured on the server." };
    }
    try {
      const r = await geminiGenerate({
        contents: [{ role: "user", parts: [{ text: buildHomeSummaryPrompt(data) }] }],
        generationConfig: {
          maxOutputTokens: 1300,
          temperature: 0.5,
          thinkingConfig: { thinkingBudget: 512 },
        },
      });
      const summary = responseText(r);
      if (!summary) return { ok: false, error: "The model returned an empty summary." };
      return { ok: true, summary };
    } catch (err) {
      console.error("[gemini] generateHomeSummary failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : "Summary failed" };
    }
  });

// Load previously stored signals (used by the Signals page loader so they
// survive a refresh without re-running / re-paying for a scan).
export const fetchSignals = createServerFn({ method: "GET" }).handler(
  async (): Promise<SignalScanResult> => {
    try {
      const stored = await fetchStoredSignals();
      // Read-time outreach gate — rows written before the gate existed still
      // get cleaned up on display. If CRM/portfolio loads fail, gate on what
      // we have (empty portco set = relevance floor only) rather than skip it.
      let contacts: Contact[] = [];
      let portcoNames = new Set<string>();
      try {
        const [c, portfolio] = await Promise.all([buildContacts(), buildPortfolioCompanies()]);
        contacts = c;
        portcoNames = new Set(portfolio.map((p) => p.name.trim().toLowerCase()));
      } catch (e) {
        console.error("[gemini] fetchSignals: contacts/portfolio load failed, floor-only gate:", e);
      }
      return resultFromStored(gateStoredRecs(stored, contacts, portcoNames), [], 0);
    } catch (err) {
      console.error("[gemini] fetchSignals failed:", err);
      return { found: true, recommendations: [], otherSignals: [], compliance: [], newCount: 0 };
    }
  },
);

// Lazily fetch one stored signal's full Body by ID. The feed load elides Body
// (fetchStoredSignals lite mode) to stay light; the Signals card calls this on
// expand for recommendations that have one (FeedCard.bodyElided).
export const fetchSignalBody = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<{ body: string }> => {
    const id = (data?.id || "").trim();
    if (!id) return { body: "" };
    try {
      const stored = await fetchStoredSignals({ withBody: true });
      const hit = stored.find((s) => s.id === id);
      return { body: hit?.body || "" };
    } catch (err) {
      console.error("[gemini] fetchSignalBody failed:", err);
      return { body: "" };
    }
  });

// ── Retention prune (SPEC #3) ────────────────────────────────────
// Core lives in signals-prune.server.ts — it also runs nightly as the final
// pass of runSignalsReconcile. This server fn is the on-demand entry point.

export type { PruneSignalsResult } from "./signals-prune.server";

export const pruneSignals = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { retentionDays?: number; mode?: "archive" | "delete"; pruneUndated?: boolean }) => data,
  )
  .handler(async ({ data }) => {
    const { runSignalsPrune } = await import("./signals-prune.server");
    return runSignalsPrune(data || {});
  });
