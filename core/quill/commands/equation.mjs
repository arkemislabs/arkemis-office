// Insert › Symbols › Equation and the Equation tab: a built-in or new equation, symbols and structures into it, Professional or
// Linear, Display or Inline, Normal Text, justification, the input syntax (Unicode or LaTeX).
//
// Built on Slate's equation model instead of translating wordcraft's math tree (doc/src/math*.rs, about 4,800 lines): an equation is
// the linear text a person types (UnicodeMath: `x=(-b±√(b^2-4ac))/2a`), typeset from it (core/slate/lib/equation.mjs, laid out for
// the page by core/quill/lib/math-layout.mjs), and the galleries are Slate's: Office's nine built-in equations, eight symbol sets and
// eleven structure galleries (core/slate/lib/equation-catalog.mjs), with the empty slots of a structure as `□`. Ids and arguments follow
// docs/spec/quill.json `equation.*`; Word's own behaviours (display or in-line in the paragraph, `m:jc`, OMML in the .docx) are
// Quill's (core/quill/lib/omml.mjs). Not checked against wordcraft's math editor, which moves a caret through the tree: here an
// equation is edited as its linear text (equation.edit, the Edit Equation box), so equation.type/move/backspace/delete/enter and
// Number are not offered (docs/spec/patches/quill/equation.json).
//
// An equation is an inline object `{type: 'equation', linear, display, math?: {jc}, format?: 'linear', normalText?, omml?}`; `omml`
// is the markup of an equation read from a .docx and goes back as it was until the equation is changed here.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/table-session.mjs';
import * as P from '../model/para.mjs';
import {selectedObjects} from '../context.mjs';
import {BODY} from '../model/document.mjs';
import {UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import {PRESETS, PLACEHOLDER, MAX_LINEAR} from '../../slate/lib/equation.mjs';
import {STRUCTURE_IDS, SYMBOL_CATEGORIES, SYMBOLS, structureTiles, structureVariant, symbolTiles, presetTiles} from '../../slate/lib/equation-catalog.mjs';
import {latexToLinear} from '../../slate/lib/equation-latex.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/equation.rs']};
export const INPUT_PREF = 'quill.equationInput';
const inputOf = ctx => (ctx.prefs?.[INPUT_PREF] === 'latex' ? 'latex' : 'unicode');
const JC = ['left', 'right', 'center', 'centerGroup'];

const bad = m => new CommandError('invalid_params', m);
const disabled = m => new CommandError('disabled', m);
const isEq = o => o?.type === 'equation';

/** The equation in the selection (or just before the caret): {pos, obj}, or null. */
function pickEquation(S) {
  const [a, b] = T.ordered(S.sel);
  if (a.story !== b.story) return null;
  return selectedObjects(S.d.content, a, b, 1, isEq)[0] ?? null;
}

function equationState(ctx) {
  const st = T.ready(ctx);
  if (!st.enabled) return st;
  try { return pickEquation(T.open(ctx)) ? {enabled: true} : {enabled: false, reason: 'select an equation first'}; } catch { return {enabled: false, reason: 'select an equation first'}; }
}

/** Whether any story of the document holds an equation. */
function anyEquation(d) {
  for (const st of [BODY, ...Object.keys(d.c.parts ?? {}).map(Number)]) {
    for (const path of d.paraPaths(st)) { const p = d.para(st, path); if (p && P.objectsOf(p).some(isEq)) return true; }
  }
  return false;
}

/** The text of `linear` as the stored linear format (LaTeX is converted), cleaned and cut to the limit. */
function linearOf(text, latex) {
  const t = String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u2028\u2029]/g, ' ').replace(/\s*\n\s*/g, ' ');
  const out = latex ? latexToLinear(t) : t;
  return [...out].slice(0, MAX_LINEAR).join('');
}

/** An edit of the selected equation: `f(copy)` returns its changes; the kept `.docx` markup (omml) goes with a change of its text or look. */
function edit(ctx, f, {keepOmml = false} = {}) {
  const S = T.open(ctx);
  const hit = pickEquation(S);
  if (!hit) throw disabled('select an equation first');
  const copy = {...hit.obj};
  const next = f(copy, S) ?? copy;
  if (!keepOmml) delete next.omml;
  const para = S.d.paraMut(hit.pos.story, hit.pos.path);
  P.setObjectAt(para, hit.pos.off, next);
  S.sel = {anchor: {...hit.pos}, focus: {...hit.pos, off: hit.pos.off + 1}};
  S.cells = null;
  return T.finish(S, {equation: {linear: next.linear, display: !!next.display}});
}

