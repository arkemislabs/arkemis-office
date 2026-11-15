// View > Window: New Window, Arrange All, Hide, Unhide, View Side by Side, Synchronous Scrolling,
// Reset Window Position and Switch Windows.
//
// Translated from gridcraft crates/engine/src/windows.rs (Session windows: new_window, hide_window,
// unhide_window, window_list, window_title "Name:1", "Name:2") and crates/engine/src/cmd/extra/window.rs
// (new_window, arrange_all: tiled / horizontal / vertical / cascade over the visible windows with the active
// one first, hide_window, unhide_window, switch_windows) at fb1e59f. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Where the state lives: a window here is an operating-system window of the application (the renderer's
// window service, electron/preload.cjs `windows`, answered by electron/main.cjs), as Word's New Window is;
// every commit, undo, redo and save of the document goes to its other windows (EngineProvider, `windows.sync`),
// so all of them show one workbook with one undo history. The engine has no window geometry, so the main
// process moves the windows, as gridcraft's interface does. View Side by Side, Synchronous Scrolling and
// Reset Window Position are Excel's and are not in gridcraft (not checked against upstream); they use the
// same window service as Word's. Headless there are no windows and the commands say so.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import {hasDoc} from '../../lib/edit-targets.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: 'fb1e59f', files: ['crates/engine/src/windows.rs', 'crates/engine/src/cmd/extra/window.rs', 'crates/ui-egui/src/ribbon/view.rs']};
const NONE = s.object({});
const interactive = ctx => ctx.origin === 'ui' || ctx.origin === 'shortcut' || ctx.origin === 'dialog';

function service(ctx) {
  const w = ctx.host?.windows;
  if (!w || typeof w.open !== 'function') throw new CommandError('unavailable', 'Windows are only available in the Grid window');
  return w;
}

/** The window service's state with `need` ('others', 'hidden', 'visibleOthers', 'sideBySide') met, or a disabled reason. */
function windowsState(ctx, need = null) {
  const r = hasDoc(ctx);
  if (!r.enabled) return r;
  const w = ctx.host?.windows;
  if (!w || typeof w.open !== 'function') return {enabled: false, reason: 'only in the Grid window'};
  const st = typeof w.state === 'function' ? w.state() : {};
  const list = st.windows ?? [];
  if (need === 'others' && !list.some(x => !x.self && !x.hidden)) return {enabled: false, reason: 'only one window is open'};
  if (need === 'visibleOthers' && !list.some(x => !x.self && !x.hidden)) return {enabled: false, reason: 'only one window is visible'};
  if (need === 'hidden' && !list.some(x => x.hidden)) return {enabled: false, reason: 'no window is hidden'};
  if (need === 'sideBySide' && !st.sideBySide) return {enabled: false, reason: 'only while viewing side by side'};
  return {enabled: true, st};
}

const ARRANGE = ['tiled', 'horizontal', 'vertical', 'cascade'];

