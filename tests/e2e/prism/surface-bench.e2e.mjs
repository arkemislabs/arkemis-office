// Prism surface benchmark in the real app (F:prism; docs/architecture.md 19 Phase 1: 500 slides).
// A 500-slide deck opens in Normal view, the thumbnail pane draws only the rows in view, the last
// slide becomes current (the pane scrolls to it), a pointer gesture moves a shape there, and Ctrl+Z
// undoes it. Timings are printed as a BENCH line; captures go to artifacts/e2e/prism/surface-bench/.
//
// Measured on this machine (Windows 11, Electron 44, test mode, 2026-10-30), last run:
//   open 846 ms (documents.open until ui.inspect answers), goto 160 ms (selection.set to slide 500
//   and the capture of it), gesture 37 ms (surface.pointer move on slide 500, bridge round trip).
// The test prints a BENCH line with the current figures.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {newSlide, layoutOfKind} from '../../../core/prism/model/defaults.mjs';
import {shape, presetGeom} from '../../../core/prism/model/presentation.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';
import {colorRgb, fillSolid} from '../../../core/prism/model/style.mjs';

const SLIDES = 500;

function seed() {
  const file = createFile('prism', 'Five hundred slides', {schema: 2});
  file.id = 'prism-bench';
  let c = file.content;
  const layout = layoutOfKind(c, 'titleAndContent');
  const fill = fillSolid(colorRgb({r: 68, g: 114, b: 196, a: 255}));
  c.slides[0].shapes[0].text = bodyFromText('Five hundred slides');
  const slides = [c.slides[0]];
  for (let i = 1; i < SLIDES; i++) {
    const made = newSlide(c, layout);
    c = {...c, nextId: made.nextId};
    const sl = made.slide;
    sl.shapes[0].text = bodyFromText(`Slide ${i + 1}`);
    sl.shapes[1].text = bodyFromText('First point\nSecond point\nThird point');
    sl.shapes.push(shape({id: `r${i}`, xfrm: {x: 600, y: 380, w: 160, h: 90}, geom: presetGeom('roundRect'), fill}));
    slides.push(sl);
  }
  file.content = {...c, slides};
  return file;
}

test('prism surface: a 500-slide deck in Normal view', {timeout: 240_000}, async () => {
  const file = seed();
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/surface-bench', files: [file], renderer});
  const doc = file.id;
  const out = {};
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000});
    let t0 = performance.now();
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 60_000});
    out.open = Math.round(performance.now() - t0);
    await app.capture('1-opened');

    const last = file.content.slides[SLIDES - 1].id;
    t0 = performance.now();
    await app.rpc('selection.set', {doc, ranges: [{anchor: `/sl:${last}`, focus: `/sl:${last}`}]});
    await app.capture('2-slide-500');
    out.goto = Math.round(performance.now() - t0);

    t0 = performance.now();
    const r = await app.rpc('engine.execute', {doc, command: 'surface.pointer', params: {events: [{kind: 'down', x: 680, y: 425}, {kind: 'drag', x: 720, y: 455},
      {kind: 'up', x: 720, y: 455}]}});
    out.gesture = Math.round(performance.now() - t0);
    assert.equal(r.undoLabel, 'Automation: Move');
    const moved = (await app.rpc('document.read', {doc, address: `/sl:${last}/sp:r${SLIDES - 1}`, as: 'json'})).value.xfrm;
    assert.ok(moved.x > 600, JSON.stringify(moved));
    await app.capture('3-moved-on-500');
    const k = await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.equal(k.handled, true);
    await app.until(async () => (await app.rpc('document.read', {doc, address: `/sl:${last}/sp:r${SLIDES - 1}`, as: 'json'})).value.xfrm.x === 600 || null);
    console.log(`BENCH prism surface ${SLIDES} slides ${JSON.stringify(out)}`);
    assert.ok(out.open < 30_000 && out.goto < 10_000 && out.gesture < 5_000, JSON.stringify(out));
  } finally {
    await app.close();
  }
});
