// U:grid/data: the models of the Data tab's dialogs (Sort, Sort Options, Advanced Filter, Remove
// Duplicates, Text to Columns, Data Validation, Consolidate, Scenario Manager, Add Scenario, Scenario
// Summary, Goal Seek, Data Table, Subtotal, Outline Settings, Group, Custom AutoFilter, Top 10), and the
// wiring of their controls and menus in the spec.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: crates/ui-egui/src/dialogs/data.rs (`sort`, `validation_defaults`,
//    `data_validation_fields`, `advanced_filter_form`, `remove_duplicates_range`: a block selection as
//    given, else the region) and dialogs.rs / analysis.rs (Text to Columns, Subtotal, Goal Seek).
//    Excel: the Sort dialog's levels, Data Validation's criteria labels following Allow and Data, the
//    wizard's three steps.
// 2. Ours: each model reads the selection when it opens, validates, and builds the upstream command.
// 3. These tests; the dialogs themselves are driven in tests/e2e/grid/data.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {session, workbook, run} from './edit-helpers.mjs';
import sortDialog from '../../core/grid/dialogs/sort.mjs';
import sortOptions from '../../core/grid/dialogs/sortOptions.mjs';
import advancedFilter from '../../core/grid/dialogs/advancedFilter.mjs';
import removeDuplicates from '../../core/grid/dialogs/removeDuplicates.mjs';
import textToColumns from '../../core/grid/dialogs/textToColumns.mjs';
import dataValidation, {criterionLabels} from '../../core/grid/dialogs/dataValidation.mjs';
import consolidate from '../../core/grid/dialogs/consolidate.mjs';
import scenarioManager from '../../core/grid/dialogs/scenarioManager.mjs';
import addScenario from '../../core/grid/dialogs/addScenario.mjs';
import goalSeek from '../../core/grid/dialogs/goalSeek.mjs';
import dataTable from '../../core/grid/dialogs/dataTable.mjs';
import subtotal from '../../core/grid/dialogs/subtotal.mjs';
import outlineSettings from '../../core/grid/dialogs/outlineSettings.mjs';
import customAutoFilter from '../../core/grid/dialogs/customAutoFilter.mjs';
import top10 from '../../core/grid/dialogs/top10AutoFilter.mjs';
import group from '../../core/grid/dialogs/group.mjs';
import scenarioSummary from '../../core/grid/dialogs/scenarioSummary.mjs';

const list = () => workbook([{id: 's1', name: 'Sheet1', blocks: {0: {
  A1: {v: 'Name'}, B1: {v: 'Dept'}, C1: {v: 'Qty'},
  A2: {v: 'cara'}, B2: {v: 'ops'}, C2: {v: 30}, A3: {v: 'Abe'}, B3: {v: 'dev'}, C3: {v: 10}, A4: {v: 'Bo'}, B4: {v: 'dev'}, C4: {v: 20},
  F1: {v: 'a b,c'},
}}}]);
const ctxOf = t => t.session.readContext(t.docId);

test('Sort: opens on the region with its headings and a level on the active column, builds data.sort', async () => {
  const t = await session(list());
  await run(t, 'selection.set', {cell: 'B3'});
  const v = sortDialog.init(ctxOf(t));
  assert.deepEqual([v.range, v.header, v.heads], ['A1:C4', true, ['Name', 'Dept', 'Qty']]);
  assert.deepEqual(v.levels, [{column: 'B', by: 'values', order: 'asc'}]);
  assert.ok(v.lists.length >= 5 && v.lists[0].list[0] === 'Sun', 'the built-in lists');
  const out = sortDialog.toCommand({...v, levels: [{column: 'B', by: 'values', order: 'desc'}, {column: 'C', by: 'cellColor', order: 'asc'}, {column: 'A', by: 'values', order: 'list:2'}], options: {caseSensitive: true, orientation: 'rows'}});
  assert.equal(out.command, 'data.sort');
  assert.deepEqual(out.params.keys.map(k => [k.column, k.order, k.by]), [['B', 'desc', 'values'], ['C', 'asc', 'cellColor'], ['A', 'asc', 'values']]);
  assert.equal(out.params.keys[2].customList[0], 'Jan');
  assert.equal(out.params.matchCase, true);
  await t.exec(out.command, {...out.params, keys: out.params.keys.slice(0, 2)});
  assert.deepEqual(sortDialog.validate({...v, levels: []}).map(p => p.field), ['levels']);
  assert.match(sortDialog.validate({...v, levels: [{column: 'A'}, {column: 'A'}]})[0].message, /different column/);
  // Left to right: the levels start over on the first row.
  const rows = sortDialog.derive({...v, options: {caseSensitive: false, orientation: 'columns'}}, ['options']);
  assert.deepEqual(rows.levels, [{column: '1', by: 'values', order: 'asc'}]);
  assert.deepEqual(sortDialog.toCommand({...v, ...rows, options: {caseSensitive: false, orientation: 'columns'}}).params.keys, [{row: 1, by: 'values', order: 'asc'}]);
  assert.deepEqual(sortOptions.derive({caseSensitive: true, orientation: 'columns'}), {value: {caseSensitive: true, orientation: 'columns'}});
});

