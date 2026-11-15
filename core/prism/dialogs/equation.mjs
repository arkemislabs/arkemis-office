// Equation (submit: insert.textBox, then the equation look): an equation typed in linear form,
// prettified (x^2 → x², sqrt → √, <= → ≤ …) and inserted as an italic 28 pt Liberation Serif text box
// in the middle of the slide, as one undo step.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_equation`) and
// crates/ui-egui/src/dialogs/equation.rs (`pretty_equation`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

const SUP = {0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', n: 'ⁿ', i: 'ⁱ', '+': '⁺', '-': '⁻'};

/** `pretty_equation`: superscripts after ^ (digits run on, a letter or sign ends it), · for *, then the word and operator replacements. */
export function prettyEquation(s) {
  const cs = [...String(s)];
  let out = '';
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c === '^') {
      while (i + 1 < cs.length) {
        const n = cs[i + 1];
        if (/^[A-Za-z0-9]$/.test(n) || n === '+' || n === '-') {
          out += SUP[n] ?? n;
          i++;
          if (!/^[0-9]$/.test(n)) break;
        } else break;
      }
    } else if (c === '*') out += '·';
    else out += c;
  }
  return out.replaceAll('sqrt', '√').replaceAll('<=', '≤').replaceAll('>=', '≥').replaceAll('!=', '≠').replaceAll('pi', 'π').replaceAll('+-', '±');
}

/** Insert: the text box (selected), then Liberation Serif, italic, 28 pt on it. */
export function equationBatch(text, size) {
  const w = size?.width ?? 960, h = size?.height ?? 540;
  return {batch: [
    {command: 'insert.textBox', params: {rect: [w / 2 - 150, h / 2 - 25, 300, 50], text: prettyEquation(text)}},
    {command: 'format.font', params: {family: 'Liberation Serif'}},
    {command: 'format.italic', params: {on: true}},
    {command: 'format.size', params: {size: 28}},
  ]};
}

export default defineDialog({
  id: 'dialog.equation',
  title: 'Equation',
  command: 'insert.textBox',
  init: ctx => ({text: '', slideSize: ctx.doc?.slideSize ?? null}),
  // What the text box will say: the prettified form in the 28 pt italic serif it is inserted in.
  preview: (_ctx, v) => ({text: prettyEquation(String(v.text ?? '')) || 'Your equation appears here', font: 'Liberation Serif', size: 20}),
  validate: v => (String(v.text ?? '').length ? [] : [{field: 'text', message: 'Type an equation'}]),
  toCommand: v => equationBatch(String(v.text), v.slideSize),
});
