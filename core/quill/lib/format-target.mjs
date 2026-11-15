// What a formatting command works on, for the format, para and lists families (U:quill/format).
// Translated from wordcraft crates/engine/src/cmd/format.rs (`target`, `apply`, `resolved`),
// crates/engine/src/cmd.rs (`selected_paths`, `sel_result`, `new_revision`),
// crates/engine/src/cmd/para/format.rs (`cur`, `fmt`) and crates/engine/src/session/query.rs
// (`typing_props`, `caret_props`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Upstream keeps the pending typing formatting (`Session::pending`), the last highlight colour
// (`last_highlight`) and the format painter (`painter`) beside the document. Here they are the
// kernel's per-document view state (`ctx.view`, written with `ctx.setView`), never a document
// change: `pendingFormat: {at, props}` holds for as long as the selection is the caret at `at`
// (any caret move or typing makes it stale, as upstream clears `pending`), `lastHighlight` is
// the highlight name, `painter: {chr, para, sticky}`.
//
// A column or block of whole cells (`column_segments`) is the kernel selection's several ranges,
// one per cell paragraph (core/quill/lib/table-session.mjs): character and paragraph formatting
// apply to each range in one edit, and the cells between its ends are left alone.
//
// Not translated: a text box selected as an object (`selected_text_box`: its whole story is the
// target).
//
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import * as P from '../model/para.mjs';
import {charUnlinked, charWithoutSymbol} from '../model/props.mjs';
import {resolveChar, resolvePara} from '../model/styles.mjs';
import {cmpPos, samePath, samePos, pathParent} from '../model/document.mjs';
import {isQuill2} from '../model/content.mjs';
import {addressOf} from '../address.mjs';

export const UPSTREAM_COMMIT = 'aadb077e072b7de05f724e359d8db82e151f125c';

/** Upstream's run cap for formatting-state queries (`resolved`). */
export const STATE_RUN_CAP = 10_000;

// ---------------------------------------------------------------------------------------------
// Readiness

/** state(): enabled on an open schema-2 document. */
export function ready(ctx) {
  if (!ctx?.doc) return {enabled: false, reason: 'No document is open'};
  if (!isQuill2(ctx.doc)) return {enabled: false, reason: 'This document has not been converted to the new Quill format yet'};
  return {enabled: true};
}

/** Throw the disabled reason when the document is not schema 2. */
export function need(ctx) {
  const st = ready(ctx);
  if (!st.enabled) throw new CommandError('disabled', st.reason);
}

// ---------------------------------------------------------------------------------------------
// Selection

/** The primary selection, ordered and clamped into `d`: [a, b] (`s.sel.ordered()`). */
export function ordered(ctx, d) {
  const [a, b] = ctx.model.selectionRange(ctx);
  const x = d.clamp(a), y = d.clamp(b);
  return cmpPos(x, y) <= 0 ? [x, y] : [y, x];
}

/**
 * Every range of the selection, each ordered and clamped (`column_segments` when a column of a
 * table is selected; otherwise just the primary range).
 */
export function segments(ctx, d) {
  const all = ctx.model.selection(ctx) ?? [];
  if (all.length <= 1) return [ordered(ctx, d)];
  return all.map(r => {
    const x = d.clamp(r.anchor), y = d.clamp(r.focus);
    return cmpPos(x, y) <= 0 ? [x, y] : [y, x];
  });
}

/** The primary selection's focus, clamped (`s.sel.focus`). */
export function focusOf(ctx, d) {
  const all = ctx.model.selection(ctx);
  const r = all[ctx.selection?.primary ?? 0] ?? all[0];
  return d.clamp(r.focus);
}

/** Upstream `target`'s word letter: `char::is_alphanumeric`, an apostrophe or an underscore. */
const isW = cp => cp !== undefined && cp !== null && (/[\p{Alphabetic}\p{N}]/u.test(String.fromCodePoint(cp)) || cp === 0x27 || cp === 0x5f);

/**
 * The range to format (`target`): the selection, or the word around a collapsed caret inside one
 * (without its trailing spaces). null: a caret between words.
 */
