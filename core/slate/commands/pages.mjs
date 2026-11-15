// Pages: the page list, page templates and View › Page Setup (U:slate/pages).
//
// Slate has no ArtCraft upstream: ids, args and summaries are docs/spec/slate.json `page.*`
// (sourceRef core/slate-pages.mjs); behaviour is OneNote's:
//   * Add Page / Ctrl+N adds a page at the end of the current section (or after a page, at its
//     level, past its subpages), using the section's default template; Ctrl+Alt+N adds one below
//     the current page at its level; Ctrl+Alt+Shift+N a subpage (two levels at most); the new
//     page becomes current;
//   * Delete moves pages to the Notebook Recycle Bin (core/slate/lib/pages-recycle.mjs) and is
//     undoable; a collapsed page group goes with its parent; the page below takes its place;
//   * Make Subpage / Promote Subpage (Ctrl+Alt+] / [) indent and outdent a page with its
//     subpages (a page is at most one level below the page above it, and level 2 is the deepest);
//     Collapse / Expand Subpages and Ctrl+Shift+* fold a page group; Move Up / Down move a page
//     with its subpages past its neighbour at the same level; Sort orders the page groups;
//   * Move or Copy (Ctrl+Alt+M) puts pages (with their subpages) at the end of another section;
//     Cut / Copy / Paste of page tabs go through the clipboard;
//   * Page Templates: Save current page as a template (with "Set as default template for new
//     pages in the current section"), apply a saved template, choose the section's default;
//   * Page Color, Rule Lines (Ctrl+Shift+R toggles), Rule Line Color, Always Create Pages with
//     Rule Lines, Hide Page Title (which deletes the title and date, as OneNote warns), Paper
//     Size, and the page's date and time under the title.
// Pages are edited through the foundation model (core/slate/model/notebook.mjs).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {writeClipboard} from '../../common/lib/clipboard.mjs';
import {MAX_LEVEL, RULE_PATTERNS, isNotebook, newPageRecord} from '../schema.mjs';
import {addPage, currentLocation, familyRange, pageIndex, removePage, selectPage, selectSection, setPageFields, setPageTitle,
  setSectionPages} from '../model/notebook.mjs';
import {RULE_LINE_COLORS} from '../model/styles.mjs';
import {binAdd, normalizeLevels, withFamilies} from '../lib/pages-recycle.mjs';
import {isLegacyPage, legacyNewBelow, legacyNewPage, legacySubpageLevel} from '../lib/pages-legacy.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/page.*', 'core/slate-pages.mjs']};
const iso = ctx => new Date(ctx.host.now()).toISOString();
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };

export const TEMPLATES_PREF = 'slate.templates';
export const RECENT_TEMPLATES_PREF = 'slate.recentTemplates';
export const LAST_RULE_PREF = 'slate.lastRule';
export const NEW_PAGE_RULE_PREF = 'slate.newPageRule';
export const DEFAULT_RULE = 'college-ruled';
export const PAPER_SIZES = Object.freeze({
  'Auto': null, 'Statement': [5.5, 8.5], 'Letter': [8.5, 11], 'Tabloid': [11, 17], 'Legal': [8.5, 14], 'A3': [11.69, 16.54], 'A4': [8.27, 11.69],
  'A5': [5.83, 8.27], 'A6': [4.13, 5.83], 'B4 (JIS)': [10.12, 14.33], 'B5 (JIS)': [7.17, 10.12], 'B6 (JIS)': [5.04, 7.17], 'Executive': [7.25, 10.5],
  'Postcard': [3.94, 5.83], 'Index Card 3x5': [3, 5], 'Index Card 4x6': [4, 6], 'Index Card 5x8': [5, 8], 'Envelope #10': [4.12, 9.5],
  'Envelope DL': [4.33, 8.66], 'Envelope C5': [6.38, 9.02],
});
export const DEFAULT_MARGINS = Object.freeze({top: 0.5, bottom: 0.5, left: 0.5, right: 0.5});

// ---------------------------------------------------------------------------------------------
// Helpers

const notebookState = ctx => (isNotebook(ctx.doc) ? {enabled: true} : {enabled: false, reason: 'No notebook is open'});
function pageState(ctx) {
  if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
  return currentLocation(ctx.doc, ctx.selection).pageId ? {enabled: true} : {enabled: false, reason: 'No page is open'};
}
/** New Page also works on a schema-1 page (the interim outline, core/slate/lib/pages-legacy.mjs). */
const newPageState = ctx => (isLegacyPage(ctx) ? {enabled: true} : sectionState(ctx));
function sectionState(ctx) {
  if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
  return currentLocation(ctx.doc, ctx.selection).sectionId ? {enabled: true} : {enabled: false, reason: 'Open a section first'};
}

const here = ctx => {
  need(isNotebook(ctx.doc), 'disabled', 'No notebook is open');
  return currentLocation(ctx.doc, ctx.selection);
};
function currentPageId(ctx) {
  const {pageId} = here(ctx);
  need(pageId, 'disabled', 'No page is open');
  return pageId;
}
const pageIdsOr = (ctx, ids) => (ids?.length ? ids : [currentPageId(ctx)]);
function locate(ctx, pageId) {
  const at = pageIndex(ctx.doc).get(pageId);
  need(at, 'not_found', `No page ${pageId}`, {address: `/pg:${pageId}`});
  return at;
}
const entries = (ctx, sid) => ctx.doc.sections[sid].pages;

