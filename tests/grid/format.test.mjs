// U:grid/format on schema-2 workbooks: every edit command's undo round trip, the ribbon states the
// commands report, whole-line formats, and the Format Cells / Row Height / Column Width dialog models.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft cmd/format.rs, format/cell_styles.rs, format/sizes.rs (apply_style, toggles
//    from the active cell, borders presets, merges, number formats, cell styles, sizes, hide/unhide),
//    ui-egui dialogs/format_cells.rs and dialogs.rs (Row Height, Column Width, Standard Width);
//    Excel: Home › Font / Alignment / Number / Styles / Cells › Format and Format Cells (Ctrl+1).
// 2. Ours: the same commands write style ids into content.styles and line records, each one undo
//    step; the dialogs open with the active cell's values and submit the same commands.
// 3. This file and tests/grid/upstream/format_tests.test.mjs (engine), tests/e2e/grid/format-ribbon.e2e.mjs (bridge + captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, run, fails, style, stored, text} from './edit-helpers.mjs';
import formatCells from '../../core/grid/dialogs/formatCells.mjs';
import rowHeight from '../../core/grid/dialogs/rowHeight.mjs';
import columnWidth from '../../core/grid/dialogs/columnWidth.mjs';
import defaultWidth from '../../core/grid/dialogs/defaultWidth.mjs';
import {cellStyleItems, builtinCellStyle} from '../../core/grid/commands/format/styles.mjs';
import {orientationAngle} from '../../core/grid/commands/format/alignment.mjs';
import {formatNameOf} from '../../core/grid/commands/format/number.mjs';

const book = () => session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 1.5}, B1: {v: 'text'}, A2: {v: 1234.5}, B2: {v: -3}}}}]));

