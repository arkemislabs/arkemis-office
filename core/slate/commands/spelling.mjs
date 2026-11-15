// Review > Spelling in OneNote (U:slate/spelling): F7 opens the Spelling pane on the first misspelt word of the page (at or after the caret) and selects it;
// squiggles under every misspelt word of the page, and the right-click menu on one (its suggestions, Ignore All, Add to Dictionary), come from the same issues.
// The pane's buttons: Ignore, Ignore All, Add (to the dictionary), the suggestions, Change and Change All.
//
// Slate has no ArtCraft upstream: ids and args are docs/spec/slate.json `review.*`; behaviour is OneNote's. Words are checked against the bundled US English
// dictionary by the shared service (core/common/lib/spelling.mjs); the user dictionary is the app's prefs (prefs.userDictionary), never sent anywhere.
// Not checked against upstream (there is none). Edits are ProseMirror steps through the foundation, one undo entry each.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook, nodeOf, schema} from '../schema.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {editPage, textRange} from '../lib/format-text.mjs';
import {matchCase} from '../lib/proofing.mjs';
import {pageIssues, pageIssuesAll} from '../lib/spelling.mjs';
import {spellingFor, sessionKey} from '../../common/lib/spelling.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/review.spelling']};
const bad = (msg, path) => new CommandError('invalid_params', msg, path ? {path} : undefined);
const MAX_WORD = 255;
const session = ctx => sessionKey(ctx.host, ctx.docId);
const sp = ctx => spellingFor(ctx.prefs);
const notebookState = ctx => (isNotebook(ctx.doc) ? {enabled: true} : {enabled: false, reason: 'No notebook is open'});
const pageOf = ctx => { const id = currentLocation(ctx.doc, ctx.selection).pageId; return id && ctx.doc.pages[id] ? id : null; };
const needPage = ctx => { const id = pageOf(ctx); if (!id) throw new CommandError('disabled', 'Open a page first'); return id; };
const enc = encodeURIComponent;

/** The issues of the current page (sync, from what the service holds) and of `pageId`'s document. */
function issuesNow(ctx, pageId = pageOf(ctx)) {
  return pageId ? pageIssues(nodeOf(ctx.doc.pages[pageId].body), pageId, sp(ctx), {session: session(ctx)}) : [];
}
const listAll = (ctx, pageId) => pageIssuesAll(nodeOf(ctx.doc.pages[pageId].body), pageId, sp(ctx), {session: session(ctx)});

/** The selection naming one word of a page (the page's block and offsets). */
const wordSelection = (it) => ({ranges: [{anchor: `/pg:${enc(it.page)}/b:${enc(it.block)}/t:${it.start}`, focus: `/pg:${enc(it.page)}/b:${enc(it.block)}/t:${it.end}`}], primary: 0});

/** Replace characters from..to of the page with `text`, keeping the marks the word had. */
function replaceWord(ctx, pageId, doc, from, to, text) {
  const marks = doc.resolve(from).marksAcross(doc.resolve(to)) ?? [];
  editPage(ctx, pageId, tr => tr.replaceWith(from, to, schema.text(text, marks)), doc);
}

/** The menu state of a command that acts on the word of the right-click menu: hidden while there is none. */
const menuState = (ctx, p, extra) => {
  const r = notebookState(ctx);
  if (!r.enabled) return r;
  const m = ctx.view?.spellMenu;
  if (!m) return {enabled: false, hidden: true, reason: 'The pointer is not on a misspelt word'};
  return extra ? extra(m, p) : r;
};

