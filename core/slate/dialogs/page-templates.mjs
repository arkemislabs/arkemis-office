// Templates pane (Insert › Pages › Page Templates...; submit: page.applyTemplate). OneNote's
// pane: "Add a page" lists templates by category (the person's saved templates are "My
// Templates"); choosing one adds a page from it at the end of the section; "Choose default
// template" sets the current section's default; "Save current page as a template" opens Save As
// Template. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {TEMPLATES_PREF} from '../commands/pages.mjs';

export const NO_DEFAULT = 'No Default Template';
const templatesOf = prefs => (Array.isArray(prefs?.[TEMPLATES_PREF]) ? prefs[TEMPLATES_PREF] : []);

export default defineDialog({
  id: 'dialog.page-templates',
  title: 'Templates',
  command: 'page.applyTemplate',
  init(ctx) {
    const {sectionId} = currentLocation(ctx.doc, ctx.selection);
    const list = templatesOf(ctx.prefs);
    const def = sectionId ? ctx.doc.sections[sectionId].defaultTemplate ?? null : null;
    // The lists the pane draws: the one category that has templates (the person's), its templates, and the default's choices.
    return {category: 'My Templates', template: null, templates: list.map(t => ({id: t.id, name: t.name})),
      categories: [{value: 'My Templates', label: 'My Templates'}], templateItems: list.map(t => ({value: t.id, label: t.name})),
      defaultOptions: [{value: NO_DEFAULT, label: NO_DEFAULT}, ...list.map(t => ({value: t.id, label: t.name}))],
      defaultTemplate: def && list.some(t => t.id === def) ? def : NO_DEFAULT, sectionId};
  },
  validate: v => (v.template ? [] : [{field: 'template', message: 'Choose a template.'}]),
  buttons: {
    setDefault: (ctx, v) => ({command: 'page.setDefaultTemplate', params: {templateId: v.defaultTemplate === NO_DEFAULT ? null : v.defaultTemplate, ...(v.sectionId ? {sectionId: v.sectionId} : {})}}),
    addPage: (ctx, v) => (v.template ? {command: 'page.applyTemplate', params: {templateId: v.template}} : null),
  },
  toCommand: v => ({command: 'page.applyTemplate', params: {templateId: v.template}}),
});
