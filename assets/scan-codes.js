// Reading scanned codes. Loaded by index.html and by tests/scan-codes.test.mjs.
//
// Three kinds of code:
//   * item  — the app's own labels: a QR code with the item's link (…#item=<id>)
//   * label — a distributor bag label: ISO/IEC 15434 DataMatrix (Digi-Key, Mouser
//             and most others, as specified by ECIA) or LCSC's {key:value} QR code
//   * plain — anything else, e.g. a 1D barcode holding one part number
(function (root) {
  'use strict';

  // Printed labels always point at the live site, wherever they were printed from
  const LABEL_BASE_URL = 'https://bromalis.github.io/electostock/';
  const GS = '\x1d', RS = '\x1e', EOT = '\x04';

  function itemLabelUrl(id) {
    return LABEL_BASE_URL + '#item=' + id;
  }

  // The item id in one of our own label links, or null
  function itemIdFromLink(text) {
    const m = /^https?:\/\/\S*[#?&]item=(\d+)\b/i.exec(text);
    return m ? Number(m[1]) : null;
  }

  // ISO/IEC 15434 "[)>" RS "06" GS field GS field … RS EOT. Each field starts with an
  // ANSI MH10.8.2 data identifier: optional digits and a letter (P, 1P, 30P, Q…).
  function parseIso15434(text) {
    const start = text.search(/\[\)>/);
    if (start < 0 || text.indexOf(GS) < 0) return null;
    const fields = {};
    text.slice(start + 3).split(RS).forEach(record => {
      const parts = record.split(GS);
      if (!/^\d\d$/.test(parts[0])) return;          // format header, e.g. "06"
      parts.slice(1).forEach(f => {
        const m = /^(\d{0,3}[A-Z])([\s\S]*)$/.exec(f.replace(/[\x00-\x1f]/g, ''));
        if (m && !(m[1] in fields)) fields[m[1]] = m[2].trim();
      });
    });
    const source = fields['30P'] !== undefined ? 'Digi-Key' : fields['14K'] !== undefined ? 'Mouser' : '';
    return {
      supplierPart: fields['30P'] || '',             // Digi-Key's own part number
      customerPart: fields['P'] || '',               // the buyer's part number, if given at order
      mfrPart:      fields['1P'] || '',
      qty:          toQty(fields['Q']),
      source,
      fields,
    };
  }

  // LCSC: {pbn:PICK…,on:SO…,pc:C25744,pm:0402WGF1001TCE,qty:100,…}
  function parseLcsc(text) {
    if (!/^\{[\s\S]*\}$/.test(text) || !/\bpc:/.test(text)) return null;
    const fields = {};
    text.slice(1, -1).split(',').forEach(pair => {
      const i = pair.indexOf(':');
      if (i > 0) fields[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    });
    return { supplierPart: fields.pc || '', customerPart: '', mfrPart: fields.pm || '', qty: toQty(fields.qty), source: 'LCSC', fields };
  }

  function toQty(v) {
    const n = parseInt(String(v || '').replace(/[^\d]/g, ''), 10);
    return n > 0 ? n : null;
  }

  function parseCode(raw) {
    const text = String(raw == null ? '' : raw).replace(/^[\s\x00]+|[\s\x00]+$/g, '');
    if (!text) return { kind: 'empty', raw: '' };
    const itemId = itemIdFromLink(text);
    if (itemId !== null) return { kind: 'item', itemId, raw: text };
    const label = parseIso15434(text) || parseLcsc(text);
    if (label && (label.supplierPart || label.customerPart || label.mfrPart)) return { kind: 'label', raw: text, ...label };
    return { kind: 'plain', raw: text };
  }

  const norm = s => String(s || '').trim().toUpperCase();

  // The codes a scan could be known by, strongest first
  function candidateCodes(code) {
    const list = code.kind === 'label' ? [code.supplierPart, code.customerPart, code.mfrPart, code.raw] : [code.raw];
    return [...new Set(list.map(norm).filter(Boolean))];
  }

  // Items a scan refers to. Returns { items, exact }: exact matches on the item id,
  // barcode, supplier part # or part #; failing those, items whose name or notes
  // mention the manufacturer part number (exact: false), for the person to pick from.
  function matchItems(code, inventory) {
    if (code.kind === 'item') {
      const it = inventory.find(i => i.id === code.itemId);
      return { items: it ? [it] : [], exact: true };
    }
    if (code.kind !== 'label' && code.kind !== 'plain') return { items: [], exact: true };
    const wanted = candidateCodes(code);
    const score = it => {
      const fields = [it.barcode, it.supplier_part, it.part].map(norm);
      let best = Infinity;
      fields.forEach((f, fi) => {
        const ci = f ? wanted.indexOf(f) : -1;
        if (ci >= 0) best = Math.min(best, ci * 3 + fi);
      });
      return best;
    };
    const exact = inventory.map(it => ({ it, s: score(it) })).filter(x => x.s < Infinity)
      .sort((a, b) => a.s - b.s || a.it.name.localeCompare(b.it.name)).map(x => x.it);
    if (exact.length) return { items: exact, exact: true };
    const mfr = code.kind === 'label' ? norm(code.mfrPart) : '';
    if (mfr.length < 5) return { items: [], exact: true };
    const loose = inventory.filter(it => norm(it.name + ' ' + (it.notes || '')).includes(mfr))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { items: loose, exact: false };
  }

  // What to store in items.barcode when a scan that matched nothing is linked to an item
  function codeToLink(code) {
    if (code.kind === 'label') return code.supplierPart || code.customerPart || code.mfrPart;
    return code.kind === 'plain' ? code.raw : '';
  }

  // For showing a raw scan: control characters as visible separators
  function printable(text) {
    return String(text || '').replace(new RegExp(`[${RS}${EOT}]`, 'g'), '').replace(/[\x00-\x1f]/g, ' · ').trim();
  }

  const ScanCodes = { LABEL_BASE_URL, itemLabelUrl, parseCode, matchItems, codeToLink, printable };
  if (typeof module !== 'undefined' && module.exports) module.exports = ScanCodes;
  else root.ScanCodes = ScanCodes;
})(typeof window !== 'undefined' ? window : globalThis);
