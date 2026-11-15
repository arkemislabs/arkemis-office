// Styles (paragraph, character, table, numbering) with based-on chains, the built-in style set,
// table style parts, latent styles, and style resolution into concrete formatting for layout.
// Translated from wordcraft crates/doc/src/styles.rs and crates/doc/src/resolve.rs at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A style sheet is `{defaultChr, defaultPara, defaultParaPresent, styles: Style[], latentStyles?}`;
// `latentStyles` is the file's `w:latentStyles` XML kept verbatim, as upstream keeps it. A style is
// `{id, name, kind, basedOn, next, linked, para, chr, priority, quick, hidden, builtin, locked?,
// default?, table}` (None = null). Functions return new objects; inputs are never mutated.
// No DOM, no Node built-ins.

import {
  charOverlaid, paraOverlaid, bordersAll, bordersBox, singleBorder, border, bordersOverlaid, borderVisible, bordersAnyVisible,
  shownFont, highlightRgb, DEFAULT_FONT_SIZE, same,
} from './props.mjs';

export const STYLE_KINDS = Object.freeze(['paragraph', 'character', 'table', 'numbering']);
export const HEADING_BLUE = Object.freeze([0x0f, 0x47, 0x61]);
export const BODY_FONT = 'Aptos';
export const HEADING_FONT = 'Aptos Display';

const tc = c => ({Rgb: [...c]});

export function style(fields) {
  return {id: '', name: '', kind: 'paragraph', basedOn: null, next: null, linked: null, para: {}, chr: {}, priority: null,
    quick: false, hidden: false, builtin: false, table: null, ...fields};
}
const pStyle = fields => style({kind: 'paragraph', builtin: true, ...fields});

// --- table style parts ----------------------------------------------------------------------

/** Table style parts, lowest precedence first (ECMA-376 §17.7.6). */
export const TABLE_PARTS = Object.freeze(['wholeTable', 'band1Vert', 'band2Vert', 'band1Horz', 'band2Horz', 'firstCol', 'lastCol', 'firstRow',
  'lastRow', 'neCell', 'nwCell', 'seCell', 'swCell']);
export const tablePartIsRow = p => ['firstRow', 'lastRow', 'band1Horz', 'band2Horz'].includes(p);
export const tablePartIsColumn = p => ['firstCol', 'lastCol', 'band1Vert', 'band2Vert'].includes(p);

/**
 * The table style parts one cell is in (PartSet::of_cell), lowest precedence first: row `ri` of
 * `nrows`, grid column `g` spanning `span` of `ncols`, with options `look` and band sizes.
 */
export function partsOfCell(look, [rowSize, colSize], [ri, nrows], [g, span, ncols]) {
  const header = look.headerRow && ri === 0;
  const total = look.totalRow && ri + 1 === nrows && nrows > 1;
  const firstCol = look.firstColumn && g === 0;
  const lastCol = look.lastColumn && g + span >= ncols && ncols > 1;
  const rows = Math.min(rowSize, 1000), cols = Math.min(colSize, 1000);
  const rowBand = look.bandedRows && !header && rows > 0;
  const oddRow = Math.floor(Math.max(0, ri - (look.headerRow ? 1 : 0)) / Math.max(rows, 1)) % 2 === 0;
  const colBand = look.bandedColumns && !firstCol && cols > 0;
  const oddCol = Math.floor(Math.max(0, g - (look.firstColumn ? 1 : 0)) / Math.max(cols, 1)) % 2 === 0;
  const on = new Set(['wholeTable']);
  const add = (cond, p) => { if (cond) on.add(p); };
  add(colBand && oddCol, 'band1Vert'); add(colBand && !oddCol, 'band2Vert');
  add(rowBand && oddRow, 'band1Horz'); add(rowBand && !oddRow, 'band2Horz');
  add(firstCol, 'firstCol'); add(lastCol, 'lastCol'); add(header, 'firstRow'); add(total, 'lastRow');
  add(header && lastCol, 'neCell'); add(header && firstCol, 'nwCell'); add(total && lastCol, 'seCell'); add(total && firstCol, 'swCell');
  return TABLE_PARTS.filter(p => on.has(p));
}

export const emptyPartFormat = () => ({chr: {}, fill: null, borders: null, align: null, vAlign: null});
const partIsEmpty = f => same(f, emptyPartFormat()) || same({...emptyPartFormat(), ...f}, emptyPartFormat());
const mergeBorders = (b, p) => (b && p ? bordersOverlaid(b, p) : p ?? b ?? null);

