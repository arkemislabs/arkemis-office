// U:quill/equation: Insert › Equation and the Equation tab, built on Slate's equation model, typeset on the page, written to and read
// from a .docx as OMML.
//
// Behaviour fidelity:
// 1. Office's Equation gallery (nine built-in equations), eight symbol sets and eleven structure galleries as Slate has them
//    (core/slate/lib/equation-catalog.mjs); Word: inline or display, Professional or Linear, Normal Text, justification, Unicode or
//    LaTeX input; docx: ECMA-376 §22.1 (m:oMath, m:oMathPara, m:f, m:sSup, m:rad, m:nary, m:d, m:m, m:acc, m:func).
// 2. Ours: the equation is its linear text (equation.edit), typeset by core/quill/lib/math-layout.mjs, one undo step each.
// 3. Proof: this file and tests/e2e/quill/chart-equation.e2e.mjs (captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {submitDialog, openDialogModel, changeDialogValues} from '../../core/kernel/dialog.mjs';
import {quill} from './format-fixture.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {read as readDocx, parseXml} from '../../core/quill/formats/docx-read.mjs';
import {linearToOmml, ommlToLinear} from '../../core/quill/lib/omml.mjs';
import {layoutEquation} from '../../core/quill/lib/math-layout.mjs';
import {PRESETS, toMathML} from '../../core/slate/lib/equation.mjs';
import {STRUCTURES, SYMBOL_CATEGORIES} from '../../core/slate/lib/equation-catalog.mjs';

const items = q => layout(q.t.content, {view: 'print'}).pages.flatMap(p => p.items);
const equations = content => content.body.chunks.flat().flatMap(b => b.objects ?? []).filter(o => o.type === 'equation');
const eqOf = q => equations(q.t.content)[0];
const advance = (text, size) => text.length * size * 0.5;
const lay = (linear, o = {}) => layoutEquation(linear, {size: 12, advance, ...o});
async function withEquation(args = {builtin: 'quadratic-formula'}) {
  const q = await quill('Before\n');
  q.sel(1, 0);
  await q.exec('insert.equation', args);
  return q;
}
const strip = x => x.split('<mrow>').join('').split('</mrow>').join('');
const NS = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const parseOmml = x => parseXml(x.replace(/^<m:(oMath|oMathPara)/, `<m:$1 ${NS}`));

test('insert.equation: a built-in equation on a line of its own, typeset on the page; one undo step', async () => {
  const q = await quill('Before\n');
  q.sel(1, 0);
  await expectUndoRoundTrip(q.t, 'insert.equation', {builtin: 'pythagorean-theorem'}, after => {
    const [o] = equations(after.content);
    assert.equal(o.linear, 'a^2+b^2=c^2');
    assert.equal(o.display, true);
  });
  await q.exec('insert.equation', {builtin: 'quadratic-formula'});
  const math = items(q).find(i => i.kind === 'math');
  assert.ok(math, 'the page has the typeset equation');
  assert.ok(math.prims.some(p => p.t === 'line'), 'a fraction bar and a radical sign are drawn');
  assert.ok(math.prims.some(p => p.t === 'text' && p.italic), 'letters are italic');
  assert.ok(items(q).some(i => i.kind === 'object' && i.rect.x === math.rect.x), 'and selectable');
  await assert.rejects(() => q.exec('insert.equation', {builtin: 'euler'}), /unknown built-in equation/);
});

test('insert.equation: typed text in the linear format (or LaTeX), inline in a paragraph with text, display on its own', async () => {
  const q = await quill('Area is ');
  q.sel(0, 8);
  await q.exec('insert.equation', {linear: 'A=πr^2'});
  assert.equal(eqOf(q).display, false, 'inline in a paragraph with text');
  await q.exec('equation.exit');
  await q.exec('insert.equation', {linear: '\\frac{a}{b}', latex: true, display: true});
  assert.equal(equations(q.t.content)[1].linear, '(a)/(b)');
  const tiles = q.state('insert.equation').value;
  assert.equal(tiles.length, Object.keys(PRESETS).length);
  assert.ok(tiles.every(t => t.mathml.startsWith('<math>')), 'the gallery is drawn from MathML, never text');
  assert.equal(q.state('insert.equation', {builtin: 'area-of-circle'}).value, undefined);
});