test('Advanced Filter, Remove Duplicates and Subtotal read the region; a block selection is used as given', async () => {
  const t = await session(list());
  await run(t, 'selection.set', {cell: 'A2'});
  assert.equal(advancedFilter.init(ctxOf(t)).range, 'A1:C4');
  assert.equal(removeDuplicates.init(ctxOf(t)).range, 'A1:C4', 'the current region for a single cell');
  await run(t, 'selection.set', {range: 'A2:B3'});
  const rd = removeDuplicates.init(ctxOf(t));
  assert.equal(rd.range, 'A2:B3', 'a block selection as given');
  assert.deepEqual(rd.columns, ['A', 'B']);
  assert.deepEqual(removeDuplicates.toCommand({...rd, columns: ['B']}).params, {range: 'A2:B3', header: rd.header, columns: ['B']});
  assert.equal(removeDuplicates.validate({columns: []})[0].field, 'columns');
  const a = advancedFilter.init(ctxOf(t));
  assert.deepEqual(advancedFilter.validate({...a, action: 'copy', copyTo: ''}).map(p => p.field), ['copyTo']);
  assert.deepEqual(advancedFilter.toCommand({...a, criteria: ' E1:E2 ', action: 'copy', copyTo: 'H1', unique: true}).params, {range: 'A2:B3', unique: true, criteria: 'E1:E2', copyTo: 'H1'});
  const st = subtotal.init(ctxOf(t));
  assert.deepEqual(subtotal.toCommand({...st, groupBy: 'B', columns: ['C']}).params.groupBy, 'B');
});

test('Text to Columns: delimiters, qualifier, fixed breaks and column formats become data.textToColumns', async () => {
  const t = await session(list());
  await run(t, 'selection.set', {cell: 'F1'});
  const v = textToColumns.init(ctxOf(t));
  assert.deepEqual([v.range, v.lines, v.dataType, v.tab, v.destination], ['F1', ['a b,c'], 'delimited', true, 'F1']);
  assert.deepEqual(textToColumns.toCommand({...v, tab: false, comma: true, space: true, other: '|', treatConsecutive: true, textQualifier: '{none}', formats: ['general', 'skip', 'text']}).params,
    {range: 'F1', destination: 'F1', delimiters: [',', ' '], other: '|', treatConsecutive: true, textQualifier: 'none', columnFormats: ['general', 'skip', 'text']});
  const fixed = textToColumns.toCommand({...v, dataType: 'fixed', breaks: [5, 2]});
  assert.deepEqual(fixed.params.fixedWidths, [2, 5]);
  assert.equal(fixed.params.delimiters, undefined);
  assert.equal(textToColumns.validate({...v, tab: false})[0].field, 'tab');
  assert.equal(textToColumns.validate({...v, dataType: 'fixed', tab: false}).length, 0);
});

