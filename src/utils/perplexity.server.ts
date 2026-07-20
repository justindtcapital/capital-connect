// Perplexity (Sonar) news integration — a second real-article source for the
// Signals scan, parallel to news.server.ts (Event Registry). Perplexity is a
// search engine with built-in web search + citations, so we use it to surface
// recent, notable news for the firm's portcos + network companies and return the
// SAME NewsArticle shape the scan already grounds on.
//
// Anti-hallucination posture (matches the rest of Signals): we only keep articles
// whose URL Perplexity actually CITED (search_results / citations) — the model's
// prose URLs are never trusted on their own. Degrades gracefully: when
// PERPLEXITY_API_KEY is absent this returns [] and the scan is unaffected.
//
// Env:
//   PERPLEXITY_API_KEY — Sonar API key (https://www.perplexity.ai/settings/api)
//   PERPLEXITY_MODEL   — optional model override (default "sonar"; e.g. "sonar-pro")

import type { NewsArticle } from "./news.server";

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";

export function isPerplexityConfigured(): boolean {
  return Boolean(process.env.PERPLEXITY_API_KEY);
}

// Perplexity's search_recency_filter accepts day|week|month|year. Round the
// requested window up to the nearest supported bucket.
function recencyFilter(windowDays: number): "day" | "week" | "month" | "year" {
  if (windowDays <= 1) return "day";
  if (windowDays <= 7) return "week";
  if (windowDays <= 31) return "month";
  return "year";
}

function normUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return u.trim().toLowerCase().replace(/\/$/, "");
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Pull the first JSON object out of a model reply (it may be fenced or prefaced).
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
  search_results?: Array<{ title?: string; url?: string; date?: string }>;
}

interface ModelItem {
  company?: string;
  title?: string;
  url?: string;
  summary?: string;
  date?: string;
}

// Fetch recent news for the given companies within `windowDays` via Sonar.
// Companies are batched to keep each query focused; only CITED URLs are returned,
// each attributed to the company the model tied it to (cross-checked against the
// input list) or, failing that, the company named in the source title.
export async function fetchPerplexityNews(
  companies: string[],
  windowDays: number,
  opts?: { batchSize?: number; maxBatches?: number; max?: number },
): Promise<NewsArticle[]> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return [];

  const uniq = [...new Set(companies.map((c) => c.trim()).filter(Boolean))];
  if (uniq.length === 0) return [];

  const model = process.env.PERPLEXITY_MODEL?.trim() || "sonar";
  const recency = recencyFilter(windowDays);
  const batchSize = Math.max(1, opts?.batchSize ?? 8);
  const maxBatches = opts?.maxBatches ?? 3; // cost-conscious: each call is billed

  const out: NewsArticle[] = [];

  for (let i = 0, b = 0; i < uniq.length && b < maxBatches; i += batchSize, b++) {
    const batch = uniq.slice(i, i + batchSize);
    const userPrompt =
      `Find notable, recent news (last ${windowDays} days) about these companies: ${batch.join(", ")}.\n` +
      `Return ONLY a JSON object of the form ` +
      `{"items":[{"company":"<exactly one of the listed names>","title":"...","url":"<the source article URL>","summary":"1-2 sentence factual summary","date":"YYYY-MM-DD"}]}.\n` +
      `Include an item only when there is a genuine, recent source article and set url to that article's real URL. ` +
      `Omit companies with no recent news. No prose, JSON only.`;

    let res: Response;
    try {
      res = await fetch(PERPLEXITY_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                "You are a precise financial-news research assistant. Only report real, recent, notable news grounded in web sources you can cite. Never invent URLs. Output strict JSON only.",
            },
            { role: "user", content: userPrompt },
          ],
          search_recency_filter: recency,
          temperature: 0.1,
          max_tokens: 1500,
          return_related_questions: false,
        }),
      });
    } catch (e) {
      console.error("[perplexity] network error:", e);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[perplexity] chat ${res.status}: ${body.slice(0, 200)}`);
      if (res.status === 401 || res.status === 403) break; // bad key — stop
      continue;
    }

    let data: PerplexityResponse;
    try {
      data = (await res.json()) as PerplexityResponse;
    } catch {
      continue;
    }

    // Real, cited sources — the ONLY URLs we trust. Prefer search_results (title +
    // date), fall back to plain citations (URL only).
    const results = (data.search_results || []).filter((r) => r.url);
    const allowed = new Map<string, { title: string; date: string }>();
    for (const r of results)
      allowed.set(normUrl(r.url!), { title: r.title || "", date: r.date || "" });
    for (const c of data.citations || []) {
      const n = normUrl(c);
      if (!allowed.has(n)) allowed.set(n, { title: "", date: "" });
    }
    if (allowed.size === 0) continue; // no verifiable sources in this batch

    // Model's structured attribution (company + summary), keyed by normalized URL.
    const parsed = extractJson(data.choices?.[0]?.message?.content || "") as {
      items?: ModelItem[];
    } | null;
    const byUrl = new Map<string, ModelItem>();
    for (const it of parsed?.items || []) {
      if (it?.url) byUrl.set(normUrl(it.url), it);
    }

    const matchCompany = (title: string, item?: ModelItem): string => {
      const claimed = (item?.company || "").trim();
      if (claimed && batch.some((c) => c.toLowerCase() === claimed.toLowerCase())) return claimed;
      const hay = `${title} ${item?.summary || ""}`.toLowerCase();
      return batch.find((c) => hay.includes(c.toLowerCase())) || "";
    };

    for (const [normalized, meta] of allowed) {
      const item = byUrl.get(normalized);
      const realUrl = item?.url || results.find((r) => normUrl(r.url!) === normalized)?.url || "";
      if (!realUrl || !/^https?:\/\//.test(realUrl)) continue;
      const title = item?.title || meta.title || "";
      const company = matchCompany(title, item);
      if (!company) continue; // drop sources we can't attribute to a listed company
      out.push({
        company,
        title: title || `${company} — recent news`,
        description: (item?.summary || meta.title || "").slice(0, 300),
        url: realUrl,
        source: hostOf(realUrl),
        publishedAt: item?.date || meta.date || "",
      });
    }
  }

  // Dedupe by normalized URL, newest first, capped.
  const seen = new Set<string>();
  const deduped: NewsArticle[] = [];
  for (const a of out.sort((x, y) => (y.publishedAt > x.publishedAt ? 1 : -1))) {
    const n = normUrl(a.url);
    if (seen.has(n)) continue;
    seen.add(n);
    deduped.push(a);
  }
  return deduped.slice(0, opts?.max ?? 60);
}
