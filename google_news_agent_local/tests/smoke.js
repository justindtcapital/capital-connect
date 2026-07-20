// Smoke test for the pure logic in the Apps Script project.
// Loads the .gs sources into a sandbox with minimal Apps Script stubs.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const PROJECT = path.join(__dirname, '..');

// Script Properties stand-in, so tests can simulate a pasted VERTEX_SA_KEY.
const props = {};

const sandbox = {
  Logger: { log: () => {} },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: k => (props[k] === undefined ? null : props[k]),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; },
      getProperties: () => Object.assign({}, props),
    }),
  },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
  Utilities: {
    sleep: () => {},
    getUuid: () => '00000000-0000-4000-8000-000000000001',
    newBlob: s => ({ getBytes: () => Buffer.from(s, 'utf8') }),
    base64EncodeWebSafe: b => Buffer.from(b).toString('base64url') + '=',
    computeRsaSha256Signature: () => Buffer.from('fake-signature'),
  },
  console,
};
vm.createContext(sandbox);

for (const f of ['Config.gs', 'Fetch.gs', 'Sheets.gs', 'Gemini.gs', 'Auth.gs',
                 'SheetEntities.gs', 'Batch.gs', 'Perplexity.gs', 'NewsApi.gs']) {
  vm.runInContext(fs.readFileSync(path.join(PROJECT, f), 'utf8'), sandbox, { filename: f });
}

