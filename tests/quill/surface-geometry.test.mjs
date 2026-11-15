// Quill page view geometry, rulers, pointer counting and the accessible mirror
// (src/apps/quill/surface/geometry.mjs, a11y.mjs, live.mjs).
//
// 1. ArtCraft: wordcraft crates/ui-egui/src/canvas/geometry.rs (place_pages, columns_for, fit
//    scales), navigation.rs (page_at, top_page, viewed_page), input.rs (press_count, edge_scroll),
//    rulers.rs (ruler_density, ruler_marks, ruler_x/ruler_d) and a11y.rs (build, page_window).
//    Word's Print Layout: pages centred on the canvas with gaps, side by side when zoomed out,
//    Page Width / One Page / Multiple Pages fit modes, rulers numbered from the start margin.
// 2. Ours: the same functions over the same numbers (CSS px for screen units).
// 3. Upstream ports below name the Rust test; the page view itself is checked by
//    tests/e2e/quill/surface-page-view.e2e.mjs (captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../../src/apps/quill/surface/geometry.mjs';
import {build, pageWindow, MAX_NODES} from '../../src/apps/quill/surface/a11y.mjs';
import {layoutOf, resetViews, viewOf} from '../../src/apps/quill/surface/live.mjs';
import {contentFromText, createContent} from '../../core/quill/model/content.mjs';
import {Document} from '../../core/quill/model/document.mjs';
import {paragraphWithText} from '../../core/quill/model/para.mjs';
import {addList} from '../../core/quill/model/numbering.mjs';

test('presses_count_up_to_three (upstream canvas/tests.rs)', () => {
  const at = {x: 100, y: 100};
  const p = (last, now, x = at.x, y = at.y) => G.pressCount(last, now * 1000, x, y, 300, 6);
  assert.equal(p(null, 5.0), 1);
  assert.equal(p({time: 5000, ...at, n: 1}, 5.1), 2);
  assert.equal(p({time: 5100, ...at, n: 2}, 5.2, at.x + 3), 3);
  assert.equal(p({time: 5200, ...at, n: 3}, 5.3), 3, 'stays a triple');
  assert.equal(p({time: 5000, ...at, n: 1}, 5.5), 1, 'too slow');
  assert.equal(p({time: 5000, ...at, n: 1}, 5.1, at.x + 20), 1, 'too far');
  assert.equal(p({time: 5000, ...at, n: 1}, 4.0), 1, 'the clock went back');
});

test('edge_auto_scroll_ramps_from_the_margins_and_clamps (upstream canvas/tests.rs)', () => {
  const dt = 1 / 60, lo = 100, hi = 500;
  for (const y of [(lo + hi) / 2, lo + G.EDGE_MARGIN, hi - G.EDGE_MARGIN]) assert.equal(G.edgeScroll(y, lo, hi, dt), 0);
  assert.ok(G.edgeScroll(lo + 1, lo, hi, dt) > 0);
  assert.ok(G.edgeScroll(hi - 1, lo, hi, dt) < 0);
  const above = Array.from({length: 9}, (_, k) => G.edgeScroll(lo + G.EDGE_MARGIN - k * G.EDGE_MARGIN / 8, lo, hi, dt));
  assert.equal(above[0], 0);
  for (let k = 1; k < 9; k++) assert.ok(above[k] > above[k - 1]);
  assert.ok(Math.abs(above[8] - G.EDGE_SPEED_MAX * dt) < 1e-9);
  assert.equal(G.edgeScroll(lo - 3 * G.EDGE_MARGIN, lo, hi, dt), above[8], 'past the edge the speed caps');
  assert.ok(G.edgeScroll(hi - 1, lo, hi, 100) <= G.EDGE_SPEED_MAX * G.EDGE_MAX_DT + 1e-3);
  for (const [p, a, b, d] of [[NaN, lo, hi, dt], [200, NaN, hi, dt], [200, lo, Infinity, dt], [200, lo, hi, NaN], [200, 500, 100, dt]]) assert.equal(G.edgeScroll(p, a, b, d), 0);
});

test('the_page_at_the_top_of_the_window (upstream canvas/tests.rs, without Hide White Space)', () => {
  const rects = [0, 1, 2].map(i => ({x: 0, y: i * 110, w: 80, h: 100}));
  assert.equal(G.topPage(rects, 0), 0);
  assert.equal(G.topPage(rects, 99), 0);
  assert.equal(G.topPage(rects, 105), 1, 'in the gap: the page below');
  assert.equal(G.topPage(rects, 250), 2);
  assert.equal(G.topPage(rects, 1e6), 2, 'past the end: the last page');
  assert.equal(G.topPage([], 0), 0);
});

