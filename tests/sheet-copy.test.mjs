// Code.gs (the read-only Google Sheet copy), run against in-memory stand-ins for
// the Apps Script services it uses, with a real export snapshot from the
// Supabase schema running on PGlite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { freshDb, addUser, q } from './db/harness.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Values created inside the vm belong to another realm: compare plain copies,
// and detect Dates without instanceof.
const plain = v => JSON.parse(JSON.stringify(v));
const isDate = v => Object.prototype.toString.call(v) === '[object Date]';

class FakeSheet {
  constructor(name) { this.name = name; this.values = []; this.protection = null; this.frozen = 0; }
  clearContents() { this.values = []; }
  getRange(row, col, nRows, nCols) {
    return {
      setValues: v => { v.forEach((r, i) => { this.values[row - 1 + i] = r.slice(0, nCols); }); return this; },
      setFontWeight: () => {},
    };
  }
  setFrozenRows(n) { this.frozen = n; }
  getProtections() { return this.protection ? [this.protection] : []; }
  protect() {
    const editors = ['someone-else@example.com'];
    this.protection = {
      editors, domainEdit: true, description: '',
      setDescription(d) { this.description = d; return this; },
      getEditors() { return [...editors]; },
      removeEditors(list) { list.forEach(e => editors.splice(editors.indexOf(e), 1)); return this; },
      canDomainEdit() { return this.domainEdit; },
      setDomainEdit(v) { this.domainEdit = v; return this; },
    };
    return this.protection;
  }
}

function loadScript({ token, fetch }) {
  const sheets = new Map();
  const triggers = [];
  const ctx = vm.createContext({
    SpreadsheetApp: {
      ProtectionType: { SHEET: 'SHEET' },
      getActiveSpreadsheet: () => ({
        getSheetByName: n => sheets.get(n) || null,
        insertSheet: n => { const s = new FakeSheet(n); sheets.set(n, s); return s; },
      }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k === 'EXPORT_TOKEN' ? token : null) }) },
    UrlFetchApp: { fetch },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    ScriptApp: {
      getProjectTriggers: () => [...triggers],
      deleteTrigger: t => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: fn => ({ timeBased: () => ({ everyHours: h => ({ create: () => triggers.push({ getHandlerFunction: () => fn, hours: h }) }) }) }),
    },
    Logger: { log: () => {} },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'Code.gs'), 'utf8'), ctx);
  return { ctx, sheets, triggers };
}

// A real snapshot, fetched the way Apps Script would (anon role + token)
async function setupDb() {
  const db = await freshDb();
  const ada = await addUser(db, 'ada@example.com', 'admin');
  await q(db, ada, "insert into categories values ('Resistor', '#fff')");
  await q(db, ada, "insert into items (id, name, category, qty, unit_cost) values (1, 'R1', 'Resistor', 100, 0.1), (2, 'Board', '', 0, 0)");
  await q(db, ada, 'insert into bom_lines values (2, 1, 4)');
  await q(db, ada, "select public.checkout(2, 1, 'Job 7')");
  const token = (await db.query('select public.create_export_token() as t')).rows[0].t;
  // UrlFetchApp.fetch is synchronous, so tests resolve the snapshot up front
  const snapshotFor = async t => {
    try { return { code: 200, body: JSON.stringify((await q(db, null, 'select public.export_snapshot($1) as s', [t])).rows[0].s) }; }
    catch (e) { return { code: 403, body: JSON.stringify({ message: e.message }) }; }
  };
  return { db, token, snapshotFor };
}

const fetcherFor = (response, calls) => (url, opts) => {
  calls.push({ url, opts });
  return { getResponseCode: () => response.code, getContentText: () => response.body };
};

