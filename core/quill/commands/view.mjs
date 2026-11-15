// View tab (U:quill/view): Views (Read Mode, Print Layout, Web Layout, Outline, Draft), Immersive
// (Focus, Immersive Reader and its reading controls), Page Movement (Vertical, Side to Side), Show
// (Ruler, Gridlines, Navigation Pane), Zoom (One Page, Multiple Pages, Page Width; Zoom, 100%,
// Zoom In/Out are the common view family's) and Window (New Window, Arrange All, Split, View Side by
// Side, Synchronous Scrolling, Reset Window Position, Switch Windows).
//
// Translated from wordcraft crates/engine/src/cmd/view.rs (`mode`, `read_column_width`,
// `read_text_size`, `read_line_spacing`, `read_page_color`, view.focus, view.ruler,
// view.gridlines, view.darkMode, view.fullScreen, view.navigationPane, view.onePage/multiplePages/pageWidth, view.newWindow,
// view.split, `switch_windows`), crates/engine/src/cmd/tools/specs.rs (view.immersive,
// view.vertical, view.sideToSide) and crates/engine/src/view.rs (`ViewState`) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Everything here is the document view (ctx.setView): never an edit, never on the undo list, as
// upstream's `.pure()` commands. The window commands reach the main process through the renderer
// host's window service (ctx.host.windows, electron/preload.cjs); headless they are unavailable.
// Word's Immersive Reader is its own view here (upstream toggles Read Mode for it): one reflowed
// column on the reading paper, with the reading controls upstream has (column width, page color,
// line spacing as Text Spacing). Line Focus, Syllables and Read Aloud have no upstream engine.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {ready, UPSTREAM_COMMIT} from '../lib/format-target.mjs';
import {MODES, COLUMN_WIDTHS, READ_PAGE_COLORS, READ_LINE_SPACINGS, TEXT_SPACING, viewOf, layoutView} from '../lib/view-layout.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/view.rs', 'crates/engine/src/cmd/tools/specs.rs', 'crates/engine/src/view.rs']};
const NONE = s.object({});
const VALUE = s.object({value: s.optional(s.boolean())});
const bad = (msg, path = '/value') => new CommandError('invalid_params', msg, {path});

export {MODES, COLUMN_WIDTHS, READ_PAGE_COLORS, READ_LINE_SPACINGS, TEXT_SPACING, viewOf, layoutView};

/** Switch views (mode): reading controls reset on each entry to Read Mode. */
function mode(ctx, m, read) {
  const v = viewOf(ctx.view);
  const patch = {mode: m, readMode: read, immersive: false};
  if (read && !v.readMode) Object.assign(patch, {readColumnWidth: null, readZoom: 1, readLineSpacing: null, readPageColor: 'none'});
  // Page Movement is Print Layout's; leaving it for another view goes back to Vertical.
  if (m !== 'print' || read) Object.assign(patch, v.pageMovement === 'sideToSide' ? {pageMovement: 'vertical', multiPage: false, fit: null} : {});
  ctx.setView(patch);
  return {mode: m, readMode: read};
}

const modeState = (m, read) => ctx => {
  const r = ready(ctx);
  if (!r.enabled) return r;
  const v = viewOf(ctx.view);
  return {enabled: true, checked: read ? v.readMode : !v.readMode && !v.immersive && v.mode === m};
};

const toggleState = key => ctx => {
  const r = ready(ctx);
  return r.enabled ? {enabled: true, checked: !!viewOf(ctx.view)[key]} : r;
};
function toggle(ctx, key, value) {
  const on = value ?? !viewOf(ctx.view)[key];
  ctx.setView({[key]: on});
  return {value: on};
}

/** Page Movement and the fit zooms are Print Layout's (Word greys them out in the other views). */
function printOnly(ctx) {
  const r = ready(ctx);
  if (!r.enabled) return r;
  const v = viewOf(ctx.view);
  if (v.readMode || v.immersive) return {enabled: false, reason: 'not in Read Mode'};
  if (v.mode !== 'print') return {enabled: false, reason: 'only in Print Layout'};
  return {enabled: true};
}

