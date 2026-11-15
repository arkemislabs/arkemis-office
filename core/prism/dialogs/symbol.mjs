// Symbol (submit: insert.symbol): six groups of characters; clicking one inserts it at the
// insertion point (editing the selected shape's text first when no text is being edited), and the
// dialog stays open until Close.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs `dlg_symbol` at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// PowerPoint's font/subset browser, character codes and Special Characters tab are not offered:
// deckcraft's dialog has only these groups.

import {defineDialog} from '../../kernel/dialog.mjs';
import {textSelection} from '../model/doc.mjs';

/** deckcraft's groups, in its order. */
export const GROUPS = Object.freeze([
  ['punctuation', 'Punctuation', '–—‘’“”…•·§¶†‡‰′″‹›«»¡¿'],
  ['currency', 'Currency', '$€£¥¢₹₩₽₺₿'],
  ['math', 'Math', '±×÷≠≈≤≥∞√∑∏∫∂∆∇∈∉∩∪⊂⊃∀∃¬∧∨⇒⇔°′'],
  ['greek', 'Greek', 'αβγδεζηθικλμνξοπρστυφχψωΓΔΘΛΞΠΣΦΨΩ'],
  ['arrows', 'Arrows', '←↑→↓↔↕⇐⇑⇒⇓↖↗↘↙⟵⟶'],
  ['shapes', 'Shapes', '■□▪▫▲△▶▷▼▽◀◁◆◇○●◎★☆✓✔✗✘♠♣♥♦'],
]);
export const chars = s => [...s];

export default defineDialog({
  id: 'dialog.symbol',
  title: 'Symbol',
  command: 'insert.symbol',
  init(ctx) {
    const v = {text: '', editing: !!textSelection(ctx.doc, ctx.selection)};
    for (const [id, , s] of GROUPS) v[`${id}Options`] = chars(s).map(c => ({value: c, label: c}));
    return v;
  },
  derive(v, changed) {
    // A click in any grid picks that character.
    const g = GROUPS.find(([id]) => changed.includes(id));
    return g && typeof v[g[0]] === 'string' ? {text: v[g[0]]} : {};
  },
  validate(v) { return typeof v.text === 'string' && v.text ? [] : [{field: 'text', message: 'Click a symbol to insert it.'}]; },
  /** Insert: text.edit first when a shape (not its text) is selected, as deckcraft's dialog does. */
  toCommand(v) {
    const ins = {command: 'insert.symbol', params: {text: v.text}};
    return v.editing ? ins : {batch: [{command: 'text.edit', params: {}}, ins]};
  },
});
