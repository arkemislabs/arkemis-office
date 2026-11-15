// Quill's Draw tab (U:quill/draw) end to end through the bridge, in the new shell. No OS input: the ribbon
// through ui.activate / ui.menu, the strokes through ui.pointer {action: 'stroke'} (the page view's own
// gesture handler: what dragging with the picked tool does), and the document read back over the bridge.
//
// Behaviour fidelity:
// 1. ArtCraft crates/ui-egui/src/ribbon/draw.rs (the tab, the pen gallery), engine/src/cmd/draw.rs and
//    cmd/canvas.rs, canvas/input.rs (the gestures); Word: a pen draws ink on the page, the eraser removes
//    the stroke it passes over, the lasso selects ink and moves it, Ink to Shape turns a rough shape into
//    that shape, Ink Replay plays the strokes back, and the ink is saved with the document.
// 2. The same commands run from the window (the person's path); each change is one undo step; the page
//    view draws the ink from the same layout (captures below).
// 3. This file; the engine side is tests/quill/draw.test.mjs and tests/quill/upstream/draw_tests.test.mjs.
//
// Evidence: artifacts/e2e/quill/draw/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';
import {documentsFolder, exists, binding, run as runFlow, script, start, vaultCopy, windowOf} from '../common/file-helpers.mjs';

const para = text => ({type: 'paragraph', content: [{type: 'text', text}]});

function seedDoc(id) {
  const seed = createFile('quill', 'Sketch');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Site sketch'}]},
    para('The courtyard sits behind the main hall, with the garden to its east and the car park to the north.'),
    para('Mark the new entrance with an arrow, circle the tree that stays and box the shed that goes.'),
    para('Notes follow below the drawing.'),
  ]};
  return migrateFile(seed);
}

const squiggle = (x, y, n = 30) => Array.from({length: n}, (_, i) => [x + i * 4, y + Math.sin(i / 2.5) * 14]);
const rect = (x, y, w, h) => {
  const c = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], pts = [];
  for (let i = 0; i < 4; i++) { const [a, b] = [c[i], c[(i + 1) % 4]]; for (let k = 0; k < 10; k++) pts.push([a[0] + (b[0] - a[0]) * k / 10, a[1] + (b[1] - a[1]) * k / 10]); }
  pts.push([x, y]);
  return pts;
};
const ring = (cx, cy, rx, ry) => Array.from({length: 49}, (_, i) => { const a = i / 48 * Math.PI * 2; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]; });
const line = (x0, y0, x1, y1, n = 20) => Array.from({length: n + 1}, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]);

/** Every shape object of a document body (read over the bridge as JSON), flattened. */
function shapesIn(body) {
  const out = [];
  const walk = v => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.type === 'shape' && v.kind) out.push(v);
      Object.values(v).forEach(walk);
    }
  };
  walk(body);
  return out;
}
const inkIn = body => shapesIn(body).filter(o => o.freeform?.ink);

