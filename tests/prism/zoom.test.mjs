// U:prism/zoom: Insert > Zoom (Slide Zoom, Section Zoom, Summary Zoom) and its dialogs.
//
// 1. deckcraft: crates/engine/src/cmd/zoom.rs. PowerPoint: Insert > Zoom.
// 2. Ours: core/prism/commands/zoom.mjs, lib/zoom-dialog.mjs, dialogs/insertZoom*.mjs.
// 3. These tests and tests/e2e/prism/zoom.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import zoom, {grid, targetsOf} from '../../core/prism/commands/zoom.mjs';
import insert from '../../core/prism/commands/insert.mjs';
import slideDialog from '../../core/prism/dialogs/insertZoom.mjs';
import sectionDialog from '../../core/prism/dialogs/insertZoomSection.mjs';
import summaryDialog from '../../core/prism/dialogs/insertZoomSummary.mjs';
import {withNew} from './upstream/text_deck.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {exportPptx} from '../../core/prism/formats/pptx-write.mjs';
import {importPptx} from '../../core/prism/formats/pptx-read.mjs';
import {slideTitle} from '../../core/prism/model/presentation.mjs';

/** Six titled slides in two sections (slides 1-3 "Intro", 4-6 "Body"); the first slide is current. */
async function deck() {
  const t = await withNew({extra: [zoom, insert]});
  for (const title of ['One', 'Two', 'Three', 'Four', 'Five']) await t.exec('slide.new', {layout: 'titleOnly', title});
  await t.exec('section.add', {name: 'Intro', at: 0});
  await t.exec('section.add', {name: 'Body', at: 3});
  await t.exec('slide.go', {index: 0});
  return t;
}
const pics = sl => sl.shapes.filter(s => s.kind?.type === 'picture');

test('the tiles sit in a centred grid; one slide zoom is half the area wide at most', () => {
  const g = grid(4, {x: 0, y: 0, w: 800, h: 400}, 16 / 9);
  assert.equal(g.length, 4);
  assert.ok(g.every(b => b.w > 0 && b.x >= 0 && b.x + b.w <= 800 && b.y >= 0 && b.y + b.h <= 400));
  const one = grid(1, {x: 480, y: 270, w: 432, h: 243}, 16 / 9);
  assert.ok(one[0].w <= 216 + 1e-9);
});

test('Slide Zoom puts a linked picture of the slide on the current slide; no Return to Zoom by default; undo removes it', async () => {
  const t = await deck();
  const target = t.content.slides[2];
  await expectUndoRoundTrip(t, 'insert.zoom', {kind: 'slide', slides: [2]});
  const [z] = pics(t.content.slides[0]);
  assert.ok(z, 'a picture');
  assert.equal(z.name, 'Slide Zoom 3', 'named by the slide number');
  assert.deepEqual(z.click.action, {kind: 'slide', slide: target.id});
  assert.equal(z.click.zoomReturn, undefined);
  assert.equal(z.descr, 'Two', 'the tooltip is the slide\'s title');
});

test('Section Zoom returns after the section\'s last slide; Return to Zoom can be turned off', async () => {
  const t = await deck();
  const body = t.content.sections[1];
  await t.exec('insert.zoom', {kind: 'section', sections: [1]});
  const z = pics(t.content.slides[0]).at(-1);
  assert.deepEqual(z.click.action, {kind: 'slide', slide: body.slides[0]});
  assert.equal(z.click.zoomReturn, body.slides.at(-1));
  await t.exec('insert.zoom', {kind: 'section', sections: [0], returnToZoom: false});
  assert.equal(pics(t.content.slides[0]).at(-1).click.zoomReturn, undefined);
  await assert.rejects(t.exec('insert.zoom', {kind: 'section', sections: [5]}), /there is no section/);
});

test('Summary Zoom adds a Summary slide before the first part with a tile per part, each returning before the next', async () => {
  const t = await deck();
  const before = t.content.slides.length;
  const [one, , , four] = t.content.slides;
  await expectUndoRoundTrip(t, 'insert.zoom', {kind: 'summary'});
  assert.equal(t.content.slides.length, before + 1);
  const sum = t.content.slides[0];
  assert.equal(slideTitle(sum), 'Summary');
  const tiles = pics(sum);
  assert.equal(tiles.length, 2, 'one per section by default');
  assert.deepEqual(tiles[0].click.action, {kind: 'slide', slide: one.id});
  assert.equal(tiles[0].click.zoomReturn, t.content.slides[3].id, 'the part runs to the slide before the next one');
  assert.deepEqual(tiles[1].click.action, {kind: 'slide', slide: four.id});
  assert.equal(tiles[1].click.zoomReturn, t.content.slides.at(-1).id);
});

test('refusals: unknown kind, no slides chosen, a slide that does not exist', async () => {
  const t = await deck();
  await assert.rejects(t.exec('insert.zoom', {kind: 'card'}), /unknown zoom kind/);
  await assert.rejects(t.exec('insert.zoom', {kind: 'slide'}), /choose the slides/);
  await assert.rejects(t.exec('insert.zoom', {kind: 'slide', slides: [99]}), /there is no slide/);
  assert.equal(pics(t.content.slides[0]).length, 0);
});

test('a host that draws slides supplies the picture; the picture and its link survive a .pptx save', async () => {
  const t = await deck();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  t.host.renderSlides = async (doc, indexes) => indexes.map(() => `data:image/png;base64,${png.toString('base64')}`);
  await t.exec('insert.zoom', {kind: 'slide', slides: [1, 2]});
  const media = t.content.media.filter(m => m.name.startsWith('zoom-'));
  assert.deepEqual(media.map(m => m.contentType), ['image/png'], 'the same bytes are stored once');
  const back = await importPptx(await exportPptx(t.content));
  const got = pics(back.slides[0]);
  assert.equal(got.length, 2);
  assert.equal(got[0].click.action.kind, 'slide');
  assert.equal(got[0].click.action.slide, back.slides[1].id);
});

test('the dialogs list slides or sections, start a summary on the section starts, and submit the command', async () => {
  const t = await deck();
  const ctx = t.session.readContext(t.docId);
  const s = slideDialog.init(ctx);
  assert.equal(s.list.length, 6);
  assert.equal(slideDialog.validate(s).length, 1);
  assert.deepEqual(slideDialog.toCommand({...s, picked: [3, 1]}), {command: 'insert.zoom', params: {kind: 'slide', slides: [1, 3]}});
  const sec = sectionDialog.init(ctx);
  assert.deepEqual(sec.list.map(x => x.title), ['Intro', 'Body']);
  assert.deepEqual(sectionDialog.toCommand({...sec, picked: [1]}).params, {kind: 'section', sections: [1]});
  assert.deepEqual(summaryDialog.init(ctx).picked, [0, 3], 'the first slide of each section');
  const none = await withNew({extra: [zoom, insert]});
  const empty = sectionDialog.init(none.session.readContext(none.docId));
  assert.match(sectionDialog.validate(empty)[0].message, /no sections/);
  assert.equal(targetsOf(t.content, 'slide', {slides: [0]}).length, 1);
});
