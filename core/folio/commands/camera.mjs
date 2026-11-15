// Scan & OCR > Enhance > Camera image: four corner handles on a page, dragged onto the edges of a photographed document; Enhance page
// straightens what they enclose, then Color mode and Clean-up give it a look, the page can be turned either way, and Done leaves the tool.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/commands.rs:543-560     ocr.enhance_camera: picks the tool with the corners on the page, "Drag the corners onto the
//                                              document's edges, then choose Enhance page."
//   crates/ui-egui/src/tools/camera_ui.rs      CameraQuad (the corners inset 5 %, dragged within the page), CameraDone (the look and level
//                                              chosen and the ones the page shows, the turns made since, the undo steps taken), the bar:
//                                              Enhance page and Cancel; once enhanced the looks, the Clean-up slider, rotate, Crop pages,
//                                              Organize pages and Done
//   crates/engine/src/camera.rs, camera_clean.rs   the pixel work (core/folio/lib/camera.mjs)
// The tool's state is view state: `view.camera` {page, corners (view points), look, level} and, once enhanced, `view.cameraDone`. Enhance page
// reads the page as a picture, which needs the page view: it is src/apps/folio/ui-commands/camera.ts. A look or level chosen after the page is
// enhanced enhances it again from the original (the steps are undone first, the window does that: AcrobatChrome `cameraRestyle`).
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/camera.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {assembly} from '../lib/edit-needs.mjs';
import {viewSize} from '../lib/geom.mjs';
import {LOOKS, LOOK_LABELS, MAX_LEVEL, DEFAULT_LEVEL, insetCorners} from '../lib/camera.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/tools/camera_ui.rs',
  'crates/engine/src/camera.rs', 'crates/engine/src/camera_clean.rs', 'crates/geom/src/perspective.rs']};

export const TOOL = 'ocr.enhance_camera';
const pages = ctx => ctx.doc?.pages ?? [];
const active = ctx => ctx.view?.tool === TOOL;
const current = ctx => {
  const list = pages(ctx);
  const id = ctx.view?.pageId ?? ctx.doc?.activePageId;
  const i = Math.max(0, list.findIndex(p => p.id === id));
  return {i, page: list[i]};
};
const needsTool = ctx => (active(ctx) ? {enabled: true} : {enabled: false, reason: 'pick Enhance camera image first'});
const both = (a, b) => ctx => { const x = a(ctx); return x.enabled ? b(ctx) : x; };

/** A corner as view points clamped to the page (camera_ui.rs page_input). */
const clampTo = (page, c) => {
  const {width, height} = viewSize(page);
  return [Math.min(Math.max(c[0], 0), width), Math.min(Math.max(c[1], 0), height)];
};
const empty = () => ({camera: null, cameraDone: null});

