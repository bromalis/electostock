// ElectoStock — Google Apps Script Backend
// Deploy as Web App: Execute as Me | Who has access: Anyone
// After ANY code change: Deploy > Manage deployments > Edit > New version > Deploy
//
// onEdit trigger setup (one-time):
//   Select installOnEditTrigger in the function dropdown and click Run.
//
// Users: edit setupUsers() near the bottom of this file and run it.

// ══════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════
const SHEET_NAME     = 'Inventory';
const CATS_SHEET     = 'Categories';
const BOM_SHEET      = 'BOMs';
const META_SHEET     = 'Meta';
const LOG_SHEET      = 'Checkout Log';
const USERS_SHEET    = 'Users';
const SESSIONS_SHEET = 'Sessions';

const INV_HEADERS      = ['id','part','name','category','qty','min','location','unit_cost','supplier','supplier_part','notes','updated_at'];
const CAT_HEADERS      = ['name','color'];
const BOM_HEADERS      = ['parent_id','child_id','quantity'];
const META_HEADERS     = ['key','value'];
const LOG_HEADERS      = ['timestamp','job_name','assembly_name','assembly_id','qty_built','component_name','component_supplier_part','component_location','qty_deducted','sub_assembly_name','depth'];
const USER_HEADERS     = ['username','password_hash','role'];
const SESSION_HEADERS  = ['token_hash','username','role','expires'];

// Fields a client may set on an inventory item. id and updated_at are server-owned.
const INV_EDITABLE = INV_HEADERS.filter(h => h !== 'id' && h !== 'updated_at');

// Roles, lowest to highest. A role missing from this map is treated as viewer.
const ROLE_RANK = { viewer: 0, user: 1, admin: 2 };

// Minimum role for each action. Actions not listed here are rejected.
// Anything above viewer is a write and runs under the script lock.
const ACTION_ROLES = {
  'getAll':          'viewer',
  'getAll+getCats':  'viewer',
  'getCats':         'viewer',
  'getBOMs':         'viewer',
  'getCheckoutLog':  'viewer',
  'getLastModified': 'viewer',
  'changePassword':  'viewer', // own password; the one write open to viewers
  'add':             'user',
  'update':          'user',
  'adjustQty':       'user',
  'checkout':        'user',
  'saveBOM':         'user',
  'addCat':          'user',
  'updateCat':       'user',
  'delete':          'admin',
  'deleteCat':       'admin',
  'listUsers':       'admin',
  'saveUser':        'admin',
  'deleteUser':      'admin',
};

// Writes that viewers may make. They still need the lock.
const VIEWER_WRITES = ['changePassword'];

const LOCK_TIMEOUT_MS       = 20 * 1000;
const TOKEN_TTL_MS          = 8 * 60 * 60 * 1000;
const SESSION_CACHE_SECONDS = 10 * 60;
const PBKDF2_ITERATIONS     = 2000;
const MIN_PASSWORD_LENGTH   = 8;

// ─── Sheet helpers ────────────────────────────────────────────────────────────

function styleHeader(sheet, headers) {
  sheet.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#0d0f11').setFontColor('#00d4aa');
  sheet.setFrozenRows(1);
}

function getInvSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(INV_HEADERS);
    styleHeader(sheet, INV_HEADERS);
  }
  return sheet;
}

function getCatsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CATS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CATS_SHEET);
    sheet.appendRow(CAT_HEADERS);
    styleHeader(sheet, CAT_HEADERS);
    const defaults = [
      ['Resistor','#8a97a5'],['Capacitor','#3b82f6'],['IC / Microcontroller','#a855f7'],
      ['Connector','#10b981'],['Transistor','#f59e0b'],['Diode','#ef4444'],
      ['Relay','#ec4899'],['Sensor','#06b6d4'],['Power Module','#f97316'],
      ['Cable / Wire','#84cc16'],['PCB','#6366f1'],['Other','#78716c'],
    ];
    sheet.getRange(2, 1, defaults.length, 2).setValues(defaults);
  }
  return sheet;
}

function getBomSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(BOM_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(BOM_SHEET);
    sheet.appendRow(BOM_HEADERS);
    styleHeader(sheet, BOM_HEADERS);
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
    styleHeader(sheet, LOG_HEADERS);
    // Format timestamp column as readable datetime
    sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
  return sheet;
}

function getUsersSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(USERS_SHEET);
    sheet.appendRow(USER_HEADERS);
    styleHeader(sheet, USER_HEADERS);
    sheet.hideColumns(2); // password_hash
  }
  return sheet;
}

function getSessionsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SESSIONS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SESSIONS_SHEET);
    sheet.appendRow(SESSION_HEADERS);
    styleHeader(sheet, SESSION_HEADERS);
    sheet.hideSheet();
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

// Replace every data row (row 2 onward) of a sheet with `rows`.
function rewriteDataRows(sheet, width, rows) {
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, width).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, width).setValues(rows);
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

// Reads the Inventory sheet once. rowOf maps item id → 1-based sheet row.
function readInventory() {
  const sheet = getInvSheet();
  ensureHeaders(sheet, INV_HEADERS);
  const data  = sheet.getDataRange().getValues();
  const items = [];
  const byId  = new Map();
  const rowOf = new Map();
  for (let i = 1; i < data.length; i++) {
    const item = rowToInvObj(data[i]);
    if (item.id <= 0) continue;
    items.push(item);
    byId.set(item.id, item);
    rowOf.set(item.id, i + 1);
  }
  return { sheet, items, byId, rowOf };
}

function invCol(header) { return INV_HEADERS.indexOf(header) + 1; }

// ─── Request routing ──────────────────────────────────────────────────────────

// All requests are POSTs with a JSON body: { action, data }. The client sends it
// as text/plain so the browser skips the CORS preflight Apps Script can't answer.
// GET is refused so credentials never end up in URLs.
function doGet()   { return jsonOutput({ error: 'Send requests as POST' }); }
function doPost(e) { return jsonOutput(handleRequest(e)); }

function jsonOutput(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function handleRequest(e) {
  try {
    let req;
    try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
    catch(err) { return { error: 'Invalid request body' }; }
    const action = req.action || '';
    const data   = req.data   || {};

    // Auth — no token required
    if (action === 'login')  return withLock(() => actionLogin(data.username, data.password));
    if (action === 'logout') return withLock(() => actionLogout(data.token));

    const minRole = ACTION_ROLES[action];
    if (!minRole) return { error: 'Unknown action: ' + action };

    const auth = validateToken(data.token);
    if (auth.error) return auth;
    if (roleRank(auth.session.role) < ROLE_RANK[minRole]) {
      return { error: 'Your role (' + auth.session.role + ') is not allowed to do that' };
    }

    const run = () => dispatch(action, data, auth.session);
    const isWrite = ROLE_RANK[minRole] > ROLE_RANK.viewer || VIEWER_WRITES.includes(action);
    return isWrite ? withLock(run) : run();
  } catch(err) {
    return { error: err.message };
  }
}

function dispatch(action, data, session) {
  switch (action) {
    // Inventory
    case 'getAll':          return actionGetAll();
    case 'add':             return actionAdd(data.item);
    case 'update':          return actionUpdate(data.item);
    case 'delete':          return actionDelete(Number(data.id));
    case 'adjustQty':       return actionAdjustQty(data);
    case 'checkout':        return actionCheckout(data);
    // Categories
    case 'getCats':         return actionGetCats();
    case 'addCat':          return actionAddCat(data.name, data.color);
    case 'updateCat':       return actionUpdateCat(data.oldName, data.name, data.color);
    case 'deleteCat':       return actionDeleteCat(data.name);
    // BOMs
    case 'getBOMs':         return actionGetBOMs();
    case 'saveBOM':         return actionSaveBOM(Number(data.parent_id), data.lines);
    // Checkout log
    case 'getCheckoutLog':  return actionGetCheckoutLog(data.assembly_id, data.limit);
    // Polling / bulk load
    case 'getLastModified': return actionGetLastModified();
    case 'getAll+getCats':  return actionGetAllAndCats();
    // Users (admin)
    case 'listUsers':       return actionListUsers(session);
    case 'saveUser':        return actionSaveUser(data, session);
    case 'deleteUser':      return actionDeleteUser(data.username, session);
    case 'changePassword':  return actionChangePassword(data, session);
  }
  return { error: 'Unknown action: ' + action };
}

// Serialises writes so concurrent requests can't interleave read-modify-write
// cycles (lost qty updates, duplicate ids, half-rewritten BOMs).
function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) return { error: 'Server busy, please try again' };
  try {
    const result = fn();
    SpreadsheetApp.flush(); // commit writes before the next request reads
    return result;
  } finally {
    lock.releaseLock();
  }
}

