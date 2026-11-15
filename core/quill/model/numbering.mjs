// Lists: abstract numbering definitions (9 levels each), numbering instances, list kinds for the
// Bullets / Numbering / Multilevel galleries, and the counters that compute list labels.
// Translated from wordcraft crates/doc/src/numbering.rs and crates/doc/src/parts.rs (`free_id`)
// at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `numbering` is `{abstracts: AbstractNum[], nums: Num[]}`. A Num is `{id, abstractId,
// startOverrides: [level, start][], levelOverrides?: [level, Level][]}`. Functions that change
// numbering return a new object. No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {formatNumber} from './numfmt.mjs';

const U32_MAX = 0xffffffff;

/**
 * A free id, `min` or more (parts.rs `free_id`): one past `largest` so ids keep growing; past
 * u32::MAX the lowest id not in `used`. null when every id from `min` up is taken.
 */
export function freeId(largest, used, min) {
  if (largest === null || largest === undefined) return min;
  if (largest + 1 <= U32_MAX) return Math.max(largest + 1, min);
  const ids = [...new Set([...used].filter(i => i >= min))].sort((a, b) => a - b);
  let want = min;
  for (const i of ids) {
    if (i > want) break;
    want += 1;
    if (want > U32_MAX) return null;
  }
  return want;
}

export const LEVEL_SUFFIXES = Object.freeze(['tab', 'space', 'nothing']);

/** A level with upstream's defaults. */
export function level(fields = {}) {
  return {start: 1, format: 'decimal', text: '%1.', align: 'left', indent: 36, hanging: 18, suffix: 'tab', chr: {}, restart: true,
    legal: false, style: null, ...fields};
}

export const emptyNumbering = () => ({abstracts: [], nums: []});

/** Built-in list kinds: 'bullet', {bulletChar: c}, 'numbered', 'numberedParen', 'outline', 'upperLetter', 'lowerLetter', 'lowerLetterDot', 'lowerRoman', 'legal'. */
export function parseListKind(s) {
  switch (s) {
    case 'bullet': return 'bullet';
    case 'numbered': case 'number': return 'numbered';
    case 'numberedParen': return 'numberedParen';
    case 'outline': return 'outline';
    case 'upperLetter': return 'upperLetter';
    case 'lowerLetter': return 'lowerLetter';
    case 'lowerLetterDot': return 'lowerLetterDot';
    case 'lowerRoman': return 'lowerRoman';
    case 'legal': case 'multilevel': return 'legal';
    default: return typeof s === 'string' && [...s].length === 1 ? {bulletChar: s} : null;
  }
}
export const listKindIsBullet = k => k === 'bullet' || (k && typeof k === 'object' && 'bulletChar' in k);

/** The bullet a level of a plain bulleted list shows: • ○ ▪ repeating. */
export const defaultBullet = lvl => ['•', '○', '▪'][lvl % 3];

function bulletLevel(i, c) {
  let font;
  if (c === '•' || c === '▪' || c === '○') font = 'Arial';
  else if ((c.codePointAt(0) < 128) || c === '–') font = undefined;
  else font = 'Segoe UI Symbol';
  return level({format: 'bullet', text: c, indent: 36 * (i + 1), hanging: 18, chr: font ? {font} : {}});
}

/** Nine levels for a list kind (`levels_for`). */
export function levelsFor(kind) {
  const out = [];
  for (let i = 0; i < 9; i++) {
    const ind = 36 * (i + 1);
    const cyc = (a, b, c) => [a, b, c][i % 3];
    const lvl = (format, text) => level({format, text, indent: ind, hanging: 18});
    const n = i + 1;
    if (kind === 'bullet') out.push(bulletLevel(i, defaultBullet(i)));
    else if (kind && typeof kind === 'object' && 'bulletChar' in kind) out.push(bulletLevel(i, i === 0 ? kind.bulletChar : defaultBullet(i)));
    else if (kind === 'numbered') out.push(lvl(cyc('decimal', 'lowerLetter', 'lowerRoman'), `%${n}.`));
    else if (kind === 'numberedParen') out.push(lvl(cyc('decimal', 'lowerLetter', 'lowerRoman'), `%${n})`));
    else if (kind === 'upperLetter') out.push(lvl(cyc('upperLetter', 'lowerLetter', 'lowerRoman'), `%${n}.`));
    else if (kind === 'lowerLetter') out.push(lvl(cyc('lowerLetter', 'lowerRoman', 'decimal'), `%${n})`));
    else if (kind === 'lowerLetterDot') out.push(lvl(cyc('lowerLetter', 'lowerRoman', 'decimal'), `%${n}.`));
    else if (kind === 'lowerRoman') out.push(lvl(cyc('lowerRoman', 'lowerLetter', 'decimal'), `%${n}.`));
    else if (kind === 'outline') out.push(lvl(['upperRoman', 'upperLetter', 'decimal', 'lowerLetter', 'lowerRoman'][i] ?? 'decimal', `%${n}.`));
    else if (kind === 'legal') {
      let text = '';
      for (let k = 1; k <= n; k++) text += `%${k}.`;
      out.push(level({format: 'decimal', text, indent: 18 + 25 * i, hanging: 18 + 7 * i}));
    } else throw new CommandError('invalid_params', `Unknown list kind ${JSON.stringify(kind)}`);
  }
  return out;
}

