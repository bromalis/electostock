// ElectoStock — Google Apps Script Backend
// Deploy as Web App: Execute as Me | Who has access: Anyone
// After ANY code change: Deploy > Manage deployments > Edit > New version > Deploy
//
// onEdit trigger setup (one-time):
//   Select installOnEditTrigger in the function dropdown and click Run.

// ══════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════
const SHEET_NAME  = 'Inventory';
const CATS_SHEET  = 'Categories';
const BOM_SHEET   = 'BOMs';
const META_SHEET  = 'Meta';
const LOG_SHEET   = 'Checkout Log';

const INV_HEADERS  = ['id','part','name','category','qty','min','location','unit_cost','supplier','supplier_part','notes','updated_at'];
const CAT_HEADERS  = ['name','color'];
const BOM_HEADERS  = ['parent_id','child_id','quantity'];
const META_HEADERS = ['key','value'];
const LOG_HEADERS  = ['timestamp','job_name','assembly_name','assembly_id','qty_built','component_name','component_supplier_part','component_location','qty_deducted','sub_assembly_name','depth'];

// ─── Sheet helpers ────────────────────────────────────────────────────────────

function getInvSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(INV_HEADERS);
    sheet.getRange(1,1,1,INV_HEADERS.length).setFontWeight('bold').setBackground('#0d0f11').setFontColor('#00d4aa');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getCatsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CATS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CATS_SHEET);
    sheet.appendRow(CAT_HEADERS);
    sheet.getRange(1,1,1,CAT_HEADERS.length).setFontWeight('bold').setBackground('#0d0f11').setFontColor('#00d4aa');
    sheet.setFrozenRows(1);
    const defaults = [
      ['Resistor','#8a97a5'],['Capacitor','#3b82f6'],['IC / Microcontroller','#a855f7'],
      ['Connector','#10b981'],['Transistor','#f59e0b'],['Diode','#ef4444'],
      ['Relay','#ec4899'],['Sensor','#06b6d4'],['Power Module','#f97316'],
      ['Cable / Wire','#84cc16'],['PCB','#6366f1'],['Other','#78716c'],
    ];
    defaults.forEach(r => sheet.appendRow(r));
  }
  return sheet;
}

function getBomSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(BOM_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(BOM_SHEET);
    sheet.appendRow(BOM_HEADERS);
    sheet.getRange(1,1,1,BOM_HEADERS.length).setFontWeight('bold').setBackground('#0d0f11').setFontColor('#00d4aa');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getMetaSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(META_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(META_SHEET);
    sheet.appendRow(META_HEADERS);
    sheet.getRange(1,1,1,META_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.appendRow(['last_modified', new Date().toISOString()]);
  }
  return sheet;
}

function getLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET);
    sheet.appendRow(LOG_HEADERS);
    sheet.getRange(1,1,1,LOG_HEADERS.length).setFontWeight('bold').setBackground('#0d0f11').setFontColor('#00d4aa');
    sheet.setFrozenRows(1);
    // Format timestamp column as readable datetime
    sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
  return sheet;
}

function touchLastModified() {
  const sheet = getMetaSheet();
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === 'last_modified') {
      sheet.getRange(i+1, 2).setValue(new Date().toISOString());
      return;
    }
  }
  sheet.appendRow(['last_modified', new Date().toISOString()]);
}

