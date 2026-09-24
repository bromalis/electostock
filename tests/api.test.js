// End-to-end tests of the web app's request handling against in-memory sheets.
const test   = require('node:test');
const assert = require('node:assert/strict');
const { loadCodeGs } = require('./fakes');

// Fresh backend with one user per role and a two-level BOM:
// Board = 2×R1 + 1×Sub,  Sub = 3×R1 + 1×C1
function setup() {
  const app = loadCodeGs();
  app.ctx.createUser('ada',  'admin-password-1',  'admin');
  app.ctx.createUser('uma',  'user-password-12',  'user');
  app.ctx.createUser('vic',  'viewer-password-1', 'viewer');
  const tokens = {};
  for (const [u, p] of [['ada','admin-password-1'],['uma','user-password-12'],['vic','viewer-password-1']]) {
    tokens[u] = app.call('login', { username: u, password: p }).token;
  }
  const as = (user, action, data = {}) => app.call(action, { ...data, token: tokens[user] });
  const add = item => as('ada', 'add', { item }).item.id;
  const R1 = add({ name: 'R1', qty: 100, unit_cost: 0.1 });
  const C1 = add({ name: 'C1', qty: 50,  unit_cost: 0.5 });
  const Sub   = add({ name: 'Sub',   qty: 0 });
  const Board = add({ name: 'Board', qty: 0 });
  as('ada', 'saveBOM', { parent_id: Sub,   lines: [{ child_id: R1, quantity: 3 }, { child_id: C1, quantity: 1 }] });
  as('ada', 'saveBOM', { parent_id: Board, lines: [{ child_id: R1, quantity: 2 }, { child_id: Sub, quantity: 1 }] });
  const item = id => as('ada', 'getAll').items.find(i => i.id === id);
  return { app, as, tokens, item, ids: { R1, C1, Sub, Board } };
}

test('GET is refused and bad tokens are rejected', () => {
  const { app } = setup();
  assert.match(JSON.parse(app.ctx.doGet().text).error, /POST/);
  assert.equal(app.call('getAll', { token: 'nope' }).auth, false);
  assert.equal(app.call('getAll').auth, false);
  assert.match(app.call('login', { username: 'ada', password: 'wrong' }).error, /Invalid/);
});

test('each user can hold several sessions; logout ends only one', () => {
  const { app, as } = setup();
  const second = app.call('login', { username: 'ada', password: 'admin-password-1' }).token;
  assert.ok(as('ada', 'getAll').items);
  assert.ok(app.call('getAll', { token: second }).items);
  app.call('logout', { token: second });
  assert.equal(app.call('getAll', { token: second }).auth, false);
  assert.ok(as('ada', 'getAll').items);
});

test('changing a password signs the user out everywhere', () => {
  const { app, as } = setup();
  app.ctx.createUser('uma', 'a-brand-new-password', 'user');
  assert.equal(as('uma', 'getAll').auth, false);
});

test('roles are enforced on the server', () => {
  const { as, ids } = setup();
  assert.ok(as('vic', 'getAll').items);
  assert.match(as('vic', 'adjustQty', { id: ids.R1, action: 'add', qty: 1 }).error, /not allowed/);
  assert.ok(as('uma', 'adjustQty', { id: ids.R1, action: 'add', qty: 1 }).success);
  assert.match(as('uma', 'delete', { id: ids.R1 }).error, /not allowed/);
  assert.match(as('uma', 'nonsense').error, /Unknown action/);
});

test('saving a BOM rolls costs up through ancestors', () => {
  const { item, ids } = setup();
  assert.equal(item(ids.Sub).unit_cost.toFixed(2), '0.80');
  assert.equal(item(ids.Board).unit_cost.toFixed(2), '1.00');
});

test('updating a leaf cost recalculates every ancestor', () => {
  const { as, item, ids } = setup();
  const r = as('uma', 'update', { item: { id: ids.R1, unit_cost: 0.2 } });
  assert.deepEqual(r.cost_updates.map(u => u.id).sort(), [ids.Sub, ids.Board].sort());
  assert.equal(item(ids.Sub).unit_cost.toFixed(2), '1.10');   // 3×0.2 + 0.5
  assert.equal(item(ids.Board).unit_cost.toFixed(2), '1.50'); // 2×0.2 + 1.1
});

test('partial updates leave other fields alone', () => {
  const { as, item, ids } = setup();
  as('uma', 'adjustQty', { id: ids.R1, action: 'set', qty: 7 });
  as('uma', 'update', { item: { id: ids.R1, notes: 'reel 3' } });
  const r1 = item(ids.R1);
  assert.equal(r1.qty, 7);
  assert.equal(r1.notes, 'reel 3');
  assert.equal(r1.name, 'R1');
});

test('checkout deducts leaves and writes the log in one call', () => {
  const { app, as, item, ids } = setup();
  const r = as('uma', 'checkout', { assembly_id: ids.Board, qty_built: 2, job_name: 'GMU 25-47' });
  assert.ok(r.success);
  assert.equal(item(ids.R1).qty, 90); // 100 − (2 + 3) × 2
  assert.equal(item(ids.C1).qty, 48); // 50 − 1 × 2
  assert.equal(item(ids.Sub).qty, 0); // intermediate assemblies are not deducted
  assert.equal(r.rows_written, 3);
  const log = as('vic', 'getCheckoutLog').entries;
  assert.deepEqual(log.map(e => [e.component_name, e.qty_deducted, e.sub_assembly_name]).sort(), [
    ['C1', 2, 'Board > Sub'], ['R1', 4, 'Board'], ['R1', 6, 'Board > Sub'],
  ]);
  assert.equal(app.sheets.get('Checkout Log').getLastRow(), 4);
});

