// The leftovers of the Word tabs that follow Office's own behaviour (U:quill/rest): Remove Page Numbers and
// Remove Current Cover Page (Insert), Delete All Ink in Document (Review), the View tab's Hide White Space,
// Interface Theme and the Immersive Reader's Line Focus, Syllables and Read Aloud.
//
// Not checked against upstream: wordcraft catalogues none of these as commands (it has view.hideWhiteSpace and
// view.interfaceTheme specs without the page geometry or the shell setting they need), so each one follows what Word
// does. They are the document view or an edit of the document like their neighbours: Remove Page Numbers takes the
// PAGE, NUMPAGES and SECTIONPAGES fields out of every header and footer (and the "Page" and "of" words a "Page X of Y"
// number leaves), Remove Current Cover Page takes the first page away when it is a cover page (a Title-styled paragraph
// on a first page that ends in a page break), Delete All Ink in Document removes every ink stroke (shapes drawn by
// other means stay).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/table-session.mjs';
import * as P from '../model/para.mjs';
import {BODY, cmpPos} from '../model/document.mjs';
import {deleteObject} from '../lib/draw-ink.mjs';
import {viewOf} from '../lib/view-layout.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/view.rs']};
const NONE = s.object({});
const failed = m => new CommandError('failed', m);
const ready = T.ready;

// ---- Insert › Page Number › Remove Page Numbers -----------------------------------------------------

const PAGE_FIELD = /^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/i;
const FILLER = /^[\s]*(page)?[\s]*(of)?[\s]*$/i;

/** Every header and footer has no page number field left; "Page" and "of" words alone are cleared with them. */
function removePageNumbers(ctx) {
  const S = T.open(ctx);
  let removed = 0;
  for (const key of Object.keys(S.d.c.parts).map(Number)) {
    const part = S.d.c.parts[key];
    if (part.kind !== 'header' && part.kind !== 'footer') continue;
    for (const path of S.d.paraPaths(key)) {
      const probe = S.d.para(key, path);
      const at = P.objectsWithOffsets(probe).filter(([, o]) => o?.type === 'field' && PAGE_FIELD.test(o.instr ?? '')).map(([off]) => off);
      if (!at.length) continue;
      const p = S.d.paraMut(key, path);
      for (const off of at.reverse()) { P.deleteRange(p, off, off + 1); removed++; }
      if (FILLER.test(p.text) && p.text.length) P.deleteRange(p, 0, p.text.length);
    }
  }
  return T.finish(S, {removed});
}

// ---- Insert › Cover Page › Remove Current Cover Page --------------------------------------------------

/** The blocks the cover page takes: up to and with the paragraph holding the first page break, when a Title comes before it. */
function coverBlocks(d) {
  const bl = d.story(BODY);
  const n = Math.min(bl.len(), 60);
  let sawTitle = false;
  for (let i = 0; i < n; i++) {
    const b = bl.get(i);
    if (b.kind !== 'para') return 0;
    if (b.props?.style === 'Title') sawTitle = true;
    if (b.text.includes(P.PAGE_BREAK)) return sawTitle ? i + 1 : 0;
  }
  return 0;
}

function removeCoverPage(ctx) {
  const S = T.open(ctx);
  const count = coverBlocks(S.d);
  if (!count) throw failed('this document has no cover page');
  const bl = S.d.storyMut(BODY);
  const total = bl.len();
  if (count >= total) {
    // The cover page was the whole body: what is left is one empty paragraph.
    bl.splice(0, total, [P.newParagraph(S.d.newId())]);
  } else bl.splice(0, count);
  T.setCaret(S, S.d.startOf(BODY));
  return T.finish(S, {removed: count});
}

function coverState(ctx) {
  const r = ready(ctx);
  if (!r.enabled) return r;
  return coverBlocks(ctx.model.open(ctx)) ? {enabled: true} : {enabled: false, reason: 'the document has no cover page'};
}

// ---- Review › Ink › Delete All Ink in Document ---------------------------------------------------------

function deleteAllInk(ctx) {
  const S = T.open(ctx);
  let deleted = 0;
  for (const key of [BODY, ...Object.keys(S.d.c.parts).map(Number)]) {
    for (const path of S.d.paraPaths(key)) {
      const probe = S.d.para(key, path);
      const at = P.objectsWithOffsets(probe).filter(([, o]) => o?.type === 'shape' && o.freeform?.ink).map(([off]) => off);
      for (const off of at.reverse()) { deleteObject(S, {story: key, path, off}); deleted++; }
    }
  }
  if (!deleted) throw failed('there is no ink in the document');
  return T.finish(S, {deleted});
}

// ---- Review › Speech › Read Aloud ------------------------------------------------------------------------

