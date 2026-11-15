// History: authors, page versions, unread marks, recent edits and the bin (U:slate/history).
//
// Slate has no ArtCraft upstream; this is OneNote's History tab on a notebook that lives in one
// folder on one machine:
//   * Author is the local profile name (the host's `profileName()`, else the `slate.author`
//     preference, else "Me"). Nothing else about the person is read or stored. A page records who
//     created it (`author`) and who edited it last (`modifiedBy`).
//   * Page versions are real snapshots of a page (title, notes, ink, look), kept in
//     `content.versions[pageId]` (newest last) and saved beside the page in the notebook folder
//     (`<pageId>.versions.json`). A version is taken when an edit comes after the page had rested
//     for VERSION_GAP_MINUTES: the page as it was before the edit becomes a version, the way OneNote
//     saves one per editing session. At most MAX_VERSIONS (and MAX_VERSION_BYTES of text) are kept
//     per page, the oldest go first. Disabling history for the notebook stops versions and clears
//     them and the bin.
//   * Unread: `page.unread === true` for a page marked unread; bold in the page list.
//
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook} from '../schema.mjs';
import {pageIndex, sectionOrder} from '../model/notebook.mjs';

export const VERSION_GAP_MINUTES = 30;
export const MAX_VERSIONS = 20;
export const MAX_VERSION_BYTES = 6 * 1024 * 1024;
export const AUTHOR_PREF = 'slate.author';
export const DEFAULT_AUTHOR = 'Me';

/** The local profile name: the author of every edit made here. */
export function authorOf(ctx) {
  let name = null;
  try { name = ctx.host?.profileName?.(); } catch { name = null; }
  const pref = ctx.prefs?.[AUTHOR_PREF];
  const out = String(name || pref || DEFAULT_AUTHOR).trim().slice(0, 80);
  return out || DEFAULT_AUTHOR;
}

export const historyOn = content => content?.notebook?.historyDisabled !== true;

// ---------------------------------------------------------------------------------------------
// Versions

/** The page's saved versions, oldest first. */
export const versionsOf = (content, pageId) => (Array.isArray(content?.versions?.[pageId]) ? content.versions[pageId] : []);

/** What a version keeps of a page. */
export const snapshotOf = (page, id, author) => ({id, saved: page.modified, author: author ?? page.modifiedBy ?? page.author ?? null, title: page.title, color: page.color ?? null,
  rule: page.rule, titleHidden: !!page.titleHidden, paperSize: page.paperSize ?? null, body: page.body, ink: page.ink ?? []});

const sizeOf = v => { try { return JSON.stringify(v.body).length + JSON.stringify(v.ink).length + (v.title?.length ?? 0); } catch { return 0; } };
const hasContent = page => !!(page.title || (page.ink?.length ?? 0) || (page.body?.content?.length ?? 0));

/** Keep a version list within its bounds (newest versions win). */
export function bounded(list) {
  let out = list.slice(-MAX_VERSIONS);
  let total = out.reduce((n, v) => n + sizeOf(v), 0);
  while (out.length > 1 && total > MAX_VERSION_BYTES) { total -= sizeOf(out[0]); out = out.slice(1); }
  return out;
}

/** Write a page's version list (an empty list removes the entry). */
export function setVersions(ctx, pageId, list) {
  const cur = ctx.doc.versions;
  if (!list.length) { if (cur && cur[pageId]) ctx.change.set(['versions'], Object.fromEntries(Object.entries(cur).filter(([k]) => k !== pageId))); return; }
  if (!cur) ctx.change.set(['versions'], {[pageId]: list});
  else ctx.change.set(['versions', pageId], list);
}

/**
 * Before an edit to a page: when the page had rested for the gap (and has something in it), what it
 * is now becomes a version. Returns the new version id or null.
 */
export function snapshotIfDue(ctx, pageId) {
  const c = ctx.doc;
  if (!isNotebook(c) || !historyOn(c)) return null;
  const page = c.pages?.[pageId];
  if (!page || !hasContent(page)) return null;
  const now = ctx.host.now();
  const last = Date.parse(page.modified);
  if (!Number.isFinite(last) || now - last < VERSION_GAP_MINUTES * 60_000) return null;
  const list = versionsOf(c, pageId);
  if (list.length && list[list.length - 1].saved === page.modified) return null;
  const id = `v${ctx.host.uid()}`;
  setVersions(ctx, pageId, bounded([...list, snapshotOf(page, id)]));
  return id;
}

/** Take the page as it is as a version now (before a restore replaces it). Skips when the newest version is the same. */
export function snapshotNow(ctx, pageId, {force = false} = {}) {
  const c = ctx.doc;
  if (!isNotebook(c) || !historyOn(c)) return null;
  const page = c.pages[pageId];
  const list = versionsOf(c, pageId);
  const top = list[list.length - 1];
  if (!force && top && top.saved === page.modified && top.body === page.body && top.ink === page.ink && top.title === page.title) return null;
  const id = `v${ctx.host.uid()}`;
  setVersions(ctx, pageId, bounded([...list, snapshotOf(page, id)]));
  return id;
}

