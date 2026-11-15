// Drawing Canvas (Insert › Illustrations › Shapes › New Drawing Canvas, and Draw › Insert › Drawing Canvas):
// a frame in line with the text at the caret that holds pictures, shapes and text boxes at offsets in the
// canvas. It stays selected, so Shape Format shows its Drawing Canvas group.
//
// Translated from wordcraft crates/engine/src/cmd/canvas.rs (`insert`, the `insert.canvas` spec) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Not here yet (their controls stay with Shape Format): canvas.fit, canvas.expand, canvas.scale and
// canvas.member, and putting a picture, shape or text box inside a selected canvas (`add_member`); the
// canvas saves to .docx as an empty `wpc:wpc` with its fill and outline (docx-write.mjs `writeCanvas`).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import * as T from '../lib/table-session.mjs';
import {newFloat} from '../lib/default-layout.mjs';
import {UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import {defaultFloat} from '../model/para.mjs';
import {parseRgb} from '../model/props.mjs';
import {BODY} from '../model/document.mjs';
import {CommandError} from '../../kernel/errors.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/canvas.rs']};
/** Largest canvas side and smallest, points. */
const MAX_SIDE = 4000, MIN_SIDE = 9;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** insert.canvas: a new empty canvas in line with text at the caret, selected (insert). */
function insert(ctx, p) {
  const S = T.open(ctx);
  const w = clamp(Number.isFinite(p.width) ? p.width : 432, MIN_SIDE, MAX_SIDE);
  const h = clamp(Number.isFinite(p.height) ? p.height : 216, MIN_SIDE, MAX_SIDE);
  const canvas = {fill: typeof p.fill === 'string' ? parseRgb(p.fill) : null, stroke: typeof p.outline === 'string' ? parseRgb(p.outline) : null, strokeWidth: 0.75};
  const props = T.typingProps(S);
  const at = T.deleteSelection(S);
  const end = S.d.insertObject(at, {type: 'group', w, h, float: newFloat(S, defaultFloat()), ch_w: w, ch_h: h, children: [], canvas}, props);
  S.sel = {anchor: T.clonePos(at), focus: end};
  S.cells = null;
  return T.finish(S);
}

export default defineCommands({
  family: 'canvas',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.canvas', label: 'Drawing Canvas', risk: 'edit',
      state(ctx) {
        const r = T.ready(ctx);
        if (!r.enabled) return r;
        const f = ctx.model.selection(ctx)[ctx.selection?.primary ?? 0]?.focus;
        const part = f && f.story !== BODY ? ctx.doc.parts?.[f.story] : null;
        return part?.kind === 'textBox' ? {enabled: false, reason: "A drawing canvas can't go inside a text box"} : {enabled: true};
      },
      description: 'Drawing Canvas: an empty canvas in line with the text at the caret (`width` 432 pt, `height` 216 pt, optional `fill` and `outline` RRGGBB); it stays selected.',
      params: s.object({width: s.optional(s.number()), height: s.optional(s.number()), fill: s.optional(s.string({max: 16})), outline: s.optional(s.string({max: 16}))}),
      run: (ctx, p) => {
        for (const k of ['fill', 'outline']) if (typeof p[k] === 'string' && !parseRgb(p[k])) throw new CommandError('invalid_params', `${k} is RRGGBB`);
        return insert(ctx, p);
      }},
  ],
});