function ensureHeaders(sheet, headers) {
  const first = sheet.getRange(1,1,1,headers.length).getValues()[0];
  if (first[0] !== headers[0]) {
    sheet.insertRowBefore(1);
    sheet.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
}

function rowToInvObj(row) {
  const obj = {};
  INV_HEADERS.forEach((h,i) => obj[h] = row[i]);
  obj.qty       = Number(obj.qty)       || 0;
  obj.min       = Number(obj.min)       || 0;
  obj.unit_cost = Number(obj.unit_cost) || 0;
  obj.id        = Number(obj.id)        || 0;
  return obj;
}

// ─── Request routing ──────────────────────────────────────────────────────────

function doGet(e)  { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function handleRequest(e) {
  try {
    const params = e.parameter || {};
    const action = params.action || '';
    let data = {};
    if (params.data) { try { data = JSON.parse(params.data); } catch(err) {} }

    let result;
    switch (action) {
      // Inventory
      case 'getAll':           result = actionGetAll();                                        break;
      case 'add':              result = actionAdd(data.item);                                  break;
      case 'update':           result = actionUpdate(data.item);                               break;
      case 'delete':           result = actionDelete(Number(data.id));                         break;
      case 'adjustQty':        result = actionAdjustQty(data);                                 break;
      case 'batchAdjustQty':   result = actionBatchAdjustQty(data.adjustments);                break;
      // Categories
      case 'getCats':          result = actionGetCats();                                       break;
      case 'addCat':           result = actionAddCat(data.name, data.color);                   break;
      case 'updateCat':        result = actionUpdateCat(data.oldName, data.name, data.color);  break;
      case 'deleteCat':        result = actionDeleteCat(data.name);                            break;
      // BOMs
      case 'getBOMs':          result = actionGetBOMs();                                       break;
      case 'saveBOM':          result = actionSaveBOM(Number(data.parent_id), data.lines);     break;
      case 'deleteBOM':        result = actionDeleteBOM(Number(data.parent_id));               break;
      // Checkout log
      case 'logCheckout':      result = actionLogCheckout(data);                               break;
      case 'getCheckoutLog':   result = actionGetCheckoutLog(data.assembly_id, data.limit);    break;
      // Polling / bulk load
      case 'getLastModified':  result = actionGetLastModified();                               break;
      case 'getAll+getCats':   result = actionGetAllAndCats();                                 break;
      default:                 result = { error: 'Unknown action: ' + action };
    }

    const output = ContentService.createTextOutput(JSON.stringify(result));
    output.setMimeType(ContentService.MimeType.JSON);
    return output;
  } catch(err) {
    const output = ContentService.createTextOutput(JSON.stringify({ error: err.message }));
    output.setMimeType(ContentService.MimeType.JSON);
    return output;
  }
}

// ─── Inventory actions ────────────────────────────────────────────────────────

function actionGetAll() {
  const sheet = getInvSheet();
  ensureHeaders(sheet, INV_HEADERS);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { items: [] };
  return { items: data.slice(1).map(rowToInvObj).filter(i => i.id > 0) };
}

function actionGetAllAndCats() {
  return {
    items:      actionGetAll().items,
    categories: actionGetCats().categories,
    boms:       actionGetBOMs().boms,
    timestamp:  actionGetLastModified().last_modified,
  };
}

function actionAdd(item) {
  if (!item) return { error: 'No item provided' };
  const sheet = getInvSheet();
  ensureHeaders(sheet, INV_HEADERS);
  const data = sheet.getDataRange().getValues();
  const ids  = data.slice(1).map(r => Number(r[0])).filter(Boolean);
  item.id = ids.length > 0 ? Math.max(...ids) + 1 : 1;
  item.updated_at = new Date().toISOString();
  sheet.appendRow(INV_HEADERS.map(h => item[h] !== undefined ? item[h] : ''));
  touchLastModified();
  return { success: true, item };
}

function actionUpdate(item) {
  if (!item || !item.id) return { error: 'No item or ID' };
  const sheet = getInvSheet();
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (Number(data[i][0]) === Number(item.id)) {
      item.updated_at = new Date().toISOString();
      sheet.getRange(i+1,1,1,INV_HEADERS.length).setValues([
        INV_HEADERS.map(h => item[h] !== undefined ? item[h] : data[i][INV_HEADERS.indexOf(h)])
      ]);
      touchLastModified();
      return { success: true, item };
    }
  }
  return { error: 'Item not found: ' + item.id };
}

function actionDelete(id) {
  if (!id) return { error: 'No ID' };
  const sheet = getInvSheet();
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (Number(data[i][0]) === id) {
      sheet.deleteRow(i+1);
      // Also delete all BOM rows referencing this item
      actionDeleteBOM(id);
      touchLastModified();
      return { success: true };
    }
  }
  return { error: 'Item not found: ' + id };
}

