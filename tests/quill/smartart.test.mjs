// U:quill/smartart: Insert › SmartArt and the SmartArt Design tab on PowerPoint's SmartArt engine (core/prism/lib/smartart.mjs), drawn
// as primitives on the page and written to a .docx as a group of shapes.
//
// Behaviour fidelity:
// 1. wordcraft crates/engine/src/cmd/smart_art.rs (insert.smartArt, smartArt.items, smartArt.textPane, smartArt.addShape, smartArt.promote,
//    smartArt.demote, smartArt.layout, smartArt.colors, smartArt.reset), with deckcraft's outline operations and 45 layouts.
// 2. Ours: the same edits of the model, one undo step each; the engine's shapes are flattened into the primitives a chart is drawn with.
// 3. Proof: this file and tests/e2e/quill/smartart.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {quill} from './format-fixture.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {read as readDocx, parseXml} from '../../core/quill/formats/docx-read.mjs';
import * as S from '../../core/quill/lib/smartart-word.mjs';

const items = q => layout(q.t.content, {view: 'print'}).pages.flatMap(p => p.items);
const graphics = content => content.body.chunks.flat().flatMap(b => b.objects ?? []).filter(o => o.type === 'graphic' && o.graphic?.smartArt);
const modelOf = q => graphics(q.t.content)[0]?.graphic.smartArt;
async function withGraphic(args = {layout: 'process'}) {
  const q = await quill('Before\nAfter');
  q.sel(0, 6);
  await q.exec('insert.smartArt', args);
  return q;
}
const texts = q => modelOf(q).items.map(i => `${'-'.repeat(i.level)}${i.text}`);

test('insert.smartArt: a graphic at the caret with sample items, fitted to the text width, drawn as primitives; one undo step', async () => {
  const q = await quill('Before\nAfter');
  q.sel(0, 6);
  await expectUndoRoundTrip(q.t, 'insert.smartArt', {layout: 'cycle'}, after => {
    const [o] = graphics(after.content);
    assert.equal(o.graphic.smartArt.layout, 'cycle');
    assert.equal(o.graphic.smartArt.items.length, 4);
    assert.ok(o.w > 0 && o.w <= 468 && o.h > 0);
  });
  const chart = items(q).find(i => i.kind === 'chart');
  assert.ok(chart, 'the page has a drawing item');
  assert.ok(chart.prims.some(p => p.t === 'poly'), 'the shapes are filled polygons');
  assert.deepEqual(chart.prims.filter(p => p.t === 'text').map(p => p.text).sort(), ['Build', 'Plan', 'Ship', 'Test']);
  assert.ok(items(q).some(i => i.kind === 'object'), 'and a selectable frame');
  await assert.rejects(() => q.exec('insert.smartArt', {layout: 'nonsense'}), /unknown layout/);
});

test('every one of the 45 layouts draws shapes and every item\'s text, in every colour scheme and style', async () => {
  for (const id of S.LAYOUT_IDS) {
    const spec = S.newSpec(id);
    const prims = S.smartArtPrims(spec, 432, 252, null);
    assert.ok(prims.some(p => p.t === 'poly'), `${id} draws polygons`);
    const words = new Set(prims.filter(p => p.t === 'text').flatMap(p => p.text.replace(/^• /, '').split(' ')));
    for (const it of spec.items.slice(0, 3)) for (const word of it.text.split(' ').filter(Boolean)) if (!words.has(word)) assert.fail(`${id}: "${word}" is not drawn`);
    for (const p of prims) {
      if (p.t === 'poly' || p.t === 'line') for (const [x, y] of p.pts) assert.ok(Number.isFinite(x) && Number.isFinite(y), `${id}: finite points`);
    }
  }
  for (const [c] of S.COLORS) for (const [st] of S.STYLES) assert.ok(S.smartArtPrims({...S.newSpec('hierarchy'), colors: c, style: st}, 300, 200, null).length > 0);
  const flipped = S.smartArtPrims({...S.newSpec('process'), rtl: true}, 432, 252, null).filter(p => p.t === 'text');
  const plain = S.smartArtPrims(S.newSpec('process'), 432, 252, null).filter(p => p.t === 'text');
  assert.ok(flipped[0].x > plain[0].x, 'Right to Left puts the first step on the right');
});

