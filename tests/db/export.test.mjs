// The sheet copy's export: token-gated, read-only, nothing else reachable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addUser, q, rows } from './harness.mjs';

async function setup() {
  const db = await freshDb();
  const ada = await addUser(db, 'ada@example.com', 'admin');
  await q(db, ada, "insert into items (id, name, unit_cost) values (1, 'R1', 0.1), (2, 'Board', 0)");
  await q(db, ada, "insert into bom_lines values (2, 1, 4)");
  const token = (await db.query('select public.create_export_token() as t')).rows[0].t;  // SQL Editor = superuser
  const snapshot = t => q(db, null, 'select public.export_snapshot($1) as s', [t]).then(r => r.rows[0].s);
  return { db, ada, token, snapshot };
}

test('the export token unlocks a snapshot for the anonymous API role', async () => {
  const { token, snapshot } = await setup();
  assert.match(token, /^[0-9a-f]{64}$/);
  const s = await snapshot(token);
  assert.deepEqual(s.items.map(i => [i.id, i.name, Number(i.unit_cost)]), [[1, 'R1', 0.1], [2, 'Board', 0.4]]);
  assert.deepEqual(s.bom_lines, [{ parent_id: 2, child_id: 1, quantity: 4, parent_name: 'Board', child_name: 'R1' }]);
  assert.ok(s.generated_at);
});

test('a wrong or missing token gets nothing', async () => {
  const { snapshot } = await setup();
  await assert.rejects(snapshot('0'.repeat(64)), /Invalid export token/);
  await assert.rejects(snapshot(null), /Invalid export token/);
});

test('only a hash of the token is stored, and the API cannot reach tokens', async () => {
  const { db, ada, token } = await setup();
  const stored = (await db.query('select token_hash from export_tokens')).rows[0].token_hash;
  assert.notEqual(stored, token);
  await assert.rejects(rows(db, null, 'select * from export_tokens'), /permission denied/);
  await assert.rejects(rows(db, ada, 'select * from export_tokens'), /permission denied/);
  await assert.rejects(rows(db, ada, 'select public.create_export_token()'), /permission denied/);
  await assert.rejects(rows(db, null, 'select public.create_export_token()'), /permission denied/);
});

test('ping() answers the anonymous API role and nobody else needs it', async () => {
  const { db, ada } = await setup();
  assert.equal((await q(db, null, 'select public.ping() as r')).rows[0].r, 'ok');
  await assert.rejects(rows(db, ada, 'select public.ping()'), /permission denied/);
});
