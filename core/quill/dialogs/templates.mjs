// Developer › Templates › Document Template: Word's Templates and Add-ins dialog, its Templates page: the
// document's template (Attach… picks one) and Automatically update document styles. OK attaches the template (updating
// the styles now when they follow it), detaches it, or just switches the automatic update.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_templates.rs (`TemplatesForm::apply`) at
// aadb077e072b7de05f724e359d8db82e151f125c; checked again against wordcraft 0.13.1 (f2dfa0d). MIT, see
// assets/third-party-licenses/artcraft-reference.txt. Upstream's Attach… fills the path box and OK attaches; here Attach…
// attaches the picked file at once (src/apps/quill/ui-commands/tools.ts) and the box shows it. Not here: the Organizer…
// button (the Organizer's dialog is not built yet; styles.organizer, styles.copyFrom and styles.rename are), Word's
// e-mail attachment option, global templates and add-ins, XML schemas, XML expansion packs and linked CSS.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.templates',
  title: 'Templates and Add-ins',
  command: 'tools.templates',
  init(ctx) {
    const st = ctx?.doc?.settings ?? {};
    const template = st.attachedTemplate ?? '';
    return {template, linkStyles: !!st.linkStyles, _was: {template, linkStyles: !!st.linkStyles}};
  },
  buttons: {
    attach: () => ({command: 'ui.attachTemplate', params: {}}),
  },
  validate: v => (String(v.template ?? '').length > 32 * 1024 ? [{field: 'template', message: 'The template name is too long.'}] : []),
  toCommand(v) {
    const path = String(v.template ?? '').trim();
    const was = v._was ?? {template: '', linkStyles: false};
    const link = !!v.linkStyles;
    if (!path) {
      if (String(was.template).trim()) return {command: 'tools.detachTemplate', params: {}};
      if (link !== was.linkStyles) return {command: 'tools.linkStyles', params: {value: link}};
      return {batch: []};
    }
    if (path !== was.template || link !== was.linkStyles || link) return {command: 'tools.attachTemplate', params: {path, linkStyles: link, update: link}};
    return {batch: []};
  },
});
