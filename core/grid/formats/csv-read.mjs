// CSV import into a schema-2 workbook: BOM-aware UTF-8/UTF-16 decoding, Windows-1256 (Arabic) or
// Windows-1252 for other bytes, comma/semicolon/tab sniffing, RFC 4180 records with the usual
// leniency, and each field read as typed input (numbers, dates, booleans, errors) as Excel opens it.
// Translated from gridcraft crates/xlsx/src/csv.rs (`decode_text`, `Cp1256Evidence`,
// `sniff_delimiter`, `parse_records`, `read_csv`) and crates/engine/src/io.rs (open: .csv sniffs
// the delimiter, .tsv/.tab/.txt read tabs) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
// U:grid/formats-csv. No DOM, no Node built-ins.

import {MAX_ROWS, MAX_COLS, a1} from '../lib/addr.mjs';
import {parseInput} from '../lib/parse.mjs';
import {toJSONValue} from '../lib/value.mjs';
import {blockOf} from '../model/store.mjs';
import {createWorkbook} from '../model/workbook.mjs';
import {sparseStyle, resolveStyle, styleKey} from '../model/style.mjs';

/** Windows-1252 code points for bytes 0x80–0x9F (others map to Latin-1). */
const CP1252 = [0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F, 0x90, 0x2018, 0x2019,
  0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178];
/** Windows-1256 code points for bytes 0x80–0xFF (unicode.org CP1256.TXT). */
export const CP1256 = [
  0x20AC, 0x067E, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0679, 0x2039, 0x0152, 0x0686, 0x0698, 0x0688, 0x06AF, 0x2018,
  0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x06A9, 0x2122, 0x0691, 0x203A, 0x0153, 0x200C, 0x200D, 0x06BA, 0x00A0, 0x060C, 0x00A2, 0x00A3,
  0x00A4, 0x00A5, 0x00A6, 0x00A7, 0x00A8, 0x00A9, 0x06BE, 0x00AB, 0x00AC, 0x00AD, 0x00AE, 0x00AF, 0x00B0, 0x00B1, 0x00B2, 0x00B3, 0x00B4, 0x00B5,
  0x00B6, 0x00B7, 0x00B8, 0x00B9, 0x061B, 0x00BB, 0x00BC, 0x00BD, 0x00BE, 0x061F, 0x06C1, 0x0621, 0x0622, 0x0623, 0x0624, 0x0625, 0x0626, 0x0627,
  0x0628, 0x0629, 0x062A, 0x062B, 0x062C, 0x062D, 0x062E, 0x062F, 0x0630, 0x0631, 0x0632, 0x0633, 0x0634, 0x0635, 0x0636, 0x00D7, 0x0637, 0x0638,
  0x0639, 0x063A, 0x0640, 0x0641, 0x0642, 0x0643, 0x00E0, 0x0644, 0x00E2, 0x0645, 0x0646, 0x0647, 0x0648, 0x00E7, 0x00E8, 0x00E9, 0x00EA, 0x00EB,
  0x0649, 0x064A, 0x00EE, 0x00EF, 0x064B, 0x064C, 0x064D, 0x064E, 0x00F4, 0x064F, 0x0650, 0x00F7, 0x0651, 0x00F9, 0x0652, 0x00FB, 0x00FC, 0x200E,
  0x200F, 0x06D2,
];

const inSet = (b, spec) => spec.some(x => (Array.isArray(x) ? b >= x[0] && b <= x[1] : b === x));
const SAME_1252_1256 = [0x80, [0x82, 0x89], [0x8B, 0x8C], [0x91, 0x97], 0x99, [0x9B, 0x9C], 0xA0, [0xA2, 0xA9], [0xAB, 0xB9], [0xBB, 0xBE], 0xD7, 0xE0, 0xE2,
  [0xE7, 0xEB], [0xEE, 0xEF], 0xF4, 0xF7, 0xF9, [0xFB, 0xFC]];
const INVISIBLE = [0x9D, 0x9E, 0xFD, 0xFE];
const SHARED_LATIN = [0xE0, 0xE2, [0xE7, 0xEB], [0xEE, 0xEF], 0xF4, 0xF9, [0xFB, 0xFC]];
const CP1256_ARABIC = [0x81, 0x8A, [0x8D, 0x90], 0x98, 0x9A, 0x9F, 0xA1, 0xAA, 0xBA, [0xBF, 0xD6], [0xD8, 0xDB], [0xDD, 0xDF], 0xE1, [0xE3, 0xE6], [0xEC, 0xED], 0xFF];
const isAsciiAlpha = b => (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A);

/** csv.rs `Cp1256Evidence::of(..).is_arabic()`: non-UTF-8 bytes that read as Arabic Windows-1256. */
export function looksArabic1256(bytes) {
  let differing = 0, arabic = 0, touchingLatin = 0, sharedRuns = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) continue;
    const before = i > 0 ? bytes[i - 1] : undefined, after = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const nextTo = pred => (before !== undefined && pred(before)) || (after !== undefined && pred(after));
    if (inSet(b, SAME_1252_1256)) {
      if (inSet(b, SHARED_LATIN) && nextTo(x => x >= 0x80)) sharedRuns++;
      continue;
    }
    if (inSet(b, INVISIBLE) || ((b === 0xAA || b === 0xBA) && before !== undefined && before >= 0x30 && before <= 0x39)) continue;
    differing++;
    if (inSet(b, CP1256_ARABIC)) {
      arabic++;
      if (nextTo(isAsciiAlpha)) touchingLatin++;
    }
  }
  return arabic >= 2 && arabic * 10 >= differing * 9 && touchingLatin * 10 <= arabic * 3 && sharedRuns * 20 <= arabic;
}