function roleRank(role) {
  const r = String(role || '').trim().toLowerCase();
  return r in ROLE_RANK ? ROLE_RANK[r] : ROLE_RANK.viewer;
}

// ─── BOM math (pure — no Apps Script calls, covered by tests/) ───────────────
// linesByParent: Map parent_id → [{ parent_id, child_id, quantity }]
// itemsById:     Map id → inventory item

function groupBomLines(boms) {
  const map = new Map();
  boms.forEach(b => {
    if (!map.has(b.parent_id)) map.set(b.parent_id, []);
    map.get(b.parent_id).push(b);
  });
  return map;
}

// Flatten a BOM to its LEAF components. Intermediate assemblies are expanded,
// never deducted themselves.
function resolveBomLeaves(parentId, multiplier, linesByParent, itemsById, visited) {
  visited = visited || new Set();
  if (visited.has(parentId)) return []; // circular reference guard
  visited.add(parentId);
  const result = [];
  (linesByParent.get(parentId) || []).forEach(line => {
    const child = itemsById.get(line.child_id);
    if (!child) return;
    const qty = line.quantity * multiplier;
    if (linesByParent.has(child.id)) {
      result.push(...resolveBomLeaves(child.id, qty, linesByParent, itemsById, new Set(visited)));
    } else {
      result.push({ item: child, qty });
    }
  });
  return result;
}

// Combine duplicate leaves, summing qty.
function mergeBomLines(lines) {
  const map = new Map();
  lines.forEach(({ item, qty }) => {
    if (map.has(item.id)) map.get(item.id).qty += qty;
    else map.set(item.id, { item, qty });
  });
  return [...map.values()];
}

// Log rows for a checkout. sub_assembly_name is the full path of ancestor
// assembly names ("Top > Sub A") so history survives later BOM edits.
function buildLogComponents(parentId, multiplier, parentPath, depth, linesByParent, itemsById, visited) {
  visited = visited || new Set();
  if (visited.has(parentId)) return [];
  visited.add(parentId);
  const result = [];
  (linesByParent.get(parentId) || []).forEach(line => {
    const child = itemsById.get(line.child_id);
    if (!child) return;
    const qty = line.quantity * multiplier;
    if (linesByParent.has(child.id)) {
      result.push(...buildLogComponents(child.id, qty, parentPath + ' > ' + child.name, depth + 1, linesByParent, itemsById, new Set(visited)));
    } else {
      result.push({
        name:              child.name,
        supplier_part:     child.supplier_part || '',
        location:          child.location      || '',
        qty_deducted:      qty,
        sub_assembly_name: parentPath,
        depth,
      });
    }
  });
  return result;
}

// Cost of one unit, always recalculated from leaf unit_costs.
function calcBomCost(parentId, linesByParent, itemsById, visited) {
  visited = visited || new Set();
  if (visited.has(parentId)) return 0; // cycle guard
  visited.add(parentId);
  return (linesByParent.get(parentId) || []).reduce((sum, line) => {
    const child = itemsById.get(line.child_id);
    if (!child) return sum;
    const childCost = linesByParent.has(child.id)
      ? calcBomCost(child.id, linesByParent, itemsById, new Set(visited))
      : (child.unit_cost || 0);
    return sum + childCost * line.quantity;
  }, 0);
}

// Every assembly that contains any of `ids` anywhere in its BOM tree.
function findAncestors(ids, boms) {
  const parentsOf = new Map();
  boms.forEach(b => {
    if (!parentsOf.has(b.child_id)) parentsOf.set(b.child_id, []);
    parentsOf.get(b.child_id).push(b.parent_id);
  });
  const found = new Set();
  const queue = [...ids];
  while (queue.length) {
    (parentsOf.get(queue.shift()) || []).forEach(pid => {
      if (!found.has(pid)) { found.add(pid); queue.push(pid); }
    });
  }
  return found;
}

