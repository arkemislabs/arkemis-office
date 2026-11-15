// The Session the caret, select, text, edit and paste commands work on: upstream's `Session`
// fields these families read and write (the document, the selection, goal x, the page hint, the
// pending typing formatting, the find state, the format painter, the pending tracked move, the
// AutoCorrect capital memory), built from a kernel command context and committed back to it.
//
// Upstream: wordcraft crates/engine/src/session.rs (`Session`: sel, goal_x, page_hint, pending,
// find, painter, pending_move, autocap, clipboard, clip_history, building_blocks, status),
// crates/engine/src/doc_state.rs (`FindState`), crates/engine/src/cmd.rs (`sel_result`,
// `parse_pos`, `pos_json`, `story_param`) and crates/engine/src/session/layout.rs (`layout`) at
// ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Where the state lives here:
// * per document view state (goal x, page hint, pending formatting, find, painter, autocap,
//   pending move, typing burst): the kernel's document view, under `view.quill` (ctx.view /
//   ctx.setView), so the renderer and the headless host see the same state and no command needs
//   the page view (architecture 4.4);
// * per session state upstream keeps once for every document (the Clipboard pane's items, the
//   Spike): `appState(ctx)`, one object per kernel host;
// * the internal rich clipboard: the kernel clipboard (ctx.clipboard / ctx.setClipboard).
//
// The layout: `layoutFor(ctx, content)`. A host that already lays the document out (the page
// view) installs `setLayoutProvider(fn)` so caret commands read exactly what the person sees;
// otherwise the translated layout (core/quill/layout) runs here with the default shaper (the
// renderer's Canvas2D shaper once installed, the metrics shaper headless) and a cache per document.

import {CommandError} from '../../kernel/errors.mjs';
import {isQuill2} from '../model/content.mjs';
import {cmpPositions} from '../address.mjs';
import {layout as runLayout, LayoutCache, getDefaultShaper} from '../layout/index.mjs';
import {viewLayoutOptions} from './view-layout.mjs';

export const UPSTREAM_COMMIT = 'aadb077e072b7de05f724e359d8db82e151f125c';

// ---- positions ---------------------------------------------------------------------------------

export const cmpPos = cmpPositions;
export const samePos = (a, b) => cmpPos(a, b) === 0;
export const caret = p => ({anchor: p, focus: p});
export const isCollapsed = sel => samePos(sel.anchor, sel.focus);
export const ordered = sel => (cmpPos(sel.anchor, sel.focus) <= 0 ? [sel.anchor, sel.focus] : [sel.focus, sel.anchor]);
export const at = (p, off) => ({story: p.story, path: [...p.path], off});
export const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export const withLast = (path, v) => [...path.slice(0, -1), v];
export const parentOf = path => path.slice(0, -1);
export const lastOf = path => path[path.length - 1] ?? 0;

/** Path::cell: the table path, row and cell of a path inside a table cell. */
export function cellOf(path) {
  const n = path.length;
  if (n < 4) return null;
  return [path.slice(0, n - 3), path[n - 3], path[n - 2]];
}

// ---- state -------------------------------------------------------------------------------------

/** Upstream FindState::default (doc_state.rs). */
export const defaultFind = () => ({query: '', replace: '', matchCase: false, wholeWord: false, regex: false, wildcards: false, literal: false,
  matchPrefix: false, matchSuffix: false, ignorePunct: false, ignoreSpace: false, current: 0, highlight: false, count: 0});

/** The per-document view state these families keep (kept JSON so the kernel can store it). */
export const defaultView = () => ({goalX: null, pageHint: 0, pending: null, find: defaultFind(), painter: null, autocap: null,
  pendingMove: null, burst: 0, burstSel: null, navPane: false, clipboardPane: false, editMarks: [], goBackStep: 0, status: ''});

// Shared with U:quill/format (core/quill/lib/format-target.mjs): the pending typing formatting is
// `ctx.view.pendingFormat = {at: caret address, props}` (valid while the selection is that caret)
// and the format painter `ctx.view.painter = {chr, para, sticky}`. Everything else this unit keeps
// is under `ctx.view.quill`.
const OWN_KEYS = Object.keys(defaultView()).filter(k => k !== 'pending' && k !== 'painter');