/** PartFormat::overlay: what `patch` sets wins; borders merge edge by edge. */
export function partOverlaid(f, patch) {
  return {
    chr: charOverlaid(f.chr, patch.chr), fill: patch.fill ?? f.fill ?? null, borders: mergeBorders(f.borders, patch.borders),
    align: patch.align ?? f.align ?? null, vAlign: patch.vAlign ?? f.vAlign ?? null,
  };
}

const PART_BORDER_KEYS = ['borders', 'headerBorders', 'bandBorders', 'firstColBorders', 'lastColBorders', 'totalBorders', 'colBandBorders'];
const PART_CHR_KEYS = ['headerChr', 'bandChr', 'firstColChr', 'totalChr', 'lastColChr', 'colBandChr'];
const PART_PLAIN_KEYS = ['bandSize', 'colBandSize', 'fill', 'cellMargins', 'headerFill', 'bandFill', 'totalBorderTop', 'firstColFill', 'lastColFill',
  'totalFill', 'colBandFill'];

/** TableStyleParts::overlay. */
export function tablePartsOverlaid(base, patch) {
  const out = {...(base || {})};
  for (const k of PART_BORDER_KEYS) out[k] = mergeBorders(out[k] ?? null, patch[k] ?? null);
  for (const k of PART_CHR_KEYS) out[k] = charOverlaid(out[k] ?? {}, patch[k] ?? {});
  for (const k of PART_PLAIN_KEYS) out[k] = patch[k] ?? out[k] ?? null;
  const regions = {...(out.regions || {})};
  for (const [k, f] of Object.entries(patch.regions || {})) regions[k] = partOverlaid({...emptyPartFormat(), ...(regions[k] || {})}, {...emptyPartFormat(), ...f});
  out.regions = regions;
  return out;
}

/** Part `p`'s formatting from table style parts (TableStyleParts::part). */
export function tablePart(t, p) {
  t = t || {};
  const extra = {...emptyPartFormat(), ...(t.regions?.[p] || {})};
  const named = (chr, fill, borders) => ({chr: {...(chr || {})}, fill: fill ?? null, borders: borders ?? null, align: extra.align, vAlign: extra.vAlign});
  switch (p) {
    case 'wholeTable': return {chr: {}, fill: t.fill ?? null, borders: t.borders ?? null, align: null, vAlign: extra.vAlign};
    case 'firstRow': return named(t.headerChr, t.headerFill, t.headerBorders);
    case 'lastRow': {
      let b;
      if (t.totalBorders) b = {...t.totalBorders, top: t.totalBorders.top ?? t.totalBorderTop ?? undefined};
      else b = t.totalBorderTop ? {top: t.totalBorderTop} : null;
      if (b && b.top === undefined) delete b.top;
      return named(t.totalChr, t.totalFill, b);
    }
    case 'firstCol': return named(t.firstColChr, t.firstColFill, t.firstColBorders);
    case 'lastCol': return named(t.lastColChr, t.lastColFill, t.lastColBorders);
    case 'band1Vert': return named(t.colBandChr, t.colBandFill, t.colBandBorders);
    case 'band1Horz': return named(t.bandChr, t.bandFill, t.bandBorders);
    default: return extra;
  }
}

/** Replace part `p`'s formatting (TableStyleParts::set_part); returns new parts. */
export function setTablePart(t, p, f) {
  const out = {...(t || {})};
  f = {...emptyPartFormat(), ...f};
  const alignOnly = {...emptyPartFormat(), align: f.align, vAlign: f.vAlign};
  let rest;
  switch (p) {
    case 'wholeTable': out.fill = f.fill; out.borders = f.borders; rest = {...emptyPartFormat(), vAlign: f.vAlign}; break;
    case 'firstRow': out.headerChr = f.chr; out.headerFill = f.fill; out.headerBorders = f.borders; rest = alignOnly; break;
    case 'lastRow': {
      out.totalChr = f.chr; out.totalFill = f.fill;
      out.totalBorderTop = f.borders?.top ?? null;
      if (f.borders) {
        const b = {...f.borders};
        delete b.top;
        out.totalBorders = Object.values(b).some(v => v !== undefined && v !== null) ? b : null;
      } else out.totalBorders = null;
      rest = alignOnly; break;
    }
    case 'firstCol': out.firstColChr = f.chr; out.firstColFill = f.fill; out.firstColBorders = f.borders; rest = alignOnly; break;
    case 'lastCol': out.lastColChr = f.chr; out.lastColFill = f.fill; out.lastColBorders = f.borders; rest = alignOnly; break;
    case 'band1Vert': out.colBandChr = f.chr; out.colBandFill = f.fill; out.colBandBorders = f.borders; rest = alignOnly; break;
    case 'band1Horz': out.bandChr = f.chr; out.bandFill = f.fill; out.bandBorders = f.borders; rest = alignOnly; break;
    default: rest = f;
  }
  const regions = {...(out.regions || {})};
  if (partIsEmpty(rest)) delete regions[p]; else regions[p] = rest;
  out.regions = regions;
  return out;
}

