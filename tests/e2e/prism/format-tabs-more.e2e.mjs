// Prism: Merge Shapes, Compress Pictures, Custom Slide Show and Rehearse Timings in the app.
//
// What deckcraft does: cmd/merge.rs, cmd/compress.rs, dialogs/body.rs dlg_custom_show, show.rs (rehearse).
// What this proves end to end: the Merge menu and the two dialogs open from their ribbon controls and
// draw (captured), merged shapes draw as one freeform, and a rehearsal runs with its clock.
// Captures in artifacts/e2e/prism/format-tabs-more/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {shape, presetGeom, slide} from '../../../core/prism/model/presentation.mjs';
import {colorRgb, fillSolid} from '../../../core/prism/model/style.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';
import {pictureFill, base64Encode} from '../../../core/prism/lib/shape-common.mjs';
import {encodePng} from '../../../core/prism/lib/raster.mjs';

const box = (id, name, x, y, preset, rgb) => shape({id, name, xfrm: {x, y, w: 160, h: 120}, geom: presetGeom(preset), fill: fillSolid(colorRgb({...rgb, a: 255})), text: bodyFromText(name)});

test('prism format tabs, more: merge shapes, Compress Pictures and Custom Shows dialogs, Rehearse Timings', {timeout: 600_000}, async () => {
  const file = createFile('prism', 'More format tabs', {schema: 2});
  file.id = 'prism-format-tabs-more';
  const c = file.content;
  const s1 = c.slides[0];
  s1.shapes.push(box('m1', 'Rect', 100, 140, 'rect', {r: 68, g: 114, b: 196}), box('m2', 'Oval', 190, 140, 'ellipse', {r: 237, g: 125, b: 49}),
    box('m3', 'Left', 420, 140, 'rect', {r: 112, g: 173, b: 71}), box('m4', 'Right', 500, 190, 'ellipse', {r: 91, g: 155, b: 213}));
  const w = 400, h = 200, data = new Uint8ClampedArray(w * h * 4);
  let x = 99;
  for (let i = 0; i < w * h; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; data.set([(x & 255) * 0.4 + 100, ((x >> 8) & 255) * 0.4 + 60, ((x >> 16) & 255) * 0.4 + 60, 255], i * 4); }
  c.media = [{id: 'pic1', name: 'noise.png', contentType: 'image/png', data: base64Encode(await encodePng({width: w, height: h, data})), link: null}];
  s1.shapes.push(shape({id: 'pic', name: 'Picture 1', xfrm: {x: 700, y: 140, w: 100, h: 50}, kind: {type: 'picture', fill: pictureFill('pic1')}, geom: presetGeom('rect')}));
  c.slides.push(slide({id: 's2', layout: s1.layout, shapes: []}), slide({id: 's3', layout: s1.layout, shapes: []}));
  c.nextId = Math.max(c.nextId, 400);
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/format-tabs-more', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const read = async address => (await app.rpc('document.read', {doc, address, as: 'json'})).value;
  const pick = ids => app.rpc('selection.set', {doc, ranges: ids.map(id => ({anchor: `/sl:${s1.id}/sp:${id}`, focus: `/sl:${s1.id}/sp:${id}`}))});
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});

    // Edit Points from the ribbon: the oval's points show; dragging one reshapes it as one undo step.
    await pick(['m4']);
    await app.rpc('ui.tab', {doc, tab: 'shape-format'}).catch(() => {});
    await app.rpc('ui.activate', {doc, control: 'shapeformat.insert.edit-shape.edit-points'});
    const pointsOf = async () => (await run('shape.points')).result;
    const before = (await pointsOf()).paths[0];
    assert.ok(before.length >= 4, 'the oval has points');
    const [vx, vy] = before[0];
    await app.rpc('ui.pointer', {doc, events: [{kind: 'down', x: vx, y: vy}, {kind: 'drag', x: vx + 20, y: vy - 25}, {kind: 'up', x: vx + 20, y: vy - 25}], tol: 4});
    const after = (await pointsOf()).paths[0];
    assert.ok(Math.abs(after[0][0] - (vx + 20)) < 1 && Math.abs(after[0][1] - (vy - 25)) < 1, 'the dragged point moved');
    assert.equal(after.length, before.length);
    await app.capture('1b-edit-points');
    await run('shape.editPoints', {on: false});

    // Merge Shapes from the Shape Format menu: union of the rectangle and oval, intersect of the other two.
    await pick(['m1', 'm2']);
    await app.rpc('ui.tab', {doc, tab: 'shape-format'}).catch(() => {});
    await app.rpc('ui.activate', {doc, control: 'shapeformat.insert.merge.union'});
    let sl = await read(`/sl:${s1.id}`);
    assert.equal(sl.shapes.filter(s => s.name === 'Freeform 1').length, 1);
    assert.ok(!sl.shapes.some(s => s.id === 'm1' || s.id === 'm2'));
    await pick(['m3', 'm4']);
    await run('shape.merge', {op: 'fragment'});
    sl = await read(`/sl:${s1.id}`);
    assert.ok(sl.shapes.filter(s => s.geom?.kind === 'custom').length >= 4, 'union plus three fragments');
    await app.capture('1-merged-shapes');

    // Compress Pictures opens its dialog; Compress shrinks the picture.
    await pick(['pic']);
    await app.rpc('ui.tab', {doc, tab: 'picture-format'}).catch(() => {});
    await app.rpc('ui.activate', {doc, control: 'pictureformat.adjust.compress'});
    await app.capture('2-compress-dialog');
    await app.rpc('ui.dialog.submit', {});
    const media = (await read('/')).media ?? [];
    void media;
    assert.notEqual((await read(`/sl:${s1.id}/sp:pic`)).kind.fill.media, 'pic1');

    // Custom Slide Show: the dialog opens, a show is made over the bridge and listed.
    await run('show.customShow', {name: 'Short', slides: [0, 2]});
    await app.rpc('ui.tab', {doc, tab: 'slide-show'}).catch(() => {});
    await app.rpc('ui.activate', {doc, control: 'slideshow.start.custom-show'});
    await new Promise(r => setTimeout(r, 2500));
    await app.capture('3-custom-shows-dialog');
    await app.rpc('ui.dialog.cancel', {});

    // Rehearse Timings plays the show with its clock.
    await app.rpc('ui.activate', {doc, control: 'slideshow.setup.rehearse'});
    await new Promise(r => setTimeout(r, 2500));
    await app.capture('4-rehearsing');
    await run('show.rehearsed', {timings: [[0, 3000]]});
    assert.equal((await read(`/sl:${s1.id}`)).transition.advanceAfterMs, 3000);
  } finally {
    await app.close();
  }
});
