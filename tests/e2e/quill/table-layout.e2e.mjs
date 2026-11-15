// Quill Table Design and Table Layout tabs (U:quill/table, table_style) end to end through the bridge,
// in the new shell (devRenderer, ARKEMIS_NEW_HOST=1). No OS input: ribbon controls through
// ui.activate, dialogs through ui.dialog.set / ui.dialog.submit, the document read back over the bridge.
//
// Behaviour fidelity:
// 1. ArtCraft crates/engine/src/cmd/table.rs + table/*.rs, table_style.rs and the dialogs in
//    crates/ui-egui/src/dialogs/{forms.rs, dialogs_layout/table.rs}; Word's contextual Table Design
//    and Table Layout tabs: they appear while the caret is in a table, style options and styles
//    restyle the table, Insert Below adds a row, Merge Cells joins the selected cells, Split Cells
//    / Table Properties / Sort / Formula open their dialogs and OK applies them, Convert to Text
//    turns the table back into text.
// 2. The same commands run from the window's ribbon and dialogs; the page view paints the result
//    (captures after each step).
// 3. This file; the engine side is tests/quill/table.test.mjs and tests/quill/upstream/table_*.test.mjs.
//
// Evidence: artifacts/e2e/quill/table-layout/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';
import {newTable} from '../../../core/quill/model/table.mjs';
import {paragraphWithText} from '../../../core/quill/model/para.mjs';

function seedDoc(id) {
  const seed = createFile('quill', 'Table tabs');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Regional sales'}]},
    {type: 'paragraph', content: [{type: 'text', text: 'Units sold per quarter.'}]},
  ]};
  const file = migrateFile(seed);
  // A 4 × 4 table of numbers after the text, as Insert › Table and typing would leave it.
  const rows = [['Region', 'Q1', 'Q2', 'Q3'], ['North', '12', '15', '9'], ['West', '7', '11', '14'], ['South', '20', '8', '10']];
  const t = newTable(4, 4, 468);
  const table = {...t, rows: t.rows.map((row, r) => ({...row, cells: row.cells.map((cl, c) => ({...cl, blocks: [paragraphWithText(rows[r][c])]}))}))};
  file.content.body.chunks = [[...file.content.body.chunks.flat(), table, paragraphWithText('')]];
  return file;
}

