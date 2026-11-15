// History tab: Unread, Authors, Recent Edits, Page Versions and the Notebook Recycle Bin (U:slate/history).
//
// Slate has no ArtCraft upstream: ids, args and summaries are docs/spec/slate.json `history.*`;
// behaviour is OneNote's History tab (see core/slate/lib/history.mjs for the model):
//   * Next Unread goes to the next unread page of the notebook and marks it read; Mark as Read /
//     Unread (Ctrl+Q) acts on the page, the section or the notebook; Show Unread Changes in this
//     Notebook shows unread pages in bold in the page list;
//   * Find by Author lists the pages by who edited them last (this section, its section group or
//     the notebook); Hide Authors hides author names in the results and the version list;
//   * Recent Edits lists the pages edited today, since yesterday, in the last 7/14/30 days, 3/6
//     months, or all pages by date;
//   * Page Versions lists the saved versions of the page: view one (read-only, with its date and
//     author), restore it (the page as it is now is kept as a version) or delete it; Delete All
//     Versions in a section, section group or the notebook asks first; Disable History for this
//     Notebook deletes every version and the bin and stops saving versions;
//   * Notebook Recycle Bin lists deleted pages, sections and section groups for 60 days; each can be
//     restored; Empty Recycle Bin asks first.
// The results panes are drawn by the page surface from `view.pane`; the commands set it.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook, newPageRecord} from '../schema.mjs';
import {addPage, currentLocation, selectPage, selectSection} from '../model/notebook.mjs';
import {RECYCLE_DAYS, binOf} from '../lib/pages-recycle.mjs';
import {RANGES, allPages, authorOf, byAuthor, findVersion, historyOn, nextUnread, recentEdits, sectionsInScope, setVersions, snapshotNow, versionsOf} from '../lib/history.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/history.*']};
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };
const SCOPES = ['section', 'group', 'notebook'];
const view = ctx => ctx.view ?? {};
const notebookState = ctx => (isNotebook(ctx.doc) ? {enabled: true} : {enabled: false, reason: 'No notebook is open'});
const pageState = ctx => {
  if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
  return currentLocation(ctx.doc, ctx.selection).pageId ? {enabled: true} : {enabled: false, reason: 'No page is open'};
};
const iso = ctx => new Date(ctx.host.now()).toISOString();
const here = ctx => currentLocation(ctx.doc, ctx.selection);

/** The pages of a scope as ids. */
function pagesOfScope(ctx, scope) {
  const c = ctx.doc;
  const {sectionId, pageId} = here(ctx);
  if (scope === 'page') { need(pageId, 'disabled', 'No page is open'); return [pageId]; }
  if (scope === 'notebook') return allPages(c).map(p => p.id);
  const ids = sectionsInScope(c, sectionId, scope === 'section-group' ? 'group' : scope);
  need(ids || scope === 'notebook', 'disabled', 'Open a section first');
  return allPages(c).filter(p => !ids || ids.has(p.section)).map(p => p.id);
}

function openPane(ctx, pane) { ctx.setView({pane}); return pane; }