// Check a proposed BOM for parentId. Returns an error string or null.
function validateBomLines(parentId, lines, boms, itemsById) {
  if (!itemsById.has(parentId)) return 'Assembly not found: ' + parentId;
  const seen = new Set();
  for (const line of lines) {
    if (!itemsById.has(line.child_id)) return 'Component not found: ' + line.child_id;
    if (line.child_id === parentId)    return 'An assembly cannot contain itself';
    if (seen.has(line.child_id))       return 'Duplicate components — each item can only appear once.';
    seen.add(line.child_id);
  }
  // Adding child C under P creates a cycle if P is already somewhere inside C.
  const ancestorsOfParent = findAncestors([parentId], boms);
  const cyclic = lines.find(l => ancestorsOfParent.has(l.child_id));
  if (cyclic) return '"' + itemsById.get(cyclic.child_id).name + '" already contains this assembly';
  return null;
}

// ─── Inventory actions ────────────────────────────────────────────────────────

function actionGetAll() {
  return { items: readInventory().items };
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
  const inv = readInventory();
  const row = {};
  INV_EDITABLE.forEach(h => { if (item[h] !== undefined) row[h] = item[h]; });
  row.id         = inv.items.length ? Math.max(...inv.items.map(i => i.id)) + 1 : 1;
  row.updated_at = new Date().toISOString();
  inv.sheet.appendRow(INV_HEADERS.map(h => row[h] !== undefined ? row[h] : ''));
  touchLastModified();
  return { success: true, item: rowToInvObj(INV_HEADERS.map(h => row[h] !== undefined ? row[h] : '')) };
}

// Partial update: only fields present in `item` are written, so a client with a
// stale copy can't clobber fields it didn't change (e.g. qty).
function actionUpdate(item) {
  if (!item || !item.id) return { error: 'No item or ID' };
  const id  = Number(item.id);
  const inv = readInventory();
  const row = inv.rowOf.get(id);
  if (!row) return { error: 'Item not found: ' + id };

  const current = inv.byId.get(id);
  const values  = INV_HEADERS.map(h =>
    INV_EDITABLE.includes(h) && item[h] !== undefined ? item[h] : current[h]);
  values[INV_HEADERS.indexOf('updated_at')] = new Date().toISOString();
  inv.sheet.getRange(row, 1, 1, INV_HEADERS.length).setValues([values]);

  const cost_updates = item.unit_cost !== undefined ? recalcAssemblyCosts([id]) : [];
  touchLastModified();
  return { success: true, item: rowToInvObj(values), cost_updates };
}

function actionDelete(id) {
  if (!id) return { error: 'No ID' };
  const inv = readInventory();
  const row = inv.rowOf.get(id);
  if (!row) return { error: 'Item not found: ' + id };
  const parents = [...findAncestors([id], actionGetBOMs().boms)];
  inv.sheet.deleteRow(row);
  deleteBomRowsFor(id);
  const cost_updates = parents.length ? recalcAssemblyCosts(parents) : [];
  touchLastModified();
  return { success: true, cost_updates };
}

function actionAdjustQty(body) {
  const { id, action, qty } = body;
  if (!id) return { error: 'No ID' };
  const inv = readInventory();
  const row = inv.rowOf.get(Number(id));
  if (!row) return { error: 'Item not found' };
  const cur    = inv.byId.get(Number(id)).qty;
  const n      = Number(qty) || 0;
  const newQty = action === 'add'    ? cur + n
               : action === 'remove' ? Math.max(0, cur - n)
               : n;
  inv.sheet.getRange(row, invCol('qty')).setValue(newQty);
  inv.sheet.getRange(row, invCol('updated_at')).setValue(new Date().toISOString());
  touchLastModified();
  return { success: true, newQty };
}

