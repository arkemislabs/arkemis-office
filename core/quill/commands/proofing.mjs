// Spelling in Word (U:quill/spelling): Review › Proofing › Spelling & Grammar (F7) and Home › Editor open the Editor pane on the next
// misspelt word after the caret; the right-click menu on a squiggled word offers its suggestions, Ignore All and Add to Dictionary;
// the pane adds Change, Change All, Ignore Once and Recheck. The words and dictionary are the shared service's
// (core/common/lib/spelling.mjs): US English, in a worker, the user dictionary in the app's prefs, never sent anywhere.
//
// Translated from wordcraft crates/engine/src/cmd/review.rs (`review.spelling`, `review.issues`, `review.suggestions`,
// `review.addToDictionary`, `review.ignoreAll`, `review.applySuggestion`, `review.proofing`) and review/proofing.rs
// (`next_issue`, `all_issues`, `suggestions`, `issue_at`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. Not upstream (Word's own): Change All, Ignore Once, Recheck Document
// and the pane; "not checked against upstream".
//
// The Editor pane's current issue is view state (`view.spellingIssue`), set by `review.spelling`; Change and Ignore leave the caret
// where the next F7 will look, so the pane (src/apps/quill/panes/editor.tsx) asks for the next issue after each one.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {open, finish, ready, ordered, samePos, posJson, UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import {typeText} from '../lib/text-edit.mjs';
import {Document} from '../model/document.mjs';
import * as P from '../model/para.mjs';
import {serviceFor, sessionOf, issuesFrom, issueAt, paraIssues, prepare, defaultLanguage, proofText} from '../lib/review-spelling.mjs';
import {wordsOf} from '../../common/lib/spelling.mjs';
import {synonyms} from '../lib/review-proofing.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/review.rs', 'crates/engine/src/cmd/review/proofing.rs', 'crates/layout/src/para/proof.rs']};
const bad = (msg, path) => new CommandError('invalid_params', msg, path ? {path} : undefined);
const MAX_WORD = 255;
const SUGGESTIONS = 6;

const POS = s.object({story: s.optional(s.any()), path: s.array(s.integer({min: 0}), {max: 64}), off: s.integer({min: 0})});

/**
 * The issue under the selection's focus, from what the service already holds (a menu or a ribbon state must not wait):
 * the issue, null (no misspelt word there), or 'unknown' (the word under the caret has not been looked up yet).
 */
function issueNow(ctx) {
  try {
    if (!ctx.doc || !ctx.selection) return null;
    const d = new Document(ctx.doc);
    const all = ctx.model.selection(ctx);
    const r = all[ctx.selection?.primary ?? 0] ?? all[0];
    const at = d.clamp(r.focus);
    const p = d.para(at.story, at.path);
    const sp = serviceFor(ctx);
    const o = {session: sessionOf(ctx), defaultLang: defaultLanguage(ctx.doc)};
    const hit = issueAt(p, at.off, sp, o);
    if (hit) return hit;
    const word = wordsOf(proofText(p)).find(t => t.start <= at.off && at.off <= t.end);
    return word && !sp.known(word.text, o.session) ? 'unknown' : null;
  } catch { return null; }
}
/** state(): enabled on a document; with `needsIssue`, only (and shown only) while the caret is on a misspelt word (or on one not looked up yet, which a command may still act on). */
const issueState = needsIssue => (ctx, p) => {
  const r = ready(ctx);
  if (!r.enabled) return r;
  if (!needsIssue || p?.word !== undefined) return r;
  return issueNow(ctx) ? r : {enabled: false, hidden: true, reason: 'The caret is not on a misspelt word'};
};

const spellOpts = (ctx, S) => ({session: sessionOf(ctx), defaultLang: defaultLanguage(S.d.c)});

/** The issue under the focus of `S.sel`, looked up fresh. */
async function issueAtSel(ctx, S) {
  const at = S.sel.focus;
  const p = S.d.para(at.story, at.path);
  const sp = serviceFor(ctx);
  await prepare(S.d, at.story, [at.path], sp, spellOpts(ctx, S));
  const hit = issueAt(p, at.off, sp, spellOpts(ctx, S));
  return hit ? {story: at.story, path: at.path, ...hit} : null;
}

