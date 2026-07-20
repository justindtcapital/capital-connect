/**
 * Main.gs — entry points.
 *
 * Pipeline per repository:
 *   build queries -> search (Perplexity) -> drop URLs already in the tab
 *   -> article text (search snippet, scraping only what needs it)
 *   -> Gemini (relevance + summary + sector) -> drop irrelevant -> append rows
 *
 * Nothing hits Gemini until after the dedupe step, so re-running costs
 * nothing for stories you already have.
 */

/** Adds the menu when the Sheet opens. Bound scripts only. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('News Bot')
    .addItem('Run all → Signals', 'runAll')
    .addSeparator()
    .addItem('Run: PortCo News → Signals', 'runPortCoNews')
    .addItem('Run: Industry News → Signals', 'runIndustryNews')
    .addItem('Run: Major Company News → Signals', 'runMajorCompanyNews')
    .addItem('Run: DTC Network Companies News → Signals', 'runDtcNetworkNews')
    .addSeparator()
    .addItem('Inspect sheet: tabs and headers', 'inspectSheet')
    .addItem('Preview: what search finds (no Gemini)', 'previewNews')
    .addItem('Dry run: PortCo News (no writes)', 'dryRunPortCoNews')
    .addSeparator()
    .addItem('Set up tabs only', 'setupTabs')
    .addItem('Check Vertex auth', 'checkVertexAuth')
    .addItem('Check Perplexity key', 'checkPerplexity')
    .addItem('Check NewsAPI key', 'checkNewsApi')
    .addSeparator()
    .addItem('Batch progress: where each list resumes', 'showBatchProgress')
    .addItem('Reset batch cursors', 'resetBatchCursors')
    .addItem('Install hourly trigger', 'installHourlyTrigger')
    .addItem('Remove triggers', 'removeTriggers')
    .addToUi();
}

/**
 * Creates and formats all seven tabs without fetching anything.
 * Run this once first — it is the cheapest way to confirm the workbook
 * matches the diagram before you spend any API quota.
 */
function setupTabs() {
  // When OUTPUT_TAB is set, every repo maps to the same sheet — ensure it once.
  if (String(CONFIG.OUTPUT_TAB || '').trim()) {
    ensureTab_(REPOSITORIES[0]);
    Logger.log(`Ready: shared output tab "${sheetTab_(REPOSITORIES[0])}".`);
    return;
  }
  REPOSITORIES.forEach(repo => ensureTab_(repo));
  Logger.log(`Ready: ${REPOSITORIES.length} tabs.`);
}

/** Runs every wired repository. This is what the daily trigger calls. */
function runAll() {
  const outTab = sheetTab_(REPOSITORIES[0]);
  Logger.log(`Run all → writing every repository into "${outTab}".`);

  const summary = [];
  REPOSITORIES.forEach(repo => {
    ensureTab_(repo);
    if (!repo.wired) {
      Logger.log(`Skipping "${repo.tab}" — not wired. ${repo.note}`);
      return;
    }
    try {
      const added = runRepository_(repo);
      summary.push(`${repo.tab}: +${added}`);
    } catch (err) {
      Logger.log(`"${repo.tab}" failed: ${err.stack || err}`);
      summary.push(`${repo.tab}: FAILED (${err.message})`);
    }
  });
  Logger.log(`Run complete (all rows in "${outTab}") — ` + summary.join(' | '));
}

function runPortCoNews() { runByTab_('PortCo News'); }
function runIndustryNews() { runByTab_('Industry News'); }
function runMajorCompanyNews() { runByTab_('Major Company News'); }
function runDtcNetworkNews() { runByTab_('DTC Network Companies News'); }

function runByTab_(tabName) {
  const repo = REPOSITORIES.filter(r => r.tab === tabName)[0];
  if (!repo) throw new Error(`No repository named "${tabName}".`);
  ensureTab_(repo);
  if (!repo.wired) throw new Error(`"${tabName}" has no data source wired. ${repo.note}`);
  const added = runRepository_(repo);
  Logger.log(`${tabName}: +${added} rows → "${sheetTab_(repo)}".`);
}

/**
 * @param {!Object} repo
 * @return {number} rows appended
 */
