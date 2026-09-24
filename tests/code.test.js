// Tests for the pure functions in Code.gs. Run: node --test
const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadCodeGs, signed } = require('./fakes');

const { ctx } = loadCodeGs();

// ── Fixture ─────────────────────────────────────────────────────────────────
// 10 Board = 2×R1 + 1×Sub
// 20 Sub   = 3×R1 + 1×C1
// 1  R1 $0.10   2 C1 $0.50   30 Spare (unused)
const items = [
  { id: 1,  name: 'R1',    unit_cost: 0.10, qty: 100 },
  { id: 2,  name: 'C1',    unit_cost: 0.50, qty: 50 },
  { id: 10, name: 'Board', unit_cost: 0,    qty: 0 },
  { id: 20, name: 'Sub',   unit_cost: 0,    qty: 0 },
  { id: 30, name: 'Spare', unit_cost: 1,    qty: 1 },
];
const boms = [
  { parent_id: 10, child_id: 1,  quantity: 2 },
  { parent_id: 10, child_id: 20, quantity: 1 },
  { parent_id: 20, child_id: 1,  quantity: 3 },
  { parent_id: 20, child_id: 2,  quantity: 1 },
];
const byId  = new Map(items.map(i => [i.id, i]));
const lines = ctx.groupBomLines(boms);
const plain = v => JSON.parse(JSON.stringify(v)); // strip VM-realm prototypes

test('resolveBomLeaves + mergeBomLines flattens to leaves and sums duplicates', () => {
  const merged = ctx.mergeBomLines(ctx.resolveBomLeaves(10, 4, lines, byId));
  const got = Object.fromEntries(merged.map(m => [m.item.id, m.qty]));
  assert.deepEqual(plain(got), { 1: 20, 2: 4 }); // R1: (2 + 3) × 4, C1: 1 × 4
});

test('calcBomCost recurses from leaf costs', () => {
  assert.equal(ctx.calcBomCost(20, lines, byId).toFixed(4), '0.8000'); // 3×0.10 + 0.50
  assert.equal(ctx.calcBomCost(10, lines, byId).toFixed(4), '1.0000'); // 2×0.10 + 0.80
});

test('cycles terminate', () => {
  const cyclic = ctx.groupBomLines([...boms, { parent_id: 20, child_id: 10, quantity: 1 }]);
  assert.ok(Array.isArray(ctx.resolveBomLeaves(10, 1, cyclic, byId)));
  assert.ok(Number.isFinite(ctx.calcBomCost(10, cyclic, byId)));
});

test('findAncestors walks all the way up', () => {
  assert.deepEqual([...ctx.findAncestors([1], boms)].sort(), [10, 20]);
  assert.deepEqual([...ctx.findAncestors([2], boms)].sort(), [10, 20]);
  assert.deepEqual([...ctx.findAncestors([10], boms)], []);
});

test('buildLogComponents records the sub-assembly path and depth', () => {
  const rows = plain(ctx.buildLogComponents(10, 2, 'Board', 0, lines, byId));
  assert.deepEqual(rows.map(r => [r.name, r.qty_deducted, r.sub_assembly_name, r.depth]), [
    ['R1', 4, 'Board', 0],
    ['R1', 6, 'Board > Sub', 1],
    ['C1', 2, 'Board > Sub', 1],
  ]);
});

test('validateBomLines rejects self, duplicates, unknown items and cycles', () => {
  assert.equal(ctx.validateBomLines(30, [{ child_id: 1, quantity: 1 }], boms, byId), null);
  assert.match(ctx.validateBomLines(30, [{ child_id: 30, quantity: 1 }], boms, byId), /itself/);
  assert.match(ctx.validateBomLines(30, [{ child_id: 1, quantity: 1 }, { child_id: 1, quantity: 2 }], boms, byId), /Duplicate/);
  assert.match(ctx.validateBomLines(30, [{ child_id: 999, quantity: 1 }], boms, byId), /not found/);
  // Sub is inside Board, so Board can't go inside Sub
  assert.match(ctx.validateBomLines(20, [{ child_id: 10, quantity: 1 }], boms, byId), /already contains/);
});

test('pbkdf2Sha256Hex matches Node PBKDF2', () => {
  const salt = crypto.randomBytes(16);
  const expected = crypto.pbkdf2Sync('correct horse', salt, 50, 32, 'sha256').toString('hex');
  assert.equal(ctx.pbkdf2Sha256Hex('correct horse', signed(salt), 50), expected);
});

test('verifyPassword accepts new and legacy hashes', () => {
  const stored = ctx.hashPassword('s3cret-password');
  assert.equal(ctx.verifyPassword('s3cret-password', stored), 'ok');
  assert.equal(ctx.verifyPassword('wrong', stored), null);
  const legacy = ctx.legacyHashPassword('old-password');
  assert.equal(ctx.verifyPassword('old-password', legacy), 'ok-legacy');
  assert.equal(ctx.verifyPassword('wrong', legacy), null);
  assert.equal(ctx.verifyPassword('anything', ''), null);
});

test('roleRank treats unknown roles as viewer', () => {
  assert.equal(ctx.roleRank(' Admin '), 2);
  assert.equal(ctx.roleRank('user'), 1);
  assert.equal(ctx.roleRank('superuser'), 0);
  assert.equal(ctx.roleRank(''), 0);
});

test('negative lines cancel positives across sub-assemblies', () => {
  // 40 Variant = 1×Sub (3×R1 + 1×C1) + 1×NoR1, where 50 NoR1 = −3×R1
  const vItems = new Map([...byId, [40, { id: 40, name: 'Variant' }], [50, { id: 50, name: 'NoR1' }]]);
  const vLines = ctx.groupBomLines([
    ...boms,
    { parent_id: 40, child_id: 20, quantity: 1 },
    { parent_id: 40, child_id: 50, quantity: 1 },
    { parent_id: 50, child_id: 1,  quantity: -3 },
  ]);
  const merged = plain(ctx.mergeBomLines(ctx.resolveBomLeaves(40, 2, vLines, vItems)));
  assert.deepEqual(Object.fromEntries(merged.map(m => [m.item.id, m.qty])), { 1: 0, 2: 2 });
  assert.equal(ctx.calcBomCost(40, vLines, vItems).toFixed(4), '0.5000'); // 0.8 − 3×0.10
});

test('a net-negative component resolves to a negative quantity', () => {
  const kit = ctx.groupBomLines([{ parent_id: 30, child_id: 1, quantity: -2 }]);
  const merged = plain(ctx.mergeBomLines(ctx.resolveBomLeaves(30, 3, kit, byId)));
  assert.deepEqual(merged.map(m => [m.item.id, m.qty]), [[1, -6]]);
  assert.equal(ctx.calcBomCost(30, kit, byId).toFixed(2), '-0.20');
});