test('Data Validation: criteria labels follow Allow and Data, the dialog opens on the cell\'s rule and builds data.validation', async () => {
  assert.deepEqual(criterionLabels('whole', 'between'), ['Minimum:', 'Maximum:']);
  assert.deepEqual(criterionLabels('whole', 'greaterThan'), ['Minimum:', 'Maximum:']);
  assert.deepEqual(criterionLabels('whole', 'lessThan'), ['Maximum:', 'Maximum:']);
  assert.deepEqual(criterionLabels('whole', 'equal'), ['Value:', 'Maximum:']);
  assert.deepEqual(criterionLabels('date', 'between'), ['Start date:', 'End date:']);
  assert.deepEqual(criterionLabels('date', 'lessThan'), ['End date:', 'End date:']);
  assert.deepEqual(criterionLabels('time', 'equal'), ['Time:', 'End time:']);
  assert.deepEqual(criterionLabels('list', 'between'), ['Source:', '']);
  assert.deepEqual(criterionLabels('custom', 'between'), ['Formula:', '']);
  const t = await session(workbook());
  await run(t, 'selection.set', {range: 'A1:A3'});
  const fresh = dataValidation.init(ctxOf(t));
  assert.deepEqual([fresh.type, fresh.range, fresh.ignoreBlank, fresh.errorStyle], ['any', 'A1:A3', true, 'stop']);
  await run(t, 'data.validation', {range: 'A1:A3', type: 'list', formula1: 'x,y', inputMessage: 'pick', errorStyle: 'warning', dropdown: false});
  const v = dataValidation.init(ctxOf(t));
  assert.deepEqual([v.type, v.formula1, v.inputMessage, v.errorStyle, v.dropdown], ['list', 'x,y', 'pick', 'warning', false], 'OK without edits keeps the rule; the list shows without its quotes');
  const out = dataValidation.toCommand(v);
  assert.deepEqual(out.params, {range: 'A1:A3', type: 'list', ignoreBlank: true, showInput: true, showError: true, errorStyle: 'warning', formula1: 'x,y', dropdown: false, inputMessage: 'pick'});
  assert.deepEqual(dataValidation.toCommand({...v, type: 'whole', operator: 'notBetween', formula1: '1', formula2: '5'}).params.operator, 'notBetween');
  assert.equal(dataValidation.toCommand({...v, type: 'whole', operator: 'equal', formula1: '1', formula2: '5'}).params.formula2, undefined, 'only between needs a second bound');
  assert.deepEqual(dataValidation.validate({...v, type: 'whole', operator: 'between', formula1: '1', formula2: ''}).map(p => p.field), ['formula2']);
  assert.deepEqual(dataValidation.validate({...v, formula1: ''}).map(p => p.field), ['formula1']);
  assert.match(dataValidation.validate({...v, type: 'date', formula1: 'soon', operator: 'greaterThan'})[0].message, /Date not understood/);
  const clear = dataValidation.buttons['Clear All'](ctxOf(t), v);
  assert.deepEqual(clear, {command: 'data.validation', params: {range: 'A1:A3', clear: true}});
  await t.exec(clear.command, clear.params);
  assert.equal(t.content.sheets[0].validations.length, 0);
});

test('What-If, Consolidate and outline dialogs build their commands', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {B2: {v: 100}, B3: {v: 5}}}}]));
  await run(t, 'selection.set', {range: 'B2:B3'});
  const c = consolidate.init(ctxOf(t));
  assert.deepEqual([c.reference, c.destination, c.function], ['B2:B3', 'B2', 'sum']);
  assert.equal(consolidate.validate({...c, reference: '', references: []})[0].field, 'reference');
  assert.deepEqual(consolidate.toCommand({...c, reference: 'Sheet2!A1:B2', references: ['Sheet3!A1:B2'], leftColumn: true}).params,
    {sources: ['Sheet3!A1:B2', 'Sheet2!A1:B2'], destination: 'B2', function: 'sum', topRow: false, leftColumn: true});
  const a = addScenario.init(ctxOf(t));
  assert.equal(a.changing, 'B2:B3');
  assert.deepEqual(addScenario.validate(a).map(p => p.field), ['name']);
  assert.deepEqual(addScenario.toCommand({...a, name: ' Big ', vals: ['200', 'x'], edit: 'Big'}).params, {name: 'Big', changing: 'B2:B3', comment: '', values: [200, 'x'], replace: true});
  await run(t, 'data.scenarioAdd', {name: 'Base', changing: 'B2:B3'});
  const m = scenarioManager.init(ctxOf(t));
  assert.deepEqual([m.scenarios.map(x => x.name), m.selected], [['Base'], 0]);
  assert.deepEqual(scenarioSummary.toCommand({resultCells: ' B5 '}), {command: 'data.scenarioSummary', params: {resultCells: 'B5'}});
  const g = goalSeek.init(ctxOf(t));
  assert.equal(g.set, 'B2');
  assert.deepEqual(goalSeek.validate({...g, to: 'x', changing: ''}).map(p => p.field), ['to', 'changing']);
  assert.deepEqual(goalSeek.toCommand({set: ' B5 ', to: '1,200', changing: 'B2'}).params, {set: 'B5', to: 1200, changing: 'B2'});
  const d = dataTable.init(ctxOf(t));
  assert.equal(d.range, 'B2:B3');
  assert.equal(dataTable.validate(d)[0].message, 'Input cell reference is not valid.');
  assert.deepEqual(dataTable.toCommand({...d, columnInput: 'A1'}).params, {range: 'B2:B3', columnInput: 'A1'});
  assert.deepEqual(outlineSettings.toCommand({summaryBelow: false}).params, {summaryBelow: false, summaryRight: true});
  assert.deepEqual(group.toCommand({by: 'cols'}).params, {by: 'cols'});
  await run(t, 'data.group', group.toCommand({by: 'cols'}).params);
});

