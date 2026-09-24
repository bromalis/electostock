// Turns CSV exports of the old Google Sheet into one SQL file for the Supabase
// SQL Editor. Usage:
//   node scripts/import-sheet.mjs <folder with the CSVs> [output.sql]
// The folder must hold the Inventory, Categories, BOMs and Checkout Log tabs
// (File > Download > CSV; file names just need to end in "<tab name>.csv").
//
// The SQL replaces all inventory data (items, BOM lines, categories, checkout
// log) and leaves users, profiles and invites alone, so it can be re-run for the
// final import at switch-over. Item ids are kept, so BOMs and history still line
// up. Problems the database would reject are reported; blocking ones stop the
// script before anything is written.
import fs from 'node:fs';
import path from 'node:path';

const SHEET_TIME_ZONE = 'America/New_York'; // appsscript.json timeZone: log times are local to it

// ── CSV (RFC 4180: quoted fields, doubled quotes, newlines inside quotes) ────
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter(r => r.some(v => v.trim() !== ''));
  return body.map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const toNum = v => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const sqlText = v => `'${String(v ?? '').replace(/'/g, "''")}'`;
const sqlNum  = v => String(toNum(v));

// ── Read and check ───────────────────────────────────────────────────────────
export function buildImport(files) {
  const problems = [];   // blocking: fix in the sheet and export again
  const notes = [];      // fixed automatically, reported for information

  // Categories: names are unique regardless of case
  const categories = [];
  const catSeen = new Map();
  for (const r of files.categories) {
    const name = r.name;
    if (!name) continue;
    const key = name.toLowerCase();
    if (catSeen.has(key)) { notes.push(`Category "${name}" duplicates "${catSeen.get(key)}" (letter case only); kept the first.`); continue; }
    catSeen.set(key, name);
    categories.push({ name, color: r.color || '#78716c' });
  }

  // Items
  const items = [];
  const byId = new Map();
  for (const r of files.inventory) {
    const id = Math.trunc(toNum(r.id));
    if (!(id > 0)) { if (r.name) notes.push(`Skipped a row without an id: "${r.name}".`); continue; }
    if (byId.has(id)) { problems.push(`Item id ${id} appears twice ("${byId.get(id).name}" and "${r.name}").`); continue; }
    if (!r.name) { problems.push(`Item id ${id} has no name.`); continue; }
    let qty = toNum(r.qty);
    if (qty < 0) { notes.push(`"${r.name}" (id ${id}) had quantity ${qty}; imported as 0.`); qty = 0; }
    const item = {
      id, part: r.part, name: r.name, category: r.category, qty, min: toNum(r.min), location: r.location,
      unit_cost: toNum(r.unit_cost), supplier: r.supplier, supplier_part: r.supplier_part, notes: r.notes,
    };
    if (item.category && !catSeen.has(item.category.toLowerCase())) {
      notes.push(`"${r.name}" uses category "${item.category}", which isn't in the Categories tab (kept as is).`);
    }
    items.push(item); byId.set(id, item);
  }

  // BOM lines: same rules as the old backend when reading (blank quantity = 1)
  const lineMap = new Map();
  for (const r of files.boms) {
    const parent = Math.trunc(toNum(r.parent_id)), child = Math.trunc(toNum(r.child_id));
    if (!(parent > 0) || !(child > 0)) continue;
    const quantity = r.quantity === '' ? 1 : toNum(r.quantity);
    const label = `BOM line ${parent} → ${child}`;
    if (!byId.has(parent)) { notes.push(`${label}: assembly ${parent} doesn't exist; line dropped.`); continue; }
    if (!byId.has(child))  { notes.push(`${label} ("${byId.get(parent).name}"): component ${child} doesn't exist; line dropped.`); continue; }
    if (parent === child)  { notes.push(`${label}: "${byId.get(parent).name}" contains itself; line dropped.`); continue; }
    if (quantity === 0)    { notes.push(`${label}: quantity 0; line dropped.`); continue; }
    const key = `${parent}:${child}`;
    if (lineMap.has(key)) {
      lineMap.get(key).quantity += quantity;
      notes.push(`"${byId.get(parent).name}" lists "${byId.get(child).name}" twice; quantities added together (as the old app did).`);
    } else lineMap.set(key, { parent_id: parent, child_id: child, quantity });
  }
  const lines = [...lineMap.values()].filter(l => {
    if (l.quantity !== 0) return true;
    notes.push(`"${byId.get(l.parent_id).name}" → "${byId.get(l.child_id).name}" added up to 0; line dropped.`);
    return false;
  });

  // Cycles would be rejected by the database: report each one found
  const children = new Map();
  lines.forEach(l => { if (!children.has(l.parent_id)) children.set(l.parent_id, []); children.get(l.parent_id).push(l.child_id); });
  const state = new Map(); // 1 = on the current path, 2 = done
  const visit = (id, pathIds) => {
    state.set(id, 1);
    for (const c of children.get(id) || []) {
      if (state.get(c) === 1) {
        const loop = [...pathIds.slice(pathIds.indexOf(c)), c].map(x => `"${byId.get(x).name}"`).join(' → ');
        problems.push(`BOM loop: ${loop}.`);
      } else if (!state.get(c)) visit(c, [...pathIds, c]);
    }
    state.set(id, 2);
  };
  for (const id of children.keys()) if (!state.get(id)) visit(id, [id]);

  // Checkout log
  const log = [];
  for (const r of files.log) {
    if (!r.timestamp || !r.job_name) continue;
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(r.timestamp)) {
      problems.push(`Checkout log time "${r.timestamp}" isn't in the expected yyyy-mm-dd hh:mm:ss format.`);
      continue;
    }
    log.push({
      created_at: r.timestamp.replace('T', ' '), job_name: r.job_name, assembly_id: Math.trunc(toNum(r.assembly_id)),
      assembly_name: r.assembly_name, qty_built: toNum(r.qty_built), component_name: r.component_name,
      component_supplier_part: r.component_supplier_part, component_location: r.component_location,
      qty_deducted: toNum(r.qty_deducted), sub_assembly_name: r.sub_assembly_name, depth: Math.trunc(toNum(r.depth)),
    });
  }

  return { categories, items, lines, log, problems, notes };
}

