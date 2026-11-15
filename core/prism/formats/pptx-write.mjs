// Prism schema-2 content → PPTX: what File > Save / Save As writes for .pptx (and .potx / .ppsx).
//
// Translated from deckcraft crates/pptx/src/write.rs, write/dml.rs, write/shapes.rs,
// write/theme.rs, write/timing.rs, opc.rs (writer half), xml.rs (writer half), custgeom.rs (writer
// half), maps.rs (writer half), tables.rs (style part writer) and png.rs at deckcraft commit
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Writes a package PowerPoint opens without repair: masters with their themes and layouts, slides
// with notes (and a notes master), legacy and modern comments with their authors, the handout
// master, presentation/view/table-style properties, sections, custom shows, embedded fonts, tags,
// kept custom-XML parts, document properties, every shape kind the model holds (preset and custom
// geometry, text, pictures, media with trim/fade/bookmarks, groups, connectors with their
// connections, tables, ink, 3-D models with poster fallbacks, opaque objects written back with their
// parts), transitions (with the p14/p15/p159 alternate-content fallbacks) and the animation timing
// tree built from the Animation Pane list.
//
// What differs (docs/behaviour-fidelity.md), and why:
// * Charts and SmartArt: the reader keeps them as opaque objects (see pptx-read.mjs), so they are
//   written back exactly as read, with every part they use. A `chart` shape or a group carrying a
//   `diagram` outline (made by a future Insert > Chart / SmartArt translation) has no chart or
//   diagram writer here yet: a diagram group is written as its drawn group, a chart is left out.
// * Opaque parts with their own relationships (a chart's workbook) are written with those
//   relationships (pptx-read.mjs keeps them); upstream drops such parts.
// No DOM, no Node built-ins (JSZip is allowed in core/*/formats).

import {chartPartXml, workbookChart} from '../lib/chart.mjs';
import {writeXlsx} from '../../grid/formats/xlsx-write.mjs';
import * as dgm from '../lib/dgm.mjs';
import {syncText} from '../lib/smartart.mjs';
import JSZip from 'jszip';
import {hex, isPresetName, isSystemName, THEME_SLOTS, slotFromXml, schemeGet, BLACK} from '../model/color.mjs';
import {anchorXml, textDirXml, alignXml} from '../model/text.mjs';
import {DASH_PRESETS, compoundXml, resolveColor} from '../model/style.mjs';
import {phXml, layoutXml, walk, layoutById} from '../model/presentation.mjs';
import {masterStyles, defaultTextStyle, buildMaster} from '../model/defaults.mjs';
import {defaultTheme, defaultFormat} from '../model/theme.mjs';
import {info as presetInfo} from '../model/geom/index.mjs';
import {normalizeTable, tableStyles as builtinTableStyles} from '../model/table.mjs';
import {
  esc, escAttr, parseXml, El, NS_A, NS_R, NS_P, NS_C, NS_MC, NS_P14, NS_P15, NS_P159, NS_A14, NS_P188, RT_BASE, RT_MEDIA, RT_MODEL3D, RT_CORE,
  SECTION_EXT_URI, COMMENTS_EXT_URI, CT_COMMENTS_MODERN, relsPath, relative, norm, mimeFor, base64Decode, guid, ownTableGuid, KNOWN_TABLE_STYLES,
  BUILTIN_WRITE_TABLE_STYLES, keepXml, relRefs, isRelAttr, TRANSITIONS, INVX_LEFT, animClassXml, subtypeFromOption, effectForPreset, fallbackEffect,
  animationInfo, paragraphBuildRoles, buildFilled, warpAdjustDefaults, PptxError,
} from './pptx-read.mjs';

export const UPSTREAM = Object.freeze({repo: 'deckcraft', commit: 'f893f6af7d36a5409fd804e81a34fd895cfefedf',
  files: ['crates/pptx/src/write.rs', 'crates/pptx/src/write/dml.rs', 'crates/pptx/src/write/shapes.rs', 'crates/pptx/src/write/theme.rs',
    'crates/pptx/src/write/timing.rs', 'crates/pptx/src/opc.rs', 'crates/pptx/src/xml.rs', 'crates/pptx/src/custgeom.rs', 'crates/pptx/src/maps.rs',
    'crates/pptx/src/tables.rs', 'crates/pptx/src/png.rs']});

export const CT_PRES = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
export const CT_TEMPLATE = 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml';
export const CT_SHOW = 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml';
const CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const CT_LAYOUT = 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml';
const CT_MASTER = 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml';
const CT_NOTES_MASTER = 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml';
const CT_HANDOUT_MASTER = 'application/vnd.openxmlformats-officedocument.presentationml.handoutMaster+xml';
const CT_NOTES = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
const CT_THEME = 'application/vnd.openxmlformats-officedocument.theme+xml';
const CT_PRES_PROPS = 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml';
const CT_VIEW_PROPS = 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml';
const CT_TABLE_STYLES = 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml';
const CT_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const CT_TAGS = 'application/vnd.openxmlformats-officedocument.presentationml.tags+xml';
const CT_COMMENTS = 'application/vnd.openxmlformats-officedocument.presentationml.comments+xml';
const CT_AUTHORS = 'application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml';
const CT_AUTHORS_MODERN = 'application/vnd.ms-powerpoint.authors+xml';
const RT_COMMENTS_MODERN = 'http://schemas.microsoft.com/office/2018/10/relationships/comments';
const RT_AUTHORS_MODERN = 'http://schemas.microsoft.com/office/2018/10/relationships/authors';
const CT_CORE = 'application/vnd.openxmlformats-package.core-properties+xml';
const CT_APP = 'application/vnd.openxmlformats-officedocument.extended-properties+xml';

// =================================================================================================
// xml.rs writer