// Build `qty_built` units of an assembly: resolve its BOM to leaf components,
// deduct them and write the checkout log, all in one request under the lock.
// BOM quantities may be negative, so a component's net can be positive
// (deducted), zero (cancels out, untouched) or negative (returned to stock).
// data = { assembly_id, qty_built, job_name }
function actionCheckout(data) {
  const assemblyId = Number(data.assembly_id);
  const qtyBuilt   = Math.floor(Number(data.qty_built));
  const jobName    = String(data.job_name || '').trim();
  if (!assemblyId)      return { error: 'assembly_id required' };
  if (!(qtyBuilt >= 1)) return { error: 'qty_built must be at least 1' };
  if (!jobName)         return { error: 'job_name required' };

  const inv           = readInventory();
  const linesByParent = groupBomLines(actionGetBOMs().boms);
  const parent        = inv.byId.get(assemblyId);
  if (!parent)                         return { error: 'Assembly not found: ' + assemblyId };
  if (!linesByParent.has(assemblyId))  return { error: '"' + parent.name + '" has no BOM' };

  const leaves     = mergeBomLines(resolveBomLeaves(assemblyId, qtyBuilt, linesByParent, inv.byId))
    .filter(l => l.qty !== 0);
  const components = buildLogComponents(assemblyId, qtyBuilt, parent.name, 0, linesByParent, inv.byId);

  const timestamp = new Date();
  const logRows = components.map(c => [
    timestamp, jobName, parent.name, assemblyId, qtyBuilt,
    c.name, c.supplier_part, c.location, c.qty_deducted, c.sub_assembly_name, c.depth,
  ]);
  if (logRows.length) {
    const log = getLogSheet();
    log.getRange(log.getLastRow() + 1, 1, logRows.length, LOG_HEADERS.length).setValues(logRows);
  }

  const now = timestamp.toISOString();
  const results = leaves.map(({ item, qty }) => {
    const newQty = Math.max(0, item.qty - qty);
    const row    = inv.rowOf.get(item.id);
    inv.sheet.getRange(row, invCol('qty')).setValue(newQty);
    inv.sheet.getRange(row, invCol('updated_at')).setValue(now);
    return { id: item.id, newQty };
  });

  touchLastModified();
  return { success: true, results, rows_written: logRows.length };
}

// Recalculate the stored unit_cost of every assembly at or above `ids` that
// has BOM lines. Negative lines can make a BOM cost zero or less, which is
// stored as-is. An item with no BOM keeps its manually entered cost.
// Returns [{ id, unit_cost }] for what changed.
function recalcAssemblyCosts(ids) {
  const inv           = readInventory();
  const boms          = actionGetBOMs().boms;
  const linesByParent = groupBomLines(boms);
  const targets       = findAncestors(ids, boms);
  ids.forEach(id => { if (linesByParent.has(id)) targets.add(id); });

  const now = new Date().toISOString();
  const updates = [];
  targets.forEach(id => {
    const item = inv.byId.get(id);
    if (!item) return;
    const cost = calcBomCost(id, linesByParent, inv.byId);
    if (Math.abs(cost - item.unit_cost) > 0.000001) {
      const row = inv.rowOf.get(id);
      inv.sheet.getRange(row, invCol('unit_cost')).setValue(cost);
      inv.sheet.getRange(row, invCol('updated_at')).setValue(now);
      updates.push({ id, unit_cost: cost });
    }
  });
  return updates;
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
      sheet.getRange(i+1, 1, 1, 2).setValues([[newName || oldName, color || data[i][1]]]);
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
// lines = [{ child_id, quantity }, ...]. quantity may be negative but not zero.
function actionSaveBOM(parent_id, lines) {
  if (!parent_id) return { error: 'No parent_id' };
  const clean = (lines || [])
    .map(l => ({ child_id: Number(l.child_id), quantity: Number(l.quantity) }))
    .filter(l => l.child_id > 0 && Number.isFinite(l.quantity) && l.quantity !== 0);

  const boms = actionGetBOMs().boms;
  const err  = validateBomLines(parent_id, clean, boms, readInventory().byId);
  if (err) return { error: err };

  const rows = boms
    .filter(b => b.parent_id !== parent_id)
    .map(b => [b.parent_id, b.child_id, b.quantity])
    .concat(clean.map(l => [parent_id, l.child_id, l.quantity]));
  rewriteDataRows(getBomSheet(), BOM_HEADERS.length, rows);

  const cost_updates = recalcAssemblyCosts([parent_id]);
  touchLastModified();
  return { success: true, cost_updates };
}

// Remove all BOM entries where parent_id OR child_id matches (used on item delete)
function deleteBomRowsFor(id) {
  const boms = actionGetBOMs().boms;
  const keep = boms.filter(b => b.parent_id !== id && b.child_id !== id);
  if (keep.length === boms.length) return;
  rewriteDataRows(getBomSheet(), BOM_HEADERS.length, keep.map(b => [b.parent_id, b.child_id, b.quantity]));
}

// ─── Checkout log actions ─────────────────────────────────────────────────────

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

// ─── Auth: hashing ────────────────────────────────────────────────────────────

function bytesToHex(bytes) {
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

// Apps Script byte arrays are signed (-128..127).
function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 2) {
    const v = parseInt(hex.substr(i, 2), 16);
    out.push(v > 127 ? v - 256 : v);
  }
  return out;
}

