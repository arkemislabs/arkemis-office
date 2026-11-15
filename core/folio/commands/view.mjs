// View: the page display (single page or two-page view, continuous scrolling, cover page, gaps between
// pages), fit and zoom commands, rotate view, Read mode and the side and tools panels.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; the same project as the pdfcraft of earlier
// units, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/commands.rs:255-345      what each view id does (run_view_command)
//   crates/ui-egui/src/canvas/zoom.rs           set_layout, set_continuous, set_page_gaps, set_cover, set_fit, rotate_view,
//                                               zoom_step (the step ladder), spread_first, fit_zoom
//   crates/ui-egui/src/canvas.rs                PageLayout (Single, TwoUp), Fit
//   crates/ui-egui/src/canvas/navigation.rs     step_page (a spread at a time in two-page view), go_to_page (the view history)
// All of it is view state (`view.*`), never a document edit. Zoom in and out, previous and next view, marquee
// zoom, fit visible, full screen and the page steps need the live page view and are in
// src/apps/folio/ui-commands/surface.ts. Hidden, with spec notes (docs/spec/patches/folio/view.json): the
// Office-only items (rulers, grids, guides, line weights, loupe, dynamic zoom, pan and zoom window, read aloud,
// first and last page, cursor coordinates, windows) and the light and dark theme, the tab switching and the
// tools palette, which this shell does not have.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/view.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/canvas.rs', 'crates/ui-egui/src/canvas/zoom.rs', 'crates/ui-egui/src/canvas/navigation.rs']};

const noPdf = {enabled: false, reason: 'no PDF open'};
const open = ctx => (Array.isArray(ctx.doc?.pages) && ctx.doc.pages.length ? {enabled: true} : noPdf);
const layoutOf = ctx => (ctx.view?.layout === 'two-up' ? 'two-up' : 'single');
const continuousOf = ctx => ctx.view?.continuous !== false;

/** A view command: `state` shows whether its mode is on. */
const mode = (id, label, description, run, checked, extra = {}) => ({
  id, label, risk: 'read', effect: 'view', undo: 'none', description, params: s.object({}),
  state: ctx => { const st = extra.state ? extra.state(ctx) : open(ctx); return st.enabled ? {...st, checked: checked(ctx)} : st; },
  run, ...extra.keep,
});

