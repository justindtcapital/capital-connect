/**
 * Sheets.gs — tab creation, formatting, dedupe, and appends.
 */

const HEADER_BACKGROUND = '#38761d';
const HEADER_FOREGROUND = '#ffffff';

const WRAP_HEADERS_ = ['Body', 'Signal', 'Justification', 'Subject'];

function getSpreadsheet_() {
  if (CONFIG.SPREADSHEET_ID) {
    return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error(
      'No spreadsheet found. Either bind this script to a Sheet (Extensions > Apps Script ' +
      'from within the Sheet), or set CONFIG.SPREADSHEET_ID in Config.gs.'
    );
  }
  return active;
}

/**
 * Creates the tab if missing and (re)applies header row + formatting.
 * Safe to call on every run — it never touches existing data rows.
 *
 * @return {!Sheet}
 */
function ensureTab_(repo) {
  const spreadsheet = getSpreadsheet_();
  const headers = headersFor_(repo);
  const tabName = sheetTab_(repo);

  let sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(tabName);
  }
  ensureRowCapacity_(sheet, 2);

  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange
    .setFontWeight('bold')
    .setBackground(HEADER_BACKGROUND)
    .setFontColor(HEADER_FOREGROUND)
    .setVerticalAlignment('middle');

  sheet.setFrozenRows(1);

  headers.forEach((header, i) => {
    const column = i + 1;
    if (WRAP_HEADERS_.indexOf(header) >= 0) {
      sheet.setColumnWidth(column, header === 'Body' ? 520 : 280);
      sheet.getRange(1, column, sheet.getMaxRows()).setWrap(true);
    } else if (header === 'Source URL') {
      sheet.setColumnWidth(column, 260);
    } else if (header === 'Date Found') {
      sheet.setColumnWidth(column, 110);
      sheet.getRange(2, column, Math.max(sheet.getMaxRows() - 1, 1))
        .setNumberFormat('yyyy-mm-dd');
    } else if (header === 'ID') {
      sheet.setColumnWidth(column, 280);
    } else {
      sheet.setColumnWidth(column, 140);
    }
  });

  // Data rows top-align so a long body does not vertically center the row.
  if (sheet.getMaxRows() > 1) {
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, headers.length).setVerticalAlignment('top');
  }

  return sheet;
}

/**
 * URLs already present in the tab, normalized for comparison.
 * Used to skip articles we have already summarized — the point is to not
 * pay Gemini twice for the same story.
 *
 * @return {!Set<string>}
 */
function existingUrls_(sheet, repo) {
  const urlColumn = headersFor_(repo).indexOf('Source URL') + 1;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2 || urlColumn < 1) return new Set();

  const values = sheet.getRange(2, urlColumn, lastRow - 1, 1).getValues();
  const urls = new Set();
  values.forEach(row => {
    const url = String(row[0] || '').trim();
    if (url) urls.add(normalizeUrl_(url));
  });
  return urls;
}

/**
 * Appends rows below existing data. Newest-first ordering within a run;
 * older runs stay above, so the tab reads as an accumulating log.
 */
function appendRows_(sheet, repo, rows) {
  if (!rows.length) return;
  const headers = headersFor_(repo);
  const startRow = Math.max(sheet.getLastRow() + 1, 2);

  // getRange throws if it reaches past the sheet's allocated rows, which a
  // long-accumulating tab eventually will.
  ensureRowCapacity_(sheet, startRow + rows.length - 1);

  sheet.getRange(startRow, 1, rows.length, headers.length).setValues(rows);

  const dateColumn = headers.indexOf('Date Found') + 1;
  if (dateColumn > 0) {
    sheet.getRange(startRow, dateColumn, rows.length, 1).setNumberFormat('yyyy-mm-dd');
  }
  sheet.getRange(startRow, 1, rows.length, headers.length).setVerticalAlignment('top');
}

/** Grows the sheet if it does not have room down to `neededRow`. */
function ensureRowCapacity_(sheet, neededRow) {
  const deficit = neededRow - sheet.getMaxRows();
  if (deficit > 0) sheet.insertRowsAfter(sheet.getMaxRows(), deficit);
}

/**
 * Builds one sheet row in CONFIG.SIGNAL_HEADERS order.
 *
 * Same shape for every repository (Industry News, PortCo, Major, DTC).
 * The /signals page only keeps Type = recommendation | awareness and needs
 * signal or company set — empty Gemini fields used to make PortCo/DTC rows
 * look broken next to Industry News. Fallbacks keep the dump consistent.
 */
function buildRow_(repo, article, enrichment) {
  const e = enrichment || {};
  const title = String(article.title || '').trim();
  const signal = String(e.signal || '').trim() || title;
  const body = String(e.summary || '').trim() || title;
  const category = String(e.sector || '').trim() || 'Other';
  const justification = String(e.justification || '').trim() ||
    (e.relevant === false ? 'Flagged irrelevant by model.' : 'From news scan.');
  const urgency = String(e.urgency || '').trim() || 'Medium';
  const timing = String(e.timing || '').trim() || 'This week';

  return [
    Utilities.getUuid(),
    new Date(),
    signalType_(Object.assign({}, e, { urgency: urgency })),
    'New',
    '',
    article.entity || '',
    '',
    category,
    signal,
    article.url || '',
    title,
    body,
    signalRelevanceScore_(Object.assign({}, e, { urgency: urgency })),
    justification,
    urgency,
    timing,
  ];
}

/**
 * /signals keeps only recommendation | awareness.
 * This bot is a news digester (same as Industry News): default awareness.
 * High urgency stays recommendation so hot PortCo hits still surface as such.
 */
function signalType_(enrichment) {
  if (enrichment && enrichment.relevant !== false && enrichment.urgency === 'High') {
    return 'recommendation';
  }
  return 'awareness';
}

/** Map urgency → 1–10 so the feed can sort/score like the main app. */
function signalRelevanceScore_(enrichment) {
  if (!enrichment || enrichment.relevant === false) return 3;
  if (enrichment.urgency === 'High') return 8;
  if (enrichment.urgency === 'Medium') return 6;
  if (enrichment.urgency === 'Low') return 4;
  return 5;
}
