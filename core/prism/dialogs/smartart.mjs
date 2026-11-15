// Choose a SmartArt Graphic (submit: insert.smartArt): the layouts drawn as thumbnails, by category, and the chosen one's name.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_smartart`: "Pick a graphic", six layouts) at 4ce2944;
// the categories list and the preview follow PowerPoint (not checked against upstream). deckcraft's items box is not offered:
// as in PowerPoint the text is typed in the Text Pane afterwards.

import {defineDialog} from '../../kernel/dialog.mjs';
import {LAYOUTS, LAYOUT_IDS} from '../lib/smartart.mjs';

const categoryOf = id => LAYOUTS.find(l => l[0] === id)?.[2] ?? 'List';

export default defineDialog({
  id: 'dialog.smartart',
  title: 'Choose a SmartArt Graphic',
  command: 'insert.smartArt',
  init: () => ({kind: 'process', category: 'All'}),
  derive(v, changed) {
    if (changed.includes('category') && v.category !== 'All' && categoryOf(v.kind) !== v.category) return {kind: LAYOUTS.find(l => l[2] === v.category)?.[0] ?? v.kind};
    return {};
  },
  validate: v => (LAYOUT_IDS.includes(v.kind) ? [] : [{field: 'kind', message: 'Pick a graphic.'}]),
  toCommand: v => ({command: 'insert.smartArt', params: {kind: v.kind}}),
});
