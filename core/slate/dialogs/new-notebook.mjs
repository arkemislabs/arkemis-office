// New Notebook (File › New; submit: notebook.new). OneNote's page: where (This PC / Browse...),
// Notebook Name, and Create Notebook. "Browse..." lets the system dialog choose the folder;
// "This Computer" creates it in the folder typed in Folder. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {checkNotebookName} from '../commands/notebooks.mjs';

export const BROWSE = 'Browse...';

export default defineDialog({
  id: 'dialog.new-notebook',
  title: 'New Notebook',
  command: 'notebook.new',
  init: () => ({location: BROWSE, name: 'My Notebook', folder: ''}),
  validate(v) {
    const out = [];
    try { checkNotebookName(v.name); } catch (e) { out.push({field: 'name', message: e.message}); }
    if (v.location !== BROWSE && !String(v.folder ?? '').trim()) out.push({field: 'folder', message: 'Choose the folder the notebook goes in.'});
    return out;
  },
  toCommand: v => ({command: 'notebook.new', params: {name: String(v.name).trim(), ...(v.location !== BROWSE ? {location: String(v.folder).trim()} : {})}}),
});
