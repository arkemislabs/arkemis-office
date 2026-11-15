// U:prism/table: Copy, Cut and Paste of a range of table cells through the bridge clipboard (the test
// host's, never the system's).
//
// 1. What ArtCraft does: deckcraft cmd/edit.rs copy_inner copies selected cells as their text (a tab between
//    cells, a paragraph per row) and Delete (clear_selected_cells) clears them. PowerPoint copies cells with
//    their formatting; pasted into a table they land cell by cell from the first selected cell, outside a
//    table they make a new table.
// 2. Ours: core/prism/lib/table-clip.mjs, hooked into edit.copy / edit.cut / edit.paste / edit.delete.
// 3. Proved here headless; undo is one step each.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {withNew, curSlide} from './upstream/text_deck.mjs';
import table from '../../core/prism/commands/table.mjs';
import insert from '../../core/prism/commands/insert.mjs';
import {bodyText} from '../../core/prism/model/text.mjs';
import {cellSelection} from '../../core/prism/lib/table-sel.mjs';

const mk = () => withNew({extra: [table, insert]});
const tables = t => curSlide(t).shapes.filter(s => s.kind?.type === 'table');
const txt = (k, r, c) => bodyText(k.rows[r].cells[c].text);

async function setup(rows = 3, cols = 3, data = [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]) {
  const t = await mk();
  const id = (await t.exec('insert.table', {rows, cols, rect: [100, 100, cols * 100, rows * 40], data})).result.id;
  return {t, id};
}

test('copy of a range of cells: their text with tabs and rows; a merged cell once; nothing changes', async () => {
  const {t, id} = await setup();
  await t.exec('table.selectCells', {id, from: [0, 0], to: [1, 1]});
  const v = t.version;
  const r = await t.exec('edit.copy', {});
  assert.equal(r.result.text, 'a\tb\nd\te');
  assert.equal(t.version, v);
  assert.equal(t.session.clipboard.kind, 'prism.cells');
  await t.exec('table.merge', {id, from: [1, 0], to: [1, 1]});
  await t.exec('table.selectCells', {id, from: [0, 0], to: [1, 1]});
  assert.equal((await t.exec('edit.copy', {})).result.text, 'a\tb\nd\ne');
});

test('cut clears the cells and keeps them; one undo', async () => {
  const {t, id} = await setup();
  await t.exec('table.selectCells', {id, from: [1, 1], to: [2, 2]});
  await expectUndoRoundTrip(t, 'edit.cut', {}, after => {
    const k = after.content.slides[0].shapes.find(s => s.id === id).kind;
    assert.deepEqual([txt(k, 1, 1), txt(k, 1, 2), txt(k, 2, 1), txt(k, 2, 2), txt(k, 0, 0), txt(k, 1, 0)], ['', '', '', '', 'a', 'd']);
  });
  assert.equal(t.session.clipboard.text, 'e\tf\nh\ti');
});

test('paste cells into the table: from the first selected cell, the table grows; one cell fills a range', async () => {
  const {t, id} = await setup();
  await t.exec('table.selectCells', {id, from: [0, 0], to: [1, 1]});
  await t.exec('table.cellFill', {color: '#336699'});
  await t.exec('edit.copy', {});
  await t.exec('table.selectCells', {id, from: [2, 1], to: [2, 1]});
  await expectUndoRoundTrip(t, 'edit.paste', {}, after => {
    const k = after.content.slides[0].shapes.find(s => s.id === id).kind;
    assert.equal(k.rows.length, 4, 'a row was added for the block');
    assert.deepEqual([txt(k, 2, 1), txt(k, 2, 2), txt(k, 3, 1), txt(k, 3, 2)], ['a', 'b', 'd', 'e']);
    assert.equal(k.rows[2].cells[1].fill.kind, 'solid', 'the formatting came with the text');
    assert.equal(txt(k, 2, 0), 'g');
  });
  // The pasted cells are the selection.
  const cs = cellSelection(t.content, t.doc.selection);
  assert.deepEqual([cs.from, cs.to], [[2, 1], [3, 2]]);
  // One cell over a range fills it.
  await t.exec('table.selectCells', {id, from: [0, 2], to: [0, 2]});
  await t.exec('edit.copy', {});
  await t.exec('table.selectCells', {id, from: [1, 0], to: [2, 0]});
  await t.exec('edit.paste', {});
  const k = tables(t)[0].kind;
  assert.deepEqual([txt(k, 1, 0), txt(k, 2, 0), txt(k, 3, 0)], ['c', 'c', '']);
});

test('paste with the caret in a cell, over merged cells, and pasted cells outside a table make a new table', async () => {
  const {t, id} = await setup();
  await t.exec('table.merge', {id, from: [1, 1], to: [2, 2]});
  await t.exec('table.selectCells', {id, from: [0, 0], to: [0, 1]});
  await t.exec('edit.copy', {});
  await t.exec('text.edit', {id, cell: [1, 1]});
  await t.exec('edit.paste', {});
  let k = tables(t)[0].kind;
  assert.deepEqual([txt(k, 1, 1), txt(k, 1, 2)], ['a', 'b']);
  assert.ok(k.rows.flatMap(r => r.cells).every(c => c.gridSpan === 1 && c.rowSpan === 1), 'the merged cell it landed on came apart');
  // Outside a table: a new table with the copied style.
  await t.exec('table.style', {id, style: 'dark1-accent2'});
  await t.exec('table.selectCells', {id, from: [0, 0], to: [1, 1]});
  await t.exec('edit.copy', {});
  await t.exec('edit.deselect', {});
  assert.equal(tables(t).length, 1);
  await t.exec('edit.paste', {});
  assert.equal(tables(t).length, 2);
  k = tables(t)[1].kind;
  assert.equal(k.style, 'dark1-accent2');
  assert.deepEqual([k.rows.length, k.cols.length, txt(k, 1, 1)], [2, 2, 'a']);
  assert.equal(txt(k, 0, 0), 'a');
});

test('tab-separated text from another app over a selected range fills the cells; elsewhere it is a text box', async () => {
  const {t, id} = await setup();
  await t.exec('table.selectCells', {id, from: [0, 0], to: [0, 0]});
  await t.exec('table.selectCells', {id, from: [0, 0], to: [0, 1]});
  await t.exec('edit.paste', {text: 'x\ty\nz\tw'});
  const k = tables(t)[0].kind;
  assert.deepEqual([txt(k, 0, 0), txt(k, 0, 1), txt(k, 1, 0), txt(k, 1, 1)], ['x', 'y', 'z', 'w']);
  // One word over a range goes to a text box as before.
  const n = curSlide(t).shapes.length;
  await t.exec('edit.deselect', {});
  await t.exec('edit.paste', {text: 'plain'});
  assert.equal(curSlide(t).shapes.length, n + 1);
});
