// The notebook structure: sections, section groups and pages (F:slate foundation).
//
// Slate has no ArtCraft upstream: behaviour follows docs/spec/slate.json `dataModel` and OneNote.
// Queries are pure functions of the content (cached per immutable record, so a 2,000-page
// notebook is indexed once per structural change); edits take the command context and write
// only through `ctx.change`, so every one is undoable (docs/architecture.md 4.2).
//
// The current page is the document selection: `/pg:<id>` (or any address inside the page) makes
// that page current, `/sec:<id>` an empty or freshly opened section. Undo restores the selection
// with the content, as OneNote returns to the page an undone action happened on.
//
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {MAX_LEVEL, SECTION_COLORS, LIMITS, newPageRecord, isNotebook} from '../schema.mjs';
import {authorOf, beforeEdit, stampEdit} from '../lib/history.mjs';

// ---------------------------------------------------------------------------------------------
// Queries

const orderCache = new WeakMap();
const indexCache = new WeakMap();

/** Sections and groups depth-first in tree order: [{id, kind, depth, parent}]. */
export function treeEntries(content) {
  const cached = orderCache.get(content.tree);
  if (cached && cached.groups === content.groups && cached.sections === content.sections) return cached.entries;
  const entries = [];
  const walk = (items, depth, parent) => {
    for (const id of items) {
      if (content.sections[id]) entries.push({id, kind: 'section', depth, parent});
      else if (content.groups[id]) { entries.push({id, kind: 'group', depth, parent}); walk(content.groups[id].items, depth + 1, id); }
    }
  };
  walk(content.tree, 0, null);
  orderCache.set(content.tree, {groups: content.groups, sections: content.sections, entries});
  return entries;
}

/** Section ids in tree order (groups flattened). */
export const sectionOrder = content => treeEntries(content).filter(e => e.kind === 'section').map(e => e.id);

/** Map pageId -> {section, index, level}. */
export function pageIndex(content) {
  let index = indexCache.get(content.sections);
  if (index) return index;
  index = new Map();
  for (const s of Object.values(content.sections)) s.pages.forEach((entry, i) => index.set(entry.id, {section: s.id, index: i, level: entry.level}));
  indexCache.set(content.sections, index);
  return index;
}

export const sectionOf = (content, pageId) => pageIndex(content).get(pageId)?.section ?? null;

/** The group (or null for the notebook root) holding an item, and its index there. */
export function parentOf(content, itemId) {
  const at = content.tree.indexOf(itemId);
  if (at >= 0) return {parent: null, index: at};
  for (const g of Object.values(content.groups)) {
    const i = g.items.indexOf(itemId);
    if (i >= 0) return {parent: g.id, index: i};
  }
  return null;
}

/** A section's pages with their records: [{id, level, title, created, modified}]. */
export function pagesOf(content, sectionId) {
  const s = content.sections[sectionId];
  if (!s) return [];
  return s.pages.map(e => {
    const p = content.pages[e.id];
    return {id: e.id, level: e.level, title: p.title, created: p.created, modified: p.modified};
  });
}

/** The section and page ids an address names, or null. */
export function locate(content, address) {
  if (typeof address !== 'string') return null;
  const m = /^\/(pg|sec):([^/]+)/.exec(address);
  if (!m) return null;
  const key = decodeURIComponent(m[2]);
  if (m[1] === 'pg') {
    const section = sectionOf(content, key);
    return section ? {sectionId: section, pageId: key} : null;
  }
  const s = content.sections[key];
  return s ? {sectionId: key, pageId: null} : null;
}

/**
 * Where the person is: the page and section of the selection's primary focus; a section with no
 * page; or, with nothing selected, the first page of the first section (OneNote opens a notebook
 * on its first section).
 */
export function currentLocation(content, selection) {
  if (!isNotebook(content)) return {sectionId: null, pageId: null};
  const r = selection?.ranges?.[selection.primary ?? 0];
  const hit = r ? locate(content, r.focus) ?? locate(content, r.anchor) : null;
  if (hit) return hit;
  const first = sectionOrder(content)[0] ?? null;
  return {sectionId: first, pageId: first ? content.sections[first].pages[0]?.id ?? null : null};
}

