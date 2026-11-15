// Home > Styles > Conditional Formatting: every rule kind, the menus' presets, Clear Rules, the Rules
// Manager and what the rules make of the cells, over a schema-2 workbook, each edit one undo step and
// the rules surviving an .xlsx round trip.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft engine cf.rs (`CfCache::look`), cmd/insert/cond_format.rs (`add_cf`, `clear_cf`,
//    `manage_cf`) and its tests (every matching rule applies, text rules skip errors, top/bottom N,
//    duplicate values, colour scale ends); Excel's Conditional Formatting menu and Rules Manager.
// 2. Ours: lib/cond-format.mjs and commands/format/conditional.mjs.
// 3. This file; tests/e2e/grid/home-styles.e2e.mjs (bridge + captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, run, fails} from './edit-helpers.mjs';
import {cfFor, buildRule, describeRule, presetRule, inTimePeriod, iconCount, defaultIconThresholds, ICON_SETS, COLOR_SCALES} from '../../core/grid/lib/cond-format.mjs';
import {iconShapes} from '../../core/grid/lib/cf-icons.mjs';
import {galleryItems} from '../../core/grid/commands/format/conditional.mjs';

const num = (...vs) => Object.fromEntries(vs.map((v, i) => [`A${i + 1}`, typeof v === 'string' && v.startsWith('=') ? {f: v.slice(1)} : {v}]));
const book = (cells = num(200, 400, 510, 12)) => session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: cells}}]));
const look = (t, row, col = 0) => cfFor(t.content, 0).look(row, col);
const rules = t => t.content.sheets[0].conditionalFormats ?? [];
const fillOf = l => l?.dxf?.fill?.fg ?? null;

test('home.conditionalFormat: Greater Than with a preset highlights the matching cells and is one undo step', async () => {
  const t = await book();
  await expectUndoRoundTrip(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'cellIs', operator: 'greater', value: '300', preset: 'lightRedFillDarkRedText'}}, () => {
    assert.equal(rules(t).length, 1);
    assert.equal(rules(t)[0].rule.operator, 'greaterThan');
    assert.deepEqual(rules(t)[0].rule.formulas, ['300']);
    assert.equal(fillOf(look(t, 1)), '#FFC7CE');
    assert.equal(look(t, 1).dxf.font.color, '#9C0006');
    assert.equal(look(t, 0), null);
  });
});

test('the cell value operators, Between and the file operator names', async () => {
  const t = await book();
  await run(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'cellIs', operator: 'between', value: '100', value2: '450', preset: 'greenFillDarkGreenText'}});
  assert.deepEqual([0, 1, 2, 3].map(r => look(t, r) !== null), [true, true, false, false]);
  await run(t, 'home.clearRules', {sheet: true});
  const CASES = {less: [1, 0, 0, 1], lessThan: [1, 0, 0, 1], lessOrEqual: [1, 1, 0, 1], equal: [0, 1, 0, 0], notEqual: [1, 0, 1, 1], greaterOrEqual: [0, 1, 1, 0], greater: [0, 0, 1, 0]};
  for (const [op, expected] of Object.entries(CASES)) {
    await run(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'cellIs', operator: op, value: '400'}});
    assert.deepEqual([0, 1, 2, 3].map(r => (look(t, r) !== null ? 1 : 0)), expected, op);
    await run(t, 'home.clearRules', {sheet: true});
  }
  await run(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'cellIs', operator: 'notBetween', value: '300', value2: '450'}});
  assert.deepEqual([0, 1, 2, 3].map(r => look(t, r) !== null), [true, false, true, true]);
  await run(t, 'home.clearRules', {sheet: true});
  const e = await fails(t, 'home.conditionalFormat', {range: 'A1', rule: {type: 'cellIs', operator: 'smaller', value: '5'}});
  assert.match(e.message, /unknown operator/);
});

test('every matching rule applies; where two set the same part the higher priority wins; Stop If True stops', async () => {
  const t = await book();
  await run(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'cellIs', operator: 'greater', value: '300', preset: 'lightRedFill'}});
  await run(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'cellIs', operator: 'greater', value: '500', preset: 'redBorder'}});
  assert.equal(look(t, 1).dxf.borders, undefined, '400 gets the first rule only');
  const both = look(t, 2).dxf;
  assert.equal(both.fill.fg, '#FFC7CE');
  assert.equal(both.borders.top.style, 'thin');
  // A new rule goes first; the second one is Stop If True.
  const [first] = rules(t);
  assert.equal(first.priority, 1);
  await run(t, 'home.manageRules', {rules: rules(t).map(r => ({id: r.id, stopIfTrue: r.priority === 1}))});
  assert.equal(look(t, 2).dxf.fill, undefined, 'the border rule stops the lower one');
});

