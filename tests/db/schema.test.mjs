// Behaviour of the Supabase schema: permissions, cost rollups, BOM validation,
// checkout and user admin. Mirrors what tests/api.test.js checks for Code.gs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser, q, rows, rpc, num } from './harness.mjs';

// Board = 2×R1 + 1×Sub,  Sub = 3×R1 + 1×C1
async function setup() {
  const db = await freshDb();
  const ada = await addUser(db, 'ada@example.com', 'admin');
  const uma = await addUser(db, 'uma@example.com', 'user');
  const vic = await addUser(db, 'vic@example.com', 'viewer');
  const add = async (name, qty, unit_cost = 0) => (await rows(db, uma,
    'insert into items (name, qty, unit_cost) values ($1, $2, $3) returning id', [name, qty, unit_cost]))[0].id;
  const ids = {};
  ids.R1 = await add('R1', 100, 0.1);
  ids.C1 = await add('C1', 50, 0.5);
  ids.Sub = await add('Sub', 0);
  ids.Board = await add('Board', 0);
  await rpc(db, uma, 'save_bom', { p_parent_id: ids.Sub, p_lines: JSON.stringify([{ child_id: ids.R1, quantity: 3 }, { child_id: ids.C1, quantity: 1 }]) });
  await rpc(db, uma, 'save_bom', { p_parent_id: ids.Board, p_lines: JSON.stringify([{ child_id: ids.R1, quantity: 2 }, { child_id: ids.Sub, quantity: 1 }]) });
  const item = async id => (await rows(db, ada, 'select * from items where id = $1', [id]))[0];
  const lines = arr => JSON.stringify(arr);
  return { db, ada, uma, vic, ids, item, lines };
}

const rejects = (promise, pattern) => assert.rejects(promise, err => pattern.test(err.message));

// ── Permissions ─────────────────────────────────────────────────────────────

test('anonymous visitors see nothing and can do nothing', async () => {
  const { db, ids } = await setup();
  await rejects(rows(db, null, 'select * from items'), /permission denied/);
  await rejects(rpc(db, null, 'adjust_qty', { p_id: ids.R1, p_action: 'add', p_qty: 1 }), /permission denied/);
});

test('viewers can read but not write', async () => {
  const { db, vic, ids } = await setup();
  assert.equal((await rows(db, vic, 'select * from items')).length, 4);
  assert.equal((await rows(db, vic, 'select * from bom_lines')).length, 4);
  await rejects(q(db, vic, "insert into items (name) values ('x')"), /row-level security/);
  assert.equal((await q(db, vic, 'update items set qty = 0 where id = $1', [ids.R1])).affectedRows, 0);
  await rejects(rpc(db, vic, 'adjust_qty', { p_id: ids.R1, p_action: 'add', p_qty: 1 }), /not allowed/);
  await rejects(rpc(db, vic, 'checkout', { p_assembly_id: ids.Board, p_qty_built: 1, p_job_name: 'J' }), /not allowed/);
  await rejects(rpc(db, vic, 'save_bom', { p_parent_id: ids.Sub, p_lines: '[]' }), /not allowed/);
});

test('users can edit but only admins can delete items and categories', async () => {
  const { db, ada, uma, ids } = await setup();
  await q(db, uma, "insert into categories (name, color) values ('Resistor', '#fff')");
  assert.equal((await q(db, uma, 'delete from items where id = $1', [ids.C1])).affectedRows, 0);
  assert.equal((await q(db, uma, "delete from categories where name = 'Resistor'")).affectedRows, 0);
  assert.equal((await q(db, ada, 'delete from items where id = $1', [ids.C1])).affectedRows, 1);
  assert.equal((await q(db, ada, "delete from categories where name = 'Resistor'")).affectedRows, 1);
});

test('the checkout log can only be written by checkout()', async () => {
  const { db, ada } = await setup();
  await rejects(q(db, ada, "insert into checkout_log (job_name, assembly_id, assembly_name, qty_built, component_name, qty_deducted) values ('j', 1, 'a', 1, 'c', 1)"),
    /permission denied|row-level security/);
});

test('a deleted user loses access immediately', async () => {
  const { db, ada, uma } = await setup();
  await rpc(db, ada, 'admin_delete_user', { p_user_id: uma });
  assert.equal((await rows(db, uma, 'select * from items')).length, 0);
  await rejects(rpc(db, uma, 'adjust_qty', { p_id: 1, p_action: 'add', p_qty: 1 }), /not allowed/);
});