/** The view state of the command's document (a copy); `pending` only when it applies at `caretAddress`. */
export function viewState(ctx, caretAddress = null) {
  const v = ctx?.view?.quill;
  const out = {...defaultView(), ...(v && typeof v === 'object' ? v : {})};
  const pf = ctx?.view?.pendingFormat;
  out.pending = pf && typeof pf === 'object' && pf.props && caretAddress !== null && pf.at === caretAddress ? {...pf.props} : null;
  out.painter = ctx?.view?.painter ?? null;
  return out;
}

const hostStates = new WeakMap();
const fallbackState = {};
/** Session-wide state (upstream keeps it on the Session, beside every document). */
export function appState(ctx) {
  const key = ctx?.host && typeof ctx.host === 'object' ? ctx.host : null;
  let st = fallbackState;
  if (key) {
    st = hostStates.get(key);
    if (!st) { st = {}; hostStates.set(key, st); }
  }
  st.clips ??= [];
  st.buildingBlocks ??= new Map();
  return st;
}

// ---- layout ------------------------------------------------------------------------------------

let provider = null;
/** A host that lays documents out itself (the page view) shares its layout: fn(ctx, content) -> DocLayout | null. */
export function setLayoutProvider(fn) { provider = typeof fn === 'function' ? fn : null; }

const layouts = new Map();
const MAX_LAYOUTS = 16;
/** The layout of `content` (default: the command's current content) for the command's document. */
export function layoutFor(ctx, content = ctx?.doc) {
  if (!isQuill2(content)) return null;
  if (provider) {
    try { const l = provider(ctx, content); if (l) return l; } catch { /* fall back to our own layout */ }
  }
  const key = ctx?.docId ?? '';
  const shaper = getDefaultShaper();
  const v = ctx?.view ?? {};
  // The document's view (U:quill/view): Outline, Draft and Web Layout at upstream's headless widths.
  const opts = {...viewLayoutOptions(v), showHidden: !!v.showHidden, fieldCodes: !!v.fieldCodes, mergeHighlight: !!v.merge?.highlight, designMode: !!v.designMode};
  const optKey = JSON.stringify(opts);
  let e = layouts.get(key);
  if (!e || e.shaper !== shaper || e.optKey !== optKey) e = {cache: new LayoutCache(), shaper, optKey, content: null, lay: null};
  if (e.content !== content) {
    e.lay = runLayout(content, {...opts, cache: e.cache, shaper});
    e.content = content;
  }
  layouts.delete(key);
  layouts.set(key, e);
  while (layouts.size > MAX_LAYOUTS) layouts.delete(layouts.keys().next().value);
  return e.lay;
}

let viewSync = null;
/**
 * A host whose page view keeps its own copy of some view state (the page hint the caret is drawn
 * on) shares it: {read(ctx) -> partial view state, write(ctx, view)}. Read when a command opens,
 * written when it finishes, so a click on the page and a command see one page hint.
 */
export function setViewSync(sync) { viewSync = sync && typeof sync === 'object' ? sync : null; }

/** For tests: forget cached layouts, the layout provider and the view sync. */
export function resetLayouts() { layouts.clear(); provider = null; viewSync = null; }

// ---- the session -------------------------------------------------------------------------------

/** state(): enabled on a schema-2 document. */
export function ready(ctx) {
  if (!ctx?.doc) return {enabled: false, reason: 'No document is open'};
  if (!isQuill2(ctx.doc)) return {enabled: false, reason: 'This document has not been converted to the new Quill format yet'};
  return {enabled: true};
}

/** The author tracked changes are recorded under (File › Options › User name). */
export function author(prefs) {
  const p = prefs ?? {};
  const name = p.userName ?? p.user?.name ?? p.author;
  return typeof name === 'string' && name.trim() ? name.trim() : 'Author';
}

/** Revision dates are whole seconds, as Word writes them (now_iso). */
export const isoSeconds = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Build the Session for a command: {ctx, d (a model Document over ctx.doc), sel, view, prefs,
 * author, now(), layout(), app}. Throws `disabled` on a schema-1 document.
 */
