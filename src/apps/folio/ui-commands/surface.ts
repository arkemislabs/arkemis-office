// The page view's own tools (F:folio foundation; docs/architecture.md 4.4 and 16.4).
//
// Translated from printcraft crates/ui-egui/src/lib.rs `QuickTool` (Select, Hand) and
// crates/ui-egui/src/tools/comments/input.rs `keys` (Escape steps back: cancel the gesture, then
// deselect, then drop the comment tool for Select) at 3109bb2359759e24ef490e1cdbdba00722b20972
// (MIT, see assets/third-party-licenses/artcraft-reference.txt). The quick bar's Select and Hand
// buttons (docs/spec/pdf.json quick.bar.select, quick.bar.hand) have no catalog command upstream:
// they set the quick tool directly, as these do. The tool is view state (`view.tool`), never a
// document edit: it is what comment.highlight and comment.ink set when picked with nothing to mark.
// surface.view and surface.scroll let the bridge read and move the page view (as slate's surface.*
// commands do): automation and the 1,000-page benchmark in tests/e2e/folio/surface-benchmark.e2e.mjs.

import {defineCommands} from '../../../../core/kernel/command.mjs';
import {s} from '../../../../core/kernel/schema.mjs';
import {CommandError} from '../../../../core/kernel/errors.mjs';
import {viewOf} from '../surface/metrics';
import {rasterStats} from '../surface/pdf';
import {pageLabel} from '../../../../core/folio/model/index.mjs';
import {zoomStep, stepTarget, displayOf} from '../../../../core/folio/lib/pageview.mjs';

const UPSTREAM = {repo: 'printcraft' as const, commit: '3109bb2359759e24ef490e1cdbdba00722b20972',
  files: ['crates/ui-egui/src/lib.rs', 'crates/ui-egui/src/tools/comments/input.rs']};

const liveView = (ctx: any) => {
  const v = viewOf(ctx.docId);
  if (!v) throw new CommandError('unavailable', 'The page view is not shown');
  return v;
};
const pdfOpen = (ctx: any) =>(Array.isArray(ctx.doc?.pages) && ctx.doc.pages.length ? {enabled: true} : {enabled: false, reason: 'no PDF open'});

