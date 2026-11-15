// Clipboard, Find and Replace, Go To, Go Back, the Spike and the Format Painter (Home › Clipboard,
// Home › Editing). Undo, Redo, Undo Actions and Undo History are the common family
// (core/common/commands/edit.mjs).
//
// Translated from wordcraft crates/engine/src/cmd/edit.rs (specs, copy, copy_result, cut, spike,
// insert_spike, paste, paste_merge, ClipItem, ClipHistory, has_clips, clip_index, paste_clip,
// paste_clip_item, paste_all_clips, paste_text, find, advanced_find, step, replace, replace_all,
// goto, painter_pick, painter, paste_format), crates/engine/src/cmd/insert/links.rs
// (bookmark_range, bookmark_span) and crates/engine/src/session/query.rs (note_edit, go_back) at
// ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The system clipboard: a Copy or Cut the person makes (origin ui / shortcut / dialog) also goes to
// the system clipboard through the host (text, and HTML once core/quill/formats/html-write.mjs
// exists); a Paste the person makes reads it from the host when the params carry none. Bridge
// calls use the params and the app's own clipboard only, as upstream's control channel does.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as P from '../model/para.mjs';
import {charCleared, charOverlaid, charWithoutSymbol} from '../model/props.mjs';
import {appendFragment} from '../model/document.mjs';
import {open, finish, ready, saveView, pushUi, posJson, isCollapsed, ordered, caret, samePos, at, UPSTREAM_COMMIT, viewState, layoutFor}
  from '../lib/caret-session.mjs';
import {deleteSelection, pasteText, checkDeletions, restorePlaceholder, trackChanges, prepareEdit} from '../lib/text-edit.mjs';
import {cutTracked} from '../lib/edit-moves.mjs';
import {searchFull, search, readOpts, needQuery, firstAtOrAfter, lastAtOrBefore} from '../lib/edit-search.mjs';
import {clipboardText, plainText, pasteContent, pasteFragment, mergeFormatting, insertFragment, insertPlainText, importers, ownClip, fragmentHtml}
  from '../lib/paste-content.mjs';
import {noteEdit} from './text.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/edit.rs', 'crates/engine/src/cmd/insert/links.rs',
  'crates/engine/src/session/query.rs']};

/** Most items the Clipboard pane keeps. */
export const CLIP_MAX_ITEMS = 24;
const CLIP_ITEM_BYTES = 4 << 20;
const CLIP_TOTAL_BYTES = 24 << 20;
const CLIP_PREVIEW_CHARS = 120;
/** The AutoText entry the Spike collects into. */
export const SPIKE = 'Spike';
/** Reading Highlight keeps at most this many ranges for the page view to paint. */
const MAX_HIGHLIGHTS = 10_000;

const userOrigin = ctx => ctx.origin === 'ui' || ctx.origin === 'shortcut' || ctx.origin === 'dialog';
const hasSel = ctx => {
  const st = ready(ctx);
  if (!st.enabled) return st;
  const [a, b] = ctx.model.selectionRange(ctx);
  return samePos(a, b) ? {enabled: false, reason: 'nothing is selected'} : {enabled: true};
};

// ---- the Clipboard pane (ClipHistory) -------------------------------------------------------------

/** One line of an item's text for a list (ClipItem::preview). */
export function clipPreview(text) {
  const words = text.split(/[\s￼]+/u).filter(Boolean);
  let out = '', n = 0;
  for (const w of words) {
    if (out) { out += ' '; n++; }
    for (const c of w) {
      if (n >= CLIP_PREVIEW_CHARS) return out + '…';
      out += c; n++;
    }
  }
  return out;
}

/** ClipHistory::push: skip oversized or empty copies and repeats; newest first; bounded. */
function clipPush(app, frag, text) {
  const paras = (text.match(/\n/g)?.length ?? 0) + frag.blocks.length + Object.keys(frag.parts ?? {}).length + 1;
  const bytes = text.length * 2 + paras * 256;
  if (bytes > CLIP_ITEM_BYTES || !frag.blocks.length) return;
  const first = app.clips[0];
  if (first && first.text === text && JSON.stringify(first.fragment) === JSON.stringify(frag)) return;
  app.clips.unshift({fragment: frag, text, bytes});
  app.clips.length = Math.min(app.clips.length, CLIP_MAX_ITEMS);
  while (app.clips.length > 1 && app.clips.reduce((t, i) => t + i.bytes, 0) > CLIP_TOTAL_BYTES) app.clips.pop();
}

