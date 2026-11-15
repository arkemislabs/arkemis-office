// Insert › Links › Bookmark (Ctrl+Shift+F5; Add runs insert.bookmark, Delete insert.deleteBookmark,
// Go To edit.goto).
// Translated from wordcraft crates/ui-egui/src/dialogs/bookmarks.rs (`bookmark_at_caret`: the
// dialog opens on the innermost bookmark around the caret; `bookmark_names`: by name or by location,
// hidden ones (_Toc…, _Ref…) only when asked; Add (Enter) closes the dialog, Delete and Go To leave it
// open; Add needs a valid name, Delete and Go To a listed one) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import {bookmarkNameOk, bookmarkRange} from '../commands/insert.mjs';
import {cmpPos} from '../model/document.mjs';

/** The bookmarks the dialog lists: by name or in document order, hidden ones only when asked (bookmark_names). */
export function bookmarkNames(marks, byLocation, hidden) {
  const names = marks.map(([n]) => n).filter(n => hidden || !n.startsWith('_'));
  if (!byLocation) names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return names;
}

const listed = v => (v.marks ?? []).some(([n]) => n === String(v.name ?? '').trim());

export default defineDialog({
  id: 'dialog.bookmark',
  title: 'Bookmark',
  command: 'insert.bookmark',
  init(ctx) {
    const S = T.open(ctx);
    const marks = S.d.bookmarks().map(([n, at]) => [n, at]);
    // The innermost bookmark around the caret (bookmark_at_caret).
    const at = S.sel.focus;
    let name = '';
    for (const [n, start] of [...marks].reverse()) {
      if (n.startsWith('_')) continue;
      const r = bookmarkRange(S.d, n);
      if (r && cmpPos(start, at) <= 0 && cmpPos(at, r[1]) <= 0) { name = n; break; }
    }
    return {name, sortBy: 'name', hidden: false, marks: marks.map(([n]) => [n]), list: name || null};
  },
  derive(v, changed) {
    if (changed.includes('list') && v.list) return {name: v.list};
    return {};
  },
  buttons: {
    delete: (_ctx, v) => (listed(v) ? {command: 'insert.deleteBookmark', params: {name: String(v.name).trim()}} : null),
    goTo: (_ctx, v) => (listed(v) ? {command: 'edit.goto', params: {bookmark: String(v.name).trim()}} : null),
  },
  validate(v) {
    return bookmarkNameOk(String(v.name ?? '').trim()) ? [] : [{field: 'name', message: 'Bookmark names start with a letter, have no spaces or punctuation and at most 40 characters.'}];
  },
  toCommand(v) {
    return {command: 'insert.bookmark', params: {name: String(v.name).trim()}};
  },
});
