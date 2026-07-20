/**
 * Perplexity.gs — news discovery via the Perplexity Search API.
 *
 * POST https://api.perplexity.ai/search returns ranked web results as
 * { title, url, snippet, date }. Three things make it the right primary source
 * here, each of which was a real failure of something we tried before:
 *
 *   - Real publisher URLs. Google News RSS returns opaque redirectors that only
 *     resolve in a JS browser; Gemini grounding returns expiring redirect links.
 *   - Authenticated, so limits are per-key. GDELT rate-limits by IP, and Apps
 *     Script shares Google's IP pool with every other script on the platform —
 *     which is why GDELT answers 429 on the first request and then stops
 *     answering at all.
 *   - `snippet` IS the page content (up to ~4k tokens). That usually removes
 *     the scrape entirely, and with it the paywalls and consent walls that
 *     silently reduced summaries to headline rephrases.
 *
 * Because requests are independent and per-key, they parallelize via fetchAll.
 * Do not add pacing here — that was a GDELT constraint and does not apply.
 */

const PERPLEXITY_ENDPOINT = 'https://api.perplexity.ai/search';

/**
 * @param {!Array<{entity: ?string, about: string, q: string}>} queries
 * @return {!Array<!Object>} articles in the shared pipeline shape
 */
function fetchPerplexityNews_(queries) {
  if (!queries.length) return [];

  const key = apiKey_('PERPLEXITY_API_KEY', CONFIG.PERPLEXITY_API_KEY);

  const requests = queries.map(query => ({
    url: PERPLEXITY_ENDPOINT,
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    muteHttpExceptions: true,
    payload: JSON.stringify(perplexityPayload_(query)),
  }));

  const responses = fetchAllBatched_(requests, { label: 'Perplexity' });
  const articles = [];
  const failed = [];

  responses.forEach((response, i) => {
    const query = queries[i];
    const label = query.entity || query.q;

    const results = readPerplexityResponse_(response, label);

    // null means the call failed. Never let that read as "no news" — that is
    // how an outage disguises itself as a quiet day.
    if (results === null) {
      failed.push(label);
      return;
    }

    recentOnly_(results, label)
      .slice(0, CONFIG.MAX_ARTICLES_PER_QUERY)
      .forEach(result => {
        const article = articleFromPerplexity_(result, query);
        if (article) articles.push(article);
      });
  });

  if (failed.length) {
    Logger.log(
      `WARNING: ${failed.length}/${queries.length} Perplexity searches FAILED (not empty — ` +
      `never answered): ${failed.join(', ')}. Those entities are missing from this run.`
    );
  }

  return dedupeArticles_(articles);
}

/**
 * The Search API has no recency parameter, so the query carries the intent and
 * recentOnly_ enforces the window against each result's date.
 */
function perplexityPayload_(query) {
  const payload = {
    query: perplexityQueryText_(query),
    // Ask for the maximum, because recentOnly_ discards anything outside the
    // lookback window and we would rather over-fetch than come back empty.
    max_results: Math.max(CONFIG.MAX_ARTICLES_PER_QUERY, CONFIG.PERPLEXITY_MAX_RESULTS || 10),
    // How much page text comes back in `snippet`. 'high' is what lets us skip
    // scraping, which is most of the value here.
    search_context_size: CONFIG.PERPLEXITY_CONTEXT_SIZE || 'high',
  };

  if (CONFIG.PERPLEXITY_LANGUAGES && CONFIG.PERPLEXITY_LANGUAGES.length) {
    payload.search_language_filter = CONFIG.PERPLEXITY_LANGUAGES;
  }
  if (CONFIG.PERPLEXITY_COUNTRY) {
    payload.country = CONFIG.PERPLEXITY_COUNTRY;
  }
  // Allowlist, or denylist with a '-' prefix. Max 20 either way.
  if (CONFIG.PERPLEXITY_DOMAIN_FILTER && CONFIG.PERPLEXITY_DOMAIN_FILTER.length) {
    payload.search_domain_filter = CONFIG.PERPLEXITY_DOMAIN_FILTER.slice(0, 20);
  }

  return payload;
}

/**
 * Perplexity searches like a search engine, not like GDELT's full-text match,
 * so the dossier is worth spending here: "Alation news" is ambiguous, but
 * "Alation data catalog software news" is not. This is why a common-word name
 * ("Away") that GDELT could never isolate is tractable here.
 */
function perplexityQueryText_(query) {
  const parts = [query.entity || query.q];

  if (query.about) {
    // One clause of context, not the whole dossier — a long query drifts.
    parts.push(String(query.about).split(/[.;]/)[0].trim());
  }
  parts.push('news');

  return parts.filter(p => p).join(' ');
}