/** The items for agents and the pane, newest first (ClipHistory::describe). */
export function clipDescribe(app) {
  return app.clips.map((it, i) => ({index: i, preview: clipPreview(it.text), chars: [...it.text].length, objects: (it.text.match(/￼/g) ?? []).length}));
}

function clipIndex(app, p) {
  if (!Number.isInteger(p.index) || p.index < 0 || p.index >= app.clips.length) {
    throw new CommandError('invalid_params', `no clipboard item ${p.index} (there are ${app.clips.length})`, {path: '/index'});
  }
  return p.index;
}
const hasClips = ctx => {
  const st = ready(ctx);
  if (!st.enabled) return st;
  return open(ctx).app.clips.length ? {enabled: true} : {enabled: false, reason: 'the Clipboard pane is empty'};
};

// ---- copy / cut ------------------------------------------------------------------------------------

/** Copy (copy): the fragment on the app's clipboard and in the Clipboard pane; {text, html?}. */
async function copyInto(ctx, S) {
  const [a, b] = ordered(S.sel);
  if (samePos(a, b)) return null;
  const frag = S.d.copyRange(a, b);
  const text = clipboardText(frag);
  clipPush(S.app, frag, text);
  const html = await fragmentHtml(frag);
  ctx.setClipboard({app: 'quill', fragment: frag, text, html});
  if (userOrigin(ctx) && typeof ctx.host?.clipboardWrite === 'function') {
    try { await ctx.host.clipboardWrite({text, html}); } catch { /* the app clipboard still has it */ }
  }
  const out = {text};
  if (html) out.html = html;
  return out;
}

/** The system clipboard's payload for a paste the person makes (the shell passes it upstream). */
async function systemClipboard(ctx, p) {
  if (!userOrigin(ctx) || p.text !== undefined || p.html !== undefined || p.rtf !== undefined) return p;
  if (typeof ctx.host?.clipboardRead !== 'function') return p;
  try {
    const got = await ctx.host.clipboardRead();
    const out = {...p};
    if (got?.text) out.text = got.text;
    if (got?.html) out.html = got.html;
    if (got?.rtf) out.rtf = got.rtf;
    if (got?.picture) out.picture = got.picture;
    return out;
  } catch { return p; }
}

/** Run an edit through the Session and commit it with the paste/edit bookkeeping. */
async function runEdit(ctx, f, {label = null} = {}) {
  const S = open(ctx);
  const out = await f(S);
  S.view.burstSel = null;
  noteEdit(ctx, S);
  const res = finish(ctx, S, {edit: true, result: out && typeof out === 'object' ? out : undefined});
  if (label) ctx.setUndoLabel(label);
  saveView(ctx, S);
  return res;
}

// ---- paste --------------------------------------------------------------------------------------------

async function paste(ctx, p) {
  if (p.as === 'picture') return ctx.run('edit.pasteSpecial', {...p, as: 'picture'});
  const q = await systemClipboard(ctx, p);
  const imp = await importers();
  return runEdit(ctx, async S => {
    const got = await pasteContent(S, q, imp);
    if (got.fragment) insertFragment(S, got.fragment);
    else insertPlainText(S, got.text);
  });
}

async function pasteMerge(ctx, p) {
  const q = await systemClipboard(ctx, p);
  const imp = await importers();
  return runEdit(ctx, async S => {
    const frag = mergeFormatting(S, await pasteFragment(S, q, imp));
    insertFragment(S, frag);
  });
}

async function pasteTextCmd(ctx, p) {
  let text = typeof p.text === 'string' ? p.text : null;
  if (text === null && userOrigin(ctx) && typeof ctx.host?.clipboardRead === 'function') {
    try { text = (await ctx.host.clipboardRead())?.text || null; } catch { text = null; }
    const own = ownClip(ctx);
    if (own && text !== null && own.text === text.replace(/\r\n/g, '\n')) text = plainText(own.fragment);
  }
  if (text === null) { const own = ownClip(ctx); text = own ? plainText(own.fragment) : ''; }
  if (!text) throw new CommandError('failed', 'the clipboard is empty');
  return runEdit(ctx, S => { pasteText(S, text.replace(/\r\n/g, '\r').replace(/\n/g, '\r')); });
}

