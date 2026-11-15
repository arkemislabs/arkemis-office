// Organize pages, the parts of the page grid's toolbar and the More menu that are not page edits of their own: Move earlier and Move
// later, the size of the pages in the grid (Larger pages, Smaller pages, Reset page size), Page properties (the tab order of pages) and
// Page transitions (what a full-screen presentation plays between pages).
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/canvas/organize.rs      organize_toolbar: Move earlier / Move later are Edit::MovePages of the target pages to
//                                              first - 1 / first + 1 (off at either end of the document), Larger pages / Smaller pages
//                                              scale the grid by GRID_ZOOM_STEP, the percentage resets it to 100 %
//   crates/ui-egui/src/canvas/zoom.rs          GRID_ZOOM_RANGE 0.5 to 3.0, GRID_ZOOM_STEP 1.25
//   crates/ui-egui/src/commands.rs:362         page.properties opens Page Properties on the target pages, with the tab order they share
//   crates/ui-egui/src/dialogs.rs:223          Dialog::PageProps: an order every page already has adds no undo step
//   crates/forms/src/tab_order.rs              set_tab_order (/Tabs R, C, S; none removes it), tab_orders (lib/form-edit.mjs)
//   crates/organize/src/transition.rs          set_transition / trans_dict (docs/spec/patches/folio/organize.json: the engine only; the
//                                              catalogue lists Page transitions as planned upstream and no dialog exists there)
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/organize.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {PDFName, PDFNumber} from 'pdf-lib';
import {assembly, documentOpen, guard} from '../lib/edit-needs.mjs';
import {editable, commit} from '../lib/page-source.mjs';
import {setTabOrder, tabOrders} from '../lib/form-edit.mjs';
import {targetPages} from './page.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/canvas/organize.rs', 'crates/ui-egui/src/canvas/zoom.rs', 'crates/ui-egui/src/commands.rs',
  'crates/ui-egui/src/dialogs.rs', 'crates/forms/src/tab_order.rs', 'crates/organize/src/transition.rs']};

export const GRID_ZOOM_RANGE = Object.freeze([0.5, 3]);
export const GRID_ZOOM_STEP = 1.25;
const gridZoomOf = ctx => ctx.view?.gridZoom ?? 1;
const clampZoom = z => Math.min(GRID_ZOOM_RANGE[1], Math.max(GRID_ZOOM_RANGE[0], z));

/** transition.rs: the styles of ISO 32000-2 table 164 as written in /S (R is "replace": no effect), and the directions /Di allows. */
export const TRANSITION_STYLES = Object.freeze(['Split', 'Blinds', 'Box', 'Wipe', 'Dissolve', 'Glitter', 'R', 'Fly', 'Push', 'Cover', 'Uncover', 'Fade']);
export const TRANSITION_DIRECTIONS = Object.freeze([0, 90, 180, 270, 315]);
const ORDERS = ['row', 'column', 'structure', 'unspecified'];

/** The /Trans dictionary (as the model's JSON form is not needed here: pdf-lib objects) for `t`: only what differs from the defaults and what the style reads. */
export function transEntries(t) {
  const style = t.style;
  const d = {Type: 'Trans', S: style};
  const duration = t.duration ?? 1, horizontal = t.dimension !== 'vertical', inward = t.motion !== 'outward', scale = t.scale ?? 1;
  const direction = t.direction === undefined ? 0 : t.direction;
  if (duration !== 1) d.D = duration;
  if (['Split', 'Blinds'].includes(style) && !horizontal) d.Dm = PDFName.of('V');
  if (['Split', 'Box', 'Fly'].includes(style) && !inward) d.M = PDFName.of('O');
  if (['Wipe', 'Glitter', 'Fly', 'Cover', 'Uncover', 'Push'].includes(style)) {
    if (direction === null && style === 'Fly') d.Di = PDFName.of('None');
    else if (direction !== null && direction !== 0) d.Di = direction;
  }
  if (style === 'Fly') {
    if (scale !== 1) d.SS = scale;
    if (t.opaque) d.B = true;
  }
  return d;
}

