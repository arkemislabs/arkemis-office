// Notebook Properties (notebook context menu › Properties, File › Info › Settings; submit:
// notebook.properties). OneNote's dialog: Display name, Color, Path, Default Format. Change
// Location and Convert are not offered: the notebook folder is where the person put it and
// there is one format. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {checkNotebookName} from '../commands/notebooks.mjs';

export default defineDialog({
  id: 'dialog.notebook-properties',
  title: 'Notebook Properties',
  command: 'notebook.properties',
  init: ctx => ({displayName: ctx.doc.notebook.name, color: ctx.doc.notebook.color ?? '#7f6fd1', path: ctx.doc.notebook.path ?? '(not saved to a folder)',
    defaultFormat: 'Arkemis notebook folder'}),
  validate(v) {
    try { checkNotebookName(v.displayName); } catch (e) { return [{field: 'displayName', message: e.message}]; }
    return /^#[0-9a-fA-F]{6}$/.test(String(v.color ?? '')) ? [] : [{field: 'color', message: 'Choose a colour.'}];
  },
  toCommand: v => ({command: 'notebook.properties', params: {displayName: String(v.displayName).trim(), color: String(v.color).toLowerCase()}}),
});
