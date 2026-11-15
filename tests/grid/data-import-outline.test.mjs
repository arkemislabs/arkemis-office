// U:grid/data: From Text/CSV and Get Data (a text file loaded into a new sheet as a table), Auto Outline and Clear Outline.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/extra/data.rs (`get_data`: CSV or TSV text, or a JSON array of objects, into a new sheet table named
//    after the source) and the csv.rs reader (decode, sniff the delimiter, RFC 4180 records). Auto Outline and Clear Outline are Excel's own: gridcraft
//    has Group and Ungroup only. Not checked against upstream.
// 2. Ours: data.fromTextCsv, data.getData (core/grid/commands/data/import.mjs), data.autoOutline, data.clearOutline (data/autooutline.mjs).
// 3. These tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import {session, workbook, run, fails, v, text} from './edit-helpers.mjs';
import fromTextCsv from '../../core/grid/dialogs/fromTextCsv.mjs';
import {sourceName, delimiterOf, rowsOfText} from '../../core/grid/commands/data/import.mjs';
import {groupsFromEdges, levelsOf} from '../../core/grid/commands/data/autooutline.mjs';

const named = name => workbook([{id: 's1', name: 'Sheet1'}], {}).sheets.find(s => s.name === name);

test('From Text/CSV loads typed values into a new sheet after the active one as a table named after the file', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  const r = await run(t, 'data.fromTextCsv', {text: 'Name,Qty,When\r\nApples,10,1/15/2026\r\n"Pears, ripe",8,\r\n', name: 'C:\\data\\sales report.csv'});
  assert.deepEqual([r.sheet, r.table, r.rows, r.columns, r.range], ['sales report', 'sales_report', 2, 3, 'A1:C3']);
  assert.equal(t.content.sheets[1].name, 'sales report');
  assert.equal(text(t, 'A1', 1), 'Name');
  assert.equal(v(t, 'B2', 1), 10, 'numbers are numbers');
  assert.equal(typeof v(t, 'C2', 1), 'number', 'dates are dates');
  assert.equal(text(t, 'A3', 1), 'Pears, ripe', 'a quoted comma stays');
  assert.equal(t.content.sheets[1].tables[0].name, 'sales_report');
  assert.equal(t.session.get(t.docId).file.content.sheets.length, 2);
});

test('the delimiter is detected, named or a character; bytes are decoded; a second import gets a free name', async () => {
  assert.equal(delimiterOf('', 'a;b;c\n1;2;3\n'), ';');
  assert.equal(delimiterOf('tab', ''), '\t');
  assert.equal(delimiterOf('|', ''), '|');
  assert.throws(() => delimiterOf('banana', ''), /delimiter/);
  assert.deepEqual(rowsOfText('a|b\n1|2', '|'), [['a', 'b'], ['1', '2']]);
  assert.equal(sourceName('data/2026 sales!.csv'), '2026 sales');
  assert.equal(sourceName(''), 'Table');
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  const bytes = Buffer.from('\ufeffname;n\nc\u00e9dric;1\n', 'utf8').toString('base64');
  const a = await run(t, 'data.fromTextCsv', {data: bytes, name: 'people.csv'});
  assert.equal(text(t, 'A2', 1), 'c\u00e9dric');
  const b = await run(t, 'data.fromTextCsv', {text: 'x,y\n1,2', name: 'people.csv', delimiter: 'comma'});
  assert.equal(a.sheet, 'people');
  assert.equal(b.sheet, 'people (2)');
  assert.equal(b.table, 'people_2');
  assert.equal(t.content.sheets.length, 3);
});

test('Get Data also takes a JSON array of objects, and refuses empty or oversized input', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  const r = await run(t, 'data.getData', {text: '[{"a":1,"b":"x"},{"a":2,"c":true}]', name: 'items.json'});
  assert.deepEqual([r.columns, r.rows], [3, 2]);
  assert.deepEqual(['A1', 'B1', 'C1'].map(c => text(t, c, 1)), ['a', 'b', 'c']);
  assert.equal(v(t, 'A3', 1), 2);
  assert.match((await fails(t, 'data.fromTextCsv', {text: '  \n'})).message, /empty/);
  assert.match((await fails(t, 'data.fromTextCsv', {})).message, /text. or .data/);
});

