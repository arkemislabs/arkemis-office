// Home › Alignment: Align Left/Center/Right/Justify, Top/Middle/Bottom Align, Wrap Text, Shrink to
// Fit, Increase/Decrease Indent, Orientation, and the Merge & Center split (Merge & Center, Merge
// Across, Merge Cells, Unmerge Cells).
// Translated from gridcraft crates/engine/src/cmd/format.rs (`halign`, `valign`, `indent`,
// `orientation`, `merge`, `toggle` for wrap/shrink) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Clicking the alignment the active cell already has returns it to General, as in Excel. Merging
// keeps only the upper-left value of each merged area (Merge Across: of each row); Merge & Center
// over areas that are already merged unmerges them.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {applyStyle, activeStyle, cellsIn} from '../../lib/format-ranges.mjs';
import {RANGE, SHEET, ON, UPSTREAM_COMMIT, withDoc} from '../../lib/format-params.mjs';
import {targetRanges, areaAddress, gridSel, baseDoc, requireSchema2} from '../../lib/edit-targets.mjs';
import {parseRange, rangeA1, intersects, rangeEquals, count, isSingle, rangeOf} from '../../lib/addr.mjs';
import {writeCell} from '../../model/store.mjs';
import {mergeAt} from '../../model/sheet.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/format.rs']};
const ranges = (ctx, t) => t.areas.map(a => areaAddress(ctx.doc, t.sheet, a));
const P = s.object({range: RANGE, sheet: SHEET});
const PON = s.object({range: RANGE, sheet: SHEET, on: ON});

/** gridcraft `halign`: clicking the active alignment again returns to General. */
function halign(id, label, h, shortcut) {
  return {
    id, label, shortcut, risk: 'edit',
    description: `${label} the text of a range (default: the selection); again returns it to General.`,
    params: PON,
    state: ctx => withDoc(ctx, () => ({checked: activeStyle(ctx).align.h === h})),
    run(ctx, p) {
      const cur = activeStyle(ctx).align.h;
      const a = cur === h && p.on === undefined ? 'general' : p.on === false ? 'general' : h;
      const t = applyStyle(ctx, p, st => { st.align.h = a; });
      return {align: a, ranges: ranges(ctx, t)};
    },
  };
}
/** gridcraft `valign`. */
function valign(id, label, v) {
  return {
    id, label, risk: 'edit',
    description: `${label} the text of a range (default: the selection) in its cells.`,
    params: P,
    state: ctx => withDoc(ctx, () => ({checked: activeStyle(ctx).align.v === v})),
    run(ctx, p) {
      const t = applyStyle(ctx, p, st => { st.align.v = v; });
      return {align: v, ranges: ranges(ctx, t)};
    },
  };
}
function toggle(id, label, key, description) {
  return {
    id, label, risk: 'edit', description, params: PON,
    state: ctx => withDoc(ctx, () => ({checked: !!activeStyle(ctx).align[key]})),
    run(ctx, p) {
      const on = p.on ?? !activeStyle(ctx).align[key];
      const t = applyStyle(ctx, p, st => { st.align[key] = on; });
      return {on, ranges: ranges(ctx, t)};
    },
  };
}
/** gridcraft `indent`. */
function indent(id, label, d, shortcut) {
  return {
    id, label, shortcut, risk: 'edit',
    description: `${d > 0 ? 'Move the text away from' : 'Move the text closer to'} the cell border (one indent level).`,
    params: P,
    state: ctx => withDoc(ctx, () => ({})),
    run(ctx, p) {
      const t = applyStyle(ctx, p, st => {
        st.align.indent = Math.max(0, Math.min(250, (st.align.indent ?? 0) + d));
        if (st.align.indent > 0 && ['general', 'center', 'fill', 'justify', 'centerAcross'].includes(st.align.h)) st.align.h = 'left';
      });
      return {ranges: ranges(ctx, t)};
    },
  };
}

/** format.rs `orientation`: the stored rotation of an Orientation choice (255 = vertical text). */
export function orientationAngle(a) {
  if (typeof a === 'number' && Number.isFinite(a)) return Math.trunc(Math.max(-90, Math.min(90, a)));
  switch (a) {
    case 'vertical': return 255;
    case 'counterclockwise': return 45;
    case 'clockwise': return -45;
    case 'up': return 90;
    case 'down': return -90;
    default: return 0;
  }
}

