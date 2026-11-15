// core/folio/commands/view.mjs and the page display of core/folio/lib/pageview.mjs: single page and two-page
// view, continuous scrolling, cover page, page gaps, the zoom ladder, fit modes, rotate view, Read mode, full screen.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft 0.16.0 crates/ui-egui/src/commands.rs run_view_command, canvas/zoom.rs, canvas/navigation.rs, canvas.rs):
//    the layout is Single or TwoUp and continuous scrolling, the cover page and the gaps are independent switches;
//    spreads are [0, 1], [2, 3] or with a cover [0], [1, 2], [3, 4]; stepping a page in two-page view moves a whole spread
//    and stays put past either end; the zoom ladder is 10 25 33 50 66 75 100 125 150 200 300 400 600 800 1200 1600 3200 and a
//    step must differ by 1 %; Fit one full page is single, not continuous, fit page; Fit to width scrolling is single,
//    continuous, fit width; full screen shows one page at a time fitted to the screen and gives the display back after;
//    Rotate view turns the view a quarter without touching the document. Acrobat's View menu does the same.
// 2. Ours does the same: the layout numbers and the commands' view state are checked here; the window in
//    tests/e2e/folio/view.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {layoutPages, rowsOf, spreadFirst, stepTarget, zoomStep, fitZoom, displayOf, PT, GAP, MARGIN, SIDE, currentPage} from '../../core/folio/lib/pageview.mjs';

const pages = n => Array.from({length: n}, (_, i) => ({id: `p${i}`, width: 600, height: 800, rotation: 0, sourceRotation: 0}));