/** A new equation at the caret (replacing the selection), selected; in a paragraph of its own it is a display equation. */
function insertNew(ctx, {linear, display}) {
  const S = T.open(ctx);
  const props = T.typingProps(S);
  const at = T.deleteSelection(S);
  const alone = (() => { const p = S.d.paraAt(at); return !!p && ![...p.text].some(c => c !== P.OBJ && !/\s/u.test(c)); })();
  const obj = {type: 'equation', linear, display: display ?? alone};
  const end = S.d.insertObject(at, obj, props);
  S.sel = {anchor: T.clonePos(at), focus: end};
  S.cells = null;
  return T.finish(S, {equation: {linear, display: obj.display}});
}

/** Put `text` into the selected equation (its first empty slot □, else its end, a structure after a space so it is a term of its own) or into a new equation at the caret (Slate's `put`). */
function put(ctx, text, {wrapInSlot = false, separate = false} = {}) {
  const S = T.open(ctx);
  const hit = pickEquation(S);
  if (!hit) return {...insertNew(ctx, {linear: text}), new: true};
  const linear = String(hit.obj.linear ?? '');
  const slot = linear.indexOf(PLACEHOLDER);
  let next;
  if (slot >= 0) {
    const inScript = slot > 0 && (linear[slot - 1] === '^' || linear[slot - 1] === '_');
    const piece = wrapInSlot && inScript && [...text].length > 1 ? `(${text})` : text;
    next = linear.slice(0, slot) + piece + linear.slice(slot + PLACEHOLDER.length);
  } else next = separate && linear && !/[\s(\[{=+\-−×÷±^_/¦@&]$/u.test(linear) ? `${linear} ${text}` : linear + text;
  if ([...next].length > MAX_LINEAR) throw new CommandError('too_large', `An equation is at most ${MAX_LINEAR} characters`);
  return {...edit(ctx, o => { o.linear = next; }), new: false};
}

// Word's Structures galleries over Slate's catalog: a stacked fraction's empty slots drawn as boxes (Slate's CSS draws them; here they would be
// blank tiles), and Word's Delta (δy/δx) fraction, which Slate's gallery lacks. Skewed, Linear and Small Fraction differ only in how Word builds
// them up (the equation here is its linear form), so they are not offered.
const BOX = /<mspace class="eq-ph"[^>]*><\/mspace>/g;
const EXTRA = {fraction: [{id: 'delta-lower', label: 'Delta', value: 'delta-lower', iconOnly: true, linear: 'δy/δx', mathml: '<math><mfrac><mrow><mi>δ</mi><mi>y</mi></mrow><mrow><mi>δ</mi><mi>x</mi></mrow></mfrac></math>'}]};
function wordTiles(structure) {
  const base = structureTiles(structure).map(t => (t.mathml ? {...t, mathml: t.mathml.replace(BOX, '<mtext>\u25a1</mtext>')} : t));
  const extra = (EXTRA[structure] ?? []).map(({linear: _l, ...t}) => t);
  const at = base.findIndex(t => t.id === 'partial');
  return at < 0 ? [...base, ...extra] : [...base.slice(0, at + 1), ...extra, ...base.slice(at + 1)];
}
const wordVariant = (structure, id) => (EXTRA[structure] ?? []).find(v => v.id === id) ?? structureVariant(structure, id);

export default defineCommands({
  family: 'equation',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.equation', label: 'Equation', risk: 'edit',
      // The Equation gallery: Office's built-in equations drawn as tiles (a click sends `value`, the tile's id).
      state(ctx, p) { const st = T.ready(ctx); return st.enabled && !p?.builtin && !p?.preset && !p?.value && p?.linear === undefined ? {...st, value: presetTiles()} : st; },
      description: `Equation (Insert › Symbols): an equation at the caret. \`builtin\` (or \`preset\`) is one of Office's built-in equations (${Object.keys(PRESETS).join('|')}); \`linear\` is its text in the linear format (UnicodeMath, or LaTeX with \`latex\` true); \`display\` puts it on a line of its own (default: when the paragraph has nothing else). With none of them the Insert Equation box asks for the text (run from code, an empty equation is inserted).`,
      params: s.object({builtin: s.optional(s.string({max: 40})), preset: s.optional(s.nullable(s.string({max: 40}))), value: s.optional(s.string({max: 40})), linear: s.optional(s.string({max: MAX_LINEAR * 2})), latex: s.optional(s.boolean()), display: s.optional(s.boolean())}),
      run(ctx, p) {
        const id = p.builtin ?? p.preset ?? p.value ?? null;
        if (id !== null && !PRESETS[id]) throw bad(`unknown built-in equation \`${id}\`: ${Object.keys(PRESETS).join('|')}`);
        if (id !== null) return insertNew(ctx, {linear: PRESETS[id].linear, display: p.display ?? true});
        if (p.linear !== undefined) return insertNew(ctx, {linear: linearOf(p.linear, p.latex ?? inputOf(ctx) === 'latex'), display: p.display});
        // Insert New Equation: an empty equation at the caret, typed in place (the page view starts its editor: view.equationEdit).
        const r = insertNew(ctx, {linear: '', display: p.display});
        ctx.setView({equationEdit: (ctx.view?.equationEdit ?? 0) + 1});
        return r;
      }},
    {id: 'equation.edit', label: 'Edit Equation', risk: 'edit', state: equationState,
      description: 'Edit Equation (Equation tab): the text of the selected equation in the linear format (`linear`; LaTeX when `latex` is true or the input is LaTeX) and whether it is a `display` equation. With no parameters, the Edit Equation box asks for them.',
      params: s.object({linear: s.optional(s.string({max: MAX_LINEAR * 2})), latex: s.optional(s.boolean()), display: s.optional(s.boolean())}),
      run(ctx, p) {
        if (p.linear === undefined && p.display === undefined) {
          // Edit Equation: the equation is edited where it stands (the page view starts its editor: view.equationEdit).
          const S = T.open(ctx);
          if (!pickEquation(S)) throw disabled('select an equation first');
          ctx.setView({equationEdit: (ctx.view?.equationEdit ?? 0) + 1});
          return T.selResult(S);
        }
        return edit(ctx, o => {
          if (p.linear !== undefined) o.linear = linearOf(p.linear, p.latex ?? inputOf(ctx) === 'latex');
          if (p.display !== undefined) o.display = p.display;
        });
      }},
    {id: 'equation.get', label: 'Equation Text', risk: 'read', state: equationState,
      description: 'The selected equation: {linear, display, format, normalText, justification}.',
      params: s.object({}),
      run(ctx) {
        const hit = pickEquation(T.open(ctx));
        if (!hit) throw disabled('select an equation first');
        const o = hit.obj;
        return {linear: o.linear ?? '', display: !!o.display, format: o.format ?? 'professional', normalText: !!o.normalText, justification: o.math?.jc ?? 'center'};
      }},
    {id: 'equation.convert', label: 'Convert', risk: 'edit',
      description: 'Convert (Equation › Tools): show the selected equation (`all` false) or every equation in the document (`all` true) as `format` professional (typeset) or linear (the text as typed). `to` and `all` are the spec\'s names, `format` and `scope` (current|all) Slate\'s.',
      params: s.object({format: s.optional(s.enum(['professional', 'linear'])), to: s.optional(s.enum(['professional', 'linear'])), scope: s.optional(s.enum(['current', 'all'])), all: s.optional(s.boolean())}),
      state(ctx, p) {
        const all = p?.all === true || p?.scope === 'all';
        if (!all) return equationState(ctx);
        const st = T.ready(ctx);
        if (!st.enabled) return st;
        try { return anyEquation(T.open(ctx).d) ? {enabled: true} : {enabled: false, reason: 'the document has no equations'}; } catch { return {enabled: true}; }
      },
      run(ctx, p) {
        const format = p.format ?? p.to;
        if (!format) throw bad('`format` (professional|linear) is required');
        const all = p.all === true || p.scope === 'all';
        if (!all) return edit(ctx, o => { if (format === 'linear') o.format = 'linear'; else delete o.format; return o; }, {keepOmml: true});
        const S = T.open(ctx);
        let changed = 0;
        S.d.objectsMut(isEq, o => {
          if ((o.format ?? 'professional') === format) return o;
          changed++;
          const n = {...o};
          if (format === 'linear') n.format = 'linear'; else delete n.format;
          return n;
        });
        return T.finish(S, {format, scope: 'all', changed});
      }},
    {id: 'equation.inputFormat', label: 'Input Format', risk: 'read', effect: 'prefs',
      description: 'Unicode / LaTeX (Equation › Tools): the syntax equation text is typed in: unicode (UnicodeMath linear format) or latex (converted to the linear format).',
      params: s.object({format: s.enum(['unicode', 'latex'])}),
      state: (ctx, p) => ({enabled: true, checked: inputOf(ctx) === (p?.format ?? 'unicode')}),
      run(ctx, p) { ctx.updatePrefs({[INPUT_PREF]: p.format}); return {format: p.format}; }},
    {id: 'equation.normalText', label: 'Normal Text', risk: 'edit',
      description: 'Normal Text (Equation › Tools): show the selected equation as plain (non-math) text, or typeset again (`value` false).',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx) {
        const st = equationState(ctx);
        if (!st.enabled) return st;
        try { return {...st, checked: pickEquation(T.open(ctx)).obj.normalText === true}; } catch { return st; }
      },
      run: (ctx, p) => edit(ctx, o => { const on = p.value ?? o.normalText !== true; if (on) o.normalText = true; else delete o.normalText; return o; }, {keepOmml: true})},
    {id: 'equation.display', label: 'Display', risk: 'edit',
      description: 'Display / Inline (Equation › Equation Options): `value` true puts the selected equation on a line of its own (Display), false in the line of text (Inline); with no value it switches.',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx, p) {
        const st = equationState(ctx);
        if (!st.enabled) return st;
        try { return {...st, checked: !!pickEquation(T.open(ctx)).obj.display === (p?.value ?? true)}; } catch { return st; }
      },
      run: (ctx, p) => edit(ctx, o => { o.display = p.value ?? !o.display; return o; })},
    {id: 'equation.justify', label: 'Justification', risk: 'edit',
      description: 'Justification (Equation › Equation Options): where a display equation sits on its line, `jc` left, right, center or centerGroup (centered as a group).',
      params: s.object({jc: s.enum(JC)}),
      state(ctx, p) {
        const st = equationState(ctx);
        if (!st.enabled) return st;
        try { return {...st, checked: (pickEquation(T.open(ctx)).obj.math?.jc ?? 'center') === p?.jc}; } catch { return st; }
      },
      run: (ctx, p) => edit(ctx, o => { o.math = {...(o.math ?? {}), jc: p.jc}; return o; })},
    {id: 'equation.exit', label: 'Close Equation', risk: 'edit', state: equationState,
      description: 'Close Equation (Equation › Equation Options): leave the equation; the caret goes just after it.',
      params: s.object({}),
      run(ctx) {
        const S = T.open(ctx);
        const hit = pickEquation(S);
        if (!hit) throw disabled('select an equation first');
        const at = {...hit.pos, off: hit.pos.off + 1};
        S.sel = {anchor: at, focus: {...at}};
        S.cells = null;
        return T.finish(S);
      }},
    {id: 'equation.insertSymbol', label: 'Symbols', risk: 'edit',
      description: `Symbols (Equation › Symbols): a math symbol from a set (${SYMBOL_CATEGORIES.join(', ')}) into the selected equation, or into a new one at the caret. \`symbol\` (or \`value\`, or \`char\`) is the character.`,
      params: s.object({category: s.optional(s.enum(SYMBOL_CATEGORIES)), symbol: s.optional(s.string({min: 1, max: 8})), value: s.optional(s.string({min: 1, max: 8})), char: s.optional(s.string({min: 1, max: 8}))}),
      state(ctx, p) { const st = T.ready(ctx); return st.enabled ? {...st, value: symbolTiles(p?.category ?? null)} : st; },
      run(ctx, p) {
        const ch = p.symbol ?? p.value ?? p.char;
        if (!ch) throw bad('give the symbol to insert (`symbol`)');
        const known = (p.category ? [p.category] : SYMBOL_CATEGORIES).some(id => SYMBOLS[id].symbols.includes(ch));
        if (!known) throw bad(`${ch} is not in ${p.category ? `the ${SYMBOLS[p.category].name} set` : 'any symbol set'}`);
        return {symbol: ch, ...put(ctx, ch)};
      }},
    {id: 'equation.insertStructure', label: 'Structures', risk: 'edit',
      description: `Structures (Equation › Structures): a template (${STRUCTURE_IDS.join(', ')}; \`variant\`, or a gallery tile's \`value\` or \`id\`, names one, else the first) into the selected equation's first empty slot (□) or its end, or as a new equation at the caret.`,
      params: s.object({structure: s.enum(STRUCTURE_IDS), variant: s.optional(s.string({min: 1, max: 40})), value: s.optional(s.string({min: 1, max: 40})), id: s.optional(s.string({min: 1, max: 40}))}),
      state(ctx, p) { const st = T.ready(ctx); return st.enabled ? {...st, value: p?.structure ? wordTiles(p.structure) : []} : st; },
      run(ctx, p) {
        const v = wordVariant(p.structure, p.variant ?? p.value ?? p.id);
        if (!v) throw bad(`no ${p.variant ?? p.value ?? p.id} in ${p.structure}`);
        return {structure: p.structure, variant: v.id, ...put(ctx, v.linear, {wrapInSlot: true, separate: true})};
      }},
  ],
});
