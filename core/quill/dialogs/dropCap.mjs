// Insert › Text › Drop Cap › Drop Cap Options… (submit: insert.dropCap).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_insert/columns.rs (`DropCapForm`:
// read from drop_cap_state (position, the letter's font else the text's, lines 1–10, distance),
// params: None sends only the position; the text's own font sends none) at
// aadb077e072b7de05f724e359d8db82e151f125c. Distance in inches, Word's default unit.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {dropCapState} from '../commands/insert.mjs';

const IN = 72;
const r2 = x => Math.round(x * 100) / 100;

export default defineDialog({
  id: 'dialog.dropCap',
  title: 'Drop Cap',
  command: 'insert.dropCap',
  init(ctx) {
    const st = dropCapState(ctx);
    return {position: st.position ?? 'none', font: st.font ?? st.textFont ?? '', textFont: st.textFont ?? '', lines: Math.max(1, Math.min(10, st.lines ?? 3)),
      distance: r2(Math.max(0, st.distance ?? 0) / IN)};
  },
  validate(v) {
    const out = [];
    if (v.position === 'none') return out;
    if (!(Number.isInteger(Number(v.lines)) && v.lines >= 1 && v.lines <= 10)) out.push({field: 'lines', message: 'The number must be between 1 and 10.'});
    if (!(Number(v.distance) >= 0 && Number(v.distance) <= 22)) out.push({field: 'distance', message: 'The measurement must be between 0" and 22".'});
    return out;
  },
  toCommand(v) {
    if (v.position === 'none') return {command: 'insert.dropCap', params: {position: 'none'}};
    const font = String(v.font ?? '').trim();
    const params = {position: v.position, lines: Math.max(1, Math.min(10, Number(v.lines))), distance: Math.max(0, Number(v.distance) * IN)};
    if (font && font !== v.textFont) params.font = font;
    return {command: 'insert.dropCap', params};
  },
});
