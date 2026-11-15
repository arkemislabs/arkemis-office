// U:grid/draw bridge E2E: the Draw tab's pens, the eraser, the lasso, Ink to Shape and Ink Replay driven as a person
// does it (the ribbon's controls, then the worksheet's own pointer handlers through ui.pointer target draw), with the
// strokes read back from the sheet and the tab's captures looked at.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/ui-egui/src/grid/interact.rs (`handle_draw_tool`: a pen drag draws, the eraser deletes
//    the ink it touches) and crates/engine/src/cmd/draw.rs. Excel: the pen draws on the sheet, Ink to Shape turns a
//    stroke into a shape, Lasso Select picks ink inside a loop.
// 2. Ours: ribbon controls and pointer handlers of the surface (never the OS mouse); the sheet read back with object.list.
// 3. This flow; captures in artifacts/e2e/grid/draw-objects/*.png were looked at by the author.

import test from 'node:test';
import {startData, assert} from './data-kit.mjs';

test('grid draw: pens, eraser, lasso, ink to shape and replay from the Draw tab', {timeout: 400_000}, async () => {
  const t = await startData('grid/draw-objects', {tab: 'draw'});
  const {app, doc, press, pointer, undo, exec, settle} = t;
  const objects = async () => (await exec('object.list')).result;
  const strokes = async () => (await objects()).filter(o => o.shape === 'ink');
  const wave = (x0, y0, n = 14) => Array.from({length: n}, (_, i) => [x0 + i * 9, y0 + 18 * Math.sin(i / 2)]);
  const control = async id => (await app.rpc('ui.inspect', {doc})).controls?.find(c => c.id === id);
  try {
    // The blue pen: pressed, and a drag through the sheet leaves a stroke where the pointer went.
    await press('draw.tools.penBlue');
    assert.equal((await control('draw.tools.penBlue'))?.checked, true, 'the blue pen shows pressed');
    await pointer({target: 'draw', points: wave(300, 120)});
    await settle(200);
    let list = await strokes();
    assert.equal(list.length, 1, 'the drag drew one stroke');
    assert.equal(list[0].anchor.mode, 'absolute');
    await app.capture('01-blue-stroke');

    // The red pen replaces the blue one (it does not switch drawing off); the highlighter is wide.
    await press('draw.tools.penRed');
    assert.equal((await control('draw.tools.penBlue'))?.checked, false);
    assert.equal((await control('draw.tools.penRed'))?.checked, true);
    await pointer({target: 'draw', points: wave(300, 200)});
    await press('draw.tools.penHighlighter');
    await pointer({target: 'draw', points: [[300, 260], [420, 262], [540, 258]]});
    await settle(200);
    assert.equal((await strokes()).length, 3);
    await app.capture('02-three-pens');

    // Undo takes the last stroke away, as one step.
    await undo();
    assert.equal((await strokes()).length, 2, 'undo removes the highlighter stroke');
    // the highlighter is still the pen in use: drawing again leaves the stroke back
    await pointer({target: 'draw', points: [[300, 260], [420, 262], [540, 258]]});
    assert.equal((await strokes()).length, 3);

    // The eraser takes the stroke it crosses.
    await press('draw.tools.eraser');
    assert.equal((await control('draw.tools.eraser'))?.checked, true);
    const second = (await strokes())[1];
    await pointer({target: 'draw', points: Array.from({length: 13}, (_, i) => [360, 170 + i * 4])});
    await settle(200);
    const left = await strokes();
    assert.equal(left.length, 2, 'the eraser took one stroke');
    assert.ok(!left.some(o => o.id === second.id), 'the stroke it crossed is gone');
    await app.capture('03-erased');

    // Lasso: a loop round the upper stroke selects it; Delete (the surface's key) removes what it holds.
    await press('draw.tools.lasso');
    const before = (await strokes()).length;
    const held = await pointer({target: 'draw', points: [[280, 90], [460, 90], [460, 160], [280, 160], [282, 92]]});
    assert.equal(held.lasso.length, 1, 'the loop holds one stroke');
    await settle(200);
    await app.capture('04-lasso-selected');
    await app.rpc('ui.key', {doc, keys: 'Delete'});
    await settle(200);
    assert.equal((await strokes()).length, before - 1, 'Delete removed the selected stroke');
    await undo();
    assert.equal((await strokes()).length, before);

    // Ink to Shape: a rough rectangle becomes a rectangle shape.
    await press('draw.tools.penBlack');
    await pointer({target: 'draw', points: [[600, 100], [720, 98], [722, 170], [602, 172], [601, 102]]});
    const rough = (await strokes()).at(-1);
    await exec('object.select', {kind: 'shape', id: rough.id});
    await press('draw.convert.inkToShape');
    const shapes = (await objects()).filter(o => o.kind === 'shape');
    assert.equal(shapes.find(o => o.id === rough.id).shape, 'rectangle', 'a closed four-cornered stroke becomes a rectangle');
    await app.capture('05-ink-to-shape');

    // Ink Replay starts with the strokes hidden and plays them in the order they were drawn.
    await press('draw.replay.inkReplay');
    await settle(900);
    await app.capture('06-replay');
    await app.until(async () => { const r = await exec('draw.inkReplay', {step: 99}); return r.result.replaying === false ? true : null; }, {timeout: 15_000});

    // The pens and Add Pen: drawn icons, and the menu.
    await app.rpc('ui.tab', {doc, id: 'draw'});
    await settle(150);
    await app.rpc('ui.menu', {doc, control: 'draw.tools.addPen'});
    await settle(300);
    await app.capture('07-add-pen-menu');
    await app.rpc('ui.menu', {doc, control: 'draw.tools.addPen', open: false});
    await press('draw.tools.select');
    assert.equal((await control('draw.tools.select'))?.checked, true, 'Select Objects shows pressed with no tool');
    await app.capture('08-draw-tab');
  } finally {
    await t.app.close();
  }
});
