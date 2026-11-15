// View tab: the workbook views (Normal, Page Break Preview), Show (Gridlines, Headings, Formula Bar), Zoom to
// Selection, Freeze Panes (all four), Split and Custom Views. Zoom and 100% are the shared commands in
// core/common/commands/view.mjs (view state, never undoable, saved with the file by model/index.mjs
// fileForSave as the active sheet's zoomScale).
//
// Translated from gridcraft crates/engine/src/cmd/view.rs (`freeze_panes`, `set_freeze`, `sheet_flag`,
// `zoom_selection`, `view.formulaBar`) and crates/engine/src/cmd/extra/window.rs (`set_view`,
// `custom_views`, `split`) at fb1e59f. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Differences kept on purpose, all about where the state lives (the kernel keeps the view of a
// document in the session, the file only when it is saved):
//   - the view mode (Normal / Page Break Preview) and the zoom are the session's view and go into the
//     active sheet of the file when it is saved (`sheetView view`, `zoomScale`), neither marks the
//     workbook changed;
//   - Custom Views are kept on the workbook (content.customViews), not as a hidden defined name.
// Not translated: Page Layout view and Ruler (the paper view with rulers), and the window commands
// (New Window, Arrange All, Hide, Unhide, Switch Windows, View Side by Side, Synchronous Scrolling,
// Reset Window Position): the application shows one workbook per tab, not several windows.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {rangeA1, parseRange} from '../lib/addr.mjs';
import {hasDoc, gridSel, targetSheet, requireSchema2, setGridSelection, selectionAt} from '../lib/edit-targets.mjs';
import {setIn, deleteIn} from '../lib/edit-parts.mjs';
import {bad, baseDoc} from '../lib/data-common.mjs';
import {colLeft, rowTop, freeze as freezeOf} from '../model/sheet.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: 'fb1e59f', files: ['crates/engine/src/cmd/view.rs', 'crates/engine/src/cmd/extra/window.rs', 'crates/ui-egui/src/ribbon/view.rs']};
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const CELL = s.optional(s.string({min: 1, max: 40}));

/** The sheet a command acts on (`sheet`, else the active one), and its content. */
function target(ctx, p) {
  const content = baseDoc(ctx);
  const si = p?.sheet !== undefined ? targetSheet(ctx, p) : gridSel(ctx).sheet;
  requireSchema2(ctx, si);
  return {content, si, sheet: content.sheets[si]};
}

/** Gridlines / Headings: `on`, else the other state (upstream `sheet_flag`; stored false only when off). */
const showFlag = key => (ctx, p) => {
  const {si, sheet} = target(ctx, p);
  const on = typeof p.on === 'boolean' ? p.on : sheet[key] === false;
  if (on) deleteIn(ctx.change, ['sheets', si, key]); else setIn(ctx.change, ['sheets', si, key], false);
  return {on};
};
const showState = key => ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: ctx.doc.sheets[gridSel(ctx).sheet]?.[key] !== false} : hasDoc(ctx));

function setFreeze(ctx, si, at) {
  if (!at || (at[0] <= 0 && at[1] <= 0)) deleteIn(ctx.change, ['sheets', si, 'freeze']); else setIn(ctx.change, ['sheets', si, 'freeze'], {rows: at[0], cols: at[1]});
  return {freeze: at && (at[0] > 0 || at[1] > 0) ? at : null};
}

/** Freeze Panes: with a frozen sheet and no `cell`, unfreezes; else freezes the rows above and the columns left of `cell` (default the active cell). */
function freezePanes(ctx, p) {
  const {si, sheet} = target(ctx, p);
  const f = freezeOf(sheet);
  if ((f.rows > 0 || f.cols > 0) && p.cell === undefined) return setFreeze(ctx, si, null);
  let at;
  if (p.cell !== undefined) {
    const r = parseRange(String(p.cell).replace(/\$/g, ''));
    if (!r) throw bad('view.freezePanes', `not a cell: \`${p.cell}\``);
    at = r.start;
  } else if (si === gridSel(ctx).sheet) at = gridSel(ctx).active;
  else throw bad('view.freezePanes', 'missing `cell`: the selection is on the active sheet');
  return setFreeze(ctx, si, [at.row, at.col]);
}
const frozen = ctx => {
  if (!hasDoc(ctx).enabled) return hasDoc(ctx);
  const f = freezeOf(ctx.doc.sheets[gridSel(ctx).sheet]);
  return {enabled: true, checked: f.rows > 0 || f.cols > 0};
};

