// A schema-2 workbook as an Excel workbook (.xlsx).
// Translated from gridcraft crates/xlsx/src at 146161b4b450a56e5e59a083ba0478582d1e602b:
//   write.rs (`write_xlsx_named`: parts, relationships, content types, workbook.xml with
//   workbookPr/bookViews/sheets/definedNames/calcPr, shared strings, metadata.xml for dynamic
//   arrays, docProps, part order), styles.rs (`write_styles`, `font_xml`, `fill_xml`,
//   `border_xml`, `alignment_xml`, `protection_xml`, `color_attrs`, dxfs, custom number formats
//   from 164), theme.rs (`write_theme`), sheet_write.rs (`write_sheet`: sheetPr, dimension,
//   `write_sheet_views` with frozen panes, sheetFormatPr, cols runs, `write_sheet_data` /
//   `write_cell` with cached values, legacy and dynamic arrays, spilled values, sheetProtection,
//   mergeCells, conditional formats, data validations, hyperlinks, tables, notes),
//   sheet_write/rules.rs and parts.rs, fmla.rs (`to_file`: `_xlfn.`/`_xlws.` prefixes,
//   ANCHORARRAY, SINGLE, TRIMRANGE, `_xlpm.` LET/LAMBDA parameters, long structured references)
//   and tables.rs (`builtin_id`, `px_to_col_width`, `px_to_pt`, FUTURE_FUNCTIONS).
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:grid/formats-xlsx.
// May use jszip (architecture 5.3); no DOM. The shapes it writes are listed in xlsx-read.mjs.

import JSZip from 'jszip';
import {MAX_ROWS, MAX_COLS, a1, parseRange, parseCell, rangeA1, rangeOf, union, colToLetters, quoteSheet} from '../lib/addr.mjs';
import {parse, print, mapExpr, structRefText} from '../lib/formula.mjs';
import {CellError, GArray, ERR, parseError} from '../lib/value.mjs';
import {blockEntries} from '../model/store.mjs';
import {resolveStyle, DEFAULT_THEME, DEFAULT_STYLE} from '../model/style.mjs';
import {engineFor, keySheet, keyRow, keyCol} from '../model/calc.mjs';
import {BUILTIN_FORMATS} from './xlsx-read.mjs';
import {autofilterXml} from '../lib/data-filter-xlsx.mjs';
import {drawingXml, chartXml, pictureFile, sparklinesExt} from '../lib/xlsx-drawing.mjs';
import {pageSetupXml, needsFitToPage} from '../lib/xlsx-pagesetup.mjs';
import {sheetObjects} from '../lib/objects.mjs';
import {MIME_FOR_EXT} from '../lib/image-info.mjs';
import {threadedXml, personsXml, placeholderNote} from '../lib/xlsx-threaded.mjs';
import {PivotWriter} from '../lib/xlsx-pivot.mjs';
import {SlicerWriter, mergeExt} from '../lib/xlsx-slicer.mjs';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const CT = {
  workbook: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  sheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  styles: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  sst: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  metadata: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml',
  table: 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml',
  comments: 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml',
  threaded: 'application/vnd.ms-excel.threadedcomments+xml',
  persons: 'application/vnd.ms-excel.person+xml',
  drawing: 'application/vnd.openxmlformats-officedocument.drawing+xml',
  chart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
};
const METADATA = `${XML_DECL}<metadata xmlns="${NS_MAIN}" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray"><metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes><futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata><cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata></metadata>`;

