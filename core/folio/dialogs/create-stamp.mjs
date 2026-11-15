// Create Custom Stamp: a PNG or JPEG chosen in the system Open dialog, its category and name.
//
// Translated from printcraft crates/ui-egui/src/tools/stamps_ui.rs (the custom stamp form: From
// <file>, Category (e.g. My stamps), Name; OK adds it to the palette) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Acrobat's "Down sample stamp to reduce file size" is not in upstream and stays hidden.

import {defineDialog} from '../../kernel/dialog.mjs';

const DATA = new RegExp('^data:image[/](png|jpeg);base64,');

export default defineDialog({
  id: 'dialog.create-stamp',
  title: 'Create Custom Stamp',
  command: 'comment.stamp.custom.create',
  init: (ctx, args = {}) => ({file: args?.path ? String(args.path) : '', category: 'My stamps', name: '',
    categories: [...new Set((ctx.prefs?.customStamps ?? []).map(c => c.category))]}),
  /** The picked picture (Browse gives a data URL) for the preview card. */
  preview: (ctx, v) => ({type: 'image', src: DATA.test(String(v.file ?? '')) ? String(v.file) : ''}),
  /** Choosing a file names the stamp after it, until a name is typed. */
  derive: (v, changed) => (changed.includes('file') && !String(v.name ?? '').trim() && v.file && !DATA.test(String(v.file)) ? {name: String(v.file).split(/[\\/]/).pop().replace(/\.[^.]*$/, '')} : {}),
  validate(v) {
    if (!String(v.name ?? '').trim()) return [{field: 'name', message: 'Type a name for the stamp.'}];
    return [];
  },
  toCommand: v => ({command: 'comment.stamp.custom.create', params: {...(DATA.test(String(v.file ?? '')) ? {base64: String(v.file).replace(DATA, '')} : String(v.file ?? '').trim() ? {path: String(v.file).trim()} : {}), category: String(v.category ?? '').trim() || 'My stamps', name: String(v.name).trim()}}),
});
