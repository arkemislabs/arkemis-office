// U:slate/equation: OneNote's Equation Tools tab (Conversions, Symbols, Structures).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `equation.*` names the commands.
//    OneNote's behaviour: Convert shows the selected equation (or all of them) as Professional
//    (typeset) or Linear; Unicode / LaTeX pick the typing syntax; Normal Text turns an equation to
//    plain text; Symbols and Structures insert into the equation being edited (or start one).
// 2. Ours does the same on the page's equation nodes (attributes format / normalText), converts LaTeX to
//    the linear format the renderer typesets (core/slate/lib/equation.mjs), and builds the gallery
//    tiles from MathML, never from labels.
// 3. Proof: these tests and tests/e2e/slate/equation.e2e.mjs (the tab, galleries, captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {PLACEHOLDER, structure, toMathML, typeset} from '../../core/slate/lib/equation.mjs';
import {latexToLinear} from '../../core/slate/lib/equation-latex.mjs';
import {STRUCTURES, STRUCTURE_IDS, SYMBOLS, SYMBOL_CATEGORIES, presetTiles, structureTiles, symbolTiles} from '../../core/slate/lib/equation-catalog.mjs';
import {evaluate} from '../../core/slate/context.mjs';
import {textSession, textSel} from './format-helpers.mjs';

const eqs = t => { const out = []; const walk = n => { if (n.type === 'equation') out.push(n); (n.content ?? []).forEach(walk); }; walk(t.content.pages[t.pageId].body); return out; };
const sel = t => t.doc.selection.ranges[0].anchor;
async function session(paras = ['x'], at = 1) { return textSession(paras, {selection: p => textSel(p, 'b1', at)}); }

// ---------------------------------------------------------------------------------------------
// The renderer: matrices, accents, placeholders, limits

test('the linear renderer typesets matrices, accents, placeholders and limits', () => {
  assert.deepEqual(structure('■(a&b@c&d)'), ['id', 'matrix']);
  const m = toMathML('[■(a&b@c&d)]');
  assert.equal((m.match(/<mtr>/g) ?? []).length, 2);
  assert.equal((m.match(/<mtd>/g) ?? []).length, 4);
  assert.match(m, /<mo>\[<\/mo>.*<mtable>.*<mo>\]<\/mo>/);
  assert.match(toMathML('x̄'), /<mover accent="true"><mi>x<\/mi><mo>¯<\/mo><\/mover>/);
  assert.match(toMathML('a⃗'), /<mo>→<\/mo>/);
  assert.match(toMathML(`${PLACEHOLDER}/${PLACEHOLDER}`), /<mfrac><mspace class="eq-ph"[^>]*><\/mspace><mspace class="eq-ph"/);
  assert.match(toMathML('lim_(n→∞) 1/n'), /<munder><mi mathvariant="normal">lim<\/mi>/);
  assert.match(toMathML('(n¦k)'), /<mtable>/);
  // Nothing is lost on matrices of different sizes or with empty cells.
  assert.equal((toMathML('■(1&0&0@0&1&0@0&0&1)').match(/<mtd>/g) ?? []).length, 9);
  assert.equal((toMathML('■(a&@&d)').match(/<mtd>/g) ?? []).length, 4);
  // An unclosed matrix does not hang or throw.
  assert.ok(toMathML('■(a&b@c'));
});

test('an equation shows professional (typeset), linear (as typed) or normal text', () => {
  assert.match(typeset({linear: 'a/b'}), /<mfrac>/);
  assert.match(typeset({linear: 'a/b', format: 'professional'}), /<math>/);
  assert.equal(typeset({linear: 'a/b', format: 'linear'}), '<span class="slate-equation-linear">a/b</span>');
  assert.equal(typeset({linear: 'a<b', format: 'linear'}), '<span class="slate-equation-linear">a&lt;b</span>');
  assert.equal(typeset({linear: 'a/b', normalText: true}), '<math><mtext>a/b</mtext></math>');
  assert.equal(typeset({linear: '  '}), '');
});

