// Review tab (U:quill/review): Proofing (Thesaurus, Word Count), Language, Comments (New, Reply,
// Edit, Delete, Resolve, Previous/Next, Show Comments), Tracking (Track Changes For Everyone /
// Just Mine, Display for Review, Show Markup, Track Changes Options, Reviewing Pane), Changes
// (Accept, Reject, Previous/Next), Compare / Combine and Protect (Restrict Editing).
//
// Translated from wordcraft crates/engine/src/cmd/review.rs (`specs`), review/comments.rs,
// review/changes.rs, review/proofing.rs (`word_count`, `thesaurus`), crates/engine/src/cmd/protect.rs
// (`review.restrict`), crates/engine/src/cmd/tools/specs.rs (`review.compare`, `review.combine`,
// `review.language`, `review.showMarkup`, `file.protect`), tools/compare.rs, tools/actions.rs
// (`language`) and crates/engine/src/cmd/view.rs (`view.commentsPane`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The engine lives in core/quill/lib/review-*.mjs; enforcement of Restrict Editing and recording
// of tracked formatting run around every command in core/quill/hooks.mjs. View state (Display for
// Review, the panes, Just Mine) is the document view's; Track Changes Options are the person's
// preferences (`prefs.markup`), as upstream. Spelling & Grammar (the proof crate's dictionaries and
// squiggles) and Block Authors (no upstream engine) are not here, so their controls stay hidden.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {open, finish, ready, author as authorOf, isoSeconds, ordered, caret, samePos, cmpPos, layoutFor, UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import * as P from '../model/para.mjs';
import {comment as newCommentRecord, contentFromText, isQuill2} from '../model/content.mjs';
import {Document, BODY} from '../model/document.mjs';
import {commentsLocked, freeCommentId, initialsOf, commentAtCaret, removeAnchors, threadOf, listComments, navComment} from '../lib/review-comments.mjs';
import {resolveAll, resolveSelection, navChange, listChanges, changes as changeList} from '../lib/review-changes.mjs';
import {markupOf, applyTrackingOptions, trackingJson, markupView, MARKUP_VIEWS} from '../lib/review-markup.mjs';
import {wordCount, wordAtCaret, synonyms, normalizeTag, LANGUAGES} from '../lib/review-proofing.mjs';
import {compareOptions, compareBlocks} from '../lib/review-compare.mjs';
import {MODES, protectState, enforced, editingRestricted, stopProtection, protectionHash, addException, removeExceptions, nextRegion, DEFAULT_SPIN_COUNT} from '../lib/review-protect.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/review.rs', 'crates/engine/src/cmd/review/comments.rs',
  'crates/engine/src/cmd/review/changes.rs', 'crates/engine/src/cmd/review/proofing.rs', 'crates/engine/src/cmd/protect.rs',
  'crates/engine/src/cmd/tools/specs.rs', 'crates/engine/src/cmd/tools/compare.rs', 'crates/engine/src/cmd/tools/actions.rs', 'crates/engine/src/cmd/view.rs']};

const bad = (msg, path) => new CommandError('invalid_params', msg, path ? {path} : undefined);
const st = ctx => ready(ctx);
const NONE = s.object({});
const ID = s.integer({min: 0, max: 0xffff_ffff, description: 'A comment id (Show Comments lists them)'});
const now = ctx => isoSeconds(ctx.host?.now?.() ?? Date.now());
const hasComments = ctx => Object.keys(ctx.doc?.comments ?? {}).length > 0;
const tracked = ctx => !!ctx.doc?.settings?.trackChanges || !!ctx.view?.trackMine;
/** Commands that only exist while a document has comments (Word greys them out otherwise). */
const commentState = ctx => { const r = ready(ctx); return !r.enabled ? r : hasComments(ctx) ? {enabled: true} : {enabled: false, reason: 'There are no comments in this document'}; };
const lockState = ctx => { const r = ready(ctx); if (!r.enabled) return r; const why = commentsLocked(new Document(ctx.doc)); return why ? {enabled: false, reason: why} : r; };
const addrOf = ctx => p => { try { return ctx.model.addressOf(ctx, p); } catch { return null; } };

// ---- comments ----------------------------------------------------------------------------------

