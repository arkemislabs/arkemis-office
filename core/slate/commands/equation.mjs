// Equation contextual tab: Conversions, Symbols and Structures (U:slate/equation); the Equation
// gallery itself is Insert > Equation (insert.equation), which this tab's gallery calls.
//
// Slate has no ArtCraft upstream: ids and args are docs/spec/slate.json `equation.*`; behaviour is
// OneNote's Equation Tools tab:
//   * Convert changes how the selected equation (or every equation on the page) is shown:
//     Professional (typeset) or Linear (the text as typed);
//   * Unicode / LaTeX choose the syntax a typed equation is written in (LaTeX is converted to the
//     linear format the page stores); Normal Text shows the equation as plain, non-math text;
//   * Symbols inserts a character from one of eight categories, Structures a template (a fraction,
//     a script, a matrix...) whose empty slots are `□`. With an equation selected they go into it:
//     into its first empty slot, else at its end; otherwise they make a new equation at the caret.
// The galleries' tiles are drawn from MathML (core/slate/lib/equation-catalog.mjs), never labelled.
// Ink Equation is not offered (docs/spec/patches/slate/equation.json).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook, nodeOf} from '../schema.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {pageDoc} from '../model/canvas.mjs';
import {blockIndex} from '../model/page.mjs';
import {editPage} from '../lib/format-text.mjs';
import {PLACEHOLDER, MAX_LINEAR} from '../lib/equation.mjs';
import {STRUCTURE_IDS, SYMBOL_CATEGORIES, SYMBOLS, structureTiles, structureVariant, symbolTiles} from '../lib/equation-catalog.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/equation.*']};
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };
export const INPUT_PREF = 'slate.equationInput';
const inputOf = ctx => (ctx.prefs?.[INPUT_PREF] === 'latex' ? 'latex' : 'unicode');

/** The equation the selection is on: {pageId, id, pos, node}, or null. */
export function selectedEquation(ctx) {
  const c = ctx.doc;
  if (!isNotebook(c)) return null;
  const r = ctx.selection?.ranges?.[ctx.selection.primary ?? 0];
  const m = /^\/pg:([^/]+)\/(?:media|b|c):([^/]+)/.exec(r?.focus ?? r?.anchor ?? '');
  if (!m) return null;
  const pageId = decodeURIComponent(m[1]);
  if (!c.pages[pageId]) return null;
  const id = decodeURIComponent(m[2]);
  const hit = blockIndex(nodeOf(c.pages[pageId].body)).get(id);
  return hit?.node.type.name === 'equation' ? {pageId, id, pos: hit.pos, node: hit.node} : null;
}

/** Every equation on a page: [{id, pos, node}]. */
function equationsOn(ctx, pageId) {
  const out = [];
  pageDoc(ctx, pageId).descendants((node, pos) => { if (node.type.name === 'equation') out.push({id: node.attrs.id, pos, node}); return true; });
  return out;
}

const pageNow = ctx => (isNotebook(ctx.doc) ? (currentLocation(ctx.doc, ctx.selection).pageId ? {enabled: true} : {enabled: false, reason: 'No page is open'}) : {enabled: false, reason: 'No notebook is open'});
const equationNow = ctx => (selectedEquation(ctx) ? {enabled: true} : {enabled: false, reason: 'Select an equation'});

/** Put `text` into the selected equation (its first empty slot, else its end) or into a new equation at the caret. */
function put(ctx, text, {wrapInSlot = false} = {}) {
  const eq = selectedEquation(ctx);
  if (!eq) { const r = ctx.run('insert.equation', {linear: text}); return {...r, new: true}; }
  const linear = String(eq.node.attrs.linear ?? '');
  const slot = linear.indexOf(PLACEHOLDER);
  let next;
  if (slot >= 0) {
    const inScript = slot > 0 && (linear[slot - 1] === '^' || linear[slot - 1] === '_');
    const piece = wrapInSlot && inScript && [...text].length > 1 ? `(${text})` : text;
    next = linear.slice(0, slot) + piece + linear.slice(slot + PLACEHOLDER.length);
  } else next = linear + text;
  need([...next].length <= MAX_LINEAR, 'too_large', `An equation is at most ${MAX_LINEAR} characters`);
  editPage(ctx, eq.pageId, tr => tr.setNodeAttribute(eq.pos, 'linear', next), pageDoc(ctx, eq.pageId));
  return {id: eq.id, linear: next, new: false};
}

