// U:grid/main: Fill Across Worksheets, the Data Validation "apply to all cells with the same settings" box, the Standard Width
// units, the web page save, and Help. Office behaviour (not in gridcraft: not checked against upstream).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, v, text, stored, style, run, fails} from './edit-helpers.mjs';
import fillAcross from '../../core/grid/dialogs/fillAcrossWorksheets.mjs';
import dataValidation from '../../core/grid/dialogs/dataValidation.mjs';
import addView from '../../core/grid/dialogs/addView.mjs';
import help from '../../core/grid/dialogs/help.mjs';
import {write as writeHtml} from '../../core/grid/formats/html-write.mjs';
import {write as writePdf} from '../../core/grid/formats/pdf-write.mjs';
import {PDFDocument} from 'pdf-lib';
import {createTestHost} from '../../core/kernel/host.mjs';
import mergeStylesDialog from '../../core/grid/dialogs/mergeStyles.mjs';
import {saveType} from '../../core/common/commands/file.mjs';

const three = () => workbook([{id: 's1', name: 'Sheet1'}, {id: 's2', name: 'Sheet2'}, {id: 's3', name: 'Sheet3'}]);

async function seeded() {
  const t = await session(three());
  await run(t, 'cell.set', {cell: 'A1', input: 'North'});
  await run(t, 'cell.set', {cell: 'B1', input: '=A2*2'});
  await run(t, 'cell.set', {cell: 'A2', input: '21'});
  await run(t, 'home.bold', {range: 'A1'});
  await run(t, 'cell.set', {sheet: 'Sheet2', cell: 'A1', input: 'old'});
  await run(t, 'cell.set', {sheet: 'Sheet2', cell: 'A2', input: '5'});
  return t;
}

test('Fill Across Worksheets copies the cells to the other sheets, with formulas reading their own sheet', async () => {
  const t = await seeded();
  assert.equal((await fails(t, 'edit.fillAcrossSheets', {range: 'A1:B2', what: 'nonsense'})).code, 'invalid_params');
  await expectUndoRoundTrip(t, 'edit.fillAcrossSheets', {range: 'A1:B2'});
  const r = await run(t, 'edit.fillAcrossSheets', {range: 'A1:B2'});
  assert.deepEqual(r.sheets, ['Sheet2', 'Sheet3']);
  assert.equal(v(t, 'Sheet2!A1'), 'North');
  assert.equal(v(t, 'Sheet3!A2'), 21);
  assert.equal(stored(t, 'B1', 1).f, 'A2*2', 'the formula is the same text, so it reads Sheet2 A2');
  assert.equal(v(t, 'Sheet2!B1'), 42);
});

test('Fill Across Worksheets: Contents keeps the formats of the other sheets, Formats keeps their contents, a chosen sheet only', async () => {
  const t = await seeded();
  const before = stored(t, 'A1', 0);
  assert.ok(before.s, 'A1 is bold');
  await run(t, 'edit.fillAcrossSheets', {range: 'A1', what: 'contents', sheets: ['Sheet3']});
  assert.equal(v(t, 'Sheet3!A1'), 'North');
  assert.equal(stored(t, 'A1', 1)?.v, 'old', 'Sheet2 was not chosen');
  assert.equal(stored(t, 'A1', 2)?.s ?? 0, 0, 'Contents leaves the formats of the target');
  await run(t, 'edit.fillAcrossSheets', {range: 'A1', what: 'formats', sheets: ['Sheet2']});
  assert.equal(stored(t, 'A1', 1).s, before.s);
  assert.equal(v(t, 'Sheet2!A1'), 'old', 'Formats leaves the contents of the target');
});

test('Fill Across Worksheets needs another sheet, and its dialog lists the others', async () => {
  const one = await session(workbook());
  const e = await fails(one, 'edit.fillAcrossSheets', {range: 'A1'});
  assert.ok(e);
  const t = await seeded();
  const ctx = {doc: t.content, selection: t.doc.selection};
  const init = fillAcross.init(ctx);
  assert.deepEqual(init.others, ['Sheet2', 'Sheet3']);
  assert.deepEqual(fillAcross.toCommand({...init, fill: 'Formats', targets: ['Sheet3']}), {command: 'edit.fillAcrossSheets', params: {what: 'formats', sheets: ['Sheet3']}});
  assert.equal(fillAcross.validate({...init, targets: []})[0].field, 'targets');
});

