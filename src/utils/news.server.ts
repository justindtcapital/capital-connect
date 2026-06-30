// News integration — real, durable article links for the Signals scan.
// Backed by Event Registry / NewsAPI.ai (https://eventregistry.org), key in
// NEWSAPI_KEY. (NOT newsapi.org — different API; this account's keys are UUIDs.)
//
// Used to GROUND the Gemini signal scan: we fetch recent real articles about the
// firm's portcos + network companies and hand them to Gemini, which must cite the
// exact article URL. This replaces the model's hallucinated/expiring source links.
// Degrades gracefully — when NEWSAPI_KEY is absent the scan uses Google Search
// grounding instead (with a search-link fallback).

const EVENT_REGISTRY_URL = "https://eventregistry.org/api/v1/article/getArticles";

export interface NewsArticle {
  /** The network/portco company this article was matched to. */
  company: string;
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
}

export function isNewsConfigured(): boolean {
  return Boolean(process.env.NEWSAPI_KEY);
}

// Fetch recent articles for the given company names within `windowDays`. Companies
// are batched into OR keyword-queries to conserve Event Registry tokens; each
// article is tagged to the company whose name appears in its title/body.
export async function fetchNewsForCompanies(
  companies: string[],
  windowDays: number,
  opts?: { max?: number; batchSize?: number; maxBatches?: number },
): Promise<NewsArticle[]> {
  const key = process.env.NEWSAPI_KEY;
  if (!key) return [];

  const uniq = [...new Set(companies.map((c) => c.trim()).filter(Boolean))];
  if (uniq.length === 0) return [];

  const dateStart = new Date(Date.now() - Math.max(1, windowDays) * 86_400_000).toISOString().split("T")[0];
  // Event Registry caps keywords-per-query (free tier = 15). Stay safely under it.
  const KEYWORD_LIMIT = 10;
  const batchSize = Math.min(KEYWORD_LIMIT, opts?.batchSize ?? KEYWORD_LIMIT);
  const maxBatches = opts?.maxBatches ?? 4; // token-conscious (free tier = 2,000 tokens)

  const out: NewsArticle[] = [];
  for (let i = 0, b = 0; i < uniq.length && b < maxBatches; i += batchSize, b++) {
    const batch = uniq.slice(i, i + batchSize);

    let res: Response;
    try {
      res = await fetch(EVENT_REGISTRY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "getArticles",
          keyword: batch,
          keywordOper: "or",
          lang: "eng",
          dateStart,
          articlesSortBy: "date",
          articlesCount: 50,
          resultType: "articles",
          includeArticleConcepts: false,
          includeArticleCategories: false,
          includeArticleImage: false,
          apiKey: key,
        }),
      });
    } catch (e) {
      console.error("[news] network error:", e);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[news] getArticles ${res.status}: ${body.slice(0, 200)}`);
      if (res.status === 401) break; // bad key — nothing more will work
      continue;
    }

    let data: { articles?: { results?: Array<Record<string, unknown>> }; error?: string };
    try {
      data = (await res.json()) as { articles?: { results?: Array<Record<string, unknown>> }; error?: string };
    } catch {
      continue;
    }
    if (data.error) {
      console.error("[news] Event Registry error:", data.error);
      break; // typically an invalid-key / quota message
    }

    for (const a of data.articles?.results || []) {
      const title = String(a.title || "");
      const bodyText = String(a.body || "");
      const url = String(a.url || "");
      if (!url) continue;
      const hay = `${title} ${bodyText}`.toLowerCase();
      const company = batch.find((c) => hay.includes(c.toLowerCase())) || "";
      if (!company) continue; // drop loosely-matched OR noise
      const src = a.source as { title?: string } | undefined;
      out.push({
        company,
        title,
        description: bodyText.slice(0, 300),
        url,
        source: src?.title || "",
        publishedAt: String(a.dateTime || a.dateTimePub || ""),
      });
    }
  }

  // Dedupe by URL, newest first, capped.
  const seen = new Set<string>();
  const deduped: NewsArticle[] = [];
  for (const a of out.sort((x, y) => (y.publishedAt > x.publishedAt ? 1 : -1))) {
    if (seen.has(a.url)) continue;
    seen.add(a.url);
    deduped.push(a);
  }
  return deduped.slice(0, opts?.max ?? 60);
}
