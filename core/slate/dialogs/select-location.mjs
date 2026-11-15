// Select Location (Review > Notes > Linked Notes; submit: review.linkedNotes).
// OneNote's picker for where linked notes go: a search box and the notebook's sections and pages.
// The file the notes are about is chosen with the system Open dialog. U:slate/rest.
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {locationOptions} from './link.mjs';

export default defineDialog({
  id: 'dialog.select-location',
  title: 'Select Location in Notebook',
  command: 'review.linkedNotes',
  init(ctx) {
    const loc = currentLocation(ctx.doc, ctx.selection);
    return {fileName: '', filePath: '', search: '', location: loc.sectionId ? `section:${loc.sectionId}` : null, locations: locationOptions(ctx.doc)};
  },
  validate(v) {
    const out = [];
    if (!v.filePath) out.push({field: 'file', message: 'Choose the file the notes are about.'});
    if (!v.location) out.push({field: 'location', message: 'Pick the section or page for the notes.'});
    return out;
  },
  toCommand(v) {
    const [kind, ...rest] = String(v.location).split(':');
    const id = rest.join(':');
    return {command: 'review.linkedNotes', params: {path: v.filePath, name: v.fileName || undefined, ...(kind === 'page' ? {pageId: id} : {sectionId: id})}};
  },
});
