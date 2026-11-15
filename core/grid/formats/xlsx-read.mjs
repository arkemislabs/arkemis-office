// Excel workbook (.xlsx / .xlsm) into a schema-2 workbook.
// Translated from gridcraft crates/xlsx/src at 146161b4b450a56e5e59a083ba0478582d1e602b:
//   xml.rs (El, rich_text, decode_xstring), read.rs (`read_xlsx`: parts by relationship, theme,
//   styles, shared strings, workbookPr/calcPr, sheets with their state and the active tab, defined
//   names incl. print areas, document properties), styles.rs (`read_styles`, `read_color`,
//   `read_font`, `read_fill`, `read_border`, `read_alignment`, `read_protection`, `read_xf`,
//   `read_dxf`), theme.rs (`read_theme` colour slots and fonts), sheet_read.rs (`read_sheet`,
//   `read_views`, `read_sheet_format`, `read_cols`, `read_row`, `read_cell`, `read_formula_text`
//   with shared formulas, legacy arrays and dynamic arrays, `parse_iso_datetime`, `parse_sqref`,
//   sheetProtection), sheet_read/parts.rs (`read_table`, `read_autofilter`, hyperlinks,
//   comments), sheet_read/rules.rs (conditional formats, data validation), fmla.rs (`from_file`)
//   and tables.rs (built-in number formats, `col_width_to_px`, `pt_to_px`).
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:grid/formats-xlsx.
// May use jszip (core/*/formats/* exception, architecture 5.3); no DOM.
//
// Schema-2 shapes this reader fills beside the foundation's (model/workbook.mjs):
//   content.theme {name, colors[12] (0xRRGGBB, Excel's slot order lt1 dk1 lt2 dk2 accent1-6
//     hlink folHlink), majorFont, minorFont}; content.calc; content.dateSystem; content.names
//     [{name, formula, scope?, comment?, hidden?}]; content.properties {title, subject, author,
//     keywords, description, company}.
//   sheet.hyperlinks {A1: {target?, location?, tooltip?, display?}}; sheet.notes {A1: {text,
//     author}}; sheet.conditionalFormats [{id, ranges, priority, type, ...}]; sheet.validations
//   [{id, ranges, type, ...}]; sheet.tables [{name, range, headerRow, totalsRow, columns, style,
//   autoFilter}]; sheet.autofilter {range}; sheet.protection {enabled, password?, select*,
//   format*, insert*, delete*, sort, autofilter}; sheet.printArea; rows/cols Line {size, hidden,
//   s, custom, outline, collapsed}.

import JSZip from 'jszip';
import {ZipBudget} from '../../common/lib/zip-guard.mjs';
import {MAX_ROWS, MAX_COLS, a1, parseRange, parseCell, rangeA1, INDEXED} from '../lib/addr.mjs';
import {parse, print, mapExpr, shiftRelative} from '../lib/formula.mjs';
import {parseError} from '../lib/value.mjs';
import {serialFromYmd} from '../lib/date.mjs';
import {blockOf} from '../model/store.mjs';
import {sparseStyle, resolveStyle, styleKey, DEFAULT_THEME} from '../model/style.mjs';
import {checkSheetName} from '../model/sheet.mjs';
import {readAutofilter} from '../lib/data-filter-xlsx.mjs';
import {readDrawing, readSparklines} from '../lib/xlsx-drawing.mjs';
import {readPersons, readThreaded} from '../lib/xlsx-threaded.mjs';
import {readPageSetupElement} from '../lib/xlsx-pagesetup.mjs';
import {CachesIn, readPivots} from '../lib/xlsx-pivot.mjs';
import {readSheetSlicers, resolveSlicers} from '../lib/xlsx-slicer.mjs';

// ---------------------------------------------------------------------------------------------
// xml.rs: a small element tree (local names, attributes by local name, children, direct text)

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
const unescape = s => s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : m;
  }
  return ENTITIES[e] ?? m;
});
const local = n => { const i = n.indexOf(':'); return i < 0 ? n : n.slice(i + 1); };

export class El {
  constructor(name, attrs) { this.name = name; this.attrs = attrs; this.children = []; this.text = ''; }
  attr(k) { return this.attrs[k]; }
  num(k) { const v = this.attrs[k]; if (v === undefined) return undefined; const n = Number(String(v).trim()); return Number.isFinite(n) ? n : undefined; }
  /** `flag`: true/1 or false/0, else the default. */
  flag(k, d) { const v = this.attrs[k]; if (v === undefined) return d; const t = String(v).trim().toLowerCase(); return t === '1' || t === 'true' ? true : t === '0' || t === 'false' ? false : d; }
  child(n) { return this.children.find(c => c.name === n); }
  kids(n) { return this.children.filter(c => c.name === n); }
  path(names) { let e = this; for (const n of names) { e = e?.child(n); if (!e) return undefined; } return e; }
  childVal(n) { return this.child(n)?.attr('val'); }
}

const MAX_DEPTH = 256;
/** xml.rs `parse`: refuses DOCTYPE/ENTITY declarations and nesting deeper than 256. */
export function parseXml(src) {
  if (/<!DOCTYPE|<!ENTITY/i.test(src.slice(0, 4096))) throw new Error('XML document type declarations are not supported');
  const root = new El('#document', {});
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) { if (stack.length > 1) stack.pop(); }
    else if (m[3] !== undefined) {
      const attrs = {};
      let a;
      attrRe.lastIndex = 0;
      while ((a = attrRe.exec(m[4] ?? ''))) {
        const k = local(a[1]);
        if (a[1].startsWith('xmlns')) continue;
        if (!(k in attrs)) attrs[k] = unescape(a[2] ?? a[3] ?? '');
        if (a[1].includes(':')) attrs[a[1]] = unescape(a[2] ?? a[3] ?? '');
      }
      const el = new El(local(m[3]), attrs);
      top.children.push(el);
      if (!m[5]) {
        if (stack.length > MAX_DEPTH) throw new Error('the XML nests too deeply');
        stack.push(el);
      }
    } else if (m[6] !== undefined) top.text += unescape(m[6]);
  }
  return root.children.find(c => c instanceof El) ?? root;
}

