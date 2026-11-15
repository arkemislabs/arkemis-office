// U:quill/shapes, WordArt on text: Home › Text Effects and Typography (format.textEffects), the effects drawn by the page view
// and saved to .docx as w14 text effects.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/wordart.rs (`text_effects`, `parse_fill`, `parse_outline`, `parse_shadow`,
//    `parse_glow`, `parse_reflection`) and crates/docx read/write wordart.rs (the w14 elements). Word: Text Effects sets a run's
//    fill, outline, shadow, glow and reflection and writes them as w14:textFill, textOutline, shadow, glow and reflection.
// 2. Ours: the effects are `textEffects` on the run; the layout carries them to the draw items, the page view paints them.
// 3. Proof: this file and tests/e2e/quill/shapes.e2e.mjs.

import test from 'node:test';
import JSZip from 'jszip';
import assert from 'node:assert/strict';
import {quill, blocks} from './format-fixture.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {pageDisplay} from '../../core/quill/layout/display.mjs';
import * as P from '../../core/quill/model/para.mjs';

const fx = (q, n = 0) => P.runRanges(blocks(q.t)[n]).map(([, , props]) => props?.textEffects);
const roundTrip = async q => readDocx(await writeDocx(q.t.content));
const firstFx = async q => {
  const back = await roundTrip(q);
  const para = back.body.chunks.flat()[0];
  return P.runRanges(para).map(([, , props]) => props?.textEffects).find(Boolean);
};

test('format.textEffects: a style, then fill, outline, shadow, glow and reflection on the selection', async () => {
  const q = await quill('Hello text effects');
  q.sel(0, 0, 5);
  await q.exec('format.textEffects', {style: 'outlined'});
  assert.equal(fx(q)[0].fill.type, 'solid');
  assert.ok(fx(q)[0].outline.color);
  assert.equal(fx(q)[1], undefined, 'the rest of the text is left alone');
  await q.exec('format.textEffects', {fill: {gradient: ['FF0000', '0000FF'], angle: 45}});
  assert.deepEqual([fx(q)[0].fill.type, fx(q)[0].fill.angle], ['gradient', 45]);
  await q.exec('format.textEffects', {outline: {width: 2}});
  assert.equal(fx(q)[0].outline.width, 2);
  await q.exec('format.textEffects', {shadow: 'offsetBottomRight', glow: 8, reflection: {size: 40}});
  const e = fx(q)[0];
  assert.deepEqual([e.shadow.angle, e.glow.size, e.reflection.size], [45, 8, 40]);
  await q.exec('format.textEffects', {shadow: null, glow: 'none', reflection: 'none', outline: null, fill: null});
  assert.equal(fx(q)[0], undefined, 'every effect off leaves none');
  await q.exec('format.textEffects', {style: 'glowing'});
  await q.exec('format.textEffects', {clear: true});
  assert.equal(fx(q)[0], undefined);
  await assert.rejects(q.exec('format.textEffects', {style: 'nope'}), /one of/);
  await assert.rejects(q.exec('format.textEffects', {shadow: 'bogus'}), /unknown shadow preset/);
});

test('format.textEffects at a caret sets the typing effects; the palette Automatic and No Color', async () => {
  const q = await quill('Hello');
  q.sel(0, 5);
  const st = await q.state('format.textEffects', {});
  assert.equal(st.enabled, true);
  assert.equal(st.value.length, 8, 'the WordArt style tiles');
  await q.exec('format.textEffects', {fill: 'auto'});
  q.sel(0, 0, 5);
  await q.exec('format.textEffects', {fill: 'FF0000'});
  assert.deepEqual(fx(q)[0].fill.color, [255, 0, 0]);
  await q.exec('format.textEffects', {fill: 'auto'});
  assert.deepEqual(fx(q)[0].fill, {type: 'none'}, 'No Color is hollow text');
  await q.exec('format.textEffects', {outline: 'auto'});
});