const EDITS = [
  ['home.bold', {range: 'A1:B2'}, t => style(t, 'B2').font.bold === true],
  ['home.italic', {range: 'A1'}, t => style(t, 'A1').font.italic === true],
  ['home.underline', {range: 'A1', style: 'singleAccounting'}, t => style(t, 'A1').font.underline === 'singleAccounting'],
  ['home.doubleUnderline', {range: 'A1'}, t => style(t, 'A1').font.underline === 'double'],
  ['home.strikethrough', {range: 'A1'}, t => style(t, 'A1').font.strike === true],
  ['home.superscript', {range: 'A1'}, t => style(t, 'A1').font.vert === 'superscript'],
  ['home.subscript', {range: 'A1'}, t => style(t, 'A1').font.vert === 'subscript'],
  ['home.fontName', {range: 'A1', name: 'Georgia'}, t => style(t, 'A1').font.name === 'Georgia'],
  ['home.fontSize', {range: 'A1', size: 14.3}, t => style(t, 'A1').font.size === 14.5],
  ['home.increaseFontSize', {range: 'A1'}, t => style(t, 'A1').font.size === 12],
  ['home.decreaseFontSize', {range: 'A1'}, t => style(t, 'A1').font.size === 10],
  ['home.fontColor', {range: 'A1', color: {theme: 4, tint: -0.25}}, t => style(t, 'A1').font.color.theme === 4],
  ['home.fillColor', {range: 'A1:B1', color: '#ffff00'}, t => style(t, 'B1').fill.fg === '#FFFF00'],
  ['home.borders', {range: 'A1:B2', preset: 'thickOutside'}, t => style(t, 'B2').borders.right.style === 'thick' && style(t, 'A1').borders.right === null],
  ['home.formatCells', {range: 'A1', style: {font: {bold: true}, fill: {fg: '#00FF00'}, align: {h: 'center'}, protection: {locked: false}}},
    t => style(t, 'A1').fill.pattern === 'solid' && style(t, 'A1').protection.locked === false],
  ['home.alignLeft', {range: 'A1'}, t => style(t, 'A1').align.h === 'left'],
  ['home.alignCenter', {range: 'A1'}, t => style(t, 'A1').align.h === 'center'],
  ['home.alignRight', {range: 'A1'}, t => style(t, 'A1').align.h === 'right'],
  ['home.justify', {range: 'A1'}, t => style(t, 'A1').align.h === 'justify'],
  ['home.alignTop', {range: 'A1'}, t => style(t, 'A1').align.v === 'top'],
  ['home.alignMiddle', {range: 'A1'}, t => style(t, 'A1').align.v === 'center'],
  ['home.wrapText', {range: 'B1'}, t => style(t, 'B1').align.wrap === true],
  ['home.shrinkToFit', {range: 'B1'}, t => style(t, 'B1').align.shrink === true],
  ['home.increaseIndent', {range: 'A1'}, t => style(t, 'A1').align.indent === 1 && style(t, 'A1').align.h === 'left'],
  ['home.orientation', {range: 'A1', angle: 'counterclockwise'}, t => style(t, 'A1').align.rotation === 45],
  ['home.mergeCenter', {range: 'A1:B1'}, t => t.content.sheets[0].merges[0] === 'A1:B1' && style(t, 'A1').align.h === 'center' && !stored(t, 'B1')?.v],
  ['home.mergeAcross', {range: 'A1:B2'}, t => t.content.sheets[0].merges.length === 2],
  ['home.mergeCells', {range: 'A1:B2'}, t => t.content.sheets[0].merges[0] === 'A1:B2'],
  ['home.numberFormat', {range: 'A2', format: 'Currency'}, t => text(t, 'A2') === '$1,234.50'],
  ['home.accounting', {range: 'A2'}, t => /1,234\.50/.test(text(t, 'A2'))],
  ['home.percent', {range: 'A1'}, t => text(t, 'A1') === '150%'],
  ['home.comma', {range: 'B2'}, t => /\(3\.00\)/.test(text(t, 'B2'))],
  ['home.increaseDecimal', {range: 'A1'}, t => text(t, 'A1') === '1.50'],
  ['home.decreaseDecimal', {range: 'A1'}, t => text(t, 'A1') === '2'],
  ['home.cellStyle', {range: 'A1', name: 'Heading 1'}, t => style(t, 'A1').font.size === 15 && style(t, 'A1').borders.bottom.style === 'thick'],
  ['home.rowHeight', {rows: '2:3', points: 24}, t => t.content.sheets[0].rows[1].size === 32 && t.content.sheets[0].rows[2].custom === true],
  ['home.columnWidth', {cols: 'B:B', chars: 12}, t => t.content.sheets[0].cols[1].size === 89],
  ['home.autofitColumnWidth', {cols: 'A:B'}, t => t.content.sheets[0].cols[0].size > 0],
  ['home.defaultWidth', {width: 80}, t => t.content.sheets[0].defaultColWidth === 80],
  ['home.hideRows', {rows: '2:2'}, t => t.content.sheets[0].rows[1].hidden === true],
  ['home.hideColumns', {cols: 'B:C'}, t => t.content.sheets[0].cols[2].hidden === true],
  ['home.lockCell', {range: 'A1'}, t => style(t, 'A1').protection.locked === false],
];

for (const [id, params, check] of EDITS) {
  test(`${id}: undo round trip`, async () => {
    const t = await book();
    await expectUndoRoundTrip(t, id, params, () => assert.ok(check(t), `${id} did what it should`));
  });
}

test('home.unhideRows / home.unhideColumns / home.autofitRowHeight / home.unmergeCells: undo round trips after setup', async () => {
  const t = await book();
  await run(t, 'home.hideRows', {rows: '2:2'});
  await run(t, 'home.hideColumns', {cols: 'B:B'});
  await run(t, 'home.mergeCells', {range: 'A1:B1'});
  await run(t, 'home.rowHeight', {rows: '1:1', height: 60});
  await run(t, 'home.increaseIndent', {range: 'A1'});
  await run(t, 'home.alignTop', {range: 'A1'});
  await expectUndoRoundTrip(t, 'home.alignBottom', {range: 'A1'}, () => assert.equal(style(t, 'A1').align.v, 'bottom'));
  // One selected line unhides its hidden neighbours too (gridcraft is forgiving).
  await expectUndoRoundTrip(t, 'home.unhideRows', {rows: '3:3'}, () => assert.equal(t.content.sheets[0].rows?.[1]?.hidden, undefined));
  await expectUndoRoundTrip(t, 'home.unhideColumns', {cols: 'A:C'}, () => assert.equal(t.content.sheets[0].cols?.[1]?.hidden, undefined));
  await expectUndoRoundTrip(t, 'home.autofitRowHeight', {rows: '1:1'}, () => assert.equal(t.content.sheets[0].rows?.[0], undefined));
  await expectUndoRoundTrip(t, 'home.unmergeCells', {range: 'A1'}, () => assert.equal(t.content.sheets[0].merges, undefined));
  await expectUndoRoundTrip(t, 'home.decreaseIndent', {range: 'A1'}, () => assert.equal(style(t, 'A1').align.indent, 0));
});