function newComment(ctx, p) {
  const S = open(ctx);
  const d = S.d;
  const text = p.text ?? '';
  let [a, b] = ordered(S.sel);
  if (samePos(a, b)) {
    // Comment on the word at the caret.
    const para = d.paraAt(a);
    if (para && para.text.length) {
      const [x, y0] = P.wordAt(para, a.off);
      const y = x + para.text.slice(x, y0).trimEnd().length;
      a = {...a, path: [...a.path], off: x};
      b = {...a, path: [...a.path], off: y};
    }
  }
  const part = d.tryAddPart('comment', [P.paragraphWithText(text.split('\n')[0] ?? '', {})]);
  if (text.includes('\n')) d.setStory(part, text.split('\n').slice(0, 10_000).map(l => P.paragraphWithText(l.replace(/\r$/, ''), {})));
  const id = freeCommentId(d);
  if (id === null) throw new CommandError('failed', 'no free comment id');
  const date = now(ctx);
  d.updateField('comments', cs => ({...cs, [id]: newCommentRecord({author: S.author, initials: initialsOf(S.author), date, dateUtc: date, parent: null, resolved: false, part})}));
  d.insertObject(b, {type: 'commentEnd', id}, {});
  const afterStart = d.insertObject(a, {type: 'commentStart', id}, {});
  const sameP = b.story === a.story && b.path.join() === a.path.join();
  const end = {...b, path: [...b.path], off: b.off + (sameP ? 1 : 0)};
  S.sel = samePos(a, b) ? caret(afterStart) : {anchor: afterStart, focus: end};
  ctx.setView({commentsPane: true, activeComment: id});
  return finish(ctx, S, {edit: true, result: {id, story: part}});
}

function reply(ctx, p) {
  const S = open(ctx);
  if (!S.d.c.comments?.[p.id]) throw bad('no such comment', '/id');
  const part = S.d.tryAddPart('comment', p.text.split('\n').slice(0, 10_000).map(l => P.paragraphWithText(l.replace(/\r$/, ''), {})));
  const id = freeCommentId(S.d);
  const date = now(ctx);
  S.d.updateField('comments', cs => ({...cs, [id]: newCommentRecord({author: S.author, initials: initialsOf(S.author), date, dateUtc: date, parent: p.id, resolved: false, part})}));
  return finish(ctx, S, {edit: true, result: {id}});
}

function editComment(ctx, p) {
  const S = open(ctx);
  const c = S.d.c.comments?.[p.id];
  if (!c) throw bad('no such comment', '/id');
  S.d.setStory(c.part, p.text.split('\n').slice(0, 10_000).map(l => P.paragraphWithText(l.replace(/\r$/, ''), {})));
  return finish(ctx, S, {edit: true, result: {id: p.id}});
}

function deleteComment(ctx, p) {
  const S = open(ctx);
  const d = S.d;
  let ids;
  if (p.all || p.shown) {
    if (p.shown && !markupOf(ctx.prefs).comments) throw new CommandError('disabled', 'No comments are shown');
    ids = Object.keys(d.c.comments ?? {}).map(Number);
  } else {
    const id = p.id ?? commentAtCaret(d, S.sel.focus);
    if (id === null || id === undefined || !d.c.comments?.[id]) throw bad('no comment here', '/id');
    ids = threadOf(d, id);
  }
  removeAnchors(d, new Set(ids));
  d.updateField('comments', cs => {
    const out = {...cs};
    for (const id of ids) { const c = out[id]; if (c) { d.removePart(c.part); delete out[id]; } }
    return out;
  });
  return finish(ctx, S, {edit: true, result: {deleted: ids}});
}

function resolveComment(ctx, p) {
  const S = open(ctx);
  const id = p.id ?? commentAtCaret(S.d, S.sel.focus);
  if (id === null || id === undefined) throw bad('`id` required', '/id');
  if (!S.d.c.comments?.[id]) throw bad('no such comment', '/id');
  let value;
  S.d.updateField('comments', cs => { value = p.value ?? !cs[id].resolved; return {...cs, [id]: {...cs[id], resolved: value}}; });
  return finish(ctx, S, {edit: true, result: {id, resolved: value}});
}

function navComments(ctx, dir) {
  const S = open(ctx);
  const t = navComment(S.d, S.sel.focus, dir);
  if (t) S.sel = caret(t);
  return finish(ctx, S);
}

// ---- tracking ----------------------------------------------------------------------------------

