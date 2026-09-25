// Fixes from the security review (migration …_hardening.sql).
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser, q, rows, rpc, num } from './harness.mjs';

async function setup() {
  const db = await freshDb();
  const ada = await addUser(db, 'ada@example.com', 'admin');
  const uma = await addUser(db, 'uma@example.com', 'user');
  const vic = await addUser(db, 'vic@example.com', 'viewer');
  const add = async (name, qty, unit_cost = 0) => (await rows(db, uma,
    'insert into items (name, qty, unit_cost) values ($1, $2, $3) returning id', [name, qty, unit_cost]))[0].id;
  const R1 = await add('R1', 100, 0.1);
  const C1 = await add('C1', 50, 0.5);
  const Board = await add('Board', 0);
  await rpc(db, uma, 'save_bom', { p_parent_id: Board, p_lines: JSON.stringify([{ child_id: R1, quantity: 2 }, { child_id: C1, quantity: -1 }]) });
  const item = async id => (await rows(db, ada, 'select * from items where id = $1', [id]))[0];
  return { db, ada, uma, vic, R1, C1, Board, item };
}

const rejects = (promise, pattern) => assert.rejects(promise, err => pattern.test(err.message));
const profile = async (db, id) => (await rows(db, id, 'select role, password_set from profiles where user_id = $1', [id]))[0];

// ── Password chosen ─────────────────────────────────────────────────────────

test('"password chosen" starts false and only the database sets it', async () => {
  const { db, uma, vic } = await setup();
  assert.equal((await profile(db, uma)).password_set, false);
  await rpc(db, uma, 'mark_password_set');
  assert.equal((await profile(db, uma)).password_set, true);
  assert.equal((await profile(db, vic)).password_set, false);   // only the caller's own row
  // Nobody can set it directly through the API: refused here; on Supabase, where
  // authenticated has table grants, row-level security leaves 0 rows changed
  const direct = await q(db, vic, 'update profiles set password_set = true where user_id = $1', [vic]).catch(e => e);
  assert.ok(direct instanceof Error ? /permission denied/.test(direct.message) : !direct.affectedRows);
  assert.equal((await profile(db, vic)).password_set, false);
  await rejects(rpc(db, null, 'mark_password_set'), /permission denied/);
});

test('existing accounts with password_set in their metadata keep it', async () => {
  // Re-run the backfill the way the migration did, for a user created before it
  const { db, vic } = await setup();
  await db.query(`update auth.users set raw_user_meta_data = '{"password_set": true}' where id = $1`, [vic]);
  await db.query(`update public.profiles p set password_set = true from auth.users u
                  where u.id = p.user_id and coalesce(u.raw_user_meta_data ->> 'password_set', '') = 'true'`);
  assert.equal((await profile(db, vic)).password_set, true);
});

// ── Finite numbers ──────────────────────────────────────────────────────────

test('NaN and Infinity are refused everywhere a user can send a number', async () => {
  const { db, uma, R1, C1, Board, item } = await setup();
  for (const bad of ['NaN', 'Infinity']) {
    await rejects(db.query('update items set qty = $1 where id = $2', [bad, R1]), /items_numbers_finite|check constraint/);   // even as the owner
    await rejects(q(db, uma, 'update items set unit_cost = $1 where id = $2', [bad, R1]), /items_numbers_finite|check constraint/);
    await rejects(q(db, uma, 'update items set min = $1 where id = $2', [bad, R1]), /items_numbers_finite|check constraint/);
    await rejects(q(db, uma, 'update bom_lines set quantity = $1 where parent_id = $2', [bad, Board]), /bom_lines_quantity_finite|check constraint/);
    await rejects(rpc(db, uma, 'move_stock', { p_id: R1, p_action: 'set', p_qty: bad, p_note: '' }), /0 or more|finite|check constraint/);
    await rejects(rpc(db, uma, 'adjust_stock', { p_id: R1, p_action: 'add', p_qty: bad, p_note: '' }), /0 or more|finite|check constraint/);
    await rejects(rpc(db, uma, 'checkout', { p_assembly_id: Board, p_qty_built: bad, p_job_name: 'J' }), /check constraint|whole number/);
    await rejects(rpc(db, uma, 'save_bom', { p_parent_id: Board, p_lines: JSON.stringify([{ child_id: R1, quantity: bad }]) }), /check constraint|number other than 0/);
  }
  await rejects(q(db, uma, "update items set min = '-Infinity' where id = $1", [R1]), /check constraint/);
  assert.equal(num((await item(R1)).qty), 100);
  assert.equal(num((await item(C1)).qty), 50);
  assert.equal((await rows(db, uma, 'select * from checkout_log')).length, 0);
});

// ── move_stock ──────────────────────────────────────────────────────────────

