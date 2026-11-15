// Insert › Illustrations › SmartArt: Choose a SmartArt Graphic (submit: insert.smartArt): the layouts drawn as thumbnails, by category, and the chosen
// one's name. Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_smart_art.rs (the layout list and its preview) at
// aadb077e072b7de05f724e359d8db82e151f125c, with PowerPoint's dialog and 45 layouts (core/prism/dialogs/smartart.mjs, core/prism/lib/smartart.mjs).
// MIT, see assets/third-party-licenses/artcraft-reference.txt. The items are typed in the Text Pane afterwards, as in Word.

import {defineDialog} from '../../kernel/dialog.mjs';
import {LAYOUTS, LAYOUT_IDS} from '../lib/smartart-word.mjs';

const categoryOf = id => LAYOUTS.find(l => l[0] === id)?.[2] ?? 'List';

export default defineDialog({
  id: 'dialog.insertSmartArt',
  title: 'Choose a SmartArt Graphic',
  command: 'insert.smartArt',
  init: () => ({kind: 'blockList', category: 'All'}),
  derive(v, changed) {
    if (changed.includes('category') && v.category !== 'All' && categoryOf(v.kind) !== v.category) return {kind: LAYOUTS.find(l => l[2] === v.category)?.[0] ?? v.kind};
    return {};
  },
  validate: v => (LAYOUT_IDS.includes(v.kind) ? [] : [{field: 'kind', message: 'Pick a graphic.'}]),
  toCommand: v => ({command: 'insert.smartArt', params: {layout: v.kind}}),
});