function trackChanges(ctx, p) {
  const S = open(ctx);
  const doc = !!S.d.c.settings?.trackChanges, mine = !!ctx.view?.trackMine;
  let everyone, justMine;
  if (p.scope === 'mine') { justMine = p.value ?? true; everyone = false; }
  else if (p.scope === 'everyone') { everyone = p.value ?? true; justMine = false; }
  else if (p.value !== undefined) { everyone = p.value; justMine = p.value ? mine : false; if (p.value && mine) everyone = false; }
  else if (doc || mine) { everyone = false; justMine = false; } else { everyone = true; justMine = false; }
  if (everyone !== doc) S.d.updateField('settings', x => { x.trackChanges = everyone; });
  if (justMine !== mine) ctx.setView({trackMine: justMine});
  return finish(ctx, S, {edit: true, result: {value: everyone || justMine, everyone, mine: justMine}});
}

function resolveAllCmd(ctx, p, accept) {
  const S = open(ctx);
  resolveAll(S, accept);
  if (p.stopTracking) { S.d.updateField('settings', x => { x.trackChanges = false; }); if (ctx.view?.trackMine) ctx.setView({trackMine: false}); }
  S.sel = {anchor: S.d.clamp(S.sel.anchor), focus: S.d.clamp(S.sel.focus)};
  return finish(ctx, S, {edit: true});
}

function resolveSelCmd(ctx, p, accept) {
  const S = open(ctx);
  resolveSelection(S, accept, !!p.next);
  return finish(ctx, S, {edit: true});
}

function navChanges(ctx, dir) {
  const S = open(ctx);
  navChange(S, dir);
  return finish(ctx, S);
}

const hasChanges = ctx => { const r = ready(ctx); if (!r.enabled) return r; return (ctx.doc.revisions ?? []).length ? r : {enabled: false, reason: 'There are no tracked changes in this document'}; };

// ---- compare -----------------------------------------------------------------------------------

const COMPARE_KEYS = ['moves', 'comments', 'tables', 'headersFooters', 'footnotes', 'textBoxes', 'fields'];

async function compare(ctx, p) {
  let revised;
  if (typeof p.text === 'string') revised = contentFromText(p.text);
  else if (p.content && typeof p.content === 'object') {
    if (!isQuill2(p.content)) throw bad('`content` must be a Quill document', '/content');
    revised = p.content;
  } else if (typeof p.data === 'string') revised = await readRevised(p.data, p.format);
  else if (typeof p.path === 'string') {
    if (typeof ctx.host?.readFile !== 'function') throw new CommandError('unavailable', 'reading the revised document by path is not available here; pass `data` (base64), `content` or `text`');
    const got = await ctx.host.readFile(p.path);
    revised = await readRevised(got, String(p.path).split('.').pop());
  } else throw bad('`path`, `data`, `content` or `text` of the revised document is required');
  const showIn = p.showIn ?? 'original';
  const opts = compareOptions(p);
  const S = open(ctx);
  const author = typeof p.author === 'string' && p.author.trim() ? p.author.trim() : S.author;
  const date = now(ctx);
  const old = S.d.story(BODY).toArray();
  const nw = new Document(revised).story(BODY).toArray();
  const base = S.d.c.revisions?.length ?? 0;
  const r = compareBlocks(old, nw, {author, date, opts, revBase: base, newId: () => S.d.newId()});
  S.d.updateField('revisions', rs => [...(rs ?? []), ...r.revisions]);
  S.d.setStory(BODY, r.blocks);
  S.sel = caret(S.d.startOf(BODY));
  const notHonoured = COMPARE_KEYS.filter(k => p[k] !== undefined && k !== 'tables');
  return finish(ctx, S, {edit: true, result: {changes: r.changes, author, notHonoured, showIn}});
}

/** The revised document's content from base64 bytes (.docx, else plain text). */
async function readRevised(data, format) {
  const bin = typeof data === 'string' ? Uint8Array.from(atob(data.replace(/^data:[^,]*,/, '')), c => c.charCodeAt(0)) : new Uint8Array(data);
  const isZip = bin[0] === 0x50 && bin[1] === 0x4b;
  if (isZip || String(format ?? '').toLowerCase() === 'docx') {
    const {read} = await import('../formats/docx-read.mjs');
    return read(bin);
  }
  const {read} = await import('../formats/txt-read.mjs');
  return read(bin);
}

// ---- protect -----------------------------------------------------------------------------------

