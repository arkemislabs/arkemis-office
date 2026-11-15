// U:prism/reuse: Reuse Slides (slide.reuseList, slide.reuse and the dialog model).
//
// 1. deckcraft: crates/engine/src/cmd/reuse.rs and its tests (every media reference comes along, links follow copies, the list
//    names the slides). PowerPoint: New Slide > Reuse Slides.
// 2. Ours: core/prism/commands/reuse.mjs, dialogs/reuseSlides.mjs.
// 3. These tests and tests/e2e/prism/reuse.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import reuse from '../../core/prism/commands/reuse.mjs';
import insert from '../../core/prism/commands/insert.mjs';
import design from '../../core/prism/commands/design.mjs';
import reuseDialog from '../../core/prism/dialogs/reuseSlides.mjs';
import {withNew} from './upstream/text_deck.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {exportPptx} from '../../core/prism/formats/pptx-write.mjs';
import {slideTitle} from '../../core/prism/model/presentation.mjs';

const b64 = bytes => Buffer.from(bytes).toString('base64');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A source deck: three titled slides (Alpha with a picture and a link to Gamma, Beta, Gamma hidden), as .pptx base64. */
async function source() {
  const t = await withNew({extra: [reuse, insert, design]});
  for (const title of ['Alpha', 'Beta', 'Gamma']) await t.exec('slide.new', {layout: 'titleAndContent', title});
  const slides = t.content.slides;
  const gamma = slides.find(s => slideTitle(s) === 'Gamma');
  await t.exec('slide.go', {index: slides.indexOf(slides.find(s => slideTitle(s) === 'Alpha'))});
  await t.exec('insert.picture', {name: 'dot.png', data: PNG, rect: [10, 10, 60, 60]});
  await t.exec('slide.hide', {index: slides.indexOf(gamma)}).catch(() => {});
  const content = structuredClone(t.content);
  const a = content.slides.find(s => slideTitle(s) === 'Alpha');
  const g = content.slides.find(s => slideTitle(s) === 'Gamma');
  const p = a.shapes.find(s => s.kind?.type === 'picture');
  p.click = {action: {kind: 'slide', slide: g.id}, tooltip: ''};
  return {content, data: b64(await exportPptx(content))};
}

const deck = async () => {
  const t = await withNew({extra: [reuse, insert, design]});
  await t.exec('slide.go', {index: 0});
  return t;
};
const titles = t => t.content.slides.map(slideTitle);

test('slide.reuseList names the slides of the other file and changes nothing', async () => {
  const src = await source();
  const t = await deck();
  const before = t.content.slides.length;
  const out = (await t.exec('slide.reuseList', {data: src.data, name: 'src.pptx'}));
  const res = out.result ?? out;
  const titlesOf = res.slides.map(s => s.title);
  assert.ok(['Alpha', 'Beta', 'Gamma'].every(x => titlesOf.includes(x)));
  assert.equal(t.content.slides.length, before);
  await assert.rejects(t.exec('slide.reuseList', {data: b64(Buffer.from('not a deck'))}), /not a presentation/);
});

test('slide.reuse brings the picked slides in after the current one; undo removes them; others stay out', async () => {
  const src = await source();
  const t = await deck();
  const list = ((await t.exec('slide.reuseList', {data: src.data})).result ?? {}).slides ?? [];
  const index = x => list.find(s => s.title === x).index;
  const before = t.content.slides.length;
  await expectUndoRoundTrip(t, 'slide.reuse', {data: src.data, name: 'src.pptx', slides: [index('Alpha'), index('Gamma')]});
  assert.equal(t.content.slides.length, before + 2);
  const names = titles(t);
  assert.ok(names.includes('Alpha') && names.includes('Gamma') && !names.includes('Beta'));
  assert.equal(names.indexOf('Alpha'), 1, 'after the current slide');
  await assert.rejects(t.exec('slide.reuse', {data: src.data, slides: [99]}), /isn't one of them/);
});

test('pictures come along under their own ids and links follow the copies of reused slides', async () => {
  const src = await source();
  const t = await deck();
  const own = t.content.media?.length ?? 0;
  const list = ((await t.exec('slide.reuseList', {data: src.data})).result ?? {}).slides;
  const out = await t.exec('slide.reuse', {data: src.data, slides: [list.find(s => s.title === 'Alpha').index, list.find(s => s.title === 'Gamma').index]});
  const ids = (out.result ?? out).ids;
  const alpha = t.content.slides.find(s => s.id === ids[0]);
  const pic = alpha.shapes.find(s => s.kind?.type === 'picture');
  assert.ok(pic, 'the picture came');
  const media = t.content.media.find(m => m.id === pic.kind.fill.media);
  assert.ok(media?.data, 'its bytes are in this presentation');
  assert.equal(t.content.media.length, own + 1);
  assert.deepEqual(pic.click.action, {kind: 'slide', slide: ids[1]}, 'the link follows the copy of Gamma');
  const ids2 = t.content.slides.flatMap(s => s.shapes.map(x => x.id));
  assert.equal(new Set(ids2).size, ids2.length, 'shape ids stay unique');
});

test('without Keep source formatting the slides take this deck\'s layouts; with it the source master comes along', async () => {
  const src = await source();
  const t = await deck();
  const masters = t.content.masters.length;
  await t.exec('slide.reuse', {data: src.data, slides: [1]});
  assert.equal(t.content.masters.length, masters);
  const used = t.content.slides[1].layout;
  assert.ok(t.content.masters.flatMap(m => m.layouts).some(l => l.id === used), 'a layout of this deck');
  await t.exec('slide.reuse', {data: src.data, slides: [1], keepFormatting: true});
  assert.equal(t.content.masters.length, masters + 1);
  const kept = t.content.slides[2];
  const m = t.content.masters.at(-1);
  assert.ok(m.layouts.some(l => l.id === kept.layout), 'the slide uses the imported master\'s layout');
  assert.ok(![...t.content.masters.slice(0, -1)].some(x => x.id === m.id || x.layouts.some(l => m.layouts.some(n => n.id === l.id))), 'fresh ids');
});

test('the dialog model needs a file and some checked slides, and submits sorted indices', () => {
  const v = reuseDialog.init({});
  assert.equal(reuseDialog.validate(v).length, 1);
  assert.equal(reuseDialog.validate({...v, data: 'AAAA', picked: []}).length, 1);
  const ok = {...v, data: 'AAAA', name: 'a.pptx', picked: [2, 0], keep: true};
  assert.equal(reuseDialog.validate(ok).length, 0);
  assert.deepEqual(reuseDialog.toCommand(ok), {command: 'slide.reuse', params: {data: 'AAAA', name: 'a.pptx', slides: [0, 2], keepFormatting: true}});
});