test('whole columns and rows keep their own format (Sheet::style_id: cell, row, column)', async () => {
  const t = await book();
  await run(t, 'home.fillColor', {range: 'C:C', color: '#FF0000'});
  assert.equal(style(t, 'C900').fill.fg, '#FF0000', 'an empty cell in the column shows the column format');
  await run(t, 'home.bold', {range: '5:5'});
  assert.equal(style(t, 'Z5').font.bold, true);
  assert.equal(style(t, 'C5').font.bold, true, 'the row format wins over the column format for an empty cell');
  assert.equal(style(t, 'C5').fill.fg, null);
  await run(t, 'home.italic', {range: 'A:A'});
  assert.equal(style(t, 'A1').font.italic, true, 'cells already in the column take it too');
});

test('toggles and alignment read the active cell; clicking the active alignment returns to General', async () => {
  const t = await book();
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sh:s1/A1', focus: '/sh:s1/B2'}], primary: 0});
  assert.deepEqual(t.state('home.bold'), {enabled: true, checked: false});
  await run(t, 'home.alignCenter', {});
  assert.deepEqual(t.state('home.alignCenter'), {enabled: true, checked: true});
  await run(t, 'home.alignCenter', {});
  assert.equal(style(t, 'B2').align.h, 'general');
  assert.equal(t.state('home.fontName').value, 'Calibri');
  assert.equal(t.state('home.fontSize').value, '11');
  assert.equal(t.state('home.numberFormat').value, 'General');
  await run(t, 'home.numberFormat', {format: 'Short Date'});
  assert.equal(t.state('home.numberFormat').value, 'Short Date');
  await run(t, 'home.numberFormat', {code: '0.000'});
  assert.equal(t.state('home.numberFormat').value, 'Custom');
  assert.equal(formatNameOf('0.00%'), 'Percentage');
});

test('combo and gallery values arrive as `value` (ribbon fillArgs)', async () => {
  const t = await book();
  await run(t, 'home.fontName', {range: 'A1', value: 'Verdana'});
  await run(t, 'home.fontSize', {range: 'A1', value: '20'});
  await run(t, 'home.cellStyle', {range: 'A1', value: 'Bad'});
  assert.equal(style(t, 'A1').fill.fg, '#FFC7CE');
  assert.equal(style(t, 'A1').font.name, 'Calibri', 'a cell style replaces the font');
  const items = t.state('home.cellStyle').value;
  assert.equal(items.length, 47);
  assert.deepEqual(items[0], {id: 'Normal', label: 'Normal', value: 'Normal', group: 'Good, Bad and Neutral'});
  assert.equal(cellStyleItems({cellStyles: [{name: 'Mine', style: {}}]})[0].group, 'Custom');
});

test('messages and limits as upstream', async () => {
  const t = await book();
  assert.equal((await fails(t, 'home.fontSize', {range: 'A1', size: 410})).message, 'The number must be between 1 and 409.');
  assert.match((await fails(t, 'home.fontColor', {range: 'A1', color: 'blue-ish'})).message, /invalid `color`/);
  assert.match((await fails(t, 'home.formatCells', {range: 'A1', style: {font: {bold: 'yes'}}})).message, /expected true or false/);
  assert.match((await fails(t, 'home.formatCells', {range: 'A1', style: {nope: {}}})).message, /unknown style key/);
  assert.match((await fails(t, 'home.numberFormat', {range: 'A1'})).message, /missing `format` or `code`/);
  const p = await session(workbook([{id: 's1', name: 'Sheet1', protection: {enabled: true, formatCells: true}}]));
  assert.match((await fails(p, 'home.lockCell', {range: 'A1'})).message, /cell protection on a protected sheet/);
  const q = await session(workbook([{id: 's1', name: 'Sheet1', protection: {enabled: true}}]));
  assert.match((await fails(q, 'home.bold', {range: 'A1'})).message, /protected sheet/);
});