function restrict(ctx, p) {
  const S = open(ctx);
  const d = S.d;
  const addr = addrOf(ctx);
  const done = () => finish(ctx, S, {edit: true, result: protectState(d, S.author, addr)});
  if (p.open !== undefined) ctx.setView({restrictPane: p.open});
  if (p.exception !== undefined) {
    if (enforced(d)) throw new CommandError('disabled', 'stop protection before changing the exceptions');
    const [a, b] = ordered(S.sel);
    if (p.exception === 'add') S.sel = addException(d, a, b);
    else removeExceptions(d, a, b, p.exception === 'removeAll', cmpPos);
    return done();
  }
  if (p.next) {
    const r = nextRegion(d, S.author, ordered(S.sel)[1], cmpPos);
    if (r) S.sel = {anchor: r[0], focus: r[1]};
    return finish(ctx, S, {result: protectState(d, S.author, addr)});
  }
  if (p.lockedStyles !== undefined) {
    if (enforced(d)) throw new CommandError('disabled', 'stop protection before changing the formatting restrictions');
    const names = p.lockedStyles.slice(0, 10_000);
    d.updateField('styles', sh => ({...sh, styles: sh.styles.map(x => {
      const locked = names.some(n => n === x.id || String(n).toLowerCase() === String(x.name ?? '').toLowerCase());
      if (!!x.locked === locked) return x;
      const o = {...x};
      if (locked) o.locked = true; else delete o.locked;
      return o;
    })}));
  }
  const mode = p.mode;
  const formatting = p.formatting;
  const explicitStop = p.stop === true;
  if (mode === 'none' && formatting !== true && !explicitStop && enforced(d)) throw new CommandError('disabled', 'the document is protected: stop protection first ("stop": true)');
  if (explicitStop || (mode === 'none' && formatting !== true)) { stopProtection(d, p.password ?? ''); return done(); }
  if (mode === undefined && formatting === undefined) {
    if (p.open === undefined && p.lockedStyles === undefined) ctx.setView({restrictPane: true});
    return done();
  }
  if (editingRestricted(d) || (d.c.settings?.protectHash ?? []).length) {
    throw new CommandError('disabled', (d.c.settings?.protectHash ?? []).length ? 'the document is protected with a password: stop protection first' : 'the document is protected: stop protection first');
  }
  const m = mode ?? 'none';
  const f = formatting ?? false;
  if (m === 'none' && !f) { stopProtection(d, ''); return done(); }
  const hash = p.password ? protectionHash(p.password, p.spinCount ?? DEFAULT_SPIN_COUNT) : [];
  d.updateField('settings', x => { x.protection = m; x.protectFormatting = f; x.protectHash = hash; if (m === 'trackedChanges') x.trackChanges = true; });
  return done();
}

// ---- language ----------------------------------------------------------------------------------

function language(ctx, p) {
  if (p.noProofToggle) p = {...p, noProof: !selectionLang(ctx).noProof};
  let lang = null;
  if (p.lang !== undefined) {
    lang = normalizeTag(p.lang);
    if (!lang) throw bad(`\`lang\` must be a language tag such as pl-PL or en-US, not ${JSON.stringify(p.lang)}`, '/lang');
  }
  if (p.detect !== undefined) ctx.updatePrefs({detectLanguage: p.detect});
  if (lang === null && p.noProof === undefined && p.detect === undefined) lang = 'en-US';
  if (lang === null && p.noProof === undefined) return {detect: p.detect};
  const S = open(ctx);
  const d = S.d;
  if (p.default) {
    if (!lang) throw bad('`default` needs `lang`', '/default');
    d.updateField('styles', sh => ({...sh, defaultChr: {...(sh.defaultChr ?? {}), lang},
      styles: sh.styles.map(x => (x.id === 'Normal' && x.chr?.lang ? {...x, chr: {...x.chr, lang}} : x))}));
    ctx.updatePrefs({defaultLanguage: lang});
  }
  const f = c => { if (lang) c.lang = lang; if (p.noProof !== undefined) { if (p.noProof) c.noProof = true; else delete c.noProof; } };
  let [a, b] = ordered(S.sel);
  if (samePos(a, b)) {
    // Upstream format::apply: the word at the caret takes it (else the pending formatting).
    const para = d.paraAt(a);
    if (para && para.text.length) { const [x, y] = P.wordAt(para, a.off); a = {...a, off: x}; b = {...a, off: y}; }
  }
  if (!samePos(a, b)) d.formatRange(a, b, f);
  else {
    const para = d.paraMut(a.story, a.path);
    const mark = P.applyProps(P.markOf(para), f);
    if (Object.keys(mark).length) para.mark = mark; else delete para.mark;
  }
  return finish(ctx, S, {edit: true, result: {lang, noProof: p.noProof ?? null}});
}

