// The bridge between a kernel command context and upstream's Session for the caret, select and text
// ui-commands: `open(ctx)` builds the Session-like `S` editing.mjs works on (a model Document over
// ctx.doc, the primary selection as positions, the live view state, the layout), and `finish`
// commits what changed as one Quill op, sets the selection and returns upstream's `sel_result`.
//
// Upstream: wordcraft crates/engine/src/cmd.rs (`sel_result`) and session.rs (the Session fields
// these commands read) at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {CommandError} from '../../../../core/kernel/errors.mjs';
import {isQuill2} from '../../../../core/quill/model/content.mjs';
import {viewOf, layoutForCtx, touch} from './live.mjs';

/** Revision dates are whole seconds, as Word writes them. */
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** state(): enabled on a schema-2 document. */
export function ready(ctx) {
  if (!ctx?.doc) return {enabled: false, reason: 'No document is open'};
  if (!isQuill2(ctx.doc)) return {enabled: false, reason: 'This document has not been converted to the new Quill format yet'};
  return {enabled: true};
}

/** The author tracked changes and comments are recorded under (File › Options › User name). */
export function author(prefs) {
  const p = prefs ?? {};
  const name = p.userName ?? p.user?.name ?? p.author;
  return typeof name === 'string' && name.trim() ? name.trim() : 'Author';
}

export function open(ctx) {
  const st = ready(ctx);
  if (!st.enabled) throw new CommandError('disabled', st.reason);
  const d = ctx.model.open(ctx);
  const all = ctx.model.selection(ctx);
  const r = all[ctx.selection?.primary ?? 0] ?? all[0];
  return {
    d,
    sel: {anchor: d.clamp(r.anchor), focus: d.clamp(r.focus)},
    view: viewOf(ctx.docId ?? ''),
    prefs: ctx.prefs ?? {},
    author: author(ctx.prefs),
    now: () => iso(ctx.host?.now?.() ?? Date.now()),
    layout: () => layoutForCtx(ctx),
  };
}

/** Commit `S.d`'s changes (if any), set the selection, return {anchor, focus} addresses (sel_result). */
export function finish(ctx, S, {edit = false} = {}) {
  if (edit) ctx.model.commit(ctx, S.d);
  ctx.model.setSelection(ctx, [S.sel]);
  touch(ctx.docId ?? '');
  return {anchor: ctx.model.addressOf(ctx, S.sel.anchor), focus: ctx.model.addressOf(ctx, S.sel.focus)};
}

/** A position param: an address string (/body/b:<id>/t:4) or upstream's {story, path, off}. */
export function posParam(ctx, v, name) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return ctx.model.position(ctx, v);
  if (typeof v === 'object' && Array.isArray(v.path) && Number.isInteger(v.off)) {
    const story = v.story === undefined || v.story === 'body' || v.story === 'Body' ? 'body' : Number(v.story?.Part ?? v.story);
    if (story !== 'body' && !Number.isInteger(story)) throw new CommandError('invalid_params', `bad \`${name}\``, {path: `/${name}`});
    return {story, path: v.path.map(Number), off: v.off};
  }
  throw new CommandError('invalid_params', `bad \`${name}\``, {path: `/${name}`});
}