/** Place a new page in a section and make it current. */
function placeNewPage(ctx, sid, {index, level = 0, templateId}) {
  const tpl = templateId ?? ctx.doc.sections[sid].defaultTemplate ?? null;
  const record = tpl ? fromTemplate(ctx, tpl) : null;
  const pid = addPage(ctx, sid, {index, level, ...(record ? {record: {...record, id: `p${ctx.host.uid()}`}} : {})});
  ctx.setSelection(selectPage(pid));
  return {page: pid, section: sid, index: index ?? entries(ctx, sid).length - 1, level, ...(tpl ? {template: tpl} : {})};
}

/** After the page's subpages (the index a page below it goes at). */
const afterFamily = (ctx, pageId) => {
  const at = locate(ctx, pageId);
  return {at, index: familyRange(ctx.doc.sections[at.section], at.index).end + 1};
};

// Templates (prefs, the person's "My Templates")
const templatesOf = prefs => (Array.isArray(prefs?.[TEMPLATES_PREF]) ? prefs[TEMPLATES_PREF] : []);
function findTemplate(ctx, id) {
  const tid = id === 'recent' ? (ctx.prefs?.[RECENT_TEMPLATES_PREF] ?? [])[0] : id;
  const tpl = templatesOf(ctx.prefs).find(t => t.id === tid);
  need(tpl, 'not_found', id === 'recent' ? 'No template has been used yet' : `No template ${id}`, {path: '/templateId'});
  return tpl;
}
function fromTemplate(ctx, id) {
  const tpl = findTemplate(ctx, id);
  const created = iso(ctx);
  const p = tpl.page;
  // OneNote starts a page from a template with an empty title.
  return {...newPageRecord({id: 'tmp', title: '', created}), color: p.color ?? null, rule: p.rule ?? {pattern: 'none', color: RULE_LINE_COLORS.blue},
    titleHidden: !!p.titleHidden, paperSize: p.paperSize ?? null, body: structuredClone(p.body), ink: structuredClone(p.ink ?? []), template: tpl.id};
}
function noteRecentTemplate(ctx, id) {
  const recent = (ctx.prefs?.[RECENT_TEMPLATES_PREF] ?? []).filter(x => x !== id);
  ctx.updatePrefs({[RECENT_TEMPLATES_PREF]: [id, ...recent].slice(0, 10)});
}

/** Change levels of a page and its subpages by `delta` (checks OneNote's rules). */
function shiftFamily(ctx, pageId, delta) {
  const at = locate(ctx, pageId);
  const list = [...entries(ctx, at.section)];
  const {start, end} = familyRange(ctx.doc.sections[at.section], at.index);
  const level = list[start].level + delta;
  if (delta > 0) {
    need(start > 0, 'disabled', 'The first page in a section cannot be a subpage');
    need(level <= list[start - 1].level + 1, 'disabled', 'A page can only be a subpage of the page above it');
    for (let i = start; i <= end; i++) need(list[i].level + delta <= MAX_LEVEL, 'disabled', 'Subpages can only be two levels deep');
  } else need(level >= 0, 'disabled', 'This page is not a subpage');
  for (let i = start; i <= end; i++) list[i] = {id: list[i].id, level: list[i].level + delta};
  setSectionPages(ctx, at.section, normalizeLevels(list));
  return {page: pageId, level};
}

/** Move a page's family past the neighbouring family at the same level. */
function movePage(ctx, pageId, dir) {
  const at = locate(ctx, pageId);
  const sec = ctx.doc.sections[at.section];
  const list = [...sec.pages];
  const {start, end} = familyRange(sec, at.index);
  const level = list[start].level;
  let os, oe;
  if (dir < 0) {
    let j = start - 1;
    while (j >= 0 && list[j].level > level) j--;
    if (j < 0 || list[j].level < level) return {moved: false};
    os = j; oe = start - 1;
    list.splice(os, end - os + 1, ...list.slice(start, end + 1), ...list.slice(os, start));
  } else {
    if (end + 1 >= list.length || list[end + 1].level !== level) return {moved: false};
    os = end + 1; oe = familyRange(sec, os).end;
    list.splice(start, oe - start + 1, ...list.slice(os, oe + 1), ...list.slice(start, end + 1));
  }
  setSectionPages(ctx, at.section, list);
  return {moved: true};
}

/** Copy page records with fresh ids (subpages keep their levels). */
function cloneRecords(ctx, records) {
  return records.map(r => ({...structuredClone(r.record), id: `p${ctx.host.uid()}`, level: r.level}));
}

function insertRecords(ctx, sid, records, index) {
  let i = index ?? entries(ctx, sid).length;
  const ids = [];
  for (const r of records) {
    const {level, ...record} = r;
    ids.push(addPage(ctx, sid, {index: i++, level: Math.min(level, MAX_LEVEL), record}));
  }
  setSectionPages(ctx, sid, normalizeLevels(entries(ctx, sid)));
  return ids;
}