test('a role change takes effect on the next request, without signing out', async () => {
  const { db, ada, vic, ids } = await setup();
  await rpc(db, ada, 'admin_set_role', { p_user_id: vic, p_role: 'user' });
  assert.equal(num(await rpc(db, vic, 'adjust_qty', { p_id: ids.R1, p_action: 'add', p_qty: 1 })), 101);
});

// ── Sign-up is invite-only ──────────────────────────────────────────────────

test('only invited emails can create an account, with the invited role', async () => {
  const { db, ada } = await setup();
  await rejects(db.query("insert into auth.users (email) values ('stranger@example.com')"), /has not been invited/);
  await rpc(db, ada, 'admin_invite', { p_email: '  New@Example.com ', p_role: 'user' });
  const { rows: [u] } = await db.query("insert into auth.users (email) values ('new@example.com') returning id");
  assert.equal((await db.query('select role from profiles where user_id = $1', [u.id])).rows[0].role, 'user');
  assert.equal((await db.query('select count(*)::int as n from invites')).rows[0].n, 0);
});

// ── Stock adjustments ───────────────────────────────────────────────────────

test('adjust_qty adds, removes (floored at 0) and sets', async () => {
  const { db, uma, ids } = await setup();
  assert.equal(num(await rpc(db, uma, 'adjust_qty', { p_id: ids.R1, p_action: 'add', p_qty: 5 })), 105);
  assert.equal(num(await rpc(db, uma, 'adjust_qty', { p_id: ids.R1, p_action: 'remove', p_qty: 500 })), 0);
  assert.equal(num(await rpc(db, uma, 'adjust_qty', { p_id: ids.R1, p_action: 'set', p_qty: 7 })), 7);
  await rejects(rpc(db, uma, 'adjust_qty', { p_id: 99999, p_action: 'add', p_qty: 1 }), /not found/);
});

test('partial updates leave other fields alone', async () => {
  const { db, uma, ids, item } = await setup();
  await rpc(db, uma, 'adjust_qty', { p_id: ids.R1, p_action: 'set', p_qty: 7 });
  await q(db, uma, "update items set notes = 'reel 3' where id = $1", [ids.R1]);
  const r1 = await item(ids.R1);
  assert.equal(num(r1.qty), 7);
  assert.equal(r1.notes, 'reel 3');
});

// ── Cost rollups ────────────────────────────────────────────────────────────

test('saving a BOM rolls costs up through ancestors', async () => {
  const { item, ids } = await setup();
  assert.equal(num((await item(ids.Sub)).unit_cost).toFixed(2), '0.80');
  assert.equal(num((await item(ids.Board)).unit_cost).toFixed(2), '1.00');
});

test('changing a leaf cost recalculates every ancestor', async () => {
  const { db, uma, item, ids } = await setup();
  await q(db, uma, 'update items set unit_cost = 0.2 where id = $1', [ids.R1]);
  assert.equal(num((await item(ids.Sub)).unit_cost).toFixed(2), '1.10');   // 3×0.2 + 0.5
  assert.equal(num((await item(ids.Board)).unit_cost).toFixed(2), '1.50'); // 2×0.2 + 1.1
});

test("an assembly's cost can't be overwritten by hand", async () => {
  const { db, uma, item, ids } = await setup();
  await q(db, uma, 'update items set unit_cost = 99 where id = $1', [ids.Board]);
  assert.equal(num((await item(ids.Board)).unit_cost).toFixed(2), '1.00');
});

test('deleting a component removes its BOM lines and reprices parents', async () => {
  const { db, ada, item, ids } = await setup();
  await q(db, ada, 'delete from items where id = $1', [ids.C1]);
  assert.equal((await rows(db, ada, 'select * from bom_lines where child_id = $1', [ids.C1])).length, 0);
  assert.equal(num((await item(ids.Sub)).unit_cost).toFixed(2), '0.30');
  assert.equal(num((await item(ids.Board)).unit_cost).toFixed(2), '0.50');
});

test('save_bom returns the new costs of the assembly and everything above it', async () => {
  const { db, uma, ids, lines } = await setup();
  const r = await rpc(db, uma, 'save_bom', { p_parent_id: ids.Sub, p_lines: lines([{ child_id: ids.R1, quantity: 1 }]) });
  const byId = Object.fromEntries(r.map(x => [x.id, num(x.unit_cost).toFixed(2)]));
  assert.deepEqual(byId, { [ids.Sub]: '0.10', [ids.Board]: '0.30' });
});

