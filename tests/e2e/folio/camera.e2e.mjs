// Enhance camera image, end to end in the window: the tool with its corners on the page, the bar's controls, Enhance page (the page is read as a
// picture, straightened, cleaned and put back as the page's content), a look chosen afterwards enhancing again from the original, turning the
// page, Done.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855): crates/engine/src/camera.rs (warp, enhance_camera_page_at), camera_clean.rs, ui-egui tools/camera_ui.rs (the corners
//    inset 5 %, the bar: Enhance page and Cancel; after it the looks, Clean-up, rotate, Done; a look re-enhances from the corners; one undo step per
//    change). Acrobat's Enhance camera image works the same way.
// 2. Ours: the window runs the new shell; the commands run as engine.execute and ui.activate (the bar's buttons run the same ones). The page is
//    read with pdf.js and the result put back with Replace pages. No OS input.
// 3. Evidence: artifacts/e2e/folio/camera/*.png (ui.capture -> capturePage).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {textPdf, schema1Content} from '../../../core/folio/fixtures.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

test('folio camera: the corners, Enhance page, a new look enhances again, a turn, Done', {timeout: 900_000}, async () => {
  const file = createFile('folio', 'Camera PDF');
  file.id = 'folio-camera';
  file.content = await schema1Content(await textPdf({pages: 2}), 'camera.pdf');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/camera', files: [file], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const doc = file.id;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const inspect = () => app.rpc('ui.inspect', {doc});
  const control = (ui, id) => ui.controls.find(c => c.id === id);
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const read = () => exec('camera.read');
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const v = await exec('surface.view'); return !v.migrating && v.renders.count > 0 ? v : null; }, {timeout: 90_000}).catch(e => { throw new Error(e.message + log()); });
    await exec('view.zoom.fit_width');
    await settle(800);

    // 1. The tool: its bar shows, the corners are on the page, inset.
    const picked = await exec('ocr.enhance_camera');
    assert.equal(picked.corners.length, 4);
    let ui = await app.until(async () => { const u = await inspect(); return control(u, 'camera.enhance') ? u : null; }, {timeout: 30_000});
    for (const id of ['camera.mode', 'camera.cleanup', 'camera.enhance', 'camera.cancel']) assert.ok(control(ui, id), `${id} is on the bar`);
    await settle(600);
    await app.capture('corners');

    // 2. The corners moved onto a tilted quadrilateral; Enhance page makes the page its picture.
    const [w, h] = [612, 792];
    await exec('camera.corners', {corners: [[30, 30], [w - 20, 12], [w - 40, h - 40], [20, h - 60]]});
    await settle(500);
    await app.capture('tilted');
    const before = (await read()).camera.page;
    const result = await exec('camera.enhance');
    assert.equal(result.page, 1);
    assert.equal(result.look, 'colour');
    const images = async () => (await exec('edit.images', {page: (await read()).done.page})).images.length;
    await app.until(async () => (await images()) >= 1 || null, {timeout: 30_000});
    assert.equal((await read()).done.applied[0], 'colour');
    assert.notEqual(before, undefined);
    await settle(1500);
    await app.capture('enhanced');
    const undoLabel = (await app.rpc('ui.inspect', {doc})).doc;
    assert.ok(undoLabel);

    // 3. A look chosen now enhances the page again from the original (the window undoes the first enhancement, then enhances).
    await exec('camera.mode', {look: 'bw'});
    await app.until(async () => { const r = await read(); return r.done && r.done.restyle === 0 && r.done.applied[0] === 'bw' ? r : null; }, {timeout: 120_000})
      .catch(async e => { throw new Error(e.message + JSON.stringify(await read()) + log()); });
    await settle(1500);
    await app.capture('black-and-white');
    assert.ok((await images()) >= 1, 'still a picture page');

    // 4. Turning the page is one more step, and a look chosen after it keeps the turn.
    await app.rpc('ui.activate', {doc, control: 'camera.rotate-cw'});
    assert.equal((await read()).done.turns, 90);
    await exec('camera.cleanup', {level: 80});
    await app.until(async () => { const r = await read(); return r.done && r.done.restyle === 0 && r.done.applied[1] === 80 ? r : null; }, {timeout: 120_000});
    assert.equal((await read()).done.turns, 90, 'the turn is made again');
    await settle(1200);
    await app.capture('turned');

    // 5. Done leaves the tool with the page as it is.
    await app.rpc('ui.activate', {doc, control: 'camera.done'});
    assert.equal((await read()).tool, false);
    ui = await inspect();
    assert.equal(control(ui, 'camera.enhance'), undefined, 'the bar is gone');
  } catch (e) { e.message += log(); throw e; } finally { await app.close(); }
});
