// Find: the find bar (Ctrl+F: the query, how many matches, previous and next, the options), and Advanced search (the
// search in a side panel that lists every match with its context, page by page).
//
// Translated from printcraft at 8f16855 (MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/canvas/find.rs        Find (query, matches in document order, current, options), rerun_find (the first match
//                                            at or after the page the search started from, wrapping), find_step (wraps round),
//                                            go_to_match, find_bar
//   crates/ui-egui/src/panels/search_ui.rs   the Search panel: query, Whole words only, Case-sensitive, "N instances",
//                                            results by page with 36 glyphs of context on each side
//   crates/ui-egui/src/commands.rs:446,525   edit.find opens the bar; edit.advanced_search opens the panel and focuses the field
//   crates/render/src/text.rs find_opts      PageText.find (model/text.mjs)
// Printcraft's search is of page text only: Acrobat's bookmarks and comments options and Replace are not in upstream
// and are not shown (docs/spec/patches/folio/find.json).
// The search is view state (`view.find`): the query, the options, the matches ([page, first glyph, last glyph + 1] and
// the excerpt) and the current one; `rev` counts the moves so the page view scrolls to the match.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/find.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {pagesOf} from '../lib/comment-geometry.mjs';
import {pageText} from '../model/page-text.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/canvas/find.rs', 'crates/ui-egui/src/panels/search_ui.rs', 'crates/ui-egui/src/commands.rs']};

const CONTEXT = 36;
const MAX_MATCHES = 2000;
const noPdf = {enabled: false, reason: 'no PDF open'};
const open = ctx => (pagesOf(ctx).length ? {enabled: true} : noPdf);
export const OPTIONS = Object.freeze(['Whole words only', 'Case-sensitive']);

const flat = t => t.split(/\s+/).filter(Boolean).join(' ');
const fresh = () => ({open: true, query: '', caseSensitive: false, wholeWords: false, matches: [], current: null, inPanel: false, rev: 0, searched: 0, pages: 0, from: 0});

/** printcraft first_at_or_after: the first match at or after `page`, else the first one (the search wraps round the document). */
export const firstAtOrAfter = (matches, page) => {
  const i = matches.findIndex(m => m[0] >= page);
  return i >= 0 ? i : matches.length ? 0 : null;
};

/** rerun_find: every match of the query on every page, in document order, with its excerpt. */
async function search(ctx, find) {
  const pages = pagesOf(ctx);
  const out = [];
  if (find.query.trim()) {
    for (let pi = 0; pi < pages.length && out.length < MAX_MATCHES; pi++) {
      const text = await pageText(ctx.doc, pages[pi]);
      for (const [a, b] of text.find(find.query, {caseSensitive: find.caseSensitive, wholeWords: find.wholeWords})) {
        const n = text.glyphs.length;
        out.push([pi, a, b, flat(text.textOf(Math.max(0, a - CONTEXT), a)), flat(text.textOf(a, Math.min(b, n))), flat(text.textOf(Math.min(b, n), Math.min(n, b + CONTEXT)))]);
        if (out.length >= MAX_MATCHES) break;
      }
    }
  }
  return out;
}

const here = ctx => Math.max(0, pagesOf(ctx).findIndex(p => p.id === ctx.doc.activePageId));
const current = ctx => ctx.view?.find ?? null;

async function run(ctx, find) {
  find.from = here(ctx);
  find.matches = await search(ctx, find);
  find.searched = pagesOf(ctx).length;
  find.pages = pagesOf(ctx).length;
  find.current = firstAtOrAfter(find.matches, find.from);
  find.rev = (find.rev ?? 0) + 1;
  ctx.setView({find});
  return {matches: find.matches.length, current: find.current === null ? null : find.current + 1};
}