/** gridcraft `merge`. how: center | across | cells | unmerge. */
function merge(ctx, p, how0) {
  baseDoc(ctx);
  const t = targetRanges(ctx, p);
  const si = t.sheet;
  requireSchema2(ctx, si);
  const list0 = (ctx.doc.sheets[si].merges ?? []).map(parseRange).filter(Boolean);
  const how = how0 === 'center' && t.areas.every(r => list0.some(m => rangeEquals(m, r))) ? 'unmerge' : how0;
  let list = list0;
  const clearOthers = (m) => {
    const others = cellsIn(ctx.doc.sheets[si], m.start.row, m.start.col, m.end.row, m.end.col)
      .filter(([row, col, cell]) => !(row === m.start.row && col === m.start.col) && (cell.v !== undefined || cell.f !== undefined));
    for (const [row, col, cell] of others) {
      const {v, f, a, d, ...rest} = cell;
      writeCell(ctx.change, ctx.doc, si, row, col, rest);
    }
  };
  for (const r of t.areas) {
    list = list.filter(m => !intersects(m, r));
    if (how === 'unmerge') continue;
    if (how === 'across') {
      for (let row = r.start.row; row <= r.end.row; row++) {
        const m = rangeOf(row, r.start.col, row, r.end.col);
        if (isSingle(m)) continue;
        list.push(m);
        // As below: only the first value of each row survives.
        clearOthers(m);
      }
      continue;
    }
    if (!isSingle(r)) list.push(r);
    // Only the upper-left value survives (Excel warns about this).
    if (count(r) <= 1_000_000) clearOthers(r);
  }
  const text = list.map(rangeA1);
  if (text.length) ctx.change.set(['sheets', si, 'merges'], text);
  else if (ctx.doc.sheets[si].merges !== undefined) ctx.change.delete(['sheets', si, 'merges']);
  if (how === 'center') applyStyle(ctx, p, st => { st.align.h = 'center'; });
  return {merged: how !== 'unmerge', how, ranges: ranges(ctx, t)};
}
const activeMerged = ctx => {
  const sel = gridSel(ctx);
  return !!mergeAt(ctx.doc.sheets[sel.sheet], sel.active.row, sel.active.col);
};

export default defineCommands({
  family: 'format/alignment',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    halign('home.alignLeft', 'Align Left', 'left'),
    halign('home.alignCenter', 'Center', 'center'),
    halign('home.alignRight', 'Align Right', 'right'),
    halign('home.justify', 'Justify', 'justify'),
    valign('home.alignTop', 'Top Align', 'top'),
    valign('home.alignMiddle', 'Middle Align', 'center'),
    valign('home.alignBottom', 'Bottom Align', 'bottom'),
    toggle('home.wrapText', 'Wrap Text', 'wrap', 'Wrap the text of a range (default: the selection) onto several lines in its cells.'),
    toggle('home.shrinkToFit', 'Shrink to Fit', 'shrink', 'Shrink the text of a range (default: the selection) to fit its cells.'),
    indent('home.increaseIndent', 'Increase Indent', 1, 'Ctrl+Alt+Tab'),
    indent('home.decreaseIndent', 'Decrease Indent', -1, 'Ctrl+Alt+Shift+Tab'),
    {
      id: 'home.orientation', label: 'Orientation', risk: 'edit',
      description: 'Rotate the text of a range (default: the selection): an angle from -90 to 90, or vertical, counterclockwise, clockwise, up, down.',
      params: s.object({range: RANGE, sheet: SHEET, angle: s.optional(s.union([s.number(), s.enum(['vertical', 'counterclockwise', 'clockwise', 'up', 'down'])]))}),
      state: ctx => withDoc(ctx, () => ({value: activeStyle(ctx).align.rotation ?? 0})),
      run(ctx, p) {
        const angle = orientationAngle(p.angle);
        const t = applyStyle(ctx, p, st => { st.align.rotation = angle; });
        return {angle, ranges: ranges(ctx, t)};
      },
    },
    {
      id: 'home.mergeCenter', label: 'Merge & Center', risk: 'edit',
      description: 'Merge each area of a range (default: the selection) into one cell and center it; merged areas are unmerged.',
      params: P, state: ctx => withDoc(ctx, () => ({checked: activeMerged(ctx)})), run: (ctx, p) => merge(ctx, p, 'center'),
    },
    {id: 'home.mergeAcross', label: 'Merge Across', risk: 'edit', description: 'Merge the cells of each row of a range (default: the selection).',
      params: P, state: ctx => withDoc(ctx, () => ({})), run: (ctx, p) => merge(ctx, p, 'across')},
    {id: 'home.mergeCells', label: 'Merge Cells', risk: 'edit', description: 'Merge each area of a range (default: the selection) into one cell, without centering.',
      params: P, state: ctx => withDoc(ctx, () => ({})), run: (ctx, p) => merge(ctx, p, 'cells')},
    {id: 'home.unmergeCells', label: 'Unmerge Cells', risk: 'edit', description: 'Split the merged cells of a range (default: the selection) back into cells.',
      params: P, state: ctx => withDoc(ctx, () => ({})), run: (ctx, p) => merge(ctx, p, 'unmerge')},
  ],
});
