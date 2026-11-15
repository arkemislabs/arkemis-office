// Ported from gridcraft crates/xlsx/src/tests/csv_tests.rs and the CSV tests of
// crates/engine/src/tests.rs (`saving_csv_keeps_leading_empty_columns_and_rows`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b; the Rust names are the test titles.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: csv.rs decode_text (BOMs, UTF-8, Windows-1256 Arabic vs Windows-1252),
//    sniff_delimiter (comma/semicolon/tab, present on every line), parse_records (RFC 4180 and
//    leniency, fields past XFD dropped), read_csv (typed input per field, number formats kept),
//    write_csv (from A1, CRLF, quoting, the 512 MiB cap). Excel opens a CSV the same way (values
//    read as typed, 007 kept only with a leading apostrophe) and saves values as shown.
// 2. Ours reads into a schema-2 workbook (core/grid/formats/csv-read.mjs) and writes the active
//    sheet's shown values (csv-write.mjs), General numbers in full as gridcraft's io.rs does.
// 3. These tests; the Save As / Open flow is tests/e2e/grid/formats-files.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeText, sniffDelimiter, parseRecords, readCsv, read as readCsvFile} from '../../../core/grid/formats/csv-read.mjs';
import {writeDelimited, plainNumber, write as writeCsvFile} from '../../../core/grid/formats/csv-write.mjs';
import {read as readTsv} from '../../../core/grid/formats/tsv-read.mjs';
import {write as writeTsv} from '../../../core/grid/formats/tsv-write.mjs';
import {engineFor} from '../../../core/grid/model/calc.mjs';
import {styleAt} from '../../../core/grid/model/workbook.mjs';
import {validateContent} from '../../../core/grid/schema.mjs';
import {CellError} from '../../../core/grid/lib/value.mjs';
import {MAX_COLS} from '../../../core/grid/lib/addr.mjs';

const enc = s => new TextEncoder().encode(s);
const v = (wb, r, c) => engineFor(wb).sheetValue(0, r, c);
const bytes = list => new Uint8Array(list.map(x => (typeof x === 'string' ? x.charCodeAt(0) : x)));

test('quoting_and_newlines', () => {
  const wb = readCsv(enc('a,"b,c","say ""hi"""\r\n"multi\nline",,3\n\nlast'));
  validateContent(wb);
  assert.equal(wb.sheets[0].name, 'Sheet1');
  assert.equal(v(wb, 0, 0), 'a');
  assert.equal(v(wb, 0, 1), 'b,c');
  assert.equal(v(wb, 0, 2), 'say "hi"');
  assert.equal(v(wb, 1, 0), 'multi\nline');
  assert.equal(v(wb, 1, 1), null);
  assert.equal(v(wb, 1, 2), 3);
  assert.equal(v(wb, 2, 0), null);
  assert.equal(v(wb, 3, 0), 'last');
});

test('values_and_formats', () => {
  const wb = readCsv(enc("1,2.5,\"1,234\",50%,TRUE,#N/A,2026-03-04,$5.00,'007,text"));
  validateContent(wb);
  assert.equal(v(wb, 0, 0), 1);
  assert.equal(v(wb, 0, 1), 2.5);
  assert.equal(v(wb, 0, 2), 1234);
  assert.equal(v(wb, 0, 3), 0.5);
  assert.equal(v(wb, 0, 4), true);
  assert.ok(v(wb, 0, 5) instanceof CellError);
  assert.equal(typeof v(wb, 0, 6), 'number');
  assert.notEqual(styleAt(wb, wb.sheets[0], 0, 6).numFmt, 'General');
  assert.equal(v(wb, 0, 8), '007');
  const wb2 = readCsv(enc('2026-03-04'), {dateSystem: 1904});
  assert.equal(wb2.dateSystem, 1904);
  assert.equal(v(wb, 0, 6) - v(wb2, 0, 0), 1462);
  const wb3 = readCsv(enc('1,TRUE'), {parseValues: false});
  assert.equal(v(wb3, 0, 0), '1');
});

test('encodings', () => {
  assert.equal(decodeText(new Uint8Array([0xEF, 0xBB, 0xBF, ...enc('é,x')])), 'é,x');
  const le = [0xFF, 0xFE];
  for (const ch of 'ü;1') { const u = ch.charCodeAt(0); le.push(u & 255, u >> 8); }
  assert.equal(decodeText(new Uint8Array(le)), 'ü;1');
  assert.equal(decodeText(new Uint8Array([0xFE, 0xFF, 0x00, 0xDF])), 'ß');
  assert.equal(decodeText(new Uint8Array([0x80, 0x61, 0xE9])), '€aé');
  const wb = readCsv(new Uint8Array(le), {delimiter: ''});
  assert.equal(v(wb, 0, 0), 'ü');
  assert.equal(v(wb, 0, 1), 1);
});