/** set_transition's checks, before any page changes. */
export function checkTransition(p) {
  const bad = message => new CommandError('invalid_params', message);
  if (p.style !== undefined) {
    if (!TRANSITION_STYLES.includes(p.style)) throw bad(`unknown transition style "${p.style}"; one of ${TRANSITION_STYLES.join(', ')}`);
    if (!(Number.isFinite(p.duration ?? 1) && (p.duration ?? 1) >= 0)) throw bad('the transition duration must be zero or more seconds');
    if (p.direction !== undefined && p.direction !== null && !TRANSITION_DIRECTIONS.includes(p.direction)) throw bad(`the direction must be one of ${TRANSITION_DIRECTIONS.join(', ')} degrees`);
    if (!(Number.isFinite(p.scale ?? 1) && (p.scale ?? 1) > 0)) throw bad('the Fly scale must be more than zero');
  }
  if (p.display !== undefined && !(Number.isFinite(p.display) && p.display >= 0)) throw bad('the display time must be zero or more seconds');
}

export default defineCommands({
  family: 'organize', app: 'folio', upstream: UPSTREAM,
  commands: [
    {
      id: 'organize.move', label: 'Move pages earlier or later', risk: 'edit',
      description: 'Move the selected pages (else the current page) one place earlier (`by` -1) or later (1), kept in their order: Edit::MovePages to the first page\'s position -1 or +1. Off at either end of the document.',
      params: s.object({by: s.enum([-1, 1])}),
      state(ctx, p) {
        const st = assembly(ctx);
        if (!st.enabled) return st;
        const targets = targetPages(ctx);
        const n = ctx.doc.pages.length;
        if (p?.by === -1 && targets[0] === 0) return {enabled: false, reason: 'the first page is already first'};
        if (p?.by === 1 && targets.at(-1) + 1 >= n) return {enabled: false, reason: 'the last page is already last'};
        return {enabled: true};
      },
      run(ctx, p) {
        guard(ctx, assembly);
        const sorted = targetPages(ctx);
        const list = ctx.doc.pages;
        const first = sorted[0];
        if (p.by < 0 ? first === 0 : sorted.at(-1) + 1 >= list.length) throw new CommandError('disabled', p.by < 0 ? 'the first page is already first' : 'the last page is already last');
        const moving = sorted.map(i => list[i]);
        const rest = list.filter((_, i) => !sorted.includes(i));
        const to = Math.min(Math.max(0, first + p.by), rest.length);
        rest.splice(to, 0, ...moving);
        ctx.change.set(['pages'], rest);
        ctx.setSelection({ranges: moving.map(m => ({anchor: `/pg:${m.id}`, focus: `/pg:${m.id}`})), primary: 0});
        ctx.setUndoLabel(moving.length === 1 ? 'Move page' : 'Move pages');
        return {pages: moving.map(m => m.id), to};
      },
    },
    {
      id: 'organize.zoom', label: 'Page size in the grid', risk: 'read', effect: 'view', undo: 'none',
      description: 'The size of the pages in the Organize grid: `mode` "in" (Larger pages) and "out" (Smaller pages) scale it by 1.25 within 50 % to 300 %, "reset" (the percentage) goes back to 100 %; or `percent` sets it.',
      params: s.object({mode: s.optional(s.enum(['in', 'out', 'reset'])), percent: s.optional(s.number({min: 50, max: 300}))}),
      state(ctx, p) {
        const st = documentOpen(ctx);
        if (!st.enabled) return st;
        const z = gridZoomOf(ctx);
        if (p?.mode === 'in' && z >= GRID_ZOOM_RANGE[1]) return {enabled: false, reason: 'the pages are as large as they go'};
        if (p?.mode === 'out' && z <= GRID_ZOOM_RANGE[0]) return {enabled: false, reason: 'the pages are as small as they go'};
        return {...st, value: `${Math.round(z * 100)}%`};
      },
      run(ctx, p) {
        const z = gridZoomOf(ctx);
        const next = p.percent !== undefined ? p.percent / 100 : p.mode === 'in' ? z * GRID_ZOOM_STEP : p.mode === 'out' ? z / GRID_ZOOM_STEP : 1;
        const gridZoom = clampZoom(next);
        ctx.setView({gridZoom});
        return {zoom: Math.round(gridZoom * 100)};
      },
    },
    {
      id: 'page.properties', label: 'Page properties…', risk: 'edit', needs: 'worker', dialog: 'dialog.page-properties',
      description: 'Page Properties of the target pages (the selected pages, else the current page, or `pages`, 0-based): their tab order, written as /Tabs R (row), C (column) or S (structure); "unspecified" removes it. Without `order` nothing is written and the pages\' present orders come back. An order every page already has adds no undo step.',
      params: s.object({pages: s.optional(s.array(s.integer({min: 0, max: 99999}), {min: 1, max: 10000})), order: s.optional(s.enum(ORDERS))}),
      state: documentOpen,
      async run(ctx, p) {
        const targets = targetPages(ctx, p.pages);
        const {doc, content: base} = await editable(ctx.doc, targets);
        const sources = targets.map(i => base.pages[i].sourceIndex);
        const all = tabOrders(doc);
        const before = targets.map(i => all[base.pages[i].sourceIndex]);
        const shared = before.every(o => o === before[0]) ? before[0] : null;
        const said = o => (o === 'annotations' ? 'unspecified' : o);
        if (!p.order) return {pages: targets.map(i => i + 1), orders: before.map(said), order: shared === null ? null : said(shared)};
        if (before.every(o => o === (p.order === 'unspecified' ? 'annotations' : p.order))) return {pages: targets.map(i => i + 1), order: p.order, changed: 0};
        setTabOrder(doc, sources, p.order === 'unspecified' ? 'annotations' : p.order);
        await commit(ctx, doc, base);
        ctx.setUndoLabel('Set tab order');
        return {pages: targets.map(i => i + 1), order: p.order, changed: targets.length};
      },
    },
    {
      id: 'page.transitions', label: 'Page transitions', risk: 'edit', needs: 'worker',
      description: 'Set or remove the transition and the display time the target pages play in a full-screen presentation (ISO 32000-2 12.4.4; Acrobat\'s Organize > Page Transitions). `style`: Split, Blinds, Box, Wipe, Dissolve, Glitter, R (replace, no effect), Fly, Push, Cover, Uncover or Fade; leave it out to remove the transition. `duration` seconds (default 1); `dimension` horizontal or vertical (Split, Blinds); `motion` inward or outward (Split, Box, Fly); `direction` 0, 90, 180, 270, 315 or null (Wipe, Glitter, Fly, Cover, Uncover, Push); `scale` and `opaque` for Fly. `display`: seconds the page stays before advancing; left out, the page waits for the presenter. Every value is checked before any page changes.',
      params: s.object({
        pages: s.optional(s.array(s.integer({min: 0, max: 99999}), {min: 1, max: 10000})), style: s.optional(s.enum(TRANSITION_STYLES)), duration: s.optional(s.number({min: 0, max: 3600})),
        dimension: s.optional(s.enum(['horizontal', 'vertical'])), motion: s.optional(s.enum(['inward', 'outward'])), direction: s.optional(s.nullable(s.integer({min: 0, max: 315}))),
        scale: s.optional(s.number({min: 0.000001, max: 1000})), opaque: s.optional(s.boolean()), display: s.optional(s.number({min: 0, max: 86400})),
      }),
      state: assembly,
      async run(ctx, p) {
        guard(ctx, assembly);
        checkTransition(p);
        const targets = targetPages(ctx, p.pages);
        const {doc, content: base} = await editable(ctx.doc, targets);
        const context = doc.context;
        const entries = p.style === undefined ? null : transEntries(p);
        for (const i of targets) {
          const page = doc.getPage(base.pages[i].sourceIndex);
          if (entries) page.node.set(PDFName.of('Trans'), context.obj(entries)); else page.node.delete(PDFName.of('Trans'));
          if (p.display !== undefined) page.node.set(PDFName.of('Dur'), PDFNumber.of(p.display)); else page.node.delete(PDFName.of('Dur'));
        }
        await commit(ctx, doc, base);
        ctx.setUndoLabel('Set page transitions');
        return {pages: targets.map(i => i + 1), style: p.style ?? null, display: p.display ?? null};
      },
    },
  ],
});