test('a formula rule is relative to the top-left cell of its range', async () => {
  const t = await book(num(1, 2, 3, 4));
  await run(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'expression', formula: '=MOD(A1,2)=0', preset: 'yellowFillDarkYellowText'}});
  assert.deepEqual([0, 1, 2, 3].map(r => look(t, r) !== null), [false, true, false, true]);
  const e = await fails(t, 'home.conditionalFormat', {range: 'A1', rule: {type: 'expression', formula: '=A1+*'}});
  assert.match(e.message, /does not parse/);
});

test('text rules: contains, does not contain, begins with, ends with, and they skip errors', async () => {
  const t = await book({A1: {v: 'apple'}, A2: {v: 'Banana'}, A3: {f: 'NA()'}, A4: {v: 'grape'}});
  await run(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'containsText', text: 'AN'}});
  assert.deepEqual([0, 1, 2, 3].map(r => look(t, r) !== null), [false, true, false, false], 'case-insensitive, #N/A never matches');
  assert.match(rules(t)[0].rule.formulas[0], /SEARCH\("AN",A1\)/);
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'beginsWith', text: 'gr'}});
  assert.deepEqual([0, 1, 2, 3].map(r => look(t, r) !== null), [false, false, false, true]);
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'endsWith', text: 'E'}});
  assert.deepEqual([0, 1, 2, 3].map(r => look(t, r) !== null), [true, false, false, true], 'apple and grape end with e');
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'notContainsText', text: 'a'}});
  assert.deepEqual([0, 1, 2, 3].map(r => look(t, r) !== null), [false, false, true, false], 'does not contain: the error cell and nothing with an a');
});

test('duplicate and unique values, blanks and errors', async () => {
  const t = await book({A1: {v: 'a'}, A2: {v: 'A'}, A3: {v: 'b'}, A4: {f: 'NA()'}});
  await run(t, 'home.conditionalFormat', {range: 'A1:A5', rule: {type: 'duplicate'}});
  assert.deepEqual([0, 1, 2, 3, 4].map(r => look(t, r) !== null), [true, true, false, false, false]);
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A5', rule: {type: 'unique'}});
  assert.deepEqual([0, 1, 2, 3, 4].map(r => look(t, r) !== null), [false, false, true, true, false]);
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A5', rule: {type: 'blanks'}});
  assert.deepEqual([0, 1, 2, 3, 4].map(r => look(t, r) !== null), [false, false, false, false, true], 'a blank cell with no stored value still shows its rule');
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A5', rule: {type: 'errors'}});
  assert.deepEqual([0, 1, 2, 3, 4].map(r => look(t, r) !== null), [false, false, false, true, false]);
});

test('top and bottom N items and percent, above and below average', async () => {
  const t = await book(num(1, 2, 3, 10, 20, 30, 40, 50, 60, 70));
  const hit = () => [...Array(10).keys()].filter(r => look(t, r) !== null).map(r => r + 1);
  await run(t, 'home.conditionalFormat', {range: 'A1:A10', rule: {type: 'top10', rank: 3}});
  assert.deepEqual(hit(), [8, 9, 10]);
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A10', rule: {type: 'top10', rank: 20, percent: true}});
  assert.deepEqual(hit(), [9, 10], 'top 20 percent of 10 values is 2');
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A10', rule: {type: 'top10', rank: 2, bottom: true}});
  assert.deepEqual(hit(), [1, 2]);
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A10', rule: {type: 'aboveAverage'}});
  assert.deepEqual(hit(), [6, 7, 8, 9, 10]);
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A10', rule: {type: 'aboveAverage', below: true}});
  assert.deepEqual(hit(), [1, 2, 3, 4, 5]);
  assert.equal((await fails(t, 'home.conditionalFormat', {range: 'A1', rule: {type: 'top10', rank: 0}})).code, 'invalid_params');
});

test('a date occurring uses today, this week and this month', () => {
  const now = 45000.5;
  assert.equal(inTimePeriod('today', 45000, 1900, now), true);
  assert.equal(inTimePeriod('yesterday', 44999, 1900, now), true);
  assert.equal(inTimePeriod('tomorrow', 45001, 1900, now), true);
  assert.equal(inTimePeriod('last7Days', 44994, 1900, now), true);
  assert.equal(inTimePeriod('last7Days', 44993, 1900, now), false);
  assert.equal(inTimePeriod('thisMonth', 45000 - 3, 1900, now), true);
  assert.equal(inTimePeriod('nextMonth', 45000 + 40, 1900, now), true);
  assert.equal(inTimePeriod('lastMonth', 45000 - 40, 1900, now), true);
  assert.equal(inTimePeriod('thisWeek', 45000, 1900, now), true);
  assert.equal(inTimePeriod('lastWeek', 45000 - 7, 1900, now), true);
  assert.equal(inTimePeriod('nextWeek', 45000 + 7, 1900, now), true);
});

