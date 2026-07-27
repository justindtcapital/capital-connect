// Signal Radar v2 — Tier-1 collectors (SIGNAL_RADAR_V2_DESIGN.md §4).
// Pure fetchers against free, structured, first-party sources:
//   · ATS career boards (Greenhouse / Lever / Ashby public JSON) — hiring exhaust
//   · GitHub org activity — engineering exhaust
//   · Certificate Transparency (crt.sh) — infrastructure exhaust
//
// Deliberately ZERO app imports: collectors take strings in and return metrics
// out, so they can be tested standalone and never entangle the Sheets layer.
// All calls are best-effort with hard timeouts; a dead source returns ok:false,
// never throws.

export interface CollectedMetric {
  /** Metric key, stable across runs (e.g. "ats_open_roles"). */
  metric: string;
  value: number;
  /** Short human detail for justification text (e.g. "3 engineering, 2 sales"). */
  detail?: string;
  /** Where a human can verify this number. */
  sourceUrl: string;
  /** Admiralty-style grade: A=registry/regulatory, B=first-party artifact. */
  grade: "A1" | "A2" | "B1" | "B2";
}

/**
 * Explicit outcome classification so the sweep can tell "the company has no
 * such source" (fine, skip quietly) from "the collector broke" (health alert,
 * and NEVER a downward company signal).
 */
export type CollectorStatus = "ok" | "no_source" | "error" | "ambiguous";

export interface CollectorResult {
  collector: "ats" | "github" | "ct" | "edgar" | "site" | "changelog" | "uspto";
  ok: boolean;
  status: CollectorStatus;
  metrics: CollectedMetric[];
  /** Persisted discovery result (e.g. "greenhouse:stripe") so the next sweep skips probing. */
  resolvedRef?: string;
  error?: string;
  /** Extra context (e.g. ambiguous-match counts) for the entity note / review. */
  note?: string;
}

export const COLLECTOR_VERSIONS: Record<CollectorResult["collector"], string> = {
  ats: "1.2",
  github: "1.1",
  ct: "1.2",
  edgar: "1.0",
  site: "1.0",
  changelog: "1.0",
  uspto: "1.0",
};

const TIMEOUT_MS = 12_000;
const UA = "VenturePulse-SignalRadar/2.0 (relationship-intelligence; contact via app operator)";

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json", ...headers },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function getText(url: string, maxBytes = 2_000_000): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/xml,application/xml,text/plain,*/*" },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } finally {
    clearTimeout(t);
  }
}

