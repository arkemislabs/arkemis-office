// Table Layout › Alignment › Cell Margins… (submit: table.cellMargins), one undo step.
// Translated from wordcraft crates/ui-egui/src/dialogs/forms.rs (the Cell Margins form: Top, Left, Bottom, Right in points) at
// aadb077e072b7de05f724e359d8db82e151f125c. Word's "Allow spacing between cells" and "Automatically resize to fit contents" have no engine
// upstream and are not offered. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {tableStyle} from '../model/styles.mjs';
import * as T from '../lib/table-session.mjs';

const KEYS = ['top', 'left', 'bottom', 'right'];
const r2 = x => Math.round(x * 100) / 100;

export default defineDialog({
  id: 'dialog.tableCellMargins',
  title: 'Cell Margins',
  command: 'table.cellMargins',
  init(ctx) {
    const S = T.open(ctx);
    const [tp] = T.cell(S);
    const t = S.d.table(S.sel.focus.story, tp);
    const style = t?.props?.style ? tableStyle(S.d.c.styles, t.props.style) : null;
    const m = t?.props?.cellMargins ?? style?.parts?.cellMargins ?? [0, 5.4, 0, 5.4];
    return Object.fromEntries(KEYS.map((k, i) => [k, r2(m[i])]));
  },
  validate(v) {
    return KEYS.flatMap(k => { const x = Number(v[k]); return Number.isFinite(x) && x >= 0 && x <= 144 ? [] : [{field: k, message: 'The measurement must be between 0 and 144 pt.'}]; });
  },
  toCommand(v) { return {command: 'table.cellMargins', params: Object.fromEntries(KEYS.map(k => [k, Number(v[k])])) }; },
});
