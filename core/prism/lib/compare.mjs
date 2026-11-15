// Review > Compare: the differences between the open presentation and a revised copy of it, slide by
// slide, and accepting a revised slide into the open one or rejecting it.
// Slides match by id (a revised copy of the same deck keeps them); when the two decks share no slide
// id at all, by position. Shapes match by id, then by name.
// Translated from deckcraft crates/engine/src/compare.rs (`diff`, `pending`, `unrelated`, `pairs`,
// `slide_details`, `shape_details`, `adopt`, `accept`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {bodyText} from '../model/text.mjs';
import {isTitlePh} from '../model/presentation.mjs';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const MAX_DETAILS = 50;

/** Whether the two decks share no slide id (then slides match by position). */
export function unrelated(cur, rev) {
  const ids = new Set((rev.slides ?? []).map(s => s.id));
  return !(cur.slides ?? []).some(s => ids.has(s.id));
}

function pairs(cur, rev, byPosition) {
  if (byPosition) return Array.from({length: Math.min(cur.slides.length, rev.slides.length)}, (_, i) => [i, i]);
  const revIds = new Map(rev.slides.map((s, i) => [s.id, i]));
  return cur.slides.flatMap((s, i) => (revIds.has(s.id) ? [[i, revIds.get(s.id)]] : []));
}

function slideTitle(s) {
  const t = (s.shapes ?? []).find(x => x.ph && isTitlePh(x.ph.kind))?.text;
  const text = t ? bodyText(t).trim() : '';
  return text ? [...text].slice(0, 60).join('') : 'Untitled slide';
}
const shapeLabel = s => (String(s.name ?? '').trim() ? s.name : `Shape ${s.id}`);

/** A shape without its ids, for comparing across decks. */
function plainShape(s) {
  const c = structuredClone(s);
  const rec = list => { for (const x of list ?? []) { x.id = '0'; if (x.kind?.children) rec(x.kind.children); } };
  rec([c]);
  return c;
}
const mediaData = (p, id) => (p.media ?? []).find(m => m.id === id)?.data ?? null;

function shapeDetails(cp, a, rp, b, out) {
  const label = shapeLabel(b);
  const text = s => (s.text ? bodyText(s.text) : '');
  const what = [];
  if (text(a) !== text(b)) what.push('text');
  else if (!same(a.text, b.text)) what.push('text formatting');
  const [x, y] = [a.xfrm, b.xfrm];
  if (x && y && (x.x !== y.x || x.y !== y.y) && x.w === y.w && x.h === y.h) what.push('moved');
  else if (x && y && (x.w !== y.w || x.h !== y.h)) what.push('resized');
  else if ((x?.rot ?? null) !== (y?.rot ?? null)) what.push('rotated');
  if (!same(a.fill, b.fill) || !same(a.line, b.line) || !same(a.style, b.style) || !same(a.effects, b.effects)) what.push('formatting');
  const pic = (p, s) => (s.kind?.type === 'picture' ? mediaData(p, s.kind.fill.media) : null);
  if (pic(cp, a) !== pic(rp, b)) what.push('picture');
  if (!what.length) {
    const [px, py] = [plainShape(a), plainShape(b)];
    px.text = null; py.text = null;
    if (px.kind?.type === 'picture' && py.kind?.type === 'picture') { px.kind = {type: 'shape'}; py.kind = {type: 'shape'}; }
    if (!same(px, py)) what.push('properties');
  }
  if (what.length) out.push(`${label}: ${what.join(', ')}`);
}

