// The notebook outline the page and section commands edit (F:slate foundation; used by
// U:slate/pages and U:slate/sections).
//
// Slate has no ArtCraft upstream: the shape follows docs/spec/slate.json `dataModel` (notebook →
// sections → pages with id, title, created, level 0–2) and OneNote's behaviour.
//
//   outline = {notebook: {id, name}, sections: [{id, name, color, pages: [{id, title, level, created}]}],
//              current: {sectionId, pageId}}
//
// Two storages, one interface:
//
// * Schema-2 notebooks (core/slate/schema.mjs): the outline is a view of the real notebook model.
//   `outlineOf` reads sections in tree order with their pages; `saveOutline` writes what changed
//   back as model edits (new sections and pages, page order and levels, names, colours) and
//   makes `current` the selection, so undo returns to the page the change happened on.
// * Schema-1 pages from the legacy editor: the interim storage kept in the page document under
//   `content.outline` (built on the first edit from the `notebook`/`section` strings, with this
//   document as the section's first page). It stays until those files are migrated
//   (core/slate/migrate.mjs reads it).
//
// No DOM, no Node built-ins.

import {SECTION_COLORS as COLORS, isNotebook, newPageRecord} from '../schema.mjs';
import {currentLocation, insertTreeItem, parentOf, removeTreeItem, sectionOrder, selectPage, selectSection} from '../model/notebook.mjs';

/** OneNote's section tab colours, assigned in turn. */
export const SECTION_COLORS = COLORS;

/** The outline as stored, or the one a first edit would create. */
export function outlineOf(ctx) {
  const c = ctx.doc ?? {};
  if (isNotebook(c)) return notebookOutline(c, ctx.selection);
  if (c.outline && Array.isArray(c.outline.sections)) return c.outline;
  const created = new Date(ctx.host.now()).toISOString();
  const sectionId = `sec-${ctx.docId}`;
  return {
    notebook: {id: `nb-${ctx.docId}`, name: typeof c.notebook === 'string' && c.notebook.trim() ? c.notebook : 'My Notebook'},
    sections: [{id: sectionId, name: typeof c.section === 'string' && c.section.trim() ? c.section : 'Quick Notes', color: SECTION_COLORS[0],
      pages: [{id: ctx.docId, title: ctx.file?.title ?? '', level: 0, created}]}],
    current: {sectionId, pageId: ctx.docId},
  };
}

function notebookOutline(c, selection) {
  const cur = currentLocation(c, selection);
  return {
    notebook: {id: c.notebook.id, name: c.notebook.name},
    sections: sectionOrder(c).map(sid => {
      const s = c.sections[sid];
      return {id: s.id, name: s.name, color: s.color,
        pages: s.pages.map(e => ({id: e.id, title: c.pages[e.id].title, level: e.level, created: c.pages[e.id].created}))};
    }),
    current: {sectionId: cur.sectionId, pageId: cur.pageId},
  };
}

/** Write an outline: the whole record the first time, otherwise only the parts that changed. */
export function saveOutline(ctx, next) {
  if (isNotebook(ctx.doc)) { saveToNotebook(ctx, next); return; }
  if (!ctx.doc.outline) { ctx.change.set(['outline'], next); return; }
  const before = ctx.doc.outline;
  // set() at index === length appends, so new sections land in order.
  next.sections.forEach((sec, i) => {
    if (before.sections[i] !== sec) ctx.change.set(['outline', 'sections', i], sec);
  });
  if (JSON.stringify(before.current) !== JSON.stringify(next.current)) ctx.change.set(['outline', 'current'], next.current);
}

const sameEntries = (a, b) => a.length === b.length && a.every((e, i) => e.id === b[i].id && e.level === b[i].level);

/** The single entry inserted into `before` to give `after`, or -1. */
function singleInsertion(before, after) {
  if (after.length !== before.length + 1) return -1;
  let i = 0;
  while (i < before.length && before[i].id === after[i].id && before[i].level === after[i].level) i++;
  for (let j = i; j < before.length; j++) if (before[j].id !== after[j + 1].id || before[j].level !== after[j + 1].level) return -1;
  return i;
}

function saveToNotebook(ctx, next) {
  const c = () => ctx.doc;
  const keep = new Set(next.sections.map(s => s.id));
  // Sections the outline no longer has leave the notebook with their pages.
  for (const sid of sectionOrder(c())) {
    if (keep.has(sid)) continue;
    const pages = c().sections[sid].pages.map(e => e.id);
    removeTreeItem(ctx, sid);
    ctx.change.delete(['sections', sid]);
    for (const pid of pages) if (!next.sections.some(s => s.pages.some(p => p.id === pid))) ctx.change.delete(['pages', pid]);
  }
  next.sections.forEach((sec, i) => {
    for (const p of sec.pages) {
      if (!c().pages[p.id]) ctx.change.set(['pages', p.id], newPageRecord({id: p.id, title: p.title ?? '', created: p.created ?? new Date(ctx.host.now()).toISOString(),
        rule: ruleForNewPage(ctx)}));
      else if (typeof p.title === 'string' && p.title !== c().pages[p.id].title) ctx.change.set(['pages', p.id, 'title'], p.title);
    }
    const entries = sec.pages.map(p => ({id: p.id, level: p.level}));
    const existing = c().sections[sec.id];
    if (!existing) {
      ctx.change.set(['sections', sec.id], {id: sec.id, name: sec.name, color: sec.color ?? SECTION_COLORS[i % SECTION_COLORS.length],
        created: new Date(ctx.host.now()).toISOString(), pages: entries});
      const prev = i > 0 ? parentOf(c(), next.sections[i - 1].id) : null;
      insertTreeItem(ctx, sec.id, prev ? {parent: prev.parent, index: prev.index + 1} : {parent: null, index: 0});
      return;
    }
    // Pages moved here from another section leave their old place first.
    if (existing.name !== sec.name) ctx.change.set(['sections', sec.id, 'name'], sec.name);
    if (sec.color && existing.color !== sec.color) ctx.change.set(['sections', sec.id, 'color'], sec.color);
    if (sameEntries(existing.pages, entries)) return;
    const at = singleInsertion(existing.pages, entries);
    if (at >= 0) ctx.change.splice(['sections', sec.id, 'pages'], at, 0, entries[at]);
    else ctx.change.set(['sections', sec.id, 'pages'], entries);
  });
  const cur = next.current;
  if (cur?.pageId && c().pages[cur.pageId]) ctx.setSelection(selectPage(cur.pageId));
  else if (cur?.sectionId && c().sections[cur.sectionId]) ctx.setSelection(selectSection(cur.sectionId));
}

/** View › Rule Lines › Always Create Pages with Rule Lines (prefs `slate.newPageRule`). */
function ruleForNewPage(ctx) {
  const r = ctx.prefs?.['slate.newPageRule'];
  return r && typeof r === 'object' && typeof r.pattern === 'string' ? {pattern: r.pattern, color: r.color} : null;
}

export const findSection = (outline, id) => outline.sections.findIndex(s => s.id === id);

/** A new untitled page record (OneNote: "Untitled page", created now, top level). */
export const newPage = (ctx, level = 0) => ({id: `pg-${ctx.host.uid()}`, title: '', level, created: new Date(ctx.host.now()).toISOString()});
