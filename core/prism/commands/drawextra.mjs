// Draw tab, the rest: Add Pen with the gallery of the pens added, and the Ruler stencil.
// PowerPoint's behaviour, not checked against upstream (deckcraft's Draw tab has its five pens and no
// more; the pen gallery follows Arkemis Quill's, which is the same ribbon in Word).
//
// - Add Pen (Pen, Pencil, Highlighter) adds a pen of that kind in the colour and thickness in use to
//   the gallery and picks it up; a click on a gallery pen picks it up (draw.usePen), a right click
//   removes it (draw.removePen). The pens are kept per profile in the settings (`prismPens`).
// - Ruler puts a ruler on the slide (draw.ruler): drag it to move it, roll the wheel over it to turn
//   it; ink drawn along its edge with a pen or highlighter runs straight along it
//   (core/prism/lib/pointer.mjs `rulerSnap`). The ruler is view state, never in the file.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {bad, hasSlide, UPSTREAM_COMMIT} from '../lib/text-session.mjs';
import {isSchema2} from '../model/doc.mjs';
import {PENS} from './tool.mjs';
import {fromHex, hex} from '../model/color.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/ui-egui/src/ribbon/draw.rs']};
export const MAX_PENS = 24;
const KINDS = ['pen', 'pencil', 'highlighter'];
const LABEL = {pen: 'Pen', pencil: 'Pencil', highlighter: 'Highlighter'};
const ICON = {pen: 'pen', pencil: 'pencil', highlighter: 'highlight'};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const PRESET = {pen: PENS[0], pencil: PENS[3], highlighter: PENS[4]};

/** The pens added with Add Pen, from the settings (a saved pen that is not one is dropped). */
export function pensOf(ctx) {
  const saved = ctx?.prefs?.prismPens;
  if (!Array.isArray(saved)) return [];
  const out = [];
  for (const v of saved) {
    if (out.length >= MAX_PENS) break;
    if (!v || typeof v !== 'object' || !KINDS.includes(v.kind)) continue;
    const c = fromHex(String(v.color ?? ''));
    if (!c || !Number.isFinite(v.width)) continue;
    out.push({kind: v.kind, color: hex(c), width: clamp(v.width, 0.1, 100)});
  }
  return out;
}
const savePens = (ctx, pens) => ctx.updatePrefs({prismPens: pens});

/** The colour and thickness of a kind's pen as it stands: the tool in use when it is that kind, else the kind's own. */
function currentOf(ctx, kind) {
  const t = ctx.view?.tool;
  const mode = kind === 'highlighter' ? 'highlighter' : 'pen';
  const [, , dc, dw] = PRESET[kind];
  if (t?.kind === 'ink' && t.mode === mode && t.color && Number.isFinite(t.width) && kind !== 'pencil') return {color: hex(t.color), width: t.width};
  return {color: hex(dc), width: dw};
}

function arm(ctx, pen) {
  const c = fromHex(pen.color);
  const mode = pen.kind === 'highlighter' ? 'highlighter' : 'pen';
  ctx.setView({tool: {kind: 'ink', mode, color: {r: c.r, g: c.g, b: c.b, a: 255}, width: pen.width, sticky: true}, toolDrag: null});
}

const inUse = (ctx, p) => { const t = ctx.view?.tool; return t?.kind === 'ink' && t.mode === (p.kind === 'highlighter' ? 'highlighter' : 'pen') && t.color && hex(t.color) === p.color && t.width === p.width; };
const gallery = ctx => pensOf(ctx).map((p, i) => ({selected: inUse(ctx, p), id: String(i), label: `${LABEL[p.kind]}: ${p.width} pt, #${p.color}`,
  value: i, icon: ICON[p.kind], accent: `#${p.color}`, bar: clamp(p.width * 0.6, 1.5, 8)}));

export const RULER_LENGTH = 520;
export const RULER_THICKNESS = 70;
const rulerOf = ctx => (ctx.view?.rulerStencil && ctx.view.rulerStencil.on !== false ? ctx.view.rulerStencil : null);

