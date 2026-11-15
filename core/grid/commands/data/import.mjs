// Data > Get & Transform Data > From Text/CSV (and Get Data): a text file imported into a new worksheet as a table.
// Translated from gridcraft crates/engine/src/cmd/extra/data.rs (`get_data`: CSV/TSV text or a JSON array of objects, each field read as typed
// input, loaded into a new sheet as a table named after the source) and crates/xlsx/src/csv.rs (`decode_text`, `sniff_delimiter`,
// `parse_records`: core/grid/formats/csv-read.mjs) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// The file is chosen by the dialog (the app's own picker returns its bytes), so the command takes `text` or `data` (base64 bytes, decoded as the
// Open command decodes a CSV: BOM-aware UTF-8 or UTF-16, Windows-1252 or 1256 otherwise), never a path. Excel's Power Query editor, Data Type
// Detection setting and refresh are not built: the data is loaded once as typed values, as File > Open would read it.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {hasDoc} from '../../lib/edit-targets.mjs';
import {bad, failed} from '../../lib/data-common.mjs';
import {a1, rangeA1, rangeOf, MAX_ROWS, MAX_COLS} from '../../lib/addr.mjs';
import {decodeText, sniffDelimiter, parseRecords} from '../../formats/csv-read.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/extra/data.rs', 'crates/xlsx/src/csv.rs']};
const MAX_CELLS = 5_000_000;
const MAX_TEXT = 60_000_000;
export const DELIMITERS = Object.freeze({comma: ',', semicolon: ';', tab: '\t', space: ' ', colon: ':', pipe: '|'});

const bytesOf = b64 => {
  if (typeof atob === 'function') { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  return Uint8Array.from(Buffer.from(b64, 'base64'));
};

/** The source name as a sheet and table name: the file name without its extension, letters and digits kept. */
export function sourceName(name, fallback = 'Table') {
  const base = String(name ?? '').replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const clean = base.replace(/[^\p{L}\p{N}_ ]+/gu, ' ').trim().replace(/\s+/g, ' ');
  return clean || fallback;
}
const tableName = n => { let t = n.replace(/[^\p{L}\p{N}_.]/gu, '_'); if (!/^[\p{L}_]/u.test(t)) t = `_${t}`; return t.slice(0, 120); };

/** The delimiter a name or character stands for ('' detects it from the text). */
export function delimiterOf(value, text) {
  const v = String(value ?? '');
  if (v === '' || v === 'auto' || v === 'detect') return sniffDelimiter(text, '"');
  if (DELIMITERS[v]) return DELIMITERS[v];
  if ([...v].length === 1) return v;
  throw bad('data.fromTextCsv', '`delimiter` is a character, or comma, semicolon, tab, space, colon, pipe or auto', {path: '/delimiter'});
}

/** The rows of CSV text: [[field]] (all strings). */
export function rowsOfText(text, delim, limit = MAX_ROWS) {
  const rows = [];
  parseRecords(text, delim, '"', rec => { if (rows.length >= limit) return false; rows.push(rec); return true; });
  return rows;
}

/** A JSON array of objects as rows with a header: [[key...], [value...]...]; null when the text is not one. */
function rowsOfJson(text) {
  const t = text.trim();
  if (!t.startsWith('[')) return null;
  let data;
  try { data = JSON.parse(t); } catch { return null; }
  if (!Array.isArray(data) || !data.length || !data.every(x => x && typeof x === 'object' && !Array.isArray(x))) return null;
  const keys = [];
  for (const o of data.slice(0, 1000)) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
  const cell = v => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return [keys, ...data.map(o => keys.map(k => cell(o[k])))];
}

function importText(ctx, p, cmd) {
  let text;
  if (typeof p.text === 'string') text = p.text;
  else if (typeof p.data === 'string') text = decodeText(bytesOf(p.data));
  else throw bad(cmd, 'give `text` or `data` (the file\'s content)');
  if (text.length > MAX_TEXT) throw failed('The file is too large to import.');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) throw failed('The file is empty.');
  let rows = rowsOfJson(text);
  if (!rows) rows = rowsOfText(text, delimiterOf(p.delimiter, text));
  const width = Math.min(MAX_COLS, Math.max(...rows.map(r => r.length)));
  if (rows.length * width > MAX_CELLS) throw failed('The file has too many cells to load into a worksheet.');
  const base = sourceName(p.name);
  // The sheet and table are named after the source; a name that is taken gets a number (Excel's Load does the same).
  const content = ctx.doc;
  const taken = n => content.sheets.some(x => x.name.toLowerCase() === n.toLowerCase());
  let sheetName = base.slice(0, 31), k = 2;
  while (taken(sheetName)) { const suffix = ` (${k++})`; sheetName = `${base.slice(0, 31 - suffix.length)}${suffix}`; }
  const made = ctx.run('home.insertSheet', {name: sheetName});
  const values = rows.map(r => Array.from({length: width}, (_, c) => r[c] ?? ''));
  ctx.run('range.setValues', {sheet: made.name, range: 'A1', values});
  const range = rangeA1(rangeOf(0, 0, rows.length - 1, width - 1));
  let tname = tableName(base), n = 2;
  const names = () => new Set(ctx.doc.sheets.flatMap(sh => (sh.tables ?? []).map(t => t.name.toLowerCase())));
  while (names().has(tname.toLowerCase())) tname = `${tableName(base)}_${n++}`;
  const t = ctx.run('insert.table', {sheet: made.name, range, header: true, name: tname});
  return {sheet: made.name, table: t?.table ?? tname, rows: rows.length - 1, columns: width, range};
}

const PARAMS = {text: s.optional(s.string({max: MAX_TEXT})), data: s.optional(s.string({max: 90_000_000})), name: s.optional(s.string({max: 255})), delimiter: s.optional(s.string({max: 16}))};

export default defineCommands({
  family: 'data/import',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'data.fromTextCsv', label: 'From Text/CSV', risk: 'edit', journal: false, dialog: 'dialog.fromTextCsv',
      description: 'From Text/CSV (Data > Get & Transform Data): the text of a file (`text`, or its bytes as base64 `data`) with its `delimiter` (a character, or comma, semicolon, tab, space, colon, pipe; default detected) is loaded into a new sheet after the active one as a table named after `name` (the file name); each field is read as typed input. -> {sheet, table, rows, columns, range}.',
      params: s.object(PARAMS), state: hasDoc, run: (ctx, p) => importText(ctx, p, 'data.fromTextCsv')},
    {id: 'data.getData', label: 'Get Data', risk: 'edit', journal: false, dialog: 'dialog.fromTextCsv',
      description: 'Get Data (Data > Get & Transform Data): as From Text/CSV; the text may also be a JSON array of objects (their keys are the columns).',
      params: s.object(PARAMS), state: hasDoc, run: (ctx, p) => importText(ctx, p, 'data.getData')},
  ],
});

export {a1};