function sha256Hex(str) {
  return bytesToHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8));
}

function utf8Bytes(str) {
  return Utilities.newBlob('').setDataFromString(str, 'UTF-8').getBytes();
}

// PBKDF2-HMAC-SHA256, single 32-byte block.
function pbkdf2Sha256Hex(password, saltBytes, iterations) {
  const key = utf8Bytes(password);
  let u = Utilities.computeHmacSha256Signature(saltBytes.concat([0, 0, 0, 1]), key);
  const out = u.slice();
  for (let i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, key);
    for (let j = 0; j < out.length; j++) out[j] ^= u[j];
  }
  return bytesToHex(out);
}

// Stored format: pbkdf2$<iterations>$<salt hex>$<hash hex>
function hashPassword(password) {
  const saltHex = Utilities.getUuid().replace(/-/g, '');
  return ['pbkdf2', PBKDF2_ITERATIONS, saltHex, pbkdf2Sha256Hex(password, hexToBytes(saltHex), PBKDF2_ITERATIONS)].join('$');
}

// Pre-PBKDF2 hashes: SHA-256 of "ELECTOSTOCK:" + password. Kept only so old
// accounts can still log in; they are upgraded on their next successful login.
function legacyHashPassword(password) {
  return sha256Hex('ELECTOSTOCK:' + password);
}

function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Returns 'ok', 'ok-legacy' (matched an old-format hash) or null.
function verifyPassword(password, stored) {
  stored = String(stored || '');
  const parts = stored.split('$');
  if (parts.length === 4 && parts[0] === 'pbkdf2') {
    const hash = pbkdf2Sha256Hex(password, hexToBytes(parts[2]), Number(parts[1]));
    return safeEqual(hash, parts[3]) ? 'ok' : null;
  }
  if (stored && safeEqual(legacyHashPassword(password), stored)) return 'ok-legacy';
  return null;
}

// ─── Auth: sessions ───────────────────────────────────────────────────────────
// One row per session in the hidden Sessions sheet, so a user can be signed in
// on several devices. Only a SHA-256 of each token is stored. Validated sessions
// are cached for a few minutes so most requests skip the sheet read.

function generateToken() {
  const a = Utilities.getUuid().replace(/-/g, '');
  const b = Utilities.getUuid().replace(/-/g, '');
  return (a + b).substring(0, 48);
}

function sessionCacheKey(tokenHash) { return 'session:' + tokenHash; }

function findUserRow(data, username) {
  const u = String(username).trim().toLowerCase();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === u) return i;
  }
  return -1;
}

function actionLogin(username, password) {
  if (!username || !password) return { error: 'Username and password required' };
  const sheet = getUsersSheet();
  ensureHeaders(sheet, USER_HEADERS);
  const data = sheet.getDataRange().getValues();
  const i    = findUserRow(data, username);
  const ok   = i > 0 ? verifyPassword(password, data[i][1]) : null;
  if (!ok) return { error: 'Invalid username or password' };
  if (ok === 'ok-legacy') sheet.getRange(i+1, 2).setValue(hashPassword(password));

  const name    = String(data[i][0]);
  const role    = String(data[i][2] || 'user').trim().toLowerCase();
  const token   = generateToken();
  const expires = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  pruneSessions(row => new Date(String(row[3])).getTime() > Date.now()); // drop expired
  getSessionsSheet().appendRow([sha256Hex(token), name, role, expires]);
  return { success: true, token, username: name, role };
}

function actionLogout(token) {
  if (token) {
    const tokenHash = sha256Hex(token);
    pruneSessions(row => String(row[0]) !== tokenHash);
    CacheService.getScriptCache().remove(sessionCacheKey(tokenHash));
  }
  return { success: true };
}