export default defineCommands({
  family: 'history',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    // --- Unread -----------------------------------------------------------------------------------
    {
      id: 'history.nextUnread', label: 'Next Unread', risk: 'edit', effect: 'content',
      description: 'Go to the next unread page of the notebook (wrapping round) and mark it read.',
      params: s.object({}),
      state(ctx) {
        if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
        return allPages(ctx.doc).some(p => p.unread) ? {enabled: true} : {enabled: false, reason: 'There are no unread pages'};
      },
      run(ctx) {
        const id = nextUnread(ctx.doc, here(ctx).pageId) ?? (ctx.doc.pages[here(ctx).pageId]?.unread ? here(ctx).pageId : null);
        need(id, 'disabled', 'There are no unread pages');
        ctx.change.delete(['pages', id, 'unread']);
        ctx.setSelection(selectPage(id));
        return {page: `/pg:${id}`, title: ctx.doc.pages[id].title};
      },
    },
    {
      id: 'history.markRead', label: 'Mark as Read', shortcut: 'Mod+Q', risk: 'edit',
      description: 'Mark the page, the section or the whole notebook as read (read: true) or unread (read: false); unread pages show in bold.',
      params: s.object({scope: s.optional(s.enum(['page', 'section', 'notebook'])), read: s.optional(s.boolean())}),
      state: notebookState,
      run(ctx, p) {
        const scope = p.scope ?? 'page';
        const read = p.read ?? ctx.doc.pages[here(ctx).pageId]?.unread === true;
        const ids = pagesOfScope(ctx, scope);
        let changed = 0;
        for (const id of ids) {
          const unread = ctx.doc.pages[id].unread === true;
          if (read && unread) { ctx.change.delete(['pages', id, 'unread']); changed++; }
          else if (!read && !unread) { ctx.change.set(['pages', id, 'unread'], true); changed++; }
        }
        return {scope, read, pages: ids.length, changed};
      },
    },
    {
      id: 'history.showUnread', label: 'Show Unread Changes in this Notebook', risk: 'read', effect: 'view',
      description: 'Show unread pages in bold in the page list (on by default).',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx) { return isNotebook(ctx.doc) ? {enabled: true, checked: view(ctx).showUnread !== false} : {enabled: false, reason: 'No notebook is open'}; },
      run(ctx, p) { const on = p.value ?? view(ctx).showUnread === false; ctx.setView({showUnread: on}); return {value: on}; },
    },

    // --- Authors ----------------------------------------------------------------------------------
    {
      id: 'history.findByAuthor', label: 'Find by Author', risk: 'read', effect: 'view',
      description: 'List the pages by the author who edited them last, for this section, its section group or the notebook; author narrows it to one.',
      params: s.object({scope: s.optional(s.enum(SCOPES)), author: s.optional(s.string({min: 1, max: 80}))}),
      state: notebookState,
      run(ctx, p) {
        const scope = p.scope ?? 'notebook';
        const ids = sectionsInScope(ctx.doc, here(ctx).sectionId, scope);
        const authors = byAuthor(ctx.doc, {sectionIds: ids, author: p.author ?? null});
        openPane(ctx, {kind: 'authors', scope, ...(p.author ? {author: p.author} : {})});
        return {scope, authors: authors.map(a => ({author: a.author, pages: a.pages.length}))};
      },
    },
    {
      id: 'history.hideAuthors', label: 'Hide Authors', risk: 'read', effect: 'view',
      description: 'Hide author names in the History results and the page version list.',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx) { return isNotebook(ctx.doc) ? {enabled: true, checked: view(ctx).hideAuthors === true} : {enabled: false, reason: 'No notebook is open'}; },
      run(ctx, p) { const on = p.value ?? view(ctx).hideAuthors !== true; ctx.setView({hideAuthors: on}); return {value: on}; },
    },

    // --- Recent Edits -----------------------------------------------------------------------------
    {
      id: 'history.recentEdits', label: 'Recent Edits', risk: 'read', effect: 'view',
      description: 'List the pages edited in a range, newest first: today, since yesterday, 7d, 14d, 30d, 3m, 6m or all pages sorted by date.',
      params: s.object({range: s.optional(s.enum(RANGES)), scope: s.optional(s.enum(SCOPES))}),
      state: notebookState,
      run(ctx, p) {
        const range = p.range ?? '7d';
        const scope = p.scope ?? 'notebook';
        const pages = recentEdits(ctx.doc, range, ctx.host.now(), {sectionIds: sectionsInScope(ctx.doc, here(ctx).sectionId, scope)});
        openPane(ctx, {kind: 'recent', range, scope});
        return {range, scope, pages: pages.map(x => ({page: `/pg:${x.id}`, title: x.title, modified: x.modified, author: x.modifiedBy}))};
      },
    },

    // --- Page Versions ----------------------------------------------------------------------------
    {
      id: 'history.pageVersions', label: 'Page Versions', risk: 'read', effect: 'view',
      description: 'Show or hide the list of saved versions of the current page.',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx) {
        const r = pageState(ctx);
        return r.enabled ? {enabled: true, checked: view(ctx).pane?.kind === 'versions'} : r;
      },
      run(ctx, p) {
        const on = p.value ?? view(ctx).pane?.kind !== 'versions';
        if (!on) { ctx.setView({pane: null, versionView: null}); return {value: false}; }
        const pageId = here(ctx).pageId;
        need(pageId, 'disabled', 'No page is open');
        openPane(ctx, {kind: 'versions', page: pageId});
        return {value: true, versions: versionsOf(ctx.doc, pageId).length, history: historyOn(ctx.doc)};
      },
    },
    {
      id: 'history.viewVersion', label: 'View Version', risk: 'read', effect: 'view',
      description: 'Show a saved version of the page read-only in the page area, with its date and author; null goes back to the current page.',
      params: s.object({versionId: s.nullable(s.string({min: 1, max: 80}))}),
      state: pageState,
      run(ctx, p) {
        if (p.versionId === null) { ctx.setView({versionView: null}); return {viewing: null}; }
        const hit = findVersion(ctx.doc, p.versionId);
        ctx.setView({versionView: {page: hit.pageId, version: hit.version.id}});
        ctx.setSelection(selectPage(hit.pageId));
        return {viewing: hit.version.id, page: hit.pageId, saved: hit.version.saved, author: hit.version.author};
      },
    },
    {
      id: 'history.restoreVersion', label: 'Restore Version', risk: 'edit',
      description: 'Make a saved version the page: its title, notes, ink and look replace the page\'s, and the page as it is now is kept as a version.',
      params: s.object({versionId: s.string({min: 1, max: 80})}),
      state: pageState,
      run(ctx, p) {
        const {pageId, version} = findVersion(ctx.doc, p.versionId);
        const kept = snapshotNow(ctx, pageId);
        const page = ctx.doc.pages[pageId];
        ctx.change.set(['pages', pageId], {...page, title: version.title, body: version.body, ink: version.ink, color: version.color ?? null, rule: version.rule ?? page.rule,
          titleHidden: !!version.titleHidden, paperSize: version.paperSize ?? null, modified: iso(ctx), modifiedBy: authorOf(ctx)});
        ctx.setView({versionView: null});
        ctx.setSelection(selectPage(pageId));
        return {restored: version.id, page: `/pg:${pageId}`, kept};
      },
    },
    {
      id: 'history.deleteVersion', label: 'Delete Version', risk: 'edit',
      description: 'Delete one saved version of a page.',
      params: s.object({versionId: s.string({min: 1, max: 80})}),
      state: pageState,
      run(ctx, p) {
        const {pageId} = findVersion(ctx.doc, p.versionId);
        setVersions(ctx, pageId, versionsOf(ctx.doc, pageId).filter(v => v.id !== p.versionId));
        if (view(ctx).versionView?.version === p.versionId) ctx.setView({versionView: null});
        return {deleted: p.versionId, left: versionsOf(ctx.doc, pageId).length - 1};
      },
    },
    {
      id: 'history.deleteVersions', label: 'Delete All Versions', risk: 'edit', dialog: 'dialog.confirm-delete-versions',
      description: 'Delete every saved version of the pages in a section, a section group or the notebook (the current version of each page is kept); confirmed must be true (the dialog asks).',
      params: s.object({scope: s.enum(['section', 'section-group', 'notebook']), confirmed: s.boolean({description: 'The person said yes to "Delete all page versions?"'})}),
      state: notebookState,
      run(ctx, p) {
        need(p.confirmed === true, 'invalid_params', 'Deleting versions needs confirmed: true', {path: '/confirmed'});
        const ids = new Set(pagesOfScope(ctx, p.scope));
        let versions = 0, pages = 0;
        const keep = {};
        for (const [pid, list] of Object.entries(ctx.doc.versions ?? {})) {
          if (!ids.has(pid)) { keep[pid] = list; continue; }
          versions += list.length;
          pages++;
        }
        if (versions) ctx.change.set(['versions'], keep);
        ctx.setView({versionView: null});
        return {scope: p.scope, versions, pages};
      },
    },
    {
      id: 'history.disable', label: 'Disable History for this Notebook', risk: 'edit', dialog: 'dialog.confirm-disable-history',
      description: 'Turn page history off (value true, the default) or on: turning it off deletes every saved version and empties the Recycle Bin and stops new versions; confirmed must be true to turn it off.',
      params: s.object({value: s.optional(s.boolean()), confirmed: s.optional(s.boolean())}),
      state(ctx) { return isNotebook(ctx.doc) ? {enabled: true, checked: !historyOn(ctx.doc)} : {enabled: false, reason: 'No notebook is open'}; },
      run(ctx, p) {
        const off = p.value ?? historyOn(ctx.doc);
        if (!off) {
          if (ctx.doc.notebook.historyDisabled) ctx.change.delete(['notebook', 'historyDisabled']);
          return {historyDisabled: false};
        }
        need(p.confirmed === true, 'invalid_params', 'Disabling history deletes every version and the Recycle Bin: confirmed must be true', {path: '/confirmed'});
        const versions = Object.values(ctx.doc.versions ?? {}).reduce((n, l) => n + l.length, 0);
        const binned = binOf(ctx.doc).length;
        ctx.change.set(['notebook', 'historyDisabled'], true);
        if (ctx.doc.versions) ctx.change.set(['versions'], {});
        if (binned) ctx.change.set(['notebook', 'recycleBin'], []);
        ctx.setView({versionView: null});
        return {historyDisabled: true, versions, binned};
      },
    },

    // --- Notebook Recycle Bin ---------------------------------------------------------------------
    {
      id: 'history.recycleBin', label: 'Notebook Recycle Bin', risk: 'edit',
      description: 'Open the Notebook Recycle Bin: deleted pages, sections and section groups, kept for 60 days (older ones are removed now).',
      params: s.object({}),
      state: notebookState,
      run(ctx) {
        const cutoff = ctx.host.now() - RECYCLE_DAYS * 86_400_000;
        const bin = binOf(ctx.doc);
        const kept = bin.filter(e => Date.parse(e.deleted) >= cutoff || !Number.isFinite(Date.parse(e.deleted)));
        if (kept.length !== bin.length) ctx.change.set(['notebook', 'recycleBin'], kept);
        openPane(ctx, {kind: 'recycle'});
        return {entries: kept.map(e => ({entry: e.id, kind: e.kind, deleted: e.deleted, name: entryName(e)})), expired: bin.length - kept.length, days: RECYCLE_DAYS};
      },
    },
    {
      id: 'history.restoreItem', label: 'Restore', risk: 'edit',
      description: 'Restore a page, section or section group from the Recycle Bin by its entry id: a page goes to the end of targetSectionId (its old section, else the current one); a section or group goes back where it was, else to the notebook\'s top level.',
      params: s.object({entryId: s.string({min: 1, max: 80}), targetSectionId: s.optional(s.string({min: 1, max: 80}))}),
      state: notebookState,
      run: (ctx, p) => restoreEntry(ctx, binEntry(ctx, p.entryId), p.targetSectionId),
    },
    {
      id: 'history.restorePage', label: 'Restore Page', risk: 'edit',
      description: 'Restore a deleted page by its id (or its bin entry id) to the end of targetSectionId (its old section, else the current one).',
      params: s.object({pageId: s.string({min: 1, max: 80}), targetSectionId: s.optional(s.string({min: 1, max: 80}))}),
      state: notebookState,
      run(ctx, p) {
        const e = binOf(ctx.doc).find(x => x.kind === 'page' && (x.id === p.pageId || x.page?.id === p.pageId));
        need(e, 'not_found', `No deleted page ${p.pageId} in the Recycle Bin`, {path: '/pageId'});
        return restoreEntry(ctx, e, p.targetSectionId);
      },
    },
    {
      id: 'history.emptyRecycleBin', label: 'Empty Recycle Bin', risk: 'edit', dialog: 'dialog.confirm-empty-recycle-bin',
      description: 'Permanently delete everything in the Notebook Recycle Bin; confirmed must be true (the dialog asks first).',
      params: s.object({confirmed: s.boolean({description: 'The person said yes to "Permanently delete all pages and sections in the Notebook Recycle Bin?"'})}),
      state(ctx) {
        if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
        return binOf(ctx.doc).length ? {enabled: true} : {enabled: false, reason: 'The Recycle Bin is empty'};
      },
      run(ctx, p) {
        need(p.confirmed === true, 'invalid_params', 'Emptying the Recycle Bin needs confirmed: true', {path: '/confirmed'});
        const n = binOf(ctx.doc).length;
        if (n) ctx.change.set(['notebook', 'recycleBin'], []);
        return {deleted: n};
      },
    },
    {
      id: 'history.closePane', label: 'Close', risk: 'read', effect: 'view',
      description: 'Close the History results pane (and the version being viewed).',
      params: s.object({}),
      state: notebookState,
      run(ctx) { ctx.setView({pane: null, versionView: null}); return {closed: true}; },
    },
  ],
});

