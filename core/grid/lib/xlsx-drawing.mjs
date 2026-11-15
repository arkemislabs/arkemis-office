// Drawings of a worksheet in an Excel workbook: the anchors, pictures, shapes and text boxes of
// `xl/drawings/drawingN.xml`, the chart parts `xl/charts/chartN.xml`, and the sparklines of the
// worksheet's x14 extension.
// Translated from gridcraft crates/xlsx/src/drawing.rs (`read_drawing`, `read_anchor`, `read_shape`,
// `read_text_format`, `write_drawing`, `anchor_open`, `image_ext`) and chart.rs (`read_chart`,
// `group_kind`, `read_series`, `write_chart`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:grid/formats-xlsx.
//
// Chart kinds Excel 2016 draws as `cx:` extension charts (histogram, waterfall, funnel, treemap,
// sunburst, box and whisker) are written as the clustered column chart a reader without the extension
// shows, with Arkemis's own marker `urn:arkemis:chart-kind` carrying the real kind so it reads back.

import {a1, parseCell} from './addr.mjs';
import {anchorAt} from './objects.mjs';
import {colLeft, rowTop, colAt, rowAt} from '../model/sheet.mjs';
import {resolveColor, DEFAULT_THEME} from '../model/style.mjs';
import {resolveChart} from './chart-resolve.mjs';
import {base64ToBytes, bytesToBase64, EXT_FOR_MIME, MIME_FOR_EXT} from './image-info.mjs';
import {iconPath} from './icon-library.mjs';
import {inkPoints, inkWidth, inkText, widthFill, HIGHLIGHTER_WIDTH} from './ink.mjs';
import {writeEffects} from '../../quill/formats/_docx-shape-fx.mjs';
import {adjustOf, isPlainAdjust, cropOf, PIC_GEOMS} from './object-fx.mjs';

const EMU_PER_PX = 9525;
const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const KIND_URI = 'urn:arkemis:chart-kind';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const EXTENSION_KINDS = ['histogram', 'waterfall', 'funnel', 'treemap', 'sunburst', 'boxWhisker', 'pareto'];

const esc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escAttr = s => esc(s).replaceAll('"', '&quot;');

// ---------------------------------------------------------------------------------------------
// What Shape Format, Picture Format and Chart Format set (core/grid/lib/object-fx.mjs): the DrawingML Excel understands (a picture's crop,
// frame shape, border and corrections, the effect list of a shape, the area of a chart) and, beside it, the exact stored fields in a
// cNvPr extension so that our own files read back unchanged. Not in gridcraft; not checked against upstream.

const FX_URI = 'urn:arkemis:object-fx';
const FX_KEYS = {image: ['fx', 'adjust', 'crop', 'border', 'geom', 'pstyle', 'decorative'], shape: ['fx', 'textFx', 'style', 'decorative'], chart: ['fx', 'textFx', 'area', 'plot', 'areaStyle', 'decorative']};
/** The cNvPr extension holding an object's stored formatting ('' when it has none). */
function fxExt(kind, o) {
  const data = {};
  for (const k of FX_KEYS[kind] ?? []) if (o[k] !== undefined) data[k] = o[k];
  return Object.keys(data).length ? `<a:extLst><a:ext uri="${FX_URI}"><ark:fx xmlns:ark="urn:arkemis" json="${escAttr(JSON.stringify(data))}"/></a:ext></a:extLst>` : '';
}
/** The formatting a cNvPr extension holds, or {}. */
function readFxExt(cNvPr, kind) {
  const e = cNvPr?.child('extLst')?.kids('ext').find(x => x.attr('uri') === FX_URI)?.child('fx');
  if (!e) return {};
  try {
    const j = JSON.parse(e.attr('json'));
    const out = {};
    for (const k of FX_KEYS[kind] ?? []) if (j && j[k] !== undefined) out[k] = j[k];
    return out;
  } catch { return {}; }
}
/** Quill's effect list writer (a:effectLst, a:scene3d, a:sp3d) run into a string. */
function effectsXml(fx) {
  if (!fx) return '';
  let out = '';
  const attrs = a => a.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  writeEffects({open: (n, a = []) => { out += `<${n}${attrs(a)}>`; }, empty: (n, a = []) => { out += `<${n}${attrs(a)}/>`; }, close: n => { out += `</${n}>`; }}, fx);
  return out;
}
const px = v => Math.round(Math.max(0, v) * EMU_PER_PX);
const hex2 = n => n.toString(16).padStart(2, '0').toUpperCase();

// ---------------------------------------------------------------------------------------------
// Reading

const emuPx = v => (Number.isFinite(v) ? Math.min(1e7, Math.max(-1e7, v / EMU_PER_PX)) : 0);
function marker(e) {
  const n = k => { const t = e.child(k)?.text?.trim(); const v = t === undefined ? NaN : Number(t); return Number.isFinite(v) ? v : undefined; };
  return {col: Math.min(16383, Math.max(0, n('col') ?? 0)), row: Math.min(1048575, Math.max(0, n('row') ?? 0)), dx: Math.max(0, emuPx(n('colOff') ?? 0)), dy: Math.max(0, emuPx(n('rowOff') ?? 0))};
}
const extPx = e => (e ? {w: Math.max(0, emuPx(e.num('cx') ?? 0)), h: Math.max(0, emuPx(e.num('cy') ?? 0))} : {w: 0, h: 0});

function readAnchor(a, sheet) {
  switch (a.name) {
    case 'twoCellAnchor': {
      const from = a.child('from');
      if (!from) return null;
      const f = marker(from), t = a.child('to') ? marker(a.child('to')) : f;
      const x1 = colLeft(sheet, f.col) + f.dx, y1 = rowTop(sheet, f.row) + f.dy, x2 = colLeft(sheet, t.col) + t.dx, y2 = rowTop(sheet, t.row) + t.dy;
      // Excel stores "Move and size with cells" as a plain twoCellAnchor, "Move but don't size" as editAs="oneCell", "Don't move or size" as editAs="absolute".
      const edit = a.attr('editAs');
      const mode = edit === 'absolute' ? 'absolute' : edit === 'oneCell' ? 'moveOnly' : 'moveAndSize';
      return {cell: a1(f.row, f.col), dx: Math.round(f.dx), dy: Math.round(f.dy), width: Math.max(0, Math.round(x2 - x1)), height: Math.max(0, Math.round(y2 - y1)), mode};
    }
    case 'oneCellAnchor': {
      const from = a.child('from');
      if (!from) return null;
      const f = marker(from), e = extPx(a.child('ext'));
      return {cell: a1(f.row, f.col), dx: Math.round(f.dx), dy: Math.round(f.dy), width: Math.round(e.w), height: Math.round(e.h), mode: 'moveOnly'};
    }
    case 'absoluteAnchor': {
      const pos = a.child('pos');
      const x = Math.max(0, emuPx(pos?.num('x') ?? 0)), y = Math.max(0, emuPx(pos?.num('y') ?? 0));
      const col = colAt(sheet, x), row = rowAt(sheet, y), e = extPx(a.child('ext'));
      return {cell: a1(row, col), dx: Math.round(Math.max(0, x - colLeft(sheet, col))), dy: Math.round(Math.max(0, y - rowTop(sheet, row))), width: Math.round(e.w), height: Math.round(e.h), mode: 'absolute'};
    }
    default: return null;
  }
}

const SCHEME = {bg1: 0, lt1: 0, tx1: 1, dk1: 1, bg2: 2, lt2: 2, tx2: 3, dk2: 3, accent1: 4, accent2: 5, accent3: 6, accent4: 7, accent5: 8, accent6: 9, hlink: 10, folHlink: 11};
/** The colour of a DrawingML colour choice inside `e` (a solidFill): '#RRGGBB', {theme, tint}, or null. */
export function dmlColor(e) {
  const rgb = e?.child('srgbClr')?.attr('val');
  if (rgb && /^[0-9a-fA-F]{6}$/.test(rgb)) return `#${rgb.toUpperCase()}`;
  const sys = e?.child('sysClr')?.attr('lastClr');
  if (sys && /^[0-9a-fA-F]{6}$/.test(sys)) return `#${sys.toUpperCase()}`;
  const sc = e?.child('schemeClr')?.attr('val');
  if (sc !== undefined && SCHEME[sc] !== undefined) return {theme: SCHEME[sc], tint: 0};
  return null;
}