function slideDetails(cp, a, rp, b) {
  const out = [];
  const used = new Set();
  for (const sa of a.shapes ?? []) {
    let k = (b.shapes ?? []).findIndex(x => x.id === sa.id);
    if (k < 0) k = (b.shapes ?? []).findIndex((x, i) => !used.has(i) && x.name === sa.name && x.name !== '');
    if (k >= 0 && !used.has(k)) { used.add(k); shapeDetails(cp, sa, rp, b.shapes[k], out); } else out.push(`${shapeLabel(sa)} deleted`);
  }
  (b.shapes ?? []).forEach((sb, k) => { if (!used.has(k)) out.push(`${shapeLabel(sb)} inserted`); });
  const order = s => (s.shapes ?? []).map(x => x.name);
  if (!out.length && !same(order(a), order(b))) out.push('order of objects');
  const layoutName = (p, s) => { for (const m of p.masters ?? []) { const l = (m.layouts ?? []).find(l => l.id === s.layout); if (l) return l.name; } return null; };
  if (layoutName(cp, a) !== layoutName(rp, b)) out.push('layout');
  if (bodyText(a.notes) !== bodyText(b.notes)) out.push('notes');
  if (!same(a.transition, b.transition)) out.push('transition');
  const [aa, ab] = [a.animations ?? [], b.animations ?? []];
  if (aa.length !== ab.length || aa.some((x, i) => !same([x.effect, x.class, x.start, x.durationMs, x.delayMs], [ab[i].effect, ab[i].class, ab[i].start, ab[i].durationMs, ab[i].delayMs]))) out.push('animations');
  if (!same(a.background, b.background)) out.push('background');
  if ((a.hidden ?? false) !== (b.hidden ?? false)) out.push(b.hidden ? 'hidden' : 'shown');
  return out.slice(0, MAX_DETAILS);
}

/** The slide-level revisions of `cur` against `rev`: [{kind: changed | deleted | inserted, slide, revised, details}]. */
export function diff(cur, rev, byPosition) {
  const ps = pairs(cur, rev, byPosition);
  const curMatched = new Set(ps.map(p => p[0])), revMatched = new Set(ps.map(p => p[1]));
  const out = [];
  for (const [i, j] of ps) {
    const details = slideDetails(cur, cur.slides[i], rev, rev.slides[j]);
    if (details.length) out.push({kind: 'changed', slide: i, revised: j, details});
  }
  cur.slides.forEach((s, i) => { if (!curMatched.has(i)) out.push({kind: 'deleted', slide: i, revised: null, details: [slideTitle(s)]}); });
  rev.slides.forEach((s, j) => {
    if (revMatched.has(j)) return;
    let at = 0;
    for (let k = j - 1; k >= 0; k--) { const hit = ps.find(p => p[1] === k); if (hit) { at = hit[0] + 1; break; } }
    out.push({kind: 'inserted', slide: at, revised: j, details: [slideTitle(s)]});
  });
  out.sort((x, y) => x.slide - y.slide || (x.revised ?? 0) - (y.revised ?? 0));
  return out;
}

/** What a revision is about, stable while slides move: [kind, open slide id | null, revised index | null]. */
export const changeKey = (doc, c) => JSON.stringify([c.kind, c.kind === 'inserted' ? null : doc.slides[c.slide]?.id ?? null, c.revised]);

/** The revisions still to review: `diff` without the rejected ones. `cmp` is {revised, byPosition, rejected: [keys]}. */
export function pending(doc, cmp) {
  const rejected = new Set(cmp.rejected ?? []);
  const keys = [...rejected].map(k => JSON.parse(k));
  return diff(doc, cmp.revised, cmp.byPosition).filter(c => {
    if (rejected.has(changeKey(doc, c))) return false;
    if (!cmp.byPosition) return true;
    if (c.kind === 'deleted') { const open = doc.slides[c.slide]?.id ?? null; return !(open !== null && keys.some(k => k[1] === open)); }
    return !(c.revised !== null && keys.some(k => k[2] === c.revised));
  });
}

function mediaIds(v, out = new Set(), depth = 0) {
  if (depth > 64 || !v || typeof v !== 'object') return out;
  if (Array.isArray(v)) { v.forEach(x => mediaIds(x, out, depth + 1)); return out; }
  for (const [k, x] of Object.entries(v)) { if ((k === 'media' || k === 'original' || k === 'poster') && typeof x === 'string') out.add(x); else mediaIds(x, out, depth + 1); }
  return out;
}
const remapMedia = (v, map, depth = 0) => {
  if (depth > 64 || !v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => remapMedia(x, map, depth + 1));
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = (k === 'media' || k === 'original' || k === 'poster') && typeof x === 'string' && map.has(x) ? map.get(x) : remapMedia(x, map, depth + 1);
  return o;
};
const walkShapes = (list, f, depth = 0) => { if (depth > 64) return; for (const s of list ?? []) { f(s); if (s.kind?.children) walkShapes(s.kind.children, f, depth + 1); } };