async function change(ctx, p) {
  const pageId = p.page ?? needPage(ctx);
  if (!ctx.doc.pages[pageId]) throw new CommandError('not_found', `No page ${pageId}`, {address: `/pg:${pageId}`});
  const doc = nodeOf(ctx.doc.pages[pageId].body);
  if (p.all) {
    const word = (p.word ?? '').toLowerCase();
    if (!word) throw bad('give `word`', '/word');
    await sp(ctx).prepare([p.word]);
    const hits = pageIssues(doc, pageId, sp(ctx), {session: session(ctx)}).filter(it => it.word.toLowerCase() === word);
    let at = doc;
    for (const it of hits.slice().sort((a, b) => b.from - a.from)) {
      const old = at.textBetween(it.from, it.to, ' ', ' ');
      replaceWord(ctx, pageId, at, it.from, it.to, matchCase(old, p.text));
      at = nodeOf(ctx.doc.pages[pageId].body);
    }
    return {changed: hits.length};
  }
  if (!Number.isInteger(p.from) || !Number.isInteger(p.to)) throw bad('give `from` and `to` (a word of review.spellingList), or `all` with `word`');
  if (doc.textBetween(p.from, p.to, ' ', ' ') !== p.word) throw bad("the word isn't there");
  replaceWord(ctx, pageId, doc, p.from, p.to, p.text);
  return {changed: 1};
}

