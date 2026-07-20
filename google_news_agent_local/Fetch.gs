/**
 * Fetch.gs — GDELT news retrieval and article text extraction.
 *
 * GDELT's DOC API is free and needs no key, and — unlike Google News RSS —
 * it returns real publisher URLs. That matters: the whole pipeline downstream
 * depends on being able to actually fetch the article to summarize it.
 * (Google News RSS returns opaque news.google.com redirectors that only
 * resolve in a real browser, so every summary would be headline-only.)
 *
 * The trade is relevance: GDELT full-text matches, so a bare company name
 * pulls in unrelated stories. Two defenses:
 *   1. buildGdeltQuery_ narrows with language + your GDELT_EXTRA_QUERY.
 *   2. Gemini judges relevance per article and Main.gs drops the misses.
 *
 * Rate limit: GDELT asks for roughly one request every 5 seconds and answers
 * 429 when pushed. Entity queries therefore run SEQUENTIALLY with a pause —
 * do not "optimize" this into fetchAll. Article scraping still parallelizes,
 * since that hits publishers rather than GDELT.
 */

const GDELT_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_MAX_ATTEMPTS = 3;

/**
 * Runs every query for a repository against GDELT and returns a flat,
 * de-duplicated list of articles.
 *
 * One failing query is logged and skipped rather than sinking the run.
 *
 * @param {!Array<{entity: ?string, q: string}>} queries
 * @return {!Array<{entity: ?string, title: string, source: string, url: string, date: ?Date}>}
 */
/**
 * Routes to the configured news provider(s). Every provider returns the same
 * article shape. When more than one is listed, results are merged and
 * URL-deduped so Gemini never sees the same story twice.
 *
 * @param {!Array<{entity: ?string, about: string, q: string}>} queries
 * @return {!Array<!Object>}
 */
function fetchNews_(queries) {
  const providers = newsProviders_();
  const pools = [];

  providers.forEach(provider => {
    if (provider === 'perplexity') {
      pools.push({ name: provider, articles: fetchPerplexityNews_(queries) });
      return;
    }
    if (provider === 'newsapi') {
      pools.push({ name: provider, articles: fetchNewsApiNews_(queries) });
      return;
    }
    if (provider === 'gdelt') {
      pools.push({ name: provider, articles: fetchGdeltNews_(queries) });
      return;
    }
    throw new Error(
      `Unknown news provider "${provider}". Expected 'perplexity', 'newsapi', or 'gdelt'.`
    );
  });

  const merged = [];
  pools.forEach(pool => Array.prototype.push.apply(merged, pool.articles));
  const out = dedupeArticles_(merged);

  if (pools.length > 1) {
    Logger.log(
      `News merge (${providers.join(' + ')}): ` +
      pools.map(p => `${p.name}=${p.articles.length}`).join(', ') +
      ` → ${out.length} unique URL(s).`
    );
  }

  return out;
}

/** Active providers: NEWS_PROVIDERS if set, else [NEWS_SOURCE]. */
function newsProviders_() {
  if (CONFIG.NEWS_PROVIDERS && CONFIG.NEWS_PROVIDERS.length) {
    return CONFIG.NEWS_PROVIDERS.map(p => String(p).trim().toLowerCase()).filter(Boolean);
  }
  return [String(CONFIG.NEWS_SOURCE || 'perplexity').trim().toLowerCase()];
}

function fetchGdeltNews_(queries) {
  if (!queries.length) return [];

  const articles = [];
  const failed = [];

  queries.forEach((query, i) => {
    if (i > 0) Utilities.sleep(CONFIG.GDELT_REQUEST_INTERVAL_MS);

    const items = fetchGdeltQuery_(query.q);

    // null means GDELT never answered. Do not let that pass as "no news" —
    // say so, or a throttled run looks identical to a quiet news day.
    if (items === null) {
      failed.push(query.entity || query.q);
      return;
    }

    items
      .slice(0, CONFIG.MAX_ARTICLES_PER_QUERY)
      .forEach(item => {
        const article = articleFromGdeltItem_(item, query);
        if (article) articles.push(article);
      });
  });

  if (failed.length) {
    Logger.log(
      `WARNING: ${failed.length}/${queries.length} GDELT queries FAILED (not empty — ` +
      `never answered): ${failed.join(', ')}. Those entities are missing from this run. ` +
      `Usually rate limiting; raise CONFIG.GDELT_REQUEST_INTERVAL_MS.`
    );
  }

  return dedupeArticles_(articles);
}

