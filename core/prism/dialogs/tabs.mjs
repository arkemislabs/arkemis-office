// Tabs… (submit: format.tabs): the default tab stop spacing and the paragraph's stops (position
// in inches, Left / Center / Right / Decimal), set, cleared one by one or all at once.
// Translated from deckcraft crates/ui-egui/src/dialogs/tabs.rs (`tabs_dialog`) and
// crates/engine/src/cmd/format/paragraph.rs (`tabs_params`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The stop list (with Set, Clear, Clear All) is drawn by src/apps/prism/dialogs/tabs.tsx.

import {defineDialog} from '../../kernel/dialog.mjs';
import {tabsParams} from '../commands/format.mjs';

const r4 = v => Math.round(v * 10000) / 10000;
const finite = v => typeof v === 'number' && Number.isFinite(v);

/** Stops in inches for the dialog: [{pos (in), align: l|ctr|r|dec}]. */
export function tabsValues(ctx) {
  const p = tabsParams(ctx);
  return {stops: p.tabs.map(t => ({pos: r4(t.pos / 72), align: t.align})), defaultTab: r4(p.defaultTab / 72)};
}

/** deckcraft `tabs.rs` Set: a stop at (nearly) the same place is replaced; the list stays sorted. */
export function setStop(stops, pos, align) {
  const out = (stops ?? []).filter(t => Math.abs(t.pos - pos) >= 0.5 / 72);
  out.push({pos, align});
  return out.sort((a, b) => a.pos - b.pos);
}

export default defineDialog({
  id: 'dialog.tabs',
  title: 'Tabs',
  command: 'format.tabs',
  init: ctx => tabsValues(ctx),
  validate(v) {
    const out = [];
    if (!finite(v.defaultTab) || v.defaultTab <= 0) out.push({field: 'defaultTab', message: 'Default tab stops must be a positive number of inches'});
    if ((v.stops ?? []).some(t => !finite(t.pos) || t.pos < 0)) out.push({field: 'stops', message: 'Tab stop positions must be numbers of inches'});
    return out;
  },
  toCommand: v => ({command: 'format.tabs', params: {set: (v.stops ?? []).map(t => ({pos: t.pos * 72, align: t.align})), defaultTab: v.defaultTab * 72}}),
});
