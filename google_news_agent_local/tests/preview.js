/**
 * preview.js — does GDELT actually find YOUR companies?
 *
 *   node tests/preview.js
 *
 * No API keys. No Apps Script deploy. No Gemini calls. Nothing is written.
 * Reads the real PORTCOS / MAJOR_COMPANIES / DTC_NETWORK_COMPANIES /
 * INDUSTRY_TOPICS out of Config.gs and runs the real Fetch.gs code against
 * live GDELT, so you can put your names in Config.gs and know within a minute
 * whether this pipeline can work for them.
 *
 * Why this matters: GDELT matches full text. A company named after an ordinary
 * word ("Away", "Bark", "Ro") cannot be retrieved at any query formulation —
 * verified, not assumed. This tells you that in seconds instead of after a
 * month of empty rows.
 *
 *   node tests/preview.js --names "Away, Brightwheel"   check specific names
 *   node tests/preview.js --config                      preview the Config.gs arrays
 *   node tests/preview.js --config portco               ...just PortCo News
 *
 * When CONFIG.ENTITY_SOURCE is 'sheet' the names live in the spreadsheet,
 * which node cannot read — use --names, or run "Preview: what GDELT finds"
 * from the News Bot menu inside the Sheet.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const forceConfig = argv.indexOf('--config') !== -1;
const namesFlag = argv.indexOf('--names');
const explicitNames = namesFlag === -1
  ? null
  : String(argv[namesFlag + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
const filter = (argv.filter(a => !a.startsWith('--'))[explicitNames ? 1 : 0] || '').toLowerCase();

// UrlFetchApp is synchronous; curl via execFileSync matches that shape.
function curl(url, opts) {
  const args = ['-s', '-w', '\\n__CODE__%{http_code}', '--max-time', '45'];
  const headers = (opts && opts.headers) || {};
  for (const k of Object.keys(headers)) args.push('-H', `${k}: ${headers[k]}`);
  args.push(url);
  let out;
  try {
    out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    return { getResponseCode: () => 0, getContentText: () => String(e) };
  }
  const i = out.lastIndexOf('\n__CODE__');
  return {
    getResponseCode: () => (i === -1 ? 0 : parseInt(out.slice(i + 9).trim(), 10)),
    getContentText: () => (i === -1 ? out : out.slice(0, i)),
  };
}

const sandbox = {
  Logger: { log: m => console.log('    ' + String(m).slice(0, 150)) },
  Utilities: {
    // Blocking sleep, so GDELT's rate limit is respected exactly as in production.
    sleep: ms => execFileSync(process.execPath, ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms})`]),
  },
  UrlFetchApp: { fetch: (u, o) => curl(u, o), fetchAll: rs => rs.map(r => curl(r.url, r)) },
  console,
};
vm.createContext(sandbox);
for (const f of ['Config.gs', 'Fetch.gs', 'SheetEntities.gs']) {
  vm.runInContext(fs.readFileSync(path.join(PROJECT, f), 'utf8'), sandbox, { filename: f });
}
const CONFIG = vm.runInContext('CONFIG', sandbox);
const REPOSITORIES = vm.runInContext('REPOSITORIES', sandbox);

// Names in the sheet are unreachable from here — there is no SpreadsheetApp
// outside Apps Script. Say so plainly instead of dying on a ReferenceError.
if (CONFIG.ENTITY_SOURCE === 'sheet' && !explicitNames && !forceConfig) {
  console.log('CONFIG.ENTITY_SOURCE is "sheet", so your company names live in the');
  console.log('spreadsheet. node cannot read it. Two ways to preview:');
  console.log('');
  console.log('  1. In the Sheet:  News Bot > Preview: what GDELT finds');
  console.log('     Reads the real tabs. This is the one that matches production.');
  console.log('');
  console.log('  2. Here, with names typed in:');
  console.log('       node tests/preview.js --names "Away, Brightwheel, Faire"');
  console.log('     Good for checking whether GDELT can find a name before you');
  console.log('     add it to the sheet.');
  console.log('');
  console.log('  (node tests/preview.js --config previews the Config.gs arrays,');
  console.log('   which are placeholders unless you have edited them.)');
  process.exit(0);
}

// --names bypasses both the sheet and the config arrays.
const repos = explicitNames
  ? [{
      tab: `Ad-hoc names (${explicitNames.length})`,
      buildQueries: () => explicitNames.map(n => sandbox.entityQuery_({ name: n, about: '' })),
    }]
  : REPOSITORIES.filter(r => r.wired)
      .filter(r => !filter || r.tab.toLowerCase().includes(filter));

if (!repos.length) {
  console.log(`No wired repository matches "${filter}".`);
  console.log('Wired: ' + REPOSITORIES.filter(r => r.wired).map(r => r.tab).join(', '));
  process.exit(1);
}

// buildQueries would hit the sheet otherwise; --config / --names are local.
if (!explicitNames) CONFIG.ENTITY_SOURCE = 'config';

console.log(explicitNames
  ? `Checking what GDELT returns for: ${explicitNames.join(', ')}`
  : 'Checking what GDELT returns for the Config.gs arrays.');
console.log('No keys used, no Gemini calls, nothing written.');
console.log(`Pacing at ${CONFIG.GDELT_REQUEST_INTERVAL_MS}ms between queries (GDELT rate-limits).`);

const dead = [];
const failed = [];
const noDossier = [];
let totalQueries = 0;

repos.forEach(repo => {
  console.log('');
  console.log('='.repeat(72));
  console.log(repo.tab);
  console.log('='.repeat(72));

  repo.buildQueries().forEach((query, i) => {
    if (totalQueries++ > 0) sandbox.Utilities.sleep(CONFIG.GDELT_REQUEST_INTERVAL_MS);

    const items = sandbox.fetchGdeltQuery_(query.q);
    const label = query.entity || query.q;

    console.log('');
    console.log(`  ${label}  —  ${items === null ? 'QUERY FAILED' : items.length + ' articles'}`);
    console.log(`  query sent: ${sandbox.buildGdeltQuery_(query.q)}`);
    if (query.about) {
      console.log(`  about: ${query.about}`);
    } else {
      console.log('  about: (NOT SET — Gemini will judge relevance blind)');
      noDossier.push(label);
    }

    // null means GDELT never answered. That is NOT the same as "no articles",
    // and calling it "unfindable" would be a wrong diagnosis about a name that
    // may work perfectly.
    if (items === null) {
      failed.push(label);
      console.log('  >> GDELT did not answer (rate limited). This says NOTHING about the name.');
      console.log('     Re-run in a minute, or raise GDELT_REQUEST_INTERVAL_MS.');
      return;
    }

    const articles = sandbox.dedupeArticles_(
      items.slice(0, CONFIG.MAX_ARTICLES_PER_QUERY)
        .map(item => sandbox.articleFromGdeltItem_(item, query))
        .filter(Boolean)
    );

    if (!articles.length) {
      dead.push(label);
      console.log('  >> NOTHING FOUND. GDELT answered, and had nothing. Either too obscure,');
      console.log('     or a common word that no query can isolate. Config cannot fix that.');
      return;
    }
    articles.forEach(a => {
      console.log(`     [${String(a.source).padEnd(22).slice(0, 22)}] ${String(a.title).slice(0, 58)}`);
    });
  });
});

console.log('');
console.log('='.repeat(72));
console.log('Read the titles above. Some noise is EXPECTED — Gemini filters it.');
console.log('What you are looking for is an entity where NOTHING is ever about the');
console.log('company. That one will never produce a row, and will burn a Gemini call');
console.log('per article every run.');

if (failed.length) {
  console.log('');
  console.log(`GDELT never answered for: ${failed.join(', ')}`);
  console.log('  -> rate limiting, NOT a verdict on these names. Re-run to judge them.');
}
if (dead.length) {
  console.log('');
  console.log(`GDELT answered with zero articles: ${dead.join(', ')}`);
  console.log('  -> too obscure, or a common-word name. Check the spelling first.');
}
if (!failed.length && !dead.length) {
  console.log('');
  console.log('Every entity returned articles. Nothing is structurally broken.');
}
if (noDossier.length) {
  console.log('');
  console.log(`Missing an "about" line: ${noDossier.join(', ')}`);
  console.log('  -> add one in Config.gs. It is free and it is the main precision lever.');
}
console.log('');
console.log('Next: paste keys, then "Check Vertex auth", then "Dry run" in the Sheet.');
