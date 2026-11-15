// A SmartArt graphic in a .docx (U:quill/smartart): Word's diagram parts, written from the model and read back into it. PowerPoint's
// diagram code (core/prism/lib/dgm.mjs, deckcraft crates/pptx/src/dgm.rs) writes and reads the data model, layout definition, quick style
// and colours; Word stores the same parts under word/diagrams/. The drawing part (`dsp:drawing`, the shapes Word shows until it lays the
// diagram out) is written here from the page's own drawing (lib/smartart-word.mjs primitives). A diagram read from a file becomes an
// editable SmartArt graphic: its outline, layout, colours and style; the layout, quick style and colour definitions it came with are kept
// (`imported`) and written back while the layout, colours and style are unchanged.
// No DOM, no Node built-ins.

import * as dgm from '../../prism/lib/dgm.mjs';
import {parseXml} from '../../prism/formats/pptx-read.mjs';
import {smartArtPrims, engineLayout, layoutFromId, colorsFromId, styleFromId, cleanSpec} from './smartart-word.mjs';

const EMU = 12_700;
const emu = v => String(Math.round(Math.max(-1e7, Math.min(1e7, Number.isFinite(v) ? v : 0)) * EMU));
const hex = c => [c[0], c[1], c[2]].map(v => Math.max(0, Math.min(255, v | 0)).toString(16).toUpperCase().padStart(2, '0')).join('');
export const DIAGRAM_URI = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const RT_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
export const DGM_RT = {data: `${RT_BASE}diagramData`, layout: `${RT_BASE}diagramLayout`, style: `${RT_BASE}diagramQuickStyle`, colors: `${RT_BASE}diagramColors`, drawing: dgm.RT_DRAWING};
export {CT_DATA, CT_LAYOUT, CT_STYLE, CT_COLORS, CT_DRAWING} from '../../prism/lib/dgm.mjs';

const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fillXml(c) {
  const alpha = c[3] !== undefined && c[3] < 255 ? `<a:alpha val="${Math.round(c[3] / 255 * 100_000)}"/>` : '';
  return `<a:solidFill><a:srgbClr val="${hex(c)}">${alpha}</a:srgbClr></a:solidFill>`;
}

/** One primitive as a `dsp:sp` (a filled or stroked outline, or a transparent text box). */
function spXml(p, i, seed, measure) {
  const id = `{${seed.toString(16).toUpperCase().padStart(8, '0')}-5D1A-4C0A-9E5B-${(i + 1).toString(16).toUpperCase().padStart(12, '0')}}`;
  const pts = p.t === 'poly' || p.t === 'line' ? p.pts : null;
  let x0, y0, x1, y1;
  if (pts) {
    x0 = Math.min(...pts.map(q => q[0])); x1 = Math.max(...pts.map(q => q[0]));
    y0 = Math.min(...pts.map(q => q[1])); y1 = Math.max(...pts.map(q => q[1]));
  } else {
    const tw = Math.max(4, measure.textWidth(p.text, p.size, false) * 1.15 + 4);
    x0 = p.align === 'left' ? p.x : p.align === 'right' ? p.x - tw : p.x - tw / 2; x1 = x0 + tw; y0 = p.y; y1 = p.y + p.size * 1.35;
  }
  const bw = Math.max(0, x1 - x0), bh = Math.max(0, y1 - y0);
  let sp = `<a:xfrm><a:off x="${emu(x0)}" y="${emu(y0)}"/><a:ext cx="${emu(bw)}" cy="${emu(bh)}"/></a:xfrm>`;
  if (pts) {
    const closed = p.t === 'poly';
    const path = pts.slice(0, 5000).map((q, k) => `<a:${k ? 'lnTo' : 'moveTo'}><a:pt x="${emu(q[0] - x0)}" y="${emu(q[1] - y0)}"/></a:${k ? 'lnTo' : 'moveTo'}>`).join('');
    sp += `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${emu(bw)}" h="${emu(bh)}"${closed ? '' : ' fill="none"'}>${path}${closed ? '<a:close/>' : ''}</a:path></a:pathLst></a:custGeom>`;
    sp += p.t === 'poly' && p.fill ? fillXml(p.fill) : '<a:noFill/>';
    const line = p.t === 'poly' ? p.stroke : [p.color, p.width];
    sp += line ? `<a:ln w="${emu(line[1])}">${fillXml(line[0])}</a:ln>` : '<a:ln><a:noFill/></a:ln>';
  } else sp += '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln>';
  let body = '';
  if (!pts) {
    const algn = p.align === 'left' ? 'l' : p.align === 'right' ? 'r' : 'ctr';
    body = `<dsp:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"/><a:lstStyle/><a:p><a:pPr algn="${algn}"/><a:r><a:rPr lang="en-US" sz="${Math.max(100, Math.round(p.size * 100))}">${fillXml(p.color)}</a:rPr><a:t>${esc(p.text)}</a:t></a:r></a:p></dsp:txBody>`;
  }
  return `<dsp:sp modelId="${id}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr>${sp}</dsp:spPr>${body}</dsp:sp>`;
}

