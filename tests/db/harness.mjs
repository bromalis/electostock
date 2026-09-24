// Runs the Supabase migrations against PGlite (Postgres in WebAssembly), with a
// minimal stand-in for the parts of Supabase the schema depends on: the anon /
// authenticated roles, auth.users and auth.uid().
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const migrations = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
  .map(f => fs.readFileSync(path.join(migrationsDir, f), 'utf8'));

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    last_sign_in_at timestamptz
  );
  -- Supabase's auth.uid() reads the JWT subject the API sets per request
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
`;

export async function freshDb() {
  const db = await PGlite.create();
  await db.exec(SUPABASE_STUB);
  for (const sql of migrations) await db.exec(sql);
  return db;
}

// Invite + register, the way Supabase Auth would create the account.
export async function addUser(db, email, role) {
  await db.query('insert into public.invites (email, role) values ($1, $2)', [email, role]);
  const { rows } = await db.query('insert into auth.users (email) values ($1) returning id', [email]);
  return rows[0].id;
}

// Run fn(tx) as a signed-in user (userId) or anonymously (null), like a request
// through Supabase's API: role authenticated/anon, RLS on, auth.uid() set.
export async function as(db, userId, fn) {
  return db.transaction(async tx => {
    await tx.exec(`set local role ${userId ? 'authenticated' : 'anon'}`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId || '']);
    return fn(tx);
  });
}

// Shorthands for a single statement / function call as a user
export const q = (db, userId, sql, params) => as(db, userId, tx => tx.query(sql, params));
export const rows = async (...args) => (await q(...args)).rows;
export const rpc = async (db, userId, fn, args = {}) => {
  const names = Object.keys(args);
  const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
  return (await q(db, userId, sql, names.map(n => args[n]))).rows[0].r;
};

// Numeric columns come back as strings from PGlite; compare as numbers
export const num = v => Number(v);
