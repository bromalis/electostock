// Barcodes on items and the stock-move log written by adjust_stock().
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser, q, rows, rpc, num } from './harness.mjs';

async function setup() {
  const db = await freshDb();
  const ada = await addUser(db, 'ada@example.com', 'admin');
  const uma = await addUser(db, 'uma@example.com', 'user');
  const vic = await addUser(db, 'vic@example.com', 'viewer');
  const add = async (name, qty, extra = {}) => (await rows(db, uma,
    'insert into items (name, qty, supplier_part, location, barcode) values ($1, $2, $3, $4, $5) returning id',
    [name, qty, extra.supplier_part || '', extra.location || '', extra.barcode || '']))[0].id;
  const R1 = await add('R1', 100, { supplier_part: '311-10KARCT-ND', location: 'A3' });
  const C1 = await add('C1', 50);
  return { db, ada, uma, vic, R1, C1 };
}

const rejects = (promise, pattern) => assert.rejects(promise, err => pattern.test(err.message));
const moves = (db, user) => rows(db, user, 'select * from stock_moves order by id');

test('adjust_stock changes the quantity and logs who, what and why', async () => {
  const { db, uma, vic, R1 } = await setup();
  assert.equal(num(await rpc(db, uma, 'adjust_stock', { p_id: R1, p_action: 'remove', p_qty: 30, p_note: ' GMU 25-47 ' })), 70);
  assert.equal(num(await rpc(db, uma, 'adjust_stock', { p_id: R1, p_action: 'add', p_qty: 5, p_note: '' })), 75);
  assert.equal(num(await rpc(db, uma, 'adjust_stock', { p_id: R1, p_action: 'set', p_qty: 60, p_note: 'stocktake' })), 60);
  const log = await moves(db, vic);
  assert.deepEqual(log.map(m => [m.action, num(m.qty_requested), num(m.qty_change), num(m.qty_after), m.note]), [
    ['remove', 30, -30, 70, 'GMU 25-47'], ['add', 5, 5, 75, ''], ['set', 60, -15, 60, 'stocktake'],
  ]);
  assert.ok(log.every(m => m.item_id === R1 && m.item_name === 'R1' && m.supplier_part === '311-10KARCT-ND'
    && m.location === 'A3' && m.user_email === 'uma@example.com'));
});

test('removing more than is in stock floors at 0 and logs the actual change', async () => {
  const { db, uma, C1 } = await setup();
  assert.equal(num(await rpc(db, uma, 'adjust_stock', { p_id: C1, p_action: 'remove', p_qty: 80, p_note: '' })), 0);
  const [m] = await moves(db, uma);
  assert.equal(num(m.qty_requested), 80);
  assert.equal(num(m.qty_change), -50);
});

test('adjust_stock validates its input and changes nothing on error', async () => {
  const { db, uma, R1 } = await setup();
  await rejects(rpc(db, uma, 'adjust_stock', { p_id: R1, p_action: 'take', p_qty: 1, p_note: '' }), /Unknown adjustment/);
  await rejects(rpc(db, uma, 'adjust_stock', { p_id: R1, p_action: 'add', p_qty: -1, p_note: '' }), /0 or more/);
  await rejects(rpc(db, uma, 'adjust_stock', { p_id: 99999, p_action: 'add', p_qty: 1, p_note: '' }), /not found/);
  assert.equal(num((await rows(db, uma, 'select qty from items where id = $1', [R1]))[0].qty), 100);
  assert.equal((await moves(db, uma)).length, 0);
});

test('the old adjust_qty still works and is logged too', async () => {
  const { db, uma, R1 } = await setup();
  assert.equal(num(await rpc(db, uma, 'adjust_qty', { p_id: R1, p_action: 'add', p_qty: 5 })), 105);
  const [m] = await moves(db, uma);
  assert.equal(m.action, 'add');
  assert.equal(num(m.qty_change), 5);
});

test('viewers and anonymous visitors cannot adjust stock or write the log', async () => {
  const { db, vic, R1 } = await setup();
  await rejects(rpc(db, vic, 'adjust_stock', { p_id: R1, p_action: 'add', p_qty: 1, p_note: '' }), /not allowed/);
  await rejects(rpc(db, null, 'adjust_stock', { p_id: R1, p_action: 'add', p_qty: 1, p_note: '' }), /permission denied/);
  await rejects(rows(db, null, 'select * from stock_moves'), /permission denied/);
  await rejects(q(db, vic, "insert into stock_moves (item_name, action, qty_requested, qty_change, qty_after) values ('x', 'add', 1, 1, 1)"),
    /permission denied|row-level security/);
});

test('the stock-move log keeps its rows when the item is deleted', async () => {
  const { db, ada, uma, C1 } = await setup();
  await rpc(db, uma, 'adjust_stock', { p_id: C1, p_action: 'add', p_qty: 1, p_note: '' });
  await q(db, ada, 'delete from items where id = $1', [C1]);
  const [m] = await moves(db, uma);
  assert.equal(m.item_name, 'C1');
});

test('a barcode belongs to one item at most; blank means none', async () => {
  const { db, uma, R1, C1 } = await setup();
  await q(db, uma, "update items set barcode = 'ABC123' where id = $1", [R1]);
  await rejects(q(db, uma, "update items set barcode = ' ABC123 ' where id = $1", [C1]), /duplicate key/);
  await q(db, uma, "insert into items (name) values ('X'), ('Y')");  // both blank
  assert.equal((await rows(db, uma, "select id from items where barcode = ''")).length, 3);
});

test('viewers cannot change barcodes', async () => {
  const { db, vic, R1 } = await setup();
  assert.equal((await q(db, vic, "update items set barcode = 'Z' where id = $1", [R1])).affectedRows, 0);
});
