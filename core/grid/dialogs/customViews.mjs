// Custom Views dialog model (View > Custom Views): the saved views of the workbook, Show, Add, Delete.
// Excel's dialog over gridcraft's `view.customViews` ({save, show, delete}, crates/engine/src/cmd/extra/window.rs)
// at fb1e59f; upstream has the command without a dialog. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: views (names), selected (index or -1), name (the name Add saves under). The buttons live in the
// body (src/apps/grid/dialogs/customViews.tsx) and run the command; submit shows the picked view.

import {defineDialog} from '../../kernel/dialog.mjs';
import {baseDoc} from '../lib/data-common.mjs';

/** The names of the saved views, in the order they were saved. */
export const viewNames = content => Object.keys(content?.customViews ?? {});

export default defineDialog({
  id: 'dialog.customViews',
  title: 'Custom Views',
  command: 'view.customViews',
  init(ctx) {
    const views = viewNames(baseDoc(ctx));
    return {views, hasViews: views.length > 0, selected: views.length ? 0 : -1, name: ''};
  },
  validate: v => (v.selected >= 0 && (v.views ?? [])[v.selected] ? [] : [{field: 'views', message: 'Pick a view to show'}]),
  toCommand: v => ({command: 'view.customViews', params: {show: String((v.views ?? [])[v.selected] ?? '')}}),
});