test('checkout validates its input', () => {
  const { as, ids } = setup();
  assert.match(as('uma', 'checkout', { assembly_id: ids.Board, qty_built: 1 }).error, /job_name/);
  assert.match(as('uma', 'checkout', { assembly_id: ids.Board, qty_built: 0, job_name: 'x' }).error, /at least 1/);
  assert.match(as('uma', 'checkout', { assembly_id: ids.R1, qty_built: 1, job_name: 'x' }).error, /no BOM/);
});

test('saveBOM rejects cycles and keeps other assemblies intact', () => {
  const { as, ids } = setup();
  assert.match(as('uma', 'saveBOM', { parent_id: ids.Sub, lines: [{ child_id: ids.Board, quantity: 1 }] }).error, /already contains/);
  const boms = as('uma', 'getBOMs').boms;
  assert.equal(boms.filter(b => b.parent_id === ids.Sub).length, 2);
  assert.equal(boms.filter(b => b.parent_id === ids.Board).length, 2);
});

test('deleting a component removes its BOM rows and reprices parents', () => {
  const { as, item, ids } = setup();
  const r = as('ada', 'delete', { id: ids.C1 });
  assert.ok(r.success);
  assert.equal(as('ada', 'getBOMs').boms.some(b => b.child_id === ids.C1), false);
  assert.equal(item(ids.Sub).unit_cost.toFixed(2), '0.30');   // 3×0.1
  assert.equal(item(ids.Board).unit_cost.toFixed(2), '0.50'); // 2×0.1 + 0.3
});

test('ids stay unique after deletes', () => {
  const { as, ids } = setup();
  as('ada', 'delete', { id: ids.Board });
  const id = as('ada', 'add', { item: { name: 'New' } }).item.id;
  assert.equal(as('ada', 'getAll').items.filter(i => i.id === id).length, 1);
});

test('legacy password hashes still log in and are upgraded', () => {
  const { app } = setup();
  app.sheets.get('Users').appendRow(['old', app.ctx.legacyHashPassword('old-password'), 'user']);
  assert.ok(app.call('login', { username: 'old', password: 'old-password' }).token);
  const row = app.sheets.get('Users').rows.find(r => r[0] === 'old');
  assert.match(row[1], /^pbkdf2\$/);
  assert.ok(app.call('login', { username: 'old', password: 'old-password' }).token);
});

test('createUser rejects short passwords and unknown roles', () => {
  const { app } = setup();
  assert.throws(() => app.ctx.createUser('x', 'short', 'user'), /at least/);
  assert.throws(() => app.ctx.createUser('x', 'long-enough-password', 'root'), /Role must be/);
});

test('negative BOM lines: cancelled components are untouched, net negatives are returned', () => {
  const { app, as, item, ids } = setup();
  const add = i => as('ada', 'add', { item: i }).item.id;
  // NoR1 removes the 3×R1 that Sub adds; Salvage gives back 2×C1 per unit
  const NoR1    = add({ name: 'NoR1' });
  const Salvage = add({ name: 'Salvage' });
  const Variant = add({ name: 'Variant' });
  assert.ok(as('uma', 'saveBOM', { parent_id: NoR1,    lines: [{ child_id: ids.R1, quantity: -3 }] }).success);
  assert.ok(as('uma', 'saveBOM', { parent_id: Salvage, lines: [{ child_id: ids.C1, quantity: -2 }] }).success);
  assert.ok(as('uma', 'saveBOM', { parent_id: Variant, lines: [
    { child_id: ids.Sub, quantity: 1 }, { child_id: NoR1, quantity: 1 }, { child_id: Salvage, quantity: 1 },
  ] }).success);

  const r1Before = item(ids.R1);
  const r = as('uma', 'checkout', { assembly_id: Variant, qty_built: 2, job_name: 'J1' });
  assert.ok(r.success);
  assert.equal(item(ids.R1).qty, 100);                          // +6 −6: untouched
  assert.equal(item(ids.R1).updated_at, r1Before.updated_at);
  assert.equal(item(ids.C1).qty, 52);                           // 50 − 2 + 4
  assert.deepEqual(r.results.map(x => x.id), [ids.C1]);

  // The log keeps every path, including the negative ones
  const log = as('vic', 'getCheckoutLog').entries.filter(e => e.job_name === 'J1');
  assert.deepEqual(log.map(e => [e.component_name, e.qty_deducted]).sort(), [
    ['C1', -4], ['C1', 2], ['R1', -6], ['R1', 6],
  ]);
  assert.equal(app.sheets.get('Checkout Log').getLastRow(), 5);

  // Costs: Variant = 0.8 − 0.3 − 1.0 = −0.5, stored even though it's negative
  assert.equal(item(Variant).unit_cost.toFixed(2), '-0.50');
});

test('saveBOM drops zero-quantity lines', () => {
  const { as, ids } = setup();
  as('uma', 'saveBOM', { parent_id: ids.Sub, lines: [{ child_id: ids.R1, quantity: 0 }, { child_id: ids.C1, quantity: -1 }] });
  assert.deepEqual(as('uma', 'getBOMs').boms.filter(b => b.parent_id === ids.Sub).map(b => b.quantity), [-1]);
});
