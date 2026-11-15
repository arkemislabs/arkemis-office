// Review tab: comments (new, reply, delete, resolve, list, previous, next), the Accessibility
// Checker, Spelling (check, change, add to dictionary), the Thesaurus (look up, insert a synonym),
// and Compare (compare with a revised copy, the revisions, accept, reject, end review).
//
// Translated from deckcraft crates/engine/src/cmd/review.rs (`add`, `reply`, `delete`, `resolve`,
// `list`, `neighbour`, `accessibility`, `spelling`, `spelling_change`, `add_to_dictionary`,
// `dictionary_info`, `thesaurus`, `insert_synonym`, `compare`, `revisions`, `accept`, `reject`,
// `end_compare`) and crates/engine/src/{compare,thesaurus,spell}.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The comparison lives in the view state (`view.compare`: the revised presentation, how slides
// match, the rejected revisions); it is never saved with the file, as deckcraft's `DocState.compare`.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {isSchema2, currentSlideId, slideById, selectedShapeIds, selectShapes} from '../model/doc.mjs';
import {walk, isTitlePh, findShape} from '../model/presentation.mjs';
import {bodyText} from '../model/text.mjs';
import {ctxForSlide, ctxColor, background as resolveBackground, run as resolveRun, fill as resolveFill, textColor} from '../model/resolve.mjs';
import {contrast} from '../model/color.mjs';
import {bad, hasDoc, hasSlide, selectionOf, selectSlideList, selectShapeIds, UPSTREAM_COMMIT} from '../lib/text-session.mjs';
import {base64Decode} from '../lib/shape-common.mjs';
import {importPptx} from '../formats/pptx-read.mjs';
import {lookup} from '../lib/thesaurus.mjs';
import {checkLang} from '../lib/spell.mjs';
import {spellingFor, isCheckedLanguage, sessionKey} from '../../common/lib/spelling.mjs';
import {spellingIssues, spellingIssuesAll, suggestionsFor} from '../lib/spelling-issues.mjs';
import {unrelated, pending, changeKey, accept as acceptChange} from '../lib/compare.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/review.rs', 'crates/engine/src/compare.rs', 'crates/engine/src/thesaurus.rs',
  'crates/engine/src/spell.rs', 'crates/ui-egui/src/ribbon/review.rs', 'crates/ui-egui/src/panels/comments.rs']};
const v2 = (cmd, ctx) => { if (!isSchema2(ctx.doc)) throw bad(cmd, 'needs a presentation (schema 2)'); };
const slidesOf = c => c.slides ?? [];
const idx = s.optional(s.integer({min: 0, max: 5000}));
const initialsOf = name => [...String(name ?? '').split(/\s+/).filter(Boolean).map(w => [...w][0])].join('');
/** The author of a comment or reply: the local profile name (the host's profileName(), as in Notes), else File > Options > User name, else 'Author'. */
const authorOf = ctx => {
  let n = null;
  try { n = ctx.host?.profileName?.(); } catch { n = null; }
  if (typeof n !== 'string' || !n.trim()) { const p = ctx.prefs ?? {}; n = p.userName ?? p.user?.name ?? p.author; }
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 80) : 'Author';
};
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------------------------------------
// Comments

/** Flat (slide, comment index) list in deck order. */
const threadsOf = doc => slidesOf(doc).flatMap((sl, si) => (sl.comments ?? []).map((_, ci) => [si, ci]));

/**
 * Step to the next or previous comment. With {slide, index} matching a thread (or the comment the
 * pane or the ribbon last went to, `view.commentFocus`, on this slide) move one step and stop at the
 * ends; otherwise next is the first thread on or after the slide and previous the last before it.
 */
function neighbour(ctx, p, forward) {
  const cmd = forward ? 'comment.next' : 'comment.prev';
  v2(cmd, ctx);
  const threads = threadsOf(ctx.doc);
  if (!threads.length) throw bad(cmd, 'no comments');
  const cur = selectionOf(ctx).slideIndex;
  const focus = ctx.view?.commentFocus;
  const given = p.slide !== undefined || p.index !== undefined;
  const slide = p.slide ?? (!given && focus && focus.slide === cur ? focus.slide : cur);
  const index = given ? p.index : focus && focus.slide === cur && p.slide === undefined ? focus.index : undefined;
  const pos = index === undefined ? -1 : threads.findIndex(([sl, c]) => sl === slide && c === index);
  let target;
  if (pos >= 0) target = forward ? threads[pos + 1] : threads[pos - 1];
  else if (forward) target = threads.find(([sl]) => sl >= slide);
  else target = [...threads].reverse().find(([sl]) => sl < slide);
  if (!target) throw bad(cmd, 'no more comments');
  const [si, ci] = target;
  const id = slidesOf(ctx.doc)[si].id;
  selectSlideList(ctx, [id], id);
  ctx.setView({commentFocus: {slide: si, index: ci}, paneRequest: {pane: 'comments', on: true, n: (ctx.view?.paneRequest?.n ?? 0) + 1}, panes: {...(ctx.view?.panes ?? {}), comments: true}});
  return {slide: si, index: ci, text: slidesOf(ctx.doc)[si].comments[ci].text};
}