function runRepository_(repo) {
  const sheet = ensureTab_(repo);

  const all = repo.buildQueries();
  if (!all.length) {
    Logger.log(`"${repo.tab}" has no queries — check the entity lists in Config.gs.`);
    return 0;
  }

  // Only matters when BATCH_SIZE is on — a GDELT concession, since its 6s
  // pacing could not fit 81 entities in one execution. Perplexity has no
  // pacing, so BATCH_SIZE 0 covers everything every run.
  const queries = nextBatch_('run', repo.tab, all);
  Logger.log(
    `"${repo.tab}": searching ${queries.length}/${all.length} entities via ` +
    `${newsProviders_().join(' + ')}...`
  );

  const found = fetchNews_(queries);
  Logger.log(`"${repo.tab}": ${found.length} articles from ${queries.length} queries.`);
  if (!found.length) return 0;

  const seen = existingUrls_(sheet, repo);
  let fresh = found.filter(article => !seen.has(normalizeUrl_(article.url)));
  Logger.log(`"${repo.tab}": ${fresh.length} new after dedupe.`);
  if (!fresh.length) return 0;

  // Newest first within this run — then cap so the quota budget keeps recent news.
  fresh.sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));

  const maxNew = CONFIG.MAX_NEW_ARTICLES_PER_REPO || 0;
  if (maxNew > 0 && fresh.length > maxNew) {
    Logger.log(
      `"${repo.tab}": capping ${fresh.length} new articles to ${maxNew} ` +
      `(MAX_NEW_ARTICLES_PER_REPO) to stay within Gemini quota.`
    );
    fresh = fresh.slice(0, maxNew);
  }

  // Snippet first, scrape only what needs it.
  const texts = articleTexts_(fresh);
  const blocked = texts.filter(t => t.length <= 200).length;
  if (blocked) {
    Logger.log(`"${repo.tab}": ${blocked}/${fresh.length} articles unreadable (paywall or block) — summarizing from headline.`);
  }

  const enrichments = summarizeArticles_(fresh, texts);

  // Search over-returns, so Gemini's relevance verdict is what keeps the
  // repository clean. Pair each article with its verdict before filtering, so
  // the two can never drift out of alignment.
  let judged = fresh.map((article, i) => ({ article: article, enrichment: enrichments[i] }));

  if (CONFIG.DROP_IRRELEVANT) {
    const kept = judged.filter(pair => pair.enrichment.relevant);
    const dropped = judged.length - kept.length;
    if (dropped) {
      Logger.log(
        `"${repo.tab}": dropped ${dropped}/${judged.length} as irrelevant — ` +
        judged.filter(p => !p.enrichment.relevant)
          .map(p => `"${p.article.title.slice(0, 60)}"`).join(', ')
      );
    }
    if (dropped && !kept.length) {
      Logger.log(
        `"${repo.tab}": everything was judged irrelevant. If that looks wrong, the ` +
        `dossier ("about") for these entities is probably wrong or missing.`
      );
    }
    judged = kept;
  }

  if (!judged.length) return 0;

  const rows = judged.map(pair => buildRow_(repo, pair.article, pair.enrichment));
  appendRows_(sheet, repo, rows);
  Logger.log(
    `"${repo.tab}": wrote ${rows.length} row(s) → "${sheetTab_(repo)}" ` +
    `(types: ${rows.filter(r => r[2] === 'recommendation').length} recommendation, ` +
    `${rows.filter(r => r[2] === 'awareness').length} awareness).`
  );
  return rows.length;
}

/**
 * Search only — no Gemini calls, no sheet writes.
 *
 * Run this FIRST, right after putting your real names in the sheet. It answers
 * the one question that decides whether any of this works: does the search
 * actually find each of your companies?
 *
 * Works against whichever CONFIG.NEWS_SOURCE is set, so it always previews
 * exactly what a real run would retrieve.
 */
function previewNews() {
  Logger.log(`Source(s): ${newsProviders_().join(' + ')}\n`);

  REPOSITORIES.filter(repo => repo.wired).forEach(repo => {
    Logger.log(`=========== ${repo.tab} ===========`);

    // Batched on its own cursor, so previewing never moves the real run's
    // position. Run preview repeatedly to walk a long list.
    const queries = nextBatch_('preview', repo.tab, repo.buildQueries());
    if (!queries.length) {
      Logger.log('No entities — check the tab mapping in CONFIG.ENTITY_SOURCES.\n');
      return;
    }

    const articles = fetchNews_(queries);

    // Seed every entity so the ones that found NOTHING still appear. Those are
    // the whole point of this report.
    const byEntity = {};
    queries.forEach(query => { byEntity[query.entity || query.q] = []; });
    articles.forEach(article => {
      const label = article.entity || article.query;
      if (!byEntity[label]) byEntity[label] = [];
      byEntity[label].push(article);
    });

    Object.keys(byEntity).forEach(label => {
      const found = byEntity[label];
      Logger.log(`
${label} — ${found.length} articles`);

      if (!found.length) {
        Logger.log('   NOTHING FOUND. Check the name spelling first; if it is right, this ' +
                   'entity will never produce a row.');
        return;
      }

      found.forEach(article => {
        const snippet = String(article.snippet || '').length;
        Logger.log(`   - [${article.source}] ${article.title.slice(0, 70)}`);
        Logger.log(`     ${article.date ? article.date.toISOString().slice(0, 10) : 'no date'}` +
                   ` | snippet ${snippet} chars` +
                   (snippet >= CONFIG.SNIPPET_MIN_CHARS ? ' (no scrape needed)' : ' (would scrape)'));
      });
    });
    Logger.log('');
  });

  Logger.log('Preview only. No Gemini calls, nothing written.');
  Logger.log('Some noise is EXPECTED — Gemini filters it. What matters is an entity where');
  Logger.log('NOTHING returned is ever about the company.');
}