/** Table style part `p` as one style alone sets it (Style::table_part). */
export function styleTablePart(st, p) {
  const f = tablePart(st.table, p);
  if (p === 'wholeTable') { f.chr = {...st.chr}; f.align = st.para?.align ?? null; }
  return f;
}
/** Replace part `p` of a table style (Style::set_table_part); returns the new style. */
export function styleSetTablePart(st, p, f) {
  const out = {...st};
  if (p === 'wholeTable') { out.chr = {...(f.chr || {})}; out.para = {...out.para}; if (f.align) out.para.align = f.align; else delete out.para.align; }
  const t = setTablePart(out.table || {}, p, f);
  out.table = isEmptyParts(t) ? null : t;
  return out;
}
function isEmptyParts(t) {
  for (const [k, v] of Object.entries(t)) {
    if (k === 'regions') { if (Object.keys(v || {}).length) return false; continue; }
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    return false;
  }
  return true;
}

// --- the built-in style set -----------------------------------------------------------------

function tableStyles() {
  const thin = c => border('single', 0.5, [...c], 0);
  const mk = (id, name, parts) => style({id, name, kind: 'table', basedOn: 'TableNormal',
    para: {spaceAfter: 0, lineSpacing: {rule: 'multiple', value: 1}}, priority: 60, builtin: true, table: {bandSize: 1, colBandSize: 1, ...parts}});
  const accents = [['Blue', [0x15, 0x60, 0x82], [0xc1, 0xe4, 0xf5]], ['Orange', [0xe9, 0x71, 0x32], [0xfb, 0xe2, 0xd5]],
    ['Green', [0x19, 0x6b, 0x24], [0xc1, 0xf0, 0xc8]], ['Purple', [0x71, 0x2e, 0x8d], [0xe5, 0xd2, 0xee]]];
  const v = [
    style({id: 'TableNormal', name: 'Normal Table', kind: 'table', hidden: true, builtin: true}),
    mk('PlainTable1', 'Plain Table 1', {borders: bordersAll(thin([0xbf, 0xbf, 0xbf])), headerChr: {bold: true}, bandFill: [0xf2, 0xf2, 0xf2],
      firstColChr: {bold: true}}),
    mk('GridTable1Light', 'Grid Table 1 Light', {borders: bordersAll(thin([0x99, 0x99, 0x99])), headerChr: {bold: true}, firstColChr: {bold: true}}),
  ];
  for (const [name, dark, light] of accents) {
    v.push(mk(`GridTable4Accent${name}`, `Grid Table 4 – ${name}`, {borders: bordersAll(thin(light)), headerFill: [...dark],
      headerChr: {bold: true, color: tc([255, 255, 255])}, bandFill: [...light], firstColChr: {bold: true}}));
    v.push(mk(`ListTable3Accent${name}`, `List Table 3 – ${name}`, {borders: bordersBox(thin(dark)), headerFill: [...dark],
      headerChr: {bold: true, color: tc([255, 255, 255])}, totalBorderTop: thin(dark)}));
  }
  return v;
}

