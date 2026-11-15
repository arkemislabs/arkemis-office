// Find and Replace (Ctrl+F, Ctrl+H): Find Next, Find All, Replace, Replace All, within the sheet
// or the workbook, by rows or by columns, looking in formulas or values (Excel: notes, comments).
// Translated from gridcraft crates/engine/src/cmd/edit/find.rs (`find`, `replace`) and
// crates/ui-egui/src/dialogs/find.rs (what the dialog's buttons run) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Find is view state (it moves the selection, switching sheet when the hit is on another one);
// Find All keeps its list in the document's view state for the dialog (`view.findResults`).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {a1, parseRange} from '../../lib/addr.mjs';
import {display, fromJSONValue} from '../../lib/value.mjs';
import {forEachCell, writeCell} from '../../model/store.mjs';
import {inputToCell} from '../../model/input.mjs';
import {matches, replaceCi} from '../../lib/edit-find.mjs';
import {cellText, formulaHidden} from '../../lib/edit-clip.mjs';
import {hasDoc, gridSel, bad, failed, setGridSelection, selectionAt, sheetPath, baseDoc} from '../../lib/edit-targets.mjs';
import {guardWrite} from './cell.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b',
  files: ['crates/engine/src/cmd/edit.rs', 'crates/engine/src/cmd/edit/find.rs', 'crates/ui-egui/src/dialogs/find.rs']};

/** Cell::input_text: `=formula`, else the value as typed (General, full precision). */
export function inputText(cell) {
  if (!cell) return '';
  if (cell.f !== undefined) return `=${cell.f}`;
  const v = fromJSONValue(cell.v);
  return v === null || v === undefined ? '' : display(v);
}
const noteText = n => (typeof n === 'string' ? n : typeof n?.text === 'string' ? n.text
  : Array.isArray(n?.replies) ? [n.text ?? '', ...n.replies.map(r => r?.text ?? '')].join('\n') : '');

/** Every hit: [{si, row, col, text}] in the order Find walks (by rows, or by columns). */
export function findHits(content, activeSi, p) {
  const what = p.what;
  const matchCase = !!p.matchCase, whole = !!p.wholeCell;
  const lookIn = p.lookIn ?? 'formulas';
  const byCols = !!p.byColumns;
  const sheets = p.within === 'workbook' ? content.sheets.map((_, i) => i) : [activeSi];
  const hits = [];
  for (const si of sheets) {
    const sh = content.sheets[si];
    if (!sh) continue;
    const list = [];
    if (lookIn === 'notes' || lookIn === 'comments') {
      // Excel: Look in Notes / Comments searches the note or comment thread text.
      for (const [k, n] of Object.entries(sh[lookIn] ?? {})) {
        const c = parseRange(k)?.start;
        if (!c) continue;
        const text = noteText(n);
        if (matches(text, what, matchCase, whole)) list.push({si, row: c.row, col: c.col, text});
      }
      list.sort((x, y) => x.row - y.row || x.col - y.col);
    } else {
      forEachCell(sh, 0, 0, 1_048_575, 16_383, (row, col, cell) => {
        const text = lookIn === 'values' || cell.f === undefined || formulaHidden(content, si, row, col) ? cellText(content, si, row, col) : inputText(cell);
        if (matches(text, what, matchCase, whole)) list.push({si, row, col, text});
      });
    }
    if (byCols) list.sort((x, y) => x.col - y.col || x.row - y.row);
    hits.push(...list);
  }
  return hits;
}

