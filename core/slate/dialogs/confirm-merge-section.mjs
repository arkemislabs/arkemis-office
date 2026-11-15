// Merge Sections confirmation (after Merge Section; submit: section.merge). OneNote's message:
// all pages are merged into the target section, and "Delete original section after merging".
// The opener passes {sectionId, targetSectionId}. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';

export default defineDialog({
  id: 'dialog.confirm-merge-section',
  title: 'Merge Sections',
  command: 'section.merge',
  init(ctx) {
    const {sectionId} = currentLocation(ctx.doc, ctx.selection);
    return {sectionId, targetSectionId: null, deleteSource: false};
  },
  validate: v => (v.targetSectionId ? [] : [{field: 'message', message: 'Choose a section to merge into first.'}]),
  preview(ctx, v) {
    const from = ctx.doc.sections[v.sectionId]?.name ?? '', to = ctx.doc.sections[v.targetSectionId]?.name ?? '';
    const pages = ctx.doc.sections[v.sectionId]?.pages.length ?? 0;
    return {from, to, pages, message: `${pages === 1 ? 'The only page' : `All ${pages} pages`} of ${from ? `"${from}"` : 'the section'} will be merged into ${to ? `"${to}"` : 'the target section'}. The original section can then be deleted.`};
  },
  toCommand: v => ({command: 'section.merge', params: {sectionId: v.sectionId, targetSectionId: v.targetSectionId, deleteSource: !!v.deleteSource}}),
});
