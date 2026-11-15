// Combine files, grid view: a card for the first page each file contributes (a stack when it contributes more than one) with its name below, a
// file expanded into one card per page, Expand all and Collapse all, and the page size (60 to 500 %, in steps with Larger pages and Smaller pages,
// Reset page size).
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/workflows/combine_ui/view.rs:155-200, 545-600   the Grid view / List view buttons, Expand all (enabled while a file with
//                                                                       more than one page is not expanded), Collapse all (enabled while any is
//                                                                       expanded), the zoom controls
//   crates/ui-egui/src/workflows/combine_grid.rs                        ZOOM_RANGE 0.6 to 5.0, ZOOM_STEPS, zoom_step, PAPER 132 x 172 points
// The cards are drawn by src/apps/folio/surface/CombineGrid.tsx from `view.combine` ({grid, zoom, expanded}); the list stays the other view. Not
// translated: dragging cards or page cards to reorder, and moving a single page between files; the list's sorting and column moves
// (docs/spec/patches/folio/combine.json).
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/combine-view.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/workflows/combine_ui/view.rs', 'crates/ui-egui/src/workflows/combine_grid.rs']};

export const ZOOM_MIN = 0.6, ZOOM_MAX = 5.0;
export const ZOOM_STEPS = [0.6, 0.8, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0];
/** combine_grid.rs zoom_step: the next size up (or down); the end of the range stays put. */
export function zoomStep(zoom, larger) {
  const next = larger ? ZOOM_STEPS.find(z => z > zoom + 0.001) : [...ZOOM_STEPS].reverse().find(z => z < zoom - 0.001);
  return next ?? (larger ? ZOOM_MAX : ZOOM_MIN);
}
const clampZoom = z => (Number.isFinite(z) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) : 1);

const tabOf = ctx => ctx.view?.combine ?? null;
const open = ctx => (tabOf(ctx)?.open ? {enabled: true} : {enabled: false, reason: 'Combine files is not open'});
/** view.rs `expandable`: a file with more than one page that can be read. */
export const expandable = f => !f.problem && f.pages > 1;
const inGrid = ctx => { const st = open(ctx); return st.enabled ? (tabOf(ctx).grid ? st : {enabled: false, reason: 'the grid view is not shown'}) : st; };
const zoomOf = ctx => clampZoom(tabOf(ctx)?.zoom ?? 1);

export default defineCommands({
  family: 'combine_view',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'combine.view', label: 'Combine view', risk: 'read', effect: 'view', undo: 'none',
      description: 'The Combine files grid: `mode` "grid", "list" or "toggle" (thumbnails or the table); `expand` "all" shows every file as its pages, "none" folds them back to cards; `zoom` sets the page size (0.6 to 5), or "larger", "smaller" (the steps 60, 80, 100, 125, 150, 175, 200, 250, 300, 400, 500 %) or "reset" (100 %); `percent` sets it as a percentage.',
      params: s.object({
        mode: s.optional(s.enum(['grid', 'list', 'toggle'])), expand: s.optional(s.enum(['all', 'none'])),
        zoom: s.optional(s.union([s.number({min: 0.6, max: 5}), s.enum(['larger', 'smaller', 'reset'])])), percent: s.optional(s.number({min: 60, max: 500})),
      }),
      state(ctx, p) {
        const st = open(ctx);
        if (!st.enabled) return st;
        const tab = tabOf(ctx);
        if (p?.mode) return {...st, checked: !!tab.grid};
        if (p?.expand || p?.zoom || p?.percent !== undefined || (p && Object.keys(p).length === 0)) {
          const g = inGrid(ctx);
          if (!g.enabled) return g;
          if (p.expand === 'all') return (tab.files ?? []).some(f => !(tab.expanded ?? []).includes(f.id) && expandable(f)) ? g : {enabled: false, reason: 'every file with pages is expanded'};
          if (p.expand === 'none') return (tab.expanded ?? []).length ? g : {enabled: false, reason: 'no file is expanded'};
          if (p.zoom === 'larger') return zoomOf(ctx) < ZOOM_MAX ? g : {enabled: false, reason: 'the pages are at their largest'};
          if (p.zoom === 'smaller') return zoomOf(ctx) > ZOOM_MIN ? g : {enabled: false, reason: 'the pages are at their smallest'};
          return {...g, value: Math.round(zoomOf(ctx) * 100)};
        }
        return st;
      },
      run(ctx, p) {
        const tab = tabOf(ctx);
        if (!tab?.open) throw new CommandError('disabled', 'Combine files is not open');
        const next = {...tab};
        if (p.mode) next.grid = p.mode === 'toggle' ? !tab.grid : p.mode === 'grid';
        if (p.expand === 'all') next.expanded = (tab.files ?? []).filter(expandable).map(f => f.id);
        if (p.expand === 'none') next.expanded = [];
        const z = zoomOf(ctx);
        if (p.zoom === 'larger') next.zoom = zoomStep(z, true);
        else if (p.zoom === 'smaller') next.zoom = zoomStep(z, false);
        else if (p.zoom === 'reset') next.zoom = 1;
        else if (typeof p.zoom === 'number') next.zoom = clampZoom(p.zoom);
        if (p.percent !== undefined) next.zoom = clampZoom(p.percent / 100);
        if (!Object.keys(p).length) throw new CommandError('invalid_params', 'give a mode, expand, zoom or percent');
        ctx.setView({combine: next});
        return {grid: !!next.grid, zoom: next.zoom ?? 1, expanded: next.expanded ?? []};
      },
    },
    {
      id: 'combine.expand', label: 'Expand a file', risk: 'read', effect: 'view', undo: 'none',
      description: 'Show one file of the grid as its pages (or fold it back to a card): a click on its stack.',
      params: s.object({id: s.integer({min: 1, max: 1e9}), open: s.optional(s.boolean())}),
      state: inGrid,
      run(ctx, p) {
        const tab = tabOf(ctx);
        const f = (tab.files ?? []).find(x => x.id === p.id);
        if (!f) throw new CommandError('not_found', `no file ${p.id} in the list`, {path: '/id'});
        const on = p.open ?? !(tab.expanded ?? []).includes(f.id);
        if (on && !expandable(f)) throw new CommandError('disabled', `${f.name} has no pages to show`);
        const expanded = on ? [...new Set([...(tab.expanded ?? []), f.id])] : (tab.expanded ?? []).filter(x => x !== f.id);
        ctx.setView({combine: {...tab, expanded}});
        return {expanded};
      },
    },
  ],
});
