// Spreadsheets as mail-merge recipient lists (Mailings › Select Recipients › Use an Existing List…):
// the sheet names of an Excel workbook (.xlsx / .xlsm, ECMA-376 Part 1 §18 SpreadsheetML) or an
// OpenDocument spreadsheet (.ods, OASIS ODF 1.3 §9.1), and one sheet's cells as rows of display strings.
//
// Translated from wordcraft crates/formats/src/sheet.rs (`sheet_names`, `read_rows`, `field_names`,
// `resolve`, `Package`, `Grid`, `walk`), sheet/xlsx.rs (`workbook`, `shared_strings`, `cell_formats`,
// `xlsx_rows`, `xlsx_value`, `number`), sheet/ods.rs (`ods_read`, `ods_value`) and sheet/date.rs
// (`builtin_date`, `custom_date`, `serial_date`, `iso_datetime`, `iso_time`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: shared strings (rich-text runs joined, phonetic runs skipped), inline strings, formula
// results (the cached <v>), booleans (TRUE/FALSE), errors as their text and numbers. A number whose
// cell format is a date or time is written in the locale-neutral ISO 8601 form `yyyy-mm-dd`,
// `yyyy-mm-dd hh:mm[:ss]` or `hh:mm[:ss]` (both the 1900 and 1904 date systems); other numbers keep
// up to 15 significant digits. OpenDocument cells use office:value-type. Merged and covered cells
// keep only the top-left value; blank rows are dropped. Every file is hostile: entries, sheets, rows,
// columns, cells and string lengths are capped, repeat counts are clamped to what is left.
//
// Not here: legacy Excel 97–2003 (.xls, BIFF8 in a compound file; sheet/xls.rs). Its extension is not
// offered by the picker (RECIPIENT_EXTENSIONS) and a file in that format is refused with a message.
// The XML is read with a small tokenizer (local names, entities decoded), not a DOM, as upstream
// streams it. Async only because the zip is inflated by JSZip. No DOM, no Node built-ins.

import JSZip from 'jszip';
import {ZipBudget} from '../../common/lib/zip-guard.mjs';

/** File extensions read as spreadsheets here (upstream also reads .xls). */
export const EXTENSIONS = Object.freeze(['xlsx', 'xlsm', 'ods']);
/** File extensions Select Recipients › Use an Existing List… opens (RECIPIENT_EXTENSIONS, without .xls). */
export const RECIPIENT_EXTENSIONS = Object.freeze(['csv', 'tsv', 'txt', ...EXTENSIONS]);

export const MAX_ENTRY = 64 << 20;
export const MAX_TOTAL = 160 << 20;
export const MAX_SHEETS = 4096;
export const MAX_ROWS = 100_000;
export const MAX_COLS = 1000;
export const MAX_CELLS = 2_000_000;
export const MAX_CELL_CHARS = 32_767;
export const MAX_TEXT_BYTES = 64 << 20;
/** Longest tag (name and attributes) read: a real sheet's are a few hundred characters. */
export const MAX_TAG_CHARS = 1 << 20;
const MAX_SHARED = 2_000_000;
const MAX_XFS = 65_536;
const MAX_XML_DEPTH = 256;
/** The legacy compound-file signature of an .xls workbook. */
const XLS_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Whether `ext` (no dot, any case) names a spreadsheet read as a recipient list (is_extension; .xls too, to say why it is refused). */
export function isExtension(ext) {
  const e = String(ext ?? '').replace(/^\./, '').toLowerCase();
  return EXTENSIONS.includes(e) || e === 'xls';
}

/** Whether a file name is a spreadsheet (is_spreadsheet_name). */
export function isSpreadsheetName(name) {
  const m = /\.([^./\\]+)$/.exec(String(name ?? ''));
  return !!m && isExtension(m[1]);
}

const startsWith = (b, magic) => magic.every((x, i) => b[i] === x);
export const isXls = bytes => startsWith(bytes, XLS_MAGIC);

// ---- field names (sheet.rs field_names) ----------------------------------------------------------