export default defineCommands({
  family: 'spelling',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'review.spelling', label: 'Spelling', risk: 'read', effect: 'view',
      description: 'Spelling (Review > Proofing, F7): opens the Spelling pane on the first misspelt word of the current page at or after the caret and selects it, and returns the misspelt words of the page: {open?: false (only list)} → [{page, block, start, end, from, to, word, key, lang, suggestions}]. US English, the bundled en_US dictionary.',
      params: s.object({open: s.optional(s.boolean())}),
      state: (ctx, p) => { const r = notebookState(ctx); return r.enabled && p?.open === undefined ? {enabled: true, checked: ctx.view?.pane?.kind === 'spelling'} : r; },
      async run(ctx, p) {
        const pageId = needPage(ctx);
        const list = await listAll(ctx, pageId);
        if (p.open === false) return list;
        const at = textRange(ctx);
        const first = list.find(it => !at || it.from >= at.to) ?? list[0];
        if (first) ctx.setSelection(wordSelection(first));
        ctx.setView({pane: {kind: 'spelling'}});
        return list;
      },
    },
    {
      id: 'review.spellingList', label: 'Spelling Issues', risk: 'read', effect: 'view',
      description: 'Query: the misspelt words of the current page, as review.spelling returns them, without opening the pane or moving the selection (the pane reads this).',
      params: s.object({}), state: notebookState,
      run(ctx) { return listAll(ctx, needPage(ctx)); },
    },
    {
      id: 'review.spellingMenu', label: 'Spelling Menu', risk: 'read', effect: 'view',
      description: 'The misspelt word the right-click menu opens on (view state `spellMenu`): {from?} a position in the page, inside the word (default: the word the selection is in); `none: true` clears it → the issue or null.',
      params: s.object({from: s.optional(s.integer({min: 0})), none: s.optional(s.boolean())}),
      state: notebookState,
      async run(ctx, p) {
        if (p.none) { ctx.setView({spellMenu: null}); return null; }
        const pageId = needPage(ctx);
        const list = await listAll(ctx, pageId);
        const pos = p.from ?? textRange(ctx)?.from;
        const hit = pos === undefined ? null : list.find(it => it.from <= pos && pos <= it.to) ?? null;
        ctx.setView({spellMenu: hit});
        return hit;
      },
    },
    {
      id: 'review.spellingChange', label: 'Change Spelling', risk: 'edit', effect: 'content',
      description: 'Change Spelling (Spelling pane): {from, to, word, text, page?} replaces the misspelt word at those page positions with `text`; with `all`, {word, text, all: true} replaces every misspelt occurrence of `word` on the page (any case) → {changed}.',
      params: s.object({from: s.optional(s.integer({min: 0})), to: s.optional(s.integer({min: 0})), word: s.optional(s.string({min: 1, max: MAX_WORD})), text: s.string({max: 1000}), page: s.optional(s.string({max: 120})), all: s.optional(s.boolean())}),
      state: notebookState, run: change,
    },
    {
      id: 'review.spellingApply', label: 'Change', risk: 'edit', effect: 'content',
      description: 'Change (a suggestion in the right-click menu on a misspelt word): {text, all?} replaces the word of view.spellMenu with `text` (every occurrence on the page with `all`).',
      params: s.object({text: s.string({max: 1000}), all: s.optional(s.boolean())}),
      // Without `text` the state is the menu's list of suggestions (dynamic: one entry each, bold).
      state: (ctx, p) => menuState(ctx, p, (m, q) => (q?.text !== undefined ? {enabled: true} : {enabled: true, value: (m.suggestions ?? []).map(w => ({id: w, label: w, value: w}))})),
      async run(ctx, p) {
        const m = ctx.view?.spellMenu;
        if (!m) throw bad('no misspelt word to change');
        const r = await change(ctx, p.all ? {word: m.word, text: p.text, all: true, page: m.page} : {from: m.from, to: m.to, word: m.word, text: p.text, page: m.page});
        ctx.setView({spellMenu: null});
        return r;
      },
    },
    {
      id: 'review.ignoreAll', label: 'Ignore All', risk: 'read', effect: 'view',
      description: 'Ignore All (Spelling pane, the right-click menu): {word?} (default: the word of the right-click menu) is not marked anywhere in this notebook while it is open (any case) → {ignored}.',
      params: s.object({word: s.optional(s.string({min: 1, max: MAX_WORD}))}),
      state: (ctx, p) => (p?.word !== undefined ? notebookState(ctx) : menuState(ctx, p)),
      run(ctx, p) {
        const w = String(p.word ?? ctx.view?.spellMenu?.word ?? '').trim();
        if (!w) throw bad('no word', '/word');
        sp(ctx).ignoreAll(session(ctx), w);
        return {ignored: w};
      },
    },
    {
      id: 'review.ignoreOnce', label: 'Ignore', risk: 'read', effect: 'view',
      description: "Ignore (Spelling pane): {key?} (an issue's `key`; default: the right-click menu's word) is not marked at that place until Recheck. Not checked against upstream.",
      params: s.object({key: s.optional(s.string({min: 1, max: 1000}))}),
      state: notebookState,
      run(ctx, p) {
        const key = p.key ?? ctx.view?.spellMenu?.key;
        if (!key) throw bad('no word', '/key');
        sp(ctx).ignoreOnce(session(ctx), key);
        return {ignored: key};
      },
    },
    {
      id: 'review.spellingRecheck', label: 'Recheck Spelling', risk: 'read', effect: 'view',
      description: 'Recheck: Ignore and Ignore All start empty again for this notebook. Not checked against upstream.',
      params: s.object({}), state: notebookState,
      run(ctx) { sp(ctx).recheck(session(ctx)); return {}; },
    },
    {
      id: 'review.addToDictionary', label: 'Add to Dictionary', risk: 'edit', effect: 'view',
      description: "Add to Dictionary (Spelling pane, the right-click menu): {word?} (default: the word of the right-click menu) is never reported again; the user dictionary is kept in this app's preferences (prefs.userDictionary) and is not sent anywhere → {added}.",
      params: s.object({word: s.optional(s.string({min: 1, max: MAX_WORD}))}),
      state: (ctx, p) => (p?.word !== undefined ? notebookState(ctx) : menuState(ctx, p)),
      run(ctx, p) {
        const w = String(p.word ?? ctx.view?.spellMenu?.word ?? '').trim();
        if (!w) throw bad('no word', '/word');
        if (/\s/.test(w)) throw bad(`${JSON.stringify(w)} isn't a single word`, '/word');
        sp(ctx).addUserWord(w);
        const list = ctx.prefs?.userDictionary ?? [];
        if (!list.includes(w)) ctx.updatePrefs({userDictionary: [...list, w]});
        return {added: w};
      },
    },
  ],
});

export {issuesNow};
