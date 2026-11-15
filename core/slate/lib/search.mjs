// Search the notebook (Review > Insights > Search, Ctrl+E; U:slate/rest).
//
// OneNote's Search box finds the words on pages, in their titles, in the text of pictures and in file
// names, in this section, section group or notebook. Smart Lookup (the online Search pane) is not
// possible offline, so the Search button runs this: the notebook's own search, with the selected
// words as the query. Text in pictures is searched through the `alt` the app writes when a scanned
// image is recognised. Sections locked with a password are not read. Not checked against upstream
// (there is none). No DOM, no Node built-ins.

import {nodeOf} from '../schema.mjs';
import {treeEntries} from '../model/notebook.mjs';
import {sectionsInScope} from './history.mjs';
import {sheetText} from './sheet-text.mjs';

export const SEARCH_SCOPES = Object.freeze(['page', 'section', 'group', 'notebook']);
export const MAX_RESULTS = 200;
export const MAX_QUERY = 200;

/** The words of a page body: its notes in reading order, with what the objects hold (picture text, file names, worksheet cells, diagram boxes). */
export function pageWords(page) {
  const lines = [];
  nodeOf(page.body).descendants(node => {
    if (node.isTextblock) {
      let line = '';
      node.forEach(child => {
        const t = child.type.name;
        if (child.isText) line += child.text;
        else if (t === 'equation') line += child.attrs.linear;
        else if (t === 'image') line += child.attrs.alt ? ` ${child.attrs.alt} ` : '';
        else if (t === 'attachment') line += ` ${child.attrs.name} `;
        else if (t === 'spreadsheet') line += ` ${sheetText(child.attrs).replace(/\t/g, ' ').replace(/\n/g, ' ')} `;
        else if (t === 'diagram') line += ` ${child.attrs.text.replace(/\n/g, ' ')} `;
      });
      if (line.trim()) lines.push(line.replace(/\s+/g, ' ').trim());
      return false;
    }
    return true;
  });
  return lines;
}

function snippetOf(text, at, len) {
  const from = Math.max(0, at - 36), to = Math.min(text.length, at + len + 60);
  return `${from ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

/**
 * The pages that hold the query: {query, scope, results: [{page, title, section, sectionId, snippet, matches, inTitle}], total, lockedSkipped},
 * the pages whose title holds it first. `scope` is page, section, group or notebook, relative to `sectionId` (and `pageId` for page).
 */
export function searchNotebook(content, query, {sectionId = null, pageId = null, scope = 'notebook'} = {}) {
  const q = String(query ?? '').trim().slice(0, MAX_QUERY).toLowerCase();
  const out = {query: String(query ?? '').trim().slice(0, MAX_QUERY), scope, results: [], total: 0, lockedSkipped: 0};
  if (!q) return out;
  const within = scope === 'page' ? new Set(sectionId ? [sectionId] : []) : sectionsInScope(content, sectionId, scope);
  for (const e of treeEntries(content)) {
    if (e.kind !== 'section' || (within && !within.has(e.id))) continue;
    const section = content.sections[e.id];
    if (section.locked === true) { out.lockedSkipped++; continue; }
    for (const entry of section.pages) {
      if (scope === 'page' && entry.id !== pageId) continue;
      const page = content.pages[entry.id];
      if (!page) continue;
      const title = page.title || '';
      const inTitle = title.toLowerCase().includes(q);
      let matches = 0, snippet = '';
      for (const line of pageWords(page)) {
        const lower = line.toLowerCase();
        let from = 0, at;
        while ((at = lower.indexOf(q, from)) >= 0) { matches++; if (!snippet) snippet = snippetOf(line, at, q.length); from = at + q.length; }
      }
      if (!inTitle && !matches) continue;
      out.total++;
      if (out.results.length < MAX_RESULTS) out.results.push({page: page.id, title: title || 'Untitled page', section: section.name, sectionId: e.id, snippet: snippet || title, matches: matches + (inTitle ? 1 : 0), inTitle});
    }
  }
  out.results.sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || b.matches - a.matches);
  return out;
}