export function entryName(e) {
  if (e.kind === 'page') return e.page?.title || 'Untitled page';
  if (e.kind === 'section') return e.section?.name ?? 'Section';
  return e.group?.name ?? 'Section group';
}

function binEntry(ctx, id) {
  const e = binOf(ctx.doc).find(x => x.id === id);
  need(e, 'not_found', `No Recycle Bin entry ${id}`, {path: '/entryId'});
  return e;
}

function removeEntry(ctx, e) {
  const at = binOf(ctx.doc).findIndex(x => x.id === e.id);
  ctx.change.splice(['notebook', 'recycleBin'], at, 1);
}

function restoreEntry(ctx, e, targetSectionId) {
  const c = ctx.doc;
  if (e.kind === 'page') {
    const home = targetSectionId ?? (c.sections[e.from?.sectionId] ? e.from.sectionId : here(ctx).sectionId);
    need(home && c.sections[home], 'not_found', 'There is no section to restore the page to', {path: '/targetSectionId'});
    need(!c.pages[e.page.id], 'invalid_params', `Page ${e.page.id} already exists`);
    const id = addPage(ctx, home, {record: {...newPageRecord({id: e.page.id, created: e.page.created}), ...e.page}, level: 0});
    removeEntry(ctx, e);
    ctx.setSelection(selectPage(id));
    return {restored: 'page', page: `/pg:${id}`, section: `/sec:${home}`};
  }
  // A section or a group: back to its place in the notebook.
  const topId = e.kind === 'section' ? e.section.id : e.group.id;
  need(!c.sections[topId] && !c.groups[topId], 'invalid_params', `${topId} already exists`);
  const sections = e.kind === 'section' ? {[e.section.id]: e.section} : e.sections;
  const pages = e.pages ?? {};
  for (const id of Object.keys(sections)) need(!c.sections[id] && !c.groups[id], 'invalid_params', `${id} already exists`);
  for (const id of Object.keys(pages)) need(!c.pages[id], 'invalid_params', `Page ${id} already exists`);
  const parent = e.from?.parent && c.groups[e.from.parent] ? e.from.parent : null;
  const list = parent ? c.groups[parent].items : c.tree;
  const index = Math.max(0, Math.min(Number.isInteger(e.from?.index) ? e.from.index : list.length, list.length));
  for (const [id, rec] of Object.entries(e.kind === 'group' ? e.groups : {})) ctx.change.set(['groups', id], rec);
  for (const [id, rec] of Object.entries(sections)) ctx.change.set(['sections', id], rec);
  for (const [id, rec] of Object.entries(pages)) ctx.change.set(['pages', id], rec);
  ctx.change.splice(parent ? ['groups', parent, 'items'] : ['tree'], index, 0, topId);
  removeEntry(ctx, e);
  const first = e.kind === 'section' ? e.section.pages[0]?.id : Object.values(sections)[0]?.pages?.[0]?.id;
  ctx.setSelection(first ? selectPage(first) : e.kind === 'section' ? selectSection(topId) : selectSection(Object.keys(sections)[0]));
  return {restored: e.kind, [e.kind]: `/${e.kind === 'section' ? 'sec' : 'grp'}:${topId}`, pages: Object.keys(pages).length};
}