/**
 * One GDELT query, with exponential backoff on 429.
 *
 * Returns null on FAILURE and [] on a genuine empty result. The distinction is
 * load-bearing: collapsing both to [] makes a throttled query indistinguishable
 * from "no news today", so an outage reads as silence and the run reports +0
 * as though everything were fine.
 *
 * @param {string} q
 * @return {?Array<!Object>} items, or null if GDELT never answered
 */
function fetchGdeltQuery_(q) {
  const url = gdeltUrl_(q);

  for (let attempt = 1; attempt <= GDELT_MAX_ATTEMPTS; attempt++) {
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; portco-news-bot/1.0)' },
    });

    const code = response.getResponseCode();
    const text = response.getContentText();

    // GDELT signals throttling two ways: a 429, or a 200 with a plain-text
    // complaint. Treat both as retryable.
    const throttled = code === 429 || (code === 200 && text.indexOf('one every 5 seconds') !== -1);

    if (throttled) {
      if (attempt < GDELT_MAX_ATTEMPTS) {
        // Exponential: linear backoff was not enough to escape a hot limiter.
        const wait = CONFIG.GDELT_REQUEST_INTERVAL_MS * Math.pow(2, attempt - 1);
        Logger.log(`GDELT rate-limited on "${q}" (attempt ${attempt}). Waiting ${wait}ms.`);
        Utilities.sleep(wait);
        continue;
      }
      Logger.log(`GDELT still rate-limiting "${q}" after ${GDELT_MAX_ATTEMPTS} attempts — ` +
                 `giving up on this query. Raise CONFIG.GDELT_REQUEST_INTERVAL_MS.`);
      return null;
    }

    if (code !== 200) {
      Logger.log(`GDELT ${code} for "${q}": ${text.slice(0, 300)}`);
      return null;
    }

    return parseGdeltBody_(text, q);
  }

  return null;
}

/**
 * GDELT answers 200 with a plain-text complaint for a rejected query
 * (too short, bad operator), so a non-JSON body is a query bug, not an outage.
 */
function parseGdeltBody_(text, q) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  if (trimmed.charAt(0) !== '{') {
    Logger.log(`GDELT rejected "${q}": ${trimmed.slice(0, 300)}`);
    return [];
  }

  let body;
  try {
    body = JSON.parse(trimmed);
  } catch (err) {
    Logger.log(`GDELT returned unparseable JSON for "${q}": ${err}`);
    return [];
  }

  return body.articles || [];
}

/**
 * Builds the GDELT query URL.
 *
 * `timespan` bounds recency the same way LOOKBACK_DAYS did before, and
 * sort=datedesc puts newest first so MAX_ARTICLES_PER_QUERY truncates the
 * tail rather than a random slice.
 */
function gdeltUrl_(q) {
  return GDELT_ENDPOINT + '?' + toQueryString_({
    query: buildGdeltQuery_(q),
    mode: 'artlist',
    maxrecords: CONFIG.MAX_ARTICLES_PER_QUERY,
    timespan: `${CONFIG.LOOKBACK_DAYS}d`,
    format: 'json',
    sort: 'datedesc',
  });
}

/**
 * Turns an entity name into a GDELT phrase term.
 *
 * GDELT rejects short quoted phrases outright — `"Nike"` comes back as
 * "The specified phrase is too short", which would silently yield zero
 * articles for every single-word company forever. Unquoted, a lone token
 * matches exactly the same thing, so only multi-word names get quotes
 * (where the quotes genuinely buy phrase-adjacency: "Warby Parker" rather
 * than every article containing both "Warby" and "Parker").
 *
 * @param {string} name
 * @return {string}
 */
function gdeltPhrase_(name) {
  const trimmed = String(name || '').trim();
  return /\s/.test(trimmed) ? `"${trimmed}"` : trimmed;
}

