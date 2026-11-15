// U:quill/shapes, Arrange: picking several objects (Shift+click), Group and Ungroup, the Selection Pane, Align (to margin, page,
// objects) and Distribute, Move with Text, Flip on the page, crop handles, Picture Effects (reflection, bevel), Shape Styles.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/objects/{group,select,arrange,specs}.rs, ui-egui/src/crop.rs; deckcraft
//    cmd/shape/appearance.rs (`quick_style_for`) and effects for reflection and bevel. Word: Shift+click adds to the selected
//    objects, Group makes them one object, Align and Distribute use the picked objects, Crop shows black handles.
// 2. Ours: several selected objects are several ranges of the selection; a group draws its members and is saved as its members.
// 3. Proof: this file and tests/e2e/quill/shapes.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from './format-fixture.mjs';
import {base64Encode} from '../../core/quill/lib/insert-objects.mjs';
import {encodePngJs} from '../../core/quill/lib/picture-host.mjs';
import * as X from '../../core/quill/lib/picture-pixels.mjs';
import * as P from '../../core/quill/model/para.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {pageDisplay} from '../../core/quill/layout/display.mjs';
import {dragCrop} from '../../src/apps/quill/surface/crop-math.mjs';

async function withPicture(w = 40, h = 20) {
  const q = await quill('Before the picture.\nAfter it.');
  q.sel(0, 6);
  await q.exec('insert.picture', {data: base64Encode(await encodePngJs(X.bitmap(w, h, [200, 30, 30, 255]))), width: w});
  return q;
}
async function withShape(kind = 'rectangle') {
  const q = await quill('Before the shape.\nAfter it.');
  q.sel(0, 6);
  await q.exec('insert.shape', {kind, width: 100, height: 50});
  return q;
}
const object = (q, type = 'image') => blocks(q.t).flatMap(b => b.objects ?? []).find(o => o.type === type) ?? null;
const shapesOf = q => blocks(q.t).flatMap(b => (b.objects ?? []).filter(o => o.type === 'shape'));
const selectIndex = (q, i) => q.exec('select.objects', {index: i});
const items = (q, type) => pageDisplay(layout(q.t.content, {view: 'print'}).pages[0], {}).filter(i => i.type === type);

/** Three floating rectangles on one paragraph. */
async function threeShapes() {
  const q = await quill('Anchor paragraph for the shapes.\nSecond.');
  for (const [i, x] of [[0, 40], [1, 200], [2, 380]]) {
    q.sel(0, 0);
    await q.exec('insert.shape', {kind: 'rectangle', width: 60 + i * 10, height: 40});
    await q.exec('arrange.position', {preset: 'topLeft', x, y: 60 + i * 30});
  }
  return q;
}

test('select.addObject picks several objects; the Selection Pane lists them; object.hide hides one', async () => {
  const q = await threeShapes();
  assert.equal(shapesOf(q).length, 3);
  await selectIndex(q, 0);
  assert.equal((await q.exec('select.addObject', {index: 1})).result.selected.length, 2);
  await q.exec('select.addObject', {index: 2});
  let list = (await q.state('arrange.objects', {})).value;
  assert.equal(list.length, 3);
  assert.deepEqual(list.map(o => o.selected), [true, true, true]);
  await q.exec('select.addObject', {index: 1});
  list = (await q.state('arrange.objects', {})).value;
  assert.deepEqual(list.map(o => o.selected), [true, false, true], 'one that is picked is taken out again');
  await q.exec('object.hide', {index: 1});
  assert.equal((await q.state('arrange.objects', {})).value[1].hidden, true);
  await q.exec('object.hide', {index: 1});
  assert.equal((await q.state('arrange.objects', {})).value[1].hidden, false);
  assert.equal((await q.exec('arrange.selectionPane', {value: true})).result.objects.length, 3);
});

test('Shape Fill applies to every picked shape', async () => {
  const q = await threeShapes();
  await selectIndex(q, 0);
  await q.exec('select.addObject', {index: 2});
  await q.exec('shape.fill', {color: '00B050'});
  const fills = shapesOf(q).map(o => [...o.fill].join(','));
  assert.equal(fills[0], '0,176,80');
  assert.equal(fills[2], '0,176,80');
  assert.notEqual(fills[1], '0,176,80', 'the shape that was not picked keeps its colour');
});