/** upstream issue_json, with the sentence around the word for the pane. */
async function issueJson(ctx, S, it) {
  const sp = serviceFor(ctx);
  const p = S.d.para(it.story, it.path);
  const suggestions = await sp.suggest(it.text, SUGGESTIONS);
  const [a, b] = P.sentenceAt(p, it.start);
  return {start: posJson(ctx, {story: it.story, path: it.path, off: it.start}), end: posJson(ctx, {story: it.story, path: it.path, off: it.end}), text: it.text, kind: 'spelling',
    message: null, suggestions, lang: 'en-US', context: {before: p.text.slice(Math.min(a, it.start), it.start), after: p.text.slice(it.end, Math.max(b, it.end)).replace(/\s+$/, '')}};
}

const rangeOf = it => ({anchor: {story: it.story, path: [...it.path], off: it.start}, focus: {story: it.story, path: [...it.path], off: it.end}});

/** F7: select the next issue after the caret and return it with suggestions (`next_issue`); `open: false` only closes the pane. */
async function spelling(ctx, p) {
  const S = open(ctx);
  if (p.open === false) { ctx.setView({editorPane: false}); return finish(ctx, S, {result: {open: false}}); }
  const sp = serviceFor(ctx);
  const caret = ordered(S.sel)[1];
  const [first] = await issuesFrom(S.d, caret, sp, {...spellOpts(ctx, S), limit: 1});
  if (!first) {
    ctx.setView({editorPane: true, spellingIssue: {done: true}});
    return finish(ctx, S, {result: {done: true}});
  }
  S.sel = rangeOf(first);
  const json = await issueJson(ctx, S, first);
  ctx.setView({editorPane: true, spellingIssue: json});
  return finish(ctx, S, {result: json});
}

async function allIssues(ctx) {
  const S = open(ctx);
  const sp = serviceFor(ctx);
  const found = await issuesFrom(S.d, S.d.startOf('body'), sp, {...spellOpts(ctx, S), limit: 500});
  const out = [];
  for (const it of found) out.push(await issueJson(ctx, S, it));
  return out;
}

async function suggestionsAt(ctx, p) {
  const S = open(ctx);
  if (p.pos) S.sel = {anchor: S.d.clamp(posOf(ctx, p.pos)), focus: S.d.clamp(posOf(ctx, p.pos))};
  const it = await issueAtSel(ctx, S);
  return it ? issueJson(ctx, S, it) : null;
}
const posOf = (ctx, v) => ({story: v.story === undefined || v.story === 'body' ? 'body' : (v.story.part ?? v.story), path: v.path, off: v.off});

/** Change: the issue at the caret is replaced by `text`, typed as the person would (tracked, undone as one step). */
async function applySuggestion(ctx, p) {
  const S = open(ctx);
  const it = await issueAtSel(ctx, S);
  if (it) S.sel = rangeOf(it);
  typeText(S, p.text);
  return finish(ctx, S, {edit: true});
}

/** The word under the caret (or the selection's focus) and its range, from the state context (no session needed). */
function wordNow(ctx) {
  try {
    if (!ctx.doc || !ctx.selection) return null;
    const d = new Document(ctx.doc);
    const all = ctx.model.selection(ctx);
    const at = d.clamp((all[ctx.selection?.primary ?? 0] ?? all[0]).focus);
    const p = d.para(at.story, at.path);
    const [a0, b0] = P.wordAt(p, at.off);
    const raw = p.text.slice(a0, b0);
    const text = raw.trim();
    const a = a0 + (raw.length - raw.trimStart().length);
    return text ? {story: at.story, path: at.path, start: a, end: a + text.length, text} : null;
  } catch { return null; }
}

/** Synonyms > a synonym: the word at the caret is replaced by it, in the case it was written in (one undo step). */
function applySynonym(ctx, p) {
  const S = open(ctx);
  const w = wordNow(ctx);
  if (!w) throw bad('the caret is not on a word');
  S.sel = {anchor: {story: w.story, path: [...w.path], off: w.start}, focus: {story: w.story, path: [...w.path], off: w.end}};
  typeText(S, fitCase(w.text, p.text));
  return finish(ctx, S, {edit: true});
}

/** The replacement in the case the word was written in (a capital at the start stays). */
const fitCase = (word, to) => (/^\p{Lu}/u.test(word) && /^\p{Ll}/u.test(to) ? to.charAt(0).toUpperCase() + to.slice(1) : to);