/** The model as the diagram code takes it (`kind`, `nodes`, colours, style, direction), with the definitions an imported diagram came with. */
function diagramOf(spec) {
  const d = {kind: engineLayout(spec.layout), nodes: spec.items.map(n => ({...n})), colors: spec.colors, style: spec.style ?? 'flat', ...(spec.rtl ? {rtl: true} : {})};
  const im = spec.imported;
  if (im && im.kind === d.kind && im.colors === d.colors && im.style === d.style) {
    if (im.layoutId) d.layoutId = im.layoutId;
    if (im.layoutXml) d.layoutXml = im.layoutXml;
    if (im.styleXml) d.styleXml = im.styleXml;
    if (im.colorsXml) d.colorsXml = im.colorsXml;
  }
  return d;
}

/** The five parts of diagram `n` for object `o`: {data, layout, style, colors, drawing} as XML text, with `drawingRel` the document's relationship id of the drawing. */
export function diagramParts(o, n, drawingRel, themeColors) {
  const spec = o.graphic.smartArt;
  const measure = {textWidth: (text, size) => [...String(text)].length * 0.5 * size};
  const prims = smartArtPrims(spec, o.w, o.h, themeColors, measure).filter(p => ((p.t === 'poly' || p.t === 'line') && (p.pts?.length ?? 0) > 1) || p.t === 'text').slice(0, 800);
  const d = diagramOf(spec);
  const drawing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<dsp:drawing xmlns:dgm="${dgm.NS_DGM}" xmlns:dsp="${dgm.NS_DSP}" xmlns:a="${dgm.NS_A}"><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>${prims.map((p, i) => spXml(p, i, n, measure)).join('')}</dsp:spTree></dsp:drawing>`;
  const decl = x => (x.startsWith('<?xml') ? x : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${x}`);
  return {
    data: dgm.dataXml(d, n, drawingRel, []), drawing,
    layout: decl(d.layoutXml ?? dgm.layoutXml(d.kind)), style: decl(d.styleXml ?? dgm.styleXml(d.style)), colors: decl(d.colorsXml ?? dgm.colorsXml(d.colors)),
  };
}

/** The part of a package (`pkg.get` bytes) as text, or null. */
const textOf = (pkg, target) => { const b = target ? pkg.get(target) : null; if (!b || b.length > 4 << 20) return null; try { return new TextDecoder('utf-8', {fatal: true}).decode(b); } catch { return null; } };

/**
 * A diagram in a drawing (`dgm:relIds`) as {spec, targets}: a SmartArt model, and the parts the document's relationships name for it (written again from
 * the model, so not kept), or null when it has no data part or no items. `pkg` is the docx Package, `rels` the part's relationships (byId).
 */
export function readSmartArt(pkg, rels, gd) {
  const ids = gd.child('dgm:relIds');
  if (!ids) return null;
  const rel = attr => { const r = rels.byId(ids.attr(attr) ?? ''); return r && !r.external ? r : null; };
  const dm = rel('r:dm');
  const dataText = dm ? textOf(pkg, dm.target) : null;
  if (!dataText) return null;
  let data;
  try { const doc = parseXml(dataText); data = doc.root ?? doc; } catch { return null; }
  if (data.local !== 'dataModel') return null;
  const nodes = dgm.outline(data);
  if (!nodes.length) return null;
  const lo = rel('r:lo');
  const loText = lo ? textOf(pkg, lo.target) : null;
  let loRoot = null;
  try { const doc = loText ? parseXml(loText) : null; loRoot = doc ? doc.root ?? doc : null; } catch { loRoot = null; }
  const docIds = dgm.docIds(data);
  const layoutId = loRoot?.attr('uniqueId') || docIds.lo;
  const kind = dgm.kindFor(layoutId, loRoot?.child('catLst')?.child('cat')?.attr('type') ?? '');
  const vars = dgm.layoutVars(data);
  const sx = rel('r:qs') ? textOf(pkg, rel('r:qs').target) : null;
  const cx = rel('r:cs') ? textOf(pkg, rel('r:cs').target) : null;
  const colors = colorsFromId(dgm.colorsFor(docIds.cs)) ?? 'accent1';
  const style = styleFromId(dgm.styleFor(docIds.qs)) ?? 'flat';
  const spec = cleanSpec({layout: layoutFromId(kind) ?? kind, items: nodes, colors, style, rtl: vars.rtl});
  spec.imported = {kind: engineLayout(spec.layout), colors: spec.colors, style: spec.style, layoutId, ...(loText ? {layoutXml: loText.replace(/^<\?xml[^>]*\?>\s*/, '')} : {}),
    ...(sx ? {styleXml: sx.replace(/^<\?xml[^>]*\?>\s*/, '')} : {}), ...(cx ? {colorsXml: cx.replace(/^<\?xml[^>]*\?>\s*/, '')} : {})};
  const drawing = rels.byId(data.find('dataModelExt')?.attr('relId') ?? '');
  const targets = ['r:dm', 'r:lo', 'r:qs', 'r:cs'].map(k => rel(k)?.target).filter(Boolean);
  if (drawing && !drawing.external) targets.push(drawing.target);
  return {spec, targets};
}