test('the From Text/CSV dialog needs a file and sends its text, name and delimiter', async () => {
  const d = fromTextCsv.init({});
  assert.equal(fromTextCsv.validate(d)[0].field, 'text');
  assert.deepEqual(fromTextCsv.toCommand({...d, text: 'a,b\n1,2', name: 'x.csv', delimiter: 'comma'}), {command: 'data.fromTextCsv', params: {text: 'a,b\n1,2', name: 'x.csv', delimiter: 'comma'}});
});

test('Auto Outline groups the rows a formula adds up and nests subtotals under a grand total', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: [
    ['Item', 'Q1'], ['a', 1], ['b', 2], ['c', 3], ['Sub1', '=SUM(B2:B4)'], ['d', 4], ['e', 5], ['Sub2', '=SUM(B6:B7)'], ['Total', '=B5+B8'],
  ]});
  const r = await run(t, 'data.autoOutline', {});
  assert.equal(r.levels, 2);
  const rows = t.content.sheets[0].rows;
  const level = n => rows?.[n - 1]?.outline ?? 0;
  assert.deepEqual([2, 3, 4].map(level), [2, 2, 2], 'detail under Sub1');
  assert.equal(level(5), 1, 'Sub1 is a summary inside the total');
  assert.deepEqual([6, 7].map(level), [2, 2]);
  assert.equal(level(8), 1);
  assert.equal(level(9), 0, 'the grand total is outside');
  assert.equal(level(1), 0);
  // The outline buttons work on what it made.
  await run(t, 'data.showLevels', {rows: 1});
  assert.equal(t.content.sheets[0].rows[1].hidden, true);
});

test('Auto Outline groups columns the same way, and Summary rows above detail flips the rows', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: [['x', 1, 2, 3, '=SUM(B1:D1)'], ['y', 4, 5, 6, '=SUM(B2:D2)']]});
  const r = await run(t, 'data.autoOutline', {});
  assert.equal(r.columns, 3);
  const cols = t.content.sheets[0].cols;
  assert.deepEqual([1, 2, 3].map(c => cols[c].outline), [1, 1, 1]);
  assert.equal(cols[4]?.outline, undefined);
  const u = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(u, 'range.setValues', {range: 'A1', values: [['Sub', '=SUM(B2:B4)'], ['a', 1], ['b', 2], ['c', 3]]});
  assert.match((await fails(u, 'data.autoOutline', {})).message, /Cannot create an outline/, 'summary below by default: a total above its detail is not one');
  await run(u, 'data.outlineSettings', {summaryBelow: false});
  await run(u, 'data.autoOutline', {});
  assert.deepEqual([2, 3, 4].map(n => u.content.sheets[0].rows[n - 1].outline), [1, 1, 1]);
});

test('Auto Outline replaces the outline that was there; Clear Outline removes it and the collapse marks', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: [[1], [2], ['=SUM(A1:A2)'], [9], [10], [11]]});
  await run(t, 'data.group', {rows: '4:6'});
  await run(t, 'data.autoOutline', {});
  const rows = () => t.content.sheets[0].rows ?? {};
  assert.equal(rows()[3]?.outline, undefined, 'the old group is gone');
  assert.equal(rows()[0].outline, 1);
  await run(t, 'data.hideDetail', {rows: '1:2'});
  assert.equal(rows()[0].hidden, true);
  const c = await run(t, 'data.clearOutline', {});
  assert.ok(c.cleared >= 2);
  assert.equal(rows()[0].outline, undefined);
  assert.equal(rows()[2]?.collapsed, undefined);
  assert.equal(rows()[0].hidden, true, 'rows that were hidden stay hidden');
  assert.match((await fails(t, 'data.clearOutline', {})).message, /no outline/);
});

test('the grouping helpers: nested summaries share their detail, levels add up', () => {
  const groups = groupsFromEdges([[4, 1, 3], [7, 5, 6], [8, 4, 7]], false);
  assert.deepEqual(groups, [{start: 1, end: 3}, {start: 5, end: 6}, {start: 1, end: 7}]);
  assert.deepEqual([...levelsOf(groups)].sort((x, y) => x[0] - y[0]), [[1, 2], [2, 2], [3, 2], [4, 1], [5, 2], [6, 2], [7, 1]]);
  assert.deepEqual(groupsFromEdges([[0, 1, 3]], true), [{start: 1, end: 3}]);
  assert.deepEqual(groupsFromEdges([[2, 5, 6]], false), [{start: 5, end: 1}].slice(1), 'a reference below a summary-below formula is not detail');
  assert.ok(named('Sheet1'));
});
