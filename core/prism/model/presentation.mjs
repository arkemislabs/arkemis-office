// The DeckCraft document model: a Presentation has slide masters (each with a theme and
// layouts) and slides. Each slide uses a layout; placeholders on a slide inherit position,
// formatting and text styles from the matching placeholder on its layout and master (resolve.mjs).
// Translated from deckcraft crates/model/src/lib.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// Representation (Prism schema 2): the deckcraft serde JSON (camelCase field names, internally
// tagged enums: `kind`/`type` tags) with one deliberate difference: object ids (slides, shapes,
// layouts, masters, media) are strings. New ids are allocated from `nextId` exactly as deckcraft's
// `alloc_id` does (so a new deck reads "257", "258"...), while documents migrated from schema 1
// keep their existing ids, so `/sl:<id>` addresses and anchors survive the migration.

import {isLineLike} from './geom/preset/catalog.mjs';
import {schemeGet, schemeSet, slotFromXml} from './color.mjs';

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** deckcraft `cmd::NO_ID_SPACE`: the message a command gives when the deck cannot grow. */
export const NO_ID_SPACE = 'the presentation has run out of object ids';

/** Placeholder types (PhType) with their XML names. */
export const PH_TYPES = Object.freeze(['title', 'ctrTitle', 'subTitle', 'body', 'obj', 'chart', 'table', 'clipArt', 'diagram', 'media', 'picture',
  'date', 'footer', 'slideNum', 'header', 'slideImage']);
const PH_XML = {title: 'title', ctrTitle: 'ctrTitle', subTitle: 'subTitle', body: 'body', obj: 'obj', chart: 'chart', table: 'tbl', clipArt: 'clipArt',
  diagram: 'dgm', media: 'media', picture: 'pic', date: 'dt', footer: 'ftr', slideNum: 'sldNum', header: 'hdr', slideImage: 'sldImg'};
export const phXml = k => PH_XML[k] ?? 'body';
export const phFromXml = s => Object.entries(PH_XML).find(([, v]) => v === s)?.[0] ?? 'body';
export const isTitlePh = k => k === 'title' || k === 'ctrTitle';
/** The prompt shown in an empty placeholder in Normal view. */
export function phPrompt(k) {
  switch (k) {
    case 'title': case 'ctrTitle': return 'Click to add title';
    case 'subTitle': return 'Click to add subtitle';
    case 'body': case 'obj': return 'Click to add text';
    case 'chart': return 'Click icon to add chart';
    case 'table': return 'Click icon to add table';
    case 'diagram': return 'Click icon to add SmartArt graphic';
    case 'media': return 'Click icon to add media';
    case 'picture': case 'clipArt': return 'Click icon to add picture';
    case 'date': return 'Date';
    case 'footer': return 'Footer';
    case 'slideNum': return '‹#›';
    case 'header': return 'Header';
    default: return '';
  }
}
/** Footer-row placeholders are not shown on slides unless the deck turns them on. */
export const isFooterPh = k => k === 'date' || k === 'footer' || k === 'slideNum' || k === 'header';

/** Layout types with their XML names. */
export const LAYOUT_TYPES = Object.freeze(['title', 'titleAndContent', 'sectionHeader', 'twoContent', 'comparison', 'titleOnly', 'blank',
  'contentWithCaption', 'pictureWithCaption', 'titleAndVerticalText', 'verticalTitleAndText', 'custom']);
const LAYOUT_XML = {title: 'title', titleAndContent: 'obj', sectionHeader: 'secHead', twoContent: 'twoObj', comparison: 'twoTxTwoObj', titleOnly: 'titleOnly',
  blank: 'blank', contentWithCaption: 'objTx', pictureWithCaption: 'picTx', titleAndVerticalText: 'vertTx', verticalTitleAndText: 'vertTitleAndTx', custom: 'cust'};
export const layoutXml = k => LAYOUT_XML[k] ?? 'cust';
export function layoutFromXml(s) {
  if (s === 'tx') return 'titleAndContent';
  if (s === 'twoColTx') return 'twoContent';
  return Object.entries(LAYOUT_XML).find(([, v]) => v === s)?.[0] ?? 'custom';
}

export const SHAPE_KINDS = Object.freeze(['shape', 'picture', 'group', 'connector', 'table', 'chart', 'media', 'ink', 'model3d', 'opaque']);