test('LaTeX is converted to the linear format', () => {
  const cases = [
    [String.raw`\frac{a}{b}`, '(a)/(b)'], [String.raw`x^{2}+y_i`, 'x^2+y_i'], [String.raw`x^{n+1}`, 'x^(n+1)'], [String.raw`\sqrt{x}`, '√(x)'], [String.raw`\sqrt[3]{x}`, '∛(x)'],
    [String.raw`\alpha\leq\beta`, 'α≤β'], [String.raw`\sum_{k=0}^{n}k`, '∑_(k=0)^n k'.replace(' ', '')], [String.raw`\sin^2\theta+\cos^2\theta=1`, 'sin^2θ+cos^2θ=1'],
    [String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`, '(■(a&b@c&d))'], [String.raw`\begin{bmatrix}1&0\\0&1\end{bmatrix}`, '[■(1&0@0&1)]'], [String.raw`\binom{n}{k}`, '(n¦k)'],
    [String.raw`\vec{v}`, 'v⃗'], [String.raw`\left(x\right)`, '(x)'], [String.raw`\text{if }x>0`, 'if x>0'], [String.raw`a \times b \pm c`, 'a × b ± c'], [String.raw`\infty`, '∞'],
  ];
  for (const [tex, linear] of cases) assert.equal(latexToLinear(tex), linear, tex);
  // What the converter makes, the renderer typesets.
  assert.deepEqual(structure(latexToLinear(String.raw`\frac{\sqrt{a^2+b^2}}{2}`)).filter(k => ['frac', 'sqrt', 'sup'].includes(k)), ['frac', 'sqrt', 'sup']);
  assert.equal(latexToLinear('plain text'), 'plain text');
  assert.equal(latexToLinear(String.raw`\unknowncommand`), 'unknowncommand');
  assert.equal(latexToLinear('{'.repeat(60) + 'x'), '{'.repeat(60) + 'x', 'too deeply nested: returned as it was');
});

// ---------------------------------------------------------------------------------------------
// The catalogue and its tiles

test('every structure variant typesets as the structure it is named for, with dotted boxes for its slots', () => {
  assert.equal(STRUCTURE_IDS.length, 11);
  const kind = {fraction: 'frac', script: ['sup', 'sub', 'subsup'], radical: 'sqrt', integral: 'nary', 'large-operator': 'nary', bracket: 'fenced', function: 'fn', accent: 'accent', 'limit-and-log': 'fn', operator: 'sym', matrix: 'matrix'};
  for (const id of STRUCTURE_IDS) {
    const want = [].concat(kind[id]);
    assert.ok(STRUCTURES[id].variants.length >= 4, `${id} has variants`);
    for (const v of STRUCTURES[id].variants) {
      const found = structure(v.linear);
      assert.ok(found.some(k => want.includes(k)), `${id}/${v.id}: ${v.linear} -> ${found}`);
      assert.ok(toMathML(v.linear).startsWith('<math>'), v.id);
    }
    const first = STRUCTURES[id].variants[0];
    assert.ok(first.linear.includes(PLACEHOLDER), `${id}: the first variant is an empty template`);
  }
  assert.equal(new Set(STRUCTURE_IDS.flatMap(id => STRUCTURES[id].variants.map(v => `${id}/${v.id}`))).size, STRUCTURE_IDS.flatMap(id => STRUCTURES[id].variants).length, 'ids are unique');
});

test('the galleries\' tiles are drawn from MathML and never carry text of their own', () => {
  assert.equal(SYMBOL_CATEGORIES.length, 8);
  for (const id of SYMBOL_CATEGORIES) assert.ok(SYMBOLS[id].symbols.length >= 24, id);
  const all = symbolTiles();
  assert.equal(all.length, SYMBOL_CATEGORIES.reduce((n, id) => n + SYMBOLS[id].symbols.length, 0));
  assert.ok(all.every(t => t.mathml.startsWith('<math>') && t.iconOnly === true && t.group));
  assert.ok(all.filter(t => t.group === 'Basic Math').every(t => t.inline !== false), 'the strip shows the first category');
  assert.ok(all.filter(t => t.group === 'Geometry').every(t => t.inline === false));
  const greek = symbolTiles('greek-letters');
  assert.equal(greek[0].value, 'α');
  assert.match(greek[0].mathml, /<mi>α<\/mi>/);
  assert.equal(greek[0].group, undefined);
  for (const id of STRUCTURE_IDS) assert.ok(structureTiles(id).every(t => t.mathml.startsWith('<math>') && t.iconOnly === true), id);
  assert.equal(presetTiles().length, 9);
  assert.ok(presetTiles().every(t => t.mathml.startsWith('<math>')));
  assert.deepEqual(structureTiles('nope'), []);
});

// ---------------------------------------------------------------------------------------------
// The commands

test('Structures and Symbols start an equation at the caret; with one selected they fill its first empty slot or go at its end', async () => {
  const t = await session(['Sum '], 4);
  assert.deepEqual(eqs(t), []);
  const made = await expectUndoRoundTrip(t, 'equation.insertStructure', {structure: 'fraction'});
  assert.equal(made.result.new, true);
  assert.equal(eqs(t).length, 1);
  assert.equal(eqs(t)[0].attrs.linear, `${PLACEHOLDER}/${PLACEHOLDER}`);
  assert.match(sel(t), /\/media:/, 'the new equation is selected: the Equation tab shows');
  assert.equal(evaluate(t.content, t.doc.selection).equation, true);
  // Selected: the first slot is filled.
  await t.exec('equation.insertSymbol', {category: 'greek-letters', symbol: 'π'});
  assert.equal(eqs(t)[0].attrs.linear, `π/${PLACEHOLDER}`);
  await t.exec('equation.insertStructure', {structure: 'script', variant: 'superscript'});
  assert.equal(eqs(t)[0].attrs.linear, `π/${PLACEHOLDER}^${PLACEHOLDER}`, 'a script in the denominator slot');
  await t.exec('equation.insertStructure', {structure: 'radical', variant: 'square-root'});
  assert.equal(eqs(t)[0].attrs.linear, `π/√${PLACEHOLDER}^${PLACEHOLDER}`);
  // A gallery tile's value names the variant or the symbol.
  await t.exec('equation.insertSymbol', {category: 'basic-math', value: '∞'});
  assert.ok(eqs(t)[0].attrs.linear.startsWith('π/√∞'));
  await t.exec('equation.insertStructure', {structure: 'matrix', value: 'empty-2x2'});
  assert.ok(structure(eqs(t)[0].attrs.linear).includes('matrix'));
  // No empty slot left: it goes at the end.
  const full = await session(['x'], 1);
  await full.exec('insert.equation', {linear: 'a+b'});
  await full.exec('equation.insertSymbol', {category: 'operators', symbol: '×'});
  assert.equal(eqs(full)[0].attrs.linear, 'a+b×');
  // A slot after ^ or _ takes a multi-character structure in brackets.
  const g = await session(['x'], 1);
  await g.exec('insert.equation', {linear: `x^${PLACEHOLDER}`});
  await g.exec('equation.insertStructure', {structure: 'fraction', variant: 'pi-over-2'});
  assert.equal(eqs(g)[0].attrs.linear, 'x^(π/2)');
});

test('Symbols and Structures refuse what is not in the catalogue and report their tiles as the control state', async () => {
  const t = await session();
  await assert.rejects(t.exec('equation.insertSymbol', {category: 'greek-letters', symbol: '∑'}), /not in the Greek Letters category/);
  await assert.rejects(t.exec('equation.insertSymbol', {category: 'arrows'}), /Give the symbol/);
  await assert.rejects(t.exec('equation.insertStructure', {structure: 'fraction', variant: 'nope'}), /No nope in fraction/);
  await assert.rejects(t.exec('equation.insertStructure', {structure: 'nope'}), /structure/);
  assert.equal(t.state('equation.insertSymbol', {category: 'geometry'}).value.length, SYMBOLS.geometry.symbols.length);
  assert.equal(t.state('equation.insertSymbol', {}).value.length, symbolTiles().length);
  assert.equal(t.state('equation.insertStructure', {structure: 'matrix'}).value.length, STRUCTURES.matrix.variants.length);
  assert.equal(t.state('insert.equation', {}).value.length, 9);
  assert.equal(t.state('insert.equation', {preset: 'area-of-circle'}).value, undefined);
  // The gallery's tile (value) inserts the built-in equation.
  await t.exec('insert.equation', {value: 'pythagorean-theorem'});
  assert.equal(eqs(t)[0].attrs.linear, 'a^2+b^2=c^2');
  await assert.rejects(t.exec('insert.equation', {value: 'nope'}), /not a built-in equation/);
});

test('Convert shows the selected equation, or all on the page, as Professional or Linear; Normal Text toggles plain text', async () => {
  const t = await session();
  assert.equal(t.state('equation.convert', {format: 'linear', scope: 'current'}).enabled, false, 'the caret is not in an equation yet: scope current needs one');
  assert.equal(t.state('equation.convert', {format: 'linear', scope: 'all'}).enabled, false, 'and the page has none');
  await t.exec('insert.equation', {linear: 'a/b'});
  await t.exec('insert.equation', {linear: 'x^2'});
  assert.equal(eqs(t).length, 2);
  assert.equal(t.state('equation.convert', {format: 'linear', scope: 'all'}).enabled, true);
  await expectUndoRoundTrip(t, 'equation.convert', {format: 'linear', scope: 'current'}, (_, r) => assert.equal(r.result.changed, 1));
  assert.deepEqual(eqs(t).map(e => e.attrs.format), ['professional', 'linear']);
  const all = await expectUndoRoundTrip(t, 'equation.convert', {format: 'linear', scope: 'all'});
  assert.equal(all.result.changed, 1, 'only the one still professional changed');
  assert.deepEqual(eqs(t).map(e => e.attrs.format), ['linear', 'linear']);
  await t.exec('equation.convert', {format: 'professional', scope: 'all'});
  assert.deepEqual(eqs(t).map(e => e.attrs.format), ['professional', 'professional']);
  // Normal Text: a toggle with a checked state, on the selected equation.
  assert.equal(t.state('equation.normalText').checked, false);
  await expectUndoRoundTrip(t, 'equation.normalText', {});
  assert.deepEqual(eqs(t).map(e => e.attrs.normalText), [false, true]);
  assert.equal(t.state('equation.normalText').checked, true);
  await t.exec('equation.normalText', {value: false});
  assert.deepEqual(eqs(t).map(e => e.attrs.normalText), [false, false]);
  // With no equation selected these are disabled with a reason.
  t.session.setSelection(t.docId, textSel(t.pageId, 'b1', 0), {origin: 'test'});
  assert.equal(t.state('equation.normalText').enabled, false);
  assert.equal(t.state('equation.normalText').reason, 'Select an equation');
  await assert.rejects(t.exec('equation.convert', {format: 'linear'}), /Select an equation|disabled/);
});

test('Unicode and LaTeX choose the syntax typed equations are written in; LaTeX is converted as it is entered', async () => {
  const t = await session();
  assert.equal(t.state('equation.setInput', {format: 'unicode'}).checked, true);
  assert.equal(t.state('equation.setInput', {format: 'latex'}).checked, false);
  await t.exec('equation.setInput', {format: 'latex'});
  assert.equal(t.state('equation.setInput', {format: 'latex'}).checked, true);
  assert.equal(t.state('equation.setInput', {format: 'unicode'}).checked, false);
  assert.equal(t.session.prefs['slate.equationInput'], 'latex');
  await t.exec('insert.equation', {linear: String.raw`\frac{a}{b}`});
  assert.equal(eqs(t)[0].attrs.linear, '(a)/(b)');
  const id = eqs(t)[0].attrs.id;
  await t.exec('equation.edit', {id, linear: String.raw`x^{2}+\alpha`});
  assert.equal(eqs(t)[0].attrs.linear, 'x^2+α');
  // Presets are linear whatever the syntax.
  await t.exec('insert.equation', {preset: 'area-of-circle'});
  assert.equal(eqs(t)[1].attrs.linear, 'A=πr^2');
  await t.exec('equation.setInput', {format: 'unicode'});
  await t.exec('insert.equation', {linear: String.raw`\frac{a}{b}`});
  assert.equal(eqs(t)[2].attrs.linear, String.raw`\frac{a}{b}`, 'in Unicode mode text is kept as typed');
});

test('the Equation tab\'s commands exist; Ink Equation and handwriting are not registered', async () => {
  const t = await session();
  for (const id of ['equation.convert', 'equation.setInput', 'equation.normalText', 'equation.insertSymbol', 'equation.insertStructure', 'insert.equation', 'equation.edit']) assert.ok(t.registry.has(id), id);
  assert.equal(t.registry.has('insert.inkEquation'), false);
});