/** Delete pages to the Recycle Bin (or nowhere, for cut); selects the page that takes their place. */
function deletePages(ctx, ids, {bin = true} = {}) {
  const c = ctx.doc;
  const firstAt = locate(ctx, ids[0]);
  const sid = firstAt.section;
  const removed = [];
  for (const id of [...ids].reverse()) {
    const at = locate(ctx, id);
    const sec = ctx.doc.sections[at.section];
    if (bin) binAdd(ctx, {kind: 'page', page: ctx.doc.pages[id], level: at.level, from: {sectionId: at.section, sectionName: sec.name, index: at.index}});
    removed.unshift({record: c.pages[id], level: at.level});
    removePage(ctx, id);
    setSectionPages(ctx, at.section, normalizeLevels(ctx.doc.sections[at.section].pages));
  }
  const left = ctx.doc.sections[sid].pages;
  const next = left[Math.min(firstAt.index, left.length - 1)];
  ctx.setSelection(next ? selectPage(next.id) : selectSection(sid));
  return removed;
}

const iDate = /^(\d{4})-(\d{2})-(\d{2})$/, iTime = /^(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?$/;

// ---------------------------------------------------------------------------------------------

const idsParam = s.optional(s.array(s.string({min: 1, max: 80}), {min: 1, max: 5000, description: 'Page ids (default: the current page)'}));
const pageIdParam = s.optional(s.string({min: 1, max: 80, description: 'Page id (default: the current page)'}));

export default defineCommands({
  family: 'pages',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    // --- templates -----------------------------------------------------------------------------
    {
      id: 'page.templates', label: 'Page Templates', risk: 'read', dialog: 'dialog.page-templates',
      description: 'List the page templates and the current section\'s default template (the Templates pane).',
      params: s.object({}),
      state: notebookState,
      run(ctx) {
        const {sectionId} = here(ctx);
        return {templates: templatesOf(ctx.prefs).map(t => ({id: t.id, name: t.name, category: 'My Templates'})),
          recent: (ctx.prefs?.[RECENT_TEMPLATES_PREF] ?? []).filter(id => templatesOf(ctx.prefs).some(t => t.id === id)),
          defaultTemplate: sectionId ? ctx.doc.sections[sectionId].defaultTemplate ?? null : null};
      },
    },
    {
      id: 'page.applyTemplate', label: 'Page Templates', risk: 'edit',
      description: 'Add a page from a template at the end of the current section ("recent" = the last template used).',
      params: s.object({templateId: s.string({min: 1, max: 80})}),
      state(ctx, p) {
        const st = sectionState(ctx);
        if (!st.enabled) return st;
        if (p?.templateId === 'recent' && !(ctx.prefs?.[RECENT_TEMPLATES_PREF] ?? []).some(id => templatesOf(ctx.prefs).some(t => t.id === id))) return {enabled: false, reason: 'No template has been used yet'};
        return st;
      },
      run(ctx, p) {
        const tpl = findTemplate(ctx, p.templateId);
        const {sectionId} = here(ctx);
        need(sectionId, 'disabled', 'Open a section first');
        noteRecentTemplate(ctx, tpl.id);
        return placeNewPage(ctx, sectionId, {templateId: tpl.id});
      },
    },
    {
      id: 'page.saveAsTemplate', label: 'Save current page as a template', risk: 'edit', dialog: 'dialog.save-as-template',
      description: 'Save the current page (its notes, ink, colour, rule lines and paper size) as a template; optionally the default for new pages in this section.',
      params: s.object({name: s.string({min: 1, max: 100, trim: true}), setDefault: s.optional(s.boolean())}),
      state: pageState,
      run(ctx, p) {
        const {pageId, sectionId} = here(ctx);
        need(pageId, 'disabled', 'No page is open');
        const list = templatesOf(ctx.prefs);
        need(!list.some(t => t.name.toLowerCase() === p.name.toLowerCase()), 'invalid_params', `A template named ${p.name} already exists`, {path: '/name'});
        const page = ctx.doc.pages[pageId];
        const tpl = {id: `tpl${ctx.host.uid()}`, name: p.name, created: iso(ctx),
          page: {title: page.title, color: page.color, rule: page.rule, titleHidden: page.titleHidden, paperSize: page.paperSize, body: page.body, ink: page.ink}};
        ctx.updatePrefs({[TEMPLATES_PREF]: [...list, tpl]});
        if (p.setDefault) ctx.change.set(['sections', sectionId, 'defaultTemplate'], tpl.id);
        return {template: tpl.id, name: tpl.name, default: !!p.setDefault};
      },
    },
    {
      id: 'page.setDefaultTemplate', label: 'Choose default template', risk: 'edit',
      description: 'Set (or clear with null) the template new pages in a section start from.',
      params: s.object({templateId: s.nullable(s.string({min: 1, max: 80})), sectionId: s.optional(s.string({min: 1, max: 80}))}),
      state: sectionState,
      run(ctx, p) {
        const sid = p.sectionId ?? here(ctx).sectionId;
        need(ctx.doc.sections[sid], 'not_found', `No section ${sid}`, {path: '/sectionId'});
        if (p.templateId !== null) findTemplate(ctx, p.templateId);
        const id = p.templateId === 'recent' ? findTemplate(ctx, 'recent').id : p.templateId;
        if ((ctx.doc.sections[sid].defaultTemplate ?? null) === id) return {section: sid, template: id, changed: false};
        if (id === null) ctx.change.delete(['sections', sid, 'defaultTemplate']);
        else ctx.change.set(['sections', sid, 'defaultTemplate'], id);
        return {section: sid, template: id, changed: true};
      },
    },
    // --- new pages ------------------------------------------------------------------------------
    {
      id: 'page.new', label: 'Add Page', shortcut: 'Mod+N', risk: 'edit',
      description: 'Add a page at the end of the section (or after afterPageId, past its subpages) and make it current.',
      params: s.object({
        sectionId: s.optional(s.string({min: 1, max: 200, description: 'Section id (default: the current section)'})),
        afterPageId: s.optional(s.string({min: 1, max: 200, description: 'Insert after this page (default: at the end)'})),
        templateId: s.optional(s.string({min: 1, max: 200, description: 'Template to start from (default: the section\'s default template)'})),
      }),
      state: newPageState,
      run(ctx, p) {
        if (isLegacyPage(ctx)) return legacyNewPage(ctx, p);
        const sid = p.sectionId ?? here(ctx).sectionId;
        need(sid && ctx.doc.sections[sid], 'not_found', `No section ${p.sectionId}`, {path: '/sectionId'});
        if (p.templateId) noteRecentTemplate(ctx, findTemplate(ctx, p.templateId).id);
        if (p.afterPageId === undefined) return placeNewPage(ctx, sid, {templateId: p.templateId});
        const {at, index} = afterFamily(ctx, p.afterPageId);
        need(at.section === sid, 'not_found', `No page ${p.afterPageId} in that section`, {path: '/afterPageId'});
        return placeNewPage(ctx, sid, {index, level: at.level, templateId: p.templateId});
      },
    },
    {
      id: 'page.newBelow', label: 'New Page Below', shortcut: 'Mod+Alt+N', risk: 'edit',
      description: 'Create a new page below the current page (past its subpages) at the same level.',
      params: s.object({}),
      state: newPageState,
      run(ctx) {
        if (isLegacyPage(ctx)) return legacyNewBelow(ctx, false);
        const {sectionId, pageId} = here(ctx);
        need(sectionId, 'disabled', 'Open a section first');
        if (!pageId) return placeNewPage(ctx, sectionId, {});
        const {at, index} = afterFamily(ctx, pageId);
        return placeNewPage(ctx, sectionId, {index, level: at.level});
      },
    },
    {
      id: 'page.newSubpage', label: 'New Subpage', shortcut: 'Mod+Alt+Shift+N', risk: 'edit',
      description: 'Create a new subpage below the current page (two levels at most).',
      params: s.object({}),
      state(ctx) {
        if (isLegacyPage(ctx)) return legacySubpageLevel(ctx) >= MAX_LEVEL ? {enabled: false, reason: 'Subpages can only be two levels deep'} : {enabled: true};
        const st = pageState(ctx);
        if (!st.enabled) return st;
        const at = pageIndex(ctx.doc).get(currentPageId(ctx));
        return at.level >= MAX_LEVEL ? {enabled: false, reason: 'Subpages can only be two levels deep'} : {enabled: true};
      },
      run(ctx) {
        if (isLegacyPage(ctx)) return legacyNewBelow(ctx, true);
        const {at, index} = afterFamily(ctx, currentPageId(ctx));
        need(at.level < MAX_LEVEL, 'disabled', 'Subpages can only be two levels deep');
        return placeNewPage(ctx, at.section, {index, level: at.level + 1});
      },
    },
    // --- page list ------------------------------------------------------------------------------
    {
      id: 'page.delete', label: 'Delete', risk: 'edit',
      description: 'Move pages to the Notebook Recycle Bin (a collapsed page group goes with its parent).',
      params: s.object({pageIds: idsParam}),
      state: pageState,
      run(ctx, p) {
        const ids = withFamilies(ctx.doc, pageIdsOr(ctx, p.pageIds));
        const removed = deletePages(ctx, ids);
        return {deleted: removed.map(r => r.record.id)};
      },
    },
    {
      id: 'page.rename', label: 'Rename', risk: 'edit',
      description: 'Retitle a page (the title on the page and its tab).',
      params: s.object({pageId: pageIdParam, title: s.string({max: 255})}),
      state: pageState,
      run(ctx, p) {
        const pid = p.pageId ?? currentPageId(ctx);
        locate(ctx, pid);
        const changed = setPageTitle(ctx, pid, p.title);
        return {page: pid, title: ctx.doc.pages[pid].title, changed};
      },
    },
    {
      id: 'page.moveOrCopy', label: 'Move or Copy', shortcut: 'Mod+Alt+M', risk: 'edit', dialog: 'dialog.move-copy-pages',
      description: 'Move or copy pages (with their subpages) to the end of another section.',
      params: s.object({pageIds: idsParam, targetSectionId: s.string({min: 1, max: 80}), mode: s.enum(['move', 'copy'])}),
      state: pageState,
      run(ctx, p) {
        need(ctx.doc.sections[p.targetSectionId], 'not_found', `No section ${p.targetSectionId}`, {path: '/targetSectionId'});
        const ids = withFamilies(ctx.doc, pageIdsOr(ctx, p.pageIds), {always: true});
        const records = ids.map(id => ({record: ctx.doc.pages[id], level: locate(ctx, id).level}));
        if (p.mode === 'copy') {
          const copies = insertRecords(ctx, p.targetSectionId, cloneRecords(ctx, records));
          return {mode: 'copy', pages: copies, section: p.targetSectionId};
        }
        deletePages(ctx, ids, {bin: false});
        insertRecords(ctx, p.targetSectionId, records.map(r => ({...r.record, level: r.level})));
        // OneNote stays in the source section, on the page that took the moved page's place (deletePages selected it).
        return {mode: 'move', pages: ids, section: p.targetSectionId};
      },
    },
    {
      id: 'page.makeSubpage', label: 'Make Subpage', shortcut: 'Mod+Alt+]', risk: 'edit',
      description: 'Indent pages (with their subpages) one level, under the page above.',
      params: s.object({pageIds: idsParam}),
      state(ctx) {
        const st = pageState(ctx);
        if (!st.enabled) return st;
        const at = pageIndex(ctx.doc).get(currentPageId(ctx));
        const list = ctx.doc.sections[at.section].pages;
        if (at.index === 0) return {enabled: false, reason: 'The first page in a section cannot be a subpage'};
        if (at.level >= MAX_LEVEL || at.level > list[at.index - 1].level) return {enabled: false, reason: 'Subpages can only be two levels deep'};
        return {enabled: true};
      },
      run(ctx, p) {
        const ids = pageIdsOr(ctx, p.pageIds);
        return {pages: ids.map(id => shiftFamily(ctx, id, 1))};
      },
    },
    {
      id: 'page.promoteSubpage', label: 'Promote Subpage', shortcut: 'Mod+Alt+[', risk: 'edit',
      description: 'Outdent subpages (with their own subpages) one level.',
      params: s.object({pageIds: idsParam}),
      state(ctx) {
        const st = pageState(ctx);
        if (!st.enabled) return st;
        return pageIndex(ctx.doc).get(currentPageId(ctx)).level > 0 ? {enabled: true} : {enabled: false, reason: 'This page is not a subpage'};
      },
      run(ctx, p) {
        const ids = pageIdsOr(ctx, p.pageIds);
        return {pages: [...ids].reverse().map(id => shiftFamily(ctx, id, -1)).reverse()};
      },
    },
    ...[['page.collapseSubpages', 'Collapse Subpages', true], ['page.expandSubpages', 'Expand Subpages', false]].map(([id, label, collapsed]) => ({
      id, label, risk: 'edit',
      description: `${collapsed ? 'Hide' : 'Show'} the subpages of a page in the page list.`,
      params: s.object({pageId: pageIdParam}),
      state(ctx) {
        const st = pageState(ctx);
        if (!st.enabled) return st;
        const pid = currentPageId(ctx);
        const at = pageIndex(ctx.doc).get(pid);
        const sec = ctx.doc.sections[at.section];
        if (familyRange(sec, at.index).end === at.index) return {enabled: false, reason: 'This page has no subpages'};
        return !!ctx.doc.pages[pid].collapsed === collapsed ? {enabled: false, reason: collapsed ? 'The subpages are already collapsed' : 'The subpages are already shown'} : {enabled: true};
      },
      run(ctx, p) {
        const pid = p.pageId ?? currentPageId(ctx);
        const at = locate(ctx, pid);
        need(familyRange(ctx.doc.sections[at.section], at.index).end > at.index, 'disabled', 'This page has no subpages');
        if (!!ctx.doc.pages[pid].collapsed === collapsed) return {page: pid, collapsed, changed: false};
        if (collapsed) ctx.change.set(['pages', pid, 'collapsed'], true);
        else ctx.change.delete(['pages', pid, 'collapsed']);
        return {page: pid, collapsed, changed: true};
      },
    })),
    {
      id: 'page.toggleGroup', label: 'Expand or Collapse Page Group', shortcut: 'Mod+Shift+8', risk: 'edit',
      description: 'Expand or collapse the page group of the current page (Ctrl+Shift+*).',
      params: s.object({}),
      state(ctx) {
        const st = pageState(ctx);
        if (!st.enabled) return st;
        return groupParent(ctx) ? {enabled: true} : {enabled: false, reason: 'This page is not in a page group'};
      },
      run(ctx) {
        const parent = groupParent(ctx);
        need(parent, 'disabled', 'This page is not in a page group');
        const collapsed = !ctx.doc.pages[parent].collapsed;
        if (collapsed) {
          ctx.change.set(['pages', parent, 'collapsed'], true);
          // A collapsed group shows its parent: a subpage selection moves to it.
          if (currentPageId(ctx) !== parent) ctx.setSelection(selectPage(parent));
        } else ctx.change.delete(['pages', parent, 'collapsed']);
        return {page: parent, collapsed};
      },
    },
    ...[['page.moveUp', 'Move Up', -1], ['page.moveDown', 'Move Down', 1]].map(([id, label, dir]) => ({
      id, label, risk: 'edit',
      description: `Move the page (with its subpages) ${dir < 0 ? 'above the page group before' : 'below the page group after'} it.`,
      params: s.object({pageIds: idsParam}),
      state: pageState,
      run(ctx, p) {
        const ids = pageIdsOr(ctx, p.pageIds);
        const order = dir < 0 ? ids : [...ids].reverse();
        const moved = order.map(pid => movePage(ctx, pid, dir).moved);
        return {moved: moved.some(Boolean)};
      },
    })),
    {
      id: 'page.select', label: 'Select Page', shortcut: 'Mod+Shift+A', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Select the current page\'s tab (to move, copy or delete it).',
      params: s.object({}),
      state: pageState,
      run(ctx) {
        const pid = currentPageId(ctx);
        ctx.setSelection(selectPage(pid));
        return {page: pid};
      },
    },
    {
      id: 'page.focusTitle', label: 'Go to Page Title', shortcut: 'Mod+Shift+T', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Move the insertion point to the page title (selecting its text).',
      params: s.object({}),
      state(ctx) {
        const st = pageState(ctx);
        if (!st.enabled) return st;
        return ctx.doc.pages[currentPageId(ctx)].titleHidden ? {enabled: false, reason: 'The page title is hidden'} : {enabled: true};
      },
      run(ctx) {
        const pid = currentPageId(ctx);
        const n = ctx.doc.pages[pid].title.length;
        const a = `/pg:${pid}/title/t:${n ? `0-${n}` : '0'}`;
        ctx.setSelection({ranges: [{anchor: a, focus: a}], primary: 0});
        return {page: pid, title: ctx.doc.pages[pid].title};
      },
    },
    {
      id: 'page.sort', label: 'Sort Pages', risk: 'edit',
      description: 'Sort the section\'s page groups by date created, date modified or title (subpages stay with their page).',
      params: s.object({by: s.enum(['created', 'modified', 'alphabetical']), order: s.optional(s.enum(['asc', 'desc']))}),
      state: sectionState,
      run(ctx, p) {
        const {sectionId} = here(ctx);
        need(sectionId, 'disabled', 'Open a section first');
        const sec = ctx.doc.sections[sectionId];
        const groups = [];
        for (let i = 0; i < sec.pages.length;) {
          const {end} = familyRange(sec, i);
          groups.push(sec.pages.slice(i, end + 1));
          i = end + 1;
        }
        const key = g => {
          const pg = ctx.doc.pages[g[0].id];
          return p.by === 'alphabetical' ? (pg.title || '').toLocaleLowerCase() : Date.parse(pg[p.by]);
        };
        const sign = p.order === 'desc' ? -1 : 1;
        const sorted = groups.map((g, i) => ({g, i, k: key(g)})).sort((a, b) => (a.k < b.k ? -sign : a.k > b.k ? sign : a.i - b.i)).map(x => x.g);
        // Top pages that were subpages of nothing stay top pages: the first page of each group is level 0.
        setSectionPages(ctx, sectionId, normalizeLevels(sorted.flat()));
        return {section: sectionId, by: p.by, order: p.order ?? 'asc'};
      },
    },
    // --- page setup ------------------------------------------------------------------------------
    {
      id: 'page.setColor', label: 'Page Color', risk: 'edit',
      description: 'Set the page background colour (null = No Color).',
      params: s.object({color: s.nullable(s.string({pattern: '^#[0-9a-fA-F]{6}$'}))}),
      state(ctx, p) {
        const st = pageState(ctx);
        if (!st.enabled) return st;
        const value = ctx.doc.pages[currentPageId(ctx)].color ?? null;
        return {enabled: true, value, ...(p && 'color' in p ? {checked: value === (p.color?.toLowerCase() ?? null)} : {})};
      },
      run(ctx, p) {
        const pid = currentPageId(ctx);
        const color = p.color === null ? null : p.color.toLowerCase();
        return {page: pid, color, changed: setPageFields(ctx, pid, {color})};
      },
    },
    {
      id: 'page.ruleLines', label: 'Rule Lines', risk: 'edit',
      description: 'Show rule lines or a grid on the page ("toggle" switches the last used lines on and off, Ctrl+Shift+R).',
      params: s.object({pattern: s.enum([...RULE_PATTERNS, 'toggle'])}),
      state(ctx, p) {
        const st = pageState(ctx);
        if (!st.enabled) return st;
        const value = ctx.doc.pages[currentPageId(ctx)].rule.pattern;
        return {enabled: true, value, ...(p?.pattern && p.pattern !== 'toggle' ? {checked: value === p.pattern} : {})};
      },
      run(ctx, p) {
        const pid = currentPageId(ctx);
        const page = ctx.doc.pages[pid];
        let pattern = p.pattern;
        if (pattern === 'toggle') pattern = page.rule.pattern === 'none' ? (ctx.prefs?.[LAST_RULE_PREF] ?? DEFAULT_RULE) : 'none';
        if (pattern !== 'none' && ctx.prefs?.[LAST_RULE_PREF] !== pattern) ctx.updatePrefs({[LAST_RULE_PREF]: pattern});
        return {page: pid, pattern, changed: setPageFields(ctx, pid, {rule: {...page.rule, pattern}})};
      },
    },
    {
      id: 'page.ruleLineColor', label: 'Rule Line Color', risk: 'edit',
      description: 'Set the colour of the page\'s rule lines or grid.',
      params: s.object({color: s.string({pattern: '^#[0-9a-fA-F]{6}$'})}),
      state(ctx, p) {
        const st = pageState(ctx);
        if (!st.enabled) return st;
        const rule = ctx.doc.pages[currentPageId(ctx)].rule;
        if (rule.pattern === 'none') return {enabled: false, reason: 'Turn on rule lines first'};
        return {enabled: true, value: rule.color, ...(p?.color ? {checked: rule.color.toLowerCase() === p.color.toLowerCase()} : {})};
      },
      run(ctx, p) {
        const pid = currentPageId(ctx);
        const page = ctx.doc.pages[pid];
        need(page.rule.pattern !== 'none', 'disabled', 'Turn on rule lines first');
        return {page: pid, color: p.color.toLowerCase(), changed: setPageFields(ctx, pid, {rule: {...page.rule, color: p.color.toLowerCase()}})};
      },
    },
    {
      id: 'page.alwaysCreateWithRuleLines', label: 'Always Create Pages with Rule Lines', risk: 'edit', effect: 'prefs', undo: 'none',
      description: 'Give every new page the current page\'s rule lines (or stop doing so).',
      params: s.object({enabled: s.optional(s.boolean({description: 'Default: toggle'}))}),
      state(ctx) {
        const st = pageState(ctx);
        return {...st, checked: !!ctx.prefs?.[NEW_PAGE_RULE_PREF]};
      },
      run(ctx, p) {
        const on = p.enabled ?? !ctx.prefs?.[NEW_PAGE_RULE_PREF];
        let rule = null;
        if (on) {
          const pid = currentPageId(ctx);
          const cur = ctx.doc.pages[pid].rule;
          rule = cur.pattern === 'none' ? {pattern: ctx.prefs?.[LAST_RULE_PREF] ?? DEFAULT_RULE, color: cur.color} : {...cur};
        }
        ctx.updatePrefs({[NEW_PAGE_RULE_PREF]: rule});
        return {enabled: on, rule};
      },
    },
    {
      id: 'page.hideTitle', label: 'Hide Page Title', risk: 'edit',
      description: 'Hide (or show again) the page title and its date and time; hiding deletes the title text.',
      params: s.object({}),
      riskFor: ctx => (isNotebook(ctx.doc) && (() => { const pid = currentLocation(ctx.doc, ctx.selection).pageId; const pg = pid && ctx.doc.pages[pid]; return pg && !pg.titleHidden && pg.title; })() ? 'destructive' : 'edit'),
      summary: ctx => {
        const pid = currentLocation(ctx.doc, ctx.selection).pageId;
        return `Hiding the page title deletes the title "${ctx.doc.pages[pid]?.title ?? ''}" and its date and time.`;
      },
      state(ctx) {
        const st = pageState(ctx);
        if (!st.enabled) return st;
        return {enabled: true, checked: !!ctx.doc.pages[currentPageId(ctx)].titleHidden};
      },
      run(ctx) {
        const pid = currentPageId(ctx);
        const page = ctx.doc.pages[pid];
        const hide = !page.titleHidden;
        if (hide && page.title) setPageTitle(ctx, pid, '');
        setPageFields(ctx, pid, {titleHidden: hide});
        return {page: pid, hidden: hide};
      },
    },
    {
      id: 'page.paperSize', label: 'Paper Size', risk: 'edit', dialog: 'dialog.paper-size',
      description: 'Set the page\'s paper size (Auto = no fixed size), orientation and print margins, in inches.',
      params: s.object({
        size: s.enum(Object.keys(PAPER_SIZES)),
        orientation: s.optional(s.enum(['portrait', 'landscape'])),
        width: s.optional(s.number({min: 1, max: 100})),
        height: s.optional(s.number({min: 1, max: 100})),
        margins: s.optional(s.object({top: s.optional(s.number({min: 0, max: 20})), bottom: s.optional(s.number({min: 0, max: 20})),
          left: s.optional(s.number({min: 0, max: 20})), right: s.optional(s.number({min: 0, max: 20}))})),
      }),
      state(ctx) {
        const st = pageState(ctx);
        if (!st.enabled) return st;
        return {enabled: true, value: ctx.doc.pages[currentPageId(ctx)].paperSize ?? {size: 'Auto'}};
      },
      run(ctx, p) {
        const pid = currentPageId(ctx);
        if (p.size === 'Auto') return {page: pid, paperSize: null, changed: setPageFields(ctx, pid, {paperSize: null})};
        const orientation = p.orientation ?? ctx.doc.pages[pid].paperSize?.orientation ?? 'portrait';
        const [w0, h0] = PAPER_SIZES[p.size];
        const [w, h] = orientation === 'landscape' ? [h0, w0] : [w0, h0];
        const margins = {...DEFAULT_MARGINS, ...(ctx.doc.pages[pid].paperSize?.margins ?? {}), ...(p.margins ?? {})};
        const width = p.width ?? w, height = p.height ?? h;
        need(margins.left + margins.right < width && margins.top + margins.bottom < height, 'invalid_params', 'The margins are larger than the page', {path: '/margins'});
        const paperSize = {size: p.size, orientation, width, height, margins};
        return {page: pid, paperSize, changed: setPageFields(ctx, pid, {paperSize})};
      },
    },
    {
      id: 'page.setDate', label: 'Change Page Date', risk: 'edit',
      description: 'Change the date shown under the page title (YYYY-MM-DD); the time stays.',
      params: s.object({date: s.string({pattern: '^\\d{4}-\\d{2}-\\d{2}$'}), pageId: pageIdParam}),
      state: pageState,
      run(ctx, p) {
        const pid = p.pageId ?? currentPageId(ctx);
        locate(ctx, pid);
        const [, y, m, d] = iDate.exec(p.date).map(Number);
        const cur = new Date(ctx.doc.pages[pid].created);
        const next = new Date(y, m - 1, d, cur.getHours(), cur.getMinutes(), cur.getSeconds());
        need(next.getMonth() === m - 1 && next.getDate() === d, 'invalid_params', `${p.date} is not a date`, {path: '/date'});
        setPageFields(ctx, pid, {created: next.toISOString()});
        return {page: pid, created: next.toISOString()};
      },
    },
    {
      id: 'page.setTime', label: 'Change Page Time', risk: 'edit',
      description: 'Change the time shown under the page title (HH:MM, or h:MM AM/PM); the date stays.',
      params: s.object({time: s.string({max: 12}), pageId: pageIdParam}),
      state: pageState,
      run(ctx, p) {
        const pid = p.pageId ?? currentPageId(ctx);
        locate(ctx, pid);
        const m = iTime.exec(p.time.trim());
        need(m, 'invalid_params', `${p.time} is not a time`, {path: '/time'});
        let h = Number(m[1]);
        const min = Number(m[2]);
        if (m[3]) { need(h >= 1 && h <= 12, 'invalid_params', `${p.time} is not a time`, {path: '/time'}); h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0); }
        need(h <= 23 && min <= 59, 'invalid_params', `${p.time} is not a time`, {path: '/time'});
        const cur = new Date(ctx.doc.pages[pid].created);
        const next = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), h, min, 0);
        setPageFields(ctx, pid, {created: next.toISOString()});
        return {page: pid, created: next.toISOString()};
      },
    },
    // --- clipboard ----------------------------------------------------------------------------
    ...[['page.copy', 'Copy', false], ['page.cut', 'Cut', true]].map(([id, label, cut]) => ({
      id, label, risk: 'edit', ...(cut ? {} : {effect: 'view', undo: 'none'}),
      description: `${label} pages (with collapsed subpages) to the clipboard${cut ? ', removing them from the section' : ''}.`,
      params: s.object({pageIds: idsParam}),
      state: pageState,
      async run(ctx, p) {
        const ids = withFamilies(ctx.doc, pageIdsOr(ctx, p.pageIds));
        const records = ids.map(pid => ({record: structuredClone(ctx.doc.pages[pid]), level: locate(ctx, pid).level}));
        const text = records.map(r => r.record.title || 'Untitled page').join('\n');
        await writeClipboard(ctx, {text, kind: 'slate.pages', data: {pages: records, cut, notebook: ctx.doc.notebook.id}, label: `${ids.length} page${ids.length > 1 ? 's' : ''}`});
        if (cut) deletePages(ctx, ids, {bin: false});
        return {pages: ids};
      },
    })),
    {
      id: 'page.paste', label: 'Paste', risk: 'edit',
      description: 'Paste copied or cut pages into a section (at the end, or after a page).',
      params: s.object({targetSectionId: s.optional(s.string({min: 1, max: 80})), afterPageId: s.optional(s.string({min: 1, max: 80}))}),
      state(ctx) {
        const st = sectionState(ctx);
        if (!st.enabled) return st;
        return ctx.clipboard?.kind === 'slate.pages' ? {enabled: true} : {enabled: false, reason: 'The clipboard holds no pages'};
      },
      run(ctx, p) {
        const clip = ctx.clipboard;
        need(clip?.kind === 'slate.pages', 'disabled', 'The clipboard holds no pages');
        const sid = p.targetSectionId ?? here(ctx).sectionId;
        need(ctx.doc.sections[sid], 'not_found', `No section ${sid}`, {path: '/targetSectionId'});
        let index;
        if (p.afterPageId !== undefined) {
          const {at, index: i} = afterFamily(ctx, p.afterPageId);
          need(at.section === sid, 'not_found', `No page ${p.afterPageId} in that section`, {path: '/afterPageId'});
          index = i;
        }
        // Cut pages come back with their ids the first time; copies (and later pastes) get new ones.
        const records = clip.data.pages.map(r => (clip.data.cut && !ctx.doc.pages[r.record.id] ? {...structuredClone(r.record), level: r.level}
          : {...structuredClone(r.record), id: `p${ctx.host.uid()}`, level: r.level}));
        const ids = insertRecords(ctx, sid, records, index);
        ctx.setSelection(selectPage(ids[0]));
        return {pages: ids, section: sid};
      },
    },
  ],
});

/** The parent page of the current page's group (itself when it has subpages). */
function groupParent(ctx) {
  const pid = currentLocation(ctx.doc, ctx.selection).pageId;
  if (!pid) return null;
  const at = pageIndex(ctx.doc).get(pid);
  const list = ctx.doc.sections[at.section].pages;
  if (at.index + 1 < list.length && list[at.index + 1].level > at.level) return pid;
  for (let i = at.index - 1; i >= 0; i--) if (list[i].level < at.level) return list[i].id;
  return null;
}