test('spreads: [0, 1], [2, 3] or with a cover [0], [1, 2], [3, 4]; the first page of a spread', () => {
  assert.deepEqual(rowsOf(5, {layout: 'two-up'}), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(rowsOf(5, {layout: 'two-up', cover: true}), [[0], [1, 2], [3, 4]]);
  assert.deepEqual(rowsOf(3, {layout: 'single'}), [[0], [1], [2]]);
  assert.deepEqual([0, 1, 2, 3, 4].map(c => spreadFirst(c, false)), [0, 0, 2, 2, 4]);
  assert.deepEqual([0, 1, 2, 3, 4].map(c => spreadFirst(c, true)), [0, 1, 1, 3, 3]);
});

test('stepping a page: a spread at a time in two-page view, nowhere past either end', () => {
  const two = {layout: 'two-up'};
  assert.equal(stepTarget(0, true, 6, two), 2);
  assert.equal(stepTarget(1, true, 6, two), 2, 'the other page of the spread is already on screen');
  assert.equal(stepTarget(2, false, 6, two), 0);
  assert.equal(stepTarget(0, false, 6, two), null);
  assert.equal(stepTarget(4, true, 6, two), null, 'the last spread has nowhere to go');
  const cover = {layout: 'two-up', cover: true};
  assert.equal(stepTarget(0, true, 6, cover), 1);
  assert.equal(stepTarget(1, false, 6, cover), 0);
  assert.equal(stepTarget(3, false, 6, cover), 1);
  assert.equal(stepTarget(2, true, 6, cover), 3);
  assert.equal(stepTarget(0, true, 3, {}), 1);
  assert.equal(stepTarget(2, true, 3, {}), null);
});

test('the zoom ladder: the next step must differ by 1 %', () => {
  assert.equal(zoomStep(100, true), 125);
  assert.equal(zoomStep(100, false), 75);
  assert.equal(zoomStep(99.5, true), 125, '99.5 % is the 100 % step already');
  assert.equal(zoomStep(3200, true), null);
  assert.equal(zoomStep(10, false), null);
  assert.equal(zoomStep(30, true), 33);
});

test('two-page layout: pages side by side, a cover on the right, gaps optional; single scrolling stays as it was', () => {
  const single = layoutPages(pages(3), 100, 1200);
  assert.equal(single.tops[0], MARGIN);
  assert.equal(single.tops[1], MARGIN + 800 * PT + GAP);
  const two = layoutPages(pages(4), 100, 1600, {layout: 'two-up'});
  assert.equal(two.tops[0], two.tops[1], 'a spread shares a top');
  assert.ok(two.left(1) > two.left(0) + two.widths[0] - 0.01 && Math.abs(two.left(1) - (two.left(0) + two.widths[0] + GAP)) < 0.01);
  assert.ok(two.tops[2] > two.tops[0] + two.heights[0]);
  const flat = layoutPages(pages(4), 100, 1600, {layout: 'two-up', gaps: false});
  assert.equal(Math.round(flat.left(1) - flat.left(0) - flat.widths[0]), 0, 'no gap between the pages of a spread');
  const cover = layoutPages(pages(3), 100, 1600, {layout: 'two-up', cover: true});
  assert.ok(cover.left(0) > 1600 / 2 - 1, 'the cover is on the right of its spread');
  assert.equal(cover.tops[1], cover.tops[2]);
  assert.ok(cover.left(1) < cover.left(2));
});

test('without continuous scrolling each page or spread has a slot at least as high as the window', () => {
  const l = layoutPages(pages(3), 50, 1000, {continuous: false, viewHeight: 900});
  const slot = l.slotTops[1] - l.slotTops[0];
  assert.ok(slot >= 900 - 0.01, `slot ${slot}`);
  assert.ok(l.tops[0] >= l.slotTops[0] && l.tops[0] + l.heights[0] <= l.slotTops[0] + slot, 'the page sits inside its slot');
  assert.ok(l.tops[0] > l.slotTops[0], 'a page smaller than the window is centred in its slot');
  assert.equal(currentPage(l, l.slotTops[2], 900), 2);
  assert.equal(displayOf({}).continuous, true);
  assert.equal(displayOf({continuous: false}).continuous, false);
});

test('fit modes: width fills the window less the gutters; page fits the whole page; two-page view halves the width; visible fits the content', () => {
  const p = pages(1)[0];
  const width = fitZoom('width', p, 1000, 800);
  assert.ok(Math.abs(width - (1000 - 2 * SIDE) / (600 * PT) * 100) < 0.01);
  assert.ok(fitZoom('page', p, 1000, 800) < width);
  assert.ok(Math.abs(fitZoom('height', p, 1000, 800) - (800 - 2 * MARGIN) / (800 * PT) * 100) < 0.01);
  const two = fitZoom('width', p, 1400, 800, {pages: pages(2), layout: 'two-up'});
  assert.ok(Math.abs(two - (1400 - 2 * SIDE - GAP) / (600 * PT * 2) * 100) < 0.01);
  const visible = fitZoom('visible', p, 1000, 800, {content: [100, 100, 300, 200]});
  assert.ok(visible > fitZoom('page', p, 1000, 800), 'the content is smaller than the page, so it zooms in more');
});

test('View commands set view state: layout, continuous, cover (two-page view only), gaps, fit, rotate, read mode', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  const view = () => t.doc.view;
  const st = id => t.session.state(t.docId, id, {});
  assert.equal((await st('view.layout.single')).checked, true);
  assert.equal((await st('view.layout.cover')).enabled, false, 'only two-page view has a cover page');
  await t.exec('view.layout.two_up', {});
  assert.equal(view().layout, 'two-up');
  assert.equal((await st('view.layout.two_up')).checked, true);
  assert.equal((await st('view.layout.cover')).enabled, true);
  await t.exec('view.layout.cover', {});
  assert.equal(view().cover, true);
  await t.exec('view.continuous', {});
  assert.equal(view().continuous, false);
  assert.equal((await st('view.continuous')).checked, false);
  await t.exec('view.page_gaps', {});
  assert.equal(view().gaps, false);
  await t.exec('view.fit_one_page', {});
  assert.deepEqual([view().layout, view().continuous, view().fit], ['single', false, 'page']);
  assert.equal((await st('view.fit_one_page')).checked, true);
  await t.exec('view.fit_width_scrolling', {});
  assert.deepEqual([view().layout, view().continuous, view().fit], ['single', true, 'width']);
  await t.exec('view.zoom.actual_size', {});
  assert.deepEqual([view().zoom, view().fit], [100, null]);
  await t.exec('view.zoom.fit_height', {});
  assert.equal(view().fit, 'height');
  await t.exec('view.zoom.page_level', {});
  assert.equal(view().fit, 'page', 'Zoom to page level fits the whole page');
  assert.equal((await st('view.zoom.page_level')).checked, true);
  await t.exec('view.fit_visible', {});
  assert.equal(view().fit, 'visible');
  await t.exec('view.rotate.cw', {});
  await t.exec('view.rotate.cw', {});
  assert.equal(view().rotation, 180);
  await t.exec('view.rotate.ccw', {});
  assert.equal(view().rotation, 90);
  assert.equal(t.content.pages[0].rotation, 0, 'the document is not rotated');
  await t.exec('view.read_mode', {});
  assert.equal(view().readMode, true);
  await t.exec('view.read_mode', {});
  assert.equal(view().readMode, false);
});

test('Full screen shows one page at a time fitted to the screen and gives the display back', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  await t.exec('view.layout.two_up', {});
  await t.exec('view.zoom.actual_size', {});
  await t.exec('view.full_screen', {});
  assert.deepEqual([t.doc.view.presenting, t.doc.view.continuous, t.doc.view.fit], [true, false, 'page']);
  await t.exec('view.full_screen', {});
  assert.deepEqual([t.doc.view.presenting, t.doc.view.layout, t.doc.view.continuous, t.doc.view.fit, t.doc.view.zoom], [false, 'two-up', true, null, 100]);
  await t.exec('view.tools_pane', {});
  assert.equal(t.doc.view.toolsPane, false, 'the panel is open to begin with, so the first toggle closes it');
  await t.exec('view.tools_pane', {});
  assert.equal(t.doc.view.toolsPane, true);
  await t.exec('view.side_panel', {});
  assert.equal(t.doc.view.panel, 'pages');
  await t.exec('view.side_panel', {});
  assert.equal(t.doc.view.panel, null);
});
