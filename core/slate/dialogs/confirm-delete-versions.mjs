// Delete All Versions (History › Page Versions › Delete All Versions in Section / Section Group /
// Notebook; submit: history.deleteVersions). OneNote asks before deleting every saved version
// ("Are you sure you want to delete all page versions?"); the current version of each page stays.
// The opener passes {scope}. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {allPages, sectionsInScope} from '../lib/history.mjs';

const WHAT = {section: 'this section', 'section-group': 'this section group', notebook: 'this notebook'};

export default defineDialog({
  id: 'dialog.confirm-delete-versions',
  title: 'Delete All Versions',
  command: 'history.deleteVersions',
  init: (ctx, args) => ({scope: args?.scope ?? 'section'}),
  validate: v => (WHAT[v.scope] ? [] : [{field: 'message', message: 'Choose what to delete the versions of.'}]),
  preview(ctx, v) {
    const {sectionId} = currentLocation(ctx.doc, ctx.selection);
    const ids = v.scope === 'notebook' ? null : sectionsInScope(ctx.doc, sectionId, v.scope === 'section' ? 'section' : 'group');
    const pages = new Set(allPages(ctx.doc).filter(p => !ids || ids.has(p.section)).map(p => p.id));
    const count = Object.entries(ctx.doc.versions ?? {}).filter(([id]) => pages.has(id)).reduce((n, [, l]) => n + l.length, 0);
    return {message: `Delete all ${count} saved page version${count === 1 ? '' : 's'} in ${WHAT[v.scope] ?? 'the notebook'}? The current version of each page is kept.`};
  },
  toCommand: v => ({command: 'history.deleteVersions', params: {scope: v.scope, confirmed: true}}),
});