function find(ctx, p) {
  const what = typeof p.what === 'string' ? p.what : '';
  if (!what) throw bad('edit.find', 'missing `what`');
  const sel = gridSel(ctx);
  const byCols = p.byColumns ?? p.search === 'columns';
  const q = {...p, byColumns: byCols};
  const hits = findHits(ctx.doc, sel.sheet, q);
  if (!hits.length) {
    if (p.all) ctx.setView({findResults: {what, count: 0, results: []}});
    throw failed(`We couldn't find what you were looking for: ${what}`);
  }
  if (p.all) {
    const results = hits.map(h => ({sheet: ctx.doc.sheets[h.si].name, cell: a1(h.row, h.col), value: h.text, address: `${sheetPath(ctx.doc, h.si)}/${a1(h.row, h.col)}`}));
    ctx.setView({findResults: {what, count: results.length, results}});
    return {count: results.length, results};
  }
  // Next hit after the active cell.
  const key = (si, row, col) => (byCols ? [si, col, row] : [si, row, col]);
  const cur = key(sel.sheet, sel.active.row, sel.active.col);
  const gt = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const next = hits.find(h => gt(key(h.si, h.row, h.col), cur) > 0) ?? hits[0];
  setGridSelection(ctx, selectionAt(next.si, {row: next.row, col: next.col}));
  return {cell: a1(next.row, next.col), sheet: next.si, value: next.text, count: hits.length, address: `${sheetPath(ctx.doc, next.si)}/${a1(next.row, next.col)}`};
}

function replace(ctx, p) {
  const what = typeof p.what === 'string' ? p.what : '';
  const withText = typeof p.with === 'string' ? p.with : '';
  if (!what) throw bad('edit.replace', 'missing `what`');
  baseDoc(ctx);
  const matchCase = !!p.matchCase, whole = !!p.wholeCell;
  const all = p.all ?? true;
  const sel = gridSel(ctx);
  const active = sel.active;
  const sheets = p.within === 'workbook' ? ctx.doc.sheets.map((_, i) => i) : [sel.sheet];
  let n = 0;
  for (const si of sheets) {
    const cells = [];
    forEachCell(ctx.doc.sheets[si], 0, 0, 1_048_575, 16_383, (row, col, cell) => { cells.push([row, col, inputText(cell)]); });
    for (const [row, col, text] of cells) {
      if (!all && (row !== active.row || col !== active.col)) continue;
      if (!matches(text, what, matchCase, whole)) continue;
      const next = whole ? withText : matchCase ? text.split(what).join(withText) : replaceCi(text, what, withText);
      let cell;
      try { cell = inputToCell(ctx.change, ctx.doc, si, row, col, next); } catch { cell = {v: next}; }
      guardWrite(ctx, si, row, col, cell);
      writeCell(ctx.change, ctx.doc, si, row, col, cell);
      n++;
    }
  }
  return {replaced: n};
}

const FIND_PARAMS = {
  what: s.string({min: 1, max: 255, description: 'What to find: text, * and ? wildcards, ~ escapes'}),
  matchCase: s.optional(s.boolean()), wholeCell: s.optional(s.boolean()),
  within: s.optional(s.enum(['sheet', 'workbook'])),
};

export default defineCommands({
  family: 'edit/find',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'edit.find', label: 'Find…', shortcut: ['Mod+F', 'Shift+F5'], risk: 'read', effect: 'view', undo: 'none', dialog: 'dialog.find', repeatable: false,
      description: 'Find the next cell after the active one whose formula (or shown value) matches; all: true lists every match.',
      params: s.object({
        ...FIND_PARAMS,
        lookIn: s.optional(s.enum(['formulas', 'values', 'notes', 'comments'])),
        byColumns: s.optional(s.boolean()),
        search: s.optional(s.enum(['rows', 'columns'])),
        all: s.optional(s.boolean()),
      }),
      state: hasDoc,
      run: find,
    },
    {
      id: 'edit.replace', label: 'Replace…', shortcut: 'Mod+H', risk: 'edit', dialog: 'dialog.find',
      description: 'Replace matches in cell entries (formulas as typed); all: false replaces only the active cell when it matches.',
      params: s.object({
        ...FIND_PARAMS,
        with: s.optional(s.string({max: 32_767})),
        all: s.optional(s.boolean()),
        replace: s.optional(s.boolean({description: 'Opens Find and Replace on its Replace tab (the ribbon and Ctrl+H)'})),
      }),
      state: hasDoc,
      run: replace,
    },
  ],
});
