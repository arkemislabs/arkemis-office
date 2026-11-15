// U:grid/data: Sort, Filter (AutoFilter), Remove Duplicates, Text to Columns, Data Validation,
// Group / Subtotal / outline, and the What-If tools (Goal Seek, Scenario Manager, Data Table,
// Advanced Filter, Consolidate), each with its undo round trip.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/data.rs and cmd/data/{sort,filter,tools,validation,
//    grouping}.rs, outline.rs, cmd/whatif.rs and cmd/whatif/{advanced_filter,consolidate,scenarios}.rs
//    (their tests are ported below). Excel: Sort keeps rows whole (formulas follow their row),
//    blanks last, AutoFilter hides rows and Filter again shows them, Remove Duplicates keeps the
//    first of each run, Text to Columns splits at delimiters or fixed positions, validation checks
//    typed values and lists drop-down items, Group/Subtotal build an outline with summary rows,
//    Goal Seek / Data Table / Scenarios / Advanced Filter / Consolidate as the Data tab does.
// 2. Ours runs those commands through the translated model and writes through the kernel, one undo
//    step each; the .xlsx round trip of every stored shape is in tests/grid/data-xlsx.test.mjs.
// 3. These tests; the bridge E2E tests/e2e/grid/data.e2e.mjs drives the same flows from the ribbon,
//    the drop-downs and the dialogs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, v, text, stored, run, fails} from './edit-helpers.mjs';
import {parseRange} from '../../core/grid/lib/addr.mjs';
import {groupsWith, groupSummary, groupHasSummary} from '../../core/grid/lib/data-outline.mjs';
import {splitDelimited, splitFixed} from '../../core/grid/commands/data/tools.mjs';
import {seek} from '../../core/grid/commands/whatif/seek.mjs';
import {criterionMatches} from '../../core/grid/commands/whatif/lists.mjs';
import {checkValidation, listItems} from '../../core/grid/lib/data-validation.mjs';
import {filterValues, customOk} from '../../core/grid/lib/data-filter.mjs';

const sel = (t, range) => run(t, 'selection.set', {range});
const sheet = t => t.content.sheets[0];
const hiddenRows = t => Object.keys(sheet(t).rows ?? {}).filter(k => sheet(t).rows[k].hidden).map(Number).sort((a, b) => a - b);

/** A small list: Name, Dept, Qty with a formula column. */
function people() {
  return workbook([{id: 's1', name: 'Sheet1', blocks: {0: {
    A1: {v: 'Name'}, B1: {v: 'Dept'}, C1: {v: 'Qty'}, D1: {v: 'Double'},
    A2: {v: 'cara'}, B2: {v: 'ops'}, C2: {v: 30}, D2: {f: 'C2*2'},
    A3: {v: 'Abe'}, B3: {v: 'dev'}, C3: {v: 10}, D3: {f: 'C3*2'},
    A4: {v: 'Bo'}, B4: {v: 'dev'}, C4: {v: 20}, D4: {f: 'C4*2'},
    A5: {v: 'Dee'}, B5: {v: 'ops'}, C5: {v: 10}, D5: {f: 'C5*2'},
    A6: {v: 'Eve'}, C6: {v: 5}, D6: {f: 'C6*2'},
  }}, notes: {A3: 'abe note'}}]);
}

test('outline groups: nested, separate, summary before and the level overflow (ported from outline.rs)', () => {
  const lines = spec => Object.fromEntries(spec.map(([i, outline, hidden]) => [i, {outline, ...(hidden ? {hidden: true} : {})}]));
  assert.deepEqual(groupsWith(lines([[3, 0, true]])), []);
  const l = lines([[4, 1], [5, 2], [6, 2], [7, 1], [11, 1, true], [12, 1, true]]);
  const g = groupsWith(l);
  assert.deepEqual(g.map(x => [x.level, x.start, x.end, x.collapsed]), [[2, 5, 6, false], [1, 4, 7, false], [1, 11, 12, true]]);
  assert.equal(groupSummary(g[1]), 8);
  // Two level-2 groups inside one level-1 group, split by a level-1 line.
  const l2 = groupsWith(lines([[0, 2, true], [1, 2, true], [2, 1], [3, 2]]));
  assert.equal(l2.filter(x => x.level === 2).length, 2);
  assert.equal(l2.find(x => x.level === 2 && x.start === 0).collapsed, true);
  assert.deepEqual(l2.filter(x => x.level === 1).map(x => [x.start, x.end, x.collapsed]), [[0, 3, false]]);
  // Summary before the detail; a group on the first line has none.
  const b = groupsWith(lines([[4, 1], [5, 2], [6, 2], [7, 1], [0, 1]]), true);
  const at = (level, start) => b.find(x => x.level === level && x.start === start);
  assert.deepEqual([groupSummary(at(1, 4)), groupHasSummary(at(1, 4))], [3, true]);
  assert.deepEqual([groupSummary(at(2, 5)), groupHasSummary(at(2, 5))], [4, true]);
  assert.equal(groupHasSummary(at(1, 0)), false);
});