/** Upstream's zoom for a fit mode (zoom): One Page and Page Width show one page per row, Multiple Pages two or more. */
function fitZoom(ctx, fit) {
  ctx.setView({fit, multiPage: fit === 'multiplePages', singleColumn: fit === 'onePage' || fit === 'pageWidth', pageMovement: 'vertical'});
  return {zoom: ctx.view?.zoom ?? 100, fit};
}

// ---- the window service (renderer only) ----------------------------------------------------------

function windows(ctx) {
  const w = ctx.host?.windows;
  if (!w || typeof w.open !== 'function') throw new CommandError('unavailable', 'Windows are only available in the Quill window');
  return w;
}
function windowsState(ctx, need = null) {
  const r = ready(ctx);
  if (!r.enabled) return r;
  const w = ctx.host?.windows;
  if (!w || typeof w.open !== 'function') return {enabled: false, reason: 'only in the Quill window'};
  const st = typeof w.state === 'function' ? w.state() : {};
  if (need === 'others' && !(st.windows ?? []).some(x => !x.self)) return {enabled: false, reason: 'only one window is open'};
  if (need === 'sideBySide' && !st.sideBySide) return {enabled: false, reason: 'only while viewing side by side'};
  return {enabled: true, st};
}

export default defineCommands({
  family: 'view',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    // ---- Views ----
    {id: 'view.printLayout', label: 'Print Layout', shortcut: 'Mod+Alt+P', risk: 'read', effect: 'view',
      description: 'Print Layout: the pages as they print.', params: NONE, state: modeState('print', false), run: ctx => mode(ctx, 'print', false)},
    {id: 'view.webLayout', label: 'Web Layout', risk: 'read', effect: 'view',
      description: 'Web Layout: the document as a web page; the text wraps to the window, no page edges.', params: NONE, state: modeState('web', false), run: ctx => mode(ctx, 'web', false)},
    {id: 'view.draft', label: 'Draft', shortcut: 'Mod+Alt+N', risk: 'read', effect: 'view',
      description: 'Draft: the text alone, no page edges, headers, footers or floating pictures; page breaks as dotted lines.', params: NONE, state: modeState('draft', false), run: ctx => mode(ctx, 'draft', false)},
    {id: 'view.outline', label: 'Outline', shortcut: 'Mod+Alt+O', risk: 'read', effect: 'view',
      description: 'Outline: the body as an outline of its headings, with the Outlining tab.', params: NONE, state: modeState('outline', false), run: ctx => mode(ctx, 'outline', false)},
    {id: 'view.readMode', label: 'Read Mode', risk: 'read', effect: 'view',
      description: 'Read Mode: the text in reading columns across the screen; arrows turn the page, Esc returns.', params: NONE, state: modeState('print', true),
      run: ctx => mode(ctx, viewOf(ctx.view).mode, true)},
    {id: 'view.readColumnWidth', label: 'Column Width', risk: 'read', effect: 'view',
      description: 'Reading column width (Read Mode and Immersive Reader): auto, narrow, medium, wide or page.',
      params: s.object({value: s.enum(Object.keys(COLUMN_WIDTHS))}),
      state(ctx, p) {
        const r = ready(ctx);
        if (!r.enabled) return r;
        const w = viewOf(ctx.view).readColumnWidth;
        return {enabled: true, checked: p?.value ? COLUMN_WIDTHS[p.value] === w : undefined, value: w};
      },
      run(ctx, p) { const width = COLUMN_WIDTHS[p.value]; ctx.setView({readColumnWidth: width}); return {width}; }},
    {id: 'view.readTextSize', label: 'Text Size', risk: 'read', effect: 'view',
      description: 'Reading text size in percent (75–150), Read Mode only; never the normal zoom.',
      params: s.object({value: s.number({min: 75, max: 150})}),
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, value: Math.round(viewOf(ctx.view).readZoom * 100)} : r; },
      run(ctx, p) { ctx.setView({readZoom: p.value / 100}); return {percent: p.value}; }},
    {id: 'view.readLineSpacing', label: 'Line Spacing', risk: 'read', effect: 'view',
      description: 'Reading line spacing: document (the document\'s own), 1, 1.25, 1.5 or 2.',
      params: s.object({value: s.union([s.enum(['document']), s.number({min: 1, max: 2})])}),
      state(ctx, p) {
        const r = ready(ctx);
        if (!r.enabled) return r;
        const v = viewOf(ctx.view).readLineSpacing;
        return {enabled: true, checked: p?.value === undefined ? undefined : p.value === 'document' ? v === null : v === p.value, value: v ?? 'document'};
      },
      run(ctx, p) {
        if (p.value !== 'document' && !READ_LINE_SPACINGS.includes(p.value)) throw bad('reading line spacing must be document, 1, 1.25, 1.5, or 2');
        const spacing = p.value === 'document' ? null : p.value;
        ctx.setView({readLineSpacing: spacing});
        return {spacing};
      }},
    {id: 'view.readPageColor', label: 'Page Color', risk: 'read', effect: 'view',
      description: 'Reading page color (screen only): none (white), sepia or inverse (light text on dark).',
      params: s.object({value: s.enum(READ_PAGE_COLORS)}),
      state(ctx, p) {
        const r = ready(ctx);
        if (!r.enabled) return r;
        const c = viewOf(ctx.view).readPageColor;
        return {enabled: true, checked: p?.value ? p.value === c : undefined, value: c};
      },
      run(ctx, p) { ctx.setView({readPageColor: p.value}); return {pageColor: p.value}; }},
    // ---- Immersive ----
    {id: 'view.focus', label: 'Focus', risk: 'read', effect: 'view',
      description: 'Focus: the document alone on the screen, the ribbon and status bar hidden; Esc leaves it.', params: VALUE, state: toggleState('focusMode'),
      run: (ctx, p) => toggle(ctx, 'focusMode', p.value)},
    {id: 'view.immersive', label: 'Immersive Reader', risk: 'read', effect: 'view',
      description: 'Immersive Reader: the text in one reading column with the Immersive Reader tab (column width, page color, text spacing); `value` sets it.',
      params: VALUE, state: toggleState('immersive'),
      run(ctx, p) {
        const on = p.value ?? !viewOf(ctx.view).immersive;
        ctx.setView(on ? {immersive: true, readMode: false, focusMode: false} : {immersive: false});
        return {value: on};
      }},
    {id: 'view.textSpacing', label: 'Text Spacing', risk: 'read', effect: 'view',
      description: 'Immersive Reader › Text Spacing: the reading lines wider apart (1.5×), or back to the document\'s spacing.',
      params: VALUE,
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: viewOf(ctx.view).readLineSpacing === TEXT_SPACING} : r; },
      run(ctx, p) {
        const on = p.value ?? viewOf(ctx.view).readLineSpacing !== TEXT_SPACING;
        ctx.setView({readLineSpacing: on ? TEXT_SPACING : null});
        return {value: on};
      }},
    // ---- Page Movement ----
    {id: 'view.vertical', label: 'Vertical', risk: 'read', effect: 'view',
      description: 'Page Movement › Vertical: the pages scroll up and down.', params: NONE,
      state: ctx => { const r = printOnly(ctx); return r.enabled ? {enabled: true, checked: viewOf(ctx.view).pageMovement === 'vertical'} : r; },
      run(ctx) { ctx.setView({multiPage: false, fit: null, pageMovement: 'vertical'}); return {pageMovement: 'vertical'}; }},
    {id: 'view.sideToSide', label: 'Side to Side', risk: 'read', effect: 'view',
      description: 'Page Movement › Side to Side: the pages side by side in one row, turned like a book.', params: NONE,
      state: ctx => { const r = printOnly(ctx); return r.enabled ? {enabled: true, checked: viewOf(ctx.view).pageMovement === 'sideToSide'} : r; },
      run(ctx) { ctx.setView({multiPage: true, singleColumn: false, fit: 'multiplePages', pageMovement: 'sideToSide'}); return {pageMovement: 'sideToSide'}; }},
    // ---- Show ----
    {id: 'view.ruler', label: 'Ruler', risk: 'read', effect: 'view',
      description: 'Show › Ruler: the horizontal and vertical rulers (Print Layout; the horizontal one in Web Layout and Draft).', params: VALUE,
      state(ctx) {
        const r = ready(ctx);
        if (!r.enabled) return r;
        const v = viewOf(ctx.view);
        if (v.readMode || v.immersive || v.mode === 'outline') return {enabled: false, checked: v.ruler, reason: 'no ruler in this view'};
        return {enabled: true, checked: v.ruler};
      },
      run: (ctx, p) => toggle(ctx, 'ruler', p.value)},
    {id: 'view.gridlines', label: 'Gridlines', risk: 'read', effect: 'view',
      description: 'Show › Gridlines: the drawing grid over the page\'s text area (on screen only).', params: VALUE,
      state(ctx) {
        const r = ready(ctx);
        if (!r.enabled) return r;
        const v = viewOf(ctx.view);
        if (v.readMode || v.immersive || v.mode !== 'print') return {enabled: false, checked: v.gridlines, reason: 'only in Print Layout'};
        return {enabled: true, checked: v.gridlines};
      },
      run: (ctx, p) => toggle(ctx, 'gridlines', p.value)},
    {id: 'view.darkMode', label: 'Switch Modes', risk: 'read', effect: 'view',
      description: 'Dark Mode › Switch Modes (wordcraft view.darkMode): the pages drawn dark with light text, on screen only (never printed or exported); `value` sets it, no value switches.',
      params: VALUE, state: toggleState('darkMode'),
      run: (ctx, p) => toggle(ctx, 'darkMode', p.value)},
    {id: 'view.fullScreen', label: 'Full Screen', risk: 'read', effect: 'view', shortcut: 'F11',
      description: 'Window › Full Screen (wordcraft view.fullScreen): the application window fills the screen (Esc leaves it); `value` sets it, no value switches. Never in test runs.',
      params: VALUE, state: toggleState('fullScreen'),
      run: (ctx, p) => toggle(ctx, 'fullScreen', p.value)},
    {id: 'view.navigationPane', label: 'Navigation Pane', risk: 'read', effect: 'view',
      description: 'Show › Navigation Pane: headings, pages and search results beside the document; `tab` opens it on Headings, Pages or Results (the pane keeps the tab, as nav.rs).',
      params: s.object({value: s.optional(s.boolean()), tab: s.optional(s.enum(['headings', 'pages', 'results']))}), state: toggleState('navPane'),
      run(ctx, p) {
        const on = p.value ?? (p.tab ? true : !viewOf(ctx.view).navPane);
        // Ctrl+F opened it through the edit family's view state: one pane, one switch.
        ctx.setView({navPane: on, ...(p.tab ? {navTab: p.tab} : {}), ...(ctx.view?.quill && typeof ctx.view.quill === 'object' ? {quill: {...ctx.view.quill, navPane: on}} : {})});
        return {value: on, tab: p.tab ?? ctx.view?.navTab ?? 'headings'};
      }},
    // ---- Zoom (fit modes) ----
    {id: 'view.onePage', label: 'One Page', risk: 'read', effect: 'view',
      description: 'Zoom so a whole page fits in the window.', params: NONE,
      state: ctx => { const r = printOnly(ctx); return r.enabled ? {enabled: true, checked: viewOf(ctx.view).fit === 'onePage'} : r; },
      run: ctx => fitZoom(ctx, 'onePage')},
    {id: 'view.multiplePages', label: 'Multiple Pages', risk: 'read', effect: 'view',
      description: 'Zoom so two or more pages fit side by side.', params: NONE,
      state: ctx => { const r = printOnly(ctx); const v = viewOf(ctx.view); return r.enabled ? {enabled: true, checked: v.multiPage && v.pageMovement !== 'sideToSide'} : r; },
      run: ctx => fitZoom(ctx, 'multiplePages')},
    {id: 'view.pageWidth', label: 'Page Width', risk: 'read', effect: 'view',
      description: 'Zoom so the page is as wide as the window.', params: NONE,
      state: ctx => { const r = printOnly(ctx); return r.enabled ? {enabled: true, checked: viewOf(ctx.view).fit === 'pageWidth'} : r; },
      run: ctx => fitZoom(ctx, 'pageWidth')},
    // ---- Window ----
    {id: 'view.split', label: 'Split', shortcut: 'Mod+Alt+S', risk: 'read', effect: 'view',
      description: 'Split: the window in two panes on the same document, each scrolled on its own; again (Remove Split) back to one. `at` is where the split bar sits (0.1–0.9 of the height).',
      params: s.object({value: s.optional(s.boolean()), at: s.optional(s.number({min: 0.1, max: 0.9}))}),
      state: toggleState('split'),
      run(ctx, p) {
        const v = viewOf(ctx.view);
        const on = p.value ?? (p.at !== undefined ? true : !v.split);
        ctx.setView(on ? {split: true, splitAt: p.at ?? ctx.view?.splitAt ?? 0.5} : {split: false});
        return {value: on, at: on ? (p.at ?? ctx.view?.splitAt ?? 0.5) : null};
      }},
    {id: 'view.newWindow', label: 'New Window', risk: 'read', effect: 'view',
      description: 'New Window: a second window on the same document; an edit in either shows in both (one undo history).', params: NONE,
      state: ctx => windowsState(ctx),
      async run(ctx) {
        const w = windows(ctx);
        // The new window reads the document's working copy: write the latest change there first.
        if (typeof ctx.host?.save === 'function') await ctx.host.save(ctx.file, {});
        return w.open({doc: ctx.docId});
      }},
    {id: 'view.arrangeAll', label: 'Arrange All', risk: 'read', effect: 'view',
      description: 'Arrange All: the open Quill windows stacked one above the other on the screen.', params: NONE,
      state: ctx => windowsState(ctx),
      async run(ctx) { return windows(ctx).arrange({mode: 'all'}); }},
    {id: 'view.sideBySide', label: 'View Side by Side', risk: 'read', effect: 'view',
      description: 'View Side by Side: this window and another (`with`, a window id from Switch Windows; default the last one used) side by side, scrolling together; again turns it off.',
      params: s.object({with: s.optional(s.integer({min: 0})), value: s.optional(s.boolean())}),
      state(ctx) {
        const r = windowsState(ctx, 'others');
        return r.enabled ? {enabled: true, checked: !!r.st?.sideBySide} : {...r, checked: false};
      },
      async run(ctx, p) {
        const w = windows(ctx);
        const on = p.value ?? !w.state?.()?.sideBySide;
        return w.arrange({mode: on ? 'sideBySide' : 'off', with: p.with});
      }},
    {id: 'view.syncScroll', label: 'Synchronous Scrolling', risk: 'read', effect: 'view',
      description: 'Synchronous Scrolling: while viewing side by side, both documents scroll together.', params: VALUE,
      state(ctx) {
        const r = windowsState(ctx, 'sideBySide');
        return r.enabled ? {enabled: true, checked: !!r.st?.syncScroll} : {...r, checked: false};
      },
      async run(ctx, p) {
        const w = windows(ctx);
        const on = p.value ?? !w.state?.()?.syncScroll;
        return w.arrange({mode: 'syncScroll', value: on});
      }},
    {id: 'view.resetWindowPosition', label: 'Reset Window Position', risk: 'read', effect: 'view',
      description: 'Reset Window Position: the two documents viewed side by side share the screen equally again.', params: NONE,
      state: ctx => windowsState(ctx, 'sideBySide'),
      async run(ctx) { return windows(ctx).arrange({mode: 'reset'}); }},
    {id: 'view.switchWindows', label: 'Switch Windows', risk: 'read', effect: 'view',
      description: 'Switch Windows: the open Quill windows ({value}: a window id brings that window to the front); without value, the list.',
      params: s.object({value: s.optional(s.integer({min: 0}))}),
      state(ctx) {
        const r = windowsState(ctx);
        if (!r.enabled) return r;
        // Word numbers them: "1 Report:1", "2 Report:2".
        const list = (r.st?.windows ?? []).map((x, i) => ({id: x.id, label: `${i + 1} ${x.title}`, value: x.id, checked: !!x.self}));
        return {enabled: true, value: list};
      },
      async run(ctx, p) {
        const w = windows(ctx);
        if (p.value === undefined) return {windows: (await w.list()) ?? []};
        return w.focus(p.value);
      }},
  ],
});
