// Shape Height and Shape Width of the Format tabs: the boxes show the selected chart, picture or shape's size in points, and typing a
// value resizes it, the other side following when Lock aspect ratio is set (`lockAspect` on the object; pictures are locked unless
// turned off, as in Excel). Built from Excel's behaviour; not in gridcraft, not checked against upstream. U:grid/object-format.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {bad} from '../../lib/data-common.mjs';
import {pick, put, needs, selectedOf, KINDS} from '../../lib/object-edit.mjs';

const UPSTREAM = {repo: 'office', commit: undefined, files: ['Excel for Windows > Format tabs > Size (not in gridcraft)']};
const PX = 96 / 72;
const locked = (kind, o) => (typeof o.lockAspect === 'boolean' ? o.lockAspect : kind === 'image');
const round = v => Math.round(v * 10) / 10;

function size(ctx, p) {
  if (!['width', 'height'].includes(p.dim)) throw bad('object.size', '`dim` is width or height');
  if (!Number.isFinite(p.value)) throw bad('object.size', '`value` is the size in points');
  const t = pick(ctx, p, 'object.size', KINDS);
  const a = {...t.object.anchor};
  const flat = ['line', 'arrow'].includes(t.object.kind);
  const px = Math.min(10000, Math.max(p.dim === 'height' && flat ? 0 : 1, p.value * PX));
  const old = a[p.dim], other = p.dim === 'width' ? 'height' : 'width';
  a[p.dim] = Math.round(px * 100) / 100;
  if (locked(t.kind, t.object) && old > 0 && a[other] > 0 && !flat) a[other] = Math.min(10000, Math.max(1, Math.round(a[other] * a[p.dim] / old * 100) / 100));
  put(ctx, t, {...t.object, anchor: a});
  return {width: round(a.width / PX), height: round(a.height / PX)};
}

function lockAspect(ctx, p) {
  const t = pick(ctx, p, 'object.lockAspect', KINDS);
  const on = typeof p.on === 'boolean' ? p.on : !locked(t.kind, t.object);
  put(ctx, t, {...t.object, lockAspect: on});
  return {on};
}

export default defineCommands({
  family: 'objfmt/size',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'object.size', label: 'Size', risk: 'edit',
      description: 'Resize the selected chart, picture or shape: `dim` width or height, `value` in points; the other side follows when Lock aspect ratio is on.',
      params: s.object({dim: s.enum(['width', 'height']), value: s.number(), id: s.optional(s.integer({min: 0})), kind: s.optional(s.enum(KINDS))}),
      state: (ctx, p) => {
        const st = needs(KINDS, 'an object')(ctx);
        if (!st.enabled || !p?.dim) return st;
        const sel = selectedOf(ctx, KINDS);
        return {...st, value: round(sel.object.anchor[p.dim] / PX)};
      }, run: size},
    {id: 'object.lockAspect', label: 'Lock aspect ratio', risk: 'edit',
      description: 'Turn Lock aspect ratio on or off for the selected object (`on`; else toggle): resizing one side then moves the other.',
      params: s.object({on: s.optional(s.boolean()), id: s.optional(s.integer({min: 0})), kind: s.optional(s.enum(KINDS))}),
      state: ctx => { const st = needs(KINDS, 'an object')(ctx); if (!st.enabled) return st; const sel = selectedOf(ctx, KINDS); return {...st, checked: locked(sel.kind, sel.object)}; }, run: lockAspect},
  ],
});