test('move_stock reports the change the database actually made', async () => {
  const { db, uma, R1 } = await setup();
  const r = await rpc(db, uma, 'move_stock', { p_id: R1, p_action: 'remove', p_qty: 250, p_note: 'all of it' });
  assert.deepEqual([num(r.qty_before), num(r.qty_after), num(r.qty_change)], [100, 0, -100]);
  const s = await rpc(db, uma, 'move_stock', { p_id: R1, p_action: 'set', p_qty: 40, p_note: '' });
  assert.deepEqual([num(s.qty_before), num(s.qty_after), num(s.qty_change)], [0, 40, 40]);
  const log = await rows(db, uma, 'select action, qty_change, note from stock_moves order by id');
  assert.deepEqual(log.map(m => [m.action, num(m.qty_change), m.note]), [['remove', -100, 'all of it'], ['set', 40, '']]);
  // adjust_stock still returns the new quantity for the older page
  assert.equal(num(await rpc(db, uma, 'adjust_stock', { p_id: R1, p_action: 'add', p_qty: 1, p_note: '' })), 41);
});

test('viewers and anonymous visitors cannot call move_stock', async () => {
  const { db, vic, R1 } = await setup();
  await rejects(rpc(db, vic, 'move_stock', { p_id: R1, p_action: 'add', p_qty: 1, p_note: '' }), /not allowed/);
  await rejects(rpc(db, null, 'move_stock', { p_id: R1, p_action: 'add', p_qty: 1, p_note: '' }), /permission denied/);
});

// ── Email changes, the admin guard, BOM writes, export ──────────────────────

test('a changed sign-in email is copied to the profile', async () => {
  const { db, uma } = await setup();
  await db.query("update auth.users set email = 'Uma.New@Example.com' where id = $1", [uma]);
  assert.equal((await rows(db, uma, 'select email from profiles where user_id = $1', [uma]))[0].email, 'uma.new@example.com');
});

test('the last admin still cannot be removed', async () => {
  const { db, ada, uma } = await setup();
  await rpc(db, ada, 'admin_set_role', { p_user_id: uma, p_role: 'admin' });
  await rpc(db, uma, 'admin_set_role', { p_user_id: ada, p_role: 'user' });
  await rejects(db.query("update profiles set role = 'user' where user_id = $1", [uma]), /at least one admin/);
});

test('BOM writes still validate and roll costs up with the new lock', async () => {
  const { db, uma, R1, C1, Board, item } = await setup();
  assert.equal(num((await item(Board)).unit_cost).toFixed(2), '-0.30');   // 2 × 0.1 − 1 × 0.5
  await rejects(q(db, uma, 'insert into bom_lines values ($1, $2, 1)', [R1, Board]), /already contains/);
  await rpc(db, uma, 'save_bom', { p_parent_id: Board, p_lines: JSON.stringify([{ child_id: C1, quantity: 3 }]) });
  assert.equal(num((await item(Board)).unit_cost).toFixed(2), '1.50');
});

test('the sheet export includes the stock-move log', async () => {
  const { db, uma, R1 } = await setup();
  await rpc(db, uma, 'move_stock', { p_id: R1, p_action: 'add', p_qty: 5, p_note: 'restock' });
  const token = (await db.query('select public.create_export_token() as t')).rows[0].t;
  const s = (await q(db, null, 'select public.export_snapshot($1) as s', [token])).rows[0].s;
  assert.deepEqual(s.stock_moves.map(m => [m.item_name, m.action, m.qty_change, m.note]), [['R1', 'add', 5, 'restock']]);
});

// ── Stock levels only through the logging functions ─────────────────────────

test('users cannot write quantities directly, only through move_stock and checkout', async () => {
  const { db, uma, R1, C1, Board, item } = await setup();
  await rejects(q(db, uma, 'update items set qty = 0 where id = $1', [R1]), /permission denied/);
  await rejects(q(db, uma, "update items set qty = 0, notes = 'x' where id = $1", [R1]), /permission denied/);
  // Every other column is still editable, and costs still roll up through the triggers
  await q(db, uma, "update items set name = 'R1 0805', notes = 'reel 2', unit_cost = 0.2, min = 10, barcode = 'B1' where id = $1", [R1]);
  assert.equal(num((await item(Board)).unit_cost).toFixed(2), '-0.10');   // 2 × 0.2 − 1 × 0.5
  // The functions that log still change stock
  await rpc(db, uma, 'move_stock', { p_id: R1, p_action: 'remove', p_qty: 4, p_note: '' });
  await rpc(db, uma, 'checkout', { p_assembly_id: Board, p_qty_built: 1, p_job_name: 'J' });
  assert.equal(num((await item(R1)).qty), 94);   // 100 − 4 − 2
  assert.equal(num((await item(C1)).qty), 51);   // the BOM's −1 returns one
  // New items can still start with a quantity
  await q(db, uma, "insert into items (name, qty) values ('New part', 25)");
});