test('Custom AutoFilter and Top 10 build data.filterBy', () => {
  const v = customAutoFilter.init();
  assert.deepEqual(customAutoFilter.toCommand({...v, column: 'C', kind: 'number', op1: '>=', val1: '5', op2: '<=', val2: '9'}),
    {command: 'data.filterBy', params: {column: 'C', custom: {op: '>=', value: '5', and: true, op2: '<=', value2: '9'}}});
  assert.equal(customAutoFilter.toCommand({...v, join: 'or', op1: 'contains', val1: 'x'}).params.custom.and, false);
  assert.equal(customAutoFilter.toCommand({...v, kind: 'date', op1: '>', val1: '1/2/2026'}).params.custom.value, '46024', 'a date filters by its serial number');
  assert.deepEqual(customAutoFilter.validate({...v, op1: '>', val1: ''}).map(p => p.field), ['val1']);
  assert.deepEqual(customAutoFilter.validate({...v, op1: '=', val1: ''}), [], 'equals nothing means blanks');
  assert.match(customAutoFilter.validate({...v, kind: 'date', op1: '>', val1: 'later'})[0].message, /Date not understood/);
  assert.deepEqual(top10.toCommand({...top10.init(), column: 'C', side: 'bottom', count: 3, unit: 'percent'}).params, {column: 'C', top: {count: 3, bottom: true, percent: true}});
  assert.equal(top10.validate({count: 0})[0].field, 'count');
});

test('the Data tab is wired: every control that works is registered, the rest is hidden with a note', async () => {
  const t = await createTestSession('grid', {fixture: 'empty'});
  const reg = t.session.registry;
  for (const id of ['data.sort', 'data.removeDuplicates', 'data.textToColumns', 'data.validation', 'data.consolidate', 'data.goalSeek', 'data.scenarioManager', 'data.dataTable', 'data.advancedFilter', 'data.subtotal', 'data.outlineSettings']) {
    assert.ok(reg.has(id), id);
    assert.ok(reg.get(id).dialog, `${id} opens its dialog without params`);
  }
  assert.ok(reg.has('data.autoOutline'), 'Auto Outline is built (U:grid/data)');
  assert.ok(reg.has('data.clearOutline'), 'Clear Outline is built (U:grid/data)');
  const state = id => t.session.state(t.docId, id, {});
  assert.equal(state('data.filter').checked, false);
  assert.equal(state('data.clearFilter').enabled, false, 'Clear is off while no filter is applied');
  await run(t, 'cell.set', {cell: 'A1', input: 'h'});
  await run(t, 'cell.set', {cell: 'A2', input: '1'});
  await run(t, 'selection.set', {cell: 'A1'});
  await run(t, 'data.filter', {});
  assert.equal(state('data.filter').checked, true);
  assert.equal(state('data.reapply').enabled, true);
  assert.equal(state('data.clearFilter').enabled, false);
  await run(t, 'data.filterBy', {column: 'A', byCell: true});
  assert.equal(state('data.clearFilter').enabled, true);
});

test('the cell right-click menu has Excel\'s Filter and Sort submenus on commands that exist', async () => {
  const fs = await import('node:fs');
  const spec = JSON.parse(fs.readFileSync(new URL('../../docs/spec/grid.json', import.meta.url), 'utf8'));
  const cell = spec.contextMenus.find(m => m.target === 'cell');
  const sub = label => cell.items.find(i => i && typeof i === 'object' && i.label === label);
  assert.deepEqual(sub('Filter').items.map(i => i.label), ["Filter by Selected Cell's Value", 'Clear Filter From Column', 'Reapply']);
  assert.deepEqual(sub('Sort').items.map(i => i.label), ['Sort A to Z', 'Sort Z to A', 'Custom Sort\u2026']);
  const t = await createTestSession('grid', {fixture: 'empty'});
  for (const i of [...sub('Filter').items, ...sub('Sort').items]) assert.ok(i.dialog || t.session.registry.has(i.command), i.label);
  // Filter by Selected Cell's Value filters on the active cell's shown text, installing the filter.
  await run(t, 'cell.set', {cell: 'A1', input: 'h'});
  await run(t, 'cell.set', {cell: 'A2', input: 'x'});
  await run(t, 'cell.set', {cell: 'A3', input: 'y'});
  await run(t, 'selection.set', {cell: 'A2'});
  await run(t, 'data.filterBy', {byCell: true, range: 'A1:A3'});
  assert.deepEqual(Object.keys(t.content.sheets[0].rows ?? {}), ['2'], 'y is hidden');
  await run(t, 'data.filterBy', {byCell: true, clear: true});
  assert.deepEqual(Object.keys(t.content.sheets[0].rows ?? {}), [], 'clearing shows it again');
});