test('colour scales run from the lowest to the highest value; data bars and icon sets', async () => {
  const t = await book(num(0, 50, 100));
  await run(t, 'home.conditionalFormat', {range: 'A1:A3', preset: 'colorScale.green-yellow-red'});
  assert.deepEqual(look(t, 0).fill, [0x63, 0xBE, 0x7B]);
  assert.deepEqual(look(t, 1).fill, [0xFF, 0xEB, 0x84]);
  assert.deepEqual(look(t, 2).fill, [0xF8, 0x69, 0x6B]);
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A3', preset: 'dataBar.blue'});
  assert.ok(look(t, 0).bar.fraction < 0.2 && look(t, 2).bar.fraction === 1, 'the highest value fills the cell, the lowest keeps a sliver');
  assert.equal(look(t, 1).bar.gradient, true);
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A3', preset: 'dataBar.red.solid'});
  assert.equal(look(t, 1).bar.gradient, false);
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A3', preset: 'iconSet.3Arrows'});
  assert.deepEqual([0, 1, 2].map(r => look(t, r).icon), [{set: '3Arrows', index: 0}, {set: '3Arrows', index: 1}, {set: '3Arrows', index: 2}]);
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A3', rule: {type: 'iconSet', set: '3Arrows', reverse: true, showValue: false}});
  assert.equal(look(t, 0).icon.index, 2);
  assert.equal(look(t, 0).hideValue, true);
  await run(t, 'home.clearRules', {sheet: true});
  await run(t, 'home.conditionalFormat', {range: 'A1:A3', rule: {type: 'colorScale', colors: ['#FFFFFF', '#FF0000'], min: {type: 'num', value: 0}, max: {type: 'num', value: 200}}});
  assert.deepEqual(look(t, 2).fill, [255, 128, 128]);
});

test('a number format in the rule is part of its differential format', async () => {
  const t = await book();
  await run(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'cellIs', operator: 'greater', value: '300', style: {numFmt: '0.0', font: {bold: true}}}});
  assert.equal(look(t, 1).dxf.numFmt, '0.0');
  assert.equal(look(t, 1).dxf.font.bold, true);
});

test('home.clearRules: selected cells split a rule, the whole sheet clears all, a table clears its own', async () => {
  const t = await book(num(1, 2, 3, 4));
  await run(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'cellIs', operator: 'greater', value: '0'}});
  await expectUndoRoundTrip(t, 'home.clearRules', {range: 'A2:A3'}, () => {
    assert.deepEqual(rules(t)[0].ranges, ['A1', 'A4']);
    assert.equal(look(t, 1), null);
    assert.notEqual(look(t, 0), null);
  });
  assert.equal((await run(t, 'home.clearRules', {sheet: true})).cleared, 1);
  assert.equal(rules(t).length, 0);
  assert.match((await fails(t, 'home.clearRules', {table: true})).message, /table/);
  assert.match((await fails(t, 'home.clearRules', {pivot: true})).message, /PivotTable/);
});

test('home.manageRules: list, reorder, delete, edit where it applies, and the whole list at once', async () => {
  const t = await book();
  await run(t, 'home.conditionalFormat', {range: 'A1:A2', rule: {type: 'cellIs', operator: 'greater', value: '1'}});
  await run(t, 'home.conditionalFormat', {range: 'A3:A4', rule: {type: 'top10', rank: 1}});
  const listed = (await run(t, 'home.manageRules', {list: true})).rules;
  assert.deepEqual(listed.map(r => r.text), ['Top 1', 'Cell Value > 1']);
  const [top, cell] = listed;
  await expectUndoRoundTrip(t, 'home.manageRules', {moveUp: cell.id}, () => assert.equal(rules(t)[0].id, cell.id));
  await run(t, 'home.manageRules', {rules: [{id: top.id, ranges: '$A$1:$A$4'}, {id: cell.id, stopIfTrue: true}]});
  assert.deepEqual(rules(t).map(r => r.id), [top.id, cell.id]);
  assert.deepEqual(rules(t)[0].ranges, ['A1:A4']);
  assert.equal(rules(t)[1].stopIfTrue, true);
  await run(t, 'home.manageRules', {rules: [{id: top.id, spec: {type: 'top10', rank: 2, bottom: true}}]});
  assert.equal(rules(t).length, 1, 'a rule left out is deleted');
  assert.equal(rules(t)[0].rule.rank, 2);
  assert.match((await fails(t, 'home.manageRules', {rules: [{id: 'nope', ranges: 'A1'}]})).message, /no definition/);
  await run(t, 'home.manageRules', {delete: top.id});
  assert.equal(rules(t).length, 0);
});