/** Zoom to Selection (zoom_selection): the largest zoom at which the selection fits `viewWidth` x `viewHeight` (default 1200 x 700 px), 10 to 400, rounded down. */
function zoomToSelection(ctx, p) {
  const {sheet} = target(ctx, {});
  const sel = gridSel(ctx);
  const r = sel.ranges[sel.ranges.length - 1];
  const w = Math.max(1, colLeft(sheet, Math.min(16384, r.end.col + 1)) - colLeft(sheet, r.start.col));
  const h = Math.max(1, rowTop(sheet, Math.min(1048576, r.end.row + 1)) - rowTop(sheet, r.start.row));
  const vw = Number.isFinite(p.viewWidth) ? p.viewWidth : 1200, vh = Number.isFinite(p.viewHeight) ? p.viewHeight : 700;
  const zoom = Math.floor(Math.min(400, Math.max(10, Math.min(vw / w, vh / h) * 100)));
  ctx.setView({zoom, fit: null});
  return {zoom};
}

/** Normal and Page Break Preview (set_view): the view of the window; Normal is the default and is not stored. */
const setMode = mode => ctx => { ctx.setView({mode}); return {view: mode ?? 'normal'}; };

// ---------------------------------------------------------------- custom views

/** The saved views, {name: {sheet, selection, zoom, freeze}} (the stash of upstream `custom_views`). */
const viewsOf = content => (content.customViews && typeof content.customViews === 'object' ? content.customViews : {});

/** View > Custom Views: save the active sheet, selection, zoom and frozen panes under a name, show one, or delete one; returns every saved view. */
function customViews(ctx, p) {
  const content = baseDoc(ctx);
  const views = {...viewsOf(content)};
  const sel = gridSel(ctx);
  if (typeof p.save === 'string') {
    const name = p.save.trim();
    if (!name) throw bad('view.customViews', 'give the view a name');
    const sheet = content.sheets[sel.sheet];
    const f = freezeOf(sheet);
    views[name] = {sheet: sheet.id, selection: rangeA1(sel.ranges[sel.ranges.length - 1]), zoom: ctx.view?.zoom ?? 100, freeze: f.rows > 0 || f.cols > 0 ? [f.rows, f.cols] : null};
    setIn(ctx.change, ['customViews'], views);
  } else if (typeof p.show === 'string') {
    const v = views[p.show];
    if (!v) throw bad('view.customViews', 'no such view');
    const si = content.sheets.findIndex(x => x.id === v.sheet);
    if (si >= 0) {
      const r = parseRange(v.selection);
      const at = r ? r.start : {row: 0, col: 0};
      setGridSelection(ctx, r ? {...selectionAt(si, at), anchor: r.start, active: r.start, ranges: [r]} : selectionAt(si, at));
    }
    if (Number.isFinite(v.zoom)) ctx.setView({zoom: Math.min(400, Math.max(10, v.zoom)), fit: null});
    const at = si >= 0 ? si : sel.sheet;
    setFreeze(ctx, at, Array.isArray(v.freeze) ? v.freeze : null);
  } else if (typeof p.delete === 'string') {
    delete views[p.delete];
    if (Object.keys(views).length) setIn(ctx.change, ['customViews'], views); else deleteIn(ctx.change, ['customViews']);
  }
  return views;
}