test('quill table tabs: styles, rows, merge, split, properties, sort, formula, convert', {timeout: 240_000}, async t => {
  const seed = seedDoc('quill-table-layout');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/table-layout', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const settle = () => new Promise(r => setTimeout(r, 350));
  /** The first table of the body, read over the bridge. */
  const table = async () => {
    const body = (await app.rpc('document.read', {doc, address: '/body', as: 'json'})).value;
    const blocks = Array.isArray(body) ? body : body?.blocks ?? body?.chunks?.flat?.() ?? [];
    return blocks.find(b => b.kind === 'table') ?? null;
  };
  /** The address of the first cell's paragraph start. */
  const firstCell = async () => {
    const tb = await table();
    return `/body/b:${tb.id}/r:${tb.rows[0].id}/c:${tb.rows[0].cells[0].id}/b:${tb.rows[0].cells[0].blocks[0].id}/t:0`;
  };
  const cellText = c => c.blocks.filter(b => b.kind === 'para').map(b => b.text.replace(/￼/g, '')).join('\n');
  const texts = tb => tb.rows.map(r => r.cells.map(cellText));
  const activate = control => app.rpc('ui.activate', {doc, control});
  const dialog = async (control, id, values) => {
    await activate(control);
    const d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.id, id, `${control} opens ${id}`);
    if (values) await app.rpc('ui.dialog.set', {doc, values});
    await settle();
    return d;
  };
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });

    // The caret in the table's first cell.
    const at = await firstCell();
    await app.rpc('selection.set', {doc, ranges: [{anchor: at, focus: at}]});
    // The contextual tabs are there while the caret is in the table.
    const tabs = (await app.rpc('ui.inspect', {doc})).tabs.map(x => x.id ?? x);
    assert.ok(tabs.includes('table-design') && tabs.includes('table-layout'), `contextual tabs: ${tabs.join(', ')}`);

    // Table Design: a style from the gallery, then Banded Rows off and First Column on.
    await app.rpc('ui.tab', {doc, id: 'table-design'});
    await run('table.style', {style: 'Grid Table 4 – Blue'});
    await activate('table-design.table-style-options.banded-rows');
    let tb = await table();
    assert.equal(tb.props.style, 'GridTable4AccentBlue');
    assert.equal(tb.props.look?.bandedRows, false, 'Banded Rows toggled off');
    await settle();
    await app.capture('1-table-design', {doc});

    // Table Layout: Insert Below (a row under the caret's), then the row's cells merged.
    await app.rpc('ui.tab', {doc, id: 'table-layout'});
    await activate('table-layout.rows-columns.insert-below');
    tb = await table();
    assert.equal(tb.rows.length, 5, 'Insert Below added a row');
    await activate('table-layout.table.select.select-row');
    await activate('table-layout.merge.merge-cells');
    tb = await table();
    assert.equal(tb.rows[1].cells.length, 1, 'Merge Cells joined the selected row (the new one under the first)');
    await run('text.insert', {text: 'Totals below'});
    await settle();
    await app.capture('2-insert-merge', {doc});

    // Split Cells: the merged cell into 2 columns.
    await dialog('table-layout.merge.split-cells', 'dialog.splitCells', {cols: 2, rows: 1});
    await app.capture('3-split-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    tb = await table();
    assert.equal(tb.rows[1].cells.length, 2, 'Split Cells made two cells');

    // Table Properties: centred, rows at least 0.3".
    await dialog('table-layout.table.properties', 'dialog.tableProperties', {alignment: 'center'});
    await app.capture('4-properties-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    tb = await table();
    assert.equal(tb.props.align, 'center', 'Table Properties centred the table');

    // Sort by Q1, descending, with a header row: the data rows reorder, the header stays.
    await run('table.deleteRow');
    await dialog('table-layout.data.sort', 'dialog.tableSort', {column: 1, order: 'descending', header: 'yes'});
    await app.capture('5-sort-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    tb = await table();
    assert.deepEqual(texts(tb).map(r => r[0]), ['Region', 'South', 'North', 'West'], 'sorted by Q1, descending, header kept');

    // Insert Below on the last row, then Formula: =SUM(ABOVE) suggested in the Q1 column.
    const lastCell = async (c) => { const tb2 = await table(); const row = tb2.rows[tb2.rows.length - 1]; return `/body/b:${tb2.id}/r:${row.id}/c:${row.cells[c].id}/b:${row.cells[c].blocks[0].id}/t:0`; };
    let here = await lastCell(0);
    await app.rpc('selection.set', {doc, ranges: [{anchor: here, focus: here}]});
    await activate('table-layout.rows-columns.insert-below');
    here = await lastCell(1);
    await app.rpc('selection.set', {doc, ranges: [{anchor: here, focus: here}]});
    const f = await dialog('table-layout.data.formula', 'dialog.tableFormula');
    assert.equal(f.values?.formula ?? (await app.rpc('ui.dialog.get', {doc})).values.formula, '=SUM(ABOVE)', 'Word suggests =SUM(ABOVE) under numbers');
    await app.capture('6-formula-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    tb = await table();
    const fieldCell = JSON.stringify(tb.rows[4].cells[1]);
    assert.ok(fieldCell.includes('"result":"39"') && fieldCell.includes('SUM(ABOVE)'), `the formula field shows 12 + 7 + 20: ${fieldCell.slice(0, 400)}`);
    await settle();
    await app.capture('7-sorted-with-total', {doc});

    // Convert to Text (tabs), then undo brings the table back.
    await dialog('table-layout.data.convert-to-text', 'dialog.tableToText', {separator: 'tab'});
    await app.rpc('ui.dialog.submit', {doc});
    assert.equal(await table(), null, 'the table became text');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.ok(await table(), 'undo brought the table back');
    await settle();
    await app.capture('8-after-undo', {doc});
    t.diagnostic('captures in artifacts/e2e/quill/table-layout');
  } finally {
    await app.close();
  }
});