/** Field names from a header row: trimmed, blanks named `Column N` (N = 1-based column) and repeats numbered (`Name`, `Name 2`), ignoring case. */
export function fieldNames(row) {
  const out = [];
  const taken = new Set();
  const next = new Map();
  const lower = s => s.replace(/[A-Z]/g, c => c.toLowerCase());
  row.forEach((h, i) => {
    const t = String(h).trim();
    const base = t === '' ? `Column ${i + 1}` : t;
    let name = base;
    if (taken.has(lower(name))) {
      const key = lower(base);
      let k = next.get(key) ?? 2;
      for (;;) {
        name = `${base} ${k}`;
        k += 1;
        if (!taken.has(lower(name))) break;
      }
      next.set(key, k);
    }
    taken.add(lower(name));
    out.push(name);
  });
  return out;
}

// ---- XML (walk) --------------------------------------------------------------------------------------

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' ? Number.parseInt(g.slice(2), 16) : Number.parseInt(g.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return ''; }
    }
    return ENTITIES[g] ?? '';
  });
}
const local = n => { const i = n.indexOf(':'); return i < 0 ? n : n.slice(i + 1); };
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A streamed XML read with namespace prefixes dropped: `f({type: 'start', name, attr(name)})`,
 * `{type: 'end', name}` and `{type: 'text', text}`; elements deeper than MAX_XML_DEPTH (and their text) are skipped.
 */
