// Layout › Page Setup › Hyphenation › Hyphenation Options…: Automatically hyphenate document, Hyphenate words in CAPS, the Hyphenation zone and
// Limit consecutive hyphens to; Manual… opens Manual Hyphenation. OK runs layout.hyphenation with them.
//
// Over wordcraft crates/ui-egui/src/dialogs/dialogs_layout/text.rs `hyphenation_ui` and engine page.rs `layout.hyphenation`.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {HYPHENATION_ZONE} from '../layout/para/justify.mjs';

export default defineDialog({
  id: 'dialog.hyphenation',
  title: 'Hyphenation',
  command: 'layout.hyphenation',
  init(ctx) {
    const st = ctx.doc?.settings ?? {};
    return {auto: !!st.autoHyphenation, caps: st.hyphenateCaps !== false, zone: Number.isFinite(st.hyphenationZone) ? st.hyphenationZone : HYPHENATION_ZONE,
      limit: Number.isFinite(st.consecutiveHyphenLimit) ? st.consecutiveHyphenLimit : 0};
  },
  validate: v => (Number(v.zone) >= 0 && Number(v.limit) >= 0 ? [] : [{field: 'zone', message: 'The zone and the limit are numbers from 0 up.'}]),
  toCommand: v => ({command: 'layout.hyphenation', params: {value: !!v.auto, caps: !!v.caps, zone: Math.min(1584, Number(v.zone) || 0), limit: Math.max(0, Math.trunc(Number(v.limit) || 0))}}),
});