test('rules survive an .xlsx round trip', async () => {
  const {writeXlsx} = await import('../../core/grid/formats/xlsx-write.mjs');
  const {readXlsx} = await import('../../core/grid/formats/xlsx-read.mjs');
  const t = await book();
  await run(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'cellIs', operator: 'greater', value: '300', preset: 'greenFillDarkGreenText'}});
  await run(t, 'home.conditionalFormat', {range: 'A1:A4', preset: 'colorScale.red-white'});
  await run(t, 'home.conditionalFormat', {range: 'A1:A4', rule: {type: 'containsText', text: 'x'}});
  const bytes = await writeXlsx(t.content);
  const back = await readXlsx(bytes);
  const got = back.content?.sheets?.[0]?.conditionalFormats ?? back.sheets?.[0]?.conditionalFormats ?? [];
  assert.equal(got.length, 3);
  assert.deepEqual(got.map(r => r.rule.type).sort(), ['cellIs', 'colorScale', 'containsText']);
  const cell = got.find(r => r.rule.type === 'cellIs');
  assert.equal(cell.rule.dxf.fill.fg.toUpperCase(), '#C6EFCE');
});

test('building a rule: formulas must parse, values are needed, presets are known', () => {
  assert.throws(() => buildRule({type: 'cellIs', operator: 'greater', value: ''}), /value is needed/);
  assert.throws(() => buildRule({type: 'cellIs', operator: 'between', value: '1'}), /value is needed/);
  assert.throws(() => buildRule({type: 'nope'}), /unknown rule type/);
  assert.throws(() => buildRule({type: 'timePeriod', period: 'someday'}), /unknown date period/);
  assert.throws(() => buildRule({type: 'iconSet', set: '9Hats'}), /unknown icon set/);
  assert.throws(() => buildRule({type: 'colorScale', colors: ['#fff']}), /two or three/);
  assert.deepEqual(buildRule({type: 'cellIs', operator: 'equal', value: 'Closed'}).formulas, ['"Closed"']);
  assert.deepEqual(buildRule({type: 'cellIs', operator: 'equal', value: '"Closed"'}).formulas, ['"Closed"']);
  assert.deepEqual(buildRule({type: 'cellIs', operator: 'greater', value: '=$B$1'}).formulas, ['$B$1']);
  assert.equal(presetRule('dataBar.nope'), null);
  assert.equal(describeRule(buildRule({type: 'cellIs', operator: 'between', value: '1', value2: '9'})), 'Cell Value between 1 and 9');
  assert.equal(describeRule(buildRule({type: 'top10', rank: 10, percent: true, bottom: true})), 'Bottom 10%');
});

test('the menus: every gallery entry makes a rule, twenty icon sets, twelve colour scales, twelve data bars', async () => {
  assert.equal(ICON_SETS.length, 20);
  assert.equal(COLOR_SCALES.length, 12);
  for (const g of ['dataBars', 'colorScales', 'iconSets']) {
    const items = galleryItems(g);
    assert.ok(items.length >= 12, g);
    for (const it of items) assert.ok(buildRule({preset: it.value}), it.value);
  }
  assert.equal(galleryItems('dataBars').length, 12);
  assert.equal(galleryItems('nothing').length, 0);
  const t = await book();
  const st = t.state('home.conditionalFormat', {gallery: 'iconSets'});
  assert.equal(st.value.length, 20);
  assert.equal(st.value[0].art.kind, 'cf');
});

test('icon sets: counts, default thresholds and a picture for every icon', () => {
  assert.equal(iconCount('3Arrows'), 3);
  assert.equal(iconCount('5Quarters'), 5);
  assert.deepEqual(defaultIconThresholds('3Arrows').map(x => x.val), ['0', '33', '67']);
  for (const [set] of ICON_SETS) {
    for (let i = 0; i < iconCount(set); i++) {
      const shapes = iconShapes(set, i);
      assert.ok(shapes.length >= 1 && shapes.every(sh => typeof sh.d === 'string' && sh.d.length > 3), `${set} ${i}`);
    }
  }
});

test('New Formatting Rule with no arguments opens its dialog; the state is enabled with a workbook', async () => {
  const t = await book();
  assert.equal(t.state('home.conditionalFormat').enabled, true);
  assert.equal(t.state('home.clearRules').enabled, true);
  assert.equal(t.state('home.manageRules').enabled, true);
  assert.equal((await fails(t, 'home.conditionalFormat', {range: 'A1'})).code, 'invalid_params');
});
