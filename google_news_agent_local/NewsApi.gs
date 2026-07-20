/**
 * NewsApi.gs — news discovery via Event Registry (newsapi.ai).
 *
 * This is the "NewsAPI" provider from the Signals fan-in: real publisher URLs
 * with dates and article body text, merged with Perplexity and deduped by URL
 * in fetchNews_. No Drive / Gmail / LinkedIn — articles only.
 *
 * Endpoint: POST https://eventregistry.org/api/v1/article/getArticles
 * Auth: apiKey in the JSON body (Script Property NEWSAPI_API_KEY).
 */

const NEWSAPI_ENDPOINT_DEFAULT = 'https://eventregistry.org/api/v1/article/getArticles';

/**
 * @param {!Array<{entity: ?string, about: string, q: string}>} queries
 * @return {!Array<!Object>} articles in the shared pipeline shape
 */
function fetchNewsApiNews_(queries) {
  if (!queries.length) return [];

  let key;
  try {
    key = apiKey_('NEWSAPI_API_KEY', CONFIG.NEWSAPI_API_KEY);
  } catch (err) {
    Logger.log(
      'NewsAPI skipped — set Script Property NEWSAPI_API_KEY (Event Registry / newsapi.ai), ' +
      'or remove "newsapi" from CONFIG.NEWS_PROVIDERS.'
    );
    return [];
  }
  const endpoint = String(CONFIG.NEWSAPI_ENDPOINT || NEWSAPI_ENDPOINT_DEFAULT).trim();

  const requests = queries.map(query => ({
    url: endpoint,
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify(newsApiPayload_(query, key)),
  }));

  const responses = fetchAllBatched_(requests, { label: 'NewsAPI' });
  const articles = [];
  const failed = [];

  responses.forEach((response, i) => {
    const query = queries[i];
    const label = query.entity || query.q;
    const results = readNewsApiResponse_(response, label);

    if (results === null) {
      failed.push(label);
      return;
    }

    results
      .slice(0, CONFIG.MAX_ARTICLES_PER_QUERY)
      .forEach(item => {
        const article = articleFromNewsApi_(item, query);
        if (article) articles.push(article);
      });
  });

  if (failed.length) {
    Logger.log(
      `WARNING: ${failed.length}/${queries.length} NewsAPI queries FAILED (not empty — ` +
      `never answered): ${failed.join(', ')}. Those entities are missing from this provider.`
    );
  }

  return dedupeArticles_(articles);
}

/**
 * Event Registry getArticles body. dateStart enforces LOOKBACK_DAYS at the
 * API so we do not over-fetch then discard.
 */
function newsApiPayload_(query, apiKey) {
  const lookback = CONFIG.LOOKBACK_DAYS || 7;
  const start = new Date(Date.now() - lookback * 86400000);
  const dateStart = start.toISOString().slice(0, 10);

  const payload = {
    action: 'getArticles',
    keyword: newsApiKeyword_(query),
    keywordOper: 'and',
    keywordSearchMode: 'phrase',
    keywordsLoc: CONFIG.NEWSAPI_KEYWORDS_LOC || 'body',
    lang: CONFIG.NEWSAPI_LANG || 'eng',
    articlesPage: 1,
    articlesCount: Math.min(
      Math.max(CONFIG.MAX_ARTICLES_PER_QUERY || 5, CONFIG.NEWSAPI_MAX_RESULTS || 10),
      100
    ),
    articlesSortBy: 'date',
    articlesSortByAsc: false,
    dateStart: dateStart,
    isDuplicateFilter: 'skipDuplicates',
    includeArticleBody: true,
    resultType: 'articles',
    apiKey: apiKey,
  };

  return payload;
}

/** Prefer the entity name; fall back to the raw query string. */
function newsApiKeyword_(query) {
  return String(query.entity || query.q || '').trim();
}

/**
 * @return {?Array<!Object>} article objects, or null if the call FAILED.
 *   Empty array means NewsAPI answered and had nothing.
 */