test('arrange.group makes one group of the picked objects, drawn with its members; arrange.ungroup gives them back, still picked', async () => {
  const q = await threeShapes();
  await selectIndex(q, 0);
  await q.exec('select.addObject', {index: 1});
  assert.equal((await q.state('arrange.group', {})).enabled, true);
  const res = await q.exec('arrange.group', {});
  const objs = blocks(q.t).flatMap(b => b.objects ?? []).filter(o => P.isDrawing(o));
  assert.equal(objs.length, 2, 'the group and the shape left out');
  const g = objs.find(o => o.type === 'group');
  assert.equal(g.children.length, 2);
  assert.ok(g.w > 200 && g.h > 40, `the group is the box round both (${g.w} × ${g.h})`);
  assert.deepEqual([Math.min(...g.children.map(c => c.x)), Math.min(...g.children.map(c => c.y))], [0, 0], 'members are placed from the box\'s corner');
  assert.equal(g.canvas, undefined);
  assert.equal(res.result.object.type, 'group');
  assert.ok(items(q, 'shape').length >= 3, 'the members and the other shape are drawn');
  await q.exec('arrange.ungroup', {});
  const back = shapesOf(q);
  assert.equal(back.length, 3);
  assert.equal((await q.state('arrange.group', {})).enabled, true, 'the members stay picked, so Group puts them back');
  const out = back.filter(o => o.float.hRel === 'page');
  assert.equal(out.length, 2, 'the two that were grouped are placed on the page');
  assert.deepEqual(out.map(o => Math.round(o.float.x)).sort((a, b) => a - b), [272, 452], 'the 72 pt margin and the offsets they had');
  await assert.rejects(q.exec('arrange.ungroup', {}), /select a group/);
});

test('Group needs two objects, floating ones', async () => {
  const q = await withShape();
  assert.equal((await q.state('arrange.group', {})).enabled, false);
  await assert.rejects(q.exec('arrange.group', {}), /two or more/);
});

test('a group saves to .docx as its members', async () => {
  const q = await threeShapes();
  await selectIndex(q, 0);
  await q.exec('select.addObject', {index: 1});
  await q.exec('arrange.group', {});
  const back = await readDocx(await writeDocx(q.t.content));
  assert.equal(back.body.chunks.flat().flatMap(b => b.objects ?? []).filter(o => o?.type === 'shape').length, 3, 'nothing is lost');
});

test('arrange.align to objects, page and margin; arrange.distribute; Align To mode', async () => {
  const q = await threeShapes();
  await selectIndex(q, 0);
  await q.exec('select.addObject', {index: 1});
  await q.exec('select.addObject', {index: 2});
  await q.exec('arrange.align', {value: 'top', to: 'objects'});
  const tops = shapesOf(q).map(o => Math.round(o.float.y));
  assert.equal(new Set(tops).size, 1, 'all three at the top of the highest');
  assert.equal(tops[0], 132, 'the highest was 60 pt under the 72 pt margin');
  await q.exec('arrange.distribute', {axis: 'horizontal'});
  const xs = shapesOf(q).map(o => ({x: o.float.x, w: o.w})).sort((a, b) => a.x - b.x);
  const g1 = xs[1].x - (xs[0].x + xs[0].w), g2 = xs[2].x - (xs[1].x + xs[1].w);
  assert.ok(Math.abs(g1 - g2) < 0.01, `equal gaps ${g1} ${g2}`);
  await selectIndex(q, 0);
  await q.exec('arrange.align', {value: 'center', to: 'page'});
  const s = shapesOf(q)[0];
  assert.equal(s.float.hRel, 'page');
  assert.ok(Math.abs(s.float.x - (612 - s.w) / 2) < 0.01);
  await q.exec('arrange.alignTo', {to: 'page'});
  assert.equal((await q.state('arrange.alignTo', {to: 'page'})).checked, true);
  await q.exec('arrange.align', {value: 'left'});
  assert.equal(shapesOf(q)[0].float.x, 0, 'the mode applies to the next Align');
  assert.equal(shapesOf(q)[0].float.hRel, 'page');
  await selectIndex(q, 1);
  await assert.rejects(q.exec('arrange.distribute', {axis: 'vertical'}), /pictures or shapes first/);
});