export default defineCommands({
  family: 'view', app: 'folio', upstream: UPSTREAM,
  commands: [
    mode('view.layout.single', 'Single page', 'Page display: single page (one page at a time or scrolling, as Continuous scrolling says).',
      ctx => { ctx.setView({layout: 'single'}); return {layout: 'single'}; }, ctx => layoutOf(ctx) === 'single'),
    mode('view.layout.two_up', 'Two-page view', 'Page display: two pages side by side (a spread); Show cover page puts the first page alone.',
      ctx => { ctx.setView({layout: 'two-up'}); return {layout: 'two-up'}; }, ctx => layoutOf(ctx) === 'two-up'),
    mode('view.continuous', 'Continuous scrolling', 'Turn continuous scrolling on or off: off shows one page (or spread) at a time and the scroll snaps to it.',
      ctx => { const on = !continuousOf(ctx); ctx.setView({continuous: on}); return {continuous: on}; }, continuousOf),
    mode('view.page_gaps', 'Show gaps between pages', 'Show or hide the gaps (and shadows) between pages.',
      ctx => { const on = ctx.view?.gaps === false; ctx.setView({gaps: on}); return {gaps: on}; }, ctx => ctx.view?.gaps !== false),
    mode('view.layout.cover', 'Show cover page in two-page view', 'Two-page view with the first page alone, as a cover.',
      ctx => { const on = !ctx.view?.cover; ctx.setView({cover: on}); return {cover: on}; }, ctx => !!ctx.view?.cover,
      {state: ctx => (open(ctx).enabled ? (layoutOf(ctx) === 'two-up' ? {enabled: true} : {enabled: false, reason: 'only two-page view has a cover page'}) : noPdf)}),
    mode('view.fit_width_scrolling', 'Fit to width scrolling', 'Single pages scrolling, fitted to the width of the window.',
      ctx => { ctx.setView({layout: 'single', continuous: true, fit: 'width'}); return {fit: 'width'}; }, ctx => layoutOf(ctx) === 'single' && continuousOf(ctx) && ctx.view?.fit === 'width'),
    mode('view.fit_one_page', 'Fit one full page', 'One whole page at a time, fitted to the window.',
      ctx => { ctx.setView({layout: 'single', continuous: false, fit: 'page'}); return {fit: 'page'}; }, ctx => layoutOf(ctx) === 'single' && !continuousOf(ctx) && ctx.view?.fit === 'page'),
    mode('view.zoom.actual_size', 'Actual size', 'Zoom to 100 %.',
      ctx => { ctx.setView({zoom: 100, fit: null}); return {zoom: 100}; }, ctx => ctx.view?.fit == null && (ctx.view?.zoom ?? 100) === 100),
    mode('view.zoom.page_level', 'Zoom to page level', 'Fit the whole page in the window.',
      ctx => { ctx.setView({fit: 'page'}); return {fit: 'page'}; }, ctx => ctx.view?.fit === 'page'),
    mode('view.zoom.fit_width', 'Fit to width', 'Fit the width of the page to the window.',
      ctx => { ctx.setView({fit: 'width'}); return {fit: 'width'}; }, ctx => ctx.view?.fit === 'width'),
    mode('view.zoom.fit_height', 'Fit to height', 'Fit the height of the page to the window.',
      ctx => { ctx.setView({fit: 'height'}); return {fit: 'height'}; }, ctx => ctx.view?.fit === 'height'),
    mode('view.fit_visible', 'Fit visible', 'Fit the visible content of the current page (its text) to the window, margins cut off.',
      ctx => { ctx.setView({fit: 'visible'}); return {fit: 'visible'}; }, ctx => ctx.view?.fit === 'visible'),
    mode('view.full_screen', 'Full screen mode', 'Full screen: one page at a time (one spread in two-page view), fitted to the screen, from the current page; Space or Enter turns forward, Backspace back, Escape leaves. The display it replaces comes back.',
      ctx => {
        const v = ctx.view ?? {};
        if (v.presentation) { ctx.setView({...v.presentation, presentation: null, presenting: false}); return {presenting: false}; }
        ctx.setView({presentation: {layout: v.layout ?? 'single', continuous: v.continuous !== false, cover: !!v.cover, fit: v.fit ?? null, zoom: v.zoom ?? 100}, presenting: true, continuous: false, fit: 'page', tool: null});
        return {presenting: true};
      }, ctx => !!ctx.view?.presenting),
    {
      id: 'view.rotate.cw', label: 'Rotate view clockwise', risk: 'read', effect: 'view', undo: 'none',
      description: 'Rotate the view 90 degrees clockwise: the pages are shown turned; the document is not changed (commenting waits until the view is turned back).',
      params: s.object({}), state: open,
      run(ctx) { const rotation = ((ctx.view?.rotation ?? 0) + 90) % 360; ctx.setView({rotation}); return {rotation}; },
    },
    {
      id: 'view.rotate.ccw', label: 'Rotate view counterclockwise', risk: 'read', effect: 'view', undo: 'none',
      description: 'Rotate the view 90 degrees counterclockwise; the document is not changed.',
      params: s.object({}), state: open,
      run(ctx) { const rotation = ((ctx.view?.rotation ?? 0) + 270) % 360; ctx.setView({rotation}); return {rotation}; },
    },
    mode('view.read_mode', 'Read mode', 'Read mode: the page fills the window with the tools, the quick bar and the panels out of the way; the command again leaves it.',
      ctx => { const on = !ctx.view?.readMode; ctx.setView({readMode: on}); return {readMode: on}; }, ctx => !!ctx.view?.readMode),
    {
      id: 'view.side_panel', label: 'Show or hide the side panel', risk: 'read', effect: 'view', undo: 'none',
      description: 'Show or hide the side panel: with one shown it is closed, else the page thumbnails open.',
      params: s.object({}), state: () => ({enabled: true}),
      run(ctx) {
        const shown = !!(ctx.view?.panel || ctx.view?.rightPanel);
        if (shown) ctx.setView({panel: null, rightPanel: null}); else ctx.setView({panel: 'pages', rightPanel: null});
        return {open: !shown};
      },
    },
    {
      id: 'view.tools_pane', label: 'Show or hide the Tools panel', risk: 'read', effect: 'view', undo: 'none',
      description: 'Show or hide the Tools panel on the left.',
      params: s.object({open: s.optional(s.boolean())}), state: () => ({enabled: true}),
      run(ctx, p) { const on = p.open ?? ctx.view?.toolsPane === false; /* open unless closed */ ctx.setView({toolsPane: on}); return {open: on}; },
    },
  ],
});
