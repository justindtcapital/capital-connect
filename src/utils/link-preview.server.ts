// Grounded article previews for digest-email links: fetch each page and read
// its real <title> + meta description (+ published time when declared). No LLM
// involved — everything on the resulting signal card traces to the page itself.
//
// Server-only. Results are cached in-process (TTL) so the weekly digest costs
// one fetch per link, not one per feed load; failures are negative-cached too.

export interface LinkPreview {
  url: string;
  ok: boolean;
  title?: string;
  description?: string;
  /** article:published_time when the page declares one (epoch ms). */
  publishedTs?: number;
}

const CACHE_TTL_MS = 12 * 3_600_000;
const CACHE_MAX = 800;
const FETCH_TIMEOUT_MS = 4_000;
const MAX_HTML_BYTES = 200_000;

const cache = new Map<string, { ts: number; preview: LinkPreview }>();

function cachePut(url: string, preview: LinkPreview): void {
  cache.set(url, { ts: Date.now(), preview });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const c = parseInt(h, 16);
      return Number.isFinite(c) ? String.fromCodePoint(c) : "";
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const c = parseInt(d, 10);
      return Number.isFinite(c) ? String.fromCodePoint(c) : "";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#?39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// <meta property|name="key" content="…"> in either attribute order.
function metaContent(html: string, key: string): string {
  const tag = html.match(
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
      "i",
    ),
  );
  if (!tag) return "";
  const content = tag[0].match(/content=["']([^"']*)["']/i);
  return content ? content[1] : "";
}

function parsePublished(html: string): number | undefined {
  const raw =
    metaContent(html, "article:published_time") ||
    metaContent(html, "og:article:published_time") ||
    metaContent(html, "date");
  if (!raw) return undefined;
  const ts = Date.parse(raw);
  // Sanity: reject unparseable, future (>1d ahead), or ancient values.
  if (Number.isNaN(ts) || ts <= 0 || ts > Date.now() + 86_400_000) return undefined;
  return ts;
}

async function fetchOne(url: string): Promise<LinkPreview> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        // Some blogs 403 unknown agents; a browser-ish UA reads fine.
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
    });
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !/text\/html|application\/xhtml/i.test(type)) return { url, ok: false };
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    const title = decodeEntities(
      metaContent(html, "og:title") || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
    ).slice(0, 160);
    const description = decodeEntities(
      metaContent(html, "og:description") || metaContent(html, "description"),
    ).slice(0, 300);
    if (!title && !description) return { url, ok: false };
    return {
      url,
      ok: true,
      title: title || undefined,
      description: description || undefined,
      publishedTs: parsePublished(html),
    };
  } catch {
    return { url, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch previews for a batch of URLs with bounded concurrency and an overall
 * time budget. Returns whatever finished inside the budget; stragglers keep
 * running in the background and land in the cache for the next load.
 */
export async function fetchLinkPreviews(
  urls: string[],
  opts?: { budgetMs?: number; concurrency?: number },
): Promise<Map<string, LinkPreview>> {
  const budgetMs = opts?.budgetMs ?? 10_000;
  const out = new Map<string, LinkPreview>();
  const todo: string[] = [];
  for (const u of [...new Set(urls)]) {
    const hit = cache.get(u);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) out.set(u, hit.preview);
    else todo.push(u);
  }
  if (todo.length === 0) return out;

  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < todo.length) {
      const u = todo[idx++];
      const p = await fetchOne(u); // never throws
      cachePut(u, p);
      out.set(u, p);
    }
  };
  const workers = Promise.all(
    Array.from({ length: Math.min(opts?.concurrency ?? 8, todo.length) }, worker),
  );

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    workers.then(() => clearTimeout(budgetTimer)),
    new Promise<void>((resolve) => {
      budgetTimer = setTimeout(resolve, budgetMs);
    }),
  ]);
  return out;
}
