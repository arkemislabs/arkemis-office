// The PDF window's chrome as commands: the mode tabs, the All tools list (View more, the expanded view with its
// search), Toggle fit page / fit width, Find tools and commands, and the notice bar over the pages (Dismiss, Don't
// show again, what it says).
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/chrome.rs:497-560         mode_bar: the four mode tabs (Mode::AllTools, Edit, Convert, ESign)
//   crates/ui-egui/src/panels/tools.rs:60-115    the All tools sidebar: Expand, the first COLLAPSED_TOOLS rows until View more
//   crates/ui-egui/src/panels/all_tools_ui.rs    the expanded view: every tool under its category, a search field, Collapse
//   crates/ui-egui/src/app/commands.rs:116       expand_all_tools (switches to All tools, opens the expanded view)
//   crates/ui-egui/src/chrome.rs:600-615         right_rail: Toggle fit page / fit width
//   crates/ui-egui/src/commands.rs:283           view.palette toggles the command palette (here: the title bar's search)
//   crates/ui-egui/src/canvas/bars.rs:94-260     notices: what the bar says, Dismiss, Don't show again (#4035)
// All of it is view state or a preference, never a document edit. The window's own chrome (src/apps/folio/chrome)
// follows `view.modeReq`, `view.toolsFull`, `view.toolsMore`, `view.toolsQuery` and `view.paletteReq`.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/chrome.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {pagesOf} from '../lib/comment-geometry.mjs';
import {noticeOf} from '../lib/notice.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/chrome.rs', 'crates/ui-egui/src/panels/tools.rs',
  'crates/ui-egui/src/panels/all_tools_ui.rs', 'crates/ui-egui/src/app/commands.rs', 'crates/ui-egui/src/canvas/bars.rs']};

const always = () => ({enabled: true});
const noPdf = {enabled: false, reason: 'no PDF open'};
const documentState = ctx => (pagesOf(ctx).length ? {enabled: true} : noPdf);

export const MODES = ['all-tools', 'edit', 'convert', 'esign'];

export default defineCommands({
  family: 'chrome',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'view.mode', label: 'Mode', risk: 'read', effect: 'view', undo: 'none',
      description: 'Switch the mode tab: All tools, Edit, Convert or E-Sign (Mode::AllTools, Edit, Convert, ESign). The window shows that mode\'s tools panel.',
      params: s.object({mode: s.enum(MODES)}),
      state: always,
      run(ctx, p) {
        const n = (ctx.view?.modeReq?.n ?? 0) + 1;
        ctx.setView({modeReq: {mode: p.mode, n}, toolsPane: true});
        return {mode: p.mode};
      },
    },
    {
      id: 'view.tools_full', label: 'Expand all tools', risk: 'read', effect: 'view', undo: 'none',
      description: 'The expanded All tools view over the pages (every tool under its category, with a search field); `open: false` is Collapse all tools. Without `open` it toggles. Opening it switches to the All tools mode.',
      params: s.object({open: s.optional(s.boolean())}),
      state: ctx => ({enabled: true, checked: ctx.view?.toolsFull === true}),
      run(ctx, p) {
        const open = p.open ?? !ctx.view?.toolsFull;
        // expand_all_tools: from another mode it first switches to All tools.
        const modeReq = open ? {mode: 'all-tools', n: (ctx.view?.modeReq?.n ?? 0) + 1} : ctx.view?.modeReq;
        ctx.setView({toolsFull: open, toolsPane: true, ...(open ? {modeReq} : {})});
        return {full: open};
      },
    },
    {
      id: 'view.tools_more', label: 'View more', risk: 'read', effect: 'view', undo: 'none',
      description: 'The All tools list shows its first 14 tools until View more shows them all; View less folds it back. Without `on` it toggles.',
      params: s.object({on: s.optional(s.boolean())}),
      state: ctx => ({enabled: true, checked: ctx.view?.toolsMore === true}),
      run(ctx, p) {
        const on = p.on ?? !ctx.view?.toolsMore;
        ctx.setView({toolsMore: on});
        return {more: on};
      },
    },
    {
      id: 'view.tools_search', label: 'Search tools and commands', risk: 'read', effect: 'view', undo: 'none',
      description: 'Filter the All tools list by what the person types: a tool is kept when its name or one of its items matches, in any case. An empty query shows every tool.',
      params: s.object({query: s.string({max: 200})}),
      state: ctx => ({enabled: true, value: ctx.view?.toolsQuery ?? ''}),
      run(ctx, p) {
        const query = String(p.query ?? '').slice(0, 200);
        ctx.setView({toolsQuery: query});
        return {query};
      },
    },
    {
      id: 'view.palette', label: 'Find tools and commands', risk: 'read', effect: 'view', undo: 'none',
      description: 'Put the cursor in the search for tools and commands in the title bar.',
      params: s.object({}),
      state: always,
      run(ctx) {
        const n = (ctx.view?.paletteReq ?? 0) + 1;
        ctx.setView({paletteReq: n});
        return {focused: true};
      },
    },
    {
      id: 'view.fit_toggle', label: 'Toggle fit page / fit width', risk: 'read', effect: 'view', undo: 'none',
      description: 'Fit the width of the page to the window, or, when it already is, fit the whole page (the rail\'s fit button); the view stays on the page shown.',
      params: s.object({}),
      state: ctx => ({...documentState(ctx), checked: ctx.view?.fit === 'width'}),
      run(ctx) {
        const fit = ctx.view?.fit === 'width' ? 'page' : 'width';
        ctx.setView({fit});
        return {fit};
      },
    },
    {
      id: 'notice.read', label: 'Notice', risk: 'read', effect: 'view', undo: 'none',
      description: 'What the notice bar over the pages says now (null when it shows nothing): the message, and which of its buttons it has.',
      params: s.object({}),
      state: documentState,
      run(ctx) { return {notice: noticeOf(ctx.doc, ctx.view, ctx.prefs)}; },
    },
    {
      id: 'notice.dismiss', label: 'Dismiss', risk: 'read', effect: 'view', undo: 'none',
      description: 'Close the notice bar for this document (it comes back when the document is opened again).',
      params: s.object({}),
      state: ctx => { const st = documentState(ctx); return st.enabled && !noticeOf(ctx.doc, ctx.view, ctx.prefs) ? {enabled: false, reason: 'there is no notice'} : st; },
      run(ctx) { ctx.setView({noticeDismissed: true}); return {dismissed: true}; },
    },
    {
      id: 'notice.hide_secured', label: "Don't show again", risk: 'edit', effect: 'prefs', undo: 'none', scope: 'app',
      description: 'Stop showing the secured-document notice, in every document (printcraft #4035). Preferences ▸ Documents can bring it back (`show: true`).',
      params: s.object({show: s.optional(s.boolean())}),
      state: ctx => {
        const st = documentState(ctx);
        if (!st.enabled) return st;
        return noticeOf(ctx.doc, ctx.view, ctx.prefs)?.kind === 'secured' ? st : {enabled: false, reason: 'the secured notice is not showing'};
      },
      run(ctx, p) {
        const hide = p.show === true ? false : true;
        ctx.updatePrefs({hideSecuredNotice: hide});
        return {hideSecuredNotice: hide};
      },
    },
  ],
});