export function open(ctx) {
  const st = ready(ctx);
  if (!st.enabled) throw new CommandError('disabled', st.reason);
  const d = ctx.model.open(ctx);
  const all = ctx.model.selection(ctx);
  const r = all[ctx.selection?.primary ?? 0] ?? all[0];
  const sel = {anchor: d.clamp(r.anchor), focus: d.clamp(r.focus)};
  let caretAddress = null;
  if (cmpPos(sel.anchor, sel.focus) === 0) { try { caretAddress = ctx.model.addressOf(ctx, sel.focus); } catch { caretAddress = null; } }
  const view = viewState(ctx, caretAddress);
  if (viewSync?.read) {
    try { const got = viewSync.read(ctx); if (got && Number.isInteger(got.pageHint)) view.pageHint = got.pageHint; } catch { /* the kernel's copy stands */ }
  }
  const S = {
    ctx, d,
    sel,
    view,
    viewBefore: viewKey(view),
    prefs: ctx.prefs ?? {},
    author: author(ctx.prefs),
    now: () => isoSeconds(ctx.host?.now?.() ?? Date.now()),
    layout: () => layoutFor(ctx, d.c),
    app: appState(ctx),
    ui: [],
  };
  return S;
}

/** A request for the front end (upstream push_ui_request): returned in the command's result. */
export function pushUi(S, req) { S.ui.push(req); }

const viewKey = v => JSON.stringify(v);

/** Write the view state back when it changed (after the commit, so addresses name committed ids). */
export function saveView(ctx, S) {
  const next = viewKey(S.view);
  if (next === S.viewBefore) return;
  const own = {};
  for (const k of OWN_KEYS) own[k] = S.view[k];
  const patch = {quill: JSON.parse(JSON.stringify(own))};
  const collapsed = cmpPos(S.sel.anchor, S.sel.focus) === 0;
  patch.pendingFormat = S.view.pending && collapsed ? {at: ctx.model.addressOf(ctx, S.sel.focus), props: {...S.view.pending}} : null;
  patch.painter = S.view.painter ?? null;
  ctx.setView?.(patch);
  S.viewBefore = next;
}

/** Upstream sel_result: the selection after the command, as addresses (and positions). */
export function selResult(ctx, S) {
  const a = S.sel.anchor, f = S.sel.focus;
  const out = {anchor: ctx.model.addressOf(ctx, a), focus: ctx.model.addressOf(ctx, f)};
  if (S.ui.length) out.ui = S.ui;
  return out;
}

/** Commit S.d's changes (if any), set the selection and view state, return sel_result. */
export function finish(ctx, S, {edit = false, result} = {}) {
  if (edit) ctx.model.commit(ctx, S.d);
  // The selection stays inside the text (Session::run clamps it after every command).
  try { S.sel = {anchor: S.d.clamp(S.sel.anchor), focus: S.d.clamp(S.sel.focus)}; } catch { /* keep it */ }
  ctx.model.setSelection(ctx, [S.sel]);
  saveView(ctx, S);
  if (viewSync?.write) { try { viewSync.write(ctx, S.view); } catch { /* a page view never breaks a command */ } }
  const base = selResult(ctx, S);
  return result ? {...base, ...result} : base;
}

/** A position param: an address (/body/b:<id>/t:4), upstream's {story, path, off} or {block, off} (parse_pos). */
export function posParam(ctx, v, name) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return ctx.model.position(ctx, v);
  if (typeof v === 'object' && Array.isArray(v.path) && Number.isInteger(v.off)) {
    const story = storyOf(v.story);
    if (story === null) throw new CommandError('invalid_params', `bad \`${name}\``, {path: `/${name}`});
    return {story, path: v.path.map(Number), off: v.off};
  }
  if (typeof v === 'object' && Number.isInteger(v.block)) return {story: 'body', path: [v.block], off: Number.isInteger(v.off) ? v.off : 0};
  throw new CommandError('invalid_params', `bad \`${name}\``, {path: `/${name}`});
}

/** A story param ("body", {part: 3}, 3) or null when it isn't one. */
export function storyOf(v) {
  if (v === undefined || v === null || v === 'body' || v === 'Body') return 'body';
  if (Number.isInteger(v)) return v;
  if (typeof v === 'object') {
    const n = v.part ?? v.Part;
    if (Number.isInteger(n)) return n;
  }
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

/** story_param: the story the params name, else the caret's. */
export function storyParam(S, p) {
  if (p?.story === undefined) return S.sel.focus.story;
  const s = storyOf(p.story);
  if (s === null || !S.d.story(s)) throw new CommandError('invalid_params', 'bad `story`', {path: '/story'});
  return s;
}

/** Position as upstream's JSON (pos_json), plus its address. */
export function posJson(ctx, p) {
  return {story: p.story === 'body' ? 'body' : {part: p.story}, path: [...p.path], off: p.off, address: ctx.model.addressOf(ctx, p)};
}