test('arrange.moveWithText anchors to the paragraph or the page and keeps the object where it is', async () => {
  const q = await threeShapes();
  await selectIndex(q, 0);
  assert.equal((await q.state('arrange.moveWithText', {value: true})).checked, false, 'positioned on the margin: fixed on the page');
  await q.exec('arrange.moveWithText', {value: true});
  assert.equal(shapesOf(q)[0].float.vRel, 'paragraph');
  const y = items(q, 'shape').map(i => i.rect.y).sort((a, b) => a - b)[0];
  assert.ok(Math.abs(y - 132) < 1, `it stays at its place on the page (${y})`);
  await q.exec('arrange.moveWithText', {value: false});
  assert.equal(shapesOf(q)[0].float.vRel, 'page');
});

test('flips are drawn: a flipped picture carries its flip to the draw items', async () => {
  const q = await withPicture();
  await q.exec('arrange.rotate', {direction: 'flipHorizontal'});
  assert.equal(items(q, 'image')[0].flipH, true);
  await q.exec('arrange.rotate', {direction: 'flipVertical'});
  assert.deepEqual([items(q, 'image')[0].flipH, items(q, 'image')[0].flipV], [true, true]);
});

test('crop handles: dragging a side trims it and shrinks the frame at the same picture scale', () => {
  const w = dragCrop('w', 20, 0, 100, 60, [0, 0, 0, 0]);
  assert.deepEqual(w.crop, [0.2, 0, 0, 0]);
  assert.deepEqual([w.width, w.height], [80, 60]);
  const e = dragCrop('e', -50, 0, 100, 60, [0, 0, 0, 0]);
  assert.deepEqual([e.crop[2], e.width], [0.5, 50]);
  const nw = dragCrop('nw', 10, 6, 100, 60, [0, 0, 0, 0]);
  assert.deepEqual([nw.crop[0], nw.crop[1], nw.width, nw.height], [0.1, 0.1, 90, 54]);
  const back = dragCrop('w', -30, 0, 80, 60, [0.2, 0, 0, 0]);
  assert.deepEqual([back.crop[0], back.width], [0, 100], 'dragging out restores what was cropped, and no further');
  const far = dragCrop('w', 500, 0, 100, 60, [0, 0, 0, 0.1]);
  assert.ok(far.crop[0] <= 0.95 && far.width >= 5, 'at least 5% stays');
});

test('view.cropMode is a view flag that needs a picture', async () => {
  const q = await withPicture();
  await q.exec('view.cropMode', {});
  assert.equal((await q.state('view.cropMode', {})).checked, true);
  await q.exec('view.cropMode', {value: false});
  const none = await quill('Plain');
  none.sel(0, 0);
  assert.equal((await none.state('view.cropMode', {})).enabled, false);
});