test('ruler_density_thins_out_as_the_page_shrinks (upstream canvas/tests.rs)', () => {
  const d = (px, div) => { const r = G.rulerDensity(px, div); return [r.labelEvery, r.tickEvery]; };
  assert.deepEqual(d(96, 8), [1, 1]);
  assert.deepEqual(d(48, 8), [1, 1]);
  assert.deepEqual(d(24, 8), [2, 2]);
  assert.deepEqual(d(9.6, 8), [4, 4]);
  assert.deepEqual(d(37.8, 4), [1, 1]);
  assert.deepEqual(d(18.9, 4), [2, 1]);
  assert.deepEqual(d(9.45, 4), [4, 2]);
  assert.deepEqual(d(3.78, 4), [8, 8]);
  assert.deepEqual(d(0, 8), [G.RULER_SPARSEST, G.RULER_SPARSEST]);
  for (const px of [-1, NaN, Infinity]) { const [l, t] = d(px, 0); assert.ok(l >= 1 && t >= 1); }
  for (const div of [4, 8]) for (let z = 1; z <= 200; z++) { const r = G.rulerDensity(z * 0.5, div); assert.equal((div * r.labelEvery) % r.tickEvery, 0); }
});

test('the_ruler_scale_mirrors_for_right_to_left (upstream canvas/tests.rs)', () => {
  const [x0, scale, pageW, unit] = [100, 1.25, 612, 72];
  assert.equal(G.rulerX(0, x0, scale, pageW, true), x0 + pageW * scale);
  assert.equal(G.rulerX(pageW, x0, scale, pageW, true), x0);
  const [bodyX, bodyRight] = [72, 468];
  assert.equal(G.rulerX(bodyX + unit, x0, scale, pageW, false), x0 + (bodyX + unit) * scale);
  assert.equal(G.rulerX(pageW - bodyRight + unit, x0, scale, pageW, true), x0 + (bodyRight - unit) * scale);
  for (const rtl of [false, true]) for (const dd of [0, 9, 72, 306, 612]) assert.ok(Math.abs(G.rulerD(G.rulerX(dd, x0, scale, pageW, rtl), x0, scale, pageW, rtl) - dd) < 1e-3);
  const marks = G.rulerMarks(72, bodyRight - bodyX, pageW, [unit, 8, 1], scale);
  const at = v => marks.find(([dd]) => Math.abs(dd - v) < 1e-4)?.[1];
  assert.equal(marks[0][0], 0);
  assert.equal(marks[marks.length - 1][0], pageW);
  assert.deepEqual(at(0), {tick: G.UNIT_TICK});
  assert.equal(at(72), undefined);
  assert.deepEqual(at(72 + unit), {label: 1});
  assert.deepEqual(at(72 + 2 * unit), {label: 2});
  assert.deepEqual(at(72 + unit / 2), {tick: 5});
  assert.deepEqual(at(72 + unit / 8), {tick: 1.5});
  const coarse = G.rulerMarks(72, bodyRight - bodyX, pageW, [unit, 8, 1], 0.3);
  assert.ok(!coarse.some(([, m]) => m.tick === 1.5));
  assert.ok(coarse.some(([, m]) => m.tick === 3));
});

test('ruler_marks_number_the_text_area_and_thin_out_zoomed_out (upstream canvas/tests.rs)', () => {
  const [unit, pageW, textW] = [72, 612, 468];
  const labels = ms => ms.filter(([, m]) => 'label' in m).map(([dd, m]) => [dd, m.label]);
  const marks = G.rulerMarks(72, textW, pageW, [unit, 8, 1], 1.25);
  assert.deepEqual(labels(marks), [1, 2, 3, 4, 5, 6].map(n => [72 + n * unit, n]));
  const tiny = G.rulerMarks(72, textW, pageW, [unit, 8, 1], 0.15);
  assert.deepEqual(labels(tiny), [[72 + 4 * unit, 4]]);
  assert.ok(tiny.length >= 8);
  const PT_PER_CM = 72 / 2.54;
  for (let z = 1; z <= 100; z++) {
    const scale = z * 0.05;
    for (const sc of [[72, 8, 1], [PT_PER_CM, 4, 1], [PT_PER_CM, 4, 10], [72, 8, 72]]) {
      const found = labels(G.rulerMarks(72, textW, pageW, sc, scale));
      const xs = found.map(([dd]) => dd * scale);
      for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= G.RULER_LABEL_PX - 1e-3, `scale ${scale}`);
      assert.ok(found.every(([dd, n]) => dd > 72 && dd <= 72 + textW + 1e-3 && n > 0));
    }
  }
  assert.equal(G.rulerMarks(NaN, textW, pageW, [unit, 8, 1], 1).length, 0);
  assert.equal(G.rulerMarks(72, textW, Infinity, [unit, 8, 1], 1).length, 0);
  assert.equal(G.rulerMarks(72, textW, pageW, [0, 8, 1], 1).length, 0);
  assert.ok(G.rulerMarks(1e9, textW, 1e9, [unit, 8, 1], 1).length <= G.RULER_MAX_MARKS);
});