test('quill Draw tab: pens and the gallery, drawing, eraser, lasso, Ink to Shape, canvas, replay; saved to .docx and read back', {timeout: 900_000}, async () => {
  const seed = seedDoc('quill-draw');
  const folder = await documentsFolder('quill-draw');
  const target = path.join(folder, 'Sketch.docx');
  let pensBefore = [];
  let keepData = false, profile = null;
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/draw', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = () => app.rpc('document.read', {doc, address: '/body', as: 'json'});
  const settle = (ms = 450) => new Promise(r => setTimeout(r, ms));
  const inspect = () => app.rpc('ui.inspect', {doc});
  const control = async id => (await inspect()).controls?.find(c => c.id === id) ?? null;
  const activate = (id, value) => app.rpc('ui.activate', {doc, control: id, ...(value === undefined ? {} : {value})});
  const draw = points => app.rpc('ui.pointer', {doc, action: 'stroke', page: 0, path: points});
  const body = async () => (await read()).value;
  const ink = async () => inkIn(await body());
  const shapes = async () => shapesIn(await body());
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await inspect(); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });

    // The Draw tab: its groups; the controls with no upstream engine are hidden.
    await app.rpc('ui.tab', {doc, id: 'draw'});
    await settle();
    const ids = new Set(((await inspect()).controls ?? []).map(c => c.id));
    for (const id of ['draw.drawing-tools.select', 'draw.drawing-tools.lasso', 'draw.drawing-tools.eraser', 'draw.drawing-tools.pen', 'draw.drawing-tools.pencil',
      'draw.drawing-tools.highlighter', 'draw.drawing-tools.gallery-pens', 'draw.drawing-tools.add-pen', 'draw.drawing-tools.color', 'draw.drawing-tools.thickness',
      'draw.convert.ink-to-shape', 'draw.insert.drawing-canvas', 'draw.replay.ink-replay']) assert.ok(ids.has(id), `${id} is on the Draw tab`);
    assert.ok(!ids.has('draw.stencils.ruler'), 'the Ruler stencil has no upstream engine');
    assert.ok(!ids.has('draw.convert.ink-to-math'), 'Ink to Math has no upstream engine (handwriting recognition)');
    await app.capture('1-draw-tab', {doc});

    // A red pen, 2.5 pt: draw a squiggle through the bridge's stroke input; it is real ink, selected nowhere yet.
    await activate('draw.drawing-tools.pen');
    assert.equal((await control('draw.drawing-tools.pen'))?.checked, true, 'the pen is picked up');
    await activate('draw.drawing-tools.color', '#C00000');
    await app.rpc('ui.menu', {doc, control: 'draw.drawing-tools.thickness'});
    await settle();
    await app.capture('2-thickness-menu', {doc});
    await app.rpc('ui.menu', {doc, control: 'draw.drawing-tools.thickness', open: false});
    await activate('draw.drawing-tools.thickness', '2.5');
    assert.equal((await run('draw.pen', {})).pen.width, 2.5);
    await draw(squiggle(120, 330));
    let strokes = await ink();
    assert.equal(strokes.length, 1, 'one stroke is in the document');
    assert.deepEqual([...strokes[0].stroke], [192, 0, 0]);
    assert.equal(strokes[0].strokeWidth, 2.5);

    // Add the pen to the gallery (a tile drawn in its colour), then a blue highlighter and a green pencil.
    await app.rpc('ui.menu', {doc, control: 'draw.drawing-tools.add-pen'});
    await settle();
    await app.capture('3-add-pen-menu', {doc});
    await app.rpc('ui.menu', {doc, control: 'draw.drawing-tools.add-pen', open: false});
    await activate('draw.drawing-tools.add-pen.pen');
    await activate('draw.drawing-tools.highlighter');
    await activate('draw.drawing-tools.color', '#FFC000');
    await activate('draw.drawing-tools.add-pen.highlighter');
    await activate('draw.drawing-tools.pencil');
    await activate('draw.drawing-tools.color', '#00B050');
    await activate('draw.drawing-tools.add-pen.pencil');
    const gallery = (await control('draw.drawing-tools.gallery-pens'))?.value ?? [];
    assert.deepEqual(gallery.map(g => g.icon), ['pen', 'pen', 'pen', 'pencil', 'highlight', 'pen', 'highlight', 'pencil'], 'the default pens, then the three added: each tile is a drawn icon');
    assert.deepEqual(gallery.map(g => g.accent), ['#000000', '#FF0000', '#0070C0', '#000000', '#FFFF00', '#C00000', '#FFC000', '#00B050'], 'in the pen colour');
    pensBefore = gallery.map(g => g.accent);
    await settle();
    await app.capture('4-pen-gallery', {doc});

    // Draw with the highlighter from the gallery (behind the text), then the pencil.
    await app.rpc('ui.activate', {doc, control: 'draw.drawing-tools.gallery-pens', value: 6});
    assert.equal((await control('draw.drawing-tools.highlighter'))?.checked, true, 'the gallery pen is picked up');
    await draw(line(90, 126, 500, 130, 40).map(([x, y]) => [x, y]));
    await app.rpc('ui.activate', {doc, control: 'draw.drawing-tools.gallery-pens', value: 7});
    await draw(squiggle(130, 420, 36));
    strokes = await ink();
    assert.deepEqual(strokes.map(s => s.freeform.ink).sort(), ['highlighter', 'pen', 'pencil']);
    assert.equal(strokes.find(s => s.freeform.ink === 'highlighter').float.wrap, 'behindText');
    await settle();
    await app.capture('5-ink-pen-highlighter-pencil', {doc});

    // Eraser: dragging across the pencil stroke erases it; each stroke is one undo step.
    await activate('draw.drawing-tools.eraser');
    assert.equal((await control('draw.drawing-tools.eraser'))?.checked, true);
    await draw(line(120, 420, 300, 420, 8));
    assert.equal((await ink()).length, 2, 'the pencil stroke is erased');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.equal((await ink()).length, 3, 'Undo brings it back');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Y'});
    assert.equal((await ink()).length, 2, 'Redo erases it again');

    // Lasso: a loop round the red squiggle selects it; dragging from inside the selection moves it.
    await activate('draw.drawing-tools.lasso');
    const redFloat = (await ink()).find(s => s.freeform.ink === 'pen').float;
    await draw([[100, 300], [260, 300], [260, 380], [100, 380], [100, 300]]);
    assert.equal((await control('draw.drawing-tools.lasso'))?.checked, true);
    await settle();
    await app.capture('6-lasso-selection', {doc});
    await draw([[150, 340], [210, 380]]);
    const movedFloat = (await ink()).find(s => s.freeform.ink === 'pen').float;
    assert.ok(Math.abs(movedFloat.x - redFloat.x - 60) < 0.6 && Math.abs(movedFloat.y - redFloat.y - 40) < 0.6, `the selection moved by (60, 40): ${JSON.stringify([redFloat, movedFloat])}`);
    await settle();
    await app.capture('7-lasso-moved', {doc});

    // Ink to Shape: with nothing lasso-selected it turns the mode on; then a rough rectangle, an ellipse and an arrow become shapes; a squiggle stays ink.
    await run('draw.lasso', {clear: true});
    await activate('draw.convert.ink-to-shape');
    assert.equal((await control('draw.convert.ink-to-shape'))?.checked, true, 'Ink to Shape is on');
    await activate('draw.drawing-tools.pen');
    await activate('draw.drawing-tools.color', '#2F5597');
    await draw(rect(360, 290, 110, 60).map(([x, y], i) => [x + (i % 3) * 0.8, y - (i % 2) * 0.9]));
    await draw(ring(210, 470, 60, 30));
    const tail = [470, 400], tip = [380, 500];
    const back = Math.atan2(tail[1] - tip[1], tail[0] - tip[0]);
    const barb = s => [tip[0] + 22 * Math.cos(back + s * 0.5), tip[1] + 22 * Math.sin(back + s * 0.5)];
    await draw([...line(tail[0], tail[1], tip[0], tip[1], 20), barb(1), tip, barb(-1)]);
    await draw(squiggle(120, 252, 22));
    const kinds = (await shapes()).filter(s => !s.freeform?.ink).map(s => s.kind).sort();
    assert.deepEqual(kinds, ['ellipse', 'rectangle', 'straightConnector'], JSON.stringify(kinds));
    assert.equal((await ink()).filter(s => s.freeform.ink === 'pen').length, 2, 'the red squiggle and the new squiggle stay ink');
    await activate('draw.convert.ink-to-shape');
    await settle();
    await app.capture('8-ink-to-shape', {doc});

    // Drawing Canvas: an empty canvas in line with the text at the caret.
    await run('caret.set', {pos: {block: 3, off: 0}});
    await activate('draw.insert.drawing-canvas');
    assert.ok(JSON.stringify(await body()).includes('"group"'), 'a drawing canvas is in the document');
    await settle();
    await app.capture('9-drawing-canvas', {doc});

    await app.rpc('ui.tab', {doc, id: 'draw'});  // the selected canvas brings its own tab forward
    // Ink Replay: the strokes play back in the order they were drawn; Hide Ink hides them.
    await activate('draw.replay.ink-replay');
    assert.equal((await control('draw.replay.ink-replay'))?.checked, true, 'replay is running');
    await settle(900);
    await app.capture('10-ink-replay', {doc});
    await app.until(async () => (await control('draw.replay.ink-replay'))?.checked === false || null, {timeout: 60_000}).catch(() => {});
    await run('draw.replay', {value: false});
    await run('review.hideInk', {value: true});
    await settle();
    await app.capture('11-hide-ink', {doc});
    await run('review.hideInk', {value: false});

    // The old action name still draws (deprecated alias of 'stroke').
    await activate('draw.drawing-tools.pen');
    const nInk = (await ink()).length;
    await app.rpc('ui.pointer', {doc, action: 'draw', page: 0, points: line(120, 285, 260, 290, 10)});
    assert.equal((await ink()).length, nInk + 1, "'draw' with points is 'stroke' with a path");
    await app.rpc('ui.pointer', {doc, action: 'stroke', page: 0, path: line(120, 295, 260, 300, 10).map(([x, y]) => ({x, y, pressure: 0.5}))});
    assert.equal((await ink()).length, nInk + 2, 'a path of {x, y} samples draws too');

    // Save as .docx (File > Save, scripted dialog), then open the file in a second app (the same profile).
    const inkBefore = (await ink()).map(s => [s.freeform.ink, [...s.stroke], s.freeform.order]).sort((a, b) => a[2] - b[2]);
    await script(app, {type: 'save', path: target});
    const key = await app.rpc('ui.key', {doc, keys: 'Ctrl+S'});
    assert.equal(key.command, 'file.save');
    await app.until(() => exists(target), {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.until(async () => (await binding(app, doc))?.path === target || null, {timeout: 30_000});
    globalThis.__inkBefore = inkBefore;
    await settle(12_000);  // the settings store writes to disk on a timer
    keepData = true;
    profile = app.data;
  } finally {
    await app.close({keepData});
  }

  const inkBefore = globalThis.__inkBefore;
  assert.ok(inkBefore?.length >= 3, 'ink was saved');
  await new Promise(r => setTimeout(r, 5000));  // the first launch's processes let go of the profile
  // The second launch is the same profile once the first launch's processes let go of it (Chromium's single-instance lock): tried again if it was not yet.
  let app2 = null;
  for (let i = 0; !app2; i++) {
    await new Promise(r => setTimeout(r, i ? 15_000 : 8000));
    try { app2 = await start('quill', 'draw-reopen', {args: [target], data: profile}); } catch (e) { if (i >= 3) throw e; }
  }
  await runFlow(async () => {
    const d = await app2.until(async () => (await app2.rpc('documents.list', {})).documents.find(x => x.path === target) || null, {timeout: 30_000});
    await app2.until(async () => (await windowOf(app2, d.id))?.title === 'Sketch - Quill' || null, {timeout: 30_000});
    const copy = await vaultCopy(app2, d.id);
    const back = inkIn(copy.content.body).sort((a, b) => a.freeform.order - b.freeform.order);
    assert.deepEqual(back.map(s => [s.freeform.ink, [...s.stroke], s.freeform.order]), inkBefore, 'the ink reads back from the .docx, in drawing order');
    const opened = await app2.rpc('documents.open', {doc: d.id, show: true});
    await new Promise(r => setTimeout(r, 1500));
    await app2.capture('12-reopened', {window: opened.window});
    // Read back, it is real ink again: selectable with the lasso, movable and erasable.
    const doc2 = d.id;
    const exec = async (command, params = {}) => (await app2.rpc('engine.execute', {doc: doc2, command, params})).result;
    await app2.rpc('ui.tab', {doc: doc2, id: 'draw'});
    await new Promise(r => setTimeout(r, 500));
    const gallery2 = ((await app2.rpc('ui.inspect', {doc: doc2})).controls.find(c => c.id === 'draw.drawing-tools.gallery-pens')?.value ?? []).map(g => g.accent);
    assert.deepEqual(gallery2, pensBefore, 'the pens added in the first launch are in the gallery of the next one (the profile keeps them)');
    await app2.rpc('ui.activate', {doc: doc2, control: 'draw.drawing-tools.eraser'});
    const count = async () => inkIn((await app2.rpc('document.read', {doc: doc2, address: '/body', as: 'json'})).value ?? {}).length;
    const n0 = await count();
    const hit = back.find(s => s.freeform.ink === 'pen');
    assert.ok(hit, 'a pen stroke came back');
    const sel = await exec('draw.lasso', {page: 0, points: [[0, 0], [612, 0], [612, 792], [0, 792]]});
    assert.ok(sel.count >= n0, `the lasso selects the ink that came back (${sel.count} of ${n0})`);
    await exec('draw.lassoMove', {dx: 10, dy: 10});
    await exec('draw.lasso', {clear: true});
    await new Promise(r => setTimeout(r, 400));
    await app2.capture('13-reopened-moved', {window: opened.window});
    await exec('draw.lasso', {page: 0, points: [[0, 0], [612, 0], [612, 792], [0, 792]]});
    await exec('draw.lassoDelete', {});
    assert.equal(await count(), 0, 'the ink read back is deletable');
    await new Promise(r => setTimeout(r, 400));
    await app2.capture('14-reopened-deleted', {window: opened.window});
  }, app2);
  await fs.rm(folder, {recursive: true, force: true});
  if (profile) await fs.rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}).catch(() => {});
});