export const numOf = (numbering, id) => numbering.nums.find(n => n.id === id) ?? null;
export function abstractOf(numbering, num) {
  const n = numOf(numbering, num);
  return n ? numbering.abstracts.find(a => a.id === n.abstractId) ?? null : null;
}
/** A list's own level definition wins over its abstract list's. */
export function levelOf(numbering, num, lvl) {
  const n = numOf(numbering, num);
  if (!n) return null;
  const own = (n.levelOverrides || []).find(([i]) => i === lvl);
  if (own) return own[1];
  return abstractOf(numbering, num)?.levels?.[lvl] ?? null;
}
/** Whether a paragraph in list `num` at `lvl` gets a label, without counting it. */
export function showsLabel(numbering, num, lvl) {
  const d = levelOf(numbering, num, Math.min(lvl, 8));
  return !!abstractOf(numbering, num) && !!d && d.format !== 'none';
}

function freeNumId(numbering) {
  const ids = numbering.nums.map(n => n.id);
  return freeId(ids.length ? Math.max(...ids) : null, ids, 1);
}

/** A new list definition and a num for it (try_add_levels). Returns {numbering, num}. */
export function addLevels(numbering, name, levels) {
  const aids = numbering.abstracts.map(a => a.id);
  const aid = freeId(aids.length ? Math.max(...aids) : null, aids, 0);
  const nid = freeNumId(numbering);
  if (aid === null || nid === null) throw new CommandError('failed', 'no free list id');
  const abs = {id: aid, name: name ?? null, levels};
  return {
    numbering: {...numbering, abstracts: [...numbering.abstracts, abs], nums: [...numbering.nums, {id: nid, abstractId: aid, startOverrides: []}]},
    num: nid,
  };
}
/** Create a new list of `kind` (add_list). Returns {numbering, num}. */
export const addList = (numbering, kind) => addLevels(numbering, null, levelsFor(kind));

/** A new num restarting an existing list (restart). Returns {numbering, num} or null. */
export function restartList(numbering, num) {
  const src = numOf(numbering, num);
  if (!src) return null;
  const nid = freeNumId(numbering);
  if (nid === null) return null;
  const a = numbering.abstracts.find(x => x.id === src.abstractId);
  const levels = a ? a.levels.length : 0;
  const startOverrides = [];
  for (let i = 0; i < levels; i++) { const l = levelOf(numbering, num, i); if (l) startOverrides.push([i, l.start]); }
  const nn = {id: nid, abstractId: src.abstractId, startOverrides};
  if (src.levelOverrides?.length) nn.levelOverrides = structuredClone(src.levelOverrides);
  return {numbering: {...numbering, nums: [...numbering.nums, nn]}, num: nid};
}

/** Find an existing list whose first level matches `kind`, so consecutive bullet clicks reuse it. */
export function findKind(numbering, kind) {
  const first = levelsFor(kind)[0];
  const n = numbering.nums.find(x => {
    const l = abstractOf(numbering, x.id)?.levels?.[0];
    return l && l.format === first.format && l.text === first.text;
  });
  return n ? n.id : null;
}

const MAX_LEVEL_TEXT = 64;
const MAX_LABEL_BYTES = 256;
const utf8Len = s => { let n = 0; for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n; };

/** Running list counters while walking a document in order (numbering.rs `Counters`). */
export class Counters {
  constructor() {
    /** Per abstract list: current value per level. */
    this.state = new Map();
    /** Which (num, level) pairs have started. */
    this.seen = new Set();
    /** Per abstract list: {started, first} per level. */
    this.flags = new Map();
  }
  /** The current value of each level of `num`'s list. */
  values(numbering, num) {
    const abs = abstractOf(numbering, num);
    if (!abs) return null;
    return (this.state.get(abs.id) ?? new Array(9).fill(0)).slice();
  }
  /** Advance the counter for `num`/`lvl` and return [label, levelDef] (or null). */
  nextLabel(numbering, num, lvl) {
    const n = numOf(numbering, num);
    const abs = abstractOf(numbering, num);
    if (!n || !abs) return null;
    const lv = Math.min(lvl, 8);
    const levelDef = k => levelOf(numbering, num, k);
    const def = levelDef(lv);
    if (!def || def.format === 'none') return null;
    if (!this.state.has(abs.id)) this.state.set(abs.id, new Array(9).fill(0));
    if (!this.flags.has(abs.id)) this.flags.set(abs.id, Array.from({length: 9}, () => ({started: false, first: null})));
    const st = this.state.get(abs.id), fl = this.flags.get(abs.id);
    const key = `${num}\u0000${lv}`;
    if (!this.seen.has(key)) {
      this.seen.add(key);
      const so = (n.startOverrides || []).find(([l]) => l === lv);
      if (so) { st[lv] = 0; fl[lv] = {started: false, first: so[1]}; }
    }
    st[lv] = fl[lv].started ? Math.min(st[lv] + 1, U32_MAX) : (fl[lv].first ?? def.start);
    fl[lv] = {started: true, first: null};
    for (let d = lv + 1; d < 9; d++) {
      const l = levelDef(d);
      const restarts = !l || (l.restart && (l.restartAfter === undefined || l.restartAfter === null || lv < l.restartAfter));
      if (restarts) { st[d] = 0; fl[d] = {started: false, first: null}; }
    }
    if (def.format === 'bullet') return [def.text, def];
    let label = '';
    const chars = [...def.text].slice(0, MAX_LEVEL_TEXT);
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const d = chars[i + 1];
      if (c === '%' && d !== undefined && /^[0-9]$/.test(d)) {
        i++;
        const k = Math.min(Math.max(Number(d) - 1, 0), 8);
        const counted = fl[k]?.started;
        const val = counted ? st[k] : (levelDef(k)?.start ?? 1);
        const own = levelDef(k)?.format ?? 'decimal';
        const fmt = own === 'decimalZero' ? 'decimalZero' : def.legal ? 'decimal' : own;
        label += formatNumber(fmt, val);
        if (utf8Len(label) > MAX_LABEL_BYTES) break;
      } else label += c;
    }
    return [label, def];
  }
}