export function findVersion(content, versionId, pageId = null) {
  for (const [pid, list] of Object.entries(content.versions ?? {})) {
    if (pageId && pid !== pageId) continue;
    const v = list.find(x => x.id === versionId);
    if (v) return {pageId: pid, version: v};
  }
  throw new CommandError('not_found', `No page version ${versionId}`, {path: '/versionId'});
}

// ---------------------------------------------------------------------------------------------
// Queries over the notebook (shared by the commands and the results panes)

/** Every page in notebook order: [{id, title, section, sectionName, level, created, modified, author, modifiedBy, unread}]. */
export function allPages(content) {
  const out = [];
  for (const sid of sectionOrder(content)) {
    const sec = content.sections[sid];
    for (const e of sec.pages) {
      const p = content.pages[e.id];
      out.push({id: p.id, title: p.title, section: sid, sectionName: sec.name, level: e.level, created: p.created, modified: p.modified,
        author: p.author ?? null, modifiedBy: p.modifiedBy ?? p.author ?? null, unread: p.unread === true});
    }
  }
  return out;
}

export const RANGES = Object.freeze(['today', 'since-yesterday', '7d', '14d', '30d', '3m', '6m', 'all']);
export const RANGE_LABELS = Object.freeze({today: 'Today', 'since-yesterday': 'Since Yesterday', '7d': 'Last 7 Days', '14d': 'Last 14 Days', '30d': 'Last 30 Days',
  '3m': 'Last 3 Months', '6m': 'Last 6 Months', all: 'All Pages Sorted by Date'});

/** The moment a range starts (ms), in the person's local time; null for all. */
export function rangeStart(range, now) {
  if (range === 'all') return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (range === 'today') return d.getTime();
  if (range === 'since-yesterday') { d.setDate(d.getDate() - 1); return d.getTime(); }
  if (range === '7d' || range === '14d' || range === '30d') { d.setDate(d.getDate() - Number.parseInt(range, 10)); return d.getTime(); }
  if (range === '3m' || range === '6m') { d.setMonth(d.getMonth() - Number.parseInt(range, 10)); return d.getTime(); }
  throw new CommandError('invalid_params', `Unknown range ${range}`, {path: '/range'});
}

/** Pages edited in a range, newest first (Recent Edits). `scope` limits to a section, section group or the notebook. */
export function recentEdits(content, range, now, {sectionIds = null} = {}) {
  const from = rangeStart(range, now);
  return allPages(content)
    .filter(p => (!sectionIds || sectionIds.has(p.section)) && (from === null || Date.parse(p.modified) >= from))
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
}

/** Sections an author search covers: 'section' (the current one), 'group' (its group), 'notebook'. */
export function sectionsInScope(content, sectionId, scope) {
  if (scope === 'notebook' || !sectionId) return null;
  if (scope === 'section') return new Set([sectionId]);
  // The section group the section is in (or the notebook root's sections when it is at the top).
  const inGroup = Object.values(content.groups).find(g => g.items.includes(sectionId));
  if (!inGroup) return new Set(content.tree.filter(id => content.sections[id]));
  const out = new Set();
  const walk = id => { if (content.sections[id]) out.add(id); else for (const k of content.groups[id]?.items ?? []) walk(k); };
  walk(inGroup.id);
  return out;
}

/** Pages grouped by the author who last edited them: [{author, pages: [...]}], authors A to Z. */
export function byAuthor(content, {sectionIds = null, author = null} = {}) {
  const groups = new Map();
  for (const p of allPages(content)) {
    if (sectionIds && !sectionIds.has(p.section)) continue;
    const name = p.modifiedBy ?? 'Unknown author';
    if (author && name !== author) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(p);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([a, pages]) => ({author: a, pages: pages.sort((x, y) => Date.parse(y.modified) - Date.parse(x.modified))}));
}

/** The next unread page after `fromPageId` in notebook order (wrapping round), or null. */
export function nextUnread(content, fromPageId) {
  const pages = allPages(content);
  if (!pages.length) return null;
  const at = Math.max(0, pages.findIndex(p => p.id === fromPageId));
  for (let k = 1; k <= pages.length; k++) {
    const p = pages[(at + k) % pages.length];
    if (p.unread && p.id !== fromPageId) return p.id;
  }
  return null;
}

/** Before an edit to a page: a version when the page had rested (see snapshotIfDue). */
export const beforeEdit = (ctx, pageId) => { snapshotIfDue(ctx, pageId); };
/** After an edit: the page's modified time and who made the edit. */
export function stampEdit(ctx, pageId) {
  ctx.change.set(['pages', pageId, 'modified'], new Date(ctx.host.now()).toISOString());
  ctx.change.set(['pages', pageId, 'modifiedBy'], authorOf(ctx));
}

export const unreadCount = content => allPages(content).filter(p => p.unread).length;
export { pageIndex };
