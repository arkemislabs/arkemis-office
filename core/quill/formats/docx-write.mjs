// Quill schema-2 content → DOCX (WordprocessingML): what File > Save, Save As and AutoSave write
// for a Word Document, read back by docx-read.mjs.
//
// Translated from wordcraft crates/docx (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c):
//   src/write.rs              PartRels, the Writer state, media names, note ids, header/footer files
//   src/write/parts.rs        the package: document, headers/footers, notes, comments (+ Extended/Ids/
//                             Extensible), styles, numbering, settings, theme, media, core/app/custom
//                             properties, content types
//   src/write/props.rs        w:rPr / w:pPr / w:tblPr / w:trPr / w:tcPr in schema order
//   src/write/styles.rs       styles.xml and numbering.xml
//   src/write/settings.rs     settings.xml, theme, comment ids, core and app properties
//   src/write/sdt.rs          content controls: the nesting plan and w:sdt
//   src/write/story/blocks.rs, story/para.rs, story/field.rs, story/object.rs, story/section.rs,
//   story/drawing.rs (pictures: wp:inline / wp:anchor, pic:pic)
//   src/write/story/toc.rs    the engine's TOC (a heading ending in an empty TOC field, then TOC1..TOC9
//                             entries) inside Word's Table of Contents control, the field opening in the
//                             first entry and ending after the last (with blocks.rs/para.rs/field.rs hooks)
//   src/write/parts.rs        the bibliography part (customXml/itemN.xml + itemPropsN.xml; the XML itself
//                             is _docx-bibliography.mjs, from write/bibliography.rs)
//   src/write/watermark.rs    the text watermark as Word's VML text shape in every header
//   src/write/math.rs         (math_pr only) settings.xml m:mathPr
//   src/custom.rs             custom document properties
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// What differs from upstream (and why) — see docx-read.mjs: drawings the model doesn't translate
// yet come back as `opaque` objects whose XML and parts are written back verbatim; equations write
// the OMML they were read with; every paragraph carries `w14:paraId` from its stable id
// (architecture 14.2). Not yet translated: the bidi run splitting of write/bidi.rs, settings
// merging (write/settings_merge.rs), the glossary writer (a glossary read from a file is kept
// verbatim), and shapes/charts/SmartArt written from the model. Kept custom XML parts keep their
// names, so the bibliography part takes the first free customXml/itemN.xml (upstream renames the
// kept part to item1_2.xml instead).
// No DOM; jszip is the one dependency (architecture 5.3).

import JSZip from 'jszip';
import {
  W, esc, bodyNs, parseXml, RT, relativePath, relsPathOf, fromBase64, toBase64, KEPT_PARTS, EMBEDDED_PARTS, APP_KEPT, APP_KEPT_PROPS,
  REL_MARK, LOWER_NAMES, PROTECTION_HASH_ATTRS, durableIdOk, MAX_LEN_PT, isToc, CUSTOM_SIMPLE,
} from './docx-read.mjs';
import {bibliographyXml, bibliographyPropsXml} from './_docx-bibliography.mjs';
import {Document} from '../model/document.mjs';
import {settingsOf, defaultCore, THEME_COLORS, DEFAULT_HYPHENATION_ZONE, DEFAULT_GRID, watermarkFrame, defaultWatermark, watermarkDrawn} from '../model/content.mjs';
import {sectionOf} from '../model/section.mjs';
import {
  rgbHex, highlightOoxml, underlineOoxml, borderStyleOoxml, ligaturesOoxml, textDirectionOoxml, textDirectionIsTurned, charFormatting, charIsEmpty,
  paraIsEmpty, tableLook, tableFloatDist, charOverlaid, DEFAULT_FONT_SIZE,
} from '../model/props.mjs';
import {TABLE_PARTS, tablePart} from '../model/styles.mjs';
import {controlEvents, pairEvents, controlLockOoxml, listItemValue} from '../model/ranges.mjs';
import {OBJ} from '../model/text.mjs';
import {floatAlignOoxml, groupRects} from '../model/para.mjs';
import {textVertOoxml, anchorOoxml} from '../model/props.mjs';
import {isConnector} from '../model/connector.mjs';
import {linearToOmml} from '../lib/omml.mjs';
import {diagramParts, DIAGRAM_URI, DGM_RT, CT_DATA, CT_LAYOUT, CT_STYLE, CT_COLORS, CT_DRAWING} from '../lib/docx-smartart.mjs';
import {NS_DGM} from '../../prism/lib/dgm.mjs';
import {presetOfKind} from '../lib/shape-presets.mjs';
import {chartPart, chartWorkbook, CHART_CT, CHART_URI, XLSX_CT, REL_PACKAGE} from '../lib/chart-part.mjs';
import {toTwips, toEmu, toHalfPoints, finite, normalizeDegrees, Spin} from '../lib/geom.mjs';
import {writeFill, writeEffects} from './_docx-shape-fx.mjs';
import {writeTextEffects} from './_docx-text-fx.mjs';
import {parse as parsePath} from '../../prism/lib/points.mjs';

