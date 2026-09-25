// ElectoStock — read-only Google Sheet copy
//
// The app moved to Supabase (https://bromalis.github.io/electostock/). This
// script, bound to the old spreadsheet, now only does two things:
//   1. Keeps a read-only copy of the inventory in this spreadsheet, refreshed
//      every hour from Supabase (refreshSheetCopy).
//   2. Tells any old copy of the app still open somewhere that it has moved
//      (doGet / doPost), so nothing can write to the sheet any more.
//
// One-time setup, in the Apps Script editor:
//   a. Project Settings > Script Properties > add EXPORT_TOKEN, with the value
//      from `select public.create_export_token();` in the Supabase SQL Editor.
//   b. Select installHourlyRefresh in the function dropdown and click Run.

const SUPABASE_URL = 'https://tnjledlrzwtnocvmtgrf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_HzFIPbDEhWRX7g9A6E_FgA_nNi4PQnV'; // publishable: public by design
const APP_URL      = 'https://bromalis.github.io/electostock/';

// Tab name → columns. The first columns match the old tabs, so anything that
// referred to them keeps working; newer fields are added at the end.
const TABS = {
  'Inventory':    ['id', 'part', 'name', 'category', 'qty', 'min', 'location', 'unit_cost', 'supplier', 'supplier_part', 'notes', 'updated_at',
                   'barcode'],
  'Categories':   ['name', 'color'],
  'BOMs':         ['parent_id', 'child_id', 'quantity', 'parent_name', 'child_name'],
  'Checkout Log': ['timestamp', 'job_name', 'assembly_name', 'assembly_id', 'qty_built', 'component_name',
                   'component_supplier_part', 'component_location', 'qty_deducted', 'sub_assembly_name', 'depth', 'user_email'],
  'Stock Moves':  ['timestamp', 'item_id', 'item_name', 'supplier_part', 'location', 'action', 'qty_requested',
                   'qty_change', 'qty_after', 'note', 'user_email'],
};
const ABOUT_TAB = 'About this copy';

// ─── Retired web app ─────────────────────────────────────────────────────────

const MOVED = { error: 'ElectoStock has moved. Reload the page to use the new version: ' + APP_URL };

function doGet()  { return movedResponse(); }
function doPost() { return movedResponse(); }

function movedResponse() {
  return ContentService.createTextOutput(JSON.stringify(MOVED)).setMimeType(ContentService.MimeType.JSON);
}

// ─── Sheet copy ──────────────────────────────────────────────────────────────

function fetchSnapshot() {
  const token = PropertiesService.getScriptProperties().getProperty('EXPORT_TOKEN');
  if (!token) throw new Error('Set EXPORT_TOKEN under Project Settings > Script Properties first.');
  const res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/export_snapshot', {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPABASE_KEY },
    payload: JSON.stringify({ p_token: token }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Supabase export failed (' + res.getResponseCode() + '): ' + res.getContentText());
  }
  return JSON.parse(res.getContentText());
}

// Rows for each tab, in TABS column order. Timestamps become Dates so the sheet
// shows them in its own time zone.
function snapshotRows(snapshot) {
  const asDate = v => (v ? new Date(v) : '');
  const row = (obj, cols) => cols.map(c => cell(obj[c]));
  return {
    'Inventory': snapshot.items.map(i => row(Object.assign({}, i, { updated_at: asDate(i.updated_at) }), TABS['Inventory'])),
    'Categories': snapshot.categories.map(c => row(c, TABS['Categories'])),
    'BOMs': snapshot.bom_lines.map(b => row(b, TABS['BOMs'])),
    'Checkout Log': snapshot.checkout_log.map(l => row(Object.assign({}, l, { timestamp: asDate(l.created_at) }), TABS['Checkout Log'])),
    'Stock Moves': (snapshot.stock_moves || []).map(m => row(Object.assign({}, m, { timestamp: asDate(m.created_at) }), TABS['Stock Moves'])),
  };
}

// One cell. Text gets a leading apostrophe, which Sheets hides, so it is stored as
// typed: anyone in the app can edit names and notes, and without it "=IMPORTXML(…)"
// would become a live formula here and "0805" the number 805.
function cell(v) {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' && v !== '' ? "'" + v : v;
}

// Replace a tab's contents with header + rows, and lock it against editing. The new
// values are written over the old ones before anything is cleared, so a write that
// fails part-way leaves the previous copy rather than an empty tab.
function writeTab(ss, name, headers, rows) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  const values = [headers.map(cell)].concat(rows);
  const width = headers.length;
  sheet.getRange(1, 1, values.length, width).setValues(values);
  // Then remove what's left of a longer or wider earlier copy
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow > values.length) sheet.getRange(values.length + 1, 1, lastRow - values.length, Math.max(lastCol, width)).clearContent();
  if (lastCol > width) sheet.getRange(1, width + 1, values.length, lastCol - width).clearContent();
  sheet.getRange(1, 1, 1, width).setFontWeight('bold');
  sheet.setFrozenRows(1);
  protect(sheet);
}

// Only the owner (who runs this script) can edit; everyone else can look.
function protect(sheet) {
  const existing = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  const p = existing.length ? existing[0] : sheet.protect();
  p.setDescription('Read-only copy of ElectoStock. Edit inventory in the app: ' + APP_URL);
  p.removeEditors(p.getEditors());
  if (p.canDomainEdit()) p.setDomainEdit(false);
}

function refreshSheetCopy() {
  // One refresh at a time: the hourly trigger and a manual run could otherwise
  // write the same tabs at once
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) { Logger.log('Another refresh is still running; skipped this one.'); return; }
  try {
    const snapshot = fetchSnapshot();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const rows = snapshotRows(snapshot);
    Object.keys(TABS).forEach(name => writeTab(ss, name, TABS[name], rows[name]));
    writeTab(ss, ABOUT_TAB, ['ElectoStock — read-only copy'], [
      ['This spreadsheet is a read-only copy of the ElectoStock inventory, refreshed every hour.'],
      ['To make changes, use the app: ' + APP_URL],
      ['Last refreshed: ' + new Date(snapshot.generated_at).toString()],
    ].map(r => r.map(cell)));
    Logger.log('Sheet copy refreshed: %s items, %s BOM lines, %s log rows, %s stock moves.',
      snapshot.items.length, snapshot.bom_lines.length, snapshot.checkout_log.length, (snapshot.stock_moves || []).length);
  } finally {
    lock.releaseLock();
  }
}

// Run once from the editor: removes the old app's triggers, schedules the
// hourly refresh and runs it straight away.
function installHourlyRefresh() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'onEdit' || fn === 'refreshSheetCopy') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshSheetCopy').timeBased().everyHours(1).create();
  refreshSheetCopy();
  Logger.log('Hourly refresh installed.');
}
