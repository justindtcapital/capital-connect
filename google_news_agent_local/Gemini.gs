/**
 * Gemini.gs — summarization and sector classification.
 *
 * Articles are judged in CHUNKS (several per generateContent call), then
 * chunks are issued SEQUENTIALLY with a pause. That is the main defence
 * against Vertex 429s: an 80-article run becomes ~10 API calls instead of 80
 * parallel ones.
 *
 * Works against Vertex AI or AI Studio (CONFIG.GEMINI_BACKEND). The two
 * speak an identical request/response format, so only the URL and the auth
 * differ — everything below the target is shared.
 */

const AI_STUDIO_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Vertex generateContent URL for the configured model, region, and project. */
function vertexEndpoint_(project) {
  const location = CONFIG.VERTEX_LOCATION || 'us-central1';
  // The multi-region endpoint is unprefixed; every real region is prefixed.
  const host = location === 'global'
    ? 'aiplatform.googleapis.com'
    : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}` +
         `/publishers/google/models/${CONFIG.GEMINI_MODEL}:generateContent`;
}

/**
 * Resolves where to send requests and how to authenticate.
 * Called once per run — the Vertex token is minted (or read from cache)
 * a single time and reused across every chunk.
 *
 * @return {{url: string, headers: !Object<string, string>}}
 */
function geminiRequestTarget_() {
  if (CONFIG.GEMINI_BACKEND === 'vertex') {
    const project = requireConfig_('VERTEX_PROJECT_ID', CONFIG.VERTEX_PROJECT_ID);
    return {
      url: vertexEndpoint_(project),
      headers: { Authorization: 'Bearer ' + vertexAccessToken_() },
    };
  }

  if (CONFIG.GEMINI_BACKEND === 'ai_studio') {
    const key = apiKey_('GEMINI_API_KEY', CONFIG.GEMINI_API_KEY);
    return {
      url: `${AI_STUDIO_ENDPOINT_BASE}/${CONFIG.GEMINI_MODEL}:generateContent` +
           `?key=${encodeURIComponent(key)}`,
      headers: {},
    };
  }

  throw new Error(
    `CONFIG.GEMINI_BACKEND is "${CONFIG.GEMINI_BACKEND}". Expected 'vertex' or 'ai_studio'.`
  );
}

/**
 * @param {!Array<{entity: ?string, title: string, source: string, url: string}>} articles
 * @param {!Array<string>} texts scraped article bodies, index-aligned
 * @return {!Array<!Object>} enrichments, index-aligned with articles
 */
function summarizeArticles_(articles, texts) {
  if (!articles.length) return [];

  const perCall = Math.max(1, CONFIG.GEMINI_ARTICLES_PER_CALL || 8);
  const pauseMs = CONFIG.GEMINI_CHUNK_PAUSE_MS || 2000;
  const target = geminiRequestTarget_();
  const out = [];

  const chunks = Math.ceil(articles.length / perCall);
  Logger.log(
    `Gemini: ${articles.length} article(s) in ${chunks} sequential call(s) ` +
    `(${perCall}/call).`
  );

  for (let start = 0; start < articles.length; start += perCall) {
    if (start > 0 && pauseMs > 0) Utilities.sleep(pauseMs);
    const end = Math.min(start + perCall, articles.length);
    const chunkArticles = articles.slice(start, end);
    const chunkTexts = texts.slice(start, end);
    Array.prototype.push.apply(out, summarizeArticleChunk_(target, chunkArticles, chunkTexts));
  }

  return out;
}

/**
 * One generateContent call covering a small list of articles.
 * Retries the whole chunk on 429 with exponential backoff.
 */
function summarizeArticleChunk_(target, articles, texts) {
  const request = {
    url: target.url,
    method: 'post',
    contentType: 'application/json',
    headers: target.headers,
    muteHttpExceptions: true,
    payload: JSON.stringify(buildGeminiBatchPayload_(articles, texts)),
  };

  const maxAttempts = CONFIG.GEMINI_MAX_ATTEMPTS || 4;
  const baseMs = CONFIG.GEMINI_RETRY_BASE_MS || 8000;
  let response = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    response = fetchOneRequest_(request);
    const code = response ? response.getResponseCode() : 0;
    if (code !== 429) break;
    if (attempt >= maxAttempts) break;
    const wait = baseMs * Math.pow(2, attempt - 1);
    Logger.log(
      `Gemini 429 on chunk of ${articles.length}. Waiting ${wait}ms ` +
      `before retry ${attempt}/${maxAttempts - 1}.`
    );
    Utilities.sleep(wait);
  }

  return parseGeminiBatchResponse_(response, articles);
}

/** Empty enrichment — fail-open on relevance so a bad call does not drop news. */
function emptyEnrichment_() {
  return {
    summary: '',
    sector: '',
    signal: '',
    justification: '',
    urgency: '',
    timing: '',
    relevant: true,
  };
}

function normalizeEnrichment_(parsed) {
  parsed = parsed || {};
  return {
    summary: parsed.summary || '',
    sector: CONFIG.SECTORS.indexOf(parsed.sector) >= 0 ? parsed.sector : '',
    signal: parsed.signal || '',
    justification: parsed.justification || '',
    urgency: (CONFIG.URGENCY_LEVELS || []).indexOf(parsed.urgency) >= 0 ? parsed.urgency : '',
    timing: (CONFIG.TIMING_WINDOWS || []).indexOf(parsed.timing) >= 0 ? parsed.timing : '',
    relevant: parsed.relevant !== false,
  };
}

/**
 * Shared judgment rules for one article (used inside a batch prompt).
 * @return {!Array<?string>}
 */
function geminiJudgmentRules_(article) {
  const dossier = article.about ? ` (${article.about})` : '';
  const relevanceRule = article.entity
    ? `RELEVANT: true only if this article is genuinely about ${article.entity}${dossier} — ` +
      `that specific company is a subject of the story, not merely name-dropped, cited as a ` +
      `comparison, listed among many brands in a roundup, quoted in a stock table or ` +
      `holdings report, or mentioned as a brand someone wore. A different company sharing ` +
      `the name is false. If the name appears only as an ordinary word rather than as this ` +
      `company, that is false. When the article is only tangentially connected, answer false.`
    : `RELEVANT: true only if this article is genuinely about the following subject: ` +
      `"${article.query || ''}"${dossier}. A passing mention is not enough. When in doubt, ` +
      `answer false.`;

  return [
    relevanceRule,
    '',
    `SUMMARY: exactly ${CONFIG.SUMMARY_SENTENCES} sentences of plain prose. Lead with what`,
    'actually happened, then why it matters commercially. State facts from the article only —',
    'no speculation, no "the article discusses", no hedging, no marketing language.',
    'If RELEVANT is false, summarize briefly anyway — it is used to spot bad filtering.',
    '',
    'SECTOR: the single best fit from the provided list, describing the sector the article is',
    'about — not the sector of whoever published it.',
    '',
    'SIGNAL: one short headline-style line (under 20 words) capturing the investment signal —',
    'what happened that a partner should notice. Not a full summary.',
    '',
    'JUSTIFICATION: 1-2 sentences explaining why this is (or is not) relevant to the subject',
    'company or topic. Be concrete.',
    '',
    'URGENCY: High if action or awareness is needed within days; Medium if important but not',
    'urgent; Low if background / nice-to-know.',
    '',
    'TIMING: Immediate if the event is happening now or just broke; This week if near-term;',
    'Monitoring if longer-horizon or ongoing.',
  ];
}

/**
 * Multi-article payload. One API call returns { items: [...] } with an
 * `index` matching the ARTICLE n blocks in the prompt.
 */
function buildGeminiBatchPayload_(articles, texts) {
  const textLimit = CONFIG.ARTICLE_TEXT_LIMIT || 2500;
  const blocks = articles.map((article, i) => {
    const raw = String(texts[i] || '');
    const text = raw.slice(0, textLimit);
    const hasBody = text.length > 200;
    return [
      `=== ARTICLE ${i} ===`,
      `HEADLINE: ${article.title}`,
      `PUBLISHER: ${article.source || 'unknown'}`,
      `URL: ${article.url || ''}`,
      article.entity ? `SUBJECT COMPANY: ${article.entity}` : null,
      article.entity && article.about ? `DOSSIER: ${article.about}` : null,
      !article.entity && article.query ? `SUBJECT TOPIC: ${article.query}` : null,
      '',
      hasBody
        ? `ARTICLE BODY:\n${text}`
        : '(no body available — paywall or blocked; work from the headline only, do not invent detail)',
      '',
    ].filter(line => line !== null).join('\n');
  });

  // Relevance rules differ per article when entities differ; spell the general
  // rule once, then remind that each ARTICLE n has its own SUBJECT COMPANY/TOPIC.
  const sample = articles[0] || { entity: null, query: '', about: '' };
  const prompt = [
    'You are building a research repository for an investment team.',
    '',
    `Judge EACH of the ${articles.length} news articles below. Return one result per article.`,
    'Use the `index` field to match ARTICLE n (0-based). Return exactly one item per article.',
    '',
    ...geminiJudgmentRules_(sample),
    '',
    'Apply the RELEVANT rule using each article\'s own SUBJECT COMPANY or SUBJECT TOPIC.',
    'For a company: relevant only if that company is a real subject of the story (not a name-drop).',
    'For a topic: relevant only if the article is genuinely about that subject.',
    '',
    'SECTOR must be one of: ' + CONFIG.SECTORS.join(', ') + '.',
    'URGENCY must be one of: ' + (CONFIG.URGENCY_LEVELS || []).join(', ') + '.',
    'TIMING must be one of: ' + (CONFIG.TIMING_WINDOWS || []).join(', ') + '.',
    '',
    blocks.join('\n'),
  ].join('\n');

  const itemSchema = {
    type: 'OBJECT',
    properties: {
      index: { type: 'INTEGER' },
      relevant: { type: 'BOOLEAN' },
      summary: { type: 'STRING' },
      sector: { type: 'STRING', enum: CONFIG.SECTORS },
      signal: { type: 'STRING' },
      justification: { type: 'STRING' },
      urgency: { type: 'STRING', enum: CONFIG.URGENCY_LEVELS },
      timing: { type: 'STRING', enum: CONFIG.TIMING_WINDOWS },
    },
    required: [
      'index', 'relevant', 'summary', 'sector',
      'signal', 'justification', 'urgency', 'timing',
    ],
  };

  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          items: { type: 'ARRAY', items: itemSchema },
        },
        required: ['items'],
      },
    },
  };

  if (CONFIG.GEMINI_THINKING_BUDGET !== null && CONFIG.GEMINI_THINKING_BUDGET !== undefined) {
    payload.generationConfig.thinkingConfig = { thinkingBudget: CONFIG.GEMINI_THINKING_BUDGET };
  }

  return payload;
}

/**
 * Single-article payload — kept for tests and as a clear unit of the prompt
 * rules. Production runs use buildGeminiBatchPayload_.
 */
function buildGeminiPayload_(article, text) {
  const hasBody = String(text || '').length > 200;
  const prompt = [
    'You are building a research repository for an investment team.',
    '',
    'Judge the news article below, summarize it, and classify it for a Signals sheet.',
    '',
    ...geminiJudgmentRules_(article),
    '',
    hasBody
      ? null
      : 'IMPORTANT: the article body could not be retrieved (paywall or blocked). Work from the ' +
        'headline alone, stay strictly within what it supports, and do not invent detail.',
    '---',
    `HEADLINE: ${article.title}`,
    `PUBLISHER: ${article.source || 'unknown'}`,
    article.entity ? `SUBJECT COMPANY: ${article.entity}` : null,
    '',
    hasBody ? `ARTICLE BODY:\n${text}` : '(no body available)',
    '---',
  ].filter(line => line !== null).join('\n');

  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          relevant: { type: 'BOOLEAN' },
          summary: { type: 'STRING' },
          sector: { type: 'STRING', enum: CONFIG.SECTORS },
          signal: { type: 'STRING' },
          justification: { type: 'STRING' },
          urgency: { type: 'STRING', enum: CONFIG.URGENCY_LEVELS },
          timing: { type: 'STRING', enum: CONFIG.TIMING_WINDOWS },
        },
        required: [
          'relevant', 'summary', 'sector',
          'signal', 'justification', 'urgency', 'timing',
        ],
      },
    },
  };

  if (CONFIG.GEMINI_THINKING_BUDGET !== null && CONFIG.GEMINI_THINKING_BUDGET !== undefined) {
    payload.generationConfig.thinkingConfig = { thinkingBudget: CONFIG.GEMINI_THINKING_BUDGET };
  }

  return payload;
}

/** Raw JSON object from a Gemini generateContent HTTP response, or null. */
function extractGeminiJson_(response, label) {
  if (!response) return null;

  if (response.getResponseCode() !== 200) {
    Logger.log(`Gemini ${response.getResponseCode()} for ${label}: ${response.getContentText().slice(0, 300)}`);
    return null;
  }

  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (err) {
    Logger.log(`Gemini returned non-JSON for ${label}: ${err}`);
    return null;
  }

  const candidate = body.candidates && body.candidates[0];
  if (!candidate) {
    Logger.log(`Gemini returned no candidate for ${label}: ${JSON.stringify(body.promptFeedback || body).slice(0, 300)}`);
    return null;
  }

  const part = candidate.content && candidate.content.parts && candidate.content.parts[0];
  if (!part || !part.text) {
    Logger.log(`Gemini candidate had no text for ${label} (finishReason: ${candidate.finishReason})`);
    return null;
  }

  try {
    return JSON.parse(part.text);
  } catch (err) {
    Logger.log(`Gemini JSON did not parse for ${label}: ${part.text.slice(0, 200)}`);
    return null;
  }
}

/**
 * Maps a batch response onto enrichments aligned with `articles`.
 * Missing indexes fail open (relevant: true, empty fields).
 */
function parseGeminiBatchResponse_(response, articles) {
  const label = `${articles.length} article chunk`;
  const parsed = extractGeminiJson_(response, label);
  const byIndex = {};

  if (parsed && Array.isArray(parsed.items)) {
    parsed.items.forEach(item => {
      if (item && typeof item.index === 'number') byIndex[item.index] = item;
    });
  } else if (parsed && typeof parsed.relevant === 'boolean') {
    // Defensive: model returned a single object instead of {items:[...]}.
    byIndex[0] = parsed;
  } else if (!parsed) {
    Logger.log(`Gemini batch failed for ${label} — failing open on all items.`);
  }

  return articles.map((article, i) => {
    if (!byIndex[i]) {
      if (parsed) {
        Logger.log(`Gemini batch missing index ${i} for "${article.title}" — failing open.`);
      }
      return emptyEnrichment_();
    }
    return normalizeEnrichment_(byIndex[i]);
  });
}

/**
 * Pulls enrichment fields out of a single-article Gemini response.
 * Kept for smoke tests; production uses parseGeminiBatchResponse_.
 */
function readGeminiResponse_(response, article) {
  const parsed = extractGeminiJson_(response, `"${article.title}"`);
  if (!parsed) {
    return {
      summary: '', sector: '', signal: '', justification: '', urgency: '', timing: '',
    };
  }
  return parsed;
}