// The operating system's own speech (the Web Speech API's local voices): nothing is sent anywhere, so a machine with
// no offline voice has no Read Aloud (the control stays off). One reading at a time; it ends when the text does.
const synth = () => globalThis.speechSynthesis ?? null;
const localVoices = () => { try { return (synth()?.getVoices?.() ?? []).filter(v => v.localService); } catch { return []; } };
const speaking = () => { const x = synth(); return !!(x && (x.speaking || x.pending)); };
const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** What is read between two positions of the body: the selection, or from the caret to the end of the body when they are one point. */
export function readText(d, anchor, focus) {
  const [a, b] = cmpPos(anchor, focus) <= 0 ? [anchor, focus] : [focus, anchor];
  const same = cmpPos(a, b) === 0;
  const out = [];
  let started = false;
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    const isA = samePath(a.path, path), isB = samePath(b.path, path);
    if (!started && !isA) continue;
    started = true;
    const text = P.finalText(p).split(P.OBJ).join('');
    out.push(text.slice(isA ? Math.min(a.off, text.length) : 0, !same && isB ? Math.min(b.off, text.length) : text.length));
    if (!same && isB) break;
  }
  return out.join('\n').trim();
}

function readAloud(ctx, p) {
  const x = synth();
  const on = typeof p.value === 'boolean' ? p.value : !speaking();
  if (!on) { x?.cancel?.(); return {speaking: false}; }
  const text = textToRead(ctx);
  if (!text) throw failed('there is nothing to read');
  const u = new globalThis.SpeechSynthesisUtterance(text.slice(0, 200_000));
  const voices = localVoices();
  const lang = String(ctx.prefs?.language ?? globalThis.navigator?.language ?? 'en-US').toLowerCase();
  u.voice = voices.find(v => v.lang?.toLowerCase() === lang) ?? voices.find(v => v.lang?.toLowerCase().startsWith(lang.slice(0, 2))) ?? voices.find(v => v.default) ?? voices[0];
  if (u.voice) u.lang = u.voice.lang;
  x.cancel();
  x.speak(u);
  return {speaking: true, characters: text.length, voice: u.voice?.name ?? null};
}

function readAloudState(ctx) {
  const r = ready(ctx);
  if (!r.enabled) return r;
  if (!synth() || typeof globalThis.SpeechSynthesisUtterance !== 'function') return {enabled: false, reason: 'speech is not available here'};
  if (!localVoices().length) return {enabled: false, reason: 'no voice is installed on this computer'};
  return {enabled: true, checked: speaking()};
}

// ---- View: Hide White Space, Interface Theme, Immersive Reader ------------------------------------------

const toggle = key => (ctx, p) => {
  const on = typeof p.value === 'boolean' ? p.value : !viewOf(ctx.view)[key];
  ctx.setView({[key]: on});
  return {value: on};
};
const toggleState = key => ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: !!viewOf(ctx.view)[key]} : r; };
const VALUE = s.object({value: s.optional(s.boolean())});

/** Line Focus: how many lines the Immersive Reader keeps lit (None 0, One, Three, Five); every other line is dimmed. */
export const LINE_FOCUS = Object.freeze({none: 0, one: 1, three: 3, five: 5});
/** Interface Theme: light, dark, or follow the system. */
export const THEMES = Object.freeze(['system', 'light', 'dark']);

const immersiveOnly = ctx => {
  const r = ready(ctx);
  if (!r.enabled) return r;
  return viewOf(ctx.view).immersive ? {enabled: true} : {enabled: false, reason: 'only in the Immersive Reader'};
};

// ---- Layout › Arrange › Align › Grid Settings --------------------------------------------------------------

/** Drawing Grid: the grid the page view draws with View › Gridlines (the document's horizontal and vertical spacing, in points) and whether it is on. */
function gridSettings(ctx, p) {
  const S = T.open(ctx);
  const ok = v => Number.isFinite(v) && v >= 0.5 && v <= 1584;
  for (const k of ['gridH', 'gridV']) if (p[k] !== undefined && !ok(p[k])) throw new CommandError('invalid_params', `\`${k}\` is 0.5 to 1584 points`);
  if (p.gridH !== undefined || p.gridV !== undefined) S.d.updateField('settings', x => { if (p.gridH !== undefined) x.gridH = p.gridH; if (p.gridV !== undefined) x.gridV = p.gridV; });
  if (typeof p.gridlines === 'boolean') ctx.setView({gridlines: p.gridlines});
  const st = S.d.c.settings ?? {};
  return T.finish(S, {gridH: st.gridH, gridV: st.gridV, gridlines: typeof p.gridlines === 'boolean' ? p.gridlines : !!viewOf(ctx.view).gridlines});
}

// ---- Review › Tracking › Track Changes › Lock Tracking -------------------------------------------------------

/**
 * Lock Tracking: Track Changes is turned on and the document is restricted to tracked changes (Restrict Editing's "Tracked changes" without a
 * password: add one in the Restrict Editing pane, where Stop Protection asks for it); used again it stops that protection (`password` when one guards it).
 */