// ---------------------------------------------------------------------------------------------
// Accessibility

/** The issues of the deck: [{slide, shape?, name?, issue}] (missing title, missing alt text, hard-to-read text). */
export function accessibilityIssues(doc) {
  const out = [];
  slidesOf(doc).forEach((sl, i) => {
    const title = (sl.shapes ?? []).find(x => x.ph && isTitlePh(x.ph.kind))?.text;
    if (!title || !bodyText(title).trim()) out.push({slide: i, issue: 'Missing slide title'});
    walk(sl.shapes, sh => {
      const needs = ['picture', 'chart', 'media', 'group'].includes(sh.kind?.type);
      if (needs && !String(sh.descr ?? '').trim() && !sh.decorative) out.push({slide: i, shape: sh.id, name: sh.name, issue: 'Missing alternative text'});
    });
    // Low-contrast text against a solid slide background.
    const ctx = ctxForSlide(doc, sl);
    if (!ctx) return;
    const [bgFill, bgPh] = resolveBackground(ctx, sl);
    if (bgFill?.kind !== 'solid') return;
    const bg = ctxColor(ctx, bgFill.color, bgPh);
    for (const sh of sl.shapes ?? []) {
      if (!sh.text) continue;
      const para = (sh.text.paragraphs ?? []).find(p => (p.runs ?? []).some(r => (r.text ?? '') !== ''));
      if (!para) continue;
      const rp = resolveRun(ctx, sh, para, para.runs?.[0]?.props ?? {});
      const [fill] = resolveFill(ctx, sh);
      if (fill && fill.kind !== 'none') continue;
      const fg = textColor(ctx, rp);
      const ratio = contrast(fg, bg);
      if (ratio < 3) out.push({slide: i, shape: sh.id, name: sh.name, issue: `Hard-to-read text contrast (${ratio.toFixed(1)}:1)`});
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Spelling

const paraOf = (sh, row, col, para) => {
  if (row !== undefined && col !== undefined && sh.kind?.type === 'table') return sh.kind.rows?.[row]?.cells?.[col]?.text?.paragraphs?.[para] ?? null;
  return sh.text?.paragraphs?.[para] ?? null;
};
const paraString = p => (p?.runs ?? []).map(r => (r.kind?.kind === 'break' ? '\u000b' : r.text ?? '')).join('');
const isWordChar = c => /[\p{L}\p{N}'’]/u.test(c ?? '');

export {spellingIssues};

/** Replace whole-word `from` with `to` in `text`; [new text, how many]. */
function replaceWord(text, from, to, all) {
  let n = 0, at = 0, out = text;
  for (;;) {
    const i = out.indexOf(from, at);
    if (i < 0) break;
    const end = i + from.length;
    if (isWordChar(out[i - 1]) || isWordChar(out[end])) { at = end; continue; }
    out = out.slice(0, i) + to + out.slice(end);
    n += 1;
    at = i + to.length;
    if (!all) break;
  }
  return [out, n];
}

/** Replace characters start..end of a paragraph with `to`, in the run where they start (later runs lose the rest of the range). */
function replaceChars(para, start, end, to) {
  let at = 0, placed = false;
  const runs = (para.runs ?? []).map(r => {
    const n = (r.text ?? '').length;
    const [a, b] = [Math.max(start, at), Math.min(end, at + n)];
    let next = r;
    if (a < b && r.text !== undefined && !r.kind?.kind) { next = {...r, text: r.text.slice(0, a - at) + (placed ? '' : to) + r.text.slice(b - at)}; placed = true; }
    at += n;
    return next;
  });
  return {...para, runs: runs.filter(r => !(r.text === '' && !r.kind?.kind))};
}

/** Go to an issue: its slide is the current one and its shape (a table's, for a cell) is selected; a notes issue selects the slide. */
function goToIssue(ctx, it) {
  const sl = slidesOf(ctx.doc)[it.slide];
  if (!sl) return;
  if (it.shape !== undefined) selectShapeIds(ctx, sl.id, [it.shape]); else selectSlideList(ctx, [sl.id], sl.id);
}

/** Change Spelling: replace a word in the shape's text (one exact occurrence at para/start, the first whole word, or every shape with `all`). */
function spellingChange(ctx, p) {
    v2('review.spellingChange', ctx);
    const shape = p.shape === undefined ? null : String(p.shape);
    const all = p.all === true;
    if (shape === null && !all) throw bad('review.spellingChange', 'give `shape`, or `all: true`');
    // One exact occurrence (a squiggled word): paragraph `para`, from character `start`.
    if (shape !== null && p.para !== undefined && p.start !== undefined) {
      const end = p.start + p.word.length;
      let hit = null;
      slidesOf(ctx.doc).forEach((sl, si) => {
        if (hit) return;
        walk(sl.shapes, sh => {
          if (hit || sh.id !== shape) return;
          const para = paraOf(sh, p.row, p.col, p.para);
          if (para && paraString(para).slice(p.start, end) === p.word) hit = {si, sh, para};
        });
      });
      if (!hit) throw bad('review.spellingChange', "the word isn't there");
      const next = replaceChars(hit.para, p.start, end, p.to);
      const path = (() => {
        const pth = ['slides', hit.si];
        const rec = (list, base) => { for (let k = 0; k < list.length; k++) { if (list[k].id === shape) return [...base, k]; const ch = list[k].kind?.children; if (ch) { const r = rec(ch, [...base, k, 'kind', 'children']); if (r) return r; } } return null; };
        const rel = rec(hit.si === undefined ? [] : slidesOf(ctx.doc)[hit.si].shapes, [...pth, 'shapes']);
        return rel;
      })();
      if (!path) throw bad('review.spellingChange', 'no shape');
      const body = p.row !== undefined && p.col !== undefined ? [...path, 'kind', 'rows', p.row, 'cells', p.col, 'text', 'paragraphs', p.para] : [...path, 'text', 'paragraphs', p.para];
      ctx.change.set(body, next);
      return {changed: 1};
    }
    let changed = 0;
    const edits = [];
    slidesOf(ctx.doc).forEach((sl, si) => {
      const rec = (list, base) => list.forEach((sh, k) => {
        const here = [...base, k];
        if (sh.text && (shape === null || sh.id === shape) && (all || changed + edits.length === 0)) {
          const paras = sh.text.paragraphs.map(para => ({...para, runs: (para.runs ?? []).map(r => {
            if (r.text === undefined || r.kind?.kind || (!all && changed > 0)) return r;
            const [t, n] = replaceWord(r.text, p.word, p.to, all);
            if (n) changed += n;
            return n ? {...r, text: t} : r;
          })}));
          if (JSON.stringify(paras) !== JSON.stringify(sh.text.paragraphs)) edits.push([[...here, 'text', 'paragraphs'], paras]);
        }
        if (sh.kind?.children) rec(sh.kind.children, [...here, 'kind', 'children']);
      });
      rec(sl.shapes ?? [], ['slides', si, 'shapes']);
    });
    for (const [path, value] of edits) ctx.change.set(path, value);
    return {changed};
}

// ---------------------------------------------------------------------------------------------
// Compare

const comparing = ctx => (ctx.view?.compare ? {enabled: true} : {enabled: false, reason: 'not comparing'});
const revisionsJson = ctx => {
  const c = ctx.view?.compare;
  if (!c) throw bad('review.revisions', 'not comparing');
  const name = String(c.name).split(/[\\/]/).pop() || c.name;
  return {name, changes: pending(ctx.doc, c), byPosition: c.byPosition};
};

async function compare(ctx, p) {
  v2('review.compare', ctx);
  let bytes, name = typeof p.name === 'string' ? p.name : 'Revised';
  if (typeof p.data === 'string') {
    bytes = base64Decode(p.data.replace(/^data:[^;,]*;base64,/, ''));
    if (!bytes) throw bad('review.compare', 'invalid base64 `data`');
  } else if (typeof p.path === 'string') {
    const read = ctx.host?.readFile ?? ctx.host?.files?.readFile;
    if (typeof read !== 'function') throw bad('review.compare', 'give `data`');
    const data = await read(p.path);
    bytes = typeof data === 'string' ? base64Decode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    name = p.path;
  } else if (ctx.origin !== 'bridge' && typeof ctx.host?.pickDocument === 'function') {
    const got = await ctx.host.pickDocument({all: true});
    if (!got) return null;
    bytes = base64Decode(got.data);
    name = got.name;
  } else throw bad('review.compare', 'give `path` or `data`');
  let revised;
  try { revised = await importPptx(bytes); } catch (e) { throw bad('review.compare', `can't read ${name} as a presentation (${e?.message ?? e})`); }
  const cmp = {name, revised, byPosition: unrelated(ctx.doc, revised), rejected: []};
  ctx.setView({compare: cmp, panes: {...(ctx.view?.panes ?? {}), revisions: true}, paneRequest: {pane: 'revisions', on: true, n: (ctx.view?.paneRequest?.n ?? 0) + 1}});
  return revisionsJson({...ctx, view: {...(ctx.view ?? {}), compare: cmp}});
}

export default defineCommands({
  family: 'review',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'comment.add', label: 'New Comment', risk: 'edit', shortcut: 'Ctrl+Alt+M', dialog: 'dialog.comment',
      description: 'New Comment (Review › Comments): add a comment to the current slide: {text, x?, y?, id?: the shape it points at (default: the selected shape)} → {index}. The author is the profile name (window.studio.profileName).',
      params: s.object({text: s.string({min: 1, max: 100000}), x: s.optional(s.number()), y: s.optional(s.number()), id: s.optional(s.union([s.string({max: 64}), s.integer({min: 0})]))}),
      state: hasSlide,
      run(ctx, p) {
        v2('comment.add', ctx);
        const sel = selectionOf(ctx);
        const author = authorOf(ctx);
        const shape = p.id !== undefined ? String(p.id) : selectedShapeIds(ctx.doc, ctx.selection)[0] ?? null;
        const cs = sel.slide.comments ?? [];
        ctx.change.set(['slides', sel.slideIndex, 'comments'], [...cs, {author, initials: initialsOf(author), text: p.text, date: nowIso(), x: p.x ?? 10, y: p.y ?? 10, resolved: false, replies: [], shape}]);
        return {index: cs.length};
      },
    },
    {
      id: 'comment.reply', label: 'Reply', risk: 'edit',
      description: 'Reply: add a reply to the comment `index` of the current slide.',
      params: s.object({index: s.integer({min: 0, max: 100000}), text: s.string({max: 100000})}),
      state: hasSlide,
      run(ctx, p) {
        v2('comment.reply', ctx);
        const sel = selectionOf(ctx);
        const c = (sel.slide.comments ?? [])[p.index];
        if (!c) throw bad('comment.reply', 'no such comment', {path: '/index'});
        const author = authorOf(ctx);
        ctx.change.set(['slides', sel.slideIndex, 'comments', p.index, 'replies'], [...(c.replies ?? []), {author, initials: initialsOf(author), text: p.text, date: nowIso(), x: 0, y: 0, resolved: false, replies: [], shape: null}]);
        return {};
      },
    },
    {
      id: 'comment.delete', label: 'Delete Comment', risk: 'edit',
      description: 'Delete (Review › Comments): delete the comment `index` of the current slide, every comment of the current slide (no `index`), or every comment of the presentation (`all`); `focused` deletes the comment the pane or Next / Previous last went to, else every comment of the slide.',
      params: s.object({index: s.optional(s.integer({min: 0, max: 100000})), all: s.optional(s.boolean()), focused: s.optional(s.boolean())}),
      state(ctx) {
        const st = hasSlide(ctx);
        if (!st.enabled) return st;
        return threadsOf(ctx.doc).length ? {enabled: true} : {enabled: false, reason: 'no comments'};
      },
      run(ctx, p) {
        v2('comment.delete', ctx);
        const sel = selectionOf(ctx);
        if (p.all === true) {
          slidesOf(ctx.doc).forEach((sl, i) => { if ((sl.comments ?? []).length) ctx.change.set(['slides', i, 'comments'], []); });
          ctx.setView({commentFocus: null});
          return {};
        }
        let index = p.index;
        if (index === undefined && p.focused === true) { const f = ctx.view?.commentFocus; if (f && f.slide === sel.slideIndex && (sel.slide.comments ?? [])[f.index]) index = f.index; }
        const list = sel.slide.comments ?? [];
        if (index === undefined) { if (list.length) ctx.change.set(['slides', sel.slideIndex, 'comments'], []); ctx.setView({commentFocus: null}); return {}; }
        if (index >= list.length) throw bad('comment.delete', 'no such comment', {path: '/index'});
        ctx.change.set(['slides', sel.slideIndex, 'comments'], list.filter((_, i) => i !== index));
        const f = ctx.view?.commentFocus;
        if (f && f.slide === sel.slideIndex) ctx.setView({commentFocus: f.index === index ? null : f.index > index ? {slide: f.slide, index: f.index - 1} : f});
        return {};
      },
    },
    {
      id: 'comment.resolve', label: 'Resolve Thread', risk: 'edit',
      description: 'Resolve Thread: mark the comment `index` of the current slide resolved (or reopen it with `resolved: false`).',
      params: s.object({index: s.integer({min: 0, max: 100000}), resolved: s.optional(s.boolean())}),
      state: hasSlide,
      run(ctx, p) {
        v2('comment.resolve', ctx);
        const sel = selectionOf(ctx);
        if (!(sel.slide.comments ?? [])[p.index]) throw bad('comment.resolve', 'no such comment', {path: '/index'});
        ctx.change.set(['slides', sel.slideIndex, 'comments', p.index, 'resolved'], p.resolved ?? true);
        return {};
      },
    },
    {
      id: 'comment.focus', label: 'Go to Comment', risk: 'read', effect: 'view',
      description: 'Go to Comment: make the comment `index` of slide `slide` the one Next and Previous step from (the pane\'s card click); the slide becomes the current one.',
      params: s.object({slide: s.integer({min: 0, max: 5000}), index: s.integer({min: 0, max: 100000})}),
      state: hasSlide,
      run(ctx, p) {
        v2('comment.focus', ctx);
        const sl = slidesOf(ctx.doc)[p.slide];
        if (!sl || !(sl.comments ?? [])[p.index]) throw bad('comment.focus', 'no such comment');
        selectSlideList(ctx, [sl.id], sl.id);
        ctx.setView({commentFocus: {slide: p.slide, index: p.index}});
        return {};
      },
    },
    {
      id: 'comment.list', label: 'Comments', risk: 'read', effect: 'view',
      description: 'Query: the comments of slide `slide` (default: the current one).',
      params: s.object({slide: idx}),
      state: hasSlide,
      run(ctx, p) { v2('comment.list', ctx); return slidesOf(ctx.doc)[p.slide ?? selectionOf(ctx).slideIndex]?.comments ?? []; },
    },
    ...[['comment.next', 'Next Comment', true], ['comment.prev', 'Previous Comment', false]].map(([id, label, forward]) => ({
      id, label, risk: 'read', effect: 'view',
      description: `${label} (Review › Comments): go to the ${forward ? 'next' : 'previous'} comment of the deck: {slide?, index?} → {slide, index, text}. Opens the Comments pane on it; it stops at the ends ("no more comments").`,
      params: s.object({slide: idx, index: s.optional(s.integer({min: 0, max: 100000}))}),
      state: ctx => {
        const st = hasSlide(ctx);
        return !st.enabled ? st : threadsOf(ctx.doc).length ? {enabled: true} : {enabled: false, reason: 'no comments'};
      },
      run: (ctx, p) => neighbour(ctx, p, forward),
    })),
    {
      id: 'review.accessibility', label: 'Check Accessibility', risk: 'read', effect: 'view', dialog: 'dialog.accessibility',
      description: 'Check Accessibility (Review › Accessibility): the issues of the deck: [{slide, shape?, name?, issue}] (a slide without a title, a picture, chart, media or group without alternative text, text that is hard to read on a solid background).',
      params: s.object({}),
      state: hasDoc,
      run(ctx) { v2('review.accessibility', ctx); return accessibilityIssues(ctx.doc); },
    },
    {
      id: 'review.spelling', label: 'Spelling', risk: 'read', effect: 'view',
      description: 'Spelling (Review › Proofing, F7): opens the Spelling pane on the first misspelt word on or after the current slide (the slide and shape are selected) and returns the misspelt and repeated words of the deck: {lang?, ignore?: [word], open?: false (only list)} → [{slide, shape?, row?, col?, notes?, para, start, end, word, lang, key, suggestions, repeated?, deleteFrom?}] (shapes, table cells and notes; US English, the bundled en_US dictionary).',
      params: s.object({lang: s.optional(s.string({max: 35})), ignore: s.optional(s.array(s.string({max: 255}), {max: 10000})), open: s.optional(s.boolean())}),
      state: (ctx, p) => { const st = hasDoc(ctx); return st.enabled && p?.open === undefined ? {enabled: true, checked: !!ctx.view?.panes?.spelling} : st; },
      async run(ctx, p) {
        v2('review.spelling', ctx);
        const list = await spellingIssuesAll(ctx.doc, p.lang, p.ignore ?? [], {sp: spellingFor(ctx.prefs), session: sessionKey(ctx.host, ctx.docId)});
        if (p.open === false) return list;
        const here = selectionOf(ctx).slideIndex;
        const first = list.find(i => i.slide >= here) ?? list[0];
        if (first) goToIssue(ctx, first);
        ctx.setView({panes: {...(ctx.view?.panes ?? {}), spelling: true}, paneRequest: {pane: 'spelling', on: true, n: (ctx.view?.paneRequest?.n ?? 0) + 1}});
        return list;
      },
    },
    {
      id: 'review.spellingList', label: 'Spelling Issues', risk: 'read', effect: 'view',
      description: 'Query: the misspelt and repeated words of the deck, as review.spelling returns them, without opening the pane or going anywhere (the pane reads this).',
      params: s.object({lang: s.optional(s.string({max: 35})), ignore: s.optional(s.array(s.string({max: 255}), {max: 10000}))}),
      state: hasDoc,
      run(ctx, p) { v2('review.spellingList', ctx); return spellingIssuesAll(ctx.doc, p.lang, p.ignore ?? [], {sp: spellingFor(ctx.prefs), session: sessionKey(ctx.host, ctx.docId)}); },
    },
    {
      id: 'review.spellingMenu', label: 'Spelling Menu', risk: 'read', effect: 'view',
      description: 'The misspelt word the right-click menu opens on (view state `spellMenu`): {slide?, shape?, row?, col?, para?, start?} names an issue of review.spelling (default: the first on the current slide); `none: true` clears it → the issue or null.',
      params: s.object({slide: s.optional(s.integer({min: 0, max: 5000})), shape: s.optional(s.union([s.string({max: 64}), s.integer({min: 0})])), row: s.optional(s.integer({min: 0, max: 10000})),
        col: s.optional(s.integer({min: 0, max: 10000})), para: s.optional(s.integer({min: 0, max: 100000})), start: s.optional(s.integer({min: 0, max: 10000000})), none: s.optional(s.boolean())}),
      state: hasDoc,
      async run(ctx, p) {
        v2('review.spellingMenu', ctx);
        if (p.none) { ctx.setView({spellMenu: null}); return null; }
        const sp = spellingFor(ctx.prefs);
        const slide = p.slide ?? selectionOf(ctx).slideIndex;
        const list = await spellingIssuesAll(ctx.doc, undefined, [], {sp, session: sessionKey(ctx.host, ctx.docId), slide});
        const hit = list.find(i => (p.shape === undefined || String(i.shape) === String(p.shape)) && (p.para === undefined || i.para === p.para) && (p.start === undefined || i.start === p.start)
          && (p.row === undefined || i.row === p.row) && (p.col === undefined || i.col === p.col)) ?? null;
        ctx.setView({spellMenu: hit});
        return hit;
      },
    },
    {
      id: 'review.spellingApply', label: 'Change', risk: 'edit',
      description: 'Change (a suggestion in the right-click menu on a misspelt word): {text, all?} replaces the word of view.spellMenu with `text` (every occurrence with `all`).',
      params: s.object({text: s.string({max: 1000}), all: s.optional(s.boolean())}),
      // Without `text` the state is the menu's list of suggestions (dynamic: one entry each, bold).
      state(ctx, p) {
        const st = hasDoc(ctx);
        if (!st.enabled) return st;
        const m = ctx.view?.spellMenu;
        if (!m || m.repeated) return {enabled: false, hidden: true, reason: 'no misspelt word'};
        return p?.text !== undefined ? st : {enabled: true, value: (m.suggestions ?? []).map(w => ({id: w, label: w, value: w}))};
      },
      run(ctx, p) {
        const m = ctx.view?.spellMenu;
        if (!m || m.repeated) throw bad('review.spellingApply', 'no misspelt word to change');
        const q = p.all ? {word: m.word, to: p.text, all: true} : {shape: m.shape, word: m.word, to: p.text, para: m.para, start: m.start, ...(m.row !== undefined ? {row: m.row, col: m.col} : {})};
        const r = spellingChange(ctx, q);
        ctx.setView({spellMenu: null});
        return r;
      },
    },
    {
      id: 'review.spellingDeleteRepeat', label: 'Delete Repeated Word', risk: 'edit',
      description: 'Delete Repeated Word (the right-click menu on a repeated word): removes the repeated word of view.spellMenu with the space before it.',
      params: s.object({}),
      state(ctx) { const st = hasDoc(ctx); return st.enabled && !ctx.view?.spellMenu?.repeated ? {enabled: false, hidden: true, reason: 'no repeated word'} : st; },
      run(ctx) {
        const m = ctx.view?.spellMenu;
        if (!m?.repeated) throw bad('review.spellingDeleteRepeat', 'no repeated word');
        const sh = findShape(slidesOf(ctx.doc)[m.slide]?.shapes ?? [], m.shape);
        const para = sh ? paraOf(sh, m.row, m.col, m.para) : null;
        const text = paraString(para).slice(m.deleteFrom, m.end);
        if (!text) throw bad('review.spellingDeleteRepeat', "the word isn't there");
        const r = spellingChange(ctx, {shape: m.shape, word: text, to: '', para: m.para, start: m.deleteFrom, ...(m.row !== undefined ? {row: m.row, col: m.col} : {})});
        ctx.setView({spellMenu: null});
        return r;
      },
    },
    {
      id: 'review.spellingChange', label: 'Change Spelling', risk: 'edit',
      description: 'Change Spelling (Review › Proofing): {shape, word, to, all?, para?, start?, row?, col?} → {changed}: replace the whole word in that shape\'s text, the one at para/start, or in every shape with `all`.',
      params: s.object({shape: s.optional(s.union([s.string({max: 64}), s.integer({min: 0})])), word: s.string({min: 1, max: 1000}), to: s.string({max: 1000}), all: s.optional(s.boolean()),
        para: s.optional(s.integer({min: 0, max: 100000})), start: s.optional(s.integer({min: 0, max: 10000000})), row: s.optional(s.integer({min: 0, max: 10000})), col: s.optional(s.integer({min: 0, max: 10000}))}),
      state: hasDoc,
      run: (ctx, p) => spellingChange(ctx, p),
    },
    {
      id: 'review.ignoreAll', label: 'Ignore All', risk: 'read', effect: 'view',
      description: 'Ignore All (Spelling pane, the right-click menu): {word?} (default: the word of the right-click menu) is not marked anywhere in this presentation while it is open (any case) → {ignored}.',
      params: s.object({word: s.optional(s.string({min: 1, max: 255}))}),
      state: () => ({enabled: true}),
      run(ctx, p) {
        const w = String(p.word ?? ctx.view?.spellMenu?.word ?? '').trim();
        if (!w) throw bad('review.ignoreAll', 'no word', {path: '/word'});
        spellingFor(ctx.prefs).ignoreAll(sessionKey(ctx.host, ctx.docId), w);
        return {ignored: w};
      },
    },
    {
      id: 'review.ignoreOnce', label: 'Ignore', risk: 'read', effect: 'view',
      description: "Ignore (Spelling pane): {key?} (an issue's `key`; default: the right-click menu's word) is not marked at that place until Recheck. Not checked against upstream.",
      params: s.object({key: s.optional(s.string({min: 1, max: 1000}))}),
      state: () => ({enabled: true}),
      run(ctx, p) {
        const key = p.key ?? ctx.view?.spellMenu?.key;
        if (!key) throw bad('review.ignoreOnce', 'no word', {path: '/key'});
        spellingFor(ctx.prefs).ignoreOnce(sessionKey(ctx.host, ctx.docId), key);
        return {ignored: key};
      },
    },
    {
      id: 'review.spellingRecheck', label: 'Recheck Spelling', risk: 'read', effect: 'view',
      description: 'Recheck: Ignore and Ignore All start empty again for this presentation. Not checked against upstream.',
      params: s.object({}), state: hasDoc,
      run(ctx) { spellingFor(ctx.prefs).recheck(sessionKey(ctx.host, ctx.docId)); return {}; },
    },
    {
      id: 'review.addToDictionary', label: 'Add to Dictionary', risk: 'edit', effect: 'view',
      description: "Add to Dictionary (Review › Proofing, Spelling pane, the right-click menu): {word?} (default: the word of the right-click menu) is never reported again; the user dictionary is kept in this app's preferences (prefs.userDictionary) and is not sent anywhere → {word}.",
      params: s.object({word: s.optional(s.string({min: 1, max: 255}))}),
      state: () => ({enabled: true}),
      run(ctx, p) {
        const w = String(p.word ?? ctx.view?.spellMenu?.word ?? '').trim();
        if (!w) throw bad('review.addToDictionary', 'no word', {path: '/word'});
        if (/\s/.test(w)) throw bad('review.addToDictionary', `${JSON.stringify(w)} isn't a single word`, {path: '/word'});
        const sp = spellingFor(ctx.prefs);
        try { sp.addUserWord(w); } catch (e) { throw bad('review.addToDictionary', e.message, {path: '/word'}); }
        const list = ctx.prefs?.userDictionary ?? [];
        if (!list.includes(w)) ctx.updatePrefs({userDictionary: [...list, w]});
        return {word: w};
      },
    },
    {
      id: 'review.dictionary', label: 'Spelling Dictionary', risk: 'read', effect: 'view',
      description: 'Query: {lang?} → {lang, available, found, folders}: whether the app ships a dictionary for the language (US English does: the bundled en_US one; other languages are not checked).',
      params: s.object({lang: s.optional(s.string({max: 35}))}),
      state: () => ({enabled: true}),
      run(ctx, p) {
        const lang = isSchema2(ctx.doc) ? checkLang(ctx.doc, p.lang) : p.lang ?? 'en-US';
        const available = isCheckedLanguage(lang);
        return {lang, available, found: available ? 'bundled' : null, folders: []};
      },
    },
    {
      id: 'review.thesaurus', label: 'Thesaurus', risk: 'read', effect: 'view',
      description: 'Thesaurus (Review › Proofing): {word?} → {word, senses: [{word, synonyms}]} (default word: the selected text or the word at the caret).',
      params: s.object({word: s.optional(s.string({max: 255}))}),
      state: hasDoc,
      run(ctx, p) {
        v2('review.thesaurus', ctx);
        const word = p.word ?? '';
        return {word, senses: lookup(word)};
      },
    },
    {
      id: 'review.replaceWord', label: 'Insert Synonym', risk: 'edit',
      description: 'Insert Synonym: {with}: replace the selected word (or the word at the caret) while editing text.',
      params: s.object({with: s.string({min: 1, max: 200})}),
      state: ctx => (selectionOf(ctx).text ? {enabled: true} : {enabled: false, reason: 'no text insertion point'}),
      async run(ctx, p) {
        v2('review.replaceWord', ctx);
        if (!p.with.trim()) throw bad('review.replaceWord', 'missing `with`');
        const t = selectionOf(ctx).text;
        if (t && t.anchor === t.caret) await ctx.run('text.selectWord', {});
        return (await ctx.run('text.insert', {text: p.with})).result;
      },
    },
    {
      id: 'review.compare', label: 'Compare', risk: 'edit', effect: 'view',
      description: 'Compare (Review › Compare): compare with a revised copy: {path} | {name, data: base64} (from the UI, the system Open dialog picks the file) → {name, changes: [{kind: inserted | deleted | changed, slide, revised, details}], byPosition}. Comparing alone changes nothing; accept or reject each revision.',
      params: s.object({path: s.optional(s.string({max: 4096})), data: s.optional(s.string({max: 400_000_000})), name: s.optional(s.string({max: 255}))}),
      state: hasDoc,
      run: (ctx, p) => compare(ctx, p),
    },
    {
      id: 'review.revisions', label: 'Revisions', risk: 'read', effect: 'view',
      description: 'Query: {} → {name, changes: [{kind, slide, revised, details}], byPosition}: the revisions still to review.',
      params: s.object({}),
      state: comparing,
      run: ctx => revisionsJson(ctx),
    },
    {
      id: 'review.accept', label: 'Accept Revision', risk: 'edit',
      description: 'Accept (Review › Compare): take a revision into the open presentation: {index} (in review.revisions) | {all: true} → {accepted}.',
      params: s.object({index: s.optional(s.integer({min: 0, max: 100000})), all: s.optional(s.boolean())}),
      state: comparing,
      run(ctx, p) {
        const cmp = ctx.view?.compare;
        if (!cmp) throw bad('review.accept', 'not comparing');
        if (p.all !== true && p.index === undefined) throw bad('review.accept', 'give `index` or `all`');
        const doc = structuredClone(ctx.doc);
        let accepted = 0, at = null;
        const limit = doc.slides.length + cmp.revised.slides.length + 1;
        for (let k = 0; k < limit; k++) {
          const changes = pending(doc, cmp);
          const c = p.all === true ? changes.find(x => !(x.kind === 'deleted' && doc.slides.length <= 1)) : changes[p.index ?? 0];
          if (!c) break;
          const shown = acceptChange(doc, cmp.revised, c);
          if (shown === null) break;
          accepted += 1; at = shown;
          if (p.all !== true) break;
        }
        if (!accepted) throw bad('review.accept', 'no such revision');
        ctx.change.set(['nextId'], doc.nextId);
        ctx.change.set(['media'], doc.media ?? []);
        ctx.change.set(['slides'], doc.slides);
        if (at !== null && doc.slides[at]) selectSlideList(ctx, [doc.slides[at].id], doc.slides[at].id);
        return {accepted};
      },
    },
    {
      id: 'review.reject', label: 'Reject Revision', risk: 'edit', effect: 'view',
      description: 'Reject (Review › Compare): drop a revision without applying it, the open presentation stays as it is: {index} | {all: true} → {rejected}.',
      params: s.object({index: s.optional(s.integer({min: 0, max: 100000})), all: s.optional(s.boolean())}),
      state: comparing,
      run(ctx, p) {
        const cmp = ctx.view?.compare;
        if (!cmp) throw bad('review.reject', 'not comparing');
        if (p.all !== true && p.index === undefined) throw bad('review.reject', 'give `index` or `all`');
        const list = pending(ctx.doc, cmp);
        const picked = p.all === true ? list : list.slice(p.index ?? 0, (p.index ?? 0) + 1);
        if (!picked.length) throw bad('review.reject', 'no such revision');
        ctx.setView({compare: {...cmp, rejected: [...(cmp.rejected ?? []), ...picked.map(c => changeKey(ctx.doc, c))]}});
        return {rejected: picked.length};
      },
    },
    {
      id: 'review.endCompare', label: 'End Review', risk: 'read', effect: 'view',
      description: 'End Review (Review › Compare): stop comparing and close the Revisions pane.',
      params: s.object({}),
      state: comparing,
      run(ctx) {
        ctx.setView({compare: null, panes: {...(ctx.view?.panes ?? {}), revisions: false}, paneRequest: {pane: 'revisions', on: false, n: (ctx.view?.paneRequest?.n ?? 0) + 1}});
        return {};
      },
    },
  ],
});

void currentSlideId; void slideById; void selectShapes;
