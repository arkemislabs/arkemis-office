// View tab: the views (Normal, Outline View, Slide Sorter, Notes Page, Reading View), Show (Ruler,
// Gridlines, Guides, Notes), Fit to Window, Grayscale, and the windows (New Window, Arrange All, Switch
// Windows). Zoom itself is the shared view.zoom family.
//
// Translated from deckcraft crates/ui-egui/src/app/commands.rs (`run_ui`: view.normal, view.outline,
// view.sorter, view.notesPage, view.reading, view.notes, view.ruler, view.gridlines, view.guides,
// view.fit, view.grayscale, view.newWindow), ribbon/view.rs and doc_window.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The mode is the view key `mode` (normal | outline | sorter | notesPage); the surface draws it.
// deckcraft's Dark Mode (the app's own light/dark theme), Cascade and Black and White are not offered:
// the app has one skin and the OS decides window placement.

import {defineCommands} from '../../kernel/command.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {s} from '../../kernel/schema.mjs';
import {isSchema2} from '../model/doc.mjs';
import {bad, hasDoc, hasSlide, selectionOf, selectSlideList, UPSTREAM_COMMIT} from '../lib/text-session.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/ui-egui/src/app/commands.rs', 'crates/ui-egui/src/ribbon/view.rs', 'crates/ui-egui/src/doc_window.rs']};
const v2 = (cmd, ctx) => { if (!isSchema2(ctx.doc)) throw bad(cmd, 'needs a presentation (schema 2)'); };
export const modeOf = view => view?.mode ?? 'normal';
const flagParams = s.object({on: s.optional(s.boolean())});
const flag = (p, cur) => (typeof p.on === 'boolean' ? p.on : !cur);

function windows(ctx) {
  const w = ctx.host?.windows;
  if (!w || typeof w.open !== 'function') throw new CommandError('unavailable', 'Windows are only available in the app window');
  return w;
}
function windowsState(ctx, need = null) {
  const st0 = hasDoc(ctx);
  if (!st0.enabled) return st0;
  const w = ctx.host?.windows;
  if (!w || typeof w.open !== 'function') return {enabled: false, reason: 'only in the app window'};
  const st = typeof w.state === 'function' ? w.state() : {};
  if (need === 'others' && !(st.windows ?? []).some(x => !x.self)) return {enabled: false, reason: 'only one window is open'};
  return {enabled: true, st};
}

const modeCommand = (id, label, mode, description) => ({
  id, label, risk: 'read', effect: 'view', description, params: s.object({}),
  state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: modeOf(ctx.view) === mode && !ctx.view?.show && !ctx.view?.master} : hasDoc(ctx)),
  run(ctx) {
    v2(id, ctx);
    // A master view belongs to Normal; any other view takes you out of it.
    ctx.setView({mode, ...(ctx.view?.show ? {show: null, showStatus: null, showCmd: null} : {})});
    if (ctx.view?.master) {
      const from = ctx.view.master.from;
      const sl = (ctx.doc.slides ?? []).find(x => x.id === from) ?? ctx.doc.slides?.[0];
      ctx.setView({master: null});
      if (sl) selectSlideList(ctx, [sl.id], sl.id);
    }
    return {mode};
  },
});

const flagCommand = (id, label, key, description, extra) => ({
  id, label, ...(extra ? {risk: 'edit'} : {risk: 'read', effect: 'view'}), description, params: flagParams,
  state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: !!ctx.view?.[key]} : hasDoc(ctx)),
  async run(ctx, p) {
    v2(id, ctx);
    const on = flag(p, !!ctx.view?.[key]);
    ctx.setView({[key]: on});
    if (extra) await extra(ctx, on);
    return {on};
  },
});