export default defineCommands({
  family: 'equation',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'equation.convert', label: 'Convert', risk: 'edit',
      description: 'Show the selected equation (scope current) or every equation on the page (scope all) as Professional (typeset) or Linear (the text as typed).',
      params: s.object({format: s.enum(['professional', 'linear']), scope: s.optional(s.enum(['current', 'all']))}),
      state(ctx, p) {
        if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
        const {pageId} = currentLocation(ctx.doc, ctx.selection);
        if ((p?.scope ?? 'current') === 'all') return pageId && equationsOn(ctx, pageId).length ? {enabled: true} : {enabled: false, reason: 'This page has no equations'};
        return equationNow(ctx);
      },
      run(ctx, p) {
        const scope = p.scope ?? 'current';
        let list, pageId;
        if (scope === 'all') {
          pageId = currentLocation(ctx.doc, ctx.selection).pageId;
          need(pageId, 'disabled', 'No page is open');
          list = equationsOn(ctx, pageId);
          need(list.length, 'disabled', 'This page has no equations');
        } else {
          const eq = selectedEquation(ctx);
          need(eq, 'disabled', 'Select an equation');
          pageId = eq.pageId; list = [eq];
        }
        const todo = list.filter(e => (e.node.attrs.format ?? 'professional') !== p.format);
        if (todo.length) editPage(ctx, pageId, tr => { for (const e of todo) tr.setNodeAttribute(e.pos, 'format', p.format); }, pageDoc(ctx, pageId));
        return {format: p.format, scope, changed: todo.length};
      },
    },
    {
      id: 'equation.setInput', label: 'Input Format', risk: 'read', effect: 'prefs',
      description: 'Choose the syntax a typed equation is written in: unicode (UnicodeMath linear format) or latex (converted to the linear format).',
      params: s.object({format: s.enum(['unicode', 'latex'])}),
      state: (ctx, p) => (isNotebook(ctx.doc) ? {enabled: true, checked: inputOf(ctx) === (p?.format ?? 'unicode')} : {enabled: false, reason: 'No notebook is open'}),
      run(ctx, p) { ctx.updatePrefs({[INPUT_PREF]: p.format}); return {format: p.format}; },
    },
    {
      id: 'equation.normalText', label: 'Normal Text', risk: 'edit',
      description: 'Show the selected equation as plain (non-math) text, or typeset again (value false).',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx) {
        const eq = selectedEquation(ctx);
        return eq ? {enabled: true, checked: eq.node.attrs.normalText === true} : equationNow(ctx);
      },
      run(ctx, p) {
        const eq = selectedEquation(ctx);
        need(eq, 'disabled', 'Select an equation');
        const on = p.value ?? eq.node.attrs.normalText !== true;
        if ((eq.node.attrs.normalText === true) !== on) editPage(ctx, eq.pageId, tr => tr.setNodeAttribute(eq.pos, 'normalText', on), pageDoc(ctx, eq.pageId));
        return {normalText: on};
      },
    },
    {
      id: 'equation.insertSymbol', label: 'Symbols', risk: 'edit',
      description: `Insert a math symbol from a category (${SYMBOL_CATEGORIES.join(', ')}) into the selected equation, or into a new one at the caret. symbol (or a gallery tile's value) is the character.`,
      params: s.object({category: s.optional(s.enum(SYMBOL_CATEGORIES)), symbol: s.optional(s.string({min: 1, max: 8})), value: s.optional(s.string({min: 1, max: 8}))}),
      state(ctx, p) {
        const st = pageNow(ctx);
        return st.enabled ? {...st, value: symbolTiles(p?.category ?? null)} : st;
      },
      run(ctx, p) {
        const ch = p.symbol ?? p.value;
        need(ch, 'invalid_params', 'Give the symbol to insert', {path: '/symbol'});
        const known = (p.category ? [p.category] : SYMBOL_CATEGORIES).some(id => SYMBOLS[id].symbols.includes(ch));
        need(known, 'invalid_params', `${ch} is not in ${p.category ? `the ${SYMBOLS[p.category].name} category` : 'any category'}`, {path: '/symbol'});
        return {symbol: ch, ...put(ctx, ch)};
      },
    },
    {
      id: 'equation.insertStructure', label: 'Structures', risk: 'edit',
      description: `Insert a structure template (${STRUCTURE_IDS.join(', ')}; variant, or a gallery tile's value, names one, else the first) into the selected equation's first empty slot (□) or end, or as a new equation at the caret.`,
      params: s.object({structure: s.enum(STRUCTURE_IDS), variant: s.optional(s.string({min: 1, max: 40})), value: s.optional(s.string({min: 1, max: 40}))}),
      state(ctx, p) {
        const st = pageNow(ctx);
        return st.enabled ? {...st, value: p?.structure ? structureTiles(p.structure) : []} : st;
      },
      run(ctx, p) {
        const variant = structureVariant(p.structure, p.variant ?? p.value);
        need(variant, 'invalid_params', `No ${p.variant ?? p.value} in ${p.structure}`, {path: '/variant'});
        return {structure: p.structure, variant: variant.id, ...put(ctx, variant.linear, {wrapInSlot: true})};
      },
    },
  ],
});
