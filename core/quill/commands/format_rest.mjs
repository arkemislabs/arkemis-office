// Home › Font › Font Color › Gradient (U:quill/rest): the selected text filled with a gradient of its own colour.
//
// Not checked against upstream (wordcraft has no gradient text fill command beyond format.textEffects' fill, which this uses); follows Word: the menu's
// Light and Dark Variations are the linear gradients of the text's colour (the same tints and shades Shape Fill › Gradient makes), each a text fill
// (w14:gradFill) set with format.textEffects; No Gradient takes the fill off again.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import * as T from '../lib/table-session.mjs';
import {rgbHex} from '../model/props.mjs';
import {variations} from '../lib/shape-fill.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/wordart.rs']};

/** The text's colour at the caret (black for Automatic). */
function textColorOf(ctx) {
  try {
    const c = T.caretProps(T.open(ctx)).color;
    return Array.isArray(c?.Rgb) ? c.Rgb : [0, 0, 0];
  } catch { return [0, 0, 0]; }
}

/** The linear variations of `main`: [{name, value: {gradient: [hex...], angle}, fill}] for the light set (0) or the dark one (1). */
function linearOnes(main, set) {
  return variations(main)[set].filter(v => v.fill.kind.type === 'linear').map(v => ({name: v.name, fill: v.fill,
    value: {gradient: v.fill.stops.map(st => rgbHex(st.color)), angle: v.fill.kind.angle}}));
}

export default defineCommands({
  family: 'format_rest',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [0, 1].map(set => ({
    id: set === 0 ? 'format.textGradientLight' : 'format.textGradientDark', label: set === 0 ? 'Light Variations' : 'Dark Variations', risk: 'edit', state: ctx => {
      const st = T.ready(ctx);
      if (!st.enabled) return st;
      return {...st, value: linearOnes(textColorOf(ctx), set).map((v, i) => ({id: String(i), label: v.name, value: v.value, art: {kind: 'gradient', fill: v.fill}, iconOnly: true}))};
    },
    description: `Gradient › ${set === 0 ? 'Light' : 'Dark'} Variations (Home › Font › Font Color): the selected text filled with one of the eight linear gradients of its colour (\`gradient\`: the colours, \`angle\`), as format.textEffects' fill. Not checked against upstream.`,
    params: s.object({gradient: s.optional(s.array(s.string({max: 16}), {min: 2, max: 10})), angle: s.optional(s.number())}),
    run: (ctx, p) => ctx.run('format.textEffects', {fill: {gradient: p.gradient ?? linearOnes(textColorOf(ctx), set)[0].value.gradient, angle: p.angle ?? 90}}),
  })),
});