export default defineCommands({
  family: 'find', app: 'folio', upstream: UPSTREAM,
  commands: [
    {
      id: 'edit.find', label: 'Find…', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Find: open the find bar; with `query`, search every page for it and go to the first match at or after the page shown (the search wraps round the document). `caseSensitive` and `wholeWords` set the options. Returns how many matches there are.',
      params: s.object({query: s.optional(s.string({max: 1000})), caseSensitive: s.optional(s.boolean()), wholeWords: s.optional(s.boolean())}),
      state(ctx) { const st = open(ctx); return st.enabled ? {...st, value: current(ctx)?.query ?? ''} : st; },
      async run(ctx, p) {
        const f = {...(current(ctx) ?? fresh()), open: true};
        if (p.caseSensitive !== undefined) f.caseSensitive = p.caseSensitive;
        if (p.wholeWords !== undefined) f.wholeWords = p.wholeWords;
        if (p.query === undefined && p.caseSensitive === undefined && p.wholeWords === undefined) { f.focus = (f.focus ?? 0) + 1; ctx.setView({find: f}); return {open: true, matches: f.matches.length}; }
        if (p.query !== undefined) f.query = p.query;
        return {open: true, ...(await run(ctx, f))};
      },
    },
    {
      id: 'find.step', label: 'Next match / Previous match', risk: 'read', effect: 'view', undo: 'none',
      description: 'Go to the next match (forward: true, Ctrl+G) or the previous one (Ctrl+Shift+G); past the last the search wraps round to the first.',
      params: s.object({forward: s.boolean()}),
      state(ctx) { const f = current(ctx); return open(ctx).enabled ? (f?.matches.length ? {enabled: true} : {enabled: false, reason: 'there are no matches'}) : noPdf; },
      run(ctx, p) {
        const f = current(ctx);
        if (!f?.matches.length) return {moved: false};
        const n = f.matches.length;
        const c = f.current ?? 0;
        const next = p.forward ? (c + 1) % n : (c + n - 1) % n;
        ctx.setView({find: {...f, current: next, rev: (f.rev ?? 0) + 1}});
        return {current: next + 1, of: n, page: f.matches[next][0] + 1};
      },
    },
    {
      id: 'find.goto', label: 'Go to a match', risk: 'read', effect: 'view', undo: 'none',
      description: 'Go to match number `match` (1-based): what a click on a result of the Search panel does.',
      params: s.object({match: s.integer({min: 1, max: 100000})}),
      state(ctx) { return open(ctx).enabled && current(ctx)?.matches.length ? {enabled: true} : {enabled: false, reason: 'there are no matches'}; },
      run(ctx, p) {
        const f = current(ctx);
        if (!f || p.match > f.matches.length) return {moved: false};
        ctx.setView({find: {...f, current: p.match - 1, rev: (f.rev ?? 0) + 1}});
        return {current: p.match, page: f.matches[p.match - 1][0] + 1};
      },
    },
    {
      id: 'find.option', label: 'Find options', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: `Switch a find option: "${OPTIONS[0]}" or "${OPTIONS[1]}" (the command toggles it, \`value\` sets it); the search runs again.`,
      params: s.object({option: s.enum(OPTIONS), value: s.optional(s.boolean())}),
      state(ctx, p) {
        const st = open(ctx);
        if (!st.enabled) return st;
        const f = current(ctx);
        return {...st, checked: p?.option === OPTIONS[0] ? !!f?.wholeWords : p?.option === OPTIONS[1] ? !!f?.caseSensitive : false};
      },
      async run(ctx, p) {
        const f = {...(current(ctx) ?? fresh())};
        if (p.option === OPTIONS[0]) f.wholeWords = p.value ?? !f.wholeWords; else f.caseSensitive = p.value ?? !f.caseSensitive;
        return run(ctx, f);
      },
    },
    {
      id: 'find.close', label: 'Close the find bar', risk: 'read', effect: 'view', undo: 'none',
      description: 'Close the find bar (Esc); the matches go with it.',
      params: s.object({}),
      state: ctx => (current(ctx) ? {enabled: true} : {enabled: false, reason: 'the find bar is not open'}),
      run(ctx) { ctx.setView({find: null, ...(ctx.view?.rightPanel === 'search' ? {rightPanel: null} : {})}); return {open: false}; },
    },
    {
      id: 'edit.advanced_search', label: 'Advanced search…', risk: 'read', effect: 'view', undo: 'none',
      description: 'Advanced search: the search in the Search panel, listing every match with its context, page by page; click a result to go to it. It shares the find bar\'s search. With `open: false` the panel closes and the search moves back to the find bar.',
      params: s.object({open: s.optional(s.boolean())}),
      state: open,
      run(ctx, p) {
        const f = {...(current(ctx) ?? fresh())};
        const on = p.open ?? ctx.view?.rightPanel !== 'search';
        if (on) { ctx.setView({find: {...f, open: true, inPanel: true, focus: (f.focus ?? 0) + 1}, rightPanel: 'search', panel: null}); return {open: true}; }
        ctx.setView({find: {...f, inPanel: false}, rightPanel: ctx.view?.rightPanel === 'search' ? null : ctx.view?.rightPanel ?? null});
        return {open: false};
      },
    },
  ],
});