/** csv.rs `decode_text`: BOMs first, then UTF-8, then Windows-1256 or Windows-1252. */
export function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try { return new TextDecoder('utf-8', {fatal: true}).decode(b); } catch { /* not UTF-8 */ }
  const arabic = looksArabic1256(b);
  let out = '';
  for (const x of b) {
    if (x >= 0x80 && arabic) out += String.fromCodePoint(CP1256[x - 0x80] ?? 0xFFFD);
    else if (x >= 0x80 && x <= 0x9F) out += String.fromCodePoint(CP1252[x - 0x80] ?? 0xFFFD);
    else out += String.fromCharCode(x);
  }
  return out;
}

/**
 * csv.rs `sniff_delimiter`: comma, semicolon or tab, the one with the most consistent count per
 * line (outside quotes) over the first 20 non-blank lines; it must appear on every one, else comma.
 */
export function sniffDelimiter(text, quote = '"') {
  let best = [',', 0, 0];
  const sample = text.length > 65536 ? text.slice(0, 65536) : text;
  for (const d of [',', ';', '\t']) {
    const counts = [];
    let n = 0, inQ = false, blank = true;
    for (const ch of sample) {
      if (!inQ && ch === '\n') {
        if (!blank) counts.push(n);
        n = 0; blank = true;
        if (counts.length >= 20) break;
        continue;
      }
      if (ch !== '\r') blank = false;
      if (ch === quote) inQ = !inQ;
      else if (!inQ && ch === d) n++;
    }
    if (!blank) counts.push(n);
    const min = counts.length ? Math.min(...counts) : 0;
    const total = counts.reduce((x, y) => x + y, 0);
    if (min > 0 && (min > best[1] || (min === best[1] && total > best[2]))) best = [d, min, total];
  }
  return best[0];
}

/**
 * csv.rs `parse_records`: records of fields; a record keeps at most MAX_COLS fields. `onRecord`
 * returns false to stop.
 */
export function parseRecords(text, delim, quote, onRecord) {
  let field = '', record = [], inQ = false, startedQuoted = false;
  const push = () => { if (record.length < MAX_COLS) record.push(field); field = ''; startedQuoted = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === quote) {
        if (text[i + 1] === quote) { field += quote; i++; } else inQ = false;
      } else field += c;
      continue;
    }
    if (c === quote && field === '' && !startedQuoted) { inQ = true; startedQuoted = true; }
    else if (c === delim) push();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      push();
      const r = record; record = [];
      if (onRecord(r) === false) return;
    } else field += c;
  }
  if (field !== '' || record.length || startedQuoted) {
    if (record.length < MAX_COLS) record.push(field);
    onRecord(record);
  }
}

/**
 * csv.rs `read_csv`: Sheet1 holding the records from A1; options {delimiter: '' (sniff) | ',' |
 * ';' | '\t', quote: '"', dateSystem: 1900|1904, parseValues: true}.
 */
export function readCsv(bytes, opts = {}) {
  const text = decodeText(bytes);
  const quote = opts.quote || '"';
  // gridcraft CsvOptions: the delimiter defaults to a comma; an empty one ('' or 0) is sniffed.
  const delim = opts.delimiter === undefined ? ',' : (opts.delimiter || sniffDelimiter(text, quote));
  if (delim === quote) throw new Error('the delimiter and quote character must differ');
  const sys = opts.dateSystem === 1904 ? 1904 : 1900;
  const parse = opts.parseValues !== false;
  const content = createWorkbook(() => 'sheet1');
  if (sys === 1904) content.dateSystem = 1904;
  content.csvDelimiter = delim;
  const sheet = content.sheets[0];
  const styles = [{}];
  const styleIds = new Map();   // number format code -> style id
  let row = 0;
  parseRecords(text, delim, quote, rec => {
    if (row >= MAX_ROWS) return false;
    rec.forEach((f, col) => {
      if (col >= MAX_COLS || f === '') return;
      let cell;
      if (parse) {
        const p = parseInput(f, sys);
        cell = {v: toJSONValue(p.value)};
        if (p.format) {
          let id = styleIds.get(p.format);
          if (id === undefined) {
            const sparse = sparseStyle(resolveStyle({numFmt: p.format}));
            id = styles.findIndex(s => styleKey(s) === styleKey(sparse));
            if (id < 0) { id = styles.length; styles.push(sparse); }
            styleIds.set(p.format, id);
          }
          if (id) cell.s = id;
        }
      } else cell = {v: f};
      const b = blockOf(row);
      (sheet.blocks[b] ??= {})[a1(row, col)] = cell;
    });
    row++;
    return true;
  });
  content.styles = styles;
  return content;
}

/** Format module: .csv files (the delimiter sniffed, as gridcraft and Excel's Open do). */
export function read(bytes, opts = {}) {
  return readCsv(bytes, {delimiter: '', parseValues: opts.parseValues !== false});
}