function actionAdjustQty(body) {
  const { id, action, qty } = body;
  if (!id) return { error: 'No ID' };
  const sheet  = getInvSheet();
  const data   = sheet.getDataRange().getValues();
  const colQty = INV_HEADERS.indexOf('qty');
  const colUpd = INV_HEADERS.indexOf('updated_at');
  for (let i = 1; i < data.length; i++) {
    if (Number(data[i][0]) === Number(id)) {
      const cur    = Number(data[i][colQty]) || 0;
      const newQty = action === 'add'    ? cur + (Number(qty)||0)
                   : action === 'remove' ? Math.max(0, cur - (Number(qty)||0))
                   : Number(qty)||0;
      sheet.getRange(i+1, colQty+1).setValue(newQty);
      sheet.getRange(i+1, colUpd+1).setValue(new Date().toISOString());
      touchLastModified();
      return { success: true, newQty };
    }
  }
  return { error: 'Item not found' };
}

// Batch: apply multiple qty adjustments in one call (used for BOM checkouts)
// adjustments = [{ id, action, qty }, ...]
function actionBatchAdjustQty(adjustments) {
  if (!adjustments || !adjustments.length) return { error: 'No adjustments provided' };
  const sheet  = getInvSheet();
  const data   = sheet.getDataRange().getValues();
  const colQty = INV_HEADERS.indexOf('qty');
  const colUpd = INV_HEADERS.indexOf('updated_at');
  const results = [];

  adjustments.forEach(adj => {
    const id  = Number(adj.id);
    const qty = Number(adj.qty) || 0;
    for (let i = 1; i < data.length; i++) {
      if (Number(data[i][0]) === id) {
        const cur    = Number(data[i][colQty]) || 0;
        const newQty = adj.action === 'add'    ? cur + qty
                     : adj.action === 'remove' ? Math.max(0, cur - qty)
                     : qty;
        sheet.getRange(i+1, colQty+1).setValue(newQty);
        sheet.getRange(i+1, colUpd+1).setValue(new Date().toISOString());
        // Update in-memory data array so subsequent iterations see the new qty
        data[i][colQty] = newQty;
        results.push({ id, newQty });
        break;
      }
    }
  });

  touchLastModified();
  return { success: true, results };
}

// ─── Category actions ─────────────────────────────────────────────────────────

function actionGetCats() {
  const sheet = getCatsSheet();
  ensureHeaders(sheet, CAT_HEADERS);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { categories: [] };
  return {
    categories: data.slice(1)
      .filter(r => r[0] && String(r[0]).trim())
      .map(r => ({ name: String(r[0]).trim(), color: String(r[1]).trim() || '#78716c' }))
  };
}

function actionAddCat(name, color) {
  if (!name) return { error: 'No name provided' };
  const sheet = getCatsSheet();
  ensureHeaders(sheet, CAT_HEADERS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === name.trim().toLowerCase())
      return { error: 'Category already exists' };
  }
  sheet.appendRow([name.trim(), color || '#78716c']);
  touchLastModified();
  return { success: true, category: { name: name.trim(), color: color || '#78716c' } };
}

function actionUpdateCat(oldName, newName, color) {
  if (!oldName) return { error: 'No old name provided' };
  const sheet = getCatsSheet();
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === oldName.trim().toLowerCase()) {
      sheet.getRange(i+1, 1).setValue(newName || oldName);
      sheet.getRange(i+1, 2).setValue(color   || data[i][1]);
      touchLastModified();
      return { success: true };
    }
  }
  return { error: 'Category not found: ' + oldName };
}

function actionDeleteCat(name) {
  if (!name) return { error: 'No name provided' };
  const sheet = getCatsSheet();
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === name.trim().toLowerCase()) {
      sheet.deleteRow(i+1);
      touchLastModified();
      return { success: true };
    }
  }
  return { error: 'Category not found: ' + name };
}

// ─── BOM actions ──────────────────────────────────────────────────────────────

// Returns all BOM rows as { boms: [{ parent_id, child_id, quantity }, ...] }
function actionGetBOMs() {
  const sheet = getBomSheet();
  ensureHeaders(sheet, BOM_HEADERS);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { boms: [] };
  return {
    boms: data.slice(1)
      .filter(r => Number(r[0]) > 0 && Number(r[1]) > 0)
      .map(r => ({
        parent_id: Number(r[0]),
        child_id:  Number(r[1]),
        quantity:  Number(r[2]) || 1,
      }))
  };
}

