/**
 * Config.gs
 *
 * Everything you are expected to edit lives in this file.
 * The other files should not need changes for normal use.
 */

const CONFIG = {
  // ---------------------------------------------------------------
  // Which news source(s) to search
  //
  // NEWS_PROVIDERS (preferred): list one or more. Results are merged and
  // deduped by URL before Gemini — same fan-in idea as the full Signals app,
  // articles only (no Drive / Gmail / LinkedIn).
  //
  //   'perplexity' — Perplexity Search API (PERPLEXITY_API_KEY)
  //   'newsapi'    — Event Registry / newsapi.ai (NEWSAPI_API_KEY)
  //   'gdelt'      — GDELT DOC API (free, IP-throttled; usually avoid)
  //
  // NEWS_SOURCE is the fallback when NEWS_PROVIDERS is empty.
  // ---------------------------------------------------------------
  NEWS_PROVIDERS: ['perplexity', 'newsapi'],

  // Used only when NEWS_PROVIDERS is []. Prefer NEWS_PROVIDERS.
  NEWS_SOURCE: 'perplexity',

  // Blank = read from the PERPLEXITY_API_KEY Script Property (preferred).
  PERPLEXITY_API_KEY: '',

  // Blank = read from the NEWSAPI_API_KEY Script Property (Event Registry key
  // from newsapi.ai). Required when 'newsapi' is in NEWS_PROVIDERS.
  NEWSAPI_API_KEY: '',

  // Override only if Event Registry gives you a different host.
  NEWSAPI_ENDPOINT: 'https://eventregistry.org/api/v1/article/getArticles',

  // Event Registry language code (eng, deu, ...).
  NEWSAPI_LANG: 'eng',

  // Where the company keyword must appear: 'body' | 'title'.
  NEWSAPI_KEYWORDS_LOC: 'body',

  // Ask NewsAPI for at least this many hits before local MAX_ARTICLES_PER_QUERY trim.
  NEWSAPI_MAX_RESULTS: 10,

  // How much page text comes back in `snippet`: 'low' | 'medium' | 'high'.
  // 'high' is what lets us skip scraping. Lower it only to cut cost.
  PERPLEXITY_CONTEXT_SIZE: 'high',

  // Results requested per entity (API max 20). Deliberately above
  // MAX_ARTICLES_PER_QUERY because the Search API has no recency parameter —
  // results are filtered to LOOKBACK_DAYS locally, so we over-fetch rather
  // than come back empty after filtering.
  PERPLEXITY_MAX_RESULTS: 20,

  // ISO 639-1 codes, max 10. [] = any language.
  PERPLEXITY_LANGUAGES: ['en'],

  // ISO 3166-1 alpha-2 for regional results. '' = worldwide.
  PERPLEXITY_COUNTRY: '',

  // Allowlist domains, or exclude with a '-' prefix. Max 20.
  // e.g. ['-dailypolitical.com', '-marketbeat.com'] to kill stock-spam mills.
  PERPLEXITY_DOMAIN_FILTER: [],

  // A snippet longer than this is used as the article body as-is. Shorter,
  // and we fall back to fetching the page. Most Perplexity snippets at
  // 'high' clear this easily.
  SNIPPET_MIN_CHARS: 400,

  // ---------------------------------------------------------------
  // GDELT settings — only used when NEWS_SOURCE is 'gdelt'
  //
  // WARNING: GDELT rate-limits by IP and Apps Script runs from Google's
  // shared pool, so this may fail outright regardless of pacing. Watch for
  // "WARNING: n/m GDELT queries FAILED" in the log.
  // ---------------------------------------------------------------

  // Appended to every GDELT query. The main precision lever if you find
  // too much noise reaching Gemini. GDELT supports AND (implicit), OR,
  // quoted phrases, and parentheses.
  //
  // Example: '(business OR earnings OR funding OR acquisition OR product)'
  // Leave blank to retrieve broadly and let Gemini do all the filtering.
  GDELT_EXTRA_QUERY: '',

  // Restricts source language. Blank = any language.
  GDELT_SOURCE_LANG: 'english',

  // Restricts source country (e.g. 'US'). Blank = worldwide, which is
  // usually what you want — a US company gets covered abroad too.
  GDELT_SOURCE_COUNTRY: '',

  // Pause between entity queries. GDELT documents ~1 request per 5 seconds,
  // but 5000 still drew a 429 in testing, so this leaves margin. Lower it and
  // you get throttled; the run then retries with backoff and takes longer
  // anyway. Budget roughly this x (number of entities) per run.
  GDELT_REQUEST_INTERVAL_MS: 6000,

  // Drop articles Gemini judges irrelevant instead of writing them.
  // Set false to write everything and add a Relevant column check by eye —
  // useful when first tuning GDELT_EXTRA_QUERY.
  DROP_IRRELEVANT: true,

  // ---------------------------------------------------------------
  // Which Gemini backend to call
  //
  //   'vertex'    Vertex AI. Auth via a service account key pasted into
  //               the VERTEX_SA_KEY Script Property. Fill in
  //               VERTEX_PROJECT_ID below. Run checkVertexAuth() to test.
  //
  //   'ai_studio' generativelanguage.googleapis.com. Auth via a plain API
  //               key from aistudio.google.com. No GCP project needed —
  //               easier for quick testing.
  //
  // Both speak the same request/response format, so only the endpoint and
  // the auth header differ. Switching backends changes nothing else.
  // ---------------------------------------------------------------
  GEMINI_BACKEND: 'vertex',

  // --- 'vertex' settings ---
  // Your GCP project ID (e.g. 'my-project-123456'), NOT the project number
  // and NOT the display name.
  VERTEX_PROJECT_ID: 'venture-pulse-499913',

  // Region serving the model. 'global' is also valid and routes to the
  // multi-region endpoint. Must be a region where your model is available.
  VERTEX_LOCATION: 'us-central1',

  // --- 'ai_studio' settings ---
  // Blank = read from the GEMINI_API_KEY Script Property. Ignored when
  // GEMINI_BACKEND is 'vertex'.
  GEMINI_API_KEY: '',

  // Blank = use the spreadsheet this script is bound to.
  // Set an ID here only if you run the script standalone.
  SPREADSHEET_ID: '',

  // ---------------------------------------------------------------
  // Where entity lists come from
  //
  //   'sheet'  — read from tabs in the bound spreadsheet (ENTITY_SOURCES
  //              below). Whoever maintains the portfolio adds a company in
  //              the Sheet; nobody touches code.
  //   'config' — use the hardcoded arrays further down.
  //
  // Columns are matched by HEADER TEXT, never position, so reordering
  // columns in the sheet cannot silently start reading the wrong one.
  // Matching ignores case, spacing and punctuation: "Company's",
  // "Companys" and "COMPANYS" are the same header.
  //
  // Any list without a tab mapped here falls back to its array below, so
  // lists can move into the sheet one at a time.
  //
  // Run "News Bot > Inspect sheet: tabs and headers" to print the exact
  // tab names and headers rather than guessing at spelling.
  // ---------------------------------------------------------------
  ENTITY_SOURCE: 'sheet',

  ENTITY_SOURCES: {
    PORTCOS: {
      tab: 'Portfolio Companies',
      nameHeader: 'Company Name',
      // The dossier. Several columns are joined, labelled by header, into one
      // line for Gemini: "Focus Area(s): pet nutrition. HQ: Austin. Summary: ...".
      // This is what lets it tell your company apart from a same-named one, or
      // from an ordinary word. Any header listed here that does not exist is
      // logged and skipped, so it is safe to list optimistically.
      aboutHeaders: ['Focus Area(s)', 'HQ', 'Summary'],
      headerRow: 1,
    },
    DTC_NETWORK_COMPANIES: {
      tab: 'Contacts',
      nameHeader: 'Company',
      aboutHeader: '',
      headerRow: 1,
    },
    MAJOR_COMPANIES: {
      tab: 'Targets',
      nameHeader: 'Companys',
      aboutHeader: '',
      headerRow: 1,
    },
    // INDUSTRY_TOPICS is deliberately absent: those are search topics, not
    // companies, so they stay in the array below. Add a tab here if you
    // want them editable in the sheet too.
  },

  // ---------------------------------------------------------------
  // Entities to track
  //
  // Used when ENTITY_SOURCE is 'config', or as the fallback for any list
  // with no tab mapped above. INDUSTRY_TOPICS always reads from here.
  //
  // NOTE: the company names below are PLACEHOLDERS invented for testing.
  //
  // Two accepted forms:
  //   'Acme Robotics'                        plain name
  //   { name: 'Away', about: 'DTC luggage brand, NYC' }
  //
  // ALWAYS WRITE THE `about` LINE. It is the single highest-leverage
  // thing in this file, and it costs nothing.
  //
  // Gemini judges whether each article is really about the company. For
  // a private PortCo it has no prior knowledge to draw on — "is this
  // about Away?" is unanswerable without knowing Away is a luggage
  // brand. One line of context turns a coin flip into an easy call, and
  // unlike a narrower query it can never hide a real article: it only
  // sharpens judgment, it does not restrict what gets retrieved.
  //
  // Keep `about` to one line: what the company sells, and where. Adding
  // a distinguishing detail helps most when the name is ambiguous
  // ('Away, the luggage brand — not the word "away"').
  //
  // Each name is one GDELT query per run (and one ~6s pause), so keep
  // the lists tight.
  //
  // A NOTE ON COMMON-WORD NAMES (Away, Bark, Ro, Faire): GDELT matches
  // full text, and testing confirmed no query formulation finds these —
  // narrowing 'Away' with '(luggage OR suitcase)' just returns car
  // reviews that mention luggage space. Gemini will correctly reject the
  // noise, so your sheet stays clean, but you pay a call per rejected
  // article. If that waste adds up, the fix is a title pre-filter, not a
  // cleverer query.
  // ---------------------------------------------------------------
  PORTCOS: [
    { name: 'Example PortCo One', about: 'DTC luggage and travel goods brand, New York' },
    { name: 'Example PortCo Two', about: 'B2B logistics software for mid-market shippers' },
  ],

  MAJOR_COMPANIES: [
    // A plain string still works — best for names Gemini already knows.
    'Nike',
    { name: 'Procter & Gamble', about: 'consumer packaged goods conglomerate, Cincinnati' },
  ],

  DTC_NETWORK_COMPANIES: [
    { name: 'Warby Parker', about: 'DTC eyewear retailer, New York' },
    { name: 'Allbirds', about: 'DTC wool footwear brand, San Francisco' },
  ],

  // Industry News has no entity column — these topics ARE the queries.
  // `about` works here too, describing the beat you want covered.
  INDUSTRY_TOPICS: [
    { name: 'direct-to-consumer retail',
      about: 'the DTC retail sector: brands selling straight to consumers online' },
    { name: 'consumer packaged goods',
      about: 'the CPG industry: packaged food, beverage, and household brands' },
  ],

  // ---------------------------------------------------------------
  // Sector taxonomy
  //
  // Gemini must pick exactly one of these per article — the list is
  // enforced by the response schema, so it cannot invent new values.
  // Edit freely, but keep 'Other' as an escape hatch or Gemini will be
  // forced into a bad fit.
  // ---------------------------------------------------------------
  SECTORS: [
    'Consumer',
    'Retail / DTC',
    'CPG / Food & Beverage',
    'Health & Wellness',
    'Fintech',
    'Logistics & Supply Chain',
    'Technology',
    'Media & Entertainment',
    'Industrials',
    'Other',
  ],

  // Urgency / timing enums for the Signals sheet (Gemini response schema).
  URGENCY_LEVELS: ['High', 'Medium', 'Low'],
  TIMING_WINDOWS: ['Immediate', 'This week', 'Monitoring'],

  // Shared output schema for every repository tab.
  SIGNAL_HEADERS: [
    'ID',
    'Date Found',
    'Type',
    'Status',
    'Person',
    'Company',
    'Email',
    'Category',
    'Signal',
    'Source URL',
    'Subject',
    'Body',
    'Relevance',
    'Justification',
    'Urgency',
    'Timing',
  ],

  // ---------------------------------------------------------------
  // Search behavior
  // ---------------------------------------------------------------
  // Recency window per run. Overlap is fine and expected — the URL dedupe
  // against what is already in the tab means a wider window costs nothing
  // beyond one GDELT call, and it stops a missed run losing stories.
  LOOKBACK_DAYS: 7,

  // Cap per entity per run. Lower = fewer Gemini calls and less noise.
  MAX_ARTICLES_PER_QUERY: 5,

  // Hard cap on NEW (post-dedupe) articles Gemini will judge per repository
  // per run. Protects Vertex quota on a cold Signals tab. 0 = no cap.
  MAX_NEW_ARTICLES_PER_REPO: 40,

  // ---------------------------------------------------------------
  // Batching
  //
  // Entities processed per repository per run, 0 = all of them.
  //
  // This exists because of a hard arithmetic problem: GDELT demands ~6s
  // between requests, and Apps Script kills a run at 6 min (consumer) or
  // 30 min (Workspace). 81 PortCos x 6s is 8 minutes of pure waiting
  // before a single article is fetched. It cannot finish.
  //
  // So each run takes a slice and remembers where it stopped (a cursor in
  // Script Properties, per repository). The next run continues from there
  // and wraps around. Coverage = (entities / BATCH_SIZE) runs, so 81
  // PortCos at 12/run needs 7 runs — an hourly trigger covers everything
  // roughly twice a day.
  //
  // The trade is staleness: a story about company #81 may sit unseen for
  // hours. LOOKBACK_DAYS is what keeps that from turning into a miss —
  // as long as the window is wider than a full pass, nothing is lost.
  //
  // Budget per run: BATCH_SIZE x (number of wired repos) x ~6s. At 12 and
  // 4 repos that is ~5 min of pacing, plus scraping and Gemini.
  //
  // Run "Reset batch cursors" to start every repository from the top.
  // ---------------------------------------------------------------
  // Entities processed per repository per run. 0 = all of them.
  //
  // Required for large lists: Contacts can be 800+ companies. At that size,
  // BATCH_SIZE 0 fires thousands of Perplexity/NewsAPI calls in one execution
  // and Apps Script dies mid-run with no further logs. 25/run is safe.
  // An hourly trigger walks the whole list over successive runs.
  BATCH_SIZE: 25,

  // ---------------------------------------------------------------
  // Gemini
  // ---------------------------------------------------------------
  GEMINI_MODEL: 'gemini-2.5-flash',
  SUMMARY_SENTENCES: 3,

  // How much scraped article text to send. Shorter when batching many
  // articles into one Gemini call — 2500 is enough for a solid summary.
  ARTICLE_TEXT_LIMIT: 2500,

  // 2.5-flash reasons before answering by default. Summarization does not
  // need it, and it roughly doubles latency and cost. Set to null to keep
  // thinking on, or if you switch to a model that rejects this field.
  GEMINI_THINKING_BUDGET: 0,

  // ---------------------------------------------------------------
  // Output
  //
  // Every wired repository appends into this single tab (shared Signals
  // schema). Repo `tab` names stay unique for menus, logs, and batch
  // cursors — only the write destination is shared.
  // Blank = each repository writes to its own tab named repo.tab.
  // ---------------------------------------------------------------
  OUTPUT_TAB: 'Signals',

  // ---------------------------------------------------------------
  // Throughput
  //
  // Publisher scrapes still parallelize. Gemini does NOT: several articles
  // are judged in ONE generateContent call, and those calls run one after
  // another. That is what stops Vertex 429 storms (86 parallel calls → ~10).
  // ---------------------------------------------------------------
  FETCH_BATCH_SIZE: 8,
  FETCH_BATCH_PAUSE_MS: 1000,

  // Articles packed into each Gemini call. 8 is a safe middle: fewer calls
  // without blowing the context window. Lower if responses truncate.
  GEMINI_ARTICLES_PER_CALL: 8,

  // Pause between sequential Gemini chunk calls.
  GEMINI_CHUNK_PAUSE_MS: 2500,

  // Gemini 429 handling on a chunk. Includes the first try.
  GEMINI_MAX_ATTEMPTS: 5,
  GEMINI_RETRY_BASE_MS: 8000,
};