function readTextFormat(body) {
  const f = {};
  if (!body) return f;
  const anchor = body.child('bodyPr')?.attr('anchor');
  if (anchor) f.anchor = anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top';
  const ppr = body.kids('p')[0]?.child('pPr');
  const algn = ppr?.attr('algn');
  if (algn) f.align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : 'left';
  if (ppr?.flag('rtl', false)) f.rtl = true;
  const rpr = body.kids('p').flatMap(p => p.kids('r')).map(r => r.child('rPr')).find(Boolean);
  if (rpr) {
    const sz = rpr.num('sz');
    if (sz !== undefined && Number.isFinite(sz)) f.fontSize = Math.min(4000, Math.max(1, sz / 100));
    if (rpr.flag('b', false)) f.bold = true;
    if (rpr.flag('i', false)) f.italic = true;
    const face = rpr.child('latin')?.attr('typeface');
    if (face && !face.startsWith('+')) f.font = face;
    const c = dmlColor(rpr.child('solidFill'));
    if (c) f.textColor = c;
  }
  return f;
}

/**
 * A stroke of ink: the one shape the writer below makes (an unfilled custom geometry of one open polyline, a solid line of 1 to 40
 * pixels, 45% alpha when wider than 8), read back as a shape of kind `ink`. Anything else keeps the shape fallback (gridcraft
 * crates/xlsx/src/drawing/ink.rs: a path is not imported partially).
 */
function readInk(obj, anchor) {
  const sp = obj.child('spPr');
  const geom = sp?.child('custGeom');
  if (!geom || !sp.child('noFill') || obj.path(['nvSpPr', 'cNvSpPr'])?.flag('txBox', false)) return null;
  const paths = geom.child('pathLst')?.kids('path') ?? [];
  if (paths.length !== 1) return null;
  const path = paths[0];
  const w = path.num('w'), h = path.num('h');
  if (!(w > 0) || !(h > 0) || path.attr('fill') !== 'none' || path.children.length < 2) return null;
  const pts = [];
  for (let i = 0; i < path.children.length; i++) {
    const c = path.children[i];
    if (c.name !== (i === 0 ? 'moveTo' : 'lnTo')) return null;
    const pt = c.child('pt');
    const x = pt?.num('x'), y = pt?.num('y');
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pts.push([x / EMU_PER_PX, y / EMU_PER_PX]);
  }
  const ln = sp.child('ln');
  const wEmu = ln?.num('w');
  const width = Math.round((wEmu ?? 0) / EMU_PER_PX);
  const color = dmlColor(ln?.child('solidFill'));
  if (!(width >= 1 && width <= 40) || typeof color !== 'string') return null;
  // The path's own extent is the stroke's (the anchor cells round it to a pixel).
  return {kind: 'ink', anchor: {...anchor, width: w / EMU_PER_PX, height: h / EMU_PER_PX, mode: 'absolute'}, fill: widthFill(width), line: color, text: inkText(pts)};
}

// What Page Layout > Arrange and the Insert > Text gallery add to an object: its name, whether it is hidden (Selection Pane), the group it is in,
// and what makes a shape a WordArt, signature line or equation. Kept in an extension of the object's own properties (Excel ignores it).
const OBJ_URI = 'urn:arkemis:object';
const EXTRA_KEYS = ['name', 'hidden', 'group', 'regroup', 'wordArt', 'signature', 'equation'];
function readExtra(cNvPr) {
  const el = cNvPr?.child('extLst')?.kids('ext').find(e => e.attr('uri') === OBJ_URI)?.child('object');
  if (!el) return {};
  try {
    const o = JSON.parse(el.attr('json') ?? '{}');
    const out = {};
    for (const k of EXTRA_KEYS) if (o[k] !== undefined) out[k] = o[k];
    if (typeof o.shapeKind === 'string') out.shapeKind = o.shapeKind;
    return out;
  } catch { return {}; }
}
/** A picture's or shape's turn and mirror (`a:xfrm rot flipH flipV`). */
function readTurn(spPr) {
  const x = spPr?.child('xfrm');
  const out = {};
  const rot = x?.num('rot');
  if (Number.isFinite(rot) && rot % 21600000 !== 0) out.rotation = Math.round((((rot / 60000) % 360) + 360) % 360 * 100) / 100;
  if (x?.flag('flipH', false)) out.flipH = true;
  if (x?.flag('flipV', false)) out.flipV = true;
  return out;
}
function withExtra(object, cNvPr, spPr) {
  const {shapeKind, ...extra} = readExtra(cNvPr);
  Object.assign(object, extra, readTurn(spPr));
  const nm = cNvPr?.attr('name');
  // A name a person gave (the pane lists it), not the "Picture 3" an application numbers.
  if (nm && !/^(Picture|Chart|Shape|Icon|Ink|Text Box|Rectangle|Oval|Straight Connector|Content Placeholder)\s*\d*$/i.test(nm.trim())) object.name = nm;
  if (cNvPr?.flag('hidden', false)) object.hidden = true;
  if (shapeKind && ['wordArt', 'signature', 'equation'].includes(shapeKind)) object.kind = shapeKind;
  return object;
}