// ── BOM validation ──────────────────────────────────────────────────────────

test('save_bom rejects bad lines and leaves the BOM unchanged', async () => {
  const { db, ada, uma, ids, lines } = await setup();
  const save = arr => rpc(db, uma, 'save_bom', { p_parent_id: ids.Sub, p_lines: lines(arr) });
  await rejects(save([{ child_id: ids.Sub, quantity: 1 }]), /itself/);
  await rejects(save([{ child_id: ids.R1, quantity: 1 }, { child_id: ids.R1, quantity: 2 }]), /Duplicate/);
  await rejects(save([{ child_id: ids.R1, quantity: 0 }]), /other than 0/);
  await rejects(save([{ child_id: 99999, quantity: 1 }]), /not found/);
  await rejects(save([{ child_id: ids.Board, quantity: 1 }]), /already contains/);   // Board contains Sub
  assert.equal((await rows(db, ada, 'select * from bom_lines where parent_id = $1', [ids.Sub])).length, 2);
});

test('cycles are blocked even when writing bom_lines directly', async () => {
  const { db, uma, ids } = await setup();
  await rejects(q(db, uma, 'insert into bom_lines values ($1, $2, 1)', [ids.Sub, ids.Board]), /already contains/);
});

// ── Checkout ────────────────────────────────────────────────────────────────

test('checkout deducts leaves and writes the log in one call', async () => {
  const { db, uma, vic, item, ids } = await setup();
  const r = await rpc(db, uma, 'checkout', { p_assembly_id: ids.Board, p_qty_built: 2, p_job_name: 'GMU 25-47' });
  assert.equal(r.rows_written, 3);
  assert.equal(num((await item(ids.R1)).qty), 90);  // 100 − (2 + 3) × 2
  assert.equal(num((await item(ids.C1)).qty), 48);
  assert.equal(num((await item(ids.Sub)).qty), 0);  // intermediate assemblies are not deducted
  const log = await rows(db, vic, 'select component_name, qty_deducted, sub_assembly_name, depth, user_email from checkout_log');
  assert.deepEqual(log.map(e => [e.component_name, num(e.qty_deducted), e.sub_assembly_name, e.depth]).sort(), [
    ['C1', 2, 'Board > Sub', 1], ['R1', 4, 'Board', 0], ['R1', 6, 'Board > Sub', 1],
  ]);
  assert.ok(log.every(e => e.user_email === 'uma@example.com'));
});

test('checkout validates its input and changes nothing on error', async () => {
  const { db, uma, item, ids } = await setup();
  await rejects(rpc(db, uma, 'checkout', { p_assembly_id: ids.Board, p_qty_built: 1, p_job_name: ' ' }), /job_name/);
  await rejects(rpc(db, uma, 'checkout', { p_assembly_id: ids.Board, p_qty_built: 0, p_job_name: 'J' }), /at least 1/);
  await rejects(rpc(db, uma, 'checkout', { p_assembly_id: ids.Board, p_qty_built: 1.5, p_job_name: 'J' }), /whole number/);
  await rejects(rpc(db, uma, 'checkout', { p_assembly_id: ids.R1, p_qty_built: 1, p_job_name: 'J' }), /no BOM/);
  assert.equal(num((await item(ids.R1)).qty), 100);
});

