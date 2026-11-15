// The Notebook Recycle Bin and page-structure helpers (U:slate/pages; other units may import,
// not edit: U:slate/history restores from and empties the bin).
//
// Slate has no ArtCraft upstream. OneNote moves a deleted page, section or section group to the
// notebook's Recycle Bin (History › Notebook Recycle Bin), where it stays for 60 days and can be
// restored to its section; deleting is also undoable at once with Ctrl+Z. Here the bin lives on
// the notebook record, so it is saved with notebook.json:
//
//   content.notebook.recycleBin = [
//     {kind: 'page',    id, deleted, page: <page record>, level, from: {sectionId, sectionName, index}},
//     {kind: 'section', id, deleted, section: <section record>, pages: {[id]: record}, from: {parent, index}},
//     {kind: 'group',   id, deleted, group: <group record>, groups: {...}, sections: {...}, pages: {...}, from: {parent, index}},
//   ]
//
// Pages also keep OneNote's page-list rules: a page is at most one level deeper than the page
// above it (normalizeLevels), and a page moves, copies and deletes with its subpages (familyRange).
//
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {MAX_LEVEL} from '../schema.mjs';
import {familyRange, pageIndex, parentOf, removeTreeItem} from '../model/notebook.mjs';

export const RECYCLE_DAYS = 60;
export const binOf = content => (Array.isArray(content?.notebook?.recycleBin) ? content.notebook.recycleBin : []);

/** Add an entry at the top of the bin (newest first). */
export function binAdd(ctx, entry) {
  const bin = binOf(ctx.doc);
  const full = {id: `r${ctx.host.uid()}`, deleted: new Date(ctx.host.now()).toISOString(), ...entry};
  if (!Array.isArray(ctx.doc.notebook.recycleBin)) ctx.change.set(['notebook', 'recycleBin'], [full]);
  else ctx.change.splice(['notebook', 'recycleBin'], 0, 0, full);
  return full.id;
}

/** OneNote's level rule: the first page is a top page; each page is at most one level below the one above. */
export function normalizeLevels(entries) {
  let prev = -1;
  return entries.map(e => {
    const level = Math.max(0, Math.min(e.level, prev + 1, MAX_LEVEL));
    prev = level;
    return level === e.level ? e : {...e, level};
  });
}

/** Expand page ids to whole families where a collapsed page hides its subpages; returns ids in section order per section. */
export function withFamilies(content, ids, {always = false} = {}) {
  const index = pageIndex(content);
  const out = new Set();
  for (const id of ids) {
    const at = index.get(id);
    if (!at) throw new CommandError('not_found', `No page ${id}`, {address: `/pg:${id}`});
    const s = content.sections[at.section];
    const {start, end} = familyRange(s, at.index);
    const whole = always || content.pages[id].collapsed;
    for (let i = start; i <= (whole ? end : start); i++) out.add(s.pages[i].id);
  }
  return [...out].sort((a, b) => {
    const x = index.get(a), y = index.get(b);
    return x.section === y.section ? x.index - y.index : 0;
  });
}

/** Remove a section or group from the tree and its records; returns what the bin needs. */
export function detachItem(ctx, itemId) {
  const c = ctx.doc;
  const from = parentOf(c, itemId);
  if (!from) throw new CommandError('not_found', `No section or section group ${itemId}`);
  const groups = {}, sections = {}, pages = {};
  const collect = id => {
    if (c.sections[id]) {
      sections[id] = c.sections[id];
      for (const e of c.sections[id].pages) pages[e.id] = c.pages[e.id];
    } else if (c.groups[id]) {
      groups[id] = c.groups[id];
      for (const child of c.groups[id].items) collect(child);
    }
  };
  collect(itemId);
  removeTreeItem(ctx, itemId);
  for (const id of Object.keys(pages)) ctx.change.delete(['pages', id]);
  for (const id of Object.keys(sections)) ctx.change.delete(['sections', id]);
  for (const id of Object.keys(groups)) ctx.change.delete(['groups', id]);
  return {from, groups, sections, pages};
}