function readShape(obj, anchor) {
  const sp = obj.child('spPr');
  if (!sp) return null;
  const ink = readInk(obj, anchor);
  if (ink) return ink;
  const prst = sp.child('prstGeom')?.attr('prst') ?? 'rect';
  const txBox = obj.path(['nvSpPr', 'cNvSpPr'])?.flag('txBox', false) ?? false;
  const ln = sp.child('ln');
  const arrow = !!ln && [ln.child('tailEnd'), ln.child('headEnd')].some(t => t && t.attr('type') && t.attr('type') !== 'none');
  const descr = obj.path(['nvSpPr', 'cNvPr'])?.attr('descr') ?? '';
  const icon = /^icon:([^;]+)(?:;color:(#[0-9A-Fa-f]{6}))?$/.exec(descr);
  let kind;
  if (icon && iconPath(icon[1])) kind = 'icon';
  else if (txBox) kind = 'textBox';
  else if (prst === 'roundRect') kind = 'roundedRectangle';
  else if (prst === 'ellipse') kind = 'ellipse';
  else if (prst === 'triangle') kind = 'triangle';
  else if (prst === 'line' || prst === 'straightConnector1') kind = arrow ? 'arrow' : 'line';
  else if (prst === 'rightArrow') kind = 'arrow';
  else kind = 'rectangle';
  const text = obj.child('txBody') ? obj.child('txBody').kids('p').map(p => p.kids('r').map(r => r.child('t')?.text ?? '').join('')).join('\n') : '';
  const shape = {kind, anchor, fill: dmlColor(sp.child('solidFill')) ?? 'auto', line: dmlColor(ln?.child('solidFill')) ?? 'auto', text};
  if (kind === 'icon') { shape.text = icon[1]; shape.fill = icon[2] ?? shape.fill; shape.line = 'auto'; }
  const format = readTextFormat(obj.child('txBody'));
  if (ln?.child('noFill')) format.noLine = true;
  if (Object.keys(format).length) shape.format = format;
  const cnv = obj.path(['nvSpPr', 'cNvPr']);
  if (kind !== 'icon' && cnv?.attr('descr')) shape.alt = cnv.attr('descr');
  Object.assign(shape, readFxExt(cnv, 'shape'));
  return shape;
}

/** A picture's crop and frame shape as Excel writes them (our own corrections come from the extension). */
function readPictureFormat(obj) {
  const out = {};
  const sr = obj.path(['blipFill', 'srcRect']);
  if (sr) {
    const f = k => Math.min(0.95, Math.max(0, (sr.num(k) ?? 0) / 100000));
    const c = {l: f('l'), t: f('t'), r: f('r'), b: f('b')};
    if (c.l || c.t || c.r || c.b) out.crop = c;
  }
  const prst = obj.child('spPr')?.child('prstGeom')?.attr('prst');
  if (prst && prst !== 'rect' && PIC_GEOMS.includes(prst)) out.geom = prst;
  return out;
}

/** Reads a worksheet's drawing part into `sheet.images`, `sheet.shapes` and `sheet.charts`. `cx.nextObjectId()` numbers them. */
export async function readDrawing(pkg, cx, part, sheet) {
  const x = await pkg.xml(part);
  if (!x) return;
  const rels = await pkg.rels(part);
  let n = 0, z = 0, gid = 0;
  for (const a of x.children) {
    n += 1;
    const anchor = readAnchor(a, sheet);
    if (!anchor) continue;
    const objs = a.children.flatMap(o => (o.name === 'AlternateContent' ? (o.child('Choice')?.child('graphicFrame') ? [...o.child('Choice').children] : [...(o.child('Fallback')?.children ?? [])]) : [o]));
    const handle = async (obj, anchor, group) => {
      switch (obj.name) {
        case 'pic': {
          const rid = obj.path(['blipFill', 'blip'])?.attr('embed');
          const rel = rels.find(r => r.id === rid && !r.external);
          if (!rel) { cx.warn('a linked (not embedded) picture was skipped'); break; }
          const file = pkg.file(rel.target);
          if (!file) { cx.warn(`missing picture ${rel.target}`); break; }
          const bytes = await pkg.bytes(file);
          const ext = rel.target.split('.').pop().toLowerCase();
          (sheet.images ??= []).push(withExtra({id: cx.nextObjectId(), z: z++, anchor, data: bytesToBase64(bytes), mime: MIME_FOR_EXT[ext] ?? 'application/octet-stream', alt: obj.path(['nvPicPr', 'cNvPr'])?.attr('descr') ?? '', ...readPictureFormat(obj), ...readFxExt(obj.path(['nvPicPr', 'cNvPr']), 'image'), ...(group ? {group} : {})}, obj.path(['nvPicPr', 'cNvPr']), obj.child('spPr')));;
          break;
        }
        case 'graphicFrame': {
          const gd = obj.path(['graphic', 'graphicData']);
          // A slicer or timeline: only its place is kept here; the slicer parts say what it is.
          const sf = gd?.child('slicer') ?? gd?.child('timeslicer');
          if (sf) { (cx.frames ??= new Map()).set(`${sheet.name}|${sf.attr('name')}`, anchor); break; }
          const rid = gd?.child('chart')?.attr('id');
          const rel = rid ? rels.find(r => r.id === rid) : null;
          if (!rel) { cx.warn(`an embedded object (SmartArt, OLE, a chart without its part) was skipped (${part}, object ${n})`); break; }
          if (String(gd.attr('uri') ?? '').toLowerCase().includes('chartex')) { cx.warn(`a histogram, waterfall, treemap... chart in Excel's extension format was skipped (${part}, object ${n})`); break; }
          const chartXml = await pkg.xml(rel.target);
          const chart = chartXml ? readChart(chartXml) : null;
          if (!chart) { cx.warn(`chart ${rel.target} has no supported plot and was skipped`); break; }
          const chartCnv = obj.path(['nvGraphicFramePr', 'cNvPr']);
          (sheet.charts ??= []).push(withExtra({id: cx.nextObjectId(), z: z++, ...chart, ...(chartCnv?.attr('descr') ? {alt: chartCnv.attr('descr')} : {}), ...readFxExt(chartCnv, 'chart'), anchor, ...(group ? {group} : {})}, chartCnv, null));
          break;
        }
        case 'sp': case 'cxnSp': {
          const shape = readShape(obj, anchor);
          if (shape) (sheet.shapes ??= []).push(withExtra({id: cx.nextObjectId(), z: z++, ...shape, ...(group ? {group} : {})}, obj.path(['nvSpPr', 'cNvPr']), obj.child('spPr')));
          break;
        }
        case 'grpSp': {
          // A group: its members are read as objects of one group, each placed through the group's own scale (child space to the sheet).
          const gx = obj.child('grpSpPr')?.child('xfrm');
          if (!gx?.child('off') || !gx.child('ext')) { cx.warn(`a group without a position was skipped (${part}, object ${n})`); break; }
          const v = (e, k) => e?.num(k) ?? 0;
          const sx = v(gx.child('chExt'), 'cx') ? v(gx.child('ext'), 'cx') / v(gx.child('chExt'), 'cx') : 1;
          const sy = v(gx.child('chExt'), 'cy') ? v(gx.child('ext'), 'cy') / v(gx.child('chExt'), 'cy') : 1;
          const id = ++gid;
          for (const child of obj.children) {
            const cxf = child.name === 'grpSp' ? child.child('grpSpPr')?.child('xfrm') : child.name === 'graphicFrame' ? child.child('xfrm') : child.child('spPr')?.child('xfrm');
            if (!cxf?.child('off') || !cxf.child('ext') || !['sp', 'cxnSp', 'pic', 'graphicFrame', 'grpSp'].includes(child.name)) continue;
            const x0 = (v(gx.child('off'), 'x') + (v(cxf.child('off'), 'x') - v(gx.child('chOff'), 'x')) * sx) / EMU_PER_PX;
            const y0 = (v(gx.child('off'), 'y') + (v(cxf.child('off'), 'y') - v(gx.child('chOff'), 'y')) * sy) / EMU_PER_PX;
            const w0 = v(cxf.child('ext'), 'cx') * sx / EMU_PER_PX, h0 = v(cxf.child('ext'), 'cy') * sy / EMU_PER_PX;
            await handle(child, anchorAt(sheet, Math.max(0, x0), Math.max(0, y0), Math.round(w0), Math.round(h0), anchor.mode), id);
          }
          break;
        }
        default: break;
      }
    };
    for (const obj of objs) await handle(obj, anchor, null);
  }
}

// ---------------------------------------------------------------------------------------------
// Chart parts: reading

function groupKind(g) {
  const grouping = g.childVal('grouping') ?? 'standard';
  const stacked = grouping === 'stacked', pct = grouping === 'percentStacked';
  switch (g.name) {
    case 'barChart': case 'bar3DChart': {
      const bar = g.childVal('barDir') === 'bar';
      if (bar) return stacked ? 'barStacked' : pct ? 'barStacked100' : 'barClustered';
      return stacked ? 'columnStacked' : pct ? 'columnStacked100' : 'columnClustered';
    }
    case 'lineChart': case 'line3DChart': {
      if (stacked || pct) return 'lineStacked';
      const groupMarkers = g.childVal('marker') === undefined || g.childVal('marker') === '1' || g.childVal('marker') === 'true';
      const sers = g.kids('ser');
      const allNone = sers.length > 0 && sers.every(s => s.path(['marker', 'symbol'])?.attr('val') === 'none');
      return !groupMarkers || allNone ? 'line' : 'lineMarkers';
    }
    case 'pieChart': return 'pie';
    case 'pie3DChart': return 'pie3d';
    case 'ofPieChart': return g.childVal('ofPieType') === 'bar' ? 'barOfPie' : 'pieOfPie';
    case 'doughnutChart': return 'doughnut';
    case 'areaChart': case 'area3DChart': return pct ? 'areaStacked100' : stacked ? 'areaStacked' : 'area';
    case 'scatterChart': {
      const sers = g.kids('ser');
      const noLines = sers.length > 0 && sers.every(s => s.path(['spPr', 'ln'])?.child('noFill'));
      return g.childVal('scatterStyle') === 'marker' || noLines ? 'scatter' : 'scatterLines';
    }
    case 'bubbleChart': return g.kids('ser').some(s => s.child('bubble3D')?.flag('val', true)) ? 'bubble3d' : 'bubble';
    case 'radarChart': return 'radar';
    case 'stockChart': return 'stock';
    default: return null;
  }
}

/** `[0]!` in front of a workbook-scoped name, and a leading `=`, dropped. */
const chartRef = text => String(text).trim().replace(/^=/, '').replace(/(^|[^\w.\\'"!$#[\]])\[0\]!(?=[A-Za-z_\\])/g, '$1');

function dataRef(e) {
  if (!e) return undefined;
  for (const k of ['numRef', 'strRef', 'multiLvlStrRef']) {
    const f = e.child(k)?.child('f');
    if (f) return chartRef(f.text);
  }
  for (const k of ['numLit', 'strLit']) {
    const l = e.child(k);
    if (l) return `{${l.kids('pt').map(p => p.child('v')?.text ?? '').map(v => (k === 'numLit' ? v.trim() : `"${v.replaceAll('"', '""')}"`)).join(',')}}`;
  }
  return undefined;
}

const TREND_READ = {linear: 'linear', exp: 'exponential', log: 'logarithmic', power: 'power', poly: 'polynomial', movingAvg: 'movingAverage'};
const TREND_WRITE = Object.fromEntries(Object.entries(TREND_READ).map(([k, v]) => [v, k]));
const EMU_PER_PT = 12700;
const clampForecast = v => (Number.isFinite(v) && v > 0 ? Math.min(v, 100_000) : 0);

/** `<c:trendline>` (ECMA-376 21.2.2.211) as a chart trendline (chart-trend.mjs); unknown types are dropped. */
function readTrendline(t) {
  const type = TREND_READ[t.child('trendlineType')?.attr('val') ?? 'linear'];
  if (!type) return null;
  const val = tag => { const n = Number(t.child(tag)?.attr('val')); return t.child(tag)?.attr('val') !== undefined && Number.isFinite(n) ? n : undefined; };
  const out = {type, forward: clampForecast(val('forward') ?? 0), backward: clampForecast(val('backward') ?? 0), displayEquation: !!t.child('dispEq')?.flag('val', true), displayRSquared: !!t.child('dispRSqr')?.flag('val', true)};
  if (type === 'polynomial') out.order = Math.min(6, Math.max(2, Math.trunc(val('order') ?? 2)));
  if (type === 'movingAverage') out.period = Math.min(255, Math.max(2, Math.trunc(val('period') ?? 2)));
  const name = t.child('name')?.text;
  if (name) out.name = name;
  if (val('intercept') !== undefined) out.intercept = val('intercept');
  const ln = t.path(['spPr', 'ln']);
  const color = dmlColor(ln?.child('solidFill'));
  if (color) out.color = color;
  const w = Number(ln?.attr('w'));
  if (ln?.attr('w') !== undefined && Number.isFinite(w) && w >= 0) out.width = w / EMU_PER_PT;
  const dash = ln?.child('prstDash')?.attr('val');
  if (dash) out.dash = dash === 'solid' ? 'solid' : 'dash';
  return out;
}

function readSeries(s) {
  const tx = s.child('tx');
  const name = tx ? (tx.path(['strRef', 'f']) ? chartRef(tx.path(['strRef', 'f']).text) : tx.child('v')?.text) : undefined;
  const sp = s.child('spPr');
  const color = dmlColor(sp?.child('solidFill')) ?? dmlColor(sp?.path(['ln', 'solidFill'])) ?? dmlColor(s.path(['marker', 'spPr', 'solidFill']));
  const out = {values: dataRef(s.child('val')) ?? dataRef(s.child('yVal')) ?? ''};
  if (name) out.name = name;
  const cat = dataRef(s.child('cat')) ?? dataRef(s.child('xVal'));
  if (cat) out.categories = cat;
  const sizes = dataRef(s.child('bubbleSize'));
  if (sizes) out.bubbleSizes = sizes;
  if (color) out.color = color;
  if (s.child('smooth')?.flag('val', true)) out.smooth = true;
  const trendlines = s.kids('trendline').map(readTrendline).filter(Boolean);
  if (trendlines.length) out.trendlines = trendlines;
  return out;
}

function richTitle(t) {
  const tx = t.child('tx');
  const rich = tx?.child('rich');
  if (rich) { const s = rich.kids('p').map(p => p.kids('r').map(r => r.child('t')?.text ?? '').join('')).join('\n'); return s || undefined; }
  const sr = tx?.child('strRef');
  if (sr) return sr.path(['strCache', 'pt', 'v'])?.text ?? sr.child('f')?.text.trim();
  return undefined;
}
const axisIds = g => g.kids('axId').map(a => a.attr('val'));

/** A chart part's chart (without id and anchor), or null when it has no plot Excel's common groups cover. */
export function readChart(root) {
  const chart = root.child('chart');
  const plot = chart?.child('plotArea');
  if (!plot) return null;
  const groups = plot.children.map(g => [g, groupKind(g)]).filter(([, k]) => k);
  if (!groups.length) return null;
  const [first, firstKind] = groups[0];
  const firstAxes = axisIds(first).join();
  const series = [];
  groups.forEach(([g, k], gi) => {
    for (const s of g.kids('ser')) {
      const ser = readSeries(s);
      // Every series of a combo chart keeps its own group's kind, the first group's included.
      if (groups.length > 1) ser.kind = k;
      if (gi > 0 && axisIds(g).join() !== firstAxes) ser.secondary = true;
      series.push(ser);
    }
  });
  let kind = groups.length > 1 ? 'combo' : firstKind;
  const hint = root.child('extLst')?.kids('ext').find(e => e.attr('uri') === KIND_URI)?.child('kind')?.attr('val');
  if (hint && EXTENSION_KINDS.includes(hint)) kind = hint;
  const showVal = e => e.child('dLbls')?.child('showVal')?.flag('val', true) === true;
  const dataLabels = groups.some(([g]) => showVal(g) || g.kids('ser').some(showVal));
  const valAxes = plot.kids('valAx');
  const catAx = plot.child('catAx') ?? plot.child('dateAx');
  const scatter = ['scatter', 'scatterLines', 'bubble'].includes(firstKind);
  const xAx = scatter ? valAxes.find(a => ['b', 't'].includes(a.childVal('axPos'))) : catAx;
  const yAx = scatter ? valAxes.find(a => ['l', 'r'].includes(a.childVal('axPos'))) : valAxes[0];
  const legendEl = chart.child('legend');
  const legend = !legendEl ? 'none' : ({b: 'bottom', t: 'top', l: 'left'})[legendEl.childVal('legendPos') ?? 'r'] ?? 'right';
  const out = {kind, series, legend, dataLabels, gridlines: valAxes.some(a => a.child('majorGridlines')), style: Number(root.childVal('style')) || 2, byRows: false};
  const pivotName = root.path(['pivotSource', 'name'])?.text?.trim().replace(/^\[[^\]]*\]/, '');
  if (pivotName) out.pivot = pivotName;
  const title = chart.child('title') ? richTitle(chart.child('title')) : undefined;
  if (title !== undefined) out.title = title;
  const xt = xAx?.child('title') ? richTitle(xAx.child('title')) : undefined;
  const yt = yAx?.child('title') ? richTitle(yAx.child('title')) : undefined;
  if (xt) out.xTitle = xt;
  if (yt) out.yTitle = yt;
  readChartElements(plot, groups.map(([g]) => g), catAx, valAxes, out);
  return out;
}

/** Add Chart Element parts of a chart: hidden axes, data table, error bars, drop / high-low / series lines, up/down bars. */
function readChartElements(plot, groups, catAx, valAxes, out) {
  const axes = {};
  if (catAx?.child('delete')?.flag('val', false) === true) axes.category = false;
  if (valAxes[0]?.child('delete')?.flag('val', false) === true) axes.value = false;
  if (Object.keys(axes).length) out.axes = axes;
  const dt = plot.child('dTable');
  if (dt) out.dataTable = {keys: dt.child('showKeys')?.flag('val', true) !== false};
  const eb = groups.flatMap(g => g.kids('ser')).map(s => s.kids('errBars').find(e => (e.childVal('errDir') ?? 'y') === 'y')).find(Boolean);
  if (eb) {
    const type = {fixedVal: 'fixed', percentage: 'percentage', stdDev: 'standardDeviation', stdErr: 'standardError'}[eb.childVal('errValType')];
    if (type) {
      out.errorBars = {type, direction: eb.childVal('errBarType') ?? 'both', cap: eb.child('noEndCap')?.flag('val', false) !== true};
      const v = Number(eb.childVal('val'));
      if (Number.isFinite(v) && type !== 'standardError') out.errorBars.value = v;
    }
  }
  for (const g of groups) {
    if (g.child('dropLines')) out.lines = 'drop';
    else if (g.child('hiLowLines') && g.name !== 'stockChart') out.lines = 'highLow';
    else if (g.child('serLines')) out.lines = 'series';
    if (g.child('upDownBars')) out.upDownBars = true;
  }
}

// ---------------------------------------------------------------------------------------------
// Writing: the drawing part

function anchorOpen(sheet, a) {
  const c = parseCell(a.cell) ?? {row: 0, col: 0};
  const x1 = colLeft(sheet, c.col) + (a.dx ?? 0), y1 = rowTop(sheet, c.row) + (a.dy ?? 0);
  const x2 = x1 + Math.max(0, a.width ?? 0), y2 = y1 + Math.max(0, a.height ?? 0);
  const tc = colAt(sheet, x2), tr = rowAt(sheet, y2);
  const edit = a.mode === 'moveOnly' ? ' editAs="oneCell"' : a.mode === 'absolute' ? ' editAs="absolute"' : '';
  return `<xdr:twoCellAnchor${edit}><xdr:from><xdr:col>${c.col}</xdr:col><xdr:colOff>${px(a.dx ?? 0)}</xdr:colOff><xdr:row>${c.row}</xdr:row><xdr:rowOff>${px(a.dy ?? 0)}</xdr:rowOff></xdr:from>`
    + `<xdr:to><xdr:col>${tc}</xdr:col><xdr:colOff>${px(x2 - colLeft(sheet, tc))}</xdr:colOff><xdr:row>${tr}</xdr:row><xdr:rowOff>${px(y2 - rowTop(sheet, tr))}</xdr:rowOff></xdr:to>`;
}
const xfrm = (a, tag, o) => {
  const rot = o?.rotation ? ` rot="${Math.round(o.rotation * 60000)}"` : '';
  return `<${tag}${rot}${o?.flipH ? ' flipH="1"' : ''}${o?.flipV ? ' flipV="1"' : ''}><a:off x="0" y="0"/><a:ext cx="${px(a.width)}" cy="${px(a.height)}"/></${tag}>`;
};
/** The `<xdr:cNvPr>` of an object: id, its name (given in the Selection Pane, else `fallback`), hidden, `attrs` and the extension that keeps group, WordArt and the rest. */
function cNvPrXml(o, id, fallback, attrs = '', fx = '') {
  const extra = {};
  for (const k of EXTRA_KEYS) if (o[k] !== undefined && k !== 'name' && k !== 'hidden') extra[k] = o[k];
  if (['wordArt', 'signature', 'equation'].includes(o.kind)) extra.shapeKind = o.kind;
  const head = `<xdr:cNvPr id="${id}" name="${escAttr(o.name || fallback)}"${o.hidden === true ? ' hidden="1"' : ''}${attrs}`;
  const fxInner = fx.replace(/^<a:extLst>|<\/a:extLst>$/g, '');
  const mine = Object.keys(extra).length ? `<a:ext uri="${OBJ_URI}"><ark:object xmlns:ark="urn:arkemis" json="${escAttr(JSON.stringify(extra))}"/></a:ext>` : '';
  if (!fxInner && !mine) return `${head}/>`;
  return `${head}><a:extLst>${fxInner}${mine}</a:extLst></xdr:cNvPr>`;
}

function srgb(c, theme) {
  const rgb = resolveColor(c, theme);
  return rgb ? `<a:srgbClr val="${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}"/>` : null;
}

function runProps(f, theme) {
  let attrs = '', body = '';
  if (Number.isFinite(f.fontSize)) attrs += ` sz="${Math.round(Math.min(4000, Math.max(1, f.fontSize)) * 100)}"`;
  if (f.bold) attrs += ' b="1"';
  if (f.italic) attrs += ' i="1"';
  const c = f.textColor ? srgb(f.textColor, theme) : null;
  if (c) body += `<a:solidFill>${c}</a:solidFill>`;
  if (f.font) body += `<a:latin typeface="${escAttr(f.font)}"/>`;
  return [attrs, body];
}

/** A stroke of ink as DrawingML: one open polyline in a custom geometry, drawn with a solid line (45% alpha for a highlighter). */
function inkXml(sh, theme, id) {
  const pts = inkPoints(sh);
  const a = sh.anchor;
  if (pts.length < 2 || !(a.width > 0) || !(a.height > 0)) return null;
  const width = Math.min(40, Math.max(1, Math.round(inkWidth(sh))));
  const rgb = resolveColor(sh.line, theme) ?? [0, 0, 0];
  let s = `<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${id}" name="Ink ${id}"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr>${xfrm(a, 'a:xfrm')}<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:pathLst><a:path w="${px(a.width)}" h="${px(a.height)}" fill="none">`;
  pts.forEach(([x, y], i) => { const tag = i === 0 ? 'moveTo' : 'lnTo'; s += `<a:${tag}><a:pt x="${px(x)}" y="${px(y)}"/></a:${tag}>`; });
  s += `</a:path></a:pathLst></a:custGeom><a:noFill/><a:ln w="${width * EMU_PER_PX}" cap="flat"><a:solidFill><a:srgbClr val="${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}">${width > HIGHLIGHTER_WIDTH ? '<a:alpha val="45000"/>' : ''}</a:srgbClr></a:solidFill><a:miter/></a:ln></xdr:spPr></xdr:sp>`;
  return s;
}

/** A picture: its image, crop, corrections (Excel's own elements and our exact values), frame shape, border and effects. */
function picXml(img, theme, id, rid, frame) {
  const adj = adjustOf(img), c = cropOf(img);
  let blip = '';
  if (adj.brightness || adj.contrast) blip += `<a:lum bright="${Math.round(adj.brightness * 1000)}" contrast="${Math.round(adj.contrast * 1000)}"/>`;
  else if (adj.recolor === 'washout') blip += '<a:lum bright="70000" contrast="-70000"/>';
  if (adj.recolor === 'grayscale') blip += '<a:grayscl/>';
  else if (adj.recolor === 'blackWhite') blip += '<a:biLevel thresh="50000"/>';
  else if (adj.recolor === 'sepia') blip += '<a:duotone><a:prstClr val="black"/><a:srgbClr val="D9C3A5"><a:tint val="50000"/><a:satMod val="180000"/></a:srgbClr></a:duotone>';
  if (adj.saturation !== 100) blip += `<a:hsl hue="0" sat="${Math.round((adj.saturation - 100) * 1000)}" lum="0"/>`;
  if (adj.transparency) blip += `<a:alphaModFix amt="${Math.round((100 - adj.transparency) * 1000)}"/>`;
  const src = c.l || c.t || c.r || c.b ? `<a:srcRect l="${Math.round(c.l * 100000)}" t="${Math.round(c.t * 100000)}" r="${Math.round(c.r * 100000)}" b="${Math.round(c.b * 100000)}"/>` : '';
  const geom = PIC_GEOMS.includes(img.geom) ? img.geom : 'rect';
  const bc = img.border ? srgb(img.border.color, theme) : null;
  const ln = bc ? `<a:ln w="${Math.round((img.border.width ?? 2.25) * EMU_PER_PX)}"><a:solidFill>${bc}</a:solidFill></a:ln>` : '';
  const deco = img.decorative === true;
  const ext = fxExt('image', img);
  return `<xdr:pic><xdr:nvPicPr>${cNvPrXml(img, id, `Picture ${id - 1}`, ` descr="${escAttr(deco ? '' : img.alt ?? '')}"`, ext)}<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
    + `<xdr:blipFill>${blip ? `<a:blip r:embed="${rid}">${blip}</a:blip>` : `<a:blip r:embed="${rid}"/>`}${src}<a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr>${frame}<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${ln}${effectsXml(img.fx)}</xdr:spPr></xdr:pic>`;
}

function shapeXml(sh, theme, id) {
  if (sh.kind === 'ink') { const ink = inkXml(sh, theme, id); if (ink) return ink; sh = {...sh, kind: 'rectangle', fill: 'auto', text: ''}; }
  const PRST = {rectangle: 'rect', roundedRectangle: 'roundRect', ellipse: 'ellipse', triangle: 'triangle', line: 'line', arrow: 'line', textBox: 'rect', icon: 'rect', wordArt: 'rect', signature: 'rect', equation: 'rect'};
  const prst = PRST[sh.kind] ?? 'rect';
  const tx = sh.kind === 'textBox' || sh.kind === 'wordArt' || sh.kind === 'signature' || sh.kind === 'equation';
  const icon = sh.kind === 'icon';
  const descr = icon ? ` descr="${escAttr(`icon:${sh.text}${sh.fill && sh.fill !== 'auto' ? `;color:${resolveHex(sh.fill, theme)}` : ''}`)}"` : sh.alt && !sh.decorative ? ` descr="${escAttr(sh.alt)}"` : '';
  const shapeExt = icon ? '' : fxExt('shape', sh);
  let s = `<xdr:sp macro="" textlink=""><xdr:nvSpPr>${cNvPrXml(sh, id, `${icon ? 'Icon' : 'Shape'} ${id - 1}`, descr, shapeExt)}<xdr:cNvSpPr${tx ? ' txBox="1"' : ''}/></xdr:nvSpPr><xdr:spPr>${xfrm(sh.anchor, 'a:xfrm', sh)}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>`;
  if (icon) s += '<a:noFill/><a:ln><a:noFill/></a:ln>';
  else {
    const fill = sh.fill !== 'auto' && sh.kind !== 'line' && sh.kind !== 'arrow' ? srgb(sh.fill, theme) : null;
    if (fill) s += `<a:solidFill>${fill}</a:solidFill>`;
    const line = sh.line !== 'auto' ? srgb(sh.line, theme) : null;
    if (sh.format?.noLine) s += '<a:ln><a:noFill/></a:ln>';
    else if (line || sh.kind === 'arrow') s += `<a:ln w="9525"><a:solidFill>${line ?? '<a:srgbClr val="000000"/>'}</a:solidFill>${sh.kind === 'arrow' ? '<a:tailEnd type="triangle"/>' : ''}</a:ln>`;
  }
  if (!icon && sh.fx && !['line', 'arrow'].includes(sh.kind)) s += effectsXml(sh.fx);
  s += '</xdr:spPr>';
  if (sh.text && !icon) {
    const f = sh.format ?? {};
    const anchor = f.anchor === 'top' ? ' anchor="t"' : f.anchor === 'middle' ? ' anchor="ctr"' : f.anchor === 'bottom' ? ' anchor="b"' : tx ? ' anchor="t"' : '';
    s += `<xdr:txBody><a:bodyPr wrap="square" rtlCol="0"${anchor}/><a:lstStyle/>`;
    const algn = f.align === 'left' ? ' algn="l"' : f.align === 'center' ? ' algn="ctr"' : f.align === 'right' ? ' algn="r"' : '';
    const ppr = algn || f.rtl ? `<a:pPr${algn}${f.rtl ? ' rtl="1"' : ''}/>` : '';
    const [attrs, body] = runProps(f, theme);
    for (const line of String(sh.text).split('\n')) {
      if (!line) s += `<a:p>${ppr}<a:endParaRPr lang="en-US"${attrs}/></a:p>`;
      else s += `<a:p>${ppr}<a:r>${body ? `<a:rPr lang="en-US"${attrs}>${body}</a:rPr>` : `<a:rPr lang="en-US"${attrs}/>`}<a:t>${esc(line)}</a:t></a:r></a:p>`;
    }
    s += '</xdr:txBody>';
  }
  return `${s}</xdr:sp>`;
}

function resolveHex(c, theme) {
  const rgb = resolveColor(c, theme);
  return rgb ? `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}` : '#000000';
}

/** The drawing part of a sheet: objs = [{type: 'image'|'chart'|'shape', object, rid?}] in drawing order. */
export function drawingXml(sheet, theme, objs) {
  let s = `${XML_DECL}<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:c="${NS_C}">`;
  objs.forEach((o, i) => {
    const id = i + 2;
    const a = o.object.anchor;
    s += anchorOpen(sheet, a);
    if (o.type === 'image') {
      s += picXml(o.object, theme, id, o.rid, xfrm(a, 'a:xfrm', o.object));
    } else if (o.type === 'chart') {
      s += `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>${cNvPrXml(o.object, id, `Chart ${id - 1}`, o.object.alt && !o.object.decorative ? ` descr="${escAttr(o.object.alt)}"` : '', fxExt('chart', o.object))}<xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>${xfrm(a, 'xdr:xfrm')}`
        + `<a:graphic><a:graphicData uri="${NS_C}"><c:chart r:id="${o.rid}"/></a:graphicData></a:graphic></xdr:graphicFrame>`;
    } else if (o.type === 'slicer' || o.type === 'timeline') s += o.frame(id, a);
    else s += shapeXml(o.object, theme, id);
    s += '<xdr:clientData/></xdr:twoCellAnchor>';
  });
  return `${s}</xdr:wsDr>`;
}

/** The bytes and file extension of a picture. */
export function pictureFile(img) {
  return {bytes: base64ToBytes(img.data) ?? new Uint8Array(), ext: EXT_FOR_MIME[String(img.mime).toLowerCase()] ?? 'png'};
}

// ---------------------------------------------------------------------------------------------
// Writing: the chart part

const GROUP = kind => {
  switch (kind) {
    case 'columnStacked': return {g: 'bar', bar: false, grouping: 'stacked'};
    case 'columnStacked100': return {g: 'bar', bar: false, grouping: 'percentStacked'};
    case 'barClustered': return {g: 'bar', bar: true, grouping: 'clustered'};
    case 'barStacked': return {g: 'bar', bar: true, grouping: 'stacked'};
    case 'barStacked100': return {g: 'bar', bar: true, grouping: 'percentStacked'};
    case 'line': return {g: 'line', grouping: 'standard', markers: false};
    case 'lineMarkers': return {g: 'line', grouping: 'standard', markers: true};
    case 'lineStacked': return {g: 'line', grouping: 'stacked', markers: false};
    case 'pie': return {g: 'pie'};
    case 'pie3d': return {g: 'pie3d'};
    case 'pieOfPie': return {g: 'ofPie', ofType: 'pie'};
    case 'barOfPie': return {g: 'ofPie', ofType: 'bar'};
    case 'bubble3d': return {g: 'bubble', d3: true};
    case 'doughnut': return {g: 'doughnut'};
    case 'area': return {g: 'area', grouping: 'standard'};
    case 'areaStacked': return {g: 'area', grouping: 'stacked'};
    case 'areaStacked100': return {g: 'area', grouping: 'percentStacked'};
    case 'scatter': return {g: 'scatter', lines: false};
    case 'scatterLines': return {g: 'scatter', lines: true};
    case 'bubble': return {g: 'bubble'};
    case 'radar': return {g: 'radar'};
    case 'stock': return {g: 'stock'};
    default: return {g: 'bar', bar: false, grouping: 'clustered'};
  }
};

const strCache = list => `<c:strCache><c:ptCount val="${list.length}"/>${list.map((t, i) => `<c:pt idx="${i}"><c:v>${esc(t)}</c:v></c:pt>`).join('')}</c:strCache>`;
const numCache = (list, code) => `<c:numCache><c:formatCode>${esc(code || 'General')}</c:formatCode><c:ptCount val="${list.length}"/>${list.map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numCache>`;
const ref = (kind, f, cache) => `<c:${kind}><c:f>${esc(f)}</c:f>${cache}</c:${kind}>`;

/** `<c:trendline>` with children in schema order: name, spPr, trendlineType, order, period, forward, backward, intercept, dispRSqr, dispEq, trendlineLbl. */
function trendlineXml(t, theme) {
  let x = '<c:trendline>';
  if (t.name) x += `<c:name>${esc(t.name)}</c:name>`;
  const color = t.color ? srgb(t.color, theme) : null;
  const dash = t.dash === 'solid' ? 'solid' : t.dash === 'dash' ? 'dash' : null;
  if (color || Number.isFinite(t.width) || dash) {
    x += '<c:spPr><a:ln';
    if (Number.isFinite(t.width)) x += ` w="${Math.min(20_116_800, Math.max(0, Math.round(t.width * EMU_PER_PT)))}"`;
    x += ' cap="rnd">';
    if (color) x += `<a:solidFill>${color}</a:solidFill>`;
    if (dash) x += `<a:prstDash val="${dash}"/>`;
    x += '</a:ln></c:spPr>';
  }
  x += `<c:trendlineType val="${TREND_WRITE[t.type] ?? 'linear'}"/>`;
  if (t.type === 'polynomial') x += `<c:order val="${Math.min(6, Math.max(2, t.order ?? 2))}"/>`;
  if (t.type === 'movingAverage') x += `<c:period val="${Math.min(255, Math.max(2, t.period ?? 2))}"/>`;
  for (const tag of ['forward', 'backward']) if (Number.isFinite(t[tag]) && t[tag] > 0) x += `<c:${tag} val="${t[tag]}"/>`;
  if (Number.isFinite(t.intercept)) x += `<c:intercept val="${t.intercept}"/>`;
  x += `<c:dispRSqr val="${t.displayRSquared ? 1 : 0}"/><c:dispEq val="${t.displayEquation ? 1 : 0}"/>`;
  if (t.displayRSquared || t.displayEquation) x += '<c:trendlineLbl><c:numFmt formatCode="General" sourceLinked="0"/></c:trendlineLbl>';
  return `${x}</c:trendline>`;
}

const ERR_WRITE = {fixed: 'fixedVal', percentage: 'percentage', standardDeviation: 'stdDev', standardError: 'stdErr'};
/** `<c:errBars>` (ECMA-376 21.2.2.58): direction, kind, end cap and the value (Fixed value, Percentage, Standard Deviation multiple). */
function errBarsXml(eb, g) {
  const dir = g === 'scatter' || g === 'bubble' ? '<c:errDir val="y"/>' : g === 'bar' ? '' : '';
  const v = eb.type === 'standardError' ? '' : `<c:val val="${Number.isFinite(eb.value) ? eb.value : 1}"/>`;
  return `<c:errBars>${dir}<c:errBarType val="${['both', 'plus', 'minus'].includes(eb.direction) ? eb.direction : 'both'}"/><c:errValType val="${ERR_WRITE[eb.type] ?? 'stdErr'}"/><c:noEndCap val="${eb.cap === false ? 1 : 0}"/>${v}</c:errBars>`;
}

function seriesXml(chart, data, theme, i, group) {
  const s = chart.series[i], d = data.series[i];
  let x = `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>`;
  if (s.name) x += `<c:tx>${ref('strRef', s.name, strCache([d.name]))}</c:tx>`;
  const col = s.color ? srgb(s.color, theme) : null;
  const isLine = group.g === 'line' || group.g === 'radar' || group.g === 'stock';
  if (col) x += `<c:spPr>${group.g === 'scatter' || isLine ? `<a:ln w="28575" cap="rnd"><a:solidFill>${col}</a:solidFill><a:round/></a:ln>` : `<a:solidFill>${col}</a:solidFill>`}</c:spPr>`;
  else if (group.g === 'scatter' && !group.lines) x += '<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr>';
  if (group.g === 'bar' || group.g === 'bubble') x += '<c:invertIfNegative val="0"/>';
  if (group.g === 'line' || group.g === 'radar' || group.g === 'scatter') x += `<c:marker><c:symbol val="${group.markers === false ? 'none' : 'circle'}"/>${group.markers === false ? '' : '<c:size val="5"/>'}</c:marker>`;
  if (chart.dataLabels) x += '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>';
  // Trendlines sit between dLbls and the data; pie and radar series have none.
  if (group.g !== 'pie' && group.g !== 'doughnut' && group.g !== 'radar') for (const tl of s.trendlines ?? []) x += trendlineXml(tl, theme);
  if (chart.errorBars && ['bar', 'line', 'area', 'scatter', 'bubble'].includes(group.g)) x += errBarsXml(chart.errorBars, group.g);
  const catData = s.categories ? (d.x && !data.categories.length ? null : s.categories) : null;
  const numericCat = group.g === 'scatter' || group.g === 'bubble';
  if (catData) x += `<c:${numericCat ? 'xVal' : 'cat'}>${ref(numericCat ? 'numRef' : 'strRef', catData, numericCat ? numCache(d.x ?? [], 'General') : strCache(data.categories))}</c:${numericCat ? 'xVal' : 'cat'}>`;
  x += `<c:${numericCat ? 'yVal' : 'val'}>${ref('numRef', s.values, numCache(d.values, d.numberFormat))}</c:${numericCat ? 'yVal' : 'val'}>`;
  if (group.g === 'bubble') x += `<c:bubbleSize>${s.bubbleSizes ? ref('numRef', s.bubbleSizes, numCache(d.sizes ?? [], 'General')) : '<c:numLit><c:ptCount val="0"/></c:numLit>'}</c:bubbleSize><c:bubble3D val="${group.d3 ? 1 : 0}"/>`;
  if (group.g === 'line' || group.g === 'scatter') x += `<c:smooth val="${s.smooth ? 1 : 0}"/>`;
  return `${x}</c:ser>`;
}

/** `<c:spPr>` of the chart area or plot area: its fill, line and effects (Format > Shape Fill, Shape Outline, Shape Effects). */
function areaSpPr(a, theme, fx) {
  const fill = a.fill === 'none' ? '<a:noFill/>' : a.fill ? `<a:solidFill>${srgb(a.fill, theme)}</a:solidFill>` : '';
  const line = a.line === 'none' ? '<a:ln><a:noFill/></a:ln>' : a.line || a.lineWidth ? `<a:ln w="${Math.round((a.lineWidth ?? 1) * EMU_PER_PX)}">${a.line ? `<a:solidFill>${srgb(a.line, theme)}</a:solidFill>` : ''}</a:ln>` : '';
  const body = fill + line + effectsXml(fx);
  return body ? `<c:spPr>${body}</c:spPr>` : '';
}

function titleXml(text) {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/>${String(text).split('\n').map(l => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${esc(l)}</a:t></a:r></a:p>`).join('')}</c:rich></c:tx><c:overlay val="0"/></c:title>`;
}

/** A chart part with cached series values, resolved against the workbook. */
export function chartXml(content, si, chart) {
  const theme = content.theme ?? DEFAULT_THEME;
  const data = resolveChart(content, si, chart);
  const kinds = chart.kind === 'combo' ? data.series.map(s => s.kind) : null;
  const ext = EXTENSION_KINDS.includes(chart.kind);
  const main = GROUP(ext ? 'columnClustered' : chart.kind === 'combo' ? 'columnClustered' : chart.kind);
  const groupOf = i => (kinds ? GROUP(kinds[i] === 'combo' ? 'line' : kinds[i]) : main);
  const catId = 111111, valId = 222222;
  // Series by group (a combo chart has a column group and a line group on the same axes).
  const groups = [];
  chart.series.forEach((s, i) => {
    const g = groupOf(i);
    const key = JSON.stringify(g);
    let e = groups.find(x => x.key === key);
    if (!e) { e = {key, g, idx: []}; groups.push(e); }
    e.idx.push(i);
  });
  let plot = '<c:layout/>';
  const noAxes = main.g === 'pie' || main.g === 'doughnut' || main.g === 'pie3d' || main.g === 'ofPie';
  const dl = chart.dataLabels ? '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>' : '';
  for (const {g, idx} of groups) {
    const sers = idx.map(i => seriesXml(chart, data, theme, i, g)).join('');
    const ax = `<c:axId val="${catId}"/><c:axId val="${valId}"/>`;
    switch (g.g) {
      case 'bar': plot += `<c:barChart><c:barDir val="${g.bar ? 'bar' : 'col'}"/><c:grouping val="${g.grouping}"/><c:varyColors val="0"/>${sers}<c:gapWidth val="150"/>${g.grouping === 'clustered' ? '' : '<c:overlap val="100"/>'}${chart.lines === 'series' && g.grouping !== 'clustered' ? '<c:serLines/>' : ''}${ax}</c:barChart>`; break;
      case 'line': plot += `<c:lineChart><c:grouping val="${g.grouping}"/><c:varyColors val="0"/>${sers}${chart.lines === 'drop' ? '<c:dropLines/>' : chart.lines === 'highLow' ? '<c:hiLowLines/>' : ''}${chart.upDownBars === true ? '<c:upDownBars><c:gapWidth val="150"/><c:upBars/><c:downBars/></c:upDownBars>' : ''}<c:marker val="1"/>${ax}</c:lineChart>`; break;
      case 'area': plot += `<c:areaChart><c:grouping val="${g.grouping}"/><c:varyColors val="0"/>${sers}${chart.lines === 'drop' ? '<c:dropLines/>' : ''}${ax}</c:areaChart>`; break;
      case 'pie': plot += `<c:pieChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/></c:pieChart>`; break;
      case 'pie3d': plot += `<c:pie3DChart><c:varyColors val="1"/>${sers}</c:pie3DChart>`; break;
      case 'ofPie': plot += `<c:ofPieChart><c:ofPieType val="${g.ofType}"/><c:varyColors val="1"/>${sers}<c:gapWidth val="100"/><c:splitType val="pos"/><c:splitPos val="3"/><c:secondPieSize val="75"/></c:ofPieChart>`; break;
      case 'doughnut': plot += `<c:doughnutChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`; break;
      case 'scatter': plot += `<c:scatterChart><c:scatterStyle val="${g.lines ? 'lineMarker' : 'marker'}"/><c:varyColors val="0"/>${sers}${ax}</c:scatterChart>`; break;
      case 'bubble': plot += `<c:bubbleChart><c:varyColors val="0"/>${sers}<c:bubbleScale val="100"/>${ax}</c:bubbleChart>`; break;
      case 'radar': plot += `<c:radarChart><c:radarStyle val="marker"/><c:varyColors val="0"/>${sers}${ax}</c:radarChart>`; break;
      case 'stock': plot += `<c:stockChart>${sers}<c:hiLowLines/>${ax}</c:stockChart>`; break;
      default: break;
    }
  }
  void dl;
  const horizontal = main.g === 'bar' && main.bar;
  const grid = chart.gridlines !== false ? '<c:majorGridlines/>' : '';
  if (!noAxes) {
    const xt = chart.xTitle ? titleXml(chart.xTitle) : '', yt = chart.yTitle ? titleXml(chart.yTitle) : '';
    const tail = '<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>';
    if (main.g === 'scatter' || main.g === 'bubble') {
      plot += `<c:valAx><c:axId val="${catId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${xt}<c:numFmt formatCode="General" sourceLinked="1"/>${tail}<c:crossAx val="${valId}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`;
      plot += `<c:valAx><c:axId val="${valId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>${grid}${yt}<c:numFmt formatCode="General" sourceLinked="1"/>${tail}<c:crossAx val="${catId}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`;
    } else {
      plot += `<c:catAx><c:axId val="${catId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="${chart.axes?.category === false ? 1 : 0}"/><c:axPos val="${horizontal ? 'l' : 'b'}"/>${xt}<c:numFmt formatCode="General" sourceLinked="1"/>${tail}<c:crossAx val="${valId}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
      plot += `<c:valAx><c:axId val="${valId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="${chart.axes?.value === false ? 1 : 0}"/><c:axPos val="${horizontal ? 'b' : 'l'}"/>${grid}${yt}<c:numFmt formatCode="${main.grouping === 'percentStacked' ? '0%' : 'General'}" sourceLinked="${main.grouping === 'percentStacked' ? 0 : 1}"/>${tail}<c:crossAx val="${catId}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
    }
  }
  if (chart.dataTable && !noAxes) plot += `<c:dTable><c:showHorzBorder val="1"/><c:showVertBorder val="1"/><c:showOutline val="1"/><c:showKeys val="${chart.dataTable.keys === false ? 0 : 1}"/></c:dTable>`;
  if (chart.plot && !noAxes) plot += areaSpPr(chart.plot, content.theme ?? DEFAULT_THEME);
  let x = `${XML_DECL}<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/>`;
  if (chart.style && chart.style !== 2) x += `<c:style val="${Math.min(48, Math.max(1, chart.style))}"/>`;
  // A PivotChart names its PivotTable behind the workbook in brackets; without them Excel shows an ordinary chart (crates/xlsx/src/chart.rs).
  if (typeof chart.pivot === 'string' && chart.pivot.trim()) x += `<c:pivotSource><c:name>[Book1]${esc(chart.pivot.trim().replace(/^\[[^\]]*\]/, ''))}</c:name><c:fmtId val="0"/></c:pivotSource>`;
  x += '<c:chart>';
  if (typeof chart.title === 'string' && chart.title.trim()) x += `${titleXml(chart.title)}<c:autoTitleDeleted val="0"/>`;
  else x += `<c:autoTitleDeleted val="${chart.title === undefined ? 0 : 1}"/>`;
  x += `<c:plotArea>${plot}</c:plotArea>`;
  const pos = {bottom: 'b', top: 't', left: 'l', right: 'r'}[chart.legend ?? 'bottom'];
  if (pos) x += `<c:legend><c:legendPos val="${pos}"/><c:overlay val="0"/></c:legend>`;
  x += '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>';
  if (chart.area || chart.fx) x += areaSpPr(chart.area ?? {}, content.theme ?? DEFAULT_THEME, chart.fx);
  if (ext) x += `<c:extLst><c:ext uri="${KIND_URI}" xmlns:ark="urn:arkemis"><ark:kind val="${chart.kind}"/></c:ext></c:extLst>`;
  return `${x}</c:chartSpace>`;
}

// ---------------------------------------------------------------------------------------------
// Sparklines (the worksheet's x14 extension)

const NS_X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const NS_XM = 'http://schemas.microsoft.com/office/excel/2006/main';
const SPARK_URI = '{05C60535-1F16-4fd2-B633-F4F36F0B64E0}';

/** The `<extLst>` of a worksheet holding its sparklines, or ''. */
export function sparklinesExt(sheet, theme) {
  const list = (sheet.sparklines ?? []).filter(sp => parseCell(sp.cell) && sp.source);
  if (!list.length) return '';
  // A group per sparkline, except the ones the person grouped (Excel merges equal looks into one group; here that would group them on reopening).
  const groups = new Map();
  for (const sp of list) {
    const key = sp.group ? `g|${sp.group}` : `s|${groups.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sp);
  }
  let g = '';
  for (const items of groups.values()) {
    const sp0 = items[0];
    const type = sp0.kind === 'column' ? ' type="column"' : sp0.kind === 'winLoss' ? ' type="stacked"' : '';
    const rgbOf = (c, dflt) => srgb(c, theme)?.replace('<a:srgbClr val="', '').replace('"/>', '') ?? dflt;
    const color = rgbOf(sp0.color, '156082');
    const col = (key, dflt) => rgbOf(sp0.colors?.[key], dflt);
    const f = sp0.flags ?? {}, ax = sp0.axis ?? {};
    const axisAttr = (key, which) => (typeof ax[key] === 'number' ? ` ${which}AxisType="custom" manual${which === 'min' ? 'Min' : 'Max'}="${ax[key]}"` : ax[key] === 'same' ? ` ${which}AxisType="group"` : '');
    const attrs = `${f.high ? ' high="1"' : ''}${f.low ? ' low="1"' : ''}${f.negative ? ' negative="1"' : ''}${f.first ? ' first="1"' : ''}${f.last ? ' last="1"' : ''}${ax.show ? ' displayXAxis="1"' : ''}${ax.rtl ? ' rightToLeft="1"' : ''}${axisAttr('min', 'min')}${axisAttr('max', 'max')}`;
    g += `<x14:sparklineGroup${type} displayEmptyCellsAs="gap"${sp0.markers ? ' markers="1"' : ''}${attrs}><x14:colorSeries rgb="FF${color}"/><x14:colorNegative rgb="FF${col('negative', 'D64F45')}"/><x14:colorAxis rgb="FF000000"/><x14:colorMarkers rgb="FF${col('markers', color)}"/><x14:colorFirst rgb="FF${col('first', 'D64F45')}"/><x14:colorLast rgb="FF${col('last', 'D64F45')}"/><x14:colorHigh rgb="FF${col('high', 'D64F45')}"/><x14:colorLow rgb="FF${col('low', 'D64F45')}"/><x14:sparklines>`;
    for (const sp of items) g += `<x14:sparkline><xm:f>${esc(sp.source)}</xm:f><xm:sqref>${sp.cell}</xm:sqref></x14:sparkline>`;
    g += '</x14:sparklines></x14:sparklineGroup>';
  }
  return `<extLst><ext xmlns:x14="${NS_X14}" uri="${SPARK_URI}"><x14:sparklineGroups xmlns:xm="${NS_XM}">${g}</x14:sparklineGroups></ext></extLst>`;
}

