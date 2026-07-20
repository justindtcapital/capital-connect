/**
 * SheetEntities.gs — read entity lists from tabs instead of Config.gs.
 *
 * Lets whoever maintains the portfolio add a company in the spreadsheet
 * without touching code. CONFIG.ENTITY_SOURCES says which tab and column
 * feeds each list; CONFIG.ENTITY_SOURCE flips the whole thing back to the
 * hardcoded arrays if you ever need to.
 *
 * Columns are matched by HEADER TEXT, never by position, so inserting or
 * reordering columns in the sheet cannot silently start reading the wrong
 * one. Matching ignores case, spacing, and punctuation — "Companys",
 * "Company's" and "COMPANYS" are the same header.
 *
 * Every failure names the tabs or headers that actually exist, because a
 * typo'd tab name would otherwise look exactly like "no companies today".
 */

/**
 * Entity list for a CONFIG key ('PORTCOS', 'MAJOR_COMPANIES', ...).
 * Returns entries in the same shape Config.gs uses, so everything
 * downstream is unchanged.
 *
 * @param {string} key
 * @return {!Array<{name: string, about: string}>}
 */
function entityList_(key) {
  if (CONFIG.ENTITY_SOURCE !== 'sheet') {
    return CONFIG[key] || [];
  }

  const source = CONFIG.ENTITY_SOURCES && CONFIG.ENTITY_SOURCES[key];
  if (!source || !source.tab) {
    // No tab mapped: fall back rather than fail. Lets you move lists into
    // the sheet one at a time.
    return CONFIG[key] || [];
  }

  return readEntityTab_(source, key);
}

/**
 * @param {{tab: string, nameHeader: string, aboutHeader: (string|undefined),
 *          headerRow: (number|undefined)}} source
 * @param {string} key CONFIG key, for error messages
 * @return {!Array<{name: string, about: string}>}
 */
function readEntityTab_(source, key) {
  const spreadsheet = getSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(source.tab);

  if (!sheet) {
    throw new Error(
      `${key}: tab "${source.tab}" does not exist. Tabs in this spreadsheet: ` +
      spreadsheet.getSheets().map(s => `"${s.getName()}"`).join(', ') +
      `. Fix CONFIG.ENTITY_SOURCES.${key}.tab, or run "Inspect sheet: tabs and headers".`
    );
  }

  const values = sheet.getDataRange().getValues();
  const headerRowIndex = (source.headerRow || 1) - 1;

  if (values.length <= headerRowIndex) {
    throw new Error(`${key}: tab "${source.tab}" has no header row at row ${headerRowIndex + 1}.`);
  }

  const headers = values[headerRowIndex].map(normalizeHeader_);
  const shown = values[headerRowIndex].map(h => `"${h}"`).join(', ');

  const nameColumn = headers.indexOf(normalizeHeader_(source.nameHeader));
  if (nameColumn === -1) {
    throw new Error(
      `${key}: no column headed "${source.nameHeader}" in tab "${source.tab}". ` +
      `Headers found on row ${headerRowIndex + 1}: ${shown}. ` +
      `Fix CONFIG.ENTITY_SOURCES.${key}.nameHeader.`
    );
  }

  // Dossier columns are optional, and there can be several — a real sheet
  // rarely has one tidy "About" column, but often has two or three that add
  // up to one (Focus Area(s) + HQ + Summary). Each configured-and-missing one
  // is a typo worth shouting about rather than silently dropping.
  const aboutColumns = aboutHeaders_(source).map(header => {
    const column = headers.indexOf(normalizeHeader_(header));
    if (column === -1) {
      Logger.log(
        `WARNING: ${key} — no column headed "${header}" in "${source.tab}". Headers: ${shown}.`
      );
    }
    return { header: header, column: column };
  }).filter(c => c.column !== -1);

  if (!aboutColumns.length && aboutHeaders_(source).length) {
    Logger.log(
      `WARNING: ${key} — no dossier column resolved. Relevance will be guesswork. ` +
      `Pick real headers from: ${shown}`
    );
  }

  const entities = [];
  const seen = {};

  for (let row = headerRowIndex + 1; row < values.length; row++) {
    const name = String(values[row][nameColumn] || '').trim();
    if (!name) continue;  // blank rows and spacers

    const dedupeKey = name.toLowerCase();
    if (seen[dedupeKey]) continue;  // same company listed twice
    seen[dedupeKey] = true;

    entities.push({
      name: name,
      about: buildAbout_(values[row], aboutColumns, aboutHeaders_(source).length > 1),
    });
  }

  const missingAbout = entities.filter(e => !e.about).length;
  Logger.log(
    `${key}: ${entities.length} from "${source.tab}"` +
    (missingAbout ? ` (${missingAbout} with no "about" — relevance is weaker for those)` : '')
  );

  if (!entities.length) {
    Logger.log(
      `WARNING: ${key} — tab "${source.tab}" has a valid "${source.nameHeader}" column but no ` +
      `names under it. That repository will produce nothing.`
    );
  }

  return entities;
}

/** Accepts aboutHeaders: ['A','B'] or the older aboutHeader: 'A'. */
function aboutHeaders_(source) {
  if (Array.isArray(source.aboutHeaders)) return source.aboutHeaders.filter(h => h);
  return source.aboutHeader ? [source.aboutHeader] : [];
}

/**
 * Joins the dossier columns into one line for Gemini.
 *
 * Composite dossiers get labelled by header: "Focus Area(s): pet nutrition. HQ:
 * Austin" tells Gemini much more than "pet nutrition. Austin", because it knows
 * which fact is which. A lone prose column is passed through bare — labelling
 * one value adds nothing, and "About: ..." just spends tokens saying so.
 *
 * Labelling keys off how many columns were CONFIGURED, not how many resolved.
 * If you asked for Focus/HQ/Summary and only HQ exists, you still want
 * "HQ: Austin" — bare "Austin" reads as noise.
 *
 * @param {!Array<*>} row
 * @param {!Array<{header: string, column: number}>} aboutColumns resolved columns
 * @param {boolean} labelled
 */
function buildAbout_(row, aboutColumns, labelled) {
  const filled = aboutColumns
    .map(c => ({ header: c.header, value: String(row[c.column] || '').trim() }))
    .filter(c => c.value);

  if (!filled.length) return '';
  if (!labelled) return filled[0].value;

  return filled.map(c => `${c.header}: ${c.value}`).join('. ');
}

/**
 * Header comparison key: case, spacing and punctuation are all ignored, so
 * "Company's", "Companys" and "COMPANYS " all match — as do "Focus Area(s)"
 * and "focus areas".
 */
function normalizeHeader_(header) {
  return String(header || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Prints every tab and its headers. Run this to get exact spellings for
 * CONFIG.ENTITY_SOURCES rather than guessing at them.
 */
function inspectSheet() {
  const spreadsheet = getSpreadsheet_();
  Logger.log(`Spreadsheet: "${spreadsheet.getName()}"\n`);

  spreadsheet.getSheets().forEach(sheet => {
    const lastColumn = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();
    const headers = lastColumn
      ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(h => `"${h}"`).join(', ')
      : '(empty)';
    Logger.log(`"${sheet.getName()}"   ${lastRow} rows x ${lastColumn} cols`);
    Logger.log(`    row 1: ${headers}\n`);
  });

  Logger.log('Copy the exact tab name and header text into CONFIG.ENTITY_SOURCES in Config.gs.');
  Logger.log('Header matching ignores case, spaces and punctuation, so "Company\'s" == "Companys".');
}