/**
 * Narrows a raw query with the configured GDELT filters.
 *
 * GDELT matches full text, so `"Nike"` alone surfaces any article that merely
 * mentions Nike. GDELT_EXTRA_QUERY is the main precision lever — see Config.gs.
 *
 * @param {string} q
 * @return {string}
 */
function buildGdeltQuery_(q) {
  const parts = [q];

  if (CONFIG.GDELT_SOURCE_LANG) {
    parts.push(`sourcelang:${CONFIG.GDELT_SOURCE_LANG}`);
  }
  if (CONFIG.GDELT_SOURCE_COUNTRY) {
    parts.push(`sourcecountry:${CONFIG.GDELT_SOURCE_COUNTRY}`);
  }
  if (CONFIG.GDELT_EXTRA_QUERY) {
    parts.push(CONFIG.GDELT_EXTRA_QUERY);
  }

  return parts.join(' ');
}

/**
 * Maps a GDELT item onto the pipeline article shape.
 * Returns null if url or title is missing.
 *
 * `query` and `about` ride along so Gemini can judge relevance: `about` is the
 * one-line dossier from Config.gs, `query` is the topic for repos with no
 * entity (Industry News). Neither is ever written to a sheet.
 *
 * @param {!Object} item
 * @param {{entity: ?string, about: (string|undefined), q: string}} query
 * @return {?{entity: ?string, about: string, query: string, title: string,
 *            source: string, url: string, date: ?Date}}
 */
function articleFromGdeltItem_(item, query) {
  if (!item || !item.url || !item.title) return null;

  return {
    entity: query.entity,
    about: query.about || '',
    query: query.q,
    title: String(item.title).trim(),
    // GDELT gives the domain, not a display name. It is the honest value for
    // a Source column, and it is what dedupe and any later filtering key on.
    source: String(item.domain || '').trim(),
    url: String(item.url).trim(),
    date: parseGdeltDate_(item.seendate),
  };
}

/**
 * GDELT seendate is compact ISO-8601 basic format: "20260715T141500Z".
 * Returns null if it cannot be parsed — the row still gets written.
 */