/** xml.rs `decode_xstring`: `_xHHHH_` escapes (surrogate pairs joined). */
export function decodeXString(s) {
  return String(s).replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
/** xml.rs `rich_text`: the text of `<t>` and the runs' `<t>`, phonetic runs left out. */
export function richText(e) {
  let out = '';
  for (const c of e.children) {
    if (c.name === 't') out += c.text;
    else if (c.name === 'r') for (const t of c.kids('t')) out += t.text;
  }
  return decodeXString(out);
}

// ---------------------------------------------------------------------------------------------
// tables.rs

/** Built-in number format codes (en-US) by id; 23–36 read as General. */
export const BUILTIN_FORMATS = new Map([
  [0, 'General'], [1, '0'], [2, '0.00'], [3, '#,##0'], [4, '#,##0.00'],
  [5, '"$"#,##0_);\\("$"#,##0\\)'], [6, '"$"#,##0_);[Red]\\("$"#,##0\\)'], [7, '"$"#,##0.00_);\\("$"#,##0.00\\)'], [8, '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)'],
  [9, '0%'], [10, '0.00%'], [11, '0.00E+00'], [12, '# ?/?'], [13, '# ??/??'], [14, 'm/d/yyyy'], [15, 'd-mmm-yy'], [16, 'd-mmm'], [17, 'mmm-yy'],
  [18, 'h:mm AM/PM'], [19, 'h:mm:ss AM/PM'], [20, 'h:mm'], [21, 'h:mm:ss'], [22, 'm/d/yyyy h:mm'],
  [37, '#,##0 ;(#,##0)'], [38, '#,##0 ;[Red](#,##0)'], [39, '#,##0.00;(#,##0.00)'], [40, '#,##0.00;[Red](#,##0.00)'],
  [41, '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)'], [42, '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)'],
  [43, '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)'], [44, '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)'],
  [45, 'mm:ss'], [46, '[h]:mm:ss'], [47, 'mmss.0'], [48, '##0.0E+0'], [49, '@'],
]);
/** Stored column width (characters) → px (tables.rs `col_width_to_px`). */
export function colWidthToPx(w) {
  if (!Number.isFinite(w) || w <= 0) return 0;
  const x = Math.min(w, 255);
  return Math.trunc(((256 * x + Math.trunc(128 / 7)) / 256) * 7);
}
/** Row height in points → px (tables.rs `pt_to_px`). */
export const ptToPx = pt => (!Number.isFinite(pt) || pt <= 0 ? 0 : Math.round(Math.min(pt, 409.5) * 4 / 3 * 1000) / 1000);

// ---------------------------------------------------------------------------------------------
// fmla.rs `from_file`: file formula text → model text (prefixes stripped when it parses)

const PARAM_PREFIX = '_xlpm.';
const stripParam = n => (typeof n === 'string' && n.toLowerCase().startsWith(PARAM_PREFIX) ? n.slice(PARAM_PREFIX.length) : n);
export function fromFile(text) {
  const body = String(text ?? '').replace(/^=/, '');
  let e;
  try { e = parse(body); } catch { return body; }
  return print(mapExpr(e, x => {
    if (x.t === 'name') return {...x, v: stripParam(x.v)};
    if (x.t === 'call') {
      const n = stripParam(x.name);
      if (/^_XLFN\.ANCHORARRAY$/i.test(n) && x.args.length === 1) return {t: 'unary', op: 'spill', x: x.args[0]};
      if (/^_XLFN\.SINGLE$/i.test(n) && x.args.length === 1) return {t: 'unary', op: 'at', x: x.args[0]};
      return n === x.name ? x : {...x, name: n};
    }
    return x;
  }));
}

// ---------------------------------------------------------------------------------------------
// styles.rs / theme.rs

const THEME_SLOTS = [['dk1', 1], ['lt1', 0], ['dk2', 3], ['lt2', 2], ['accent1', 4], ['accent2', 5], ['accent3', 6], ['accent4', 7], ['accent5', 8], ['accent6', 9], ['hlink', 10], ['folHlink', 11]];
export function readTheme(root) {
  const t = {name: root.attr('name') ?? DEFAULT_THEME.name, colors: [...DEFAULT_THEME.colors], majorFont: DEFAULT_THEME.majorFont, minorFont: DEFAULT_THEME.minorFont};
  const el = root.child('themeElements');
  if (!el) return t;
  const cs = el.child('clrScheme');
  if (cs) for (const [name, i] of THEME_SLOTS) {
    const s = cs.child(name);
    if (!s) continue;
    const srgb = s.child('srgbClr')?.attr('val');
    const sys = s.child('sysClr');
    let v = srgb ? parseInt(srgb, 16) : sys?.attr('lastClr') ? parseInt(sys.attr('lastClr'), 16) : sys?.attr('val') === 'windowText' ? 0 : sys?.attr('val') === 'window' ? 0xFFFFFF : NaN;
    if (Number.isFinite(v)) t.colors[i] = v & 0xFFFFFF;
  }
  if (cs?.attr('name')) t.name = cs.attr('name');
  const fs = el.child('fontScheme');
  const face = (f, k) => fs?.path([f, k])?.attr('typeface') || null;
  if (face('majorFont', 'latin')) t.majorFont = face('majorFont', 'latin');
  if (face('minorFont', 'latin')) t.minorFont = face('minorFont', 'latin');
  return t;
}

const hex6 = v => `#${(v & 0xFFFFFF).toString(16).padStart(6, '0').toUpperCase()}`;
/** styles.rs `read_color`: '#RRGGBB', {theme, tint} or null (Automatic). */
export function readColor(e, palette) {
  if (!e) return null;
  if (e.flag('auto', false)) return null;
  const rgb = e.attr('rgb');
  if (rgb) { const h = rgb.trim().replace(/^#/, ''); return /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h) ? `#${h.slice(-6).toUpperCase()}` : null; }
  const th = e.num('theme');
  if (th !== undefined) {
    if (th > 11 || th < 0 || !Number.isInteger(th)) return null;
    const tint = e.num('tint');
    const t = tint === undefined ? 0 : Math.max(-1000, Math.min(1000, Math.round(tint * 1000))) / 1000;
    return t ? {theme: th, tint: t} : {theme: th};
  }
  const ix = e.num('indexed');
  if (ix !== undefined) { const c = palette[ix]; return c === undefined ? null : hex6(c); }
  return null;
}
const boolProp = (e, name) => { const c = e.child(name); return !!c && c.flag('val', true); };

export function readFont(e, palette) {
  const f = {};
  const name = (e.child('name') ?? e.child('rFont'))?.attr('val');
  if (name) f.name = name;
  const sz = e.child('sz')?.num('val');
  if (sz !== undefined) f.size = Math.min(409, Math.max(1, sz));
  if (boolProp(e, 'b')) f.bold = true;
  if (boolProp(e, 'i')) f.italic = true;
  if (boolProp(e, 'strike')) f.strike = true;
  const u = e.child('u');
  if (u) {
    const v = u.attr('val') ?? 'single';
    f.underline = {double: 'double', singleAccounting: 'singleAccounting', doubleAccounting: 'doubleAccounting', none: 'none'}[v] ?? 'single';
  }
  const va = e.childVal('vertAlign');
  if (va === 'superscript' || va === 'subscript') f.vert = va;
  let color = readColor(e.child('color'), palette);
  // Text 1 (dk1) is what "automatic" font colour means in practice.
  if (color && typeof color === 'object' && color.theme === 1 && !color.tint) color = null;
  if (color) f.color = color;
  return f;
}

const PATTERNS = {solid: 'solid', mediumGray: 'mediumGray', darkGray: 'darkGray', lightGray: 'lightGray', gray125: 'gray125', gray0625: 'gray0625',
  darkHorizontal: 'darkHorizontal', darkVertical: 'darkVertical', darkDown: 'darkDown', darkUp: 'darkUp', darkGrid: 'darkGrid', darkTrellis: 'darkTrellis',
  lightHorizontal: 'lightHorizontal', lightVertical: 'lightVertical', lightDown: 'lightDown', lightUp: 'lightUp', lightGrid: 'lightGrid', lightTrellis: 'lightTrellis'};
/** styles.rs `read_fill`: in differential formats a solid fill's colour is the background colour. */
export function readFill(e, palette, dxf = false) {
  const p = e.child('patternFill');
  if (p) {
    const fg = readColor(p.child('fgColor'), palette), bg = readColor(p.child('bgColor'), palette);
    const pt = p.attr('patternType');
    if (dxf && (pt === undefined || pt === 'solid')) {
      const c = bg ?? fg;
      if (!c && pt === undefined) return null;
      return {pattern: 'solid', fg: c};
    }
    const pattern = PATTERNS[pt ?? 'none'];
    if (!pattern) return null;
    return {pattern, ...(fg ? {fg} : {}), ...(bg ? {bg} : {})};
  }
  const g = e.child('gradientFill');
  const c = g?.kids('stop')[0]?.child('color');
  if (c) return {pattern: 'solid', fg: readColor(c, palette)};
  return null;
}

const BORDER_STYLES = new Set(['thin', 'medium', 'thick', 'dashed', 'dotted', 'double', 'hair', 'mediumDashed', 'dashDot', 'mediumDashDot', 'dashDotDot', 'mediumDashDotDot', 'slantDashDot']);
function readLine(e, palette) {
  if (!e) return null;
  const style = e.attr('style');
  if (!BORDER_STYLES.has(style)) return null;
  const color = readColor(e.child('color'), palette);
  return color ? {style, color} : {style};
}
export function readBorder(e, palette) {
  const diag = readLine(e.child('diagonal'), palette);
  const b = {};
  const set = (k, v) => { if (v) b[k] = v; };
  set('left', readLine(e.child('left') ?? e.child('start'), palette));
  set('right', readLine(e.child('right') ?? e.child('end'), palette));
  set('top', readLine(e.child('top'), palette));
  set('bottom', readLine(e.child('bottom'), palette));
  if (e.flag('diagonalDown', false)) set('diagDown', diag);
  if (e.flag('diagonalUp', false)) set('diagUp', diag);
  return b;
}
const H_ALIGN = {left: 'left', center: 'center', right: 'right', fill: 'fill', justify: 'justify', centerContinuous: 'centerAcross', distributed: 'distributed'};
const V_ALIGN = {top: 'top', center: 'center', justify: 'justify', distributed: 'distributed'};
export function readAlignment(a) {
  const al = {};
  const h = H_ALIGN[a.attr('horizontal')];
  if (h) al.h = h;
  const v = V_ALIGN[a.attr('vertical')];
  if (v) al.v = v;
  if (a.flag('wrapText', false)) al.wrap = true;
  if (a.flag('shrinkToFit', false)) al.shrink = true;
  const ind = a.num('indent');
  if (ind) al.indent = Math.min(250, Math.max(0, Math.trunc(ind)));
  const r = a.num('textRotation');
  if (r !== undefined) {
    const rot = r >= 0 && r <= 90 ? r : r >= 91 && r <= 180 ? -(r - 90) : r === 255 ? 255 : 0;
    if (rot) al.rotation = rot;
  }
  return al;
}
const numFmtCode = (id, custom) => custom.get(id) ?? BUILTIN_FORMATS.get(id) ?? 'General';

function readXf(xf, fonts, fills, borders, fmts) {
  const s = {};
  const fi = xf.num('fontId');
  const font = (fi !== undefined ? fonts[fi] : undefined) ?? fonts[0];
  if (font && Object.keys(font).length) s.font = font;
  const fill = fills[xf.num('fillId') ?? -1];
  if (fill) s.fill = fill;
  const b = borders[xf.num('borderId') ?? -1];
  if (b && Object.keys(b).length) s.borders = b;
  const code = numFmtCode(xf.num('numFmtId') ?? 0, fmts);
  if (code !== 'General') s.numFmt = code;
  const a = xf.child('alignment');
  if (a) { const al = readAlignment(a); if (Object.keys(al).length) s.align = al; }
  const p = xf.child('protection');
  if (p) {
    const pr = {};
    if (!p.flag('locked', true)) pr.locked = false;
    if (p.flag('hidden', false)) pr.hidden = true;
    if (Object.keys(pr).length) s.protection = pr;
  }
  return s;
}

/** styles.rs `read_dxf`: the parts a differential format sets. */
function readDxf(x, palette, fmts) {
  const s = {};
  const f = x.child('font');
  if (f) { const font = readFont(f, palette); delete font.size; if (Object.keys(font).length) s.font = font; }
  const fl = x.child('fill');
  if (fl) { const fill = readFill(fl, palette, true); if (fill) s.fill = fill; }
  const b = x.child('border');
  if (b) { const bd = readBorder(b, palette); if (Object.keys(bd).length) s.borders = bd; }
  const n = x.child('numFmt');
  if (n?.attr('formatCode')) s.numFmt = n.attr('formatCode');
  else if (n?.num('numFmtId') !== undefined) s.numFmt = numFmtCode(n.num('numFmtId'), fmts);
  const a = x.child('alignment');
  if (a) { const al = readAlignment(a); if (Object.keys(al).length) s.align = al; }
  return s;
}

/** styles.rs `read_styles`: {xfs (sparse), dxfs, palette, numFmts}. */
export function readStyles(root) {
  let palette = [...INDEXED];
  const ix = root.path(['colors', 'indexedColors']);
  if (ix) {
    const custom = ix.kids('rgbColor').map(c => { const h = (c.attr('rgb') ?? '').replace(/^#/, ''); return /^[0-9a-f]{6,8}$/i.test(h) ? parseInt(h.slice(-6), 16) : 0; });
    if (custom.length) palette = custom;
  }
  const fmts = new Map();
  for (const f of root.child('numFmts')?.kids('numFmt') ?? []) {
    const id = f.num('numFmtId'), code = f.attr('formatCode');
    if (id !== undefined && code !== undefined) fmts.set(id, code);
  }
  const fonts = (root.child('fonts')?.kids('font') ?? []).map(e => readFont(e, palette));
  const fills = (root.child('fills')?.kids('fill') ?? []).map(e => readFill(e, palette, false));
  const borders = (root.child('borders')?.kids('border') ?? []).map(e => readBorder(e, palette));
  const xfs = (root.child('cellXfs')?.kids('xf') ?? []).map(xf => readXf(xf, fonts, fills, borders, fmts));
  const dxfs = (root.child('dxfs')?.kids('dxf') ?? []).map(x => readDxf(x, palette, fmts));
  return {xfs, dxfs, palette, numFmts: fmts};
}

// ---------------------------------------------------------------------------------------------
// sheet_read.rs helpers

/** `2024-03-15`, `2024-03-15T10:30:00Z`, `10:30:00` → serial. */
export function parseIsoDatetime(s, sys) {
  const t = String(s).trim().replace(/Z$/, '');
  let date = '', time = null;
  const i = t.indexOf('T');
  if (i >= 0) { date = t.slice(0, i); time = t.slice(i + 1); } else if (t.includes(':')) time = t; else date = t;
  let serial = 0;
  if (date) {
    const m = /^(-?\d+)-(\d+)-(\d+)$/.exec(date);
    if (!m) return null;
    const v = serialFromYmd(sys, Number(m[1]), Number(m[2]), Number(m[3]));
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    serial = v;
  }
  if (time) {
    const m = /^(\d+):(\d+)(?::(\d+(?:\.\d+)?))?$/.exec(time);
    if (!m) return null;
    serial += (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)) / 86400;
  }
  return serial;
}
/** A space-separated range list (`A1:B2 D4`). */
export const parseSqref = s => String(s ?? '').split(/\s+/).filter(Boolean).map(x => parseRange(x.replace(/\$/g, ''))).filter(Boolean);

const MAX_HYPERLINK_CELLS = 10_000;
const MAX_DYNAMIC_RANGES = 65_536;

// ---------------------------------------------------------------------------------------------
// Package

class Package {
  constructor(zip) { this.zip = zip; this.budget = new ZipBudget(); }
  static async open(bytes) {
    const zip = await JSZip.loadAsync(bytes);
    const files = Object.values(zip.files);
    if (files.length > 10_000) throw new Error('The workbook has too many parts.');
    return new Package(zip);
  }
  file(name) { return this.zip.file(name.replace(/^\//, '')); }
  /** Inflate an entry within the per-part and whole-workbook caps (the header's declared size is not trusted). */
  async bytes(file) {
    try { return await this.budget.bytes(file); } catch (e) { if (e?.code === 'zip_limit') throw new Error('The workbook is too large to open.'); throw e; }
  }
  async text(name) { const f = this.file(name); return f ? new TextDecoder('utf-8', {ignoreBOM: true}).decode(await this.bytes(f)) : null; }
  async xml(name) { const t = await this.text(name); return t === null ? null : parseXml(t); }
  /** Relationships of a part: [{id, type (last path segment), target (resolved), external}]. */
  async rels(part) {
    const dir = part.includes('/') ? part.slice(0, part.lastIndexOf('/')) : '';
    const base = part.slice(part.lastIndexOf('/') + 1);
    const x = await this.xml(dir ? `${dir}/_rels/${base}.rels` : `_rels/${base}.rels`);
    if (!x) return [];
    return x.kids('Relationship').map(r => {
      const external = r.attr('TargetMode') === 'External';
      const type = String(r.attr('Type') ?? '').split('/').pop();
      const target = external ? r.attr('Target') : resolvePath(dir, r.attr('Target') ?? '');
      return {id: r.attr('Id'), type, target, external};
    });
  }
}
function resolvePath(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (dir ? dir.split('/') : []);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}
const findRel = (rels, type) => rels.find(r => r.type === type);

// ---------------------------------------------------------------------------------------------
// read.rs `read_xlsx`

let uidCounter = 0;
const newId = () => `x${Date.now().toString(36).slice(-4)}${(uidCounter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** read.rs `unique_name`: a valid, unused sheet name. */
function uniqueName(content, name, i) {
  let n = String(name ?? '').slice(0, 31);
  if (checkSheetName(content, n)) n = `Sheet${i + 1}`;
  let k = 2;
  const base = n;
  while (content.sheets.some(s => s.name.toLowerCase() === n.toLowerCase())) n = `${base.slice(0, 27)} (${k++})`;
  return n;
}

/** The workbook in `bytes` as schema-2 content; `report.warnings` lists what could not be kept. */
export async function readXlsx(bytes, {report = {warnings: []}} = {}) {
  const warn = m => { if (!report.warnings.includes(m)) report.warnings.push(m); };
  const pkg = await Package.open(bytes);
  const rootRels = await pkg.rels('');
  const wbPart = findRel(rootRels, 'officeDocument')?.target ?? 'xl/workbook.xml';
  const wbXml = await pkg.xml(wbPart);
  if (!wbXml) throw new Error('This is not an Excel workbook (xl/workbook.xml is missing).');
  const wbRels = await pkg.rels(wbPart);

  const content = {sheets: [], activeSheetId: null, styles: [{}], names: []};
  // Theme, then styles.
  const themeRel = findRel(wbRels, 'theme');
  const themeXml = themeRel ? await pkg.xml(themeRel.target) : null;
  const theme = themeXml ? readTheme(themeXml) : null;
  if (theme) content.theme = theme;
  const personRel = findRel(wbRels, 'person');
  const persons = personRel ? readPersons(await pkg.xml(personRel.target)) : new Map();
  let objectId = 0;
  const cx = {xfMap: [0], dxfs: [], palette: [...INDEXED], sst: [], dateSystem: 1900, warn, styles: content.styles, nextObjectId: () => ++objectId, persons};
  cx.caches = new CachesIn(wbXml, wbRels);
  const stylesRel = findRel(wbRels, 'styles');
  const stylesXml = stylesRel ? await pkg.xml(stylesRel.target) : null;
  if (stylesXml) {
    const st = readStyles(stylesXml);
    cx.palette = st.palette;
    cx.numFmts = st.numFmts;
    cx.dxfs = st.dxfs;
    const keys = new Map();
    // Cell format 0 is the Normal cell format: what a cell without its own format shows.
    const normal = sparseStyle(resolveStyle(st.xfs[0] ?? {}));
    content.styles[0] = normal;
    keys.set(styleKey(normal), 0);
    cx.xfMap = st.xfs.map((s, i) => {
      if (i === 0) return 0;
      const sp = sparseStyle(resolveStyle(s));
      const k = styleKey(sp);
      let id = keys.get(k);
      if (id === undefined) { id = content.styles.length; content.styles.push(sp); keys.set(k, id); }
      return id;
    });
  } else warn('no styles part');
  // Shared strings.
  const sstRel = findRel(wbRels, 'sharedStrings');
  if (sstRel) {
    const x = await pkg.xml(sstRel.target);
    if (x) cx.sst = x.kids('si').map(richText);
    else warn(`missing part ${sstRel.target}`);
  }
  // workbookPr, calcPr.
  const pr = wbXml.child('workbookPr');
  if (pr?.flag('date1904', false)) { cx.dateSystem = 1904; content.dateSystem = 1904; }
  // workbookProtection: Protect Workbook (structure), with its password.
  const wp = wbXml.child('workbookProtection');
  if (wp && wp.flag('lockStructure', false)) {
    const prot = {structure: true};
    const pw = {};
    for (const [k, attr] of [['algorithmName', 'workbookAlgorithmName'], ['hashValue', 'workbookHashValue'], ['saltValue', 'workbookSaltValue'], ['spinCount', 'workbookSpinCount']]) if (wp.attr(attr) !== undefined) pw[k] = k === 'spinCount' ? Number(wp.attr(attr)) : wp.attr(attr);
    if (wp.attr('workbookPassword') !== undefined) pw.password = wp.attr('workbookPassword');
    if (Object.keys(pw).length) prot.password = pw;
    content.protection = prot;
  }
  const calc = wbXml.child('calcPr');
  if (calc) {
    const c = {};
    const mode = calc.attr('calcMode');
    if (mode === 'manual') c.mode = 'manual'; else if (mode === 'autoNoTable') c.mode = 'autoNoTables';
    if (calc.flag('iterate', false)) c.iterative = true;
    const n = calc.num('iterateCount');
    if (n !== undefined) c.maxIterations = Math.min(32767, Math.max(1, Math.trunc(n)));
    const d = calc.num('iterateDelta');
    if (d !== undefined) c.maxChange = Math.abs(d);
    if (Object.keys(c).length) content.calc = c;
  }
  const activeTab = wbXml.path(['bookViews', 'workbookView'])?.num('activeTab') ?? 0;

  // Sheets.
  const fileToModel = [];
  const sheetEls = wbXml.child('sheets')?.kids('sheet') ?? [];
  for (let i = 0; i < sheetEls.length; i++) {
    const se = sheetEls[i];
    const rel = wbRels.find(r => r.id === (se.attr('r:id') ?? se.attr('id')));
    if (!rel) { warn(`sheet "${se.attr('name')}" has no part; skipped`); fileToModel.push(null); continue; }
    if (rel.type !== 'worksheet') {
      warn(`sheet "${se.attr('name')}" is a ${rel.type} and was skipped`);
      fileToModel.push(null);
      continue;
    }
    const name = uniqueName(content, se.attr('name'), i);
    let sheet;
    try { sheet = await readSheet(pkg, cx, rel.target, name); } catch (e) {
      if (/too large/i.test(String(e?.message))) throw e;
      warn(`sheet "${name}" could not be read: ${e?.message ?? e}`);
      sheet = {id: newId(), name, blocks: {}};
    }
    const state = se.attr('state');
    if (state === 'hidden' || state === 'veryHidden') sheet.hidden = state;
    fileToModel.push(content.sheets.length);
    content.sheets.push(sheet);
  }
  await resolveSlicers(pkg, cx, wbRels);
  if (!content.sheets.length) {
    warn('the workbook has no worksheets; added an empty sheet');
    content.sheets.push({id: newId(), name: 'Sheet1', blocks: {}});
  }
  content.activeSheetId = content.sheets[fileToModel[activeTab] ?? 0]?.id ?? content.sheets[0].id;
  if (content.sheets.find(s => s.id === content.activeSheetId)?.hidden) content.activeSheetId = content.sheets.find(s => !s.hidden)?.id ?? content.activeSheetId;

  // Defined names.
  const seen = new Set();
  for (const d of wbXml.child('definedNames')?.kids('definedName') ?? []) {
    const name = d.attr('name');
    if (!name) continue;
    const local = d.num('localSheetId');
    let scope = null;
    if (local !== undefined) { const m = fileToModel[local]; if (m === null || m === undefined) continue; scope = content.sheets[m].id; }
    const text = d.text.trim();
    const lname = name.toLowerCase();
    if (lname === '_xlnm._filterdatabase' || lname.startsWith('_xlchart.') || ((lname.startsWith('slicer_') || lname.startsWith('nativetimeline_')) && text === '#N/A')) continue;
    if (lname === '_xlnm.print_area' || lname === '_xlnm.print_titles') {
      const sh = content.sheets.find(s => s.id === scope);
      if (sh && lname === '_xlnm.print_area') sh.printArea = text.split(',').map(x => x.slice(x.lastIndexOf('!') + 1).replace(/\$/g, '')).join(',');
      if (sh && lname === '_xlnm.print_titles') sh.printTitles = text;
      continue;
    }
    if (!/^[\p{L}_\\][\p{L}\p{N}_.\\?]{0,254}$/u.test(name)) { warn(`the name "${name}" is not valid here and was left out`); continue; }
    const k = `${scope ?? ''}:${lname}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const n = {name, formula: fromFile(text)};
    if (scope) n.scope = scope;
    if (d.attr('comment')) n.comment = d.attr('comment');
    if (d.flag('hidden', false)) n.hidden = true;
    content.names.push(n);
  }
  // Document properties.
  const core = findRel(rootRels, 'core-properties');
  const props = {};
  if (core) {
    const x = await pkg.xml(core.target);
    for (const [k, tag] of [['title', 'title'], ['subject', 'subject'], ['author', 'creator'], ['keywords', 'keywords'], ['description', 'description']]) {
      const t = x?.child(tag)?.text;
      if (t) props[k] = t;
    }
  }
  const app = findRel(rootRels, 'extended-properties');
  if (app) { const x = await pkg.xml(app.target); const c = x?.child('Company')?.text; if (c) props.company = c; }
  if (Object.keys(props).length) content.properties = props;
  if (findRel(wbRels, 'vbaProject')) warn('macros (VBA project) are not kept: Arkemis never runs macros');
  return content;
}

// ---------------------------------------------------------------------------------------------
// sheet_read.rs `read_sheet`

async function readSheet(pkg, cx, part, name) {
  const root = await pkg.xml(part);
  if (!root) throw new Error(`missing part ${part}`);
  const rels = await pkg.rels(part);
  const sheet = {id: newId(), name, blocks: {}};
  const style = s => (s === undefined ? 0 : cx.xfMap[s] ?? 0);
  // sheetFormatPr first: rows and columns compare against the sheet's defaults.
  const fmt = root.child('sheetFormatPr');
  if (fmt) {
    const w = fmt.num('defaultColWidth') ?? (fmt.num('baseColWidth') !== undefined ? fmt.num('baseColWidth') + 5 / 7 : undefined);
    if (w !== undefined) { const px = colWidthToPx(w); if (px > 0 && px !== 64) sheet.defaultColWidth = px; }
    const h = fmt.num('defaultRowHeight');
    if (h !== undefined && fmt.flag('customHeight', false)) { const px = ptToPx(h); if (px > 0 && Math.abs(px - 20) > 0.01) sheet.defaultRowHeight = px; }
  }
  const defaultRowPx = sheet.defaultRowHeight ?? 20, defaultColPx = sheet.defaultColWidth ?? 64;
  let fitToPage = false;
  for (const e of root.children) {
    switch (e.name) {
      case 'sheetPr': {
        const t = readColor(e.child('tabColor'), cx.palette);
        if (t) sheet.tabColor = typeof t === 'string' ? t : themeHex(cx, t);
        fitToPage = e.child('pageSetUpPr')?.flag('fitToPage', false) === true;
        const o = e.child('outlinePr');
        if (o) { if (!o.flag('summaryBelow', true)) sheet.summaryBelow = false; if (!o.flag('summaryRight', true)) sheet.summaryRight = false; }
        break;
      }
      case 'sheetViews': readViews(e, sheet); break;
      case 'cols': {
        const cols = {};
        for (const c of e.kids('col')) {
          const min = c.num('min'), max0 = c.num('max');
          if (!min || min > MAX_COLS || max0 === undefined || max0 < min) continue;
          const max = Math.min(max0, MAX_COLS);
          const info = {};
          const w = c.num('width');
          if (w !== undefined) {
            const px = colWidthToPx(w);
            if (c.flag('customWidth', false) || px !== defaultColPx) info.size = px;
          }
          if (c.flag('hidden', false)) info.hidden = true;
          const ol = Math.min(7, c.num('outlineLevel') ?? 0);
          if (ol) info.outline = ol;
          if (c.flag('collapsed', false)) info.collapsed = true;
          const s = c.num('style');
          if (s !== undefined && style(s)) info.s = style(s);
          if (!Object.keys(info).length) continue;
          if (max - min > 16_383 && Object.keys(info).length === 1 && info.s) { /* whole-sheet column style: kept per column */ }
          for (let col = min - 1; col < max; col++) cols[col] = info;
        }
        if (Object.keys(cols).length) sheet.cols = cols;
        break;
      }
      case 'sheetData': readSheetData(cx, e, sheet, style, defaultRowPx); break;
      case 'mergeCells': {
        const ms = e.kids('mergeCell').map(m => parseRange(String(m.attr('ref') ?? '').replace(/\$/g, ''))).filter(r => r && !(r.start.row === r.end.row && r.start.col === r.end.col));
        const kept = [];
        for (const r of ms) if (!kept.some(k => r.start.row <= k.end.row && k.start.row <= r.end.row && r.start.col <= k.end.col && k.start.col <= r.end.col)) kept.push(r);
        if (kept.length) sheet.merges = kept.map(rangeA1);
        break;
      }
      case 'conditionalFormatting': readCf(cx, e, sheet); break;
      case 'dataValidations': {
        const list = e.kids('dataValidation').map(v => readValidation(v)).filter(Boolean);
        if (list.length) sheet.validations = [...(sheet.validations ?? []), ...list];
        break;
      }
      case 'hyperlinks': readHyperlinks(cx, e, rels, sheet); break;
      case 'ignoredErrors': {
        const cells = [];
        for (const ie of e.kids('ignoredError')) if (ie.flag('evalError', false)) for (const part of String(ie.attr('sqref') ?? '').split(/\s+/)) { const r = parseRange(part.replace(/\$/g, '')); if (r) for (let row = r.start.row; row <= Math.min(r.end.row, r.start.row + 200); row++) for (let col = r.start.col; col <= Math.min(r.end.col, r.start.col + 50); col++) cells.push(a1(row, col)); }
        if (cells.length) sheet.ignoredErrors = [...new Set(cells)].slice(0, 2000);
        break;
      }
      case 'cellWatches': { const w = e.kids('cellWatch').map(c => String(c.attr('r') ?? '').replace(/$/g, '')).filter(r => /^[A-Za-z]{1,3}[0-9]+$/.test(r)); if (w.length) sheet.watches = w.slice(0, 500); break; }
      case 'autoFilter': { const af = readAutofilter(e, cx.dxfs); if (af) sheet.autofilter = af; break; }
      case 'sheetProtection':
        if (e.flag('sheet', false)) sheet.protection = readProtection(e);
        break;
      case 'protectedRanges': {
        // Allow Edit Ranges: a title, the cells (sqref, space separated) and an optional password.
        const list = [];
        for (const r of e.kids('protectedRange')) {
          const ranges = String(r.attr('sqref') ?? '').split(/\s+/).map(x => x.replace(/\$/g, '')).filter(x => parseRange(x));
          const title = r.attr('name');
          if (!ranges.length || !title) continue;
          const entry = {title, ranges};
          const pw = {};
          for (const k of ['algorithmName', 'hashValue', 'saltValue', 'spinCount']) if (r.attr(k) !== undefined) pw[k] = k === 'spinCount' ? Number(r.attr(k)) : r.attr(k);
          if (r.attr('password') !== undefined) pw.password = r.attr('password');
          if (Object.keys(pw).length) entry.password = pw;
          list.push(entry);
        }
        if (list.length) sheet.editRanges = list;
        break;
      }
      case 'printOptions': case 'pageMargins': case 'pageSetup': case 'headerFooter': case 'rowBreaks': case 'colBreaks': readPageSetupElement(e, sheet, fitToPage); break;
      case 'extLst': readSparklines(e, sheet); break;
      case 'tableParts':
        for (const tp of e.kids('tablePart')) {
          const rel = rels.find(r => r.id === (tp.attr('r:id') ?? tp.attr('id')));
          if (!rel) continue;
          const x = await pkg.xml(rel.target);
          const t = x && readTable(x);
          if (t) (sheet.tables ??= []).push(t);
          if (t && x.num('id') !== undefined) (cx.tableIds ??= new Map()).set(x.num('id'), {sheet, name: t.name, columns: t.columns});
          // A table's filter criteria are the sheet's AutoFilter over the table (U:grid/data).
          const taf = t && x.child('autoFilter') ? readAutofilter(x.child('autoFilter'), cx.dxfs) : null;
          if (taf?.criteria && !sheet.autofilter) sheet.autofilter = taf;
        }
        break;
      default: break;
    }
  }
  for (const rel of rels.filter(r => r.type === 'comments')) {
    const x = await pkg.xml(rel.target);
    if (x) readComments(x, sheet);
  }
  for (const rel of rels.filter(r => r.type === 'drawing')) await readDrawing(pkg, cx, rel.target, sheet);
  for (const rel of rels.filter(r => r.type === 'threadedComment')) { const tx = await pkg.xml(rel.target); if (tx) readThreaded(tx, cx.persons, sheet); }
  const pivots = await readPivots(pkg, cx, cx.caches, part, name, rels);
  if (pivots.length) sheet.pivots = pivots;
  await readSheetSlicers(pkg, cx, rels, sheet);
  return sheet;
}

function themeHex(cx, c) {
  const base = DEFAULT_THEME.colors[c.theme] ?? 0;
  return hex6(base);
}

function readViews(e, sheet) {
  const v = e.child('sheetView');
  if (!v) return;
  if (!v.flag('showGridLines', true)) sheet.showGridlines = false;
  if (!v.flag('showRowColHeaders', true)) sheet.showHeadings = false;
  if (v.flag('showFormulas', false)) sheet.showFormulas = true;
  if (!v.flag('showZeros', true)) sheet.showZeros = false;
  if (v.flag('rightToLeft', false)) sheet.rightToLeft = true;
  const mode = v.attr('view');
  if (mode === 'pageBreakPreview' || mode === 'pageLayout') sheet.view = mode;
  const z = v.num('zoomScale');
  if (z !== undefined && z !== 100) sheet.zoom = Math.min(400, Math.max(10, Math.trunc(z)));
  const top = parseCell(String(v.attr('topLeftCell') ?? '').replace(/\$/g, ''));
  if (top && (top.row || top.col)) sheet.topLeft = a1(top.row, top.col);
  const p = v.child('pane');
  let activePane = null;
  if (p) {
    const state = p.attr('state');
    if (state === 'frozen' || state === 'frozenSplit') {
      const cols = Math.min(MAX_COLS - 1, Math.max(0, Math.trunc(p.num('xSplit') ?? 0)));
      const rows = Math.min(MAX_ROWS - 1, Math.max(0, Math.trunc(p.num('ySplit') ?? 0)));
      if (rows > 0 || cols > 0) {
        sheet.freeze = {rows, cols};
        const tl = parseCell(String(p.attr('topLeftCell') ?? '').replace(/\$/g, ''));
        if (tl) sheet.topLeft = a1(tl.row, tl.col);
      }
    }
    activePane = p.attr('activePane') ?? null;
  }
  const sels = v.kids('selection');
  const sel = sels.find(s => (s.attr('pane') ?? null) === activePane) ?? sels[sels.length - 1];
  const ac = parseCell(String(sel?.attr('activeCell') ?? '').replace(/\$/g, ''));
  if (ac) sheet.activeCell = a1(ac.row, ac.col);
}

function readSheetData(cx, sheetData, sheet, style, defaultRowPx) {
  const shared = new Map();
  const dynamic = [];
  const rows = {};
  let nextRow = 0, dropped = 0;
  const put = (row, col, cell) => { (sheet.blocks[blockOf(row)] ??= {})[a1(row, col)] = cell; };
  const inDynamic = (row, col) => dynamic.some(r => row >= r.start.row && row <= r.end.row && col >= r.start.col && col <= r.end.col && !(r.start.row === row && r.start.col === col));
  for (const rowEl of sheetData.kids('row')) {
    const rAttr = rowEl.num('r');
    const r = rAttr !== undefined ? rAttr - 1 : nextRow;
    if (rAttr !== undefined && rAttr < 1) { dropped++; continue; }
    if (r >= MAX_ROWS) { dropped++; continue; }
    nextRow = r + 1;
    const info = {};
    const ht = rowEl.num('ht');
    if (ht !== undefined) {
      const custom = rowEl.flag('customHeight', false);
      if (custom || Math.abs(ptToPx(ht) - defaultRowPx) > 0.5) { info.size = ptToPx(ht); if (custom) info.custom = true; }
    }
    if (rowEl.flag('hidden', false)) info.hidden = true;
    const ol = Math.min(7, rowEl.num('outlineLevel') ?? 0);
    if (ol) info.outline = ol;
    if (rowEl.flag('collapsed', false)) info.collapsed = true;
    if (rowEl.flag('customFormat', false) && rowEl.num('s') !== undefined && style(rowEl.num('s'))) info.s = style(rowEl.num('s'));
    if (Object.keys(info).length) rows[r] = info;
    let nextCol = 0;
    for (const c of rowEl.kids('c')) {
      let pos;
      const ref = c.attr('r');
      if (ref !== undefined) { pos = parseCell(ref.trim().replace(/\$/g, '')); if (!pos) { dropped++; continue; } } else pos = {row: r, col: nextCol};
      if (pos.col >= MAX_COLS || pos.row >= MAX_ROWS) { dropped++; continue; }
      nextCol = pos.col + 1;
      const cell = readCell(cx, c, pos, shared, dynamic);
      const s = style(c.num('s'));
      const isDyn = cell.f === undefined && inDynamic(pos.row, pos.col);
      if (isDyn) delete cell.v;
      if (s) cell.s = s;
      if (cell.v === undefined && cell.f === undefined && !cell.s) continue;
      put(pos.row, pos.col, cell);
    }
  }
  if (Object.keys(rows).length) sheet.rows = rows;
  if (dropped) cx.warn(`sheet "${sheet.name}": ${dropped} cells or rows outside the 1,048,576 × 16,384 grid were dropped`);
}

function readCell(cx, c, pos, shared, dynamic) {
  const vEl = c.child('v');
  const v = vEl ? vEl.text : undefined;
  let value;
  switch (c.attr('t') ?? 'n') {
    case 's': {
      const i = v === undefined ? NaN : Number(v.trim());
      if (Number.isInteger(i)) { value = cx.sst[i]; if (value === undefined) cx.warn('some cells refer to missing shared strings'); }
      break;
    }
    case 'str': if (v !== undefined) value = decodeXString(v); break;
    case 'inlineStr': { const is = c.child('is'); value = is ? richText(is) : v !== undefined ? decodeXString(v) : undefined; break; }
    case 'b': if (v !== undefined) value = ['1', 'true', 'TRUE'].includes(v.trim()); break;
    case 'e': if (v !== undefined) value = {e: (parseError(v.trim()) ?? parseError('#VALUE!')).text}; break;
    case 'd': if (v !== undefined) { const n = parseIsoDatetime(v, cx.dateSystem); if (n === null) { if (v.trim()) cx.warn('some date cells could not be read'); } else value = n; } break;
    default: {
      const t = v?.trim();
      if (t) { const n = Number(t); if (Number.isFinite(n)) value = n === 0 ? 0 : n; else cx.warn('some numeric cells could not be read'); }
    }
  }
  const cell = {};
  if (value !== undefined && value !== null && value !== '') cell.v = value;
  else if (value === '') cell.v = '';
  const fEl = c.child('f');
  if (fEl) {
    const dyn = c.attr('cm') !== undefined;
    const f = readFormula(cx, fEl, pos, dyn, shared, dynamic);
    if (f) {
      cell.f = f.text;
      if (f.array) cell.a = f.array;
      if (dyn) cell.d = true;
      // Values of formulas are calculated, not stored.
      delete cell.v;
    }
  }
  if (cell.v === '' ) delete cell.v;
  return cell;
}

function readFormula(cx, f, pos, dyn, shared, dynamic) {
  const text = fromFile(f.text.trim());
  switch (f.attr('t') ?? 'normal') {
    case 'shared': {
      const si = f.num('si');
      if (si === undefined) return null;
      if (text) {
        let expr = null;
        try { expr = parse(text); } catch { expr = null; }
        shared.set(si, {anchor: pos, expr, text});
        return {text};
      }
      const sh = shared.get(si);
      if (!sh) { cx.warn('a shared formula refers to a missing master cell; kept the cached value'); return null; }
      if (!sh.expr) return {text: sh.text};
      return {text: print(shiftRelative(sh.expr, pos.row - sh.anchor.row, pos.col - sh.anchor.col))};
    }
    case 'array': {
      if (!text) return null;
      const range = parseRange(String(f.attr('ref') ?? '').replace(/\$/g, '')) ?? {start: pos, end: pos};
      const single = range.start.row === range.end.row && range.start.col === range.end.col;
      if (!single && dynamic.length < MAX_DYNAMIC_RANGES) dynamic.push(range);
      return dyn ? {text} : {text, array: rangeA1(range)};
    }
    case 'dataTable':
      cx.warn('what-if data tables are not supported; kept their values');
      return null;
    default: return text ? {text} : null;
  }
}

function readProtection(e) {
  const p = {enabled: true};
  const pw = {};
  for (const k of ['algorithmName', 'hashValue', 'saltValue', 'spinCount', 'password']) if (e.attr(k) !== undefined) pw[k] = e.attr(k);
  if (Object.keys(pw).length) p.password = pw;
  // sheetProtection attributes say what is protected: an allowed action is one not protected.
  p.selectLocked = !e.flag('selectLockedCells', false);
  p.selectUnlocked = !e.flag('selectUnlockedCells', false);
  for (const [k, attr] of [['formatCells', 'formatCells'], ['formatColumns', 'formatColumns'], ['formatRows', 'formatRows'], ['insertColumns', 'insertColumns'],
    ['insertRows', 'insertRows'], ['insertHyperlinks', 'insertHyperlinks'], ['deleteColumns', 'deleteColumns'], ['deleteRows', 'deleteRows'], ['sort', 'sort'],
    ['autofilter', 'autoFilter'], ['pivotTables', 'pivotTables']]) p[k] = !e.flag(attr, true);
  // Objects and scenarios are protected only when the attribute says so (their default is false).
  p.objects = !e.flag('objects', false);
  p.scenarios = !e.flag('scenarios', false);
  return p;
}

// sheet_read/parts.rs

function readHyperlinks(cx, e, rels, sheet) {
  const out = sheet.hyperlinks ?? {};
  let cells = 0;
  for (const h of e.kids('hyperlink')) {
    const r = parseRange(String(h.attr('ref') ?? '').replace(/\$/g, ''));
    if (!r) continue;
    const link = {};
    const rid = h.attr('r:id') ?? h.attr('id');
    if (rid) { const rel = rels.find(x => x.id === rid); if (rel) link.target = rel.target; }
    if (h.attr('location')) link.location = h.attr('location');
    if (h.attr('tooltip')) link.tooltip = h.attr('tooltip');
    if (h.attr('display')) link.display = h.attr('display');
    if (!link.target && !link.location) continue;
    for (let row = r.start.row; row <= r.end.row; row++) for (let col = r.start.col; col <= r.end.col; col++) {
      if (++cells > MAX_HYPERLINK_CELLS) { cx.warn('more than 10,000 hyperlinked cells; the rest were dropped'); sheet.hyperlinks = out; return; }
      out[a1(row, col)] = link;
    }
  }
  if (Object.keys(out).length) sheet.hyperlinks = out;
}

function readComments(x, sheet) {
  const authors = x.child('authors')?.kids('author').map(a => a.text) ?? [];
  const notes = sheet.notes ?? {};
  for (const c of x.child('commentList')?.kids('comment') ?? []) {
    const p = parseCell(String(c.attr('ref') ?? '').replace(/\$/g, ''));
    if (!p) continue;
    const t = c.child('text');
    let text = t ? richText(t) : '';
    const author = authors[c.num('authorId') ?? -1] ?? '';
    // Excel puts "Author:\n" at the start of a note's text in bold; it is the author, not the note.
    if (author && text.startsWith(`${author}:\n`)) text = text.slice(author.length + 2);
    // A threaded comment's legacy placeholder (authored tc=<id>) is the thread's, read from its own part.
    if (author.startsWith('tc=')) continue;
    notes[a1(p.row, p.col)] = {text, ...(author ? {author} : {})};
  }
  if (Object.keys(notes).length) sheet.notes = notes;
}

const TOTALS = new Set(['sum', 'min', 'max', 'average', 'count', 'countNums', 'stdDev', 'var', 'custom']);
/** parts.rs `read_table`. */
export function readTable(x) {
  const r = parseRange(String(x.attr('ref') ?? '').replace(/\$/g, ''));
  const name = x.attr('displayName') ?? x.attr('name');
  if (!r || !name) return null;
  const t = {name, range: rangeA1(r), headerRow: (x.num('headerRowCount') ?? 1) !== 0, totalsRow: (x.num('totalsRowCount') ?? 0) > 0};
  t.columns = (x.child('tableColumns')?.kids('tableColumn') ?? []).map(c => {
    const col = {name: c.attr('name') ?? ''};
    const fn = c.attr('totalsRowFunction');
    if (fn && TOTALS.has(fn) && fn !== 'none') col.totalsRowFunction = fn;
    if (c.attr('totalsRowLabel')) col.totalsRowLabel = c.attr('totalsRowLabel');
    const cf = c.child('calculatedColumnFormula')?.text;
    if (cf) col.calculatedColumnFormula = fromFile(cf);
    const tf = c.child('totalsRowFormula')?.text;
    if (tf) col.totalsRowFormula = fromFile(tf);
    return col;
  });
  const si = x.child('tableStyleInfo');
  if (si) {
    t.style = {name: si.attr('name') ?? null, showRowStripes: si.flag('showRowStripes', false), showColumnStripes: si.flag('showColumnStripes', false),
      showFirstColumn: si.flag('showFirstColumn', false), showLastColumn: si.flag('showLastColumn', false)};
  }
  t.autoFilter = !!x.child('autoFilter');
  return t;
}

// sheet_read/rules.rs

let ruleIds = 0;
const nextRuleId = () => `r${Date.now().toString(36).slice(-4)}${(ruleIds++).toString(36)}`;
const cfvo = e => ({type: e.attr('type') ?? 'min', ...(e.attr('val') !== undefined ? {val: e.attr('val')} : {}), ...(e.flag('gte', true) ? {} : {gte: false})});

function readCf(cx, e, sheet) {
  const ranges = parseSqref(e.attr('sqref')).map(rangeA1);
  if (!ranges.length) return;
  const list = sheet.conditionalFormats ?? [];
  for (const r of e.kids('cfRule')) {
    // {id, ranges, priority, stopIfTrue?, rule: {type, ...}}: the shape U:grid/format and
    // U:grid/insert keep (design note U-grid-format--U-grid-insert--conditional-formatting).
    const rule = {type: r.attr('type') ?? 'expression'};
    for (const k of ['operator', 'text', 'timePeriod']) if (r.attr(k) !== undefined) rule[k] = r.attr(k);
    for (const k of ['rank', 'stdDev']) if (r.num(k) !== undefined) rule[k] = r.num(k);
    for (const [k, d] of [['percent', false], ['bottom', false], ['aboveAverage', true], ['equalAverage', false]]) if (r.attr(k) !== undefined && r.flag(k, d) !== d) rule[k] = r.flag(k, d);
    const fs = r.kids('formula').map(f => fromFile(f.text));
    if (fs.length) rule.formulas = fs;
    const dxf = r.num('dxfId');
    if (dxf !== undefined && cx.dxfs[dxf]) rule.dxf = cx.dxfs[dxf];
    const cs = r.child('colorScale');
    if (cs) rule.colorScale = {cfvo: cs.kids('cfvo').map(cfvo), colors: cs.kids('color').map(c => readColor(c, cx.palette))};
    const db = r.child('dataBar');
    if (db) rule.dataBar = {cfvo: db.kids('cfvo').map(cfvo), color: readColor(db.child('color'), cx.palette), ...(db.flag('showValue', true) ? {} : {showValue: false})};
    const is = r.child('iconSet');
    if (is) rule.iconSet = {iconSet: is.attr('iconSet') ?? '3TrafficLights1', cfvo: is.kids('cfvo').map(cfvo), ...(is.flag('showValue', true) ? {} : {showValue: false}), ...(is.flag('reverse', false) ? {reverse: true} : {})};
    const entry = {id: nextRuleId(), ranges, priority: r.num('priority') ?? list.length + 1, rule};
    if (r.flag('stopIfTrue', false)) entry.stopIfTrue = true;
    list.push(entry);
  }
  if (list.length) sheet.conditionalFormats = list;
}

function readValidation(v) {
  const ranges = parseSqref(v.attr('sqref')).map(rangeA1);
  if (!ranges.length) return null;
  const rule = {id: nextRuleId(), ranges, type: v.attr('type') ?? 'any'};
  if (v.attr('operator')) rule.operator = v.attr('operator');
  const f1 = v.child('formula1')?.text, f2 = v.child('formula2')?.text;
  if (f1 !== undefined) rule.formula1 = rule.type === 'list' && /^"/.test(f1.trim()) ? f1.trim() : fromFile(f1);
  if (f2 !== undefined) rule.formula2 = fromFile(f2);
  if (v.flag('allowBlank', false)) rule.allowBlank = true;
  // showDropDown="1" means the in-cell dropdown is hidden (the attribute's name is inverted).
  if (v.flag('showDropDown', false)) rule.inCellDropdown = false;
  if (v.flag('showInputMessage', false)) rule.showInputMessage = true;
  if (v.flag('showErrorMessage', false)) rule.showErrorMessage = true;
  for (const k of ['errorStyle', 'errorTitle', 'error', 'promptTitle', 'prompt']) if (v.attr(k) !== undefined) rule[k] = v.attr(k);
  return rule;
}

/** Format module: .xlsx bytes → schema-2 workbook content. */
export async function read(bytes) {
  return readXlsx(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}