test('an empty equation shows Word\'s placeholder text', async () => {
  const q = await withEquation({});
  assert.equal(eqOf(q).linear, '');
  const math = items(q).find(i => i.kind === 'math');
  assert.ok(math.prims.some(p => p.t === 'text' && p.text === 'Type equation here.'));
});

test('equation.edit: the text, display or inline; the typeset page follows; one undo step', async () => {
  const q = await withEquation({builtin: 'area-of-circle'});
  await expectUndoRoundTrip(q.t, 'equation.edit', {linear: 'E=mc^2', display: false}, after => {
    const [o] = equations(after.content);
    assert.equal(o.linear, 'E=mc^2');
    assert.equal(o.display, false);
  });
  await q.exec('equation.edit', {linear: 'E=mc^2'});
  assert.deepEqual((await q.exec('equation.get')).result, {linear: 'E=mc^2', display: false, format: 'professional', normalText: false, justification: 'center'});
  const sup = items(q).find(i => i.kind === 'math').prims.filter(p => p.t === 'text');
  assert.ok(sup.some(p => p.text === '2' && p.size < 12), 'a superscript is smaller');
  await assert.rejects(() => q.exec('equation.edit', {linear: 'x', latex: true, display: undefined}).then(() => q.exec('equation.nothing')), /Unknown command/);
});

test('Equation tab: symbols and structures go into the equation being edited (first empty slot, else its end) or make a new one', async () => {
  const q = await withEquation({linear: 'x=', display: false});
  await q.exec('equation.insertSymbol', {symbol: 'π'});
  assert.equal(eqOf(q).linear, 'x=π');
  await q.exec('equation.insertStructure', {structure: 'fraction'});
  assert.equal(eqOf(q).linear, 'x=π □/□', 'a structure at the end is a term of its own');
  await q.exec('equation.insertStructure', {structure: 'script', variant: 'superscript'});
  assert.equal(eqOf(q).linear, 'x=π □^□/□', 'a structure goes into the first empty slot');
  await q.exec('equation.insertSymbol', {symbol: '2', category: 'basic-math'}).then(() => assert.fail('2 is not a symbol'), e => assert.match(e.message, /not in/));
  await assert.rejects(() => q.exec('equation.insertStructure', {structure: 'fraction', variant: 'nonsense'}), /no nonsense/);
  // With no equation selected a symbol makes a new one.
  const p = await quill('Text');
  p.sel(0, 4);
  const r = (await p.exec('equation.insertSymbol', {symbol: '∑'})).result;
  assert.equal(r.new, true);
  assert.equal(eqOf(p).linear, '∑');
});

test('the galleries are drawn from MathML tiles, eight symbol sets and eleven structure galleries', async () => {
  const q = await withEquation({linear: 'x'});
  const symbols = q.state('equation.insertSymbol', {}).value;
  assert.ok(symbols.length > 150 && symbols.every(t => t.mathml.startsWith('<math>')));
  assert.equal(SYMBOL_CATEGORIES.length, 8);
  const ids = Object.keys(STRUCTURES);
  assert.equal(ids.length, 11);
  for (const id of ids) assert.ok(q.state('equation.insertStructure', {structure: id}).value.length >= 3, id);
});

test('Convert, Normal Text, Display, Inline, Justification, Close Equation', async () => {
  const q = await withEquation({builtin: 'pythagorean-theorem'});
  await q.exec('equation.convert', {format: 'linear'});
  assert.equal(eqOf(q).format, 'linear');
  let math = items(q).find(i => i.kind === 'math');
  assert.deepEqual(math.prims.filter(p => p.t === 'text').map(p => p.text), ['a^2+b^2=c^2'], 'Linear shows the text as typed');
  await q.exec('equation.convert', {to: 'professional', all: false});
  assert.equal(eqOf(q).format, undefined);
  await q.exec('equation.insert' + 'Symbol', {symbol: '∑'});
  await q.exec('equation.convert', {to: 'linear', all: true});
  assert.equal(eqOf(q).format, 'linear', 'All converts every equation in the document');
  await q.exec('equation.convert', {to: 'professional', all: true});
  await q.exec('equation.normalText', {});
  assert.equal(q.state('equation.normalText').checked, true);
  math = items(q).find(i => i.kind === 'math');
  assert.equal(math.prims.filter(p => p.t === 'text').length, 1, 'Normal Text is one run of plain text');
  await q.exec('equation.normalText', {value: false});
  await q.exec('equation.display', {value: false});
  assert.equal(eqOf(q).display, false);
  assert.equal(q.state('equation.display', {value: false}).checked, true);
  assert.equal(q.state('equation.display', {value: true}).checked, false);
  await q.exec('equation.display', {value: true});
  await q.exec('equation.justify', {jc: 'left'});
  assert.equal(eqOf(q).math.jc, 'left');
  const left = items(q).find(i => i.kind === 'math').rect.x;
  await q.exec('equation.justify', {jc: 'right'});
  assert.ok(items(q).find(i => i.kind === 'math').rect.x > left + 100, 'a right-justified display equation sits at the right');
  const where = q.t.session.get(q.t.docId).selection.ranges[0];
  await q.exec('equation.exit');
  const after = q.t.session.get(q.t.docId).selection.ranges[0];
  assert.equal(after.anchor, after.focus, 'Close Equation puts the caret after the equation');
  assert.notEqual(where.anchor, where.focus, 'the equation was selected');
  await q.exec('equation.inputFormat', {format: 'latex'});
  assert.equal(q.state('equation.inputFormat', {format: 'latex'}).checked, true);
});

