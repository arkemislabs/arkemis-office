// The Quill app op: how an edit made on a Document (document.mjs) reaches the kernel's change API
// (docs/architecture.md section 4.2, `ChangeApi.apply`). Arkemis glue, no upstream counterpart:
// upstream's engine snapshots the whole Arc-shared document per undo step; here an edit is the set
// of top-level fields, parts and (through `body`) chunks it replaced, so the kernel's undo stack
// holds pointers to the old values (structural sharing) and undo restores them exactly.
//
//   op = {type: 'quill', set: {[field]: value|null}, parts: {[id]: Part|null}, steps: Step[],
//         changed: Changed[]}
//
// `steps` say how positions move, for sticky anchors and the selection (address.mjs mapThrough):
//   {k: 'text',  story, id, at, del, ins}   paragraph `id`: [at, at+del) replaced by `ins` units
//   {k: 'split', story, id, at, into}       paragraph `id` split at `at`; the tail is paragraph `into`
//   {k: 'join',  story, id, into, at}       paragraph `id` appended to paragraph `into` at offset `at`
//   {k: 'remove', ids}                      blocks, rows, cells, objects and sections that are gone
// `changed` lists what changed for doc.changed events: {story, id?} per changed top-level block or
// part, {field} per other field. No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {collectIds} from './body.mjs';

export const OP_TYPE = 'quill';

/** Prefix/suffix diff of two strings: [at, del, ins] or null when equal. */
export function textDiff(a, b) {
  if (a === b) return null;
  let s = 0;
  const n = Math.min(a.length, b.length);
  while (s < n && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let e = 0;
  while (e < n - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;
  return [s, a.length - s - e, b.length - s - e];
}

/** Paragraphs by id in a list of blocks (deep). */
function parasById(blocks, out) {
  const stack = [...blocks].reverse();
  while (stack.length) {
    const b = stack.pop();
    if (!b) continue;
    if (b.kind === 'para') { if (b.id) out.set(b.id, b); continue; }
    for (const r of b.rows || []) for (const c of r.cells || []) for (let i = c.blocks.length - 1; i >= 0; i--) stack.push(c.blocks[i]);
  }
  return out;
}

/**
 * The op from `base` to `cur` (null when they are the same), with the recorded `steps` and the
 * steps derived from what changed: removed ids, and text diffs for paragraphs no step describes.
 */
export function buildOp(base, cur, steps = []) {
  if (base === cur) return null;
  const set = {}, parts = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(cur)]);
  const oldUnits = [], newUnits = [];
  const changed = [];
  for (const k of keys) {
    if (base[k] === cur[k]) continue;
    if (k === 'parts') {
      const ids = new Set([...Object.keys(base.parts || {}), ...Object.keys(cur.parts || {})]);
      for (const id of ids) {
        const a = base.parts?.[id], b = cur.parts?.[id];
        if (a === b) continue;
        parts[id] = b ?? null;
        if (a) oldUnits.push({story: Number(id), blocks: a.blocks});
        if (b) newUnits.push({story: Number(id), blocks: b.blocks});
        changed.push({story: Number(id)});
      }
      continue;
    }
    set[k] = cur[k] === undefined ? null : cur[k];
    if (k === 'body') {
      const before = new Set(base.body?.chunks ?? []);
      const after = new Set(cur.body?.chunks ?? []);
      const oldTop = new Map();
      for (const ch of base.body?.chunks ?? []) if (!after.has(ch)) { oldUnits.push({story: 'body', blocks: ch}); for (const b of ch) oldTop.set(b.id, b); }
      for (const ch of cur.body?.chunks ?? []) if (!before.has(ch)) {
        newUnits.push({story: 'body', blocks: ch});
        for (const b of ch) if (oldTop.get(b.id) !== b) changed.push({story: 'body', id: b.id});
      }
    } else changed.push({field: k});
  }
  if (!Object.keys(set).length && !Object.keys(parts).length) return null;
  const oldIds = new Set(), newIds = new Set();
  for (const u of oldUnits) collectIds(u.blocks, oldIds);
  for (const u of newUnits) collectIds(u.blocks, newIds);
  if (set.lastSection !== undefined) { if (base.lastSection?.id) oldIds.add(base.lastSection.id); if (cur.lastSection?.id) newIds.add(cur.lastSection.id); }
  const removed = [...oldIds].filter(id => !newIds.has(id));
  // Paragraphs whose text changed without a recorded step get one from a diff.
  const touched = new Set();
  for (const s of steps) { touched.add(s.id); if (s.into) touched.add(s.into); }
  const derived = [];
  if (oldUnits.length && newUnits.length) {
    const oldParas = new Map(), newParas = new Map();
    for (const u of oldUnits) parasById(u.blocks, oldParas);
    const storyOf = new Map();
    for (const u of newUnits) { const m = parasById(u.blocks, new Map()); for (const [id, p] of m) { newParas.set(id, p); storyOf.set(id, u.story); } }
    for (const [id, p] of newParas) {
      const q = oldParas.get(id);
      if (!q || q === p || touched.has(id)) continue;
      const d = textDiff(q.text, p.text);
      if (d) derived.push({k: 'text', story: storyOf.get(id), id, at: d[0], del: d[1], ins: d[2]});
    }
  }
  const all = [...steps, ...derived];
  if (removed.length) all.push({k: 'remove', ids: removed});
  return {type: OP_TYPE, set, parts, steps: all, changed};
}

/** The steps that undo `steps` (reverse order; removals can't be undone for anchors). */
export function invertSteps(steps) {
  const out = [];
  for (let i = (steps || []).length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.k === 'text') out.push({...s, del: s.ins, ins: s.del});
    else if (s.k === 'split') out.push({k: 'join', story: s.story, id: s.into, into: s.id, at: s.at});
    else if (s.k === 'join') out.push({k: 'split', story: s.story, id: s.into, at: s.at, into: s.id});
  }
  return out;
}

/** Apply an op to content: {content, inverse} (the schema.mjs `apply` hook of the kernel). */
export function applyOp(content, op) {
  if (!op || op.type !== OP_TYPE) throw new CommandError('failed', `Not a Quill op: ${op?.type}`);
  const next = {...content};
  const inv = {type: OP_TYPE, set: {}, parts: {}, steps: invertSteps(op.steps), changed: op.changed || []};
  for (const [k, v] of Object.entries(op.set || {})) {
    if (k === 'parts') throw new CommandError('failed', 'Quill ops change parts by id');
    inv.set[k] = Object.hasOwn(content, k) ? content[k] : null;
    if (v === null) delete next[k]; else next[k] = v;
  }
  const pk = Object.keys(op.parts || {});
  if (pk.length) {
    next.parts = {...(content.parts || {})};
    for (const id of pk) {
      inv.parts[id] = content.parts?.[id] ?? null;
      if (op.parts[id] === null) delete next.parts[id]; else next.parts[id] = op.parts[id];
    }
  }
  return {content: next, inverse: inv};
}
