// Find and Replace (Home › Editing › Find ▾ Advanced Find…, Replace, Go To…; Ctrl+H, F5): one dialog
// with Find, Replace and Go To tabs.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs (`find_dialog`: Find what, Replace
// with, Match case / Whole words greyed with wildcards, Use wildcards, ▸ Search Options with Match
// prefix / suffix, Ignore punctuation / white-space, Regular expressions and the Special ▾ menu;
// Reading Highlight, Replace All, Replace, Find Next and their messages) and dialogs/find.rs
// (`FindExtra`, `FindTab`, `GoToWhat`, `SPECIAL_*`, `goto_body`, `goto_page`) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The buttons are in-dialog handlers (the dialog stays open, as Word's does); each runs the engine
// command upstream runs and the dialog shows the message upstream shows ("Match 2 of 5",
// "All done. We made 3 replacements.", "4 items highlighted"), read back from the find state.

import {defineDialog} from '../../kernel/dialog.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {Document} from '../model/document.mjs';
import {viewState} from '../lib/caret-session.mjs';

/** Special ▾ for Find what: [name, code] (SPECIAL_FIND). */
export const SPECIAL_FIND = Object.freeze([['Paragraph Mark', '^p'], ['Tab Character', '^t'], ['Any Character', '^?'], ['Any Digit', '^#'],
  ['Any Letter', '^$'], ['Caret Character', '^^'], ['Section Character', '^%'], ['Paragraph Character', '^v'], ['Column Break', '^n'],
  ['Em Dash', '^+'], ['En Dash', '^='], ['Graphic', '^g'], ['Manual Line Break', '^l'], ['Manual Page Break', '^m'],
  ['Nonbreaking Hyphen', '^~'], ['Nonbreaking Space', '^s'], ['Optional Hyphen', '^-'], ['Section Break', '^b'], ['White Space', '^w']]);
/** Special ▾ for Find what with wildcards (SPECIAL_WILD). */
export const SPECIAL_WILD = Object.freeze([['Any Character', '?'], ['Character in Range', '[-]'], ['Beginning of Word', '<'], ['End of Word', '>'],
  ['Expression', '()'], ['Not', '[!]'], ['Num Occurrences', '{,}'], ['Previous 1 or More', '@'], ['0 or More Characters', '*'],
  ['Paragraph Mark', '^13'], ['Tab Character', '^t'], ['Caret Character', '^^'], ['Section Character', '^%'], ['Paragraph Character', '^v'],
  ['Column Break', '^n'], ['Em Dash', '^+'], ['En Dash', '^='], ['Graphic', '^g'], ['Manual Line Break', '^l'], ['Manual Page Break', '^m'],
  ['Nonbreaking Hyphen', '^~'], ['Nonbreaking Space', '^s'], ['Optional Hyphen', '^-']]);
/** Special ▾ for Replace with; with wildcards "Find What Expression" (\1) comes first (SPECIAL_REPLACE). */
export const SPECIAL_REPLACE = Object.freeze([['Paragraph Mark', '^p'], ['Tab Character', '^t'], ['Caret Character', '^^'], ['Section Character', '^%'],
  ['Paragraph Character', '^v'], ['Clipboard Contents', '^c'], ['Column Break', '^n'], ['Em Dash', '^+'], ['En Dash', '^='],
  ['Find What Text', '^&'], ['Manual Line Break', '^l'], ['Manual Page Break', '^m'], ['Nonbreaking Hyphen', '^~'], ['Nonbreaking Space', '^s'],
  ['Optional Hyphen', '^-']]);

/** The Special ▾ items for the field that last had the focus (special_menu). */
export function specialItems(v) {
  if (v.toReplace) return v.wildcards ? [['Find What Expression', '\\1'], ...SPECIAL_REPLACE] : [...SPECIAL_REPLACE];
  return [...(v.wildcards ? SPECIAL_WILD : SPECIAL_FIND)];
}

/** Go To's page box as edit.goto params: empty steps one page on, +n / -n from the current page, n that page (goto_page). */
export function gotoPage(text) {
  const t = String(text ?? '').trim().replace(/−/g, '-');
  if (!t) return {pageBy: 1};
  if (t.startsWith('+')) { const r = t.slice(1); return /^\d+$/.test(r) ? {pageBy: Number(r)} : null; }
  if (t.startsWith('-')) return /^-\d+$/.test(t) ? {pageBy: Number(t)} : null;
  return /^\d+$/.test(t) && Number(t) >= 1 ? {page: Number(t)} : null;
}