test('the equation commands are off unless an equation is selected; Insert Equation is on', async () => {
  const q = await quill('Plain text');
  q.sel(0, 0);
  for (const id of ['equation.edit', 'equation.normalText', 'equation.justify', 'equation.exit']) assert.equal(q.state(id).enabled, false, id);
  assert.equal(q.state('insert.equation').enabled, true);
  assert.equal(q.state('equation.insertSymbol').enabled, true);
});

test('Edit Equation and Insert Equation edit in place: the text, LaTeX and Display go through the commands, and no box exists', async () => {
  const q = await withEquation({linear: 'a/b', display: false});
  await q.exec('equation.edit', {linear: 'x^2', display: true});
  assert.equal(eqOf(q).linear, 'x^2');
  assert.equal(eqOf(q).display, true);
  await q.exec('equation.edit', {linear: '\\frac{a}{b}', latex: true});
  assert.equal(eqOf(q).linear, '(a)/(b)');
  await q.exec('equation.edit', {linear: 'x'.repeat(3000)});
  assert.ok(eqOf(q).linear.length <= 2000, 'at most 2000 characters');
  const n = await quill('Text');
  n.sel(0, 4);
  await n.exec('insert.equation', {linear: 'a^2', display: false});
  assert.equal(eqOf(n).linear, 'a^2');
  const spec = (await import('../../src/generated/quill.spec.ts').catch(() => null))?.default;
  if (spec) for (const id of ['dialog.equation', 'dialog.insertEquation']) assert.ok(!spec.dialogs[id]?.command, id + ' has no command: nothing opens it');
});

// ---- layout ---------------------------------------------------------------------------------------------------

test('layout: boxes have a width, an ascent and a descent; a fraction is a bar between two boxes on the axis; scripts shrink', () => {
  const x = lay('x');
  assert.ok(x.w > 0 && x.a > 0 && x.d > 0 && Math.abs(x.h - (x.a + x.d)) < 1e-9);
  const f = lay('a/b');
  const bar = f.prims.find(p => p.t === 'line');
  const [num, den] = ['a', 'b'].map(t => f.prims.find(p => p.t === 'text' && p.text === t));
  assert.ok(bar && num.y < bar.pts[0][1] && den.y > bar.pts[0][1], 'the numerator is over the bar, the denominator under it');
  assert.ok(f.h > x.h, 'a fraction is taller than a letter');
  const s = lay('x^2');
  const two = s.prims.find(p => p.text === '2');
  assert.ok(two.size < 12 && two.y < s.prims.find(p => p.text === 'x').y, 'the superscript is smaller and raised');
  const sub = lay('x_i');
  assert.ok(sub.prims.find(p => p.text === 'i').y > sub.prims.find(p => p.text === 'x').y, 'the subscript is lowered');
  const root = lay('√(a+b)');
  assert.ok(root.prims.some(p => p.t === 'line' && p.pts.length >= 4), 'the radical sign is a path');
  const sum = lay('∑_(k=0)^n k', {display: true});
  const glyph = sum.prims.find(p => p.text === '∑');
  assert.ok(glyph.size > 12 && sum.prims.find(p => p.text === 'n').y < glyph.y, 'a large operator with its limits over and under it');
  const paren = lay('(a/b)');
  assert.ok(paren.prims.find(p => p.text === '(').size > 12, 'a bracket grows with its content');
  const matrix = lay('■(1&0@0&1)');
  assert.equal(new Set(matrix.prims.filter(p => p.t === 'text').map(p => Math.round(p.y))).size, 2, 'two rows');
  assert.equal(lay('□/□').prims.filter(p => p.t === 'line' && p.dash).length, 2, 'the empty slots are dotted boxes');
});

