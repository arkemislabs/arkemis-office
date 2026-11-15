// U:slate/insert (Tables): Insert › Table and the Table Layout tab.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `insert.table` and `table.*`
//    (Table Layout) name the commands; OneNote's behaviour: Insert › Table (grid picker or Insert
//    Table… dialog, columns 1–99, rows 1–500) puts a table at the caret, in a note container when
//    there is no caret in a note; Table Layout › Select / Delete / Insert (above, below, left,
//    right) / Hide Borders / Header Row / Shading / Sort act on the cells the caret or selection
//    covers; the Table Layout tab shows while the selection is in a table.
// 2. Ours does the same on the page body (schema table > row > cell), one undo entry each; cell
//    selections are cell addresses (one range per cell), a table selection the table's address.
// 3. Proof: these tests (engine, undo round trips, dialog model, context flag) and
//    tests/e2e/slate/insert.e2e.mjs (ribbon presses, grid picker, captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import insertTableDialog from '../../core/slate/dialogs/insert-table.mjs';
import {evaluate} from '../../core/slate/context.mjs';
import {textSession, textSel} from './format-helpers.mjs';

const text = n => (n.content ?? []).map(c => (c.type === 'text' ? c.text : c.content ? text(c) : '')).join('');
/** The first table in the body: {container, index, node}. */
function findTable(t) {
  for (const c of t.content.pages[t.pageId].body.content) {
    const i = c.content.findIndex(n => n.type === 'table');
    if (i >= 0) return {container: c, index: i, node: c.content[i]};
  }
  return null;
}
const grid = t => findTable(t).node.content.map(r => r.content.map(c => c.content.map(text).join('|')));
const shape = t => { const {node} = findTable(t); return [node.content.length, node.content[0].content.length]; };
const block = (container, i) => (container.content[i].type === 'paragraph' ? text(container.content[i]) : container.content[i].type);

/** A session whose first page holds Intro then a table, built through the model (steps). */
async function withTable(cells, selection) {
  const t = await textSession(['Intro'], {selection: p => textSel(p, 'b1', 5)});
  await t.exec('insert.table', {rows: cells.length, columns: cells[0].length});
  // Fill the cells through typing steps by replacing the table's paragraphs' text (surface.edit with insert steps).
  const {node} = findTable(t);
  const edits = [];
  node.content.forEach((r, ri) => r.content.forEach((c, ci) => edits.push({id: c.content[0].attrs.id, text: cells[ri][ci]})));
  for (const e of edits) {
    if (!e.text) continue;
    t.select({ranges: [{anchor: `/pg:${t.pageId}/b:${e.id}/t:0`, focus: `/pg:${t.pageId}/b:${e.id}/t:0`}], primary: 0});
    await t.exec('insert.symbol', {char: e.text});
  }
  if (selection) t.select(selection(t));
  return t;
}
const cellSel = (t, r, c, to = [r, c]) => {
  const tb = findTable(t).node;
  const a = `/pg:${t.pageId}/b:${tb.content[r].content[c].attrs.id}`, f = `/pg:${t.pageId}/b:${tb.content[to[0]].content[to[1]].attrs.id}`;
  return {ranges: [{anchor: a, focus: f}], primary: 0};
};
const caretIn = (t, r, c) => {
  const tb = findTable(t).node;
  const a = `/pg:${t.pageId}/b:${tb.content[r].content[c].content[0].attrs.id}/t:0`;
  return {ranges: [{anchor: a, focus: a}], primary: 0};
};

test('insert.table at a caret in the middle of a paragraph splits it; the caret goes to the first cell', async () => {
  const t = await textSession(['Hello world'], {selection: p => textSel(p, 'b1', 5)});
  await expectUndoRoundTrip(t, 'insert.table', {rows: 2, columns: 3});
  const {container, index} = findTable(t);
  assert.deepEqual(shape(t), [2, 3]);
  assert.equal(block(container, index - 1), 'Hello');
  assert.equal(block(container, index + 1), ' world');
  const sel = t.doc.selection.ranges[0];
  const firstCell = findTable(t).node.content[0].content[0].content[0].attrs.id;
  assert.equal(sel.anchor, `/pg:${t.pageId}/b:${firstCell}/t:0`);
  assert.equal(findTable(t).node.attrs.hideBorders, false);
});