export default defineCommands({
  family: 'view',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    modeCommand('view.normal', 'Normal', 'normal', 'Normal (View › Presentation Views): the slide pane, the slide and the notes.'),
    modeCommand('view.outline', 'Outline View', 'outline', 'Outline View: the slide titles and text as an outline beside the slide.'),
    modeCommand('view.sorter', 'Slide Sorter', 'sorter', 'Slide Sorter: every slide as a thumbnail in sections; drag to reorder.'),
    modeCommand('view.notesPage', 'Notes Page', 'notesPage', 'Notes Page: the slide above its speaker notes, as a printed notes page.'),
    {
      id: 'view.reading', label: 'Reading View', risk: 'read', effect: 'view',
      description: 'Reading View: play the show from the current slide in the window.',
      params: s.object({}),
      state: ctx => (hasSlide(ctx).enabled ? {enabled: true, checked: !!ctx.view?.show?.reading} : hasSlide(ctx)),
      run(ctx) {
        v2('view.reading', ctx);
        const was = ctx.view?.show;
        ctx.setView({show: {from: selectionOf(ctx).slideIndex, custom: null, n: (was?.n ?? 0) + 1, reading: true}, showStatus: null, showCmd: null});
        return {from: selectionOf(ctx).slideIndex};
      },
    },
    {
      id: 'view.notes', label: 'Notes', risk: 'read', effect: 'view',
      description: 'Notes (View › Show): show or hide the notes pane under the slide.',
      params: flagParams,
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: ctx.view?.notes !== false} : hasDoc(ctx)),
      run(ctx, p) { v2('view.notes', ctx); const on = flag(p, ctx.view?.notes !== false); ctx.setView({notes: on}); return {on}; },
    },
    flagCommand('view.ruler', 'Ruler', 'ruler', 'Ruler (View › Show): show or hide the rulers along the slide in points from its top left.'),
    flagCommand('view.gridlines', 'Gridlines', 'gridlines', 'Gridlines (View › Show): show or hide the grid over the slide.'),
    flagCommand('view.guides', 'Guides', 'guides', 'Guides (View › Show): show or hide the drawing guides; a presentation without guides gets PowerPoint\'s two centre guides.', async (ctx, on) => {
      if (on && !(ctx.doc.guides ?? []).length && typeof ctx.run === 'function') { try { await ctx.run('guide.add', {defaults: true}); } catch { /* guides are shown without the defaults */ } }
    }),
    {
      id: 'view.fit', label: 'Fit to Window', risk: 'read', effect: 'view',
      description: 'Fit to Window (View › Zoom): fit the slide to the window.',
      params: s.object({}),
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: ctx.view?.fit === 'fit'} : hasDoc(ctx)),
      async run(ctx) { return (await ctx.run('view.zoom', {value: 'fit'})).result; },
    },
    {
      id: 'view.grayscale', label: 'Grayscale', risk: 'read', effect: 'view',
      description: 'Grayscale (View › Color/Grayscale): draw the slides in grays; `on: false` is Color.',
      params: flagParams,
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: !!ctx.view?.grayscale} : hasDoc(ctx)),
      run(ctx, p) { v2('view.grayscale', ctx); const on = flag(p, !!ctx.view?.grayscale); ctx.setView({grayscale: on, ...(on ? {blackWhite: false} : {})}); return {on}; },
    },
    {
      id: 'view.color', label: 'Color', risk: 'read', effect: 'view',
      description: 'Color (View › Color/Grayscale): draw the slides in full color.',
      params: s.object({}),
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: !ctx.view?.grayscale && !ctx.view?.blackWhite} : hasDoc(ctx)),
      run(ctx) { v2('view.color', ctx); ctx.setView({grayscale: false, blackWhite: false}); return {on: false}; },
    },
    {
      id: 'view.newWindow', label: 'New Window', risk: 'read', effect: 'view',
      description: 'New Window (View › Window): a second window on the same presentation; an edit in either shows in both (one undo history).',
      params: s.object({}),
      state: ctx => windowsState(ctx),
      async run(ctx) {
        const w = windows(ctx);
        // The new window reads the document's working copy: write the latest change there first.
        if (typeof ctx.host?.save === 'function') await ctx.host.save(ctx.file, {});
        return w.open({doc: ctx.docId});
      },
    },
    {
      id: 'view.arrangeAll', label: 'Arrange All', risk: 'read', effect: 'view',
      description: 'Arrange All (View › Window): the open windows stacked one above the other on the screen.',
      params: s.object({}),
      state: ctx => windowsState(ctx),
      async run(ctx) { return windows(ctx).arrange({mode: 'all'}); },
    },
    {
      id: 'view.switchWindows', label: 'Switch Windows', risk: 'read', effect: 'view',
      description: 'Switch Windows (View › Window): the open windows ({value}: a window id brings that window to the front); without value, the list.',
      params: s.object({value: s.optional(s.integer({min: 0}))}),
      state(ctx) {
        const r = windowsState(ctx);
        if (!r.enabled) return r;
        return {enabled: true, value: (r.st?.windows ?? []).map((x, i) => ({id: x.id, label: `${i + 1} ${x.title}`, value: x.id, checked: !!x.self}))};
      },
      async run(ctx, p) {
        const w = windows(ctx);
        if (p.value === undefined) return {windows: (await w.list()) ?? []};
        return w.focus(p.value);
      },
    },
  ],
});
