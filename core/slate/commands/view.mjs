// View tab: Views, Immersive Reader, Show (navigation panes, tabs layout, Switch Background), Zoom to
// page width, and Window (U:slate/view). Page Setup (colour, rule lines, title, paper size) and the
// zoom percent commands are other families (pages.mjs, core/common/commands/view.mjs).
//
// Slate has no ArtCraft upstream: ids and args are docs/spec/slate.json `view.*` and `window.*`;
// behaviour is OneNote's View tab:
//   * Normal View shows the notebook with its section tabs and page list; Full Page View hides all
//     of them and leaves the page; Show > Navigation Panes turns the whole navigation, the notebook
//     name and the page list off and on; Tabs Layout puts the section tabs along the top or down the
//     left side; Switch Background turns the page dark (and its text light) and back;
//   * Immersive Reader shows the page's text alone, large and spaced, read aloud on request, with
//     text size, spacing, a theme and Line Focus; Page Width zooms so the page fills the window;
//   * New Window opens the notebook again in a window of its own (one undo history, edits mirrored),
//     New Docked Window and Dock to Desktop put a window narrow at the edge of the screen, Always on
//     Top keeps one above the others. Send to OneNote Tool is not offered (docs/spec/patches/slate/view.json).
// View state is the document's session state; tabs layout and the dark page are preferences. The
// window commands need the app's own window (they are disabled outside it).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook} from '../schema.mjs';
import {currentLocation, selectPage} from '../model/notebook.mjs';
import {backPages, takeBack} from '../lib/nav-history.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/view.*', 'docs/spec/slate.json#commands/window.*']};
export const PANES = Object.freeze(['navigation', 'notebooks', 'pages']);
export const TABS_LAYOUT_PREF = 'slate.tabsLayout';
export const DARK_PAGE_PREF = 'slate.darkPage';
export const READER_THEMES = Object.freeze(['white', 'sepia', 'dark']);
export const READER_SIZES = Object.freeze([1, 2, 3, 4]);
const VALUE = s.object({value: s.optional(s.boolean())});
const ready = ctx => (isNotebook(ctx.doc) ? {enabled: true} : {enabled: false, reason: 'No notebook is open'});
const view = ctx => ctx.view ?? {};
const hasPage = ctx => (ready(ctx).enabled && currentLocation(ctx.doc, ctx.selection).pageId ? {enabled: true} : {enabled: false, reason: ready(ctx).enabled ? 'No page is open' : 'No notebook is open'});

/** The panes as shown: all on unless turned off. */
export const panesOf = v => ({navigation: v?.panes?.navigation !== false, notebooks: v?.panes?.notebooks !== false, pages: v?.panes?.pages !== false});
export const readerOf = v => ({size: READER_SIZES.includes(v?.immersive?.size) ? v.immersive.size : 2, spacing: v?.immersive?.spacing === true, theme: READER_THEMES.includes(v?.immersive?.theme) ? v.immersive.theme : 'white',
  lineFocus: [0, 1, 3, 5].includes(v?.immersive?.lineFocus) ? v.immersive.lineFocus : 0});

function windows(ctx) {
  const w = ctx.host?.windows;
  if (!w || typeof w.open !== 'function') throw new CommandError('unavailable', 'Windows are only available in the application window');
  return w;
}
const windowState = ctx => {
  const r = ready(ctx);
  if (!r.enabled) return r;
  const w = ctx.host?.windows;
  if (!w || typeof w.open !== 'function') return {enabled: false, reason: 'only in the application window'};
  return {enabled: true, st: typeof w.state === 'function' ? w.state() : {}};
};