/**
 * Full pipeline for one repository, but nothing is written.
 *
 * This is the tool for tuning your `about` lines: it prints Gemini's KEEP/DROP
 * verdict, the sector, how much article body it actually got, and the summary.
 * If real news is being dropped, the dossier is wrong. If junk is kept, the
 * dossier is too vague.
 *
 * Skips the dedupe against existing rows on purpose — you want to see verdicts
 * on everything, not just what happens to be new today.
 *
 * Costs one Gemini call per article, so it obeys MAX_ARTICLES_PER_QUERY. Drop
 * that to 2-3 while tuning.
 */
function dryRunPortCoNews() { dryRunRepository_('PortCo News'); }

function dryRunRepository_(tabName) {
  const repo = REPOSITORIES.filter(r => r.tab === tabName)[0];
  if (!repo) throw new Error(`No repository named "${tabName}".`);
  if (!repo.wired) throw new Error(`"${tabName}" has no data source wired.`);

  const found = fetchNews_(repo.buildQueries());
  Logger.log(`${found.length} articles after dedupe. Summarizing all of them...`);
  if (!found.length) {
    Logger.log('Nothing retrieved — run "Preview: what GDELT finds" to see why.');
    return;
  }

  const texts = articleTexts_(found);
  const enrichments = summarizeArticles_(found, texts);

  let kept = 0;
  found.forEach((article, i) => {
    const enrichment = enrichments[i];
    if (enrichment.relevant) kept++;
    const body = texts[i].length > 200 ? `${texts[i].length} chars` : 'UNREADABLE (headline only)';
    Logger.log(
      `\n${enrichment.relevant ? 'KEEP' : 'DROP'}  [${article.entity || '-'}] ` +
      `${article.title.slice(0, 70)}\n` +
      `      ${article.source} | category: ${enrichment.sector || '(none)'} | ` +
      `urgency: ${enrichment.urgency || '(none)'} | body: ${body}\n` +
      `      signal: ${enrichment.signal || '(none)'}\n` +
      `      ${enrichment.summary || '(no summary)'}`
    );
  });

  Logger.log(`\nWould write ${kept}/${found.length} rows. NOTHING WAS WRITTEN.`);
  Logger.log('If real news shows DROP, the "about" line for that entity needs work. ' +
             'If junk shows KEEP, make "about" more specific.');
}

/**
 * Hourly run. This is the right choice once BATCH_SIZE is on: a daily trigger
 * would only ever cover the first slice of each list, so most of your
 * companies would never be searched at all.
 */
function installHourlyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('runAll').timeBased().everyHours(1).create();

  const passes = REPOSITORIES.filter(r => r.wired).map(repo => {
    const total = repo.buildQueries().length;
    const runs = CONFIG.BATCH_SIZE ? Math.ceil(total / CONFIG.BATCH_SIZE) : 1;
    return `${repo.tab}: ${runs}h per full pass`;
  });
  Logger.log(`Hourly trigger installed.\n${passes.join('\n')}`);
  Logger.log(`\nLOOKBACK_DAYS is ${CONFIG.LOOKBACK_DAYS}, which must stay wider than the ` +
             `slowest pass above or entities will miss stories between visits.`);
}

/**
 * Daily run at 6am in the script's timezone (set in appsscript.json).
 * Only appropriate when BATCH_SIZE is 0 — otherwise use the hourly trigger,
 * or you will only ever search the first BATCH_SIZE entities of each list.
 */
function installDailyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('runAll').timeBased().atHour(6).everyDays(1).create();

  if (CONFIG.BATCH_SIZE) {
    const worst = Math.max.apply(null, REPOSITORIES.filter(r => r.wired)
      .map(r => Math.ceil(r.buildQueries().length / CONFIG.BATCH_SIZE)));
    if (worst > 1) {
      Logger.log(
        `WARNING: BATCH_SIZE is ${CONFIG.BATCH_SIZE}, so a full pass takes ${worst} runs. ` +
        `Once a day means ${worst} DAYS to cover every entity, and LOOKBACK_DAYS is only ` +
        `${CONFIG.LOOKBACK_DAYS}. Use "Install hourly trigger" instead.`
      );
    }
  }
  Logger.log('Daily trigger installed for ~6am.');
}

function removeTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'runAll')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  Logger.log('Triggers removed.');
}