/** A selection that makes a page (or, with no page, a section) current. */
export const selectPage = pageId => ({ranges: [{anchor: `/pg:${pageId}`, focus: `/pg:${pageId}`}], primary: 0});
export const selectSection = sectionId => ({ranges: [{anchor: `/sec:${sectionId}`, focus: `/sec:${sectionId}`}], primary: 0});

/** OneNote's default section name: the first unused "New Section <n>". */
export function nextSectionName(content) {
  const used = new Set(Object.values(content.sections).map(s => s.name.toLowerCase()));
  for (let n = 1; ; n++) if (!used.has(`new section ${n}`)) return `New Section ${n}`;
}

export function nextGroupName(content) {
  const used = new Set(Object.values(content.groups).map(g => g.name.toLowerCase()));
  for (let n = 1; ; n++) if (!used.has(`new section group ${n}`)) return `New Section Group ${n}`;
}

/** The pages from `index` through its last subpage (OneNote moves and deletes a page with its subpages). */
export function familyRange(section, index) {
  let end = index;
  const level = section.pages[index].level;
  while (end + 1 < section.pages.length && section.pages[end + 1].level > level) end++;
  return {start: index, end};
}

// ---------------------------------------------------------------------------------------------
// Edits (through ctx.change, inside a command)

const iso = ctx => new Date(ctx.host.now()).toISOString();
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };

/** Insert an item id into the tree (root when parent is null) at `index` (default: the end). */
export function insertTreeItem(ctx, itemId, {parent = null, index} = {}) {
  const c = ctx.doc;
  const path = parent ? ['groups', parent, 'items'] : ['tree'];
  const list = parent ? c.groups[parent]?.items : c.tree;
  need(list, 'not_found', `No section group ${parent}`, {address: `/grp:${parent}`});
  const at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length));
  ctx.change.splice(path, at, 0, itemId);
  return at;
}

/** Remove an item id from wherever it sits in the tree. */
export function removeTreeItem(ctx, itemId) {
  const where = parentOf(ctx.doc, itemId);
  if (!where) return null;
  ctx.change.splice(where.parent ? ['groups', where.parent, 'items'] : ['tree'], where.index, 1);
  return where;
}

/**
 * Add a section (OneNote: New Section). Placed after `after` (an item id), else at the end of
 * `groupId` (or the notebook). Returns the section id.
 */
export function addSection(ctx, {id, name, color, after, groupId = null, pages = []} = {}) {
  const c = ctx.doc;
  need(Object.keys(c.sections).length < LIMITS.sections, 'too_large', `A notebook has at most ${LIMITS.sections} sections`);
  const sid = id ?? `s${ctx.host.uid()}`;
  need(!c.sections[sid] && !c.groups[sid], 'invalid_params', `${sid} is already used`);
  const label = (name ?? nextSectionName(c)).trim();
  need(label && label.length <= LIMITS.nameLength, 'invalid_params', 'A section name has 1 to 100 characters', {path: '/name'});
  need(!Object.values(c.sections).some(s => s.name.toLowerCase() === label.toLowerCase()), 'invalid_params', `A section named ${label} already exists`, {path: '/name'});
  const total = Object.keys(c.sections).length;
  ctx.change.set(['sections', sid], {id: sid, name: label, color: color ?? SECTION_COLORS[total % SECTION_COLORS.length], created: iso(ctx), pages});
  if (after !== undefined && after !== null) {
    const where = parentOf(c, after);
    need(where, 'not_found', `No section or group ${after}`);
    insertTreeItem(ctx, sid, {parent: where.parent, index: where.index + 1});
  } else insertTreeItem(ctx, sid, {parent: groupId});
  return sid;
}

/** Add a section group (OneNote: New Section Group) at the end of `parent` (or the notebook). */
export function addGroup(ctx, {id, name, parent = null} = {}) {
  const c = ctx.doc;
  need(Object.keys(c.groups).length < LIMITS.groups, 'too_large', `A notebook has at most ${LIMITS.groups} section groups`);
  const gid = id ?? `g${ctx.host.uid()}`;
  const label = (name ?? nextGroupName(c)).trim();
  need(label && label.length <= LIMITS.nameLength, 'invalid_params', 'A section group name has 1 to 100 characters', {path: '/name'});
  ctx.change.set(['groups', gid], {id: gid, name: label, created: iso(ctx), items: []});
  insertTreeItem(ctx, gid, {parent});
  return gid;
}