/** Paste a collected item through the normal paste path; the clipboard stays as it was (paste_clip). */
function pasteClip(S, frag) {
  insertFragment(S, frag);
}

// ---- find and replace ------------------------------------------------------------------------------------

const FIND_OPTS = {
  matchCase: s.optional(s.boolean()), wholeWord: s.optional(s.boolean()), matchPrefix: s.optional(s.boolean()), matchSuffix: s.optional(s.boolean()),
  ignorePunct: s.optional(s.boolean()), ignoreSpace: s.optional(s.boolean()), wildcards: s.optional(s.boolean({description: 'Word\'s "Use wildcards"'})),
  special: s.optional(s.boolean({description: '^p ^t ^# … codes (default true)'})), regex: s.optional(s.boolean({description: 'A regular expression'})),
  // Find and Replace sends its whole state with every button (find_dialog `opts`), Replace with included.
  with: s.optional(s.string({max: 4096, description: 'Replace with (remembered for Replace)'})),
};
const TEXT = s.string({max: 1024 * 4});

function matchesJson(ctx, list) {
  return list.slice(0, 200).map(([a, b]) => ({start: posJson(ctx, a), end: posJson(ctx, b)}));
}

function find(ctx, p) {
  const S = open(ctx);
  readOpts(S.view.find, p);
  if (typeof p.text !== 'string') {
    // Word's Ctrl+F: the Navigation pane with its search box ready to type in.
    S.view.navPane = true;
    pushUi(S, {focus: 'navSearch'});
    return finish(ctx, S, {result: {count: S.view.find.count ?? 0, ui: S.ui}});
  }
  const story = S.sel.focus.story;
  const results = search(S.d, story, S.view.find);
  const idx = firstAtOrAfter(results, S.sel.focus);
  S.view.find.current = idx;
  S.view.find.count = results.length;
  if (results[idx]) S.sel = {anchor: results[idx][0], focus: results[idx][1]};
  return finish(ctx, S, {result: {count: results.length, matches: matchesJson(ctx, results)}});
}

function advancedFind(ctx, p) {
  const S = open(ctx);
  if (typeof p.text !== 'string' && p.highlight === undefined) {
    // No query: ask the front end for Find and Replace (upstream push_ui_request) and report the count.
    pushUi(S, {open: 'find'});
    finish(ctx, S);
    return {count: S.view.find.count ?? 0, ui: S.ui};
  }
  readOpts(S.view.find, p);
  const where = p.in ?? 'main';
  let within = null;
  if (where === 'selection') {
    if (isCollapsed(S.sel)) throw new CommandError('invalid_params', '`in: selection` needs a selection', {path: '/in'});
    within = ordered(S.sel);
  }
  const story = within ? within[0].story : 'body';
  let found = search(S.d, story, S.view.find);
  if (within) found = found.filter(([x, y]) => cmpGE(x, within[0]) && cmpGE(within[1], y));
  if (typeof p.highlight === 'boolean') S.view.find.highlight = p.highlight;
  S.view.find.highlights = S.view.find.highlight
    ? found.slice(0, MAX_HIGHLIGHTS).map(([a, b]) => [ctx.model.addressOf(ctx, a), ctx.model.addressOf(ctx, b)]) : null;
  S.view.find.current = 0;
  S.view.find.count = found.length;
  // What Find and Replace says after Reading Highlight (find_dialog).
  if (typeof p.highlight === 'boolean') S.view.status = p.highlight ? `${found.length} items highlighted` : '';
  saveView(ctx, S);
  return {count: found.length, matches: matchesJson(ctx, found), highlight: !!S.view.find.highlight};
}
const cmpGE = (x, y) => !(ordered({anchor: x, focus: y})[0] === x && !samePos(x, y));