export const UPSTREAM = Object.freeze({repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/docx/src/write.rs']});

const CT_WML = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
export const MAIN_CONTENT_TYPE = `${CT_WML}document.main+xml`;
const MAX_DEPTH = 24;
const clampLen = v => Math.max(-MAX_LEN_PT, Math.min(MAX_LEN_PT, finite(v)));
/** Points → twips string (units.rs `twips`). */
export const twips = pt => String(toTwips(clampLen(pt)));
/** Points → EMU string. */
export const emu = pt => String(toEmu(clampLen(pt)));
const n = v => String(Math.round(v));
const round = v => Math.max(-1e9, Math.min(1e9, Math.round(finite(v))));
const isOn = v => v === true;

// =============================================================================================
// write.rs: PartRels
// =============================================================================================

export class PartRels {
  constructor(part) { this.part = part; this.list = []; this.index = new Map(); }
  add(kind, target, external) {
    const key = `${kind}\u0000${target}\u0000${external ? 1 : 0}`;
    if (this.index.has(key)) return this.index.get(key);
    const id = `rId${this.list.length + 1}`;
    this.list.push([id, kind, target, external]);
    this.index.set(key, id);
    return id;
  }
  isEmpty() { return !this.list.length; }
  xml() {
    const w = new W();
    w.open('Relationships', [['xmlns', 'http://schemas.openxmlformats.org/package/2006/relationships']]);
    for (const [id, kind, target, external] of this.list) {
      w.empty('Relationship', external ? [['Id', id], ['Type', kind], ['Target', target], ['TargetMode', 'External']] : [['Id', id], ['Type', kind], ['Target', target]]);
    }
    w.close('Relationships');
    return w.toString();
  }
}

// =============================================================================================
// write/props.rs
// =============================================================================================

function toggle(w, name, v) {
  if (v === true) w.empty(name);
  else if (v === false) w.val(name, '0');
}
const colorHex = c => (Array.isArray(c) ? rgbHex(c) : null);

/** `w:rPr` content (without the wrapper). Link and revision marks are not run properties. */
export function rprInner(w, c) {
  if (c.style) w.val('w:rStyle', c.style);
  const fonts = [];
  if (c.font) fonts.push(['w:ascii', c.font], ['w:hAnsi', c.font]);
  if (c.fontEa) fonts.push(['w:eastAsia', c.fontEa]);
  if (c.fontCs) fonts.push(['w:cs', c.fontCs]);
  if (fonts.length) w.empty('w:rFonts', fonts);
  toggle(w, 'w:b', c.bold);
  toggle(w, 'w:bCs', c.boldCs);
  toggle(w, 'w:i', c.italic);
  toggle(w, 'w:iCs', c.italicCs);
  toggle(w, 'w:caps', c.caps);
  toggle(w, 'w:smallCaps', c.smallCaps);
  toggle(w, 'w:strike', c.strike);
  toggle(w, 'w:dstrike', c.doubleStrike);
  toggle(w, 'w:outline', c.outline);
  toggle(w, 'w:shadow', c.shadow);
  toggle(w, 'w:emboss', c.emboss);
  toggle(w, 'w:imprint', c.engrave);
  toggle(w, 'w:noProof', c.noProof);
  toggle(w, 'w:vanish', c.hidden);
  if (c.color === 'Auto') w.val('w:color', 'auto');
  else if (c.color?.Rgb) w.val('w:color', rgbHex(c.color.Rgb));
  if (typeof c.spacing === 'number') w.val('w:spacing', twips(Math.max(-1584, Math.min(1584, c.spacing))));
  if (typeof c.scale === 'number') w.val('w:w', n(round(Math.max(1, Math.min(600, c.scale)))));
  if (typeof c.kern === 'number') w.val('w:kern', String(toHalfPoints(Math.max(0, Math.min(1638, c.kern)))));
  if (typeof c.position === 'number') w.val('w:position', String(toHalfPoints(Math.max(-1584, Math.min(1584, c.position)))));
  const half = s => String(Math.max(2, toHalfPoints(Math.max(1, Math.min(1638, s)))));
  if (typeof c.size === 'number') w.val('w:sz', half(c.size));
  if (typeof c.sizeCs === 'number') w.val('w:szCs', half(c.sizeCs));
  if (c.highlight) w.val('w:highlight', c.highlight === 'none' ? 'none' : highlightOoxml(c.highlight));
  if (c.underline && c.underlineColor) w.empty('w:u', [['w:val', underlineOoxml(c.underline)], ['w:color', rgbHex(c.underlineColor)]]);
  else if (c.underline) w.val('w:u', underlineOoxml(c.underline));
  else if (c.underlineColor) w.empty('w:u', [['w:color', rgbHex(c.underlineColor)]]);
  if (c.border) borderEl(w, 'w:bdr', c.border);
  if (Array.isArray(c.shading)) w.empty('w:shd', [['w:val', 'clear'], ['w:color', 'auto'], ['w:fill', rgbHex(c.shading)]]);
  if (c.vertAlign) w.val('w:vertAlign', c.vertAlign === 'superscript' ? 'superscript' : c.vertAlign === 'subscript' ? 'subscript' : 'baseline');
  toggle(w, 'w:rtl', c.rtl);
  toggle(w, 'w:cs', c.cs);
  const lang = [];
  if (c.lang) lang.push(['w:val', c.lang]);
  if (c.langEa) lang.push(['w:eastAsia', c.langEa]);
  if (c.langBidi) lang.push(['w:bidi', c.langBidi]);
  if (lang.length) w.empty('w:lang', lang);
  if (c.eastAsianLayout) eastAsianLayout(w, c.eastAsianLayout);
  writeTextEffects(w, c.textEffects);
  for (const x of c.textEffects?.xml ?? []) w.raw(x);
  if (c.ligatures) w.empty('w14:ligatures', [['w14:val', ligaturesOoxml(c.ligatures)]]);
}
function eastAsianLayout(w, l) {
  const on = v => (v ? '1' : '0');
  const a = [];
  if (Number.isInteger(l.id)) a.push(['w:id', String(l.id)]);
  if (typeof l.combine === 'boolean') a.push(['w:combine', on(l.combine)]);
  if (l.combineBrackets) a.push(['w:combineBrackets', l.combineBrackets]);
  if (typeof l.vert === 'boolean') a.push(['w:vert', on(l.vert)]);
  if (typeof l.vertCompress === 'boolean') a.push(['w:vertCompress', on(l.vertCompress)]);
  w.empty('w:eastAsianLayout', a);
}
/** Does `c` produce any `w:rPr` content (besides a tracked change)? */
export const hasRpr = c => !charIsEmpty(stripUndef(charFormatting(c || {})));
const stripUndef = o => { const r = {}; for (const k in o) if (o[k] !== undefined && o[k] !== null) r[k] = o[k]; return r; };
export function rpr(w, c) {
  if (hasRpr(c)) { w.open('w:rPr'); rprInner(w, c); w.close('w:rPr'); }
}
export const alignVal = a => ({center: 'center', right: 'right', justify: 'both', distribute: 'distribute'})[a] ?? 'left';
export const tabLeaderVal = l => ({dot: 'dot', hyphen: 'hyphen', underscore: 'underscore', middleDot: 'middleDot'})[l] ?? 'none';
function borderEl(w, name, b) {
  const sz = n(round(Math.max(0, Math.min(12, finite(b.width ?? 0))) * 8));
  const space = n(round(Math.max(0, Math.min(31, finite(b.space ?? 0)))));
  const color = Array.isArray(b.color) ? rgbHex(b.color) : 'auto';
  const style = !b.style || b.style === 'none' ? 'nil' : borderStyleOoxml(b.style);
  w.empty(name, [['w:val', style], ['w:sz', sz], ['w:space', space], ['w:color', color]]);
}
/** Borders element; `inner` names the between/insideH element (null for page borders). */
export function borders(w, tag, b, inner, extra = []) {
  w.open(tag, extra);
  for (const [k, el] of [['top', 'w:top'], ['left', 'w:left'], ['bottom', 'w:bottom'], ['right', 'w:right']]) if (b[k]) borderEl(w, el, b[k]);
  if (inner) {
    if (b.between) borderEl(w, inner, b.between);
    if (inner === 'w:insideH' && b.inside_v) borderEl(w, 'w:insideV', b.inside_v);
    if (b.diagDown) borderEl(w, 'w:tl2br', b.diagDown);
    if (b.diagUp) borderEl(w, 'w:tr2bl', b.diagUp);
  }
  w.close(tag);
}
const shd = (w, c) => w.empty('w:shd', [['w:val', 'clear'], ['w:color', 'auto'], ['w:fill', rgbHex(c)]]);

/** `w:pPr` content without the mark `w:rPr` and `w:sectPr`. */
export function pprInner(w, p, framed = false, numChange = null) {
  if (p.style) w.val('w:pStyle', p.style);
  toggle(w, 'w:keepNext', p.keepNext);
  toggle(w, 'w:keepLines', p.keepLines);
  toggle(w, 'w:pageBreakBefore', p.pageBreakBefore);
  writeFrame(w, p, framed);
  toggle(w, 'w:widowControl', p.widowControl);
  if (p.numbering) {
    w.open('w:numPr');
    w.val('w:ilvl', n(Math.min(p.numbering.level ?? 0, 8)));
    w.val('w:numId', n(p.numbering.num));
    if (numChange) w.empty('w:numberingChange', numChange);
    w.close('w:numPr');
  }
  toggle(w, 'w:suppressLineNumbers', p.suppressLineNumbers);
  if (p.borders) borders(w, 'w:pBdr', p.borders, 'w:between');
  if (Array.isArray(p.shading)) shd(w, p.shading);
  if (p.tabs?.length) {
    w.open('w:tabs');
    for (const t of p.tabs.slice(0, 64)) {
      const val = ['left', 'center', 'right', 'decimal', 'bar', 'clear'].includes(t.align) ? t.align : 'left';
      if (!t.leader || t.leader === 'none') w.empty('w:tab', [['w:val', val], ['w:pos', twips(t.pos)]]);
      else w.empty('w:tab', [['w:val', val], ['w:leader', tabLeaderVal(t.leader)], ['w:pos', twips(t.pos)]]);
    }
    w.close('w:tabs');
  }
  toggle(w, 'w:suppressAutoHyphens', p.suppressHyphens);
  toggle(w, 'w:kinsoku', p.kinsoku);
  toggle(w, 'w:wordWrap', p.wordWrap);
  toggle(w, 'w:overflowPunct', p.overflowPunct);
  toggle(w, 'w:topLinePunct', p.topLinePunct);
  toggle(w, 'w:autoSpaceDE', p.autoSpaceDE);
  toggle(w, 'w:autoSpaceDN', p.autoSpaceDN);
  toggle(w, 'w:bidi', p.bidi);
  toggle(w, 'w:snapToGrid', p.snapToGrid);
  writeSpacing(w, p);
  writeIndentation(w, p);
  toggle(w, 'w:contextualSpacing', p.contextualSpacing);
  toggle(w, 'w:mirrorIndents', p.mirrorIndents);
  if (p.align) w.val('w:jc', alignVal(p.align));
  if (typeof p.outlineLevel === 'number') w.val('w:outlineLvl', n(Math.min(p.outlineLevel, 9)));
}
function writeFrame(w, p, framed) {
  if (framed && p.dropCap > 0) {
    const a = [['w:dropCap', p.dropCapMargin === true ? 'margin' : 'drop'], ['w:lines', n(Math.min(p.dropCap, 10))]];
    if (Number.isFinite(p.dropCapDistance) && p.dropCapDistance > 0) a.push(['w:hSpace', twips(Math.min(p.dropCapDistance, 1584))]);
    a.push(['w:wrap', 'around'], ['w:vAnchor', 'text'], ['w:hAnchor', 'text']);
    w.empty('w:framePr', a);
  } else if (p.frame) {
    const f = p.frame;
    const a = [];
    if (typeof f.w === 'number') a.push(['w:w', twips(f.w)]);
    if (typeof f.h === 'number') a.push(['w:h', twips(f.h)], ['w:hRule', f.hExact ? 'exact' : 'atLeast']);
    if (f.hSpace > 0) a.push(['w:hSpace', twips(f.hSpace)]);
    if (f.vSpace > 0) a.push(['w:vSpace', twips(f.vSpace)]);
    a.push(['w:wrap', f.wrap ?? 'auto'], ['w:vAnchor', f.vAnchor ?? 'page'], ['w:hAnchor', f.hAnchor ?? 'page']);
    a.push(f.xAlign ? ['w:xAlign', f.xAlign] : ['w:x', twips(f.x ?? 0)]);
    a.push(f.yAlign ? ['w:yAlign', f.yAlign] : ['w:y', twips(f.y ?? 0)]);
    w.empty('w:framePr', a);
  }
}
function writeSpacing(w, p) {
  const has = ['spaceBefore', 'spaceAfter', 'lineSpacing', 'spaceBeforeAuto', 'spaceAfterAuto'].some(k => p[k] !== undefined && p[k] !== null);
  if (!has) return;
  const a = [];
  if (typeof p.spaceBefore === 'number') a.push(['w:before', twips(Math.max(0, p.spaceBefore))]);
  if (typeof p.spaceBeforeAuto === 'boolean') a.push(['w:beforeAutospacing', p.spaceBeforeAuto ? '1' : '0']);
  if (typeof p.spaceAfter === 'number') a.push(['w:after', twips(Math.max(0, p.spaceAfter))]);
  if (typeof p.spaceAfterAuto === 'boolean') a.push(['w:afterAutospacing', p.spaceAfterAuto ? '1' : '0']);
  const l = p.lineSpacing;
  if (l) {
    if (l.rule === 'atLeast') a.push(['w:line', twips(Math.abs(l.value))], ['w:lineRule', 'atLeast']);
    else if (l.rule === 'exactly') a.push(['w:line', twips(Math.abs(l.value))], ['w:lineRule', 'exact']);
    else a.push(['w:line', n(round(Math.max(0.06, Math.min(132, l.value)) * 240))], ['w:lineRule', 'auto']);
  }
  w.empty('w:spacing', a);
}
function writeIndentation(w, p) {
  const chars = [p.indentLeftChars, p.indentRightChars, p.indentFirstChars];
  const set = v => typeof v === 'number';
  if (!(set(p.indentLeft) || set(p.indentRight) || set(p.indentFirst) || chars.some(set))) return;
  const hundredths = v => String(Math.round(Math.max(-1584, Math.min(1584, v)) * 100));
  const a = [];
  if (set(p.indentLeftChars)) a.push(['w:leftChars', hundredths(p.indentLeftChars)]);
  if (set(p.indentLeft)) a.push(['w:left', twips(p.indentLeft)]);
  if (set(p.indentRightChars)) a.push(['w:rightChars', hundredths(p.indentRightChars)]);
  if (set(p.indentRight)) a.push(['w:right', twips(p.indentRight)]);
  if (set(p.indentFirstChars)) a.push([p.indentFirstChars < 0 ? 'w:hangingChars' : 'w:firstLineChars', hundredths(Math.abs(p.indentFirstChars))]);
  if (set(p.indentFirst)) a.push([p.indentFirst < 0 ? 'w:hanging' : 'w:firstLine', twips(Math.abs(p.indentFirst))]);
  w.empty('w:ind', a);
}
export function margins(w, tag, m) { marginSides(w, tag, m); }
function marginSides(w, tag, m) {
  w.open(tag);
  ['w:top', 'w:left', 'w:bottom', 'w:right'].forEach((name, i) => {
    const v = m[i];
    if (typeof v === 'number') w.empty(name, [['w:w', twips(Math.max(0, Math.min(1584, v)))], ['w:type', 'dxa']]);
  });
  w.close(tag);
}
export function lookAttrs(l) {
  let bits = 0;
  if (l.headerRow) bits |= 0x20;
  if (l.totalRow) bits |= 0x40;
  if (l.firstColumn) bits |= 0x80;
  if (l.lastColumn) bits |= 0x100;
  if (!l.bandedRows) bits |= 0x200;
  if (!l.bandedColumns) bits |= 0x400;
  const b = v => (v ? '1' : '0');
  return [['w:val', bits.toString(16).toUpperCase().padStart(4, '0')], ['w:firstRow', b(l.headerRow)], ['w:lastRow', b(l.totalRow)],
    ['w:firstColumn', b(l.firstColumn)], ['w:lastColumn', b(l.lastColumn)], ['w:noHBand', b(!l.bandedRows)], ['w:noVBand', b(!l.bandedColumns)]];
}
function changeEl(w, tag, inner, a, body) { w.open(tag, a); w.open(inner); body(w); w.close(inner); w.close(tag); }
const tableAlign = a => alignVal(a === 'justify' || a === 'distribute' ? 'left' : a);
function tblW(w, t, auto) {
  if (typeof t.widthPct === 'number') w.empty('w:tblW', [['w:w', n(round(Math.max(0, Math.min(1000, t.widthPct)) * 50))], ['w:type', 'pct']]);
  else if (typeof t.width === 'number') w.empty('w:tblW', [['w:w', twips(Math.max(0, t.width))], ['w:type', 'dxa']]);
  else if (auto) w.empty('w:tblW', [['w:w', '0'], ['w:type', 'auto']]);
}
export function tblpr(w, t, change) {
  w.open('w:tblPr');
  tblprInner(w, t);
  if (change && t.fmtChange) changeEl(w, 'w:tblPrChange', 'w:tblPr', change, x => tblprInner(x, t.fmtChange.old || {}));
  w.close('w:tblPr');
}
function tblprInner(w, t) {
  if (t.style) w.val('w:tblStyle', t.style);
  if (t.float) tableFloat(w, t.float);
  if (t.bidiVisual) w.empty('w:bidiVisual');
  tblW(w, t, true);
  if (t.align) w.val('w:jc', tableAlign(t.align));
  if (typeof t.indent === 'number') w.empty('w:tblInd', [['w:w', twips(t.indent)], ['w:type', 'dxa']]);
  if (t.borders) borders(w, 'w:tblBorders', t.borders, 'w:insideH');
  if (Array.isArray(t.shading)) shd(w, t.shading);
  if (t.fixed) w.empty('w:tblLayout', [['w:type', 'fixed']]);
  if (t.cellMargins) margins(w, 'w:tblCellMar', t.cellMargins);
  w.empty('w:tblLook', lookAttrs(tableLook(t)));
  if (typeof t.caption === 'string') w.val('w:tblCaption', t.caption);
  if (typeof t.description === 'string') w.val('w:tblDescription', t.description);
}
export function trpr(w, r, change) {
  if (r.exceptions) tblprex(w, r.exceptions);
  const ch = change && r.fmtChange ? change : null;
  const gaps = r.gridBefore > 0 || r.gridAfter > 0 || typeof r.wBefore === 'number' || typeof r.wAfter === 'number';
  if (typeof r.height !== 'number' && !r.header && !r.cantSplit && !gaps && !ch) return;
  w.open('w:trPr');
  trprInner(w, r);
  if (ch) changeEl(w, 'w:trPrChange', 'w:trPr', ch, x => trprInner(x, r.fmtChange.old || {}));
  w.close('w:trPr');
}
function tblprex(w, t) {
  w.open('w:tblPrEx');
  tblW(w, t, false);
  if (t.align) w.val('w:jc', tableAlign(t.align));
  if (typeof t.indent === 'number') w.empty('w:tblInd', [['w:w', twips(t.indent)], ['w:type', 'dxa']]);
  if (t.borders) borders(w, 'w:tblBorders', t.borders, 'w:insideH');
  if (Array.isArray(t.shading)) shd(w, t.shading);
  if (t.fixed) w.empty('w:tblLayout', [['w:type', 'fixed']]);
  if (t.cellMargins) margins(w, 'w:tblCellMar', t.cellMargins);
  w.close('w:tblPrEx');
}
function trprInner(w, r) {
  if (r.gridBefore > 0) w.val('w:gridBefore', n(r.gridBefore));
  if (r.gridAfter > 0) w.val('w:gridAfter', n(r.gridAfter));
  for (const [name, v] of [['w:wBefore', r.wBefore], ['w:wAfter', r.wAfter]]) if (typeof v === 'number') w.empty(name, [['w:w', twips(v)], ['w:type', 'dxa']]);
  if (r.cantSplit) w.empty('w:cantSplit');
  if (typeof r.height === 'number') w.empty('w:trHeight', [['w:val', twips(Math.abs(r.height))], ['w:hRule', r.heightRule === 'auto' ? 'auto' : r.heightRule === 'exact' ? 'exact' : 'atLeast']]);
  if (r.header) w.empty('w:tblHeader');
}
export function tcpr(w, c, change) {
  w.open('w:tcPr');
  tcprInner(w, c);
  if (change && c.fmtChange) changeEl(w, 'w:tcPrChange', 'w:tcPr', change, x => tcprInner(x, c.fmtChange.old || {}));
  w.close('w:tcPr');
}
function tcprInner(w, c) {
  if (typeof c.width === 'number') w.empty('w:tcW', [['w:w', twips(Math.max(0, c.width))], ['w:type', 'dxa']]);
  else if (typeof c.widthPct === 'number') w.empty('w:tcW', [['w:w', n(Math.round(Math.max(0, Math.min(100, c.widthPct)) * 50))], ['w:type', 'pct']]);
  else w.empty('w:tcW', [['w:w', '0'], ['w:type', 'auto']]);
  if ((c.span ?? 1) > 1) w.val('w:gridSpan', n(Math.min(c.span, 63)));
  if (c.vmerge === 'restart') w.val('w:vMerge', 'restart');
  else if (c.vmerge === 'continue') w.empty('w:vMerge');
  if (c.borders) borders(w, 'w:tcBorders', c.borders, 'w:insideH');
  if (Array.isArray(c.shading)) shd(w, c.shading);
  if (c.noWrap) w.empty('w:noWrap');
  if (c.margins) margins(w, 'w:tcMar', c.margins);
  else if (c.partialMargins) marginSides(w, 'w:tcMar', c.partialMargins);
  if (textDirectionIsTurned(c.textDirection) || c.textDirectionSet) w.val('w:textDirection', textDirectionOoxml(c.textDirection ?? 'horizontal'));
  if (c.valign) w.val('w:vAlign', c.valign === 'center' ? 'center' : c.valign === 'bottom' ? 'bottom' : 'top');
  if (c.hideMark) w.empty('w:hideMark');
}
function tableFloat(w, f) {
  const rel = (a, text) => (a === 'page' ? 'page' : a === 'margin' ? 'margin' : text);
  const [left, top, right, bottom] = tableFloatDist(f).map(twips);
  const fin = v => twips(Number.isFinite(v) ? Math.max(-31_680, Math.min(31_680, v)) : 0);
  const a = [['w:leftFromText', left], ['w:rightFromText', right], ['w:topFromText', top], ['w:bottomFromText', bottom],
    ['w:vertAnchor', rel(f.vRel, 'text')], ['w:horzAnchor', rel(f.hRel, 'text')]];
  a.push(f.hAlign ? ['w:tblpXSpec', floatAlignOoxml(f.hAlign, true)] : ['w:tblpX', fin(f.x ?? 0)]);
  a.push(f.vAlign ? ['w:tblpYSpec', floatAlignOoxml(f.vAlign, false)] : ['w:tblpY', fin(f.y ?? 0)]);
  w.empty('w:tblpPr', a);
  if (f.overlap === false) w.val('w:tblOverlap', 'never');
}

// =============================================================================================
// write/sdt.rs
// =============================================================================================

/** Where a block list's controls are written: opens/closes per block, inline marker offsets per block. */
export function sdtPlan(bl) {
  const len = bl.length;
  const out = {opens: Array.from({length: len}, () => []), closes: new Array(len).fill(0), inline: Array.from({length: len}, () => [])};
  const events = controlEvents(bl);
  if (!events.length) return out;
  const [pairs] = pairEvents(events);
  const ranges = pairs.map(([o, c]) => [o, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const parent = new Array(ranges.length).fill(null);
  const stack = [];
  ranges.forEach(([o], k) => {
    while (stack.length && ranges[stack[stack.length - 1]][1] < o) stack.pop();
    parent[k] = stack.length ? stack[stack.length - 1] : null;
    stack.push(k);
  });
  const para = b => (bl[b]?.kind === 'para' ? bl[b] : null);
  const objAt = (p, off) => { let k = 0; for (let i = 0; i < off; i++) if (p.text[i] === OBJ) k++; return p.objects?.[k]; };
  const atStart = (b, off) => { const p = para(b); if (!p) return false; for (let i = 0; i < off; i++) if (p.text[i] !== OBJ || objAt(p, i)?.type !== 'controlStart') return false; return true; };
  const atEnd = (b, off) => { const p = para(b); if (!p) return false; for (let i = off + 1; i < p.text.length; i++) if (p.text[i] !== OBJ || objAt(p, i)?.type !== 'controlEnd') return false; return true; };
  const mode = new Array(ranges.length).fill('inline');
  const span = ranges.map(() => [0, 0]);
  ranges.forEach(([o, c], k) => {
    const s = events[o], e = events[c];
    if (!s?.open || !e) return;
    let m;
    if (s.off !== null && e.off !== null && s.block === e.block) {
      const parentInline = parent[k] !== null && mode[parent[k]] === 'inline';
      m = !parentInline && s.control.block && atStart(s.block, s.off) && atEnd(e.block, e.off) ? 'block' : 'inline';
    } else m = 'block';
    mode[k] = m;
    span[k] = [s.block, e.block];
  });
  const INF = Number.MAX_SAFE_INTEGER;
  const firstClose = new Array(len + 1).fill(INF), secondClose = new Array(len + 1).fill(INF), firstOwner = new Array(len + 1).fill(INF);
  ranges.forEach(([, qc], q) => {
    if (mode[q] !== 'block') return;
    const e = Math.min(span[q][1], len);
    if (qc < firstClose[e]) { secondClose[e] = firstClose[e]; firstClose[e] = qc; firstOwner[e] = q; }
    else if (qc < secondClose[e]) secondClose[e] = qc;
  });
  ranges.forEach(([o], k) => {
    if (mode[k] !== 'block') return;
    const [sb, eb] = span[k];
    const e = Math.min(sb, len);
    const close = firstOwner[e] === k ? secondClose[e] : firstClose[e];
    if (close < o) span[k] = [Math.min(sb + 1, eb), eb];
  });
  ranges.forEach(([o, c], k) => {
    const s = events[o];
    if (mode[k] === 'block') {
      const [sb, eb] = span[k];
      out.opens[sb]?.push(s.control);
      if (eb < len) out.closes[eb] += 1;
    } else {
      for (const ev of [events[o], events[c]]) if (ev && ev.off !== null) out.inline[ev.block]?.push(ev.off);
    }
  });
  for (const v of out.inline) { v.sort((a, b) => a - b); for (let i = v.length - 1; i > 0; i--) if (v[i] === v[i - 1]) v.splice(i, 1); }
  return out;
}
/** `w:sdtPr` (and `w:sdtEndPr`), then open `w:sdtContent`. */
export function sdtOpen(w, c) {
  w.open('w:sdt');
  w.open('w:sdtPr');
  if (c.rprXml) w.raw(c.rprXml);
  if (c.title) w.val('w:alias', c.title);
  if (c.tag) w.val('w:tag', c.tag);
  if (Number.isInteger(c.id)) w.val('w:id', String(c.id));
  const l = controlLockOoxml(c.lock); if (l) w.val('w:lock', l);
  if (c.placeholder) { w.open('w:placeholder'); w.val('w:docPart', c.placeholder); w.close('w:placeholder'); }
  if (c.temporary) w.empty('w:temporary');
  if (c.showingPlaceholder) w.empty('w:showingPlcHdr');
  const early = x => ['<w:dataBinding', '<w:label', '<w:tabIndex'].some(p => x.startsWith(p) && [' ', '/', '>'].includes(x[p.length]));
  for (const x of c.extra ?? []) if (early(x)) w.raw(x);
  controlKind(w, c.kind ?? {type: 'richText'});
  if (c.appearance === 'tags' || c.appearance === 'hidden') w.empty('w15:appearance', [['w15:val', c.appearance]]);
  if (/^[0-9A-Fa-f]{6}$/.test(c.color ?? '')) w.empty('w15:color', [['w:val', String(c.color).toUpperCase()]]);
  for (const x of c.extra ?? []) if (!early(x)) w.raw(x);
  w.close('w:sdtPr');
  if (c.endPrXml) w.raw(c.endPrXml);
  w.open('w:sdtContent');
}
export const sdtClose = w => w.raw('</w:sdtContent></w:sdt>');
/** Whether a block-level control is around block `i` (sdt.rs `Plan::covers`). */
export function planCovers(plan, i) {
  let open = 0;
  for (let k = 0; k <= i; k++) {
    open += plan.opens[k]?.length ?? 0;
    if (k < i) open -= plan.closes[k] ?? 0;
  }
  return open > 0;
}

// =============================================================================================
// write/story/toc.rs
// =============================================================================================

/** Word's Table of Contents content control, which gives the TOC its frame and Update Table. */
const TOC_SDT_OPEN = '<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>';

/**
 * The body TOC the writer wraps in Word's Table of Contents control (`tocSpan`): not one whose
 * heading is inside a content control already (read from a file) (story/toc.rs `written_toc_span`).
 * @returns {[number, number]|null}
 */
export function writtenTocSpan(bl) {
  const span = tocSpan(bl);
  return span && !planCovers(sdtPlan(bl), span[0]) ? span : null;
}

/**
 * The engine's TOC: a paragraph holding an empty `TOC` field, then its TOC-styled entries. Returns
 * [heading, last entry] so the field can be written spanning the entries, as Word does. The heading
 * may end a section: entries in columns follow a continuous break (#3889) (story/toc.rs `toc_span`).
 */
export function tocSpan(bl) {
  const start = bl.findIndex(b => b?.kind === 'para' && (b.objects ?? []).some(o => o.type === 'field' && isToc(o.instr ?? '') && !o.result));
  if (start < 0) return null;
  let entries = 0;
  for (let i = start + 1; i < bl.length; i++) {
    const b = bl[i];
    const st = b?.props?.style;
    if (b?.kind === 'para' && !b.section && typeof st === 'string' && st.startsWith('TOC') && st !== 'TOCHeading') entries++;
    else break;
  }
  return entries > 0 ? [start, start + entries] : null;
}
const hex4 = ch => (ch ?? '').codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0') ?? '0000';
function controlKind(w, k) {
  switch (k.type) {
    case 'text': w.empty('w:text', k.multiLine ? [['w:multiLine', '1']] : []); break;
    case 'checkBox': {
      w.open('w14:checkbox');
      w.empty('w14:checked', [['w14:val', k.checked ? '1' : '0']]);
      for (const [tag, ch, font] of [['w14:checkedState', k.checkedChar, k.checkedFont], ['w14:uncheckedState', k.uncheckedChar, k.uncheckedFont]]) {
        w.empty(tag, font ? [['w14:val', hex4(ch)], ['w14:font', font]] : [['w14:val', hex4(ch)]]);
      }
      w.close('w14:checkbox');
      break;
    }
    case 'comboBox': case 'dropDown': {
      const tag = k.type === 'comboBox' ? 'w:comboBox' : 'w:dropDownList';
      w.open(tag, k.lastValue ? [['w:lastValue', k.lastValue]] : []);
      for (const i of k.items ?? []) w.empty('w:listItem', [['w:displayText', i.display ?? ''], ['w:value', listItemValue(i)]]);
      w.close(tag);
      break;
    }
    case 'date': {
      w.open('w:date', k.fullDate ? [['w:fullDate', k.fullDate]] : []);
      for (const [tag, v] of [['w:dateFormat', k.format], ['w:lid', k.lid], ['w:storeMappedDataAs', k.storeAs], ['w:calendar', k.calendar]]) if (v) w.val(tag, v);
      w.close('w:date');
      break;
    }
    case 'picture': w.empty('w:picture'); break;
    case 'gallery': {
      const tag = k.list ? 'w:docPartList' : 'w:docPartObj';
      w.open(tag);
      if (k.gallery) w.val('w:docPartGallery', k.gallery);
      if (k.category) w.val('w:docPartCategory', k.category);
      if (k.unique) w.empty('w:docPartUnique');
      w.close(tag);
      break;
    }
    case 'repeatingSection':
      w.open('w15:repeatingSection');
      if (k.title) w.val('w15:sectionTitle', k.title);
      if (k.noInsertDelete) w.empty('w15:doNotAllowInsertDeleteSection');
      w.close('w15:repeatingSection');
      break;
    case 'repeatingSectionItem': w.empty('w15:repeatingSectionItem'); break;
    default:
  }
}

// =============================================================================================
// write.rs: media names, content types
// =============================================================================================

export function contentTypeFor(file) {
  const e = file.split('.').pop().toLowerCase();
  return {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', tif: 'image/tiff',
    tiff: 'image/tiff', svg: 'image/svg+xml', emf: 'image/x-emf', wmf: 'image/x-wmf', ico: 'image/x-icon'}[e] ?? 'application/octet-stream';
}
export function sniff(b) {
  const at = (i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b[0] === 0x89 && at(1, 'PNG')) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (at(0, 'GIF8')) return 'gif';
  if (at(0, 'BM')) return 'bmp';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  if ((at(0, 'II') && b[2] === 42 && b[3] === 0) || (at(0, 'MM') && b[2] === 0 && b[3] === 42)) return 'tiff';
  if (b[0] === 0xd7 && b[1] === 0xcd && b[2] === 0xc6 && b[3] === 0x9a) return 'wmf';
  if (at(40, ' EMF')) return 'emf';
  if (at(0, '<svg') || at(0, '<?xml')) return 'svg';
  return 'bin';
}

/** `w14:paraId` for a paragraph id: the id itself when it is a valid paraId, else a stable hash. */
export function paraIdOf(id) {
  if (typeof id === 'string' && /^[0-7][0-9a-f]{7}$/.test(id) && id !== '00000000') return id.toUpperCase();
  let h = 0x811c9dc5;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  h &= 0x7fffffff;
  if (!h) h = 1;
  return h.toString(16).toUpperCase().padStart(8, '0');
}

// =============================================================================================
// The writer
// =============================================================================================

class Writer {
  constructor(doc) {
    this.doc = doc;
    this.c = doc.content;
    this.settings = settingsOf(this.c.settings);
    this.mediaFiles = new Map();
    this.bookmarks = new Map();
    this.nextRevId = 0;
    this.openMoves = [];
    this.docpr = 0;
    this.z = 251_658_240;
    this.footnotes = [];
    this.endnotes = [];
    this.hf = [];
    this.pendingMark = null;
    this.pendingWatermark = null;
    this.linkedHeaders = {default: null, first: null, even: null};
    const ids = Object.keys(this.c.parts ?? {}).map(Number);
    let wm = 0xffffffff;
    while (ids.includes(wm)) wm--;
    this.wmHeader = wm;
    this.currentNote = null;
    this.inlineControls = [];
    this.usedMedia = new Set();
    this.paraIds = new Set();
    this.commentParaIds = new Map();
    this.keptUsed = new Set();
    this.charts = [];
    this.diagrams = [];
    this.embedTypes = parseManifest(this.c.passthrough?.[EMBEDDED_PARTS]);
    // The TOC hand-over (write.rs): the heading's TOC field is held back while the heading is
    // written (`tocHoldEnd`), kept as [instr, locked, dirty, props] (`tocField`), opened in the
    // first entry (`tocBeginHere`) and ended after the last (`tocEndHere`).
    this.tocHoldEnd = false;
    this.tocField = null;
    this.tocBeginHere = false;
    this.tocEndHere = false;
  }
  assignMedia() {
    const used = new Set();
    for (const [key, b64] of Object.entries(this.c.media ?? {})) {
      const clean = key.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);
      const d = clean.lastIndexOf('.');
      const known = d > 0 && contentTypeFor(clean) !== 'application/octet-stream';
      let base;
      if (known && !clean.startsWith('.')) base = clean;
      else { const stem = clean.replace(/^\.+|\.+$/g, '') || 'image'; base = `${stem}.${sniff(fromBase64(b64.slice(0, 120)))}`; }
      const dot = base.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot + 1)] : [base, 'bin'];
      let i = 1;
      while (used.has(base.toLowerCase())) { i++; base = `${stem}_${i}.${ext}`; }
      used.add(base.toLowerCase());
      this.mediaFiles.set(key, base);
    }
  }
  nextDocpr() { this.docpr += 1; return String(this.docpr); }
  bookmarkId(name) { if (!this.bookmarks.has(name)) this.bookmarks.set(name, this.bookmarks.size); return String(this.bookmarks.get(name)); }
  noteIdBase(foot) { const s = foot ? this.c.footnoteSeparators : this.c.endnoteSeparators; return s?.continuationNotice ? 2 : 1; }
  noteId(part, foot) {
    const list = foot ? this.footnotes : this.endnotes;
    let i = list.indexOf(part);
    if (i < 0) { list.push(part); i = list.length - 1; }
    return String(i + this.noteIdBase(foot));
  }
  hfRel(part, footer, rels) {
    const kind = part === this.wmHeader && !footer ? 'header' : this.c.parts[part]?.kind;
    if (kind !== 'header' && kind !== 'footer') return null;
    let hit = this.hf.find(([p, , f]) => p === part && f === footer);
    if (!hit) { const k = this.hf.filter(([, , f]) => f === footer).length + 1; hit = [part, `${footer ? 'footer' : 'header'}${k}.xml`, footer]; this.hf.push(hit); }
    return rels.add(footer ? RT.FOOTER : RT.HEADER, hit[1], false);
  }
  revOf(i) { return i === undefined || i === null ? null : this.c.revisions?.[i] ?? null; }
  revKind(i) { return this.revOf(i)?.kind ?? null; }
  moveName(i) { return this.revOf(i)?.moveName ?? null; }
  revAttrs(idx) {
    this.nextRevId += 1;
    const r = this.revOf(idx);
    const author = annotationAuthor(this.settings, r?.author ?? '');
    const date = this.settings.removeDateTime ? '' : r?.date ?? '';
    return [String(this.nextRevId), author, date];
  }
  changeAttrs(idx) {
    const [id, author, date] = this.revAttrs(idx);
    const a = [['w:id', id], ['w:author', author]];
    if (date) a.push(['w:date', date]);
    return a;
  }
  revTag(idx, tag) { return this.moveName(idx) ? (tag === 'w:ins' ? 'w:moveTo' : 'w:moveFrom') : tag; }
  isDel(p) { return p.del !== undefined && p.del !== null && this.revKind(p.del) !== 'format' && !this.moveName(p.del); }
  revOpen(w, p) {
    for (const [idx, tag] of [[p.ins, 'w:ins'], [p.del, 'w:del']]) {
      if (idx === undefined || idx === null || this.revKind(idx) === 'format') continue;
      w.open(this.revTag(idx, tag), this.changeAttrs(idx));
    }
  }
  revClose(w, p) {
    for (const [idx, tag] of [[p.del, 'w:del'], [p.ins, 'w:ins']]) if (idx !== undefined && idx !== null && this.revKind(idx) !== 'format') w.close(this.revTag(idx, tag));
  }
  movesOf(p) {
    return [[p.del, false], [p.ins, true]].filter(([r]) => r !== undefined && r !== null && this.moveName(r)).map(([r, to]) => [r, to]);
  }
  moveRanges(w, want) {
    for (let k = 0; k < this.openMoves.length;) {
      const [rev, id, to] = this.openMoves[k];
      if (!want.some(([r, t]) => r === rev && t === to)) { w.empty(to ? 'w:moveToRangeEnd' : 'w:moveFromRangeEnd', [['w:id', id]]); this.openMoves.splice(k, 1); }
      else k++;
    }
    for (const [rev, to] of want) {
      if (this.openMoves.some(([r, , t]) => r === rev && t === to)) continue;
      const name = this.moveName(rev) ?? '';
      const [id, author, date] = this.revAttrs(rev);
      const a = [['w:id', id], ['w:name', name], ['w:author', author]];
      if (date) a.push(['w:date', date]);
      w.empty(to ? 'w:moveToRangeStart' : 'w:moveFromRangeStart', a);
      this.openMoves.push([rev, id, to]);
    }
  }
  rprWithChange(w, c) {
    if (!c.fmtChange) return rpr(w, c);
    w.open('w:rPr');
    rprInner(w, c);
    this.rprChange(w, c.fmtChange);
    w.close('w:rPr');
  }
  rprChange(w, ch) {
    w.open('w:rPrChange', this.changeAttrs(ch.rev));
    w.open('w:rPr');
    rprInner(w, ch.old || {});
    w.close('w:rPr');
    w.close('w:rPrChange');
  }

  // --- blocks (story/blocks.rs) ---
  blocks(w, bl, rels, top, depth) {
    if (depth > MAX_DEPTH) { w.raw('<w:p/>'); return; }
    const plan = sdtPlan(bl);
    const toc = top ? writtenTocSpan(bl) : null;
    // Whether the heading's TOC field was written and still needs its end.
    let tocFieldOpen = false;
    bl.forEach((b, i) => {
      for (const c of plan.opens[i] ?? []) sdtOpen(w, c);
      this.updateTocBeforeBlock(i, toc, tocFieldOpen, w);
      if (b.kind === 'para') { this.inlineControls = plan.inline[i] ?? []; this.para(w, b, rels, top, depth); }
      else this.table(w, b, rels, depth);
      tocFieldOpen = this.updateTocAfterBlock(i, toc, tocFieldOpen, w);
      for (let k = 0; k < (plan.closes[i] ?? 0); k++) sdtClose(w);
    });
    if (depth === 0) this.moveRanges(w, []);
    if (!bl.length || bl[bl.length - 1].kind === 'table') {
      // A header with no paragraph of its own before: the watermark goes in this one (write/story/blocks.rs).
      if (depth === 0 && this.pendingWatermark) { w.raw(`<w:p>${this.pendingWatermark}</w:p>`); this.pendingWatermark = null; } else w.raw('<w:p/>');
    }
  }
  // --- the TOC hand-over (story/toc.rs) ---
  /** story/toc.rs `update_toc_before_block`. */
  updateTocBeforeBlock(i, toc, tocFieldOpen, w) {
    if (!toc) return;
    const [start, end] = toc;
    if (i === start) {
      w.raw(TOC_SDT_OPEN);
      this.tocHoldEnd = true;
    }
    this.tocBeginHere = tocFieldOpen && i === start + 1;
    this.tocEndHere = tocFieldOpen && i === end;
  }
  /** story/toc.rs `update_toc_after_block`; returns the new `toc_field_open`. */
  updateTocAfterBlock(i, toc, tocFieldOpen, w) {
    if (!toc) return tocFieldOpen;
    const [start, end] = toc;
    if (i === start) {
      // `field` holds the heading's TOC field back for the first entry.
      this.tocHoldEnd = false;
      tocFieldOpen = this.tocField !== null;
    }
    if (i === end) w.raw('</w:sdtContent></w:sdt>');
    return tocFieldOpen;
  }

  table(w, t, rels, depth) {
    const rows = t.rows.filter(r => r.cells.length);
    if (!rows.length) return;
    w.open('w:tbl');
    tblpr(w, t.props || {}, t.props?.fmtChange ? this.changeAttrs(t.props.fmtChange.rev) : null);
    w.open('w:tblGrid');
    let cols = t.grid.length;
    for (const r of rows) cols = Math.max(cols, (r.props?.gridBefore ?? 0) + r.cells.reduce((s, c) => s + Math.max(1, c.props?.span ?? 1), 0) + (r.props?.gridAfter ?? 0));
    cols = Math.max(1, Math.min(63, cols));
    for (let g = 0; g < cols; g++) w.empty('w:gridCol', [['w:w', twips(Math.max(0, t.grid[g] ?? 72))]]);
    w.close('w:tblGrid');
    let openRows = 0;
    for (const r of rows) {
      for (const c of r.controls?.open ?? []) { sdtOpen(w, c); openRows++; }
      w.open('w:tr');
      trpr(w, r.props || {}, r.props?.fmtChange ? this.changeAttrs(r.props.fmtChange.rev) : null);
      let openCells = 0;
      for (const c of r.cells) {
        for (const ctl of c.controls?.open ?? []) { sdtOpen(w, ctl); openCells++; }
        w.open('w:tc');
        tcpr(w, c.props || {}, c.props?.fmtChange ? this.changeAttrs(c.props.fmtChange.rev) : null);
        this.blocks(w, c.blocks, rels, false, depth + 1);
        w.close('w:tc');
        const k = Math.min(c.controls?.close ?? 0, openCells);
        for (let i = 0; i < k; i++) sdtClose(w);
        openCells -= k;
      }
      for (let i = 0; i < openCells; i++) sdtClose(w);
      w.close('w:tr');
      const k = Math.min(r.controls?.close ?? 0, openRows);
      for (let i = 0; i < k; i++) sdtClose(w);
      openRows -= k;
    }
    for (let i = 0; i < openRows; i++) sdtClose(w);
    w.close('w:tbl');
  }

  // --- paragraphs (story/para.rs) ---
  para(w, p, rels, top, depth) {
    const inline = this.inlineControls;
    this.inlineControls = [];
    const first = p.text ? String.fromCodePoint(p.text.codePointAt(0)) : '';
    if (p.props?.dropCap > 0 && first && !['￼', '\t', '\n', '\u000C', '\u000E'].includes(first) && p.text.length > first.length) {
      const [head, tail] = splitPara(p, first.length);
      head.props = {...(p.props || {}), dropCap: p.props.dropCap};
      if (p.props.dropCapFont?.trim()) head.runs = head.runs.map(r => ({len: r.len, props: {...(r.props || {}), font: p.props.dropCapFont}}));
      delete head.section;
      this.paraInner(w, head, rels, false, depth, true);
      tail.props = {...(p.props || {})};
      delete tail.props.dropCap;
      if (p.section) tail.section = p.section; else delete tail.section;
      this.inlineControls = inline.filter(o => o >= first.length).map(o => o - first.length);
      this.paraInner(w, tail, rels, top, depth, false, null);
      return;
    }
    this.inlineControls = inline;
    this.paraInner(w, p, rels, top, depth, false);
  }
  writeMarkRpr(w, mark, markRevs) {
    w.open('w:rPr');
    for (const [idx, tag] of markRevs) {
      const [id, author, date] = this.revAttrs(idx);
      w.empty(tag, date ? [['w:id', id], ['w:author', author], ['w:date', date]] : [['w:id', id], ['w:author', author]]);
    }
    rprInner(w, mark);
    if (mark.fmtChange) this.rprChange(w, mark.fmtChange);
    w.close('w:rPr');
  }
  paraIdFor(p) {
    let pid = paraIdOf(p.id);
    while (this.paraIds.has(pid)) pid = ((parseInt(pid, 16) % 0x7ffffffe) + 1).toString(16).toUpperCase().padStart(8, '0');
    this.paraIds.add(pid);
    return pid;
  }
  paraInner(w, p, rels, top, depth, framed, idOverride) {
    const pid = idOverride === null ? null : this.paraIdFor(p);
    if (pid && this.pendingCommentPara === p) this.commentParaIds.set(this.pendingCommentId, pid);
    w.open('w:p', pid ? [['w14:paraId', pid], ['w14:textId', '77777777']] : []);
    const pp = {...(p.props || {})};
    if (!framed) { delete pp.dropCap; }
    const section = top ? p.section : null;
    const mark = p.mark || {};
    const markRevs = [[mark.ins, 'w:ins'], [mark.del, 'w:del']].filter(([i]) => i !== undefined && i !== null && this.revKind(i) && this.revKind(i) !== 'format')
      .map(([i, tag]) => [i, this.revTag(i, tag)]);
    const hasMark = hasRpr(mark) || markRevs.length > 0 || !!mark.fmtChange;
    const ppEmpty = paraIsEmpty(stripUndef({...pp, dropCapFont: undefined, dropCapMargin: framed ? pp.dropCapMargin : undefined, dropCapDistance: framed ? pp.dropCapDistance : undefined}));
    if (!ppEmpty || hasMark || section) {
      w.open('w:pPr');
      let numChange = null;
      if (pp.numChange) { numChange = this.changeAttrs(pp.numChange.rev); numChange.push(['w:original', pp.numChange.original ?? '']); }
      pprInner(w, pp, framed, numChange);
      if (hasMark) this.writeMarkRpr(w, mark, markRevs);
      if (section) this.sectpr(w, section, rels);
      if (pp.fmtChange) {
        w.open('w:pPrChange', this.changeAttrs(pp.fmtChange.rev));
        w.open('w:pPr');
        pprInner(w, pp.fmtChange.old || {}, false, null);
        w.close('w:pPr');
        w.close('w:pPrChange');
      }
      w.close('w:pPr');
    }
    if (depth === 0 && this.pendingWatermark) { w.raw(this.pendingWatermark); this.pendingWatermark = null; }
    if (!this.holdsOwnRef(p) && this.pendingMark) {
      const m = this.pendingMark;
      this.pendingMark = null;
      w.raw('<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr>');
      w.empty(m);
      w.raw('</w:r>');
    }
    // Taken before the content so a nested story (a text box in an entry) can't claim them.
    const tocBegin = this.tocBeginHere;
    this.tocBeginHere = false;
    if (tocBegin && this.tocField) {
      const [instr, locked, dirty, props] = this.tocField;
      this.tocField = null;
      this.revOpen(w, props);
      this.fieldStart(w, instr, locked, dirty, '', props);
      this.revClose(w, props);
    }
    const tocEnd = this.tocEndHere;
    this.tocEndHere = false;
    this.paraContent(w, p, rels, depth);
    if (tocEnd) w.raw('<w:r><w:fldChar w:fldCharType="end"/></w:r>');
    this.moveRanges(w, this.movesOf(mark));
    w.close('w:p');
  }
  holdsOwnRef(p) {
    if (!this.currentNote) return false;
    const [foot, id] = this.currentNote;
    return (p.objects ?? []).some(o => o.type === 'noteRef' && o.id === id && (o.kind === 'footnote') === foot);
  }
  paraContent(w, p, rels, depth) {
    const inline = this.inlineControls;
    this.inlineControls = [];
    const pieces = [];
    let k = 0, s = 0;
    for (const r of p.runs) {
      const props = r.props ?? {};
      const text = p.text.slice(s, s + r.len);
      const symFont = props.symFont && props.symFont.trim() ? props.symFont : null;
      let buf = '';
      let off = s;
      const flush = () => { if (buf) { pieces.push([['text', buf], props]); buf = ''; } };
      for (const ch of text) {
        let special = null;
        if (ch === '\t') special = ['tab'];
        else if (ch === '\n') special = ['br', null];
        else if (ch === '\u000C') special = ['br', 'page'];
        else if (ch === '\u000E') special = ['br', 'column'];
        else if (ch === '‑') special = ['nbh'];
        else if (ch === '­') special = ['soft'];
        else if (ch === OBJ) { const o = p.objects?.[k++]; special = o ? ['obj', o, off] : ['text', '']; }
        else if (symFont && ch.codePointAt(0) >= 0x20 && ch.codePointAt(0) <= 0xffff) special = ['sym', symFont, ch];
        if (special) { flush(); pieces.push([special, props]); } else buf += ch;
        off += ch.length;
      }
      flush();
      s += r.len;
    }
    let openLink = null;
    for (let i = 0; i < pieces.length;) {
      const [piece, props] = pieces[i];
      if (piece[0] === 'obj' && (piece[1].type === 'controlStart' || piece[1].type === 'controlEnd')) {
        if (inline.includes(piece[2])) {
          if (openLink !== null) { w.close('w:hyperlink'); openLink = null; }
          if (piece[1].type === 'controlStart') sdtOpen(w, piece[1].control); else sdtClose(w);
        }
        i++;
        continue;
      }
      const link = props.link ?? null;
      if (link !== openLink) {
        if (openLink !== null) w.close('w:hyperlink');
        openLink = null;
        if (link) {
          const tip = props.linkTip ? [['w:tooltip', props.linkTip]] : [];
          if (link.startsWith('#')) w.open('w:hyperlink', [['w:anchor', link.slice(1)], ...tip, ['w:history', '1']]);
          else w.open('w:hyperlink', [['r:id', rels.add(RT.HYPERLINK, link, true)], ...tip, ['w:history', '1']]);
          openLink = link;
        }
      }
      if (piece[0] === 'obj') { this.object(w, piece[1], props, rels, depth); i++; continue; }
      let j = i;
      while (j < pieces.length && pieces[j][0][0] !== 'obj' && (pieces[j][1] === props || JSON.stringify(pieces[j][1]) === JSON.stringify(props))) j++;
      const del = this.isDel(props);
      this.moveRanges(w, this.movesOf(props));
      this.revOpen(w, props);
      w.open('w:r');
      this.rprWithChange(w, props);
      for (const [pc] of pieces.slice(i, j)) {
        switch (pc[0]) {
          case 'text': if (pc[1]) w.leaf(del ? 'w:delText' : 'w:t', [['xml:space', 'preserve']], pc[1]); break;
          case 'tab': w.empty('w:tab'); break;
          case 'br': w.empty('w:br', pc[1] ? [['w:type', pc[1]]] : []); break;
          case 'nbh': w.empty('w:noBreakHyphen'); break;
          case 'soft': w.empty('w:softHyphen'); break;
          case 'sym': w.empty('w:sym', [['w:font', pc[1]], ['w:char', hex4(pc[2])]]); break;
          default:
        }
      }
      w.close('w:r');
      this.revClose(w, props);
      i = Math.max(j, i + 1);
    }
    if (openLink !== null) w.close('w:hyperlink');
  }

  // --- fields (story/field.rs) ---
  run(w, props, f) { w.open('w:r'); rpr(w, props); f(w); w.close('w:r'); }
  field(w, o, props) {
    if (this.tocHoldEnd && isToc(o.instr ?? '')) {
      // A TOC heading's field opens in the first entry and closes after the last (see `tocSpan`).
      this.tocHoldEnd = false;
      this.tocField = [o.instr ?? '', !!o.locked, !!o.dirty, props];
      return;
    }
    const del = this.isDel(props);
    this.revOpen(w, props);
    this.fieldStart(w, o.instr ?? '', !!o.locked, !!o.dirty, o.form ?? '', props);
    const result = o.result ?? '';
    if (result) {
      this.run(w, props, x => {
        let buf = '';
        const flush = () => { if (buf) { x.leaf(del ? 'w:delText' : 'w:t', [['xml:space', 'preserve']], buf); buf = ''; } };
        for (const ch of result) {
          if (ch === '\t') { flush(); x.empty('w:tab'); }
          else if (ch === '\n' || ch === '\r') { flush(); x.empty('w:br'); }
          else if (ch.codePointAt(0) < 0x20 || ch === OBJ) continue;
          else buf += ch;
        }
        flush();
      });
    }
    this.run(w, props, x => x.empty('w:fldChar', [['w:fldCharType', 'end']]));
    this.revClose(w, props);
  }
  fieldStart(w, instr, locked, dirty, form, props) {
    const del = this.isDel(props);
    this.run(w, props, x => {
      const a = [['w:fldCharType', 'begin']];
      if (locked) a.push(['w:fldLock', '1']);
      if (dirty) a.push(['w:dirty', 'true']);
      if (!form) x.empty('w:fldChar', a); else { x.open('w:fldChar', a); x.raw(form); x.close('w:fldChar'); }
    });
    this.run(w, props, x => x.leaf(del ? 'w:delInstrText' : 'w:instrText', [['xml:space', 'preserve']], ` ${instr.trim()} `));
    this.run(w, props, x => x.empty('w:fldChar', [['w:fldCharType', 'separate']]));
  }

  // --- objects (story/object.rs) ---
  object(w, o, props, rels, depth) {
    switch (o.type) {
      case 'controlStart': case 'controlEnd': return;
      case 'bookmarkStart': w.empty('w:bookmarkStart', [['w:id', this.bookmarkId(o.name)], ['w:name', o.name]]); return;
      case 'bookmarkEnd': w.empty('w:bookmarkEnd', [['w:id', this.bookmarkId(o.name)]]); return;
      case 'permStart': {
        const a = [['w:id', String(o.id)]];
        if (o.group) a.push(['w:edGrp', o.group]);
        if (o.editor) a.push(['w:ed', o.editor]);
        w.empty('w:permStart', a);
        return;
      }
      case 'permEnd': w.empty('w:permEnd', [['w:id', String(o.id)]]); return;
      case 'commentStart': if (this.c.comments?.[o.id]) w.empty('w:commentRangeStart', [['w:id', String(o.id)]]); return;
      case 'commentEnd':
        if (this.c.comments?.[o.id]) {
          const s = String(o.id);
          w.empty('w:commentRangeEnd', [['w:id', s]]);
          w.open('w:r'); w.open('w:rPr'); w.val('w:rStyle', commentReferenceStyle(this.c)); w.close('w:rPr');
          w.empty('w:commentReference', [['w:id', s]]);
          w.close('w:r');
        }
        return;
      case 'equation': this.equation(w, o, props); return;
      case 'field': this.field(w, o, props); return;
      case 'fieldStart': this.revOpen(w, props); this.fieldStart(w, o.instr ?? '', !!o.locked, !!o.dirty, '', props); this.revClose(w, props); return;
      case 'fieldEnd': this.revOpen(w, props); this.run(w, props, x => x.empty('w:fldChar', [['w:fldCharType', 'end']])); this.revClose(w, props); return;
      case 'noteRef': {
        const foot = o.kind === 'footnote';
        const custom = o.custom ?? '';
        const p = {...props};
        if (!p.style && !p.vertAlign) p.vertAlign = 'superscript';
        if (this.currentNote && this.currentNote[0] === foot && this.currentNote[1] === o.id) {
          if (this.pendingMark) {
            const m = this.pendingMark;
            this.pendingMark = null;
            this.revOpen(w, props);
            w.open('w:r');
            this.rprWithChange(w, p);
            if (!custom) w.empty(m); else w.leaf('w:t', [['xml:space', 'preserve']], custom);
            w.close('w:r');
            this.revClose(w, props);
          }
          return;
        }
        const nid = this.noteId(o.id, foot);
        this.revOpen(w, props);
        w.open('w:r');
        this.rprWithChange(w, p);
        const tag = foot ? 'w:footnoteReference' : 'w:endnoteReference';
        if (!custom) w.empty(tag, [['w:id', nid]]);
        else { w.empty(tag, [['w:customMarkFollows', '1'], ['w:id', nid]]); w.leaf('w:t', [['xml:space', 'preserve']], custom); }
        w.close('w:r');
        this.revClose(w, props);
        return;
      }
      case 'image': this.writeImage(w, o, props, rels); return;
      case 'graphic': this.writeGraphic(w, o, props, rels); return;
      case 'shape': this.writeShape(w, o, props, rels, depth); return;
      case 'group': if (o.canvas) this.writeCanvas(w, o, props); else this.writeGroupMembers(w, o, props, rels); return;
      case 'ruby': this.ruby(w, o, props); return;
      case 'positionalTab':
        this.revOpen(w, props);
        w.open('w:r');
        this.rprWithChange(w, props);
        w.empty('w:ptab', [['w:relativeTo', o.relative_to ?? 'margin'], ['w:alignment', o.align ?? 'left'], ['w:leader', tabLeaderVal(o.leader)]]);
        w.close('w:r');
        this.revClose(w, props);
        return;
      case 'opaque': this.opaque(w, o, props, rels); return;
      default:
        // Shapes, groups and graphics made in Quill: their DrawingML writer (story/drawing.rs
        // `wsp`, groups, charts) is not translated yet; their text (a text box's) is kept.
        return;
    }
  }
  equation(w, o, props) {
    if (o.omml) { try { parseXml(o.omml); w.raw(o.omml); return; } catch { /* fall through to the equation written from its linear text */ } }
    const color = props.color?.Rgb ? rgbHex(props.color.Rgb) : null;
    w.raw(linearToOmml(o.linear ?? '', {display: !!o.display, jc: o.math?.jc, normalText: !!o.normalText, color}));
  }
  ruby(w, o, props) {
    const t = this.isDel(props) ? 'w:delText' : 'w:t';
    const fin = (v, d) => (Number.isFinite(v) ? v : d);
    const hps = (v, min) => String(toHalfPoints(Math.max(min, Math.min(1584, v))));
    const size = Math.max(1, Math.min(1584, fin(o.size, 5)));
    const baseSize = Number.isFinite(o.base_size) && o.base_size > 0 ? o.base_size : props.size ?? 10.5;
    this.revOpen(w, props);
    w.open('w:r');
    rpr(w, props);
    w.open('w:ruby');
    w.open('w:rubyPr');
    w.val('w:rubyAlign', o.align ?? 'center');
    w.val('w:hps', hps(size, 1));
    w.val('w:hpsRaise', hps(fin(o.raise, 0), 0));
    w.val('w:hpsBaseText', hps(fin(baseSize, 10.5), 1));
    w.val('w:lid', o.lang || 'ja-JP');
    w.close('w:rubyPr');
    const rtProps = {...charOverlaid(props, o.props || {}), size};
    for (const [tag, p, text] of [['w:rt', rtProps, o.ruby ?? ''], ['w:rubyBase', props, o.base ?? '']]) {
      w.open(tag); w.open('w:r'); rpr(w, p); w.leaf(t, [['xml:space', 'preserve']], text); w.close('w:r'); w.close(tag);
    }
    w.close('w:ruby');
    w.close('w:r');
    this.revClose(w, props);
  }
  /** A kept run (drawing, VML, OLE object, ink…): its XML with relationship placeholders resolved. */
  opaque(w, o, props, rels) {
    if (o.format !== 'docx' || !o.xml) {
      if (o.text) { this.revOpen(w, props); w.open('w:r'); this.rprWithChange(w, props); w.leaf('w:t', [['xml:space', 'preserve']], o.text); w.close('w:r'); this.revClose(w, props); }
      return;
    }
    let xml = o.xml;
    try { parseXml(xml); } catch {
      // write/story/object.rs: XML that doesn't parse is written as its text.
      if (o.text) { this.revOpen(w, props); w.open('w:r'); this.rprWithChange(w, props); w.leaf('w:t', [['xml:space', 'preserve']], o.text); w.close('w:r'); this.revClose(w, props); }
      return;
    }
    xml = xml.replace(/"@rel:([^"|]*)\|([^"|]*)\|([01])"/g, (m, kind, target, ext) => {
      const k = kind.replace(/&amp;/g, '&'), t = target.replace(/&amp;/g, '&');
      if (ext === '1') return `"${esc(rels.add(k, t, true))}"`;
      this.keptUsed.add(t);
      return `"${esc(rels.add(k, relativePath(rels.part, t), false))}"`;
    });
    // A kept run takes the run's current formatting and revision marks (the w:r we kept is
    // replaced: `<w:r>` + rPr + payload).
    const inner = xml.replace(/^<w:r>/, '').replace(/<\/w:r>$/, '').replace(/^<w:rPr>[\s\S]*?<\/w:rPr>/, '');
    if (!o.drawing && !inner.startsWith('<w:drawing') && /^<w:(separator|continuationSeparator)\/>$/.test(inner)) { w.raw(xml); return; }
    this.revOpen(w, props);
    w.open('w:r');
    this.rprWithChange(w, props);
    w.raw(inner);
    w.close('w:r');
    this.revClose(w, props);
  }
  /**
   * A chart (`graphic.chart`): a chart part with the data cached in it and the workbook Word edits the data in, written from the
   * model (lib/chart-part.mjs). A chart read from a file is written as it was read (`graphic.raw`, its own part and relationships)
   * until a command edits it or it is moved, resized or re-wrapped. SmartArt made here is written as a group of shapes; other graphics are not written yet.
   */
  writeGraphic(w, o, props, rels) {
    // SmartArt made here: its shapes as a drawing group (lib/docx-smartart.mjs).
    if (o.graphic?.smartArt) { this.writeSmartArt(w, o, props, rels); return; }
    const chart = o.graphic?.chart;
    if (!chart) return;
    const raw = o.graphic.raw;
    if (raw && raw.w === o.w && raw.h === o.h && raw.float === JSON.stringify(o.float ?? {}) && this.rawChartHolds(raw.xml)) {
      this.opaque(w, {format: 'docx', xml: raw.xml, drawing: true, text: ''}, props, rels);
      return;
    }
    const n = this.charts.length + 1;
    const name = `word/charts/chart${n}.xml`;
    const book = `word/embeddings/Microsoft_Excel_Sheet${n}.xlsx`;
    const {xml} = chartPart(chart, this.c.settings?.themeColors);
    const prels = new PartRels(name);
    prels.add(REL_PACKAGE, `../embeddings/Microsoft_Excel_Sheet${n}.xlsx`, false);
    this.charts.push({name, xml, rels: prels, book, bytes: chartWorkbook(chart, this.c.settings?.themeColors)});
    const rid = rels.add(RT.CHART, `charts/chart${n}.xml`, false);
    const float = {...(o.float || {})};
    const wrap = float.wrap ?? 'inline';
    this.revOpen(w, props);
    w.open('w:r');
    this.rprWithChange(w, props);
    w.open('w:drawing');
    const docpr = this.nextDocpr();
    this.drawingOpen(w, float, o.w, o.h, docpr, `Chart ${docpr}`, o.alt ?? '');
    w.empty('wp:cNvGraphicFramePr');
    w.open('a:graphic');
    w.open('a:graphicData', [['uri', CHART_URI]]);
    w.empty('c:chart', [['xmlns:c', CHART_URI], ['xmlns:r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'], ['r:id', rid]]);
    w.close('a:graphicData');
    w.close('a:graphic');
    w.close(wrap === 'inline' ? 'wp:inline' : 'wp:anchor');
    w.close('w:drawing');
    w.close('w:r');
    this.revClose(w, props);
  }
  /** SmartArt made here or read from a file: a diagram frame naming its data, layout, quick style and colour parts (lib/docx-smartart.mjs), with the drawing Word shows. */
  writeSmartArt(w, o, props, rels) {
    const n = this.diagrams.length + 1;
    const dir = 'word/diagrams';
    const drawingRel = rels.add(DGM_RT.drawing, `diagrams/drawing${n}.xml`, false);
    const parts = diagramParts(o, n, drawingRel, this.c.settings?.themeColors);
    this.diagrams.push({n, parts});
    const rid = k => rels.add(DGM_RT[k], `diagrams/${{data: 'data', layout: 'layout', style: 'quickStyle', colors: 'colors'}[k]}${n}.xml`, false);
    const float = {...(o.float || {})};
    const wrap = float.wrap ?? 'inline';
    void dir;
    this.revOpen(w, props);
    w.open('w:r');
    this.rprWithChange(w, props);
    w.open('w:drawing');
    const docpr = this.nextDocpr();
    this.drawingOpen(w, float, o.w, o.h, docpr, `Diagram ${docpr}`, o.alt ?? '');
    w.empty('wp:cNvGraphicFramePr');
    w.open('a:graphic');
    w.open('a:graphicData', [['uri', DIAGRAM_URI]]);
    w.empty('dgm:relIds', [['xmlns:dgm', NS_DGM], ['r:dm', rid('data')], ['r:lo', rid('layout')], ['r:qs', rid('style')], ['r:cs', rid('colors')]]);
    w.close('a:graphicData');
    w.close('a:graphic');
    w.close(wrap === 'inline' ? 'wp:inline' : 'wp:anchor');
    w.close('w:drawing');
    w.close('w:r');
    this.revClose(w, props);
  }
  /** Whether every part a kept chart's markup refers to is still in the document's kept parts. */
  rawChartHolds(xml) {
    for (const m of String(xml).matchAll(/"@rel:[^"|]*\|([^"|]*)\|0"/g)) if (!this.c.passthrough?.[m[1].replace(/&amp;/g, '&')]) return false;
    return true;
  }
  /** The relationship of a picture or texture fill's image (null without one: the shape then keeps one colour). */
  fillRid(rels, media) {
    const file = this.mediaFiles.get(media);
    if (!file || !rels) return null;
    this.usedMedia.add(media);
    return rels.add(RT.IMAGE, relativePath(rels.part, `word/media/${file}`), false);
  }
  writeImage(w, o, props, rels) {
    const file = this.mediaFiles.get(o.media);
    if (!file) return;
    const float = {...(o.float || {})};
    const wrap = float.wrap ?? 'inline';
    this.revOpen(w, props);
    w.open('w:r');
    this.rprWithChange(w, props);
    w.open('w:drawing');
    const docpr = this.nextDocpr();
    this.drawingOpen(w, float, o.w, o.h, docpr, `Picture ${docpr}`, o.alt ?? '');
    w.empty('wp:cNvGraphicFramePr');
    w.open('a:graphic');
    w.open('a:graphicData', [['uri', 'http://schemas.openxmlformats.org/drawingml/2006/picture']]);
    this.pic(w, o, file, rels);
    w.close('a:graphicData');
    w.close('a:graphic');
    w.close(wrap === 'inline' ? 'wp:inline' : 'wp:anchor');
    w.close('w:drawing');
    w.close('w:r');
    this.revClose(w, props);
  }
  /**
   * A shape's `wps:wsp` in a drawing (story/drawing.rs `wsp`): its preset or freeform geometry, fill and
   * outline; ink is named `Ink <Pen> <id> #<order>` so reading finds it again. Not written yet: a text
   * box's text and linked boxes, effects, gradients and text warp (a shape with a text box story is left
   * out, as before).
   */
  writeShape(w, o, props, rels = null, depth = 0) {
    const part = o.story !== undefined && o.story !== null ? this.c.parts?.[o.story] : null;
    // A text box whose text is gone (or too deeply nested) is left out, as before.
    if (o.story !== undefined && o.story !== null && (!part || !rels || depth > MAX_DEPTH - 4)) return;
    const float = {...(o.float || {})};
    const wrap = float.wrap ?? 'inline';
    const kind = o.kind ?? 'rectangle';
    const geom = kind === 'freeform' ? o.freeform ?? null : null;
    const ink = !!geom?.ink;
    this.revOpen(w, props);
    w.open('w:r');
    this.rprWithChange(w, props);
    w.open('w:drawing');
    const docpr = this.nextDocpr();
    const name = ink ? `Ink ${{pen: 'Pen', pencil: 'Pencil', highlighter: 'Highlighter'}[geom.ink] ?? 'Pen'} ${docpr}${Number.isFinite(geom.order) ? ` #${geom.order}` : ''}` : part ? `Text Box ${docpr}` : `Shape ${docpr}`;
    this.drawingOpen(w, float, o.w, o.h, docpr, name, '');
    w.empty('wp:cNvGraphicFramePr');
    w.open('a:graphic');
    w.open('a:graphicData', [['uri', 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape']]);
    w.open('wps:wsp');
    if (isConnector(kind)) w.empty('wps:cNvCnPr'); else w.empty('wps:cNvSpPr');
    w.open('wps:spPr');
    w.open('a:xfrm', spinAttrs(float));
    w.empty('a:off', [['x', '0'], ['y', '0']]);
    w.empty('a:ext', [['cx', emu(Math.max(0, o.w))], ['cy', emu(Math.max(0, o.h))]]);
    w.close('a:xfrm');
    if (geom) this.custGeom(w, geom, o.w, o.h);
    else {
      const prst = {rectangle: 'rect', textBox: 'rect', freeform: 'rect', roundedRectangle: 'roundRect', ellipse: 'ellipse', flowchartOr: 'flowChartOr', triangle: 'triangle',
        rightTriangle: 'rtTriangle', diamond: 'diamond', line: 'line', straightConnector: 'straightConnector1', elbowConnector: 'bentConnector3', curvedConnector: 'curvedConnector3',
        arrow: 'rightArrow', arrowLeft: 'leftArrow', arrowUp: 'upArrow', arrowDown: 'downArrow', star: 'star5', heart: 'heart'}[kind] ?? (presetOfKind(kind) ?? 'rect');
      w.open('a:prstGeom', [['prst', prst]]); w.empty('a:avLst'); w.close('a:prstGeom');
    }
    const open = kind === 'line' || isConnector(kind);
    // Solid with a transparency, or a gradient (Shape Format › Shape Fill), as well as plain colours.
    if (o.fill && !ink && !open) writeFill(w, o.fill, media => this.fillRid(rels, media)); else w.empty('a:noFill');
    if (o.stroke) {
      const alpha = geom?.alpha ?? 1;
      w.open('a:ln', ink ? [['w', emu(Math.max(0, Math.min(100, o.strokeWidth ?? 1)))], ['cap', 'rnd']] : [['w', emu(Math.max(0, Math.min(100, o.strokeWidth ?? 0.75)))]]);
      w.open('a:solidFill');
      if (alpha < 1) { w.open('a:srgbClr', [['val', rgbHex(o.stroke)]]); w.empty('a:alpha', [['val', String(Math.round(Math.max(0, Math.min(1, alpha)) * 100_000))]]); w.close('a:srgbClr'); }
      else w.empty('a:srgbClr', [['val', rgbHex(o.stroke)]]);
      w.close('a:solidFill');
      if (ink) w.empty('a:round');
      if (o.extra?.arrowStart) w.empty('a:headEnd', [['type', 'triangle']]);
      if (o.extra?.arrowEnd) w.empty('a:tailEnd', [['type', 'triangle']]);
      w.close('a:ln');
    } else { w.open('a:ln'); w.empty('a:noFill'); w.close('a:ln'); }
    writeEffects(w, o.effects);
    w.close('wps:spPr');
    if (part) {
      // The text box's text, then its body properties: direction, alignment, margins and the text warp (Shape Format › Text).
      w.open('wps:txbx');
      w.open('w:txbxContent');
      this.blocks(w, part.blocks ?? [], rels, false, depth + 1);
      w.close('w:txbxContent');
      w.close('wps:txbx');
      const body = part.body ?? {};
      const at = [['wrap', 'square']];
      if (body.vert && body.vert !== 'horz') at.push(['vert', textVertOoxml(body.vert)]);
      if (body.anchor && body.anchor !== 'top') at.push(['anchor', anchorOoxml(body.anchor)]);
      if (Array.isArray(body.inset)) for (const [k, v] of [['lIns', body.inset[0]], ['tIns', body.inset[1]], ['rIns', body.inset[2]], ['bIns', body.inset[3]]]) at.push([k, String(Math.max(0, Math.round(finite(v))))]);
      w.open('wps:bodyPr', at);
      if (o.extra?.warp?.preset) {
        w.open('a:prstTxWarp', [['prst', o.extra.warp.preset]]);
        if (o.extra.warp.adj?.length) { w.open('a:avLst'); for (const [name, val] of o.extra.warp.adj) w.empty('a:gd', [['name', name], ['fmla', `val ${Math.round(finite(val))}`]]); w.close('a:avLst'); } else w.empty('a:avLst');
        w.close('a:prstTxWarp');
      }
      w.empty('a:noAutofit');
      w.close('wps:bodyPr');
    } else w.empty('wps:bodyPr');
    w.close('wps:wsp');
    w.close('a:graphicData');
    w.close('a:graphic');
    w.close(wrap === 'inline' ? 'wp:inline' : 'wp:anchor');
    w.close('w:drawing');
    w.close('w:r');
    this.revClose(w, props);
  }
  /**
   * A group (Layout › Arrange › Group) is saved as its members, each a drawing of its own at the place the group shows it
   * (the group's own wpg:wgp is not written yet), so nothing is lost; reading the file back gives separate objects.
   */
  writeGroupMembers(w, o, props, rels) {
    const f = o.float ?? {};
    for (const [[x, y, mw, mh], c] of groupRects(o, 0, 0, o.w, o.h)) {
      const own = c.float ?? {};
      const float = {...f, x: (f.hAlign ? 0 : finite(f.x)) + x, y: (f.vAlign ? 0 : finite(f.y)) + y, rot: own.rot ?? 0, flipH: !!own.flipH, flipV: !!own.flipV, alt: own.alt};
      delete float.hAlign; delete float.vAlign;
      if (!float.rot) delete float.rot;
      if (!float.flipH) delete float.flipH;
      if (!float.flipV) delete float.flipV;
      if (!float.alt) delete float.alt;
      const child = {...c, w: mw, h: mh, float};
      if (c.type === 'image') this.writeImage(w, child, props, rels);
      else if (c.type === 'shape') this.writeShape(w, child, props);
    }
  }
  /** An empty Drawing Canvas as a `wpc:wpc` with its fill and outline (a canvas with members, and any other group, is not written yet). */
  writeCanvas(w, o, props) {
    if (!o.canvas || (o.children ?? []).length) return;
    const float = {...(o.float || {})};
    const wrap = float.wrap ?? 'inline';
    this.revOpen(w, props);
    w.open('w:r');
    this.rprWithChange(w, props);
    w.open('w:drawing');
    const docpr = this.nextDocpr();
    this.drawingOpen(w, float, o.w, o.h, docpr, `Drawing Canvas ${docpr}`, '');
    w.empty('wp:cNvGraphicFramePr');
    w.open('a:graphic');
    w.open('a:graphicData', [['uri', 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas']]);
    w.open('wpc:wpc');
    w.open('wpc:bg');
    writeFill(w, o.canvas.fill ?? null);
    w.close('wpc:bg');
    w.open('wpc:whole');
    if (o.canvas.stroke) {
      w.open('a:ln', [['w', emu(Math.max(0, Math.min(100, o.canvas.strokeWidth ?? 0.75)))]]);
      w.open('a:solidFill'); w.empty('a:srgbClr', [['val', rgbHex(o.canvas.stroke)]]); w.close('a:solidFill');
      w.close('a:ln');
    } else { w.open('a:ln'); w.empty('a:noFill'); w.close('a:ln'); }
    w.close('wpc:whole');
    w.close('wpc:wpc');
    w.close('a:graphicData');
    w.close('a:graphic');
    w.close(wrap === 'inline' ? 'wp:inline' : 'wp:anchor');
    w.close('w:drawing');
    w.close('w:r');
    this.revClose(w, props);
  }
  /** A freeform's geometry as DrawingML custom geometry (cust_geom): each path in EMUs of its own space, from a:moveTo along a:lnTo. */
  custGeom(w, f, sw, sh) {
    const pw = f.w > 0 ? f.w : Math.max(0, sw), ph = f.h > 0 ? f.h : Math.max(0, sh);
    w.open('a:custGeom');
    w.empty('a:avLst'); w.empty('a:gdLst'); w.empty('a:ahLst'); w.empty('a:cxnLst');
    w.empty('a:rect', [['l', '0'], ['t', '0'], ['r', 'r'], ['b', 'b']]);
    w.open('a:pathLst');
    const pt = (tag, [x, y]) => { w.open(tag); w.empty('a:pt', [['x', emu(x)], ['y', emu(y)]]); w.close(tag); };
    for (const p of (f.paths ?? []).slice(0, 256)) {
      const attrs = [['w', emu(pw)], ['h', emu(ph)]];
      if (!p.closed || f.ink) attrs.push(['fill', 'none']);
      w.open('a:path', attrs);
      const segs = typeof p.d === 'string' ? parsePath(p.d).filter(s => s.t !== 'Z') : null;
      if (segs?.length) {
        // Edit Points' outline keeps its curves: Béziers as a:cubicBezTo and a:quadBezTo.
        for (const s of segs) {
          const tag = s.t === 'M' ? 'a:moveTo' : s.t === 'L' ? 'a:lnTo' : s.t === 'C' ? 'a:cubicBezTo' : 'a:quadBezTo';
          w.open(tag);
          for (const q of s.pts) w.empty('a:pt', [['x', emu(q.x)], ['y', emu(q.y)]]);
          w.close(tag);
        }
      } else {
        p.pts.slice(0, 5000).forEach((xy, i) => pt(i === 0 ? 'a:moveTo' : 'a:lnTo', xy));
        // A tap: a zero-length line, so it shows as a dot.
        if (p.pts.length === 1) pt('a:lnTo', p.pts[0]);
      }
      if (p.closed) w.empty('a:close');
      w.close('a:path');
    }
    w.close('a:pathLst');
    w.close('a:custGeom');
  }
  pic(w, o, file, rels) {
    const rid = rels.add(RT.IMAGE, relativePath(rels.part, `word/media/${file}`), false);
    this.usedMedia.add(o.media);
    const float = o.float || {};
    w.open('pic:pic');
    w.open('pic:nvPicPr');
    nvProps(w, 'pic:cNvPr', '0', file, o.alt ?? '', float.alt ?? {}, !!float.hidden);
    w.open('pic:cNvPicPr');
    w.empty('a:picLocks', [['noChangeAspect', '1'], ['noChangeArrowheads', '1']]);
    w.close('pic:cNvPicPr');
    w.close('pic:nvPicPr');
    w.open('pic:blipFill');
    w.empty('a:blip', [['r:embed', rid]]);
    const crop = o.crop ?? [0, 0, 0, 0];
    if (crop.some(c => c > 0)) {
      const c = v => n(Math.round(Math.max(0, Math.min(1, finite(v))) * 100_000));
      w.empty('a:srcRect', [['l', c(crop[0])], ['t', c(crop[1])], ['r', c(crop[2])], ['b', c(crop[3])]]);
    }
    w.open('a:stretch'); w.empty('a:fillRect'); w.close('a:stretch');
    w.close('pic:blipFill');
    w.open('pic:spPr', [['bwMode', 'auto']]);
    w.open('a:xfrm', spinAttrs(float));
    w.empty('a:off', [['x', '0'], ['y', '0']]);
    w.empty('a:ext', [['cx', emu(Math.max(0, o.w))], ['cy', emu(Math.max(0, o.h))]]);
    w.close('a:xfrm');
    w.open('a:prstGeom', [['prst', 'rect']]); w.empty('a:avLst'); w.close('a:prstGeom');
    writeEffects(w, o.effects);
    w.close('pic:spPr');
    w.close('pic:pic');
  }
  drawingOpen(w, float, iw, ih, docpr, name, alt) {
    const cx = emu(Math.max(0, iw)), cy = emu(Math.max(0, ih));
    const wrap = float.wrap ?? 'inline';
    if (wrap === 'inline') w.open('wp:inline', [['distT', '0'], ['distB', '0'], ['distL', '0'], ['distR', '0']]);
    else {
      const d = emu(Math.max(0, Math.min(1584, float.dist ?? 0)));
      this.z = float.z > 0 ? float.z : this.z + 1;
      w.open('wp:anchor', [['distT', emu(Math.max(0, Math.min(1584, float.distTop ?? 0)))], ['distB', emu(Math.max(0, Math.min(1584, float.distBottom ?? 0)))],
        ['distL', d], ['distR', d], ['simplePos', '0'], ['relativeHeight', String(this.z)], ['behindDoc', wrap === 'behindText' ? '1' : '0'], ['locked', '0'],
        ['layoutInCell', float.outsideCell ? '0' : '1'], ['allowOverlap', '1']]);
      w.empty('wp:simplePos', [['x', '0'], ['y', '0']]);
      const rel = (a, horiz) => {
        if (['margin', 'page', 'insideMargin', 'outsideMargin'].includes(a)) return a;
        if (horiz && ['leftMargin', 'rightMargin', 'character'].includes(a)) return a;
        if (!horiz && ['topMargin', 'bottomMargin', 'line'].includes(a)) return a;
        return horiz ? 'column' : 'paragraph';
      };
      for (const [tag, horiz, al, rf, off] of [['wp:positionH', true, float.hAlign, float.hRel, float.x], ['wp:positionV', false, float.vAlign, float.vRel, float.y]]) {
        w.open(tag, [['relativeFrom', rel(rf ?? 'column', horiz)]]);
        if (al) w.leaf('wp:align', [], floatAlignOoxml(al, horiz)); else w.leaf('wp:posOffset', [], emu(off ?? 0));
        w.close(tag);
      }
    }
    w.empty('wp:extent', [['cx', cx], ['cy', cy]]);
    const sp = new Spin(float.rot ?? 0, float.flipH, float.flipV);
    const [bw, bh] = sp.extent(iw, ih);
    const px = (bw - Math.abs(finite(iw))) / 2, py = (bh - Math.abs(finite(ih))) / 2;
    const ef = (float.effect ?? [0, 0, 0, 0]).map(v => (Number.isFinite(v) ? Math.max(0, Math.min(1584, v)) : 0));
    w.empty('wp:effectExtent', [['l', emu(ef[0] + px)], ['t', emu(ef[1] + py)], ['r', emu(ef[2] + px)], ['b', emu(ef[3] + py)]]);
    const wrapText = float.wrapText === 'left' || float.wrapText === 'right' || float.wrapText === 'largest' ? float.wrapText : 'bothSides';
    switch (wrap) {
      case 'square': w.empty('wp:wrapSquare', [['wrapText', wrapText]]); break;
      case 'tight': case 'through': {
        const tag = wrap === 'tight' ? 'wp:wrapTight' : 'wp:wrapThrough';
        w.open(tag, [['wrapText', wrapText]]);
        const S = 21600;
        const poly = float.wrapPolygon?.points?.length >= 3 ? float.wrapPolygon : {edited: false, points: [[0, 0], [0, S], [S, S], [S, 0]]};
        w.open('wp:wrapPolygon', [['edited', poly.edited ? '1' : '0']]);
        [...poly.points, poly.points[0]].forEach(([x, y], i) => w.empty(i === 0 ? 'wp:start' : 'wp:lineTo', [['x', String(x)], ['y', String(y)]]));
        w.close('wp:wrapPolygon');
        w.close(tag);
        break;
      }
      case 'topAndBottom': w.empty('wp:wrapTopAndBottom'); break;
      case 'behindText': case 'inFrontOfText': w.empty('wp:wrapNone'); break;
      default:
    }
    nvProps(w, 'wp:docPr', docpr, name, alt, float.alt ?? {}, !!float.hidden);
  }

  // --- sections (story/section.rs) ---
  /**
   * The section's headers, plus the header holding only the watermark in each slot the pages show
   * (first page with a title page, even pages with even/odd headers) that has no header of its own
   * or linked from an earlier section (write/story/section.rs watermark_headers). Sections are
   * written in body order.
   */
  watermarkHeaders(s) {
    const set = {default: s.headers?.default ?? null, first: s.headers?.first ?? null, even: s.headers?.even ?? null};
    const linked = this.linkedHeaders;
    if (this.settings.watermark && watermarkDrawn(this.settings.watermark)) {
      const id = this.wmHeader;
      if ((set.default ?? linked.default) === null) set.default = id;
      if (s.titlePage && (set.first ?? linked.first) === null) set.first = id;
      if (this.settings.evenOddHeaders && (set.even ?? linked.even) === null) set.even = id;
    }
    for (const k of ['default', 'first', 'even']) linked[k] = set[k] ?? linked[k];
    return set;
  }
  sectpr(w, s0, rels) {
    const s = sectionOf(s0);
    w.open('w:sectPr');
    const headers = this.watermarkHeaders(s);
    for (const [set, footer] of [[headers, false], [s.footers, true]]) {
      for (const kind of ['default', 'first', 'even']) {
        const id = set?.[kind];
        if (id === null || id === undefined) continue;
        const rid = this.hfRel(id, footer, rels);
        if (rid) w.empty(footer ? 'w:footerReference' : 'w:headerReference', [['w:type', kind], ['r:id', rid]]);
      }
    }
    sectprBody(w, s);
    if (s.fmtChange) {
      w.open('w:sectPrChange', this.changeAttrs(s.fmtChange.rev));
      w.open('w:sectPr');
      sectprBody(w, sectionOf(s.fmtChange.old || {}));
      w.close('w:sectPr');
      w.close('w:sectPrChange');
    }
    w.close('w:sectPr');
  }
  noteBlocks(w, blocks, rels, foot, part) {
    this.pendingMark = foot ? 'w:footnoteRef' : 'w:endnoteRef';
    this.currentNote = [foot, part];
    this.blocks(w, blocks, rels, false, 0);
    this.currentNote = null;
    this.pendingMark = null;
  }
}

/** Split a paragraph into [head, tail] at `off` (for the drop cap's framed paragraph). */
function splitPara(p, off) {
  const head = {...p, text: p.text.slice(0, off), runs: [], objects: []};
  const tail = {...p, text: p.text.slice(off), runs: [], objects: []};
  let s = 0;
  for (const r of p.runs) {
    const a = Math.max(s, 0), b = s + r.len;
    if (b <= off) head.runs.push(r);
    else if (a >= off) tail.runs.push(r);
    else { head.runs.push({...r, len: off - a}); tail.runs.push({...r, len: b - off}); }
    s = b;
  }
  let k = 0;
  for (let i = 0; i < p.text.length; i++) if (p.text[i] === OBJ) { (i < off ? head : tail).objects.push(p.objects[k]); k++; }
  return [head, tail];
}

function sectprBody(w, s) {
  for (const [tag, pr] of [['w:footnotePr', s.footnotePr], ['w:endnotePr', s.endnotePr]]) {
    if (pr && ['pos', 'numFmt', 'numStart', 'numRestart'].some(k => pr[k] !== undefined && pr[k] !== null)) { w.open(tag); notePrInner(w, pr); w.close(tag); }
  }
  w.val('w:type', ['nextPage', 'continuous', 'evenPage', 'oddPage', 'nextColumn'].includes(s.start) ? s.start : 'nextPage');
  const pw = Math.max(36, Math.min(MAX_LEN_PT, s.pageW)), ph = Math.max(36, Math.min(MAX_LEN_PT, s.pageH));
  w.empty('w:pgSz', s.landscape ? [['w:w', twips(pw)], ['w:h', twips(ph)], ['w:orient', 'landscape']] : [['w:w', twips(pw)], ['w:h', twips(ph)]]);
  w.empty('w:pgMar', [['w:top', twips(s.marginTop)], ['w:right', twips(Math.max(0, s.marginRight))], ['w:bottom', twips(s.marginBottom)],
    ['w:left', twips(Math.max(0, s.marginLeft))], ['w:header', twips(Math.max(0, s.header))], ['w:footer', twips(Math.max(0, s.footer))],
    ['w:gutter', twips(Math.max(0, s.gutter))]]);
  if (s.pageBorders) borders(w, 'w:pgBorders', s.pageBorders, null, [['w:offsetFrom', 'text']]);
  if (s.lineNumbers) {
    const l = s.lineNumbers;
    const a = [['w:countBy', n(Math.max(1, Math.min(100, l.countBy ?? 1)))], ['w:start', n(Math.min(Math.max(0, (l.start ?? 1) - 1), 32_767))],
      ['w:restart', {page: 'newPage', section: 'newSection', continuous: 'continuous'}[l.restart] ?? 'newPage']];
    if (l.distance > 0) a.push(['w:distance', twips(l.distance)]);
    w.empty('w:lnNumType', a);
  }
  if (s.pageNumSet || Number.isInteger(s.pageNumStart) || (s.pageNumFormat ?? 'decimal') !== 'decimal') {
    const a = [['w:fmt', s.pageNumFormat ?? 'decimal']];
    if (Number.isInteger(s.pageNumStart)) a.push(['w:start', String(s.pageNumStart)]);
    w.empty('w:pgNumType', a);
  }
  const c = s.columns ?? {count: 1, space: 36, separator: false, widths: []};
  const count = Math.max(1, Math.min(45, c.count ?? 1));
  const ca = [['w:space', twips(Math.max(0, c.space ?? 36))], ['w:num', n(count)]];
  if (c.separator) ca.push(['w:sep', '1']);
  if (c.widths?.length && c.widths.length === count) {
    ca.push(['w:equalWidth', '0']);
    w.open('w:cols', ca);
    for (const [cw, sp] of c.widths) w.empty('w:col', [['w:w', twips(Math.max(0, cw))], ['w:space', twips(Math.max(0, sp))]]);
    w.close('w:cols');
  } else w.empty('w:cols', ca);
  if (typeof s.formProt === 'boolean') w.empty('w:formProt', s.formProt ? [] : [['w:val', '0']]);
  if (s.valign === 'center') w.val('w:vAlign', 'center');
  else if (s.valign === 'justify') w.val('w:vAlign', 'both');
  else if (s.valign === 'bottom') w.val('w:vAlign', 'bottom');
  if (s.titlePage) w.empty('w:titlePg');
  if (textDirectionIsTurned(s.textDirection) || s.textDirectionSet) w.val('w:textDirection', textDirectionOoxml(s.textDirection ?? 'horizontal'));
  if (s.rtl) w.empty('w:bidi');
  if (s.docGrid) {
    const g = s.docGrid;
    const a = [['w:linePitch', twips(Math.max(1, Math.min(1584, g.linePitch ?? 18)))]];
    if (g.type && g.type !== 'default') a.unshift(['w:type', g.type]);
    if (g.charSpace) a.push(['w:charSpace', n(Math.max(-1584 * 4096, Math.min(1584 * 4096, g.charSpace)))]);
    w.empty('w:docGrid', a);
  }
}
export function notePrInner(w, pr) {
  if (pr.pos) w.val('w:pos', pr.pos);
  if (pr.numFmt) w.val('w:numFmt', pr.numFmt);
  if (Number.isInteger(pr.numStart)) w.val('w:numStart', String(Math.max(1, Math.min(32_767, pr.numStart))));
  if (pr.numRestart) w.val('w:numRestart', pr.numRestart);
}
function commentReferenceStyle(c) {
  return c.styles?.styles?.find(s => s.kind === 'character' && s.name.toLowerCase() === 'annotation reference')?.id ?? 'CommentReference';
}
function spinAttrs(float) {
  const a = [];
  const rot = Math.round(normalizeDegrees(float.rot ?? 0) * 60_000) % 21_600_000;
  if (rot) a.push(['rot', String(rot)]);
  if (float.flipH) a.push(['flipH', '1']);
  if (float.flipV) a.push(['flipV', '1']);
  return a;
}
const DECORATIVE_EXT = '{C183D7F6-B498-43B3-948B-1728B52AA6E4}';
const DECORATIVE_NS = 'http://schemas.microsoft.com/office/drawing/2017/decorative';
function nvProps(w, tag, id, name, descr, alt, hidden) {
  const a = [['id', id], ['name', name]];
  if (descr !== (alt.title ?? '') || !descr) a.push(['descr', descr]);
  if (alt.title) a.push(['title', alt.title]);
  if (hidden) a.push(['hidden', '1']);
  if (!alt.decorative) { w.empty(tag, a); return; }
  w.open(tag, a);
  w.open('a:extLst');
  w.open('a:ext', [['uri', DECORATIVE_EXT]]);
  w.empty('adec:decorative', [['xmlns:adec', DECORATIVE_NS], ['val', '1']]);
  w.close('a:ext');
  w.close('a:extLst');
  w.close(tag);
}
function parseManifest(b64) {
  const m = new Map();
  if (!b64) return m;
  for (const line of new TextDecoder().decode(fromBase64(b64)).split('\n')) {
    const [p, t] = line.split('\t');
    if (p) m.set(p, t || 'application/octet-stream');
  }
  return m;
}

// =============================================================================================
// write/styles.rs
// =============================================================================================

function fileStyleName(name) {
  const hit = LOWER_NAMES.find(([, ui]) => ui.toLowerCase() === name.toLowerCase());
  if (hit) return hit[0];
  for (const [pre, f] of [['Heading ', 'heading '], ['TOC ', 'toc '], ['Index ', 'index ']]) {
    if (name.startsWith(pre)) { const d = name.slice(pre.length); if (/^\d$/.test(d)) return f + d; }
  }
  return name;
}
export function stylesXml(c) {
  const s = c.styles;
  const w = new W();
  w.open('w:styles', bodyNs());
  w.open('w:docDefaults');
  w.open('w:rPrDefault');
  w.open('w:rPr');
  rprInner(w, typeof s.defaultChr?.size === 'number' ? s.defaultChr : {...(s.defaultChr || {}), size: DEFAULT_FONT_SIZE});
  w.close('w:rPr');
  w.close('w:rPrDefault');
  if (s.defaultParaPresent !== false || !paraIsEmpty(stripUndef(s.defaultPara || {}))) {
    w.open('w:pPrDefault'); w.open('w:pPr'); pprInner(w, s.defaultPara || {}); w.close('w:pPr'); w.close('w:pPrDefault');
  }
  w.close('w:docDefaults');
  if (s.latentStyles) w.raw(s.latentStyles);
  const flagged = s.styles.filter(st => st.default).map(st => st.kind);
  for (const st of s.styles) styleXml(w, st, flagged);
  w.close('w:styles');
  return w.toString();
}
function styleXml(w, st, flagged) {
  const kind = ['paragraph', 'character', 'table', 'numbering'].includes(st.kind) ? st.kind : 'paragraph';
  const english = (kind === 'paragraph' && st.id === 'Normal') || (kind === 'character' && st.id === 'DefaultParagraphFont')
    || (kind === 'table' && st.id === 'TableNormal') || (kind === 'numbering' && st.id === 'NoList');
  const a = [['w:type', kind], ['w:styleId', st.id]];
  if (st.default || (english && !flagged.includes(kind))) a.push(['w:default', '1']);
  if (!st.builtin) a.push(['w:customStyle', '1']);
  w.open('w:style', a);
  w.val('w:name', fileStyleName(st.name || st.id));
  if (st.basedOn) w.val('w:basedOn', st.basedOn);
  if (st.next) w.val('w:next', st.next);
  if (st.linked) w.val('w:link', st.linked);
  if (Number.isInteger(st.priority)) w.val('w:uiPriority', String(st.priority));
  if (st.hidden) { w.empty('w:semiHidden'); w.empty('w:unhideWhenUsed'); }
  if (st.quick) w.empty('w:qFormat');
  if (st.locked) w.empty('w:locked');
  if (!paraIsEmpty(stripUndef(st.para || {})) && kind !== 'character') { w.open('w:pPr'); pprInner(w, st.para); w.close('w:pPr'); }
  if (hasRpr(st.chr) && kind !== 'numbering') { w.open('w:rPr'); rprInner(w, st.chr); w.close('w:rPr'); }
  const t = st.table;
  if (t) {
    if (t.borders || t.cellMargins || Number.isInteger(t.bandSize) || Number.isInteger(t.colBandSize)) {
      w.open('w:tblPr');
      if (Number.isInteger(t.bandSize)) w.val('w:tblStyleRowBandSize', String(Math.min(t.bandSize, 1000)));
      if (Number.isInteger(t.colBandSize)) w.val('w:tblStyleColBandSize', String(Math.min(t.colBandSize, 1000)));
      if (t.borders) borders(w, 'w:tblBorders', t.borders, 'w:insideH');
      if (t.cellMargins) margins(w, 'w:tblCellMar', t.cellMargins);
      w.close('w:tblPr');
    }
    for (const part of TABLE_PARTS) {
      const f = tablePart(t, part);
      const has = hasRpr(f.chr);
      const bs = part === 'wholeTable' ? null : f.borders;
      const tc = f.fill || bs || f.vAlign;
      if (!has && !tc && !f.align) continue;
      w.open('w:tblStylePr', [['w:type', part]]);
      if (f.align) { w.open('w:pPr'); pprInner(w, {align: f.align}); w.close('w:pPr'); }
      if (has) { w.open('w:rPr'); rprInner(w, f.chr); w.close('w:rPr'); }
      if (tc) {
        w.open('w:tcPr');
        if (bs) borders(w, 'w:tcBorders', bs, 'w:insideH');
        if (f.fill) shd(w, f.fill);
        if (f.vAlign) w.val('w:vAlign', f.vAlign);
        w.close('w:tcPr');
      }
      w.close('w:tblStylePr');
    }
  }
  w.close('w:style');
}
export function numberingXml(c) {
  const w = new W();
  w.open('w:numbering', bodyNs());
  const nsids = new Set();
  for (const a of c.numbering.abstracts) {
    w.open('w:abstractNum', [['w:abstractNumId', String(a.id)]]);
    if (a.nsid && !nsids.has(a.nsid)) { nsids.add(a.nsid); w.val('w:nsid', a.nsid); }
    w.val('w:multiLevelType', a.multiLevelType ?? ((a.levels?.length ?? 0) > 1 ? 'multilevel' : 'singleLevel'));
    if (a.tmpl) w.val('w:tmpl', a.tmpl);
    if (a.name) w.val('w:name', a.name);
    (a.levels ?? []).slice(0, 9).forEach((l, i) => writeLevel(w, i, l));
    w.close('w:abstractNum');
  }
  for (const num of c.numbering.nums) {
    w.open('w:num', [['w:numId', String(num.id)]]);
    w.val('w:abstractNumId', String(num.abstractId));
    for (let lvl = 0; lvl < 9; lvl++) {
      const st = (num.startOverrides ?? []).find(([l]) => Math.min(l, 8) === lvl)?.[1];
      const lv = (num.levelOverrides ?? []).find(([l]) => Math.min(l, 8) === lvl)?.[1];
      if (st === undefined && !lv) continue;
      w.open('w:lvlOverride', [['w:ilvl', String(lvl)]]);
      if (st !== undefined) w.val('w:startOverride', String(st));
      if (lv) writeLevel(w, lvl, lv);
      w.close('w:lvlOverride');
    }
    w.close('w:num');
  }
  w.close('w:numbering');
  return w.toString();
}
function writeLevel(w, i, l) {
  w.open('w:lvl', [['w:ilvl', String(i)]]);
  w.val('w:start', String(l.start ?? 1));
  w.val('w:numFmt', l.format ?? 'decimal');
  if (l.restart === false) w.val('w:lvlRestart', '0');
  else if (l.restartAfter >= 1 && l.restartAfter <= 9) w.val('w:lvlRestart', String(l.restartAfter));
  if (l.style) w.val('w:pStyle', l.style);
  if (l.legal) w.empty('w:isLgl');
  if (l.suffix === 'space') w.val('w:suff', 'space'); else if (l.suffix === 'nothing') w.val('w:suff', 'nothing');
  w.val('w:lvlText', l.text ?? '');
  w.val('w:lvlJc', alignVal(l.align));
  w.open('w:pPr');
  if (Number.isFinite(l.tab)) { w.open('w:tabs'); w.empty('w:tab', [['w:val', 'num'], ['w:pos', twips(Math.max(-1584, Math.min(1584, l.tab)))]]); w.close('w:tabs'); }
  const ind = twips(l.indent ?? 0);
  const h = l.hanging ?? 0;
  w.empty('w:ind', h >= 0 ? [['w:left', ind], ['w:hanging', twips(h)]] : [['w:left', ind], ['w:firstLine', twips(-h)]]);
  w.close('w:pPr');
  rpr(w, l.chr || {});
  w.close('w:lvl');
}

// =============================================================================================
// write/settings.rs
// =============================================================================================

export const ANONYMOUS_AUTHOR = 'Author';
export const ANONYMOUS_INITIALS = 'A';
export const annotationAuthor = (settings, author) => (settings.removePersonalInfo ? ANONYMOUS_AUTHOR : author || 'Unknown');

/** The settings part's `m:mathPr` (write/math.rs math_pr; `m:wrapIndent` and `m:wrapRight` are a choice). */
export function mathPr(w, m) {
  if (m.xml) { try { parseXml(m.xml); w.raw(m.xml); } catch { /* malformed: left out */ } return; }
  w.open('m:mathPr');
  w.empty('m:brkBin', [['m:val', m.brkBin === 'after' ? 'after' : m.brkBin === 'repeat' ? 'repeat' : 'before']]);
  w.empty('m:brkBinSub', [['m:val', m.brkBinSub === 'minusPlus' ? '-+' : m.brkBinSub === 'plusMinus' ? '+-' : '--']]);
  if (m.wrapRight) w.empty('m:wrapRight');
  else w.empty('m:wrapIndent', [['m:val', twips(Number.isFinite(m.wrapIndent) ? Math.max(0, Math.min(1584, m.wrapIndent)) : 18)]]);
  w.close('m:mathPr');
}

// --- write/watermark.rs ------------------------------------------------------------------------

const WM_SHAPETYPE_ID = '_x0000_t136';
const WM_SHAPETYPE_PATH = 'm0,0l21600,0m0,21600l21600,21600e';
/** The watermark text as written: what the reader accepts (non-blank, at most 200 characters). */
export function watermarkText(wm) {
  const t = [...String(wm?.text ?? '')].slice(0, 200).join('');
  return t.trim() ? t : null;
}
/**
 * A `w:r` holding the watermark shape (and its shape type), for the first paragraph of header part
 * number `n`, in its box (its own size, or Word's default for the page): Word's Design > Watermark
 * as a VML text shape (ECMA-376 Part 4: shape, shapetype, path, textpath, fill).
 */
export function watermarkRun(wm, n, page, imageRid = null) {
  if (wm?.picture) return imageRid ? pictureWatermarkRun(wm, n, page, imageRid) : null;
  const text = watermarkText(wm);
  if (text === null) return null;
  const [width, height] = watermarkFrame(wm, page.pageW, page.pageH);
  let font = '';
  for (const c of [...String(wm.font ?? '')].filter(ch => ch.codePointAt(0) >= 0x20 && ch.codePointAt(0) !== 0x7f).slice(0, 100)) {
    // A font name can't break out of the textpath's CSS-like style: the characters a quoted CSS
    // string can't carry raw are escaped (the reader's cssString maps them back).
    font += c === '"' ? '\\22 ' : c === ';' ? '\\3b ' : c === ':' ? '\\3a ' : c === '\\' ? '\\5c ' : c;
  }
  if (!font.trim()) font = defaultWatermark().font;
  const rotation = wm.diagonal ? 'rotation:315;' : '';
  const style = `position:absolute;margin-left:0;margin-top:0;width:${width.toFixed(1)}pt;height:${height.toFixed(1)}pt;${rotation}z-index:-251654144;`
    + 'mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin';
  const fill = wm.semitransparent ? '<v:fill opacity=".5"/>' : '';
  const color = rgbHex(Array.isArray(wm.color) ? wm.color : defaultWatermark().color);
  return '<w:r><w:rPr><w:noProof/></w:rPr><w:pict>'
    + `<v:shapetype id="${WM_SHAPETYPE_ID}" coordsize="21600,21600" o:spt="136" path="${WM_SHAPETYPE_PATH}">`
    + '<v:path textpathok="t"/><v:textpath on="t" fitshape="t"/></v:shapetype>'
    + `<v:shape id="PowerPlusWaterMarkObject${n}" type="#${WM_SHAPETYPE_ID}" style="${esc(style)}" o:allowincell="f" fillcolor="#${color}" stroked="f">`
    + `${fill}<v:textpath style="${esc(`font-family:"${font}";font-size:1pt`)}" string="${esc(text)}"/></v:shape></w:pict></w:r>`;
}

/** Word's Picture watermark: a VML picture shape in the header (v:imagedata; Washout is Word's gain and black level), centred on the margins, behind the text. */
function pictureWatermarkRun(wm, n, page, rid) {
  const [width, height] = watermarkFrame(wm, page.pageW, page.pageH);
  const style = `position:absolute;margin-left:0;margin-top:0;width:${width.toFixed(1)}pt;height:${height.toFixed(1)}pt;z-index:-251656192;`
    + 'mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin';
  const wash = wm.washout !== false ? ' gain="19661f" blacklevel="22938f"' : '';
  return '<w:r><w:rPr><w:noProof/></w:rPr><w:pict>'
    + '<v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t" path="m0,0l0,21600,21600,21600,21600,0xe" filled="f" stroked="f"><v:stroke joinstyle="miter"/><v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/><o:lock v:ext="edit" aspectratio="t"/></v:shapetype>'
    + `<v:shape id="WordPictureWatermark${n}" type="#_x0000_t75" style="${esc(style)}" o:allowincell="f"><v:imagedata r:id="${rid}" o:title=""${wash}/></v:shape></w:pict></w:r>`;
}

export function settingsXml(c, settings, footnotes, endnotes, templateRel) {
  const s = settings;
  const w = new W();
  w.open('w:settings', bodyNs());
  // Word's view (U:quill/view): w:view comes first in CT_Settings; Print Layout writes none.
  const view = {web: 'web', outline: 'outline', draft: 'normal'}[s.view];
  if (view) w.empty('w:view', [['w:val', view]]);
  const zoom = s.zoom ?? {percent: 100, fit: null};
  const percent = String(Math.max(10, Math.min(500, zoom.percent ?? 100)));
  const fit = {onePage: 'fullPage', pageWidth: 'bestFit', textWidth: 'textFit'}[zoom.fit];
  w.empty('w:zoom', fit ? [['w:val', fit], ['w:percent', percent]] : [['w:percent', percent]]);
  if (s.removePersonalInfo) w.empty('w:removePersonalInformation');
  if (s.removeDateTime) w.empty('w:removeDateAndTime');
  if (s.pageColor || s.pagePicture) w.empty('w:displayBackgroundShape');
  if (s.mirrorMargins) w.empty('w:mirrorMargins');
  if (templateRel) w.empty('w:attachedTemplate', [['r:id', templateRel]]);
  if (s.linkStyles) w.empty('w:linkStyles');
  const mergeType = {letters: 'formLetters', emails: 'email', envelopes: 'envelopes', labels: 'mailingLabels', directory: 'catalog'}[s.mailMerge?.kind];
  if (mergeType) { w.open('w:mailMerge'); w.empty('w:mainDocumentType', [['w:val', mergeType]]); w.close('w:mailMerge'); }
  if (s.trackChanges) w.empty('w:trackRevisions');
  if (s.trackMoves === false) w.empty('w:doNotTrackMoves');
  if (s.protection) {
    const a = [];
    if (s.protection !== 'none') a.push(['w:edit', s.protection]);
    if (s.protectFormatting) a.push(['w:formatting', '1']);
    a.push(['w:enforcement', '1']);
    for (const name of PROTECTION_HASH_ATTRS) { const hit = (s.protectHash ?? []).find(([k]) => k === name); if (hit) a.push([name, hit[1]]); }
    w.empty('w:documentProtection', a);
  }
  w.val('w:defaultTabStop', twips(Math.max(1, Math.min(1584, s.defaultTab ?? 36))));
  if (s.autoHyphenation) w.empty('w:autoHyphenation');
  if (s.consecutiveHyphenLimit > 0) w.val('w:consecutiveHyphenLimit', String(Math.min(s.consecutiveHyphenLimit, 32_767)));
  if (Number.isFinite(s.hyphenationZone) && Math.abs(s.hyphenationZone - DEFAULT_HYPHENATION_ZONE) > 0.01) w.val('w:hyphenationZone', twips(Math.max(0, Math.min(1584, s.hyphenationZone))));
  if (s.hyphenateCaps === false) w.empty('w:doNotHyphenateCaps');
  if (s.evenOddHeaders) w.empty('w:evenAndOddHeaders');
  for (const [tag, v] of [['w:drawingGridHorizontalSpacing', s.gridH], ['w:drawingGridVerticalSpacing', s.gridV]]) {
    if (Number.isFinite(v) && Math.abs(v - DEFAULT_GRID) > 0.01) w.val(tag, twips(Math.max(0.5, Math.min(1584, v))));
  }
  w.val('w:characterSpacingControl', 'doNotCompress');
  for (const [tag, fmt, pr, used, el, seps] of [['w:footnotePr', s.footnoteFormat, s.footnotePr, footnotes, 'w:footnote', c.footnoteSeparators],
    ['w:endnotePr', s.endnoteFormat, s.endnotePr, endnotes, 'w:endnote', c.endnoteSeparators]]) {
    w.open(tag);
    notePrInner(w, {...(pr || {}), numFmt: fmt});
    if (used) {
      w.empty(el, [['w:id', '-1']]);
      w.empty(el, [['w:id', '0']]);
      if (seps?.continuationNotice) w.empty(el, [['w:id', '1']]);
    }
    w.close(tag);
  }
  w.open('w:compat');
  if (s.doNotExpandShiftReturn) w.empty('w:doNotExpandShiftReturn');
  if (s.sumParagraphSpacing) w.empty('w:doNotUseHTMLParagraphAutoSpacing');
  if (s.allowSpaceOfSameStyleInTable) w.empty('w:allowSpaceOfSameStyleInTable');
  w.empty('w:compatSetting', [['w:name', 'compatibilityMode'], ['w:uri', 'http://schemas.microsoft.com/office/word'], ['w:val', String(Math.max(11, Math.min(15, s.compatMode ?? 15)))]]);
  w.close('w:compat');
  if (s.math) mathPr(w, s.math);
  w.close('w:settings');
  return w.toString();
}
export function themeXml(s) {
  const names = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  const name = s.themeName || 'Craft';
  const w = new W();
  w.open('a:theme', [['xmlns:a', 'http://schemas.openxmlformats.org/drawingml/2006/main'], ['name', name]]);
  w.open('a:themeElements');
  w.open('a:clrScheme', [['name', name]]);
  names.forEach((nm, i) => { const c = s.themeColors?.[i] ?? THEME_COLORS[i] ?? [0, 0, 0]; w.open(`a:${nm}`); w.empty('a:srgbClr', [['val', rgbHex(c)]]); w.close(`a:${nm}`); });
  w.close('a:clrScheme');
  w.open('a:fontScheme', [['name', name]]);
  for (const [tag, face] of [['a:majorFont', s.majorFont], ['a:minorFont', s.minorFont]]) {
    w.open(tag); w.empty('a:latin', [['typeface', face ?? '']]); w.empty('a:ea', [['typeface', '']]); w.empty('a:cs', [['typeface', '']]); w.close(tag);
  }
  w.close('a:fontScheme');
  w.open('a:fmtScheme', [['name', name]]);
  w.open('a:fillStyleLst'); for (let i = 0; i < 3; i++) w.raw('<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'); w.close('a:fillStyleLst');
  w.open('a:lnStyleLst');
  for (const width of ['6350', '12700', '19050']) w.raw(`<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`);
  w.close('a:lnStyleLst');
  w.open('a:effectStyleLst'); for (let i = 0; i < 3; i++) w.raw('<a:effectStyle><a:effectLst/></a:effectStyle>'); w.close('a:effectStyleLst');
  w.open('a:bgFillStyleLst'); for (let i = 0; i < 3; i++) w.raw('<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'); w.close('a:bgFillStyleLst');
  w.close('a:fmtScheme');
  w.close('a:themeElements');
  w.empty('a:objectDefaults');
  w.empty('a:extraClrSchemeLst');
  w.close('a:theme');
  return w.toString();
}
export function coreXml(c, s) {
  const core = {...defaultCore(), ...(c.core || {})};
  const personal = v => (s.removePersonalInfo ? '' : v);
  const w = new W();
  w.open('cp:coreProperties', [['xmlns:cp', 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties'], ['xmlns:dc', 'http://purl.org/dc/elements/1.1/'],
    ['xmlns:dcterms', 'http://purl.org/dc/terms/'], ['xmlns:dcmitype', 'http://purl.org/dc/dcmitype/'], ['xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance']]);
  for (const [tag, v] of [['dc:title', core.title], ['dc:subject', core.subject], ['dc:creator', personal(core.creator)], ['cp:keywords', core.keywords],
    ['dc:description', core.description], ['cp:lastModifiedBy', personal(core.lastModifiedBy)], ['cp:category', core.category]]) if (v) w.leaf(tag, [], v);
  if (core.revision > 0) w.leaf('cp:revision', [], String(core.revision));
  for (const [tag, v] of [['dcterms:created', core.created], ['dcterms:modified', core.modified]]) if (v) w.leaf(tag, [['xsi:type', 'dcterms:W3CDTF']], v);
  w.close('cp:coreProperties');
  return w.toString();
}
export function appXml(doc, s) {
  const c = doc.content;
  const w = new W();
  w.open('Properties', [['xmlns', 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'], ['xmlns:vt', 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes']]);
  w.leaf('Application', [], 'Arkemis Quill');
  w.leaf('Words', [], String(safe(() => doc.wordCount(), 0)));
  w.leaf('Paragraphs', [], String(safe(() => doc.paragraphCount(), 0)));
  w.leaf('DocSecurity', [], '0');
  const kept = c.passthrough?.[APP_KEPT];
  if (kept) {
    for (const line of new TextDecoder().decode(fromBase64(kept)).split('\n').slice(0, APP_KEPT_PROPS.length)) {
      const i = line.indexOf('\t');
      if (i < 0) continue;
      const name = line.slice(0, i), value = line.slice(i + 1);
      if (!APP_KEPT_PROPS.includes(name)) continue;
      if (s.removePersonalInfo && (name === 'Company' || name === 'Manager')) continue;
      w.leaf(name, [], value);
    }
  }
  w.close('Properties');
  return w.toString();
}
const safe = (f, d) => { try { return f(); } catch { return d; } };
/** Custom properties (custom.rs `write`). */
export function customXml(props) {
  const w = new W();
  w.open('Properties', [['xmlns', 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties'], ['xmlns:vt', 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes']]);
  // Property ids start at 2 (22.3.2.2).
  props.filter(p => p?.name).forEach((p, i) => {
    if (p.kind === 'raw' && !rawIsWellformed(String(p.value ?? ''))) return;
    w.open('property', [['fmtid', '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}'], ['pid', String(i + 2)], ['name', p.name]]);
    if (p.kind === 'raw') w.raw(String(p.value ?? ''));
    else w.leaf(`vt:${CUSTOM_SIMPLE.includes(p.kind) ? p.kind : 'lpwstr'}`, [], String(p.value ?? ''));
    w.close('property');
  });
  w.close('Properties');
  return w.toString();
}
/** A raw value is written only if it parses inside a `vt`-namespaced wrapper (custom.rs `raw_is_wellformed`). */
function rawIsWellformed(xml) {
  try { parseXml(`<x xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${xml}</x>`); return true; } catch { return false; }
}

// =============================================================================================
// write/parts.rs: the package
// =============================================================================================

/** The package parts in order, [Content_Types].xml first: [[name, bytes|string]]. */
export function writeParts(content) {
  let doc = new Document(content);
  if (doc.hasUnbalancedFieldRanges?.()) { doc.balanceFieldRanges(); doc = new Document(doc.content); }
  const wr = new Writer(doc);
  const c = wr.c;
  wr.assignMedia();
  const entries = [];
  const overrides = [];
  const push = (path, bytes, ct, prels) => {
    if (prels && !prels.isEmpty()) entries.push([relsPathOf(path), prels.xml()]);
    entries.push([path, bytes]);
    overrides.push([`/${path}`, ct]);
  };
  const rels = new PartRels('word/document.xml');
  const root = new PartRels('');
  const ns = bodyNs();

  // Comments' last paragraphs carry the paragraph ids the comment extensions key on.
  const commentLast = new Map();
  for (const [cid, cm] of Object.entries(c.comments ?? {})) {
    const blocks = c.parts?.[cm.part]?.blocks ?? [];
    const last = [...blocks].reverse().find(b => b.kind === 'para');
    if (last) commentLast.set(last, Number(cid));
  }

  // The document body.
  const w = new W();
  w.open('w:document', ns);
  const s = wr.settings;
  const pic = s.pagePicture && wr.mediaFiles.has(s.pagePicture.media) ? s.pagePicture : null;
  if (pic || s.pageColor) {
    w.open('w:background', s.pageColor ? [['w:color', rgbHex(s.pageColor)]] : []);
    if (pic) {
      const rid = rels.add(RT.IMAGE, `media/${wr.mediaFiles.get(pic.media)}`, false);
      wr.usedMedia.add(pic.media);
      w.open('v:background', [['id', '_x0000_s1025'], ['o:bwmode', 'white']]);
      const fa = [['r:id', rid]];
      if (pic.fillType) fa.push(['type', pic.fillType]);
      if (pic.title) fa.push(['o:title', pic.title]);
      w.empty('v:fill', fa);
      w.close('v:background');
    }
    w.close('w:background');
  }
  w.open('w:body');
  wr.blocks(w, c.body.chunks.flat(), rels, true, 0);
  wr.sectpr(w, c.lastSection, rels);
  w.close('w:body');
  w.close('w:document');
  const body = w.toString();

  // Headers and footers, discovered while writing sections.
  for (let done = 0; done < wr.hf.length; done++) {
    const [id, file, footer] = wr.hf[done];
    const prels = new PartRels(`word/${file}`);
    const hw = new W();
    const tag = footer ? 'w:ftr' : 'w:hdr';
    hw.open(tag, ns);
    // The watermark goes in every header, at the start of its first paragraph (write/parts.rs).
    const wmk = !footer ? wr.settings.watermark : null;
    let wmRid = null;
    if (wmk?.picture && wr.mediaFiles.has(wmk.picture.media)) {
      wmRid = prels.add(RT.IMAGE, relativePath(prels.part, `word/media/${wr.mediaFiles.get(wmk.picture.media)}`), false);
      wr.usedMedia.add(wmk.picture.media);
    }
    wr.pendingWatermark = wmk ? watermarkRun(wmk, done + 1, sectionOf(c.lastSection), wmRid) : null;
    wr.blocks(hw, id === wr.wmHeader && !footer ? [] : c.parts[id]?.blocks ?? [], prels, false, 0);
    wr.pendingWatermark = null;
    hw.close(tag);
    push(`word/${file}`, hw.toString(), `${CT_WML}${footer ? 'footer' : 'header'}+xml`, prels);
  }

  // Footnotes and endnotes.
  const notesPart = foot => (foot ? wr.footnotes : wr.endnotes).length > 0 || !!(foot ? hasSeps(c.footnoteSeparators) : hasSeps(c.endnoteSeparators));
  // Notes may reference further notes: collect until no new note appears.
  const noteXml = {};
  for (const foot of [true, false]) {
    if (!notesPart(foot)) continue;
    const seps = foot ? c.footnoteSeparators : c.endnoteSeparators;
    const [rootTag, tag, file] = foot ? ['w:footnotes', 'w:footnote', 'footnotes.xml'] : ['w:endnotes', 'w:endnote', 'endnotes.xml'];
    const prels = new PartRels(`word/${file}`);
    const nw = new W();
    nw.open(rootTag, ns);
    for (const [id, kind] of [['-1', 'separator'], ['0', 'continuationSeparator'], ['1', 'continuationNotice']]) {
      const own = seps?.[kind];
      if (own) {
        nw.open(tag, [['w:type', kind], ['w:id', id]]);
        if (!own.length) nw.empty('w:p'); else wr.blocks(nw, own, prels, false, 0);
        nw.close(tag);
      } else if (kind !== 'continuationNotice') {
        nw.raw(`<${tag} w:type="${kind}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><${kind === 'separator' ? 'w:separator' : 'w:continuationSeparator'}/></w:r></w:p></${tag}>`);
      }
    }
    const base = wr.noteIdBase(foot);
    for (let k = 0; k < (foot ? wr.footnotes : wr.endnotes).length; k++) {
      const pid = (foot ? wr.footnotes : wr.endnotes)[k];
      nw.open(tag, [['w:id', String(k + base)]]);
      wr.noteBlocks(nw, c.parts[pid]?.blocks ?? [], prels, foot, pid);
      nw.close(tag);
    }
    nw.close(rootTag);
    rels.add(foot ? RT.FOOTNOTES : RT.ENDNOTES, file, false);
    noteXml[foot] = [`word/${file}`, nw.toString(), `${CT_WML}${foot ? 'footnotes' : 'endnotes'}+xml`, prels];
  }
  for (const foot of [true, false]) if (noteXml[foot]) push(...noteXml[foot]);

  // Comments (+ commentsExtended, commentsIds, commentsExtensible).
  const commentParas = [];
  if (Object.keys(c.comments ?? {}).length) {
    const prels = new PartRels('word/comments.xml');
    const cw = new W();
    cw.open('w:comments', ns);
    for (const [cid, cm] of Object.entries(c.comments).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const a = [['w:id', cid], ['w:author', annotationAuthor(s, cm.author ?? '')]];
      if (cm.date && !s.removeDateTime) a.push(['w:date', cm.date]);
      if (s.removePersonalInfo) a.push(['w:initials', ANONYMOUS_INITIALS]); else if (cm.initials) a.push(['w:initials', cm.initials]);
      cw.open('w:comment', a);
      const blocks = c.parts?.[cm.part]?.blocks ?? [];
      const last = [...blocks].reverse().find(b => b.kind === 'para');
      wr.pendingCommentPara = last ?? null;
      wr.pendingCommentId = Number(cid);
      wr.blocks(cw, blocks, prels, false, 0);
      wr.pendingCommentPara = null;
      const pid = wr.commentParaIds.get(Number(cid));
      if (pid) commentParas.push([Number(cid), pid]);
      cw.close('w:comment');
    }
    cw.close('w:comments');
    rels.add(RT.COMMENTS, 'comments.xml', false);
    push('word/comments.xml', cw.toString(), `${CT_WML}comments+xml`, prels);
    const ew = new W();
    ew.open('w15:commentsEx', [['xmlns:w15', 'http://schemas.microsoft.com/office/word/2012/wordml'], ['xmlns:mc', 'http://schemas.openxmlformats.org/markup-compatibility/2006']]);
    const pidOf = id => commentParas.find(([x]) => x === id)?.[1];
    for (const [cid, cm] of Object.entries(c.comments)) {
      const pid = pidOf(Number(cid));
      if (!pid) continue;
      const parent = cm.parent === null || cm.parent === undefined ? null : pidOf(cm.parent);
      ew.empty('w15:commentEx', parent ? [['w15:paraId', pid], ['w15:paraIdParent', parent], ['w15:done', cm.resolved ? '1' : '0']] : [['w15:paraId', pid], ['w15:done', cm.resolved ? '1' : '0']]);
    }
    ew.close('w15:commentsEx');
    rels.add(RT.COMMENTS_EX, 'commentsExtended.xml', false);
    push('word/commentsExtended.xml', ew.toString(), `${CT_WML}commentsExtended+xml`, null);
    if (commentParas.length) {
      const used = new Set();
      let next = 0x1000_0000;
      const rows = [];
      for (const [cid, pid] of commentParas) {
        const cm = c.comments[cid];
        const kept = cm.durableId && durableIdOk(cm.durableId) ? parseInt(cm.durableId, 16).toString(16).toUpperCase().padStart(8, '0') : null;
        let durable = kept && !used.has(kept) ? kept : null;
        while (!durable) { next++; const d = next.toString(16).toUpperCase().padStart(8, '0'); if (!used.has(d) && !Object.values(c.comments).some(o => o.durableId === d)) durable = d; }
        used.add(durable);
        rows.push([pid, durable, s.removeDateTime ? null : cm.dateUtc ?? null]);
      }
      const mc = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
      const iw = new W();
      iw.open('w16cid:commentsIds', [['xmlns:mc', mc], ['xmlns:w16cid', 'http://schemas.microsoft.com/office/word/2016/wordml/cid'], ['mc:Ignorable', 'w16cid']]);
      for (const [pid, d] of rows) iw.empty('w16cid:commentId', [['w16cid:paraId', pid], ['w16cid:durableId', d]]);
      iw.close('w16cid:commentsIds');
      rels.add(RT.COMMENTS_IDS, 'commentsIds.xml', false);
      push('word/commentsIds.xml', iw.toString(), `${CT_WML}commentsIds+xml`, null);
      const xw = new W();
      xw.open('w16cex:commentsExtensible', [['xmlns:mc', mc], ['xmlns:w16cex', 'http://schemas.microsoft.com/office/word/2018/wordml/cex'], ['mc:Ignorable', 'w16cex']]);
      for (const [, d, utc] of rows) xw.empty('w16cex:commentExtensible', utc ? [['w16cex:durableId', d], ['w16cex:dateUtc', utc]] : [['w16cex:durableId', d]]);
      xw.close('w16cex:commentsExtensible');
      rels.add(RT.COMMENTS_EXTENSIBLE, 'commentsExtensible.xml', false);
      push('word/commentsExtensible.xml', xw.toString(), `${CT_WML}commentsExtensible+xml`, null);
    }
  }

  rels.add(RT.STYLES, 'styles.xml', false);
  push('word/styles.xml', stylesXml(c), `${CT_WML}styles+xml`, null);
  if (c.numbering?.nums?.length || c.numbering?.abstracts?.length) {
    rels.add(RT.NUMBERING, 'numbering.xml', false);
    push('word/numbering.xml', numberingXml(c), `${CT_WML}numbering+xml`, null);
  }
  rels.add(RT.SETTINGS, 'settings.xml', false);
  const srels = new PartRels('word/settings.xml');
  const tmpl = s.attachedTemplate?.trim();
  const tmplRel = tmpl ? srels.add(RT.ATTACHED_TEMPLATE, tmpl, true) : null;
  push('word/settings.xml', settingsXml(c, s, notesPart(true), notesPart(false), tmplRel), `${CT_WML}settings+xml`, srels);
  rels.add(RT.THEME, 'theme/theme1.xml', false);
  push('word/theme/theme1.xml', themeXml(s), 'application/vnd.openxmlformats-officedocument.theme+xml', null);

  // Parts kept from the file the model doesn't own (font table, web settings, glossary, custom XML…).
  const written = new Set(entries.map(([p]) => p.toLowerCase()));
  written.add('word/document.xml');
  const keptLines = c.passthrough?.[KEPT_PARTS] ? new TextDecoder().decode(fromBase64(c.passthrough[KEPT_PARTS])).split('\n').filter(Boolean) : [];
  for (const line of keptLines) {
    const [scope, kind, target, , external] = line.split('\t');
    if (!kind || !target) continue;
    if (/vbaProject$/.test(kind)) continue; // a .docx can't hold macros (Word drops them too)
    const pr = scope === 'P' ? root : rels;
    if (external === '1') { pr.add(kind, target, true); continue; }
    if (written.has(target.toLowerCase()) || !c.passthrough?.[target]) continue;
    pr.add(kind, scope === 'P' ? target : relativePath('word/document.xml', target), false);
    wr.keptUsed.add(target);
  }
  // Every kept part reached (from a kept drawing or the list above), and the parts their
  // relationship files reach in turn.
  const queue = [...wr.keptUsed];
  const keptWritten = new Set();
  while (queue.length) {
    const p = queue.shift();
    if (keptWritten.has(p) || written.has(p.toLowerCase()) || !c.passthrough?.[p]) continue;
    keptWritten.add(p);
    entries.push([p, fromBase64(c.passthrough[p])]);
    overrides.push([`/${p}`, wr.embedTypes.get(p) ?? 'application/octet-stream']);
    const rp = relsPathOf(p);
    if (c.passthrough[rp]) {
      const relsBytes = fromBase64(c.passthrough[rp]);
      entries.push([rp, relsBytes]);
      try {
        const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
        for (const r of parseXml(relsBytes).elList()) {
          if ((r.attr('TargetMode') ?? '').toLowerCase() === 'external') continue;
          const t = r.attr('Target');
          if (t) queue.push(resolveTarget(dir, t));
        }
      } catch { /* a damaged kept relationship part is written as it was */ }
    }
  }

  // Charts written from the model: the chart part with its relationship to the workbook, and the workbook (a promise zipEntries awaits).
  const mediaTypes = new Map();
  for (const ch of wr.charts) {
    push(ch.name, ch.xml, CHART_CT, ch.rels);
    entries.push([ch.book, ch.bytes]);
    mediaTypes.set('xlsx', XLSX_CT);
  }

  // SmartArt: each diagram's data, layout, quick style, colour and drawing parts.
  for (const {n, parts} of wr.diagrams) {
    push(`word/diagrams/data${n}.xml`, parts.data, CT_DATA, null);
    push(`word/diagrams/layout${n}.xml`, parts.layout, CT_LAYOUT, null);
    push(`word/diagrams/quickStyle${n}.xml`, parts.style, CT_STYLE, null);
    push(`word/diagrams/colors${n}.xml`, parts.colors, CT_COLORS, null);
    push(`word/diagrams/drawing${n}.xml`, parts.drawing, CT_DRAWING, null);
  }

  // Media referenced by a written drawing.
  for (const [key, file] of wr.mediaFiles) {
    if (!wr.usedMedia.has(key)) continue;
    const ext = file.split('.').pop().toLowerCase();
    mediaTypes.set(ext, contentTypeFor(file));
    entries.push([`word/media/${file}`, fromBase64(c.media[key])]);
  }

  entries.unshift(['word/document.xml', body], ['word/_rels/document.xml.rels', rels.xml()]);
  overrides.unshift(['/word/document.xml', MAIN_CONTENT_TYPE]);
  root.add(RT.OFFICE_DOC, 'word/document.xml', false);
  root.add(RT.CORE, 'docProps/core.xml', false);
  root.add(RT.APP, 'docProps/app.xml', false);
  entries.push(['docProps/core.xml', coreXml(c, s)]);
  overrides.push(['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml']);
  entries.push(['docProps/app.xml', appXml(doc, s)]);
  overrides.push(['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml']);
  if (c.customProps?.length) {
    root.add(RT.CUSTOM, 'docProps/custom.xml', false);
    entries.push(['docProps/custom.xml', customXml(c.customProps)]);
    overrides.push(['/docProps/custom.xml', 'application/vnd.openxmlformats-officedocument.custom-properties+xml']);
  }
  // The bibliography (write/parts.rs): customXml/item1.xml with its data store properties, related
  // from the package. A kept custom XML part already named item1 keeps its name; the sources take
  // the next free number.
  if (c.sources?.length) {
    const taken = new Set(entries.map(([n]) => n.toLowerCase()));
    let k = 1;
    while (taken.has(`customxml/item${k}.xml`) || taken.has(`customxml/itemprops${k}.xml`) || taken.has(`customxml/_rels/item${k}.xml.rels`)) k++;
    const item = `customXml/item${k}.xml`;
    root.add(RT.CUSTOM_XML, item, false);
    const itemRels = new PartRels(item);
    itemRels.add(RT.CUSTOM_XML_PROPS, `itemProps${k}.xml`, false);
    push(item, bibliographyXml(c), 'application/vnd.openxmlformats-officedocument.customXml+xml', itemRels);
    push(`customXml/itemProps${k}.xml`, bibliographyPropsXml(), 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml', null);
  }
  entries.unshift(['_rels/.rels', root.xml()]);
  const tw = new W();
  tw.open('Types', [['xmlns', 'http://schemas.openxmlformats.org/package/2006/content-types']]);
  tw.empty('Default', [['Extension', 'rels'], ['ContentType', 'application/vnd.openxmlformats-package.relationships+xml']]);
  tw.empty('Default', [['Extension', 'xml'], ['ContentType', 'application/xml']]);
  for (const [ext, ct] of mediaTypes) if (ext !== 'xml' && ext !== 'rels') tw.empty('Default', [['Extension', ext], ['ContentType', ct]]);
  for (const [part, ct] of overrides) tw.empty('Override', [['PartName', part], ['ContentType', ct]]);
  tw.close('Types');
  entries.unshift(['[Content_Types].xml', tw.toString()]);
  return entries;
}
const hasSeps = s => !!s && !!(s.separator || s.continuationSeparator || s.continuationNotice);
function resolveTarget(dir, target) {
  const parts = target.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const seg of target.split('#')[0].split('/')) { if (!seg || seg === '.') continue; if (seg === '..') parts.pop(); else parts.push(seg); }
  return parts.join('/');
}

/** Zip the parts (package.rs `zip_entries`): deflated, in order, fixed dates for reproducible files. */
export async function zipEntries(entries) {
  const z = new JSZip();
  const date = new Date(Date.UTC(1980, 0, 1));
  for (const [name, bytes] of entries) z.file(name, bytes, {date, createFolders: false});
  return z.generateAsync({type: 'uint8array', compression: 'DEFLATE', compressionOptions: {level: 6}});
}

/** Write a `.docx` package from schema-2 content. */
export async function writeDocx(content) { return zipEntries(writeParts(content)); }

/** The format-worker entry point (electron/format-worker.cjs): a schema-2 Quill file → `.docx` bytes. */
export async function write(file, _opts = {}) {
  const content = file?.content ?? file;
  return writeDocx(content);
}

export {toBase64};
