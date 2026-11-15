// Merge Section (section tab context menu › Merge into Another Section; submit: section.merge).
// OneNote's dialog: 'Merge "<section>" into the selected section' over the notebook tree, then
// the Merge Sections confirmation (dialog.confirm-merge-section) with "Delete original section
// after merging". Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {notebookTree} from '../lib/sections-tree.mjs';

export default defineDialog({
  id: 'dialog.merge-section',
  title: 'Merge Section',
  command: 'section.merge',
  init(ctx) {
    const {sectionId} = currentLocation(ctx.doc, ctx.selection);
    return {target: null, tree: notebookTree(ctx.doc), sectionId, section: sectionId ? ctx.doc.sections[sectionId].name : ''};
  },
  validate(v) {
    const item = (v.tree ?? []).find(x => x.value === v.target);
    if (!item || item.kind !== 'section') return [{field: 'target', message: 'Choose a section to merge into.'}];
    return v.target === v.sectionId ? [{field: 'target', message: 'Choose a different section to merge into.'}] : [];
  },
  toCommand: v => ({command: 'section.merge', params: {sectionId: v.sectionId, targetSectionId: v.target, deleteSource: false}}),
});
