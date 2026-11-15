// U:grid/data: what the Data tab stores survives .xlsx: an AutoFilter with every kind of criterion
// (values, custom, top 10, above average, colour, icon) and the rows it hid, data validations with
// their messages and list sources, outline levels with collapsed marks and the summary settings, and
// the scenarios (a hidden workbook name).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: crates/xlsx sheet_read/parts.rs `read_autofilter` and sheet_write/parts.rs
//    `autofilter_xml` (filterColumn: filters, customFilters, top10, dynamicFilter, colorFilter,
//    iconFilter), rules.rs data validation, sheet_read `outlineLevel`/`collapsed`/outlinePr. Excel
//    stores them the same way (a begins-with filter is an equal filter with `abc*`).
// 2. Ours writes the stored shapes of lib/data-filter.mjs and reads them back unchanged.
// 3. These tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {validateContent} from '../../core/grid/schema.mjs';
import {session, workbook, v, run} from './edit-helpers.mjs';
import {loadScenarios} from '../../core/grid/commands/whatif/scenarios.mjs';

async function roundTrip(content) {
  const bytes = await writeXlsx(content);
  const zip = await JSZip.loadAsync(bytes);
  const read = await readXlsx(bytes);
  return {zip, read, sheetXml: await zip.file('xl/worksheets/sheet1.xml').async('string')};
}

test('an AutoFilter with every kind of criterion round trips with its hidden rows', async () => {
  const content = workbook([{id: 's1', name: 'Sheet1', blocks: {0: {
    A1: {v: 'a'}, B1: {v: 'b'}, C1: {v: 'c'}, D1: {v: 'd'}, E1: {v: 'e'}, F1: {v: 'f'},
    A2: {v: 'x'}, B2: {v: 1}, C2: {v: 5}, D2: {v: 'abc'}, E2: {v: 3}, F2: {v: 'p'},
    A3: {v: 'y'}, B3: {v: 2}, C3: {v: 9}, D3: {v: 'xbc'}, E3: {v: 4}, F3: {v: 'q'},
  }}, rows: {2: {hidden: true}},
  autofilter: {range: 'A1:F3', criteria: {
    0: {type: 'values', values: ['x', 'z'], blanks: true},
    1: {type: 'custom', a: ['>', '1'], b: ['<=', '9'], and: true},
    2: {type: 'top10', bottom: true, percent: true, count: 40},
    3: {type: 'custom', a: ['beginsWith', 'a'], and: false},
    4: {type: 'aboveAverage', above: false},
    5: {type: 'fillColor', color: '#FF0000'},
  }}}], {styles: [{}]});
  const {sheetXml, read} = await roundTrip(content);
  assert.match(sheetXml, /<autoFilter ref="A1:F3"><filterColumn colId="0"><filters blank="1"><filter val="x"\/><filter val="z"\/><\/filters><\/filterColumn>/);
  assert.match(sheetXml, /<customFilters and="1"><customFilter operator="greaterThan" val="1"\/><customFilter operator="lessThanOrEqual" val="9"\/><\/customFilters>/);
  assert.match(sheetXml, /<top10 top="0" percent="1" val="40"\/>/);
  assert.match(sheetXml, /<customFilter val="a\*"\/>/, 'begins with is an equal filter with a wildcard, as Excel stores it');
  assert.match(sheetXml, /<dynamicFilter type="belowAverage"\/>/);
  assert.match(sheetXml, /<colorFilter dxfId="0"\/>/);
  const af = read.sheets[0].autofilter;
  assert.equal(af.range, 'A1:F3');
  assert.deepEqual(af.criteria[0], {type: 'values', values: ['x', 'z'], blanks: true});
  assert.deepEqual(af.criteria[1], {type: 'custom', a: ['>', '1'], b: ['<=', '9'], and: true});
  assert.deepEqual(af.criteria[2], {type: 'top10', bottom: true, percent: true, count: 40});
  assert.deepEqual(af.criteria[3], {type: 'custom', a: ['=', 'a*'], and: false});
  assert.deepEqual(af.criteria[4], {type: 'aboveAverage', above: false});
  assert.equal(af.criteria[5].type, 'fillColor');
  assert.equal(String(af.criteria[5].color).toUpperCase().slice(-6), 'FF0000');
  assert.equal(read.sheets[0].rows[2].hidden, true, 'the rows the filter hid stay hidden');
  validateContent(read);
});

test('a filtered table keeps its criteria inside the table part', async () => {
  const content = workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 'k'}, A2: {v: 'x'}, A3: {v: 'y'}}},
    tables: [{name: 'T1', range: 'A1:A3', headerRow: true, columns: [{name: 'k'}]}],
    autofilter: {range: 'A1:A3', criteria: {0: {type: 'values', values: ['x'], blanks: false}}}, rows: {2: {hidden: true}}}]);
  const {zip, read, sheetXml} = await roundTrip(content);
  assert.doesNotMatch(sheetXml, /<autoFilter/, 'one filter, on the table');
  const table = await zip.file('xl/tables/table1.xml').async('string');
  assert.match(table, /<autoFilter ref="A1:A3"><filterColumn colId="0"><filters><filter val="x"\/>/);
  assert.deepEqual(read.sheets[0].autofilter.criteria[0], {type: 'values', values: ['x'], blanks: false});
});