test('data.sortAscending / data.sortDescending: rows stay whole, formulas follow, blanks last, one undo step', async () => {
  const t = await session(people());
  await run(t, 'selection.set', {cell: 'C2'});
  await expectUndoRoundTrip(t, 'data.sortAscending', {}, () => {});
  assert.deepEqual([2, 3, 4, 5, 6].map(r => v(t, `C${r}`)), [5, 10, 10, 20, 30]);
  assert.equal(v(t, 'A2'), 'Eve');
  assert.equal(stored(t, 'D2').f, 'C2*2', 'a formula keeps pointing at its own row after the move');
  assert.equal(v(t, 'D2'), 10);
  const r = await run(t, 'data.sortDescending', {});
  assert.equal(r.sorted, 'A2:D6');
  assert.deepEqual([2, 3, 4].map(x => v(t, `C${x}`)), [30, 20, 10]);
  assert.equal(v(t, 'A2'), 'cara', 'the header row (text over numbers) stays put');
  assert.equal(v(t, 'A1'), 'Name');
  // Notes travel with their cell.
  assert.ok(Object.values(sheet(t).notes).includes('abe note'));
  assert.equal(sheet(t).notes.A3, undefined);
});

test('data.sort: levels, by column, blanks last whatever the order, case, custom list, columns', async () => {
  const t = await session(people());
  await run(t, 'selection.set', {cell: 'A2'});
  await run(t, 'data.sort', {keys: [{column: 'B', order: 'asc'}, {column: 'C', order: 'desc'}]});
  assert.deepEqual([2, 3, 4, 5, 6].map(r => v(t, `A${r}`)), ['Bo', 'Abe', 'cara', 'Dee', 'Eve'], 'dev first (20, 10), then ops (30, 10); the blank department last');
  await run(t, 'data.sort', {keys: [{column: 'B', order: 'desc'}]});
  assert.equal(v(t, 'A6'), 'Eve', 'blanks sort last in either order');
  // Custom list order.
  await run(t, 'data.sort', {keys: [{column: 'B', customList: ['ops', 'dev']}]});
  assert.deepEqual([2, 3, 4, 5].map(r => v(t, `B${r}`)), ['ops', 'ops', 'dev', 'dev']);
  // Case sensitive: lowercase before uppercase when equal ignoring case.
  const c = await session(workbook([{id: 's1', name: 'S', blocks: {0: {A1: {v: 'h'}, A2: {v: 'a'}, A3: {v: 'A'}, A4: {v: 'b'}}}}]));
  await run(c, 'data.sort', {range: 'A1:A4', header: true, keys: [{column: 'A'}], matchCase: true});
  assert.deepEqual([2, 3, 4].map(r => v(c, `A${r}`)), ['a', 'A', 'b']);
  // Left to right.
  const h = await session(workbook([{id: 's1', name: 'S', blocks: {0: {A1: {v: 3}, B1: {v: 1}, C1: {v: 2}, A2: {v: 'c'}, B2: {v: 'a'}, C2: {v: 'b'}}}}]));
  await run(h, 'data.sort', {range: 'A1:C2', header: false, orientation: 'columns', keys: [{row: 1}]});
  assert.deepEqual([v(h, 'A2'), v(h, 'B2'), v(h, 'C2')], ['a', 'b', 'c']);
  // Merged cells of different sizes refuse the sort.
  const m = await session(workbook([{id: 's1', name: 'S', blocks: {0: {A1: {v: 'h'}, A2: {v: 2}, A3: {v: 1}}}, merges: ['A2:B3']}]));
  const e = await fails(m, 'data.sort', {range: 'A1:B3', header: true, keys: [{column: 'A'}]});
  assert.match(e.message, /merged cells/);
});