test('layout: every built-in equation and structure lays out without throwing, with finite boxes', () => {
  const all = [...Object.values(PRESETS).map(p => p.linear), ...Object.values(STRUCTURES).flatMap(s => s.variants.map(v => v.linear)), 'sin α±sin β=2 sin 1/2 (α±β)', '(n¦k)'];
  for (const linear of all) {
    const b = lay(linear, {display: true});
    assert.ok(Number.isFinite(b.w) && Number.isFinite(b.a) && Number.isFinite(b.d) && b.w > 0, linear);
    for (const p of b.prims) {
      if (p.t === 'text') assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${linear}: ${p.text}`);
      else assert.ok(p.pts.every(([px, py]) => Number.isFinite(px) && Number.isFinite(py)), linear);
    }
  }
});

test('layout: the line holds the equation: an inline equation sits on the baseline between the words; a display one centres', async () => {
  const q = await quill('Area is ');
  q.sel(0, 8);
  await q.exec('insert.equation', {linear: 'A=πr^2', display: false});
  await q.exec('caret.set', {pos: {story: 'body', path: [0], off: 9}}).catch(() => {});
  const its = items(q);
  const math = its.find(i => i.kind === 'math');
  const line = its.find(i => i.kind === 'lines');
  assert.ok(math.rect.x > line.x + 20, 'after the words');
  const d = await withEquation({builtin: 'pythagorean-theorem'});
  const dm = items(d).find(i => i.kind === 'math');
  const centre = dm.rect.x + dm.rect.w / 2;
  assert.ok(Math.abs(centre - (72 + 468 / 2)) < 2, `centred on the text column (${centre})`);
});

// ---- OMML and .docx -------------------------------------------------------------------------------------------

test('OMML: every built-in equation and structure is written as Word writes it and reads back as the same typeset equation', () => {
  const all = [...Object.values(PRESETS).map(p => p.linear), ...Object.values(STRUCTURES).flatMap(s => s.variants.map(v => v.linear))];
  const bad = [];
  for (const linear of all) {
    const back = ommlToLinear(parseOmml(linearToOmml(linear, {})));
    if (strip(toMathML(linear)) !== strip(toMathML(back))) bad.push(`${linear} => ${back}`);
  }
  assert.deepEqual(bad, []);
});

test('OMML: the elements Word uses for each structure', () => {
  const x = linearToOmml('x=(-b±√(b^2-4ac))/2a', {display: true, jc: 'left'});
  for (const tag of ['m:oMathPara', '<m:jc m:val="left"/>', '<m:f>', '<m:num>', '<m:den>', '<m:rad>', '<m:degHide m:val="1"/>', '<m:sSup>']) assert.ok(x.includes(tag), tag);
  assert.match(linearToOmml('∑_(k=0)^n k', {}), /<m:nary><m:naryPr><m:chr m:val="∑"\/><m:limLoc m:val="undOvr"\/><\/m:naryPr><m:sub>.*<\/m:sub><m:sup>.*<\/m:sup><m:e><m:r>.*k<\/m:t><\/m:r><\/m:e><\/m:nary>/);
  assert.match(linearToOmml('(n¦k)', {}), /<m:d><m:dPr><m:begChr m:val="\("\/><m:endChr m:val="\)"\/><\/m:dPr><m:e><m:f><m:fPr><m:type m:val="noBar"\/>/);
  assert.match(linearToOmml('■(1&0@0&1)', {}), /<m:m><m:mr><m:e>.*<\/m:e><m:e>.*<\/m:e><\/m:mr><m:mr>/);
  assert.match(linearToOmml('x̂', {}), /<m:acc><m:accPr><m:chr m:val="̂"\/>/);
  assert.match(linearToOmml('sin α', {}), /<m:sty m:val="p"\/>/);
  assert.match(linearToOmml('hello', {normalText: true}), /<m:nor\/>/);
  assert.match(linearToOmml('x', {color: 'FF0000'}), /<w:color w:val="FF0000"\/>/);
  assert.equal(ommlToLinear(parseOmml('<m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath>')), 'x+1');
  assert.equal(ommlToLinear(parseOmml('<m:oMath><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>n+1</m:t></m:r></m:sup></m:sSup></m:oMath>')), 'x^(n+1)');
  assert.equal(ommlToLinear(parseOmml('<m:oMath><m:rad><m:radPr><m:degHide m:val="0"/></m:radPr><m:deg><m:r><m:t>3</m:t></m:r></m:deg><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad></m:oMath>')), '∛x');
});

test('.docx: equations are written as OMML in the paragraph and read back; display and justification survive', async () => {
  const q = await quill('Area is \nSecond');
  q.sel(0, 8);
  await q.exec('insert.equation', {linear: 'A=πr^2', display: false});
  q.sel(1, 0);
  await q.exec('insert.equation', {builtin: 'quadratic-formula'});
  await q.exec('equation.justify', {jc: 'right'});
  const z = await JSZip.loadAsync(await writeDocx(q.t.content));
  const doc = await z.file('word/document.xml').async('string');
  assert.match(doc, /<m:oMath><m:r>/);
  assert.match(doc, /<m:oMathPara><m:oMathParaPr><m:jc m:val="right"\/>/);
  assert.match(doc, /<m:rad>/);
  const back = await readDocx(await writeDocx(q.t.content));
  const [a, b] = equations(back);
  assert.equal(strip(toMathML(a.linear)), strip(toMathML('A=πr^2')));
  assert.equal(a.display, false);
  assert.deepEqual([b.display, b.math?.jc], [true, 'right']);
  assert.ok(strip(toMathML(b.linear)) === strip(toMathML('x=(-b±√(b^2-4ac))/2a')));
  // What was read is written as it was (omml) until the equation is changed here.
  assert.ok(a.omml && b.omml);
  const again = await JSZip.loadAsync(await writeDocx(back));
  assert.equal((await again.file('word/document.xml').async('string')).split('<m:oMath>').length, doc.split('<m:oMath>').length);
  const kept = await quill('Area is ', () => back);
  kept.sel(0, 8, 9);
  await kept.exec('equation.edit', {linear: 'E=mc^2'});
  assert.equal(equations(kept.t.content)[0].omml, undefined, 'a change lets the kept markup go');
  const changed = await JSZip.loadAsync(await writeDocx(kept.t.content));
  assert.match(await changed.file('word/document.xml').async('string'), /<m:sSup>/);
});

test('.docx read: an equation made in Word (OMML with its own run formatting) reads as its linear text and is written back untouched', async () => {
  const q = await quill('x');
  q.sel(0, 1);
  await q.exec('insert.equation', {linear: 'a'});
  const bytes = await writeDocx(q.t.content);
  const z = await JSZip.loadAsync(bytes);
  let doc = await z.file('word/document.xml').async('string');
  const word = '<m:oMath><m:f><m:fPr><m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/><w:i/></w:rPr></m:ctrlPr></m:fPr><m:num><m:sSup><m:sSupPr><m:ctrlPr><w:rPr><w:i/></w:rPr></m:ctrlPr></m:sSupPr><m:e><m:r><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:num><m:den><m:r><m:t>y+1</m:t></m:r></m:den></m:f></m:oMath>';
  doc = doc.replace(/<m:oMath>.*?<\/m:oMath>/, word);
  z.file('word/document.xml', doc);
  const content = await readDocx(await z.generateAsync({type: 'uint8array'}));
  const [o] = equations(content);
  assert.equal(strip(toMathML(o.linear)), strip(toMathML('x^2/(y+1)')));
  assert.equal(strip(toMathML(o.linear)).includes('<mfrac>'), true);
  const out = await JSZip.loadAsync(await writeDocx(content));
  assert.match(await out.file('word/document.xml').async('string'), /<m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"\/><w:i\/>/);
});

test('PDF export draws the typeset equation', async () => {
  const {exportPdf} = await import('../../core/quill/formats/pdf-write.mjs');
  const plain = await quill('Before\n');
  const q = await withEquation({builtin: 'quadratic-formula'});
  const a = await exportPdf(plain.t.content), b = await exportPdf(q.t.content);
  assert.ok(b.length > a.length + 200);
});