/** Shape geometry default: `{kind:'preset', name:'rect'}`. */
export const presetGeom = (name, adj) => (adj && adj.length ? {kind: 'preset', name, adj: [...adj]} : {kind: 'preset', name});
export const presetName = geom => (geom?.kind === 'custom' ? null : geom?.name ?? 'rect');

/** True when every sample is the placeholder 0.5 written before a device reported pressure. */
export const inkPressureIsLegacy = points => points.length > 0 && points.every(p => Math.abs(p[2] - 0.5) <= 1e-3);
/** Width of one ink sample (a light touch stays visible: at least 8% of the pen). */
export function inkSampleWidth(pen, pressure, legacy) {
  const w = Number.isFinite(pen) ? Math.abs(pen) : 0;
  if (legacy) return w;
  const p = Number.isFinite(pressure) ? Math.min(Math.max(pressure, 0.08), 1) : 1;
  return w * p;
}

// ---------------------------------------------------------------------------------------------
// Shapes

/** deckcraft `Shape::default()` with the given fields. */
export function shape(fields = {}) {
  return {id: '0', name: '', xfrm: null, kind: {type: 'shape'}, geom: presetGeom('rect'), ph: null, fill: null, line: null, effects: null, style: null,
    text: null, hidden: false, locked: false, textBox: false, descr: '', title: '', decorative: false, click: null, hover: null, ...fields};
}
export const isPlaceholder = sh => !!sh?.ph;
export const phType = sh => sh?.ph?.kind ?? null;
export const isGroup = sh => sh?.kind?.type === 'group';
export const childrenOf = sh => (sh?.kind?.type === 'group' ? sh.kind.children ?? [] : []);
/** Is this a line-like shape (no area)? */
export const isLine = sh => sh?.kind?.type === 'connector' || (presetName(sh?.geom) !== null && sh?.geom?.kind !== 'custom' && isLineLike(presetName(sh.geom)));
export function kindName(sh) {
  switch (sh?.kind?.type) {
    case 'shape': return sh.ph ? 'placeholder' : sh.textBox ? 'textBox' : 'shape';
    case 'media': return sh.kind.video ? 'video' : 'audio';
    case 'model3d': return 'model';
    case 'opaque': return 'object';
    default: return sh?.kind?.type ?? 'shape';
  }
}

/** Walk shapes depth-first (groups included): `f(shape, depth, parentGroup)`. */
export function walk(shapes, f) {
  const rec = (list, depth, parent) => {
    if (depth > 64) return;
    for (const s of list ?? []) { f(s, depth, parent); rec(childrenOf(s), depth + 1, s); }
  };
  rec(shapes, 0, null);
}
export function findShape(shapes, id) {
  let found = null;
  const rec = (list, depth) => {
    if (depth > 64 || found) return;
    for (const s of list ?? []) {
      if (s.id === id) { found = s; return; }
      rec(childrenOf(s), depth + 1);
      if (found) return;
    }
  };
  rec(shapes, 0);
  return found;
}
/**
 * The JSON path of shape `id` inside `shapes` (relative to the list): `[i]` for a top-level shape,
 * `[i, 'kind', 'children', j, ...]` inside groups. null when absent.
 */
export function shapePath(shapes, id) {
  const rec = (list, depth) => {
    if (depth > 64) return null;
    for (let i = 0; i < (list ?? []).length; i++) {
      const s = list[i];
      if (s.id === id) return [i];
      if (isGroup(s)) {
        const sub = rec(s.kind.children, depth + 1);
        if (sub) return [i, 'kind', 'children', ...sub];
      }
    }
    return null;
  };
  return rec(shapes, 0);
}
/** The group directly holding `id`: `null` for a top-level shape, `undefined` when absent. */
export function parentOf(shapes, id) {
  const rec = (list, parent, depth) => {
    if (depth > 64) return undefined;
    for (const s of list ?? []) {
      if (s.id === id) return parent;
      const f = rec(childrenOf(s), s.id, depth + 1);
      if (f !== undefined) return f;
    }
    return undefined;
  };
  return rec(shapes, null, 0);
}

// ---------------------------------------------------------------------------------------------
// Slides, layouts, masters