/** The built-in style set used for new documents (StyleSheet::builtin). */
export function builtinStyleSheet() {
  const styles = [];
  const add = st => styles.push(st);
  add(pStyle({id: 'Normal', name: 'Normal', priority: 0, quick: true}));
  add(style({id: 'DefaultParagraphFont', name: 'Default Paragraph Font', kind: 'character', priority: 1, hidden: true, builtin: true}));
  add(pStyle({id: 'NoSpacing', name: 'No Spacing', basedOn: 'Normal', para: {spaceAfter: 0, lineSpacing: {rule: 'multiple', value: 1}}, priority: 1, quick: true}));
  const heads = [[20, 18, 4, null, HEADING_BLUE, HEADING_FONT], [16, 8, 4, null, HEADING_BLUE, HEADING_FONT], [14, 8, 4, null, HEADING_BLUE, BODY_FONT],
    [12, 4, 2, true, HEADING_BLUE, BODY_FONT], [12, 4, 2, null, HEADING_BLUE, BODY_FONT], [12, 2, 0, true, [0x59, 0x59, 0x59], BODY_FONT],
    [12, 2, 0, null, [0x59, 0x59, 0x59], BODY_FONT], [12, 0, 0, true, [0x27, 0x27, 0x27], BODY_FONT], [12, 0, 0, null, [0x27, 0x27, 0x27], BODY_FONT]];
  heads.forEach(([size, before, after, italic, c, font], i) => {
    const n = i + 1;
    const chr = {font, size, color: tc(c)};
    if (italic !== null) chr.italic = italic;
    add(pStyle({id: `Heading${n}`, name: `Heading ${n}`, basedOn: 'Normal', next: 'Normal', linked: `Heading${n}Char`,
      para: {spaceBefore: before, spaceAfter: after, keepNext: true, keepLines: true, outlineLevel: i}, chr, priority: 9 + n, quick: n <= 3}));
  });
  add(pStyle({id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal',
    para: {spaceAfter: 4, contextualSpacing: true, lineSpacing: {rule: 'multiple', value: 1}},
    chr: {font: HEADING_FONT, size: 28, spacing: -0.5, kern: 14}, priority: 10, quick: true}));
  add(pStyle({id: 'Subtitle', name: 'Subtitle', basedOn: 'Normal', next: 'Normal', chr: {size: 14, spacing: 0.75, color: tc([0x59, 0x59, 0x59])},
    priority: 11, quick: true}));
  const cStyle = (id, name, prio, chr) => style({id, name, kind: 'character', basedOn: 'DefaultParagraphFont', chr, priority: prio, quick: true, builtin: true});
  add(cStyle('SubtleEmphasis', 'Subtle Emphasis', 19, {italic: true, color: tc([0x40, 0x40, 0x40])}));
  add(cStyle('Emphasis', 'Emphasis', 20, {italic: true}));
  add(cStyle('IntenseEmphasis', 'Intense Emphasis', 21, {italic: true, color: tc(HEADING_BLUE)}));
  add(cStyle('Strong', 'Strong', 22, {bold: true}));
  add(pStyle({id: 'Quote', name: 'Quote', basedOn: 'Normal', next: 'Normal', para: {align: 'center', spaceBefore: 8},
    chr: {italic: true, color: tc([0x40, 0x40, 0x40])}, priority: 29, quick: true}));
  const blueLine = border('single', 0.5, [...HEADING_BLUE], 10);
  add(pStyle({id: 'IntenseQuote', name: 'Intense Quote', basedOn: 'Normal', next: 'Normal',
    para: {align: 'center', spaceBefore: 18, spaceAfter: 18, indentLeft: 43.2, indentRight: 43.2, borders: {top: blueLine, bottom: blueLine}},
    chr: {italic: true, color: tc(HEADING_BLUE)}, priority: 30, quick: true}));
  add(cStyle('SubtleReference', 'Subtle Reference', 31, {smallCaps: true, color: tc([0x5a, 0x5a, 0x5a])}));
  add(cStyle('IntenseReference', 'Intense Reference', 32, {bold: true, smallCaps: true, spacing: 0.25, color: tc(HEADING_BLUE)}));
  add(cStyle('BookTitle', 'Book Title', 33, {bold: true, italic: true, spacing: 0.25}));
  add(pStyle({id: 'ListParagraph', name: 'List Paragraph', basedOn: 'Normal', para: {indentLeft: 36, contextualSpacing: true}, priority: 34, quick: true}));
  add({...cStyle('Hyperlink', 'Hyperlink', 99, {color: tc([0x46, 0x78, 0x86]), underline: 'single'}), quick: false});
  add(pStyle({id: 'Caption', name: 'Caption', basedOn: 'Normal', next: 'Normal', para: {spaceAfter: 10, lineSpacing: {rule: 'multiple', value: 1}},
    chr: {italic: true, size: 9, color: tc([0x0e, 0x28, 0x41])}, priority: 35}));
  for (const id of ['Header', 'Footer']) {
    add(pStyle({id, name: id, basedOn: 'Normal', para: {spaceAfter: 0, lineSpacing: {rule: 'multiple', value: 1},
      tabs: [{pos: 234, align: 'center', leader: 'none'}, {pos: 468, align: 'right', leader: 'none'}]}, priority: 99}));
  }
  add(pStyle({id: 'FootnoteText', name: 'Footnote Text', basedOn: 'Normal', para: {spaceAfter: 0, lineSpacing: {rule: 'multiple', value: 1}},
    chr: {size: 10}, priority: 99}));
  add({...cStyle('FootnoteReference', 'Footnote Reference', 99, {vertAlign: 'superscript'}), quick: false});
  add(pStyle({id: 'EndnoteText', name: 'Endnote Text', basedOn: 'Normal', para: {spaceAfter: 0, lineSpacing: {rule: 'multiple', value: 1}},
    chr: {size: 10}, priority: 99}));
  add({...cStyle('EndnoteReference', 'Endnote Reference', 99, {vertAlign: 'superscript'}), quick: false});
  add(pStyle({id: 'TOCHeading', name: 'TOC Heading', basedOn: 'Heading1', next: 'Normal', para: {outlineLevel: 9, spaceBefore: 12}, priority: 39}));
  for (let n = 1; n <= 9; n++) {
    add(pStyle({id: `TOC${n}`, name: `TOC ${n}`, basedOn: 'Normal', next: 'Normal', para: {spaceAfter: 5, indentLeft: 12 * (n - 1)}, priority: 39}));
  }
  add(style({id: 'TableGrid', name: 'Table Grid', kind: 'table', para: {spaceAfter: 0, lineSpacing: {rule: 'multiple', value: 1}}, priority: 59,
    builtin: true, table: {borders: bordersAll(singleBorder(0.5))}}));
  styles.push(...tableStyles());
  return {
    defaultChr: {font: BODY_FONT, size: 12, kern: 1, lang: 'en-US'},
    defaultPara: {spaceAfter: 8, spaceBefore: 0, lineSpacing: {rule: 'multiple', value: 1.15}, widowControl: true},
    defaultParaPresent: true,
    styles,
  };
}

