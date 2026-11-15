// Picture Format and Shape Format › Alt Text and the Format Shape pane: the two panes the object tabs show beside the
// page, and where the Format Picture and Format Shape sections open.
//
// Translated from wordcraft crates/engine/src/cmd/view.rs (`view.altTextPane`, `view.formatShapePane`: `pure`, a
// view flag, no document change) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. The window shows or hides the panes from these view flags
// (QuillSurface). `tab` is where the Format pane opens: fill (Fill & Line), effects, layout (Layout & Properties) or
// picture (Picture: corrections, colour and crop); not upstream's, which has the fill section only.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {UPSTREAM_COMMIT, ready} from '../../lib/caret-session.mjs';
import {selectedIn, reasonFor, NO_OBJECT} from '../../lib/object-edit.mjs';
import {fillForm} from '../../model/fill.mjs';
import {originalSize} from './picture.mjs';
import * as P from '../../model/para.mjs';
import {elementsOf, elementOf} from '../chart-format.mjs';
import {colorOfSeries, gridTheme} from '../../lib/chart-draw.mjs';

/** What the Format Shape and Alt Text panes show of the selected drawing (read straight from the document). */
function info(ctx) {
  const d = ctx.model.open(ctx);
  const all = ctx.model.selection(ctx);
  const r = all[ctx.selection?.primary ?? 0] ?? all[0];
  const o = selectedIn(d, {anchor: r.anchor, focus: r.focus})?.obj;
  if (!o) return null;
  const canvas = P.canvasStyle(o);
  const float = o.float ?? P.defaultFloat();
  const body = o.type === 'shape' && o.story != null ? d.c.parts[o.story]?.body ?? {} : null;
  return {
    type: o.type, kind: o.kind ?? null, canvas: !!canvas, textBox: o.type === 'shape' && o.story != null,
    width: o.w, height: o.h, rotation: float.rot ?? 0, wrap: float.wrap ?? 'inline',
    fill: o.type === 'image' ? null : fillForm(canvas ? canvas.fill : o.fill), stroke: canvas ? canvas.stroke ?? null : o.stroke ?? null,
    strokeWidth: canvas ? canvas.strokeWidth ?? 0.75 : o.strokeWidth ?? 0.75, effects: o.effects ?? {},
    crop: o.crop ?? [0, 0, 0, 0], border: o.look && o.look.drawn === o.media ? o.look.border ?? null : null, edited: !!o.orig,
    original: o.type === 'image' ? (() => { const g = originalSize(d, o); return g ? {width: g.w, height: g.h} : null; })() : null,
    alt: P.altTextOf(o), title: float.alt?.title ?? '', decorative: !!float.alt?.decorative,
    vert: body ? body.vert ?? 'horz' : null, anchor: body ? body.anchor ?? 'top' : null,
    theme: d.c.settings?.themeColors ?? null,
    // A chart: the element Current Selection picked and what the Format pane shows of it.
    chart: o.type === 'graphic' && o.graphic?.chart ? (() => {
      const c = o.graphic.chart, theme = gridTheme(d.c.settings?.themeColors), el = elementOf(c, ctx.view);
      return {element: el.id, label: el.label, elements: elementsOf(c), areaFill: c.areaFill ?? null, areaLine: c.areaLine ?? null, title: c.title ?? null, legend: c.legend ?? null,
        series: c.series.map((x, i) => ({name: x.name || `Series ${i + 1}`, color: `#${colorOfSeries(c, theme, i).slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`}))};
    })() : null,
  };
}

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/view.rs']};
export const FORMAT_TABS = Object.freeze(['fill', 'effects', 'layout', 'picture']);

export default defineCommands({
  family: 'objects/panes',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'object.info', label: 'Selected Object', risk: 'read', effect: 'view',
      description: 'The selected picture, shape, text box or canvas as the Format Shape and Alt Text panes show it: type, size, rotation, fill, outline, effects, crop, alt text, text direction.',
      params: s.object({}),
      state(ctx) {
        const reason = reasonFor(ctx, () => null, NO_OBJECT);
        if (reason) return {enabled: false, reason};
        try { return {enabled: true, value: info(ctx)}; } catch { return {enabled: false, reason: NO_OBJECT}; }
      },
      run(ctx) { ready(ctx); return {object: info(ctx)}; }},
    {id: 'view.altTextPane', label: 'Alt Text Pane', risk: 'read', effect: 'view',
      description: 'Alt Text (Picture Format and Shape Format › Accessibility): shows or hides the Alt Text pane (`value` sets it).',
      params: s.object({value: s.optional(s.boolean())}),
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: !!ctx.view?.altTextPane} : r; },
      run(ctx, p) { ready(ctx); const on = p.value ?? !ctx.view?.altTextPane; ctx.setView({altTextPane: on}); return {value: on}; }},
    {id: 'view.cropMode', label: 'Crop', risk: 'read', effect: 'view',
      description: 'Crop (Picture Format › Size): turns crop mode on or off (`value` sets it): the selected picture shows its crop handles on the page; dragging one trims that side (picture.crop).',
      params: s.object({value: s.optional(s.boolean())}),
      state: ctx => {
        const r = reasonFor(ctx, o => (o.type === 'image' ? null : 'select a picture first'), 'select a picture first');
        return r ? {enabled: false, reason: r, checked: !!ctx.view?.cropping} : {enabled: true, checked: !!ctx.view?.cropping};
      },
      run(ctx, p) { ready(ctx); const on = p.value ?? !ctx.view?.cropping; ctx.setView({cropping: on}); return {value: on}; }},
    {id: 'view.formatShapePane', label: 'Format Shape Pane', risk: 'read', effect: 'view',
      description: 'Format Shape (Shape Format › Shape Styles › Fill › More Gradients): shows or hides the Format Shape pane (Format Picture for a picture); `tab` opens it on fill, effects, layout or picture.',
      params: s.object({value: s.optional(s.boolean()), tab: s.optional(s.enum(FORMAT_TABS))}),
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: !!ctx.view?.formatShapePane} : r; },
      run(ctx, p) {
        ready(ctx);
        const on = p.value ?? (p.tab ? true : !ctx.view?.formatShapePane);
        ctx.setView({formatShapePane: on, ...(p.tab ? {formatPaneTab: p.tab} : {})});
        return {value: on, tab: p.tab ?? ctx.view?.formatPaneTab ?? 'fill'};
      }},
  ],
});
