// Prism Table Design and Table Layout through the bridge (U:prism/table).
//
// What deckcraft does (crates/engine/src/cmd/table.rs, drawtable.rs, tools/{click,drag,hit,pointer}.rs;
// ribbon/table.rs): selecting a table shows Table Design and Layout; the style options are check
// boxes, the styles a gallery drawn in the table's own look, Shading and Borders restyle the
// selected cells, the pencil and eraser split and merge, Layout inserts and deletes rows and
// columns, merges and splits, sizes and aligns. PowerPoint: the same tabs and controls.
// What this proves end to end in the app: ui.pointer reaches a cell and a range of cells,
// ui.activate on the real controls (check boxes, gallery tiles, menu items) changes the deck as
// the engine tests do, the Split Cells and Cell Text Layout dialogs submit, the table is drawn from
// its style, and Ctrl+Z through the KeyRouter undoes. Captures in artifacts/e2e/prism/table/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {shape} from '../../../core/prism/model/presentation.mjs';
import {newTable} from '../../../core/prism/model/table.mjs';
import {bodyFromText, bodyText} from '../../../core/prism/model/text.mjs';

test('prism tables: options, styles, shading, borders, cells by pointer, rows and columns, merge, split, size, undo', {timeout: 700_000}, async () => {
  const file = createFile('prism', 'Tables deck', {schema: 2});
  file.id = 'prism-table';
  const c = file.content;
  c.slides[0].layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  const tb = newTable(4, 3, 450, 40);
  [['Region', 'Q1', 'Q2'], ['North', '12', '15'], ['South', '9', '11'], ['West', '14', '10']].forEach((row, r) => row.forEach((v, k) => { tb.rows[r].cells[k].text = bodyFromText(v); }));
  c.slides[0].shapes = [shape({id: 'tb', name: 'Table 1', xfrm: {x: 100, y: 120, w: 450, h: 160}, kind: {type: 'table', ...tb}})];
  c.nextId = 400;
  const sid = c.slides[0].id;
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/table', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const tbl = async () => (await deck()).slides[0].shapes.find(s => s.id === 'tb').kind;
  const sel = async () => (await app.rpc('selection.get', {doc})).selection;
  const pointer = events => app.rpc('ui.pointer', {doc, events});
  const click = (x, y) => pointer([{kind: 'down', x, y}, {kind: 'up', x, y}]);
  const activate = (control, value) => app.rpc('ui.activate', {doc, control, ...(value === undefined ? {} : {value})});
  // The middle of cell (r, c): the table's top-left is (100, 120), the columns are 150 wide, the rows 40.
  const mid = (r, k) => [175 + k * 150, 140 + r * 40];
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});

    // A click selects the table: Table Design and Layout appear; the table is drawn from its style.
    await click(...mid(1, 1));
    await app.until(async () => ((await app.rpc('ui.inspect', {doc})).tabs ?? []).some(t => (t.id ?? t) === 'table-design') || null, {timeout: 15_000}).catch(() => null);
    await app.rpc('ui.tab', {doc, tab: 'table-design'});
    await app.capture('1-table-design');
    // The options are check boxes: Total Row and First Column on.
    await activate('tabledesign.options.total-row');
    await activate('tabledesign.options.first-column');
    let t = await tbl();
    assert.deepEqual([t.lastRow, t.firstCol, t.firstRow, t.bandRow], [true, true, true, true]);
    await activate('tabledesign.options.banded-rows');
    assert.equal((await tbl()).bandRow, false);
    await activate('tabledesign.options.banded-rows');
    // The gallery: Dark Style 1 - Accent 3.
    await activate('tabledesign.styles.gallery', 'dark1-accent3');
    assert.equal((await tbl()).style, 'dark1-accent3');
    await app.capture('2-dark-style');
    await activate('tabledesign.styles.gallery', 'medium2-accent1');

    // A click in the table again puts the caret in a cell; a drag to another cell selects cells.
    await click(...mid(1, 1));
    let s = await sel();
    assert.match(s.ranges[0].anchor, /\/sp:tb\/r:1\/c:1\/t:\d+$/, JSON.stringify(s));
    await pointer([{kind: 'down', ...Object.fromEntries([['x', mid(1, 1)[0]], ['y', mid(1, 1)[1]]])}, {kind: 'drag', x: mid(2, 2)[0], y: mid(2, 2)[1]}, {kind: 'up', x: mid(2, 2)[0], y: mid(2, 2)[1]}]);
    s = await sel();
    assert.equal(s.ranges[0].anchor, `/sl:${sid}/sp:tb/r:1/c:1`);
    assert.equal(s.ranges[0].focus, `/sl:${sid}/sp:tb/r:2/c:2`);
    await app.capture('3-cells-selected');
    // Shading and Borders on the selected cells; the pen weight first.
    await activate('tabledesign.styles.shading', '#ffd966');
    t = await tbl();
    assert.deepEqual([t.rows[1].cells[1].fill.kind, t.rows[2].cells[2].fill.kind, t.rows[3].cells[1].fill], ['solid', 'solid', null]);
    await activate('tabledesign.draw.pen-weight.3-pt');
    await activate('tabledesign.styles.borders.outside-borders');
    t = await tbl();
    assert.equal(t.rows[1].cells[1].borders[0].width, 3);
    assert.equal(t.rows[2].cells[2].borders[1].width, 3);
    assert.equal(t.rows[1].cells[2].borders[0], null, 'inside the range there is no outer line');
    await app.capture('4-shaded-and-bordered');
    await activate('tabledesign.styles.shading.no-fill');
    assert.equal((await tbl()).rows[1].cells[1].fill.kind, 'none');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.equal((await tbl()).rows[1].cells[1].fill.kind, 'solid');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.equal((await tbl()).rows[1].cells[1].borders[0], null, 'the second undo takes the borders back');
    assert.equal((await tbl()).rows[1].cells[1].fill.kind, 'solid', 'and leaves the shading');

    // Table Layout: insert a row below, a column to the right, delete them again.
    await click(...mid(3, 0));
    await app.rpc('ui.tab', {doc, tab: 'layout'});
    await app.capture('5-table-layout');
    await activate('tablelayout.rows.insert-below');
    await activate('tablelayout.rows.insert-right');
    t = await tbl();
    assert.deepEqual([t.rows.length, t.cols.length], [5, 4]);
    assert.equal(bodyText(t.rows[3].cells[0].text), 'West');
    // The caret stayed in West: select the new cell (below, in the new column) and delete its row and column.
    await click(...mid(4, 1));
    await activate('tablelayout.rows.delete.delete-rows');
    await activate('tablelayout.rows.delete.delete-columns');
    t = await tbl();
    assert.deepEqual([t.rows.length, t.cols.length], [4, 3]);
    assert.equal(bodyText(t.rows[3].cells[0].text), 'West');
    // Select > Select Row: the three cells of the caret's row.
    await activate('tablelayout.table.select.select-row');
    s = await sel();
    assert.equal(s.ranges[0].anchor, `/sl:${sid}/sp:tb/r:3/c:0`);
    assert.equal(s.ranges[0].focus, `/sl:${sid}/sp:tb/r:3/c:2`);

    // Merge: drag across two cells of the first row, Merge Cells; Split Cells' dialog undoes it.
    await pointer([{kind: 'down', x: mid(0, 1)[0], y: mid(0, 1)[1]}, {kind: 'drag', x: mid(0, 2)[0], y: mid(0, 2)[1]}, {kind: 'up', x: mid(0, 2)[0], y: mid(0, 2)[1]}]);
    await activate('tablelayout.merge.merge');
    t = await tbl();
    assert.equal(t.rows[0].cells[1].gridSpan, 2);
    assert.equal(bodyText(t.rows[0].cells[1].text), 'Q1\nQ2');
    await app.capture('6-merged');
    await activate('tablelayout.merge.split');
    let dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.splitCells');
    assert.deepEqual([dlg.values.cols, dlg.values.rows], [2, 1], 'a merged cell starts with the columns it spans');
    await app.capture('7-split-dialog');
    await app.rpc('ui.dialog.submit', {});
    t = await tbl();
    assert.equal(t.rows[0].cells[1].gridSpan, 1);
    // Split a cell into 2 columns and 2 rows.
    await click(...mid(2, 0));
    await click(...mid(2, 0));
    await activate('tablelayout.merge.split');
    await app.rpc('ui.dialog.set', {field: 'cols', value: 2});
    await app.rpc('ui.dialog.set', {field: 'rows', value: 2});
    await app.rpc('ui.dialog.submit', {});
    t = await tbl();
    assert.deepEqual([t.rows.length, t.cols.length], [5, 4]);
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    t = await tbl();
    assert.deepEqual([t.rows.length, t.cols.length], [4, 3]);

    // Cell Size: distribute columns; Alignment: centre vertically, text direction, custom margins.
    await activate('tablelayout.size.distribute-columns');
    t = await tbl();
    assert.ok(t.cols.every(w => Math.abs(w - 150) < 1e-9));
    await click(...mid(1, 1));
    await activate('tablelayout.align.middle');
    assert.equal((await tbl()).rows[1].cells[1].anchor, 'middle');
    await activate('tablelayout.align.direction.rotate-all-text-90');
    assert.equal((await tbl()).rows[1].cells[1].vertical, 'vertical');
    await activate('tablelayout.align.direction.horizontal');
    await activate('tablelayout.align.margins.wide');
    assert.deepEqual((await tbl()).rows[1].cells[1].margins, [14.4, 14.4, 14.4, 14.4]);
    await activate('tablelayout.align.margins.custom-margins');
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.cellMargins');
    await app.rpc('ui.dialog.set', {field: 'left', value: 0.5});
    await app.capture('8-cell-margins-dialog');
    await app.rpc('ui.dialog.submit', {});
    assert.equal((await tbl()).rows[1].cells[1].margins[0], 36);
    await app.capture('9-aligned');

    // Table Size scales the table; View Gridlines draws the cell edges.
    await activate('tablelayout.tablesize.width', 300);
    t = await tbl();
    assert.ok(Math.abs(t.cols.reduce((a, b) => a + b, 0) - 300) < 1e-6);
    await activate('tablelayout.table.gridlines');
    await app.capture('10-gridlines');
    await activate('tablelayout.table.gridlines');

    // The pencil and the eraser, through the ribbon's toggles and the pointer.
    await app.rpc('ui.tab', {doc, tab: 'table-design'});
    await activate('tabledesign.draw.draw-table');
    const cols0 = (await tbl()).cols;
    const w0 = cols0.length;
    await pointer([{kind: 'down', x: 230, y: 125}, {kind: 'drag', x: 230, y: 150}, {kind: 'up', x: 230, y: 150}]);
    const cols1 = (await tbl()).cols;
    assert.equal(cols1.length, w0 + 1);
    // The new column is never hair-thin: the pencil leaves both pieces at least 40 pt wide.
    assert.ok(cols1.every(w => w >= 40), JSON.stringify(cols1));
    const split = cols1.findIndex((w, i) => Math.abs(w - (cols0[i] ?? -1)) > 1e-6);
    const borderX = 100 + cols1.slice(0, split + 1).reduce((a, b) => a + b, 0);
    await app.capture('11-pencil');
    await activate('tabledesign.draw.draw-table');
    await activate('tabledesign.draw.eraser');
    await pointer([{kind: 'down', x: borderX, y: 135}, {kind: 'up', x: borderX, y: 135}]);
    assert.ok((await tbl()).rows[0].cells.some(k => k.gridSpan > 1));
    await activate('tabledesign.draw.eraser');
    await app.capture('12-eraser');

    // Dragging a column border resizes the column.
    const before = (await tbl()).cols.slice();
    const bx = 100 + before[0];
    await pointer([{kind: 'down', x: bx, y: 220}, {kind: 'drag', x: bx + 10, y: 220}, {kind: 'up', x: bx + 10, y: 220}]);
    const after = (await tbl()).cols;
    assert.ok(Math.abs(after[0] - before[0] - 10) < 0.5, JSON.stringify({before, after}));
  } finally {
    await app.close();
  }
});