test('cell styles: number-format styles keep the look, others keep the number format', async () => {
  const t = await book();
  await run(t, 'home.numberFormat', {range: 'A2', format: 'Number'});
  await run(t, 'home.cellStyle', {range: 'A2', name: 'Good'});
  assert.equal(style(t, 'A2').numFmt, '0.00');
  await run(t, 'home.cellStyle', {range: 'A2', name: 'Percent'});
  assert.equal(style(t, 'A2').numFmt, '0%');
  assert.equal(style(t, 'A2').fill.fg, '#C6EFCE');
  assert.deepEqual(builtinCellStyle('40% - Accent2').fill, {pattern: 'solid', fg: {theme: 5, tint: 0.6}});
  assert.equal(builtinCellStyle('Accent7'), null);
  assert.equal(orientationAngle('vertical'), 255);
  assert.equal(orientationAngle(120), 90);
});

test('Format Cells dialog: opens on the active cell, previews, and submits home.formatCells', async () => {
  const t = await book();
  await run(t, 'home.numberFormat', {range: 'A2', format: 'Currency'});
  await run(t, 'home.bold', {range: 'A2'});
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sh:s1/A2', focus: '/sh:s1/A2'}], primary: 0});
  const ctx = t.session.readContext(t.docId);
  const v0 = formatCells.init(ctx);
  assert.equal(v0.category, 'Currency');
  assert.equal(v0.decimalPlaces, 2);
  assert.equal(v0.symbol, '$');
  assert.equal(v0.bold, true);
  assert.equal(v0.fontStyle, 'Bold');
  assert.equal(formatCells.preview(ctx, v0).number.text, '$1,234.50');
  const v1 = {decimalPlaces: 0, ...formatCells.derive({...v0, decimalPlaces: 0}, ['decimalPlaces'])};
  assert.equal(v1.code, '"$"#,##0');
  const v2 = {...v0, ...v1, horizontal: 'right', wrap: true, top: 'thin', fontStyle: 'Bold Italic', ...formatCells.derive({...v0, fontStyle: 'Bold Italic'}, ['fontStyle'])};
  const call = formatCells.toCommand(v2);
  const [fc, border] = call.batch;
  assert.equal(fc.command, 'home.formatCells');
  assert.equal(fc.params.style.numFmt, '"$"#,##0');
  assert.equal(fc.params.style.align.h, 'right');
  assert.equal(fc.params.style.font.italic, true);
  assert.equal(fc.params.style.font.name, undefined, 'unchanged settings are left alone');
  assert.deepEqual(border, {command: 'home.borders', params: {preset: 'top', style: 'thin'}});
  const depth = t.doc.undo.size;
  await t.batch(call.batch);
  assert.equal(t.doc.undo.size, depth + 1, 'OK is one undo step');
  assert.equal(text(t, 'A2'), '$1,235');
  assert.equal(style(t, 'A2').align.wrap, true);
  assert.equal(style(t, 'A2').borders.top.style, 'thin');
  assert.deepEqual(formatCells.validate({...v2, category: 'Custom', code: ''}).map(p => p.field), ['code']);
});

test('Row Height / Column Width / Standard Width dialogs', async () => {
  const t = await book();
  await run(t, 'home.rowHeight', {rows: '1:1', points: 18});
  await run(t, 'home.columnWidth', {cols: 'A:A', chars: 10});
  const ctx = t.session.readContext(t.docId);
  assert.equal(rowHeight.init(ctx).points, 18);
  assert.equal(columnWidth.init(ctx).chars, 10);
  assert.deepEqual(rowHeight.toCommand({points: 20}), {command: 'home.rowHeight', params: {points: 20}});
  assert.deepEqual(columnWidth.toCommand({chars: 9}), {command: 'home.columnWidth', params: {chars: 9}});
  assert.equal(rowHeight.validate({points: 500})[0].message, 'Row height must be between 0 and 409.5 points.');
  assert.equal(columnWidth.validate({chars: 300})[0].message, 'Column width must be between 0 and 255 characters.');
  // Standard Width is asked in characters (8.43 for 64 px) and kept in pixels.
  assert.equal(defaultWidth.init(ctx).width, 8.43);
  assert.deepEqual(defaultWidth.toCommand({width: 8.43}), {command: 'home.defaultWidth', params: {width: 64}});
  assert.deepEqual(defaultWidth.toCommand({width: 12}), {command: 'home.defaultWidth', params: {width: 89}});
});