test('refreshSheetCopy writes every tab, keeps the old column order and locks the tabs', async () => {
  const { token, snapshotFor } = await setupDb();
  const calls = [];
  const { ctx, sheets } = loadScript({ token, fetch: fetcherFor(await snapshotFor(token), calls) });
  ctx.refreshSheetCopy();

  assert.equal(calls[0].url, 'https://tnjledlrzwtnocvmtgrf.supabase.co/rest/v1/rpc/export_snapshot');
  assert.deepEqual(JSON.parse(calls[0].opts.payload), { p_token: token });
  assert.ok(!('Authorization' in calls[0].opts.headers), 'the publishable key goes in apikey only');

  const inv = sheets.get('Inventory').values;
  assert.deepEqual(plain(inv[0].slice(0, 5)), ['id', 'part', 'name', 'category', 'qty']);
  assert.deepEqual(plain(inv.slice(1).map(r => [r[0], r[2], Number(r[4]), Number(r[7])])), [[1, 'R1', 96, 0.1], [2, 'Board', 0, 0.4]]);
  assert.ok(isDate(inv[1][11]));

  assert.deepEqual(plain(sheets.get('BOMs').values), [
    ['parent_id', 'child_id', 'quantity', 'parent_name', 'child_name'], [2, 1, 4, 'Board', 'R1']]);
  assert.deepEqual(plain(sheets.get('Categories').values), [['name', 'color'], ['Resistor', '#fff']]);

  const log = sheets.get('Checkout Log').values;
  assert.equal(log.length, 2);
  assert.ok(isDate(log[1][0]));
  assert.deepEqual([log[1][1], log[1][5], Number(log[1][8]), log[1][11]], ['Job 7', 'R1', 4, 'ada@example.com']);

  for (const name of ['Inventory', 'Categories', 'BOMs', 'Checkout Log', 'About this copy']) {
    const p = sheets.get(name).protection;
    assert.ok(p, `${name} is protected`);
    assert.deepEqual(plain(p.getEditors()), [], `${name}: only the owner can edit`);
    assert.equal(p.canDomainEdit(), false);
  }
  assert.match(sheets.get('About this copy').values[3][0], /Last refreshed/);
});

test('refreshing again replaces the contents rather than adding to them', async () => {
  const { token, snapshotFor } = await setupDb();
  const { ctx, sheets } = loadScript({ token, fetch: fetcherFor(await snapshotFor(token), []) });
  ctx.refreshSheetCopy();
  ctx.refreshSheetCopy();
  assert.equal(sheets.get('Inventory').values.length, 3);
});

test('a missing or wrong token fails loudly and writes nothing', async () => {
  const { snapshotFor } = await setupDb();
  const none = loadScript({ token: null, fetch: () => assert.fail('should not fetch') });
  assert.throws(() => none.ctx.refreshSheetCopy(), /Set EXPORT_TOKEN/);
  const wrong = loadScript({ token: 'nope', fetch: fetcherFor(await snapshotFor('nope'), []) });
  assert.throws(() => wrong.ctx.refreshSheetCopy(), /export failed \(403\).*Invalid export token/);
  assert.equal(wrong.sheets.size, 0);
});

test('installHourlyRefresh replaces the old onEdit trigger with one hourly refresh', async () => {
  const { token, snapshotFor } = await setupDb();
  const { ctx, triggers, sheets } = loadScript({ token, fetch: fetcherFor(await snapshotFor(token), []) });
  triggers.push({ getHandlerFunction: () => 'onEdit' });
  ctx.installHourlyRefresh();
  ctx.installHourlyRefresh();   // running it twice doesn't double up
  assert.deepEqual(plain(triggers.map(t => [t.getHandlerFunction(), t.hours])), [['refreshSheetCopy', 1]]);
  assert.ok(sheets.get('Inventory'));
});

test('the retired web app tells old pages where the app went', () => {
  const { ctx } = loadScript({ token: null, fetch: () => {} });
  for (const fn of ['doGet', 'doPost']) {
    assert.match(JSON.parse(ctx[fn]({}).text).error, /ElectoStock has moved.*bromalis\.github\.io\/electostock/);
  }
});