/** deckcraft `Slide::default()` with the given fields. */
export function slide(fields = {}) {
  return {id: '0', layout: '0', name: '', shapes: [], background: null, hidden: false, showMasterShapes: true, transition: null, animations: [],
    notes: {body: {}, paragraphs: []}, comments: [], ...fields};
}
const bodyText = t => (t?.paragraphs ?? []).map(p => (p.runs ?? []).map(r => (r.kind?.kind === 'break' ? '\u000b' : r.text ?? '')).join('')).join('\n');
/** The slide's title text (first title placeholder), for thumbnails, outline and navigation. */
export function slideTitle(sl) {
  const t = (sl?.shapes ?? []).find(s => isTitlePh(phType(s)));
  return t?.text ? bodyText(t.text).replace(/\u000b/g, ' ') : '';
}
export const notesText = sl => bodyText(sl?.notes);
export const layoutOf = (master, id) => (master?.layouts ?? []).find(l => l.id === id) ?? null;

const DEFAULT_MAP = {bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2'};
/** Resolve bg1/tx1/bg2/tx2 through the colour map (an array of [alias, slot] pairs; default mapping when absent). */
export function mapSlot(map, slot) {
  if (!(slot in DEFAULT_MAP)) return slot;
  const hit = (map ?? []).find(([k]) => k === slot);
  return (hit && slotFromXml(hit[1])) || DEFAULT_MAP[slot];
}
/** The theme's colour scheme with `map` applied (bg1... resolve to mapped colours). */
export function schemeWith(master, map) {
  let s = master.theme.colors;
  if (!map || !map.length) return s;
  const base = master.theme.colors;
  for (const [alias, slot] of [['bg1', 'lt1'], ['tx1', 'dk1'], ['bg2', 'lt2'], ['tx2', 'dk2']]) s = schemeSet(s, slot, schemeGet(base, mapSlot(map, alias)));
  return s;
}
export const masterScheme = master => schemeWith(master, master.colorMap);

// ---------------------------------------------------------------------------------------------
// Presentation

/** A fresh id (deckcraft `alloc_id`): returns `[id, nextId]`, or null once every id is used. */
export function allocId(pres) {
  const next = Math.max(pres.nextId ?? 0, 1) + 1;
  if (!Number.isSafeInteger(next) || next > 0xffffffff) return null;
  return [String(next), next];
}
/** `next_id` above every numeric id in use (after loading a file). */
export function fixNextId(pres) {
  let m = pres.nextId ?? 0;
  const see = id => { const n = /^\d+$/.test(String(id)) ? Number(id) : 0; if (n > m) m = n; };
  for (const s of pres.slides ?? []) { see(s.id); walk(s.shapes, sh => see(sh.id)); }
  for (const ma of pres.masters ?? []) {
    see(ma.id); walk(ma.shapes, sh => see(sh.id));
    for (const l of ma.layouts ?? []) { see(l.id); walk(l.shapes, sh => see(sh.id)); }
  }
  for (const md of pres.media ?? []) see(md.id);
  for (const extra of [pres.notesMaster, pres.handoutMaster]) if (extra) { see(extra.id); walk(extra.shapes, sh => see(sh.id)); }
  return m;
}
export const slideIndex = (pres, id) => (pres.slides ?? []).findIndex(s => s.id === id);
export const slideById = (pres, id) => (pres.slides ?? []).find(s => s.id === id) ?? null;

// ---------------------------------------------------------------------------------------------
// Master views edit a master, a layout, the handout or the notes master as if it were a slide: a
// "virtual slide" whose shapes are that object's own, so selecting, moving, formatting and typing use
// the slide code unchanged. Ids: vm-<master>, vl-<master>-<layout>, vh (handout), vn (notes); its
// layout is the synthetic ~<id> (the master's graphics behind it, or none for the master itself).
const VID = /^v([mlhn])(?:-(\d+))?(?:-(\d+))?$/;
export const virtualSlideId = (kind, mi = 0, li = null) => (kind === 'handout' ? 'vh' : kind === 'notes' ? 'vn' : li === null || li === undefined ? `vm-${mi}` : `vl-${mi}-${li}`);
/** Where a virtual slide id points: {kind: 'master' | 'layout' | 'handout' | 'notes', mi, li, node, master, path (to the object holding shapes)}, or null. */
export function virtualTarget(pres, id) {
  const m = typeof id === 'string' ? VID.exec(String(id).replace(/^~/, '')) : null;
  if (!m) return null;
  const mi = Number(m[2] ?? 0), li = m[3] === undefined ? null : Number(m[3]);
  if (m[1] === 'h') return pres.handoutMaster ? {kind: 'handout', mi: 0, li: null, node: pres.handoutMaster, master: pres.handoutMaster, path: ['handoutMaster']} : null;
  if (m[1] === 'n') return pres.notesMaster ? {kind: 'notes', mi: 0, li: null, node: pres.notesMaster, master: pres.notesMaster, path: ['notesMaster']} : null;
  const master = pres.masters?.[mi];
  if (!master) return null;
  if (m[1] === 'm') return {kind: 'master', mi, li: null, node: master, master, path: ['masters', mi]};
  const layout = master.layouts?.[li ?? -1];
  return layout ? {kind: 'layout', mi, li, node: layout, master, path: ['masters', mi, 'layouts', li]} : null;
}
export const isVirtualSlideId = id => typeof id === 'string' && VID.test(id);
/** The virtual slide for id (see above), or null. Its shapes are the object's own list. */
export function virtualSlide(pres, id) {
  const t = virtualTarget(pres, id);
  if (!t) return null;
  const isMaster = t.kind !== 'layout';
  return {id, layout: `~${id}`, name: '', shapes: t.node.shapes ?? [], background: null, hidden: false, showMasterShapes: !isMaster, transition: null, animations: [],
    notes: {body: {}, paragraphs: []}, comments: [], virtual: t.kind,
    ...(t.kind === 'handout' || t.kind === 'notes' ? {size: pres.notesSize ?? {width: 540, height: 720}} : {})};
}
/** The synthetic layout of a virtual slide: no shapes of its own; a layout's background and graphics switch carry over. */
function virtualLayout(pres, id) {
  const t = virtualTarget(pres, id);
  if (!t) return null;
  const real = t.kind === 'layout' ? t.node : null;
  return [t.master, {id: `~${String(id).replace(/^~/, '')}`, name: real?.name ?? '', kind: 'custom', shapes: [], background: real?.background ?? null, showMasterShapes: real ? real.showMasterShapes !== false : true, preserve: false}];
}
/** Master and layout for a layout id: [master, layout] or null. */
export function layoutById(pres, id) {
  if (typeof id === 'string' && id.startsWith('~v')) return virtualLayout(pres, id);
  for (const m of pres.masters ?? []) { const l = layoutOf(m, id); if (l) return [m, l]; }
  return null;
}
/** The master (and layout) a slide uses, falling back to the first. */
export function masterFor(pres, sl) {
  const hit = layoutById(pres, sl?.layout);
  if (hit) return hit;
  const m = pres.masters?.[0];
  return m ? [m, m.layouts?.[0] ?? null] : null;
}
export const mediaById = (pres, id) => (pres.media ?? []).find(m => m.id === id) ?? null;
/** Section index containing a slide, when sections exist (-1 otherwise). */
export const sectionOf = (pres, slideId) => (pres.sections ?? []).findIndex(s => s.slides.includes(slideId));
/** 1-based slide number as displayed (respects firstSlideNumber). */
export const slideNumber = (pres, index) => (pres.firstSlideNumber ?? 1) + index;
/** Basic consistency check: unique slide/shape ids, layouts exist. Returns problems found. */
export function validatePresentation(pres) {
  const out = [];
  const seen = new Set();
  for (const s of pres.slides ?? []) {
    if (seen.has(s.id)) out.push(`duplicate slide id ${s.id}`);
    seen.add(s.id);
    if (!layoutById(pres, s.layout)) out.push(`slide ${s.id} uses missing layout ${s.layout}`);
    const ids = new Set();
    walk(s.shapes, sh => { if (ids.has(sh.id)) out.push(`slide ${s.id}: duplicate shape id ${sh.id}`); ids.add(sh.id); });
  }
  return out;
}

/** deckcraft `ShowSettings::default()`. */
export const defaultShowSettings = () => ({showType: 'speaker', loopUntilEsc: false, withoutNarration: false, withoutAnimation: false, useTimings: true,
  range: null, customShow: null, penColor: {r: 255, g: 0, b: 0, a: 255}, laserColor: {r: 255, g: 0, b: 0, a: 255}, showMediaControls: true});
export const defaultHeaderFooter = () => ({date: false, slideNumber: false, footer: false, header: false, footerText: '', dateText: '', dateFormat: '', hideOnTitle: false});
export const defaultProperties = () => ({title: '', subject: '', author: '', keywords: '', comments: '', category: '', company: '', created: '', modified: '',
  lastModifiedBy: '', revision: 0});