function readNewsApiResponse_(response, label) {
  if (!response) return null;

  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code === 401 || code === 403) {
    Logger.log(`NewsAPI rejected the key (${code}) for "${label}": ${text.slice(0, 200)}`);
    return null;
  }
  if (code === 429) {
    Logger.log(`NewsAPI rate limit (429) for "${label}". Lower FETCH_BATCH_SIZE or add pacing.`);
    return null;
  }
  if (code !== 200) {
    Logger.log(`NewsAPI ${code} for "${label}": ${text.slice(0, 300)}`);
    return null;
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    Logger.log(`NewsAPI returned non-JSON for "${label}": ${text.slice(0, 200)}`);
    return null;
  }

  // Event Registry error payloads sometimes still HTTP 200.
  if (body.error || body.message === 'Invalid API key') {
    Logger.log(`NewsAPI error for "${label}": ${JSON.stringify(body).slice(0, 300)}`);
    return null;
  }

  const results = (body.articles && body.articles.results) || body.articles || [];
  return Array.isArray(results) ? results : [];
}

/**
 * Maps an Event Registry article onto the shared pipeline shape.
 * `body` becomes `snippet` so thin/missing scrapes can still summarize.
 */
function articleFromNewsApi_(item, query) {
  if (!item) return null;
  const url = String(item.url || '').trim();
  const title = String(item.title || '').trim();
  if (!url || !title) return null;

  const sourceName = item.source && (item.source.title || item.source.uri);
  const date = parseNewsApiDate_(item.date, item.time);

  return {
    entity: query.entity,
    about: query.about || '',
    query: query.q,
    title: title,
    source: sourceName ? String(sourceName).trim() : domainOf_(url),
    url: url,
    date: date,
    snippet: String(item.body || item.snippet || '').trim(),
  };
}

/** Event Registry dates are YYYY-MM-DD; optional HH:MM:SS time. */
function parseNewsApiDate_(datePart, timePart) {
  if (!datePart) return null;
  const day = String(datePart).trim();
  const ymd = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!ymd) {
    const fallback = new Date(day);
    return isNaN(fallback.getTime()) ? null : fallback;
  }

  let hh = 0, mm = 0, ss = 0;
  const tod = String(timePart || '').trim().match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (tod) {
    hh = parseInt(tod[1], 10);
    mm = parseInt(tod[2], 10);
    ss = parseInt(tod[3] || '0', 10);
  }

  return new Date(Date.UTC(
    parseInt(ymd[1], 10),
    parseInt(ymd[2], 10) - 1,
    parseInt(ymd[3], 10),
    hh, mm, ss
  ));
}

/**
 * Verifies the NewsAPI key with one live lookup — no Gemini, no sheet writes.
 */
function checkNewsApi() {
  const key = apiKey_('NEWSAPI_API_KEY', CONFIG.NEWSAPI_API_KEY);
  Logger.log(`NewsAPI key loaded (${key.length} chars). Running one live lookup...\n`);

  const query = { entity: 'Alation', about: 'data catalog software', q: 'Alation' };
  const endpoint = String(CONFIG.NEWSAPI_ENDPOINT || NEWSAPI_ENDPOINT_DEFAULT).trim();
  Logger.log(`Keyword: "${newsApiKeyword_(query)}" → ${endpoint}`);

  const response = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify(newsApiPayload_(query, key)),
  });

  const results = readNewsApiResponse_(response, 'Alation');
  if (results === null) {
    Logger.log('NewsAPI check FAILED. Fix NEWSAPI_API_KEY (Event Registry / newsapi.ai).');
    return;
  }

  Logger.log(`NewsAPI answered: ${results.length} article(s).`);
  results.slice(0, 5).forEach((item, i) => {
    const article = articleFromNewsApi_(item, query);
    if (!article) return;
    Logger.log(
      `  ${i + 1}. ${article.title}\n` +
      `     ${article.source} | ${article.date ? article.date.toISOString().slice(0, 10) : 'undated'}\n` +
      `     ${article.url}`
    );
  });
  Logger.log('\nNewsAPI key is good.');
}