export default defineCommands({
  family: 'camera',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: TOOL, label: 'Enhance camera image', risk: 'read', effect: 'view', undo: 'none',
      description: 'Enhance camera image: pick the tool with four corners on the page shown (inset 5 % from its edges), to be dragged onto the edges of the photographed document; again, or Cancel, puts it away. Finding the document\'s edges by itself is not translated.',
      params: s.object({}),
      state: ctx => { const st = assembly(ctx); return st.enabled ? {...st, checked: active(ctx)} : st; },
      run(ctx) {
        if (active(ctx)) { ctx.setView({tool: null, ...empty()}); return {tool: null}; }
        const {page} = current(ctx);
        const {width, height} = viewSize(page);
        // The whole page shows, so all four corners can be reached.
        ctx.setView({tool: TOOL, ...empty(), fit: 'page', camera: {page: page.id, corners: insetCorners(width, height), look: 'colour', level: DEFAULT_LEVEL}, highlighter: false});
        return {tool: TOOL, page: page.id, corners: insetCorners(width, height), message: "Drag the corners onto the document's edges, then choose Enhance page."};
      },
    },
    {
      id: 'camera.corners', label: 'Camera corners', risk: 'read', effect: 'view', undo: 'none',
      description: 'Place the four corners on a page, as [x, y] in page view points (top-left origin), in any order: they are kept inside the page. A press on a page without the corners moves them there (inset); without `corners` they go back to the inset place.',
      params: s.object({page: s.optional(s.union([s.string({min: 1, max: 120}), s.integer({min: 1, max: 100000})])),
        corners: s.optional(s.array(s.array(s.number({min: -1e6, max: 1e6}), {min: 2, max: 2}), {min: 4, max: 4}))}),
      state: both(assembly, needsTool),
      run(ctx, p) {
        if (ctx.view?.cameraDone) throw new CommandError('disabled', 'the page is enhanced: Done, or choose a look');
        const list = pages(ctx);
        const i = p.page === undefined ? current(ctx).i : typeof p.page === 'number' ? p.page - 1 : list.findIndex(x => x.id === p.page);
        const page = list[i];
        if (!page) throw new CommandError('not_found', `page ${p.page} does not exist`, {path: '/page'});
        const {width, height} = viewSize(page);
        const corners = p.corners ? p.corners.map(c => clampTo(page, c)) : insetCorners(width, height);
        const prev = ctx.view?.camera ?? {};
        ctx.setView({camera: {look: prev.look ?? 'colour', level: prev.level ?? DEFAULT_LEVEL, ...prev, page: page.id, corners}});
        return {page: page.id, corners};
      },
    },
    {
      id: 'camera.mode', label: 'Color mode', risk: 'read', effect: 'view', undo: 'none',
      description: 'The look of the straightened page: original (as photographed), colour, greyscale or black and white. After Enhance page it enhances the page again in that look.',
      params: s.object({look: s.enum(LOOKS)}),
      state: ctx => { const st = both(assembly, needsTool)(ctx); return st.enabled ? {...st, value: LOOK_LABELS[ctx.view?.camera?.look ?? 'colour']} : st; },
      run(ctx, p) { return setLook(ctx, {look: p.look}); },
    },
    {
      id: 'camera.cleanup', label: 'Clean-up', risk: 'read', effect: 'view', undo: 'none',
      description: 'How much the straightened page is cleaned up, 0 (as photographed) to 100 (white paper, strong contrast, no specks); for black and white it is the threshold. After Enhance page it enhances the page again at that level.',
      params: s.object({level: s.integer({min: 0, max: MAX_LEVEL})}),
      state: ctx => {
        const st = both(assembly, needsTool)(ctx);
        if (!st.enabled) return st;
        const look = ctx.view?.camera?.look ?? 'colour';
        return look === 'original' ? {enabled: false, reason: 'the original look is not cleaned up', value: ctx.view?.camera?.level ?? DEFAULT_LEVEL} : {...st, value: ctx.view?.camera?.level ?? DEFAULT_LEVEL};
      },
      run(ctx, p) { return setLook(ctx, {level: p.level}); },
    },
    ...[['camera.rotate_cw', 'Rotate clockwise', true, 'page.rotate'], ['camera.rotate_ccw', 'Rotate counterclockwise', false, 'page.rotate_ccw']].map(([id, label, cw, rotate]) => ({
      id, label, risk: 'edit', undo: 'auto',
      description: `${label}: after Enhance page, put the page the right way up (one undo step; the look chosen later keeps the turn).`,
      params: s.object({}),
      state: ctx => (ctx.view?.cameraDone ? assembly(ctx) : {enabled: false, reason: 'enhance the page first'}),
      run(ctx) {
        const done = ctx.view.cameraDone;
        const i = pages(ctx).findIndex(x => x.id === done.page);
        if (i < 0) throw new CommandError('not_found', 'the page is gone');
        ctx.run(rotate, {pages: [i]});
        ctx.setView({cameraDone: {...done, turns: done.turns + (cw ? 90 : -90), steps: done.steps + 1}});
        ctx.setUndoLabel('Rotate page');
        return {turns: done.turns + (cw ? 90 : -90)};
      },
    })),
    {
      id: 'camera.read', label: 'Camera tool state', risk: 'read', effect: 'view', undo: 'none',
      description: 'The state of the tool: its corners (view points), the look and level chosen, and, once the page is enhanced, what it was enhanced with and the turns made since.',
      params: s.object({}),
      state: () => ({enabled: true}),
      run(ctx) { return {tool: active(ctx), camera: ctx.view?.camera ?? null, done: ctx.view?.cameraDone ?? null}; },
    },
    {
      id: 'camera.done', label: 'Done', risk: 'read', effect: 'view', undo: 'none',
      description: 'Leave the tool with the page as it is.',
      params: s.object({}),
      state: needsTool,
      run(ctx) { ctx.setView({tool: null, ...empty()}); return {tool: null}; },
    },
    {
      id: 'camera.cancel', label: 'Cancel', risk: 'read', effect: 'view', undo: 'none',
      description: 'Put the tool away (a page already enhanced stays: undo takes it back).',
      params: s.object({}),
      state: needsTool,
      run(ctx) { ctx.setView({tool: null, ...empty()}); return {tool: null}; },
    },
  ],
});

/** Color mode / Clean-up: what the next Enhance page uses; for an enhanced page, ask for it again (`restyle`). */
function setLook(ctx, change) {
  const cam = ctx.view?.camera ?? {};
  const done = ctx.view?.cameraDone ?? null;
  const next = {look: cam.look ?? 'colour', level: cam.level ?? DEFAULT_LEVEL, ...cam, ...change};
  if (done && (done.applied[0] !== next.look || done.applied[1] !== next.level) && !(next.look === 'original' && done.applied[0] === 'original')) {
    ctx.setView({camera: next, cameraDone: {...done, look: next.look, level: next.level, restyle: (done.restyle ?? 0) + 1}});
  } else ctx.setView({camera: next, ...(done ? {cameraDone: {...done, look: next.look, level: next.level}} : {})});
  return {look: next.look, level: next.level, restyle: !!done && (done.applied[0] !== next.look || done.applied[1] !== next.level)};
}
