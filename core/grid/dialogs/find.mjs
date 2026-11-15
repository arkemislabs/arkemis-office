// Find and Replace dialog model (Find Next / Find All run edit.find, Replace / Replace All run
// edit.replace, Close cancels).
// Translated from gridcraft crates/ui-egui/src/dialogs/find.rs (`find`: the Find and Replace tabs,
// Match case, Match entire cell contents, Within, the buttons and what each runs, the results
// list "<n> cell(s) found") at 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's Search
// (By Rows / By Columns) and Look in (Formulas / Values / Notes / Comments).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {fromKernelSelection} from '../model/workbook.mjs';
import {findHits, inputText} from '../commands/edit/find.mjs';
import {matches, replaceCi} from '../lib/edit-find.mjs';
import {cellAt} from '../model/store.mjs';

const base = v => ({
  what: String(v.what ?? ''),
  ...(v.matchCase ? {matchCase: true} : {}),
  ...(v.wholeCell ? {wholeCell: true} : {}),
  within: v.within === 'workbook' ? 'workbook' : 'sheet',
});
const findParams = v => ({...base(v), ...(v.lookIn && v.lookIn !== 'formulas' ? {lookIn: v.lookIn} : {}), ...(v.search === 'columns' ? {byColumns: true} : {})});

/** What Replace does to one entry (find.rs `replace`). */
const replaced = (text, v) => {
  const what = String(v.what), w = String(v.with ?? '');
  if (v.wholeCell) return w;
  return v.matchCase ? text.split(what).join(w) : replaceCi(text, what, w);
};

export default defineDialog({
  id: 'dialog.find',
  title: 'Find and Replace',
  command: 'edit.find',
  init(ctx) {
    const last = ctx.view?.findResults ?? null;
    return {
      what: last?.what ?? '', with: '', within: 'sheet', search: 'rows', lookIn: 'formulas', matchCase: false, wholeCell: false,
      results: last?.results ?? [],
    };
  },
  validate: v => (String(v.what ?? '') ? [] : [{field: 'what', message: 'Type what to find'}]),
  buttons: {
    'Find Next': (_ctx, v) => (v.what ? {command: 'edit.find', params: findParams(v)} : null),
    'Find All': (_ctx, v) => (v.what ? {command: 'edit.find', params: {...findParams(v), all: true}} : null),
    'Replace All': (_ctx, v) => (v.what ? {command: 'edit.replace', params: {...base(v), with: String(v.with ?? ''), all: true}} : null),
    Replace(ctx, v) {
      // gridcraft: replace the active cell when it matches, then find the next match. They run as
      // one batch only when a match is left to find (a failed find would undo the replacement).
      if (!v.what) return null;
      const replace = {command: 'edit.replace', params: {...base(v), with: String(v.with ?? ''), all: false}};
      const sel = fromKernelSelection(ctx.doc, ctx.selection);
      const cell = cellAt(ctx.doc.sheets[sel.sheet], sel.active.row, sel.active.col);
      const text = inputText(cell);
      const here = !!cell && matches(text, String(v.what), !!v.matchCase, !!v.wholeCell);
      const others = findHits(ctx.doc, sel.sheet, findParams(v)).some(h => !(h.si === sel.sheet && h.row === sel.active.row && h.col === sel.active.col));
      const stillHere = here && matches(replaced(text, v), String(v.what), !!v.matchCase, !!v.wholeCell);
      if (!others && !stillHere) return replace;
      return {batch: [replace, {command: 'edit.find', params: findParams(v)}]};
    },
  },
  toCommand: v => ({command: 'edit.find', params: findParams(v)}),
});