export default defineCommands({
  family: 'view/windows',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'view.newWindow', label: 'New Window', risk: 'read', effect: 'view',
      description: 'New Window: another window on the same workbook (named Name:1, Name:2); an edit in either shows in both, with one undo history.', params: NONE,
      state: ctx => windowsState(ctx),
      async run(ctx) {
        const w = service(ctx);
        // The new window reads the workbook's working copy: write the latest change there first.
        if (typeof ctx.host?.save === 'function') await ctx.host.save(ctx.file, {});
        return w.open({doc: ctx.docId});
      }},
    {id: 'view.arrangeAll', label: 'Arrange All', risk: 'read', effect: 'view', dialog: 'dialog.arrangeAll',
      description: 'Arrange All: the visible windows tiled, horizontal, vertical or cascaded (`arrange`, default tiled), the active one first; `activeWorkbook` arranges only the windows of this workbook.',
      params: s.object({arrange: s.optional(s.enum(ARRANGE)), activeWorkbook: s.optional(s.boolean())}),
      state: ctx => windowsState(ctx),
      async run(ctx, p) {
        const w = service(ctx);
        const arrange = p.arrange ?? 'tiled';
        const st = await w.arrange({mode: arrange, activeWorkbook: p.activeWorkbook === true});
        return {arrange, windows: (st?.windows ?? []).filter(x => !x.hidden).map(x => x.id)};
      }},
    {id: 'view.hideWindow', label: 'Hide', risk: 'read', effect: 'view',
      description: 'Hide the window (the workbook stays open; Unhide brings it back). Needs another visible window.', params: NONE,
      state: ctx => windowsState(ctx, 'visibleOthers'),
      async run(ctx) {
        const w = service(ctx);
        const me = (w.state?.()?.windows ?? []).find(x => x.self);
        await w.arrange({mode: 'hide', with: me?.id});
        return {hidden: me?.id ?? null};
      }},
    {id: 'view.unhideWindow', label: 'Unhide', risk: 'read', effect: 'view', dialog: 'dialog.unhideWindow',
      description: 'Unhide a hidden window (`window`, a window id from the dialog; default the most recently hidden) and bring it forward.',
      params: s.object({window: s.optional(s.integer({min: 0}))}),
      state: ctx => windowsState(ctx, 'hidden'),
      async run(ctx, p) {
        const w = service(ctx);
        const hidden = (w.state?.()?.windows ?? []).filter(x => x.hidden);
        const id = p.window ?? hidden.at(-1)?.id;
        if (id === undefined || !hidden.some(x => x.id === id)) throw new CommandError('invalid_params', 'no such hidden window', {path: '/window'});
        await w.arrange({mode: 'unhide', with: id});
        return {window: id};
      }},
    {id: 'view.sideBySide', label: 'View Side by Side', risk: 'read', effect: 'view',
      description: 'View Side by Side: this window and another (`with`, a window id from Switch Windows; with more than two windows the person is asked) next to each other, scrolling together; again turns it off.',
      params: s.object({with: s.optional(s.integer({min: 0})), value: s.optional(s.boolean())}),
      state(ctx) {
        const r = windowsState(ctx, 'others');
        const on = !!ctx.host?.windows?.state?.()?.sideBySide;
        // Turning it off is always possible while it is on.
        if (on) return {enabled: true, checked: true};
        return r.enabled ? {enabled: true, checked: false} : {...r, checked: false};
      },
      async run(ctx, p) {
        const w = service(ctx);
        const st = w.state?.() ?? {};
        const on = p.value ?? !st.sideBySide;
        if (!on) return w.arrange({mode: 'off'});
        let other = p.with;
        const others = (st.windows ?? []).filter(x => !x.self && !x.hidden);
        if (other === undefined && others.length > 1 && interactive(ctx) && typeof ctx.host?.openDialog === 'function') {
          // Excel asks which workbook to compare with when more than one other window is open.
          const v = await ctx.host.openDialog('dialog.compareSideBySide', {windows: others.map(x => ({id: x.id, title: x.title})), with: others.at(-1).id});
          if (!v) return null;
          other = Number(v.with);
        }
        return w.arrange({mode: 'sideBySide', with: other});
      }},
    {id: 'view.syncScroll', label: 'Synchronous Scrolling', risk: 'read', effect: 'view',
      description: 'Synchronous Scrolling: while viewing side by side, both windows scroll together.', params: s.object({value: s.optional(s.boolean())}),
      state(ctx) {
        const r = windowsState(ctx, 'sideBySide');
        return r.enabled ? {enabled: true, checked: !!r.st?.syncScroll} : {...r, checked: false};
      },
      async run(ctx, p) {
        const w = service(ctx);
        const on = p.value ?? !w.state?.()?.syncScroll;
        return w.arrange({mode: 'syncScroll', value: on});
      }},
    {id: 'view.resetWindowPosition', label: 'Reset Window Position', risk: 'read', effect: 'view',
      description: 'Reset Window Position: the two windows viewed side by side share the screen equally again.', params: NONE,
      state: ctx => windowsState(ctx, 'sideBySide'),
      async run(ctx) { return service(ctx).arrange({mode: 'reset'}); }},
    {id: 'view.switchWindows', label: 'Switch Windows', risk: 'read', effect: 'view',
      description: 'Switch Windows: the open windows ({value}: a window id brings that window to the front); without value, the list.',
      params: s.object({value: s.optional(s.integer({min: 0}))}),
      state(ctx) {
        const r = windowsState(ctx);
        if (!r.enabled) return r;
        // Excel numbers them: "1 Book1:1", "2 Book1:2"; hidden windows are not listed.
        const list = (r.st?.windows ?? []).filter(x => !x.hidden).map((x, i) => ({id: x.id, label: `${i + 1} ${x.title}`, value: x.id, checked: !!x.self}));
        return {enabled: true, value: list};
      },
      async run(ctx, p) {
        const w = service(ctx);
        if (p.value === undefined) return {windows: ((await w.list()) ?? []).filter(x => !x.hidden)};
        return w.focus(p.value);
      }},
  ],
});