/** Change All: every occurrence of the misspelt word in the document body is replaced (the same word, any case). */
async function changeAll(ctx, p) {
  const S = open(ctx);
  const sp = serviceFor(ctx);
  let word = p.word;
  if (word === undefined) { const it = await issueAtSel(ctx, S); word = it?.text; }
  if (!word) throw bad('no misspelt word to change', '/word');
  const found = (await issuesFrom(S.d, S.d.startOf('body'), sp, {...spellOpts(ctx, S), limit: 5000})).filter(it => it.story === 'body' && it.text.toLowerCase() === word.toLowerCase());
  // From the last to the first, so the offsets of those not yet changed stay true.
  for (const it of found.slice().sort((a, b) => cmpPath(b, a))) { S.sel = rangeOf(it); typeText(S, fitCase(it.text, p.text)); }
  return finish(ctx, S, {edit: found.length > 0, result: {changed: found.length}});
}
const cmpPath = (a, b) => {
  for (let i = 0; i < Math.max(a.path.length, b.path.length); i++) if ((a.path[i] ?? -1) !== (b.path[i] ?? -1)) return (a.path[i] ?? -1) - (b.path[i] ?? -1);
  return a.start - b.start;
};

/** The word `p.word` names, else the misspelt word at the caret (`review.addToDictionary` and `review.ignoreAll`). */
async function wordParam(ctx, p) {
  if (typeof p.word === 'string') return p.word;
  const S = open(ctx);
  const it = await issueAtSel(ctx, S);
  return it?.text ?? '';
}

async function addToDictionary(ctx, p) {
  const w = (await wordParam(ctx, p)).trim();
  if (!w) throw bad('no word', '/word');
  if (/\s/.test(w) || w.length > MAX_WORD) throw bad(`${JSON.stringify(w)} isn't a single word of at most ${MAX_WORD} characters`, '/word');
  const sp = serviceFor(ctx);
  const list = ctx.prefs?.userDictionary ?? [];
  if (!list.includes(w)) ctx.updatePrefs({userDictionary: [...list, w]});
  sp.addUserWord(w);
  return {added: w};
}

async function ignoreAll(ctx, p) {
  const w = (await wordParam(ctx, p)).trim();
  // For this document session only, as in Word: not added to (or saved with) the dictionary.
  if (w) serviceFor(ctx).ignoreAll(sessionOf(ctx), w);
  return {ignored: w};
}

async function ignoreOnce(ctx, p) {
  const S = open(ctx);
  if (p.pos) S.sel = {anchor: S.d.clamp(posOf(ctx, p.pos)), focus: S.d.clamp(posOf(ctx, p.pos))};
  const it = await issueAtSel(ctx, S);
  if (!it) throw bad('the caret is not on a misspelt word');
  serviceFor(ctx).ignoreOnce(sessionOf(ctx), it.key);
  return finish(ctx, S, {result: {ignored: it.text}});
}