export default defineCommands({
  family: 'drawextra',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'draw.addPen', label: 'Add Pen', risk: 'read', effect: 'prefs', state: hasSlide,
      description: 'Add Pen: add a pen (`kind` pen, pencil or highlighter, `color` #RRGGBB, `width` pt) to the pen gallery and pick it up; `current` takes the colour and thickness of that kind in use. Not checked against upstream.',
      params: s.object({kind: s.optional(s.enum(KINDS)), color: s.optional(s.string({max: 16})), width: s.optional(s.number({min: 0.1, max: 100})), current: s.optional(s.boolean())}),
      run(ctx, p) {
        if (!isSchema2(ctx.doc)) throw bad('draw.addPen', 'needs a presentation (schema 2)');
        const kind = p.kind ?? 'pen';
        const base = p.current === false ? {color: hex(PRESET[kind][2]), width: PRESET[kind][3]} : currentOf(ctx, kind);
        const c = p.color === undefined ? fromHex(base.color) : fromHex(p.color);
        if (!c) throw bad('draw.addPen', '`color` is #RRGGBB');
        const pen = {kind, color: hex(c), width: Number.isFinite(p.width) ? clamp(p.width, 0.1, 100) : base.width};
        const pens = pensOf(ctx);
        if (pens.length >= MAX_PENS) throw bad('draw.addPen', `the pen gallery holds at most ${MAX_PENS} pens`);
        savePens(ctx, [...pens, pen]);
        arm(ctx, {...pen, index: pens.length});
        return {pen, index: pens.length, pens: pens.length + 1};
      },
    },
    {
      id: 'draw.usePen', label: 'Use Pen', risk: 'read', effect: 'view',
      description: 'Use Pen: pick up gallery pen `index` (0-based) with its colour and thickness.',
      params: s.object({index: s.integer({min: 0, max: MAX_PENS})}),
      state(ctx) { const st = hasSlide(ctx); return st.enabled ? {enabled: true, value: gallery(ctx)} : st; },
      run(ctx, p) {
        const pen = pensOf(ctx)[p.index];
        if (!pen) throw bad('draw.usePen', `no pen ${p.index}`);
        arm(ctx, {...pen, index: p.index});
        return {pen};
      },
    },
    {
      id: 'draw.removePen', label: 'Remove Pen', risk: 'read', effect: 'prefs', state: hasSlide,
      description: 'Remove Pen: take gallery pen `index` (0-based) out of the gallery.',
      params: s.object({index: s.integer({min: 0, max: MAX_PENS})}),
      run(ctx, p) {
        const pens = pensOf(ctx);
        if (p.index >= pens.length) throw bad('draw.removePen', `no pen ${p.index}`);
        savePens(ctx, pens.filter((_, i) => i !== p.index));
        return {removed: pens[p.index], pens: pens.length - 1};
      },
    },
    {
      id: 'draw.ruler', label: 'Ruler', risk: 'read', effect: 'view',
      description: `Ruler (Draw › Stencils): a ruler ${RULER_LENGTH} pt long on the slide. \`on\` shows or hides it (default: toggle); \`x\`, \`y\` (the ruler's top left corner, slide points) and \`angle\` (degrees) place it. Ink drawn along its edge runs straight. Not checked against upstream.`,
      params: s.object({on: s.optional(s.boolean()), x: s.optional(s.number({min: -5000, max: 5000})), y: s.optional(s.number({min: -5000, max: 5000})), angle: s.optional(s.number({min: -3600, max: 3600}))}),
      state: ctx => { const st = hasSlide(ctx); return st.enabled ? {enabled: true, checked: !!rulerOf(ctx)} : st; },
      run(ctx, p) {
        if (!isSchema2(ctx.doc)) throw bad('draw.ruler', 'needs a presentation (schema 2)');
        const cur = ctx.view?.rulerStencil ?? null;
        const on = typeof p.on === 'boolean' ? p.on : (p.x !== undefined || p.y !== undefined || p.angle !== undefined) ? true : !rulerOf(ctx);
        const size = ctx.doc.slideSize ?? {width: 960, height: 540};
        const base = cur ?? {x: Math.max(0, (size.width - RULER_LENGTH) / 2), y: size.height * 0.55, angle: 0};
        const angle = p.angle === undefined ? base.angle : ((p.angle % 360) + 360) % 360;
        const next = {x: p.x ?? base.x, y: p.y ?? base.y, angle, on};
        ctx.setView({rulerStencil: next});
        return next;
      },
    },
  ],
});