/** Candidate ATS/GitHub slugs derived from a company name. */
export function slugCandidates(name: string): string[] {
  const base = (name || "").trim().toLowerCase();
  if (!base) return [];
  const stripped = base.replace(/\b(inc|llc|ltd|corp|co|gmbh|technologies|labs|ai)\.?$/g, "").trim();
  const variants = new Set<string>();
  for (const n of [base, stripped]) {
    if (!n) continue;
    variants.add(n.replace(/[^a-z0-9]/g, ""));
    variants.add(n.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  }
  return [...variants].filter(Boolean).slice(0, 4);
}

function roleBuckets(titles: string[]): { eng: number; gtm: number } {
  let eng = 0;
  let gtm = 0;
  for (const t of titles) {
    const s = t.toLowerCase();
    if (/engineer|developer|swe|infra|devops|sre|data scientist|ml |machine learning|security/.test(s)) eng++;
    else if (/sales|account exec|marketing|growth|business development|customer success|partnership|revenue/.test(s)) gtm++;
  }
  return { eng, gtm };
}

// ── ATS career boards ────────────────────────────────────────────
// The single highest-value weak signal: open-role counts move months before
// press. Providers expose public JSON keyed by a board slug; we discover the
// slug once (name variants) and persist it via resolvedRef.

type AtsProbe = { provider: string; url: (slug: string) => string; titles: (data: unknown) => string[] | null };

const ATS_PROVIDERS: AtsProbe[] = [
  {
    provider: "greenhouse",
    url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    titles: (data) => {
      const jobs = (data as { jobs?: Array<{ title?: string }> })?.jobs;
      return Array.isArray(jobs) ? jobs.map((j) => j.title || "") : null;
    },
  },
  {
    provider: "lever",
    url: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    titles: (data) =>
      Array.isArray(data) ? (data as Array<{ text?: string }>).map((j) => j.text || "") : null,
  },
  {
    provider: "ashby",
    url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    titles: (data) => {
      const jobs = (data as { jobs?: Array<{ title?: string }> })?.jobs;
      return Array.isArray(jobs) ? jobs.map((j) => j.title || "") : null;
    },
  },
  {
    provider: "smartrecruiters",
    url: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`,
    titles: (data) => {
      const content = (data as { content?: Array<{ name?: string }> })?.content;
      return Array.isArray(content) ? content.map((j) => j.name || "") : null;
    },
  },
  {
    provider: "recruitee",
    url: (slug) => `https://${slug}.recruitee.com/api/offers/`,
    titles: (data) => {
      const offers = (data as { offers?: Array<{ title?: string }> })?.offers;
      return Array.isArray(offers) ? offers.map((j) => j.title || "") : null;
    },
  },
  {
    provider: "workable",
    url: (slug) => `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=false`,
    titles: (data) => {
      const jobs = (data as { jobs?: Array<{ title?: string }> })?.jobs;
      return Array.isArray(jobs) ? jobs.map((j) => j.title || "") : null;
    },
  },
];

export async function collectAtsJobs(companyName: string, knownRef?: string): Promise<CollectorResult> {
  // knownRef format "provider:slug" — probe only that when present.
  const probes: Array<{ probe: AtsProbe; slug: string }> = [];
  if (knownRef?.includes(":")) {
    const [prov, slug] = knownRef.split(":");
    const probe = ATS_PROVIDERS.find((p) => p.provider === prov);
    if (probe && slug) probes.push({ probe, slug });
  }
  if (probes.length === 0) {
    for (const slug of slugCandidates(companyName))
      for (const probe of ATS_PROVIDERS) probes.push({ probe, slug });
  }

  const discovering = !knownRef;
  for (const { probe, slug } of probes) {
    try {
      const data = await getJson(probe.url(slug));
      const titles = probe.titles(data);
      if (!titles) continue;
      // Discovery guard: some providers (SmartRecruiters) answer 200 + empty
      // list for ANY slug, so an empty board is NOT proof the company uses this
      // provider — keep probing. Once a board is KNOWN, 0 jobs is a real
      // observation (hiring freeze) and must be reported.
      if (discovering && titles.length === 0) continue;
      const { eng, gtm } = roleBuckets(titles);
      const src = probe.url(slug);
      return {
        collector: "ats",
        ok: true,
        status: "ok",
        resolvedRef: `${probe.provider}:${slug}`,
        metrics: [
          { metric: "ats_open_roles", value: titles.length, detail: `${eng} eng · ${gtm} GTM`, sourceUrl: src, grade: "B1" },
          { metric: "ats_eng_roles", value: eng, sourceUrl: src, grade: "B1" },
          { metric: "ats_gtm_roles", value: gtm, sourceUrl: src, grade: "B1" },
        ],
      };
    } catch {
      /* wrong slug/provider — try next */
    }
  }
  return { collector: "ats", ok: false, status: "no_source", metrics: [], error: "no public ATS board found" };
}

// ── GitHub org activity ──────────────────────────────────────────

interface GhOrg {
  login?: string;
  public_repos?: number;
  followers?: number;
  blog?: string;
}

function ghHeaders(): Record<string, string> {
  const token = process.env["GITHUB_TOKEN"];
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function resolveGithubOrg(companyName: string, domain: string): Promise<string | null> {
  // Try name-derived logins directly (cheap), then a search pass matched by blog domain.
  for (const slug of slugCandidates(companyName)) {
    try {
      const org = (await getJson(`https://api.github.com/orgs/${slug}`, ghHeaders())) as GhOrg;
      if (!org?.login) continue;
      const blog = (org.blog || "").toLowerCase();
      if (!domain || blog.includes(domain) || !blog) return org.login ?? null;
    } catch {
      /* not an org */
    }
  }
  if (!domain) return null;
  try {
    const q = encodeURIComponent(`${companyName} type:org`);
    const res = (await getJson(`https://api.github.com/search/users?q=${q}&per_page=3`, ghHeaders())) as {
      items?: Array<{ login?: string }>;
    };
    for (const item of res.items || []) {
      if (!item.login) continue;
      try {
        const org = (await getJson(`https://api.github.com/orgs/${item.login}`, ghHeaders())) as GhOrg;
        if ((org.blog || "").toLowerCase().includes(domain)) return org.login ?? null;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* search quota — fine */
  }
  return null;
}

export async function collectGithub(
  companyName: string,
  domain: string,
  knownRef?: string,
): Promise<CollectorResult> {
  try {
    const login = knownRef || (await resolveGithubOrg(companyName, domain));
    if (!login)
      return { collector: "github", ok: false, status: "no_source", metrics: [], error: "no matching GitHub org" };

    const [org, repos] = await Promise.all([
      getJson(`https://api.github.com/orgs/${login}`, ghHeaders()) as Promise<GhOrg>,
      getJson(
        `https://api.github.com/orgs/${login}/repos?per_page=100&sort=pushed`,
        ghHeaders(),
      ) as Promise<Array<{ stargazers_count?: number; pushed_at?: string }>>,
    ]);
    const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
    const active90 = repos.filter((r) => r.pushed_at && Date.parse(r.pushed_at) > cutoff).length;
    const stars = repos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
    const src = `https://github.com/${login}`;
    return {
      collector: "github",
      ok: true,
      status: "ok",
      resolvedRef: login,
      metrics: [
        { metric: "gh_public_repos", value: org.public_repos ?? repos.length, sourceUrl: src, grade: "B1" },
        { metric: "gh_active_repos_90d", value: active90, detail: `of ${repos.length} recent`, sourceUrl: src, grade: "B1" },
        { metric: "gh_stars", value: stars, detail: "top 100 repos by push", sourceUrl: src, grade: "B1" },
        { metric: "gh_followers", value: org.followers ?? 0, sourceUrl: src, grade: "B1" },
      ],
    };
  } catch (e) {
    return {
      collector: "github",
      ok: false,
      status: "error",
      metrics: [],
      error: e instanceof Error ? e.message : "github failed",
    };
  }
}

// ── Certificate Transparency (crt.sh) ────────────────────────────
// New subdomains (app.*, enterprise.*, eu.*) show up in CT logs weeks before
// launches. Registry-grade evidence: certificates can't be quietly faked.

// Secondary CT source: certspotter (unauthenticated tier is rate-limited but
// fine as a fallback when crt.sh is down — which is often).
async function certspotterRows(
  domain: string,
): Promise<Array<{ name_value?: string; not_before?: string }>> {
  const data = (await getJson(
    `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=true&expand=dns_names`,
  )) as Array<{ dns_names?: string[]; not_before?: string }>;
  if (!Array.isArray(data)) throw new Error("unexpected certspotter payload");
  return data.map((r) => ({ name_value: (r.dns_names || []).join("\n"), not_before: r.not_before }));
}

export async function collectCtSubdomains(domain: string): Promise<CollectorResult> {
  if (!domain) return { collector: "ct", ok: false, status: "no_source", metrics: [], error: "no domain" };
  try {
    // crt.sh 5xxs routinely under load — one retry, then fail over to certspotter.
    const url = `https://crt.sh/?q=${encodeURIComponent("%." + domain)}&output=json`;
    let rows: Array<{ name_value?: string; not_before?: string }>;
    try {
      rows = (await getJson(url)) as typeof rows;
    } catch {
      try {
        await new Promise((r) => setTimeout(r, 2000));
        rows = (await getJson(url)) as typeof rows;
      } catch {
        rows = await certspotterRows(domain);
      }
    }
    if (!Array.isArray(rows)) throw new Error("unexpected crt.sh payload");

    const subdomains = new Set<string>();
    const cutoff90 = Date.now() - 90 * 24 * 3600 * 1000;
    let certs90 = 0;
    for (const r of rows) {
      for (const raw of (r.name_value || "").split("\n")) {
        const name = raw.trim().toLowerCase();
        if (name && name.endsWith(domain) && !name.startsWith("*")) subdomains.add(name);
      }
      if (r.not_before && Date.parse(r.not_before) > cutoff90) certs90++;
    }
    const src = `https://crt.sh/?q=${encodeURIComponent("%." + domain)}`;
    return {
      collector: "ct",
      ok: true,
      status: "ok",
      metrics: [
        { metric: "ct_subdomains", value: subdomains.size, sourceUrl: src, grade: "A2" },
        { metric: "ct_certs_90d", value: certs90, sourceUrl: src, grade: "A2" },
      ],
    };
  } catch (e) {
    return {
      collector: "ct",
      ok: false,
      status: "error",
      metrics: [],
      error: e instanceof Error ? e.message : "crt.sh failed",
    };
  }
}

// ── Website / sitemap intelligence ───────────────────────────────
// The sitemap is the company's own declared map of its site. New page CLASSES
// (pricing, enterprise, security, customers…) are commercial-motion evidence
// that precedes announcements. We classify URL paths into flags rather than
// diffing HTML — structural, noise-free, and one or two requests per entity.

const PAGE_CLASS_PATTERNS: Array<{ metric: string; pattern: RegExp }> = [
  { metric: "site_has_pricing", pattern: /\/(pricing|plans)(\/|$)/i },
  { metric: "site_has_enterprise", pattern: /\/enterprise(\/|$)/i },
  { metric: "site_has_security", pattern: /\/(security|trust|trust-center|compliance|soc-?2)(\/|$)/i },
  { metric: "site_has_customers", pattern: /\/(customers|case-stud(y|ies)|success-stories|testimonials)(\/|$)/i },
  { metric: "site_has_partners", pattern: /\/(partners|integrations|marketplace|ecosystem)(\/|$)/i },
  { metric: "site_has_docs", pattern: /\/(docs|documentation|developers?|api-reference|api-docs)(\/|$)/i },
  { metric: "site_has_changelog", pattern: /\/(changelog|release-notes|releases|whats-new)(\/|$)/i },
];

function extractLocs(xml: string, cap: number): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < cap) out.push(m[1]);
  return out;
}

async function discoverSitemaps(domain: string): Promise<string[]> {
  // robots.txt is authoritative when present; fall back to conventional paths.
  try {
    const robots = await getText(`https://${domain}/robots.txt`, 100_000);
    const declared = [...robots.matchAll(/^\s*sitemap:\s*(\S+)\s*$/gim)].map((m) => m[1]);
    if (declared.length > 0) return declared.slice(0, 2);
  } catch {
    /* no robots — try defaults */
  }
  return [`https://${domain}/sitemap.xml`, `https://${domain}/sitemap_index.xml`];
}

export async function collectSiteSignals(domain: string): Promise<CollectorResult> {
  if (!domain) return { collector: "site", ok: false, status: "no_source", metrics: [], error: "no domain" };
  try {
    const candidates = await discoverSitemaps(domain);
    let urls: string[] = [];
    let sitemapUrl = "";
    for (const cand of candidates) {
      try {
        const xml = await getText(cand);
        const locs = extractLocs(xml, 5000);
        if (locs.length === 0) continue;
        sitemapUrl = cand;
        if (/<sitemapindex/i.test(xml)) {
          // Index file: aggregate the first few child sitemaps.
          for (const child of locs.slice(0, 3)) {
            try {
              urls.push(...extractLocs(await getText(child), 5000 - urls.length));
            } catch {
              /* child unreachable — partial coverage is fine */
            }
            if (urls.length >= 5000) break;
          }
        } else {
          urls = locs;
        }
        break;
      } catch {
        /* try next candidate */
      }
    }
    if (!sitemapUrl || urls.length === 0) {
      return { collector: "site", ok: false, status: "no_source", metrics: [], error: "no readable sitemap" };
    }

    const paths = urls
      .map((u) => {
        try {
          return new URL(u).pathname;
        } catch {
          return "";
        }
      })
      .filter(Boolean);

    const metrics: CollectedMetric[] = [
      { metric: "site_sitemap_urls", value: paths.length, sourceUrl: sitemapUrl, grade: "B1" },
    ];
    for (const cls of PAGE_CLASS_PATTERNS) {
      const hit = paths.find((p) => cls.pattern.test(p));
      metrics.push({
        metric: cls.metric,
        value: hit ? 1 : 0,
        detail: hit ? `e.g. ${hit}` : undefined,
        sourceUrl: hit ? `https://${domain}${hit}` : sitemapUrl,
        grade: "B1",
      });
    }
    return { collector: "site", ok: true, status: "ok", resolvedRef: sitemapUrl, metrics };
  } catch (e) {
    return {
      collector: "site",
      ok: false,
      status: "error",
      metrics: [],
      error: e instanceof Error ? e.message : "sitemap fetch failed",
    };
  }
}

// ── Changelog release velocity (RSS/Atom) ────────────────────────
// Release cadence is the cleanest product-velocity metric a company publishes.
// We only accept CHANGELOG-scoped feeds (never generic blog feeds — posts are
// not releases), parse entry dates, and count releases in the last 90 days.

const CHANGELOG_FEED_PATHS = [
  "/changelog/rss.xml",
  "/changelog/feed.xml",
  "/changelog/atom.xml",
  "/changelog.xml",
  "/changelog/feed",
  "/changelog/rss",
  "/release-notes/rss.xml",
  "/releases.xml",
];

function feedEntryDates(xml: string): number[] {
  const dates: number[] = [];
  const re = /<(?:pubDate|updated|published)>\s*([^<]+?)\s*<\/(?:pubDate|updated|published)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && dates.length < 500) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t)) dates.push(t);
  }
  return dates;
}

