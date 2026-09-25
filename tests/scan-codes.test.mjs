// Reading scanned codes (assets/scan-codes.js): our own labels, distributor bag
// labels and plain codes, and matching them to items.
import test from 'node:test';
import assert from 'node:assert/strict';
import ScanCodes from '../assets/scan-codes.js';

const { parseCode, matchItems, codeToLink, itemLabelUrl, printable } = ScanCodes;
const GS = '\x1d', RS = '\x1e', EOT = '\x04';

// As read from a Digi-Key bag's DataMatrix
const DIGIKEY = `[)>${RS}06${GS}P311-10KARCT-ND${GS}1PRC0805FR-0710KL${GS}30P311-10KARCT-ND${GS}K${GS}1K80000000`
  + `${GS}10K90000000${GS}9D2331${GS}1TTH12345${GS}11K1${GS}4LTW${GS}Q00250${GS}11ZPICK${GS}12Z1234567${GS}13Z999999${GS}20Z0000000${RS}${EOT}`;
// Mouser's DataMatrix: no 30P, a line number in 14K, sometimes a leading ">"
const MOUSER = `>[)>${RS}06${GS}K12345${GS}14K001${GS}1PSN74HC595N${GS}Q10${GS}11K55555${GS}4LMY${GS}1VTexas Instruments${RS}${EOT}`;
const LCSC = '{pbn:PICK2305120001,on:SO2305120001,pc:C25744,pm:0402WGF1001TCE,qty:100,mc:,cc:1,pdi:12345,hp:0,wc:JS}';

const inventory = [
  { id: 1, name: '10k 0805 resistor', part: '', supplier_part: '311-10KARCT-ND', barcode: '', notes: '' },
  { id: 2, name: 'Shift register', part: '', supplier_part: '595-SN74HC595N', barcode: '', notes: 'SN74HC595N, DIP-16' },
  { id: 3, name: '1k 0402', part: 'R-1K-0402', supplier_part: 'C25744', barcode: '', notes: '' },
  { id: 4, name: 'Enclosure', part: 'ENC-01', supplier_part: '', barcode: '0012345678905', notes: '' },
  { id: 5, name: '10k 0805 (spare reel)', part: '311-10KARCT-ND', supplier_part: '', barcode: '', notes: '' },
];

test('our own labels carry the item id, from any copy of the site', () => {
  assert.equal(itemLabelUrl(42), 'https://bromalis.github.io/electostock/#item=42');
  assert.deepEqual(parseCode(itemLabelUrl(42)), { kind: 'item', itemId: 42, raw: itemLabelUrl(42) });
  assert.equal(parseCode('http://localhost:8765/?x=1#item=7').itemId, 7);
  assert.deepEqual(matchItems(parseCode(itemLabelUrl(4)), inventory).items.map(i => i.id), [4]);
  assert.deepEqual(matchItems(parseCode(itemLabelUrl(99)), inventory).items, []);   // deleted item
});

test('Digi-Key bag labels give the Digi-Key part #, manufacturer part # and quantity', () => {
  const c = parseCode(DIGIKEY);
  assert.equal(c.kind, 'label');
  assert.equal(c.source, 'Digi-Key');
  assert.equal(c.supplierPart, '311-10KARCT-ND');
  assert.equal(c.mfrPart, 'RC0805FR-0710KL');
  assert.equal(c.qty, 250);
  // Supplier part # beats part #, so the item stocked under that number comes first
  assert.deepEqual(matchItems(c, inventory).items.map(i => i.id), [1, 5]);
});

test('Mouser labels match on the manufacturer part #, falling back to names and notes', () => {
  const c = parseCode(MOUSER);
  assert.equal(c.kind, 'label');
  assert.equal(c.source, 'Mouser');
  assert.equal(c.mfrPart, 'SN74HC595N');
  assert.equal(c.qty, 10);
  const m = matchItems(c, inventory);
  assert.equal(m.exact, false);
  assert.deepEqual(m.items.map(i => i.id), [2]);
});

test('LCSC QR codes are read too', () => {
  const c = parseCode(LCSC);
  assert.equal(c.source, 'LCSC');
  assert.equal(c.supplierPart, 'C25744');
  assert.equal(c.mfrPart, '0402WGF1001TCE');
  assert.equal(c.qty, 100);
  assert.deepEqual(matchItems(c, inventory).items.map(i => i.id), [3]);
});

test('a scanner that drops the record separators still reads the label', () => {
  const c = parseCode(DIGIKEY.replace(new RegExp(RS, 'g'), '').replace(EOT, ''));
  assert.equal(c.supplierPart, '311-10KARCT-ND');
  assert.equal(c.qty, 250);
});

test('plain codes match barcode, supplier part # or part #, ignoring case and spaces', () => {
  assert.deepEqual(matchItems(parseCode(' 0012345678905\n'), inventory).items.map(i => i.id), [4]);
  assert.deepEqual(matchItems(parseCode('595-sn74hc595n'), inventory).items.map(i => i.id), [2]);
  assert.deepEqual(matchItems(parseCode('enc-01'), inventory).items.map(i => i.id), [4]);
  assert.deepEqual(matchItems(parseCode('NOTHING-LIKE-IT'), inventory), { items: [], exact: true });
  assert.equal(parseCode('   ').kind, 'empty');
});

test('linking a scan stores the most specific part number it carries', () => {
  assert.equal(codeToLink(parseCode(DIGIKEY)), '311-10KARCT-ND');
  assert.equal(codeToLink(parseCode(MOUSER)), 'SN74HC595N');
  assert.equal(codeToLink(parseCode('ABC-1')), 'ABC-1');
  assert.equal(codeToLink(parseCode(itemLabelUrl(1))), '');
});

test('raw scans display without control characters', () => {
  assert.equal(printable(`[)>${RS}06${GS}P1${GS}Q2${RS}${EOT}`), '[)>06 · P1 · Q2');
});
