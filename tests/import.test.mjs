// The sheet → Supabase import: CSV parsing, data checks, and the generated SQL
// loaded into the real schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, buildImport, toSql } from '../scripts/import-sheet.mjs';
import { freshDb } from './db/harness.mjs';

const csv = rows => rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
const inv = (...items) => [['id', 'part', 'name', 'category', 'qty', 'min', 'location', 'unit_cost', 'supplier', 'supplier_part', 'notes', 'updated_at'],
  ...items.map(([id, name, qty = 0, cost = 0, category = '']) => [id, '', name, category, qty, 0, '', cost, '', '', '', ''])];
const build = ({ items, boms = [], cats = [['Resistor', '#fff']], log = [] }) => buildImport({
  inventory:  parseCsv(csv(inv(...items))),
  categories: parseCsv(csv([['name', 'color'], ...cats])),
  boms:       parseCsv(csv([['parent_id', 'child_id', 'quantity'], ...boms])),
  log:        parseCsv(csv([['timestamp', 'job_name', 'assembly_name', 'assembly_id', 'qty_built', 'component_name',
    'component_supplier_part', 'component_location', 'qty_deducted', 'sub_assembly_name', 'depth'], ...log])),
});

test('parseCsv handles quotes, commas and newlines inside fields', () => {
  const rows = parseCsv('a,b\r\n"x, ""y""","line1\nline2"\r\n\r\n');
  assert.deepEqual(rows, [{ a: 'x, "y"', b: 'line1\nline2' }]);
});

test('clean data produces no problems', () => {
  const d = build({ items: [[1, 'R1', 5, 0.1, 'Resistor'], [2, 'Board']], boms: [[2, 1, 3]] });
  assert.deepEqual([d.problems, d.notes], [[], []]);
  assert.equal(d.lines.length, 1);
});

test('fixable issues are fixed and reported', () => {
  const d = build({
    items: [[1, 'R1', -4], [2, 'Board', 0, 0, 'Unknown']],
    boms: [[2, 1, 1], [2, 1, 2], [2, 99, 1], [2, 2, 1], [2, 1, '']],
    cats: [['Resistor', '#fff'], ['resistor', '#000']],
  });
  assert.equal(d.items.find(i => i.id === 1).qty, 0);
  assert.deepEqual(d.lines, [{ parent_id: 2, child_id: 1, quantity: 4 }]);    // 1 + 2 + blank(=1)
  assert.equal(d.categories.length, 1);
  assert.equal(d.problems.length, 0);
  for (const pattern of [/quantity -4/, /isn't in the Categories tab/, /doesn't exist/, /contains itself/, /twice/, /letter case/]) {
    assert.ok(d.notes.some(n => pattern.test(n)), `expected a note matching ${pattern}`);
  }
});

test('blocking problems are reported: loops, duplicate ids, missing names, bad times', () => {
  const d = build({
    items: [[1, 'A'], [2, 'B'], [3, 'C'], [3, 'C again'], [4, '']],
    boms: [[1, 2, 1], [2, 3, 1], [3, 1, 1]],
    log: [['yesterday', 'J', 'A', 1, 1, 'B', '', '', 1, 'A', 0]],
  });
  assert.ok(d.problems.some(p => /BOM loop: "A" → "B" → "C" → "A"/.test(p)), d.problems.join('\n'));
  assert.ok(d.problems.some(p => /id 3 appears twice/.test(p)));
  assert.ok(d.problems.some(p => /id 4 has no name/.test(p)));
  assert.ok(d.problems.some(p => /isn't in the expected/.test(p)));
});

test('the generated SQL loads into the schema, keeps ids and converts log times from New York time', async () => {
  const d = build({
    items: [[5, "O'Brien cap", 10, 0.5], [9, 'Kit']],
    boms: [[9, 5, 2]],
    log: [['2026-01-15 09:30:00', 'Job', 'Kit', 9, 1, "O'Brien cap", '', '', 2, 'Kit', 0]],
  });
  const db = await freshDb();
  await db.exec(toSql(d));
  const items = (await db.query('select id, name, unit_cost::float as cost from items order by id')).rows;
  assert.deepEqual(items, [{ id: 5, name: "O'Brien cap", cost: 0.5 }, { id: 9, name: 'Kit', cost: 1 }]);  // Kit recalculated
  const utc = (await db.query("select to_char(created_at at time zone 'UTC', 'HH24:MI') t from checkout_log")).rows[0].t;
  assert.equal(utc, '14:30');                                    // 09:30 EST = 14:30 UTC
  const next = (await db.query("insert into items (name) values ('new') returning id")).rows[0].id;
  assert.equal(next, 10);
});

test('re-running the import replaces inventory data but keeps users', async () => {
  const db = await freshDb();
  await db.query("insert into invites (email, role) values ('ada@example.com', 'admin')");
  await db.query("insert into auth.users (email) values ('ada@example.com')");
  const sql = toSql(build({ items: [[1, 'R1']] }));
  await db.exec(sql);
  await db.query("insert into items (name) values ('added after first import')");
  await db.exec(sql);
  assert.equal((await db.query('select count(*)::int n from items')).rows[0].n, 1);
  assert.equal((await db.query('select count(*)::int n from profiles')).rows[0].n, 1);
});
