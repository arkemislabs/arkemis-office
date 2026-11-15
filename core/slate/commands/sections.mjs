// Sections and section groups: the section tabs and their context menus (U:slate/sections).
//
// Slate has no ArtCraft upstream: ids, args and summaries are docs/spec/slate.json `section.*` and
// `sectionGroup.*` (sourceRef core/slate-sections.mjs); behaviour is OneNote's:
//   * New Section (Ctrl+T, the "+" after the tabs) adds "New Section <n>" with one untitled page
//     after the current section (or at the end of the section group being shown) and opens it;
//     each new section takes the next colour;
//   * Rename (names have 1–100 characters, none of / \ : * ? " < > | # %, and are unique),
//     Section Color (or None), Move Up / Down past the neighbouring tab;
//   * Delete moves the section with its pages to the Notebook Recycle Bin after a confirmation;
//   * Move or Copy puts a section into a notebook or section group (at the end) or after a
//     section; a copy gets fresh pages and "(2)" when the name is taken;
//   * Merge into Another Section copies every page to the end of the target section and can
//     delete the original afterwards;
//   * New Section Group, Rename, Delete (with its sections, to the Recycle Bin), Move.
// Sections are edited through the foundation model (core/slate/model/notebook.mjs).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {LIMITS, isNotebook} from '../schema.mjs';
import {addGroup, addPage, addSection, currentLocation, insertTreeItem, parentOf, removeTreeItem, sectionOrder, selectPage, selectSection} from '../model/notebook.mjs';
import {binAdd, detachItem} from '../lib/pages-recycle.mjs';
import {isLegacyPage, legacyNewSection} from '../lib/pages-legacy.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/section.*', 'docs/spec/slate.json#commands/sectionGroup.*', 'core/slate-sections.mjs']};
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };
const BAD_NAME = /[\\/:*?"<>|#%]/;

const notebookState = ctx => (isNotebook(ctx.doc) ? {enabled: true} : {enabled: false, reason: 'No notebook is open'});
function sectionState(ctx) {
  if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
  return currentLocation(ctx.doc, ctx.selection).sectionId ? {enabled: true} : {enabled: false, reason: 'No section is open'};
}

function checkNotebook(ctx, id) {
  need(isNotebook(ctx.doc), 'disabled', 'No notebook is open');
  if (id !== undefined) need(id === ctx.doc.notebook.id, 'not_found', `No notebook ${id} here`, {path: '/notebookId'});
}
function sectionId(ctx, id) {
  checkNotebook(ctx);
  const sid = id ?? currentLocation(ctx.doc, ctx.selection).sectionId;
  need(sid && ctx.doc.sections[sid], 'not_found', id ? `No section ${id}` : 'No section is open', {path: '/sectionId'});
  return sid;
}
function groupId(ctx, id) {
  checkNotebook(ctx);
  need(ctx.doc.groups[id], 'not_found', `No section group ${id}`, {path: '/groupId'});
  return id;
}

/** A name OneNote accepts for a section or section group. */
export function checkName(name, what = 'section') {
  const n = String(name ?? '').trim();
  need(n.length >= 1 && n.length <= LIMITS.nameLength, 'invalid_params', `A ${what} name has 1 to ${LIMITS.nameLength} characters`, {path: '/name'});
  need(!BAD_NAME.test(n), 'invalid_params', `A ${what} name cannot contain any of these characters: / \\ : * ? " < > | # %`, {path: '/name'});
  return n;
}
const nameTaken = (ctx, name, except) => Object.values(ctx.doc.sections).some(x => x.id !== except && x.name.toLowerCase() === name.toLowerCase());
function freeName(ctx, base) {
  if (!nameTaken(ctx, base)) return base;
  for (let n = 2; ; n++) if (!nameTaken(ctx, `${base} (${n})`)) return `${base} (${n})`;
}

/** Where a section lands for a target: {parent, index}. */
function placement(ctx, target, position, moving) {
  const c = ctx.doc;
  if (target === c.notebook.id) return {parent: null, index: undefined};
  if (c.groups[target]) {
    if (position === 'after') {
      const w = parentOf(c, target);
      return {parent: w.parent, index: w.index + 1};
    }
    return {parent: target, index: undefined};
  }
  need(c.sections[target], 'not_found', `No notebook, section group or section ${target}`, {path: '/target'});
  need(target !== moving, 'invalid_params', 'Choose another place for the section', {path: '/target'});
  const w = parentOf(c, target);
  return {parent: w.parent, index: w.index + 1};
}

/** Copy a section's pages into a section (fresh ids); returns the new page ids. */
function copyPagesInto(ctx, fromSid, toSid) {
  const ids = [];
  for (const e of ctx.doc.sections[fromSid].pages) {
    const record = {...structuredClone(ctx.doc.pages[e.id]), id: `p${ctx.host.uid()}`};
    ids.push(addPage(ctx, toSid, {level: e.level, record}));
  }
  return ids;
}

/** Send a section or group to the Recycle Bin and select the next section. */
function deleteItem(ctx, itemId, kind) {
  const order = sectionOrder(ctx.doc);
  const cur = currentLocation(ctx.doc, ctx.selection).sectionId;
  const record = kind === 'section' ? ctx.doc.sections[itemId] : ctx.doc.groups[itemId];
  const parts = detachItem(ctx, itemId);
  if (kind === 'section') binAdd(ctx, {kind, section: record, pages: parts.pages, from: parts.from});
  else binAdd(ctx, {kind, group: record, groups: parts.groups, sections: parts.sections, pages: parts.pages, from: parts.from});
  const left = sectionOrder(ctx.doc);
  if (cur && !ctx.doc.sections[cur]) {
    // OneNote opens the next section (or the one before when it was the last).
    const was = order.indexOf(cur);
    const next = order.slice(was + 1).find(id => ctx.doc.sections[id]) ?? [...order.slice(0, was)].reverse().find(id => ctx.doc.sections[id]);
    if (next) {
      const first = ctx.doc.sections[next].pages[0]?.id;
      ctx.setSelection(first ? selectPage(first) : selectSection(next));
    } else ctx.setSelection({ranges: [], primary: 0});
  }
  return {deleted: itemId, sections: Object.keys(parts.sections).length, pages: Object.keys(parts.pages).length, left: left.length};
}

const sectionParam = s.optional(s.string({min: 1, max: 80, description: 'Section id (default: the current section)'}));
const colorParam = s.nullable(s.string({pattern: '^#[0-9a-fA-F]{6}$', description: '#RRGGBB or null (None)'}));

export default defineCommands({
  family: 'sections',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'section.new', label: 'New Section', shortcut: 'Mod+T', risk: 'edit',
      description: 'Create a new section (with one untitled page) after the current section, or at the end of a section group, and open it.',
      params: s.object({
        notebookId: s.optional(s.string({min: 1, max: 200, description: 'Notebook id (default: the current notebook)'})),
        groupId: s.optional(s.string({min: 1, max: 200, description: 'Create the section at the end of this section group'})),
        name: s.optional(s.string({min: 1, max: 100, trim: true})),
      }),
      state: ctx => (isLegacyPage(ctx) ? {enabled: true} : notebookState(ctx)),
      run(ctx, p) {
        if (isLegacyPage(ctx)) return legacyNewSection(ctx, p);
        checkNotebook(ctx, p.notebookId);
        const name = p.name === undefined ? undefined : checkName(p.name);
        const cur = currentLocation(ctx.doc, ctx.selection).sectionId;
        const sid = addSection(ctx, {name, ...(p.groupId ? {groupId: groupId(ctx, p.groupId)} : cur ? {after: cur} : {})});
        const pid = addPage(ctx, sid, {});
        ctx.setSelection(selectPage(pid));
        return {section: sid, name: ctx.doc.sections[sid].name, page: pid, color: ctx.doc.sections[sid].color};
      },
    },
    {
      id: 'section.rename', label: 'Rename', risk: 'edit',
      description: 'Rename a section.',
      params: s.object({sectionId: sectionParam, name: s.string({min: 1, max: 100, trim: true})}),
      state: sectionState,
      run(ctx, p) {
        const sid = sectionId(ctx, p.sectionId);
        const name = checkName(p.name);
        need(!nameTaken(ctx, name, sid), 'invalid_params', `A section named ${name} already exists`, {path: '/name'});
        if (ctx.doc.sections[sid].name === name) return {section: sid, name, changed: false};
        ctx.change.set(['sections', sid, 'name'], name);
        return {section: sid, name, changed: true};
      },
    },
    {
      id: 'section.delete', label: 'Delete', risk: 'edit', dialog: 'dialog.confirm-delete',
      description: 'Move a section and its pages to the Notebook Recycle Bin.',
      params: s.object({sectionId: sectionParam}),
      state: sectionState,
      run: (ctx, p) => deleteItem(ctx, sectionId(ctx, p.sectionId), 'section'),
    },
    {
      id: 'section.moveOrCopy', label: 'Move or Copy', risk: 'edit', dialog: 'dialog.move-copy-section',
      description: 'Move or copy a section into a notebook or section group (at the end) or after another section.',
      params: s.object({
        sectionId: sectionParam,
        target: s.string({min: 1, max: 80, description: 'Notebook, section group or section id'}),
        mode: s.enum(['move', 'copy']),
        position: s.optional(s.enum(['into', 'after'], {description: 'into a notebook or group (default), or after a section or group'})),
      }),
      state: sectionState,
      run(ctx, p) {
        const sid = sectionId(ctx, p.sectionId);
        const where = placement(ctx, p.target, p.position ?? 'into', sid);
        if (p.mode === 'move') {
          const from = parentOf(ctx.doc, sid);
          removeTreeItem(ctx, sid);
          // Removing first shifts a later index in the same parent by one.
          const index = where.index !== undefined && from.parent === where.parent && from.index < where.index ? where.index - 1 : where.index;
          insertTreeItem(ctx, sid, {parent: where.parent, index});
          return {mode: 'move', section: sid};
        }
        const src = ctx.doc.sections[sid];
        const copy = addSection(ctx, {name: freeName(ctx, src.name), color: src.color, groupId: where.parent});
        if (where.index !== undefined) {
          removeTreeItem(ctx, copy);
          insertTreeItem(ctx, copy, {parent: where.parent, index: where.index});
        }
        const pages = copyPagesInto(ctx, sid, copy);
        return {mode: 'copy', section: copy, name: ctx.doc.sections[copy].name, pages};
      },
    },
    {
      id: 'section.merge', label: 'Merge into Another Section', risk: 'edit', dialog: 'dialog.merge-section',
      description: 'Copy every page of a section to the end of another section; optionally delete the original section afterwards.',
      params: s.object({sectionId: sectionParam, targetSectionId: s.string({min: 1, max: 80}), deleteSource: s.optional(s.boolean())}),
      state(ctx) {
        const st = sectionState(ctx);
        if (!st.enabled) return st;
        return Object.keys(ctx.doc.sections).length > 1 ? {enabled: true} : {enabled: false, reason: 'There is no other section to merge into'};
      },
      run(ctx, p) {
        const sid = sectionId(ctx, p.sectionId);
        need(ctx.doc.sections[p.targetSectionId], 'not_found', `No section ${p.targetSectionId}`, {path: '/targetSectionId'});
        need(p.targetSectionId !== sid, 'invalid_params', 'Choose a different section to merge into', {path: '/targetSectionId'});
        const pages = copyPagesInto(ctx, sid, p.targetSectionId);
        if (p.deleteSource) deleteItem(ctx, sid, 'section');
        ctx.setSelection(pages.length ? selectPage(pages[0]) : selectSection(p.targetSectionId));
        return {section: p.targetSectionId, pages, deleted: !!p.deleteSource};
      },
    },
    {
      id: 'section.setColor', label: 'Section Color', risk: 'edit',
      description: 'Set a section\'s tab colour (null = None).',
      params: s.object({sectionId: sectionParam, color: colorParam}),
      state(ctx, p) {
        const st = sectionState(ctx);
        if (!st.enabled) return st;
        const value = ctx.doc.sections[currentLocation(ctx.doc, ctx.selection).sectionId].color ?? null;
        return {enabled: true, value, ...(p && 'color' in p ? {checked: value === (p.color?.toLowerCase() ?? null)} : {})};
      },
      run(ctx, p) {
        const sid = sectionId(ctx, p.sectionId);
        const color = p.color === null ? null : p.color.toLowerCase();
        if ((ctx.doc.sections[sid].color ?? null) === color) return {section: sid, color, changed: false};
        ctx.change.set(['sections', sid, 'color'], color);
        return {section: sid, color, changed: true};
      },
    },
    ...[['section.moveUp', 'Move Up', -1], ['section.moveDown', 'Move Down', 1]].map(([id, label, dir]) => ({
      id, label, risk: 'edit',
      description: `Move a section ${dir < 0 ? 'before' : 'after'} the tab ${dir < 0 ? 'before' : 'after'} it.`,
      params: s.object({sectionId: sectionParam}),
      state(ctx) {
        const st = sectionState(ctx);
        if (!st.enabled) return st;
        const w = parentOf(ctx.doc, currentLocation(ctx.doc, ctx.selection).sectionId);
        const list = w.parent ? ctx.doc.groups[w.parent].items : ctx.doc.tree;
        const to = w.index + dir;
        return to < 0 || to >= list.length ? {enabled: false, reason: dir < 0 ? 'This is the first section' : 'This is the last section'} : {enabled: true};
      },
      run(ctx, p) {
        const sid = sectionId(ctx, p.sectionId);
        const w = parentOf(ctx.doc, sid);
        const list = w.parent ? ctx.doc.groups[w.parent].items : ctx.doc.tree;
        const to = w.index + dir;
        if (to < 0 || to >= list.length) return {section: sid, moved: false};
        removeTreeItem(ctx, sid);
        insertTreeItem(ctx, sid, {parent: w.parent, index: to});
        return {section: sid, moved: true, index: to};
      },
    })),
    {
      id: 'sectionGroup.new', label: 'New Section Group', risk: 'edit',
      description: 'Create a section group at the end of the notebook or of a section group.',
      params: s.object({
        notebookId: s.optional(s.string({min: 1, max: 200})),
        parentGroupId: s.optional(s.string({min: 1, max: 80})),
        name: s.optional(s.string({min: 1, max: 100, trim: true})),
      }),
      state: notebookState,
      run(ctx, p) {
        checkNotebook(ctx, p.notebookId);
        if (p.parentGroupId !== undefined) groupId(ctx, p.parentGroupId);
        const name = p.name === undefined ? undefined : checkName(p.name, 'section group');
        const gid = addGroup(ctx, {name, parent: p.parentGroupId ?? null});
        return {group: gid, name: ctx.doc.groups[gid].name};
      },
    },
    {
      id: 'sectionGroup.rename', label: 'Rename', risk: 'edit',
      description: 'Rename a section group.',
      params: s.object({groupId: s.string({min: 1, max: 80}), name: s.string({min: 1, max: 100, trim: true})}),
      state: notebookState,
      run(ctx, p) {
        const gid = groupId(ctx, p.groupId);
        const name = checkName(p.name, 'section group');
        if (ctx.doc.groups[gid].name === name) return {group: gid, name, changed: false};
        ctx.change.set(['groups', gid, 'name'], name);
        return {group: gid, name, changed: true};
      },
    },
    {
      id: 'sectionGroup.delete', label: 'Delete', risk: 'edit', dialog: 'dialog.confirm-delete',
      description: 'Move a section group with its sections to the Notebook Recycle Bin.',
      params: s.object({groupId: s.string({min: 1, max: 80})}),
      state: notebookState,
      run: (ctx, p) => deleteItem(ctx, groupId(ctx, p.groupId), 'group'),
    },
    {
      id: 'sectionGroup.move', label: 'Move', risk: 'edit',
      description: 'Move a section group into the notebook or another section group (at the end).',
      params: s.object({groupId: s.string({min: 1, max: 80}), target: s.string({min: 1, max: 80, description: 'Notebook or section group id'})}),
      state: notebookState,
      run(ctx, p) {
        const gid = groupId(ctx, p.groupId);
        const c = ctx.doc;
        const parent = p.target === c.notebook.id ? null : p.target;
        if (parent !== null) {
          need(c.groups[parent], 'not_found', `No notebook or section group ${p.target}`, {path: '/target'});
          // Not into itself or a group inside it.
          for (let g = parent; g; g = parentOf(c, g)?.parent) need(g !== gid, 'invalid_params', 'A section group cannot go inside itself', {path: '/target'});
        }
        removeTreeItem(ctx, gid);
        insertTreeItem(ctx, gid, {parent});
        return {group: gid, parent};
      },
    },
  ],
});