test('Data Validation: apply to all other cells with the same settings', async () => {
  const t = await session(workbook());
  const rule = {type: 'whole', operator: 'between', formula1: '1', formula2: '9'};
  await run(t, 'data.validation', {...rule, range: 'A1:A3'});
  await run(t, 'data.validation', {...rule, range: 'C1:C3'});
  await run(t, 'data.validation', {type: 'list', formula1: 'x,y', range: 'E1'});
  await run(t, 'selection.set', {cell: 'A1'});
  await run(t, 'data.validation', {range: 'A1', type: 'whole', operator: 'between', formula1: '1', formula2: '50', applyToSame: true});
  const rules = t.content.sheets[0].validations;
  const whole = rules.filter(r => r.type === 'whole');
  assert.ok(whole.length >= 1 && whole.every(r => r.formula2 === '50'), JSON.stringify(rules));
  assert.equal(whole.flatMap(r => r.ranges).sort().join(), 'A1:A3,C1:C3');
  assert.equal(rules.find(r => r.type === 'list').formula1, '"x,y"', 'a rule with other settings is left alone');
  const init = dataValidation.init({doc: t.content, selection: t.doc.selection});
  assert.equal(init.applyToSame, false);
  assert.equal(dataValidation.toCommand({...init, applyToSame: true}).params.applyToSame, true);
  assert.equal(dataValidation.toCommand(init).params.applyToSame, undefined);
});

test('Save a copy as a web page writes the sheet as an HTML table', async () => {
  const t = await session(workbook());
  await run(t, 'cell.set', {cell: 'A1', input: 'Tom & <Jerry>'});
  await run(t, 'cell.set', {cell: 'B1', input: '12.5'});
  const html = new TextDecoder().decode(writeHtml({content: t.content}));
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<title>Sheet1<\/title>/);
  assert.match(html, /Tom &amp; &lt;Jerry&gt;/);
  assert.match(html, /<td[^>]*>12\.5<\/td>/);
  assert.equal(saveType('grid', 'html').exts[0], 'htm');
});

test('Help is a command with a dialog', async () => {
  const t = await session(workbook());
  assert.deepEqual(await run(t, 'help.open', {search: 'sort'}), {search: 'sort'});
  assert.deepEqual(help.toCommand({search: 'bold'}), {command: 'help.open', params: {search: 'bold'}});
  assert.equal(style(t, 'A1').font.bold ?? false, false);
  assert.equal(text(t, 'A1'), '');
});

test('Add View asks for a name and saves the view under it', async () => {
  const t = await session(workbook());
  assert.equal(addView.validate({name: '  '})[0].field, 'name');
  assert.deepEqual(addView.validate({name: 'Review'}), []);
  const call = addView.toCommand({name: ' Review '});
  assert.deepEqual(call, {command: 'view.customViews', params: {save: 'Review'}});
  await run(t, call.command, call.params);
  assert.deepEqual(Object.keys(t.content.customViews), ['Review']);
});

test('Export as PDF writes the print pages of the sheet', async () => {
  const t = await session(workbook());
  await assert.rejects(() => writePdf({content: t.content}), /nothing to print/);
  await run(t, 'cell.set', {cell: 'A1', input: 'Region'});
  await run(t, 'cell.set', {cell: 'B1', input: '12.5'});
  await run(t, 'cell.set', {cell: 'A2', input: 'Café 中'});
  await run(t, 'home.bold', {range: 'A1:B1'});
  await run(t, 'home.fillColor', {range: 'A1:B1', color: '#FFE699'}).catch(() => {});
  await run(t, 'pageLayout.headerFooter', {header: '&CReport &A', footer: '&RPage &P of &N'}).catch(() => {});
  const bytes = await writePdf({content: t.content, title: 'Budget'});
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
  assert.deepEqual(doc.getPage(0).getSize(), {width: 612, height: 792});
  assert.equal(doc.getTitle(), 'Budget');
  // Many rows run on to more pages.
  for (let r = 1; r <= 120; r++) await run(t, 'cell.set', {cell: 'D' + r, input: String(r)});
  const long = await PDFDocument.load(await writePdf({content: t.content}));
  assert.ok(long.getPageCount() >= 2, 'a long sheet prints on more pages');
});

