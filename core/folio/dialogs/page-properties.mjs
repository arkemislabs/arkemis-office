// Page Properties (submit: page.properties): the tab order of the target pages.
// Translated from printcraft crates/ui-egui/src/panels/organize_panel.rs:190 (page_props_body: Use Row Order, Use Column Order,
// Use Document Structure, Unspecified) and dialogs.rs:223 (Dialog::PageProps: an order every page already has adds no undo step) at
// 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt). The dialog opens on Unspecified: the pages'
// present order is read from the file by the command (`page.properties` without `order`), which a synchronous init cannot do.
// Acrobat's Actions tab (page open and close actions) is not in upstream and is not shown.

import {defineDialog} from '../../kernel/dialog.mjs';

const ORDERS = {'Use Row Order': 'row', 'Use Column Order': 'column', 'Use Document Structure': 'structure', Unspecified: 'unspecified'};

export default defineDialog({
  id: 'dialog.page-properties',
  title: 'Page Properties',
  command: 'page.properties',
  init: () => ({order: 'Unspecified'}),
  validate: v => (Object.hasOwn(ORDERS, v.order) ? [] : [{field: 'order', message: 'Choose a tab order'}]),
  toCommand: v => ({command: 'page.properties', params: {order: ORDERS[v.order] ?? 'unspecified'}}),
});
