// Chart Title dialog model (submit: chart.set).
// gridcraft's chart title dialog (crates/ui-egui/src/dialogs.rs): the title and the two axis titles of
// the selected (or last) chart. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: title, xTitle, yTitle.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {selectedObject} from '../lib/objects.mjs';

export default defineDialog({
  id: 'dialog.chartTitle',
  title: 'Chart Title',
  command: 'chart.set',
  init(ctx) {
    const content = baseDoc(ctx);
    const si = gridSel(ctx).sheet;
    const list = content.sheets[si].charts ?? [];
    const picked = selectedObject(content, ctx.selection);
    const c = (picked?.kind === 'chart' && list.find(x => x.id === picked.id)) || list[list.length - 1];
    return {title: c?.title ?? '', xTitle: c?.xTitle ?? '', yTitle: c?.yTitle ?? ''};
  },
  validate: () => [],
  toCommand: v => ({command: 'chart.set', params: {title: String(v.title ?? ''), xTitle: String(v.xTitle ?? ''), yTitle: String(v.yTitle ?? '')}}),
});