export function target(d, a, b) {
  if (!samePos(a, b)) return [a, b];
  const p = d.paraAt(a);
  if (!p) return null;
  const before = P.charBefore(p.text, a.off);
  const after = P.charAt(p.text, a.off);
  if (isW(before) && isW(after)) {
    const [x, y] = P.wordAt(p, a.off);
    const word = p.text.slice(x, y).replace(/\s+$/u, '');
    return [{...a, path: [...a.path], off: x}, {...a, path: [...a.path], off: x + word.length}];
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Pending typing formatting (session view state)

/** The pending formatting, when the selection is still the caret it was set at. */
export function pendingProps(ctx, d) {
  const pf = ctx.view?.pendingFormat;
  if (!pf || typeof pf !== 'object' || !pf.props) return null;
  const [a, b] = ordered(ctx, d);
  if (!samePos(a, b)) return null;
  try { return addressOf(d.content, a) === pf.at ? {...pf.props} : null; } catch { return null; }
}

/** Remember `props` as what typing at the caret `at` will get. */
export function setPending(ctx, d, at, props) {
  ctx.setView({pendingFormat: {at: addressOf(d.content, at), props: {...props}}});
}

/** Forget the pending formatting (a paragraph style resets it, as upstream `s.pending = None`). */
export function clearPending(ctx) {
  if (ctx.view?.pendingFormat) ctx.setView({pendingFormat: null});
}

/** The caret's formatting, as Reveal Formatting shows it (`caret_props`). */
export function caretProps(ctx, d) {
  const pend = pendingProps(ctx, d);
  if (pend) return pend;
  const f = focusOf(ctx, d);
  const p = d.paraAt(f);
  if (!p) return {};
  const props = P.propsAt(p, f.off) ?? {};
  const insideLink = !!props.link && f.off > 0 && f.off < p.text.length && P.propsOfChar(p, f.off)?.link === props.link;
  const out = charWithoutSymbol(props.link && !insideLink ? charUnlinked(props) : {...props});
  if (out.style === 'FootnoteReference' || out.style === 'EndnoteReference') delete out.style;
  return out;
}

/** The formatting typed text gets (`typing_props`). */
export function typingProps(ctx, d) {
  const [a, b] = ordered(ctx, d);
  const p = d.paraAt(a);
  let c;
  if (p && !pendingProps(ctx, d) && !samePos(a, b) && a.off < p.text.length) {
    const props = P.propsOfChar(p, a.off) ?? {};
    c = props.link ? charUnlinked(props) : {...props};
    if (c.style === 'FootnoteReference' || c.style === 'EndnoteReference') delete c.style;
  } else c = caretProps(ctx, d);
  delete c.rtl;
  return c;
}

// ---------------------------------------------------------------------------------------------
// Character formatting

/** The result upstream commands give (`sel_result`): the selection's ends as addresses. */
export function selResult(ctx) {
  const all = ctx.model.selection(ctx);
  const r = all[ctx.selection?.primary ?? 0] ?? all[0];
  return {anchor: ctx.model.addressOf(ctx, r.anchor), focus: ctx.model.addressOf(ctx, r.focus)};
}

/**
 * Apply `f` (mutates or returns CharProps) to the target, or with a caret between words to the
 * pending formatting and an empty paragraph's mark (`apply`). Returns the selection result plus
 * `pending: true` when only the pending formatting changed.
 */
export function applyChar(ctx, f) {
  need(ctx);
  let pending = false;
  ctx.model.edit(ctx, d => {
    const segs = segments(ctx, d);
    if (segs.length > 1) {
      // A column of cells: each cell's range, and an empty cell's paragraph mark.
      for (const [x, y] of segs) {
        if (!samePos(x, y)) { d.formatRange(x, y, f); continue; }
        const p = d.paraAt(x);
        if (p && p.text.length === 0) {
          const para = d.paraMut(x.story, x.path);
          const mark = P.applyProps(P.markOf(para), f);
          if (Object.keys(mark).length) para.mark = mark; else delete para.mark;
        }
      }
      return;
    }
    const [a, b] = ordered(ctx, d);
    const t = target(d, a, b);
    if (t) { d.formatRange(t[0], t[1], f); return; }
    const pend = P.applyProps(typingProps(ctx, d), f);
    setPending(ctx, d, a, pend);
    pending = true;
    // An empty paragraph's mark takes the formatting too (so it shows the new size).
    const p = d.paraAt(a);
    if (p && p.text.length === 0) {
      const para = d.paraMut(a.story, a.path);
      const mark = P.applyProps(P.markOf(para), f);
      if (Object.keys(mark).length) para.mark = mark; else delete para.mark;
    }
  });
  return {...selResult(ctx), ...(pending ? {pending: true} : {})};
}

/** Resolved formatting of every run the target touches, capped (`resolved`). */
export function resolvedRuns(ctx, d) {
  const sheet = d.styles;
  const out = [];
  const segs = segments(ctx, d);
  if (segs.length > 1) {
    for (const [x, y] of segs) {
      const p = d.paraAt(x);
      if (!p) continue;
      if (samePos(x, y)) { if (!p.text.length) out.push(resolveChar(sheet, p.props?.style ?? null, P.markOf(p))); continue; }
      for (const path of d.pathsBetween(x, y)) {
        const q = d.para(x.story, path);
        if (!q) continue;
        const from = samePath(path, x.path) ? x.off : 0;
        const to = samePath(path, y.path) ? y.off : q.text.length;
        for (const [s0, e, c] of P.runRanges(q)) if (e > from && s0 < to) out.push(resolveChar(sheet, q.props?.style ?? null, c));
      }
      if (out.length > STATE_RUN_CAP) break;
    }
    if (out.length) return out;
  }
  const [a, b] = ordered(ctx, d);
  const t = target(d, a, b);
  if (!t) {
    const p = d.paraAt(focusOf(ctx, d));
    out.push(resolveChar(sheet, p?.props?.style ?? null, typingProps(ctx, d)));
    return out;
  }
  const [x, y] = t;
  for (const path of d.pathsBetween(x, y)) {
    const p = d.para(x.story, path);
    if (!p) continue;
    const from = samePath(path, x.path) ? x.off : 0;
    const to = samePath(path, y.path) ? y.off : p.text.length;
    for (const [s, e, c] of P.runRanges(p)) if (e > from && s < to) out.push(resolveChar(sheet, p.props?.style ?? null, c));
    if (out.length > STATE_RUN_CAP) break;
  }
  if (!out.length) {
    const p = d.paraAt(x);
    out.push(resolveChar(sheet, p?.props?.style ?? null, typingProps(ctx, d)));
  }
  return out;
}

/** Open a read-only Document over the context (state functions). */
export function peek(ctx) { return ctx.model.open(ctx); }

// ---------------------------------------------------------------------------------------------
// Paragraph formatting

/**
 * The paragraphs the selection covers (`selected_paths`): those between its ends, not the next
 * one when the selection ends at its start (#418).
 */
export function selectedPaths(ctx, d) {
  const segs = segments(ctx, d);
  if (segs.length > 1) {
    // A column of cells: each cell's paragraphs once, in document order, in the first range's story.
    const story = segs[0][0].story;
    const seen = new Set();
    const out = [];
    for (const [x, y] of segs) {
      if (x.story !== story) continue;
      for (const path of d.paraPathsIn(x, y)) {
        const k = path.join('.');
        if (!seen.has(k)) { seen.add(k); out.push(path); }
      }
    }
    return out;
  }
  const [a, b] = ordered(ctx, d);
  return d.paraPathsIn(a, b);
}

/** Resolved paragraph formatting at the caret (`cur`), the last covered paragraph for a selection ending at the next one's start. */
export function curPara(ctx, d) {
  const [a, b] = ordered(ctx, d);
  let at = focusOf(ctx, d);
  const paths = d.paraPathsIn(a, b);
  const last = paths[paths.length - 1];
  if (last && !samePath(last, at.path) && samePos(at, b)) at = {...at, path: last, off: 0};
  const p = d.paraAt(at);
  return resolvePara(d.styles, p?.props ?? {});
}

/** The paragraph at the caret (focus), or null. */
export function focusPara(ctx, d) { return d.paraAt(focusOf(ctx, d)); }

/** Apply `f` to the paragraph properties of every selected paragraph (`fmt`). */
export function fmtParas(d, story, paths, f) {
  for (const path of paths) {
    const para = d.paraMut(story, path);
    const next = P.applyProps(P.paraPropsOf(para), f);
    if (Object.keys(next).length) para.props = next; else delete para.props;
  }
}

/** `fmt` over the selection in one edit; returns the selection result. */
export function fmt(ctx, f) {
  need(ctx);
  ctx.model.edit(ctx, d => {
    const [a] = ordered(ctx, d);
    fmtParas(d, a.story, selectedPaths(ctx, d), f);
  });
  return selResult(ctx);
}

// ---------------------------------------------------------------------------------------------
// Revisions (Track Changes)

/** Revision dates are whole seconds, as Word writes them. */
export const isoNow = ctx => new Date(ctx.host?.now?.() ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The author tracked changes are recorded under (File › Options › User name). */
export function author(prefs) {
  const p = prefs ?? {};
  const name = p.userName ?? p.user?.name ?? p.author;
  return typeof name === 'string' && name.trim() ? name.trim() : 'Author';
}

/** A revision record for the current author (`new_revision`): reuses one of the same kind, author and second. */
export function newRevision(ctx, d, kind) {
  const date = isoNow(ctx);
  const who = author(ctx.prefs);
  const list = d.content.revisions ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r.kind === kind && r.author === who && r.date === date && !r.moveName) return i;
  }
  d.updateField('revisions', rs => [...(rs ?? []), {kind, author: who, date}]);
  return (d.content.revisions ?? []).length - 1;
}

/** Same container (story and parent path) for two positions. */
export const sameContainer = (a, b) => a.story === b.story && samePath(pathParent(a.path), pathParent(b.path));