test('data validations round trip with messages, operators and list sources', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'data.validation', {range: 'A1:A3', type: 'whole', operator: 'between', formula1: '1', formula2: '10', inputTitle: 'Qty', inputMessage: 'one to ten', errorStyle: 'warning', errorTitle: 'Oops', errorMessage: 'no'});
  await run(t, 'data.validation', {range: 'B1', type: 'list', formula1: 'Open,Closed', dropdown: false, ignoreBlank: false});
  await run(t, 'data.validation', {range: 'C1', type: 'list', formula1: '=$E$1:$E$3'});
  await run(t, 'data.validation', {range: 'D1', type: 'date', operator: 'greaterThan', formula1: '2026-01-01', showInput: false});
  const {sheetXml, read} = await roundTrip(t.content);
  assert.match(sheetXml, /<dataValidation type="whole" errorStyle="warning" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorTitle="Oops" error="no" promptTitle="Qty" prompt="one to ten" sqref="A1:A3"><formula1>1<\/formula1><formula2>10<\/formula2>/);
  assert.match(sheetXml, /<formula1>"Open,Closed"<\/formula1>/);
  const byRange = r => read.sheets[0].validations.find(x => x.ranges.includes(r));
  assert.deepEqual([byRange('A1:A3').operator ?? 'between', byRange('A1:A3').errorStyle, byRange('A1:A3').prompt, byRange('A1:A3').error], ['between', 'warning', 'one to ten', 'no']);
  assert.equal(byRange('B1').inCellDropdown, false);
  assert.equal(byRange('B1').formula1, '"Open,Closed"');
  assert.equal(byRange('C1').formula1, '$E$1:$E$3');
  assert.equal(byRange('D1').operator, 'greaterThan');
  assert.equal(byRange('D1').formula1, '46023');
  assert.equal(byRange('D1').showInputMessage, undefined);
});

test('outline levels, collapsed marks and summary settings round trip', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 1}}}}]));
  await run(t, 'data.group', {rows: '2:5'});
  await run(t, 'data.group', {rows: '3:4'});
  await run(t, 'data.group', {cols: 'B:C'});
  await run(t, 'data.hideDetail', {rows: '3:4'});
  await run(t, 'data.outlineSettings', {summaryBelow: false});
  const {sheetXml, read} = await roundTrip(t.content);
  assert.match(sheetXml, /<outlinePr summaryBelow="0"\/>/);
  assert.match(sheetXml, /outlineLevelRow="2" outlineLevelCol="1"/);
  const rows = read.sheets[0].rows;
  assert.deepEqual([1, 2, 3, 4].map(i => rows[i].outline), [1, 2, 2, 1]);
  assert.equal(rows[2].hidden, true);
  assert.equal(read.sheets[0].cols[1].outline, 1);
  assert.equal(read.sheets[0].summaryBelow, false);
  assert.equal(read.sheets[0].rows[1].collapsed, true, 'the + mark sits on the summary line above the inner group');
});

test('scenarios are saved in a hidden workbook name and come back', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'B2', values: [[100], ['text, with "quotes"']]});
  await run(t, 'data.scenarioAdd', {name: 'Base', changing: 'B2:B3', comment: 'the plan'});
  await run(t, 'data.scenarioAdd', {name: 'High', changing: 'B2', values: [200]});
  const {zip, read} = await roundTrip(t.content);
  const wbxml = await zip.file('xl/workbook.xml').async('string');
  assert.match(wbxml, /<definedName name="_sc_scenarios" comment="[^"]*" hidden="1">"/);
  const list = loadScenarios(read);
  assert.deepEqual(list.map(x => [x.name, x.changing, x.comment]), [['Base', 'B2,B3', 'the plan'], ['High', 'B2', '']]);
  assert.deepEqual(list[0].values, [100, 'text, with "quotes"']);
  const again = await session(read);
  await run(again, 'data.scenarioShow', {name: 'High'});
  assert.equal(v(again, 'B2'), 200);
});

test('a long scenario list is written as pieces of at most 250 characters', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  for (let i = 0; i < 8; i++) await run(t, 'data.scenarioAdd', {name: `Scenario number ${i}`, changing: 'B2:B3', values: [i, i * 2], comment: 'x'.repeat(60)});
  const formula = t.content.names.find(n => n.name === '_sc_scenarios').formula;
  assert.ok(formula.includes('"&"'));
  assert.ok(formula.split('"&"').every(p => p.replaceAll('""', '"').length <= 252), 'pieces of at most 250 characters once the doubled quotes are one');
  assert.equal(loadScenarios(t.content).length, 8);
  const {read} = await roundTrip(t.content);
  assert.equal(loadScenarios(read).length, 8);
});
