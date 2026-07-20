/**
 * ProbeSearch.gs — is Gemini's Google Search grounding a viable news source?
 *
 * Throwaway diagnostic. Delete once the question is settled.
 *
 * Grounding is attractive here because the search runs on Google's own
 * infrastructure: no shared-IP rate limiter (which is what GDELT blocks Apps
 * Script with), no 6s pacing, and Google Search relevance instead of GDELT's
 * full-text noise. But three things have to be true before rebuilding on it,
 * and none of them can be settled by reading docs:
 *
 *   1. Do the citation URLs resolve to real publishers? Grounding returns
 *      vertexaisearch.cloud.google.com/grounding-api-redirect/... links, which
 *      is the same shape that made Google News RSS useless — its redirects only
 *      resolved in a JS browser, so article bodies were unreachable and every
 *      summary silently degraded to a headline rephrase. If these resolve
 *      server-side we can store the REAL url and ignore the reported ~30-day
 *      expiry on the redirect. If they do not, grounding is a dead end for the
 *      same reason RSS was.
 *
 *   2. Does structured output survive? Gemini 2.5 rejects responseSchema when
 *      google_search is attached ("controlled generation is not supported with
 *      google_search tool"); only Gemini 3+ allows both. The sector enum and
 *      relevance boolean are ENFORCED by that schema, so without it they go
 *      back to being parsed out of free text.
 *
 *   3. Are dates available? GDELT hands over seendate. Grounding chunks carry
 *      uri/title/domain and no publication date, and the Date column is in the
 *      diagram. Resolving to the real article would let us scrape one.
 *
 * Run probeGeminiSearch() and read the log. Costs a couple of Gemini calls.
 */

/** One grounded search, fully inspected. */
function probeGeminiSearch() {
  const target = geminiRequestTarget_();
  Logger.log(`Model: ${CONFIG.GEMINI_MODEL}`);
  Logger.log(`Endpoint: ${target.url.split('?')[0]}\n`);

  // ---- 1. Grounded search, no schema ----------------------------------
  Logger.log('=== 1. Grounded search (no schema) ===');
  const grounded = probeCall_(target, {
    contents: [{
      role: 'user',
      parts: [{ text: 'Find recent news articles about the company Alation, the data ' +
                      'catalog software vendor. List each headline and its publisher.' }],
    }],
    tools: [{ googleSearch: {} }],
  });

  if (!grounded) {
    Logger.log('FAILED. Grounding is unavailable on this model/region — read the error above.');
    Logger.log('If it says the tool is unknown, try a Gemini 3 model in CONFIG.GEMINI_MODEL.');
    return;
  }

  const candidate = (grounded.candidates || [])[0] || {};
  const metadata = candidate.groundingMetadata || {};
  const chunks = metadata.groundingChunks || [];

  Logger.log(`Grounding chunks returned: ${chunks.length}`);
  if (!chunks.length) {
    Logger.log('No citations. Either the search found nothing, or grounding did not engage.');
    Logger.log(`Raw metadata: ${JSON.stringify(metadata).slice(0, 500)}`);
  }

  chunks.slice(0, 5).forEach((chunk, i) => {
    const web = chunk.web || {};
    Logger.log(`  [${i}] title:  ${String(web.title || '(none)').slice(0, 60)}`);
    Logger.log(`      domain: ${web.domain || '(none)'}`);
    Logger.log(`      uri:    ${String(web.uri || '(none)').slice(0, 90)}`);
  });

  // Does a chunk carry a date? The diagram has a Date column.
  const firstChunk = JSON.stringify((chunks[0] || {}));
  Logger.log(`\nAny date field in a chunk? ${/date|time|published/i.test(firstChunk) ? 'MAYBE' : 'NO'}`);
  Logger.log(`Raw first chunk: ${firstChunk.slice(0, 300)}`);

  // ---- 2. Do the redirect URLs actually resolve? -----------------------
  // This is the whole question. Google News RSS died here.
  Logger.log('\n=== 2. Do citation URLs resolve to real publishers? ===');
  const uri = chunks.length && chunks[0].web && chunks[0].web.uri;

  if (!uri) {
    Logger.log('No URI to test.');
  } else {
    const response = UrlFetchApp.fetch(uri, {
      method: 'get',
      followRedirects: true,
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                               '(KHTML, like Gecko) Chrome/122.0 Safari/537.36' },
    });

    const code = response.getResponseCode();
    const body = code === 200 ? stripHtml_(response.getContentText()) : '';
    Logger.log(`HTTP ${code}, ${body.length} chars of text after stripping.`);

    if (body.length > 200) {
      Logger.log('RESOLVES. The redirect reaches a real page and the body is readable.');
      Logger.log('=> We can resolve once at write time, store the REAL publisher URL,');
      Logger.log('   scrape a date, and the ~30-day redirect expiry stops mattering.');
      Logger.log(`Sample: ${body.slice(0, 200)}`);
    } else {
      Logger.log('DOES NOT RESOLVE to readable content.');
      Logger.log('=> Same failure as Google News RSS: no body means every summary would be');
      Logger.log('   written from a headline. Grounding would not be an upgrade.');
    }
  }

  // ---- 3. Grounding + structured output together ----------------------
  Logger.log('\n=== 3. Grounding + responseSchema together ===');
  const structured = probeCall_(target, {
    contents: [{ role: 'user', parts: [{ text: 'Find one recent news article about Alation.' }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { headline: { type: 'STRING' }, publisher: { type: 'STRING' } },
        required: ['headline', 'publisher'],
      },
    },
  });

  if (structured) {
    Logger.log('WORKS. Schema and grounding coexist on this model.');
    Logger.log('=> sector/relevance stay schema-enforced. Rebuild is straightforward.');
  } else {
    Logger.log('REJECTED (expected on Gemini 2.5 — only Gemini 3+ allows both).');
    Logger.log('=> Either move CONFIG.GEMINI_MODEL to a Gemini 3 model, or run two calls');
    Logger.log('   per company: one grounded search, one schema-enforced classify.');
  }

  Logger.log('\nDone. Paste this log back.');
}

/** POSTs a payload, logging any error. Returns parsed JSON or null. */
function probeCall_(target, payload) {
  const response = UrlFetchApp.fetch(target.url, {
    method: 'post',
    contentType: 'application/json',
    headers: target.headers,
    muteHttpExceptions: true,
    payload: JSON.stringify(payload),
  });

  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code !== 200) {
    Logger.log(`HTTP ${code}: ${text.slice(0, 400)}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    Logger.log(`Unparseable response: ${text.slice(0, 200)}`);
    return null;
  }
}