test('sort by cell colour orders by the colour value; a protected sheet refuses unless Sort is allowed', async () => {
  const wb = workbook([{id: 's1', name: 'S', blocks: {0: {A1: {v: 'x', s: 0}, A2: {v: 'red', s: 1}, A3: {v: 'none'}, A4: {v: 'blue', s: 2}}}}],
    {styles: [{}, {fill: {pattern: 'solid', fg: '#FF0000'}}, {fill: {pattern: 'solid', fg: '#0000FF'}}]});
  const t = await session(wb);
  await run(t, 'data.sort', {range: 'A1:A4', header: true, keys: [{column: 'A', by: 'cellColor'}]});
  assert.deepEqual([2, 3, 4].map(r => v(t, `A${r}`)), ['blue', 'red', 'none'], 'colours by value, no colour last');
  const p = await session(workbook([{id: 's1', name: 'S', blocks: {0: {A1: {v: 'h'}, A2: {v: 2}, A3: {v: 1}}}, protection: {enabled: true, sort: false}}]));
  assert.match((await fails(p, 'data.sort', {range: 'A1:A3', keys: [{column: 'A'}]})).message, /Sorting isn't allowed/);
});

test('AutoFilter: Filter toggles buttons, filterBy hides rows, Clear and Reapply, one undo step each', async () => {
  const t = await session(people());
  await run(t, 'selection.set', {cell: 'B3'});
  const on = await run(t, 'data.filter', {});
  assert.deepEqual(on, {filter: true, range: 'A1:D6'});
  assert.equal(sheet(t).autofilter.range, 'A1:D6');
  await expectUndoRoundTrip(t, 'data.filterBy', {column: 'B', values: ['dev']}, () => {});
  const r = await run(t, 'data.filterBy', {column: 'B', values: ['dev']});
  assert.equal(r.hiddenRows, 3);
  assert.deepEqual(hiddenRows(t), [1, 4, 5], 'rows 2, 5 and 6 are hidden (0-based 1, 4, 5)');
  // A second column's filter narrows further.
  await run(t, 'data.filterBy', {column: 'C', custom: {op: '>', value: 10}});
  assert.deepEqual(hiddenRows(t), [1, 2, 4, 5]);
  await run(t, 'data.clearFilter', {});
  assert.deepEqual(hiddenRows(t), []);
  assert.ok(sheet(t).autofilter, 'Clear keeps the buttons');
  await run(t, 'data.filterBy', {column: 'C', top: {count: 2}});
  assert.deepEqual([2, 3, 4, 5, 6].filter(r => !hiddenRows(t).includes(r - 1)), [2, 4], 'top 2 of 30, 10, 20, 10, 5 shows 30 and 20');
  await run(t, 'cell.set', {cell: 'C6', input: '99'});
  await run(t, 'data.reapply', {});
  assert.ok(!hiddenRows(t).includes(5), 'Reapply shows the row that now qualifies');
  // Filter again: buttons off and the rows the filter hid show again.
  await run(t, 'data.filterBy', {column: 'B', values: ['dev']});
  const off = await run(t, 'data.filter', {});
  assert.deepEqual(off, {filter: false});
  assert.equal(sheet(t).autofilter, undefined);
  assert.deepEqual(hiddenRows(t), []);
});

test('AutoFilter: rows hidden by hand stay hidden when the filter is turned off; blanks, above average, case, wildcard', async () => {
  const t = await session(people());
  await run(t, 'data.filter', {});
  await run(t, 'home.hideRows', {rows: '9:9'});
  await run(t, 'data.filterBy', {column: 'B', values: ['ops'], blanks: false});
  assert.deepEqual(hiddenRows(t), [2, 3, 5, 8]);
  await run(t, 'data.filter', {});
  assert.deepEqual(hiddenRows(t), [8], 'only the rows the filter hid are shown again; a row hidden by hand beyond it stays hidden');
  const u = await session(people());
  await run(u, 'data.filter', {});
  await run(u, 'data.filterBy', {column: 'B', values: [], blanks: true});
  assert.deepEqual([2, 3, 4, 5, 6].filter(r => !hiddenRows(u).includes(r - 1)), [6], 'only the blank department shows');
  await run(u, 'data.filterBy', {column: 'C', aboveAverage: true});
  await run(u, 'data.clearFilter', {});
  await run(u, 'data.filterBy', {column: 'A', custom: {op: '=', value: 'a*'}});
  assert.deepEqual([2, 3, 4, 5, 6].filter(r => !hiddenRows(u).includes(r - 1)), [3], 'wildcards, any case');
  await run(u, 'data.filterBy', {column: 'A', custom: {op: 'contains', value: 'E'}});
  assert.deepEqual([2, 3, 4, 5, 6].filter(r => !hiddenRows(u).includes(r - 1)), [3, 5, 6]);
  assert.equal(customOk(5, '5', '>=', '5'), true);
  assert.equal(customOk('x', 'x', '>', '3'), false, 'text never passes a numeric ordering comparison');
});

test('AutoFilter: the drop-down lists distinct shown values in order with (Blanks) last and the checked state', async () => {
  const t = await session(people());
  await run(t, 'data.filter', {});
  await run(t, 'data.filterBy', {column: 'B', values: ['dev']});
  const list = filterValues(t.content, 0, 1);
  assert.deepEqual(list, [{text: 'dev', on: true}, {text: 'ops', on: false}, {text: '(Blanks)', on: false}]);
  assert.deepEqual(filterValues(t.content, 0, 2).map(x => x.text), ['5', '10', '20', '30']);
});

test('the filter range grows when a value is typed right below it', async () => {
  const t = await session(people());
  await run(t, 'data.filter', {});
  await run(t, 'cell.set', {cell: 'A7', input: 'Fay'});
  assert.equal(sheet(t).autofilter.range, 'A1:D7');
});

test('data.removeDuplicates: first of each run stays, rows move up, columns subset, header', async () => {
  const wb = workbook([{id: 's1', name: 'S', blocks: {0: {
    A1: {v: 'k'}, B1: {v: 'v'}, A2: {v: 'a'}, B2: {v: 1}, A3: {v: 'A'}, B3: {v: 2}, A4: {v: 'b'}, B4: {v: 1}, A5: {v: 'a'}, B5: {v: 1},
  }}}]);
  const t = await session(wb);
  const r = await run(t, 'data.removeDuplicates', {range: 'A1:B5', header: true});
  assert.deepEqual(r, {removed: 1, remaining: 3});
  assert.deepEqual([2, 3, 4].map(x => [v(t, `A${x}`), v(t, `B${x}`)]), [['a', 1], ['A', 2], ['b', 1]]);
  assert.equal(v(t, 'A5'), null);
  const u = await session(wb);
  assert.match((await fails(u, 'data.removeDuplicates', {range: 'A1:B5', columns: ['E']})).message, /columns/);
  await expectUndoRoundTrip(u, 'data.removeDuplicates', {range: 'A1:B5', header: true}, () => {});
  const w = await session(wb);
  const r2 = await run(w, 'data.removeDuplicates', {range: 'A1:B5', header: true, columns: ['A']});
  assert.deepEqual(r2, {removed: 2, remaining: 2});
});

test('text to columns: delimiters, qualifier, consecutive, fixed widths, destination, formats', async () => {
  assert.deepEqual(splitDelimited('a,"b,c",d', [','], false, '"'), ['a', 'b,c', 'd']);
  assert.deepEqual(splitDelimited('a,,b', [','], true, '"'), ['a', 'b']);
  assert.deepEqual(splitDelimited('a "" b', [' '], false, '"'), ['a', '', 'b'], 'an empty quoted string is an empty part');
  assert.deepEqual(splitFixed('abcdefgh', [3, 6]), ['abc', 'def', 'gh']);
  assert.deepEqual(splitFixed('ab', [0, 5]), ['ab']);
  const t = await session(workbook([{id: 's1', name: 'S', blocks: {0: {A1: {v: 'x,1,2024-01-05'}, A2: {v: 'y,2,'}}}}]));
  const u = await session(workbook([{id: 's1', name: 'S', blocks: {0: {A1: {v: 'x,1,2024-01-05'}, A2: {v: 'y,2,'}}}}]));
  await expectUndoRoundTrip(u, 'data.textToColumns', {range: 'A1:A2', delimiters: [',']}, () => {});
  assert.equal(v(u, 'A1'), 'x');
  assert.equal(v(u, 'B1'), 1);
  assert.equal(typeof v(u, 'C1'), 'number', 'the date part is read as a date');
  await run(t, 'data.textToColumns', {range: 'A1:A2', delimiters: [','], destination: 'E1', columnFormats: ['general', 'text', 'skip']});
  assert.equal(v(t, 'E1'), 'x');
  assert.equal(v(t, 'F1'), '1', 'a text-formatted part stays text');
  assert.equal(v(t, 'G1'), null, 'a skipped part is not imported');
});

test('data validation: rules per range, check typed values, lists, Stop / Warning styles, clear', async () => {
  const t = await session(workbook());
  await run(t, 'data.validation', {range: 'A1:A3', type: 'whole', operator: 'between', formula1: '1', formula2: '10', errorMessage: 'one to ten', errorTitle: 'Range'});
  assert.equal(sheet(t).validations.length, 1);
  assert.equal(sheet(t).validations[0].operator, 'between');
  assert.equal(checkValidation(t.content, 0, {row: 0, col: 0}, '5'), null);
  const bad = checkValidation(t.content, 0, {row: 0, col: 0}, '11');
  assert.deepEqual([bad.message, bad.title, bad.style], ['one to ten', 'Range', 'stop']);
  assert.ok(checkValidation(t.content, 0, {row: 0, col: 0}, '2.5'), 'a whole number refuses decimals');
  assert.ok(checkValidation(t.content, 0, {row: 0, col: 0}, 'abc'));
  assert.equal(checkValidation(t.content, 0, {row: 0, col: 0}, ''), null, 'ignore blank');
  assert.equal(checkValidation(t.content, 0, {row: 5, col: 0}, 'abc'), null, 'cells with no rule take anything');
  const q = await run(t, 'data.validate', {cell: 'A2', input: '99'});
  assert.deepEqual([q.ok, q.message], [false, 'one to ten']);
  // A list, typed with no quotes, becomes the quoted string Excel stores.
  await run(t, 'data.validation', {range: 'B1:B3', type: 'list', formula1: 'Open,In progress,Closed', errorStyle: 'warning'});
  const rule = sheet(t).validations.find(x => x.ranges.includes('B1:B3'));
  assert.equal(rule.formula1, '"Open,In progress,Closed"');
  assert.deepEqual(listItems(t.content, 0, rule), ['Open', 'In progress', 'Closed']);
  assert.equal(checkValidation(t.content, 0, {row: 1, col: 1}, 'closed'), null, 'list items match ignoring case');
  assert.equal(checkValidation(t.content, 0, {row: 1, col: 1}, 'Done').style, 'warning');
  // A list from a range.
  await run(t, 'cell.set', {cell: 'D1', input: 'x'});
  await run(t, 'cell.set', {cell: 'D2', input: 'y'});
  await run(t, 'data.validation', {range: 'C1', type: 'list', formula1: '=$D$1:$D$2'});
  const rr = sheet(t).validations.find(x => x.ranges.includes('C1'));
  assert.deepEqual(listItems(t.content, 0, rr), ['x', 'y']);
  // A new rule replaces the cells it covers; clear removes.
  await run(t, 'data.validation', {range: 'A2', type: 'any'});
  assert.deepEqual(sheet(t).validations.find(x => x.type === 'whole').ranges.sort(), ['A1', 'A3']);
  await expectUndoRoundTrip(t, 'data.validation', {range: 'A1:A3', clear: true}, () => {});
  await run(t, 'data.validation', {range: 'A1:C3', clear: true});
  assert.equal(sheet(t).validations.length, 0);
  assert.match((await fails(t, 'data.validation', {range: 'A1', type: 'list'})).message, /formula1/);
});

test('data validation: custom formulas see the entered value; dates and text length', async () => {
  const t = await session(workbook());
  await run(t, 'data.validation', {range: 'A1:A5', type: 'custom', formula1: '=A1>10'});
  assert.equal(checkValidation(t.content, 0, {row: 4, col: 0}, '11'), null, 'the formula shifts to A5 and reads the new value');
  assert.ok(checkValidation(t.content, 0, {row: 4, col: 0}, '3'));
  await run(t, 'data.validation', {range: 'B1', type: 'date', operator: 'greaterThan', formula1: '2026-01-01'});
  assert.equal(sheet(t).validations.find(x => x.ranges.includes('B1')).formula1, '46023', 'a typed date is stored as its serial number');
  assert.equal(checkValidation(t.content, 0, {row: 0, col: 1}, '2026-02-01'), null);
  assert.ok(checkValidation(t.content, 0, {row: 0, col: 1}, '2025-02-01'));
  await run(t, 'data.validation', {range: 'C1', type: 'textLength', operator: 'lessThanOrEqual', formula1: '3'});
  assert.equal(checkValidation(t.content, 0, {row: 0, col: 2}, 'abc'), null);
  assert.ok(checkValidation(t.content, 0, {row: 0, col: 2}, 'abcd'));
});

test('data.circleInvalid marks cells whose values break their rule and clears', async () => {
  const t = await session(workbook([{id: 's1', name: 'S', blocks: {0: {A1: {v: 5}, A2: {v: 50}, A3: {v: 7}}}}]));
  await run(t, 'data.validation', {range: 'A1:A3', type: 'whole', operator: 'lessThan', formula1: '10'});
  const r = await run(t, 'data.circleInvalid', {});
  assert.deepEqual(r.invalid, ['A2']);
  assert.deepEqual(t.doc.view.circles, {sheet: 's1', cells: ['A2']});
  await run(t, 'data.circleInvalid', {clear: true});
  assert.equal(t.doc.view.circles, null);
});

test('data.group / ungroup / hideDetail / showDetail / showLevels / outlineSettings', async () => {
  const t = await session(people());
  await run(t, 'data.group', {rows: '2:3'});
  await run(t, 'data.group', {rows: '2:2'});
  assert.deepEqual([1, 2].map(i => sheet(t).rows[i].outline), [2, 1]);
  await run(t, 'data.hideDetail', {rows: '2:2'});
  assert.equal(sheet(t).rows[1].hidden, true, 'the innermost group holding the line collapses');
  assert.equal(sheet(t).rows[2].hidden, undefined);
  assert.equal(sheet(t).rows[2].collapsed, true, 'the summary line (below) is marked');
  await run(t, 'data.showDetail', {rows: '2:2'});
  assert.equal(sheet(t).rows[1].hidden, undefined);
  await run(t, 'data.showLevels', {rows: 1});
  assert.deepEqual(hiddenRows(t), [1, 2]);
  await run(t, 'data.showLevels', {rows: 3});
  assert.deepEqual(hiddenRows(t), []);
  // Summary above: the marks move.
  await run(t, 'data.hideDetail', {rows: '2:3', level: 1});
  assert.equal(sheet(t).rows[3].collapsed, true);
  const s = await run(t, 'data.outlineSettings', {summaryBelow: false});
  assert.deepEqual(s, {summaryBelow: false, summaryRight: true});
  assert.equal(sheet(t).rows[3]?.collapsed, undefined);
  assert.equal(sheet(t).rows[0].collapsed, true, 'the + button moved to the line above the group');
  await run(t, 'data.ungroup', {rows: '2:3'});
  await run(t, 'data.ungroup', {rows: '2:2'});
  assert.deepEqual(Object.values(sheet(t).rows).filter(x => x.outline), []);
  assert.equal(hiddenRows(t).length, 0, 'ungrouping shows the lines');
  await run(t, 'data.group', {cols: 'B:C'});
  assert.equal(sheet(t).cols[1].outline, 1);
  await expectUndoRoundTrip(t, 'data.ungroup', {cols: 'B:C'}, () => {});
});

test('data.subtotal inserts SUBTOTAL rows per run, groups them and adds a grand total', async () => {
  const t = await session(workbook([{id: 's1', name: 'S', blocks: {0: {
    A1: {v: 'Dept'}, B1: {v: 'Qty'},
    A2: {v: 'dev'}, B2: {v: 10}, A3: {v: 'dev'}, B3: {v: 20}, A4: {v: 'ops'}, B4: {v: 30},
  }}}]));
  await run(t, 'selection.set', {cell: 'A2'});
  const r = await run(t, 'data.subtotal', {groupBy: 'A', function: 'sum', columns: ['B']});
  assert.equal(r.groups, 2);
  assert.equal(v(t, 'A4'), 'dev Total');
  assert.equal(v(t, 'B4'), 30);
  assert.equal(v(t, 'A6'), 'ops Total');
  assert.equal(v(t, 'B6'), 30);
  assert.equal(v(t, 'A7'), 'Grand Total');
  assert.equal(v(t, 'B7'), 60, 'SUBTOTAL ignores the nested subtotals');
  assert.equal(stored(t, 'B4').f, 'SUBTOTAL(9,B2:B3)');
  assert.deepEqual([1, 2, 4].map(i => sheet(t).rows[i]?.outline), [1, 1, 1]);
  await run(t, 'data.hideDetail', {rows: '2:2'});
  assert.deepEqual(hiddenRows(t).slice(0, 2), [1, 2]);
  await expectUndoRoundTrip(t, 'data.subtotal', {range: 'A1:B7', groupBy: 'A', function: 'count', columns: ['B']}, () => {});
});

test('goal seek: linear, nonlinear, starting at zero, errors (ported from whatif/tests.rs)', async () => {
  const t = await session(workbook());
  await run(t, 'cell.set', {cell: 'B2', input: '1'});
  await run(t, 'cell.set', {cell: 'B5', input: '=B2*3+4'});
  const r = await run(t, 'data.goalSeek', {set: 'B5', to: 25, changing: 'B2'});
  assert.equal(r.converged, true);
  assert.ok(Math.abs(v(t, 'B2') - 7) < 0.001);
  assert.ok(Math.abs(v(t, 'B5') - 25) < 0.001);
  await t.exec('edit.undo', {});
  assert.equal(v(t, 'B2'), 1, 'one undo step restores the input');
  await run(t, 'cell.set', {cell: 'C1', input: '=B2^2'});
  const r2 = await run(t, 'data.goalSeek', {set: 'C1', to: 2, changing: 'B2'});
  assert.equal(r2.converged, true);
  assert.ok(Math.abs(v(t, 'C1') - 2) <= 0.001);
  await run(t, 'range.setValues', {range: 'E1', values: [[0.01], [10000], [24]]});
  await run(t, 'cell.set', {cell: 'E4', input: '=PMT(E1/12,E3,E2)'});
  const r3 = await run(t, 'data.goalSeek', {set: 'E4', to: -500, changing: 'E1'});
  assert.equal(r3.converged, true);
  await run(t, 'cell.set', {cell: 'G1', input: '0'});
  await run(t, 'cell.set', {cell: 'G2', input: '=G1*G1*G1-27'});
  await run(t, 'data.goalSeek', {set: 'G2', to: 0, changing: 'G1'});
  assert.ok(Math.abs(v(t, 'G1') - 3) < 0.01);
  await run(t, 'cell.set', {cell: 'A1', input: '5'});
  await run(t, 'cell.set', {cell: 'A2', input: '=A1'});
  assert.match((await fails(t, 'data.goalSeek', {set: 'A1', to: 1, changing: 'A1'})).message, /formula/);
  assert.match((await fails(t, 'data.goalSeek', {set: 'A2', to: 1, changing: 'A2'})).message, /value/);
  assert.ok(await fails(t, 'data.goalSeek', {set: 'A2', changing: 'A1'}));
  assert.equal(seek(0, x => x - 5, 100, 0.001).converged, true);
});

test('data table: one-variable by column, by row, and two variables, static values', async () => {
  const t = await session(workbook());
  await run(t, 'range.setValues', {range: 'A1', values: [[2], [3]]});
  await run(t, 'cell.set', {cell: 'D1', input: '=A1*A2'});
  await run(t, 'range.setValues', {range: 'D2', values: [[1], [2], [3]]});
  await run(t, 'cell.set', {cell: 'E1', input: '=A1+A2'});
  const r = await run(t, 'data.dataTable', {range: 'D1:E4', columnInput: 'A1'});
  assert.equal(r.mode, 'column');
  assert.deepEqual([2, 3, 4].map(x => v(t, `E${x}`)), [4, 5, 6]);
  assert.equal(stored(t, 'E2').f, undefined, 'a snapshot, not a live TABLE()');
  const u = await session(workbook());
  await run(u, 'range.setValues', {range: 'A1', values: [[2, 3]]});
  await run(u, 'cell.set', {cell: 'D1', input: '=A1*B1'});
  await run(u, 'range.setValues', {range: 'E1', values: [[1, 2, 3]]});
  await run(u, 'range.setValues', {range: 'D2', values: [[10], [20]]});
  const w = await session(workbook([{id: 's1', name: 'S', blocks: {0: {A1: {v: 2}, B1: {v: 3}, D1: {f: 'A1*B1'}, E1: {v: 1}, F1: {v: 2}, G1: {v: 3}, D2: {v: 10}, D3: {v: 20}}}}]));
  await expectUndoRoundTrip(w, 'data.dataTable', {range: 'D1:G3', rowInput: 'A1', columnInput: 'B1'}, () => {});
  const r2 = await run(u, 'data.dataTable', {range: 'D1:G3', rowInput: 'A1', columnInput: 'B1'});
  assert.equal(r2.mode, 'twoVariable');
  assert.deepEqual([[v(u, 'E2'), v(u, 'F2'), v(u, 'G2')], [v(u, 'E3'), v(u, 'F3'), v(u, 'G3')]], [[10, 20, 30], [20, 40, 60]]);
  assert.match((await fails(u, 'data.dataTable', {range: 'D1:G3', rowInput: 'E2', columnInput: 'B1'})).message, /Input cell/);
  assert.deepEqual([v(u, 'E2'), v(u, 'G3')], [10, 60]);
});

test('scenario manager: add, list, show, replace, delete, summary sheet', async () => {
  const t = await session(workbook());
  await run(t, 'range.setValues', {range: 'B2', values: [[100], [5]]});
  await run(t, 'cell.set', {cell: 'B5', input: '=B2*B3'});
  await run(t, 'data.scenarioAdd', {name: 'Base', changing: 'B2:B3'});
  await run(t, 'data.scenarioAdd', {name: 'High', changing: 'B2,B3', values: [200, 8], comment: 'optimistic'});
  const list = (await run(t, 'data.scenarioManager', {})).scenarios;
  assert.deepEqual(list.map(x => [x.name, x.changing, x.values, x.comment]), [['Base', 'B2,B3', [100, 5], ''], ['High', 'B2,B3', [200, 8], 'optimistic']]);
  assert.match((await fails(t, 'data.scenarioAdd', {name: 'base', changing: 'B2'})).message, /already exists/);
  await run(t, 'data.scenarioAdd', {name: 'base', changing: 'B2:B3', values: [1, 1], replace: true});
  await run(t, 'data.scenarioShow', {name: 'High'});
  assert.deepEqual([v(t, 'B2'), v(t, 'B3'), v(t, 'B5')], [200, 8, 1600]);
  assert.ok(t.content.names.some(n => n.name === '_sc_scenarios' && n.hidden), 'kept in a hidden workbook name');
  const s = await run(t, 'data.scenarioSummary', {resultCells: 'B5'});
  assert.equal(s.sheet, 'Scenario Summary');
  assert.equal(t.content.sheets.length, 2);
  const sum = (ref) => text(t, ref, 1);
  assert.equal(sum('B2'), 'Scenario Summary');
  assert.equal(sum('C3'), 'Current Values:');
  assert.deepEqual([sum('D3'), sum('E3')], ['base', 'High']);
  assert.equal(sum('B4'), 'Changing Cells:');
  assert.deepEqual([sum('B5'), sum('C5'), sum('D5'), sum('E5')], ['$B$2', '200', '1', '200']);
  assert.equal(sum('B7'), 'Result Cells:');
  assert.deepEqual([sum('B8'), sum('C8'), sum('D8'), sum('E8')], ['$B$5', '1600', '1', '1600']);
  await run(t, 'data.scenarioDelete', {name: 'Base'});
  assert.equal((await run(t, 'data.scenarioManager', {sheet: '*'})).scenarios.length, 1);
  await expectUndoRoundTrip(t, 'data.scenarioAdd', {name: 'Zed', changing: 'B2'}, () => {});
});

test('advanced filter: criteria rows OR, columns AND, computed criteria, copy to, unique', async () => {
  assert.equal(criterionMatches(5, '5', 5), true);
  assert.equal(criterionMatches('abc', 'abc', 'a*'), true, 'plain text means begins with');
  assert.equal(criterionMatches(null, '', '='), true);
  assert.equal(criterionMatches(7, '7', '>5'), true);
  assert.equal(criterionMatches('x', 'x', '<>x'), false);
  const wb = () => workbook([{id: 's1', name: 'S', blocks: {0: {
    A1: {v: 'Dept'}, B1: {v: 'Qty'}, A2: {v: 'dev'}, B2: {v: 10}, A3: {v: 'ops'}, B3: {v: 30}, A4: {v: 'dev'}, B4: {v: 10}, A5: {v: 'dev'}, B5: {v: 40},
    D1: {v: 'Dept'}, E1: {v: 'Qty'}, D2: {v: 'dev'}, E2: {v: '>15'}, D3: {v: 'ops'},
  }}}]);
  const t = await session(wb());
  const r = await run(t, 'data.advancedFilter', {range: 'A1:B5', criteria: 'D1:E3'});
  assert.equal(r.matched, 2, 'dev AND qty>15 (row 5), OR ops (row 3)');
  assert.deepEqual(hiddenRows(t), [1, 3]);
  await run(t, 'data.advancedFilter', {range: 'A1:B5'});
  assert.deepEqual(hiddenRows(t), [], 'no criteria matches every row');
  const c = await session(wb());
  const r2 = await run(c, 'data.advancedFilter', {range: 'A1:B5', criteria: 'D1:E3', copyTo: 'H1'});
  assert.equal(r2.range, 'H1:I3');
  assert.deepEqual([v(c, 'H1'), v(c, 'H2'), v(c, 'I2'), v(c, 'H3')], ['Dept', 'ops', 30, 'dev']);
  const u = await session(wb());
  const r3 = await run(u, 'data.advancedFilter', {range: 'A1:B5', unique: true, copyTo: 'H1'});
  assert.equal(r3.matched, 3);
  assert.match((await fails(u, 'data.advancedFilter', {range: 'A1:B5', criteria: 'D1:E3', copyTo: 'A3'})).message, /overlap/);
  // A computed criterion: a blank heading over a formula written for the first data row.
  const k = await session(workbook([{id: 's1', name: 'S', blocks: {0: {
    A1: {v: 'Qty'}, A2: {v: 5}, A3: {v: 50}, A4: {v: 500}, C2: {f: 'A2>10'},
  }}}]));
  const r4 = await run(k, 'data.advancedFilter', {range: 'A1:A4', criteria: 'C1:C2'});
  assert.equal(r4.matched, 2);
});

test('consolidate: by position and by labels across sheets', async () => {
  const wb = workbook([
    {id: 's1', name: 'S1', blocks: {0: {A1: {v: 'x'}, B1: {v: 1}, A2: {v: 'y'}, B2: {v: 2}}}},
    {id: 's2', name: 'S2', blocks: {0: {A1: {v: 'y'}, B1: {v: 10}, A2: {v: 'z'}, B2: {v: 20}}}},
    {id: 's3', name: 'S3'},
  ]);
  const t = await session(wb);
  const r = await run(t, 'data.consolidate', {sources: ['S1!A1:B2', 'S2!A1:B2'], destination: 'S3!A1', function: 'sum', leftColumn: true});
  assert.equal(r.rows, 3);
  assert.deepEqual([0, 1, 2].map(i => [v(t, `A${i + 1}`, 2), v(t, `B${i + 1}`, 2)]), [['x', 1], ['y', 12], ['z', 20]]);
  const p = await run(t, 'data.consolidate', {sources: 'S1!A1:B2;S2!A1:B2', destination: 'S3!D1', function: 'max'});
  assert.equal(p.range, 'D1:E2');
  assert.deepEqual([v(t, 'E1', 2), v(t, 'E2', 2)], [10, 20], 'by position: the text column has no numbers');
  assert.ok(await fails(t, 'data.consolidate', {sources: [], destination: 'S3!A1'}));
  await expectUndoRoundTrip(t, 'data.consolidate', {sources: ['S1!A1:B2'], destination: 'S3!H1', function: 'count'}, () => {});
});

test('data commands are registered with their upstream ids', async () => {
  const t = await session(workbook());
  for (const id of ['data.sortAscending', 'data.sortDescending', 'data.sort', 'data.filter', 'data.filterBy', 'data.clearFilter', 'data.reapply', 'data.removeDuplicates',
    'data.textToColumns', 'data.validation', 'data.validate', 'data.circleInvalid', 'data.group', 'data.ungroup', 'data.hideDetail', 'data.showDetail', 'data.showLevels',
    'data.outlineSettings', 'data.subtotal', 'data.goalSeek', 'data.scenarioManager', 'data.scenarioAdd', 'data.scenarioShow', 'data.scenarioDelete', 'data.scenarioSummary',
    'data.dataTable', 'data.advancedFilter', 'data.consolidate']) {
    assert.ok(t.session.registry.has(id), id);
  }
  void parseRange;
});