test('Picture Effects and Shape Effects: reflection and bevel on pictures and shapes, saved in .docx', async () => {
  const q = await withPicture(40, 20);
  await q.exec('shape.effects', {reflection: 'half', bevel: 'circle', shadow: 'offsetBottomRight'});
  const o = object(q);
  assert.deepEqual([o.effects.reflection.endPos, o.effects.reflection.dist], [0.55, 4]);
  assert.deepEqual([o.effects.bevel.preset, o.effects.bevel.w], ['circle', 6]);
  assert.ok(o.float.effect[3] >= 4 + 0.55 * o.h - 0.01, 'room under the picture for its reflection');
  const img0 = items(q, 'image')[0];
  assert.ok(img0.effects.reflection && img0.effects.bevel, 'the picture draws with its effects');
  const img = (await readDocx(await writeDocx(q.t.content))).body.chunks.flat().flatMap(b => b.objects ?? []).find(x => x?.type === 'image');
  assert.equal(img.effects.reflection.endPos, 0.55);
  assert.equal(img.effects.bevel.preset, 'circle');
  assert.equal(img.effects.shadow.angle, 45);
  await q.exec('shape.effects', {reflection: null, bevel: null, shadow: null});
  assert.equal(object(q).effects, undefined);
  await assert.rejects(q.exec('shape.effects', {bevel: 'bogus'}), /unknown bevel/);
  await assert.rejects(q.exec('shape.effects', {reflection: 'huge'}), /unknown reflection/);
  const s = await withShape('ellipse');
  await s.exec('shape.effects', {reflection: 'tight', bevel: 'angle'});
  const read = (await readDocx(await writeDocx(s.t.content))).body.chunks.flat().flatMap(b => b.objects ?? []).find(x => x?.type === 'shape');
  assert.deepEqual([read.effects.reflection.endPos, read.effects.bevel.preset], [0.35, 'angle']);
});

test('shape.quickStyle: 42 Shape Styles in the theme colours', async () => {
  const q = await withShape();
  const st = await q.state('shape.quickStyle', {});
  assert.equal(st.value.length, 42);
  assert.ok(st.value.every(v => v.art.kind === 'shapeStyle'));
  await q.exec('shape.quickStyle', {index: 1 * 7 + 1});
  assert.deepEqual([...shapesOf(q)[0].fill], [0x15, 0x60, 0x82], 'Colored Fill - Accent 1: the theme accent');
  assert.ok(shapesOf(q)[0].stroke);
  await q.exec('shape.quickStyle', {index: 4 * 7 + 2});
  assert.ok(shapesOf(q)[0].effects.shadow, 'Moderate Effect has a shadow');
  assert.equal(shapesOf(q)[0].stroke, null);
  await q.exec('shape.quickStyle', {index: 0});
  assert.deepEqual([...shapesOf(q)[0].fill], [255, 255, 255], 'Colored Outline: a white fill');
});

test('Tight wrapping follows the shape outline: the text beside a triangle reaches closer to its tip than to its base', async () => {
  const long = 'word '.repeat(1500).trim();
  const q = await quill(long);
  q.sel(0, 0);
  await q.exec('insert.shape', {kind: 'triangle', width: 200, height: 200});
  await q.exec('arrange.position', {preset: 'middleCenter'});
  // The right-hand piece of every line: the text items that start right of the shape's middle, by line.
  const texts = () => items(q, 'text').filter(i => i.text.trim());
  const shape = () => items(q, 'shape')[0].rect;
  const gaps = rows => rows.map(r => r.gap);
  const measure = () => {
    const sh = shape();
    const rows = new Map();
    for (const i of texts()) {
      if (i.y < sh.y || i.y > sh.y + sh.h) continue;
      const k = Math.round(i.y);
      const row = rows.get(k) ?? {left: -Infinity, right: Infinity};
      if (i.x < sh.x + sh.w / 2) row.left = Math.max(row.left, i.x + 1); else row.right = Math.min(row.right, i.x);
      rows.set(k, row);
    }
    return [...rows.entries()].sort((x, y) => x[0] - y[0]).map(([y, r]) => ({y: y - sh.y, right: r.right}));
  };
  await q.exec('arrange.wrap', {wrap: 'square'});
  const square = measure();
  await q.exec('arrange.wrap', {wrap: 'tight'});
  const tight = measure();
  void gaps;
  assert.ok(square.length && tight.length);
  const sh = shape();
  const at = (rows, frac) => rows.find(r => r.y >= sh.h * frac)?.right;
  // Square: the same gap all the way down. Tight: text on the right starts closer in at the tip (top) than at the base (bottom).
  assert.ok(Number.isFinite(at(tight, 0.1)) && Number.isFinite(at(tight, 0.85)));
  assert.ok(at(tight, 0.1) < at(tight, 0.85) - 20, 'text follows the slanted side: near the tip it starts further left than near the base');
  assert.ok(Math.abs(at(square, 0.1) - at(square, 0.85)) < 1, 'square wrap keeps one edge');
});