// xml.rs escaping
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
export const esc = s => String(s).replace(INVALID_XML, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const escAttr = s => esc(s).replaceAll('"', '&quot;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;').replaceAll('\t', '&#9;');
/** xml.rs `encode_xstring`: characters XML can't hold, and literal `_xHHHH_`, as `_xHHHH_`. */
export function encodeXString(s) {
  return String(s).replace(/_x[0-9A-Fa-f]{4}_|[\u0000-\u0008\u000B-\u001F\uFFFE\uFFFF]/g,
    m => (m.length === 1 ? `_x${m.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_` : `_x005F${m}`));
}
const tEl = s => `<t${/^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : ''}>${esc(encodeXString(s))}</t>`;
const num = n => (Object.is(n, -0) ? '0' : String(n));

// ---------------------------------------------------------------------------------------------
// tables.rs

const FUTURE_FUNCTIONS = new Set(('ACOT ACOTH AGGREGATE ARABIC ARRAYTOTEXT BASE BETA.DIST BETA.INV BINOM.DIST BINOM.DIST.RANGE BINOM.INV BITAND BITLSHIFT BITOR '
  + 'BITRSHIFT BITXOR BYCOL BYROW CEILING.MATH CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST CHOOSECOLS CHOOSEROWS COMBINA '
  + 'CONCAT CONFIDENCE.NORM CONFIDENCE.T COT COTH COVARIANCE.P COVARIANCE.S CSC CSCH DAYS DECIMAL DROP ENCODEURL ERF.PRECISE ERFC.PRECISE EXPAND '
  + 'EXPON.DIST F.DIST F.DIST.RT F.INV F.INV.RT F.TEST FIELDVALUE FILTERXML FLOOR.MATH FLOOR.PRECISE FORECAST.ETS FORECAST.ETS.CONFINT '
  + 'FORECAST.ETS.SEASONALITY FORECAST.ETS.STAT FORECAST.LINEAR FORMULATEXT GAMMA GAMMA.DIST GAMMA.INV GAMMALN.PRECISE GAUSS GROUPBY HSTACK '
  + 'HYPGEOM.DIST IFNA IFS IMAGE IMCOSH IMCOT IMCSC IMCSCH IMSEC IMSECH IMSINH IMTAN ISFORMULA ISOMITTED ISOWEEKNUM LAMBDA LET LOGNORM.DIST LOGNORM.INV '
  + 'MAKEARRAY MAP MAXIFS MINIFS MODE.MULT MODE.SNGL MUNIT NEGBINOM.DIST NETWORKDAYS.INTL NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV NUMBERVALUE '
  + 'PDURATION PERCENTILE.EXC PERCENTILE.INC PERCENTOF PERCENTRANK.EXC PERCENTRANK.INC PERMUTATIONA PHI PIVOTBY POISSON.DIST QUARTILE.EXC '
  + 'QUARTILE.INC RANDARRAY RANK.AVG RANK.EQ REDUCE REGEXEXTRACT REGEXREPLACE REGEXTEST RRI SCAN SEC SECH SEQUENCE SHEET SHEETS SINGLE SKEW.P SORTBY '
  + 'STDEV.P STDEV.S SWITCH T.DIST T.DIST.2T T.DIST.RT T.INV T.INV.2T T.TEST TAKE TEXTAFTER TEXTBEFORE TEXTJOIN TEXTSPLIT TOCOL TOROW TRIMRANGE '
  + 'UNICHAR UNICODE UNIQUE VALUETOTEXT VAR.P VAR.S VSTACK WEBSERVICE WEIBULL.DIST WORKDAY.INTL WRAPCOLS WRAPROWS XLOOKUP XMATCH XOR Z.TEST').split(' '));
const XLWS = new Set(['FILTER', 'SORT']);
/** tables.rs `file_function_name`: `XLOOKUP` → `_xlfn.XLOOKUP`, `FILTER` → `_xlfn._xlws.FILTER`. */
export function fileFunctionName(name) {
  const u = String(name).toUpperCase();
  if (XLWS.has(u)) return `_xlfn._xlws.${u}`;
  return FUTURE_FUNCTIONS.has(u) ? `_xlfn.${u}` : null;
}
/** tables.rs `builtin_id`: built-ins that are the same in every locale (not 5–8, 42, 44). */
function builtinId(code) {
  for (const [i, c] of BUILTIN_FORMATS) if (c === code && !(i >= 5 && i <= 8) && i !== 42 && i !== 44) return i;
  return null;
}
const colWidthToPx = w => (!Number.isFinite(w) || w <= 0 ? 0 : Math.trunc(((256 * Math.min(w, 255) + Math.trunc(128 / 7)) / 256) * 7));
/** tables.rs `px_to_col_width`. */
export function pxToColWidth(px0) {
  const px = Math.min(1790, Math.round(Math.max(0, px0)));
  const chars = px > 12 ? Math.trunc((px - 5) / 7 * 100 + 0.5) / 100 : px / 12;
  const w = Math.trunc((chars * 7 + 5) / 7 * 256) / 256;
  if (colWidthToPx(w) === px) return w;
  return Math.max(0, Math.ceil(px * 256 / 7 - 18)) / 256;
}
/** tables.rs `px_to_pt`. */
export const pxToPt = px => Math.round(Math.max(0, px) * 0.75 * 100) / 100;

// ---------------------------------------------------------------------------------------------
// fmla.rs `to_file`

const PARAM = '_xlpm.';
function prefixParams(e, scope) {
  const inScope = n => scope.some(s => s.toLowerCase() === String(n).toLowerCase());
  switch (e.t) {
    case 'name': return inScope(e.v) ? {t: 'name', v: PARAM + e.v} : e;
    case 'unary': return {...e, x: prefixParams(e.x, scope)};
    case 'paren': return {t: 'paren', x: prefixParams(e.x, scope)};
    case 'binary': {
      const spine = [];
      let left = e;
      while (left.t === 'binary') { spine.push(left); left = left.a; }
      let acc = prefixParams(left, scope);
      while (spine.length) { const b = spine.pop(); acc = {t: 'binary', op: b.op, a: acc, b: prefixParams(b.b, scope)}; }
      return acc;
    }
    case 'array': return {t: 'array', rows: e.rows.map(r => r.map(x => prefixParams(x, scope)))};
    case 'invoke': return {t: 'invoke', callee: prefixParams(e.callee, scope), args: e.args.map(a => prefixParams(a, scope))};
    case 'call': {
      if (e.name === 'LET' || e.name === 'LAMBDA') {
        const last = e.args.length - 1, isLet = e.name === 'LET';
        const sc = [...scope];
        let pending = null;
        const out = e.args.map((a, i) => {
          const declares = i < last && (!isLet || i % 2 === 0);
          if (a.t === 'name' && declares) {
            if (isLet) pending = a.v; else sc.push(a.v);
            return {t: 'name', v: PARAM + a.v};
          }
          const r = prefixParams(a, sc);
          if (pending !== null) { sc.push(pending); pending = null; }
          return r;
        });
        return {t: 'call', name: e.name, args: out};
      }
      const args = e.args.map(a => prefixParams(a, scope));
      return {t: 'call', name: inScope(e.name) ? PARAM + e.name : e.name, args};
    }
    default: return e;
  }
}
const TRIM_CODES = {leading: 1, trailing: 2, all: 3};
/** fmla.rs `to_file` for formula text (model text without `=`). Unparseable text is kept. */
export function toFile(text) {
  let e;
  try { e = parse(String(text).replace(/^=/, '')); } catch { return String(text).replace(/^=/, ''); }
  e = prefixParams(e, []);
  e = mapExpr(e, x => {
    if (x.t === 'call') { const n = fileFunctionName(x.name); return n ? {...x, name: n} : x; }
    if (x.t === 'unary' && x.op === 'spill') return x.x.t === 'err' ? x.x : {t: 'call', name: '_xlfn.ANCHORARRAY', args: [x.x]};
    if (x.t === 'unary' && x.op === 'at') return {t: 'call', name: '_xlfn.SINGLE', args: [x.x]};
    if (x.t === 'unary' && x.op === 'trim') { const c = {t: 'num', v: TRIM_CODES[x.mode] ?? 3}; return {t: 'call', name: '_xlfn.TRIMRANGE', args: [x.x, c, c]}; }
    if (x.t === 'struct') return {t: 'name', v: structRefText(x, false)};
    return x;
  });
  return print(e);
}

// ---------------------------------------------------------------------------------------------
// styles.rs writing

/** styles.rs `color_attrs`. */
function colorAttrs(c) {
  if (c === null || c === undefined || c === 'auto') return 'auto="1"';
  if (typeof c === 'string') { const h = c.replace(/^#/, '').slice(-6).toUpperCase(); return `rgb="FF${/^[0-9A-F]{6}$/.test(h) ? h : '000000'}"`; }
  if (typeof c === 'object' && Number.isInteger(c.theme)) return c.tint ? `theme="${c.theme}" tint="${num(c.tint)}"` : `theme="${c.theme}"`;
  return 'auto="1"';
}
function fontXml(f, dxf = false, stated = null) {
  let s = '<font>';
  for (const [k, tag] of [['bold', 'b'], ['italic', 'i'], ['strike', 'strike']]) {
    if (f[k]) s += `<${tag}/>`; else if (dxf && stated && k in stated) s += `<${tag} val="0"/>`;
  }
  const u = f.underline ?? 'none';
  if (u === 'single') s += '<u/>';
  else if (u !== 'none') s += `<u val="${u}"/>`;
  else if (dxf && stated && 'underline' in stated) s += '<u val="none"/>';
  if (f.vert === 'superscript' || f.vert === 'subscript') s += `<vertAlign val="${f.vert}"/>`;
  if (!dxf || (stated && 'size' in stated)) s += `<sz val="${num(f.size ?? 11)}"/>`;
  if (f.color) s += `<color ${colorAttrs(f.color)}/>`;
  else if (!dxf) s += '<color theme="1"/>';
  if (!dxf) s += `<name val="${escAttr(f.name ?? DEFAULT_STYLE.font.name)}"/><family val="2"/>`;
  else if (stated && 'name' in stated) s += `<name val="${escAttr(f.name)}"/>`;
  return `${s}</font>`;
}
function fillXml(f, dxf = false) {
  if (!f || !f.pattern || f.pattern === 'none') return '<fill><patternFill patternType="none"/></fill>';
  if (dxf && f.pattern === 'solid') { const c = colorAttrs(f.fg); return `<fill><patternFill patternType="solid"><fgColor ${c}/><bgColor ${c}/></patternFill></fill>`; }
  let s = `<fill><patternFill patternType="${f.pattern}">`;
  if (f.fg) s += `<fgColor ${colorAttrs(f.fg)}/>`; else if (f.pattern !== 'gray125') s += '<fgColor indexed="64"/>';
  s += f.bg ? `<bgColor ${colorAttrs(f.bg)}/>` : '<bgColor indexed="64"/>';
  return `${s}</patternFill></fill>`;
}
const lineXml = (tag, l) => (!l || !l.style || l.style === 'none' ? `<${tag}/>`
  : `<${tag} style="${l.style}">${l.color ? `<color ${colorAttrs(l.color)}/>` : '<color indexed="64"/>'}</${tag}>`);
function borderXml(b) {
  let s = '<border';
  if (b.diagUp) s += ' diagonalUp="1"';
  if (b.diagDown) s += ' diagonalDown="1"';
  s += `>${lineXml('left', b.left)}${lineXml('right', b.right)}${lineXml('top', b.top)}${lineXml('bottom', b.bottom)}${lineXml('diagonal', b.diagDown ?? b.diagUp)}</border>`;
  return s;
}
const H_NAME = {left: 'left', center: 'center', right: 'right', fill: 'fill', justify: 'justify', centerAcross: 'centerContinuous', distributed: 'distributed'};
const V_NAME = {top: 'top', center: 'center', justify: 'justify', distributed: 'distributed'};
function alignmentXml(a) {
  let s = '';
  if (H_NAME[a.h]) s += ` horizontal="${H_NAME[a.h]}"`;
  if (V_NAME[a.v]) s += ` vertical="${V_NAME[a.v]}"`;
  const r = a.rotation ?? 0;
  const rot = r === 255 ? 255 : r >= 0 && r <= 90 ? r : r >= -90 && r < 0 ? 90 - r : 0;
  if (rot) s += ` textRotation="${rot}"`;
  if (a.wrap) s += ' wrapText="1"';
  if (a.indent > 0) s += ` indent="${a.indent}"`;
  if (a.shrink) s += ' shrinkToFit="1"';
  return s ? `<alignment${s}/>` : null;
}
const protectionXml = p => (p.locked !== false && !p.hidden ? null : `<protection locked="${p.locked === false ? 0 : 1}" hidden="${p.hidden ? 1 : 0}"/>`);
const keyOf = v => JSON.stringify(v ?? null);

function writeStyles(content, dxfs) {
  const table = Array.isArray(content.styles) && content.styles.length ? content.styles : [{}];
  const custom = [], fmtIds = new Map();
  const fmtId = code => {
    if (!code || code === 'General' || code === 'checkbox') return 0;
    const b = builtinId(code);
    if (b !== null) return b;
    let id = fmtIds.get(code);
    if (id === undefined) { id = 164 + custom.length; custom.push(code); fmtIds.set(code, id); }
    return id;
  };
  const fonts = [], fontMap = new Map();
  const fills = [{pattern: 'none'}, {pattern: 'gray125'}], fillMap = new Map([[keyOf({pattern: 'none'}), 0], [keyOf({pattern: 'gray125'}), 1]]);
  const borders = [{}], borderMap = new Map([[keyOf({left: null, right: null, top: null, bottom: null, diagDown: null, diagUp: null}), 0]]);
  const intern = (list, map, item) => { const k = keyOf(item); let i = map.get(k); if (i === undefined) { i = list.length; list.push(item); map.set(k, i); } return i; };
  intern(fonts, fontMap, resolveStyle(table[0]).font);
  let xfs = '';
  for (const st of table) {
    const r = resolveStyle(st);
    const font = intern(fonts, fontMap, r.font);
    const fill = intern(fills, fillMap, r.fill.pattern === 'none' ? {pattern: 'none'} : r.fill);
    const border = intern(borders, borderMap, r.borders);
    const fmt = fmtId(r.numFmt);
    xfs += `<xf numFmtId="${fmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"`;
    if (fmt) xfs += ' applyNumberFormat="1"';
    if (font) xfs += ' applyFont="1"';
    if (fill) xfs += ' applyFill="1"';
    if (border) xfs += ' applyBorder="1"';
    const al = alignmentXml(r.align), pr = protectionXml(r.protection);
    if (al) xfs += ' applyAlignment="1"';
    if (pr) xfs += ' applyProtection="1"';
    xfs += al || pr ? `>${al ?? ''}${pr ?? ''}</xf>` : '/>';
  }
  let dx = '';
  for (const d of dxfs) {
    let s = '<dxf>';
    if (d.font) s += fontXml({...DEFAULT_STYLE.font, size: undefined, ...d.font}, true, d.font);
    if (d.numFmt) { const id = fmtId(d.numFmt); s += `<numFmt numFmtId="${id}" formatCode="${escAttr(d.numFmt)}"/>`; }
    if (d.fill) s += fillXml(d.fill, true);
    if (d.align) s += alignmentXml({...DEFAULT_STYLE.align, ...d.align}) ?? '';
    if (d.borders) s += borderXml(d.borders);
    dx += `${s}</dxf>`;
  }
  let out = `${XML_DECL}<styleSheet xmlns="${NS_MAIN}">`;
  if (custom.length) out += `<numFmts count="${custom.length}">${custom.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${escAttr(c)}"/>`).join('')}</numFmts>`;
  out += `<fonts count="${fonts.length}">${fonts.map(f => fontXml(f)).join('')}</fonts>`;
  out += `<fills count="${fills.length}">${fills.map(f => fillXml(f)).join('')}</fills>`;
  out += `<borders count="${borders.length}">${borders.map(borderXml).join('')}</borders>`;
  out += '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>';
  out += `<cellXfs count="${table.length}">${xfs}</cellXfs>`;
  out += '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>';
  out += `<dxfs count="${dxfs.length}">${dx}</dxfs><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;
  return out;
}

const THEME_SLOTS = [['dk1', 1], ['lt1', 0], ['dk2', 3], ['lt2', 2], ['accent1', 4], ['accent2', 5], ['accent3', 6], ['accent4', 7], ['accent5', 8], ['accent6', 9], ['hlink', 10], ['folHlink', 11]];
/** theme.rs `write_theme`. */
function writeTheme(t0) {
  const t = {...DEFAULT_THEME, ...(t0 ?? {})};
  const name = t.name || 'Craft';
  let s = `${XML_DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${escAttr(name)}"><a:themeElements><a:clrScheme name="${escAttr(name)}">`;
  for (const [slot, i] of THEME_SLOTS) s += `<a:${slot}><a:srgbClr val="${((t.colors?.[i] ?? 0) & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0')}"/></a:${slot}>`;
  s += `</a:clrScheme><a:fontScheme name="${escAttr(name)}"><a:majorFont><a:latin typeface="${escAttr(t.majorFont)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${escAttr(t.minorFont)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>`;
  s += '<a:fmtScheme name="Craft"><a:fillStyleLst>';
  for (let i = 0; i < 3; i++) s += '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  s += '</a:fillStyleLst><a:lnStyleLst>';
  for (const w of [6350, 12700, 19050]) s += `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>`;
  s += '</a:lnStyleLst><a:effectStyleLst>';
  for (let i = 0; i < 3; i++) s += '<a:effectStyle><a:effectLst/></a:effectStyle>';
  s += '</a:effectStyleLst><a:bgFillStyleLst>';
  for (let i = 0; i < 3; i++) s += '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return `${s}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

// ---------------------------------------------------------------------------------------------
// Package writing helpers (write.rs Rels / Sst / Out)

class Rels {
  constructor() { this.list = []; }
  add(type, target, external = false) { const id = `rId${this.list.length + 1}`; this.list.push({id, type: type.includes('://') ? type : REL + type, target, external}); return id; }
  xml() {
    return `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${this.list.map(r =>
      `<Relationship Id="${r.id}" Type="${escAttr(r.type)}" Target="${escAttr(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
  }
}
class Sst {
  constructor() { this.list = []; this.map = new Map(); this.count = 0; }
  index(s) { this.count++; let i = this.map.get(s); if (i === undefined) { i = this.list.length; this.list.push(s); this.map.set(s, i); } return i; }
}

const errorText = v => {
  // #SPILL! and #CALC! are not error codes of the file format; Excel caches them as #VALUE!.
  if (v === ERR.Spill || v === ERR.Calc || v.text === '#SPILL!' || v.text === '#CALC!') return '#VALUE!';
  return v.text;
};
const scalar = v => (v instanceof GArray ? (v.data[0] ?? null) : v);

// ---------------------------------------------------------------------------------------------
// sheet_write.rs

function sheetViews(sheet, selected) {
  let s = '<sheetViews><sheetView';
  if (selected) s += ' tabSelected="1"';
  if (sheet.showGridlines === false) s += ' showGridLines="0"';
  if (sheet.showHeadings === false) s += ' showRowColHeaders="0"';
  if (sheet.showFormulas === true) s += ' showFormulas="1"';
  if (sheet.showZeros === false) s += ' showZeros="0"';
  if (sheet.rightToLeft === true) s += ' rightToLeft="1"';
  if (sheet.view === 'pageBreakPreview' || sheet.view === 'pageLayout') s += ` view="${sheet.view}"`;
  const zoom = sheet.zoom ?? 100;
  if (zoom !== 100 && zoom >= 10 && zoom <= 400) s += ` zoomScale="${zoom}" zoomScaleNormal="${zoom}"`;
  const top = parseCell(sheet.topLeft ?? 'A1') ?? {row: 0, col: 0};
  const rows = sheet.freeze?.rows ?? 0, cols = sheet.freeze?.cols ?? 0;
  if ((top.row || top.col) && !(rows || cols)) s += ` topLeftCell="${a1(top.row, top.col)}"`;
  s += ' workbookViewId="0">';
  const active = sheet.activeCell && parseCell(sheet.activeCell) ? sheet.activeCell : 'A1';
  if (rows > 0 || cols > 0) {
    const pane = rows > 0 && cols > 0 ? 'bottomRight' : rows > 0 ? 'bottomLeft' : 'topRight';
    s += '<pane';
    if (cols > 0) s += ` xSplit="${cols}"`;
    if (rows > 0) s += ` ySplit="${rows}"`;
    s += ` topLeftCell="${a1(Math.min(MAX_ROWS - 1, Math.max(rows, top.row)), Math.min(MAX_COLS - 1, Math.max(cols, top.col)))}" activePane="${pane}" state="frozen"/>`;
    s += `<selection pane="${pane}" activeCell="${active}" sqref="${active}"/>`;
  } else s += `<selection activeCell="${active}" sqref="${active}"/>`;
  return `${s}</sheetView></sheetViews>`;
}

function lineAttrs(info, rowOrCol) {
  let s = '';
  if (rowOrCol === 'col') {
    if (info.s) s += ` style="${info.s}"`;
    if (info.hidden) s += ' hidden="1"';
    if (info.size !== undefined) s += ' customWidth="1"';
  }
  if (info.outline > 0) s += ` outlineLevel="${Math.min(7, info.outline)}"`;
  if (info.collapsed) s += ' collapsed="1"';
  return s;
}

function cfvoXml(v) { return `<cfvo type="${escAttr(v.type ?? 'min')}"${v.val !== undefined ? ` val="${escAttr(v.val)}"` : ''}${v.gte === false ? ' gte="0"' : ''}/>`; }

function writeRules(sheet, dxfs) {
  let s = '';
  const groups = new Map();
  for (const r of sheet.conditionalFormats ?? []) {
    const k = (r.ranges ?? []).join(' ');
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let prio = 0;
  for (const [sqref, rules] of groups) {
    s += `<conditionalFormatting sqref="${escAttr(sqref)}">`;
    for (const entry of rules) {
      prio++;
      const r = {...(entry.rule ?? entry), priority: entry.priority, stopIfTrue: entry.stopIfTrue};
      let a = ` type="${escAttr(r.type ?? 'expression')}"`;
      if (r.dxf) { a += ` dxfId="${dxfs.length}"`; dxfs.push(r.dxf); }
      a += ` priority="${Number.isInteger(r.priority) ? r.priority : prio}"`;
      if (r.stopIfTrue) a += ' stopIfTrue="1"';
      for (const k of ['aboveAverage', 'percent', 'bottom', 'equalAverage']) if (r[k] !== undefined) a += ` ${k}="${r[k] ? 1 : 0}"`;
      for (const k of ['operator', 'text', 'timePeriod', 'rank', 'stdDev']) if (r[k] !== undefined) a += ` ${k}="${escAttr(r[k])}"`;
      let body = (r.formulas ?? []).map(f => `<formula>${esc(toFile(f))}</formula>`).join('');
      if (r.colorScale) body += `<colorScale>${r.colorScale.cfvo.map(cfvoXml).join('')}${r.colorScale.colors.map(c => `<color ${colorAttrs(c)}/>`).join('')}</colorScale>`;
      if (r.dataBar) body += `<dataBar${r.dataBar.showValue === false ? ' showValue="0"' : ''}>${r.dataBar.cfvo.map(cfvoXml).join('')}<color ${colorAttrs(r.dataBar.color ?? '#638EC6')}/></dataBar>`;
      if (r.iconSet) body += `<iconSet iconSet="${escAttr(r.iconSet.iconSet)}"${r.iconSet.showValue === false ? ' showValue="0"' : ''}${r.iconSet.reverse ? ' reverse="1"' : ''}>${r.iconSet.cfvo.map(cfvoXml).join('')}</iconSet>`;
      s += `<cfRule${a}>${body}</cfRule>`;
    }
    s += '</conditionalFormatting>';
  }
  const vs = (sheet.validations ?? []).filter(v => (v.ranges ?? []).length);
  if (vs.length) {
    s += `<dataValidations count="${vs.length}">`;
    for (const v of vs) {
      let a = '';
      if (v.type && v.type !== 'any') a += ` type="${escAttr(v.type)}"`;
      if (v.errorStyle && v.errorStyle !== 'stop') a += ` errorStyle="${escAttr(v.errorStyle)}"`;
      if (v.operator && v.operator !== 'between') a += ` operator="${escAttr(v.operator)}"`;
      if (v.allowBlank) a += ' allowBlank="1"';
      if (v.inCellDropdown === false) a += ' showDropDown="1"';
      if (v.showInputMessage) a += ' showInputMessage="1"';
      if (v.showErrorMessage) a += ' showErrorMessage="1"';
      for (const k of ['errorTitle', 'error', 'promptTitle', 'prompt']) if (v[k]) a += ` ${k}="${escAttr(v[k])}"`;
      a += ` sqref="${escAttr(v.ranges.join(' '))}"`;
      const f = x => (v.type === 'list' && /^"/.test(String(x).trim()) ? String(x).trim() : toFile(x));
      s += `<dataValidation${a}>${v.formula1 !== undefined ? `<formula1>${esc(f(v.formula1))}</formula1>` : ''}${v.formula2 !== undefined ? `<formula2>${esc(f(v.formula2))}</formula2>` : ''}</dataValidation>`;
    }
    s += '</dataValidations>';
  }
  return s;
}

function protectionXmlSheet(p) {
  if (!p || p.enabled === false) return '';
  let s = '<sheetProtection';
  const pw = p.password ?? {};
  for (const k of ['algorithmName', 'hashValue', 'saltValue', 'spinCount', 'password']) if (pw[k] !== undefined) s += ` ${k}="${escAttr(pw[k])}"`;
  s += ' sheet="1"';
  // Attributes say what is protected; the model keeps what is allowed.
  for (const [k, attr, dflt] of [['objects', 'objects', false], ['scenarios', 'scenarios', false], ['formatCells', 'formatCells', true], ['formatColumns', 'formatColumns', true],
    ['formatRows', 'formatRows', true], ['insertColumns', 'insertColumns', true], ['insertRows', 'insertRows', true], ['insertHyperlinks', 'insertHyperlinks', true],
    ['deleteColumns', 'deleteColumns', true], ['deleteRows', 'deleteRows', true], ['sort', 'sort', true], ['autofilter', 'autoFilter', true], ['pivotTables', 'pivotTables', true]]) {
    const allowed = p[k];
    const protectedNow = allowed === undefined ? dflt : !allowed;
    if (protectedNow !== dflt) s += ` ${attr}="${protectedNow ? 1 : 0}"`;
  }
  if (p.selectLocked === false) s += ' selectLockedCells="1"';
  if (p.selectUnlocked === false) s += ' selectUnlockedCells="1"';
  return `${s}/>`;
}

/** Allow Edit Ranges: the ranges that stay editable on a protected sheet, each with its title and optional password. */
function protectedRangesXml(list) {
  const rows = (Array.isArray(list) ? list : []).filter(r => r?.title && (Array.isArray(r.ranges) ? r.ranges : [r.range]).some(x => typeof x === 'string' && parseRange(x)));
  if (!rows.length) return '';
  let s = '<protectedRanges>';
  for (const r of rows) {
    const sq = (Array.isArray(r.ranges) ? r.ranges : [r.range]).filter(x => typeof x === 'string' && parseRange(x)).join(' ');
    s += `<protectedRange sqref="${escAttr(sq)}" name="${escAttr(r.title)}"`;
    const pw = r.password ?? {};
    for (const k of ['algorithmName', 'hashValue', 'saltValue', 'spinCount', 'password']) if (pw[k] !== undefined) s += ` ${k}="${escAttr(pw[k])}"`;
    s += '/>';
  }
  return `${s}</protectedRanges>`;
}

/** The range of a table's own filter (without the totals row), as the sheet AutoFilter over it names it. */
function tableFilterRange(t) {
  const r = parseRange(t.range);
  return r && t.headerRow !== false && t.autoFilter !== false ? rangeA1(rangeOf(r.start.row, r.start.col, r.end.row - (t.totalsRow ? 1 : 0), r.end.col)) : null;
}

function tableXml(t, id, filter, dxfs) {
  const r = parseRange(t.range);
  const cols = t.columns ?? [];
  let s = `${XML_DECL}<table xmlns="${NS_MAIN}" id="${id}" name="${escAttr(t.name)}" displayName="${escAttr(t.name)}" ref="${rangeA1(r)}"`;
  if (t.headerRow === false) s += ' headerRowCount="0"';
  if (t.totalsRow) s += ' totalsRowCount="1"'; else s += ' totalsRowShown="0"';
  s += '>';
  if (t.headerRow !== false && t.autoFilter !== false) {
    const af = rangeOf(r.start.row, r.start.col, r.end.row - (t.totalsRow ? 1 : 0), r.end.col);
    s += filter && filter.range === rangeA1(af) ? autofilterXml(filter, dxfs, escAttr) : `<autoFilter ref="${rangeA1(af)}"/>`;
  }
  s += `<tableColumns count="${cols.length}">`;
  cols.forEach((c, i) => {
    const col = typeof c === 'string' ? {name: c} : c;
    let a = ` id="${i + 1}" name="${escAttr(col.name ?? `Column${i + 1}`)}"`;
    if (col.totalsRowLabel) a += ` totalsRowLabel="${escAttr(col.totalsRowLabel)}"`;
    if (col.totalsRowFunction) a += ` totalsRowFunction="${escAttr(col.totalsRowFunction)}"`;
    let body = '';
    if (col.calculatedColumnFormula) body += `<calculatedColumnFormula>${esc(toFile(col.calculatedColumnFormula))}</calculatedColumnFormula>`;
    if (col.totalsRowFormula) body += `<totalsRowFormula>${esc(toFile(col.totalsRowFormula))}</totalsRowFormula>`;
    s += body ? `<tableColumn${a}>${body}</tableColumn>` : `<tableColumn${a}/>`;
  });
  s += '</tableColumns>';
  const st = t.style ?? {name: 'TableStyleMedium2', showRowStripes: true};
  if (st.name !== null) {
    s += `<tableStyleInfo name="${escAttr(st.name ?? 'TableStyleMedium2')}" showFirstColumn="${st.showFirstColumn ? 1 : 0}" showLastColumn="${st.showLastColumn ? 1 : 0}" showRowStripes="${st.showRowStripes ? 1 : 0}" showColumnStripes="${st.showColumnStripes ? 1 : 0}"/>`;
  }
  return `${s}</table>`;
}

function commentsXml(notes) {
  const authors = [];
  const aid = a => { let i = authors.indexOf(a); if (i < 0) { i = authors.length; authors.push(a); } return i; };
  const entries = Object.entries(notes).map(([ref, n]) => [parseCell(ref), ref, n]).filter(x => x[0]).sort((x, y) => x[0].row - y[0].row || x[0].col - y[0].col);
  let list = '';
  for (const [, ref, n] of entries) {
    const author = n.author ?? '';
    const runs = author ? `<r><rPr><b/><sz val="9"/><color indexed="81"/><rFont val="Tahoma"/></rPr>${tEl(`${author}:\n`)}</r><r><rPr><sz val="9"/><color indexed="81"/><rFont val="Tahoma"/></rPr>${tEl(String(n.text ?? ''))}</r>` : `<r><rPr><sz val="9"/><color indexed="81"/><rFont val="Tahoma"/></rPr>${tEl(String(n.text ?? ''))}</r>`;
    list += `<comment ref="${ref}" authorId="${aid(author)}"><text>${runs}</text></comment>`;
  }
  return `${XML_DECL}<comments xmlns="${NS_MAIN}"><authors>${authors.map(a => `<author>${esc(a)}</author>`).join('')}</authors><commentList>${list}</commentList></comments>`;
}
function vmlXml(notes) {
  let s = '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">'
    + '<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe">'
    + '<v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>';
  let n = 1024;
  for (const ref of Object.keys(notes)) {
    const c = parseCell(ref);
    if (!c) continue;
    n++;
    s += `<v:shape id="_x0000_s${n}" type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:108pt;height:59.25pt;z-index:${n - 1024};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto">`
      + '<v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox>'
      + `<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${c.col + 1}, 15, ${c.row}, 2, ${c.col + 3}, 15, ${c.row + 4}, 16</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${c.row}</x:Row><x:Column>${c.col}</x:Column></x:ClientData></v:shape>`;
  }
  return `${s}</xml>`;
}

/** sheet_write.rs `write_sheet` for sheet `si`. Returns the worksheet XML; adds its parts to `out`. */
function writeSheet(content, si, selected, out, eng) {
  const sheet = content.sheets[si];
  const rels = new Rels();
  const nstyles = Array.isArray(content.styles) && content.styles.length ? content.styles.length : 1;
  const sid = s => (Number.isInteger(s) && s > 0 && s < nstyles ? s : 0);
  // Cells, row-major, with spilled values of dynamic arrays cached in their cells.
  const cells = new Map();   // key row*MAX_COLS+col -> [row, col, cell]
  for (const bk of Object.keys(sheet.blocks ?? {})) {
    const e = blockEntries(sheet.blocks[bk]);
    for (let i = 0; i < e.cells.length; i++) cells.set(e.rows[i] * MAX_COLS + e.cols[i], [e.rows[i], e.cols[i], e.cells[i]]);
  }
  const spills = new Map();  // anchor key -> range
  for (const [k, r] of eng.spillRanges) {
    if (keySheet(k) !== si) continue;
    const ar = keyRow(k), ac = keyCol(k);
    spills.set(ar * MAX_COLS + ac, r);
    let n = 0;
    for (let row = r.start.row; row <= r.end.row && n < 1_000_000; row++) for (let col = r.start.col; col <= r.end.col && n < 1_000_000; col++, n++) {
      if (row === ar && col === ac) continue;
      const key = row * MAX_COLS + col;
      const have = cells.get(key);
      if (!have) cells.set(key, [row, col, null]);
    }
  }
  // Table header cells hold the column names.
  const overrides = new Map();
  for (const t of sheet.tables ?? []) {
    const r = parseRange(t.range);
    if (!r || t.headerRow === false) continue;
    (t.columns ?? []).forEach((c, i) => {
      const key = r.start.row * MAX_COLS + r.start.col + i;
      overrides.set(key, typeof c === 'string' ? c : c.name);
      if (!cells.has(key)) cells.set(key, [r.start.row, r.start.col + i, null]);
    });
  }
  const keys = [...cells.keys()].sort((x, y) => x - y);
  let used = null;
  for (const k of keys) { const [row, col] = cells.get(k); const r = rangeOf(row, col, row, col); used = used ? union(used, r) : r; }

  let s = `${XML_DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`;
  const summary = sheet.summaryBelow === false || sheet.summaryRight === false;
  const fitToPage = needsFitToPage(sheet);
  if (sheet.tabColor || summary || fitToPage) {
    s += '<sheetPr>';
    if (sheet.tabColor) s += `<tabColor ${colorAttrs(sheet.tabColor)}/>`;
    if (summary) s += `<outlinePr${sheet.summaryBelow === false ? ' summaryBelow="0"' : ''}${sheet.summaryRight === false ? ' summaryRight="0"' : ''}/>`;
    if (fitToPage) s += '<pageSetUpPr fitToPage="1"/>';
    s += '</sheetPr>';
  }
  s += `<dimension ref="${used ? rangeA1(used) : 'A1'}"/>`;
  s += sheetViews(sheet, selected);
  const rowsInfo = sheet.rows ?? {}, colsInfo = sheet.cols ?? {};
  const maxOutline = m => Object.values(m).reduce((x, i) => Math.max(x, i?.outline ?? 0), 0);
  s += '<sheetFormatPr';
  if (sheet.defaultColWidth !== undefined && Math.abs(sheet.defaultColWidth - 64) > 0.01) s += ` defaultColWidth="${num(pxToColWidth(sheet.defaultColWidth))}"`;
  s += ` defaultRowHeight="${num(pxToPt(sheet.defaultRowHeight ?? 20))}"`;
  if (sheet.defaultRowHeight !== undefined && Math.abs(sheet.defaultRowHeight - 20) > 0.01) s += ' customHeight="1"';
  if (maxOutline(rowsInfo)) s += ` outlineLevelRow="${maxOutline(rowsInfo)}"`;
  if (maxOutline(colsInfo)) s += ` outlineLevelCol="${maxOutline(colsInfo)}"`;
  s += '/>';
  const colKeys = Object.keys(colsInfo).map(Number).filter(c => Number.isInteger(c) && c >= 0 && c < MAX_COLS).sort((x, y) => x - y);
  if (colKeys.length) {
    s += '<cols>';
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    let run = null;
    const flush = ([a, b, info]) => { s += `<col min="${a + 1}" max="${b + 1}" width="${num(pxToColWidth(info.size ?? sheet.defaultColWidth ?? 64))}"${lineAttrs({...info, s: sid(info.s)}, 'col')}/>`; };
    for (const c of colKeys) {
      const info = colsInfo[c];
      if (run && run[1] + 1 === c && same(run[2], info)) run[1] = c;
      else { if (run) flush(run); run = [c, c, info]; }
    }
    if (run) flush(run);
    s += '</cols>';
  }
  // sheetData
  s += '<sheetData>';
  const rowKeys = new Set(Object.keys(rowsInfo).map(Number));
  for (const k of keys) rowKeys.add(Math.floor(k / MAX_COLS));
  const byRow = new Map();
  for (const k of keys) { const r = Math.floor(k / MAX_COLS); if (!byRow.has(r)) byRow.set(r, []); byRow.get(r).push(k); }
  for (const row of [...rowKeys].filter(r => Number.isInteger(r) && r >= 0 && r < MAX_ROWS).sort((x, y) => x - y)) {
    const info = rowsInfo[row] ?? {};
    const list = byRow.get(row) ?? [];
    if (!list.length && !Object.keys(info).length) continue;
    s += `<row r="${row + 1}"`;
    if (info.s) s += ` s="${sid(info.s)}" customFormat="1"`;
    if (info.size !== undefined) s += ` ht="${num(pxToPt(info.size))}"${info.custom ? ' customHeight="1"' : ''}`;
    if (info.hidden) s += ' hidden="1"';
    s += lineAttrs(info, 'row');
    if (!list.length) { s += '/>'; continue; }
    s += '>';
    for (const k of list) s += cellXml(cells.get(k), si, sheet, eng, out, sid, overrides.get(k), spills.get(k));
    s += '</row>';
  }
  s += '</sheetData>';
  s += protectionXmlSheet(sheet.protection);
  s += protectedRangesXml(sheet.editRanges);
  if (sheet.autofilter?.range && !(sheet.tables ?? []).some(t => tableFilterRange(t) === sheet.autofilter.range)) s += autofilterXml(sheet.autofilter, out.dxfs, escAttr);
  const merges = (sheet.merges ?? []).filter(m => parseRange(m));
  if (merges.length) s += `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`;
  s += writeRules(sheet, out.dxfs);
  // Hyperlinks: one per cell, external targets as relationships.
  const links = Object.entries(sheet.hyperlinks ?? {}).filter(([ref, l]) => parseCell(ref) && (l?.target || l?.location));
  if (links.length) {
    s += '<hyperlinks>';
    for (const [ref, l] of links) {
      let a = ` ref="${ref}"`;
      if (l.target) a += ` r:id="${rels.add('hyperlink', l.target, true)}"`;
      if (l.location) a += ` location="${escAttr(l.location)}"`;
      if (l.tooltip) a += ` tooltip="${escAttr(l.tooltip)}"`;
      if (l.display) a += ` display="${escAttr(l.display)}"`;
      s += `<hyperlink${a}/>`;
    }
    s += '</hyperlinks>';
  }
  s += pageSetupXml(sheet);
  const ignored = (sheet.ignoredErrors ?? []).filter(r => parseCell(r));
  if (ignored.length) s += `<ignoredErrors><ignoredError sqref="${escAttr(ignored.join(' '))}" evalError="1"/></ignoredErrors>`;
  // The Watch Window's cells (Formulas > Watch Window) are the sheet's cellWatches.
  const watches = (sheet.watches ?? []).filter(r => parseCell(r));
  if (watches.length) s += `<cellWatches>${watches.map(r => `<cellWatch r="${escAttr(r)}"/>`).join('')}</cellWatches>`;
  // Charts, pictures and shapes: one drawing part, a chart part per chart and a media part per picture.
  const objs = sheetObjects(sheet).map(({kind, object}) => (kind === 'slicer' ? out.slw?.drawingObject(si, object) : {type: kind, object})).filter(Boolean);
  if (objs.length) {
    const n = ++out.drawings;
    const drels = new Rels();
    for (const o of objs) {
      if (o.type === 'chart') { const cn = ++out.charts; out.part(`xl/charts/chart${cn}.xml`, CT.chart, chartXml(content, si, o.object)); o.rid = drels.add('chart', `../charts/chart${cn}.xml`); }
      else if (o.type === 'image') { const mn = ++out.media; const {bytes, ext} = pictureFile(o.object); out.part(`xl/media/image${mn}.${ext}`, null, bytes); out.mediaExt.add(ext); o.rid = drels.add('image', `../media/image${mn}.${ext}`); }
    }
    out.part(`xl/drawings/drawing${n}.xml`, CT.drawing, drawingXml(sheet, content.theme ?? DEFAULT_THEME, objs));
    out.raw(`xl/drawings/_rels/drawing${n}.xml.rels`, drels.xml());
    s += `<drawing r:id="${rels.add('drawing', `../drawings/drawing${n}.xml`)}"/>`;
  }
  // Threaded comments: the thread part and, for readers without it, a legacy note authored `tc=<thread id>`.
  const notes = {...(sheet.notes ?? {})};
  const threads = Object.entries(sheet.comments ?? {}).filter(([ref, c]) => parseCell(ref) && c && c.threaded !== false);
  if (threads.length) {
    const {xml, ids} = threadedXml(threads, out.persons);
    const tn = ++out.threaded;
    out.part(`xl/threadedComments/threadedComment${tn}.xml`, CT.threaded, xml);
    rels.add('http://schemas.microsoft.com/office/2017/10/relationships/threadedComment', `../threadedComments/threadedComment${tn}.xml`);
    for (const [ref, c] of threads) notes[ref] = {author: `tc=${ids.get(ref)}`, text: placeholderNote(c)};
  }
  if (Object.keys(notes).length) {
    const n = ++out.comments;
    out.part(`xl/comments${n}.xml`, CT.comments, commentsXml(notes));
    rels.add('comments', `../comments${n}.xml`);
    out.vml = true;
    out.part(`xl/drawings/vmlDrawing${n}.vml`, null, vmlXml(notes));
    s += `<legacyDrawing r:id="${rels.add('vmlDrawing', `../drawings/vmlDrawing${n}.vml`)}"/>`;
  }
  const tables = (sheet.tables ?? []).filter(t => parseRange(t.range));
  if (tables.length) {
    let parts = '';
    for (const t of tables) {
      const n = ++out.tables;
      out.part(`xl/tables/table${n}.xml`, CT.table, tableXml(t, n, sheet.autofilter, out.dxfs));
      (out.tableIds ??= new Map()).set(String(t.name).toLowerCase(), n);
      parts += `<tablePart r:id="${rels.add('table', `../tables/table${n}.xml`)}"/>`;
    }
    s += `<tableParts count="${tables.length}">${parts}</tableParts>`;
  }
  s += mergeExt(sparklinesExt(sheet, content.theme ?? DEFAULT_THEME), out.slw?.sheetParts(si, out, rels));
  s += '</worksheet>';
  return {xml: s, rels};
}

function cellXml([row, col, cell], si, sheet, eng, out, sid, override, spill) {
  const ref = a1(row, col);
  const style = sid(cell?.s);
  let s = `<c r="${ref}"${style ? ` s="${style}"` : ''}`;
  if (override !== undefined) { const i = out.sst.index(String(override)); return `${s} t="s"><v>${i}</v></c>`; }
  const formula = cell?.f;
  let value = formula !== undefined || !cell || cell.v === undefined ? scalar(eng.sheetValue(si, row, col)) : cell.v;
  if (value && typeof value === 'object' && !(value instanceof CellError) && typeof value.e === 'string') value = parseError(value.e) ?? ERR.Value;
  if (value instanceof CellError && value.text === '#CIRC!') value = 0;
  if (formula !== undefined) {
    const multi = spill && !(spill.start.row === spill.end.row && spill.start.col === spill.end.col);
    const text = esc(toFile(formula));
    // A formula with `@` is evaluated as an array in the file (array_formula.rs `needs_array`).
    const dynamic = !cell.a && (cell.d === true || multi || text.includes('_xlfn.SINGLE(')) ? (multi ? spill : rangeOf(row, col, row, col)) : null;
    if (dynamic) { s += ' cm="1"'; out.dynamicArrays = true; }
    const t = typeof value === 'string' ? ' t="str"' : typeof value === 'boolean' ? ' t="b"' : value instanceof CellError ? ' t="e"' : '';
    s += `${t}>`;
    if (cell.a) s += `<f t="array" ref="${cell.a}">${text}</f>`;
    else if (dynamic) s += `<f t="array" ref="${rangeA1(dynamic)}">${text}</f>`;
    else s += `<f>${text}</f>`;
    if (typeof value === 'number' && Number.isFinite(value)) s += `<v>${num(value)}</v>`;
    else if (typeof value === 'string') s += `<v>${esc(encodeXString(value))}</v>`;
    else if (typeof value === 'boolean') s += `<v>${value ? 1 : 0}</v>`;
    else if (value instanceof CellError) s += `<v>${errorText(value)}</v>`;
    else out.needsCalc = true;
    return `${s}</c>`;
  }
  if (value === null || value === undefined || value === '') return `${s}/>`;
  if (typeof value === 'number') return Number.isFinite(value) ? `${s}><v>${num(value)}</v></c>` : `${s}/>`;
  if (typeof value === 'string') return `${s} t="s"><v>${out.sst.index(value)}</v></c>`;
  if (typeof value === 'boolean') return `${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  if (value instanceof CellError) return `${s} t="e"><v>${errorText(value)}</v></c>`;
  return `${s}/>`;
}

// ---------------------------------------------------------------------------------------------
// write.rs `write_xlsx_named`

/** The workbook as .xlsx bytes. */
export async function writeXlsx(content) {
  if (!Array.isArray(content?.sheets) || !content.sheets.length) throw new Error('a workbook needs at least one sheet');
  const eng = engineFor(content);
  const parts = [];
  const overrides = [];
  const out = {
    sst: new Sst(), dxfs: [], comments: 0, threaded: 0, persons: new Map(), tables: 0, drawings: 0, charts: 0, media: 0, mediaExt: new Set(), dynamicArrays: false, needsCalc: false, vml: false,
    raw(name, data) { parts.push([name, data]); },
    part(name, ct, data) { parts.push([name, data]); if (ct) overrides.push([`/${name}`, ct]); },
  };
  const sheets = content.sheets;
  const activeIndex = Math.max(0, sheets.findIndex(s => s.id === content.activeSheetId));
  const active = sheets[activeIndex] && !sheets[activeIndex].hidden ? activeIndex : Math.max(0, sheets.findIndex(s => !s.hidden));
  const wbRels = new Rels();
  const pivots = new PivotWriter();
  out.slw = new SlicerWriter(content);
  let sheetsXml = '';
  sheets.forEach((sheet, i) => {
    const {xml, rels} = writeSheet(content, i, i === active, out, eng);
    pivots.addSheet(content, i, out, rels);
    out.part(`xl/worksheets/sheet${i + 1}.xml`, CT.sheet, xml);
    if (rels.list.length) parts.push([`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, rels.xml()]);
    const rid = wbRels.add('worksheet', `worksheets/sheet${i + 1}.xml`);
    sheetsXml += `<sheet name="${escAttr(sheet.name)}" sheetId="${i + 1}"${sheet.hidden === 'hidden' || sheet.hidden === 'veryHidden' ? ` state="${sheet.hidden}"` : ''} r:id="${rid}"/>`;
  });
  const slicerOut = out.slw.finish(out, wbRels, pivots, out.tableIds ?? new Map());
  // Defined names (print areas as _xlnm.Print_Area of their sheet).
  let names = '';
  const idx = id => sheets.findIndex(s => s.id === id);
  for (const n of content.names ?? []) {
    const scope = n.scope ? idx(n.scope) : -1;
    if (n.scope && scope < 0) continue;
    let a = ` name="${escAttr(n.name)}"`;
    if (n.comment) a += ` comment="${escAttr(n.comment)}"`;
    if (scope >= 0) a += ` localSheetId="${scope}"`;
    if (n.hidden) a += ' hidden="1"';
    names += `<definedName${a}>${esc(toFile(String(n.formula ?? '').replace(/^=/, '')))}</definedName>`;
  }
  names += slicerOut.names;
  sheets.forEach((sh, i) => {
    if (sh.printArea) {
      const q = quoteSheet(sh.name);
      const areas = String(sh.printArea).split(',').map(x => parseRange(x.trim())).filter(Boolean)
        .map(r => `${q}!$${colToLetters(r.start.col)}$${r.start.row + 1}:$${colToLetters(r.end.col)}$${r.end.row + 1}`);
      if (areas.length) names += `<definedName name="_xlnm.Print_Area" localSheetId="${i}">${esc(areas.join(','))}</definedName>`;
    }
    if (sh.printTitles) names += `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${esc(sh.printTitles)}</definedName>`;
  });
  let w = `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/><workbookPr`;
  if (content.dateSystem === 1904) w += ' date1904="1"';
  w += '/>';
  if (content.protection?.structure) {
    w += '<workbookProtection lockStructure="1"';
    const pw = content.protection.password ?? {};
    for (const [k, attr] of [['algorithmName', 'workbookAlgorithmName'], ['hashValue', 'workbookHashValue'], ['saltValue', 'workbookSaltValue'], ['spinCount', 'workbookSpinCount'], ['password', 'workbookPassword']]) if (pw[k] !== undefined) w += ` ${attr}="${escAttr(pw[k])}"`;
    w += '/>';
  }
  w += `<bookViews><workbookView activeTab="${active}"/></bookViews><sheets>${sheetsXml}</sheets>`;
  if (names) w += `<definedNames>${names}</definedNames>`;
  w += '<calcPr calcId="191029"';
  const calc = content.calc ?? {};
  if (calc.mode === 'manual') w += ' calcMode="manual"';
  else if (calc.mode === 'autoNoTables') w += ' calcMode="autoNoTable"';
  if (calc.iterative) w += ' iterate="1"';
  if (calc.iterative || (calc.maxIterations !== undefined && calc.maxIterations !== 100)) w += ` iterateCount="${calc.maxIterations ?? 100}"`;
  if (calc.iterative || (calc.maxChange !== undefined && calc.maxChange !== 0.001)) w += ` iterateDelta="${num(calc.maxChange ?? 0.001)}"`;
  if (out.needsCalc) w += ' fullCalcOnLoad="1"';
  w += `/>${pivots.workbookXml(wbRels)}${slicerOut.ext}</workbook>`;

  out.part('xl/styles.xml', CT.styles, writeStyles(content, out.dxfs));
  if (out.persons.size) {
    out.part('xl/persons/person.xml', CT.persons, personsXml(out.persons));
    wbRels.add('http://schemas.microsoft.com/office/2017/10/relationships/person', 'persons/person.xml');
  }
  wbRels.add('styles', 'styles.xml');
  out.part('xl/theme/theme1.xml', CT.theme, writeTheme(content.theme));
  wbRels.add('theme', 'theme/theme1.xml');
  let sst = `${XML_DECL}<sst xmlns="${NS_MAIN}" count="${out.sst.count}" uniqueCount="${out.sst.list.length}">`;
  for (const t of out.sst.list) sst += `<si>${tEl(t)}</si>`;
  out.part('xl/sharedStrings.xml', CT.sst, `${sst}</sst>`);
  wbRels.add('sharedStrings', 'sharedStrings.xml');
  if (out.dynamicArrays) {
    out.part('xl/metadata.xml', CT.metadata, METADATA);
    wbRels.add('sheetMetadata', 'metadata.xml');
  }
  out.part('xl/workbook.xml', CT.workbook, w);
  parts.push(['xl/_rels/workbook.xml.rels', wbRels.xml()]);
  const p = content.properties ?? {};
  let core = `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`;
  for (const [tag, v] of [['dc:title', p.title], ['dc:subject', p.subject], ['dc:creator', p.author], ['cp:keywords', p.keywords], ['dc:description', p.description]]) if (v) core += `<${tag}>${esc(v)}</${tag}>`;
  out.part('docProps/core.xml', CT.core, `${core}</cp:coreProperties>`);
  out.part('docProps/app.xml', CT.app, `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Excel</Application>${p.company ? `<Company>${esc(p.company)}</Company>` : ''}</Properties>`);
  const root = new Rels();
  root.add('officeDocument', 'xl/workbook.xml');
  root.add('http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml');
  root.add('extended-properties', 'docProps/app.xml');
  parts.push(['_rels/.rels', root.xml()]);
  let ct = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`;
  if (out.vml) ct += '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>';
  for (const ext of out.mediaExt) ct += `<Default Extension="${ext}" ContentType="${MIME_FOR_EXT[ext] ?? 'application/octet-stream'}"/>`;
  for (const [name, t] of overrides) ct += `<Override PartName="${escAttr(name)}" ContentType="${escAttr(t)}"/>`;
  ct += '</Types>';
  const zip = new JSZip();
  zip.file('[Content_Types].xml', ct);
  const rank = n => (n === '_rels/.rels' ? 0 : n === 'xl/_rels/workbook.xml.rels' ? 1 : n === 'xl/workbook.xml' ? 2 : n.startsWith('docProps/') ? 4 : 3);
  parts.sort((x, y) => rank(x[0]) - rank(y[0]));
  for (const [name, data] of parts) zip.file(name, data);
  return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE', compressionOptions: {level: 6}});
}

/** Format module: the document as .xlsx bytes. */
export function write(file) {
  return writeXlsx(file.content ?? file);
}