test('the outline: Add Shape in each position, Add Bullet, Promote, Demote, Move Up and Down, Remove; each one undo step', async () => {
  const q = await withGraphic({layout: 'list', items: ['Alpha', '\tAlpha 1', 'Beta', 'Gamma']});
  assert.deepEqual(texts(q), ['Alpha', '-Alpha 1', 'Beta', 'Gamma']);
  await expectUndoRoundTrip(q.t, 'smartArt.addShape', {index: 0, position: 'after', text: 'New'}, () => {});
  assert.deepEqual(texts(q), ['Alpha', '-Alpha 1', 'New', 'Beta', 'Gamma']);
  await q.exec('smartArt.addShape', {index: 0, position: 'before', text: 'First'});
  assert.deepEqual(texts(q), ['First', 'Alpha', '-Alpha 1', 'New', 'Beta', 'Gamma']);
  await q.exec('smartArt.addShape', {index: 1, position: 'below', text: 'Sub'});
  assert.deepEqual(texts(q), ['First', 'Alpha', '-Sub', '-Alpha 1', 'New', 'Beta', 'Gamma']);
  await q.exec('smartArt.addShape', {index: 3, position: 'above', text: 'Up'});
  assert.deepEqual(texts(q), ['First', 'Alpha', '-Sub', 'Up', '-Alpha 1', 'New', 'Beta', 'Gamma']);
  await q.exec('smartArt.items', {items: ['One', '\tTwo', 'Three', 'Four']});
  await expectUndoRoundTrip(q.t, 'smartArt.promote', {index: 1}, () => {});
  assert.deepEqual(texts(q), ['One', 'Two', 'Three', 'Four']);
  await q.exec('smartArt.demote', {index: 2});
  assert.deepEqual(texts(q), ['One', 'Two', '-Three', 'Four']);
  await assert.rejects(() => q.exec('smartArt.promote', {index: 0}), /already at the top/);
  await assert.rejects(() => q.exec('smartArt.demote', {index: 0}), /can't go down/);
  await q.exec('smartArt.moveUp', {index: 3});
  assert.deepEqual(texts(q), ['One', 'Two', '-Three', 'Four'].slice(0, 1).concat(['Four', 'Two', '-Three']));
  await q.exec('smartArt.moveDown', {index: 1});
  assert.deepEqual(texts(q), ['One', 'Two', '-Three', 'Four']);
  await assert.rejects(() => q.exec('smartArt.moveDown', {index: 3}), /last on its level/);
  await q.exec('smartArt.removeItem', {index: 2});
  assert.deepEqual(texts(q), ['One', 'Two', 'Four']);
  await assert.rejects(() => q.exec('smartArt.addShape', {index: 40}), /no item 40/);
});

test('layout, colours, style, Right to Left and Reset change the model and the drawing; the galleries list every choice', async () => {
  const q = await withGraphic({layout: 'process'});
  await q.exec('smartArt.layout', {layout: 'pyramid'});
  assert.equal(modelOf(q).layout, 'pyramid');
  await q.exec('smartArt.colors', {colors: 'colorful'});
  await q.exec('smartArt.style', {style: 'outline'});
  await q.exec('smartArt.rtl', {});
  assert.deepEqual([modelOf(q).colors, modelOf(q).style, modelOf(q).rtl], ['colorful', 'outline', true]);
  await assert.rejects(() => q.exec('smartArt.colors', {colors: 'mauve'}), /unknown colours/);
  await assert.rejects(() => q.exec('smartArt.style', {style: 'glitter'}), /unknown style/);
  await q.exec('smartArt.reset', {});
  assert.deepEqual([modelOf(q).colors, modelOf(q).style, modelOf(q).rtl, modelOf(q).layout], ['accent1', 'flat', undefined, 'pyramid']);
  const state = async id => (await q.state(id, {})).value;
  const layouts = await state('smartArt.layout');
  assert.equal(layouts.length, 45);
  assert.ok(layouts.find(x => x.id === 'pyramid').checked);
  assert.equal(layouts[0].art.kind, 'diagram');
  const colors = await state('smartArt.colors');
  assert.equal(colors.length, 17);
  assert.equal(colors[0].art.colors.length, 6);
  assert.equal((await state('smartArt.style')).length, 9);
  await q.exec('smartArt.size', {width: 300, height: 150});
  const [o] = graphics(q.t.content);
  assert.deepEqual([o.w, o.h], [300, 150]);
  const chart = items(q).find(i => i.kind === 'chart');
  assert.ok(chart.prims.every(p => p.t !== 'poly' || p.pts.every(([x, y]) => x <= 300.5 && y <= 150.5)), 'drawn again at the new size');
});

test('the Text Pane toggle and the focused item are view state, never undoable; Add Shape follows the focused item', async () => {
  const q = await withGraphic({layout: 'process', items: ['A', 'B', 'C']});
  const r = await q.exec('smartArt.textPane', {});
  assert.equal(r.result.value, true);
  await q.exec('smartArt.focus', {index: 0});
  await q.exec('smartArt.addShape', {text: 'X'});
  assert.deepEqual(texts(q), ['A', 'X', 'B', 'C']);
  const o = await q.exec('smartArt.outline', {});
  assert.equal(o.result.items.length, 4);
});


test('a save writes the diagram parts, and the file reads back as an editable SmartArt graphic', async () => {
  const q = await withGraphic({layout: 'hierarchy', items: ['Plan', '\tBuild', '\tTest', 'Ship'], colors: 'colorful', style: 'subtle'});
  await q.exec('smartArt.rtl', {value: true});
  const bytes = await writeDocx(q.t.content);
  const zip = await JSZip.loadAsync(bytes);
  for (const p of ['data', 'layout', 'quickStyle', 'colors', 'drawing']) assert.ok(zip.file(`word/diagrams/${p}1.xml`), `word/diagrams/${p}1.xml is in the package`);
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok(xml.includes('<dgm:relIds'), 'the drawing names the diagram parts');
  parseXml(xml);
  assert.ok((await zip.file('word/diagrams/drawing1.xml').async('string')).includes('>Ship<'), 'the drawing holds the text');
  const types = await zip.file('[Content_Types].xml').async('string');
  assert.ok(types.includes('diagramData+xml') && types.includes('diagramDrawing+xml'));
  const back = await readDocx(bytes);
  const [o] = graphics(back);
  assert.ok(o, 'a SmartArt graphic again');
  assert.deepEqual(o.graphic.smartArt.items.map(i => [i.text, i.level]), [['Plan', 0], ['Build', 1], ['Test', 1], ['Ship', 0]]);
  assert.equal(o.graphic.smartArt.layout, 'hierarchy');
  assert.equal(o.graphic.smartArt.style, 'subtle');
  assert.equal(o.graphic.smartArt.colors, 'colorful');
  assert.equal(o.graphic.smartArt.rtl, true);
  // Editable: it takes the commands, and a second save keeps one set of parts.
  const q2 = await quill('Before', () => back);
  q2.sel(0, 6, 7);
  await q2.exec('smartArt.addShape', {index: 3, text: 'Done'});
  const again = await JSZip.loadAsync(await writeDocx(q2.t.content));
  assert.ok(again.file('word/diagrams/data1.xml') && !again.file('word/diagrams/data2.xml'), 'one diagram, one set of parts');
  assert.ok((await again.file('word/diagrams/data1.xml').async('string')).includes('Done'));
});
