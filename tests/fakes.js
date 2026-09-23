// Minimal in-memory stand-ins for the Apps Script services Code.gs uses, plus a
// loader that evaluates Code.gs against them. Only what Code.gs calls is faked.
const fs     = require('node:fs');
const path   = require('node:path');
const vm     = require('node:vm');
const crypto = require('node:crypto');

const signed   = buf => [...buf].map(b => (b > 127 ? b - 256 : b));
const unsigned = arr => Buffer.from(arr.map(b => b & 0xff));

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.rows[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
  clearContent() {
    for (let r = 0; r < this.numRows; r++)
      for (let c = 0; c < this.numCols; c++) this.sheet.set(this.row + r, this.col + c, '');
    return this;
  }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setFontColor()  { return this; }
  setNumberFormat() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; }
  getName() { return this.name; }
  set(row, col, v) {
    while (this.rows.length < row) this.rows.push([]);
    this.rows[row - 1][col - 1] = v;
  }
  getLastRow() {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i].some(v => v !== '' && v !== undefined)) return i + 1;
    }
    return 0;
  }
  getLastColumn() { return Math.max(0, ...this.rows.map(r => r.length)); }
  getDataRange() { return new FakeRange(this, 1, 1, this.getLastRow(), this.getLastColumn()); }
  getRange(a, col, numRows = 1, numCols = 1) {
    if (typeof a === 'string') return new FakeRange(this, 1, 1, 0, 0); // 'A:A' style — formatting only
    return new FakeRange(this, a, col, numRows, numCols);
  }
  appendRow(values) { this.rows.splice(this.getLastRow(), 0, [...values]); }
  deleteRow(row) { this.rows.splice(row - 1, 1); }
  insertRowBefore(row) { this.rows.splice(row - 1, 0, []); }
  setFrozenRows() {}
  hideColumns() {}
  hideSheet() {}
}

function loadCodeGs() {
  const sheets = new Map();
  const ss = {
    getSheetByName: n => sheets.get(n) || null,
    insertSheet: n => { const s = new FakeSheet(n); sheets.set(n, s); return s; },
  };
  const cacheStore = new Map();
  const services = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush: () => {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({
      get: k => (cacheStore.has(k) ? cacheStore.get(k) : null),
      put: (k, v) => cacheStore.set(k, v),
      remove: k => cacheStore.delete(k),
    }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: text => ({ text, setMimeType() { return this; } }),
    },
    Utilities: {
      computeHmacSha256Signature: (value, key) =>
        signed(crypto.createHmac('sha256', unsigned(key)).update(unsigned(value)).digest()),
      computeDigest: (_alg, str) => signed(crypto.createHash('sha256').update(str, 'utf8').digest()),
      newBlob: () => ({ setDataFromString: s => ({ getBytes: () => signed(Buffer.from(s, 'utf8')) }) }),
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
    },
    Logger: { log: () => {} },
  };
  const ctx = vm.createContext(services);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ctx);

  // Call the web app the way the frontend does: POST { action, data }.
  const call = (action, data = {}) =>
    JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ action, data }) } }).text);

  return { ctx, sheets, cacheStore, call };
}

module.exports = { loadCodeGs, signed };
