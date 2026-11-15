// References › Manage Sources (Source Manager): the document's sources with New…, Import…, Edit…,
// Delete and Insert Citation, and the selected source as the current style writes it. Each button
// runs its command at once (src/apps/quill/dialogs/sourceManager.tsx); Close closes.
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_refs/sources.rs (`sources_ui`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import {bibStyleOf} from '../lib/references-lists.mjs';

export default defineDialog({
  id: 'dialog.sourceManager',
  title: 'Source Manager',
  command: 'references.sources',
  init(ctx) {
    const d = T.open(ctx).d;
    return {sources: (d.c.sources ?? []).map(x => ({...x})), style: bibStyleOf(d), list: null};
  },
  validate: () => [],
  buttons: {
    delete: (_ctx, v) => (typeof v.list === 'string' ? {command: 'references.sources', params: {remove: v.list}} : null),
    insertCitation: (_ctx, v) => (typeof v.list === 'string' ? {command: 'references.citation', params: {tag: v.list}} : null),
  },
  toCommand: () => ({batch: []}),
});