/**
 * @return {?Array<!Object>} results, or null if the call FAILED. Empty array
 *   means Perplexity answered and had nothing.
 */
function readPerplexityResponse_(response, label) {
  if (!response) return null;

  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code === 401 || code === 403) {
    Logger.log(`Perplexity rejected the key (${code}) for "${label}": ${text.slice(0, 200)}`);
    return null;
  }
  if (code === 429) {
    Logger.log(`Perplexity rate limit (429) for "${label}". Lower FETCH_BATCH_SIZE.`);
    return null;
  }
  if (code !== 200) {
    Logger.log(`Perplexity ${code} for "${label}": ${text.slice(0, 300)}`);
    return null;
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    Logger.log(`Perplexity returned non-JSON for "${label}": ${text.slice(0, 200)}`);
    return null;
  }

  return body.results || [];
}

/**
 * Keeps results inside LOOKBACK_DAYS.
 *
 * `date` is nullable. An undated result is KEPT — dropping it would silently
 * lose real news over a missing field, and the dedupe against existing rows
 * stops it being written twice.
 */
function recentOnly_(results, label) {
  const cutoff = Date.now() - CONFIG.LOOKBACK_DAYS * 86400000;
  let undated = 0;

  const kept = results.filter(result => {
    const date = parsePerplexityDate_(result.date || result.last_updated);
    if (!date) { undated++; return true; }
    return date.getTime() >= cutoff;
  });

  if (undated) {
    Logger.log(`"${label}": ${undated} result(s) had no date — kept, but recency is unverified.`);
  }
  return kept;
}

/** Perplexity dates are YYYY-MM-DD (or null). */
function parsePerplexityDate_(raw) {
  if (!raw) return null;
  const text = String(raw).trim();

  const ymd = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) {
    return new Date(Date.UTC(
      parseInt(ymd[1], 10), parseInt(ymd[2], 10) - 1, parseInt(ymd[3], 10)));
  }

  const fallback = new Date(text);
  return isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * Maps a Perplexity result onto the shared article shape.
 *
 * `snippet` rides along as the article body, so Main.gs can skip the scrape.
 */
function articleFromPerplexity_(result, query) {
  if (!result || !result.url || !result.title) return null;

  return {
    entity: query.entity,
    about: query.about || '',
    query: query.q,
    title: String(result.title).trim(),
    // No publisher name is returned, but the domain is the honest Source value
    // and is what GDELT gave us too.
    source: domainOf_(result.url),
    url: String(result.url).trim(),
    date: parsePerplexityDate_(result.date || result.last_updated),
    snippet: String(result.snippet || '').trim(),
  };
}

/** Hostname without protocol or www. */
function domainOf_(url) {
  const match = String(url || '').match(/^https?:\/\/(?:www\.)?([^/:?#]+)/i);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Verifies the Perplexity key and shows what one real search returns —
 * without touching Gemini or the sheet. Run this first.
 */
function checkPerplexity() {
  const key = apiKey_('PERPLEXITY_API_KEY', CONFIG.PERPLEXITY_API_KEY);
  Logger.log(`Key loaded (${key.length} chars). Running one live search...\n`);

  const query = { entity: 'Alation', about: 'data catalog software', q: 'Alation' };
  Logger.log(`Query sent: "${perplexityQueryText_(query)}"`);

  const response = UrlFetchApp.fetch(PERPLEXITY_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    muteHttpExceptions: true,
    payload: JSON.stringify(perplexityPayload_(query)),
  });

  const results = readPerplexityResponse_(response, 'Alation');
  if (results === null) {
    Logger.log('FAILED — see the error above. A 401 means the key is wrong or unfunded.');
    return;
  }

  Logger.log(`${results.length} results.\n`);
  results.slice(0, 5).forEach(result => {
    const snippet = String(result.snippet || '');
    Logger.log(`  ${String(result.title).slice(0, 70)}`);
    Logger.log(`    ${result.url}`);
    Logger.log(`    date: ${result.date || '(none)'} | snippet: ${snippet.length} chars` +
               (snippet.length > CONFIG.SNIPPET_MIN_CHARS ? ' (enough — no scrape needed)'
                                                          : ' (thin — would fall back to scraping)'));
  });

  const usable = results.filter(r => String(r.snippet || '').length > CONFIG.SNIPPET_MIN_CHARS).length;
  Logger.log(`\n${usable}/${results.length} snippets are usable as-is.`);
  Logger.log('Every one of those is a page we never have to fetch, and a paywall we never hit.');
  Logger.log('\nNothing was written and no Gemini calls were made.');
}