test('insert.table at the end of the last paragraph leaves an empty paragraph after it; at the start it goes before', async () => {
  const t = await textSession(['One'], {selection: p => textSel(p, 'b1', 3)});
  await t.exec('insert.table', {rows: 1, columns: 1});
  let {container, index} = findTable(t);
  assert.equal(block(container, index - 1), 'One');
  assert.equal(block(container, index + 1), '');
  assert.equal(container.content.length, 3);
  const t2 = await textSession(['One', 'Two'], {selection: p => textSel(p, 'b2', 0)});
  await t2.exec('insert.table', {rows: 1, columns: 2});
  ({container, index} = findTable(t2));
  assert.equal(block(container, index - 1), 'One');
  assert.equal(block(container, index + 1), 'Two');
});

test('insert.table with no caret in a note starts a note container for it; defaults 2 x 2; limits 99 columns and 500 rows', async () => {
  const t = await textSession(['Existing'], {selection: p => ({ranges: [{anchor: `/pg:${p}`, focus: `/pg:${p}`}], primary: 0})});
  const r = await t.exec('insert.table', {});
  assert.deepEqual(shape(t), [2, 2]);
  assert.equal(t.content.pages[t.pageId].body.content.length, 2);
  assert.equal(r.result.columns, 2);
  await assert.rejects(t.exec('insert.table', {rows: 501, columns: 2}), /rows/);
  await assert.rejects(t.exec('insert.table', {rows: 2, columns: 100}), /columns/);
  await t.exec('insert.table', {rows: 500, columns: 99});
});

test('dialog.insert-table: 2 x 2 to start, columns 1–99 and rows 1–500, submits insert.table', () => {
  assert.deepEqual(insertTableDialog.init({}), {columns: 2, rows: 2});
  assert.equal(insertTableDialog.validate({columns: 0, rows: 2})[0].field, 'columns');
  assert.equal(insertTableDialog.validate({columns: 2, rows: 501})[0].field, 'rows');
  assert.deepEqual(insertTableDialog.toCommand({columns: '4', rows: '3'}), {command: 'insert.table', params: {rows: 3, columns: 4}});
});

test('table.select: Table selects the table, Columns / Rows the cells they cover, Cell the caret\'s cell', async () => {
  const t = await withTable([['a', 'b', 'c'], ['d', 'e', 'f']], t0 => caretIn(t0, 1, 1));
  assert.equal(t.state('table.select', {scope: 'cell'}).enabled, true);
  await t.exec('table.select', {scope: 'columns'});
  assert.equal(t.doc.selection.ranges.length, 2);
  const ids = findTable(t).node.content.map(r => r.content[1].attrs.id);
  assert.deepEqual(t.doc.selection.ranges.map(r => r.anchor), ids.map(i => `/pg:${t.pageId}/b:${i}`));
  t.select(caretIn(t, 1, 1));
  await t.exec('table.select', {scope: 'rows'});
  assert.equal(t.doc.selection.ranges.length, 3);
  await t.exec('table.select', {scope: 'cell'});
  assert.equal(t.doc.selection.ranges.length, 1);
  await t.exec('table.select', {scope: 'table'});
  assert.deepEqual(t.doc.selection.ranges, [{anchor: `/pg:${t.pageId}/b:${findTable(t).node.attrs.id}`, focus: `/pg:${t.pageId}/b:${findTable(t).node.attrs.id}`}]);
  // The commands still see the table.
  assert.equal(t.state('table.hideBorders').enabled, true);
});