export async function collectChangelogFeed(
  domain: string,
  knownFeed?: string,
): Promise<CollectorResult> {
  if (!domain) return { collector: "changelog", ok: false, status: "no_source", metrics: [], error: "no domain" };
  const candidates = knownFeed ? [knownFeed] : CHANGELOG_FEED_PATHS.map((p) => `https://${domain}${p}`);
  for (const url of candidates) {
    try {
      const xml = await getText(url, 500_000);
      if (!/<(rss|feed|channel)[\s>]/i.test(xml)) continue;
      const dates = feedEntryDates(xml);
      if (dates.length === 0) continue;
      const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
      const recent = dates.filter((t) => t > cutoff).length;
      return {
        collector: "changelog",
        ok: true,
        status: "ok",
        resolvedRef: url,
        metrics: [
          {
            metric: "changelog_releases_90d",
            value: recent,
            detail: `${dates.length} entries in feed`,
            sourceUrl: url,
            grade: "B1",
          },
        ],
      };
    } catch {
      /* try next candidate */
    }
  }
  return { collector: "changelog", ok: false, status: "no_source", metrics: [], error: "no changelog feed found" };
}

// ── SEC EDGAR Form D (regulatory funding evidence) ───────────────
// A Form D means securities were actually sold — the highest-grade fundraise
// evidence that exists, and frequently the ONLY disclosure a quiet round gets.
//
// Entity resolution is the hazard: EDGAR full-text search returns SPVs and
// series LLCs that merely mention the name ("Acme Jun 2022 a Series of CGF2021
// LLC"). We therefore require STRICT normalized-name equality with the issuer's
// display name (legal suffixes stripped) — or a previously verified CIK.
// Anything else is reported as ambiguous and never becomes a filing count.

