/**
 * Batch.gs — process a slice of entities per run, remembering the position.
 *
 * GDELT allows ~1 request per 6 seconds; Apps Script kills a run at 6 min
 * (consumer) or 30 min (Workspace). 81 PortCos therefore cannot be covered in
 * one execution — 8 minutes of the run would be pure sleeping.
 *
 * Each run takes CONFIG.BATCH_SIZE entities and stores where it stopped. The
 * next run resumes there and wraps around, so a recurring trigger walks the
 * whole list. LOOKBACK_DAYS is the safety net: as long as the window is wider
 * than one full pass, an entity being visited only every few hours loses
 * nothing — it still sees every story in its lookback.
 *
 * Cursors are namespaced, so previewing does not advance the real run's
 * position (or you would preview one slice and then run a different one).
 */

const CURSOR_PREFIX = 'batch_cursor_';

/**
 * The slice of `queries` this run should process, advancing the cursor.
 *
 * @param {string} namespace e.g. 'run' or 'preview' — separate positions
 * @param {string} tab repository tab name, so each list tracks its own place
 * @param {!Array<*>} queries every entity for the repository
 * @return {!Array<*>} the slice to process now
 */
function nextBatch_(namespace, tab, queries) {
  const size = CONFIG.BATCH_SIZE;

  // 0/unset means "no batching", and a list that already fits needs no cursor.
  if (!size || size <= 0 || queries.length <= size) return queries;

  const properties = PropertiesService.getScriptProperties();
  const key = CURSOR_PREFIX + namespace + '_' + tab;

  const stored = parseInt(properties.getProperty(key) || '0', 10);
  // Guard against a stale cursor left over from a shorter list.
  const start = (isNaN(stored) ? 0 : stored) % queries.length;

  const slice = [];
  for (let i = 0; i < size; i++) {
    slice.push(queries[(start + i) % queries.length]);
  }

  const next = (start + size) % queries.length;
  properties.setProperty(key, String(next));

  const last = start + size;
  Logger.log(
    `"${tab}": entities ${start + 1}-${Math.min(last, queries.length)}` +
    (last > queries.length ? ` and 1-${last - queries.length}` : '') +
    ` of ${queries.length}` +
    (next <= start ? ' (completing a full pass)' : '') +
    `. Next run starts at ${next + 1}.`
  );

  return slice;
}

/** Sends every repository back to the top of its list. */
function resetBatchCursors() {
  const properties = PropertiesService.getScriptProperties();
  const removed = Object.keys(properties.getProperties())
    .filter(k => k.indexOf(CURSOR_PREFIX) === 0);

  removed.forEach(k => properties.deleteProperty(k));
  Logger.log(`Reset ${removed.length} batch cursor(s). Every repository starts from entity 1.`);
}

/** Prints where each repository will resume, without running anything. */
function showBatchProgress() {
  const properties = PropertiesService.getScriptProperties();

  if (!CONFIG.BATCH_SIZE) {
    Logger.log('BATCH_SIZE is 0 — batching is off and every run covers every entity.');
    return;
  }

  REPOSITORIES.filter(repo => repo.wired).forEach(repo => {
    const total = repo.buildQueries().length;
    const stored = parseInt(properties.getProperty(CURSOR_PREFIX + 'run_' + repo.tab) || '0', 10);
    const at = (isNaN(stored) ? 0 : stored) % (total || 1);
    const runsPerPass = Math.ceil(total / CONFIG.BATCH_SIZE);

    Logger.log(
      `"${repo.tab}": ${total} entities, ${CONFIG.BATCH_SIZE}/run, resuming at ${at + 1}. ` +
      `${runsPerPass} run(s) per full pass.`
    );
  });

  Logger.log(
    `\nKeep LOOKBACK_DAYS (${CONFIG.LOOKBACK_DAYS}) comfortably wider than one full pass, ` +
    `or an entity can miss stories between visits.`
  );
}
