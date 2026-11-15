// Layout › Columns › More Columns…: Word's Columns dialog (Presets, Number of columns, Line
// between, Width and spacing per column, Equal column width, Preview, Apply to). OK runs one
// layout.columns.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_insert/columns.rs (`MIN_COL_PT`,
// `ColumnsForm`: `read`, `spacing`, `even_out`, `set_count`, `preset`, `current_preset`,
// `rebalance`, `params`; `columns_ui`'s Apply to choices) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. Lengths are in inches.
//
// The form is plain values: count, equal, separator, applyTo, and `cols` ([[width, spacing], …]).
// `editColumn` is the per-column edit (the view's width and spacing boxes); `derive` applies a
// preset, a new count or Equal column width, so the bridge and the view drive the same thing.

import {defineDialog} from '../../kernel/dialog.mjs';
import {caretSection, selectionSectionable} from '../commands/page.mjs';
import {textWidth} from '../model/section.mjs';

const K = 72;
/** Narrowest column, points (the engine refuses narrower ones). */
export const MIN_COL_PT = 18;
const MIN_W = MIN_COL_PT / K;
const r2 = x => Math.round(x * 10000) / 10000;
export const PRESETS = Object.freeze(['one', 'two', 'three', 'left', 'right']);
export const APPLY = Object.freeze({section: 'This section', document: 'Whole document', forward: 'This point forward', selection: 'Selected text'});

/** Spacing the first column has (or the default 0.5"). */
const spacingOf = f => f.cols[0]?.[1] ?? 36 / K;

/** Equal widths for `count` columns sharing the first column's spacing (even_out). */
export function evenOut(f) {
  const n = Math.max(1, Math.min(12, f.count));
  const room = Math.max(0, f.textWidth - MIN_W * n);
  const sp = n > 1 ? Math.max(0, Math.min(room / (n - 1), spacingOf(f))) : spacingOf(f);
  const w = (f.textWidth - sp * (n - 1)) / n;
  const cols = Array.from({length: n}, (_, i) => [r2(w), i + 1 < n ? r2(sp) : 0]);
  if (n === 1) cols[0][1] = r2(sp);
  return {...f, count: n, cols};
}

export const setCount = (f, n) => evenOut({...f, count: Math.max(1, Math.min(12, Math.trunc(n) || 1))});

/** One, Two, Three, Left or Right (preset). */
export function applyPreset(f, p) {
  const sp = 36 / K;
  if (p === 'left' || p === 'right') {
    const narrow = (f.textWidth - sp) / 3, wide = (f.textWidth - sp) * 2 / 3;
    return {...f, count: 2, equal: false, cols: p === 'left' ? [[r2(narrow), sp], [r2(wide), 0]] : [[r2(wide), sp], [r2(narrow), 0]]};
  }
  const count = p === 'two' ? 2 : p === 'three' ? 3 : 1;
  const cols = f.cols.length ? f.cols.map((c, i) => (i === 0 ? [c[0], sp] : c)) : [[0, sp]];
  return evenOut({...f, count, equal: true, cols});
}

/** The preset the settings match, if any (current_preset). */
export function currentPreset(f) {
  const near = (a, b) => Math.abs(a - b) < 0.02;
  if (f.equal || f.count === 1) return f.count === 1 ? 'one' : f.count === 2 ? 'two' : f.count === 3 ? 'three' : null;
  const [a, b] = [f.cols[0]?.[0], f.cols[1]?.[0]];
  if (a === undefined || b === undefined) return null;
  if (f.count === 2 && near(a * 2, b)) return 'left';
  if (f.count === 2 && near(b * 2, a)) return 'right';
  return null;
}

/**
 * After column `i`'s width or spacing changed: the next column (the one before, for the last)
 * takes up the difference so the columns fill the text width (rebalance).
 */
export function rebalance(f, i) {
  const cols = f.cols.map(c => [...c]);
  const n = cols.length;
  if (f.equal) {
    if (cols[i] && n > 1) {
      const [w, sp0] = cols[i];
      const sp = i === 0 && Math.abs(w - (cols[1]?.[0] ?? w)) > 1e-4 ? (f.textWidth - w * n) / (n - 1) : sp0;
      cols[0][1] = Math.max(0, sp);
    }
    return evenOut({...f, cols});
  }
  if (n < 2) return {...f, cols};
  cols[n - 1][1] = 0;
  const j = i + 1 < n ? i + 1 : Math.max(0, i - 1);
  const total = cols.reduce((a, [w, s]) => a + w + s, 0);
  const excess = total - f.textWidth;
  let short = 0;
  if (cols[j]) { cols[j][0] -= excess; short = Math.max(0, MIN_W - cols[j][0]); cols[j][0] = Math.max(MIN_W, cols[j][0]); }
  // The neighbour can't shrink further: take the rest back from the edited column.
  if (short > 0 && cols[i]) {
    const fromW = Math.min(short, Math.max(0, cols[i][0] - MIN_W));
    cols[i][0] -= fromW;
    cols[i][1] = Math.max(0, cols[i][1] - (short - fromW));
  }
  return {...f, cols: cols.map(([w, s]) => [r2(w), r2(s)])};
}