/** Find Next / Previous (step). */
function step(S, dir) {
  const story = S.sel.focus.story;
  const results = search(S.d, story, S.view.find);
  const n = results.length;
  if (!n) throw new CommandError('failed', 'no matches');
  const [a, b] = ordered(S.sel);
  const idx = dir > 0 ? firstAtOrAfter(results, b) : lastAtOrBefore(results, a);
  S.view.find.current = idx;
  S.view.find.count = n;
  S.sel = {anchor: results[idx][0], focus: results[idx][1]};
  // What Find and Replace says after Find Next (find_dialog).
  S.view.status = `Match ${idx + 1} of ${n}`;
  return {index: idx, count: n};
}

function findStep(ctx, p, dir) {
  const S = open(ctx);
  readOpts(S.view.find, p);
  const r = step(S, dir);
  return finish(ctx, S, {result: r});
}

function replace(ctx, p) {
  return runEditSync(ctx, S => {
    needQuery(S.view.find, p);
    readOpts(S.view.find, p);
    const story = S.sel.focus.story;
    const results = searchFull(S.d, story, S.view.find, {withRep: true, clipboardText: ownClip(ctx)?.text ?? ''});
    const [a, b] = ordered(S.sel);
    const hit = results.find(f => samePos(f.a, a) && samePos(f.b, b));
    if (hit) pasteText(S, hit.rep ?? '');
    try { step(S, 1); } catch { /* no more matches */ }
    return {remaining: search(S.d, story, S.view.find).length};
  });
}

function replaceAll(ctx, p) {
  return runEditSync(ctx, S => {
    needQuery(S.view.find, p);
    readOpts(S.view.find, p);
    const story = S.sel.focus.story;
    const results = searchFull(S.d, story, S.view.find, {withRep: true, clipboardText: ownClip(ctx)?.text ?? ''});
    const n = results.length;
    checkDeletions(S, story, results.map(f => [f.a, f.b]));
    for (const {a, b, rep} of [...results].reverse()) {
      const withText = rep ?? '';
      if (trackChanges(S)) {
        S.sel = {anchor: a, focus: b};
        pasteText(S, withText);
        continue;
      }
      // Replacing a symbol gives the new text the symbol's formatting, not its own font.
      const para = S.d.paraAt(a);
      const props = para ? charWithoutSymbol(P.propsOfChar(para, a.off) ?? {}) : {};
      let pos = S.d.deleteRange(a, b);
      withText.split(/[\r\u2029]/).forEach((part, k) => {
        if (k > 0) pos = S.d.splitParagraph(pos);
        if (part) pos = S.d.insertText(pos, part, props);
      });
    }
    S.view.status = `All done. We made ${n} replacements.`;
    return {replaced: n};
  }, {label: 'Replace All'});
}

/** runEdit for synchronous bodies (kernel commands may be sync). */
function runEditSync(ctx, f, {label = null} = {}) {
  const S = open(ctx);
  const out = f(S);
  S.view.burstSel = null;
  const res = finish(ctx, S, {edit: true, result: out && typeof out === 'object' ? out : undefined});
  noteEdit(ctx, S);
  if (label) ctx.setUndoLabel(label);
  saveView(ctx, S);
  return res;
}

// ---- Go To / Go Back ------------------------------------------------------------------------------------

/** The text of a bookmark: from just after its start mark to its end mark (bookmark_range / bookmark_span). */
export function bookmarkRange(d, name) {
  const hit = d.bookmarks().find(([n]) => n === name);
  if (!hit) return null;
  const start = hit[1];
  const from = at(start, start.off + 1);
  const paths = d.paraPaths(start.story);
  const i0 = paths.findIndex(q => q.length === start.path.length && q.every((v, k) => v === start.path[k]));
  for (let i = Math.max(i0, 0); i < paths.length; i++) {
    const para = d.para(start.story, paths[i]);
    if (!para) continue;
    for (const [off, o] of P.objectsWithOffsets(para)) {
      if ((i !== i0 || off > start.off) && o.type === 'bookmarkEnd' && o.name === name) return [from, {story: start.story, path: paths[i], off}];
    }
  }
  return [from, from];
}