/** Reads the sparklines of a worksheet's extLst into `sheet.sparklines`. */
export function readSparklines(extLst, sheet) {
  for (const ext of extLst.kids('ext')) {
    const groups = ext.child('sparklineGroups');
    if (!groups) continue;
    for (const g of groups.kids('sparklineGroup')) {
      const t = g.attr('type');
      const kind = t === 'column' ? 'column' : t === 'stacked' ? 'winLoss' : 'line';
      const rgb = g.child('colorSeries')?.attr('rgb');
      const color = rgb && /^[0-9a-fA-F]{8}$/.test(rgb) ? `#${rgb.slice(2).toUpperCase()}` : {theme: 4, tint: 0};
      const markers = g.flag('markers', false);
      const hex = e => { const v = g.child(e)?.attr('rgb'); return v && /^[0-9a-fA-F]{8}$/.test(v) ? `#${v.slice(2).toUpperCase()}` : null; };
      const look = {};
      const flags = {};
      for (const k of ['high', 'low', 'negative', 'first', 'last']) if (g.flag(k, false)) flags[k] = true;
      if (Object.keys(flags).length) look.flags = flags;
      // The colours Excel always writes (the defaults of the file's own style) are kept only where they differ from ours.
      const colors = {};
      for (const [k, el, dflt] of [['negative', 'colorNegative', '#D64F45'], ['markers', 'colorMarkers', null], ['first', 'colorFirst', '#D64F45'], ['last', 'colorLast', '#D64F45'], ['high', 'colorHigh', '#D64F45'], ['low', 'colorLow', '#D64F45']]) {
        const v = hex(el);
        if (v && v !== (dflt ?? (typeof color === 'string' ? color : null))) colors[k] = v;
      }
      if (Object.keys(colors).length) look.colors = colors;
      const axis = {};
      if (g.flag('displayXAxis', false)) axis.show = true;
      if (g.flag('rightToLeft', false)) axis.rtl = true;
      for (const [key, attr, man] of [['min', 'minAxisType', 'manualMin'], ['max', 'maxAxisType', 'manualMax']]) {
        const t = g.attr(attr);
        if (t === 'group') axis[key] = 'same';
        else if (t === 'custom' && Number.isFinite(Number(g.attr(man)))) axis[key] = Number(g.attr(man));
      }
      if (Object.keys(axis).length) look.axis = axis;
      const items = g.child('sparklines')?.kids('sparkline') ?? [];
      // A file's group of several sparklines is a group here too.
      const group = items.length > 1 ? `x${(sheet.sparklines ?? []).length}` : undefined;
      for (const sp of items) {
        const source = sp.child('f')?.text?.trim(), cell = sp.child('sqref')?.text?.trim();
        if (source && cell && parseCell(cell)) (sheet.sparklines ??= []).push({cell, source, kind, color, markers, ...look, ...(group ? {group} : {})});
      }
    }
  }
}