function parseGdeltDate_(raw) {
  if (!raw) return null;
  const text = String(raw).trim();

  const compact = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (compact) {
    return new Date(Date.UTC(
      parseInt(compact[1], 10),
      parseInt(compact[2], 10) - 1,
      parseInt(compact[3], 10),
      parseInt(compact[4], 10),
      parseInt(compact[5], 10),
      parseInt(compact[6], 10)
    ));
  }

  const fallback = new Date(text);
  return isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * Article text for each article, index-aligned.
 *
 * Perplexity returns page content in `snippet`, so most articles need no HTTP
 * call at all — which is the main reason it beats the alternatives: a fetch we
 * never make is a paywall we never hit and a summary that never silently
 * degrades to a headline rephrase. Anything without a usable snippet falls back
 * to scraping the page.
 *
 * @param {!Array<{url: string, snippet: (string|undefined)}>} articles
 * @return {!Array<string>}
 */
function articleTexts_(articles) {
  if (!articles.length) return [];

  const texts = new Array(articles.length);
  const needScraping = [];
  let skippedBinary = 0;

  articles.forEach((article, i) => {
    const snippet = String(article.snippet || '').trim();
    if (snippet.length >= CONFIG.SNIPPET_MIN_CHARS) {
      texts[i] = snippet.slice(0, CONFIG.ARTICLE_TEXT_LIMIT);
    } else if (!isScrapableUrl_(article.url)) {
      // PDFs and other binaries hang UrlFetchApp and yield nothing useful
      // for stripHtml_. Leave blank so Gemini summarizes from the headline.
      skippedBinary++;
      Logger.log(`Skipping scrape of non-HTML URL: ${article.url}`);
      texts[i] = '';
    } else {
      needScraping.push(i);
    }
  });

  if (skippedBinary) {
    Logger.log(`${skippedBinary} non-HTML URL(s) skipped (PDF/binary) — summarizing from headline.`);
  }

  if (needScraping.length) {
    Logger.log(
      `${articles.length - needScraping.length - skippedBinary}/${articles.length} articles used the search ` +
      `snippet directly. Fetching ${needScraping.length} with thin or missing snippets.`
    );
    const scraped = fetchArticleTexts_(needScraping.map(i => articles[i]));
    needScraping.forEach((articleIndex, k) => { texts[articleIndex] = scraped[k]; });
  } else if (!skippedBinary) {
    Logger.log(`All ${articles.length} articles used the search snippet — no pages fetched.`);
  }

  return texts.map(t => t || '');
}

/**
 * True when a URL is worth attempting as an HTML article scrape.
 * PDFs and IR "static-files" downloads have hung entire fetchAll batches
 * (Apps Script times out the whole chunk when one request stalls).
 */
function isScrapableUrl_(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return false;
  if (/\.pdf(\?|#|$)/.test(u)) return false;
  if (/\.(docx?|xlsx?|pptx?|zip|gz|tgz|rar|7z)(\?|#|$)/.test(u)) return false;
  if (/\.(mp4|mp3|mov|avi|m4a|wav|png|jpe?g|gif|webp|svg)(\?|#|$)/.test(u)) return false;
  // Investor-relations CDNs often serve PDFs under this path with no extension.
  if (/\/static-files\//.test(u)) return false;
  return true;
}

/**
 * Downloads each article and reduces it to plain text for Gemini.
 *
 * The fallback path, for articles whose snippet was thin or absent. Still
 * best-effort: paywalls, consent walls, and JS-rendered pages yield little or
 * nothing. Articles that fail return '' and get summarized from the headline
 * alone, which Gemini is told about explicitly.
 *
 * These hit publishers, not the search API, so they parallelize safely.
 *
 * @param {!Array<{url: string}>} articles
 * @return {!Array<string>} article text, index-aligned with the input
 */
function fetchArticleTexts_(articles) {
  if (!articles.length) return [];

  const requests = articles.map(article => ({
    url: article.url,
    method: 'get',
    followRedirects: true,
    muteHttpExceptions: true,
    headers: {
      // Without a browser UA a meaningful number of publishers return 403.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    },
  }));

  return fetchAllBatched_(requests).map((response, i) => {
    if (!response) return '';
    if (response.getResponseCode() !== 200) {
      Logger.log(`Article fetch ${response.getResponseCode()}: ${articles[i].url}`);
      return '';
    }
    try {
      return stripHtml_(response.getContentText()).slice(0, CONFIG.ARTICLE_TEXT_LIMIT);
    } catch (err) {
      Logger.log(`Could not decode ${articles[i].url}: ${err}`);
      return '';
    }
  });
}

/** Crude but dependency-free HTML to text. Good enough to summarize from. */
function stripHtml_(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    // Numeric entities are everywhere in publisher HTML (&#8217; &#8211;).
    // Decode them before the catch-all below, which would otherwise blank
    // them and hand Gemini "India s" instead of "India's".
    .replace(/&#(\d+);/g, (match, code) => decodeCharCode_(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => decodeCharCode_(parseInt(code, 16)))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Code point to character, falling back to a space on anything invalid. */
function decodeCharCode_(code) {
  if (!isFinite(code) || code <= 0 || code > 0x10FFFF) return ' ';
  try {
    return String.fromCodePoint(code);
  } catch (err) {
    return ' ';
  }
}

/**
 * UrlFetchApp.fetchAll in chunks, so a large run does not hammer quota in
 * one burst. A chunk that throws (e.g. one hung PDF timing out the whole
 * batch) is retried one request at a time so the other URLs still get a
 * chance — rather than nulling the entire slice.
 *
 * For publisher and Gemini calls only — never for GDELT, which rate-limits.
 *
 * @param {!Array<!Object>} requests
 * @param {{batchSize: (number|undefined), pauseMs: (number|undefined)}=} opts
 *        Optional overrides — Gemini uses a smaller batch than scrapes.
 */
function fetchAllBatched_(requests, opts) {
  const out = [];
  const batchSize = (opts && opts.batchSize) || CONFIG.FETCH_BATCH_SIZE || 20;
  const pauseMs = (opts && opts.pauseMs !== undefined)
    ? opts.pauseMs
    : (CONFIG.FETCH_BATCH_PAUSE_MS || 0);
  const label = (opts && opts.label) || 'HTTP';
  const total = requests.length;

  if (total > batchSize) {
    Logger.log(`${label}: ${total} request(s) in batches of ${batchSize}...`);
  }

  for (let i = 0; i < requests.length; i += batchSize) {
    if (i > 0 && pauseMs > 0) Utilities.sleep(pauseMs);
    const chunk = requests.slice(i, i + batchSize);
    try {
      Array.prototype.push.apply(out, UrlFetchApp.fetchAll(chunk));
    } catch (err) {
      Logger.log(`fetchAll batch starting at ${i} failed: ${err}`);
      Logger.log(`Retrying ${chunk.length} request(s) one at a time so one hang does not wipe the batch.`);
      chunk.forEach(req => out.push(fetchOneRequest_(req)));
    }

    const done = Math.min(i + batchSize, total);
    // Log every batch for large runs so Executions does not look "stuck".
    if (total > batchSize) {
      Logger.log(`${label}: ${done}/${total}`);
    }
  }
  return out;
}

/**
 * Single UrlFetchApp.fetch from a fetchAll-style request object.
 * Returns null on throw so callers stay index-aligned.
 */
function fetchOneRequest_(req) {
  try {
    const opts = {
      method: req.method || 'get',
      muteHttpExceptions: req.muteHttpExceptions !== false,
      followRedirects: req.followRedirects !== false,
    };
    if (req.headers) opts.headers = req.headers;
    if (req.contentType) opts.contentType = req.contentType;
    if (req.payload !== undefined) opts.payload = req.payload;
    return UrlFetchApp.fetch(req.url, opts);
  } catch (err) {
    Logger.log(`Single fetch failed (${req.url}): ${err}`);
    return null;
  }
}

function toQueryString_(params) {
  return Object.keys(params)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');
}

/**
 * Collapses duplicates: same URL, and the same story syndicated across sites.
 *
 * URL dedupe alone is not enough. Wire stories run on many outlets under
 * different URLs — one live run returned "Iowa to Receive Portion of $18
 * Million 23andMe Settlement" from both koel.com and kdat.com. Untouched,
 * that costs one Gemini call per copy and writes one row per copy.
 *
 * The surviving copy is chosen DETERMINISTICALLY (earliest seen, then domain
 * alphabetically) rather than by arrival order. That matters across runs: the
 * sheet has no Title column — the diagram does not include one — so cross-run
 * dedupe can only happen through the URL check against existing rows. That
 * check holds only if every run elects the same copy. Pick by arrival order
 * and a reshuffle from GDELT would let yesterday's loser in as today's winner.
 *
 * @param {!Array<!Object>} articles
 * @return {!Array<!Object>}
 */
function dedupeArticles_(articles) {
  const seenUrls = new Set();
  const groups = [];
  const byTitle = {};

  articles.forEach(article => {
    const urlKey = normalizeUrl_(article.url);
    if (seenUrls.has(urlKey)) return;
    seenUrls.add(urlKey);

    const key = titleKey_(article.title);
    // An untitled article cannot be grouped; keep it on its own.
    if (!key) {
      groups.push([article]);
      return;
    }
    if (!byTitle[key]) {
      byTitle[key] = [];
      groups.push(byTitle[key]);
    }
    byTitle[key].push(article);
  });

  return groups.map(group => group.sort(compareSyndicated_)[0]);
}

/** Earliest copy wins (closest to the original), then domain for stability. */
function compareSyndicated_(a, b) {
  const aTime = a.date ? a.date.getTime() : Infinity;
  const bTime = b.date ? b.date.getTime() : Infinity;
  if (aTime !== bTime) return aTime - bTime;
  return String(a.source || '').localeCompare(String(b.source || ''));
}

/**
 * Normalizes a headline for syndication matching.
 *
 * Strips punctuation and case entirely, which also absorbs GDELT's habit of
 * spacing out punctuation ("Invests $438 , 000 in Warby Parker Inc .") so it
 * matches a normally-punctuated copy of the same headline elsewhere.
 */
function titleKey_(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strips tracking params so the same story via two links dedupes to one. */
function normalizeUrl_(url) {
  return String(url).trim().replace(/[?&](utm_[^=]+|fbclid|gclid)=[^&]*/gi, '').replace(/[?&]$/, '');
}