/** The language the selection is marked with (the menu's check mark, the status bar). */
function selectionLang(ctx) {
  try {
    const d = new Document(ctx.doc);
    const all = ctx.model.selection(ctx);
    const f = d.clamp(all[0]?.focus);
    const para = d.paraAt(f);
    const c = para ? P.propsAt(para, f.off) : {};
    return {lang: c.lang ?? ctx.doc.styles?.defaultChr?.lang ?? 'en-US', noProof: !!c.noProof};
  } catch { return {lang: 'en-US', noProof: false}; }
}

// ---- the family --------------------------------------------------------------------------------

const markupParams = s.object({
  comments: s.optional(s.boolean()), ink: s.optional(s.boolean()), insertionsDeletions: s.optional(s.boolean()), formatting: s.optional(s.boolean()),
  balloons: s.optional(s.enum(['revisions', 'inline', 'commentsAndFormatting'])), commentDisplay: s.optional(s.enum(['margin', 'selected'])),
  insertMark: s.optional(s.string({max: 32})), insertColor: s.optional(s.string({max: 16})), deleteMark: s.optional(s.string({max: 32})),
  deleteColor: s.optional(s.string({max: 16})), changedLines: s.optional(s.string({max: 16})), changedLinesColor: s.optional(s.string({max: 16})),
  trackFormatting: s.optional(s.boolean()), moveFromMark: s.optional(s.string({max: 32})), moveFromColor: s.optional(s.string({max: 16})),
  moveToMark: s.optional(s.string({max: 32})), moveToColor: s.optional(s.string({max: 16})), trackMoves: s.optional(s.boolean()),
});

const compareParams = s.object({
  path: s.optional(s.string({max: 4096})), text: s.optional(s.string({max: 50_000_000})), data: s.optional(s.string({max: 60_000_000})),
  content: s.optional(s.any({description: 'the revised document as Quill content'})), format: s.optional(s.string({max: 16})),
  original: s.optional(s.string({max: 4096})), author: s.optional(s.string({max: 255})),
  caseChanges: s.optional(s.boolean()), whiteSpace: s.optional(s.boolean()), formatting: s.optional(s.boolean()),
  level: s.optional(s.enum(['word', 'character', 'char'])), showIn: s.optional(s.enum(['original', 'revised', 'new'])),
  moves: s.optional(s.boolean()), comments: s.optional(s.boolean()), tables: s.optional(s.boolean()), headersFooters: s.optional(s.boolean()),
  footnotes: s.optional(s.boolean()), textBoxes: s.optional(s.boolean()), fields: s.optional(s.boolean()),
  combine: s.optional(s.boolean({description: 'Combine… (the same comparison)'})),
});

const TOGGLES = {comments: 'comments', ink: 'ink', insertions: 'insertionsDeletions', formatting: 'formatting'};

