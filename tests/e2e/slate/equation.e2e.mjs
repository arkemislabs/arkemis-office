// U:slate/equation: OneNote's Equation Tools tab on a real page, end to end through the bridge: the
// tab appears when an equation is selected (and Ink Equation is not offered), the Equation gallery
// of built-in equations, the Symbols gallery (eight categories) and the Structures galleries drawn
// from MathML, Convert (Professional / Linear), Normal Text, the Unicode / LaTeX input syntax, and
// structures filling one another's empty slots. Every step is checked in the document and captured.
//
// Behaviour fidelity: see tests/slate/equation.test.mjs. Evidence: artifacts/e2e/slate/equation/*.png.
// No OS or DOM input: ui.activate / ui.menu / ui.tab / engine.execute only.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createContent, newPageRecord, SECTION_COLORS, validateContent} from '../../../core/slate/schema.mjs';

const NOW = new Date().toISOString();
const para = (id, text) => ({type: 'paragraph', attrs: {id, style: 'normal', align: null, indent: 0, dir: null, tags: [], spacing: null, audio: null}, ...(text ? {content: [{type: 'text', text}]} : {})});

function seed() {
  let n = 0;
  const c = createContent('Maths', {uid: () => `q${(n++).toString(36).padStart(4, '0')}`, now: NOW});
  c.tree = ['snotes']; c.groups = {};
  c.sections = {snotes: {id: 'snotes', name: 'Notes', color: SECTION_COLORS[2], created: NOW, pages: [{id: 'palg', level: 0}]}};
  c.pages = {palg: {...newPageRecord({id: 'palg', title: 'Algebra', created: NOW}),
    body: {type: 'doc', content: [{type: 'container', attrs: {id: 'calg', x: 60, y: 130, width: 560}, content: [para('b1', 'Pythagoras: '), para('b2', 'Structures: '), para('b3', 'Typed: ')]}]}}};
  return validateContent(c);
}

const fileOf = (id, content) => ({id, schema: 2, kind: 'slate', title: content.notebook.name, revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [], content});

