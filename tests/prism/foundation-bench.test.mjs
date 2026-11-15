// F:prism foundation benchmark (docs/architecture.md 19, Phase 1: "500 slides"; 20: foundations
// ship a benchmark before units start). A 500-slide deck, each slide a Title and Content layout
// with a title, five bullet paragraphs and two shapes, run through the operations every command
// and the surface lean on: build + validate, open in a kernel session, address enumerate/canonical/
// read, a pointer gesture (move) on the last slide with its undo, and laying out every text body
// (what painting all thumbnails costs, headless measure).
//
// Numbers measured on this machine (Windows 11, Node 24, 2026-10-30), two runs: quiet / while other
// agents' builds and tests ran in parallel:
//   build 500 slides ............. 12 / 59 ms        (budget 4 s)
//   validateContent .............. 13 / 63 ms        (budget 1.5 s)
//   session open (registry warm) . — / 99 ms         (budget 3 s; 554 ms cold, registry included)
//   enumerate / canonical / read . 6 / 90 ms         (budget 0.5 s)
//   pointer move + undo, slide 500 14 / 70 ms        (budget 0.5 s)
//   lay out 1,499 text bodies .... 486 / 2,095 ms    (budget 20 s; headless measure)
//   serialize .................... 22 / 35 ms, 1,155,940 bytes (budget 2 s)
// The test prints a BENCH line with the current figures.
export const RESULTS = {quiet: {build: 12, validate: 13.4, openCold: 553.7, address: 5.9, pointer: 13.9, layout: 486.1, serialize: 22.3},
  loaded: {build: 59.3, validate: 62.6, open: 99.3, address: 90, pointer: 70.3, layout: 2095.2, serialize: 34.5}, bytes: 1155940, bodies: 1499};

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createContent, validateContent} from '../../core/prism/schema.mjs';
import {newSlide, layoutOfKind} from '../../core/prism/model/defaults.mjs';
import {shape, presetGeom} from '../../core/prism/model/presentation.mjs';
import {bodyFromText} from '../../core/prism/model/text.mjs';
import {colorRgb, fillSolid} from '../../core/prism/model/style.mjs';
import {ctxForSlide} from '../../core/prism/model/resolve.mjs';
import {shapeGeometry} from '../../core/prism/model/render.mjs';
import {layoutText} from '../../core/prism/model/textlayout.mjs';
import * as address from '../../core/prism/address.mjs';
import {boxOf} from '../../core/prism/lib/connect.mjs';
import surface from '../../src/apps/prism/ui-commands/surface.ts';

const SLIDES = 500;
const ms = t0 => Math.round((performance.now() - t0) * 10) / 10;

function bigDeck() {
  let c = createContent('Benchmark');
  const layout = layoutOfKind(c, 'titleAndContent');
  const fill = fillSolid(colorRgb({r: 68, g: 114, b: 196, a: 255}));
  const slides = [c.slides[0]];
  for (let i = 1; i < SLIDES; i++) {
    const made = newSlide(c, layout);
    c = {...c, nextId: made.nextId};
    const sl = made.slide;
    sl.shapes[0].text = bodyFromText(`Slide ${i + 1}: quarterly results and the plan for next year`);
    sl.shapes[1].text = bodyFromText(['Revenue grew in every region', 'Margins held despite costs', 'Two new products shipped',
      'Hiring stayed on plan', 'Next: the international launch'].join('\n'));
    sl.shapes.push(shape({id: `r${i}`, xfrm: {x: 600, y: 380, w: 160, h: 90}, geom: presetGeom('roundRect'), fill, text: bodyFromText('Note')}));
    sl.shapes.push(shape({id: `e${i}`, xfrm: {x: 780, y: 380, w: 90, h: 90}, geom: presetGeom('ellipse'), fill}));
    slides.push(sl);
  }
  return {...c, slides};
}

test(`benchmark: a ${SLIDES}-slide deck through the Prism foundation`, async () => {
  const out = {};
  let t0 = performance.now();
  const deck = bigDeck();
  out.build = ms(t0);
  assert.equal(deck.slides.length, SLIDES);

  t0 = performance.now();
  validateContent(deck);
  out.validate = ms(t0);

  const last = deck.slides[SLIDES - 1];
  // Warm the registry and module imports once, so the figure is the deck's own open.
  await createTestSession('prism', {content: createContent('warm-up'), modules: [surface]});
  t0 = performance.now();
  const t = await createTestSession('prism', {content: deck, modules: [surface], prefs: {prism: {snapToGrid: false, smartGuides: true}},
    selection: {ranges: [{anchor: `/sl:${last.id}`, focus: `/sl:${last.id}`}], primary: 0}});
  out.open = ms(t0);

  t0 = performance.now();
  const top = address.enumerate(t.content, address.parse('/'), {depth: 1, limit: 1000});
  const canon = address.canonical(t.content, `slide ${SLIDES}`);
  const shapeJson = t.read(`/sl:${last.id}/sp:r${SLIDES - 1}`, 'json');
  out.address = ms(t0);
  assert.ok(top.nodes.length >= SLIDES, `enumerate listed ${top.nodes.length}`);
  assert.equal(canon, `/sl:${last.id}`);
  assert.ok(shapeJson);

  t0 = performance.now();
  const r = await t.exec('surface.pointer', {events: [{kind: 'down', x: 680, y: 425}, {kind: 'drag', x: 700, y: 440}, {kind: 'drag', x: 712, y: 451},
    {kind: 'up', x: 712, y: 451}]});
  await t.undo();
  out.pointer = ms(t0);
  assert.equal(r.undoLabel, 'Move');

  t0 = performance.now();
  let bodies = 0;
  const measure = (f, s) => s.length * f.size * 0.52;
  for (const sl of t.content.slides) {
    const ctx = ctxForSlide(t.content, sl);
    for (const sh of sl.shapes) {
      if (!sh.text) continue;
      const x = boxOf(t.content, sl, sh);
      layoutText(ctx, sh, sh.text, {rect: shapeGeometry(sh, x.w, x.h).textRect, measure});
      bodies++;
    }
  }
  out.layout = ms(t0);
  assert.ok(bodies >= SLIDES * 3 - 3, `laid out ${bodies}`);

  t0 = performance.now();
  const json = JSON.stringify(t.content);
  out.serialize = ms(t0);
  out.bytes = json.length;
  out.bodies = bodies;

  console.log(`BENCH prism ${SLIDES} slides ${JSON.stringify(out)}`);
  assert.ok(out.build < 4000, `build ${out.build} ms`);
  assert.ok(out.validate < 1500, `validate ${out.validate} ms`);
  assert.ok(out.open < 3000, `open ${out.open} ms`);
  assert.ok(out.address < 500, `address ${out.address} ms`);
  assert.ok(out.pointer < 500, `pointer ${out.pointer} ms`);
  assert.ok(out.layout < 20000, `layout ${out.layout} ms`);
  assert.ok(out.serialize < 2000, `serialize ${out.serialize} ms`);
});
