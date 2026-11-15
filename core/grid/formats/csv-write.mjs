// CSV export of the active sheet: A1 to the end of the used range (leading empty rows and columns
// kept as empty fields), CRLF line ends, UTF-8 without BOM, fields quoted when they hold the
// delimiter, a quote or a line break; values as displayed (number formats applied), except a
// General number, written whole (no column width rounds it), as Excel's Save As CSV does.
// Translated from gridcraft crates/xlsx/src/csv.rs (`write_csv`, `write_csv_limited`,
// MAX_CSV_BYTES) and crates/engine/src/io.rs (`csv`: General numbers in full, the workbook's
// csv delimiter, .tsv with tabs) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
// U:grid/formats-csv. No DOM, no Node built-ins.

import {engineFor} from '../model/calc.mjs';
import {displayAt} from '../model/index.mjs';
import {styleAt} from '../model/workbook.mjs';
import {activeSheetIndex} from '../model/sheet.mjs';
import {isNumber} from '../lib/value.mjs';

/** The largest delimited file written (bytes). */
export const MAX_CSV_BYTES = 512 << 20;

/** Rust's `f64::to_string`: the shortest digits that read back, never in exponent form. */
export function plainNumber(n) {
  if (Object.is(n, -0)) return '0';
  const s = String(n);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const [, sign, d0, rest = '', e] = m;
  const digits = d0 + rest;
  const exp = Number(e);
  if (exp >= 0) return sign + (digits.length <= exp + 1 ? digits + '0'.repeat(exp + 1 - digits.length) : `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`);
  return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
}

const utf8Length = s => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1; else if (c < 0x800) n += 2; else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; } else n += 3;
  }
  return n;
};

/** csv.rs `write_csv_limited`: the sheet's text, or throws when it would pass `limit` bytes. */
export function writeDelimited(content, si, delimiter = ',', limit = MAX_CSV_BYTES) {
  const delim = delimiter || ',';
  const eng = engineFor(content);
  const r = eng.usedRange(si);
  if (!r) return '';
  const tooLarge = what => new Error(`the CSV would be ${what}, over the limit of ${limit >> 20} MiB; export a smaller range`);
  const rows = r.end.row + 1, cols = r.end.col + 1;
  const least = rows * ((cols - 1) * utf8Length(delim) + 2);
  if (least > limit) throw tooLarge(`at least ${Math.floor(least / 1048576)} MiB (${rows} rows by ${cols} columns)`);
  const sheet = content.sheets[si];
  const text = (row, col) => {
    const v = eng.sheetValue(si, row, col);
    if (isNumber(v) && Number.isFinite(v) && String(styleAt(content, sheet, row, col).numFmt).toLowerCase() === 'general') return plainNumber(v);
    return displayAt(content, si, row, col, v).text;
  };
  const parts = [];
  let size = 0;
  for (let row = 0; row <= r.end.row; row++) {
    for (let col = 0; col <= r.end.col; col++) {
      if (col > 0) { parts.push(delim); size += utf8Length(delim); }
      const t = text(row, col);
      const quoted = t.includes(delim) || t.includes('"') || t.includes('\n') || t.includes('\r');
      const len = utf8Length(t) + (quoted ? t.split('"').length - 1 + 2 : 0);
      if (size + len > limit) throw tooLarge(`more than ${limit >> 20} MiB (stopped at row ${row + 1})`);
      parts.push(quoted ? `"${t.replaceAll('"', '""')}"` : t);
      size += len;
    }
    parts.push('\r\n');
    size += 2;
    if (size > limit) throw tooLarge(`more than ${limit >> 20} MiB (stopped at row ${row + 1})`);
  }
  return parts.join('');
}

/** Format module: the active sheet as CSV with the workbook's delimiter (comma unless it came from a ; file). */
export function write(file) {
  const content = file.content ?? file;
  const delim = [',', ';', '\t'].includes(content.csvDelimiter) ? content.csvDelimiter : ',';
  return new TextEncoder().encode(writeDelimited(content, activeSheetIndex(content), delim));
}