/** Normalize a company/issuer name for strict comparison. */
export function normalizeIssuerName(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/\(cik[^)]*\)/g, "")
    .replace(/[.,'’]/g, "")
    .replace(/\b(incorporated|inc|corporation|corp|company|co|llc|llp|lp|ltd|limited|holdings|technologies|labs)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface EdgarHit {
  _id?: string;
  _source?: {
    ciks?: string[];
    display_names?: string[];
    file_date?: string;
    adsh?: string;
    form?: string;
  };
}

export async function collectEdgarFormD(
  companyName: string,
  knownCik?: string,
): Promise<CollectorResult> {
  const wanted = normalizeIssuerName(companyName);
  if (!wanted) return { collector: "edgar", ok: false, status: "no_source", metrics: [], error: "no company name" };
  try {
    const q = encodeURIComponent(`"${companyName.trim()}"`);
    const data = (await getJson(`https://efts.sec.gov/LATEST/search-index?q=${q}&forms=D`)) as {
      hits?: { hits?: EdgarHit[] };
    };
    const hits = data?.hits?.hits || [];

    const matched: Array<{ cik: string; date: string; adsh: string; name: string }> = [];
    let ambiguous = 0;
    const seenAdsh = new Set<string>();
    for (const h of hits) {
      const src = h._source;
      if (!src || src.form !== "D") continue;
      const display = (src.display_names || [])[0] || "";
      const cik = ((src.ciks || [])[0] || "").replace(/^0+/, "");
      const adsh = src.adsh || "";
      if (!adsh || seenAdsh.has(adsh)) continue;
      const cikMatch = knownCik && cik && cik === knownCik.replace(/^0+/, "");
      const nameMatch = normalizeIssuerName(display) === wanted;
      if (cikMatch || nameMatch) {
        seenAdsh.add(adsh);
        matched.push({ cik, date: src.file_date || "", adsh, name: display });
      } else if (normalizeIssuerName(display).startsWith(wanted)) {
        // Mentions the name but is a different issuer (SPV / series LLC / fund).
        ambiguous++;
      }
    }

    if (matched.length === 0) {
      return {
        collector: "edgar",
        ok: false,
        status: ambiguous > 0 ? "ambiguous" : "no_source",
        metrics: [],
        error: ambiguous > 0 ? `${ambiguous} near-match filings need review (SPV/series names)` : "no Form D filings found",
        note: ambiguous > 0 ? `EDGAR near-matches for "${companyName}": ${ambiguous} — verify issuer CIK to include them` : undefined,
      };
    }

    matched.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const latest = matched[0];
    const humanUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${latest.cik}&type=D&dateb=&owner=include&count=40`;
    return {
      collector: "edgar",
      ok: true,
      status: "ok",
      resolvedRef: latest.cik,
      metrics: [
        {
          metric: "sec_formd_filings",
          value: matched.length,
          detail: `latest ${latest.date} (${latest.name.replace(/\s*\(CIK[^)]*\)\s*/i, "")})`,
          sourceUrl: humanUrl,
          grade: "A1",
        },
      ],
      note: ambiguous > 0 ? `${ambiguous} additional near-match filings excluded (SPV/series names)` : undefined,
    };
  } catch (e) {
    return {
      collector: "edgar",
      ok: false,
      status: "error",
      metrics: [],
      error: e instanceof Error ? e.message : "EDGAR search failed",
    };
  }
}

// ── USPTO trademarks (launch / brand precursors) ─────────────────
// Requires USPTO_API_KEY from https://account.uspto.gov/api-manager/ (TSDR)
// and/or https://data.uspto.gov/apis/getting-started (ODP). Without a key the
// collector returns no_source — never invents filings. Owner matching is strict
// (same spirit as Form D): legal-suffix-stripped equality, not substring.

/** Normalize an owner / applicant name for trademark matching. */
export function normalizeTrademarkOwner(name: string): string {
  return normalizeIssuerName(name);
}

interface UsptoHit {
  serial: string;
  mark: string;
  owner: string;
  status?: string;
}

function extractUsptoHits(payload: unknown, wanted: string): { matched: UsptoHit[]; ambiguous: number } {
  const matched: UsptoHit[] = [];
  const seen = new Set<string>();
  let ambiguous = 0;

  const push = (raw: Record<string, unknown>) => {
    const serial = String(
      raw.serialNumber || raw.serial || raw.applicationNumber || raw.appNumber || "",
    ).replace(/\D/g, "");
    const mark = String(
      raw.markIdentification || raw.mark || raw.wordMark || raw.trademarkName || raw.markText || "",
    ).trim();
    const owner = String(
      raw.ownerName ||
        raw.owner ||
        raw.applicantName ||
        (Array.isArray(raw.owners) && raw.owners[0]
          ? (raw.owners[0] as Record<string, unknown>).name ||
            (raw.owners[0] as Record<string, unknown>).partyName ||
            ""
          : "") ||
        "",
    ).trim();
    if (!serial && !mark) return;
    const ownerNorm = normalizeTrademarkOwner(owner);
    if (!ownerNorm) return;
    if (ownerNorm === wanted) {
      const key = serial || mark.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      matched.push({
        serial,
        mark,
        owner,
        status: String(raw.status || raw.statusCode || raw.tm5StatusCode || ""),
      });
    } else if (ownerNorm.startsWith(wanted) || wanted.startsWith(ownerNorm)) {
      ambiguous++;
    }
  };

  const walk = (node: unknown, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const looksLikeHit =
      obj.serialNumber ||
      obj.serial ||
      obj.markIdentification ||
      obj.wordMark ||
      obj.trademarkName ||
      obj.markText;
    if (looksLikeHit) push(obj);
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(payload);
  return { matched, ambiguous };
}

async function usptoFetchJson(
  url: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const headers = new Headers(init.headers || {});
    headers.set("User-Agent", UA);
    headers.set("Accept", "application/json");
    // ODP uses X-API-KEY; TSDR uses USPTO-API-KEY — send both for one env var.
    headers.set("X-API-KEY", apiKey);
    headers.set("USPTO-API-KEY", apiKey);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const res = await fetch(url, { ...init, headers, signal: ctl.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Count live USPTO trademark applications/registrations for a company owner.
 * Metric: uspto_trademark_filings (filing kind — any increase is an event).
 */
export async function collectUsptoTrademarks(
  companyName: string,
  knownRef?: string,
): Promise<CollectorResult> {
  const wanted = normalizeTrademarkOwner(companyName);
  if (!wanted) {
    return { collector: "uspto", ok: false, status: "no_source", metrics: [], error: "no company name" };
  }

  const apiKey = (process.env["USPTO_API_KEY"] || "").trim();
  if (!apiKey) {
    return {
      collector: "uspto",
      ok: false,
      status: "no_source",
      metrics: [],
      error:
        "USPTO_API_KEY not set — register free at https://account.uspto.gov/api-manager/ (TSDR) or https://data.uspto.gov/apis/getting-started",
    };
  }

  try {
    const matched: UsptoHit[] = [];
    let ambiguous = 0;
    const knownSerials = String(knownRef || "")
      .split(",")
      .map((s) => s.replace(/\D/g, ""))
      .filter((s) => s.length >= 7)
      .slice(0, 40);

    // 1) Refresh known serials via TSDR (authoritative case status).
    for (const sn of knownSerials) {
      const r = await usptoFetchJson(
        `https://tsdrapi.uspto.gov/ts/cd/casestatus/sn${sn}/info.json`,
        apiKey,
      );
      if (r.status === 401 || r.status === 403) {
        return {
          collector: "uspto",
          ok: false,
          status: "error",
          metrics: [],
          error: `USPTO auth failed (HTTP ${r.status}) — check USPTO_API_KEY`,
        };
      }
      if (!r.ok) continue;
      const extracted = extractUsptoHits(r.json, wanted);
      // TSDR payloads often nest owner under parties — if strict owner extract
      // fails but we already trusted this serial, count it as live.
      if (extracted.matched.length > 0) matched.push(...extracted.matched);
      else {
        matched.push({ serial: sn, mark: "", owner: companyName, status: "known" });
      }
      ambiguous += extracted.ambiguous;
    }

    // 2) ODP / gateway search by owner name (shape varies by gateway version).
    if (matched.length === 0) {
      const queries = [
        {
          url: "https://api.uspto.gov/api/v1/trademark/applications/search",
          body: JSON.stringify({
            q: `ownerName:"${companyName.trim()}"`,
            rows: 50,
            start: 0,
          }),
        },
        {
          url: "https://api.uspto.gov/api/v1/trademark/applications/search",
          body: JSON.stringify({
            criteria: { ownerName: companyName.trim() },
            rows: 50,
            start: 0,
          }),
        },
      ];
      for (const q of queries) {
        const r = await usptoFetchJson(q.url, apiKey, { method: "POST", body: q.body });
        if (r.status === 401 || r.status === 403) {
          return {
            collector: "uspto",
            ok: false,
            status: "error",
            metrics: [],
            error: `USPTO auth failed (HTTP ${r.status}) — check USPTO_API_KEY`,
          };
        }
        if (!r.ok) continue;
        const extracted = extractUsptoHits(r.json, wanted);
        matched.push(...extracted.matched);
        ambiguous += extracted.ambiguous;
        if (matched.length > 0) break;
      }
    }

    // Dedup by serial.
    const bySerial = new Map<string, UsptoHit>();
    for (const h of matched) {
      const key = h.serial || h.mark.toLowerCase();
      if (!key) continue;
      if (!bySerial.has(key)) bySerial.set(key, h);
    }
    const unique = [...bySerial.values()];

    if (unique.length === 0) {
      return {
        collector: "uspto",
        ok: false,
        status: ambiguous > 0 ? "ambiguous" : "no_source",
        metrics: [],
        error:
          ambiguous > 0
            ? `${ambiguous} near-match trademark owner(s) need review`
            : "no USPTO trademarks found for strict owner match",
        note:
          ambiguous > 0
            ? `USPTO near-matches for "${companyName}": ${ambiguous} — verify owner legal name`
            : undefined,
      };
    }

    const serials = unique
      .map((h) => h.serial)
      .filter(Boolean)
      .slice(0, 40);
    const sample = unique.find((h) => h.mark)?.mark || unique[0].serial;
    const humanUrl = serials[0]
      ? `https://tsdr.uspto.gov/#caseNumber=${serials[0]}&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch`
      : `https://tmsearch.uspto.gov/`;

    return {
      collector: "uspto",
      ok: true,
      status: "ok",
      resolvedRef: serials.join(","),
      metrics: [
        {
          metric: "uspto_trademark_filings",
          value: unique.length,
          detail: sample ? `e.g. "${sample}"` : `${unique.length} mark(s)`,
          sourceUrl: humanUrl,
          grade: "A1",
        },
      ],
      note: ambiguous > 0 ? `${ambiguous} additional near-match owners excluded` : undefined,
    };
  } catch (e) {
    return {
      collector: "uspto",
      ok: false,
      status: "error",
      metrics: [],
      error: e instanceof Error ? e.message : "USPTO search failed",
    };
  }
}

/** Registrable domain from a website URL / bare host ("" when unparsable). */
export function domainOf(website: string): string {
  const raw = (website || "").trim().toLowerCase();
  if (!raw) return "";
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
    return host.replace(/^www\./, "");
  } catch {
    return "";
  }
}