// Replace all BOM lines for a given parent — full overwrite
// lines = [{ child_id, quantity }, ...]
function actionSaveBOM(parent_id, lines) {
  if (!parent_id) return { error: 'No parent_id' };
  const sheet = getBomSheet();
  ensureHeaders(sheet, BOM_HEADERS);

  // Delete existing rows for this parent (iterate backwards to avoid index shift)
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (Number(data[i][0]) === parent_id) sheet.deleteRow(i+1);
  }

  // Append new lines
  if (lines && lines.length) {
    lines.forEach(line => {
      if (Number(line.child_id) > 0 && Number(line.quantity) > 0) {
        sheet.appendRow([parent_id, Number(line.child_id), Number(line.quantity)]);
      }
    });
  }

  touchLastModified();
  return { success: true };
}

// Remove all BOM entries where parent_id OR child_id matches (used on item delete)
function actionDeleteBOM(id) {
  if (!id) return { success: true };
  const sheet = getBomSheet();
  const data  = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (Number(data[i][0]) === id || Number(data[i][1]) === id) {
      sheet.deleteRow(i+1);
    }
  }
  return { success: true };
}

// ─── Checkout log actions ─────────────────────────────────────────────────────

// data = {
//   job_name, assembly_name, assembly_id, qty_built,
//   components: [{ name, supplier_part, location, qty_deducted, sub_assembly_name, depth }]
// }
function actionLogCheckout(data) {
  if (!data || !data.job_name) return { error: 'job_name required' };
  const sheet     = getLogSheet();
  const timestamp = new Date();
  const rows      = (data.components || []).map(c => [
    timestamp,
    data.job_name,
    data.assembly_name        || '',
    Number(data.assembly_id)  || 0,
    Number(data.qty_built)    || 1,
    c.name                    || '',
    c.supplier_part           || '',
    c.location                || '',
    Number(c.qty_deducted)    || 0,
    c.sub_assembly_name       || '',
    Number(c.depth)           || 0,
  ]);
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, LOG_HEADERS.length).setValues(rows);
  }
  return { success: true, rows_written: rows.length };
}

// Returns recent log entries, optionally filtered by assembly_id
// limit defaults to 100
function actionGetCheckoutLog(assembly_id, limit) {
  const sheet = getLogSheet();
  const data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return { entries: [] };
  const cap   = Number(limit) || 100;
  let rows    = data.slice(1).reverse(); // most recent first
  if (assembly_id) rows = rows.filter(r => Number(r[3]) === Number(assembly_id));
  rows = rows.slice(0, cap);
  return {
    entries: rows.map(r => ({
      timestamp:           r[0] ? new Date(r[0]).toISOString() : '',
      job_name:            String(r[1] || ''),
      assembly_name:       String(r[2] || ''),
      assembly_id:         Number(r[3]) || 0,
      qty_built:           Number(r[4]) || 0,
      component_name:      String(r[5] || ''),
      supplier_part:       String(r[6] || ''),
      location:            String(r[7] || ''),
      qty_deducted:        Number(r[8]) || 0,
      sub_assembly_name:   String(r[9] || ''),
      depth:               Number(r[10]) || 0,
    }))
  };
}

// ─── Polling ──────────────────────────────────────────────────────────────────

function actionGetLastModified() {
  const sheet = getMetaSheet();
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === 'last_modified') return { last_modified: String(data[i][1]) };
  }
  touchLastModified();
  return { last_modified: new Date().toISOString() };
}

// ─── onEdit trigger ───────────────────────────────────────────────────────────

function onEdit(e) {
  try {
    const sheetName = e && e.range ? e.range.getSheet().getName() : '';
    if (
      (sheetName === SHEET_NAME || sheetName === CATS_SHEET || sheetName === BOM_SHEET) &&
      e.range.getRow() > 1
    ) {
      touchLastModified();
    }
  } catch(err) {}
}

function installOnEditTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'onEdit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onEdit')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();
  Logger.log('onEdit trigger installed successfully.');
}