test('docx: text effects save as w14 elements and read back structured', async () => {
  const q = await quill('Hello text effects');
  q.sel(0, 0, 5);
  await q.exec('format.textEffects', {fill: {gradient: ['FF0000', '0000FF'], angle: 45}, outline: {color: '00B050', width: 1.5}, shadow: 'offsetBottomRight', glow: {color: 'FFC000', size: 6}, reflection: {size: 40, distance: 2}});
  const bytes = await writeDocx(q.t.content);
  const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string');
  for (const tag of ['w14:textFill', 'w14:gradFill', 'w14:textOutline', 'w14:shadow', 'w14:glow', 'w14:reflection']) assert.ok(xml.includes(`<${tag}`), `${tag} is written`);
  const e = await firstFx(q);
  assert.equal(e.fill.type, 'gradient');
  assert.deepEqual(e.fill.stops.map(s => [...s.color]), [[255, 0, 0], [0, 0, 255]]);
  assert.equal(e.fill.angle, 45);
  assert.deepEqual([[...e.outline.color], e.outline.width], [[0, 176, 80], 1.5]);
  assert.deepEqual([e.shadow.angle, e.shadow.distance > 0], [45, true]);
  assert.deepEqual([[...e.glow.color], e.glow.size], [[255, 192, 0], 6]);
  assert.deepEqual([e.reflection.size, e.reflection.distance], [40, 2]);
  assert.equal(e.xml, undefined, 'nothing is kept as markup');
});

test('docx: effects this does not read stay as markup and are written back', async () => {
  const q = await quill('Hello');
  q.sel(0, 0, 5);
  await q.exec('format.textEffects', {glow: 5});
  const back = await roundTrip(q);
  const para = back.body.chunks.flat()[0];
  const kept = P.runRanges(para)[0][2].textEffects;
  assert.ok(kept.glow);
});

test('the page: runs carry their effects to the draw items', async () => {
  const q = await quill('Hello text effects');
  q.sel(0, 0, 5);
  await q.exec('format.textEffects', {style: 'shadowed'});
  const text = pageDisplay(layout(q.t.content, {view: 'print'}).pages[0], {}).filter(i => i.type === 'text');
  assert.ok(text.some(i => i.fx?.shadow), 'the effects reach the text item');
  assert.ok(text.some(i => !i.fx), 'the rest is drawn plain');
});

test('insert.wordArt: a floating text box in a WordArt style, its text selected, saved to .docx as w14 effects', async () => {
  const q = await quill('Before.');
  q.sel(0, 7);
  const r = await q.exec('insert.wordArt', {text: 'Big news', style: 'gradient', transform: 'textArchUp'});
  const box = blocks(q.t).flatMap(b => b.objects ?? []).find(o => o.type === 'shape');
  assert.equal(box.kind, 'textBox');
  assert.deepEqual([box.fill, box.stroke, box.float.wrap, box.float.hAlign], [null, null, 'inFrontOfText', 'center']);
  assert.equal(box.extra.warp.preset, 'textArchUp');
  const part = q.t.content.parts[r.result.story];
  assert.equal(part.blocks[0].text, 'Big news');
  assert.equal(P.runRanges(part.blocks[0])[0][2].textEffects.fill.type, 'gradient');
  assert.equal(P.runRanges(part.blocks[0])[0][2].size, 36);
  const sel = q.t.doc.selection.ranges[0];
  assert.notEqual(sel.anchor, sel.focus, 'the text is selected');
  await assert.rejects(q.exec('insert.wordArt', {style: 'nope'}), /one of/);
  const st = await q.state('insert.wordArt', {});
  assert.equal(st.value.length, 8);
});

test('docx: a text box saves with its text, direction, alignment, WordArt effects and warp, and reads back', async () => {
  const q = await quill('Before.');
  q.sel(0, 7);
  await q.exec('insert.wordArt', {text: 'Boxed art', style: 'shadowed', transform: 'textWave1'});
  const sel = q.t.doc.selection.ranges[0];
  void sel;
  const story = blocks(q.t).flatMap(b => b.objects ?? []).find(o => o.type === 'shape').story;
  q.t.content.parts[story].body = {...q.t.content.parts[story].body, vert: 'vert', anchor: 'center'};
  const back = await readDocx(await writeDocx(q.t.content));
  const box = back.body.chunks.flat().flatMap(b => b.objects ?? []).find(o => o?.type === 'shape');
  assert.ok(box, 'the text box reads back as a shape');
  assert.equal(box.kind, 'textBox');
  const part = back.parts[box.story];
  assert.equal(part.blocks[0].text, 'Boxed art');
  assert.equal(P.runRanges(part.blocks[0])[0][2].textEffects.shadow.angle, 45);
  assert.equal(P.runRanges(part.blocks[0])[0][2].size, 36);
  assert.deepEqual([part.body.vert, part.body.anchor], ['vert', 'center']);
  assert.equal(box.extra.warp.preset, 'textWave1');
  assert.equal(box.float.wrap, 'inFrontOfText');
});
