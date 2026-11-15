// Move or Copy Section (section tab context menu › Move or Copy; submit: section.moveOrCopy).
// OneNote's dialog: 'Move or copy "<section>" into the selected notebook or after the selected
// section', the notebook > section group > section tree, Move / Copy / Cancel. Picking the
// notebook or a section group puts the section at its end; picking a section puts it after.
// Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {notebookTree} from '../lib/sections-tree.mjs';

const call = (v, mode) => {
  const item = (v.tree ?? []).find(x => x.value === v.target);
  return {command: 'section.moveOrCopy', params: {sectionId: v.sectionId, target: v.target, mode, position: item?.kind === 'section' ? 'after' : 'into'}};
};

export default defineDialog({
  id: 'dialog.move-copy-section',
  title: 'Move or Copy Section',
  command: 'section.moveOrCopy',
  init(ctx) {
    const {sectionId} = currentLocation(ctx.doc, ctx.selection);
    return {target: null, tree: notebookTree(ctx.doc), sectionId, section: sectionId ? ctx.doc.sections[sectionId].name : ''};
  },
  validate(v) {
    if (!(v.tree ?? []).some(x => x.value === v.target)) return [{field: 'target', message: 'Choose a notebook, section group or section.'}];
    return v.target === v.sectionId ? [{field: 'target', message: 'Choose a different place for the section.'}] : [];
  },
  buttons: {copy: (ctx, v) => (v.target && v.target !== v.sectionId ? call(v, 'copy') : null)},
  toCommand: v => call(v, 'move'),
});