/** Minimal Sheet stand-in: a tab is just a 2-D array of cell values. */
function fakeSpreadsheet(tabs) {
  const sheets = Object.keys(tabs).map(name => ({
    getName: () => name,
    getLastRow: () => tabs[name].length,
    getLastColumn: () => (tabs[name][0] || []).length,
    getDataRange: () => ({ getValues: () => tabs[name] }),
    getRange: (r, c, nr, nc) => ({
      getValues: () => tabs[name].slice(r - 1, r - 1 + nr).map(row => row.slice(c - 1, c - 1 + nc)),
    }),
  }));
  return {
    getName: () => 'Test Workbook',
    getSheets: () => sheets,
    getSheetByName: n => sheets.filter(s => s.getName() === n)[0] || null,
  };
}
function useTabs(tabs) {
  sandbox.SpreadsheetApp = { getActiveSpreadsheet: () => fakeSpreadsheet(tabs) };
}

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${e}\n        actual   ${a}`);
}

// ---- gdeltUrl_ / buildGdeltQuery_ ----
const CONFIG = vm.runInContext('CONFIG', sandbox);

function withConfig(overrides, fn) {
  const saved = {};
  Object.keys(overrides).forEach(k => { saved[k] = CONFIG[k]; CONFIG[k] = overrides[k]; });
  try { return fn(); } finally { Object.keys(saved).forEach(k => { CONFIG[k] = saved[k]; }); }
}

// ---- gdeltPhrase_ ----
// Regression guard: GDELT answers `"Nike"` with "The specified phrase is too
// short" and returns NOTHING. Quoting single-word entities silently starved
// every such company of news. Verified against the live API.
check('single-word entity is NOT quoted', sandbox.gdeltPhrase_('Nike'), 'Nike');
check('single-word entity, any length, is not quoted',
  sandbox.gdeltPhrase_('Allbirds'), 'Allbirds');
check('multi-word entity IS quoted (buys phrase adjacency)',
  sandbox.gdeltPhrase_('Warby Parker'), '"Warby Parker"');
check('multi-word entity with punctuation is quoted',
  sandbox.gdeltPhrase_('Procter & Gamble'), '"Procter & Gamble"');
check('topic phrase is quoted',
  sandbox.gdeltPhrase_('direct-to-consumer retail'), '"direct-to-consumer retail"');
check('hyphenated single token is not quoted',
  sandbox.gdeltPhrase_('direct-to-consumer'), 'direct-to-consumer');
check('surrounding whitespace is trimmed', sandbox.gdeltPhrase_('  Nike  '), 'Nike');
check('empty name yields empty', sandbox.gdeltPhrase_(''), '');

// No repository may emit a quoted single word — that is the starvation bug.
// Top-level `const` lands in the vm's lexical scope, not on the global object,
// so read it by evaluating in-context rather than off `sandbox`.
const REPOSITORIES = vm.runInContext('REPOSITORIES', sandbox);
// These assert against the config arrays, so pin the source — otherwise
// buildQueries reads tabs and needs a live spreadsheet.
const allQueries = withConfig({ ENTITY_SOURCE: 'config' },
  () => REPOSITORIES.filter(r => r.wired).flatMap(r => r.buildQueries()));
check('no wired repo emits a quoted single-word query',
  allQueries.filter(q => /^"[^"\s]+"$/.test(q.q)).map(q => q.q), []);
check('every wired repo emits a non-empty query',
  allQueries.every(q => q.q && q.q.trim().length > 0), true);

// ---- gdeltUrl_ ----
const gdeltUrl = sandbox.gdeltUrl_('"Nike"');
check('GDELT URL uses the DOC API',
  gdeltUrl.startsWith('https://api.gdeltproject.org/api/v2/doc/doc?'), true);
check('GDELT URL asks for a JSON article list',
  /mode=artlist/.test(gdeltUrl) && /format=json/.test(gdeltUrl), true);
check('GDELT URL sorts newest first so the cap truncates the tail',
  /sort=datedesc/.test(gdeltUrl), true);
check('GDELT URL carries timespan from LOOKBACK_DAYS',
  gdeltUrl.includes(`timespan=${CONFIG.LOOKBACK_DAYS}d`), true);
check('GDELT URL carries maxrecords from MAX_ARTICLES_PER_QUERY',
  gdeltUrl.includes(`maxrecords=${CONFIG.MAX_ARTICLES_PER_QUERY}`), true);
check('GDELT URL is escaped (quotes do not leak raw)',
  /query=%22Nike%22/.test(gdeltUrl), true);

check('query defaults to english filter',
  withConfig({ GDELT_SOURCE_LANG: 'english', GDELT_SOURCE_COUNTRY: '', GDELT_EXTRA_QUERY: '' },
    () => sandbox.buildGdeltQuery_('"Nike"')),
  '"Nike" sourcelang:english');
check('query appends extra filters and country',
  withConfig({ GDELT_SOURCE_LANG: 'english', GDELT_SOURCE_COUNTRY: 'US',
               GDELT_EXTRA_QUERY: '(earnings OR funding)' },
    () => sandbox.buildGdeltQuery_('"Nike"')),
  '"Nike" sourcelang:english sourcecountry:US (earnings OR funding)');
check('blank filters are omitted entirely',
  withConfig({ GDELT_SOURCE_LANG: '', GDELT_SOURCE_COUNTRY: '', GDELT_EXTRA_QUERY: '' },
    () => sandbox.buildGdeltQuery_('"Nike"')),
  '"Nike"');

// ---- parseGdeltDate_ : compact ISO-8601 basic ----
const d = sandbox.parseGdeltDate_('20260715T141500Z');
check('parseGdeltDate_ compact -> ISO', d && d.toISOString(), '2026-07-15T14:15:00.000Z');
check('parseGdeltDate_ garbage -> null', sandbox.parseGdeltDate_('not a date'), null);
check('parseGdeltDate_ empty -> null', sandbox.parseGdeltDate_(''), null);

// ---- parseGdeltBody_ : real shapes, including the non-JSON rejection ----
const gdeltJson = JSON.stringify({
  articles: [
    { url: 'https://www.reuters.com/business/nike-q3',
      title: 'Nike beats Q3 estimates', domain: 'reuters.com',
      seendate: '20260715T141500Z', language: 'English' },
    { url: 'https://www.ft.com/content/abc',
      title: 'Nike expands DTC', domain: 'ft.com', seendate: '20260714T090000Z' },
  ],
});
check('parseGdeltBody_ reads articles', sandbox.parseGdeltBody_(gdeltJson, 'q').length, 2);
check('parseGdeltBody_ empty result set', sandbox.parseGdeltBody_('{}', 'q'), []);
check('parseGdeltBody_ blank body', sandbox.parseGdeltBody_('', 'q'), []);
// GDELT answers 200 + plain text when it rejects a query — must not throw.
check('parseGdeltBody_ survives a plain-text rejection',
  sandbox.parseGdeltBody_('Your query was too short.', 'q'), []);
check('parseGdeltBody_ survives malformed JSON',
  sandbox.parseGdeltBody_('{"articles":[', 'q'), []);

// ---- articleFromGdeltItem_ ----
const items = JSON.parse(gdeltJson).articles;
const entityArticle = sandbox.articleFromGdeltItem_(items[0], { entity: 'Nike', q: '"Nike"' });
check('article maps url/title/domain/date',
  [entityArticle.url, entityArticle.title, entityArticle.source,
   entityArticle.date.toISOString()],
  ['https://www.reuters.com/business/nike-q3', 'Nike beats Q3 estimates',
   'reuters.com', '2026-07-15T14:15:00.000Z']);
check('article carries entity', entityArticle.entity, 'Nike');
check('article carries query for topic-repo relevance', entityArticle.query, '"Nike"');

const topicArticle = sandbox.articleFromGdeltItem_(items[1], { entity: null, q: 'dtc retail' });
check('topic article has null entity and keeps query',
  [topicArticle.entity, topicArticle.query], [null, 'dtc retail']);

check('article drops items with no url',
  sandbox.articleFromGdeltItem_({ title: 'x' }, { entity: null, q: 'q' }), null);
check('article drops items with no title',
  sandbox.articleFromGdeltItem_({ url: 'https://x.com' }, { entity: null, q: 'q' }), null);
check('article tolerates a missing domain',
  sandbox.articleFromGdeltItem_({ url: 'https://x.com/a', title: 'T' },
    { entity: null, q: 'q' }).source, '');

// ---- Perplexity : the primary news source ----
props.PERPLEXITY_API_KEY = 'pplx-test';

const PPLX_OK = JSON.stringify({
  results: [
    { title: 'Alation raises $50M', url: 'https://techcrunch.com/alation-50m',
      snippet: 'x'.repeat(2000), date: '2026-07-14' },
    { title: 'Old news', url: 'https://reuters.com/old',
      snippet: 'y'.repeat(2000), date: '2020-01-01' },
    { title: 'Undated piece', url: 'https://ft.com/undated',
      snippet: 'z'.repeat(2000), date: null },
  ],
});

check('parses a Perplexity result set',
  sandbox.readPerplexityResponse_(resp(200, PPLX_OK), 'Alation').length, 3);
check('an empty result set is [] (answered, nothing found)',
  sandbox.readPerplexityResponse_(resp(200, '{"results":[]}'), 'x'), []);

// Failure must be distinguishable from empty, or an outage reads as "no news".
check('401 (bad key) returns null, not []',
  sandbox.readPerplexityResponse_(resp(401, '{"error":"unauthorized"}'), 'x'), null);
check('429 returns null, not []', sandbox.readPerplexityResponse_(resp(429, 'slow'), 'x'), null);
check('500 returns null, not []', sandbox.readPerplexityResponse_(resp(500, 'boom'), 'x'), null);
check('non-JSON returns null, not []',
  sandbox.readPerplexityResponse_(resp(200, '<html>'), 'x'), null);
check('a dead request returns null', sandbox.readPerplexityResponse_(null, 'x'), null);

// ---- date handling ----
check('parses YYYY-MM-DD',
  sandbox.parsePerplexityDate_('2026-07-14').toISOString(), '2026-07-14T00:00:00.000Z');
check('null date -> null', sandbox.parsePerplexityDate_(null), null);
check('garbage date -> null', sandbox.parsePerplexityDate_('sometime'), null);

// The Search API has no recency parameter, so the window is enforced locally.
const results = JSON.parse(PPLX_OK).results;
const recent = withConfig({ LOOKBACK_DAYS: 7 }, () => sandbox.recentOnly_(results, 'Alation'));
check('drops results older than LOOKBACK_DAYS',
  recent.filter(r => r.title === 'Old news').length, 0);
check('keeps recent results', recent.filter(r => r.title === 'Alation raises $50M').length, 1);
// Fail open: dropping an undated result would silently lose real news.
check('keeps undated results rather than losing them',
  recent.filter(r => r.title === 'Undated piece').length, 1);

// ---- article mapping ----
const pplxArticle = sandbox.articleFromPerplexity_(results[0],
  { entity: 'Alation', about: 'data catalog software', q: 'Alation' });
check('maps url/title/date and derives the source domain',
  [pplxArticle.url, pplxArticle.title, pplxArticle.source,
   pplxArticle.date.toISOString().slice(0, 10)],
  ['https://techcrunch.com/alation-50m', 'Alation raises $50M', 'techcrunch.com', '2026-07-14']);
check('carries the snippet through as the article body',
  pplxArticle.snippet.length, 2000);
check('carries entity and dossier', [pplxArticle.entity, pplxArticle.about],
  ['Alation', 'data catalog software']);
check('drops results with no url',
  sandbox.articleFromPerplexity_({ title: 'x' }, { entity: null, q: 'q' }), null);

check('domainOf_ strips protocol and www',
  [sandbox.domainOf_('https://www.reuters.com/a/b'), sandbox.domainOf_('http://ft.com/x'),
   sandbox.domainOf_('garbage')],
  ['reuters.com', 'ft.com', '']);

// ---- query text : the dossier disambiguates, which is why "Away" works here ----
check('query pairs the name with one clause of dossier',
  sandbox.perplexityQueryText_({ entity: 'Away', about: 'DTC luggage brand, NYC. Founded 2015.',
                                 q: 'Away' }),
  'Away DTC luggage brand, NYC news');
check('query without a dossier is bare',
  sandbox.perplexityQueryText_({ entity: 'Nike', about: '', q: 'Nike' }), 'Nike news');
check('topic query falls back to q',
  sandbox.perplexityQueryText_({ entity: null, about: '', q: 'dtc retail' }), 'dtc retail news');

// ---- payload ----
const pplxPayload = withConfig(
  { PERPLEXITY_CONTEXT_SIZE: 'high', PERPLEXITY_MAX_RESULTS: 20, MAX_ARTICLES_PER_QUERY: 10,
    PERPLEXITY_LANGUAGES: ['en'], PERPLEXITY_COUNTRY: '', PERPLEXITY_DOMAIN_FILTER: [] },
  () => sandbox.perplexityPayload_({ entity: 'Alation', about: '', q: 'Alation' }));
check('payload asks for high context (this is what removes the scrape)',
  pplxPayload.search_context_size, 'high');
check('payload over-fetches, because recency is filtered locally',
  pplxPayload.max_results, 20);
check('payload sets the language filter', pplxPayload.search_language_filter, ['en']);
check('blank country/domain filters are omitted entirely',
  [pplxPayload.country, pplxPayload.search_domain_filter], [undefined, undefined]);
check('domain filter is capped at the API limit of 20',
  withConfig({ PERPLEXITY_DOMAIN_FILTER: Array.from({ length: 30 }, (_, i) => '-spam' + i + '.com') },
    () => sandbox.perplexityPayload_({ entity: 'x', about: '', q: 'x' })).search_domain_filter.length,
  20);

// ---- articleTexts_ : snippet first, scrape only what needs it ----
const mixed = [
  { url: 'https://a.com/1', snippet: 'x'.repeat(1000) },   // usable
  { url: 'https://b.com/2', snippet: 'short' },            // thin -> scrape
  { url: 'https://c.com/3', snippet: '' },                 // none -> scrape
];
sandbox.UrlFetchApp = {
  fetchAll: reqs => reqs.map(() => resp(200, '<p>' + 'scraped '.repeat(100) + '</p>')),
};
const texts = withConfig({ SNIPPET_MIN_CHARS: 400, ARTICLE_TEXT_LIMIT: 6000, FETCH_BATCH_SIZE: 20 },
  () => sandbox.articleTexts_(mixed));
check('a usable snippet is used verbatim, with no fetch', texts[0].length, 1000);
check('a thin snippet falls back to scraping', /scraped/.test(texts[1]), true);
check('a missing snippet falls back to scraping', /scraped/.test(texts[2]), true);
check('texts stay index-aligned with articles', texts.length, 3);

// A long snippet must still respect the token budget.
check('snippet is truncated to ARTICLE_TEXT_LIMIT',
  withConfig({ SNIPPET_MIN_CHARS: 400, ARTICLE_TEXT_LIMIT: 500 },
    () => sandbox.articleTexts_([{ url: 'https://a.com', snippet: 'x'.repeat(9000) }]))[0].length,
  500);

// ---- isScrapableUrl_ / binary skip ----
// A hung PDF once wiped an entire fetchAll batch of 20. Skip these before scrape.
check('HTML article URL is scrapable',
  sandbox.isScrapableUrl_('https://techcrunch.com/2026/01/01/story'), true);
check('PDF URL is not scrapable',
  sandbox.isScrapableUrl_('https://example.com/report.pdf'), false);
check('PDF with query string is not scrapable',
  sandbox.isScrapableUrl_('https://example.com/report.pdf?download=1'), false);
check('IR static-files path is not scrapable',
  sandbox.isScrapableUrl_('https://investors.xometry.com/static-files/a03bf7fb-ba2f-4d96-931a-4af25ddb37b4'), false);
check('docx is not scrapable',
  sandbox.isScrapableUrl_('https://example.com/deck.docx'), false);

let pdfFetchCalls = 0;
sandbox.UrlFetchApp = {
  fetchAll: () => { pdfFetchCalls++; return []; },
  fetch: () => { pdfFetchCalls++; return resp(200, 'should not fetch'); },
};
const pdfTexts = withConfig({ SNIPPET_MIN_CHARS: 400, ARTICLE_TEXT_LIMIT: 6000, FETCH_BATCH_SIZE: 8 },
  () => sandbox.articleTexts_([
    { url: 'https://investors.xometry.com/static-files/abc', snippet: 'short' },
    { url: 'https://ok.com/story', snippet: 'x'.repeat(1000) },
  ]));
check('non-HTML URL is not scraped', pdfTexts[0], '');
check('sibling with a usable snippet is untouched', pdfTexts[1].length, 1000);
check('skipping binary does not call UrlFetchApp', pdfFetchCalls, 0);

// ---- fetchAllBatched_ : one timeout must not null the whole chunk ----
let soloFetches = 0;
sandbox.UrlFetchApp = {
  fetchAll: () => { throw new Error('Timeout: https://bad.example/static-files/x'); },
  fetch: (url) => {
    soloFetches++;
    return resp(200, '<p>' + ('solo' + soloFetches + ' ').repeat(50) + '</p>');
  },
};
const recovered = withConfig(
  { SNIPPET_MIN_CHARS: 400, ARTICLE_TEXT_LIMIT: 6000, FETCH_BATCH_SIZE: 8, FETCH_BATCH_PAUSE_MS: 0 },
  () => sandbox.articleTexts_([
    { url: 'https://a.com/1', snippet: 'thin' },
    { url: 'https://b.com/2', snippet: 'thin' },
  ]));
check('timed-out batch retries one-at-a-time', soloFetches, 2);
check('one-at-a-time retry still yields scraped text', /solo1/.test(recovered[0]), true);
check('second URL also recovers after batch timeout', /solo2/.test(recovered[1]), true);

// ---- fetchNews_ routes by NEWS_PROVIDERS / NEWS_SOURCE ----
let badSource = false;
try {
  withConfig({ NEWS_PROVIDERS: [], NEWS_SOURCE: 'bing' }, () => sandbox.fetchNews_([{ q: 'x' }]));
} catch (e) { badSource = /Expected 'perplexity', 'newsapi', or 'gdelt'/.test(e.message); }
check('an unknown NEWS_SOURCE fails loudly', badSource, true);

sandbox.UrlFetchApp = { fetchAll: reqs => reqs.map(() => resp(200, PPLX_OK)) };
check('NEWS_SOURCE perplexity routes to the Perplexity API',
  withConfig({ NEWS_PROVIDERS: [], NEWS_SOURCE: 'perplexity', LOOKBACK_DAYS: 7, MAX_ARTICLES_PER_QUERY: 10 },
    () => sandbox.fetchNews_([{ entity: 'Alation', about: '', q: 'Alation' }]))
    .map(a => a.source),
  ['techcrunch.com', 'ft.com']);

const NEWSAPI_OK = JSON.stringify({
  articles: {
    results: [
      {
        url: 'https://reuters.com/a',
        title: 'Alation raises funding',
        body: 'Alation announced a new round. '.repeat(20),
        date: '2026-07-15',
        time: '14:30:00',
        source: { title: 'Reuters' },
      },
      {
        url: 'https://techcrunch.com/alation-50m',
        title: 'Same story elsewhere',
        body: 'dup',
        date: '2026-07-14',
        source: { title: 'TechCrunch' },
      },
    ],
  },
});

check('NewsAPI maps body into snippet and keeps publisher',
  sandbox.articleFromNewsApi_({
    url: 'https://reuters.com/a', title: 'T', body: 'hello body',
    date: '2026-07-15', time: '12:00:00', source: { title: 'Reuters' },
  }, { entity: 'Alation', about: '', q: 'Alation' }),
  {
    entity: 'Alation', about: '', query: 'Alation', title: 'T',
    source: 'Reuters', url: 'https://reuters.com/a',
    date: new Date(Date.UTC(2026, 6, 15, 12, 0, 0)),
    snippet: 'hello body',
  });

check('NewsAPI 401 returns null, not []',
  sandbox.readNewsApiResponse_(resp(401, 'bad key'), 'x'), null);
check('NewsAPI empty results are [] (answered)',
  sandbox.readNewsApiResponse_(resp(200, '{"articles":{"results":[]}}'), 'x'), []);

sandbox.UrlFetchApp = {
  fetchAll: reqs => reqs.map(r => {
    // Perplexity endpoint vs NewsAPI endpoint
    if (/perplexity/i.test(r.url)) return resp(200, PPLX_OK);
    return resp(200, NEWSAPI_OK);
  }),
};
const merged = withConfig(
  { NEWS_PROVIDERS: ['perplexity', 'newsapi'], LOOKBACK_DAYS: 30, MAX_ARTICLES_PER_QUERY: 10,
    PERPLEXITY_API_KEY: 'p', NEWSAPI_API_KEY: 'n' },
  () => sandbox.fetchNews_([{ entity: 'Alation', about: '', q: 'Alation' }]));
check('perplexity + newsapi merge dedupes by URL',
  merged.filter(a => /techcrunch\.com\/alation-50m/.test(a.url)).length, 1);
check('merge keeps NewsAPI-only URLs',
  merged.some(a => a.url === 'https://reuters.com/a'), true);
check('newsProviders_ reads NEWS_PROVIDERS',
  withConfig({ NEWS_PROVIDERS: ['newsapi', 'perplexity'] }, () => sandbox.newsProviders_()),
  ['newsapi', 'perplexity']);
check('newsProviders_ falls back to NEWS_SOURCE',
  withConfig({ NEWS_PROVIDERS: [], NEWS_SOURCE: 'gdelt' }, () => sandbox.newsProviders_()),
  ['gdelt']);

// ---- fetchGdeltQuery_ : failure must be distinguishable from empty ----
// Collapsing both to [] makes a throttled query read as "no news today", so an
// outage looks like silence and the run reports +0 as if all were well.
function stubFetch(responses) {
  let i = 0;
  sandbox.UrlFetchApp = { fetch: () => responses[Math.min(i++, responses.length - 1)] };
}
function resp(code, text) {
  return { getResponseCode: () => code, getContentText: () => text };
}

stubFetch([resp(200, '{"articles":[{"url":"https://x.com/a","title":"T","domain":"x.com"}]}')]);
check('successful query returns items', sandbox.fetchGdeltQuery_('Nike').length, 1);

stubFetch([resp(200, '{"articles":[]}')]);
check('genuinely empty result is [] not null', sandbox.fetchGdeltQuery_('Nike'), []);

stubFetch([resp(429, 'rate limited')]);
check('exhausted retries return null, NOT []', sandbox.fetchGdeltQuery_('Nike'), null);

// GDELT also throttles via 200 + plain text, which must not parse as "empty".
stubFetch([resp(200, 'Please limit requests to one every 5 seconds or contact kalev')]);
check('200-with-throttle-text returns null, not []', sandbox.fetchGdeltQuery_('Nike'), null);

stubFetch([resp(500, 'boom')]);
check('server error returns null', sandbox.fetchGdeltQuery_('Nike'), null);

// A rejected query IS an answer — GDELT had nothing to say, so [] is right.
stubFetch([resp(200, 'The specified phrase is too short.')]);
check('rejected query returns [] (GDELT answered)', sandbox.fetchGdeltQuery_('"Nike"'), []);

// Retry then succeed.
stubFetch([resp(429, 'slow down'),
           resp(200, '{"articles":[{"url":"https://x.com/a","title":"T","domain":"x.com"}]}')]);
check('a throttled query recovers on retry', sandbox.fetchGdeltQuery_('Nike').length, 1);

// ---- fetchGdeltNews_ : a failed query must not silently vanish ----
const logged = [];
sandbox.Logger = { log: m => logged.push(String(m)) };
stubFetch([resp(429, 'rate limited')]);
check('gdelt returns nothing when every query fails',
  withConfig({ NEWS_PROVIDERS: ['gdelt'], NEWS_SOURCE: 'gdelt' },
    () => sandbox.fetchNews_([{ entity: 'Nike', about: '', q: 'Nike' }])), []);
check('gdelt shouts about failed queries rather than reporting no news',
  logged.some(m => /FAILED \(not empty/.test(m) && /Nike/.test(m)), true);

logged.length = 0;
stubFetch([resp(200, '{"articles":[]}')]);
withConfig({ NEWS_PROVIDERS: ['gdelt'], NEWS_SOURCE: 'gdelt' },
  () => sandbox.fetchNews_([{ entity: 'Nike', about: '', q: 'Nike' }]));
check('a genuinely empty gdelt query does NOT warn',
  logged.some(m => /FAILED/.test(m)), false);

// Same contract on the Perplexity path: a dead key must not read as "no news".
logged.length = 0;
sandbox.UrlFetchApp = { fetchAll: reqs => reqs.map(() => resp(401, '{"error":"bad key"}')) };
check('perplexity returns nothing when the key is rejected',
  withConfig({ NEWS_PROVIDERS: ['perplexity'], NEWS_SOURCE: 'perplexity', PERPLEXITY_API_KEY: 'x' },
    () => sandbox.fetchNews_([{ entity: 'Nike', about: '', q: 'Nike' }])), []);
check('perplexity shouts about failed searches rather than reporting no news',
  logged.some(m => /FAILED \(not empty/.test(m) && /Nike/.test(m)), true);

logged.length = 0;
sandbox.UrlFetchApp = { fetchAll: reqs => reqs.map(() => resp(200, '{"results":[]}')) };
withConfig({ NEWS_PROVIDERS: ['perplexity'], NEWS_SOURCE: 'perplexity', PERPLEXITY_API_KEY: 'x' },
  () => sandbox.fetchNews_([{ entity: 'Nike', about: '', q: 'Nike' }]));
check('a genuinely empty perplexity search does NOT warn',
  logged.some(m => /FAILED/.test(m)), false);

sandbox.Logger = { log: () => {} };

// ---- nextBatch_ : slicing 81 entities across runs without losing any ----
// The whole point is coverage: a cursor bug means some company is never
// searched, silently, forever.
const NAMES = [];
for (let i = 1; i <= 81; i++) NAMES.push('co' + i);

function clearCursors() {
  Object.keys(props).forEach(k => { if (k.indexOf('batch_cursor_') === 0) delete props[k]; });
}

clearCursors();
check('first run takes the first slice',
  withConfig({ BATCH_SIZE: 12 }, () => sandbox.nextBatch_('run', 'T', NAMES)),
  NAMES.slice(0, 12));
check('second run continues where the first stopped',
  withConfig({ BATCH_SIZE: 12 }, () => sandbox.nextBatch_('run', 'T', NAMES)),
  NAMES.slice(12, 24));

// Walk a whole pass and prove every entity is visited exactly once.
clearCursors();
const visits = {};
const runsPerPass = Math.ceil(81 / 12);
for (let r = 0; r < runsPerPass; r++) {
  withConfig({ BATCH_SIZE: 12 }, () => sandbox.nextBatch_('run', 'T', NAMES))
    .forEach(n => { visits[n] = (visits[n] || 0) + 1; });
}
check('a full pass visits every entity',
  NAMES.filter(n => !visits[n]), []);
check('a full pass visits none more than twice (81 does not divide by 12)',
  NAMES.filter(n => visits[n] > 2), []);

// Wraparound: the last slice must run off the end and back to the start.
clearCursors();
props['batch_cursor_run_T'] = '76';
check('the final slice wraps to the top of the list',
  withConfig({ BATCH_SIZE: 12 }, () => sandbox.nextBatch_('run', 'T', NAMES)),
  ['co77', 'co78', 'co79', 'co80', 'co81', 'co1', 'co2', 'co3', 'co4', 'co5', 'co6', 'co7']);

// Namespaces must not share a position, or previewing would move the real run.
clearCursors();
withConfig({ BATCH_SIZE: 12 }, () => sandbox.nextBatch_('preview', 'T', NAMES));
check('preview does not advance the run cursor',
  withConfig({ BATCH_SIZE: 12 }, () => sandbox.nextBatch_('run', 'T', NAMES)),
  NAMES.slice(0, 12));

// Repositories must not share a position either.
clearCursors();
withConfig({ BATCH_SIZE: 12 }, () => sandbox.nextBatch_('run', 'A', NAMES));
check('each repository tracks its own position',
  withConfig({ BATCH_SIZE: 12 }, () => sandbox.nextBatch_('run', 'B', NAMES)),
  NAMES.slice(0, 12));

clearCursors();
check('BATCH_SIZE 0 disables batching',
  withConfig({ BATCH_SIZE: 0 }, () => sandbox.nextBatch_('run', 'T', NAMES)).length, 81);
check('a list shorter than the batch is returned whole',
  withConfig({ BATCH_SIZE: 12 }, () => sandbox.nextBatch_('run', 'T', NAMES.slice(0, 5))).length, 5);
check('no cursor is stored for an unbatched list',
  props['batch_cursor_run_T'], undefined);

// A cursor left over from a longer list must not index off the end.
clearCursors();
props['batch_cursor_run_T'] = '400';
check('a stale cursor past the end is wrapped, not fatal',
  withConfig({ BATCH_SIZE: 12 }, () => sandbox.nextBatch_('run', 'T', NAMES)).length, 12);
clearCursors();
props['batch_cursor_run_T'] = 'garbage';
check('a corrupt cursor falls back to the start',
  withConfig({ BATCH_SIZE: 12 }, () => sandbox.nextBatch_('run', 'T', NAMES)),
  NAMES.slice(0, 12));

// resetBatchCursors must clear cursors and nothing else.
clearCursors();
props['batch_cursor_run_T'] = '24';
props.VERTEX_SA_KEY = 'do-not-touch';
sandbox.resetBatchCursors();
check('reset clears the cursor', props['batch_cursor_run_T'], undefined);
check('reset leaves other script properties alone', props.VERTEX_SA_KEY, 'do-not-touch');
delete props.VERTEX_SA_KEY;

// ---- normalizeHeader_ : header matching must survive real spelling ----
check('header match ignores case', sandbox.normalizeHeader_('COMPANYS'), 'companys');
check("header match ignores an apostrophe (Company's == Companys)",
  sandbox.normalizeHeader_("Company's"), sandbox.normalizeHeader_('Companys'));
check('header match ignores surrounding space',
  sandbox.normalizeHeader_('  Company  '), 'company');
check('header match ignores inner space',
  sandbox.normalizeHeader_('Port Co'), 'portco');
check('header match on a blank cell', sandbox.normalizeHeader_(''), '');

// ---- readEntityTab_ : reading entity lists out of tabs ----
const PORTCO_TAB = [
  ['Company', 'About', 'Owner'],
  ['Away', 'DTC luggage brand, NYC', 'jd'],
  ['Brightwheel', 'childcare software', 'ml'],
];
useTabs({ 'Port Co': PORTCO_TAB });

check('reads names and dossiers from a tab',
  sandbox.readEntityTab_({ tab: 'Port Co', nameHeader: 'Company', aboutHeader: 'About' }, 'PORTCOS'),
  [{ name: 'Away', about: 'DTC luggage brand, NYC' },
   { name: 'Brightwheel', about: 'childcare software' }]);

// Columns are found by header, so reordering them must not break anything.
useTabs({ 'Port Co': [
  ['Owner', 'About', 'Company'],
  ['jd', 'DTC luggage brand, NYC', 'Away'],
] });
check('column order does not matter — matched by header',
  sandbox.readEntityTab_({ tab: 'Port Co', nameHeader: 'Company', aboutHeader: 'About' }, 'PORTCOS'),
  [{ name: 'Away', about: 'DTC luggage brand, NYC' }]);

// The reported header spelling ("Companys") must match despite punctuation.
useTabs({ Contacts: [["Company's", 'Notes'], ['Acme Corp', 'x'], ['Globex', 'y']] });
check('nameHeader "Companys" matches a "Company\'s" column',
  sandbox.readEntityTab_({ tab: 'Contacts', nameHeader: 'Companys', aboutHeader: '' }, 'DTC')
    .map(e => e.name),
  ['Acme Corp', 'Globex']);

// Real sheets are messy.
useTabs({ Contacts: [
  ['Companys'],
  ['  Acme Corp  '],   // padded
  [''],                // blank spacer row
  ['Globex'],
  ['acme corp'],       // same company, different case
  [null],              // truly empty cell
] });
const messy = sandbox.readEntityTab_({ tab: 'Contacts', nameHeader: 'Companys', aboutHeader: '' }, 'DTC');
check('trims names, skips blanks, dedupes case-insensitively',
  messy.map(e => e.name), ['Acme Corp', 'Globex']);

// A header row further down the tab.
useTabs({ Targeting: [
  ['Q3 target list', ''],
  ['', ''],
  ['Companys', 'About'],
  ['Acme Corp', 'industrial robots'],
] });
check('headerRow can be below row 1',
  sandbox.readEntityTab_({ tab: 'Targeting', nameHeader: 'Companys', aboutHeader: 'About', headerRow: 3 }, 'MAJOR'),
  [{ name: 'Acme Corp', about: 'industrial robots' }]);

// A missing about column warns but must not fail the run.
useTabs({ Contacts: [['Companys'], ['Acme Corp']] });
check('missing about column degrades to empty dossiers',
  sandbox.readEntityTab_({ tab: 'Contacts', nameHeader: 'Companys', aboutHeader: 'About' }, 'DTC'),
  [{ name: 'Acme Corp', about: '' }]);

// ---- multi-column dossiers : real sheets spread context across columns ----
// Modelled on the actual tab: Company Name / Website / Focus Area(s) / HQ /
// Summary / URID, with trailing unnamed columns.
useTabs({ 'Portfolio Companies': [
  ['Company Name', 'Website', 'Focus Area(s)', 'HQ', 'Summary', 'URID', '', ''],
  ['Aidaptive', 'a.com', 'AI personalization', 'Palo Alto', 'ML for ecommerce', 'U1', '', ''],
  ['Alation', 'b.com', 'data catalog', '', '', 'U2', '', ''],
] });
const multi = sandbox.readEntityTab_(
  { tab: 'Portfolio Companies', nameHeader: 'Company Name',
    aboutHeaders: ['Focus Area(s)', 'HQ', 'Summary'] }, 'PORTCOS');
check('joins several columns into one labelled dossier',
  multi[0].about, 'Focus Area(s): AI personalization. HQ: Palo Alto. Summary: ML for ecommerce');
check('blank dossier cells are skipped, not left as empty labels',
  multi[1].about, 'Focus Area(s): data catalog');
check('multi-column read still gets the names',
  multi.map(e => e.name), ['Aidaptive', 'Alation']);

// A header that does not exist is skipped, so aboutHeaders can be optimistic.
useTabs({ T: [['Company Name', 'HQ'], ['Acme', 'Austin']] });
check('nonexistent dossier headers are skipped, real ones still used',
  sandbox.readEntityTab_(
    { tab: 'T', nameHeader: 'Company Name', aboutHeaders: ['Focus Area(s)', 'HQ', 'Summary'] },
    'PORTCOS')[0].about,
  'HQ: Austin');

// A single dossier column is passed through bare — labelling one value adds
// nothing but tokens.
useTabs({ T: [['Company Name', 'Summary'], ['Acme', 'makes robots']] });
check('one dossier column is unlabelled',
  sandbox.readEntityTab_({ tab: 'T', nameHeader: 'Company Name', aboutHeaders: ['Summary'] },
    'PORTCOS')[0].about,
  'makes robots');

// Trailing unnamed columns must not blow up header matching.
useTabs({ T: [['Company Name', '', ''], ['Acme', '', '']] });
check('empty trailing headers are harmless',
  sandbox.readEntityTab_({ tab: 'T', nameHeader: 'Company Name', aboutHeaders: [] }, 'PORTCOS'),
  [{ name: 'Acme', about: '' }]);

check('aboutHeaders and legacy aboutHeader both resolve',
  [sandbox.aboutHeaders_({ aboutHeaders: ['A', 'B'] }), sandbox.aboutHeaders_({ aboutHeader: 'A' }),
   sandbox.aboutHeaders_({})],
  [['A', 'B'], ['A'], []]);

// Failures must name what actually exists — a typo'd tab otherwise reads
// exactly like "no companies today".
useTabs({ 'Port Co': PORTCO_TAB, Contacts: [['Companys']] });
function expectTabError(label, source, pattern) {
  let msg = '';
  try { sandbox.readEntityTab_(source, 'PORTCOS'); } catch (e) { msg = e.message; }
  check(label, pattern.test(msg), true);
}
expectTabError('wrong tab name lists the real tabs',
  { tab: 'PortCo', nameHeader: 'Company' }, /"Port Co".*"Contacts"|"Contacts".*"Port Co"/);
expectTabError('wrong tab name says which setting to fix',
  { tab: 'PortCo', nameHeader: 'Company' }, /ENTITY_SOURCES\.PORTCOS\.tab/);
expectTabError('wrong header lists the real headers',
  { tab: 'Port Co', nameHeader: 'Nope' }, /"Company", "About", "Owner"/);
expectTabError('wrong header says which setting to fix',
  { tab: 'Port Co', nameHeader: 'Nope' }, /ENTITY_SOURCES\.PORTCOS\.nameHeader/);

// ---- entityList_ : sheet vs config routing ----
useTabs({ 'Port Co': PORTCO_TAB });
check('ENTITY_SOURCE sheet reads the tab',
  withConfig({ ENTITY_SOURCE: 'sheet',
               ENTITY_SOURCES: { PORTCOS: { tab: 'Port Co', nameHeader: 'Company', aboutHeader: 'About' } } },
    () => sandbox.entityList_('PORTCOS').map(e => e.name)),
  ['Away', 'Brightwheel']);

check('ENTITY_SOURCE config ignores the tab entirely',
  withConfig({ ENTITY_SOURCE: 'config',
               ENTITY_SOURCES: { PORTCOS: { tab: 'Port Co', nameHeader: 'Company' } },
               PORTCOS: [{ name: 'From Config', about: 'x' }] },
    () => sandbox.entityList_('PORTCOS').map(e => e.name)),
  ['From Config']);

// An unmapped list falls back, so lists can migrate one at a time.
check('unmapped list falls back to the config array',
  withConfig({ ENTITY_SOURCE: 'sheet', ENTITY_SOURCES: {},
               INDUSTRY_TOPICS: [{ name: 'dtc retail', about: 'the sector' }] },
    () => sandbox.entityList_('INDUSTRY_TOPICS').map(e => e.name)),
  ['dtc retail']);

// ---- entitySpec_ / entityQuery_ / topicQuery_ : the dossier ----
check('plain string entity still works',
  sandbox.entitySpec_('Nike'), { name: 'Nike', about: '' });
check('object entity carries the dossier',
  sandbox.entitySpec_({ name: 'Away', about: 'DTC luggage brand' }),
  { name: 'Away', about: 'DTC luggage brand' });
check('entitySpec_ trims both fields',
  sandbox.entitySpec_({ name: '  Away  ', about: '  luggage  ' }),
  { name: 'Away', about: 'luggage' });
check('entitySpec_ tolerates a missing about',
  sandbox.entitySpec_({ name: 'Away' }), { name: 'Away', about: '' });

check('entityQuery_ pairs an unquoted single word with its dossier',
  sandbox.entityQuery_({ name: 'Away', about: 'DTC luggage brand' }),
  { entity: 'Away', about: 'DTC luggage brand', q: 'Away' });
check('entityQuery_ quotes a multi-word name',
  sandbox.entityQuery_({ name: 'Warby Parker', about: 'eyewear' }).q, '"Warby Parker"');
check('entityQuery_ from a plain string has no dossier',
  sandbox.entityQuery_('Nike'), { entity: 'Nike', about: '', q: 'Nike' });
check('topicQuery_ has no entity but keeps the dossier',
  sandbox.topicQuery_({ name: 'dtc retail', about: 'the DTC sector' }),
  { entity: null, about: 'the DTC sector', q: '"dtc retail"' });

// ---- normalizeUrl_ ----
check('normalizeUrl_ strips utm',
  sandbox.normalizeUrl_('https://x.com/a?utm_source=news&utm_medium=rss'),
  'https://x.com/a');
check('normalizeUrl_ leaves real params',
  sandbox.normalizeUrl_('https://x.com/a?id=7'),
  'https://x.com/a?id=7');

// ---- titleKey_ ----
check('titleKey_ normalizes case and punctuation',
  sandbox.titleKey_('Nike Beats Q3 Estimates!'), 'nike beats q3 estimates');
// GDELT spaces out punctuation; a normally-punctuated copy must still match.
check('titleKey_ absorbs GDELT punctuation spacing',
  sandbox.titleKey_('Y Intercept Invests $438 , 000 in Warby Parker Inc .'),
  sandbox.titleKey_('Y Intercept Invests $438,000 in Warby Parker Inc.'));
check('titleKey_ empty title', sandbox.titleKey_(''), '');

// ---- dedupeArticles_ : URL + syndication ----
const D = (url, title, source, iso) =>
  ({ url, title, source, date: iso ? new Date(iso) : null });

check('dedupeArticles_ collapses utm variants of one URL',
  sandbox.dedupeArticles_([
    D('https://x.com/a', 'first', 'x.com', '2026-07-15T10:00:00Z'),
    D('https://x.com/a?utm_source=z', 'first', 'x.com', '2026-07-15T10:00:00Z'),
    D('https://x.com/b', 'other', 'x.com', '2026-07-15T10:00:00Z'),
  ]).map(x => x.title),
  ['first', 'other']);

// The observed case: one wire story, two outlets, two URLs.
const syndicated = [
  D('https://kdat.com/iowa', 'Iowa to Receive Portion of $18 Million 23andMe Settlement',
    'kdat.com', '2026-07-15T14:45:00Z'),
  D('https://koel.com/iowa', 'Iowa to Receive Portion of $18 Million 23andMe Settlement',
    'koel.com', '2026-07-15T11:30:00Z'),
  D('https://other.com/x', 'Unrelated story', 'other.com', '2026-07-15T12:00:00Z'),
];
const deduped = sandbox.dedupeArticles_(syndicated);
check('dedupeArticles_ collapses a syndicated story', deduped.length, 2);
check('dedupeArticles_ keeps the earliest copy (closest to the original)',
  deduped[0].source, 'koel.com');

// Determinism is the whole point: cross-run dedupe rides on the URL check
// against existing rows, which only holds if every run elects the same copy.
const shuffled = [syndicated[1], syndicated[2], syndicated[0]];
check('dedupeArticles_ is order-independent',
  sandbox.dedupeArticles_(shuffled).map(a => a.source).sort(),
  deduped.map(a => a.source).sort());

// Same timestamp -> domain decides, so it is still deterministic.
const tied = [
  D('https://zebra.com/s', 'Same Headline', 'zebra.com', '2026-07-15T10:00:00Z'),
  D('https://apple.com/s', 'Same Headline', 'apple.com', '2026-07-15T10:00:00Z'),
];
check('dedupeArticles_ breaks timestamp ties by domain',
  sandbox.dedupeArticles_(tied)[0].source, 'apple.com');
check('dedupeArticles_ tie-break is order-independent',
  sandbox.dedupeArticles_([tied[1], tied[0]])[0].source, 'apple.com');

// Different stories that merely share a publisher must NOT collapse.
check('dedupeArticles_ keeps distinct stories from one source',
  sandbox.dedupeArticles_([
    D('https://x.com/1', 'Story One', 'x.com', '2026-07-15T10:00:00Z'),
    D('https://x.com/2', 'Story Two', 'x.com', '2026-07-15T11:00:00Z'),
  ]).length, 2);

// An untitled article can't be grouped — it must survive, not vanish.
check('dedupeArticles_ keeps untitled articles separate',
  sandbox.dedupeArticles_([
    D('https://x.com/1', '', 'x.com', '2026-07-15T10:00:00Z'),
    D('https://x.com/2', '', 'x.com', '2026-07-15T11:00:00Z'),
  ]).length, 2);

check('dedupeArticles_ handles an empty list', sandbox.dedupeArticles_([]), []);
// A missing date must not win over a real one by sorting as 0.
check('dedupeArticles_ prefers a dated copy over an undated one',
  sandbox.dedupeArticles_([
    D('https://a.com/s', 'Same Headline', 'a.com', null),
    D('https://b.com/s', 'Same Headline', 'b.com', '2026-07-15T10:00:00Z'),
  ])[0].source, 'b.com');

// ---- stripHtml_ ----
const html = `<html><head><style>.a{color:red}</style><script>var x=1;</script></head>
  <body><nav>Menu Home</nav><h1>Acme raises $40M</h1>
  <p>Acme &amp; Co. closed a round&nbsp;today.</p><!-- comment --></body></html>`;
const text = sandbox.stripHtml_(html);
check('stripHtml_ drops script/style/nav',
  /var x|color:red|Menu Home/.test(text), false);
check('stripHtml_ keeps body text and decodes entities',
  /Acme raises \$40M/.test(text) && /Acme & Co\. closed a round today\./.test(text), true);

// Numeric entities are pervasive in real publisher HTML — seen live from
// thefrontierpost.com. Undecoded, Gemini reads "India s" instead of "India's".
// &#8217; is U+2019, a typographic apostrophe — decoding to ’ (not ') is
// correct; the point is that the character survives at all.
check('stripHtml_ decodes decimal entities',
  sandbox.stripHtml_('<p>India&#8217;s plant &#8211; exposed</p>'),
  'India’s plant – exposed');
check('stripHtml_ decodes hex entities',
  sandbox.stripHtml_('<p>India&#x2019;s plant</p>'), 'India’s plant');
check('stripHtml_ decodes the old &#39; apostrophe',
  sandbox.stripHtml_('<p>Nike&#39;s Q3</p>'), "Nike's Q3");
check('stripHtml_ decodes astral code points',
  sandbox.stripHtml_('<p>up &#128200; today</p>'), 'up 📈 today');
check('stripHtml_ survives an out-of-range entity',
  sandbox.stripHtml_('<p>a&#99999999;b</p>'), 'a b');
check('stripHtml_ still blanks unknown named entities',
  sandbox.stripHtml_('<p>a&zzz;b</p>'), 'a b');

// ---- headersFor_ : shared Signals schema ----
const SIGNAL_HEADERS = [
  'ID', 'Date Found', 'Type', 'Status', 'Person', 'Company', 'Email', 'Category',
  'Signal', 'Source URL', 'Subject', 'Body', 'Relevance', 'Justification', 'Urgency', 'Timing',
];
check('headers match SIGNAL_HEADERS for entity repo',
  sandbox.headersFor_({ entityLabel: 'PortCo' }), SIGNAL_HEADERS);
check('headers match SIGNAL_HEADERS for topic repo (no entity column)',
  sandbox.headersFor_({ entityLabel: null }), SIGNAL_HEADERS);
check('CONFIG.SIGNAL_HEADERS matches the sheet schema',
  CONFIG.SIGNAL_HEADERS, SIGNAL_HEADERS);

// ---- buildRow_ : column order must match headers exactly ----
const article = {
  entity: 'Acme', title: 'T', source: 'Reuters',
  url: 'https://x.com/a', date: new Date('2025-07-14T10:00:00Z'),
};
const enrich = {
  summary: 'Something happened.',
  sector: 'Fintech',
  signal: 'Acme raises Series B',
  justification: 'Directly about Acme funding.',
  urgency: 'Medium',
  timing: 'This week',
  relevant: true,
};

const rowWithEntity = sandbox.buildRow_({ entityLabel: 'PortCo' }, article, enrich);
check('row width matches SIGNAL_HEADERS',
  rowWithEntity.length, SIGNAL_HEADERS.length);
check('row ID is a uuid', rowWithEntity[0], '00000000-0000-4000-8000-000000000001');
check('row Date Found is a Date',
  typeof rowWithEntity[1].getTime === 'function' && !isNaN(rowWithEntity[1].getTime()), true);
check('row Type/Status defaults', [rowWithEntity[2], rowWithEntity[3]], ['awareness', 'New']);
check('row Company from entity', rowWithEntity[5], 'Acme');
check('row Category/Signal/URL/Subject/Body/Relevance',
  [rowWithEntity[7], rowWithEntity[8], rowWithEntity[9], rowWithEntity[10],
   rowWithEntity[11], rowWithEntity[12]],
  ['Fintech', 'Acme raises Series B', 'https://x.com/a', 'T',
   'Something happened.', 6]);
check('row Justification/Urgency/Timing',
  [rowWithEntity[13], rowWithEntity[14], rowWithEntity[15]],
  ['Directly about Acme funding.', 'Medium', 'This week']);

const rowNoEntity = sandbox.buildRow_(
  { entityLabel: null },
  Object.assign({}, article, { entity: null }),
  enrich);
check('topic repo leaves Company blank', rowNoEntity[5], '');
check('topic row still matches header width',
  rowNoEntity.length, SIGNAL_HEADERS.length);
check('medium urgency writes Type awareness',
  sandbox.buildRow_({ entityLabel: 'PortCo' }, article, enrich)[2],
  'awareness');
check('high urgency writes Type recommendation',
  sandbox.buildRow_({ entityLabel: 'PortCo' }, article,
    Object.assign({}, enrich, { urgency: 'High' }))[2],
  'recommendation');
check('high urgency Relevance score is 8',
  sandbox.buildRow_({ entityLabel: 'PortCo' }, article,
    Object.assign({}, enrich, { urgency: 'High' }))[12],
  8);
check('empty Gemini signal falls back to title (Industry News style)',
  sandbox.buildRow_({ entityLabel: 'PortCo' }, article,
    Object.assign({}, enrich, { signal: '', summary: '' }))[8],
  'T');
check('empty Gemini body falls back to title',
  sandbox.buildRow_({ entityLabel: 'PortCo' }, article,
    Object.assign({}, enrich, { summary: '' }))[11],
  'T');
check('blank urgency defaults to Medium / awareness',
  (() => {
    const row = sandbox.buildRow_({ entityLabel: 'PortCo' }, article,
      Object.assign({}, enrich, { urgency: '' }));
    return [row[2], row[14], row[12]];
  })(),
  ['awareness', 'Medium', 6]);


// ---- REPOSITORIES wiring sanity ----
check('7 repositories defined', REPOSITORIES.length, 7);
check('4 repositories wired',
  REPOSITORIES.filter(r => r.wired).length, 4);
check('every wired repo builds queries',
  REPOSITORIES.filter(r => r.wired).every(r => typeof r.buildQueries === 'function'), true);
check('every unwired repo explains why',
  REPOSITORIES.filter(r => !r.wired).every(r => typeof r.note === 'string' && r.note.length > 0), true);
check('tab names are unique',
  new Set(REPOSITORIES.map(r => r.tab)).size, REPOSITORIES.length);
check('PortCo News queries map entity -> phrase',
  withConfig({ ENTITY_SOURCE: 'config' },
    () => REPOSITORIES.find(r => r.tab === 'PortCo News').buildQueries().map(q => [q.entity, q.q])),
  [['Example PortCo One', '"Example PortCo One"'],
   ['Example PortCo Two', '"Example PortCo Two"']]);
check('Industry News queries carry no entity',
  withConfig({ ENTITY_SOURCE: 'config' },
    () => REPOSITORIES.find(r => r.tab === 'Industry News').buildQueries())
    .every(q => q.entity === null), true);

// Every PortCo in the config array should ship a dossier — it is the main
// precision lever, and a blank one silently degrades relevance to guesswork.
// (When ENTITY_SOURCE is 'sheet' this is enforced by the About column instead,
// and readEntityTab_ logs a count of rows missing one.)
check('every PortCo has a dossier',
  CONFIG.PORTCOS.map(p => sandbox.entitySpec_(p)).filter(p => !p.about).map(p => p.name), []);
check('every wired repo query carries an about field (even if empty)',
  allQueries.every(q => typeof q.about === 'string'), true);

// Each mapped source must name a tab and a name column, or the run dies at
// read time with no way to guess what was meant.
check('every ENTITY_SOURCES entry names a tab and a nameHeader',
  Object.keys(CONFIG.ENTITY_SOURCES)
    .filter(k => !CONFIG.ENTITY_SOURCES[k].tab || !CONFIG.ENTITY_SOURCES[k].nameHeader), []);
check('ENTITY_SOURCES only maps real CONFIG lists',
  Object.keys(CONFIG.ENTITY_SOURCES).filter(k => !Array.isArray(CONFIG[k])), []);
check('CONFIG has no SerpAPI key',
  Object.prototype.hasOwnProperty.call(CONFIG, 'SERPAPI_KEY'), false);

// Every tab the menu offers must exist and be wired.
const MENU_TABS = ['PortCo News', 'Industry News', 'Major Company News', 'DTC Network Companies News'];
check('menu items all map to wired repos',
  MENU_TABS.every(t => { const r = REPOSITORIES.find(x => x.tab === t); return r && r.wired; }), true);
check('OUTPUT_TAB consolidates writes into Signals',
  sandbox.sheetTab_({ tab: 'PortCo News' }), 'Signals');
check('blank OUTPUT_TAB falls back to repo.tab',
  withConfig({ OUTPUT_TAB: '' }, () => sandbox.sheetTab_({ tab: 'Industry News' })),
  'Industry News');

// ---- Gemini sector enum must contain an escape hatch ----
check("SECTORS includes 'Other'", CONFIG.SECTORS.includes('Other'), true);
check('URGENCY_LEVELS has High/Medium/Low',
  CONFIG.URGENCY_LEVELS, ['High', 'Medium', 'Low']);
check('TIMING_WINDOWS has Immediate/This week/Monitoring',
  CONFIG.TIMING_WINDOWS, ['Immediate', 'This week', 'Monitoring']);

// ---- apiKey_ must fail loudly, not silently send an empty key ----
let threw = false;
try { sandbox.apiKey_('GEMINI_API_KEY', ''); } catch (e) { threw = /Missing GEMINI_API_KEY/.test(e.message); }
check('apiKey_ throws a clear error when unset', threw, true);
check('apiKey_ returns inline value when set', sandbox.apiKey_('GEMINI_API_KEY', ' abc123 '), 'abc123');

// ---- buildGeminiPayload_ : the schema is what pins sector to the taxonomy ----
const body = 'x'.repeat(3000);
const withBody = sandbox.buildGeminiPayload_(article, body);

check('payload constrains sector to CONFIG.SECTORS',
  withBody.generationConfig.responseSchema.properties.sector.enum, CONFIG.SECTORS);
check('payload constrains urgency to CONFIG.URGENCY_LEVELS',
  withBody.generationConfig.responseSchema.properties.urgency.enum, CONFIG.URGENCY_LEVELS);
check('payload constrains timing to CONFIG.TIMING_WINDOWS',
  withBody.generationConfig.responseSchema.properties.timing.enum, CONFIG.TIMING_WINDOWS);
check('payload demands JSON back',
  withBody.generationConfig.responseMimeType, 'application/json');
check('payload requires all Signals fields',
  withBody.generationConfig.responseSchema.required,
  ['relevant', 'summary', 'sector', 'signal', 'justification', 'urgency', 'timing']);
check('payload types relevant as a boolean',
  withBody.generationConfig.responseSchema.properties.relevant, { type: 'BOOLEAN' });
check('payload disables thinking per config',
  withBody.generationConfig.thinkingConfig, { thinkingBudget: 0 });
check('payload carries the article body',
  withBody.contents[0].parts[0].text.includes(body), true);
check('payload names the subject company',
  withBody.contents[0].parts[0].text.includes('SUBJECT COMPANY: Acme'), true);
check('payload does not warn about a missing body when one exists',
  /could not be retrieved/.test(withBody.contents[0].parts[0].text), false);
check('payload asks for SIGNAL',
  /SIGNAL: one short/.test(withBody.contents[0].parts[0].text), true);
check('payload asks for JUSTIFICATION',
  /JUSTIFICATION:/.test(withBody.contents[0].parts[0].text), true);

// Paywalled / blocked article: must warn Gemini instead of silently inventing.
const noBody = sandbox.buildGeminiPayload_(article, '');
check('empty body -> warns Gemini not to invent detail',
  /could not be retrieved/.test(noBody.contents[0].parts[0].text), true);
check('empty body -> says no body available',
  noBody.contents[0].parts[0].text.includes('(no body available)'), true);

// A stub page under the 200-char threshold counts as no body.
const stub = sandbox.buildGeminiPayload_(article, 'Please enable JavaScript.');
check('sub-threshold body treated as missing',
  /could not be retrieved/.test(stub.contents[0].parts[0].text), true);

// Industry News has no entity — the prompt must not fabricate one.
const noEntity = sandbox.buildGeminiPayload_({ ...article, entity: null, query: 'dtc retail' }, body);
check('no entity -> no SUBJECT COMPANY line',
  /SUBJECT COMPANY/.test(noEntity.contents[0].parts[0].text), false);
check('prompt has no leftover null lines',
  /\bnull\b/.test(noEntity.contents[0].parts[0].text), false);

// ---- the relevance rule : this is what makes GDELT's noise survivable ----
check('entity repo judges relevance against the company',
  /RELEVANT: true only if this article is genuinely about Acme/
    .test(withBody.contents[0].parts[0].text), true);
check('entity repo rules out mere name-drops',
  /not merely name-dropped/.test(withBody.contents[0].parts[0].text), true);
check('topic repo judges relevance against the query',
  /RELEVANT: true only if this article is genuinely about the following subject: "dtc retail"/
    .test(noEntity.contents[0].parts[0].text), true);
check('topic repo does not reference a company',
  /name-dropped/.test(noEntity.contents[0].parts[0].text), false);

// ---- the dossier reaches the prompt ----
const withDossier = sandbox.buildGeminiPayload_(
  { ...article, entity: 'Away', about: 'DTC luggage brand, NYC' }, body);
check('dossier is injected next to the entity name',
  /genuinely about Away \(DTC luggage brand, NYC\)/
    .test(withDossier.contents[0].parts[0].text), true);
// The common-word case is exactly why the dossier exists.
check('prompt rules out the name used as an ordinary word',
  /appears only as an ordinary word rather than as this company/
    .test(withDossier.contents[0].parts[0].text), true);
check('prompt rules out roundup name-drops',
  /listed among many brands in a roundup/
    .test(withDossier.contents[0].parts[0].text), true);
check('no dossier -> no empty parens',
  /genuinely about Acme —/.test(withBody.contents[0].parts[0].text), true);

const topicDossier = sandbox.buildGeminiPayload_(
  { ...article, entity: null, query: 'dtc retail', about: 'the DTC sector' }, body);
check('topic dossier reaches the prompt',
  /subject: "dtc retail" \(the DTC sector\)/
    .test(topicDossier.contents[0].parts[0].text), true);

// ---- readGeminiResponse_ : every failure path must degrade, not throw ----
function fakeResponse(code, text) {
  return { getResponseCode: () => code, getContentText: () => text };
}
function geminiOk(obj) {
  return fakeResponse(200, JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }],
  }));
}
check('reads a good response',
  sandbox.readGeminiResponse_(geminiOk({
    relevant: true, summary: 'S.', sector: 'Fintech',
    signal: 'Sig', justification: 'Why', urgency: 'High', timing: 'Immediate',
  }), article),
  {
    relevant: true, summary: 'S.', sector: 'Fintech',
    signal: 'Sig', justification: 'Why', urgency: 'High', timing: 'Immediate',
  });
check('429 degrades to empty',
  sandbox.readGeminiResponse_(fakeResponse(429, 'rate limited'), article),
  { summary: '', sector: '', signal: '', justification: '', urgency: '', timing: '' });
check('null response degrades to empty',
  sandbox.readGeminiResponse_(null, article),
  { summary: '', sector: '', signal: '', justification: '', urgency: '', timing: '' });
check('non-JSON degrades to empty',
  sandbox.readGeminiResponse_(fakeResponse(200, '<html>502</html>'), article),
  { summary: '', sector: '', signal: '', justification: '', urgency: '', timing: '' });
check('safety block (no candidate) degrades to empty',
  sandbox.readGeminiResponse_(fakeResponse(200, '{"promptFeedback":{"blockReason":"SAFETY"}}'), article),
  { summary: '', sector: '', signal: '', justification: '', urgency: '', timing: '' });
check('truncated candidate degrades to empty',
  sandbox.readGeminiResponse_(fakeResponse(200, '{"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[]}}]}'), article),
  { summary: '', sector: '', signal: '', justification: '', urgency: '', timing: '' });

// ---- retry / summarizeArticles_ : batched sequential Gemini ----
function geminiBatchOk(items) {
  return geminiOk({ items: items });
}

{
  let geminiFetches = 0;
  sandbox.UrlFetchApp = {
    fetchAll: () => { throw new Error('fetchAll should not be used for Gemini batches'); },
    fetch: () => {
      geminiFetches++;
      return geminiBatchOk([{
        index: 0, relevant: true, summary: 'recovered after 429', sector: 'Technology',
        signal: 'S', justification: 'J', urgency: 'Medium', timing: 'This week',
      }]);
    },
  };
  // First attempt 429s, then succeeds — stub by call count.
  let calls = 0;
  sandbox.UrlFetchApp.fetch = () => {
    calls++;
    geminiFetches++;
    if (calls === 1) return fakeResponse(429, '{"error":{"code":429}}');
    return geminiBatchOk([{
      index: 0, relevant: true, summary: 'recovered after 429', sector: 'Technology',
      signal: 'S', justification: 'J', urgency: 'Medium', timing: 'This week',
    }]);
  };
  const after429 = withConfig(
    { GEMINI_BACKEND: 'ai_studio', GEMINI_API_KEY: 'k',
      GEMINI_ARTICLES_PER_CALL: 8, GEMINI_CHUNK_PAUSE_MS: 0,
      GEMINI_MAX_ATTEMPTS: 4, GEMINI_RETRY_BASE_MS: 1 },
    () => sandbox.summarizeArticles_(
      [{ entity: 'Acme', title: 'T', source: 's', url: 'https://x.com/1' }],
      ['x'.repeat(500)]));
  check('Gemini 429 chunk is retried via UrlFetchApp.fetch', geminiFetches >= 2, true);
  check('Gemini 429 recovers with a summary on retry', after429[0].summary, 'recovered after 429');
  check('Gemini 429 recovery keeps sector', after429[0].sector, 'Technology');
}

// ---- summarizeArticles_ : relevance must fail OPEN, never drop silently ----
function stubGeminiBatch(chunks) {
  // chunks: array of response objects (or null) for each sequential fetch
  let n = 0;
  sandbox.UrlFetchApp = {
    fetchAll: () => { throw new Error('unexpected fetchAll'); },
    fetch: () => {
      const obj = chunks[Math.min(n, chunks.length - 1)];
      n++;
      if (obj === null) return null;
      return geminiBatchOk(obj.items || obj);
    },
  };
}

const three = [
  { entity: 'Acme', title: 'A', source: 's', url: 'https://x.com/1' },
  { entity: 'Acme', title: 'B', source: 's', url: 'https://x.com/2' },
  { entity: 'Acme', title: 'C', source: 's', url: 'https://x.com/3' },
];

stubGeminiBatch([{
  items: [
    { index: 0, relevant: true, summary: 'yes', sector: 'Fintech',
      signal: 'Sig A', justification: 'Why A', urgency: 'High', timing: 'Immediate' },
    { index: 1, relevant: false, summary: 'no', sector: 'Other',
      signal: 'Sig B', justification: 'Why B', urgency: 'Low', timing: 'Monitoring' },
    // index 2 deliberately missing → fail open
  ],
}]);
const enriched = withConfig(
  { GEMINI_BACKEND: 'ai_studio', GEMINI_API_KEY: 'k',
    GEMINI_ARTICLES_PER_CALL: 8, GEMINI_CHUNK_PAUSE_MS: 0 },
  () => sandbox.summarizeArticles_(three, ['x'.repeat(500), 'x'.repeat(500), 'x'.repeat(500)]));

check('relevant article kept', enriched[0].relevant, true);
check('irrelevant article marked', enriched[1].relevant, false);
check('missing batch index defaults to relevant (fails open)', enriched[2].relevant, true);
check('enrichments stay index-aligned with articles', enriched.length, 3);
check('enrichment carries signal/urgency/timing',
  [enriched[0].signal, enriched[0].urgency, enriched[0].timing],
  ['Sig A', 'High', 'Immediate']);
check('missing index blanks signal fields',
  [enriched[2].signal, enriched[2].urgency, enriched[2].timing],
  ['', '', '']);

check('batch payload asks for items array',
  sandbox.buildGeminiBatchPayload_(three, ['a', 'b', 'c'])
    .generationConfig.responseSchema.required,
  ['items']);
check('batch payload lists ARTICLE 0 and ARTICLE 2',
  (() => {
    const t = sandbox.buildGeminiBatchPayload_(three, ['a', 'b', 'c']).contents[0].parts[0].text;
    return /=== ARTICLE 0 ===/.test(t) && /=== ARTICLE 2 ===/.test(t);
  })(),
  true);

// Dead HTTP response → fail open for the whole chunk
stubGeminiBatch([null]);
const dead = withConfig(
  { GEMINI_BACKEND: 'ai_studio', GEMINI_API_KEY: 'k',
    GEMINI_ARTICLES_PER_CALL: 8, GEMINI_CHUNK_PAUSE_MS: 0 },
  () => sandbox.summarizeArticles_([three[0]], ['x'.repeat(500)]));
check('dead batch call defaults to relevant (fails open)', dead[0].relevant, true);
check('dead batch call blanks signal fields',
  [dead[0].signal, dead[0].urgency, dead[0].timing],
  ['', '', '']);

// An unknown sector must be blanked, not written through.
stubGeminiBatch([{
  items: [{ index: 0, relevant: true, summary: 's', sector: 'Cryptocurrency Mining',
    signal: 'x', justification: 'y', urgency: 'High', timing: 'Immediate' }],
}]);
const badSector = withConfig(
  { GEMINI_BACKEND: 'ai_studio', GEMINI_API_KEY: 'k',
    GEMINI_ARTICLES_PER_CALL: 8, GEMINI_CHUNK_PAUSE_MS: 0 },
  () => sandbox.summarizeArticles_([three[0]], ['x'.repeat(500)]));
check('sector outside the taxonomy is blanked', badSector[0].sector, '');

stubGeminiBatch([{
  items: [{ index: 0, relevant: true, summary: 's', sector: 'Fintech',
    signal: 'x', justification: 'y', urgency: 'Critical', timing: 'Yesterday' }],
}]);
const badEnums = withConfig(
  { GEMINI_BACKEND: 'ai_studio', GEMINI_API_KEY: 'k',
    GEMINI_ARTICLES_PER_CALL: 8, GEMINI_CHUNK_PAUSE_MS: 0 },
  () => sandbox.summarizeArticles_([three[0]], ['x'.repeat(500)]));
check('urgency outside the taxonomy is blanked', badEnums[0].urgency, '');
check('timing outside the taxonomy is blanked', badEnums[0].timing, '');

// ---- Vertex endpoint construction ----
check('vertex endpoint for a regular region',
  withConfig({ VERTEX_LOCATION: 'us-central1', GEMINI_MODEL: 'gemini-2.5-flash' },
    () => sandbox.vertexEndpoint_('my-proj')),
  'https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1' +
  '/publishers/google/models/gemini-2.5-flash:generateContent');
check('vertex endpoint for global is unprefixed',
  withConfig({ VERTEX_LOCATION: 'global', GEMINI_MODEL: 'gemini-2.5-flash' },
    () => sandbox.vertexEndpoint_('my-proj')),
  'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global' +
  '/publishers/google/models/gemini-2.5-flash:generateContent');
check('vertex endpoint respects a different region',
  withConfig({ VERTEX_LOCATION: 'europe-west4' },
    () => sandbox.vertexEndpoint_('p')).includes('europe-west4-aiplatform.googleapis.com'), true);

// ---- geminiRequestTarget_ : routing + auth per backend ----
const SA = JSON.stringify({
  type: 'service_account',
  project_id: 'my-proj',
  client_email: 'bot@my-proj.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
  token_uri: 'https://oauth2.googleapis.com/token',
});
props.VERTEX_SA_KEY = SA;
sandbox.UrlFetchApp = { fetch: () => fakeResponse(200, '{"access_token":"ya29.fake-token"}') };

const vertexTarget = withConfig(
  { GEMINI_BACKEND: 'vertex', VERTEX_PROJECT_ID: 'my-proj', VERTEX_LOCATION: 'us-central1' },
  () => sandbox.geminiRequestTarget_());
check('vertex target uses a Bearer token, not a key param',
  vertexTarget.headers, { Authorization: 'Bearer ya29.fake-token' });
check('vertex target url has no ?key=', /[?&]key=/.test(vertexTarget.url), false);
check('vertex target points at aiplatform',
  vertexTarget.url.includes('aiplatform.googleapis.com'), true);

const studioTarget = withConfig(
  { GEMINI_BACKEND: 'ai_studio', GEMINI_API_KEY: 'AIza-test' },
  () => sandbox.geminiRequestTarget_());
check('ai_studio target uses ?key= and no auth header',
  [studioTarget.url.includes('key=AIza-test'), studioTarget.headers], [true, {}]);

let badBackend = false;
try { withConfig({ GEMINI_BACKEND: 'openai' }, () => sandbox.geminiRequestTarget_()); }
catch (e) { badBackend = /Expected 'vertex' or 'ai_studio'/.test(e.message); }
check('unknown backend fails loudly', badBackend, true);

let missingProject = false;
try { withConfig({ GEMINI_BACKEND: 'vertex', VERTEX_PROJECT_ID: '' }, () => sandbox.geminiRequestTarget_()); }
catch (e) { missingProject = /VERTEX_PROJECT_ID is empty/.test(e.message); }
check('vertex without a project id fails loudly', missingProject, true);

// ---- loadServiceAccount_ : every setup mistake must name its fix ----
props.VERTEX_SA_KEY = SA;
check('loads a valid service account',
  sandbox.loadServiceAccount_().client_email, 'bot@my-proj.iam.gserviceaccount.com');

function expectLoadError(label, value, pattern) {
  props.VERTEX_SA_KEY = value;
  let msg = '';
  try { sandbox.loadServiceAccount_(); } catch (e) { msg = e.message; }
  check(label, pattern.test(msg), true);
}
expectLoadError('unset key explains where to paste it', null, /Project Settings > Script Properties/);
expectLoadError('empty key explains where to paste it', '   ', /Project Settings > Script Properties/);
expectLoadError('malformed JSON says paste it verbatim', '{not json', /not valid JSON/);
expectLoadError('OAuth client secret is caught',
  JSON.stringify({ type: 'authorized_user', client_id: 'x' }), /not a service account key/);
expectLoadError('key missing private_key is caught',
  JSON.stringify({ type: 'service_account', client_email: 'a@b.com' }), /missing client_email or private_key/);

// ---- JWT assembly ----
props.VERTEX_SA_KEY = SA;
const jwt = sandbox.buildSignedJwt_(JSON.parse(SA), 'https://oauth2.googleapis.com/token');
check('JWT has three dot-separated segments', jwt.split('.').length, 3);
check('JWT segments carry no base64 padding', /=/.test(jwt), false);
check('JWT segments are url-safe', /[+/]/.test(jwt), false);

const claim = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
check('JWT claim issuer is the service account', claim.iss, 'bot@my-proj.iam.gserviceaccount.com');
check('JWT claim requests cloud-platform scope',
  claim.scope, 'https://www.googleapis.com/auth/cloud-platform');
check('JWT claim audience is the token endpoint', claim.aud, 'https://oauth2.googleapis.com/token');
check('JWT expires an hour out', claim.exp - claim.iat, 3600);
check('JWT header declares RS256',
  JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString('utf8')),
  { alg: 'RS256', typ: 'JWT' });

// ---- readTokenResponse_ : auth failures must be loud, not silent ----
check('reads a good token',
  sandbox.readTokenResponse_(fakeResponse(200, '{"access_token":"ya29.x"}')), 'ya29.x');

function expectTokenError(label, code, text, pattern) {
  let msg = '';
  try { sandbox.readTokenResponse_(fakeResponse(code, text)); } catch (e) { msg = e.message; }
  check(label, pattern.test(msg), true);
}
expectTokenError('401 surfaces the cause', 401, '{"error":"invalid_grant"}', /invalid_grant/);
expectTokenError('401 hints at the usual causes', 401, '{}', /Vertex AI User|not enabled|revoked/);
expectTokenError('non-JSON token response is caught', 200, '<html>500</html>', /non-JSON/);
expectTokenError('missing access_token is caught', 200, '{"scope":"x"}', /no access_token/);

// ---- the key must never be readable from source ----
for (const f of ['Config.gs', 'Auth.gs', 'Gemini.gs', 'Main.gs', 'Fetch.gs', 'Sheets.gs', 'NewsApi.gs']) {
  const src = fs.readFileSync(path.join(PROJECT, f), 'utf8');
  check(`${f} contains no private key material`, /BEGIN [A-Z ]*PRIVATE KEY/.test(src), false);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