test('pages are centred with gaps, side by side when zoomed out, one per row for Page Width and One Page (geometry.rs)', () => {
  const pages = Array.from({length: 4}, () => ({w: 612, h: 792}));
  const at100 = G.geometry(pages, {zoom: 100}, {w: 1200, h: 800});
  assert.equal(at100.cols, 1);
  assert.equal(at100.rects[0].w, 612 * G.PX_PER_PT);
  assert.ok(Math.abs(at100.rects[0].x - (1200 - 612 * G.PX_PER_PT) / 2) < 1e-6, 'centred');
  assert.equal(at100.rects[1].y - (at100.rects[0].y + at100.rects[0].h), G.GAP);
  const at30 = G.geometry(pages, {zoom: 30}, {w: 1200, h: 800});
  assert.ok(at30.cols > 1, 'zoomed out, pages flow side by side');
  assert.equal(at30.rects[1].y, at30.rects[0].y);
  const width = G.geometry(pages, {zoom: 100, fit: 'pageWidth'}, {w: 1200, h: 800});
  assert.equal(width.cols, 1);
  assert.ok(Math.abs(width.rects[0].w - (1200 - 2 * G.GAP - 20)) < 1e-6);
  const one = G.geometry(pages, {zoom: 100, fit: 'onePage'}, {w: 1200, h: 800});
  assert.ok(Math.abs(one.rects[0].h - (800 - 2 * G.GAP)) < 1e-6);
  const multi = G.geometry(pages, {zoom: 100, fit: 'multiplePages'}, {w: 1200, h: 800});
  assert.ok(multi.cols >= 2);
  // The markup area keeps room beside each page.
  const markup = G.geometry(pages, {zoom: 100}, {w: 1200, h: 800}, G.MARKUP_WIDTH);
  assert.ok(markup.rects[0].x < at100.rects[0].x);
});

test('page_at / nearest page, visible pages and tiles', () => {
  const geo = G.geometry([{w: 612, h: 792}, {w: 612, h: 792}], {zoom: 100}, {w: 1000, h: 600});
  const r = geo.rects[1];
  const hit = G.pageAt(geo.rects, [{w: 612}, {w: 612}], geo.scale, r.x + 72 * geo.scale, r.y + 36 * geo.scale);
  assert.equal(hit.page, 1);
  assert.ok(Math.abs(hit.x - 72) < 1e-6 && Math.abs(hit.y - 36) < 1e-6);
  assert.equal(G.pageAt(geo.rects, [{w: 612}, {w: 612}], geo.scale, 0, 0).page, 0, 'outside every page: the nearest');
  assert.deepEqual(G.visiblePages(geo.rects, 0, 600), [0]);
  assert.deepEqual(G.visiblePages(geo.rects, 0, 600, 600), [0, 1]);
  const tiles = G.visibleTiles(geo.rects[0], 0, 600);
  assert.equal(tiles[0][0], 0);
  assert.ok(tiles.every(([, top, h]) => h <= G.TILE_HEIGHT_PX && top >= 0));
  assert.equal(G.visibleTiles({x: 0, y: 0, w: 10, h: 3000}, 2100, 2200).length, 1);
});

test('the layout of a document paginates and is reused until the content changes (live.mjs)', () => {
  resetViews();
  const long = Array.from({length: 120}, (_, i) => `Paragraph ${i + 1} with enough words to take a line of its own on the page.`).join('\n');
  const c = contentFromText(long);
  const a = layoutOf('d1', c, {});
  assert.ok(a.pages.length >= 2, `paginates: ${a.pages.length} pages`);
  assert.equal(layoutOf('d1', c, {}), a, 'same content, same layout');
  const c2 = {...c};
  assert.notEqual(layoutOf('d1', c2, {}), a);
  assert.equal(viewOf('d1').pageHint, 0);
});

test('accessible mirror: paragraphs, lists with markers, runs per line, page window (a11y.rs)', () => {
  resetViews();
  const c = createContent();
  const {numbering, num} = addList(c.numbering, 'bullet');
  c.numbering = numbering;
  c.body.chunks = [[paragraphWithText('Intro paragraph.'), {...paragraphWithText('First item'), props: {style: 'ListParagraph', numbering: {num, level: 0}}},
    {...paragraphWithText('Second item'), props: {style: 'ListParagraph', numbering: {num, level: 0}}}, {...paragraphWithText('Heading'), props: {style: 'Heading1'}}]];
  const lay = layoutOf('d2', c, {});
  const tree = build(new Document(c), lay, [0, lay.pages.length]);
  const roles = tree.top.map(id => tree.nodes.get(id).role);
  assert.deepEqual(roles, ['paragraph', 'list', 'heading']);
  const list = tree.nodes.get(tree.top[1]);
  assert.equal(list.children.length, 2, 'consecutive items share a list');
  const item = tree.nodes.get(list.children[0]);
  assert.equal(item.role, 'listitem');
  assert.equal(tree.nodes.get(item.children[0]).role, 'listmarker');
  assert.equal(tree.nodes.get(tree.top[2]).level, 1);
  const runs = [...tree.nodes.values()].filter(n => n.role === 'run').map(n => n.text).join('|');
  assert.match(runs, /Intro paragraph\./);
  assert.ok(tree.count <= MAX_NODES);
  const rects = [0, 1, 2, 3].map(i => ({x: 0, y: i * 1000, w: 800, h: 990}));
  assert.deepEqual(pageWindow(rects, 1500, 400), [0, 3]);
  assert.equal(pageWindow(rects, 1e6, 400), null);
});