export function walk(xml, f) {
  // An indexOf scanner: every step consumes input, so the work is linear. (A regex tokenizer rescanned to the end of the
  // input from every '<' that did not close, which is quadratic, so a few MB of '<a ' hung the window.) A construct
  // that never closes ends the read: the rest of the file cannot be told apart from its text.
  const n = xml.length;
  let depth = 0;
  let i = 0;
  while (i < n) {
    if (xml.charCodeAt(i) !== 60) {
      let j = xml.indexOf('<', i);
      if (j < 0) j = n;
      if (depth <= MAX_XML_DEPTH) f({type: 'text', text: decodeEntities(xml.slice(i, j))});
      i = j;
      continue;
    }
    if (xml.startsWith('<!--', i)) { const e = xml.indexOf('-->', i + 4); if (e < 0) return; i = e + 3; continue; }
    if (xml.startsWith('<![CDATA[', i)) {
      const e = xml.indexOf(']]>', i + 9);
      if (e < 0) return;
      if (depth <= MAX_XML_DEPTH) f({type: 'text', text: xml.slice(i + 9, e)});
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<?', i)) { const e = xml.indexOf('?>', i + 2); if (e < 0) return; i = e + 2; continue; }
    if (xml.startsWith('<!', i)) { const e = xml.indexOf('>', i + 2); if (e < 0) return; i = e + 1; continue; }
    // A tag: '<', an optional '/', a name up to whitespace, '/' or '>', then attributes (quoted values may hold '>').
    let k = i + 1;
    const closing = xml.charCodeAt(k) === 47;
    if (closing) k += 1;
    const nameStart = k;
    while (k < n) { const c = xml.charCodeAt(k); if (c === 62 || c === 47 || c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11) break; k += 1; }
    if (k === nameStart) { i += 1; continue; }
    const name = local(xml.slice(nameStart, k));
    const attrStart = k;
    const limit = Math.min(n, attrStart + MAX_TAG_CHARS);
    let end = -1;
    while (k < limit) {
      const c = xml.charCodeAt(k);
      if (c === 62) { end = k; break; }
      if (c === 34 || c === 39) { const q = xml.indexOf(c === 34 ? '"' : "'", k + 1); if (q < 0 || q >= limit) return; k = q + 1; continue; }
      k += 1;
    }
    if (end < 0) return;
    i = end + 1;
    if (closing) {
      if (depth <= MAX_XML_DEPTH) f({type: 'end', name});
      depth = Math.max(0, depth - 1);
      continue;
    }
    const selfClosing = xml.charCodeAt(end - 1) === 47 && end - 1 >= attrStart;
    const raw = xml.slice(attrStart, selfClosing ? end - 1 : end);
    const attr = key => {
      const x = new RegExp(`(?:^|\\s)(?:[A-Za-z0-9_.-]+:)?${escapeRe(key)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(raw);
      return x ? decodeEntities(x[1] ?? x[2] ?? '') : null;
    };
    if (selfClosing) {
      if (depth < MAX_XML_DEPTH) { f({type: 'start', name, attr}); f({type: 'end', name}); }
    } else {
      depth += 1;
      if (depth <= MAX_XML_DEPTH) f({type: 'start', name, attr});
    }
  }
}

/** `s` + `t`, keeping `s` at most MAX_CELL_CHARS characters. */
function pushCapped(s, t) {
  const have = [...s].length;
  if (have >= MAX_CELL_CHARS) return s;
  return s + [...t].slice(0, MAX_CELL_CHARS - have).join('');
}

const utf8Len = s => new TextEncoder().encode(s).length;

/** Rows collected under the caps (Grid): blank rows dropped, rows past MAX_ROWS, cells past MAX_CELLS and rows past MAX_TEXT_BYTES of text ignored. */
class Grid {
  constructor() { this.rows = []; this.cells = 0; this.text = 0; }
  full() { return this.rows.length >= MAX_ROWS || this.cells >= MAX_CELLS || this.text >= MAX_TEXT_BYTES; }
  push(row, times) {
    row = [...row];
    while (row.length && row.at(-1) === '') row.pop();
    if (!row.length) return;
    let left = times;
    while (left > 0 && !this.full()) {
      const keep = Math.min(row.length, Math.max(0, MAX_CELLS - this.cells));
      const r = row.slice(0, keep);
      const bytes = r.reduce((n, c) => n + utf8Len(c), 0);
      if (this.text + bytes > MAX_TEXT_BYTES) return;
      this.text += bytes;
      this.cells += r.length;
      this.rows.push(r);
      left -= 1;
    }
  }
}

// ---- dates (sheet/date.rs) -------------------------------------------------------------------------

const D = 'date', T = 'time', DT = 'datetime';

/** The built-in number formats (§18.8.30) that show dates or times. */
export function builtinDate(id) {
  if ((id >= 14 && id <= 17) || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return D;
  if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47)) return T;
  return id === 22 ? DT : null;
}

/** Whether a custom format code (§18.8.31) shows a date or time. */
export function customDate(code) {
  let plain = '';
  const cs = [...String(code)];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c === ';') break;
    if (c === '"') { for (i++; i < cs.length && cs[i] !== '"'; i++); continue; }
    if (c === '[') { for (i++; i < cs.length && cs[i] !== ']'; i++); continue; }
    if (c === '\\' || c === '_' || c === '*') { i++; continue; }
    plain += c.toLowerCase();
  }
  const has = c => plain.includes(c);
  const date = has('d') || has('y'), time = has('h') || has('s');
  if (date && time) return DT;
  if (date) return D;
  if (time) return T;
  if (has('m') && !has('0') && !has('#')) return D;
  return null;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Days since 1970-01-01 to a proleptic Gregorian [year, month, day]. */
export function civil(z) {
  z += 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

/** A serial date-time (days since the workbook's epoch) in ISO 8601 form. */
export function serialDate(serial, date1904, kind) {
  if (!Number.isFinite(serial) || serial < 0 || serial >= 2_958_466) return null;
  let days = Math.floor(serial);
  let secs = Math.round((serial - Math.floor(serial)) * 86_400);
  if (secs >= 86_400) { days += 1; secs -= 86_400; }
  // The 1900 system counts a 29 February 1900 that never was, so days before it start a day later.
  const epoch = date1904 ? -24_107 : days < 60 ? -25_568 : -25_569;
  const [y, m, d] = civil(days + epoch);
  const h = Math.floor(secs / 3600), mi = Math.floor(secs / 60) % 60, s = secs % 60;
  const time = s === 0 ? `${pad(h)}:${pad(mi)}` : `${pad(h)}:${pad(mi)}:${pad(s)}`;
  const date = `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
  return kind === D ? date : kind === T ? time : `${date} ${time}`;
}

/** An ISO 8601 date or date-time as `yyyy-mm-dd`, with ` hh:mm[:ss]` when the time isn't midnight (iso_datetime). */
export function isoDatetime(v) {
  const s = String(v);
  const at = s.indexOf('T');
  const date = at < 0 ? s : s.slice(0, at);
  const time = at < 0 ? '' : s.slice(at + 1);
  const parts = date.split('-');
  if (parts.length < 3 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
  const y = Number(parts[0]), m = Number(parts[1]);
  const dDigits = /^\d+/.exec(parts.slice(2).join('-'))?.[0] ?? '';
  const d = Number(dDigits);
  if (!dDigits || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  let out = `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
  const clean = time.split(/[Z+\-.]/)[0] ?? '';
  const hms = clean.split(':').filter(p => /^\d+$/.test(p)).map(Number);
  if (hms.length >= 2) {
    const [h, mi, sec = 0] = hms;
    if (h !== 0 || mi !== 0 || sec !== 0) out += sec === 0 ? ` ${pad(h)}:${pad(mi)}` : ` ${pad(h)}:${pad(mi)}:${pad(sec)}`;
  }
  return out;
}

/** An ISO 8601 duration time (`PT13H45M00S`) or clock time (`13:45[:00]`) as `hh:mm[:ss]` (iso_time). */
export function isoTime(v) {
  const t = String(v).trim();
  if (t.startsWith('PT')) {
    let h = 0, m = 0, s = 0, num = '';
    for (const c of t.slice(2)) {
      if (c === 'H' || c === 'M' || c === 'S') {
        const n = Number(num);
        if (num === '' || !Number.isFinite(n)) return null;
        num = '';
        if (c === 'H') h = n; else if (c === 'M') m = n; else s = n;
      } else if (num.length < 20) num += c;
      else return null;
    }
    const sec = Math.round(s);
    return sec === 0 ? `${pad(h)}:${pad(m)}` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }
  const hms = (t.split(/[Z+\-]/)[0] ?? '').split(':').filter(p => /^\d+/.test(p)).map(p => Number(p.split('.')[0]));
  if (hms.length >= 2) {
    const [h, mi, sec = 0] = hms;
    return sec === 0 ? `${pad(h)}:${pad(mi)}` : `${pad(h)}:${pad(mi)}:${pad(sec)}`;
  }
  return null;
}

/** A number as a spreadsheet shows it in General format: up to 15 significant digits, no trailing zeros (number). */
export function number(x) {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x) && Math.abs(x) < 1e15) return String(x + 0);
  const rounded = Number(x.toExponential(14));
  if (Math.abs(rounded) >= 1e15 || Math.abs(rounded) < 1e-9) return rounded.toExponential().toUpperCase().replace('E+', 'E');
  return String(rounded);
}

// ---- the package ---------------------------------------------------------------------------------------

class Package {
  constructor(zip) { this.zip = zip; this.total = 0; this.budget = new ZipBudget({total: MAX_TOTAL, part: MAX_ENTRY, xmlPart: MAX_ENTRY}); }
  static async open(bytes) {
    let zip;
    try { zip = await JSZip.loadAsync(bytes); } catch (e) { throw new Error(`not a valid spreadsheet package (${e?.message ?? e})`); }
    return new Package(zip);
  }
  has(name) { return !!this.zip.file(name); }
  /** Inflate an entry, refusing ones (or a workbook) larger than the caps. */
  async read(name) {
    const f = this.zip.file(name);
    if (!f) throw new Error(`${name} is missing`);
    // Inflated as a stream and cut off at the caps: the header's declared size is the file's word, not ours.
    let text;
    try { text = await this.budget.text(f, name); } catch (e) { if (e?.code === 'zip_limit') throw new Error(`${name} is too large`); throw e; }
    this.total = this.budget.used;
    return text;
  }
  async kind() {
    if (await this.workbookPath()) return 'xlsx';
    if (this.has('content.xml')) {
      let ods;
      try { ods = (await this.read('mimetype')).trim().startsWith('application/vnd.oasis.opendocument.spreadsheet'); }
      catch { ods = !this.has('word/document.xml'); }
      if (ods) return 'ods';
    }
    return null;
  }
  /** The SpreadsheetML workbook part: the package's main part when it is a workbook, otherwise `xl/workbook.xml` when present. */
  async workbookPath() {
    try {
      for (const r of relationships(await this.read('_rels/.rels'), '')) {
        if (r.kind.endsWith('/officeDocument') && r.target.toLowerCase().includes('workbook') && this.has(r.target)) return r.target;
      }
    } catch { /* no root relationships */ }
    return this.has('xl/workbook.xml') ? 'xl/workbook.xml' : null;
  }
}

/** A relative part name resolved against `dir` (`/` = the package root). */
function join(dir, target) {
  const parts = target.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}
const dirOf = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const relsOf = p => (p.includes('/') ? `${dirOf(p)}/_rels/${p.slice(p.lastIndexOf('/') + 1)}.rels` : `_rels/${p}.rels`);

/** The relationships of a part in `dir` (targets resolved to package paths). */
export function relationships(xml, dir) {
  const v = [];
  walk(xml, ev => {
    if (ev.type !== 'start' || ev.name !== 'Relationship' || v.length >= MAX_SHEETS * 2) return;
    if ((ev.attr('TargetMode') ?? '').toLowerCase() === 'external') return;
    v.push({id: ev.attr('Id') ?? '', kind: ev.attr('Type') ?? '', target: join(dir, ev.attr('Target') ?? '')});
  });
  return v;
}

async function workbook(pkg) {
  const path = await pkg.workbookPath();
  if (!path) throw new Error('the workbook part is missing');
  const xml = await pkg.read(path);
  let rels = [];
  try { rels = relationships(await pkg.read(relsOf(path)), dirOf(path)); } catch { /* no relationships */ }
  const listed = [];
  let date1904 = false;
  walk(xml, ev => {
    if (ev.type !== 'start') return;
    if (ev.name === 'sheet' && listed.length < MAX_SHEETS) listed.push([ev.attr('name') ?? '', ev.attr('id') ?? '']);
    else if (ev.name === 'workbookPr') { const v = ev.attr('date1904'); date1904 = v !== null && (v === '1' || v.toLowerCase() === 'true'); }
  });
  const sheets = [];
  for (const [name, id] of listed) {
    // Worksheets only: chart and dialog sheets hold no cells.
    const r = rels.find(x => x.id === id && x.kind.endsWith('/worksheet'));
    if (r) sheets.push({name, path: r.target});
  }
  const part = suffix => rels.find(r => r.kind.endsWith(suffix))?.target ?? null;
  return {sheets, date1904, shared: part('/sharedStrings'), styles: part('/styles')};
}

/** The shared string table (§18.4): each `si`'s text, rich-text runs joined, phonetic runs (`rPh`) left out. */
function sharedStrings(xml) {
  const out = [];
  let cur = null, inT = false, phonetic = 0;
  walk(xml, ev => {
    if (ev.type === 'start') {
      if (ev.name === 'si') cur = '';
      else if (ev.name === 't') inT = true;
      else if (ev.name === 'rPh') phonetic += 1;
    } else if (ev.type === 'end') {
      if (ev.name === 'si') { if (cur !== null && out.length < MAX_SHARED) out.push(cur); cur = null; }
      else if (ev.name === 't') inT = false;
      else if (ev.name === 'rPh') phonetic = Math.max(0, phonetic - 1);
    } else if (inT && phonetic === 0 && cur !== null) cur = pushCapped(cur, ev.text);
  });
  return out;
}

/** Each cell format's (`cellXfs/xf`, by `s` index) date kind. */
function cellFormats(xml) {
  const custom = new Map();
  const xfs = [];
  let inXfs = false;
  walk(xml, ev => {
    if (ev.type === 'start') {
      if (ev.name === 'numFmt' && custom.size < MAX_XFS) {
        const id = Number.parseInt(ev.attr('numFmtId') ?? '', 10);
        if (Number.isFinite(id)) custom.set(id, customDate(ev.attr('formatCode') ?? ''));
      } else if (ev.name === 'cellXfs') inXfs = true;
      else if (ev.name === 'xf' && inXfs && xfs.length < MAX_XFS) xfs.push(Number.parseInt(ev.attr('numFmtId') ?? '', 10) || 0);
    } else if (ev.type === 'end' && ev.name === 'cellXfs') inXfs = false;
  });
  return xfs.map(id => (custom.has(id) ? custom.get(id) : builtinDate(id)));
}

/** A cell reference's 0-based column (`C5` → 2); null when it isn't one. */
function refCol(r) {
  let col = 0, letters = 0;
  for (const c of r) {
    if (/[A-Za-z]/.test(c)) {
      letters += 1;
      if (letters > 3) return null;
      col = col * 26 + (c.toUpperCase().charCodeAt(0) - 64);
    } else break;
  }
  return col - 1 >= 0 ? col - 1 : null;
}

function xlsxValue(c, shared, formats, date1904) {
  const v = c.value.trim();
  const kind = c.kind.trim().toLowerCase();
  if (kind === 's') { const i = /^\d+$/.test(v) ? Number(v) : -1; return shared[i] ?? ''; }
  if (kind === 'inlinestr') return c.inline === '' ? c.value : c.inline;
  if (kind === 'str' || kind === 'e') return c.value;
  if (kind === 'b') return v === '1' || v.toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
  if (kind === 'd') return isoDatetime(v) ?? v;
  if (v === '') return c.inline;
  const x = Number(v);
  if (!Number.isFinite(x)) return v;
  const fmt = formats[c.style] ?? null;
  return fmt ? serialDate(x, date1904, fmt) ?? number(x) : number(x);
}

async function xlsxRows(pkg, path) {
  const wb = await workbook(pkg);
  const sharedPath = wb.shared ?? (pkg.has('xl/sharedStrings.xml') ? 'xl/sharedStrings.xml' : null);
  const shared = sharedPath ? sharedStrings(await pkg.read(sharedPath)) : [];
  const stylesPath = wb.styles ?? (pkg.has('xl/styles.xml') ? 'xl/styles.xml' : null);
  const formats = stylesPath ? cellFormats(await pkg.read(stylesPath)) : [];
  const xml = await pkg.read(path);
  const rows = new Map();
  let cells = 0, budget = 0;
  let inData = false, rowNo = 0, nextCol = 0;
  let cell = null;
  let inV = false, inIsT = false, phonetic = 0;
  walk(xml, ev => {
    if (ev.type === 'start') {
      if (ev.name === 'sheetData') inData = true;
      else if (ev.name === 'row' && inData) { rowNo = Number.parseInt(ev.attr('r') ?? '', 10) || rowNo + 1; nextCol = 0; }
      else if (ev.name === 'c' && inData) {
        // A reference that isn't one (or is past the last column) drops the cell.
        const r = ev.attr('r');
        const col = r !== null ? refCol(r.trim()) ?? Infinity : nextCol;
        nextCol = col + 1;
        cell = {col, kind: ev.attr('t') ?? '', style: Number.parseInt(ev.attr('s') ?? '', 10) || 0, value: '', inline: ''};
      } else if (ev.name === 'v') inV = !!cell;
      else if (ev.name === 't') inIsT = !!cell;
      else if (ev.name === 'rPh') phonetic += 1;
    } else if (ev.type === 'text') {
      if (cell) {
        if (inV) cell.value = pushCapped(cell.value, ev.text);
        else if (inIsT && phonetic === 0) cell.inline = pushCapped(cell.inline, ev.text);
      }
    } else if (ev.type === 'end') {
      if (ev.name === 'sheetData') inData = false;
      else if (ev.name === 'v') inV = false;
      else if (ev.name === 't') inIsT = false;
      else if (ev.name === 'rPh') phonetic = Math.max(0, phonetic - 1);
      else if (ev.name === 'c') {
        const c = cell;
        cell = null;
        if (!c) return;
        const text = xlsxValue(c, shared, formats, wb.date1904);
        if (text === '' || c.col >= MAX_COLS) return;
        if (!rows.has(rowNo) && rows.size >= MAX_ROWS) return;
        const bytes = utf8Len(text);
        if (budget + bytes > MAX_TEXT_BYTES) return;
        budget += bytes;
        let row = rows.get(rowNo);
        if (!row) { row = []; rows.set(rowNo, row); }
        if (row.length <= c.col) {
          const grow = c.col + 1 - row.length;
          if (cells + grow > MAX_CELLS) return;
          cells += grow;
          while (row.length < c.col + 1) row.push('');
        }
        row[c.col] = text;
      }
    }
  });
  const grid = new Grid();
  for (const k of [...rows.keys()].sort((a, b) => a - b)) grid.push(rows.get(k), 1);
  return grid.rows;
}

// ---- OpenDocument ---------------------------------------------------------------------------------------

function odsValue(c) {
  const v = c.value === null ? null : c.value.trim();
  const kind = c.kind.trim().toLowerCase();
  if (v !== null) {
    if (kind === 'float') { const x = Number(v); return v !== '' && Number.isFinite(x) ? number(x) : c.text; }
    if (kind === 'date') return isoDatetime(v) ?? c.text;
    if (kind === 'time') return isoTime(v) ?? c.text;
    if (kind === 'boolean') return v.toLowerCase() === 'true' || v === '1' ? 'TRUE' : 'FALSE';
    if ((kind === 'percentage' || kind === 'currency') && c.text.trim() === '') { const x = Number(v); return v !== '' && Number.isFinite(x) ? number(x) : c.text; }
    if (kind === 'string' && c.text.trim() === '') return pushCapped('', v);
  }
  return c.text;
}

/** The sheet names of `content.xml`, and with `want` (an index) that sheet's rows: [names, rows] (ods_read). */
export function odsRead(xml, want = null) {
  const names = [];
  const grid = new Grid();
  let tables = 0, collecting = false;
  let row = null; // {cells, pending, repeat, bytes (null once the row is over the text budget)}
  let cell = null;
  let inP = 0, skip = 0;
  walk(xml, ev => {
    if (ev.type === 'start') {
      const n = ev.name;
      if (n === 'table') {
        if (tables === 0 && names.length < MAX_SHEETS) {
          collecting = want === names.length;
          names.push(ev.attr('name') ?? `Sheet${names.length + 1}`);
        }
        tables += 1;
        return;
      }
      if (!collecting || tables !== 1) return;
      if (n === 'table-row') {
        const repeat = Math.max(1, Number.parseInt(ev.attr('number-rows-repeated') ?? '', 10) || 1);
        row = {cells: [], pending: 0, repeat, bytes: 0};
      } else if ((n === 'table-cell' || n === 'covered-table-cell') && row) {
        const repeat = Math.max(1, Number.parseInt(ev.attr('number-columns-repeated') ?? '', 10) || 1);
        const kind = ev.attr('value-type') ?? '';
        const kl = kind.trim().toLowerCase();
        const value = kl === 'float' || kl === 'percentage' || kl === 'currency' ? ev.attr('value') : kl === 'date' ? ev.attr('date-value')
          : kl === 'time' ? ev.attr('time-value') : kl === 'boolean' ? ev.attr('boolean-value') : kl === 'string' ? ev.attr('string-value') : null;
        const covered = n === 'covered-table-cell';
        cell = {repeat, kind: covered ? '' : kind, value: covered ? null : value, text: '', paras: 0};
        if (covered) skip += 1;
      } else if (n === 'annotation' && cell) skip += 1;
      else if ((n === 'p' || n === 'h') && cell) {
        if (skip === 0) { if (cell.paras > 0) cell.text = pushCapped(cell.text, '\n'); cell.paras += 1; }
        inP += 1;
      } else if (n === 's' && inP > 0 && skip === 0) {
        const k = Math.max(1, Math.min(1000, Number.parseInt(ev.attr('c') ?? '', 10) || 1));
        if (cell) cell.text = pushCapped(cell.text, ' '.repeat(k));
      } else if (n === 'tab' && inP > 0 && skip === 0) { if (cell) cell.text = pushCapped(cell.text, '\t'); }
      else if (n === 'line-break' && inP > 0 && skip === 0) { if (cell) cell.text = pushCapped(cell.text, '\n'); }
    } else if (ev.type === 'text') {
      if (inP > 0 && skip === 0 && cell) cell.text = pushCapped(cell.text, ev.text);
    } else {
      const n = ev.name;
      if (n === 'table') {
        tables = Math.max(0, tables - 1);
        if (tables === 0) collecting = false;
        return;
      }
      if (!collecting || tables !== 1) return;
      if (n === 'p' || n === 'h') inP = Math.max(0, inP - 1);
      else if (n === 'annotation') skip = Math.max(0, skip - 1);
      else if (n === 'table-cell' || n === 'covered-table-cell') {
        if (n === 'covered-table-cell') skip = Math.max(0, skip - 1);
        const c = cell; cell = null;
        if (!c || !row || row.bytes === null) return;
        const text = odsValue(c);
        if (text === '') { row.pending += c.repeat; return; }
        // Blank cells before this one, then the value as often as it repeats, as far as the columns and the grid's cells left allow.
        const room = Math.min(MAX_COLS, Math.max(0, MAX_CELLS - grid.cells));
        const blanks = Math.min(row.pending, Math.max(0, room - row.cells.length));
        const times = Math.min(c.repeat, Math.max(0, room - (row.cells.length + blanks)));
        row.bytes += utf8Len(text) * times;
        if (row.bytes > MAX_TEXT_BYTES - grid.text) { row.cells = []; row.bytes = null; return; }
        for (let i = 0; i < blanks; i++) row.cells.push('');
        row.pending = 0;
        for (let i = 0; i < times; i++) row.cells.push(text);
      } else if (n === 'table-row') {
        const r = row; row = null;
        if (r && r.bytes !== null) grid.push(r.cells, r.repeat);
      }
    }
  });
  if (!names.length) throw new Error('the spreadsheet has no sheets');
  return [names, grid.rows];
}

// ---- the public reads ---------------------------------------------------------------------------------

async function open(bytes) {
  if (isXls(bytes)) throw new Error('Excel 97-2003 workbooks (.xls) are not read yet: open it in a spreadsheet program, save it as .xlsx or .csv and select it again');
  const pkg = await Package.open(bytes);
  const kind = await pkg.kind();
  if (!kind) throw new Error('not an Excel or OpenDocument spreadsheet');
  return [pkg, kind];
}

/** What kind of spreadsheet `bytes` holds, from the package contents (null: not one; 'xls' for the legacy format). */
export async function detect(bytes) {
  if (isXls(bytes)) return 'xls';
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return null;
  try { return await (await Package.open(bytes)).kind(); } catch { return null; }
}

/** The sheet names, in workbook order. */
export async function sheetNames(bytes) {
  const [pkg, kind] = await open(bytes);
  if (kind === 'xlsx') return (await workbook(pkg)).sheets.map(s => s.name);
  return odsRead(await pkg.read('content.xml'), null)[0];
}

function resolve(names, pick) {
  if (!names.length) throw new Error('the workbook has no sheets');
  if (typeof pick === 'number') {
    if (pick >= 0 && pick < names.length) return pick;
    throw new Error(`the workbook has ${names.length} sheets; there is no sheet ${pick + 1}`);
  }
  const n = String(pick);
  let i = names.indexOf(n);
  if (i < 0) i = names.findIndex(s => s.toLowerCase() === n.trim().toLowerCase());
  if (i < 0) throw new Error(`no sheet named "${n}"`);
  return i;
}

/** One sheet's non-blank rows of display strings (trailing blank cells trimmed): [sheet names, rows]. `pick`: a 0-based index or a name. */
export async function readRows(bytes, pick) {
  const [pkg, kind] = await open(bytes);
  if (kind === 'xlsx') {
    const sheets = (await workbook(pkg)).sheets;
    const names = sheets.map(s => s.name);
    const sheet = sheets[resolve(names, pick)];
    return [names, await xlsxRows(pkg, sheet.path)];
  }
  const content = await pkg.read('content.xml');
  const [names] = odsRead(content, null);
  const i = resolve(names, pick);
  return [names, odsRead(content, i)[1]];
}