/** Column `i`'s width and/or spacing typed in the view: then rebalance. */
export function editColumn(f, i, width, spacing) {
  if (!f.cols[i]) return f;
  if (f.equal && i > 0) return f;
  const cols = f.cols.map(c => [...c]);
  if (typeof width === 'number' && Number.isFinite(width)) cols[i][0] = Math.max(MIN_W, Math.min(f.textWidth, width));
  if (typeof spacing === 'number' && Number.isFinite(spacing)) cols[i][1] = Math.max(0, Math.min(f.textWidth, spacing));
  return rebalance({...f, cols}, i);
}

/** The `layout.columns` parameters (params). */
export function columnsParams(f) {
  const r = x => Math.round(x * K * 100) / 100;
  if (f.equal || f.count <= 1) return {count: f.count, space: r(spacingOf(f)), separator: !!f.separator, apply: f.applyTo};
  return {widths: f.cols.map(([w, s]) => [r(w), r(s)]), separator: !!f.separator, apply: f.applyTo};
}

const formOf = v => ({count: v.count, equal: !!v.equal, cols: Array.isArray(v.cols) ? v.cols : [], separator: !!v.separator, applyTo: v.applyTo, textWidth: v._textWidth});
const valuesOf = f => ({count: f.count, equal: f.equal, cols: f.cols, presets: currentPreset(f)});

/** The dialog's values for the caret's section (read). */
export function readColumns(ctx) {
  const {d, x} = caretSection(ctx);
  const c = x.columns ?? {count: 1, space: 36, separator: false, widths: []};
  const count = Math.max(1, Math.min(12, c.count ?? 1));
  const sections = d.sections().length > 1;
  const all = ctx.model.selection(ctx);
  const r = all[ctx.selection?.primary ?? 0] ?? all[0];
  const selection = selectionSectionable({anchor: r.anchor, focus: r.focus});
  const applyTo = selection ? 'selection' : sections ? 'section' : 'document';
  let f = {count, equal: true, cols: [], separator: !!c.separator, applyTo, textWidth: textWidth(x) / K};
  if ((c.widths ?? []).length === count && count > 1) f = {...f, equal: false, cols: c.widths.map(([w, s]) => [r2(w / K), r2(s / K)])};
  else f = evenOut({...f, cols: Array.from({length: count}, () => [0, Math.max(0, c.space ?? 36) / K])});
  const choices = [...(sections ? ['section'] : []), 'document', 'forward', ...(selection ? ['selection'] : [])];
  return {...valuesOf(f), separator: f.separator, applyTo, _textWidth: f.textWidth, _applyChoices: choices};
}

export default defineDialog({
  id: 'dialog.columns',
  title: 'Columns',
  command: 'layout.columns',
  init: ctx => readColumns(ctx),
  derive(v, changed) {
    let f = formOf(v);
    if (changed.includes('presets') && v.presets) f = applyPreset(f, v.presets);
    else if (changed.includes('count')) f = setCount(f, v.count);
    else if (changed.includes('equal')) f = f.equal ? evenOut(f) : f;
    else if (changed.includes('cols')) f = f.equal ? evenOut(f) : rebalance(f, 0);
    else return {};
    return valuesOf(f);
  },
  validate(v) {
    const out = [];
    if (!Number.isInteger(v.count) || v.count < 1 || v.count > 12) out.push({field: 'count', message: 'Enter a number from 1 to 12.'});
    if (!Object.hasOwn(APPLY, v.applyTo)) out.push({field: 'applyTo', message: 'Choose where to apply the columns.'});
    if (Array.isArray(v.cols) && v.cols.some(([w]) => !(w >= MIN_W - 1e-6))) out.push({field: 'cols', message: 'Each column must be at least 0.25" wide.'});
    return out;
  },
  preview(_ctx, v) {
    const f = formOf(v);
    return {textWidth: f.textWidth, cols: f.cols, separator: f.separator};
  },
  toCommand(v) {
    return {batch: [{command: 'layout.columns', params: columnsParams(formOf(v))}]};
  },
});