export default defineCommands({
  family: 'view',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    // --- Back (Quick Access Toolbar) ------------------------------------------------------------------
    {
      id: 'nav.back', label: 'Back', shortcut: 'Alt+Left', risk: 'read', effect: 'view',
      description: 'Back: return to the page that was open before this one (each press goes one page further back); the pages visited are kept while the notebook is open.',
      params: s.object({}),
      state: ctx => (ready(ctx).enabled ? (backPages(ctx.doc).length ? {enabled: true} : {enabled: false, reason: 'There is no earlier page to go back to'}) : ready(ctx)),
      run(ctx) {
        const id = takeBack(ctx.doc);
        if (!id) throw new CommandError('disabled', 'There is no earlier page to go back to');
        ctx.setSelection(selectPage(id));
        return {page: `/pg:${id}`, title: ctx.doc.pages[id].title};
      },
    },
    // --- Views ------------------------------------------------------------------------------------
    {
      id: 'view.mode', label: 'Normal View', risk: 'read', effect: 'view',
      description: 'Normal View: the notebook with its section tabs and page list (leaves Full Page View and the Immersive Reader).',
      params: s.object({mode: s.optional(s.enum(['normal']))}),
      state: ctx => (ready(ctx).enabled ? {enabled: true, checked: view(ctx).fullPage !== true && !view(ctx).immersive?.on} : ready(ctx)),
      run(ctx) { ctx.setView({fullPage: false, immersive: {...readerOf(view(ctx)), on: false}}); return {mode: 'normal'}; },
    },
    {
      id: 'view.fullPage', label: 'Full Page View', risk: 'read', effect: 'view',
      description: 'Full Page View: only the page, with the section tabs, notebook name and page list hidden; again goes back (value false).',
      params: VALUE,
      state: ctx => (ready(ctx).enabled ? {enabled: true, checked: view(ctx).fullPage === true} : ready(ctx)),
      run(ctx, p) { const on = p.value ?? view(ctx).fullPage !== true; ctx.setView({fullPage: on}); return {fullPage: on}; },
    },
    {
      id: 'view.dock', label: 'Dock to Desktop', risk: 'read', effect: 'view',
      description: 'Dock to Desktop: this window narrow along the right edge of the screen, above other windows; again (value false) puts it back.',
      params: VALUE,
      state(ctx) { const r = windowState(ctx); return r.enabled ? {enabled: true, checked: r.st?.docked === true} : r; },
      async run(ctx, p) { const w = windows(ctx); const on = p.value ?? w.state?.()?.docked !== true; await w.dock(on); return {docked: on}; },
    },
    // --- Immersive Reader --------------------------------------------------------------------------
    {
      id: 'view.immersiveReader', label: 'Immersive Reader', risk: 'read', effect: 'view',
      description: 'Immersive Reader: the page\'s text alone, large and spaced; options set its text size (1 to 4), spacing, theme (white, sepia, dark) and Line Focus (0 off, 1, 3 or 5 lines); Esc or value false leaves it. Reading aloud is the reader\'s own button.',
      params: s.object({value: s.optional(s.boolean()), textSize: s.optional(s.integer({min: 1, max: 4})), spacing: s.optional(s.boolean()), theme: s.optional(s.enum(READER_THEMES)),
        lineFocus: s.optional(s.enum([0, 1, 3, 5]))}),
      state: ctx => (hasPage(ctx).enabled ? {enabled: true, checked: view(ctx).immersive?.on === true, value: readerOf(view(ctx))} : hasPage(ctx)),
      run(ctx, p) {
        const cur = readerOf(view(ctx));
        const wants = p.textSize !== undefined || p.spacing !== undefined || p.theme !== undefined || p.lineFocus !== undefined;
        const on = p.value ?? (wants ? true : view(ctx).immersive?.on !== true);
        const next = {...cur, ...(p.textSize !== undefined ? {size: p.textSize} : {}), ...(p.spacing !== undefined ? {spacing: p.spacing} : {}), ...(p.theme !== undefined ? {theme: p.theme} : {}),
          ...(p.lineFocus !== undefined ? {lineFocus: p.lineFocus} : {}), on};
        ctx.setView({immersive: next});
        return next;
      },
    },
    // --- Show ---------------------------------------------------------------------------------------
    {
      id: 'view.navigationPanes', label: 'Navigation Panes', risk: 'read', effect: 'view',
      description: `Show or hide a navigation pane: ${PANES.join(', ')} (navigation is the whole of them: section tabs, notebook name and page list; notebooks the notebook name; pages the page list). value false hides; no value toggles; without pane, all three come back.`,
      params: s.object({pane: s.optional(s.enum(PANES)), value: s.optional(s.boolean())}),
      state(ctx, p) {
        if (!ready(ctx).enabled) return ready(ctx);
        const panes = panesOf(view(ctx));
        return {enabled: true, ...(p?.pane ? {checked: panes[p.pane]} : {checked: panes.navigation && panes.notebooks && panes.pages})};
      },
      run(ctx, p) {
        const cur = panesOf(view(ctx));
        const next = p.pane ? {...cur, [p.pane]: p.value ?? !cur[p.pane]} : {navigation: true, notebooks: true, pages: true};
        ctx.setView({panes: next});
        return next;
      },
    },
    {
      id: 'view.tabsLayout', label: 'Tabs Layout', risk: 'read', effect: 'prefs',
      description: 'Put the section tabs along the top of the page (horizontal) or down the left side (vertical).',
      params: s.object({layout: s.optional(s.enum(['horizontal', 'vertical']))}),
      state: (ctx, p) => (ready(ctx).enabled ? {enabled: true, checked: (ctx.prefs?.[TABS_LAYOUT_PREF] === 'vertical' ? 'vertical' : 'horizontal') === (p?.layout ?? 'horizontal')} : ready(ctx)),
      run(ctx, p) {
        const layout = p.layout ?? (ctx.prefs?.[TABS_LAYOUT_PREF] === 'vertical' ? 'horizontal' : 'vertical');
        ctx.updatePrefs({[TABS_LAYOUT_PREF]: layout});
        return {layout};
      },
    },
    {
      id: 'view.switchBackground', label: 'Switch Background', risk: 'read', effect: 'prefs',
      description: 'Switch the page between its light and dark background (the text and ink follow); value sets it.',
      params: VALUE,
      state: ctx => (ready(ctx).enabled ? {enabled: true, checked: ctx.prefs?.[DARK_PAGE_PREF] === true} : ready(ctx)),
      run(ctx, p) { const on = p.value ?? ctx.prefs?.[DARK_PAGE_PREF] !== true; ctx.updatePrefs({[DARK_PAGE_PREF]: on}); return {dark: on}; },
    },
    // --- Zoom ----------------------------------------------------------------------------------------
    {
      id: 'view.zoomPageWidth', label: 'Page Width', risk: 'read', effect: 'view',
      description: 'Zoom so the page content fills the width of the window.',
      params: s.object({}),
      state: hasPage,
      run(ctx) { return ctx.run('view.zoom', {value: 'pageWidth'}); },
    },
    // --- Window ----------------------------------------------------------------------------------------
    {
      id: 'window.new', label: 'New Window', risk: 'read', effect: 'view',
      description: 'New Window: this notebook again in a second window; an edit in either shows in both (one undo history).',
      params: s.object({}),
      state: windowState,
      async run(ctx) {
        const w = windows(ctx);
        if (typeof ctx.host?.save === 'function') await ctx.host.save(ctx.file, {});
        return w.open({doc: ctx.docId});
      },
    },
    {
      id: 'window.newDocked', label: 'New Docked Window', risk: 'read', effect: 'view',
      description: 'New Docked Window: a second window on this notebook, docked narrow along the right edge of the screen for taking notes beside other work.',
      params: s.object({}),
      state: windowState,
      async run(ctx) {
        const w = windows(ctx);
        if (typeof ctx.host?.save === 'function') await ctx.host.save(ctx.file, {});
        return w.open({doc: ctx.docId, docked: true});
      },
    },
    {
      id: 'window.alwaysOnTop', label: 'Always on Top', risk: 'read', effect: 'view',
      description: 'Always on Top: keep this window above the others; again (value false) lets others cover it.',
      params: VALUE,
      state(ctx) { const r = windowState(ctx); return r.enabled ? {enabled: true, checked: r.st?.alwaysOnTop === true} : r; },
      async run(ctx, p) { const w = windows(ctx); const on = p.value ?? w.state?.()?.alwaysOnTop !== true; await w.pin(on); return {alwaysOnTop: on}; },
    },
  ],
});
