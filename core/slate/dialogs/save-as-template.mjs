// Save As Template (Templates pane › Save current page as a template; submit:
// page.saveAsTemplate). OneNote's dialog: Template name (the page title to start with) and "Set
// as default template for new pages in the current section". Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';

export default defineDialog({
  id: 'dialog.save-as-template',
  title: 'Save As Template',
  command: 'page.saveAsTemplate',
  init(ctx) {
    const {pageId} = currentLocation(ctx.doc, ctx.selection);
    return {name: pageId ? ctx.doc.pages[pageId].title : '', setDefault: false};
  },
  validate(v) {
    const n = String(v.name ?? '').trim();
    if (!n) return [{field: 'name', message: 'Type a name for the template.'}];
    return n.length > 100 ? [{field: 'name', message: 'A template name has at most 100 characters.'}] : [];
  },
  toCommand: v => ({command: 'page.saveAsTemplate', params: {name: String(v.name).trim(), setDefault: !!v.setDefault}}),
});