export default defineCommands({
  family: 'proofing',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'review.spelling', label: 'Spelling & Grammar', risk: 'read', effect: 'view',
      description: 'Spelling & Grammar (Review › Proofing, F7): select the next misspelt word after the caret and open the Editor pane on it: {open?: false closes the pane} → {text, start, end, kind: "spelling", suggestions, lang, context: {before, after}} or {done: true}. US English only; no grammar.',
      params: s.object({open: s.optional(s.boolean())}),
      state: (ctx, p) => { const r = ready(ctx); return r.enabled && p?.open === undefined ? {enabled: true, checked: !!ctx.view?.editorPane} : r; },
      run: spelling,
    },
    {
      id: 'review.issues', label: 'Proofing Issues', risk: 'read', effect: 'view',
      description: 'Proofing Issues (Review › Proofing): every misspelt word of the body (at most 500) in reading order, as review.spelling returns them.',
      params: s.object({}), state: ready, run: allIssues,
    },
    {
      id: 'review.suggestions', label: 'Spelling Suggestions', risk: 'read', effect: 'view',
      description: 'Spelling Suggestions (Review › Proofing): {pos?} → the misspelt word at the position (default: the caret) with its suggestions, or null.',
      params: s.object({pos: s.optional(POS)}), state: ready, run: suggestionsAt,
    },
    {
      id: 'review.applySuggestion', label: 'Change', risk: 'edit',
      description: 'Change (Review › Proofing, a suggestion in the right-click menu): {text} replaces the misspelt word at the caret (else the selection) with `text`.',
      params: s.object({text: s.string({max: 1000})}),
      // Without `text` the state is the right-click menu's list of suggestions (dynamic: one entry each, bold), hidden off a misspelt word.
      state(ctx, p) {
        const r = issueState(true)(ctx, p);
        if (!r.enabled || p?.text !== undefined) return r;
        const it = issueNow(ctx);
        const list = (it && it !== 'unknown' && serviceFor(ctx).suggested(it.text, SUGGESTIONS)) || [];
        return {enabled: true, value: list.map(w => ({id: w, label: w, value: w}))};
      },
      run: applySuggestion,
    },
    {
      id: 'review.applySynonym', label: 'Synonym', risk: 'edit',
      description: 'Synonyms (the right-click menu): {text} replaces the word at the caret with the synonym, in the case it was written in. Without text its state lists the thesaurus synonyms of the word at the caret.',
      params: s.object({text: s.string({max: 200})}),
      state(ctx, p) {
        const r = ready(ctx);
        if (!r.enabled || p?.text !== undefined) return r;
        const w = wordNow(ctx);
        const list = w ? synonyms(w.text.trim().toLowerCase()).synonyms : [];
        return {enabled: true, value: list.map(x => ({id: x, label: x, value: x}))};
      },
      run: applySynonym,
    },
    {
      id: 'review.changeAll', label: 'Change All', risk: 'edit',
      description: 'Change All (Editor pane): {text, word?} replaces every occurrence of the misspelt word (default: the one at the caret; any case) in the body with `text` → {changed}. Not checked against upstream.',
      params: s.object({text: s.string({max: 1000}), word: s.optional(s.string({min: 1, max: MAX_WORD}))}),
      state: issueState(true), run: changeAll,
    },
    {
      id: 'review.ignoreOnce', label: 'Ignore Once', risk: 'read', effect: 'view',
      description: 'Ignore Once (Editor pane): the misspelt word at the caret (or `pos`) stops being marked, at this place only, until Recheck Document. Not checked against upstream.',
      params: s.object({pos: s.optional(POS)}), state: issueState(true), run: ignoreOnce,
    },
    {
      id: 'review.ignoreAll', label: 'Ignore All', risk: 'read', effect: 'view',
      description: 'Ignore All (Review › Proofing, the right-click menu): {word?} is not marked anywhere in this document while it is open (any case; default: the misspelt word at the caret) → {ignored}.',
      params: s.object({word: s.optional(s.string({min: 1, max: MAX_WORD}))}), state: issueState(true), run: ignoreAll,
    },
    {
      id: 'review.addToDictionary', label: 'Add to Dictionary', risk: 'edit', effect: 'view',
      description: 'Add to Dictionary (Review › Proofing, the right-click menu): {word?} (default: the misspelt word at the caret) is never marked again; the user dictionary is kept in this app\'s preferences (prefs.userDictionary) and is not sent anywhere → {added}.',
      params: s.object({word: s.optional(s.string({min: 1, max: MAX_WORD}))}), state: issueState(true), run: addToDictionary,
    },
    {
      id: 'review.recheck', label: 'Recheck Document', risk: 'read', effect: 'view',
      description: 'Recheck Document (File › Options › Proofing, the Editor pane): Ignore Once and Ignore All start empty again for this document. Not checked against upstream.',
      params: s.object({}), state: ready,
      run(ctx) { serviceFor(ctx).recheck(sessionOf(ctx)); return {}; },
    },
    {
      id: 'review.proofing', label: 'Check Spelling as You Type', risk: 'edit', effect: 'view',
      description: 'Check Spelling as You Type (File › Options › Proofing): {value?: bool (default: toggle)} turns the squiggles on or off (prefs.checkSpelling).',
      params: s.object({value: s.optional(s.boolean())}),
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: ctx.prefs?.checkSpelling !== false} : r; },
      run(ctx, p) {
        const on = p.value ?? ctx.prefs?.checkSpelling === false;
        ctx.updatePrefs({checkSpelling: on});
        return {value: on};
      },
    },
  ],
});

export {issueNow, paraIssues, samePos};
