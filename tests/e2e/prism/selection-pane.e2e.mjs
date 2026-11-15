// Prism selection through the bridge (U:prism/selection, U:prism/edit): Home › Editing › Select ›
// Select All, the Selection pane's commands (pick, Ctrl+pick, Hide All, Show All), Cut and Paste.
//
// What deckcraft does: Select All selects every object on the slide (cmd/edit.rs select_all);
// the Selection pane (panels/selpane.rs) runs selection.select for a row click (a hidden object
// picked there is shown again, one undo step), selection.hideAll / selection.showAll for its
// buttons (cmd/selection.rs); Ctrl+X / Ctrl+V cut and paste the shapes (cmd/edit.rs). PowerPoint:
// the same Select menu and Selection pane. The pane itself is U:prism/pane-selection's; this test
// drives its commands and the ribbon's Select All.
// What this proves end to end in the app: the ribbon control and the commands change the
// selection and the hidden flags the surface draws (captured), and undo restores them.
// Captures in artifacts/e2e/prism/selection-pane/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {shape, presetGeom} from '../../../core/prism/model/presentation.mjs';
import {colorRgb, fillSolid} from '../../../core/prism/model/style.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';

const box = (id, name, x, rgb) => shape({id, name, xfrm: {x, y: 380, w: 180, h: 100}, geom: presetGeom('rect'),
  fill: fillSolid(colorRgb({...rgb, a: 255})), text: bodyFromText(name)});

test('prism selection: Select All, pick a hidden object, Hide All / Show All, cut and paste, undo', {timeout: 240_000}, async () => {
  const file = createFile('prism', 'Selection deck', {schema: 2});
  file.id = 'prism-selection';
  const s1 = file.content.slides[0];
  s1.shapes[0].text = bodyFromText('Quarterly review');
  s1.shapes.push(box('a1', 'Blue box', 180, {r: 68, g: 114, b: 196}), box('a2', 'Orange box', 420, {r: 237, g: 125, b: 49}),
    box('a3', 'Green box', 660, {r: 112, g: 173, b: 71}));
  file.content.nextId = Math.max(file.content.nextId, 400);
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/selection-pane', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const slide = async () => (await app.rpc('document.read', {doc, address: `/sl:${s1.id}`, as: 'json'})).value;
  const selected = async () => (await app.rpc('selection.get', {doc})).selection.ranges.map(r => r.anchor.replace(/^.*\/sp:/, ''));
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const hidden = sl => sl.shapes.filter(x => x.hidden).map(x => x.id);
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await app.rpc('ui.tab', {doc, tab: 'home'}).catch(() => {});
    const ids = (await slide()).shapes.map(x => x.id);

    // Home › Editing › Select › Select All selects every object on the slide.
    await app.rpc('selection.set', {doc, ranges: [{anchor: `/sl:${s1.id}/sp:a1`, focus: `/sl:${s1.id}/sp:a1`}]});
    await app.rpc('ui.activate', {doc, control: 'home.editing.select.select-all'});
    assert.deepEqual((await selected()).sort(), [...ids].sort());
    await app.capture('1-select-all');

    // Hide All hides every top-level object; picking a hidden one in the pane shows and selects it.
    await run('selection.hideAll');
    assert.deepEqual(hidden(await slide()).sort(), [...ids].sort());
    await run('selection.select', {id: 'a2'});
    assert.deepEqual(await selected(), ['a2']);
    assert.ok(!hidden(await slide()).includes('a2'), 'picking a hidden object shows it');
    await app.capture('2-picked-hidden-object');
    // Ctrl+click adds to the selection (a3 was hidden too, so it is shown: another undo step).
    await run('selection.select', {id: 'a3', toggle: true});
    assert.deepEqual((await selected()).sort(), ['a2', 'a3']);
    await run('selection.showAll');
    assert.deepEqual(hidden(await slide()), []);
    await app.capture('3-show-all');

    // Ctrl+X cuts the two boxes; Ctrl+V pastes them back in place (cut shapes keep their position).
    assert.equal((await app.rpc('ui.key', {doc, keys: 'Ctrl+X'})).handled, true);
    assert.equal((await slide()).shapes.length, ids.length - 2);
    assert.equal((await app.rpc('ui.key', {doc, keys: 'Ctrl+V'})).handled, true);
    const after = await slide();
    assert.equal(after.shapes.length, ids.length);
    assert.deepEqual(after.shapes.slice(-2).map(x => x.text.paragraphs[0].runs[0].text), ['Orange box', 'Green box']);
    await app.capture('4-cut-and-pasted');

    // Undo walks back through paste, cut and Show All, then the two picks that showed a3 and a2.
    for (let i = 0; i < 3; i++) await run('edit.undo');
    const back = await slide();
    assert.deepEqual(back.shapes.map(x => x.id), ids);
    assert.deepEqual(hidden(back).sort(), ids.filter(x => x !== 'a2' && x !== 'a3').sort(), 'Hide All with a2 and a3 shown again by the picks');
    await run('edit.undo');
    assert.deepEqual(hidden(await slide()).sort(), ids.filter(x => x !== 'a2').sort());
    await run('edit.undo');
    assert.deepEqual(hidden(await slide()).sort(), [...ids].sort());
    await app.capture('5-after-undo');
  } finally {
    await app.close();
  }
});
