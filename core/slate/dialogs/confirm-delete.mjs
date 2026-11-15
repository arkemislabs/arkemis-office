// Delete confirmation (page, section or section group delete; submit: page.delete,
// section.delete or sectionGroup.delete). OneNote asks before deleting a section or a section
// group ("Are you sure you want to delete this section?"), and everything deleted goes to the
// Notebook Recycle Bin. The opener may pass {kind, id}; by default the current section.
// Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';

const COMMANDS = {page: ['page.delete', 'pageIds'], section: ['section.delete', 'sectionId'], group: ['sectionGroup.delete', 'groupId']};

export default defineDialog({
  id: 'dialog.confirm-delete',
  title: 'Delete',
  command: 'page.delete',
  init(ctx) {
    const {sectionId} = currentLocation(ctx.doc, ctx.selection);
    return {kind: 'section', id: sectionId};
  },
  validate: v => (v.id && COMMANDS[v.kind] ? [] : [{field: 'message', message: 'There is nothing to delete.'}]),
  preview(ctx, v) {
    const name = v.kind === 'page' ? ctx.doc.pages[v.id]?.title || 'Untitled page' : v.kind === 'group' ? ctx.doc.groups[v.id]?.name : ctx.doc.sections[v.id]?.name;
    const what = v.kind === 'group' ? 'section group' : v.kind;
    return {message: `Are you sure you want to delete this ${what}${name ? ` (${name})` : ''}? It is moved to the Notebook Recycle Bin.`};
  },
  toCommand(v) {
    const [command, key] = COMMANDS[v.kind];
    return {command, params: {[key]: v.kind === 'page' ? [v.id] : v.id}};
  },
});