test('arabic_csv_in_windows_1256_reads_as_arabic', () => {
  const b = bytes([0xC7, 0xE1, 0xC7, 0xD3, 0xE3, ',', 0xC7, 0xE1, 0xDE, 0xED, 0xE3, 0xC9, '\n', 0xE3, 0xD1, 0xCD, 0xC8, 0xC7, ' ', '1', '2', '3', 0xA1,
    ' ', '4', '2', 0xBF, ',', 0xC8, 0xED, 0xC7, 0xE4, 0xC7, 0xCA, ' ', '7', '\n']);
  const wb = readCsv(b);
  assert.equal(v(wb, 0, 0), 'الاسم');
  assert.equal(v(wb, 0, 1), 'القيمة');
  assert.equal(v(wb, 1, 0), 'مرحبا 123، 42؟');
  assert.equal(v(wb, 1, 1), 'بيانات 7');
});

const readsAsArabic = b => [...decodeText(b)].some(c => c >= '؀' && c <= 'ۿ');

test('western_1252_text_stays_latin', () => {
  assert.equal(decodeText(bytes(['C', 'r', 0xE8, 'm', 'e', ' ', 'b', 'r', 0xFB, 'l', 0xE9, 'e', ',', ' ', 0xE0, ' ', 'c', 0xF4, 't', 0xE9, ',', ' ', 0xE9, 't', 0xE9])), 'Crème brûlée, à côté, été');
  assert.equal(decodeText(bytes(['G', 'r', 0xF6, 0xDF, 'e', ',', ' ', 0xDC, 'b', 'e', 'r', 'm', 'a', 0xDF, ',', ' ', 'F', 'u', 0xDF, 'g', 0xE4, 'n', 'g', 'e', 'r'])), 'Größe, Übermaß, Fußgänger');
  assert.equal(decodeText(bytes(['A', 0xC7, 0xC3, 'O', ',', ' ', 'i', 'n', 'f', 'o', 'r', 'm', 'a', 0xE7, 0xE3, 'o', ',', ' ', 's', 'i', 't', 'u', 'a', 0xE7, 0xE3, 'o', ',', ' ', 'P', 0xE3, 'o'])), 'AÇÃO, informação, situação, Pão');
  assert.equal(decodeText(bytes([0xC6, 'r', 0xF8, ',', 0xD8, 's', 't', ',', 0xC5, 's', 'e', ',', 0xDE, 0xF3, 'r', 0xF0, 'u', 'r', ',', 'G', 'u', 0xF0, 'r', 0xFA, 'n', ',', 0xC4, 0xD6, 0xDC])), 'Ærø,Øst,Åse,Þórður,Guðrún,ÄÖÜ');
  assert.equal(decodeText(bytes(['1', 0xBA, ',', '2', 0xBA, ',', '3', 0xBA, '\n', '1', 0xAA, ',', '2', 0xAA])), '1º,2º,3º\n1ª,2ª');
  assert.equal(decodeText(bytes(['K', 0xE4, 's', 'e', ',', 'B', 0xE4, 'c', 'k', 'e', 'r'])), 'Käse,Bäcker');
});

test('short_arabic_words_read_as_arabic', () => {
  assert.equal(decodeText(bytes([0xDD, 0xED, ',', 0xE3, 0xE4, ',', 0xDA, 0xE4, '\n'])), 'في,من,عن\n');
  assert.equal(decodeText(bytes([0xE4, 0xDA, 0xE3, ',', 0xE1, 0xC7, '\n', 0xE1, 0xC7, ',', 0xE4, 0xDA, 0xE3, '\n'])), 'نعم,لا\nلا,نعم\n');
  assert.equal(decodeText(bytes([0x98, 0xCA, 0xC7, 0xC8, ' ', 0x81, 0xC7, 0xD1, 0xD3, 0xED])), 'کتاب پارسي');
  const marks = bytes([0xDF, 0xCA, 0xC7, 0xC8, 0x9D, 0xE5, 0xC7, ',', 0xCE, 0xC7, 0xE4, 0xE5, 0x9D, 0xE5, 0xC7, ',', 0xE3, 0xCD, 0xE3, 0xCF, 0xFE, ',', 0xDA, 0xE1, 0xED, 0xFE]);
  assert.equal(decodeText(marks), 'كتاب‌ها,خانه‌ها,محمد‏,علي‏');
});

test('hebrew_1255_bytes_are_not_read_as_arabic', () => {
  for (const b of [
    [0xF9, 0xEC, 0xE5, 0xED, ',', 0xF2, 0xE5, 0xEC, 0xED],
    [0xF9, 0xC8, 0xD1, 0xEC, 0xE5, 0xC9, 0xED, ' ', 0xF2, 0xE5, 0xC9, 0xEC, 0xC8, 0xED],
    [0xFA, 0xEC, 0xCE, 0xE0, 0xE1, 0xE9, 0xE1, ',', 0xE1, 0xEF, 0xCE, 0xE2, 0xE5, 0xF8, 0xE9, 0xE5, 0xEF],
    [0xF6, 0xE4, 0xD8, 0xEC, ',', 0xE3, 0xD8, 0xF8],
  ]) assert.ok(!readsAsArabic(bytes(b)), decodeText(bytes(b)));
});

