// View, end to end in the window (docs/behaviour-fidelity.md):
//   the page display (two-page view, cover page, one page at a time), zoom steps, Rotate view, the marquee zoom
//   drag (through the page view's own pointer handlers), the view history, Read mode and Full screen.
//
// Behaviour fidelity:
// 1. printcraft 0.16.0: crates/ui-egui/src/commands.rs run_view_command, canvas/zoom.rs, canvas/navigation.rs.
//    Acrobat's View menu works the same way.
// 2. Here the window runs the new shell (devRenderer); the commands run as engine.execute (the View menu and the
//    rail run the same ones), the drag through surface.pointer; what the view shows is read with surface.view.
//    No OS input (the window's full screen is never taken in test runs).
// 3. Evidence: artifacts/e2e/folio/view/*.png (ui.capture -> capturePage).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {textPdf, schema1Content} from '../../../core/folio/fixtures.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

test('folio view: two-page view, cover, one page at a time, zoom, rotate, marquee zoom, history, read mode, full screen', {timeout: 400_000}, async () => {
  const file = createFile('folio', 'View PDF');
  file.id = 'folio-view';
  file.content = await schema1Content(await textPdf({pages: 5}), 'view.pdf');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/view', files: [file], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const doc = file.id;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const surface = () => exec('surface.view');
  const viewState = async () => (await app.rpc('document.read', {doc, address: '/'})).view ?? null;
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const painted = async () => { await app.until(async () => { const v = await surface(); return v.renders.count > 0 ? v : null; }, {timeout: 30_000}); await settle(900); };
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const v = await surface(); return !v.migrating && v.renders.count > 0 ? v : null; }, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await exec('view.zoom.fit_width');
    await settle(800);
    await app.capture('single');

    // 1. Two-page view: two pages side by side; the zoom follows (fit width halves).
    const one = (await surface()).zoom;
    await exec('view.layout.two_up');
    await settle(900);
    const two = (await surface()).zoom;
    assert.ok(two < one * 0.6, `fit width in two-page view is about half: ${one} -> ${two}`);
    await painted();
    await app.capture('two-page');
    await exec('view.layout.cover');
    await settle(900);
    await app.capture('two-page-cover');
    // A step turns a whole spread.
    const s0 = await surface();
    await exec('view.step_page', {forward: true});
    await settle(500);
    assert.ok((await surface()).current > s0.current, 'a step moves to the next spread');

    // 2. One page at a time, fitted: Fit one full page.
    await exec('view.layout.single');
    await exec('view.fit_one_page');
    await settle(900);
    await app.capture('one-page');
    const zoomFit = (await surface()).zoom;
    await exec('view.step_page', {forward: true});
    await settle(500);
    const afterStep = await surface();
    assert.ok(Math.abs(afterStep.zoom - zoomFit) < 0.5, 'the zoom holds still while pages turn');

    // 3. Zoom steps and Rotate view.
    await exec('view.zoom.actual_size');
    await settle(400);
    assert.equal(Math.round((await surface()).zoom), 100);
    await exec('view.zoom.in');
    assert.equal(Math.round((await surface()).zoom), 125);
    await exec('view.zoom.out');
    await exec('view.zoom.out');
    assert.equal(Math.round((await surface()).zoom), 75);
    await exec('view.fit_width_scrolling');
    await exec('view.rotate.cw');
    await settle(1200);
    await app.capture('rotated');
    const pageAfterTurn = await app.rpc('document.read', {doc, address: '/pages'});
    assert.equal(pageAfterTurn.value[0].rotation, 0, 'the document is not rotated');
    await exec('view.rotate.ccw');

    // 4. Marquee zoom: pick the tool, drag a rectangle on page 1.
    await exec('view.fit_width_scrolling');
    await exec('view.zoom.fit_width');
    await exec('view.step_page', {forward: false}).catch(() => {});
    await exec('view.marquee_zoom');
    const before = (await surface()).zoom;
    await app.rpc('engine.execute', {doc, command: 'surface.pointer', params: {page: 1, action: 'drag', x: 60, y: 60, to: {x: 330, y: 160}}});
    await settle(1200);
    const after = await surface();
    assert.ok(after.zoom > before * 1.5, `the marquee zoomed in: ${before} -> ${after.zoom}`);
    await painted();
    await app.capture('marquee-zoom');

    // 5. The view history: a jump to page 4 and back.
    await exec('view.zoom.fit_width');
    await exec('view.focus_page_input', {value: 1});
    await settle(500);
    await exec('view.focus_page_input', {value: 4});
    await settle(700);
    assert.equal((await surface()).current, 3);
    await exec('view.previous_view');
    await settle(700);
    assert.equal((await surface()).current, 0, 'Previous view goes back to the page left');
    await exec('view.next_view');
    await settle(700);
    assert.equal((await surface()).current, 3);

    // 6. Read mode and Full screen.
    await exec('view.read_mode');
    await settle(900);
    await app.capture('read-mode');
    await exec('view.read_mode');
    await exec('view.full_screen');
    await settle(1000);
    const presenting = await surface();
    assert.ok(presenting.zoom > 0);
    await app.capture('full-screen');
    await exec('view.step_page', {forward: true});
    await exec('view.full_screen');
    await settle(700);
    void viewState;
  } catch (e) { e.message += log(); throw e; } finally { await app.close(); }
});