export default defineCommands({
  family: 'review',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    // --- Comments ---
    {
      id: 'review.newComment', label: 'New Comment', risk: 'edit',
      description: 'New Comment (Review › Comments): a comment on the selection (the word at the caret), with `text` (default empty, typed in its card); shows the comments.',
      params: s.object({text: s.optional(s.string({max: 1_000_000}))}),
      state: lockState, run: newComment,
    },
    {
      id: 'review.reply', label: 'Reply', risk: 'edit',
      description: 'Reply to comment `id` with `text` (a reply joins its thread).',
      params: s.object({id: ID, text: s.string({max: 1_000_000})}), state: lockState, run: reply,
    },
    {
      id: 'review.editComment', label: 'Edit Comment', risk: 'edit',
      description: "Replace comment (or reply) `id`'s text; each line becomes a paragraph.",
      params: s.object({id: ID, text: s.string({max: 1_000_000})}), state: lockState, run: editComment,
    },
    {
      id: 'review.deleteComment', label: 'Delete', risk: 'edit',
      description: 'Delete (Review › Comments): the comment `id` (default: at the caret) and its replies; `all` every comment; `shown` every comment shown.',
      params: s.object({id: s.optional(ID), all: s.optional(s.boolean()), shown: s.optional(s.boolean())}), state: commentState, run: deleteComment,
    },
    {
      id: 'review.resolveComment', label: 'Resolve', risk: 'edit',
      description: 'Resolve or reopen comment `id` (default: at the caret); `value` sets it (default: toggles).',
      params: s.object({id: s.optional(ID), value: s.optional(s.boolean())}), state: commentState, run: resolveComment,
    },
    {
      id: 'review.nextComment', label: 'Next', risk: 'read', effect: 'view',
      description: 'Next Comment: the caret goes to the next comment in reading order (wrapping).',
      params: NONE, state: commentState, run: ctx => navComments(ctx, 1),
    },
    {
      id: 'review.previousComment', label: 'Previous', risk: 'read', effect: 'view',
      description: 'Previous Comment: the caret goes to the previous comment in reading order (wrapping).',
      params: NONE, state: commentState, run: ctx => navComments(ctx, -1),
    },
    {
      id: 'review.comments', label: 'Show Comments', risk: 'read',
      description: 'The comments in reading order: [{id, author, initials, date, resolved, parent, text, anchor}].',
      params: NONE, state: st, run: ctx => listComments(new Document(ctx.doc), addrOf(ctx)),
    },
    {
      id: 'view.commentsPane', label: 'Comments Pane', risk: 'read', effect: 'view',
      description: 'Show Comments (Review › Comments): shows or hides the Comments pane (`value` sets it).',
      params: s.object({value: s.optional(s.boolean())}),
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: !!ctx.view?.commentsPane} : r; },
      run(ctx, p) { ready(ctx); const on = p.value ?? !ctx.view?.commentsPane; ctx.setView({commentsPane: on}); return {value: on}; },
    },
    // --- Tracking ---
    {
      id: 'review.trackChanges', label: 'Track Changes', risk: 'edit',
      description: 'Track Changes (Review › Tracking): `scope` everyone (the document\'s setting) or mine (Just Mine: only this person\'s changes, not saved with the document); `value` sets it (default: toggles).',
      params: s.object({value: s.optional(s.boolean()), scope: s.optional(s.enum(['everyone', 'mine']))}),
      state(ctx, p) {
        const r = ready(ctx);
        if (!r.enabled) return r;
        const doc = !!ctx.doc.settings?.trackChanges, mine = !!ctx.view?.trackMine;
        return {enabled: true, checked: p?.scope === 'everyone' ? doc : p?.scope === 'mine' ? mine : doc || mine};
      },
      run: trackChanges,
    },
    {
      id: 'review.markup', label: 'Display for Review', risk: 'read', effect: 'view',
      description: 'Display for Review: simple (Simple Markup), all (All Markup), noMarkup or original; without `value` toggles All Markup and No Markup.',
      params: s.object({value: s.optional(s.enum(MARKUP_VIEWS))}),
      state(ctx, p) {
        const r = ready(ctx);
        if (!r.enabled) return r;
        const cur = markupView(ctx.view);
        return {enabled: true, checked: p?.value ? cur === p.value : undefined, value: {simple: 'Simple Markup', all: 'All Markup', noMarkup: 'No Markup', original: 'Original'}[cur]};
      },
      run(ctx, p) {
        ready(ctx);
        const cur = markupView(ctx.view);
        const value = p.value ?? (cur === 'noMarkup' || cur === 'original' ? 'all' : 'noMarkup');
        ctx.setView({markup: value});
        return {value, showMarkup: value !== 'noMarkup' && value !== 'original'};
      },
    },
    {
      id: 'review.showMarkup', label: 'Show Markup', risk: 'read', effect: 'prefs',
      description: 'Show Markup: `toggle` comments, ink, insertions or formatting turns that markup on or off; `value` shows (All Markup) or hides all markup.',
      params: s.object({toggle: s.optional(s.enum(Object.keys(TOGGLES))), value: s.optional(s.boolean())}),
      state(ctx, p) {
        const r = ready(ctx);
        if (!r.enabled) return r;
        if (p?.toggle) return {enabled: true, checked: !!markupOf(ctx.prefs)[TOGGLES[p.toggle]]};
        return r;
      },
      run(ctx, p) {
        ready(ctx);
        if (p.toggle) {
          const m = markupOf(ctx.prefs);
          const k = TOGGLES[p.toggle];
          m[k] = !m[k];
          ctx.updatePrefs({markup: m});
          return {[p.toggle]: m[k]};
        }
        const show = p.value ?? markupView(ctx.view) === 'noMarkup';
        ctx.setView({markup: show ? 'all' : 'noMarkup'});
        return {value: show};
      },
    },
    {
      id: 'review.trackingOptions', label: 'Track Changes Options', risk: 'edit', dialog: 'dialog.trackChangesOptions',
      description: 'Track Changes Options: what markup shows and how revisions are drawn (the person\'s preference); `trackMoves` is the document\'s. Omit everything to read them.',
      params: markupParams,
      state(ctx, p) {
        const r = ready(ctx);
        if (!r.enabled || !p?.balloons) return r;
        return {enabled: true, checked: markupOf(ctx.prefs).balloons === p.balloons};
      },
      run(ctx, p) {
        ready(ctx);
        const cur = markupOf(ctx.prefs);
        let next;
        try { next = applyTrackingOptions(cur, p); } catch (e) { throw bad(e.message); }
        if (JSON.stringify(next) !== JSON.stringify(cur)) ctx.updatePrefs({markup: next});
        let trackMoves = ctx.doc.settings?.trackMoves ?? true;
        if (p.trackMoves !== undefined && p.trackMoves !== trackMoves) {
          ctx.model.edit(ctx, d => { d.updateField('settings', x => { x.trackMoves = p.trackMoves; }); });
          trackMoves = p.trackMoves;
        }
        return {...trackingJson(next), trackMoves};
      },
    },
    {
      id: 'review.changes', label: 'Reviewing Pane', risk: 'read', effect: 'view',
      description: 'Reviewing Pane: the tracked changes [{kind, start, end, text, author, date, description?}]; shows or hides the pane (`open` sets it; `horizontal` docks it below in Word).',
      params: s.object({open: s.optional(s.boolean()), horizontal: s.optional(s.boolean()), list: s.optional(s.boolean())}),
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: !!ctx.view?.reviewingPane} : r; },
      run(ctx, p) {
        const S = open(ctx);
        if (!p.list) ctx.setView({reviewingPane: p.open ?? (p.horizontal ? true : !ctx.view?.reviewingPane)});
        return listChanges(S, addrOf(ctx));
      },
    },
    // --- Changes ---
    {
      id: 'review.acceptAll', label: 'Accept All Changes', risk: 'edit',
      description: 'Accept All Changes; with `stopTracking` Track Changes is turned off too.',
      params: s.object({stopTracking: s.optional(s.boolean())}), state: hasChanges, run: (ctx, p) => resolveAllCmd(ctx, p, true),
    },
    {
      id: 'review.rejectAll', label: 'Reject All Changes', risk: 'edit',
      description: 'Reject All Changes; with `stopTracking` Track Changes is turned off too.',
      params: s.object({stopTracking: s.optional(s.boolean())}), state: hasChanges, run: (ctx, p) => resolveAllCmd(ctx, p, false),
    },
    {
      id: 'review.accept', label: 'Accept', risk: 'edit',
      description: 'Accept the change at the caret or the changes in the selection (off a change: selects the next one); `next` then selects the next change.',
      params: s.object({next: s.optional(s.boolean())}), state: hasChanges, run: (ctx, p) => resolveSelCmd(ctx, p, true),
    },
    {
      id: 'review.reject', label: 'Reject', risk: 'edit',
      description: 'Reject the change at the caret or the changes in the selection (off a change: selects the next one); `next` then selects the next change.',
      params: s.object({next: s.optional(s.boolean())}), state: hasChanges, run: (ctx, p) => resolveSelCmd(ctx, p, false),
    },
    {
      id: 'review.nextChange', label: 'Next Change', risk: 'read', effect: 'view',
      description: 'Next Change: selects the next tracked change (wrapping).',
      params: NONE, state: hasChanges, run: ctx => navChanges(ctx, 1),
    },
    {
      id: 'review.previousChange', label: 'Previous Change', risk: 'read', effect: 'view',
      description: 'Previous Change: selects the previous tracked change (wrapping).',
      params: NONE, state: hasChanges, run: ctx => navChanges(ctx, -1),
    },
    // --- Proofing and Language ---
    {
      id: 'review.wordCount', label: 'Word Count', risk: 'read', dialog: 'dialog.wordCount',
      description: 'Word Count: pages, words, characters (no spaces), characters (with spaces), paragraphs and lines of the selection or the document; `includeTextBoxes` counts text boxes, footnotes and endnotes (remembered).',
      params: s.object({includeTextBoxes: s.optional(s.boolean())}), state: st,
      run(ctx, p) {
        const S = open(ctx);
        const inc = p.includeTextBoxes ?? !!ctx.prefs?.countNotes;
        if (p.includeTextBoxes !== undefined && p.includeTextBoxes !== !!ctx.prefs?.countNotes) ctx.updatePrefs({countNotes: p.includeTextBoxes});
        return wordCount(S.d, S.sel, layoutFor(ctx, S.d.c), inc);
      },
    },
    {
      id: 'review.thesaurus', label: 'Thesaurus', risk: 'read', effect: 'view',
      description: 'Thesaurus: synonyms of `word` (default: the word at the caret); shows the Thesaurus pane.',
      params: s.object({word: s.optional(s.string({max: 200})), open: s.optional(s.boolean())}), state: st,
      run(ctx, p) {
        const S = open(ctx);
        const word = p.word !== undefined ? p.word.trim().toLowerCase() : wordAtCaret(S.d, S.sel.focus) ?? '';
        if (p.open !== false) ctx.setView({thesaurusPane: true, thesaurusWord: word});
        return synonyms(word);
      },
    },
    {
      id: 'review.language', label: 'Language', risk: 'edit', dialog: 'dialog.language',
      description: 'Language: mark the selection (the word at the caret) as `lang` (BCP 47, default en-US); `noProof` skips proofing; `detect` (a preference); `default` also makes it the document\'s.',
      params: s.object({lang: s.optional(s.string({max: 35})), noProof: s.optional(s.boolean()), noProofToggle: s.optional(s.boolean()), detect: s.optional(s.boolean()), default: s.optional(s.boolean())}),
      state(ctx, p) {
        const r = ready(ctx);
        if (!r.enabled) return r;
        const cur = selectionLang(ctx);
        if (p?.lang) return {enabled: true, checked: normalizeTag(p.lang) === cur.lang, value: cur.lang};
        if (p?.noProof !== undefined || p?.noProofToggle) return {enabled: true, checked: cur.noProof};
        // The status bar shows the language's name (chrome.rs status_bar).
        return {enabled: true, value: {label: LANGUAGES.find(([t]) => t === cur.lang)?.[1] ?? cur.lang, lang: cur.lang}};
      },
      run: language,
    },
    // --- Compare ---
    {
      id: 'review.compare', label: 'Compare', risk: 'edit', dialog: 'dialog.compare',
      description: 'Compare: this document with a revised one (`text`, `content`, `data` base64 .docx or `path`): the differences as tracked changes labelled with `author`; caseChanges, whiteSpace, formatting, level word|character, showIn.',
      params: compareParams, state: st, run: compare,
    },
    {
      id: 'review.combine', label: 'Combine', risk: 'edit', dialog: 'dialog.compare',
      description: 'Combine: the revisions of a revised document into this one as tracked changes (the same settings as Compare).',
      params: compareParams, state: st, run: compare,
    },
    // --- Protect ---
    {
      id: 'review.restrict', label: 'Restrict Editing', risk: 'edit',
      description: 'Restrict Editing: `mode` none|readOnly|comments|trackedChanges|forms starts enforcing, `formatting` limits formatting to unlocked styles (`lockedStyles`), `password` guards it, `stop` stops it, `exception` add|remove|removeAll, `next` finds the next region you can edit, `open` shows the pane → the state.',
      params: s.object({mode: s.optional(s.enum(MODES)), formatting: s.optional(s.boolean()), lockedStyles: s.optional(s.array(s.string({max: 253}), {max: 10_000})),
        password: s.optional(s.secret({max: 255})), stop: s.optional(s.boolean()), exception: s.optional(s.enum(['add', 'remove', 'removeAll'])),
        next: s.optional(s.boolean()), open: s.optional(s.boolean()), spinCount: s.optional(s.integer({min: 1, max: DEFAULT_SPIN_COUNT}))}),
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: !!ctx.view?.restrictPane} : r; },
      run: restrict,
    },
  ],
});

export {changeList, tracked};