test('delimiter_sniffing', () => {
  assert.equal(sniffDelimiter('a;b;c\n1;2;3\n'), ';');
  assert.equal(sniffDelimiter('a\tb\n1\t2\n'), '\t');
  assert.equal(sniffDelimiter('a,b\n"x;y;z",2\n'), ',');
  assert.equal(sniffDelimiter('single'), ',');
  assert.equal(sniffDelimiter('alpha;beta\r\ngamma\r\n'), ',');
  assert.equal(sniffDelimiter('alpha\tbeta\r\ngamma\r\n'), ',');
  assert.equal(sniffDelimiter('a;b\r\n\r\nc;d\r\n'), ';');
  const wb = readCsv(enc('x;y\n1,5;2'), {delimiter: ''});
  assert.equal(v(wb, 1, 1), 2);
  assert.equal(wb.csvDelimiter, ';');
  assert.equal(readCsv(enc('a\tb'), {delimiter: ''}).csvDelimiter, '\t');
  assert.equal(readCsv(enc('a;b')).csvDelimiter, ',');
  assert.throws(() => readCsv(enc('a'), {delimiter: '"'}));
});

test('writing', () => {
  const wb = {sheets: [{id: 's', name: 'S', blocks: {0: {B2: {v: 'a,b'}, C2: {v: 'q"t'}, B3: {v: 0.1}, C3: {v: false}, D4: {v: 'x\ny'}, B4: {v: {e: '#DIV/0!'}}}}}],
    activeSheetId: 's', styles: [{}], names: []};
  const out = writeDelimited(wb, 0, ',');
  assert.equal(out, ',,,\r\n,"a,b","q""t",\r\n,0.1,FALSE,\r\n,#DIV/0!,,"x\ny"\r\n');
  assert.ok(writeDelimited(wb, 0, ';').startsWith(';;;\r\n;a,b;'));
  assert.equal(writeDelimited({sheets: [{id: 'e', name: 'E', blocks: {}}], activeSheetId: 'e', styles: [{}]}, 0, ','), '');
  const back = readCsv(enc(out));
  assert.equal(v(back, 1, 1), 'a,b');
  assert.equal(v(back, 3, 3), 'x\ny');
});

test('hostile_csv', () => {
  readCsv(new Uint8Array(1000).fill(0xFF));
  readCsv(enc('"unterminated,quote\n1,2'));
  const wb = readCsv(enc(`${','.repeat(20_000)}x`));
  assert.deepEqual(wb.sheets[0].blocks, {}, 'fields past column XFD are dropped');
});

test('two_far_apart_cells_are_refused_before_anything_is_allocated', () => {
  const wb = {sheets: [{id: 's', name: 'S', blocks: {0: {A1: {v: 'a'}}, 4095: {XFD1048576: {v: 'b'}}}}], activeSheetId: 's', styles: [{}]};
  assert.throws(() => writeDelimited(wb, 0, ','), /over the limit of 512 MiB/);
});

test('the_cap_counts_the_bytes_the_cells_hold_and_accepted_exports_keep_every_position', () => {
  const wb = {sheets: [{id: 's', name: 'S', blocks: {0: {A1: {v: 'x'.repeat(40)}, C3: {v: 'yy'}}}}], activeSheetId: 's', styles: [{}]};
  assert.throws(() => writeDelimited(wb, 0, ',', 30), /over the limit/);
  assert.equal(writeDelimited(wb, 0, ',', 1000), `${'x'.repeat(40)},,\r\n,,\r\n,,yy\r\n`);
});

test('parser_stops_collecting_fields_at_max_cols', () => {
  let n = 0;
  parseRecords(`${'a,'.repeat(MAX_COLS + 50)}z\n`, ',', '"', r => { n = r.length; });
  assert.equal(n, MAX_COLS);
});

test('saving_csv_keeps_leading_empty_columns_and_rows', () => {
  const wb = readCsv(enc(',x\r\n\r\n,,y\r\n'));
  assert.equal(new TextDecoder().decode(writeCsvFile({content: wb})), ',x,\r\n,,\r\n,,y\r\n');
});

test('general numbers are written whole, formatted ones as shown, and tsv uses tabs', () => {
  assert.equal(plainNumber(1e21), '1000000000000000000000');
  assert.equal(plainNumber(1.5e-7), '0.00000015');
  assert.equal(plainNumber(123456789012), '123456789012');
  const wb = readCsv(enc('123456789012345,50%,"$1,234.50"\n'));
  assert.equal(new TextDecoder().decode(writeCsvFile({content: wb})), '123456789012345,50%,"$1,234.50"\r\n');
  const t = readTsv(enc('a\tb,c\n1\t2'));
  assert.equal(v(t, 0, 1), 'b,c');
  assert.equal(new TextDecoder().decode(writeTsv({content: t})), 'a\tb,c\r\n1\t2\r\n');
  const semi = readCsvFile(enc('a;b\n1;2\n'));
  assert.equal(new TextDecoder().decode(writeCsvFile({content: semi})), 'a;b\r\n1;2\r\n', 'a ; file saves with ;');
});