export default defineCommands({
  family: 'view',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'view.normal', label: 'Normal', risk: 'read', effect: 'view', description: 'Show the sheet in Normal view.', params: s.object({}),
      state: ctx => ({...hasDoc(ctx), checked: !ctx.view?.mode}), run: setMode(null)},
    {id: 'view.pageBreakPreview', label: 'Page Break Preview', risk: 'read', effect: 'view',
      description: 'Show the pages as they print: the printed area bright and the rest grey, each page outlined in blue with its number behind the cells.', params: s.object({}),
      state: ctx => ({...hasDoc(ctx), checked: ctx.view?.mode === 'pageBreakPreview'}), run: setMode('pageBreakPreview')},
    {id: 'view.gridlines', label: 'Gridlines', risk: 'edit', description: 'Show or hide the gridlines of the sheet (`on`, default: the other state).', params: s.object({sheet: SHEET, on: s.optional(s.boolean())}),
      state: showState('showGridlines'), run: showFlag('showGridlines')},
    {id: 'view.headings', label: 'Headings', risk: 'edit', description: 'Show or hide the row and column headings of the sheet (`on`, default: the other state).', params: s.object({sheet: SHEET, on: s.optional(s.boolean())}),
      state: showState('showHeadings'), run: showFlag('showHeadings')},
    {id: 'view.formulaBar', label: 'Formula Bar', risk: 'edit', effect: 'prefs', scope: 'app', description: 'Show or hide the formula bar (an application option; `on`, default: the other state).', params: s.object({on: s.optional(s.boolean())}),
      state: ctx => ({enabled: true, checked: ctx.prefs?.formulaBar !== false}),
      run: (ctx, p) => { const on = typeof p.on === 'boolean' ? p.on : ctx.prefs?.formulaBar === false; ctx.updatePrefs({formulaBar: on}); return {on}; }},
    {id: 'view.zoomToSelection', label: 'Zoom to Selection', risk: 'read', effect: 'view', description: 'Zoom so the selected cells fill the grid (10 to 400%).',
      params: s.object({viewWidth: s.optional(s.number({min: 1})), viewHeight: s.optional(s.number({min: 1}))}), state: hasDoc, run: zoomToSelection},
    {id: 'view.freezePanes', label: 'Freeze Panes', risk: 'edit',
      description: 'Freeze the rows above and the columns left of `cell` (default: the active cell); without `cell`, a frozen sheet is unfrozen.', params: s.object({sheet: SHEET, cell: CELL}),
      state: frozen, run: freezePanes},
    {id: 'view.freezeTopRow', label: 'Freeze Top Row', risk: 'edit', description: 'Keep the top row visible while scrolling.', params: s.object({sheet: SHEET}), state: hasDoc,
      run: (ctx, p) => setFreeze(ctx, target(ctx, p).si, [1, 0])},
    {id: 'view.freezeFirstColumn', label: 'Freeze First Column', risk: 'edit', description: 'Keep the first column visible while scrolling.', params: s.object({sheet: SHEET}), state: hasDoc,
      run: (ctx, p) => setFreeze(ctx, target(ctx, p).si, [0, 1])},
    {id: 'view.unfreezePanes', label: 'Unfreeze Panes', risk: 'edit', description: 'Unfreeze every row and column.', params: s.object({sheet: SHEET}), state: hasDoc,
      run: (ctx, p) => setFreeze(ctx, target(ctx, p).si, null)},
    {id: 'view.split', label: 'Split', risk: 'edit', description: 'Toggle a split at the active cell (shown as frozen panes).', params: s.object({}),
      state: frozen, run: ctx => freezePanes(ctx, {})},
    {id: 'view.customViews', label: 'Custom Views', risk: 'edit', dialog: 'dialog.customViews',
      description: 'Save the active sheet, selection, zoom and frozen panes under a name (`save`), show a saved view (`show`) or delete one (`delete`); returns the saved views.',
      params: s.object({save: s.optional(s.string({min: 1, max: 255})), show: s.optional(s.string({min: 1, max: 255})), delete: s.optional(s.string({min: 1, max: 255}))}),
      state: hasDoc, run: customViews},
  ],
});