test('Export as PDF draws the pictures, charts and shapes on the sheet', async () => {
  const t = await session(workbook());
  for (let r = 1; r <= 4; r++) { await run(t, 'cell.set', {cell: `A${r}`, input: `R${r}`}); await run(t, 'cell.set', {cell: `B${r}`, input: String(r * 10)}); }
  const plain = await writePdf({content: t.content});
  await run(t, 'insert.chart', {range: 'A1:B4', type: 'column', at: 'D2'});
  await run(t, 'insert.shape', {kind: 'ellipse', at: 'A8', text: 'Hi'});
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';
  await run(t, 'insert.picture', {base64: png, at: 'C8', width: 60, height: 60});
  const full = await writePdf({content: t.content});
  assert.ok(full.length > plain.length + 400, 'the objects add drawing to the page');
  assert.match(new TextDecoder('latin1').decode(full), /\/Subtype\s*\/Image/, 'the picture is an image in the PDF');
  assert.equal((await PDFDocument.load(full)).getPageCount() >= 1, true);
});

test('Merge Styles brings the custom styles of another workbook in, keeping same-named ones unless asked', async () => {
  const theirs = [{name: 'Loud', style: {font: {bold: true}}}, {name: 'Mine', style: {font: {italic: true}}}];
  const host = createTestHost({peerStyles: {list: async () => [{id: 'other', title: 'Other', current: false}], get: async id => (id === 'other' ? theirs : [])}});
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}], {cellStyles: [{name: 'Mine', style: {font: {bold: true}}}]}), {host});
  const r = await run(t, 'home.mergeStyles', {from: 'other'});
  assert.deepEqual([r.added, r.replaced, r.skipped], [1, 0, 1]);
  assert.deepEqual(t.content.cellStyles.map(x => x.name), ['Mine', 'Loud']);
  assert.equal(t.content.cellStyles[0].style.font.bold, true, 'the same-named style was kept');
  const r2 = await run(t, 'home.mergeStyles', {from: 'other', replace: true});
  assert.deepEqual([r2.added, r2.replaced], [0, 2]);
  assert.equal(t.content.cellStyles[0].style.font.italic, true);
  assert.equal((await fails(t, 'home.mergeStyles', {})).code, 'failed');
  assert.equal(mergeStylesDialog.validate({from: null})[0].field, 'from');
  assert.deepEqual(mergeStylesDialog.toCommand({from: 'x', replace: true}), {command: 'home.mergeStyles', params: {from: 'x', replace: true}});
});

test('Sheet Views: New, Keep, Exit, Select, Rename, Duplicate and Delete keep the filter and hidden rows of each view', async () => {
  const t = await session(workbook());
  for (let r = 1; r <= 4; r++) await run(t, 'cell.set', {cell: 'A' + r, input: String(r)});
  const hiddenRows = () => Object.entries(t.content.sheets[0].rows ?? {}).filter(([, v]) => v.hidden).map(([k]) => Number(k));
  await run(t, 'home.hideRows', {rows: '2'}).catch(async () => run(t, 'selection.set', {range: 'A2'}).then(() => run(t, 'home.hideRows', {})));
  assert.deepEqual(hiddenRows(), [1], 'Default has row 2 hidden');
  const list = (await t.exec('view.sheetViewSelect', {})).result;
  assert.deepEqual(list, {views: [], active: null});
  assert.equal((await run(t, 'view.sheetViewNew', {})).active, 'View1');
  await run(t, 'selection.set', {range: 'A3'});
  await run(t, 'home.hideRows', {});
  assert.deepEqual(hiddenRows(), [1, 2]);
  await run(t, 'view.sheetViewKeep', {});
  await run(t, 'home.unhideRows', {rows: '2:4'}).catch(() => {});
  await run(t, 'view.sheetViewExit', {});
  assert.deepEqual(hiddenRows(), [1], 'Exit shows the sheet as Default had it');
  await run(t, 'view.sheetViewSelect', {name: 'View1'});
  assert.deepEqual(hiddenRows(), [1, 2], 'the kept view comes back');
  await run(t, 'view.sheetViewOptions', {action: 'rename', name: 'Mine'});
  await run(t, 'view.sheetViewOptions', {action: 'duplicate'});
  assert.deepEqual(Object.keys(t.content.sheets[0].sheetViews), ['Mine', 'Mine copy']);
  await run(t, 'view.sheetViewOptions', {action: 'delete'});
  assert.deepEqual(Object.keys(t.content.sheets[0].sheetViews), ['Mine copy']);
  assert.deepEqual(hiddenRows(), [1], 'deleting the view being viewed returns to Default');
  assert.equal((await fails(t, 'view.sheetViewSelect', {name: 'Nope'})).code, 'invalid_params');
  assert.equal((await fails(t, 'view.sheetViewKeep', {})).code, 'disabled');
});