/**
 * The seven repositories from the architecture diagram.
 *
 * Every repository writes the same Signals schema (CONFIG.SIGNAL_HEADERS)
 * into CONFIG.OUTPUT_TAB when set (default: "Signals"). Company is filled
 * from the entity when present; topic repos leave it blank. entityLabel is
 * kept for logging / dry-run display only. Repo `tab` names stay unique for
 * menus and batch cursors.
 *
 * wired: false means the tab is created and formatted but nothing fills
 * it. Those three need a source GDELT cannot provide — see the `note`
 * on each.
 *
 * NOTE: the diagram shows "PortCo Blogs" twice (once green, once blue)
 * with identical fields. Treated as one repository here. If they are
 * meant to be distinct, duplicate the entry below and give it a
 * different `tab` name.
 */
const REPOSITORIES = [
  {
    tab: 'PortCo News',
    entityLabel: 'PortCo',
    wired: true,
    buildQueries: () => entityList_('PORTCOS').map(entityQuery_),
  },
  {
    tab: 'PortCo Blogs',
    entityLabel: 'PortCo',
    wired: false,
    note: 'GDELT indexes news, not company blogs. Needs per-PortCo RSS feeds ' +
          '(UrlFetchApp + XmlService) or a web search with site: filters.',
  },
  {
    tab: 'Industry Reports',
    entityLabel: null,
    wired: false,
    note: 'Reports are rarely news-indexed. Needs a web search with filetype:pdf, ' +
          'or a direct feed from a research vendor.',
  },
  {
    tab: 'Industry News',
    entityLabel: null,
    wired: true,
    buildQueries: () => entityList_('INDUSTRY_TOPICS').map(topicQuery_),
  },
  {
    tab: 'Major Company News',
    entityLabel: 'Company',
    wired: true,
    buildQueries: () => entityList_('MAJOR_COMPANIES').map(entityQuery_),
  },
  {
    tab: 'DTC Network Companies News',
    entityLabel: 'Company',
    wired: true,
    buildQueries: () => entityList_('DTC_NETWORK_COMPANIES').map(entityQuery_),
  },
  {
    tab: 'PortCo LinkedIn Socials',
    entityLabel: 'Company',
    wired: false,
    note: 'LinkedIn cannot be retrieved through GDELT and scraping it violates their ToS. ' +
          'Needs official LinkedIn API access or a social listening vendor (Brandwatch, Sprout).',
  },
];

