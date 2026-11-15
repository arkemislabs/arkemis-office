// Move or Copy Pages (page context menu › Move or Copy, Ctrl+Alt+M; submit: page.moveOrCopy).
// OneNote's dialog: a Search box over All Notebooks (the notebook > section group > section tree),
// Recent picks, and Move / Copy / Cancel; only a section can be picked. Other notebooks are other
// windows here, so the tree is this notebook's. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {notebookTree} from '../lib/sections-tree.mjs';

export const RECENT_PREF = 'slate.recentPicks';

export default defineDialog({
  id: 'dialog.move-copy-pages',
  title: 'Move or Copy Pages',
  command: 'page.moveOrCopy',
  init(ctx) {
    const {pageId, sectionId} = currentLocation(ctx.doc, ctx.selection);
    const tree = notebookTree(ctx.doc);
    const recent = (ctx.prefs?.[RECENT_PREF] ?? []).filter(id => ctx.doc.sections[id]);
    const recentSections = recent.map(id => ({value: id, label: ctx.doc.sections[id].name, color: ctx.doc.sections[id].color ?? null}));
    return {search: '', recentPicks: null, target: null, tree, recent, recentSections, pageIds: pageId ? [pageId] : [], page: pageId ? ctx.doc.pages[pageId].title : '', from: sectionId};
  },
  derive: (v, changed) => (changed.includes('recentPicks') && v.recentPicks ? {target: v.recentPicks} : {}),
  validate: v => ((v.tree ?? []).some(x => x.value === v.target && x.kind === 'section') ? [] : [{field: 'target', message: 'Choose a section.'}]),
  buttons: {
    copy: (ctx, v) => (ctx.doc.sections[v.target] ? {command: 'page.moveOrCopy', params: {pageIds: v.pageIds, targetSectionId: v.target, mode: 'copy'}} : null),
  },
  toCommand: v => ({command: 'page.moveOrCopy', params: {pageIds: v.pageIds, targetSectionId: v.target, mode: 'move'}}),
});
