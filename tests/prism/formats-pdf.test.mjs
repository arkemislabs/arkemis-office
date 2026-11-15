// Prism File > Export > Create PDF / Save As > PDF (core/prism/formats/pdf-write.mjs).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. What does ArtCraft do? deckcraft crates/pdf/src/lib.rs `export`: each slide is the renderer's
//    raster at print DPI (lib.rs:508 Exporter::slide) with an invisible real-text layer (text_layer),
//    link annotations for URLs and slide jumps (links, :609), bookmarks from slide titles
//    (build_outline, :148); layouts Slides / Notes (slide over its notes, notes_frames :240) /
//    Handouts 1-9 per page (handout_boxes :361, ruled lines for 3 per page :681); hidden slides are
//    left out unless asked. PowerPoint's Export > Create PDF/XPS offers the same page layouts.
// 2. Does ours do the same? Yes with Prism's own slide renderer (the SlideView SVG the surface draws,
//    run in a hidden window and handed in as `render`); the invisible text is set in Helvetica
//    squeezed to the measured width (documented in the module header). Without the renderer the
//    export refuses rather than drawing something that doesn't look like the slide.
// 3. Which test proves it? This file (pages, sizes, text layer extracted by pdf.js, links, outline,
//    layouts); the hidden-window renderer hook is an integrator request
//    (design note U-prism-formats-pptx--integrator--pdf-slide-renderer).

import test from 'node:test';
import assert from 'node:assert/strict';
import {exportPdf, handoutBoxes, notesSlideBox, notesFrames, rasterScale, paperSize, planPages, defaultPdfOptions} from '../../core/prism/formats/pdf-write.mjs';
import {richDeck, png} from './formats-pptx-fixtures.mjs';

const load = async bytes => (await import('pdfjs-dist/legacy/build/pdf.mjs')).getDocument({data: new Uint8Array(bytes), verbosity: 0}).promise;
const fakeRenderer = calls => async (i, size) => {
  calls?.push([i, size.width, size.height]);
  return {image: png([240, 240, 250]), texts: [{x: 60, y: 100, size: 24, width: 160, text: `Slide text ${i + 1}`}]};
};

test('one page per visible slide at the slide size, rendered at print resolution', async () => {
  const p = richDeck();
  const calls = [];
  const doc = await load(await exportPdf(p, {render: fakeRenderer(calls)}));
  assert.equal(doc.numPages, 4, 'the hidden slide is left out');
  const page = await doc.getPage(1);
  const [, , w, h] = page.view;
  assert.deepEqual([Math.round(w), Math.round(h)], [960, 540]);
  assert.deepEqual(calls[0], [0, Math.round(960 * rasterScale(960, [960, 540], 200)), Math.round(540 * rasterScale(960, [960, 540], 200))]);
  const all = await load(await exportPdf(p, {render: fakeRenderer(), includeHidden: true}));
  assert.equal(all.numPages, 5);
});

test('the invisible text layer can be searched and copied', async () => {
  const doc = await load(await exportPdf(richDeck(), {render: fakeRenderer()}));
  const text = (await (await doc.getPage(2)).getTextContent()).items.map(i => i.str).join('');
  assert.ok(text.includes('Slide text 2'), text);
});

test('shape actions become link annotations and slide titles become bookmarks', async () => {
  const p = richDeck();
  p.slides[1].shapes.push({...p.slides[1].shapes[0], id: '9001', name: 'Web', xfrm: {x: 10, y: 10, w: 50, h: 50}, click: {action: {kind: 'url', url: 'https://example.com/'}, tooltip: 'Go', highlightClick: false}});
  const doc = await load(await exportPdf(p, {render: fakeRenderer()}));
  const annots = await (await doc.getPage(2)).getAnnotations();
  assert.ok(annots.some(a => a.subtype === 'Link' && a.url === 'https://example.com/'), JSON.stringify(annots.map(a => [a.subtype, a.url, a.dest])));
  const jump = await (await doc.getPage(4)).getAnnotations();
  assert.ok(jump.some(a => a.subtype === 'Link' && Array.isArray(a.dest)), 'the go-to-slide action jumps to a page');
  assert.ok(!annots.some(a => Array.isArray(a.dest)), 'next slide is the hidden slide, which is not in the PDF: no link');
  const outline = await doc.getOutline();
  assert.equal(outline.length, 4);
  assert.equal(outline[0].title, '1. Hello deck');
  assert.equal(outline[1].title, 'Slide 2');
});

test('notes pages put the slide above its notes on letter paper', async () => {
  const p = richDeck();
  const doc = await load(await exportPdf(p, {render: fakeRenderer(), layout: {kind: 'notes'}}));
  assert.equal(doc.numPages, 4);
  const page = await doc.getPage(1);
  assert.deepEqual(page.view.slice(2).map(Math.round), [612, 792]);
  const text = (await page.getTextContent()).items.map(i => i.str).join(' ');
  assert.ok(text.includes('Speaker notes line 1') && text.includes('line 2'), text);
  const [slide, notes] = notesFrames(p, [612, 792]);
  assert.ok(slide.y1 < notes.y0, 'notes below the slide');
});

test('handouts: boxes per page, ruled lines for three per page', async () => {
  const p = richDeck();
  for (const [per, pages] of [[1, 4], [2, 2], [3, 2], [4, 1], [6, 1], [9, 1]]) {
    const doc = await load(await exportPdf(p, {render: fakeRenderer(), layout: {kind: 'handouts', perPage: per}}));
    assert.equal(doc.numPages, pages, `${per} per page`);
    assert.equal(handoutBoxes(per, [612, 792], 16 / 9).length, per === 1 ? 1 : per);
  }
  const three = handoutBoxes(3, [612, 792], 16 / 9);
  assert.ok(three.every(b => b.x0 === 54), 'slides on the left, lines on the right');
  assert.ok(three[0].x1 < 612 / 2 + 1);
});

test('layout helpers match upstream', () => {
  assert.deepEqual(paperSize('A4', false), [595.28, 841.89]);
  assert.deepEqual(paperSize('letter', true), [792, 612]);
  assert.equal(paperSize('nope', false), null);
  const b = notesSlideBox([612, 792], 16 / 9);
  assert.equal(b.y0, 54);
  assert.ok(Math.abs((b.x1 - b.x0) - (612 - 144)) < 1e-9);
  const tall = notesSlideBox([792, 612], 4 / 3);
  assert.ok(tall.y1 - tall.y0 <= 612 * 0.5 - 54 + 1e-9);
  assert.ok(rasterScale(960, [960, 540], 10000) * 960 * rasterScale(960, [960, 540], 10000) * 540 <= 64e6 + 1);
  assert.deepEqual(defaultPdfOptions().paper, [612, 792]);
  const p = richDeck();
  assert.equal(planPages(p, {...defaultPdfOptions(), layout: {kind: 'handouts', perPage: 4}}, [0, 1, 2, 3, 4]).length, 2);
});

test('an empty selection is an error, and so is a missing renderer', async () => {
  await assert.rejects(exportPdf(richDeck(), {render: fakeRenderer(), slides: []}), /nothing to export/);
  await assert.rejects(exportPdf(richDeck(), {}), /slide renderer/);
});