export default defineCommands({
  family: 'surface',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'tool.select', label: 'Select', risk: 'read', effect: 'view', needs: 'view',
      description: 'The Select tool: select text and comments, move and resize comments (QuickTool::Select).',
      params: s.object({}),
      state: (ctx: any) => ({...pdfOpen(ctx), checked: !ctx.view?.tool || ctx.view.tool === 'tool.select'}),
      run(ctx: any) { ctx.setView({tool: null, highlighter: false}); return {tool: 'tool.select'}; },
    },
    {
      id: 'tool.hand', label: 'Hand', risk: 'read', effect: 'view', needs: 'view',
      description: 'The Hand tool: drag to scroll the pages (QuickTool::Hand).',
      params: s.object({}),
      state: (ctx: any) => ({...pdfOpen(ctx), checked: ctx.view?.tool === 'tool.hand'}),
      run(ctx: any) { ctx.setView({tool: 'tool.hand', highlighter: false}); return {tool: 'tool.hand'}; },
    },
    {
      id: 'surface.view', label: 'Page view', risk: 'read', effect: 'view', needs: 'view',
      description: 'The page view as shown: current page, the pages mounted (virtualized), zoom, scroll position and paint timings.',
      params: s.object({}),
      run(ctx: any) {
        const v = viewOf(ctx.docId);
        if (!v) throw new CommandError('unavailable', 'The page view is not shown');
        const {goToPage, scrollTo, pointer, ...state} = v;
        void goToPage; void scrollTo; void pointer;
        return {...state, rasters: {...rasterStats}};
      },
    },
    {
      id: 'surface.scroll', label: 'Scroll', risk: 'read', effect: 'view', needs: 'view',
      description: 'Scroll the page view to a page (1-based, its top at the top of the view) or to a scroll offset in pixels.',
      params: s.object({page: s.optional(s.integer({min: 1, max: 100000})), top: s.optional(s.number({min: 0, max: 1e9}))}),
      run(ctx: any, p: any) {
        const v = viewOf(ctx.docId);
        if (!v) throw new CommandError('unavailable', 'The page view is not shown');
        if (p.page !== undefined) v.goToPage(p.page - 1);
        else if (p.top !== undefined) v.scrollTo(p.top);
        else throw new CommandError('invalid_params', 'give page or top', {path: '/page'});
        return {page: p.page ?? null, top: p.top ?? null};
      },
    },
    {
      id: 'surface.pointer', label: 'Pointer', risk: 'edit', needs: 'view',
      description: 'Run a pointer gesture through the page view (click, double, triple, drag, move) at page view points on a page: select text, select, move or resize comments, draw with the current tool. Edits it makes are separate undo steps.',
      params: s.object({
        page: s.union([s.string({min: 1, max: 120}), s.integer({min: 1, max: 100000})]),
        action: s.enum(['click', 'double', 'triple', 'drag', 'move']),
        x: s.number({min: -10000, max: 100000}), y: s.number({min: -10000, max: 100000}),
        to: s.optional(s.object({x: s.number({min: -10000, max: 100000}), y: s.number({min: -10000, max: 100000})})),
        path: s.optional(s.array(s.array(s.number(), {min: 2, max: 2}), {min: 2, max: 5000})),
        alt: s.optional(s.boolean()), shift: s.optional(s.boolean()), ctrl: s.optional(s.boolean()),
      }),
      async run(ctx: any, p: any) {
        const v = viewOf(ctx.docId);
        if (!v) throw new CommandError('unavailable', 'The page view is not shown');
        return v.pointer(p);
      },
    },
    {
      // The right rail's Page thumbnails and Bookmarks (docs/spec/pdf.json rail.panels.pages/bookmarks;
      // printcraft chrome.rs right_rail → choose_right_panel): one right panel at a time, a second
      // click on the shown one closes it (RailRequest::Close). The page view docks it (SidePanel).
      id: 'view.panel', label: 'Navigation panel', risk: 'read', effect: 'view', needs: 'view', undo: 'none',
      description: 'Show or hide the Page thumbnails or Bookmarks panel beside the pages (the right rail\'s toggles); default: toggle.',
      params: s.object({panel: s.enum(['pages', 'bookmarks']), open: s.optional(s.boolean())}),
      state: (ctx: any, p: any) => ({...pdfOpen(ctx), checked: !!p?.panel && ctx.view?.panel === p.panel && !ctx.view?.rightPanel}),
      run(ctx: any, p: any) {
        const shown = ctx.view?.panel === p.panel && !ctx.view?.rightPanel;
        const open = p.open ?? !shown;
        ctx.setView({panel: open ? p.panel : null, ...(open ? {rightPanel: null} : {})});
        return {panel: open ? p.panel : null};
      },
    },
    // Page navigation at the foot of the right rail (printcraft chrome.rs right_rail: Previous page /
    // Next page step the view one page, `view.step_page`; the page box takes a page label first,
    // then a number, `go_to_typed`, as Acrobat's logical page numbers do).
    // A command of its own (not view.page.next/previous): the spec binds those to Left, Right, Space
    // and Backspace, keys the page view keeps for moving and deleting the selected comment.
    {
      id: 'view.step_page', label: 'Next page / Previous page', risk: 'read', effect: 'view', needs: 'view', undo: 'none',
      description: 'Show the next page (forward: true) or the previous one; the page view scrolls its top to the top of the view.',
      params: s.object({forward: s.boolean()}),
      state: pdfOpen,
      run(ctx: any, p: any) {
        const v = liveView(ctx);
        const d = displayOf(ctx.view);
        // Two-page view turns a whole spread (navigation.rs step_page); past either end the view stays.
        const to = stepTarget(v.current, !!p.forward, v.pages, d);
        if (to === null) return {page: v.current + 1};
        v.goToPage(to);
        return {page: to + 1};
      },
    },
    // View > Zoom steps (zoom.rs zoom_step: the ladder 10, 25, 33, 50, 66, 75, 100, 125, 150, 200 ... 3200 %).
    ...[true, false].map(up => ({
      id: up ? 'view.zoom.in' : 'view.zoom.out', label: up ? 'Zoom in' : 'Zoom out', risk: 'read', effect: 'view', needs: 'view', undo: 'none',
      description: `${up ? 'Zoom in' : 'Zoom out'} to the next step of the zoom ladder (10 to 3200 %); the view keeps the page it shows.`,
      params: s.object({}),
      state: pdfOpen,
      run(ctx: any) { const v = liveView(ctx); const z = zoomStep(v.zoom, up); if (z === null) return {zoom: Math.round(v.zoom)}; ctx.setView({zoom: z, fit: null}); return {zoom: z}; },
    })),
    // The view history (navigation.rs go_to_page: back and forward lists of the pages left behind).
    {
      id: 'view.jump', label: 'Remember the page left', risk: 'read', effect: 'view', needs: 'view', undo: 'none',
      description: 'Record that the view left page `from` (1-based) for another: Previous view and Next view walk these.',
      params: s.object({from: s.integer({min: 1, max: 100000})}),
      state: pdfOpen,
      run(ctx: any, p: any) {
        const h = ctx.view?.history ?? {back: [], forward: []};
        const back = h.back.at(-1) === p.from - 1 ? h.back : [...h.back, p.from - 1].slice(-200);
        ctx.setView({history: {back, forward: []}});
        return {back: back.length};
      },
    },
    ...[false, true].map(forward => ({
      id: forward ? 'view.next_view' : 'view.previous_view', label: forward ? 'Next view' : 'Previous view', risk: 'read', effect: 'view', needs: 'view', undo: 'none',
      description: forward ? 'Go forward to the page you came back from.' : 'Go back to the page you were on before the last jump.',
      params: s.object({}),
      state(ctx: any) {
        if (!pdfOpen(ctx).enabled) return pdfOpen(ctx);
        const h = ctx.view?.history ?? {back: [], forward: []};
        return (forward ? h.forward : h.back).length ? {enabled: true} : {enabled: false, reason: forward ? 'there is no later view' : 'there is no earlier view'};
      },
      run(ctx: any) {
        const v = liveView(ctx);
        const h = ctx.view?.history ?? {back: [], forward: []};
        const from = forward ? h.forward : h.back;
        const page = from.at(-1);
        if (page === undefined) return {moved: false};
        const rest = from.slice(0, -1);
        const to = Math.min(page, v.pages - 1);
        ctx.setView({history: forward ? {back: [...h.back, v.current], forward: rest} : {back: rest, forward: [...h.forward, v.current]}});
        v.goToPage(to, false);
        return {page: to + 1};
      },
    })),
    // Marquee zoom (QuickTool::MarqueeZoom): a drag on a page zooms to that rectangle.
    {
      id: 'view.marquee_zoom', label: 'Marquee zoom', risk: 'read', effect: 'view', needs: 'view', undo: 'none',
      description: 'Marquee zoom: pick the tool, then drag a rectangle on a page and the view zooms to it. With `page` (id) and `rect` [x, y, width, height] in page view points it zooms there at once.',
      params: s.object({page: s.optional(s.string({min: 1, max: 120})), rect: s.optional(s.array(s.number(), {min: 4, max: 4}))}),
      state(ctx: any) { const st = pdfOpen(ctx); return st.enabled ? {...st, checked: ctx.view?.tool === 'view.marquee_zoom'} : st; },
      run(ctx: any, p: any) {
        if (!p.rect) { ctx.setView({tool: ctx.view?.tool === 'view.marquee_zoom' ? null : 'view.marquee_zoom'}); return {tool: ctx.view?.tool === 'view.marquee_zoom' ? null : 'view.marquee_zoom'}; }
        const v = liveView(ctx);
        const pages: any[] = ctx.doc.pages;
        const i = p.page ? pages.findIndex(x => x.id === p.page) : v.current;
        if (i < 0) throw new CommandError('not_found', `page ${p.page} does not exist`, {path: '/page'});
        if (!(p.rect[2] >= 1 && p.rect[3] >= 1)) throw new CommandError('invalid_params', 'the rectangle is too small', {path: '/rect'});
        const z = v.zoomToRect(i, p.rect);
        ctx.setView({tool: null, zoom: z, fit: null});
        return {page: i + 1, zoom: Math.round(z)};
      },
    },
    {
      id: 'view.focus_page_input', label: 'Go to page…', risk: 'read', effect: 'view', needs: 'view', undo: 'none',
      description: 'Go to a page by its label (such as iv) or its number; with no value, put the cursor in the rail\'s page box.',
      params: s.object({value: s.optional(s.union([s.string({min: 1, max: 40}), s.integer({min: 1, max: 100000})]))}),
      state: pdfOpen,
      run(ctx: any, p: any) {
        const v = liveView(ctx);
        if (p.value === undefined) {
          const box = typeof document === 'undefined' ? null : document.querySelector<HTMLInputElement>('[data-control-id="rail.nav.page-input"] input');
          box?.focus(); box?.select();
          return {focused: !!box};
        }
        const typed = String(p.value).trim();
        const content = ctx.doc;
        const labels = Array.from({length: v.pages}, (_, i) => pageLabel(content, i));
        let index = labels.findIndex(l => l === typed);
        if (index < 0 && /^\d+$/.test(typed)) index = Number(typed) - 1;
        if (index < 0 || index >= v.pages) throw new CommandError('invalid_params', `There is no page ${typed} (1–${v.pages})`, {path: '/value'});
        v.goToPage(index);
        return {page: index + 1, label: labels[index]};
      },
    },
  ],
} as any);