function goto(ctx, p) {
  const S = open(ctx);
  let page = null;
  if (Number.isInteger(p.pageBy)) {
    const here = S.layout()?.caret(S.sel.focus, S.view.pageHint)?.page ?? 0;
    page = Math.max(here + 1 + p.pageBy, 1);
  } else if (Number.isInteger(p.page)) page = p.page;
  if (page !== null) {
    const l = S.layout();
    const idx = Math.min(Math.max(page, 1) - 1, Math.max((l?.pages.length ?? 1) - 1, 0));
    const pg = l?.pages[idx];
    const it = pg?.items.find(x => x.kind === 'lines' && x.story === 'body');
    if (it) {
      const ln = it.para.lines[it.l0];
      if (ln) { S.sel = caret({story: 'body', path: [...it.path], off: ln.start}); S.view.pageHint = idx; }
    }
    pushUi(S, {scrollTo: 'caret'});
    return finish(ctx, S);
  }
  if (typeof p.bookmark === 'string') {
    if (p.bookmark === '_top') { S.sel = caret({story: 'body', path: [0], off: 0}); S.sel = caret(S.d.clamp(S.sel.focus)); return finish(ctx, S); }
    const r = bookmarkRange(S.d, p.bookmark);
    if (!r) throw new CommandError('failed', `no bookmark \`${p.bookmark}\``);
    S.sel = {anchor: r[0], focus: r[1]};
    return finish(ctx, S);
  }
  if (Number.isInteger(p.paragraph)) {
    const paths = S.d.paraPaths('body');
    const path = paths[Math.max(p.paragraph, 1) - 1];
    if (path) S.sel = caret({story: 'body', path, off: 0});
    return finish(ctx, S);
  }
  pushUi(S, {open: 'goto'});
  return finish(ctx, S);
}

function goBack(ctx) {
  const S = open(ctx);
  const marks = S.view.editMarks ?? [];
  const n = marks.length;
  let target = null;
  for (let k = 0; k < n && !target; k++) {
    const i = n - 1 - ((S.view.goBackStep ?? 0) % n);
    S.view.goBackStep = (S.view.goBackStep ?? 0) + 1;
    let pos;
    try { pos = S.d.clamp(ctx.model.position(ctx, marks[i])); } catch { continue; }
    if (!samePos(pos, S.sel.focus) || n === 1) target = pos;
  }
  if (!target && n) { try { target = S.d.clamp(ctx.model.position(ctx, marks[n - 1])); } catch { target = null; } }
  if (!target) throw new CommandError('failed', 'no edits to go back to yet');
  S.sel = caret(target);
  S.view.goalX = null;
  return finish(ctx, S);
}

// ---- Format Painter ---------------------------------------------------------------------------------------

/** Pick up the formatting at the selection's start (painter_pick). */
function painterPick(S) {
  const [f] = ordered(S.sel);
  const para = S.d.paraAt(f);
  const chr = para ? charWithoutSymbol(P.propsOfChar(para, f.off) ?? {}) : {};
  S.view.painter = {chr, para: {...(para?.props ?? {})}, sticky: false};
}

function painter(ctx, p) {
  const S = open(ctx);
  if (S.view.painter) { S.view.painter = null; finish(ctx, S); return {active: false}; }
  painterPick(S);
  S.view.painter.sticky = !!p.sticky;
  finish(ctx, S);
  return {active: true};
}

function pasteFormat(ctx) {
  return runEditSync(ctx, S => {
    const pt = S.view.painter;
    if (!pt) throw new CommandError('failed', 'no formatting copied');
    const {chr, para} = pt;
    const [a, b] = ordered(S.sel);
    const setPara = () => S.d.formatParagraphs(a, b, () => ({...para}));
    if (samePos(a, b)) {
      // No selection: paragraph formatting, and the word's formatting like Word.
      const pp = S.d.paraAt(S.sel.focus);
      if (pp) {
        const [x, y] = P.wordAt(pp, S.sel.focus.off);
        S.d.formatRange(at(S.sel.focus, x), at(S.sel.focus, y), c => charOverlaid(charCleared(c), chr));
      }
      setPara();
    } else {
      S.d.formatRange(a, b, c => { const link = c.link; const out = charOverlaid(charCleared(c), chr); if (link !== undefined) out.link = link; else delete out.link; return out; });
      if (a.story !== b.story || a.path.join('.') !== b.path.join('.') || a.off === 0) setPara();
    }
    if (!pt.sticky) S.view.painter = null;
  }, {label: 'Paste Formatting'});
}