async function lockTracking(ctx, p) {
  const locked = ctx.doc?.settings?.protection === 'trackedChanges';
  if (locked || p.stop) return ctx.run('review.restrict', {stop: true, ...(p.password ? {password: p.password} : {})});
  const S = T.open(ctx);
  if (!S.d.c.settings?.trackChanges) { S.d.updateField('settings', x => { x.trackChanges = true; }); T.finish(S); }
  return ctx.run('review.restrict', {mode: 'trackedChanges', ...(p.password ? {password: p.password} : {})});
}

export default defineCommands({
  family: 'rest',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.removePageNumbers', label: 'Remove Page Numbers', risk: 'edit', state: ready,
      description: 'Remove Page Numbers (Insert › Page Number): the page number fields (PAGE, NUMPAGES, SECTIONPAGES) are taken out of every header and footer. Not checked against upstream.',
      params: NONE, run: removePageNumbers},
    {id: 'insert.removeCoverPage', label: 'Remove Current Cover Page', risk: 'edit', state: coverState,
      description: 'Remove Current Cover Page (Insert › Cover Page): the first page goes when it is a cover page (a Title paragraph on a first page that ends in a page break). Not checked against upstream.',
      params: NONE, run: removeCoverPage},
    {id: 'review.deleteAllInk', label: 'Delete All Ink in Document', risk: 'edit', state: ready,
      description: 'Delete All Ink in Document (Review › Ink): every ink stroke is deleted, even while ink is hidden; other shapes stay. Not checked against upstream.',
      params: NONE, run: deleteAllInk},
    {id: 'review.readAloud', label: 'Read Aloud', risk: 'read', effect: 'view', shortcut: 'Mod+Alt+Space', state: readAloudState,
      description: 'Read Aloud (Review › Speech): the selection, or the text from the caret on, spoken with an offline voice of this computer (the Web Speech API\'s local voices; nothing is sent anywhere); `value` false stops it. Not checked against upstream.',
      params: VALUE, run: readAloud},
    {id: 'layout.gridSettings', label: 'Grid Settings', risk: 'edit', dialog: 'dialog.gridSettings', state: ready,
      description: 'Grid Settings (Layout › Arrange › Align): the drawing grid: `gridH` and `gridV` the horizontal and vertical spacing in points (0.5 to 1584; saved as w:drawingGridHorizontalSpacing and w:drawingGridVerticalSpacing), `gridlines` whether the page view draws it (View › Gridlines). Not checked against upstream.',
      params: s.object({gridH: s.optional(s.number()), gridV: s.optional(s.number()), gridlines: s.optional(s.boolean())}), run: gridSettings},
    {id: 'review.lockTracking', label: 'Lock Tracking', risk: 'edit',
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: ctx.doc?.settings?.protection === 'trackedChanges'} : r; },
      description: 'Lock Tracking… (Review › Track Changes): turns Track Changes on and restricts editing to tracked changes (Restrict Editing, no password); used again it stops that protection (`stop`, with the `password` when one guards it). Not checked against upstream.',
      params: s.object({stop: s.optional(s.boolean()), password: s.optional(s.secret({max: 255}))}), run: lockTracking},
    {id: 'view.hideWhiteSpace', label: 'Hide White Space', risk: 'read', effect: 'view', state: toggleState('hideWhiteSpace'),
      description: 'Hide White Space (View › Show): in Print Layout the margins, headers and footers between pages collapse into a thin divider; `value` sets it. Not checked against upstream.',
      params: VALUE, run: toggle('hideWhiteSpace')},
    {id: 'view.interfaceTheme', label: 'Interface Theme', risk: 'read', effect: 'prefs',
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, value: ctx.prefs?.interfaceTheme ?? 'system'} : r; },
      description: 'Interface Theme (View › Dark Mode): `value` system, light or dark; the window around the pages follows it. Not checked against upstream.',
      params: s.object({value: s.enum([...THEMES])}),
      run(ctx, p) { ctx.updatePrefs({interfaceTheme: p.value}); return {value: p.value}; }},
    {id: 'view.lineFocus', label: 'Line Focus', risk: 'read', effect: 'view',
      state: ctx => { const st = immersiveOnly(ctx); return st.enabled ? {...st, value: viewOf(ctx.view).lineFocus} : st; },
      description: 'Line Focus (Immersive Reader): `value` none, one, three or five lines stay lit and the rest of the page dims; arrow keys move the lit lines. Not checked against upstream.',
      params: s.object({value: s.enum(Object.keys(LINE_FOCUS))}),
      run(ctx, p) { ctx.setView({lineFocus: LINE_FOCUS[p.value]}); return {lines: LINE_FOCUS[p.value]}; }},
  ],
});