test('Tight and Through are real wrap choices now', async () => {
  const q = await withShape('ellipse');
  await q.exec('arrange.wrap', {wrap: 'tight'});
  assert.equal(shapesOf(q)[0].float.wrap, 'tight');
  assert.equal((await q.state('arrange.wrap', {wrap: 'tight'})).checked, true);
  await q.exec('arrange.wrap', {wrap: 'through'});
  assert.equal(shapesOf(q)[0].float.wrap, 'through');
});

import {openDialogModel, submitDialog, changeDialogValues} from '../../core/kernel/dialog.mjs';
const dialogs = (await import('../../core/generated/quill.dialogs.mjs')).dialogs;

test('arrange.layout: wrapping, distances and position in one step; the position waits while the object is in line', async () => {
  const q = await withShape();
  await q.exec('arrange.layout', {wrap: 'square', wrapText: 'left', dist: 12, distTop: 3, distBottom: 4, hRel: 'page', hAlign: 'center', vRel: 'page', y: 100});
  const f = shapesOf(q)[0].float;
  assert.deepEqual([f.wrap, f.wrapText, f.dist, f.distTop, f.distBottom, f.hRel, f.hAlign, f.vRel, f.y, f.vAlign], ['square', 'left', 12, 3, 4, 'page', 'center', 'page', 100, undefined]);
  await q.exec('arrange.layout', {hAlign: 'start', vAlign: 'end'});
  assert.deepEqual([shapesOf(q)[0].float.hAlign, shapesOf(q)[0].float.vAlign], ['start', 'end']);
  await q.exec('arrange.layout', {x: 50});
  assert.deepEqual([shapesOf(q)[0].float.x, shapesOf(q)[0].float.hAlign], [50, undefined]);
  await q.exec('arrange.layout', {wrap: 'inline', x: 999});
  assert.equal(shapesOf(q)[0].float.x, 50, 'in line with text, the position is left alone');
  await assert.rejects(q.exec('arrange.layout', {hRel: 'sideways'}), /one of/);
});

test('dialog.pictureSize is the Layout dialog: Position, Text Wrapping and Size tabs, one undo step', async () => {
  const q = await withShape();
  const model = dialogs['dialog.pictureSize'];
  let v = openDialogModel(q.t.session, q.t.docId, model);
  assert.deepEqual([v.wrap, v.hMode, v.vMode, v.width, v.height], ['inline', 'absolute', 'absolute', 100, 50]);
  v = changeDialogValues(model, v, 'wrap', 'square');
  assert.equal(v.dist, 9, 'a newly wrapped object gets Word\'s 9 pt from the text');
  v = {...v, hMode: 'alignment', hAlign: 'right', hAlignRel: 'page', vMode: 'absolute', vPos: 120, vPosRel: 'page', wrapText: 'right', distTop: 5, distBottom: 6, dist: 7, width: 80, lock: false, rotation: 30};
  await submitDialog(q.t.session, q.t.docId, model, v);
  const o = shapesOf(q)[0];
  assert.deepEqual([o.float.wrap, o.float.hAlign, o.float.hRel, o.float.vRel, o.float.y, o.float.wrapText, o.float.distTop, o.float.distBottom, o.float.dist, o.w, o.h, o.float.rot],
    ['square', 'end', 'page', 'page', 120, 'right', 5, 6, 7, 80, 50, 30]);
  await q.exec('edit.undo', {});
  assert.deepEqual([shapesOf(q)[0].float.wrap, shapesOf(q)[0].w], ['inline', 100], 'the whole dialog is one undo step');
  assert.ok(model.validate({...v, distTop: -1}).length && model.validate({...v, vPos: NaN}).length);
  // reopened on a wrapped object it reads the position back
  await submitDialog(q.t.session, q.t.docId, model, v);
  const again = openDialogModel(q.t.session, q.t.docId, model);
  assert.deepEqual([again.hMode, again.hAlign, again.hAlignRel, again.vMode, again.vPos, again.wrap, again.wrapText], ['alignment', 'right', 'page', 'absolute', 120, 'square', 'right']);
});