// ---- commands --------------------------------------------------------------------------------------------

const clipPaste = s.object({text: s.optional(TEXT.max ? s.string({max: 16 << 20}) : TEXT), html: s.optional(s.string({max: 16 << 20})), rtf: s.optional(s.string({max: 16 << 20}))});

export default defineCommands({
  family: 'edit',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'edit.cut', label: 'Cut', shortcut: 'Mod+X', risk: 'edit', description: 'Cut the selection to the clipboard (a tracked cut of a paragraph or sentence becomes a move when pasted).',
      params: s.object({}), state: hasSel,
      async run(ctx) {
        let r = null;
        const res = await runEdit(ctx, async S => {
          r = await copyInto(ctx, S);
          if (!r) throw new CommandError('disabled', 'edit.cut: nothing is selected');
          if (!cutTracked(S, r.text)) deleteSelection(S);
          restorePlaceholder(S);
        });
        return {...res, ...r};
      },
    },
    {
      id: 'edit.copy', label: 'Copy', shortcut: ['Mod+C', 'Mod+Insert'], risk: 'read', effect: 'view',
      description: 'Copy the selection to the clipboard and the Clipboard pane; returns its text (and HTML).',
      params: s.object({}), state: ctx => ready(ctx),
      async run(ctx) {
        const S = open(ctx);
        const r = await copyInto(ctx, S);
        return r ?? {text: ''};
      },
    },
    {
      id: 'edit.spike', label: 'Spike', shortcut: 'Mod+F3', risk: 'edit', description: 'Cut the selection to the end of the Spike (the clipboard is left alone).',
      params: s.object({}), state: hasSel,
      run: ctx => runEditSync(ctx, S => {
        const [a, b] = ordered(S.sel);
        if (samePos(a, b)) throw new CommandError('disabled', 'edit.spike: nothing is selected');
        const piece = S.d.copyRange(a, b);
        if (!piece.blocks.length) throw new CommandError('disabled', "edit.spike: this selection can't be collected");
        deleteSelection(S);
        restorePlaceholder(S);
        const cur = S.app.buildingBlocks.get(SPIKE);
        S.app.buildingBlocks.set(SPIKE, cur ? appendFragment(cur, piece) : appendFragment({blocks: [], parts: {}}, piece));
      }),
    },
    {
      id: 'edit.insertSpike', label: 'Insert Spike', shortcut: 'Mod+Shift+F3', risk: 'edit', description: 'Insert everything the Spike collected, in order, and empty it.',
      params: s.object({}),
      state: ctx => { const st = ready(ctx); if (!st.enabled) return st; return open(ctx).app.buildingBlocks.has(SPIKE) ? {enabled: true} : {enabled: false, reason: 'the Spike is empty'}; },
      run: ctx => runEditSync(ctx, S => {
        const frag = S.app.buildingBlocks.get(SPIKE);
        if (!frag) throw new CommandError('disabled', 'edit.insertSpike: the Spike is empty');
        insertFragment(S, frag);
        S.app.buildingBlocks.delete(SPIKE);
      }),
    },
    {
      id: 'edit.paste', label: 'Paste', shortcut: ['Mod+V', 'Shift+Insert'], risk: 'edit',
      description: 'Paste, keeping the source formatting: our own copy while the clipboard holds it, else another program\'s HTML or RTF, else the text (as Keep Text Only).',
      params: s.object({text: s.optional(s.string({max: 16 << 20})), html: s.optional(s.string({max: 16 << 20})), rtf: s.optional(s.string({max: 16 << 20})),
        picture: s.optional(s.string({max: 96 << 20})), as: s.optional(s.enum(['formatted', 'picture'], {description: 'Keep Source Formatting (default) or Picture'}))}),
      state: ctx => ready(ctx),
      run: (ctx, p) => paste(ctx, p),
    },
    {
      id: 'edit.pasteText', label: 'Paste: Keep Text Only', shortcut: 'Mod+Shift+Alt+V', risk: 'edit',
      description: 'Paste the clipboard as plain text in the formatting at the caret.',
      params: s.object({text: s.optional(s.string({max: 16 << 20}))}), state: ctx => ready(ctx),
      run: (ctx, p) => pasteTextCmd(ctx, p),
    },
    {
      id: 'edit.pasteMerge', label: 'Paste: Merge Formatting', risk: 'edit',
      description: 'Paste taking the formatting where it lands, keeping only bold, italic, underline, strikethrough and links.',
      params: clipPaste, state: ctx => ready(ctx),
      run: (ctx, p) => pasteMerge(ctx, p),
    },
    {
      id: 'edit.clipboardPane', label: 'Clipboard Pane', risk: 'read', effect: 'view', description: 'Show or hide the Clipboard pane (Home › Clipboard).',
      params: s.object({value: s.optional(s.boolean())}), state: ctx => { const st = ready(ctx); return st.enabled ? {enabled: true, checked: !!viewState(ctx).clipboardPane} : st; },
      run(ctx, p) {
        const S = open(ctx);
        const on = p.value ?? !S.view.clipboardPane;
        S.view.clipboardPane = on;
        finish(ctx, S);
        return {value: on, count: S.app.clips.length};
      },
    },
    {
      id: 'edit.clipboardItems', label: 'Clipboard Items', risk: 'read', description: 'The items Copy and Cut collected, newest first.',
      params: s.object({}), state: ctx => ready(ctx), run: ctx => clipDescribe(open(ctx).app),
    },
    {
      id: 'edit.pasteClipboardItem', label: 'Paste Clipboard Item', risk: 'edit', description: 'Paste one collected item (0 = newest); the clipboard stays as it was.',
      params: s.object({index: s.integer({min: 0, description: '0 = newest'})}), state: hasClips,
      run: (ctx, p) => runEditSync(ctx, S => { const i = clipIndex(S.app, p); pasteClip(S, S.app.clips[i].fragment); }),
    },
    {
      id: 'edit.pasteAllClipboard', label: 'Paste All', risk: 'edit', description: 'Paste every collected item in the order they were copied (one undo step).',
      params: s.object({}), state: hasClips,
      run: ctx => runEditSync(ctx, S => { for (const it of [...S.app.clips].reverse()) pasteClip(S, it.fragment); }),
    },
    {
      id: 'edit.deleteClipboardItem', label: 'Delete Clipboard Item', risk: 'read', effect: 'view', description: 'Remove one item from the Clipboard pane.',
      params: s.object({index: s.integer({min: 0, description: '0 = newest'})}), state: hasClips,
      run(ctx, p) { const app = open(ctx).app; app.clips.splice(clipIndex(app, p), 1); return clipDescribe(app); },
    },
    {
      id: 'edit.clearClipboard', label: 'Clear All', risk: 'read', effect: 'view', description: 'Empty the Clipboard pane.',
      params: s.object({}), state: ctx => ready(ctx),
      run(ctx) { const app = open(ctx).app; app.clips.length = 0; return clipDescribe(app); },
    },
    {
      id: 'edit.find', label: 'Find', shortcut: 'Mod+F', risk: 'read', effect: 'view',
      description: 'Find text and select the first match after the caret; without text, the Navigation pane\'s search box.',
      params: s.object({text: s.optional(TEXT), ...FIND_OPTS}), state: ctx => ready(ctx),
      run: (ctx, p) => find(ctx, p),
    },
    {
      id: 'edit.advancedFind', label: 'Advanced Find', risk: 'read', effect: 'view', dialog: 'dialog.find',
      description: 'Every match in the main document or the selection, optionally marked with Reading Highlight; without text, the Find and Replace dialog.',
      params: s.object({text: s.optional(TEXT), ...FIND_OPTS, in: s.optional(s.enum(['main', 'selection'])), highlight: s.optional(s.boolean())}),
      state: ctx => ready(ctx), run: (ctx, p) => advancedFind(ctx, p),
    },
    {
      id: 'edit.findNext', label: 'Find Next', shortcut: ['Mod+G', 'F3', 'Shift+F4', 'Mod+PageDown'], risk: 'read', effect: 'view',
      description: 'Select the next match of the last search (or of `text`).', params: s.object({text: s.optional(TEXT), ...FIND_OPTS}), state: ctx => ready(ctx),
      run: (ctx, p) => findStep(ctx, p, 1),
    },
    {
      id: 'edit.findPrevious', label: 'Find Previous', shortcut: 'Mod+PageUp', risk: 'read', effect: 'view',
      description: 'Select the previous match of the last search (or of `text`).', params: s.object({text: s.optional(TEXT), ...FIND_OPTS}), state: ctx => ready(ctx),
      run: (ctx, p) => findStep(ctx, p, -1),
    },
    {
      id: 'edit.replace', label: 'Replace', risk: 'edit', dialog: 'dialog.find',
      description: 'Replace the selected match and select the next one.',
      params: s.object({text: s.optional(TEXT), with: s.optional(s.string({max: 4096})), ...FIND_OPTS}), state: ctx => ready(ctx),
      run: (ctx, p) => replace(ctx, p),
    },
    {
      id: 'edit.findReplace', label: 'Find and Replace', shortcut: 'Mod+H', risk: 'read', effect: 'view', dialog: 'dialog.find',
      description: 'The Find and Replace dialog on its Find, Replace (default) or Go To tab.',
      params: s.object({tab: s.optional(s.enum(['find', 'replace', 'goto']))}), state: ctx => ready(ctx),
      run: (ctx, p) => ({open: p.tab ?? 'replace'}),
    },
    {
      id: 'edit.replaceAll', label: 'Replace All', risk: 'edit',
      description: 'Replace every match (^p ^t ^& ^c codes; \\1 with wildcards; $1 ${name} with regular expressions) as one undo step.',
      params: s.object({text: s.optional(TEXT), with: s.optional(s.string({max: 4096})), ...FIND_OPTS}), state: ctx => ready(ctx),
      run: (ctx, p) => replaceAll(ctx, p),
    },
    {
      id: 'edit.goto', label: 'Go To', shortcut: ['Mod+Alt+G', 'F5'], risk: 'read', effect: 'view', dialog: 'dialog.find',
      description: 'Go to a page (or pages forward/back from the caret\'s), a bookmark (its text selected) or a paragraph; none opens Go To.',
      params: s.object({page: s.optional(s.integer({min: 1})), pageBy: s.optional(s.integer()), bookmark: s.optional(s.string({max: 255})), paragraph: s.optional(s.integer({min: 1}))}),
      state: ctx => ready(ctx), run: (ctx, p) => goto(ctx, p),
    },
    {
      id: 'edit.goBack', label: 'Go Back', shortcut: ['Shift+F5', 'Mod+Alt+Z'], risk: 'read', effect: 'view',
      description: 'Move the caret to the places of the last edits in turn.', params: s.object({}), state: ctx => ready(ctx),
      run: ctx => goBack(ctx),
    },
    {
      id: 'edit.formatPainter', label: 'Format Painter', risk: 'read', effect: 'view',
      description: 'Pick up the formatting at the selection to paint onto the next selection (sticky: until turned off).',
      params: s.object({sticky: s.optional(s.boolean())}),
      state: ctx => { const st = ready(ctx); return st.enabled ? {enabled: true, checked: !!ctx.view?.painter} : st; },
      run: (ctx, p) => painter(ctx, p),
    },
    {
      id: 'edit.copyFormat', label: 'Copy Formatting', shortcut: 'Mod+Shift+C', risk: 'read', effect: 'view',
      description: 'Pick up the formatting at the selection (as the Format Painter does).', params: s.object({}), state: ctx => ready(ctx),
      run(ctx) { const S = open(ctx); painterPick(S); return finish(ctx, S); },
    },
    {
      id: 'edit.pasteFormat', label: 'Paste Formatting', shortcut: 'Mod+Shift+V', risk: 'edit',
      description: 'Apply the formatting the Format Painter picked up to the selection (or the word at the caret).', params: s.object({}),
      state: ctx => { const st = ready(ctx); if (!st.enabled) return st; return ctx.view?.painter ? {enabled: true} : {enabled: false, reason: 'no formatting copied'}; },
      run: ctx => pasteFormat(ctx),
    },
  ],
});

void prepareEdit; void layoutFor;
