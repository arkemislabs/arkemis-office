// Prism schema 2: the content model is a deckcraft Presentation (core/prism/model). This module
// creates and validates content for core/model.mjs (createFile/validateFile with schema 2) and the
// format worker. Foundation-owned (F:prism). No DOM, no Node built-ins.
// Upstream: deckcraft crates/model/src/lib.rs (Presentation::validate, fix_next_id) and
// crates/model/src/defaults.rs (new_presentation) at f893f6af7d36a5409fd804e81a34fd895cfefedf.

import {newPresentation} from './model/defaults.mjs';
import {validatePresentation, fixNextId, walk, ID_RE, SHAPE_KINDS, PH_TYPES, LAYOUT_TYPES} from './model/presentation.mjs';

export const SCHEMA_VERSION = 2;
export const MAX_SLIDES = 5000;
export const MAX_SHAPES_PER_SLIDE = 5000;

/** New content for a new presentation (deckcraft `Presentation::default()`), titled `title`. */
export function createContent(title) {
  const p = newPresentation();
  if (title) p.props = {...p.props, title: String(title).slice(0, 240)};
  return p;
}

const bad = m => { throw new Error(`Invalid presentation: ${m}`); };
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = v => typeof v === 'number' && Number.isFinite(v);

function checkXfrm(x, where) {
  if (x === null || x === undefined) return;
  if (!isObj(x) || !['x', 'y', 'w', 'h'].every(k => finite(x[k]))) bad(`${where}: xfrm needs finite x, y, w, h`);
  if (x.w < 0 || x.h < 0) bad(`${where}: negative size`);
  if (x.rot !== undefined && !finite(x.rot)) bad(`${where}: rot`);
  for (const k of ['flipH', 'flipV']) if (x[k] !== undefined && typeof x[k] !== 'boolean') bad(`${where}: ${k}`);
}

function checkBody(t, where) {
  if (t === null || t === undefined) return;
  if (!isObj(t) || !Array.isArray(t.paragraphs)) bad(`${where}: text body needs paragraphs`);
  for (const p of t.paragraphs) {
    if (!isObj(p) || !Array.isArray(p.runs ?? [])) bad(`${where}: paragraph`);
    if (p.level !== undefined && !(Number.isInteger(p.level) && p.level >= 0 && p.level <= 8)) bad(`${where}: paragraph level`);
    for (const r of p.runs ?? []) if (!isObj(r) || (r.text !== undefined && typeof r.text !== 'string')) bad(`${where}: run`);
  }
}

function checkShapes(list, where, ids) {
  if (!Array.isArray(list)) bad(`${where}: shapes`);
  if (list.length > MAX_SHAPES_PER_SLIDE) bad(`${where}: more than ${MAX_SHAPES_PER_SLIDE} shapes`);
  walk(list, (sh, depth) => {
    const w = `${where} shape ${sh?.id}`;
    if (!isObj(sh) || typeof sh.id !== 'string' || !ID_RE.test(sh.id)) bad(`${where}: shape id`);
    if (ids.has(sh.id)) bad(`${w}: duplicate id`);
    ids.add(sh.id);
    if (!isObj(sh.kind) || !SHAPE_KINDS.includes(sh.kind.type)) bad(`${w}: kind`);
    if (sh.kind.type === 'group' && !Array.isArray(sh.kind.children)) bad(`${w}: group children`);
    if (sh.kind.type === 'table' && (!Array.isArray(sh.kind.rows) || !Array.isArray(sh.kind.cols))) bad(`${w}: table rows/cols`);
    if (sh.geom !== undefined && sh.geom !== null && !(isObj(sh.geom) && ((sh.geom.kind === 'preset' && typeof sh.geom.name === 'string') || (sh.geom.kind === 'custom' && Array.isArray(sh.geom.paths))))) bad(`${w}: geom`);
    if (sh.ph !== null && sh.ph !== undefined && !(isObj(sh.ph) && PH_TYPES.includes(sh.ph.kind))) bad(`${w}: placeholder`);
    checkXfrm(sh.xfrm, w);
    checkBody(sh.text, w);
    if (depth > 64) bad(`${w}: groups nest too deeply`);
  });
}

/** Throws when `c` is not a valid schema-2 presentation. */
export function validateContent(c) {
  if (!isObj(c)) bad('content');
  if (!isObj(c.slideSize) || !finite(c.slideSize.width) || !finite(c.slideSize.height) || c.slideSize.width <= 0 || c.slideSize.height <= 0) bad('slide size');
  if (!Array.isArray(c.slides) || c.slides.length > MAX_SLIDES) bad(`slides (at most ${MAX_SLIDES})`);
  if (!Array.isArray(c.masters) || !c.masters.length) bad('masters');
  if (!Number.isSafeInteger(c.nextId) || c.nextId < 0) bad('nextId');
  const layoutIds = new Set();
  for (const m of c.masters) {
    if (!isObj(m) || typeof m.id !== 'string' || !ID_RE.test(m.id)) bad('master id');
    if (!isObj(m.theme) || !isObj(m.theme.colors) || !Array.isArray(m.theme.colors.colors) || m.theme.colors.colors.length !== 12) bad(`master ${m.id}: theme colours`);
    if (!Array.isArray(m.layouts)) bad(`master ${m.id}: layouts`);
    checkShapes(m.shapes ?? [], `master ${m.id}`, new Set());
    for (const l of m.layouts) {
      if (!isObj(l) || typeof l.id !== 'string' || !ID_RE.test(l.id)) bad('layout id');
      if (l.kind !== undefined && !LAYOUT_TYPES.includes(l.kind)) bad(`layout ${l.id}: kind`);
      layoutIds.add(l.id);
      checkShapes(l.shapes ?? [], `layout ${l.id}`, new Set());
    }
  }
  const slideIds = new Set();
  for (const s of c.slides) {
    if (!isObj(s) || typeof s.id !== 'string' || !ID_RE.test(s.id)) bad('slide id');
    if (slideIds.has(s.id)) bad(`duplicate slide id ${s.id}`);
    slideIds.add(s.id);
    if (typeof s.layout !== 'string' || !layoutIds.has(s.layout)) bad(`slide ${s.id} uses missing layout ${s.layout}`);
    if (s.hidden !== undefined && typeof s.hidden !== 'boolean') bad(`slide ${s.id}: hidden`);
    checkShapes(s.shapes, `slide ${s.id}`, new Set());
    checkBody(s.notes, `slide ${s.id} notes`);
  }
  if (c.activeSlideId !== undefined && c.activeSlideId !== '' && !slideIds.has(c.activeSlideId)) bad('activeSlideId');
  for (const sec of c.sections ?? []) if (!isObj(sec) || typeof sec.name !== 'string' || !Array.isArray(sec.slides)) bad('section');
  const problems = validatePresentation(c);
  if (problems.length) bad(problems[0]);
  if (fixNextId(c) > c.nextId) bad('nextId is below an id in use');
  return c;
}

/**
 * The /v1 bridge's legacy command types on schema-2 content (core/model.mjs applyCommand): only
 * `replace_text` and the content-wide commands core/model.mjs handles itself apply.
 */
export function applyLegacyCommand(content, command) {
  throw new Error(`Unsupported command ${command?.type} for a schema-2 presentation (use the /v2 engine)`);
}