class A {
  constructor() { this.v = []; }
  a(k, v) { this.v.push([k, String(v)]); return this; }
  o(k, v) { if (v !== null && v !== undefined && v !== false) this.v.push([k, String(v)]); return this; }
  b(k, v) { if (v !== null && v !== undefined) this.v.push([k, v ? '1' : '0']); return this; }
  t(k, v) { if (v) this.v.push([k, '1']); return this; }
}
const at = () => new A();
class W {
  constructor(frag = false) { this.s = frag ? '' : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'; }
  static frag() { return new W(true); }
  attrs(a) { for (const [k, v] of a.v) this.s += ` ${k}="${escAttr(v)}"`; }
  open(name, a) { this.s += `<${name}`; if (a) this.attrs(a); this.s += '>'; }
  open0(name) { this.s += `<${name}>`; }
  close(name) { this.s += `</${name}>`; }
  empty(name, a) { this.s += `<${name}`; if (a) this.attrs(a); this.s += '/>'; }
  empty0(name) { this.s += `<${name}/>`; }
  val(name, v) { this.empty(name, at().a('val', v)); }
  text(t) { this.s += esc(t); }
  elt(name, t) { this.open0(name); this.text(t); this.close(name); }
  raw(xml) { this.s += xml; }
  finish() { return this.s; }
}

// =================================================================================================
// opc.rs writer

class RelsOut {
  constructor() { this.items = []; }
  add(kind, target, external) {
    const ty = kind.startsWith('http') ? kind : `${RT_BASE}${kind}`;
    const hit = this.items.find(([, t, tg, e]) => t === ty && tg === target && e === external);
    if (hit) return hit[0];
    return this.addNew(kind, target, external);
  }
  addNew(kind, target, external) {
    const ty = kind.startsWith('http') ? kind : `${RT_BASE}${kind}`;
    const id = `rId${this.items.length + 1}`;
    this.items.push([id, ty, target, external]);
    return id;
  }
  toXml() {
    const w = new W();
    w.open('Relationships', at().a('xmlns', 'http://schemas.openxmlformats.org/package/2006/relationships'));
    for (const [id, ty, target, ext] of this.items) {
      const a = at().a('Id', id).a('Type', ty).a('Target', target);
      if (ext) a.a('TargetMode', 'External');
      w.empty('Relationship', a);
    }
    w.close('Relationships');
    return w.finish();
  }
}
class PackageOut {
  constructor() {
    this.files = [];
    this.defaults = [['rels', 'application/vnd.openxmlformats-package.relationships+xml'], ['xml', 'application/xml']];
    this.overrides = [];
  }
  xmlPart(name, contentType, data) { this.overrides.push([`/${name}`, contentType]); this.files.push([name, data, true]); }
  rels(part, rels) {
    if (!rels.items.length) return;
    const path = relsPath(part);
    const existing = this.files.find(([n]) => n === path);
    if (existing) existing[1] = rels.toXml(); else this.files.push([path, rels.toXml(), true]);
  }
  raw(name, data) { this.files.push([name, data, true]); }
  binary(name, contentType, data) {
    const ext = (name.includes('.') ? name.split('.').pop() : 'bin').toLowerCase();
    if (!this.defaults.some(([e]) => e === ext)) this.defaults.push([ext, contentType]);
    else if (!this.defaults.some(([e, c]) => e === ext && c === contentType)) this.overrides.push([`/${name}`, contentType]);
    this.files.push([name, data, false]);
  }
  has(name) { return this.files.some(([n]) => norm(n) === norm(name)); }
  async finish() {
    const ct = new W();
    ct.open('Types', at().a('xmlns', 'http://schemas.openxmlformats.org/package/2006/content-types'));
    for (const [e, c] of this.defaults) ct.empty('Default', at().a('Extension', e).a('ContentType', c));
    for (const [p, c] of this.overrides) ct.empty('Override', at().a('PartName', p).a('ContentType', c));
    ct.close('Types');
    const zip = new JSZip();
    zip.file('[Content_Types].xml', ct.finish(), {compression: 'DEFLATE'});
    const written = new Set();
    for (const [name, data, compress] of this.files) {
      if (written.has(norm(name))) continue; // written twice: the first is kept
      written.add(norm(name));
      zip.file(name, data, {compression: compress ? 'DEFLATE' : 'STORE'});
    }
    return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE', compressionOptions: {level: 6}});
  }
}

// =================================================================================================
// png.rs: a transparent 1×1 PNG (the stand-in when a picture's image is missing)

export function crc32(data) {
  let c = 0xFFFFFFFF;
  for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function adler32(data) { let a = 1, b = 0; for (const x of data) { a = (a + x) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; }
const be32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
function chunk(out, kind, data) {
  const k = [...kind].map(c => c.charCodeAt(0));
  out.push(...be32(data.length), ...k, ...data, ...be32(crc32([...k, ...data])));
}
export function transparent1x1() {
  const out = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  chunk(out, 'IHDR', [...be32(1), ...be32(1), 8, 6, 0, 0, 0]);
  const raw = [0, 0, 0, 0, 0];
  const z = [0x78, 0x01, 0x01, raw.length, 0, (~raw.length) & 255, 0xFF, ...raw, ...be32(adler32(raw))];
  chunk(out, 'IDAT', z);
  chunk(out, 'IEND', []);
  return new Uint8Array(out);
}

// =================================================================================================
// write/dml.rs

const finiteOr0 = v => (Number.isFinite(v) ? v : 0);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
export const emu = p => clamp(Number.isFinite(p) ? Math.round(p * 12700) : 0, -27273042316900, 27273042316900);
export const emuPos = p => Math.max(emu(p), 0);
export const pct = v => (Number.isFinite(v) ? clamp(Math.round(v * 100000), -2e9, 2e9) : 0);
export function ang(deg) {
  if (!Number.isFinite(deg)) return 0;
  const d = ((deg % 360) + 360) % 360;
  return clamp(Math.round(d * 60000), 0, 21599999);
}
export function color(w, c) {
  const b = c?.base ?? {kind: 'rgb', rgb: BLACK};
  let tag, a;
  switch (b.kind) {
    case 'scheme': tag = 'a:schemeClr'; a = at().a('val', b.slot); break;
    case 'preset': tag = 'a:prstClr'; a = at().a('val', isPresetName(b.name) ? b.name : 'black'); break;
    case 'system': tag = 'a:sysClr'; a = at().a('val', isSystemName(b.name) ? b.name : 'windowText').a('lastClr', hex(b.last ?? BLACK)); break;
    default: tag = 'a:srgbClr'; a = at().a('val', hex(b.rgb ?? BLACK));
  }
  const mods = c?.mods ?? [];
  const rgbAlpha = b.kind === 'rgb' && (b.rgb?.a ?? 255) < 255 && !mods.some(m => m.op === 'alpha') ? Math.trunc(b.rgb.a * 100000 / 255) : null;
  if (!mods.length && rgbAlpha === null) { w.empty(tag, a); return; }
  w.open(tag, a);
  for (const m of mods) { if (m.val === undefined || m.val === null) w.empty0(`a:${m.op}`); else w.val(`a:${m.op}`, m.val); }
  if (rgbAlpha !== null) w.val('a:alpha', rgbAlpha);
  w.close(tag);
}
const solid = (w, c) => { w.open0('a:solidFill'); color(w, c); w.close('a:solidFill'); };
export function fill(w, x, o, f) {
  switch (f?.kind) {
    case 'none': w.empty0('a:noFill'); break;
    case 'solid': solid(w, f.color); break;
    case 'gradient': gradient(w, f); break;
    case 'picture': blipFill(w, x, o, 'a:blipFill', f); break;
    case 'pattern':
      w.open('a:pattFill', at().a('prst', f.preset || 'pct5'));
      w.open0('a:fgClr'); color(w, f.fg); w.close('a:fgClr');
      w.open0('a:bgClr'); color(w, f.bg); w.close('a:bgClr');
      w.close('a:pattFill');
      break;
    case 'group': w.empty0('a:grpFill'); break;
    default: break; // background: written by the shape (useBgFill)
  }
}
export function blipFill(w, x, o, tag, pf) {
  const m = x.media(pf.media);
  const linked = !!m && !m.data && !!m.link;
  const rid = x.mediaRel(o, pf.media, 'image') ?? x.placeholderRel(o);
  w.open(tag, at().a('rotWithShape', pf.upright ? '0' : '1'));
  const adj = pf.adjust ?? {};
  const hasKids = (pf.alpha !== null && pf.alpha !== undefined) || (adj.brightness ?? 0) !== 0 || (adj.contrast ?? 0) !== 0 || adj.grayscale || adj.duotone
    || adj.clearColor || (adj.bilevel !== null && adj.bilevel !== undefined) || adj.alphaInv || pf.artistic;
  const a = linked ? at().a('r:link', rid) : at().a('r:embed', rid);
  if (hasKids) {
    w.open('a:blip', a);
    if (adj.clearColor) {
      w.open0('a:clrChange');
      w.open0('a:clrFrom'); color(w, {base: {kind: 'rgb', rgb: adj.clearColor}}); w.close('a:clrFrom');
      w.open0('a:clrTo'); color(w, {base: {kind: 'rgb', rgb: adj.clearColor}, mods: [{op: 'alpha', val: 0}]}); w.close('a:clrTo');
      w.close('a:clrChange');
    }
    if (pf.alpha !== null && pf.alpha !== undefined) w.empty('a:alphaModFix', at().a('amt', pct(clamp(pf.alpha, 0, 1))));
    if (adj.alphaInv) w.empty0('a:alphaInv');
    if (adj.bilevel !== null && adj.bilevel !== undefined) w.empty('a:biLevel', at().a('thresh', pct(clamp(adj.bilevel, 0, 1))));
    if (adj.duotone) { w.open0('a:duotone'); color(w, adj.duotone[0]); color(w, adj.duotone[1]); w.close('a:duotone'); }
    if (adj.grayscale) w.empty0('a:grayscl');
    if ((adj.brightness ?? 0) !== 0 || (adj.contrast ?? 0) !== 0) w.empty('a:lum', at().a('bright', pct(clamp(adj.brightness ?? 0, -1, 1))).a('contrast', pct(clamp(adj.contrast ?? 0, -1, 1))));
    const art = pf.artistic;
    if (art && art.effect.startsWith('artistic') && /^[A-Za-z0-9]+$/.test(art.effect)) {
      const orig = x.mediaRel(o, art.original, 'image');
      if (orig) {
        w.open0('a:extLst');
        w.open('a:ext', at().a('uri', '{BEBA8EAE-BF5A-486C-A8C5-ECC9F3942E4B}'));
        w.open('a14:imgProps', at().a('xmlns:a14', NS_A14));
        w.open('a14:imgLayer', at().a('r:embed', orig));
        w.open0('a14:imgEffect'); w.empty0(`a14:${art.effect}`); w.close('a14:imgEffect');
        w.close('a14:imgLayer'); w.close('a14:imgProps'); w.close('a:ext'); w.close('a:extLst');
      }
    }
    w.close('a:blip');
  } else w.empty('a:blip', a);
  const c = pf.crop ?? [0, 0, 0, 0];
  if (c.some(v => v !== 0)) w.empty('a:srcRect', at().a('l', pct(c[0])).a('t', pct(c[1])).a('r', pct(c[2])).a('b', pct(c[3])));
  const mode = pf.mode ?? {kind: 'stretch', fillRect: [0, 0, 0, 0]};
  if (mode.kind === 'tile') {
    const flip = ['x', 'y', 'xy'].includes(mode.flip) ? mode.flip : 'none';
    const algn = ['tl', 't', 'tr', 'l', 'ctr', 'r', 'bl', 'b', 'br'].includes(mode.align) ? mode.align : 'tl';
    w.empty('a:tile', at().a('tx', emu(mode.tx ?? 0)).a('ty', emu(mode.ty ?? 0)).a('sx', pct(mode.sx ?? 1)).a('sy', pct(mode.sy ?? 1)).a('flip', flip).a('algn', algn));
  } else {
    const r = mode.fillRect ?? [0, 0, 0, 0];
    w.open0('a:stretch');
    if (r.some(v => v !== 0)) w.empty('a:fillRect', at().a('l', pct(r[0])).a('t', pct(r[1])).a('r', pct(r[2])).a('b', pct(r[3])));
    else w.empty0('a:fillRect');
    w.close('a:stretch');
  }
  w.close(tag);
}
export function line(w, x, o, tag, l) {
  const a = at();
  if (l.width !== null && l.width !== undefined) a.a('w', emu(clamp(l.width, 0, 1584)));
  if (l.cap) a.a('cap', l.cap === 'round' ? 'rnd' : l.cap === 'square' ? 'sq' : 'flat');
  if (l.compound) a.a('cmpd', compoundXml(l.compound));
  w.open(tag, a);
  if (l.fill && ['none', 'solid', 'gradient', 'pattern'].includes(l.fill.kind)) fill(w, x, o, l.fill);
  if (l.dash?.kind === 'preset') w.val('a:prstDash', DASH_PRESETS.includes(l.dash.name) ? l.dash.name : 'solid');
  else if (l.dash?.kind === 'custom' && (l.dash.pattern ?? []).length) {
    w.open0('a:custDash');
    for (const [d, s] of l.dash.pattern.slice(0, 64)) w.empty('a:ds', at().a('d', Math.max(pct(d), 0)).a('sp', Math.max(pct(s), 0)));
    w.close('a:custDash');
  }
  if (l.join === 'round') w.empty0('a:round'); else if (l.join === 'bevel') w.empty0('a:bevel'); else if (l.join === 'miter') w.empty0('a:miter');
  for (const [t, e] of [['a:headEnd', l.head], ['a:tailEnd', l.tail]]) {
    if (!e) continue;
    const kind = ['triangle', 'stealth', 'diamond', 'oval', 'arrow'].includes(e.kind) ? e.kind : 'none';
    const sz = s => (s === 'sm' || s === 'lg' ? s : 'med');
    w.empty(t, at().a('type', kind).a('w', sz(e.w)).a('len', sz(e.len)));
  }
  // Shape Outline > Sketched: kept in the line's extension list (this app's own; PowerPoint draws such a line plain).
  if (['curved', 'freehand', 'scribble'].includes(l.sketch)) {
    w.open0('a:extLst'); w.open('a:ext', at().a('uri', '{6A1F3C52-2D64-4C57-9C1E-0D2B6F6E3A12}'));
    w.empty('ark:sketch', at().a('xmlns:ark', 'urn:arkemis').a('style', l.sketch));
    w.close('a:ext'); w.close('a:extLst');
  }
  w.close(tag);
}
function shadow(w, tag, s) {
  const a = at().a('blurRad', Math.max(emu(s.blur ?? 0), 0)).a('dist', Math.max(emu(s.dist ?? 0), 0)).a('dir', ang(s.dir ?? 0));
  if (tag === 'a:outerShdw') {
    if ((s.sx ?? 1) !== 1) a.a('sx', pct(s.sx));
    if ((s.sy ?? 1) !== 1) a.a('sy', pct(s.sy));
    if ((s.kx ?? 0) !== 0) a.a('kx', Math.round(clamp(s.kx, -89, 89) * 60000));
    if ((s.ky ?? 0) !== 0) a.a('ky', Math.round(clamp(s.ky, -89, 89) * 60000));
    a.a('algn', ['tl', 't', 'tr', 'l', 'ctr', 'r', 'bl', 'b', 'br'].includes(s.align) ? s.align : 'b').a('rotWithShape', s.rotateWithShape !== false ? '1' : '0');
  }
  w.open(tag, a);
  color(w, s.color);
  w.close(tag);
}
function gradient(w, g) {
  w.open('a:gradFill', at().a('rotWithShape', g.rotateWithShape !== false ? '1' : '0'));
  const stops = [...(g.stops ?? [])];
  if (stops.length === 1) stops.push({...stops[0], pos: 1});
  if (stops.length) {
    w.open0('a:gsLst');
    for (const s of stops) { w.open('a:gs', at().a('pos', pct(clamp(s.pos, 0, 1)))); color(w, s.color); w.close('a:gs'); }
    w.close('a:gsLst');
  }
  const sh = g.shape ?? {kind: 'linear', angle: 90};
  if (sh.kind === 'path') {
    const p = ['rect', 'shape', 'circle'].includes(sh.path) ? sh.path : 'circle';
    const f = sh.focus ?? [0, 0, 0, 0];
    w.open('a:path', at().a('path', p));
    w.empty('a:fillToRect', at().a('l', pct(f[0])).a('t', pct(f[1])).a('r', pct(f[2])).a('b', pct(f[3])));
    w.close('a:path');
  } else w.empty('a:lin', at().a('ang', ang(sh.angle ?? 0)).a('scaled', sh.scaled ? '1' : '0'));
  const tile = g.tile ?? [0, 0, 0, 0];
  if (tile.some(v => v !== 0)) w.empty('a:tileRect', at().a('l', pct(tile[0])).a('t', pct(tile[1])).a('r', pct(tile[2])).a('b', pct(tile[3])));
  w.close('a:gradFill');
}
export function effects(w, fx) {
  w.open0('a:effectLst');
  const ov = fx.fillOverlay;
  if (ov) {
    w.open('a:fillOverlay', at().a('blend', ['over', 'mult', 'screen', 'darken', 'lighten'].includes(ov.blend) ? ov.blend : 'over'));
    if (ov.fill?.kind === 'solid') solid(w, ov.fill.color); else if (ov.fill?.kind === 'gradient') gradient(w, ov.fill); else w.empty0('a:noFill');
    w.close('a:fillOverlay');
  }
  if (fx.glow) { w.open('a:glow', at().a('rad', Math.max(emu(fx.glow.radius ?? 0), 0))); color(w, fx.glow.color); w.close('a:glow'); }
  if (fx.innerShadow) shadow(w, 'a:innerShdw', fx.innerShadow);
  if (fx.outerShadow) shadow(w, 'a:outerShdw', fx.outerShadow);
  const r = fx.reflection;
  if (r) {
    w.empty('a:reflection', at().a('blurRad', Math.max(emu(r.blur ?? 0), 0)).a('stA', pct(clamp(r.startAlpha ?? 1, 0, 1))).a('endA', pct(clamp(r.endAlpha ?? 0, 0, 1)))
      .a('endPos', pct(clamp(r.endPos ?? 1, 0, 1))).a('dist', Math.max(emu(r.dist ?? 0), 0)).a('dir', 5400000).a('sy', -100000).a('algn', 'bl').a('rotWithShape', '0'));
  }
  if (fx.softEdge !== null && fx.softEdge !== undefined) w.empty('a:softEdge', at().a('rad', Math.max(emu(fx.softEdge), 0)));
  w.close('a:effectLst');
}
export const bevelSp3d = preset => (!preset || preset.length > 32 || !/^[A-Za-z0-9]+$/.test(preset) ? null : `<a:sp3d><a:bevelT prst="${preset}"/></a:sp3d>`);
const xfrmFinite = x => !!x && [x.x, x.y, x.w, x.h, x.rot ?? 0].every(Number.isFinite);
export function xfrm(w, tag, xf, child) {
  const x = xfrmFinite(xf) ? xf : {x: 0, y: 0, w: 0, h: 0};
  const rot = ang(x.rot ?? 0);
  w.open(tag, at().o('rot', rot !== 0 ? rot : null).t('flipH', !!x.flipH).t('flipV', !!x.flipV));
  w.empty('a:off', at().a('x', emu(x.x)).a('y', emu(x.y)));
  w.empty('a:ext', at().a('cx', emuPos(x.w)).a('cy', emuPos(x.h)));
  if (child) {
    const c = xfrmFinite(child) ? child : {x: 0, y: 0, w: 0, h: 0};
    w.empty('a:chOff', at().a('x', emu(c.x)).a('y', emu(c.y)));
    w.empty('a:chExt', at().a('cx', emuPos(c.w)).a('cy', emuPos(c.h)));
  }
  w.close(tag);
}
const JUMP = {nextSlide: 'nextslide', previousSlide: 'previousslide', firstSlide: 'firstslide', lastSlide: 'lastslide', endShow: 'endshow', lastViewed: 'lastslideviewed'};
export function hyperlink(w, x, o, tag, h) {
  const a = h.action ?? {};
  let rid = '', action = null;
  if (a.kind === 'url') { if (!a.url) return; rid = o.rels.add('hyperlink', a.url, true); }
  else if (a.kind === 'slide') {
    const target = x.slideParts.get(a.slide);
    if (!target) return;
    rid = o.rels.add('slide', relative(o.name, target), false);
    action = 'ppaction://hlinksldjump';
  } else if (JUMP[a.kind]) action = `ppaction://hlinkshowjump?jump=${JUMP[a.kind]}`;
  else if (a.kind === 'customShow') {
    const id = Math.max(0, (x.p.customShows ?? []).findIndex(c => c.name === a.name));
    action = `ppaction://customshow?id=${id}&return=${a.returns === false ? 'false' : 'true'}`;
  } else if (a.kind === 'program') { if (!a.path) return; rid = o.rels.add('hyperlink', a.path, true); action = 'ppaction://program'; }
  else if (a.kind === 'playMedia') action = 'ppaction://media';
  else return;
  const attrs = at().a('r:id', rid).o('action', action).o('tooltip', h.tooltip || null).t('highlightClick', !!h.highlightClick).t('endSnd', !!h.stopSound);
  const srid = h.sound !== null && h.sound !== undefined ? x.mediaRel(o, h.sound, 'audio') : null;
  if (!srid) { w.empty(tag, attrs); return; }
  w.open(tag, attrs);
  w.empty('a:snd', at().a('r:embed', srid).a('name', soundLabel(x.media(h.sound)?.name ?? 'sound.wav')));
  w.close(tag);
}
function soundLabel(name) {
  const file = String(name).split(/[/\\]/).pop();
  const label = [...file].filter(c => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) < 0x7F && !'"<>'.includes(c)).slice(0, 80).join('');
  return label || 'sound.wav';
}
export function bodyPr(w, b) {
  const a = at()
    .o('rot', b.rot === null || b.rot === undefined ? null : clamp(Math.round(b.rot * 60000), -21600000, 21600000))
    .o('vert', b.vert ? textDirXml(b.vert) : null)
    .o('wrap', b.wrap === null || b.wrap === undefined ? null : b.wrap ? 'square' : 'none')
    .o('lIns', (b.insetL ?? null) === null ? null : emu(b.insetL))
    .o('tIns', (b.insetT ?? null) === null ? null : emu(b.insetT))
    .o('rIns', (b.insetR ?? null) === null ? null : emu(b.insetR))
    .o('bIns', (b.insetB ?? null) === null ? null : emu(b.insetB))
    .o('numCol', (b.columns ?? null) === null ? null : clamp(b.columns, 1, 16))
    .o('spcCol', (b.colSpacing ?? null) === null ? null : Math.max(emu(b.colSpacing), 0))
    .b('rtlCol', b.rtlCol)
    .o('anchor', b.anchor ? anchorXml(b.anchor) : null)
    .b('anchorCtr', b.anchorCtr)
    .b('upright', b.upright)
    .b('spcFirstLastPara', b.spaceFirstLast);
  const warp = b.warp && /^[A-Za-z0-9]+$/.test(b.warp) ? b.warp : null;
  if (!warp && !b.autofit && !b.raw3d) { w.empty('a:bodyPr', a); return; }
  w.open('a:bodyPr', a);
  if (warp) {
    w.open('a:prstTxWarp', at().a('prst', warp));
    const adj = (b.warpAdj ?? []).slice(0, 8).map((v, i) => [i, v]).filter(([, v]) => Number.isFinite(v)).map(([i, v]) => [i, clamp(Math.round(v), -2e9, 2e9)]);
    if (!adj.length) w.empty0('a:avLst');
    else {
      const single = warpAdjustDefaults(warp).length <= 1 && (b.warpAdj ?? []).length === 1;
      w.open0('a:avLst');
      for (const [i, v] of adj) w.empty('a:gd', at().a('name', single ? 'adj' : `adj${i + 1}`).a('fmla', `val ${v}`));
      w.close('a:avLst');
    }
    w.close('a:prstTxWarp');
  }
  const af = b.autofit;
  if (af?.kind === 'none') w.empty0('a:noAutofit');
  else if (af?.kind === 'shape') w.empty0('a:spAutoFit');
  else if (af?.kind === 'shrink') {
    const fs = af.fontScale === null || af.fontScale === undefined ? null : pct(clamp(af.fontScale, 0.01, 1));
    const lr = pct(clamp(af.lineReduction ?? 0, 0, 1));
    w.empty('a:normAutofit', at().o('fontScale', fs).o('lnSpcReduction', lr !== 0 ? lr : null));
  }
  // The text's 3-D rotation and bevel (Text Effects), kept as the file's own scene3d / sp3d.
  if (b.raw3d) w.raw(b.raw3d);
  w.close('a:bodyPr');
}
function spacing(w, tag, s) {
  w.open0(tag);
  if (s.kind === 'pct') w.val('a:spcPct', pct(clamp(s.v, 0, 132)));
  else w.val('a:spcPts', Math.round(clamp(s.v, 0, 1584) * 100));
  w.close(tag);
}
const nn = v => v !== null && v !== undefined;
const isDefault = o => !o || Object.values(o).every(v => v === null || v === undefined);
export function ppr(w, x, o, tag, level, p, def) {
  p = p ?? {};
  const a = at()
    .o('marL', nn(p.marginLeft) ? emu(clamp(p.marginLeft, 0, 4032)) : null)
    .o('marR', nn(p.marginRight) ? emu(clamp(p.marginRight, 0, 4032)) : null)
    .o('lvl', nn(level) && level > 0 ? Math.min(level, 8) : null)
    .o('indent', nn(p.indent) ? emu(clamp(p.indent, -4032, 4032)) : null)
    .o('algn', p.align ? alignXml(p.align) : null)
    .o('defTabSz', nn(p.defaultTab) ? Math.max(emu(p.defaultTab), 0) : null)
    .b('rtl', p.rtl).b('eaLnBrk', p.eastAsianLineBreak).b('latinLnBrk', p.latinLineBreak).b('hangingPunct', p.hangingPunct)
    .o('fontAlgn', ['auto', 't', 'ctr', 'base', 'b'].includes(p.fontAlign) ? p.fontAlign : null);
  const hasKids = nn(p.lineSpacing) || nn(p.spaceBefore) || nn(p.spaceAfter) || nn(p.bullet) || nn(p.bulletFont) || nn(p.bulletColor) || nn(p.bulletSize) || nn(p.tabs) || !!def;
  if (!hasKids) { w.empty(tag, a); return; }
  w.open(tag, a);
  if (p.lineSpacing) spacing(w, 'a:lnSpc', p.lineSpacing);
  if (p.spaceBefore) spacing(w, 'a:spcBef', p.spaceBefore);
  if (p.spaceAfter) spacing(w, 'a:spcAft', p.spaceAfter);
  if (p.bulletColor) { w.open0('a:buClr'); color(w, p.bulletColor); w.close('a:buClr'); }
  if (nn(p.bulletSize)) w.val('a:buSzPct', pct(clamp(p.bulletSize, 0.25, 4)));
  if (nn(p.bulletFont)) w.empty('a:buFont', at().a('typeface', p.bulletFont));
  const bu = p.bullet;
  if (bu?.kind === 'none') w.empty0('a:buNone');
  else if (bu?.kind === 'char') w.empty('a:buChar', at().a('char', bu.char || '•'));
  else if (bu?.kind === 'autoNum') {
    const s = bu.scheme && /^[A-Za-z0-9]+$/.test(bu.scheme) ? bu.scheme : 'arabicPeriod';
    const st = bu.startAt ?? 1;
    w.empty('a:buAutoNum', at().a('type', s).o('startAt', st !== 1 ? clamp(st, 1, 32767) : null));
  } else if (bu?.kind === 'picture') {
    const rid = x.mediaRel(o, bu.media, 'image');
    if (rid) {
      const m = x.media(bu.media);
      w.open0('a:buBlip');
      w.empty('a:blip', m && !m.data && m.link ? at().a('r:link', rid) : at().a('r:embed', rid));
      w.close('a:buBlip');
    } else w.empty('a:buChar', at().a('char', '•'));
  }
  if (p.tabs) {
    w.open0('a:tabLst');
    for (const t of p.tabs.slice(0, 32)) w.empty('a:tab', at().a('pos', emu(t.pos)).a('algn', ['ctr', 'r', 'dec'].includes(t.align) ? t.align : 'l'));
    w.close('a:tabLst');
  }
  if (def) rpr(w, x, o, 'a:defRPr', def);
  w.close(tag);
}
const typeface = (w, tag, f) => { if (nn(f)) w.empty(tag, at().a('typeface', f)); };
export function rpr(w, x, o, tag, r) {
  r = r ?? {};
  const a = at()
    .o('lang', r.lang || null)
    .o('sz', nn(r.size) ? Math.round(clamp(r.size, 1, 4000) * 100) : null)
    .b('b', r.bold).b('i', r.italic)
    .o('u', r.underline && /^[A-Za-z0-9]+$/.test(r.underline) ? r.underline : null)
    .o('strike', nn(r.strike) ? {none: 'noStrike', single: 'sngStrike', double: 'dblStrike'}[r.strike] ?? 'noStrike' : null)
    .o('kern', nn(r.kern) ? Math.round(clamp(r.kern, 0, 4000) * 100) : null)
    .o('cap', nn(r.caps) ? r.caps : null)
    .o('spc', nn(r.spacing) ? Math.round(clamp(r.spacing, -4000, 4000) * 100) : null)
    .o('baseline', nn(r.baseline) ? pct(clamp(r.baseline, -10, 10)) : null)
    .b('noProof', r.noProof);
  const hasFx = nn(r.shadow) || nn(r.innerShadow) || nn(r.glow) || nn(r.reflection) || nn(r.softEdge);
  const hasKids = nn(r.outline) || nn(r.fill) || hasFx || nn(r.highlight) || nn(r.underlineColor) || nn(r.font) || nn(r.fontEa) || nn(r.fontCs) || nn(r.fontSym) || nn(r.link) || nn(r.hover);
  if (!hasKids) { w.empty(tag, a); return; }
  w.open(tag, a);
  if (r.outline) line(w, x, o, 'a:ln', r.outline);
  if (r.fill && r.fill.kind !== 'background') fill(w, x, o, r.fill);
  if (hasFx) effects(w, {outerShadow: r.shadow, innerShadow: r.innerShadow, glow: r.glow, reflection: r.reflection, softEdge: r.softEdge});
  if (r.highlight) { w.open0('a:highlight'); color(w, r.highlight); w.close('a:highlight'); }
  if (r.underlineColor) { w.open0('a:uFill'); solid(w, r.underlineColor); w.close('a:uFill'); }
  typeface(w, 'a:latin', r.font); typeface(w, 'a:ea', r.fontEa); typeface(w, 'a:cs', r.fontCs); typeface(w, 'a:sym', r.fontSym);
  if (r.link) hyperlink(w, x, o, 'a:hlinkClick', r.link);
  if (r.hover) hyperlink(w, x, o, 'a:hlinkMouseOver', r.hover);
  w.close(tag);
}
const listEmpty = ls => (ls?.levels ?? []).every(l => !l);
export function listStyle(w, x, o, tag, ls) {
  if (listEmpty(ls)) { w.empty0(tag); return; }
  w.open0(tag);
  (ls.levels ?? []).slice(0, 9).forEach((l, i) => {
    if (!l) return;
    ppr(w, x, o, `a:lvl${i + 1}pPr`, null, l.para, isDefault(l.run) ? null : l.run);
  });
  w.close(tag);
}
export function textBody(w, x, o, tag, tb, math) {
  w.open0(tag);
  bodyPr(w, tb.body ?? {});
  listStyle(w, x, o, 'a:lstStyle', tb.listStyle);
  if (!(tb.paragraphs ?? []).length) w.empty0('a:p');
  (tb.paragraphs ?? []).forEach((p, pi) => paragraph(w, x, o, p, math, pi));
  w.close(tag);
}
function runText(w, x, o, text, props) {
  String(text).split(/[\n\u000b]/).forEach((piece, i) => {
    if (i > 0) { w.open0('a:br'); rpr(w, x, o, 'a:rPr', props); w.close('a:br'); }
    if (!piece && i > 0) return;
    w.open0('a:r'); rpr(w, x, o, 'a:rPr', props); w.elt('a:t', piece); w.close('a:r');
  });
}
export function paragraph(w, x, o, p, math, index) {
  w.open0('a:p');
  const def = isDefault(p.defProps) ? null : p.defProps;
  if ((p.level ?? 0) > 0 || !isDefault(p.props) || def) ppr(w, x, o, 'a:pPr', p.level ?? 0, p.props, def);
  (p.runs ?? []).forEach((r, ri) => {
    const kind = r.kind?.kind ?? 'text';
    if (kind === 'break') { w.open0('a:br'); rpr(w, x, o, 'a:rPr', r.props); w.close('a:br'); }
    else if (kind === 'field') {
      const field = r.kind.field ?? '';
      const id = guid(`${o.name}:${index}:${ri}:${field}`);
      const ty = field && /^[A-Za-z0-9-]+$/.test(field) ? field : null;
      w.open('a:fld', at().a('id', id).o('type', ty));
      rpr(w, x, o, 'a:rPr', r.props);
      w.elt('a:t', r.text ?? '');
      w.close('a:fld');
    } else if (kind === 'math') {
      if (math && r.kind.omml) { w.open('a14:m', at().a('xmlns:a14', NS_A14)); w.raw(r.kind.omml); w.close('a14:m'); }
      else runText(w, x, o, r.text ?? '', r.props);
    } else runText(w, x, o, r.text ?? '', r.props);
  });
  if (!isDefault(p.endProps)) rpr(w, x, o, 'a:endParaRPr', p.endProps);
  w.close('a:p');
}
export const hasMath = tb => (tb.paragraphs ?? []).some(p => (p.runs ?? []).some(r => r.kind?.kind === 'math' && r.kind.omml));

// =================================================================================================
// custgeom.rs (writer half)

const fin = v => (Number.isFinite(v) ? clamp(v, -1e15, 1e15) : 0);
/** Tokens of a path's `d` text: [[cmd, nums]], M with several pairs continuing as L. */
export function parsePath(d) {
  const out = [];
  let cmd = null, nums = [], token = '';
  const pushTok = () => { if (token) { const v = Number(token); if (token.trim() !== '' && Number.isFinite(v)) nums.push(v); token = ''; } };
  const flush = () => {
    if (cmd) {
      const n = cmd === 'M' || cmd === 'L' ? 2 : cmd === 'C' ? 6 : cmd === 'Q' ? 4 : 0;
      if (n === 0) out.push([cmd, []]);
      else for (let i = 0; i + n <= nums.length; i += n) if (out.length < 1000000) out.push([cmd === 'M' && i > 0 ? 'L' : cmd, nums.slice(i, i + n)]);
    }
    nums = [];
  };
  for (const ch of String(d)) {
    if ('MLCQZmlcqzE'.includes(ch)) { pushTok(); flush(); cmd = ch.toUpperCase(); }
    else if (' ,\t\n'.includes(ch)) pushTok();
    else if (ch === '-' && token && !token.endsWith('e')) { pushTok(); token += ch; }
    else token += ch;
  }
  pushTok(); flush();
  return out;
}
export function writeCustGeom(w, paths) {
  w.open0('a:custGeom');
  w.empty0('a:avLst'); w.empty0('a:gdLst'); w.empty0('a:ahLst'); w.empty0('a:cxnLst');
  w.empty('a:rect', at().a('l', 'l').a('t', 't').a('r', 'r').a('b', 'b'));
  w.open0('a:pathLst');
  for (const p of paths) {
    const pw = Math.abs(fin(p.w)), ph = Math.abs(fin(p.h));
    const m = Math.max(pw, ph);
    const k = m > 0 && m < 20000 ? 100000 / m : 1;
    const r = v => clamp(Math.round(fin(v) * k), -2e9, 2e9);
    const fillMode = !p.fill || p.fill === 'norm' ? null : ['none', 'lighten', 'lightenLess', 'darken', 'darkenLess'].includes(p.fill) ? p.fill : null;
    w.open('a:path', at().a('w', Math.max(r(pw), 0)).a('h', Math.max(r(ph), 0)).o('fill', fillMode).o('stroke', p.stroke === false ? '0' : null));
    for (const [c, v] of parsePath(p.d)) {
      if (c === 'Z') { w.empty0('a:close'); continue; }
      const tag = {M: 'a:moveTo', L: 'a:lnTo', C: 'a:cubicBezTo', Q: 'a:quadBezTo'}[c];
      if (!tag) continue;
      w.open0(tag);
      for (let i = 0; i + 1 < v.length; i += 2) w.empty('a:pt', at().a('x', r(v[i])).a('y', r(v[i + 1])));
      w.close(tag);
    }
    w.close('a:path');
  }
  w.close('a:pathLst');
  w.close('a:custGeom');
}

// =================================================================================================
// write/shapes.rs

const MAXI = 2147483647;
const numId = id => (/^\d+$/.test(String(id)) ? Number(id) : NaN);
/** Shape ids in a part: the model's numeric ids where they're usable, fresh ones otherwise. */
class IdMap {
  constructor(shapes) {
    this.map = new Map();
    const used = new Set();
    let max = 1;
    walk(shapes, s => { const n = numId(s.id); if (n >= 2 && n < MAXI) max = Math.max(max, n); });
    let next = max;
    walk(shapes, s => {
      const n = numId(s.id);
      let id;
      if (n >= 2 && n < MAXI && !used.has(n)) id = n; else { next += 1; id = next; }
      used.add(id);
      if (!this.map.has(s.id)) this.map.set(s.id, id);
    });
    this.next = next;
  }
  get(id) { return this.map.get(id) ?? null; }
  fresh() { this.next += 1; return this.next; }
}
class Cx {
  constructor(ids) { this.ids = ids; this.written = new Set(); }
  idFor(s) {
    const id = this.ids.get(s.id) ?? 0;
    if (id >= 2 && !this.written.has(id)) { this.written.add(id); return id; }
    const f = this.ids.fresh();
    this.written.add(f);
    return f;
  }
}
const presetNameOut = name => (name === 'textBox' || !name || !/^[A-Za-z0-9]+$/.test(name) ? 'rect' : name);
function extraGuides(name) {
  switch (name) {
    case 'star5': case 'pentagon': return [['hf', 105146], ['vf', 110557]];
    case 'star7': case 'heptagon': return [['hf', 102572], ['vf', 105210]];
    case 'star6': return [['hf', 115470]];
    case 'star10': return [['hf', 105146]];
    case 'hexagon': return [['vf', 115470]];
    case 'decagon': return [['vf', 105146]];
    default: return [];
  }
}
export function geometry(w, g) {
  if (g?.kind === 'custom') {
    if (!(g.paths ?? []).length) { w.open('a:prstGeom', at().a('prst', 'rect')); w.empty0('a:avLst'); w.close('a:prstGeom'); }
    else writeCustGeom(w, g.paths);
    return;
  }
  const name = presetNameOut(g?.name ?? 'rect');
  const adj = g?.adj ?? [];
  w.open('a:prstGeom', at().a('prst', name));
  if (!adj.length) w.empty0('a:avLst');
  else {
    const defaults = presetInfo(name)?.defaults ?? [];
    const vals = adj.slice(0, 16);
    while (vals.length < defaults.length) vals.push(defaults[vals.length] ?? 0);
    w.open0('a:avLst');
    const adj1 = ['bentConnector3', 'curvedConnector3', 'frame', 'mathPlus', 'mathMinus', 'mathMultiply'].includes(name);
    const single = !adj1 && (defaults.length === 0 ? vals.length === 1 : defaults.length === 1);
    vals.forEach((v, i) => {
      const n = single && i === 0 ? 'adj' : `adj${i + 1}`;
      w.empty('a:gd', at().a('name', n).a('fmla', `val ${Number.isFinite(v) ? clamp(Math.round(v), -2e9, 2e9) : 0}`));
    });
    for (const [n, v] of extraGuides(name)) w.empty('a:gd', at().a('name', n).a('fmla', `val ${v}`));
    w.close('a:avLst');
  }
  w.close('a:prstGeom');
}
function cnvpr(w, x, o, id, s) {
  const a = at().a('id', id).a('name', s.name ? s.name : `Shape ${id}`).o('descr', s.descr || null).t('hidden', !!s.hidden).o('title', s.title || null);
  if (!s.click && !s.hover && !s.decorative) { w.empty('p:cNvPr', a); return; }
  w.open('p:cNvPr', a);
  if (s.click) hyperlink(w, x, o, 'a:hlinkClick', s.click);
  if (s.hover) hyperlink(w, x, o, 'a:hlinkHover', s.hover);
  if (s.decorative) {
    w.open0('a:extLst');
    w.open('a:ext', at().a('uri', '{C183D7F6-B498-43B3-948B-1728B52AA6E4}'));
    w.empty('adec:decorative', at().a('xmlns:adec', 'http://schemas.microsoft.com/office/drawing/2017/decorative').a('val', '1'));
    w.close('a:ext');
    w.close('a:extLst');
  }
  w.close('p:cNvPr');
}
function nvPr(w, x, o, s) {
  const tags = s.tags ?? [];
  if (!s.ph && !tags.length) { w.empty0('p:nvPr'); return; }
  w.open0('p:nvPr');
  if (s.ph) {
    const ph = s.ph;
    const sz = ['full', 'half', 'quarter'].includes(ph.size) ? ph.size : null;
    w.empty('p:ph', at().o('type', ph.kind === 'obj' ? null : phXml(ph.kind)).o('orient', ph.vertical ? 'vert' : null).o('sz', sz)
      .o('idx', ph.idx ? ph.idx : null).t('hasCustomPrompt', !!ph.hasCustomPrompt));
  }
  custData(w, x, o, tags);
  w.close('p:nvPr');
}
function locks(w, tag, s, extra) {
  const lk = !!s.locked;
  const a = extra.t('noGrp', !!s.ph || lk);
  if (tag === 'a:grpSpLocks') a.t('noUngrp', lk).t('noRot', lk).t('noMove', lk).t('noResize', lk);
  else {
    a.t('noRot', lk).t('noMove', lk).t('noResize', lk).t('noEditPoints', lk).t('noAdjustHandles', lk).t('noChangeArrowheads', lk).t('noChangeShapeType', lk);
    if (tag === 'a:picLocks') a.t('noCrop', lk);
  }
  if (!a.v.length) return;
  w.empty(tag, a);
}
function styleTag(w, st, tag) {
  w.open0(tag);
  for (const [t, ref] of [['a:lnRef', st.lineRef], ['a:fillRef', st.fillRef], ['a:effectRef', st.effectRef]]) {
    w.open(t, at().a('idx', ref?.[0] ?? 0)); color(w, ref?.[1] ?? {base: {kind: 'scheme', slot: 'accent1'}}); w.close(t);
  }
  const idx = ['major', 'minor', 'none'].includes(st.fontRef?.[0]) ? st.fontRef[0] : 'minor';
  if (st.fontRef?.[1]) { w.open('a:fontRef', at().a('idx', idx)); color(w, st.fontRef[1]); w.close('a:fontRef'); }
  else w.empty('a:fontRef', at().a('idx', idx));
  w.close(tag);
}
const isRectPreset = g => g?.kind !== 'custom' && (g?.name ?? 'rect') === 'rect' && !(g?.adj ?? []).length;
function spPrTag(w, x, o, s, geom, tag) {
  w.open0(tag);
  if (s.xfrm) xfrm(w, 'a:xfrm', s.xfrm, null);
  if (geom && (s.xfrm || !s.ph || !isRectPreset(s.geom))) geometry(w, s.geom);
  if (s.fill) fill(w, x, o, s.fill);
  if (s.line) line(w, x, o, 'a:ln', s.line);
  if (s.effects) {
    effects(w, s.effects);
    if (s.effects.raw3d) w.raw(s.effects.raw3d);
    else { const xml = bevelSp3d(s.effects.bevel); if (xml) w.raw(xml); }
  }
  w.close(tag);
}
const spPr = (w, x, o, s, geom) => spPrTag(w, x, o, s, geom, 'p:spPr');
function shapes(w, x, o, cx, list, depth) {
  if (depth > 32) return;
  for (const s of list ?? []) shape(w, x, o, cx, s, depth);
}
function shape(w, x, o, cx, s, depth) {
  const k = s.kind ?? {type: 'shape'};
  switch (k.type) {
    case 'shape': {
      if (s.text && hasMath(s.text)) {
        w.open('mc:AlternateContent', at().a('xmlns:mc', NS_MC));
        w.open('mc:Choice', at().a('xmlns:a14', NS_A14).a('Requires', 'a14'));
        const id = cx.idFor(s);
        sp(w, x, o, id, s, true);
        w.close('mc:Choice');
        w.open0('mc:Fallback'); sp(w, x, o, id, s, false); w.close('mc:Fallback');
        w.close('mc:AlternateContent');
      } else sp(w, x, o, cx.idFor(s), s, false);
      break;
    }
    case 'picture': writePicture(w, x, o, cx.idFor(s), s, k.fill, true); break;
    case 'group': {
      if (s.diagram && depth < 32) { diagramFrame(w, x, o, cx, s, k); break; }
      const id = cx.idFor(s);
      w.open0('p:grpSp');
      w.open0('p:nvGrpSpPr');
      cnvpr(w, x, o, id, s);
      w.open0('p:cNvGrpSpPr'); locks(w, 'a:grpSpLocks', s, at()); w.close('p:cNvGrpSpPr');
      nvPr(w, x, o, s);
      w.close('p:nvGrpSpPr');
      w.open0('p:grpSpPr');
      const child = k.child ?? {x: 0, y: 0, w: 0, h: 0};
      xfrm(w, 'a:xfrm', s.xfrm ?? child, child);
      if (s.fill) fill(w, x, o, s.fill);
      if (s.effects) effects(w, s.effects);
      w.close('p:grpSpPr');
      shapes(w, x, o, cx, k.children, depth + 1);
      w.close('p:grpSp');
      break;
    }
    case 'connector': {
      const id = cx.idFor(s);
      w.open0('p:cxnSp');
      w.open0('p:nvCxnSpPr');
      cnvpr(w, x, o, id, s);
      const st = k.start ? (cx.ids.get(k.start[0]) !== null ? [cx.ids.get(k.start[0]), k.start[1]] : null) : null;
      const en = k.end ? (cx.ids.get(k.end[0]) !== null ? [cx.ids.get(k.end[0]), k.end[1]] : null) : null;
      if (!st && !en && !s.locked) w.empty0('p:cNvCxnSpPr');
      else {
        w.open0('p:cNvCxnSpPr');
        locks(w, 'a:cxnSpLocks', s, at());
        if (st) w.empty('a:stCxn', at().a('id', st[0]).a('idx', st[1] ?? 0));
        if (en) w.empty('a:endCxn', at().a('id', en[0]).a('idx', en[1] ?? 0));
        w.close('p:cNvCxnSpPr');
      }
      nvPr(w, x, o, s);
      w.close('p:nvCxnSpPr');
      const s2 = {...s};
      if (s2.fill?.kind === 'background') s2.fill = null;
      if (s2.geom?.kind !== 'custom' && (s2.geom?.name ?? 'rect') === 'rect') s2.geom = {kind: 'preset', name: 'line'};
      spPr(w, x, o, s2, true);
      if (s.style) styleTag(w, s.style, 'p:style');
      w.close('p:cxnSp');
      break;
    }
    case 'table': {
      const id = cx.idFor(s);
      frameOpen(w, x, o, id, s);
      w.open('a:graphicData', at().a('uri', 'http://schemas.openxmlformats.org/drawingml/2006/table'));
      table(w, x, o, k);
      w.close('a:graphicData');
      frameClose(w);
      break;
    }
    case 'media': media(w, x, o, cx.idFor(s), s, k); break;
    case 'model3d': writeModel(w, x, o, cx, s, k.media, k.poster); break;
    case 'ink': {
      const id = cx.idFor(s);
      const xf = s.xfrm ?? {x: 0, y: 0, w: 0, h: 0};
      w.open0('p:grpSp');
      w.open0('p:nvGrpSpPr'); cnvpr(w, x, o, id, s); w.empty0('p:cNvGrpSpPr'); w.empty0('p:nvPr'); w.close('p:nvGrpSpPr');
      w.open0('p:grpSpPr'); xfrm(w, 'a:xfrm', xf, xf); w.close('p:grpSpPr');
      (k.strokes ?? []).slice(0, 10000).forEach((st, i) => { const stroke = inkShape(st, i); if (stroke) sp(w, x, o, cx.ids.fresh(), stroke, false); });
      w.close('p:grpSp');
      break;
    }
    case 'opaque': opaque(w, x, o, cx, s, k); break;
    case 'chart': {
      // A chart read from a file and not edited since is written back as it came; an edited or new one gets a fresh chart part.
      if (k.raw) { opaque(w, x, o, cx, s, k.raw); break; }
      const rel = x.chartRel(o, k);
      frameOpen(w, x, o, cx.idFor(s), s);
      w.open('a:graphicData', at().a('uri', 'http://schemas.openxmlformats.org/drawingml/2006/chart'));
      w.empty('c:chart', at().a('xmlns:c', NS_C).a('xmlns:r', NS_R).a('r:id', rel));
      w.close('a:graphicData');
      frameClose(w);
      break;
    }
    default: break;
  }
}
/**
 * A SmartArt graphic as PowerPoint stores it (deckcraft write/shapes.rs `diagram`): a graphic frame naming its data, layout, quick style and colour parts,
 * with the group's shapes as the cached drawing PowerPoint shows until it lays the diagram out. An imported diagram keeps the layout, style and colour parts it came with.
 */
function diagramFrame(w, x, o, cx, s, k) {
  const id = cx.idFor(s);
  const d = {...s.diagram, nodes: syncText(s.diagram, k.children ?? [])};
  const n = ++x.nDiagrams;
  const frame = s.xfrm ?? k.child ?? {x: 0, y: 0, w: 0, h: 0};
  const child = k.child ?? frame;
  const name = kind => `ppt/diagrams/${kind}${n}.xml`;
  // The drawing: the group's shapes in the frame's own coordinates.
  const dname = name('drawing');
  const dout = {name: dname, rels: new RelsOut()};
  const dw = new W();
  dw.open('dsp:drawing', at().a('xmlns:dgm', dgm.NS_DGM).a('xmlns:dsp', dgm.NS_DSP).a('xmlns:a', NS_A).a('xmlns:r', NS_R));
  dw.open0('dsp:spTree');
  dw.open0('dsp:nvGrpSpPr'); dw.empty('dsp:cNvPr', at().a('id', 0).a('name', '')); dw.empty0('dsp:cNvGrpSpPr'); dw.close('dsp:nvGrpSpPr');
  dw.empty0('dsp:grpSpPr');
  const sx = frame.w / Math.max(child.w, 1e-6), sy = frame.h / Math.max(child.h, 1e-6);
  const flat = [];
  walk(k.children ?? [], c => { if (c.kind?.type === 'shape') flat.push(c); });
  const seed = (parseInt(s.id, 10) || n) >>> 0;
  flat.slice(0, 10000).forEach((c0, i) => {
    const c = {...c0};
    if (c.xfrm) c.xfrm = {...c.xfrm, x: (c.xfrm.x - child.x) * sx, y: (c.xfrm.y - child.y) * sy, w: c.xfrm.w * sx, h: c.xfrm.h * sy};
    dw.open('dsp:sp', at().a('modelId', `{${seed.toString(16).toUpperCase().padStart(8, '0')}-5D1A-4C0A-9E5B-${(i + 1).toString(16).toUpperCase().padStart(12, '0')}}`));
    dw.open0('dsp:nvSpPr'); dw.empty('dsp:cNvPr', at().a('id', 0).a('name', '')); dw.empty0('dsp:cNvSpPr'); dw.close('dsp:nvSpPr');
    spPrTag(dw, x, dout, c, true, 'dsp:spPr');
    if (c.style) styleTag(dw, c.style, 'dsp:style');
    if (c.text) textBody(dw, x, dout, 'dsp:txBody', c.text, false);
    dw.close('dsp:sp');
  });
  dw.close('dsp:spTree');
  dw.close('dsp:drawing');
  x.pkg.xmlPart(dname, dgm.CT_DRAWING, dw.finish());
  x.pkg.rels(dname, dout.rels);
  const rel = (kind, part) => o.rels.add(kind, relative(o.name, part), false);
  const drawingRel = rel(dgm.RT_DRAWING, dname);
  const data = name('data');
  // Node pictures: on the data model's presentation points, through the data part's relationships.
  const mout = {name: data, rels: new RelsOut()};
  const pics = [];
  d.nodes.forEach((nd, i) => { if (nd.picture !== undefined && nd.picture !== null) { const r = x.mediaRel(mout, nd.picture, 'image'); if (r) pics.push([i, r]); } });
  x.pkg.xmlPart(data, dgm.CT_DATA, dgm.dataXml(d, seed, drawingRel, pics));
  x.pkg.rels(data, mout.rels);
  const dm = rel('diagramData', data);
  const layout = name('layout');
  x.pkg.xmlPart(layout, dgm.CT_LAYOUT, d.layoutXml ?? dgm.layoutXml(d.kind));
  const lo = rel('diagramLayout', layout);
  const style = name('quickStyle');
  x.pkg.xmlPart(style, dgm.CT_STYLE, d.styleXml ?? dgm.styleXml(d.style));
  const qs = rel('diagramQuickStyle', style);
  const colors = name('colors');
  x.pkg.xmlPart(colors, dgm.CT_COLORS, d.colorsXml ?? dgm.colorsXml(d.colors));
  const cs = rel('diagramColors', colors);
  frameOpen(w, x, o, id, {...s, xfrm: frame});
  w.open('a:graphicData', at().a('uri', 'http://schemas.openxmlformats.org/drawingml/2006/diagram'));
  w.empty('dgm:relIds', at().a('xmlns:dgm', dgm.NS_DGM).a('r:dm', dm).a('r:lo', lo).a('r:qs', qs).a('r:cs', cs));
  w.close('a:graphicData');
  frameClose(w);
}
function writePicture(w, x, o, id, s, pf, withPh) {
  w.open0('p:pic');
  w.open0('p:nvPicPr');
  cnvpr(w, x, o, id, s);
  w.open0('p:cNvPicPr');
  if (withPh) locks(w, 'a:picLocks', s, at().a('noChangeAspect', '1')); else w.empty('a:picLocks', at().a('noChangeAspect', '1'));
  w.close('p:cNvPicPr');
  if (withPh) nvPr(w, x, o, s); else w.empty0('p:nvPr');
  w.close('p:nvPicPr');
  blipFill(w, x, o, 'p:blipFill', pf ?? {media: '0'});
  const s2 = {...s};
  if (['picture', 'background', 'group'].includes(s2.fill?.kind)) s2.fill = null;
  spPr(w, x, o, s2, true);
  if (withPh && s.style) styleTag(w, s.style, 'p:style');
  w.close('p:pic');
}
function writeModel(w, x, o, cx, s, mediaId, poster) {
  const m = x.media(mediaId);
  const rid = m && m.data ? x.mediaRel(o, mediaId, RT_MODEL3D) : null;
  if (!rid) { x.warnings.push(`3-D model '${s.name}' has no embedded part`); return; }
  const id = cx.idFor(s);
  const part = () => {
    w.open('p:contentPart', at().a('r:id', rid));
    w.open0('p:nvContentPartPr'); cnvpr(w, x, o, id, s); w.empty0('p:cNvContentPartPr'); w.empty0('p:nvPr'); w.close('p:nvContentPartPr');
    if (s.xfrm) xfrm(w, 'p:xfrm', s.xfrm, null);
    w.close('p:contentPart');
  };
  const pm = poster !== null && poster !== undefined ? x.media(poster) : null;
  if (!pm || !pm.data) { part(); return; }
  w.open('mc:AlternateContent', at().a('xmlns:mc', NS_MC));
  w.open('mc:Choice', at().a('xmlns:am3d', 'http://schemas.microsoft.com/office/drawing/2017/model3d').a('Requires', 'am3d'));
  part();
  w.close('mc:Choice');
  w.open0('mc:Fallback');
  writePicture(w, x, o, cx.ids.fresh(), {name: s.name, xfrm: s.xfrm, fill: null, line: null, effects: null, geom: {kind: 'preset', name: 'rect'}},
    {media: poster, crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null, adjust: {}}, false);
  w.close('mc:Fallback');
  w.close('mc:AlternateContent');
}
function inkShape(st, i) {
  const pts = (st.points ?? []).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 2) return null;
  const x0 = Math.min(...pts.map(p => p[0])), y0 = Math.min(...pts.map(p => p[1]));
  const x1 = Math.max(...pts.map(p => p[0])), y1 = Math.max(...pts.map(p => p[1]));
  const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
  const legacy = st.points.length > 0 && st.points.every(p => Math.abs(p[2] - 0.5) <= 1e-3);
  const pen = Number.isFinite(st.width) ? Math.abs(st.width) : 0;
  const sample = pr => (legacy ? pen : pen * (Number.isFinite(pr) ? clamp(pr, 0.08, 1) : 1));
  const width = legacy ? st.width : st.points.reduce((a, p) => a + sample(p[2]), 0) / Math.max(st.points.length, 1);
  const d = pts.map((p, k) => `${k === 0 ? 'M ' : 'L '}${(p[0] - x0).toFixed(2)} ${(p[1] - y0).toFixed(2)} `).join('');
  let c = {base: {kind: 'rgb', rgb: {...(st.color ?? BLACK), a: 255}}};
  if (st.highlighter) c = {...c, mods: [{op: 'alpha', val: 50000}]};
  return {id: '0', name: `Ink ${i + 1}`, xfrm: {x: x0, y: y0, w, h}, geom: {kind: 'custom', paths: [{w, h, d, fill: 'none', stroke: true}]}, fill: {kind: 'none'},
    line: {fill: {kind: 'solid', color: c}, width: Math.max(width, 0.25), cap: 'round', join: 'round'}, kind: {type: 'shape'}, ph: null, text: null};
}
function sp(w, x, o, id, s, math) {
  w.open('p:sp', at().t('useBgFill', s.fill?.kind === 'background'));
  w.open0('p:nvSpPr');
  cnvpr(w, x, o, id, s);
  const cnv = at();
  if (s.textBox) cnv.a('txBox', '1');
  if (s.ph || s.locked) { w.open('p:cNvSpPr', cnv); locks(w, 'a:spLocks', s, at()); w.close('p:cNvSpPr'); } else w.empty('p:cNvSpPr', cnv);
  nvPr(w, x, o, s);
  w.close('p:nvSpPr');
  spPr(w, x, o, s.fill?.kind === 'background' ? {...s, fill: null} : s, true);
  if (s.style) styleTag(w, s.style, 'p:style');
  if (s.text) {
    if (!s.ph && !s.textBox && !s.text.body?.anchor) textBody(w, x, o, 'p:txBody', {...s.text, body: {...(s.text.body ?? {}), anchor: 'middle'}}, math);
    else textBody(w, x, o, 'p:txBody', s.text, math);
  }
  w.close('p:sp');
}
function frameOpen(w, x, o, id, s) {
  w.open0('p:graphicFrame');
  w.open0('p:nvGraphicFramePr');
  cnvpr(w, x, o, id, s);
  w.open0('p:cNvGraphicFramePr');
  w.empty('a:graphicFrameLocks', at().a('noGrp', '1').t('noDrilldown', !!s.locked).t('noMove', !!s.locked).t('noResize', !!s.locked));
  w.close('p:cNvGraphicFramePr');
  nvPr(w, x, o, s);
  w.close('p:nvGraphicFramePr');
  const xf = s.xfrm ?? {x: 0, y: 0, w: 0, h: 0};
  xfrm(w, 'p:xfrm', {x: xf.x, y: xf.y, w: xf.w, h: xf.h}, null);
  w.open0('a:graphic');
}
const frameClose = w => { w.close('a:graphic'); w.close('p:graphicFrame'); };
/** tables.rs `guid_for_style`: the style's GUID and whether the package must define it. */
export function guidForStyle(style) {
  if (String(style).startsWith('{')) return [String(style), false];
  if (BUILTIN_WRITE_TABLE_STYLES.includes(style)) { const k = KNOWN_TABLE_STYLES.find(([, s]) => s === style); if (k) return [k[0], false]; }
  return builtinTableStyles().some(([id]) => id === style) ? [ownTableGuid(style), true] : ['{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}', false];
}
function table(w, x, o, t0) {
  const t = normalizeTable(structuredClone(t0));
  w.open0('a:tbl');
  const [g] = guidForStyle(t.style ?? 'medium2-accent1');
  if (!x.tableStyles.includes(t.style)) x.tableStyles.push(t.style);
  w.open('a:tblPr', at().t('firstRow', t.firstRow).t('firstCol', t.firstCol).t('lastRow', t.lastRow).t('lastCol', t.lastCol).t('bandRow', t.bandRow).t('bandCol', t.bandCol));
  if (t.background) fill(w, x, o, t.background);
  w.elt('a:tableStyleId', g);
  w.close('a:tblPr');
  w.open0('a:tblGrid');
  for (const c of t.cols) w.empty('a:gridCol', at().a('w', emuPos(c)));
  w.close('a:tblGrid');
  for (const row of t.rows) {
    w.open('a:tr', at().a('h', emuPos(row.height)));
    for (const c of row.cells) {
      w.open('a:tc', at().o('gridSpan', c.gridSpan > 1 ? c.gridSpan : null).o('rowSpan', c.rowSpan > 1 ? c.rowSpan : null).t('hMerge', c.hMerge).t('vMerge', c.vMerge));
      textBody(w, x, o, 'a:txBody', c.text ?? {body: {}, paragraphs: []}, false);
      const a = at();
      if (c.margins) a.a('marL', emu(c.margins[0])).a('marR', emu(c.margins[1])).a('marT', emu(c.margins[2])).a('marB', emu(c.margins[3]));
      a.o('vert', c.vertical ? textDirXml(c.vertical) : null).o('anchor', c.anchor ? (c.anchor === 'justified' || c.anchor === 'distributed' ? 't' : anchorXml(c.anchor)) : null);
      w.open('a:tcPr', a);
      const b = c.borders ?? [];
      for (const [tag, l] of [['a:lnL', b[0]], ['a:lnR', b[1]], ['a:lnT', b[2]], ['a:lnB', b[3]], ['a:lnTlToBr', c.diagDown], ['a:lnBlToTr', c.diagUp]]) if (l) line(w, x, o, tag, l);
      if (c.fill && c.fill.kind !== 'background') fill(w, x, o, c.fill);
      w.close('a:tcPr');
      w.close('a:tc');
    }
    w.close('a:tr');
  }
  w.close('a:tbl');
}
function media(w, x, o, id, s, m) {
  const kind = m.video ? 'video' : 'audio';
  const link = x.mediaRel(o, m.media, kind);
  const embed = x.mediaRelNew(o, m.media, RT_MEDIA);
  w.open0('p:pic');
  w.open0('p:nvPicPr');
  cnvpr(w, x, o, id, s.click ? s : {...s, click: {action: {kind: 'playMedia'}, tooltip: '', highlightClick: false}});
  w.open0('p:cNvPicPr'); w.empty('a:picLocks', at().a('noChangeAspect', '1')); w.close('p:cNvPicPr');
  w.open0('p:nvPr');
  if (link) w.empty(m.video ? 'a:videoFile' : 'a:audioFile', at().a('r:link', link));
  if (embed) {
    w.open0('p:extLst');
    w.open('p:ext', at().a('uri', '{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}'));
    w.open('p14:media', at().a('xmlns:p14', NS_P14).a('r:embed', embed));
    if (m.trimStartMs > 0 || m.trimEndMs > 0) w.empty('p14:trim', at().o('st', m.trimStartMs > 0 ? m.trimStartMs : null).o('end', m.trimEndMs > 0 ? m.trimEndMs : null));
    if (m.fadeInMs > 0 || m.fadeOutMs > 0) w.empty('p14:fade', at().o('in', m.fadeInMs > 0 ? m.fadeInMs : null).o('out', m.fadeOutMs > 0 ? m.fadeOutMs : null));
    if ((m.bookmarks ?? []).length) {
      w.open0('p14:bmkLst');
      for (const [n, t] of m.bookmarks.slice(0, 1000)) w.empty('p14:bmk', at().a('name', n).a('time', t));
      w.close('p14:bmkLst');
    }
    w.close('p14:media'); w.close('p:ext'); w.close('p:extLst');
  }
  w.close('p:nvPr');
  w.close('p:nvPicPr');
  blipFill(w, x, o, 'p:blipFill', {media: m.poster ?? '0', crop: m.crop ?? [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null, adjust: {}});
  spPr(w, x, o, {...s, fill: null}, true);
  w.close('p:pic');
}
function opaque(w, x, o, cx, s, k) {
  let doc = null;
  try { doc = parseXml(k.xml ?? ''); } catch { doc = null; }
  if (doc && ['graphicFrame', 'sp', 'grpSp', 'cxnSp'].includes(doc.root.local)) {
    const partMap = new Map();
    for (const entry of k.parts ?? []) if (!partMap.has(entry[0])) partMap.set(entry[0], entry);
    const ids = new Map();
    let ok = true;
    for (const r of relRefs(doc.root)) {
      const entry = partMap.get(r);
      const nid = entry ? x.keptPartRel(o, entry) : null;
      if (!nid) { ok = false; break; }
      ids.set(r, nid);
    }
    if (ok) {
      const root = doc.root;
      setRelIds(root, ids, 0);
      oleFallback(root, x, o, k.preview);
      setCnvPrId(root, cx.idFor(s));
      w.raw(root.toXml());
      return;
    }
  }
  x.warnings.push(`object '${k.label}' written as its preview picture`);
  const id = cx.idFor(s);
  const pm = k.preview !== null && k.preview !== undefined ? x.media(k.preview) : null;
  if (pm) writePicture(w, x, o, id, {...s, name: s.name || k.label, ph: null}, {media: k.preview, crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null, adjust: {}}, false);
  else sp(w, x, o, id, {...s, name: s.name || k.label, kind: {type: 'shape'}, ph: null, geom: {kind: 'preset', name: 'rect'}, fill: {kind: 'none'}, text: null}, false);
}
function oleFallback(root, x, o, preview) {
  const t = root.child('xfrm');
  const atv = (e, a) => t?.child(e)?.attr(a) ?? '0';
  const ole = root.child('graphic')?.child('graphicData')?.child('oleObj');
  if (!ole || ole.child('pic') || ole.attr('spid') === null) return;
  ole.attrs = ole.attrs.filter(([kk]) => kk !== 'spid');
  const rel = (preview !== null && preview !== undefined ? x.mediaRel(o, preview, 'image') : null) ?? x.placeholderRel(o);
  const pic = `<p:pic><p:nvPicPr><p:cNvPr id="0" name=""/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${atv('off', 'x')}" y="${atv('off', 'y')}"/><a:ext cx="${atv('ext', 'cx')}" cy="${atv('ext', 'cy')}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  try { ole.children.push(parseXml(pic).root); } catch { /* malformed preview: left without one */ }
}
function setRelIds(e, ids, depth) {
  if (depth > 256) return;
  for (const a of e.attrs) if (isRelAttr(a[0], a[1]) && ids.has(a[1])) a[1] = ids.get(a[1]);
  for (const c of e.elements()) setRelIds(c, ids, depth + 1);
}
function setCnvPrId(el, id) {
  const rec = (e, depth) => {
    if (depth > 8) return false;
    if (e.is('cNvPr')) { e.setAttr('id', String(id)); return true; }
    return e.elements().some(c => rec(c, depth + 1));
  };
  rec(el, 0);
}
function treeHeader(w) {
  w.open0('p:nvGrpSpPr'); w.empty('p:cNvPr', at().a('id', 1).a('name', '')); w.empty0('p:cNvGrpSpPr'); w.empty0('p:nvPr'); w.close('p:nvGrpSpPr');
  w.open0('p:grpSpPr'); w.open0('a:xfrm');
  w.empty('a:off', at().a('x', 0).a('y', 0)); w.empty('a:ext', at().a('cx', 0).a('cy', 0));
  w.empty('a:chOff', at().a('x', 0).a('y', 0)); w.empty('a:chExt', at().a('cx', 0).a('cy', 0));
  w.close('a:xfrm'); w.close('p:grpSpPr');
}

// =================================================================================================
// write/theme.rs

function fontSetXml(w, tag, f) {
  w.open0(tag);
  w.empty('a:latin', at().a('typeface', f?.latin || 'Arial'));
  w.empty('a:ea', at().a('typeface', f?.ea ?? ''));
  w.empty('a:cs', at().a('typeface', f?.cs ?? ''));
  for (const sf of f?.scripts ?? []) w.empty('a:font', at().a('script', sf.script).a('typeface', sf.typeface));
  w.close(tag);
}
const phSolid = () => ({kind: 'solid', color: {base: {kind: 'scheme', slot: 'phClr'}}});
const styleFill = f => (f?.kind === 'background' || f?.kind === 'group' ? phSolid() : f);
function themeXml(x, o, t) {
  const w = new W();
  w.open('a:theme', at().a('xmlns:a', NS_A).a('xmlns:r', NS_R).a('name', t.name || 'Theme'));
  w.open0('a:themeElements');
  w.open('a:clrScheme', at().a('name', t.colors?.name || t.name));
  for (const slot of THEME_SLOTS) { w.open0(`a:${slot}`); w.val('a:srgbClr', hex(schemeGet(t.colors, slot))); w.close(`a:${slot}`); }
  w.close('a:clrScheme');
  w.open('a:fontScheme', at().a('name', t.fonts?.name || t.name));
  fontSetXml(w, 'a:majorFont', t.fonts?.major); fontSetXml(w, 'a:minorFont', t.fonts?.minor);
  w.close('a:fontScheme');
  const d = defaultFormat();
  const f = t.format ?? d;
  w.open('a:fmtScheme', at().a('name', f.name || t.name));
  const three = (v, dd) => { const out = (v ?? []).map(styleFill); while (out.length < 3) out.push(dd[out.length] ?? phSolid()); return out; };
  w.open0('a:fillStyleLst'); for (const fl of three(f.fills, d.fills)) fill(w, x, o, fl); w.close('a:fillStyleLst');
  w.open0('a:lnStyleLst');
  const lines = [...(f.lines ?? [])];
  while (lines.length < 3) lines.push(d.lines[lines.length] ?? {});
  for (const l0 of lines) { const l = {...l0}; if (!l.fill) l.fill = phSolid(); l.fill = styleFill(l.fill); line(w, x, o, 'a:ln', l); }
  w.close('a:lnStyleLst');
  w.open0('a:effectStyleLst');
  const fx = [...(f.effects ?? [])];
  while (fx.length < 3) fx.push({});
  for (const e of fx) {
    w.open0('a:effectStyle');
    effects(w, e);
    if (e.raw3d) w.raw(e.raw3d); else { const xml = bevelSp3d(e.bevel); if (xml) w.raw(xml); }
    w.close('a:effectStyle');
  }
  w.close('a:effectStyleLst');
  w.open0('a:bgFillStyleLst'); for (const fl of three(f.bgFills, d.bgFills)) fill(w, x, o, fl); w.close('a:bgFillStyleLst');
  w.close('a:fmtScheme');
  w.close('a:themeElements');
  if (t.rawExtra && t.rawExtra.includes('objectDefaults')) w.raw(t.rawExtra);
  else if (t.rawExtra) { w.empty0('a:objectDefaults'); w.raw(t.rawExtra); }
  else { w.empty0('a:objectDefaults'); w.empty0('a:extraClrSchemeLst'); }
  w.close('a:theme');
  return w.finish();
}

// =================================================================================================
// maps.rs `transition_to_xml` and write/timing.rs

/** Write a transition effect element; returns the namespace prefix it needs ('p', 'p14', 'p15', 'p159') or null when not modelled. */
export function transitionToXml(w, kind, option) {
  const lr = d => (['l', 'r'].includes(option) ? option : d);
  const lrud = d => (['l', 'r', 'u', 'd'].includes(option) ? option : d);
  const hv = d => (['horz', 'vert'].includes(option) ? option : d);
  const eight = d => (['l', 'r', 'u', 'd', 'lu', 'ru', 'ld', 'rd'].includes(option) ? option : d);
  switch (kind) {
    case 'fade': w.empty('p:fade', at().t('thruBlk', option === 'throughBlack')); return 'p';
    case 'cut': w.empty('p:cut', at().t('thruBlk', option === 'throughBlack')); return 'p';
    case 'push': w.empty('p:push', at().a('dir', lrud('u'))); return 'p';
    case 'wipe':
      if (['lu', 'ru', 'ld', 'rd'].includes(option)) w.empty('p:strips', at().a('dir', option)); else w.empty('p:wipe', at().a('dir', lrud('r')));
      return 'p';
    case 'split': {
      const [ori, d] = {vertIn: ['vert', 'in'], vertOut: ['vert', 'out'], horzIn: ['horz', 'in']}[option] ?? ['horz', 'out'];
      w.empty('p:split', at().a('orient', ori).a('dir', d));
      return 'p';
    }
    case 'randomBar': w.empty('p:randomBar', at().a('dir', hv('vert'))); return 'p';
    case 'shape':
      if (option === 'diamond') w.empty0('p:diamond'); else if (option === 'plus') w.empty0('p:plus');
      else if (option === 'in' || option === 'out') w.empty('p:zoom', at().a('dir', option)); else w.empty0('p:circle');
      return 'p';
    case 'zoom':
      if (option === 'rotate') { w.empty0('p:newsflash'); return 'p'; }
      w.empty('p14:warp', at().a('dir', option === 'out' ? 'out' : 'in'));
      return 'p14';
    case 'uncover': w.empty('p:pull', at().a('dir', eight('l'))); return 'p';
    case 'cover': w.empty('p:cover', at().a('dir', eight('l'))); return 'p';
    case 'checker': w.empty('p:checker', at().a('dir', hv('horz'))); return 'p';
    case 'blinds': w.empty('p:blinds', at().a('dir', hv('horz'))); return 'p';
    case 'comb': w.empty('p:comb', at().a('dir', hv('horz'))); return 'p';
    case 'clock':
      if (option === 'counterClockwise') { w.empty('p14:wheelReverse', at().a('spokes', 1)); return 'p14'; }
      if (option === 'wedge') w.empty0('p:wedge'); else w.empty('p:wheel', at().a('spokes', 1));
      return 'p';
    case 'dissolve': w.empty0('p:dissolve'); return 'p';
    case 'random': w.empty0('p:random'); return 'p';
    case 'honeycomb': w.empty0('p14:honeycomb'); return 'p14';
    case 'flash': w.empty0('p14:flash'); return 'p14';
    case 'vortex': w.empty('p14:vortex', at().a('dir', lrud('l'))); return 'p14';
    case 'glitter': {
      const hexp = option.startsWith('hex');
      let d = option.replace(/^hex/, '').toLowerCase();
      if (!['l', 'r', 'u', 'd'].includes(d)) d = 'l';
      w.empty('p14:glitter', at().a('dir', d).o('pattern', hexp ? 'hexagon' : null));
      return 'p14';
    }
    case 'switch': case 'flip': case 'gallery': case 'conveyor': case 'ferris': w.empty(`p14:${kind}`, at().a('dir', lr('l'))); return 'p14';
    case 'ripple': w.empty('p14:ripple', at().a('dir', ['lu', 'ru', 'ld', 'rd'].includes(option) ? option : 'center')); return 'p14';
    case 'doors': case 'window': w.empty(`p14:${kind}`, at().a('dir', hv('vert'))); return 'p14';
    case 'pan': w.empty('p14:pan', at().a('dir', lrud('d'))); return 'p14';
    case 'shred': w.empty('p14:shred', at().a('pattern', option.startsWith('particles') ? 'rectangle' : 'strip').a('dir', option.endsWith('Out') ? 'out' : 'in')); return 'p14';
    case 'reveal': w.empty('p14:reveal', at().t('thruBlk', option.startsWith('black')).a('dir', option.endsWith('Right') ? 'r' : 'l')); return 'p14';
    case 'flythrough': w.empty('p14:flythrough', at().a('dir', option.startsWith('out') ? 'out' : 'in').t('hasBounce', option.endsWith('Bounce'))); return 'p14';
    case 'cube': case 'box': case 'rotate': case 'orbit':
      w.empty('p14:prism', at().a('dir', lrud('l')).t('isContent', kind === 'rotate' || kind === 'orbit').t('isInverted', kind === 'box' || kind === 'orbit'));
      return 'p14';
    case 'pageCurlDouble':
      if (option.startsWith('single')) { w.empty('p15:prstTrans', at().a('prst', 'pageCurlSingle').t('invX', option === 'singleR')); return 'p15'; }
    // falls through
    case 'fallOver': case 'drape': case 'curtains': case 'wind': case 'prestige': case 'fracture': case 'crush': case 'peelOff': case 'airplane': case 'origami': {
      const inv = INVX_LEFT.includes(kind) ? option === 'l' : option === 'r';
      w.empty('p15:prstTrans', at().a('prst', kind).t('invX', inv));
      return 'p15';
    }
    case 'morph': w.empty('p159:morph', at().a('option', option === 'words' ? 'byWord' : option === 'characters' ? 'byChar' : 'byObject')); return 'p159';
    default: return null;
  }
}
function transitionXml(w, x, o, t) {
  const advClick = t.advanceOnClick === false ? '0' : null;
  const advTm = t.advanceAfterMs === null || t.advanceAfterMs === undefined ? null : Math.min(t.advanceAfterMs, 86400000);
  const dms = t.durationMs ?? 1000;
  const spd = dms <= 600 ? 'fast' : dms <= 900 ? 'med' : 'slow';
  const srid = t.sound !== null && t.sound !== undefined ? x.mediaRel(o, t.sound, 'audio') : null;
  const sname = srid ? x.media(t.sound)?.name ?? '' : '';
  const snd = ww => {
    if (srid) {
      ww.open0('p:sndAc'); ww.open('p:stSnd', at().t('loop', !!t.soundLoop)); ww.empty('p:snd', at().a('r:embed', srid).a('name', sname || 'sound.wav'));
      ww.close('p:stSnd'); ww.close('p:sndAc');
    } else if (t.stopSound) { ww.open0('p:sndAc'); ww.empty0('p:endSnd'); ww.close('p:sndAc'); }
  };
  let effect = W.frag();
  let ns = t.kind === 'none' ? 'p' : transitionToXml(effect, t.kind, t.option ?? '');
  if (!ns) {
    let d = null;
    try { d = t.raw ? parseXml(t.raw) : null; } catch { d = null; }
    const e = d?.root.elements().find(c => c.local !== 'sndAc' && c.local !== 'extLst');
    if (e && relRefs(e).length === 0) {
      const prefix = e.prefix;
      const e2 = e.clone();
      for (const [k, v] of d.nsDecls().filter(([k]) => k === `xmlns:${prefix}`)) e2.attrs.push([k, v]);
      effect.raw(e2.toXml());
      if (['p14', 'p15', 'p159', 'p'].includes(prefix)) ns = prefix;
      else { effect = W.frag(); effect.empty0('p:fade'); ns = 'p'; }
    } else { effect.empty0('p:fade'); ns = 'p'; }
  }
  const isNone = t.kind === 'none';
  const dur = Math.min(dms, 60000);
  w.open('mc:AlternateContent', at().a('xmlns:mc', NS_MC));
  const ch = at().a('xmlns:p14', NS_P14);
  let req = 'p14';
  if (ns === 'p15') { ch.a('xmlns:p15', NS_P15); req = 'p15'; } else if (ns === 'p159') { ch.a('xmlns:p159', NS_P159); req = 'p159'; }
  w.open('mc:Choice', ch.a('Requires', req));
  w.open('p:transition', at().a('spd', spd).o('p14:dur', isNone ? null : dur).o('advClick', advClick).o('advTm', advTm));
  if (!isNone) w.raw(effect.s);
  snd(w);
  w.close('p:transition');
  w.close('mc:Choice');
  w.open0('mc:Fallback');
  w.open('p:transition', at().a('spd', spd).o('advClick', advClick).o('advTm', advTm));
  if (!isNone) { if (ns === 'p') w.raw(effect.s); else w.empty0('p:fade'); }
  snd(w);
  w.close('p:transition');
  w.close('mc:Fallback');
  w.close('mc:AlternateContent');
}

class Ids { constructor() { this.v = 0; } next() { this.v += 1; return this.v; } }
function tgt(w, spid, para) {
  w.open0('p:tgtEl');
  if (para !== null && para !== undefined) {
    w.open('p:spTgt', at().a('spid', spid)); w.open0('p:txEl'); w.empty('p:pRg', at().a('st', para).a('end', para)); w.close('p:txEl'); w.close('p:spTgt');
  } else w.empty('p:spTgt', at().a('spid', spid));
  w.close('p:tgtEl');
}
function cbhvr(w, ids, e, dur, delay, attrs, additive) {
  w.open('p:cBhvr', at().o('additive', additive));
  const a = at().a('id', ids.next()).a('dur', Math.max(dur, 1)).a('fill', 'hold');
  if (delay !== null && delay !== undefined) {
    w.open('p:cTn', a); w.open0('p:stCondLst'); w.empty('p:cond', at().a('delay', delay)); w.close('p:stCondLst'); w.close('p:cTn');
  } else w.empty('p:cTn', a);
  tgt(w, e.spid, e.paragraph);
  if (attrs.length) { w.open0('p:attrNameLst'); for (const n of attrs) w.elt('p:attrName', n); w.close('p:attrNameLst'); }
  w.close('p:cBhvr');
}
function setVis(w, ids, e, delay, visible) {
  w.open0('p:set'); cbhvr(w, ids, e, 1, delay, ['style.visibility'], null);
  w.open0('p:to'); w.val('p:strVal', visible ? 'visible' : 'hidden'); w.close('p:to');
  w.close('p:set');
}
function animEffect(w, ids, e, dur, filter, out) {
  w.open('p:animEffect', at().a('transition', out ? 'out' : 'in').a('filter', filter)); cbhvr(w, ids, e, dur, null, [], null); w.close('p:animEffect');
}
function animProp(w, ids, e, dur, attr, from, to) {
  w.open('p:anim', at().a('calcmode', 'lin').a('valueType', 'num'));
  cbhvr(w, ids, e, dur, null, [attr], 'base');
  w.open0('p:tavLst');
  for (const [tm, v] of [[0, from], [100000, to]]) { w.open('p:tav', at().a('tm', tm)); w.open0('p:val'); w.val('p:strVal', v); w.close('p:val'); w.close('p:tav'); }
  w.close('p:tavLst');
  w.close('p:anim');
}
function filterFor(effect, option) {
  switch (effect) {
    case 'wipe': case 'wipeOut': return {t: 'wipe(down)', l: 'wipe(right)', r: 'wipe(left)'}[option] ?? 'wipe(up)';
    case 'split': case 'splitOut': return {horzOut: 'barn(outHorizontal)', vertIn: 'barn(inVertical)', vertOut: 'barn(outVertical)'}[option] ?? 'barn(inHorizontal)';
    case 'randomBars': case 'randomBarsOut': return option === 'vert' ? 'randombar(vertical)' : 'randombar(horizontal)';
    case 'blinds': case 'blindsOut': return option === 'vert' ? 'blinds(vertical)' : 'blinds(horizontal)';
    case 'box': case 'boxOut': return option === 'out' ? 'box(out)' : 'box(in)';
    case 'circle': return option === 'out' ? 'circle(out)' : 'circle(in)';
    case 'diamond': case 'diamondOut': return option === 'out' ? 'diamond(out)' : 'diamond(in)';
    case 'shape': case 'shapeOut': return {circleOut: 'circle(out)', boxIn: 'box(in)', boxOut: 'box(out)', diamondIn: 'diamond(in)', diamondOut: 'diamond(out)', plusIn: 'plus(in)', plusOut: 'plus(out)'}[option] ?? 'circle(in)';
    case 'checkerboard': case 'checkerboardOut': return option === 'down' ? 'checkerboard(down)' : 'checkerboard(across)';
    case 'dissolve': case 'dissolveOut': return 'dissolve';
    case 'wheel': case 'wheelOut': return {2: 'wheel(2)', 3: 'wheel(3)', 4: 'wheel(4)', 8: 'wheel(8)'}[option] ?? 'wheel(1)';
    case 'strips': case 'stripsOut': return {ru: 'strips(upRight)', ld: 'strips(downLeft)', rd: 'strips(downRight)'}[option] ?? 'strips(upLeft)';
    case 'peek': case 'peekOut': return {t: 'slide(fromTop)', l: 'slide(fromLeft)', r: 'slide(fromRight)'}[option] ?? 'slide(fromBottom)';
    default: return 'fade';
  }
}
function flyFrom(option) {
  const x = option.includes('l') ? '0-#ppt_w/2' : option.includes('r') ? '1+#ppt_w/2' : '#ppt_x';
  const y = option.includes('t') ? '0-#ppt_h/2' : option.includes('b') || option === '' ? '1+#ppt_h/2' : '#ppt_y';
  return [x, y];
}
function behaviors(w, ids, e) {
  const a = e.a;
  const dur = clamp(a.durationMs ?? 500, 1, 3600000);
  const opt = a.option ?? '';
  switch (a.class) {
    case 'entrance':
      setVis(w, ids, e, 0, true);
      switch (a.effect) {
        case 'appear': break;
        case 'fly': { const [fx, fy] = flyFrom(opt); animProp(w, ids, e, dur, 'ppt_x', fx, '#ppt_x'); animProp(w, ids, e, dur, 'ppt_y', fy, '#ppt_y'); break; }
        case 'zoom': case 'grow': case 'expand': case 'spinner':
          animProp(w, ids, e, dur, 'ppt_w', '0', '#ppt_w'); animProp(w, ids, e, dur, 'ppt_h', '0', '#ppt_h'); animEffect(w, ids, e, dur, 'fade', false); break;
        case 'float': case 'rise': animProp(w, ids, e, dur, 'ppt_y', opt === 'd' ? '#ppt_y-.1' : '#ppt_y+.1', '#ppt_y'); animEffect(w, ids, e, dur, 'fade', false); break;
        default: animEffect(w, ids, e, dur, filterFor(a.effect, opt), false);
      }
      break;
    case 'exit':
      switch (a.effect) {
        case 'disappear': break;
        case 'flyOut': { const [fx, fy] = flyFrom(opt); animProp(w, ids, e, dur, 'ppt_x', '#ppt_x', fx); animProp(w, ids, e, dur, 'ppt_y', '#ppt_y', fy); break; }
        case 'floatOut': case 'sinkDown': {
          const to = a.effect === 'sinkDown' || opt === 'd' ? '#ppt_y+.1' : '#ppt_y-.1';
          animProp(w, ids, e, dur, 'ppt_y', '#ppt_y', to); animEffect(w, ids, e, dur, 'fade', true); break;
        }
        case 'zoomOut': case 'shrinkTurn': case 'spinnerOut': case 'contract':
          animProp(w, ids, e, dur, 'ppt_w', '#ppt_w', '0'); animProp(w, ids, e, dur, 'ppt_h', '#ppt_h', '0'); animEffect(w, ids, e, dur, 'fade', true); break;
        default: animEffect(w, ids, e, dur, filterFor(a.effect, opt), true);
      }
      setVis(w, ids, e, a.effect === 'disappear' ? 0 : Math.max(dur - 1, 0), false);
      break;
    case 'emphasis':
      switch (a.effect) {
        case 'spin': case 'teeter': {
          let deg = a.amount ?? (a.effect === 'teeter' ? 4 : 360);
          if (opt === 'counterClockwise') deg = -Math.abs(deg);
          w.open('p:animRot', at().a('by', Math.round(clamp(deg, -36000, 36000) * 60000)));
          cbhvr(w, ids, e, dur, null, ['r'], null);
          w.close('p:animRot');
          break;
        }
        case 'transparency':
          w.open0('p:set'); cbhvr(w, ids, e, dur, null, ['style.opacity'], null);
          w.open0('p:to'); w.val('p:strVal', clamp(1 - (a.amount ?? 0.5), 0, 1).toFixed(2)); w.close('p:to');
          w.close('p:set');
          break;
        case 'colorPulse': {
          const c = a.color ?? {base: {kind: 'rgb', rgb: {r: 0xC0, g: 0, b: 0, a: 255}}};
          for (const [attr, child] of [['style.color', true], ['fillcolor', false]]) {
            w.open('p:animClr', at().a('clrSpc', 'rgb').a('dir', 'cw'));
            w.open('p:cBhvr', at().o('override', child ? 'childStyle' : null));
            w.empty('p:cTn', at().a('id', ids.next()).a('dur', Math.max(dur, 1)).a('autoRev', '1').a('fill', 'remove'));
            tgt(w, e.spid, e.paragraph);
            w.open0('p:attrNameLst'); w.elt('p:attrName', attr); w.close('p:attrNameLst');
            w.close('p:cBhvr');
            w.open0('p:to'); color(w, c); w.close('p:to');
            w.close('p:animClr');
          }
          break;
        }
        case 'fillColor': case 'objectColor': case 'fontColor': case 'lineColor': case 'complementaryColor': case 'darken': case 'lighten': {
          const attr = a.effect === 'fontColor' ? 'style.color' : a.effect === 'lineColor' ? 'stroke.color' : 'fillcolor';
          const c = a.color ?? {base: {kind: 'scheme', slot: 'accent2'}};
          w.open('p:animClr', at().a('clrSpc', 'rgb').a('dir', 'cw'));
          cbhvr(w, ids, e, dur, null, [attr], null);
          w.open0('p:to'); color(w, c); w.close('p:to');
          w.close('p:animClr');
          break;
        }
        default: {
          const s = Number.isFinite(a.amount) && a.amount > 0 ? a.amount : a.effect === 'growShrink' ? 1.5 : 1.1;
          const [sx, sy] = opt === 'horz' ? [s, 1] : opt === 'vert' ? [1, s] : [s, s];
          w.open0('p:animScale');
          cbhvr(w, ids, e, dur, null, [], null);
          w.empty('p:by', at().a('x', Math.round(clamp(sx, 0.01, 100) * 100000)).a('y', Math.round(clamp(sy, 0.01, 100) * 100000)));
          w.close('p:animScale');
        }
      }
      break;
    case 'path': {
      const ok = a.path && a.path.trim() && /^[\x20-\x7E]*$/.test(a.path) && !/["<&]/.test(a.path);
      const path = ok ? a.path : {up: 'M 0 0 L 0 -0.25 E', right: 'M 0 0 L 0.25 0 E', left: 'M 0 0 L -0.25 0 E'}[opt] ?? 'M 0 0 L 0 0.25 E';
      w.open('p:animMotion', at().a('origin', 'layout').a('path', path).a('pathEditMode', 'relative').a('ptsTypes', ''));
      cbhvr(w, ids, e, dur, null, ['ppt_x', 'ppt_y'], null);
      w.close('p:animMotion');
      break;
    }
    case 'media': {
      const cmd = a.effect === 'pause' ? 'togglePause' : a.effect === 'stop' ? 'stop' : 'playFrom(0.0)';
      w.open('p:cmd', at().a('type', 'call').a('cmd', cmd)); cbhvr(w, ids, e, 1, null, [], null); w.close('p:cmd');
      break;
    }
    default: break;
  }
}
/** maps.rs `preset_for`: the preset id written for an animation. */
export function presetFor(a) {
  if ((a.effect === 'float' || a.effect === 'floatOut') && a.option === 'd') return 47;
  if (a.presetId !== null && a.presetId !== undefined) {
    const e = effectForPreset(a.class, a.presetId);
    if (e ? e === a.effect : a.effect === fallbackEffect(a.class)) return a.presetId;
  }
  const info = animationInfo(a.effect, a.class);
  if (info && info[2] === a.class) return info[3];
  return {entrance: 10, exit: 10, emphasis: 26, path: 0, media: 1}[a.class] ?? 10;
}
function effectPar(w, ids, e) {
  const a = e.a;
  const node = e.start === 'onClick' ? 'clickEffect' : e.start === 'withPrevious' ? 'withEffect' : 'afterEffect';
  const preset = presetFor(a);
  const sub = preset === 47 ? 0 : subtypeFromOption(a.effect, a.option ?? '') ?? (a.presetId === preset ? a.presetSubtype : null) ?? 0;
  const repeat = a.repeat === 4294967295 ? 'indefinite' : !a.repeat || a.repeat === 1 ? null : String(Math.min(a.repeat, 10000) * 1000);
  const accel = a.smoothStart > 0 ? Math.round(clamp(a.smoothStart, 0, 1) * 100000) : null;
  const decel = a.smoothEnd > 0 ? Math.round(clamp(a.smoothEnd, 0, 1) * 100000) : null;
  const bounceN = Number.isFinite(a.bounceEnd) && a.bounceEnd > 0 ? Math.round(clamp(a.bounceEnd, 0, 1) * 100000) : 0;
  w.open0('p:par');
  w.open('p:cTn', at().a('id', ids.next()).a('presetID', preset).a('presetClass', animClassXml(a.class)).a('presetSubtype', sub).o('repeatCount', repeat)
    .o('accel', accel).o('decel', decel).o('bounceEnd', bounceN > 0 ? bounceN : null).t('autoRev', !!a.autoReverse).a('fill', a.rewind ? 'remove' : 'hold')
    .a('grpId', e.grp).a('nodeType', node));
  w.open0('p:stCondLst'); w.empty('p:cond', at().a('delay', Math.min(a.delayMs ?? 0, 3600000))); w.close('p:stCondLst');
  w.open0('p:childTnLst'); behaviors(w, ids, e); w.close('p:childTnLst');
  w.close('p:cTn');
  w.close('p:par');
}
function endTime(e) {
  const rep = !e.a.repeat || e.a.repeat === 1 || e.a.repeat === 4294967295 ? 1 : Math.min(e.a.repeat, 100);
  return Math.min((e.a.delayMs ?? 0) + (e.a.durationMs ?? 0) * rep, 3600000);
}
function group(effs) {
  const clicks = [];
  for (const e of effs) {
    if (e.start === 'onClick') clicks.push([false, [[e]]]);
    else if (e.start === 'withPrevious') { const last = clicks[clicks.length - 1]; if (last) last[1][last[1].length - 1].push(e); else clicks.push([true, [[e]]]); }
    else { const last = clicks[clicks.length - 1]; if (last) last[1].push([e]); else clicks.push([true, [[e]]]); }
  }
  return clicks;
}
function clickPars(w, ids, clicks, interactive) {
  clicks.forEach(([auto, afters], ci) => {
    w.open0('p:par');
    w.open('p:cTn', at().a('id', ids.next()).a('fill', 'hold'));
    w.open0('p:stCondLst');
    if (interactive && ci === 0) w.empty('p:cond', at().a('delay', 0));
    else {
      w.empty('p:cond', at().a('delay', 'indefinite'));
      if (auto) { w.open('p:cond', at().a('evt', 'onBegin').a('delay', 0)); w.val('p:tn', 2); w.close('p:cond'); }
    }
    w.close('p:stCondLst');
    w.open0('p:childTnLst');
    let t = 0;
    for (const g of afters) {
      w.open0('p:par');
      w.open('p:cTn', at().a('id', ids.next()).a('fill', 'hold'));
      w.open0('p:stCondLst'); w.empty('p:cond', at().a('delay', t)); w.close('p:stCondLst');
      w.open0('p:childTnLst'); for (const e of g) effectPar(w, ids, e); w.close('p:childTnLst');
      w.close('p:cTn');
      w.close('p:par');
      t += Math.max(0, ...g.map(endTime));
    }
    w.close('p:childTnLst');
    w.close('p:cTn');
    w.close('p:par');
  });
}
function findShapeDeep(shapes, id) { let f = null; walk(shapes, s => { if (!f && s.id === id) f = s; }); return f; }
function timing(w, x, anims, shapesList, idmap) {
  const grpCount = new Map();
  const main = [], triggered = [], bld = [];
  let prevPara = null;
  for (const a of (anims ?? []).slice(0, 10000)) {
    const spid = idmap.get(a.shape);
    if (spid === null) { x.warnings.push(`animation on missing shape ${a.shape} skipped`); continue; }
    const sh = findShapeDeep(shapesList, a.shape);
    if (!sh) continue;
    const textSp = sh.kind?.type === 'shape' && !!sh.text;
    const isTextSp = textSp && (sh.text.paragraphs ?? []).some(p => (p.runs ?? []).some(r => r.kind?.kind === 'break' || (r.text ?? '') !== ''));
    const text = a.textBuild === 'byParagraph' && isTextSp ? sh.text : null;
    const roles = text ? paragraphBuildRoles(text) : [];
    const byPara = roles.some(r => r.top);
    const paraEffect = !byPara && textSp && a.paragraph !== null && a.paragraph !== undefined;
    const joins = paraEffect && !!prevPara && prevPara[0] === a.shape && prevPara[1] === a.class && prevPara[2] === (a.trigger ?? null);
    let grp;
    if (joins) grp = prevPara[3];
    else { grp = grpCount.get(spid) ?? 0; grpCount.set(spid, grp + 1); }
    prevPara = paraEffect ? [a.shape, a.class, a.trigger ?? null, grp] : null;
    const effs = [];
    if (byPara) {
      let tops = 0;
      roles.forEach((role, i) => {
        let start;
        if (role.top) { tops++; start = tops === 1 ? a.start : a.start === 'onClick' ? 'onClick' : 'afterPrevious'; }
        else if (role.member !== undefined && buildFilled(text.paragraphs[i])) start = 'withPrevious';
        else return;
        effs.push({a, spid, start, paragraph: i, grp});
      });
    } else effs.push({a, spid, start: a.start, paragraph: a.paragraph ?? null, grp});
    if (textSp && !joins) bld.push([spid, grp, byPara || paraEffect]);
    const trig = a.trigger !== null && a.trigger !== undefined ? idmap.get(a.trigger) : null;
    if (trig !== null && trig !== undefined) {
      const hit = triggered.find(([s]) => s === trig);
      if (hit) hit[1].push(...effs); else triggered.push([trig, effs]);
    } else main.push(...effs);
  }
  if (!main.length && !triggered.length) return;
  const ids = new Ids();
  w.open0('p:timing');
  w.open0('p:tnLst');
  w.open0('p:par');
  w.open('p:cTn', at().a('id', ids.next()).a('dur', 'indefinite').a('restart', 'never').a('nodeType', 'tmRoot'));
  w.open0('p:childTnLst');
  const sldCond = (tag, evt) => { w.open0(tag); w.open('p:cond', at().a('evt', evt).a('delay', 0)); w.open0('p:tgtEl'); w.empty0('p:sldTgt'); w.close('p:tgtEl'); w.close('p:cond'); w.close(tag); };
  if (main.length) {
    const clicks = group(main);
    w.open('p:seq', at().a('concurrent', 1).a('nextAc', 'seek'));
    w.open('p:cTn', at().a('id', ids.next()).a('dur', 'indefinite').a('nodeType', 'mainSeq'));
    w.open0('p:childTnLst'); clickPars(w, ids, clicks, false); w.close('p:childTnLst');
    w.close('p:cTn');
    sldCond('p:prevCondLst', 'onPrev');
    sldCond('p:nextCondLst', 'onNext');
    w.close('p:seq');
  }
  for (const [trig, effs0] of triggered) {
    const effs = effs0.map((e, i) => ({...e, start: i === 0 ? 'onClick' : e.start}));
    const clicks = group(effs);
    const trigCond = () => { w.open('p:cond', at().a('evt', 'onClick').a('delay', 0)); w.open0('p:tgtEl'); w.empty('p:spTgt', at().a('spid', trig)); w.close('p:tgtEl'); w.close('p:cond'); };
    w.open('p:seq', at().a('concurrent', 1).a('nextAc', 'seek'));
    w.open('p:cTn', at().a('id', ids.next()).a('restart', 'whenNotActive').a('fill', 'hold').a('evtFilter', 'cancelBubble').a('nodeType', 'interactiveSeq'));
    w.open0('p:stCondLst'); trigCond(); w.close('p:stCondLst');
    w.open('p:endSync', at().a('evt', 'end').a('delay', 0)); w.empty('p:rtn', at().a('val', 'all')); w.close('p:endSync');
    w.open0('p:childTnLst'); clickPars(w, ids, clicks, true); w.close('p:childTnLst');
    w.close('p:cTn');
    w.open0('p:nextCondLst'); trigCond(); w.close('p:nextCondLst');
    w.close('p:seq');
  }
  w.close('p:childTnLst');
  w.close('p:cTn');
  w.close('p:par');
  w.close('p:tnLst');
  if (bld.length) {
    w.open0('p:bldLst');
    for (const [spid, grp, buildP] of bld) w.empty('p:bldP', at().a('spid', spid).a('grpId', grp).o('build', buildP ? 'p' : null).t('animBg', !buildP));
    w.close('p:bldLst');
  }
  w.close('p:timing');
}

// =================================================================================================
// tables.rs style part writer

function tsClr(w, slot, mods) {
  if (!mods.length) { w.val('a:schemeClr', slot); return; }
  w.open('a:schemeClr', at().a('val', slot)); for (const [n, v] of mods) w.val(n, v); w.close('a:schemeClr');
}
function tsSolid(w, slot, mods) { w.open0('a:fill'); w.open0('a:solidFill'); tsClr(w, slot, mods); w.close('a:solidFill'); w.close('a:fill'); }
function tsBorders(w, b) {
  w.open0('a:tcBdr');
  if (b) {
    const [slot, mods, width] = b;
    for (const side of ['a:left', 'a:right', 'a:top', 'a:bottom', 'a:insideH', 'a:insideV']) {
      w.open0(side); w.open('a:ln', at().a('w', width).a('cmpd', 'sng')); w.open0('a:solidFill'); tsClr(w, slot, mods); w.close('a:solidFill'); w.close('a:ln'); w.close(side);
    }
  }
  w.close('a:tcBdr');
}
function tsTxt(w, bold, c) {
  w.open('a:tcTxStyle', at().o('b', bold ? 'on' : null));
  w.open('a:fontRef', at().a('idx', 'minor')); w.val('a:prstClr', 'black'); w.close('a:fontRef');
  w.val('a:schemeClr', c ?? 'dk1');
  w.close('a:tcTxStyle');
}
function styleDef(w, id, name) {
  const kind = id.split('-')[0] || 'medium2';
  const last = id.split('-').pop() || 'accent1';
  const acc = last === 'tx1' ? 'dk1' : last.startsWith('accent') ? last : 'accent1';
  w.open('a:tblStyle', at().a('styleId', ownTableGuid(id)).a('styleName', name));
  const part = (tag, bold, text, fillv, bdr) => {
    w.open0(tag);
    if (bold || text) tsTxt(w, bold, text);
    w.open0('a:tcStyle'); tsBorders(w, bdr); if (fillv) tsSolid(w, fillv[0], fillv[1]); w.close('a:tcStyle');
    w.close(tag);
  };
  const tint = v => [['a:tint', v]], shade = v => [['a:shade', v]];
  switch (kind) {
    case 'grid': part('a:wholeTbl', false, 'dk1', null, ['dk1', [], 9525]); break;
    case 'light1':
      part('a:wholeTbl', false, 'dk1', null, null);
      part('a:band1H', false, null, [acc, tint(20000)], null); part('a:band1V', false, null, [acc, tint(20000)], null);
      part('a:lastCol', true, null, null, null); part('a:firstCol', true, null, null, null); part('a:lastRow', true, null, null, null);
      part('a:firstRow', true, null, null, [acc, [], 12700]);
      break;
    case 'light2':
      part('a:wholeTbl', false, 'dk1', null, [acc, [], 12700]);
      part('a:firstCol', true, null, null, null); part('a:lastRow', true, null, null, null);
      part('a:firstRow', true, 'lt1', [acc, []], [acc, [], 12700]);
      break;
    case 'dark1':
      part('a:wholeTbl', false, 'lt1', [acc, shade(75000)], ['lt1', [], 12700]);
      part('a:band1H', false, null, [acc, shade(60000)], null); part('a:band1V', false, null, [acc, shade(60000)], null);
      part('a:firstCol', true, null, null, null); part('a:lastRow', true, null, null, null);
      part('a:firstRow', true, 'lt1', ['dk1', []], null);
      break;
    case 'medium4':
      part('a:wholeTbl', false, 'dk1', [acc, tint(20000)], [acc, [], 9525]);
      part('a:band1H', false, null, [acc, tint(40000)], null); part('a:band1V', false, null, [acc, tint(40000)], null);
      part('a:lastCol', true, null, null, null); part('a:firstCol', true, null, null, null); part('a:lastRow', true, null, null, null);
      part('a:firstRow', true, null, [acc, tint(40000)], null);
      break;
    default:
      part('a:wholeTbl', false, 'dk1', [acc, tint(20000)], ['lt1', [], 12700]);
      part('a:band1H', false, null, [acc, tint(40000)], null); part('a:band1V', false, null, [acc, tint(40000)], null);
      part('a:lastCol', true, 'lt1', [acc, []], null); part('a:firstCol', true, 'lt1', [acc, []], null); part('a:lastRow', true, 'lt1', [acc, []], null);
      part('a:firstRow', true, 'lt1', [acc, []], null);
  }
  w.close('a:tblStyle');
}
const rawIsTblStyle = raw => { try { return parseXml(raw).root.is('tblStyle'); } catch { return false; } };
export function tableStylesXml(used, defs) {
  const w = new W();
  w.open('a:tblStyleLst', at().a('xmlns:a', NS_A).a('def', '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'));
  const names = builtinTableStyles();
  const done = [];
  for (const s of used) {
    if (done.includes(s)) continue;
    done.push(s);
    const d = (defs ?? []).find(dd => dd.id.toLowerCase() === String(s).toLowerCase());
    if (d && d.raw && rawIsTblStyle(d.raw)) { w.raw(d.raw); continue; }
    const [, define] = guidForStyle(s);
    if (!define) continue;
    const n = names.find(([id]) => id === s);
    styleDef(w, s, n ? `Arkemis ${n[1]}` : s);
  }
  for (const d of defs ?? []) {
    if (done.some(s => String(s).toLowerCase() === d.id.toLowerCase())) continue;
    if (d.raw && rawIsTblStyle(d.raw)) { done.push(d.id); w.raw(d.raw); }
  }
  w.close('a:tblStyleLst');
  return w.finish();
}

// =================================================================================================
// write.rs: the package

function extFor(contentType, name, data) {
  const byCt = {'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/svg+xml': 'svg',
    'image/x-emf': 'emf', 'image/emf': 'emf', 'image/x-wmf': 'wmf', 'image/wmf': 'wmf', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
    'video/x-ms-wmv': 'wmv', 'video/x-msvideo': 'avi', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
    'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/x-ms-wma': 'wma', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'model/gltf-binary': 'glb'}[contentType];
  if (byCt) return byCt;
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return 'png';
  if (data[0] === 0xFF && data[1] === 0xD8) return 'jpeg';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'gif';
  const e = String(name).includes('.') ? String(name).split('.').pop().toLowerCase() : '';
  return e && e.length <= 5 && /^[a-z0-9]+$/.test(e) ? e : 'bin';
}
/** Folder a kept (opaque) part goes back to, by the relationship that names it. */
function keptFolder(relType) {
  const k = String(relType).split('/').pop();
  if (k === 'chart' || k === 'chartEx' || k === 'chartUserShapes' || k === 'chartStyle' || k === 'chartColorStyle') return 'ppt/charts';
  if (k.startsWith('diagram')) return 'ppt/diagrams';
  if (k === 'oleObject' || k === 'package') return 'ppt/embeddings';
  if (k === 'vmlDrawing' || k === 'drawing') return 'ppt/drawings';
  return null;
}

class Exp {
  constructor(p) {
    this.p = p;
    this.pkg = new PackageOut();
    this.mediaParts = new Map();
    this.mediaById = new Map((p.media ?? []).map(m => [m.id, m]));
    this.bytesCache = new Map();
    this.nImage = 0; this.nMedia = 0; this.nTags = 0; this.nCharts = 0; this.nDiagrams = 0; this.pending = [];
    this.slideParts = new Map();
    this.tableStyles = [];
    this.placeholder = null;
    this.keptNames = new Map();
    this.warnings = [];
  }
  media(id) { return this.mediaById.get(id) ?? null; }
  bytes(m) {
    if (!this.bytesCache.has(m.id)) this.bytesCache.set(m.id, m.data ? base64Decode(m.data) : new Uint8Array(0));
    return this.bytesCache.get(m.id);
  }
  mediaPart(id) {
    if (this.mediaParts.has(id)) return this.mediaParts.get(id);
    const m = this.media(id);
    if (!m || !m.data) return null;
    const data = this.bytes(m);
    if (!data.length) return null;
    const ext = extFor(m.contentType, m.name, data);
    const ct = !m.contentType || !m.contentType.includes('/') ? mimeFor(`x.${ext}`) : m.contentType;
    let name;
    if (ct.startsWith('image/')) { this.nImage += 1; name = `ppt/media/image${this.nImage}.${ext}`; }
    else { this.nMedia += 1; name = `ppt/media/media${this.nMedia}.${ext}`; }
    this.pkg.binary(name, ct, data);
    this.mediaParts.set(id, name);
    return name;
  }
  mediaRel(o, id, kind) {
    const m = this.media(id);
    if (!m) return null;
    if (!m.data) return m.link ? o.rels.add(kind, m.link, true) : null;
    const part = this.mediaPart(id);
    return part ? o.rels.add(kind, relative(o.name, part), false) : null;
  }
  mediaRelNew(o, id, kind) {
    const m = this.media(id);
    if (!m || !m.data) return null;
    const part = this.mediaPart(id);
    return part ? o.rels.add(kind, relative(o.name, part), false) : null;
  }
  placeholderRel(o) {
    if (!this.placeholder) {
      this.nImage += 1;
      this.placeholder = `ppt/media/image${this.nImage}.png`;
      this.pkg.binary(this.placeholder, 'image/png', transparent1x1());
    }
    return o.rels.add('image', relative(o.name, this.placeholder), false);
  }
  /** A kept part of an opaque object (with its own kept relationships) written once; the relationship id from `o`. */
  keptPartRel(o, entry) {
    const [, relType, mediaId, nested] = entry;
    const m = this.media(mediaId);
    if (!m) return null;
    if (!m.data) return m.link ? o.rels.add(relType, m.link, true) : null;
    const folder = keptFolder(relType);
    if (!folder) return this.mediaRel(o, mediaId, relType);
    let name = this.keptNames.get(mediaId);
    if (!name) {
      const base = (m.name || 'part.xml').replace(/[^A-Za-z0-9._-]/g, '_');
      name = `${folder}/${base}`;
      let n = 1;
      while (this.pkg.has(name)) { const dot = base.lastIndexOf('.'); name = `${folder}/${dot > 0 ? base.slice(0, dot) : base}_${n}${dot > 0 ? base.slice(dot) : ''}`; n++; }
      this.keptNames.set(mediaId, name);
      const data = this.bytes(m);
      const ct = m.contentType || mimeFor(name);
      if (/xml/.test(ct)) this.pkg.xmlPart(name, ct, data); else this.pkg.binary(name, ct, data);
      if (nested?.length) {
        const sub = {name, rels: new RelsOut()};
        const ids = new Map();
        for (const e of nested) { const rid = this.keptPartRel(sub, e); if (rid) ids.set(e[0], rid); }
        // The part's XML names its relationships by the original ids: keep those ids.
        sub.rels.items = sub.rels.items.map(it => { const orig = [...ids].find(([, v]) => v === it[0])?.[0]; return orig ? [orig, it[1], it[2], it[3]] : it; });
        this.pkg.rels(name, sub.rels);
      }
    }
    return o.rels.add(relType, relative(o.name, name), false);
  }
  /** A new chart part for chart `k` with its data in an embedded workbook (PowerPoint's Edit Data opens it); the relationship id from `o`. */
  chartRel(o, k) {
    this.nCharts += 1;
    const name = `ppt/charts/chart${this.nCharts}.xml`;
    const scheme = this.p.masters?.[0]?.theme?.colors;
    const resolve = ref => resolveColor(ref, scheme);
    this.pkg.xmlPart(name, CT_CHART, chartPartXml(k, resolve, {workbook: true}));
    const embedded = `ppt/embeddings/Microsoft_Excel_Sheet${this.nCharts}.xlsx`;
    const rels = new RelsOut();
    rels.addNew(`${RT_BASE}package`, relative(name, embedded), false);
    this.pkg.rels(name, rels);
    // The workbook is written asynchronously: the package waits for it before it is zipped.
    this.pending.push(writeXlsx(workbookChart(k, resolve).content).then(bytes => this.pkg.binary(embedded, CT_XLSX, bytes)));
    return o.rels.addNew('chart', relative(o.name, name), false);
  }
  tagsRel(o, tags) {
    this.nTags += 1;
    const name = `ppt/tags/tag${this.nTags}.xml`;
    const w = new W();
    rootOpen(w, 'p:tagLst', at());
    for (const [n, v] of tags.slice(0, 10000)) w.empty('p:tag', at().a('name', n).a('val', v));
    w.close('p:tagLst');
    this.pkg.xmlPart(name, CT_TAGS, w.finish());
    return o.rels.addNew('tags', relative(o.name, name), false);
  }
}
const out = name => ({name, rels: new RelsOut()});
function custData(w, x, o, tags) {
  if (!tags?.length) return;
  const id = x.tagsRel(o, tags);
  w.open0('p:custDataLst'); w.empty('p:tags', at().a('r:id', id)); w.close('p:custDataLst');
}
function rootOpen(w, tag, extra) {
  const a = at().a('xmlns:a', NS_A).a('xmlns:r', NS_R).a('xmlns:p', NS_P);
  a.v.push(...extra.v);
  w.open(tag, a);
}
function background(w, x, o, bg) {
  w.open0('p:bg');
  if (bg.kind === 'fill') {
    w.open0('p:bgPr');
    if (bg.fill?.kind === 'background' || bg.fill?.kind === 'group' || !bg.fill) w.empty0('a:noFill'); else fill(w, x, o, bg.fill);
    w.empty0('a:effectLst');
    w.close('p:bgPr');
  } else {
    const idx = (bg.idx >= 1 && bg.idx <= 3) || (bg.idx >= 1001 && bg.idx <= 1003) ? bg.idx : 1001;
    w.open('p:bgRef', at().a('idx', idx)); color(w, bg.color); w.close('p:bgRef');
  }
  w.close('p:bg');
}
function csld(w, x, o, name, bg, list, tags) {
  w.open('p:cSld', at().o('name', name || null));
  if (bg) background(w, x, o, bg);
  w.open0('p:spTree');
  treeHeader(w);
  const ids = new IdMap(list);
  shapes(w, x, o, new Cx(ids), list, 0);
  w.close('p:spTree');
  custData(w, x, o, tags);
  w.close('p:cSld');
  return ids;
}
const CLR_KEYS = [['bg1', 'lt1'], ['tx1', 'dk1'], ['bg2', 'lt2'], ['tx2', 'dk2'], ['accent1', 'accent1'], ['accent2', 'accent2'], ['accent3', 'accent3'],
  ['accent4', 'accent4'], ['accent5', 'accent5'], ['accent6', 'accent6'], ['hlink', 'hlink'], ['folHlink', 'folHlink']];
function clrMapAttrs(map) {
  const a = at();
  for (const [k, d] of CLR_KEYS) {
    const v = (map ?? []).find(([mk]) => mk === k)?.[1];
    a.a(k, v && THEME_SLOTS.includes(slotFromXml(v)) ? v : d);
  }
  return a;
}
const clrMap = (w, map) => w.empty('p:clrMap', clrMapAttrs(map));
function clrMapOvr(w, map) {
  w.open0('p:clrMapOvr');
  if (map) w.empty('a:overrideClrMapping', clrMapAttrs(map)); else w.empty0('a:masterClrMapping');
  w.close('p:clrMapOvr');
}
function extsOf(raw) {
  if (!raw || !raw.trim()) return [];
  try { return parseXml(`<x>${raw}</x>`).root.elements().filter(e => e.is('ext') && e.hasAttr('uri')).map(e => e.toXml()); } catch { return []; }
}
function extList(w, raw) {
  const exts = extsOf(raw);
  if (!exts.length) return;
  w.open0('p:extLst'); for (const e of exts) w.raw(e); w.close('p:extLst');
}
function extChildren(raw) {
  if (!raw) return null;
  try {
    const d = parseXml(raw);
    if (d.root.is('extLst')) { const ns = d.nsDecls(); return d.root.elements().map(e => keepXml(e, ns)).join(''); }
  } catch { /* a run of <ext> elements, not one element */ }
  return raw;
}
function slideExtList(w, raw, commentRel) {
  const exts = extsOf(raw);
  if (commentRel) {
    const e = W.frag();
    e.open('p:ext', at().a('uri', COMMENTS_EXT_URI)); e.empty('p188:commentRel', at().a('xmlns:p188', NS_P188).a('r:id', commentRel)); e.close('p:ext');
    exts.push(e.s);
  }
  if (!exts.length) return;
  w.open0('p:extLst'); for (const e of exts) w.raw(e); w.close('p:extLst');
}
function notesMasterShapes(size) {
  const {width: w, height: h} = size;
  const mk = (id, name, kind, idx, x, y, ww, hh) => ({id: String(id), name, xfrm: {x, y, w: ww, h: hh}, kind: {type: 'shape'}, geom: {kind: 'preset', name: 'rect'},
    ph: {kind, idx, vertical: false, size: kind !== 'slideImage' ? 'quarter' : null, hasCustomPrompt: false}, fill: null, line: null, effects: null, style: null,
    text: kind !== 'slideImage' ? {body: {}, paragraphs: []} : null, hidden: false, locked: false, textBox: false, descr: '', title: '', decorative: false, click: null, hover: null});
  const img = mk(4, 'Slide Image Placeholder 3', 'slideImage', 2, w * 0.125, h * 0.125, w * 0.75, h * 0.375);
  img.fill = {kind: 'none'};
  img.line = {fill: {kind: 'solid', color: {base: {kind: 'rgb', rgb: BLACK}}}, width: 1};
  const body = mk(5, 'Notes Placeholder 4', 'body', 3, w * 0.1, h * 0.53, w * 0.8, h * 0.36);
  body.text.paragraphs = [{level: 0, runs: [{text: 'Click to edit Master text styles'}]}];
  return [mk(2, 'Header Placeholder 1', 'header', 0, 0, 0, w * 0.43, h * 0.05), mk(3, 'Date Placeholder 2', 'date', 1, w * 0.57, 0, w * 0.43, h * 0.05), img, body,
    mk(6, 'Footer Placeholder 5', 'footer', 4, 0, h * 0.95, w * 0.43, h * 0.05), mk(7, 'Slide Number Placeholder 6', 'slideNum', 5, w * 0.57, h * 0.95, w * 0.43, h * 0.05)];
}
function notesStyle() {
  const levels = [];
  for (let i = 0; i < 9; i++) levels.push({para: {marginLeft: 36 * i, align: 'left'}, run: {size: 12, font: '+mn-lt', fill: {kind: 'solid', color: {base: {kind: 'scheme', slot: 'tx1'}}}}});
  return {levels};
}
const notesEmpty = n => (n?.paragraphs ?? []).every(p => !(p.runs ?? []).some(r => r.kind?.kind === 'break' || (r.text ?? '') !== ''));
function notesMasterWrite(p) {
  const nm = p.notesMaster ?? null;
  const kept = nm && (nm.shapes ?? []).length ? nm : null;
  const hasNotes = (p.slides ?? []).some(s => !notesEmpty(s.notes));
  if (!hasNotes && !nm) return null;
  const defaultBg = () => ({kind: 'ref', idx: 1001, color: {base: {kind: 'scheme', slot: 'bg1'}}});
  if (kept) return {shapes: kept.shapes, background: kept.background ?? defaultBg(), colorMap: kept.colorMap ?? [], style: listEmpty(kept.bodyStyle) ? notesStyle() : kept.bodyStyle, theme: kept.theme};
  return {shapes: notesMasterShapes(p.notesSize ?? {width: 540, height: 720}), background: nm?.background ?? defaultBg(), colorMap: nm?.colorMap ?? [], style: notesStyle(), theme: null};
}
function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(T(\d{2}):(\d{2}):(\d{2}).*)?$/.exec(String(s));
  if (!m) return false;
  const mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  if (String(s).length > 10 && !m[4]) return false;
  if (m[4]) return Number(m[5]) <= 23 && Number(m[6]) <= 59 && Number(m[7]) <= 60;
  return true;
}
function sanitized(p) {
  let need = !(p.masters ?? []).length || p.masters.some(m => !(m.layouts ?? []).length);
  need = need || (p.slides ?? []).some(s => !layoutById(p, s.layout));
  if (!need) return p;
  const q = structuredClone(p);
  if (!(q.masters ?? []).length) {
    const [m, next] = buildMaster(q.slideSize ?? {width: 960, height: 540}, defaultTheme(), Math.max(q.nextId ?? 1, 1));
    q.nextId = next;
    q.masters = [m];
  }
  for (const m of q.masters) {
    if ((m.layouts ?? []).length) continue;
    q.nextId = Math.max(q.nextId ?? 1, 1) + 1;
    m.layouts = [{id: String(q.nextId), name: 'Blank', kind: 'blank', shapes: [], background: null, showMasterShapes: true, preserve: false}];
  }
  const first = q.masters[0]?.layouts?.[0]?.id ?? '0';
  const ok = new Set(q.masters.flatMap(m => m.layouts.map(l => l.id)));
  for (const s of q.slides ?? []) if (!ok.has(s.layout)) s.layout = first;
  return q;
}
function layoutXmlOut(x, o, l) {
  const w = new W();
  rootOpen(w, 'p:sldLayout', at().o('showMasterSp', l.showMasterShapes === false ? '0' : null).a('type', layoutXml(l.kind ?? 'custom')).t('preserve', !!l.preserve));
  csld(w, x, o, l.name, l.background, l.shapes ?? [], []);
  clrMapOvr(w, l.colorMap ?? null);
  extList(w, extChildren(l.rawExt));
  w.close('p:sldLayout');
  return w.finish();
}
function masterXmlOut(x, o, m, layouts) {
  const w = new W();
  rootOpen(w, 'p:sldMaster', at().t('preserve', !!m.preserve));
  csld(w, x, o, m.name, m.background, m.shapes ?? [], []);
  clrMap(w, m.colorMap);
  w.open0('p:sldLayoutIdLst');
  for (const [id, rid] of layouts) w.empty('p:sldLayoutId', at().a('id', id).a('r:id', rid));
  w.close('p:sldLayoutIdLst');
  w.open0('p:txStyles');
  const [dt, db, dother] = masterStyles();
  const pick = (s, d) => (listEmpty(s) ? d : s);
  listStyle(w, x, o, 'p:titleStyle', pick(m.titleStyle, dt));
  listStyle(w, x, o, 'p:bodyStyle', pick(m.bodyStyle, db));
  listStyle(w, x, o, 'p:otherStyle', pick(m.otherStyle, dother));
  w.close('p:txStyles');
  extList(w, extChildren(m.rawExt));
  w.close('p:sldMaster');
  return w.finish();
}
function slideXmlOut(x, o, s, commentRel) {
  const w = new W();
  rootOpen(w, 'p:sld', at().o('showMasterSp', s.showMasterShapes === false ? '0' : null).o('show', s.hidden ? '0' : null));
  const ids = csld(w, x, o, s.name, s.background, s.shapes ?? [], s.tags ?? []);
  clrMapOvr(w, s.colorMap ?? null);
  if (s.transition) transitionXml(w, x, o, s.transition);
  if ((s.animations ?? []).length) timing(w, x, s.animations, s.shapes ?? [], ids);
  slideExtList(w, s.rawExt, commentRel);
  w.close('p:sld');
  return w.finish();
}
function notesXmlOut(x, o, notes) {
  const w = new W();
  rootOpen(w, 'p:notes', at());
  const base = {kind: {type: 'shape'}, geom: {kind: 'preset', name: 'rect'}, xfrm: null, fill: null, line: null, effects: null, style: null, hidden: false, locked: false,
    textBox: false, descr: '', title: '', decorative: false, click: null, hover: null};
  const img = {...base, id: '2', name: 'Slide Image Placeholder 1', ph: {kind: 'slideImage', idx: 0, vertical: false, size: null, hasCustomPrompt: false}, text: null};
  const body = {...base, id: '3', name: 'Notes Placeholder 2', ph: {kind: 'body', idx: 1, vertical: false, size: null, hasCustomPrompt: false}, text: {...notes, body: {}}};
  csld(w, x, o, '', null, [img, body], []);
  w.open0('p:clrMapOvr'); w.empty0('a:masterClrMapping'); w.close('p:clrMapOvr');
  w.close('p:notes');
  return w.finish();
}
function authorSlot(c, authors, map) {
  const author = c.author || 'Author';
  if (map.has(author)) return map.get(author);
  const ini = c.initials || [...author].filter(ch => /\p{L}/u.test(ch)).slice(0, 2).join('');
  authors.push([author, ini, 0]);
  map.set(author, authors.length - 1);
  return authors.length - 1;
}
const commentDate = d => (validDate(d) ? d : '2024-01-01T00:00:00.000');
function commentsXml(list, authors, map) {
  const w = new W();
  rootOpen(w, 'p:cmLst', at());
  const flat = [];
  for (const c of list.slice(0, 10000)) { flat.push(c); for (const r of (c.replies ?? []).slice(0, 1000)) flat.push(r); }
  for (const c of flat) {
    const ai = authorSlot(c, authors, map);
    authors[ai][2] += 1;
    w.open('p:cm', at().a('authorId', ai).a('dt', commentDate(c.date)).a('idx', authors[ai][2]));
    const pos = v => (Number.isFinite(v) ? clamp(Math.round(v * 8), 0, 1e9) : 0);
    w.empty('p:pos', at().a('x', pos(c.x)).a('y', pos(c.y)));
    w.elt('p:text', c.text ?? '');
    w.close('p:cm');
  }
  w.close('p:cmLst');
  return w.finish();
}
const authorGuid = name => guid(`deckcraft-comment-author:${name}`);
function txBodyComment(w, text) {
  w.open0('p188:txBody'); w.empty0('a:bodyPr');
  for (const ln of String(text ?? '').split('\n')) { w.open0('a:p'); w.open0('a:r'); w.empty('a:rPr', at().a('lang', 'en-US')); w.elt('a:t', ln); w.close('a:r'); w.close('a:p'); }
  w.close('p188:txBody');
}
function modernCommentsXml(list, part, authors, map) {
  const w = new W();
  w.open('p188:cmLst', at().a('xmlns:p188', NS_P188).a('xmlns:a', NS_A).a('xmlns:r', NS_R));
  list.slice(0, 10000).forEach((c, ti) => {
    const ai = authorSlot(c, authors, map);
    const a = at().a('id', guid(`deckcraft-comment:${part}:${ti}`)).a('authorId', authorGuid(authors[ai][0])).a('created', commentDate(c.date));
    if (c.resolved) a.a('status', 'resolved');
    w.open('p188:cm', a);
    w.empty0('p188:unknownAnchor');
    const e = v => (Number.isFinite(v) ? clamp(Math.round(v * 12700), 0, 1e9) : 0);
    w.empty('p188:pos', at().a('x', e(c.x)).a('y', e(c.y)));
    if ((c.replies ?? []).length) {
      w.open0('p188:replyLst');
      c.replies.slice(0, 1000).forEach((r, ri) => {
        const rai = authorSlot(r, authors, map);
        const ra = at().a('id', guid(`deckcraft-comment:${part}:${ti}:${ri}`)).a('authorId', authorGuid(authors[rai][0])).a('created', commentDate(r.date));
        if (r.resolved) ra.a('status', 'resolved');
        w.open('p188:reply', ra); txBodyComment(w, r.text); w.close('p188:reply');
      });
      w.close('p188:replyLst');
    }
    txBodyComment(w, c.text);
    w.close('p188:cm');
  });
  w.close('p188:cmLst');
  return w.finish();
}
function sectionSlides(p) {
  const out = (p.sections ?? []).map(s => [s.name, []]);
  if (!out.length) return out;
  let cur = 0;
  p.slides.forEach((s, i) => {
    const k = p.sections.findIndex(sec => sec.slides.includes(s.id));
    if (k >= 0 && k >= cur) cur = k;
    out[cur]?.[1].push(i);
  });
  return out;
}
function writeEmbeddedFonts(x, o) {
  const seenPart = new Map();
  let n = 0;
  const rel = id => {
    if (id === null || id === undefined) return null;
    if (seenPart.has(id)) return seenPart.get(id);
    const m = x.media(id);
    if (!m || !m.data) return null;
    const bytes = x.bytes(m);
    if (!bytes.length || bytes.length > 32 * 1024 * 1024) return null;
    n += 1;
    const name = `ppt/fonts/font${n}.fntdata`;
    x.pkg.binary(name, 'application/x-fontdata', bytes);
    const rid = o.rels.add('font', relative('ppt/presentation.xml', name), false);
    seenPart.set(id, rid);
    return rid;
  };
  const seenFace = [], res = [];
  for (const font of (x.p.embeddedFonts ?? []).slice(0, 64)) {
    const tf = String(font.typeface ?? '').trim();
    if (!tf) continue;
    const wf = {typeface: [...tf].slice(0, 255).join(''), panose: font.panose && /^[0-9a-fA-F]{20}$/.test(font.panose) ? font.panose : null,
      pitchFamily: font.pitchFamily ?? null, charset: font.charset ?? null, regular: rel(font.regular), bold: rel(font.bold), italic: rel(font.italic), boldItalic: rel(font.boldItalic)};
    if ((wf.regular || wf.bold || wf.italic || wf.boldItalic) && !seenFace.includes(wf.typeface)) { seenFace.push(wf.typeface); res.push(wf); }
  }
  return res;
}
function presentationXml(x, o, masters, notes, handout, slides) {
  const fonts = writeEmbeddedFonts(x, o);
  const p = x.p;
  const w = new W();
  const first = (p.firstSlideNumber ?? 1) !== 1 ? Math.min(p.firstSlideNumber, 9999) : null;
  rootOpen(w, 'p:presentation', at().a('saveSubsetFonts', 1).t('embedTrueTypeFonts', fonts.length > 0).o('firstSlideNum', first));
  w.open0('p:sldMasterIdLst');
  for (const [id, rid] of masters) w.empty('p:sldMasterId', at().a('id', id).a('r:id', rid));
  w.close('p:sldMasterIdLst');
  if (notes) { w.open0('p:notesMasterIdLst'); w.empty('p:notesMasterId', at().a('r:id', notes)); w.close('p:notesMasterIdLst'); }
  if (handout) { w.open0('p:handoutMasterIdLst'); w.empty('p:handoutMasterId', at().a('r:id', handout)); w.close('p:handoutMasterIdLst'); }
  if (slides.length) { w.open0('p:sldIdLst'); slides.forEach((rid, i) => w.empty('p:sldId', at().a('id', 256 + i).a('r:id', rid))); w.close('p:sldIdLst'); }
  const cl = v => clamp(emu(v), 914400, 51206400);
  const ss = p.slideSize ?? {width: 960, height: 540}, ns = p.notesSize ?? {width: 540, height: 720};
  w.empty('p:sldSz', at().a('cx', cl(ss.width)).a('cy', cl(ss.height)));
  w.empty('p:notesSz', at().a('cx', Math.max(emuPos(ns.width), 1)).a('cy', Math.max(emuPos(ns.height), 1)));
  if (fonts.length) {
    w.open0('p:embeddedFontLst');
    for (const f of fonts) {
      w.open0('p:embeddedFont');
      w.empty('p:font', at().a('typeface', f.typeface).o('panose', f.panose).o('pitchFamily', f.pitchFamily).o('charset', f.charset));
      for (const [tag, rid] of [['p:regular', f.regular], ['p:bold', f.bold], ['p:italic', f.italic], ['p:boldItalic', f.boldItalic]]) if (rid) w.empty(tag, at().a('r:id', rid));
      w.close('p:embeddedFont');
    }
    w.close('p:embeddedFontLst');
  }
  if ((p.customShows ?? []).length) {
    w.open0('p:custShowLst');
    p.customShows.forEach((cs, i) => {
      w.open('p:custShow', at().a('name', cs.name).a('id', i));
      w.open0('p:sldLst');
      for (const sid of cs.slides ?? []) {
        const part = x.slideParts.get(sid);
        if (part) w.empty('p:sld', at().a('r:id', o.rels.add('slide', relative('ppt/presentation.xml', part), false)));
      }
      w.close('p:sldLst');
      w.close('p:custShow');
    });
    w.close('p:custShowLst');
  }
  custData(w, x, o, p.tags ?? []);
  listStyle(w, x, o, 'p:defaultTextStyle', listEmpty(p.defaultTextStyle) ? defaultTextStyle() : p.defaultTextStyle);
  const sections = sectionSlides(p);
  const raw = p.rawExt && p.rawExt.trim() ? p.rawExt : null;
  if (sections.length || raw) {
    const inner = W.frag();
    if (sections.length) {
      inner.open('p:ext', at().a('uri', SECTION_EXT_URI));
      inner.open('p14:sectionLst', at().a('xmlns:p14', NS_P14));
      sections.forEach(([name, list], i) => {
        inner.open('p14:section', at().a('name', name).a('id', guid(`section:${i}:${name}`)));
        inner.open0('p14:sldIdLst'); for (const si of list) inner.empty('p14:sldId', at().a('id', 256 + si)); inner.close('p14:sldIdLst');
        inner.close('p14:section');
      });
      inner.close('p14:sectionLst');
      inner.close('p:ext');
    }
    if (raw) inner.raw(raw);
    extList(w, inner.s);
  }
  w.close('p:presentation');
  return w.finish();
}
function presPropsXml(p) {
  const s = p.show ?? {};
  const w = new W();
  rootOpen(w, 'p:presentationPr', at());
  w.open('p:showPr', at().t('loop', !!s.loopUntilEsc).a('showNarration', s.withoutNarration ? 0 : 1).o('showAnimation', s.withoutAnimation ? '0' : null).o('useTimings', s.useTimings === false ? '0' : null));
  if (s.showType === 'browsed') w.empty('p:browse', at()); else if (s.showType === 'kiosk') w.empty('p:kiosk', at()); else w.empty0('p:present');
  const custom = s.customShow ? (p.customShows ?? []).findIndex(c => c.name === s.customShow) : -1;
  if (custom >= 0) w.empty('p:custShow', at().a('id', custom));
  else if (s.range) { const [a, b] = s.range; w.empty('p:sldRg', at().a('st', Math.max(a, 1)).a('end', Math.max(b, a, 1))); }
  else w.empty0('p:sldAll');
  w.open0('p:penClr'); w.val('a:srgbClr', hex(s.penColor ?? {r: 255, g: 0, b: 0, a: 255})); w.close('p:penClr');
  // The laser pointer colour is PowerPoint 2010's extension of the show properties.
  w.open0('p:extLst'); w.open('p:ext', at().a('uri', '{EC167BDD-8182-4AB7-AECC-EB403E3ABB37}'));
  w.open('p14:laserClr', at().a('xmlns:p14', NS_P14)); w.val('a:srgbClr', hex(s.laserColor ?? {r: 255, g: 0, b: 0, a: 255})); w.close('p14:laserClr');
  w.close('p:ext'); w.close('p:extLst');
  w.close('p:showPr');
  w.close('p:presentationPr');
  return w.finish();
}
function viewPropsXml(p) {
  const w = new W();
  rootOpen(w, 'p:viewPr', at());
  w.open0('p:normalViewPr'); w.empty('p:restoredLeft', at().a('sz', 15620)); w.empty('p:restoredTop', at().a('sz', 94660)); w.close('p:normalViewPr');
  if ((p.guides ?? []).length) {
    w.open0('p:slideViewPr'); w.open0('p:cSldViewPr'); w.open0('p:cViewPr');
    w.open0('p:scale'); w.empty('a:sx', at().a('n', 100).a('d', 100)); w.empty('a:sy', at().a('n', 100).a('d', 100)); w.close('p:scale');
    w.empty('p:origin', at().a('x', 0).a('y', 0));
    w.close('p:cViewPr');
    w.open0('p:guideLst');
    for (const g of p.guides.slice(0, 1000)) {
      const pos = clamp(Math.round(g.pos * 8), -1e9, 1e9);
      w.empty('p:guide', g.vertical ? at().a('pos', pos) : at().a('orient', 'horz').a('pos', pos));
    }
    w.close('p:guideLst');
    w.close('p:cSldViewPr'); w.close('p:slideViewPr');
  }
  w.empty('p:gridSpacing', at().a('cx', 76200).a('cy', 76200));
  w.close('p:viewPr');
  return w.finish();
}
function coreXml(p) {
  const pr = p.props ?? {};
  const w = new W();
  w.open('cp:coreProperties', at().a('xmlns:cp', 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties').a('xmlns:dc', 'http://purl.org/dc/elements/1.1/')
    .a('xmlns:dcterms', 'http://purl.org/dc/terms/').a('xmlns:dcmitype', 'http://purl.org/dc/dcmitype/').a('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance'));
  for (const [tag, v] of [['dc:title', pr.title], ['dc:subject', pr.subject], ['dc:creator', pr.author], ['cp:keywords', pr.keywords], ['dc:description', pr.comments],
    ['cp:category', pr.category], ['cp:lastModifiedBy', pr.lastModifiedBy]]) if (v) w.elt(tag, v);
  if ((pr.revision ?? 0) > 0) w.elt('cp:revision', String(pr.revision));
  for (const [tag, v] of [['dcterms:created', pr.created], ['dcterms:modified', pr.modified]]) {
    if (validDate(v)) { w.open(tag, at().a('xsi:type', 'dcterms:W3CDTF')); w.text(v); w.close(tag); }
  }
  w.close('cp:coreProperties');
  return w.finish();
}
function appXml(p) {
  const w = new W();
  w.open('Properties', at().a('xmlns', 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties').a('xmlns:vt', 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'));
  w.elt('Application', 'Arkemis Prism');
  w.elt('Slides', String(p.slides.length));
  w.elt('Notes', String(p.slides.filter(s => !notesEmpty(s.notes)).length));
  w.elt('HiddenSlides', String(p.slides.filter(s => s.hidden).length));
  if (p.props?.company) w.elt('Company', p.props.company);
  w.close('Properties');
  return w.finish();
}

/** Write a package for the presentation; `mainCt` picks .pptx / .potx / .ppsx. Returns `{bytes, warnings}`. */
export async function exportPptxChecked(pres, mainCt = CT_PRES) {
  const p = sanitized(pres);
  const x = new Exp(p);
  p.slides.forEach((s, i) => x.slideParts.set(s.id, `ppt/slides/slide${i + 1}.xml`));
  const presO = out('ppt/presentation.xml');
  const masterRids = [];
  const layoutParts = new Map();
  let nLayout = 0;
  let bigId = 2147483648;
  p.masters.forEach((m, mi) => {
    const mname = `ppt/slideMasters/slideMaster${mi + 1}.xml`;
    const tname = `ppt/theme/theme${mi + 1}.xml`;
    const mo = out(mname);
    const lrids = [];
    for (const l of m.layouts) {
      nLayout += 1;
      const lname = `ppt/slideLayouts/slideLayout${nLayout}.xml`;
      layoutParts.set(l.id, lname);
      lrids.push(mo.rels.add('slideLayout', relative(mname, lname), false));
      const lo = out(lname);
      lo.rels.add('slideMaster', relative(lname, mname), false);
      x.pkg.xmlPart(lname, CT_LAYOUT, layoutXmlOut(x, lo, l));
      x.pkg.rels(lname, lo.rels);
    }
    mo.rels.add('theme', relative(mname, tname), false);
    const to = out(tname);
    x.pkg.xmlPart(tname, CT_THEME, themeXml(x, to, m.theme ?? defaultTheme()));
    x.pkg.rels(tname, to.rels);
    const masterId = bigId++;
    const layoutIds = lrids.map(rid => [bigId++, rid]);
    x.pkg.xmlPart(mname, CT_MASTER, masterXmlOut(x, mo, m, layoutIds));
    x.pkg.rels(mname, mo.rels);
    masterRids.push([masterId, presO.rels.add('slideMaster', relative('ppt/presentation.xml', mname), false)]);
  });
  const notesMaster = 'ppt/notesMasters/notesMaster1.xml';
  let notesMasterRid = null;
  const nm = notesMasterWrite(p);
  if (nm) {
    const tname = `ppt/theme/theme${p.masters.length + 1}.xml`;
    const no = out(notesMaster);
    no.rels.add('theme', relative(notesMaster, tname), false);
    const theme = nm.theme ?? p.masters[0]?.theme ?? defaultTheme();
    const to = out(tname);
    x.pkg.xmlPart(tname, CT_THEME, themeXml(x, to, theme));
    x.pkg.rels(tname, to.rels);
    const w = new W();
    rootOpen(w, 'p:notesMaster', at());
    csld(w, x, no, '', nm.background, nm.shapes, []);
    clrMap(w, nm.colorMap);
    listStyle(w, x, no, 'p:notesStyle', nm.style);
    w.close('p:notesMaster');
    x.pkg.xmlPart(notesMaster, CT_NOTES_MASTER, w.finish());
    x.pkg.rels(notesMaster, no.rels);
    notesMasterRid = presO.rels.add('notesMaster', relative('ppt/presentation.xml', notesMaster), false);
  }
  const handoutPath = 'ppt/handoutMasters/handoutMaster1.xml';
  let handoutRid = null;
  const hm = p.handoutMaster;
  if (hm) {
    const tname = `ppt/theme/theme${p.masters.length + 1 + (notesMasterRid ? 1 : 0)}.xml`;
    const ho = out(handoutPath);
    ho.rels.add('theme', relative(handoutPath, tname), false);
    const to = out(tname);
    x.pkg.xmlPart(tname, CT_THEME, themeXml(x, to, hm.theme ?? defaultTheme()));
    x.pkg.rels(tname, to.rels);
    const w = new W();
    rootOpen(w, 'p:handoutMaster', at());
    csld(w, x, ho, hm.name, hm.background, hm.shapes ?? [], []);
    clrMap(w, hm.colorMap);
    w.close('p:handoutMaster');
    x.pkg.xmlPart(handoutPath, CT_HANDOUT_MASTER, w.finish());
    x.pkg.rels(handoutPath, ho.rels);
    handoutRid = presO.rels.add('handoutMaster', relative('ppt/presentation.xml', handoutPath), false);
  }
  const authors = [], authorMap = new Map();
  let nComments = 0;
  const slideRids = [];
  p.slides.forEach((s, i) => {
    const sname = `ppt/slides/slide${i + 1}.xml`;
    const so = out(sname);
    const lp = layoutParts.get(s.layout);
    if (lp) so.rels.add('slideLayout', relative(sname, lp), false);
    if (!notesEmpty(s.notes)) {
      const nname = `ppt/notesSlides/notesSlide${i + 1}.xml`;
      so.rels.add('notesSlide', relative(sname, nname), false);
      const no = out(nname);
      no.rels.add('notesMaster', relative(nname, notesMaster), false);
      no.rels.add('slide', relative(nname, sname), false);
      x.pkg.xmlPart(nname, CT_NOTES, notesXmlOut(x, no, s.notes));
      x.pkg.rels(nname, no.rels);
    }
    let commentRel = null;
    if ((s.comments ?? []).length) {
      nComments += 1;
      const cname = `ppt/comments/comment${nComments}.xml`;
      so.rels.add('comments', relative(sname, cname), false);
      x.pkg.xmlPart(cname, CT_COMMENTS, commentsXml(s.comments, authors, authorMap));
      const mname = `ppt/comments/modernComment${nComments}.xml`;
      commentRel = so.rels.add(RT_COMMENTS_MODERN, relative(sname, mname), false);
      x.pkg.xmlPart(mname, CT_COMMENTS_MODERN, modernCommentsXml(s.comments, cname, authors, authorMap));
    }
    x.pkg.xmlPart(sname, CT_SLIDE, slideXmlOut(x, so, s, commentRel));
    x.pkg.rels(sname, so.rels);
    slideRids.push(presO.rels.add('slide', relative('ppt/presentation.xml', sname), false));
  });
  if (authors.length) {
    const w = new W();
    rootOpen(w, 'p:cmAuthorLst', at());
    authors.forEach(([n, ini, last], i) => w.empty('p:cmAuthor', at().a('id', i).a('name', n).a('initials', ini).a('lastIdx', last).a('clrIdx', i % 8)));
    w.close('p:cmAuthorLst');
    x.pkg.xmlPart('ppt/commentAuthors.xml', CT_AUTHORS, w.finish());
    presO.rels.add('commentAuthors', 'commentAuthors.xml', false);
    const w2 = new W();
    w2.open('p188:authorLst', at().a('xmlns:p188', NS_P188));
    for (const [n, ini] of authors) w2.empty('p188:author', at().a('id', authorGuid(n)).a('name', n).a('initials', ini).a('userId', '').a('providerId', 'None'));
    w2.close('p188:authorLst');
    x.pkg.xmlPart('ppt/authors.xml', CT_AUTHORS_MODERN, w2.finish());
    presO.rels.add(RT_AUTHORS_MODERN, 'authors.xml', false);
  }
  presO.rels.add('theme', 'theme/theme1.xml', false);
  presO.rels.add('presProps', 'presProps.xml', false);
  presO.rels.add('viewProps', 'viewProps.xml', false);
  presO.rels.add('tableStyles', 'tableStyles.xml', false);
  x.pkg.xmlPart('ppt/presProps.xml', CT_PRES_PROPS, presPropsXml(p));
  x.pkg.xmlPart('ppt/viewProps.xml', CT_VIEW_PROPS, viewPropsXml(p));
  x.pkg.xmlPart('ppt/tableStyles.xml', CT_TABLE_STYLES, tableStylesXml(x.tableStyles, p.tableStyles ?? []));
  x.pkg.xmlPart('ppt/presentation.xml', mainCt, presentationXml(x, presO, masterRids, notesMasterRid, handoutRid, slideRids));
  const kept = (p.keptParts ?? []).filter(k => {
    const n = String(k.name ?? '').toLowerCase();
    return n && !n.includes('..') && !n.startsWith('ppt/') && !n.startsWith('docprops/core') && !n.startsWith('docprops/app') && !n.startsWith('[content_types]') && n !== '_rels/.rels';
  });
  for (const k of kept.filter(k => k.relType && !k.fromRoot)) presO.rels.addNew(k.relType, relative('ppt/presentation.xml', k.name), false);
  x.pkg.rels('ppt/presentation.xml', presO.rels);
  for (const k of kept) { if (!k.contentType) x.pkg.raw(k.name, k.xml); else x.pkg.xmlPart(k.name, k.contentType, k.xml); }
  x.pkg.xmlPart('docProps/core.xml', CT_CORE, coreXml(p));
  x.pkg.xmlPart('docProps/app.xml', CT_APP, appXml(p));
  const root = new RelsOut();
  root.add('officeDocument', 'ppt/presentation.xml', false);
  root.add(RT_CORE, 'docProps/core.xml', false);
  root.add('extended-properties', 'docProps/app.xml', false);
  for (const k of kept.filter(k => k.relType && k.fromRoot)) root.addNew(k.relType, k.name, false);
  x.pkg.rels('', root);
  await Promise.all(x.pending);
  return {bytes: await x.pkg.finish(), warnings: x.warnings};
}
/** deckcraft `export`. */
export async function exportPptx(pres) { return (await exportPptxChecked(pres, CT_PRES)).bytes; }
/** deckcraft `export_as`: `potx` (template) and `ppsx` (slide show) differ only in the main part's content type. */
export async function exportAs(pres, ext) {
  const ct = ext === 'potx' ? CT_TEMPLATE : ext === 'ppsx' ? CT_SHOW : CT_PRES;
  return (await exportPptxChecked(pres, ct)).bytes;
}

/** Format-worker entry (electron/formats-v2.cjs): a schema-2 Prism file → .pptx bytes. */
export async function write(file) {
  const content = file?.content ?? file;
  if (!content || !Array.isArray(content.slides)) throw new PptxError('Write', 'write failed: not a presentation');
  return exportPptx(content);
}

export {W, A, RelsOut, PackageOut, IdMap, El};