test('negative BOM lines: cancelled components are untouched, net negatives are returned', async () => {
  const { db, ada, uma, vic, item, ids, lines } = await setup();
  const add = async name => (await rows(db, uma, 'insert into items (name) values ($1) returning id', [name]))[0].id;
  const NoR1 = await add('NoR1'), Salvage = await add('Salvage'), Variant = await add('Variant');
  await rpc(db, uma, 'save_bom', { p_parent_id: NoR1, p_lines: lines([{ child_id: ids.R1, quantity: -3 }]) });
  await rpc(db, uma, 'save_bom', { p_parent_id: Salvage, p_lines: lines([{ child_id: ids.C1, quantity: -2 }]) });
  await rpc(db, uma, 'save_bom', { p_parent_id: Variant, p_lines: lines([
    { child_id: ids.Sub, quantity: 1 }, { child_id: NoR1, quantity: 1 }, { child_id: Salvage, quantity: 1 },
  ]) });
  const r1Before = await item(ids.R1);

  const r = await rpc(db, uma, 'checkout', { p_assembly_id: Variant, p_qty_built: 2, p_job_name: 'J1' });
  assert.equal(num((await item(ids.R1)).qty), 100);                                 // +6 −6
  assert.equal((await item(ids.R1)).updated_at.getTime(), r1Before.updated_at.getTime());
  assert.equal(num((await item(ids.C1)).qty), 52);                                  // 50 − 2 + 4
  assert.deepEqual(r.results.map(x => x.id), [ids.C1]);
  const log = await rows(db, vic, "select component_name, qty_deducted from checkout_log where job_name = 'J1'");
  assert.deepEqual(log.map(e => [e.component_name, num(e.qty_deducted)]).sort(), [
    ['C1', -4], ['C1', 2], ['R1', -6], ['R1', 6],
  ]);
  assert.equal(num((await item(Variant)).unit_cost).toFixed(2), '-0.50');           // 0.8 − 0.3 − 1.0
});

// ── User admin ──────────────────────────────────────────────────────────────

test('only admins can manage users', async () => {
  const { db, uma, vic } = await setup();
  await rejects(rows(db, uma, 'select * from admin_list_users()'), /Only admins/);
  await rejects(rpc(db, uma, 'admin_invite', { p_email: 'x@example.com', p_role: 'admin' }), /Only admins/);
  await rejects(rpc(db, uma, 'admin_set_role', { p_user_id: vic, p_role: 'admin' }), /Only admins/);
  await rejects(rpc(db, vic, 'admin_delete_user', { p_user_id: uma }), /Only admins/);
});

test('admins see users and pending invites', async () => {
  const { db, ada } = await setup();
  await rpc(db, ada, 'admin_invite', { p_email: 'pending@example.com', p_role: 'viewer' });
  const users = await rows(db, ada, 'select email, role, is_self, pending from admin_list_users()');
  assert.deepEqual(users.map(u => [u.email, u.role, u.is_self, u.pending]), [
    ['ada@example.com', 'admin', true, false],
    ['pending@example.com', 'viewer', false, true],
    ['uma@example.com', 'user', false, false],
    ['vic@example.com', 'viewer', false, false],
  ]);
  await rpc(db, ada, 'admin_cancel_invite', { p_email: 'PENDING@example.com' });
  assert.equal((await rows(db, ada, 'select * from admin_list_users() where pending')).length, 0);
});

test('invites are validated', async () => {
  const { db, ada } = await setup();
  await rejects(rpc(db, ada, 'admin_invite', { p_email: 'not-an-email', p_role: 'user' }), /valid email/);
  await rejects(rpc(db, ada, 'admin_invite', { p_email: 'x@example.com', p_role: 'root' }), /Role must be/);
  await rejects(rpc(db, ada, 'admin_invite', { p_email: 'UMA@example.com', p_role: 'user' }), /already has an account/);
});

test('admins cannot lock themselves out, and one admin always remains', async () => {
  const { db, ada, uma } = await setup();
  await rejects(rpc(db, ada, 'admin_set_role', { p_user_id: ada, p_role: 'user' }), /own role/);
  await rejects(rpc(db, ada, 'admin_delete_user', { p_user_id: ada }), /own account/);
  await rejects(db.query("update profiles set role = 'user' where role = 'admin'"), /at least one admin/);
  // With a second admin, the first can be demoted
  await rpc(db, ada, 'admin_set_role', { p_user_id: uma, p_role: 'admin' });
  await rpc(db, uma, 'admin_set_role', { p_user_id: ada, p_role: 'viewer' });
  assert.equal((await rows(db, uma, 'select role from admin_list_users() where email = $1', ['ada@example.com']))[0].role, 'viewer');
});

test('users can read their own profile only', async () => {
  const { db, uma } = await setup();
  assert.deepEqual((await rows(db, uma, 'select email, role from profiles')).map(p => [p.email, p.role]), [['uma@example.com', 'user']]);
});

test('category names are unique regardless of letter case', async () => {
  const { db, uma } = await setup();
  await q(db, uma, "insert into categories (name) values ('Resistor')");
  await rejects(q(db, uma, "insert into categories (name) values ('resistor')"), /duplicate key/);
});