/**
 * Add a page to a section at `index` (default: the end) with `level` 0–2. The page record is new
 * (empty canvas, "Untitled page") unless `record` is given. Returns the page id.
 */
export function addPage(ctx, sectionId, {id, index, level = 0, title = '', created, record} = {}) {
  const c = ctx.doc;
  const s = c.sections[sectionId];
  need(s, 'not_found', `No section ${sectionId}`, {address: `/sec:${sectionId}`});
  need(s.locked !== true, 'disabled', `${s.name} is password protected and locked. Unlock it first.`);
  need(Object.keys(c.pages).length < LIMITS.pages, 'too_large', `A notebook has at most ${LIMITS.pages} pages`);
  need(Number.isInteger(level) && level >= 0 && level <= MAX_LEVEL, 'invalid_params', 'A page level is 0, 1 or 2');
  const pid = id ?? record?.id ?? `p${ctx.host.uid()}`;
  need(!c.pages[pid], 'invalid_params', `Page ${pid} already exists`);
  const at = index === undefined ? s.pages.length : Math.max(0, Math.min(index, s.pages.length));
  const when = created ?? iso(ctx);
  ctx.change.set(['pages', pid], record ? {...record, id: pid} : {...newPageRecord({id: pid, title, created: when, rule: ruleForNewPage(ctx)}), author: authorOf(ctx), modifiedBy: authorOf(ctx)});
  ctx.change.splice(['sections', sectionId, 'pages'], at, 0, {id: pid, level});
  return pid;
}

/** View › Rule Lines › Always Create Pages with Rule Lines (prefs `slate.newPageRule`). */
function ruleForNewPage(ctx) {
  const r = ctx.prefs?.['slate.newPageRule'];
  return r && typeof r === 'object' && typeof r.pattern === 'string' ? {pattern: r.pattern, color: r.color} : null;
}

/** Remove a page record and its entry (its subpages stay; callers decide about families). */
export function removePage(ctx, pageId) {
  const c = ctx.doc;
  const at = pageIndex(c).get(pageId);
  need(at, 'not_found', `No page ${pageId}`, {address: `/pg:${pageId}`});
  ctx.change.splice(['sections', at.section, 'pages'], at.index, 1);
  ctx.change.delete(['pages', pageId]);
  return at;
}

const touch = (ctx, pageId) => stampEdit(ctx, pageId);

/** Set the page title (the title area on the canvas, page.rename). */
export function setPageTitle(ctx, pageId, title) {
  need(ctx.doc.pages[pageId], 'not_found', `No page ${pageId}`, {address: `/pg:${pageId}`});
  const text = String(title).replace(/[\r\n]+/g, ' ');
  need(text.length <= LIMITS.titleLength, 'invalid_params', `A page title has at most ${LIMITS.titleLength} characters`, {path: '/title'});
  if (ctx.doc.pages[pageId].title === text) return false;
  beforeEdit(ctx, pageId);
  ctx.change.set(['pages', pageId, 'title'], text);
  touch(ctx, pageId);
  return true;
}

const PAGE_FIELDS = new Set(['color', 'rule', 'titleHidden', 'paperSize', 'created']);

/** Set page-level fields (color, rule, titleHidden, paperSize, created) on a page. */
export function setPageFields(ctx, pageId, patch) {
  const page = ctx.doc.pages[pageId];
  need(page, 'not_found', `No page ${pageId}`, {address: `/pg:${pageId}`});
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    need(PAGE_FIELDS.has(k), 'invalid_params', `${k} is not a page setting`);
    if (JSON.stringify(page[k]) === JSON.stringify(v)) continue;
    ctx.change.set(['pages', pageId, k], v);
    changed = true;
  }
  if (changed) touch(ctx, pageId);
  return changed;
}

/** Set a section's page entries (order and levels) in one write. */
export function setSectionPages(ctx, sectionId, entries) {
  need(ctx.doc.sections[sectionId], 'not_found', `No section ${sectionId}`, {address: `/sec:${sectionId}`});
  ctx.change.set(['sections', sectionId, 'pages'], entries.map(e => ({id: e.id, level: e.level})));
}
