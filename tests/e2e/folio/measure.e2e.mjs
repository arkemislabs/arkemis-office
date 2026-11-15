// Measure, end to end in the window (docs/behaviour-fidelity.md):
//   the Measure panel opening with the tool, clicks on the page placing vertices (snapping to the drawing's endpoints, the rubber band
//   and the reading by the pointer), Distance ending at two points, Perimeter on a double click, Area on a click at the first vertex,
//   Apply scale (1:50) from the panel's field, the measurements read in that scale, and the saved list.
//
// Behaviour fidelity:
// 1. printcraft 0.16.0: crates/ui-egui/src/tools/measure_ui.rs (page_input, panel_body). Acrobat's Measure tools work the same way.
// 2. Here the window runs the new shell (devRenderer); the page gestures go through surface.pointer (in-page pointer events at page
//    view points, the page view's own handlers), the rest as engine.execute (the panel's controls run the same commands). No OS input.
// 3. Evidence: artifacts/e2e/folio/measure/*.png (ui.capture -> capturePage).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {drawingPdf, schema1Content} from '../../../core/folio/fixtures.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

test('folio measure: the panel, clicks that snap, distance, perimeter, area, a drawing scale, the saved list', {timeout: 600_000}, async () => {
  const file = createFile('folio', 'Measure PDF');
  file.id = 'folio-measure';
  file.content = await schema1Content(await drawingPdf(), 'drawing.pdf');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/measure', files: [file], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const doc = file.id;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const surface = () => exec('surface.view');
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const click = async (x, y, extra = {}) => { await exec('surface.pointer', {page: 1, action: 'click', x, y, ...extra}); await settle(450); };
  const move = async (x, y, extra = {}) => { await exec('surface.pointer', {page: 1, action: 'move', x, y, ...extra}); await settle(450); };
  const info = async () => exec('measure.info');
  // The drawing is in user space (origin bottom left); view y = 792 - user y.
  const v = (x, y) => [x, 792 - y];
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const s = await surface(); return !s.migrating && s.renders.count > 0 ? s : null; }, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await exec('view.zoom.fit_width');
    await settle(800);

    // 1. Picking Distance opens the Measure panel.
    await exec('measure.distance');
    await settle(900);
    await app.capture('panel');
    // 2. A press near an endpoint of the drawing snaps to it; the pointer shows the snap and the reading.
    await click(...v(12, 22));
    await move(...v(60, 70));
    await app.capture('first-point');
    // 3. The second click ends the distance: 10, 20 to 110, 20 snapped, 100 pt = 1.39 in.
    await click(...v(108, 22));
    let list = (await info()).measurements;
    assert.equal(list.length, 1, 'the distance was added');
    assert.deepEqual(list[0].points, [[10, 20], [110, 20]], 'both ends snapped to the line work');
    assert.equal(list[0].reading.label, '1.39 in');
    await app.capture('distance');

    // 3b. While a distance is placed it shows its open arrows, the way the saved line ends.
    await exec('measure.distance');
    await settle(400);
    await click(...v(300, 700));
    await move(...v(420, 700));
    await app.capture('distance-live');

    // 4. Perimeter: three clicks and a double click on the last vertex.
    await exec('measure.perimeter');
    await settle(500);
    await click(...v(200, 300));
    await click(...v(300, 300));
    await click(...v(300, 400));
    await exec('surface.pointer', {page: 1, action: 'double', x: v(300, 400)[0], y: v(300, 400)[1]});
    await settle(900);
    list = (await info()).measurements;
    assert.equal(list.length, 2, 'the perimeter was added');
    assert.equal(list[1].kind, 'perimeter');
    assert.equal(list[1].reading.label, '2.78 in');
    await app.capture('perimeter');

    // 5. Area: a triangle closed by a click on its first vertex.
    await exec('measure.area');
    await settle(500);
    await click(...v(350, 500));
    await click(...v(450, 500));
    await click(...v(450, 600));
    await app.capture('area-drawing');
    await click(...v(350, 500));
    list = (await info()).measurements;
    assert.equal(list.length, 3, 'the area was added');
    assert.equal(list[2].kind, 'area');
    assert.equal(list[2].reading.label, '0.96 sq in');
    await app.capture('area');

    // 6. The drawing scale from the panel: 1:50 applies at once; the next distance reads in metres.
    await exec('measure.scale', {ratio: '1:50'});
    await settle(500);
    await exec('measure.distance');
    await settle(500);
    await click(...v(200, 700));
    await click(...v(272, 700));
    list = (await info()).measurements;
    assert.equal(list.at(-1).reading.label, '1.27 m', '72 pt of paper (25.4 mm) at 1:50');
    await app.capture('scaled');

    // 7. Back to Select: the panel closes with the tool.
    await exec('measure.panel', {open: false});
    await settle(700);
    await app.capture('closed');
  } catch (e) { e.message += log(); throw e; } finally { await app.close(); }
});