/** An empty style sheet (StyleSheet::empty). */
export const emptyStyleSheet = () => ({defaultChr: {}, defaultPara: {}, defaultParaPresent: true, styles: []});

// --- StyleSheet methods ---------------------------------------------------------------------

export const getStyle = (sheet, id) => sheet.styles.find(s => s.id === id) ?? null;
/** Find by display name (case-insensitive) or id. */
export function findStyle(sheet, nameOrId) {
  return getStyle(sheet, nameOrId) ?? sheet.styles.find(s => s.name.toLowerCase() === String(nameOrId).toLowerCase()) ?? null;
}
/** The Quick Styles gallery, in priority order. */
export function gallery(sheet) {
  return sheet.styles.filter(s => s.quick && !s.hidden && s.kind !== 'table')
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
/** The based-on chain from the root down to `id` (bounded, cycle-safe). */
export function chain(sheet, id) {
  const out = [];
  let cur = getStyle(sheet, id);
  while (cur) {
    if (out.length >= 32 || out.some(o => o.id === cur.id)) break;
    out.push(cur);
    cur = cur.basedOn ? getStyle(sheet, cur.basedOn) : null;
  }
  return out.reverse();
}

/** Which indents (left, first line) the style chain sets over a list level's own. */
export function indentsOverList(sheet, id) {
  const ch = chain(sheet, id);
  let k = -1;
  for (let i = ch.length - 1; i >= 0; i--) if (ch[i].para?.numbering) { k = i; break; }
  if (k < 0) return [false, false];
  const set = (v, chars) => v !== undefined && v !== null || (chars !== undefined && chars !== null && chars !== 0);
  let l = false, f = false;
  for (const s of ch.slice(k)) {
    l ||= set(s.para?.indentLeft, s.para?.indentLeftChars);
    f ||= set(s.para?.indentFirst, s.para?.indentFirstChars);
  }
  return [l, f];
}

/** Table style `id` with its based-on chain merged (null when there is no such table style). */
export function tableStyle(sheet, id) {
  const ch = chain(sheet, id).filter(s => s.kind === 'table');
  if (!ch.length || ch[ch.length - 1].id !== id) return null;
  let para = {}, chr = {}, parts = {};
  for (const s of ch) {
    para = paraOverlaid(para, s.para);
    chr = charOverlaid(chr, s.chr);
    if (s.table) parts = tablePartsOverlaid(parts, s.table);
  }
  delete para.style; delete chr.style;
  return {para, chr, parts};
}
/** Part `p` of merged table style props (TableStyleProps::part). */
export function tableStylePart(props, p) {
  const f = tablePart(props.parts, p);
  if (p === 'wholeTable') { f.chr = {...props.chr}; f.align = props.para.align ?? null; }
  return f;
}

/** Add or replace a style; returns the new sheet. */
export function upsertStyle(sheet, st) {
  const i = sheet.styles.findIndex(s => s.id === st.id);
  const styles = sheet.styles.slice();
  if (i >= 0) styles[i] = st; else styles.push(st);
  return {...sheet, styles};
}

/** Give a file without quick styles Word's usual gallery (StyleSheet::add_default_gallery). */
export function addDefaultGallery(sheet) {
  const builtin = builtinStyleSheet();
  let styles = sheet.styles.slice();
  const get = id => styles.find(s => s.id === id);
  const find = n => get(n) ?? styles.find(s => s.name.toLowerCase() === String(n).toLowerCase());
  for (const q of builtin.styles.filter(s => s.quick && s.kind !== 'table')) {
    let i = styles.findIndex(s => s.id === q.id);
    if (i < 0) i = styles.findIndex(s => s.name.toLowerCase() === q.name.toLowerCase());
    if (i >= 0) {
      const st = styles[i];
      if (st.builtin && st.kind === q.kind) styles[i] = {...st, quick: true, priority: st.priority ?? q.priority};
      continue;
    }
    for (const sid of [q.id, q.linked].filter(Boolean)) {
      const b = getStyle(builtin, sid);
      if (b && !get(sid) && !find(b.name)) styles = [...styles, structuredClone(b)];
    }
  }
  return {...sheet, styles};
}

/** Remove style `id` (StyleSheet::remove): styles based on it rebase onto its own base. Returns {sheet, removed}. */
export function removeStyle(sheet, id) {
  const i = sheet.styles.findIndex(s => s.id === id);
  if (i < 0) return {sheet, removed: null};
  const gone = sheet.styles[i];
  const styles = sheet.styles.filter((_, k) => k !== i).map(s => {
    let t = s;
    if (s.basedOn === id) t = {...t, basedOn: gone.basedOn && gone.basedOn !== s.id ? gone.basedOn : null};
    if (s.next === id) t = {...t, next: null};
    if (s.linked === id) t = {...t, linked: null};
    return t;
  });
  return {sheet: {...sheet, styles}, removed: gone};
}

/** An id not used yet, derived from a display name (StyleSheet::new_id). */
export function newStyleId(sheet, name) {
  let base = [...String(name)].filter(c => /[\p{Alphabetic}\p{N}]/u.test(c)).join('');
  if (!base) base = 'Style';
  if (!getStyle(sheet, base)) return base;
  for (let i = 1; i < 10_000; i++) if (!getStyle(sheet, `${base}${i}`)) return `${base}${i}`;
  return base;
}

// --- resolve.rs -----------------------------------------------------------------------------

/** Automatic (HTML-style) paragraph spacing, points. */
export const AUTO_SPACING = 14;
export const MAX_DROP_CAP_DISTANCE = 1584;
const MAX_INDENT = 1584;
const MAX_CHARS = 1584;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fin = v => (typeof v === 'number' && Number.isFinite(v));

/** Concrete character formatting (ResolvedChar::from). */
function resolvedChar(c) {
  const size = clamp(c.size ?? DEFAULT_FONT_SIZE, 1, 1638);
  return {
    font: shownFont(c) ?? BODY_FONT,
    size: Number.isNaN(size) ? 1 : size,
    bold: c.bold ?? false, italic: c.italic ?? false, underline: c.underline ?? 'none', underlineColor: c.underlineColor ?? null,
    strike: c.strike ?? false, doubleStrike: c.doubleStrike ?? false, color: c.color ?? 'Auto',
    highlight: c.highlight ? highlightRgb(c.highlight) : null, shading: c.shading ?? null,
    border: c.border && borderVisible(c.border) ? c.border : null,
    vertAlign: c.vertAlign ?? 'baseline', caps: c.caps ?? false, smallCaps: c.smallCaps ?? false, hidden: c.hidden ?? false,
    spacing: clamp(c.spacing ?? 0, -100, 100), scale: clamp(c.scale ?? 100, 1, 600), position: clamp(c.position ?? 0, -800, 800),
    kern: clamp(fin(c.kern) ? c.kern : 0, 0, 1638), ligatures: c.ligatures ?? null,
    outline: c.outline ?? false, shadow: c.shadow ?? false, emboss: c.emboss ?? false, engrave: c.engrave ?? false,
    textEffects: c.textEffects && Object.values(c.textEffects).some(v => v !== undefined && v !== null) ? c.textEffects : null,
    link: c.link ?? null, ins: c.ins ?? null, del: c.del ?? null, fmt: c.fmtChange ? c.fmtChange.rev : null,
    noProof: c.noProof ?? false, lang: c.lang ?? null, rtl: c.rtl ?? false, cs: c.cs ?? false,
    fontCs: c.fontCs ?? c.font ?? BODY_FONT, fontEa: c.fontEa ?? null,
    sizeCs: clamp(c.sizeCs ?? c.size ?? DEFAULT_FONT_SIZE, 1, 1638), boldCs: c.boldCs ?? c.bold ?? false, italicCs: c.italicCs ?? c.italic ?? false,
  };
}
/** The formatting complex-script text in this run is drawn with (ResolvedChar::complex). */
export const resolvedComplex = r => ({...r, font: r.fontCs, size: r.sizeCs, bold: r.boldCs, italic: r.italicCs});
/** Word kerns only a run with Kerning for fonts set at a size of at least that many points. */
export const resolvedKerned = r => r.kern > 0 && r.size >= r.kern;
/** The size glyphs are drawn at (super/subscript shrink to ~2/3). */
export const resolvedDrawSize = r => (r.vertAlign === 'baseline' ? r.size : r.size * 0.65);
/** Baseline shift, points (positive = up). */
export const resolvedBaselineShift = r => r.position + (r.vertAlign === 'superscript' ? r.size * 0.33 : r.vertAlign === 'subscript' ? -r.size * 0.14 : 0);

function clampSpacing(ls) {
  const l = ls ?? {rule: 'multiple', value: 1};
  if (l.rule === 'atLeast') return {rule: 'atLeast', value: fin(l.value) ? clamp(l.value, 0, 1584) : 0};
  if (l.rule === 'exactly') return {rule: 'exactly', value: fin(l.value) ? clamp(l.value, 0.7, 1584) : 12};
  return {rule: 'multiple', value: fin(l.value) ? clamp(l.value, 0.06, 132) : 1};
}

/** Concrete paragraph formatting (ResolvedPara::from). */
function resolvedPara(p, style) {
  const clampi = v => clamp(v ?? 0, -MAX_INDENT, MAX_INDENT);
  const tabs = (p.tabs ?? []).filter(t => t.align !== 'clear' && fin(t.pos)).slice().sort((a, b) => a.pos - b.pos);
  return {
    style, align: p.align ?? 'left',
    indentLeft: clampi(p.indentLeft), indentRight: clampi(p.indentRight), indentFirst: clampi(p.indentFirst),
    spaceBefore: p.spaceBeforeAuto === true ? AUTO_SPACING : clamp(p.spaceBefore ?? 0, 0, 1584),
    spaceAfter: p.spaceAfterAuto === true ? AUTO_SPACING : clamp(p.spaceAfter ?? 0, 0, 1584),
    beforeAuto: p.spaceBeforeAuto === true, afterAuto: p.spaceAfterAuto === true,
    lineSpacing: clampSpacing(p.lineSpacing), contextualSpacing: p.contextualSpacing ?? false, mirrorIndents: p.mirrorIndents ?? false,
    keepNext: p.keepNext ?? false, keepLines: p.keepLines ?? false, pageBreakBefore: p.pageBreakBefore ?? false,
    widowControl: p.widowControl ?? true, outlineLevel: fin(p.outlineLevel) && p.outlineLevel < 9 ? p.outlineLevel : null,
    numbering: p.numbering && p.numbering.num !== 0 ? p.numbering : null, tabs, shading: p.shading ?? null,
    borders: p.borders && bordersAnyVisible(p.borders) ? p.borders : null, bidi: p.bidi ?? false,
    dropCap: Math.min(p.dropCap ?? 0, 10), dropCapMargin: p.dropCapMargin ?? false,
    dropCapDistance: clamp(fin(p.dropCapDistance) ? p.dropCapDistance : 0, 0, MAX_DROP_CAP_DISTANCE),
    dropCapFont: typeof p.dropCapFont === 'string' && p.dropCapFont.trim() ? p.dropCapFont : null,
    frame: (p.dropCap ?? 0) === 0 ? p.frame ?? null : null,
    suppressHyphens: p.suppressHyphens ?? false, suppressLineNumbers: p.suppressLineNumbers ?? false,
    kinsoku: p.kinsoku ?? true, wordWrap: p.wordWrap ?? true, overflowPunct: p.overflowPunct ?? true, topLinePunct: p.topLinePunct ?? false,
    autoSpaceDE: p.autoSpaceDE ?? true, autoSpaceDN: p.autoSpaceDN ?? true, snapToGrid: p.snapToGrid ?? true,
    indentChars: [p.indentLeftChars, p.indentRightChars, p.indentFirstChars].map(c => clamp(fin(c) ? c : 0, -MAX_CHARS, MAX_CHARS)),
  };
}

/** Visual (left, right) indents: a right-to-left paragraph's start edge is its right. */
export const visualIndents = r => (r.bidi ? [r.indentRight, r.indentLeft] : [r.indentLeft, r.indentRight]);

/** Turn indents in characters into points, one character being `size` points (ResolvedPara::set_char_unit). */
export function setCharUnit(r, size) {
  const s = fin(size) ? clamp(size, 1, 1638) : 12;
  const out = {...r};
  const [l, rr, f] = r.indentChars;
  if (l !== 0) out.indentLeft = clamp(l * s, -MAX_INDENT, MAX_INDENT);
  if (rr !== 0) out.indentRight = clamp(rr * s, -MAX_INDENT, MAX_INDENT);
  if (f !== 0) out.indentFirst = clamp(f * s, -MAX_INDENT, MAX_INDENT);
  return out;
}

function mergeTabs(base, add) {
  const merged = base.filter(t => !add.some(a => Math.abs(a.pos - t.pos) < 0.5));
  return [...merged, ...add];
}

/** The paragraph style chain of `style` applied over `pp` / `cp` (para_style_props_over). */
function paraStylePropsOver(sheet, styleId, pp, cp) {
  for (const s of chain(sheet, styleId)) {
    if (s.kind !== 'paragraph') continue;
    let sp = s.para || {};
    if (pp.tabs && sp.tabs) sp = {...sp, tabs: mergeTabs(pp.tabs, sp.tabs)};
    pp = paraOverlaid(pp, sp);
    cp = charOverlaid(cp, s.chr);
  }
  delete pp.style;
  return [pp, cp];
}

/** Paragraph properties after defaults and the style chain, without direct formatting. */
export const paraStyleProps = (sheet, styleId) => paraStylePropsOver(sheet, styleId, {...sheet.defaultPara}, {...sheet.defaultChr});

/**
 * Resolve a paragraph's properties; `table` is the paragraph formatting of the table style the
 * paragraph's table uses (ECMA-376 §17.7.2 order: defaults, table style, style chain, direct).
 */
export function resolvePara(sheet, p, table = null) {
  p = p || {};
  const styleId = p.style ?? 'Normal';
  let defaults = {...sheet.defaultPara};
  if (table) { const t = {...table}; delete t.style; defaults = paraOverlaid(defaults, t); }
  let [base] = paraStylePropsOver(sheet, styleId, defaults, {});
  let direct = p;
  if (base.tabs && direct.tabs) direct = {...direct, tabs: mergeTabs(base.tabs, direct.tabs)};
  base = paraOverlaid(base, direct);
  let rp = resolvedPara(base, styleId);
  if (rp.indentChars.some(c => c !== 0)) rp = setCharUnit(rp, resolveChar(sheet, styleId, {}).size);
  return rp;
}

/**
 * Resolve character formatting for a run in a paragraph of style `paraStyle`; `table` is the run
 * formatting of the table style with the cell's conditional formatting. Order: defaults, table
 * style, paragraph style chain, character style chain, direct formatting.
 */
export function resolveChar(sheet, paraStyle, c, table = null) {
  c = c || {};
  let defaults = {...sheet.defaultChr};
  if (table) { const t = {...table}; delete t.style; defaults = charOverlaid(defaults, t); }
  let [, cp] = paraStylePropsOver(sheet, paraStyle ?? 'Normal', {}, defaults);
  if (c.style) for (const s of chain(sheet, c.style)) if (s.kind === 'character' || s.kind === 'paragraph') cp = charOverlaid(cp, s.chr);
  delete cp.symFont;
  const direct = {...c};
  delete direct.style;
  cp = charOverlaid(cp, direct);
  return resolvedChar(cp);
}