/**
 * Normalizes an entity list entry into { name, about }.
 * Accepts a plain string or an object, so old configs keep working.
 *
 * @param {string|{name: string, about: (string|undefined)}} spec
 * @return {{name: string, about: string}}
 */
function entitySpec_(spec) {
  if (typeof spec === 'string') {
    return { name: spec.trim(), about: '' };
  }
  return {
    name: String((spec && spec.name) || '').trim(),
    about: String((spec && spec.about) || '').trim(),
  };
}

/** Entity list entry -> query. `about` rides along for Gemini's relevance call. */
function entityQuery_(spec) {
  const entity = entitySpec_(spec);
  return { entity: entity.name, about: entity.about, q: gdeltPhrase_(entity.name) };
}

/** Topic list entry -> query. Same as entityQuery_ but with no entity column. */
function topicQuery_(spec) {
  const topic = entitySpec_(spec);
  return { entity: null, about: topic.about, q: gdeltPhrase_(topic.name) };
}

/** Column headers for a repository — shared Signals schema for every tab. */
function headersFor_(repo) {
  return CONFIG.SIGNAL_HEADERS.slice();
}

/**
 * Sheet name where rows are written. CONFIG.OUTPUT_TAB consolidates every
 * repository into one Signals tab; blank falls back to the repo's own tab.
 */
function sheetTab_(repo) {
  const shared = String(CONFIG.OUTPUT_TAB || '').trim();
  return shared || repo.tab;
}

/** Reads a key from Script Properties, falling back to the CONFIG literal. */
function apiKey_(propertyName, inlineValue) {
  const stored = PropertiesService.getScriptProperties().getProperty(propertyName);
  const key = (stored || inlineValue || '').trim();
  if (!key) {
    throw new Error(
      `Missing ${propertyName}. Either set it in Project Settings > Script Properties, ` +
      `or paste it into CONFIG in Config.gs.`
    );
  }
  return key;
}

/** Asserts a plain CONFIG value is filled in. */
function requireConfig_(name, value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error(`CONFIG.${name} is empty. Set it in Config.gs.`);
  }
  return trimmed;
}