/**
 * The revised slide made to live in `doc` (a mutable copy, changed in place: media, nextId): its
 * media copied over (remapped on an id clash), shape ids kept unless another slide of `doc` uses
 * them (then fresh, animations following), its layout matched by id, then by name, then the first.
 */
export function adopt(doc, rev, slide, replacing) {
  let sl = structuredClone(slide);
  const alloc = () => { doc.nextId = Math.max(doc.nextId ?? 0, 1) + 1; if (doc.nextId > 0xffffffff) throw new Error('the presentation has used every object id and can hold no more'); return String(doc.nextId); };
  doc.media = doc.media ?? [];
  const map = new Map();
  for (const id of mediaIds(sl)) {
    const m = (rev.media ?? []).find(x => x.id === id);
    if (!m) continue;
    const mine = doc.media.find(x => x.id === id);
    if (mine && mine.data === m.data) continue;
    if (!mine) { doc.media.push(structuredClone(m)); doc.nextId = Math.max(doc.nextId ?? 0, Number(id) || 0); continue; }
    const nid = alloc();
    doc.media.push({...structuredClone(m), id: nid});
    map.set(id, nid);
  }
  const taken = new Set();
  for (const s of doc.slides) if (s.id !== replacing) walkShapes(s.shapes, x => taken.add(x.id));
  const ids = new Map();
  walkShapes(sl.shapes, x => { if (taken.has(x.id)) { const n = alloc(); ids.set(x.id, n); x.id = n; } });
  sl = remapMedia(sl, map);
  for (const a of sl.animations ?? []) {
    if (ids.has(a.shape)) a.shape = ids.get(a.shape);
    if (a.trigger && ids.has(a.trigger)) a.trigger = ids.get(a.trigger);
  }
  let max = 0;
  walkShapes(sl.shapes, x => { max = Math.max(max, Number(x.id) || 0); });
  doc.nextId = Math.max(doc.nextId ?? 0, max);
  const findLayout = (p, id) => { for (const m of p.masters ?? []) { const l = (m.layouts ?? []).find(l => l.id === id); if (l) return l; } return null; };
  // By id when that layout is the same one (decks reopened from files number their layouts alike but not always the same way), else by name, else the first.
  const mine = findLayout(doc, sl.layout), theirs = findLayout(rev, slide.layout);
  if (!mine || (theirs && mine.name !== theirs.name)) {
    const name = theirs?.name;
    const byName = name ? doc.masters.flatMap(m => m.layouts ?? []).find(l => l.name === name)?.id : null;
    sl.layout = byName ?? doc.masters[0]?.layouts?.[0]?.id ?? '0';
  }
  if (replacing) sl.id = replacing;
  else {
    if (doc.slides.some(s => s.id === sl.id) || sl.id === '0') sl.id = alloc();
    doc.nextId = Math.max(doc.nextId ?? 0, Number(sl.id) || 0);
  }
  return sl;
}

/** Apply `change` (from `diff` of `doc` against `rev`) to `doc`, a mutable copy: the slide index to show, or null when it no longer applies. */
export function accept(doc, rev, change) {
  if (change.kind === 'changed') {
    const b = change.revised !== null ? rev.slides[change.revised] : null;
    const id = doc.slides[change.slide]?.id;
    if (!b || !id) return null;
    doc.slides[change.slide] = adopt(doc, rev, b, id);
    return change.slide;
  }
  if (change.kind === 'inserted') {
    const b = change.revised !== null ? rev.slides[change.revised] : null;
    if (!b) return null;
    const sl = adopt(doc, rev, b, null);
    const at = Math.min(change.slide, doc.slides.length);
    doc.slides.splice(at, 0, sl);
    return at;
  }
  if (change.slide >= doc.slides.length || doc.slides.length <= 1) return null;
  doc.slides.splice(change.slide, 1);
  return Math.min(change.slide, doc.slides.length - 1);
}