test('table.insert adds a row above or below and a column left or right of the selection; the caret goes to the new cell', async () => {
  const t = await withTable([['a', 'b'], ['c', 'd']], t0 => caretIn(t0, 0, 1));
  await expectUndoRoundTrip(t, 'table.insert', {where: 'below'});
  assert.deepEqual(grid(t), [['a', 'b'], ['', ''], ['c', 'd']]);
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pageId}/b:${findTable(t).node.content[1].content[0].content[0].attrs.id}/t:0`);
  await t.exec('table.insert', {where: 'above'});
  assert.deepEqual(grid(t), [['a', 'b'], ['', ''], ['', ''], ['c', 'd']]);
  t.select(caretIn(t, 0, 0));
  await t.exec('table.insert', {where: 'right'});
  assert.deepEqual(grid(t)[0], ['a', '', 'b']);
  assert.equal(shape(t)[1], 3);
  t.select(caretIn(t, 0, 0));
  await expectUndoRoundTrip(t, 'table.insert', {where: 'left'});
  assert.deepEqual(grid(t)[0], ['', 'a', '', 'b']);
  assert.deepEqual(grid(t).map(r => r.length), [4, 4, 4, 4]);
});

test('table.insert below a selection of two rows goes after the last; Insert refuses past 500 rows or 99 columns', async () => {
  const t = await withTable([['a'], ['b'], ['c']], t0 => cellSel(t0, 0, 0, [1, 0]));
  await t.exec('table.insert', {where: 'below'});
  assert.deepEqual(grid(t), [['a'], ['b'], [''], ['c']]);
  const big = await textSession(['x'], {selection: p => textSel(p, 'b1', 1)});
  await big.exec('insert.table', {rows: 500, columns: 99});
  assert.equal(big.state('table.insert', {where: 'below'}).enabled, false);
  assert.equal(big.state('table.insert', {where: 'right'}).enabled, false);
  assert.equal(big.state('table.insert', {where: 'above'}).reason, 'A table has at most 500 rows');
});

test('table.delete removes the selected rows or columns, the whole table when all are selected, and a container never stays empty', async () => {
  const t = await withTable([['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']], t0 => cellSel(t0, 0, 1, [1, 1]));
  await expectUndoRoundTrip(t, 'table.delete', {scope: 'columns'});
  assert.deepEqual(grid(t), [['a', 'c'], ['d', 'f'], ['g', 'i']]);
  t.select(cellSel(t, 1, 0));
  await t.exec('table.delete', {scope: 'rows'});
  assert.deepEqual(grid(t), [['a', 'c'], ['g', 'i']]);
  t.select(cellSel(t, 0, 0, [0, 1]));
  await t.exec('table.delete', {scope: 'rows'});
  assert.deepEqual(grid(t), [['g', 'i']]);
  await t.exec('table.delete', {scope: 'columns'}).catch(() => {});
  t.select(caretIn(t, 0, 0));
  await expectUndoRoundTrip(t, 'table.delete', {scope: 'table'});
  assert.equal(findTable(t), null);
  // A table that is the only block in its container is replaced by an empty paragraph.
  const only = await textSession(['x'], {selection: p => ({ranges: [{anchor: `/pg:${p}`, focus: `/pg:${p}`}], primary: 0})});
  await only.exec('insert.table', {rows: 1, columns: 1});
  const body = only.content.pages[only.pageId].body.content[1];
  assert.equal(body.content[0].type, 'table');
  only.select(caretIn(only, 0, 0));
  await only.exec('table.delete', {scope: 'table'});
  assert.equal(findTable(only), null);
  assert.ok(only.content.pages[only.pageId].body.content[1].content.length >= 1);
});

test('table.hideBorders, headerRow and sortHeaderRow toggle on the table; Shading sets the selected cells, none clears them', async () => {
  const t = await withTable([['a', 'b'], ['c', 'd']], t0 => caretIn(t0, 0, 0));
  assert.deepEqual(t.state('table.hideBorders'), {enabled: true, checked: false});
  await expectUndoRoundTrip(t, 'table.hideBorders', {});
  assert.equal(findTable(t).node.attrs.hideBorders, true);
  assert.equal(t.state('table.hideBorders').checked, true);
  await t.exec('table.hideBorders', {value: false});
  assert.equal(findTable(t).node.attrs.hideBorders, false);
  await t.exec('table.headerRow', {});
  assert.equal(findTable(t).node.attrs.headerRow, true);
  await t.exec('table.sortHeaderRow', {});
  assert.equal(findTable(t).node.attrs.sortHeader, true);
  // Shading on the caret's cell, then on a selected column.
  await expectUndoRoundTrip(t, 'table.shading', {color: '#FF0000'});
  assert.deepEqual(findTable(t).node.content.map(r => r.content.map(c => c.attrs.shading)), [['#ff0000', null], [null, null]]);
  assert.equal(t.state('table.shading').value, '#ff0000');
  t.select(cellSel(t, 0, 1, [1, 1]));
  await t.exec('table.shading', {color: '#00b050'});
  assert.deepEqual(findTable(t).node.content.map(r => r.content.map(c => c.attrs.shading)), [['#ff0000', '#00b050'], [null, '#00b050']]);
  await t.exec('table.shading', {color: null});
  assert.deepEqual(findTable(t).node.content.map(r => r.content.map(c => c.attrs.shading)), [['#ff0000', null], [null, null]]);
  await t.exec('table.shading', {});
  assert.equal(findTable(t).node.content[0].content[1].attrs.shading, '#ffff00');
});

test('table.sort orders the rows by the caret\'s column: numbers by value, text in locale order, empty cells last, the header row first', async () => {
  const t = await withTable([['Name', 'Qty'], ['pear', '10'], ['Apple', '9'], ['fig', ''], ['banana', '100']], t0 => caretIn(t0, 1, 0));
  await t.exec('table.headerRow', {});
  await expectUndoRoundTrip(t, 'table.sort', {order: 'ascending'});
  assert.deepEqual(grid(t).map(r => r[0]), ['Name', 'Apple', 'banana', 'fig', 'pear']);
  await t.exec('table.sort', {order: 'descending'});
  assert.deepEqual(grid(t).map(r => r[0]), ['Name', 'pear', 'fig', 'banana', 'Apple']);
  t.select(caretIn(t, 1, 1));
  await t.exec('table.sort', {order: 'ascending'});
  assert.deepEqual(grid(t).map(r => r[1]), ['Qty', '9', '10', '100', '']);
  await t.exec('table.sort', {order: 'descending'});
  assert.deepEqual(grid(t).map(r => r[1]), ['Qty', '100', '10', '9', '']);
  // Without a header row the first row sorts too.
  await t.exec('table.headerRow', {value: false});
  await t.exec('table.sort', {order: 'ascending'});
  assert.deepEqual(grid(t).map(r => r[1]), ['9', '10', '100', 'Qty', '']);
  // Sort leaves the first row alone when Sort › Header Row is on.
  await t.exec('table.sortHeaderRow', {value: true});
  await t.exec('table.sort', {order: 'descending'});
  assert.equal(grid(t)[0][1], '9');
});

test('table commands are disabled outside a table, and the Table Layout context flag follows the selection', async () => {
  const t = await withTable([['a']], t0 => textSel(t0.pageId, 'b1', 0));
  for (const id of ['table.select', 'table.delete', 'table.insert', 'table.hideBorders', 'table.headerRow', 'table.shading', 'table.sort']) {
    assert.equal(t.state(id, id === 'table.select' || id === 'table.delete' ? {scope: 'table'} : id === 'table.insert' ? {where: 'below'} : id === 'table.sort' ? {order: 'ascending'} : undefined).enabled, false, id);
  }
  assert.equal(t.state('table.hideBorders').reason, 'Click in a table to use the table commands');
  await assert.rejects(t.exec('table.delete', {scope: 'table'}), /Click in a table/);
  assert.equal(evaluate(t.content, t.doc.selection).table, false);
  t.select(caretIn(t, 0, 0));
  assert.equal(evaluate(t.content, t.doc.selection).table, true);
  t.select(cellSel(t, 0, 0));
  assert.equal(evaluate(t.content, t.doc.selection).table, true);
  await t.exec('table.select', {scope: 'table'});
  assert.equal(evaluate(t.content, t.doc.selection).table, true);
});

test('a text range across cells acts on the rectangle between its ends', async () => {
  const t = await withTable([['a', 'b', 'c'], ['d', 'e', 'f']], t0 => caretIn(t0, 0, 0));
  const tb = findTable(t).node;
  const a = `/pg:${t.pageId}/b:${tb.content[0].content[1].content[0].attrs.id}/t:0`, f = `/pg:${t.pageId}/b:${tb.content[1].content[2].content[0].attrs.id}/t:1`;
  t.select({ranges: [{anchor: a, focus: f}], primary: 0});
  await t.exec('table.shading', {color: '#ff0000'});
  assert.deepEqual(findTable(t).node.content.map(r => r.content.map(c => c.attrs.shading)), [[null, '#ff0000', '#ff0000'], [null, '#ff0000', '#ff0000']]);
});

test('Table Layout › Alignment acts on every selected cell (Select Columns gives one range per cell)', async () => {
  const t = await withTable([['a', 'b'], ['c', 'd']], t0 => caretIn(t0, 0, 1));
  await t.exec('table.select', {scope: 'columns'});
  await t.exec('paragraph.align', {alignment: 'center'});
  const aligns = findTable(t).node.content.map(r => r.content.map(c => c.content[0].attrs.align));
  assert.deepEqual(aligns, [[null, 'center'], [null, 'center']]);
  await t.exec('table.select', {scope: 'table'});
  await t.exec('paragraph.align', {alignment: 'right'});
  assert.deepEqual(findTable(t).node.content.map(r => r.content.map(c => c.content[0].attrs.align)), [['right', 'right'], ['right', 'right']]);
});