/** The search options as the engine's params (find_dialog `opts`). */
export function findOpts(v) {
  return {text: String(v.findWhat ?? ''), with: String(v.replaceWith ?? ''), matchCase: !!v.matchCase, wholeWord: !!v.wholeWords, regex: !!v.regex,
    wildcards: !!v.wildcards, matchPrefix: !!v.prefix, matchSuffix: !!v.suffix, ignorePunct: !!v.ignorePunct, ignoreSpace: !!v.ignoreSpace};
}

/** The document's bookmarks Go To lists (hidden ones, starting with _, left out). */
function bookmarks(ctx) {
  try { return new Document(ctx.doc).bookmarks().map(([n]) => n).filter(n => !n.startsWith('_')); } catch { return []; }
}

const needText = v => {
  if (!String(v.findWhat ?? '')) throw new CommandError('invalid_params', 'Type what to find.', {fields: [{field: 'findWhat', message: 'Type what to find.'}], path: '/findWhat'});
};

export default defineDialog({
  id: 'dialog.find',
  title: 'Find and Replace',
  init(ctx) {
    const v = viewState(ctx);
    const f = v.find ?? {};
    return {
      findWhat: f.query ?? '', replaceWith: f.replace ?? '', matchCase: !!f.matchCase, wholeWords: !!f.wholeWord, wildcards: !!f.wildcards,
      more: !!(f.matchPrefix || f.matchSuffix || f.ignorePunct || f.ignoreSpace || f.regex), prefix: !!f.matchPrefix, suffix: !!f.matchSuffix,
      ignorePunct: !!f.ignorePunct, ignoreSpace: !!f.ignoreSpace, regex: !!f.regex, special: null, toReplace: false,
      highlight: !!f.highlight, status: typeof v.status === 'string' ? v.status : '',
      goToWhat: 'page', pageNumber: '', bookmarkName: null, bookmarks: bookmarks(ctx),
    };
  },
  derive(v, changed) {
    const out = {};
    // Special ▾ adds its code to the field that last had the focus, then resets.
    if (changed.includes('special') && typeof v.special === 'string' && v.special) {
      if (v.toReplace) out.replaceWith = String(v.replaceWith ?? '') + v.special;
      else out.findWhat = String(v.findWhat ?? '') + v.special;
      out.special = null;
    }
    // Word greys Match case and the word options with wildcards (they always match case).
    if (changed.includes('wildcards') && v.wildcards) Object.assign(out, {matchCase: false, wholeWords: false, prefix: false, suffix: false, ignorePunct: false, ignoreSpace: false});
    if (changed.includes('goToWhat')) Object.assign(out, {pageNumber: '', bookmarkName: null, status: ''});
    return out;
  },
  validate() { return []; },
  buttons: {
    findNext(_ctx, v) { needText(v); return {command: 'edit.findNext', params: findOpts(v)}; },
    replace(_ctx, v) { needText(v); return {command: 'edit.replace', params: findOpts(v)}; },
    replaceAll(_ctx, v) { needText(v); return {command: 'edit.replaceAll', params: findOpts(v)}; },
    readingHighlight(_ctx, v) { return {command: 'edit.advancedFind', params: {...findOpts(v), highlight: !v.highlight}}; },
    previous() { return {command: 'edit.goto', params: {pageBy: -1}}; },
    goTo(_ctx, v) {
      if (v.goToWhat === 'bookmark') {
        if (!v.bookmarkName) throw new CommandError('invalid_params', 'Choose a bookmark.', {fields: [{field: 'bookmarkName', message: 'Choose a bookmark.'}], path: '/bookmarkName'});
        return {command: 'edit.goto', params: {bookmark: v.bookmarkName}};
      }
      const p = gotoPage(v.pageNumber);
      if (!p) throw new CommandError('invalid_params', 'Type a page number, or +2 / -1.', {fields: [{field: 'pageNumber', message: 'Type a page number, or +2 / -1.'}], path: '/pageNumber'});
      return {command: 'edit.goto', params: p};
    },
  },
  // Close is the only footer button: nothing to submit.
  toCommand() { return null; },
});