export function toSql({ categories, items, lines, log }) {
  const out = [];
  const values = (rows, fn) => rows.map(r => `  (${fn(r).join(', ')})`).join(',\n');
  out.push(`-- ElectoStock import from the Google Sheet, generated ${new Date().toISOString()}.`);
  out.push('-- Replaces all inventory data; users, profiles and invites are left alone.');
  out.push('begin;');
  out.push('truncate public.checkout_log, public.bom_lines, public.items, public.categories restart identity;');
  if (categories.length) {
    out.push('insert into public.categories (name, color) values');
    out.push(values(categories, c => [sqlText(c.name), sqlText(c.color)]) + ';');
  }
  if (items.length) {
    out.push('insert into public.items (id, part, name, category, qty, min, location, unit_cost, supplier, supplier_part, notes) values');
    out.push(values(items, i => [i.id, sqlText(i.part), sqlText(i.name), sqlText(i.category), sqlNum(i.qty), sqlNum(i.min),
      sqlText(i.location), sqlNum(i.unit_cost), sqlText(i.supplier), sqlText(i.supplier_part), sqlText(i.notes)]) + ';');
  }
  if (lines.length) {
    out.push('-- Assembly costs are recalculated by the database as these go in.');
    out.push('insert into public.bom_lines (parent_id, child_id, quantity) values');
    out.push(values(lines, l => [l.parent_id, l.child_id, sqlNum(l.quantity)]) + ';');
  }
  if (log.length) {
    out.push(`insert into public.checkout_log (created_at, job_name, assembly_id, assembly_name, qty_built, component_name,`);
    out.push(`  component_supplier_part, component_location, qty_deducted, sub_assembly_name, depth) values`);
    out.push(values(log, e => [`(${sqlText(e.created_at)}::timestamp at time zone '${SHEET_TIME_ZONE}')`, sqlText(e.job_name),
      e.assembly_id, sqlText(e.assembly_name), sqlNum(e.qty_built), sqlText(e.component_name),
      sqlText(e.component_supplier_part), sqlText(e.component_location), sqlNum(e.qty_deducted),
      sqlText(e.sub_assembly_name), e.depth]) + ';');
  }
  out.push('-- New items and log rows continue after the imported ids');
  out.push("select setval(pg_get_serial_sequence('public.items', 'id'), greatest((select max(id) from public.items), 1));");
  out.push("select setval(pg_get_serial_sequence('public.checkout_log', 'id'), greatest((select max(id) from public.checkout_log), 1));");
  out.push('commit;');
  out.push(`select (select count(*) from public.items) as items, (select count(*) from public.bom_lines) as bom_lines,`);
  out.push(`       (select count(*) from public.categories) as categories, (select count(*) from public.checkout_log) as log_rows;`);
  return out.join('\n') + '\n';
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const dir = process.argv[2];
  if (!dir) { console.error('Usage: node scripts/import-sheet.mjs <folder with the CSVs> [output.sql]'); process.exit(1); }
  const outFile = process.argv[3] || path.join(dir, 'import.sql');
  const find = tab => {
    const f = fs.readdirSync(dir).find(n => n.toLowerCase().endsWith(`${tab.toLowerCase()}.csv`));
    if (!f) { console.error(`No CSV for the "${tab}" tab in ${dir}`); process.exit(1); }
    return parseCsv(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, ''));
  };
  const data = buildImport({ inventory: find('Inventory'), categories: find('Categories'), boms: find('BOMs'), log: find('Checkout Log') });
  console.log(`Read ${data.items.length} items, ${data.lines.length} BOM lines, ${data.categories.length} categories, ${data.log.length} log rows.`);
  if (data.notes.length) { console.log(`\nFixed automatically (${data.notes.length}):`); data.notes.forEach(n => console.log('  • ' + n)); }
  if (data.problems.length) {
    console.log(`\nMust be fixed in the sheet first (${data.problems.length}):`); data.problems.forEach(p => console.log('  ✖ ' + p));
    console.log('\nNo SQL written.'); process.exit(2);
  }
  fs.writeFileSync(outFile, toSql(data));
  console.log(`\nWrote ${outFile}`);
}
