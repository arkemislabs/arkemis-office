// Zoom, 100%, Zoom In and Zoom Out for every app (session view state, never undoable).
// Translated from wordcraft crates/engine/src/cmd/view.rs (zoom, view.zoom100, view.zoomIn,
// view.zoomOut: 10% steps from the current zoom, 10–500%) at
// aadb077e072b7de05f724e359d8db82e151f125c. Gridcraft caps zoom at 400% (crates/engine/src/cmd/view.rs
// `{percent: 10..400}`) and calls the value `percent`; both names are accepted. The PDF page view
// zooms 8–6400% with Acrobat's zoom-menu steps for Zoom In / Zoom Out (printcraft
// crates/ui-egui/src/canvas/zoom.rs `zoom_at` clamp(0.08, 64.0) and `zoom_step` STEPS, at
// 3109bb2359759e24ef490e1cdbdba00722b20972). MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';

export const FIT_MODES = Object.freeze(['pageWidth', 'onePage', 'multiplePages', 'textWidth', 'fit']);
const MAX_ZOOM = {grid: 400, folio: 6400};
const MIN_ZOOM = {folio: 8};
export const maxZoom = app => MAX_ZOOM[app] ?? 500;
export const minZoom = app => MIN_ZOOM[app] ?? 10;
/** printcraft `zoom_step` STEPS (Acrobat's zoom menu), in percent. */
export const FOLIO_ZOOM_STEPS = Object.freeze([10, 25, 33, 50, 66, 75, 100, 125, 150, 200, 300, 400, 600, 800, 1200, 1600, 3200]);

/** The zoom Zoom In (up) or Zoom Out goes to from `z`; null when there is no further step. */
export function zoomStep(app, z, up) {
  if (app === 'folio') {
    // printcraft: the next step more than 1% away, so 99.5% zooms in to 100% only when it is not already there.
    const next = up ? FOLIO_ZOOM_STEPS.find(s => s > z * 1.01) : [...FOLIO_ZOOM_STEPS].reverse().find(s => s < z * 0.99);
    return next ?? null;
  }
  const v = up ? Math.min(maxZoom(app), (Math.round(z / 10) * 10) + 10) : Math.max(minZoom(app), (Math.round(z / 10) * 10) - 10);
  return v === z ? null : v;
}

function setZoom(ctx, value) {
  if (typeof value === 'string') {
    // wordcraft `zoom`: Multiple Pages shows two or more per row, One Page and Page Width one (#768).
    ctx.setView({fit: value, multiPage: value === 'multiplePages', singleColumn: value === 'onePage' || value === 'pageWidth'});
    return {zoom: ctx.view?.zoom ?? 100, fit: value};
  }
  const max = maxZoom(ctx.app), min = minZoom(ctx.app);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new CommandError('invalid_params', `zoom must be ${min}–${max}%`, {path: '/value'});
  }
  const zoom = Math.round(value * 10) / 10;
  // A percent drops the fit mode; after One Page or Page Width the pages stay one per row (#768).
  ctx.setView({zoom, fit: null, multiPage: false});
  return {zoom, fit: null};
}

const current = ctx => ctx.view?.zoom ?? 100;
const viewState = ctx => ({enabled: true, value: current(ctx)});

export default defineCommands({
  family: 'view',
  app: '*',
  upstream: {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/view.rs']},
  commands: [
    {
      id: 'view.zoom', label: 'Zoom', risk: 'read', effect: 'view', dialog: 'dialog.zoom',
      description: 'Set the zoom: a percent (10–500; Grid 10–400; PDF 8–6400), or a fit mode (pageWidth, onePage, multiplePages, textWidth, fit).',
      params: s.object({
        value: s.optional(s.union([s.number({min: 8, max: 6400}), s.enum(FIT_MODES)])),
        percent: s.optional(s.number({min: 8, max: 6400})),
      }),
      state: viewState,
      run(ctx, p) {
        const value = p.value ?? p.percent;
        if (value === undefined) throw new CommandError('invalid_params', 'zoom percent or fit mode is required', {path: '/value'});
        return setZoom(ctx, value);
      },
    },
    {
      id: 'view.zoom100', label: '100%', risk: 'read', effect: 'view', shortcut: null,
      description: 'Zoom to 100%.',
      params: s.object({}),
      state: ctx => ({enabled: true, checked: current(ctx) === 100 && !ctx.view?.fit}),
      run: ctx => setZoom(ctx, 100),
    },
    {
      id: 'view.zoomIn', label: 'Zoom In', risk: 'read', effect: 'view',
      description: 'Zoom in by 10% (PDF: to the next of Acrobat’s zoom steps).',
      params: s.object({}),
      state: ctx => (zoomStep(ctx.app, current(ctx), true) === null ? {enabled: false, reason: 'already at the largest zoom'} : viewState(ctx)),
      run: ctx => setZoom(ctx, zoomStep(ctx.app, current(ctx), true) ?? current(ctx)),
    },
    {
      id: 'view.zoomOut', label: 'Zoom Out', risk: 'read', effect: 'view',
      description: 'Zoom out by 10% (PDF: to the previous of Acrobat’s zoom steps).',
      params: s.object({}),
      state: ctx => (zoomStep(ctx.app, current(ctx), false) === null ? {enabled: false, reason: 'already at the smallest zoom'} : viewState(ctx)),
      run: ctx => setZoom(ctx, zoomStep(ctx.app, current(ctx), false) ?? current(ctx)),
    },
  ],
});
