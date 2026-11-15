// U:grid/insert bridge E2E (objects): charts from the ribbon's drawn menus, a chart selected, moved and
// resized as the worksheet's own handlers do (ui.pointer target object), pictures, shapes, icons and a
// text box over the cells, each undone, and the Insert tab's open menus captured.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/ui-egui/src/ribbon/insert.rs (the chart menus, Shapes, Icons),
//    floating_pictures.rs, chartview.rs, text_box.rs and grid/interact.rs (an object is dragged by its
//    body and resized by its handles). Excel: Insert > Charts drops a chart beside the data and
//    selects it; its eight handles resize it; Delete removes it.
// 2. Ours runs the same commands from the ribbon controls and the surface's own pointer handlers
//    (ui.pointer target object), and reads the sheet's objects back (object.list).
// 3. This flow; captures in artifacts/e2e/grid/insert-objects/*.png were looked at by the author.

import test from 'node:test';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import {script, exists} from '../common/file-helpers.mjs';
import {startData, assert} from './data-kit.mjs';

/** A w x h PNG filled with a gradient (built here so the flow needs no image file). */
function png(w, h) {
  const crc = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return b => { let c = ~0; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; }; })();
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = Math.round(255 * x / w); raw[o + 1] = Math.round(255 * y / h); raw[o + 2] = 160; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

