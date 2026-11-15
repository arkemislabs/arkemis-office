// Back (Quick Access Toolbar > Back, Alt+Left; U:slate/nav): OneNote's Back button returns to the page
// the person was on before. Slate has no ArtCraft upstream. `watchNavigation` follows the document's
// selection and keeps the pages visited, newest last, per notebook, in memory only (never saved);
// nav.back goes to the most recent one that still exists. No DOM, no Node built-ins.

import {isNotebook} from '../schema.mjs';
import {currentLocation} from '../model/notebook.mjs';

const MAX = 100;
const states = new Map();
const stateOf = content => { const id = content.notebook.id; let s = states.get(id); if (!s) { s = {back: [], at: null, skip: null}; states.set(id, s); } return s; };

/** The pages Back would go through, nearest first, that still exist. */
export function backPages(content) {
  if (!isNotebook(content)) return [];
  const s = stateOf(content);
  return [...s.back].reverse().filter(id => content.pages[id] && id !== s.at);
}

/** Take the nearest page off the stack for a Back; the watcher then does not count that move as a visit. */
export function takeBack(content) {
  const s = stateOf(content);
  while (s.back.length) {
    const id = s.back.pop();
    if (content.pages[id] && id !== s.at) { s.skip = id; return id; }
  }
  return null;
}

/** Follow the document: each move to another page remembers the page left. Returns the function that stops it. */
export function watchNavigation(session, docId) {
  const here = () => { const d = session.get(docId); const c = d.file.content; return isNotebook(c) ? {c, page: currentLocation(c, d.selection).pageId} : null; };
  try { const h = here(); if (h) stateOf(h.c).at = h.page; } catch { /* closed */ }
  return session.subscribe(e => {
    if (e.doc !== docId || (e.type !== 'selection.changed' && e.type !== 'doc.changed')) return;
    let h;
    try { h = here(); } catch { return; }
    if (!h || !h.page) return;
    const s = stateOf(h.c);
    if (h.page === s.at) return;
    if (s.skip === h.page) { s.skip = null; s.at = h.page; return; }
    if (s.at && h.c.pages[s.at]) { s.back.push(s.at); if (s.back.length > MAX) s.back.shift(); }
    s.at = h.page;
  });
}