// Keep only session rows for which keep(row) is true; uncache the rest.
function pruneSessions(keep) {
  const sheet = getSessionsSheet();
  const data  = sheet.getDataRange().getValues().slice(1);
  const kept  = data.filter(keep);
  if (kept.length === data.length) return;
  const cache = CacheService.getScriptCache();
  data.filter(r => !keep(r)).forEach(r => cache.remove(sessionCacheKey(String(r[0]))));
  rewriteDataRows(sheet, SESSION_HEADERS.length, kept);
}

// Returns { session: { username, role, expires, tokenHash } } or { error, auth: false }.
function validateToken(token) {
  if (!token) return { error: 'Not authenticated', auth: false };
  const tokenHash = sha256Hex(String(token));
  const cache     = CacheService.getScriptCache();
  const cached    = cache.get(sessionCacheKey(tokenHash));
  let session     = cached ? JSON.parse(cached) : null;

  if (!session) {
    const rows = getSessionsSheet().getDataRange().getValues();
    const row  = rows.slice(1).find(r => String(r[0]) === tokenHash);
    if (!row) return { error: 'Not authenticated', auth: false };
    session = { username: String(row[1]), role: String(row[2]), expires: String(row[3]) };
  }
  // Set on every call, never taken from the cache: entries cached by older code lack it
  session.tokenHash = tokenHash;

  const remainingMs = new Date(session.expires).getTime() - Date.now();
  if (!(remainingMs > 0)) return { error: 'Session expired, please log in again', auth: false };
  if (!cached) {
    const ttl = Math.min(SESSION_CACHE_SECONDS, Math.floor(remainingMs / 1000));
    if (ttl > 0) cache.put(sessionCacheKey(tokenHash), JSON.stringify(session), ttl);
  }
  return { session };
}

// ─── User management ──────────────────────────────────────────────────────────
// Admins manage users in the app (listUsers / saveUser / deleteUser). createUser
// does the same from the Apps Script editor, e.g. to create the first admin.
// A change to someone's password or role signs them out everywhere, so the new
// role applies at their next login.

const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,40}$/;

function normUser(u) { return String(u || '').trim().toLowerCase(); }

// Each returns an error string or null.
function checkUsername(username) {
  return USERNAME_PATTERN.test(username) ? null : 'Usernames are 1-40 letters, numbers or . _ @ -';
}
function checkPassword(password) {
  return String(password).length >= MIN_PASSWORD_LENGTH ? null : 'Password must be at least ' + MIN_PASSWORD_LENGTH + ' characters';
}
function checkRole(role) {
  return role in ROLE_RANK ? null : 'Role must be one of: ' + Object.keys(ROLE_RANK).join(', ');
}

// The role a stored value grants: unknown values count as viewer, as in roleRank().
function effectiveRole(stored) {
  const r = String(stored || '').trim().toLowerCase();
  return r in ROLE_RANK ? r : 'viewer';
}

function countAdmins(rows) {
  return rows.slice(1).filter(r => String(r[0]).trim() && effectiveRole(r[2]) === 'admin').length;
}

// Sign a user out of every session, optionally keeping one (by token hash).
function revokeSessionsFor(username, keepTokenHash) {
  const u = normUser(username);
  pruneSessions(row => normUser(row[1]) !== u || (keepTokenHash && String(row[0]) === keepTokenHash));
}

function actionListUsers(session) {
  const sheet = getUsersSheet();
  ensureHeaders(sheet, USER_HEADERS);
  const sessions = getSessionsSheet().getDataRange().getValues().slice(1);
  const now = Date.now();
  const users = sheet.getDataRange().getValues().slice(1)
    .filter(r => String(r[0]).trim())
    .map(r => {
      const u = normUser(r[0]);
      return {
        username:        String(r[0]).trim(),
        role:            effectiveRole(r[2]),
        active_sessions: sessions.filter(s => normUser(s[1]) === u && new Date(String(s[3])).getTime() > now).length,
        is_self:         u === normUser(session.username),
      };
    })
    .sort((a, b) => a.username.localeCompare(b.username));
  return { users };
}