test('slate Equation tab: galleries, conversions, symbols and structures work on an equation through the ribbon', {timeout: 600_000}, async () => {
  const doc = 'slate-equation';
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'slate', flow: 'slate/equation', files: [fileOf(doc, seed())], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async (address, as = 'json') => (await app.rpc('document.read', {doc, address, as})).value;
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const pick = (id, value) => app.rpc('ui.activate', {doc, control: id, ...(value === undefined ? {} : {value})});
  const select = (anchor, focus = anchor) => app.rpc('selection.set', {doc, ranges: [{anchor, focus}]});
  const inspect = () => app.rpc('ui.inspect', {doc});
  const equations = async block => {
    const out = [];
    const walk = n => { if (n?.type === 'equation') out.push(n.attrs); (n?.content ?? []).forEach(walk); };
    walk(await read(`/pg:palg/b:${block}`, 'json'));
    return out;
  };
  const menu = async (id, shot) => {
    await app.rpc('ui.menu', {doc, control: id});
    await settle(700);
    assert.equal((await inspect()).tab, 'equation', `${id}: the gallery is shown on the Equation tab`);
    assert.equal((await inspect()).menu, id, `${id}: its gallery is open`);
    if (shot) await app.capture(shot, {doc});
    await app.rpc('ui.menu', {doc, control: id, open: false});
  };
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}).catch(() => null); return ui?.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000})
      .catch(e => { throw new Error(e.message + log()); });

    // ---- An equation on the page brings the Equation tab ----------------------------------------------------------------
    await select('/pg:palg/b:b1/t:12');
    assert.equal((await inspect()).contextualTabs.includes('equation'), false, 'no equation selected: no Equation tab');
    await pick('insert.symbols.equation.pythagorean-theorem');
    await app.until(async () => (await inspect()).contextualTabs.includes('equation') || null, {timeout: 10_000});
    await app.rpc('ui.tab', {doc, id: 'equation'});
    await settle(900);
    await app.capture('01-equation-tab', {doc});
    const ids = (await inspect()).controls.map(c => c.id);
    for (const id of ['equation.tools.equation', 'equation.conversions.convert', 'equation.conversions.unicode', 'equation.conversions.latex', 'equation.conversions.normal-text',
      'equation.symbols.symbols', 'equation.structures.fraction', 'equation.structures.matrix']) assert.ok(ids.includes(id), `${id} is on the tab`);
    assert.equal(ids.includes('equation.tools.ink-equation'), false, 'Ink Equation has no engine');
    assert.equal((await equations('b1'))[0].linear, 'a^2+b^2=c^2');

    // ---- The Equation gallery, drawn ---------------------------------------------------------------------------------
    await menu('equation.tools.equation', '02-equation-gallery');
    const gallery = (await inspect()).controls.find(c => c.id === 'equation.tools.equation');
    assert.equal(gallery.value.length, 9);
    assert.ok(gallery.value.every(t => t.mathml.startsWith('<math>')), 'tiles are MathML');

    // ---- Conversions: Linear and back, Normal Text -------------------------------------------------------------------------
    await pick('equation.conversions.convert.current-linear');
    await settle(600);
    assert.equal((await equations('b1'))[0].format, 'linear');
    await app.capture('03-converted-to-linear', {doc});
    await pick('equation.conversions.convert.current-professional');
    assert.equal((await equations('b1'))[0].format, 'professional');
    await pick('equation.conversions.normal-text');
    await settle(500);
    assert.equal((await equations('b1'))[0].normalText, true);
    assert.equal((await inspect()).controls.find(c => c.id === 'equation.conversions.normal-text').checked, true);
    await app.capture('04-normal-text', {doc});
    await pick('equation.conversions.normal-text');
    assert.equal((await equations('b1'))[0].normalText, false);

    // ---- Symbols: the gallery of eight categories, a symbol into the equation --------------------------------------------------
    await menu('equation.symbols.symbols', '05-symbols-gallery');
    const symbols = (await inspect()).controls.find(c => c.id === 'equation.symbols.symbols');
    assert.ok(symbols.value.length > 200);
    assert.deepEqual([...new Set(symbols.value.map(t => t.group))].length, 8);
    // The Pythagoras equation stays as it is: the symbol goes into a new equation with an empty slot.
    await exec('insert.equation', {linear: 'x=□'});
    await pick('equation.symbols.symbols', 'π');
    assert.deepEqual((await equations('b1')).map(e => e.linear), ['a^2+b^2=c^2', 'x=π'], 'the symbol filled the empty slot of the selected equation');

    // ---- Structures: a new equation at the caret, then slots filled one by one ----------------------------------------------------
    await select('/pg:palg/b:b2/t:12');
    await exec('insert.equation', {linear: '□'});
    await app.rpc('ui.tab', {doc, id: 'equation'});
    await menu('equation.structures.fraction', '06-fraction-gallery');
    await pick('equation.structures.fraction', 'stacked');
    await settle(400);
    let [eq] = await equations('b2');
    assert.equal(eq.linear, '□/□');
    assert.equal((await inspect()).contextualTabs.includes('equation'), true);
    await pick('equation.structures.script', 'superscript');
    await pick('equation.structures.radical', 'square-root');
    await pick('equation.symbols.symbols', '∞');
    await settle(500);
    [eq] = await equations('b2');
    assert.ok(eq.linear.includes('√∞') && eq.linear.includes('^'), eq.linear);
    await app.capture('07-structures-filled', {doc});
    await menu('equation.structures.matrix', '08-matrix-gallery');
    await menu('equation.structures.accent', '09-accent-gallery');
    await menu('equation.structures.large-operator', '10-large-operator-gallery');
    await pick('equation.structures.matrix', 'brackets-2x2');
    await pick('equation.structures.accent', 'vector');
    await settle(600);
    await app.capture('11-matrix-and-accent', {doc});

    // ---- Unicode / LaTeX: LaTeX typed is converted --------------------------------------------------------------------------------------
    await pick('equation.conversions.latex');
    assert.equal((await inspect()).controls.find(c => c.id === 'equation.conversions.latex').checked, true);
    await select('/pg:palg/b:b3/t:7');
    await exec('insert.equation', {linear: String.raw`\frac{-b\pm\sqrt{b^{2}-4ac}}{2a}`});
    await settle(600);
    const [typed] = await equations('b3');
    assert.equal(typed.linear, '(-b±√(b^2-4ac))/(2a)');
    await app.capture('12-latex-input', {doc});
    await pick('equation.conversions.unicode');
    assert.equal((await inspect()).controls.find(c => c.id === 'equation.conversions.unicode').checked, true);
    await pick('equation.conversions.convert.all-linear');
    await settle(600);
    assert.deepEqual([...(await equations('b1')), ...(await equations('b2')), ...(await equations('b3'))].map(e => e.format), ['linear', 'linear', 'linear', 'linear']);
    await app.capture('13-all-linear', {doc});
    await pick('equation.conversions.convert.all-professional');
    await settle(500);
    await app.capture('14-all-professional', {doc});
  } finally {
    await app.close();
  }
});