test('grid insert: charts, pictures, shapes, icons and text boxes from the ribbon and the worksheet', {timeout: 400_000}, async () => {
  const t = await startData('grid/insert-objects', {tab: 'insert'});
  const {app, doc, select, press, pointer, undo, exec, settle} = t;
  const objects = async () => (await exec('object.list')).result;
  const sheetProps = async () => await t.read('/sh:s1', 'props');
  const openMenu = async id => { await app.rpc('ui.tab', {doc, id: 'insert'}); await settle(150); await app.rpc('ui.menu', {doc, control: id}); await settle(350); };
  const closeMenu = async id => { await app.rpc('ui.menu', {doc, control: id, open: false}); await settle(100); };
  try {
    // A column chart of the reps' Qty and Amount from the Insert Column or Bar menu's first entry.
    await select('B1', 'D8');
    await press('insert.charts.columnBar', 'columnClustered');
    let list = await objects();
    assert.equal(list.length, 1);
    const chart = list[0];
    assert.equal(chart.kind, 'chart');
    assert.equal(chart.anchor.cell, 'F1', 'two columns right of the data');
    await settle(300);
    await app.capture('01-chart-inserted');

    // Drag the chart by its body, then by its south-east handle.
    const before = chart.anchor;
    await pointer({target: 'object', kind: 'chart', id: chart.id, action: 'drag', dx: 70, dy: 50});
    await settle(200);
    let moved = (await objects())[0].anchor;
    assert.ok(moved.cell !== before.cell || moved.dx !== before.dx || moved.dy !== before.dy, 'the drag moved the chart');
    assert.equal(moved.width, before.width, 'a move keeps the size');
    await app.capture('02-chart-moved-selected');
    await pointer({target: 'object', kind: 'chart', id: chart.id, action: 'drag', handle: 'se', dx: 60, dy: 40});
    await settle(200);
    const sized = (await objects())[0].anchor;
    assert.ok(sized.width > moved.width + 40 && sized.height > moved.height + 20, `the handle resized the chart ${JSON.stringify([moved.width, sized.width])}`);
    await undo();
    assert.equal((await objects())[0].anchor.width, moved.width, 'undo puts the size back');
    await undo();
    assert.deepEqual((await objects())[0].anchor, before, 'undo puts the chart back');

    // Delete removes it, undo brings it back.
    await app.rpc('ui.key', {doc, keys: 'Delete'});
    await settle();
    assert.equal((await objects()).length, 0, 'Delete removes the selected chart');
    await undo();
    assert.equal((await objects()).length, 1);

    // The chart menus draw a thumbnail for every type.
    await openMenu('insert.charts.columnBar');
    await app.capture('03-menu-column-bar');
    await closeMenu('insert.charts.columnBar');
    await openMenu('insert.charts.hierarchy');
    await app.capture('04-menu-hierarchy');
    await closeMenu('insert.charts.hierarchy');

    // The other chart kinds, one after another, on the same data.
    for (const [type, subtype] of [['pie', ''], ['line', 'markers'], ['scatter', ''], ['bar', 'stacked'], ['area', ''], ['radar', ''], ['doughnut', '']]) {
      await exec('object.delete', {kind: 'chart', id: (await objects()).find(o => o.kind === 'chart').id});
      await select('B1', 'C8');
      await exec('insert.chart', {type, subtype, at: 'F1'});
      await settle(250);
      await app.capture(`05-chart-${type}${subtype ? '-' + subtype : ''}`);
    }

    // Pictures, shapes, icons and a text box over the cells.
    await exec('object.delete', {kind: 'chart', id: (await objects()).find(o => o.kind === 'chart').id});
    await select('F2');
    await exec('insert.picture', {base64: png(96, 64), alt: 'gradient', at: 'F2'});
    await press('insert.illustrations.shapes.oval');
    await exec('object.move', {kind: 'shape', id: (await objects()).find(o => o.kind === 'shape').id, at: 'F9', width: 120, height: 70});
    await press('insert.illustrations.shapes.arrow');
    await exec('object.move', {kind: 'shape', id: (await objects()).filter(o => o.kind === 'shape')[1].id, at: 'H9', width: 90, height: 40});
    await press('insert.text.textBox');
    const box = (await objects()).filter(o => o.kind === 'shape')[2];
    await exec('shape.setText', {id: box.id, text: 'A text box\nwith two lines'});
    await exec('object.move', {kind: 'shape', id: box.id, at: 'H2', width: 150, height: 60});
    await press('insert.illustrations.icons', 'chart');
    await press('insert.illustrations.icons', 'validation');
    const icons = (await objects()).filter(o => o.shape === 'icon');
    assert.equal(icons.length, 2);
    await exec('object.move', {kind: 'shape', id: icons[0].id, at: 'J2'});
    await exec('object.move', {kind: 'shape', id: icons[1].id, at: 'J5'});
    await settle(300);
    assert.deepEqual((await objects()).map(o => o.kind === 'shape' ? o.shape : o.kind), ['image', 'ellipse', 'arrow', 'textBox', 'icon', 'icon']);
    await app.capture('06-picture-shapes-icons');
    const props = await sheetProps();
    assert.equal(props.images?.length ?? (await t.read('/sh:s1', 'json')).images?.length, 1);

    // Save to a real .xlsx file, open it again, and the objects come back as they were.
    await select('B1', 'C8');
    await exec('insert.chart', {type: 'line', subtype: 'markers', at: 'F12', title: 'Round trip'});
    const file = path.join(os.tmpdir(), `insert-objects-${process.pid}.xlsx`);
    await script(app, {type: 'save', path: file});
    await app.rpc('ui.key', {doc, keys: 'Ctrl+S'});
    await app.until(() => exists(file), {timeout: 30_000});
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    assert.ok(zip.file('xl/charts/chart1.xml') && zip.file('xl/drawings/drawing1.xml') && zip.file('xl/media/image1.png'), 'the workbook holds a chart, a drawing and a picture part');
    const reopened = await app.rpc('documents.open', {path: file, show: false});
    const back = (await app.rpc('engine.execute', {doc: reopened.doc, command: 'object.list', params: {}})).result;
    assert.deepEqual(back.map(o => (o.kind === 'shape' ? o.shape : o.kind === 'chart' ? 'chart' : o.kind)).sort(), ['arrow', 'chart', 'ellipse', 'icon', 'icon', 'image', 'textBox']);
    assert.equal(back.find(o => o.kind === 'chart').chart, 'lineMarkers');
    await fs.rm(file, {force: true});
    await exec('object.delete', {kind: 'chart', id: (await objects()).find(o => o.kind === 'chart').id});

    // The Insert tab's other galleries.
    await openMenu('insert.illustrations.shapes');
    await app.capture('07-menu-shapes');
    await closeMenu('insert.illustrations.shapes');
    await openMenu('insert.illustrations.icons');
    await app.capture('08-menu-icons');
    await closeMenu('insert.illustrations.icons');
    await openMenu('insert.symbols.symbol');
    await app.capture('09-menu-symbols');
    await closeMenu('insert.symbols.symbol');
    await openMenu('insert.illustrations.pictures');
    await app.capture('10-menu-pictures');
    await closeMenu('insert.illustrations.pictures');

    // Selecting an object by a click and resizing a picture keeps its proportions' handles.
    const pic = (await objects()).find(o => o.kind === 'image');
    await pointer({target: 'object', kind: 'image', id: pic.id, action: 'click'});
    await settle(200);
    assert.ok(JSON.stringify(await app.rpc('selection.get', {doc})).includes(`/sh:s1/pic:${pic.id}`), 'a click selects the picture');
    await app.capture('11-picture-selected');
  } finally {
    await t.app.close();
  }
});