// data = { username, role, password?, create? }
// create: add a new user (password required). Otherwise change the role and/or,
// if a password is given, reset it.
function actionSaveUser(data, session) {
  const username = String(data.username || '').trim();
  const role     = String(data.role || '').trim().toLowerCase();
  const password = data.password ? String(data.password) : '';
  const err = checkUsername(username) || checkRole(role) || (password ? checkPassword(password) : null);
  if (err) return { error: err };

  const sheet = getUsersSheet();
  ensureHeaders(sheet, USER_HEADERS);
  const rows = sheet.getDataRange().getValues();
  const i    = findUserRow(rows, username);

  if (data.create) {
    if (i > 0)     return { error: 'A user named "' + username + '" already exists' };
    if (!password) return { error: 'Set a password for the new user' };
    sheet.appendRow([username, hashPassword(password), role]);
    return { success: true, created: true };
  }

  if (i < 0) return { error: 'User not found: ' + username };
  const isSelf      = normUser(username) === normUser(session.username);
  const currentRole = effectiveRole(rows[i][2]);
  const roleChanged = role !== currentRole;
  if (roleChanged && isSelf) return { error: "You can't change your own role. Ask another admin to do it." };
  if (roleChanged && currentRole === 'admin' && countAdmins(rows) <= 1) return { error: 'There must be at least one admin.' };
  if (!roleChanged && !password) return { success: true };

  sheet.getRange(i+1, 2, 1, 2).setValues([[password ? hashPassword(password) : rows[i][1], role]]);
  // An admin changing their own password stays signed in on this device
  revokeSessionsFor(username, isSelf ? session.tokenHash : null);
  return { success: true };
}

// Any signed-in user changing their own password. The current password is
// required, so someone at an unattended, signed-in computer can't change it.
// Keeps this session and signs out the user's other devices.
// data = { current_password, new_password }
function actionChangePassword(data, session) {
  const current = String(data.current_password || '');
  const next    = String(data.new_password || '');
  const err = checkPassword(next);
  if (err) return { error: err };
  const sheet = getUsersSheet();
  ensureHeaders(sheet, USER_HEADERS);
  const rows = sheet.getDataRange().getValues();
  const i    = findUserRow(rows, session.username);
  if (i < 0) return { error: 'User not found: ' + session.username };
  if (!current || !verifyPassword(current, rows[i][1])) return { error: 'Your current password is incorrect' };
  sheet.getRange(i+1, 2).setValue(hashPassword(next));
  revokeSessionsFor(session.username, session.tokenHash);
  return { success: true };
}

function actionDeleteUser(username, session) {
  username = String(username || '').trim();
  if (normUser(username) === normUser(session.username)) return { error: "You can't delete your own account." };
  const sheet = getUsersSheet();
  const rows  = sheet.getDataRange().getValues();
  const i     = findUserRow(rows, username);
  if (i < 0) return { error: 'User not found: ' + username };
  if (effectiveRole(rows[i][2]) === 'admin' && countAdmins(rows) <= 1) return { error: 'There must be at least one admin.' };
  sheet.deleteRow(i+1);
  revokeSessionsFor(username);
  return { success: true };
}

// Run from the Apps Script editor. Creates the user, or updates the password and
// role of an existing one and signs them out everywhere.
function createUser(username, password, role) {
  if (!username || !password) {
    Logger.log('Usage: createUser("username", "password", "role")');
    return;
  }
  username = String(username).trim();
  role     = String(role || 'user').trim().toLowerCase();
  const err = checkUsername(username) || checkPassword(password) || checkRole(role);
  if (err) throw new Error(err);

  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    const sheet = getUsersSheet();
    ensureHeaders(sheet, USER_HEADERS);
    const data = sheet.getDataRange().getValues();
    const i    = findUserRow(data, username);
    if (i > 0) {
      sheet.getRange(i+1, 2, 1, 2).setValues([[hashPassword(password), role]]);
      revokeSessionsFor(username);
      Logger.log('Updated user: ' + username + ' (signed out of all sessions)');
    } else {
      sheet.appendRow([username, hashPassword(password), role]);
      Logger.log('Created user: ' + username);
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

// Step 1: Uncomment a line below and fill in a username, a long unique password
//         and a role (viewer | user | admin)
// Step 2: Select setupUsers in the function dropdown and click Run
// Step 3: Check the Execution Log, then delete the password from this file again
//
// viewer: read only · user: edit stock, BOMs, checkouts, categories · admin: also delete
function setupUsers() {
  // createUser('admin', '', 'admin');
  // createUser('alice', '', 'user');
  Logger.log('Edit setupUsers() first: uncomment a createUser line and fill in the password.');
}
