// Copying and removing shapes: fresh ids for copies (groups included) with connectors and
// animations following their copies, removing shapes anywhere in the tree (emptied groups go too),
// bringing a clipboard's media into a deck, and baking theme colours and fonts into shapes so they
// keep their look under another theme.
// Translated from deckcraft crates/engine/src/cmd/edit.rs (`reid`, `remap_animations`,
// `walk_mut`, `bring_media`, `remap_media`, `remove_shapes`, `count`, `bake_theme`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// U:prism/edit owns this file; U:prism/slide imports it. No DOM, no Node built-ins.

import {allocId, isGroup, walk} from '../model/presentation.mjs';
import {schemeGet} from '../model/color.mjs';
import {masterScheme} from '../model/presentation.mjs';
import {bad, NO_ID_SPACE} from './text-session.mjs';

/** A fresh id from `holder.pres` (deckcraft `alloc_id`), advancing `holder.pres.nextId`. */
export function takeId(holder, cmd) {
  const a = allocId(holder.pres);
  if (!a) throw bad(cmd, NO_ID_SPACE);
  holder.pres = {...holder.pres, nextId: a[1]};
  return a[0];
}

/**
 * deckcraft `reid`: give `shapes` (deep copies) fresh ids, groups included, and return the
 * old-to-new map. Connector ends glued to a copied shape follow its copy; ends glued elsewhere
 * are detached (the connector keeps its geometry). Returns {shapes, map}.
 */
export function reid(cmd, holder, shapesIn) {
  const map = new Map();
  const rec = (list, depth) => (depth > 64 ? list : list.map(s => {
    const id = takeId(holder, cmd);
    map.set(s.id, id);
    const n = {...s, id};
    if (isGroup(n)) n.kind = {...n.kind, children: rec(n.kind.children ?? [], depth + 1)};
    return n;
  }));
  let shapes = rec(structuredClone(shapesIn), 0);
  const fix = list => list.map(s => {
    let n = s;
    if (n.kind?.type === 'connector') {
      const end = e => (e && map.has(e[0]) ? [map.get(e[0]), e[1]] : null);
      n = {...n, kind: {...n.kind, start: end(n.kind.start), end: end(n.kind.end)}};
    }
    if (isGroup(n)) n = {...n, kind: {...n.kind, children: fix(n.kind.children ?? [])}};
    return n;
  });
  shapes = fix(shapes);
  return {shapes, map};
}

/** deckcraft `remap_animations`: animations follow the copies; others are dropped, uncopied triggers cleared. */
export function remapAnimations(anims, map) {
  const out = [];
  for (const a of anims ?? []) {
    if (!map.has(a.shape)) continue;
    out.push({...a, shape: map.get(a.shape), trigger: a.trigger != null && map.has(a.trigger) ? map.get(a.trigger) : null});
  }
  return out;
}

/** Count shapes (groups included). */
export function countShapes(list) {
  let n = 0;
  walk(list, () => { n += 1; });
  return n;
}

/** deckcraft `remove_shapes`: remove `ids` anywhere in the tree; emptied groups go too. Returns {shapes, removed}. */
export function removeShapes(list, ids) {
  const gone = new Set(ids);
  const rec = (v, depth) => {
    let out = v.filter(s => !gone.has(s.id));
    if (depth > 64) return out;
    out = out.map(s => (isGroup(s) ? {...s, kind: {...s.kind, children: rec(s.kind.children ?? [], depth + 1)}} : s));
    return out.filter(s => !isGroup(s) || (s.kind.children ?? []).length > 0);
  };
  const shapes = rec(list, 0);
  return {shapes, removed: Math.max(0, countShapes(list) - countShapes(shapes))};
}

// ---------------------------------------------------------------------------------------------
// Media

/** Keys under which a shape refers to a media item (deckcraft media_refs visitor, by field name). */
const MEDIA_KEYS = new Set(['media', 'poster', 'sound', 'mediaId', 'posterMedia']);

/** Every media id the value refers to. */
export function mediaRefs(value) {
  const out = new Set();
  const rec = (v, depth) => {
    if (depth > 256 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(x => rec(x, depth + 1)); return; }
    for (const [k, x] of Object.entries(v)) {
      if (MEDIA_KEYS.has(k) && (typeof x === 'string' || typeof x === 'number')) out.add(String(x));
      else rec(x, depth + 1);
    }
  };
  rec(value, 0);
  return out;
}
/** Rewrite media ids through `map` (old → new). */
export function remapMedia(value, map) {
  if (!map.size) return value;
  const rec = (v, depth) => {
    if (depth > 256 || !v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(x => rec(x, depth + 1));
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = MEDIA_KEYS.has(k) && map.has(String(x)) ? map.get(String(x)) : rec(x, depth + 1);
    return o;
  };
  return rec(value, 0);
}

/**
 * deckcraft `bring_media`: add the clipboard's media to the deck in `holder.pres`; an id used by
 * other bytes in this deck gets a fresh id. Returns the old-to-new map for the ids that changed.
 */
export function bringMedia(cmd, holder, media) {
  const map = new Map();
  for (const m of media ?? []) {
    const have = (holder.pres.media ?? []).find(x => x.id === m.id);
    if (!have) {
      const n = /^\d+$/.test(String(m.id)) ? Number(m.id) : 0;
      holder.pres = {...holder.pres, media: [...(holder.pres.media ?? []), structuredClone(m)], nextId: Math.max(holder.pres.nextId ?? 0, n)};
    } else if (have.data !== m.data) {
      const id = takeId(holder, cmd);
      holder.pres = {...holder.pres, media: [...holder.pres.media, {...structuredClone(m), id}]};
      map.set(String(m.id), id);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// Theme baking (Paste Special › Keep Source Formatting)

/** The source theme a copy carries: the current slide's master colour scheme and fonts. */
export function sourceTheme(master) {
  return master ? {scheme: masterScheme(master), fonts: structuredClone(master.theme?.fonts ?? {})} : null;
}

/**
 * deckcraft `bake_theme`: replace scheme colours (except the placeholder colour) and theme font
 * references (`+mj-lt`, `+mn-ea`...) with the values they have in the source theme.
 */
export function bakeTheme(shapes, theme) {
  if (!theme) return shapes;
  const {scheme, fonts} = theme;
  const face = t => {
    const set = t.slice(1, 3) === 'mj' ? fonts?.major : t.slice(1, 3) === 'mn' ? fonts?.minor : null;
    const k = {'-lt': 'latin', '-ea': 'ea', '-cs': 'cs'}[t.slice(3)];
    const f = set && k ? set[k] : '';
    return f || t;
  };
  const rec = (v, depth) => {
    if (depth > 256) return v;
    if (typeof v === 'string') return v.startsWith('+') ? face(v) : v;
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(x => rec(x, depth + 1));
    if (v.kind === 'scheme' && typeof v.slot === 'string' && v.slot !== 'phClr') {
      let rgb = null;
      const slot = {bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2'}[v.slot] ?? v.slot;
      try { rgb = schemeGet(scheme, slot); } catch { rgb = null; }
      if (rgb) return {kind: 'rgb', rgb: {...rgb}};
    }
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = rec(x, depth + 1);
    return o;
  };
  return shapes.map(s => rec(s, 0));
}
