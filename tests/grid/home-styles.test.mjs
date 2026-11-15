// Home > Styles, Font and Editing controls that sit beside the format families: Format as Table, Draw Border,
// New Cell Style (and its Style box), Fill > Justify, the Colors dialog and the conditional-format dialogs'
// models, over a schema-2 workbook; each edit one undo step.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft cmd/insert/table.rs (`format_as_table`: restyle inside a table, else make one),
//    cmd/extra/cells.rs (`draw_border` as `home.borders` presets, `new_cell_style`), dialogs.rs (`cond_format`).
// 2. Excel: Draw Border's pen, Style Includes, Fill > Justify, Colors, New Formatting Rule, Rules Manager.
// 3. This file; tests/e2e/grid/home-styles.e2e.mjs (bridge + captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, run, fails, style, text} from './edit-helpers.mjs';
import styleDialog, {describe} from '../../core/grid/dialogs/style.mjs';
import colors, {honeycomb, toHex} from '../../core/grid/dialogs/colors.mjs';
import cfQuick, {quickText} from '../../core/grid/dialogs/cfQuick.mjs';
import cfNewRule from '../../core/grid/dialogs/cfNewRule.mjs';
import manageRules from '../../core/grid/dialogs/manageRules.mjs';
import cfFormatCells, {dxfFromValues, valuesFromDxf} from '../../core/grid/dialogs/cfFormatCells.mjs';
import {valuesFromRule, specFromValues, problems, blankRuleValues} from '../../core/grid/lib/cond-format-dialog.mjs';
import {buildRule, cfFor} from '../../core/grid/lib/cond-format.mjs';
import {validTableStyle, tableStyleTiles, wrapWords} from '../../core/grid/commands/format/home-extra.mjs';
import {cellStyleItems} from '../../core/grid/commands/format/styles.mjs';

const data = () => ({A1: {v: 'Region'}, B1: {v: 'Sales'}, A2: {v: 'North'}, B2: {v: 10}, A3: {v: 'South'}, B3: {v: 20}});
const book = (cells = data(), extra = {}) => session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: cells}, ...extra}, {id: 's2', name: 'Sheet2'}]));
const ctxOf = t => t.session.readContext(t.docId);
const tables = t => t.content.sheets[0].tables ?? [];

test('home.formatAsTable: a style makes the block a table, and restyles the table the cell is in', async () => {
  const t = await book();
  await expectUndoRoundTrip(t, 'home.formatAsTable', {range: 'A1:B3', style: 'TableStyleDark3'}, () => {
    assert.equal(tables(t).length, 1);
    assert.equal(tables(t)[0].range, 'A1:B3');
    assert.equal(tables(t)[0].style.name, 'TableStyleDark3');
  });
  const r = await run(t, 'home.formatAsTable', {range: 'A1:B3', style: 'TableStyleLight9'});
  assert.equal(r.style, 'TableStyleLight9');
  assert.equal(tables(t).length, 1, 'inside a table it restyles it');
  assert.equal(tables(t)[0].style.name, 'TableStyleLight9');
  assert.equal(tables(t)[0].style.showRowStripes, true, 'the stripes stay as they were');
  assert.match((await fails(t, 'home.formatAsTable', {style: 'TableStyleMedium99'})).message, /unknown table style/);
  assert.equal(validTableStyle('TableStyleDark11'), true);
  assert.equal(validTableStyle('TableStyleDark12'), false);
});

test('home.formatAsTable: the value a gallery tile gives is the style, and the state lists sixty drawn tiles', async () => {
  const t = await book();
  await run(t, 'home.formatAsTable', {range: 'A1:B3', value: 'TableStyleMedium5'});
  assert.equal(tables(t)[0].style.name, 'TableStyleMedium5');
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sh:s1/A2', focus: '/sh:s1/A2'}], primary: 0});
  const tiles = t.state('home.formatAsTable').value;
  assert.equal(tiles.length, 60);
  assert.equal(tiles.filter(x => x.selected).map(x => x.id).join(), 'TableStyleMedium5');
  assert.deepEqual([...new Set(tiles.map(x => x.group))], ['Light', 'Medium', 'Dark']);
  assert.ok(tiles.every(x => x.art.kind === 'pivot' && /^#/.test(x.art.header)));
  assert.equal(tableStyleTiles(ctxOf(t)).length, 60);
});

test('home.drawBorder: a mode turns the pen on and off, colour and style set it, a range draws', async () => {
  const t = await book();
  let r = await run(t, 'home.drawBorder', {mode: 'border'});
  assert.equal(r.mode, 'border');
  assert.equal(t.state('home.drawBorder', {mode: 'border'}).checked, true);
  assert.equal(t.state('home.drawBorder', {mode: 'grid'}).checked, false);
  await run(t, 'home.drawBorder', {color: '#FF0000'});
  await run(t, 'home.drawBorder', {style: 'thick'});
  assert.equal(t.state('home.drawBorder', {}).value, '#FF0000');
  await expectUndoRoundTrip(t, 'home.drawBorder', {apply: true, range: 'A1:B2'}, () => {
    assert.equal(style(t, 'A1').borders.top.style, 'thick');
    assert.equal(style(t, 'A1').borders.top.color, '#FF0000');
    assert.equal(style(t, 'B2').borders.right.style, 'thick');
    assert.equal(style(t, 'A1').borders.right, null, 'the outline only, not the grid');
  });
  await run(t, 'home.drawBorder', {mode: 'grid'});
  await run(t, 'home.drawBorder', {apply: true, range: 'A3:B3'});
  assert.equal(style(t, 'B3').borders.left.style, 'thick');
  assert.equal(style(t, 'A3').borders.right.style, 'thick', 'the grid draws the lines between the cells too');
  await run(t, 'home.drawBorder', {mode: 'erase'});
  await run(t, 'home.drawBorder', {apply: true, range: 'A1:B2'});
  assert.equal(style(t, 'A1').borders.top, null);
  r = await run(t, 'home.drawBorder', {mode: 'erase'});
  assert.equal(r.mode, null, 'a second click turns the pen off');
  assert.equal(t.state('home.drawBorder', {mode: 'erase'}).checked, false);
  await run(t, 'home.drawBorder', {range: 'C1', edge: 'bottom', style: 'double'});
  assert.equal(style(t, 'C1').borders.bottom.style, 'double');
  assert.match((await fails(t, 'home.drawBorder', {})).message, /name a mode/);
  const states = t.state('home.drawBorder', {gallery: 'lineStyles'}).value;
  assert.equal(states.length, 13);
  assert.equal(states.find(x => x.selected).id, 'thin', 'the pen is off, so the default line');
});

test('home.newCellStyle: the active cell as a named style, with the parts it includes', async () => {
  const t = await book();
  await run(t, 'home.bold', {range: 'A1'});
  await run(t, 'home.fillColor', {range: 'A1', color: '#FFFF00'});
  await run(t, 'home.numberFormat', {range: 'A1', code: '0.00'});
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sh:s1/A1', focus: '/sh:s1/A1'}], primary: 0});
  await expectUndoRoundTrip(t, 'home.newCellStyle', {name: 'Emphasis'}, () => {
    const own = t.content.cellStyles.find(x => x.name === 'Emphasis');
    assert.equal(own.style.font.bold, true);
    assert.equal(own.style.fill.fg, '#FFFF00');
    assert.equal(own.includes, undefined, 'all parts when none is left out');
  });
  await run(t, 'home.newCellStyle', {name: 'Fill only', includes: {numFmt: false, align: false, font: false, borders: false, protection: false}});
  const fillOnly = t.content.cellStyles.find(x => x.name === 'Fill only');
  assert.deepEqual(Object.keys(fillOnly.style), ['fill']);
  assert.equal(fillOnly.includes.join(), 'fill');
  // Applying it changes only what it includes.
  await run(t, 'home.italic', {range: 'B2'});
  await run(t, 'home.cellStyle', {range: 'B2', name: 'Fill only'});
  assert.equal(style(t, 'B2').fill.fg, '#FFFF00');
  assert.equal(style(t, 'B2').font.italic, true, 'the font was not part of the style');
  await run(t, 'home.cellStyle', {range: 'B3', name: 'Emphasis'});
  assert.equal(style(t, 'B3').font.bold, true);
  assert.equal(text(t, 'B3'), '20.00');
  // The same name replaces the style.
  await run(t, 'home.newCellStyle', {name: 'emphasis'});
  assert.equal(t.content.cellStyles.filter(x => x.name.toLowerCase() === 'emphasis').length, 1);
  assert.deepEqual(cellStyleItems(t.content).filter(i => i.group === 'Custom').map(i => i.label), ['Fill only', 'emphasis']);
  assert.match((await fails(t, 'home.newCellStyle', {name: '  '})).message, /name/);
});

test('the Style dialog: name, the parts and what each holds', async () => {
  const t = await book();
  await run(t, 'home.bold', {range: 'A1'});
  const init = styleDialog.init(ctxOf(t));
  assert.equal(init.name, 'Style 1');
  assert.equal(init.descriptions.font, 'Calibri 11, Bold');
  assert.equal(init.descriptions.borders, 'No Borders');
  assert.equal(init.descriptions.protection, 'Locked');
  assert.deepEqual(styleDialog.validate({name: ' '}), [{field: 'name', message: 'Type a name for the style.'}]);
  const call = styleDialog.toCommand({...init, name: 'Mine', font: false});
  assert.deepEqual(call.batch[0].params, {name: 'Mine', includes: {numFmt: true, align: true, font: false, borders: true, fill: true, protection: true}});
  await t.batch(call.batch);
  assert.ok(t.content.cellStyles.some(x => x.name === 'Mine' && x.includes.length === 5));
  assert.equal(describe(style(t, 'A1')).font, 'Calibri 11, Bold');
});

test('edit.fillJustify: the text of the first column re-wraps to the width of the selection', async () => {
  const long = 'The quick brown fox jumps over the lazy dog and keeps on running through the quiet field';
  const t = await book({A1: {v: long}, A2: {v: 'tail'}}, {cols: {0: {size: 110}, 1: {size: 110}}});
  await expectUndoRoundTrip(t, 'edit.fillJustify', {range: 'A1:B8'}, () => {
    assert.ok(text(t, 'A1').length > 0 && text(t, 'A1').length < long.length);
    assert.ok(text(t, 'A4') !== '');
    assert.equal([1, 2, 3, 4, 5, 6, 7, 8].map(r => text(t, `A${r}`)).join(' ').replace(/\s+/g, ' ').trim(), `${long} tail`);
  });
  assert.deepEqual(wrapWords('aa bb cc', 1, 11, false), ['aa', 'bb', 'cc']);
  assert.deepEqual(wrapWords('', 100, 11, false), []);
});

test('edit.fillJustify refuses numbers, formulas and text that would run into filled cells', async () => {
  const t = await book({A1: {v: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen'}, A2: {v: 'x'}, A3: {v: 'blocker'}, B1: {v: 1}}, {cols: {0: {size: 60}}});
  assert.match((await fails(t, 'edit.fillJustify', {range: 'A1:A2'})).message, /extend below/);
  const n = await book({A1: {v: 42}});
  assert.match((await fails(n, 'edit.fillJustify', {range: 'A1:A3'})).message, /numbers/);
  const f = await book({A1: {f: '"a"&"b"'}});
  assert.match((await fails(f, 'edit.fillJustify', {range: 'A1:A3'})).message, /formulas/);
  const e = await book({});
  assert.equal((await run(e, 'edit.fillJustify', {range: 'A1:A3'})).lines, 0);
});

test('the Colors dialog: the honeycomb, the current colour and the command it submits', async () => {
  const t = await book();
  await run(t, 'home.fillColor', {range: 'A1', color: '#FF0000'});
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sh:s1/A1', focus: '/sh:s1/A1'}], primary: 0});
  const init = colors.init(ctxOf(t), {target: 'fill'});
  assert.equal(init.color, '#FF0000');
  assert.equal(init.current, '#FF0000');
  assert.equal(colors.init(ctxOf(t), {target: 'font'}).color, '#000000');
  assert.equal(colors.init(ctxOf(t), {target: 'font'}).hasCurrent, false, 'automatic font colour: no current colour');
  const comb = honeycomb();
  assert.equal(comb.rows.reduce((n, r) => n + r.length, 0), 127);
  assert.equal(comb.greys.length, 15);
  assert.equal(comb.greys[0], '#FFFFFF');
  assert.equal(comb.greys[14], '#000000');
  assert.equal(toHex(255, 128, 0), '#FF8000');
  assert.deepEqual(colors.toCommand({target: 'fill', color: '#00ff00'}).batch, [{command: 'home.fillColor', params: {color: '#00FF00'}}]);
  assert.deepEqual(colors.toCommand({target: 'font', color: '#00ff00'}).batch, [{command: 'home.fontColor', params: {color: '#00FF00'}}]);
  assert.equal(colors.validate({color: 'red'}).length, 1);
  assert.equal(colors.preview(ctxOf(t), init).comb.rows.length, 13);
});

test('the Highlight Cells boxes: wording, the active cell\'s address, and the rule they make', async () => {
  const t = await book();
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sh:s1/B2', focus: '/sh:s1/B3'}], primary: 0});
  const g = cfQuick.init(ctxOf(t), {type: 'cellIs', operator: 'greater'});
  assert.equal(g.__title, 'Greater Than');
  assert.equal(g.value, '=$B$2');
  assert.equal(g.range, 'B2:B3');
  assert.equal(quickText(g).lead, 'Format cells that are GREATER THAN:');
  assert.equal(cfQuick.init(ctxOf(t), {type: 'cellIs', operator: 'between'}).__title, 'Between');
  assert.equal(cfQuick.init(ctxOf(t), {type: 'containsText'}).__title, 'Text That Contains');
  assert.equal(cfQuick.init(ctxOf(t), {type: 'timePeriod'}).__title, 'A Date Occurring');
  assert.equal(cfQuick.init(ctxOf(t), {type: 'duplicate'}).__title, 'Duplicate Values');
  assert.equal(cfQuick.init(ctxOf(t), {type: 'top10', rank: 10, percent: true}).__title, 'Top 10 %');
  assert.equal(cfQuick.init(ctxOf(t), {type: 'top10', rank: 10, bottom: true}).__title, 'Bottom 10 Items');
  assert.equal(cfQuick.init(ctxOf(t), {type: 'aboveAverage', below: true}).__title, 'Below Average');
  assert.equal(cfQuick.validate({...g, value: ''})[0].field, 'value');
  const call = cfQuick.toCommand({...g, value: '15', preset: 'greenFillDarkGreenText'});
  assert.equal(call.batch[0].command, 'home.conditionalFormat');
  await t.batch(call.batch);
  assert.equal(cfFor(t.content, 0).look(2, 1).dxf.fill.fg, '#C6EFCE');
  assert.equal(cfFor(t.content, 0).look(1, 1), null, '10 is not greater than 15');
  // A custom format wins over the preset.
  const custom = cfQuick.toCommand({...g, value: '5', preset: 'custom', dxf: {font: {bold: true}}});
  assert.deepEqual(custom.batch[0].params.rule.style, {font: {bold: true}});
});

test('New Formatting Rule: every rule type round-trips between its values and its rule', async () => {
  const t = await book();
  const spec = (patch) => specFromValues({...blankRuleValues(), ...patch});
  const cases = [
    [{ruleType: 'scale', formatStyle: '3color'}, 'colorScale'],
    [{ruleType: 'scale', formatStyle: '2color'}, 'colorScale'],
    [{ruleType: 'scale', formatStyle: 'dataBar'}, 'dataBar'],
    [{ruleType: 'scale', formatStyle: 'iconSet', iconSet: '4Arrows', iconRules: [{type: 'percent', value: '75', gte: true}, {type: 'percent', value: '50', gte: true}, {type: 'percent', value: '25', gte: false}]}, 'iconSet'],
    [{ruleType: 'cells', cellsKind: 'cellValue', operator: 'between', value: '1', value2: '9', dxf: {font: {bold: true}}}, 'cellIs'],
    [{ruleType: 'cells', cellsKind: 'text', textOp: 'endsWith', text: 'x'}, 'endsWith'],
    [{ruleType: 'cells', cellsKind: 'dates', period: 'thisWeek'}, 'timePeriod'],
    [{ruleType: 'cells', cellsKind: 'blanks'}, 'containsBlanks'],
    [{ruleType: 'cells', cellsKind: 'noErrors'}, 'notContainsErrors'],
    [{ruleType: 'rank', rankDir: 'bottom', rank: 5, rankPercent: true}, 'top10'],
    [{ruleType: 'average', avgDir: 'below2'}, 'aboveAverage'],
    [{ruleType: 'duplicates', dupKind: 'unique'}, 'uniqueValues'],
    [{ruleType: 'formula', formula: '=A1>3'}, 'expression'],
  ];
  for (const [values, type] of cases) {
    const rule = buildRule(spec(values));
    assert.equal(rule.type, type, JSON.stringify(values));
    const back = valuesFromRule(rule);
    assert.equal(back.ruleType, values.ruleType, `${type} ruleType`);
    const again = buildRule(specFromValues(back));
    delete again.dxf; const first = {...rule}; delete first.dxf;
    assert.deepEqual(again, first, `${type} survives the dialog`);
  }
  const icons = buildRule(spec(cases[3][0]));
  assert.deepEqual(icons.iconSet.cfvo.map(c => [c.type, c.val, c.gte]), [['percent', '0', undefined], ['percent', '25', false], ['percent', '50', undefined], ['percent', '75', undefined]]);
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sh:s1/B2', focus: '/sh:s1/B3'}], primary: 0});
  const init = cfNewRule.init(ctxOf(t), {});
  assert.equal(init.ruleType, 'scale');
  assert.equal(init.__title, 'New Formatting Rule');
  assert.equal(cfNewRule.init(ctxOf(t), {rule: icons}).__title, 'Edit Formatting Rule');
  assert.equal(cfNewRule.derive({...init, iconSet: '5Arrows'}, ['iconSet']).iconRules.length, 4);
  const call = cfNewRule.toCommand({...init, ruleType: 'formula', formula: '=B2>10', dxf: {fill: {pattern: 'solid', fg: '#FFFF00'}}});
  await t.batch(call.batch);
  assert.equal(cfFor(t.content, 0).look(2, 1).dxf.fill.fg, '#FFFF00');
  assert.equal(cfFor(t.content, 0).look(1, 1), null);
});

test('New Formatting Rule: what OK refuses', () => {
  const p = patch => problems({...blankRuleValues(), ...patch});
  assert.deepEqual(p({ruleType: 'cells', cellsKind: 'cellValue', value: ''}).map(x => x.field), ['value', 'value2']);
  assert.deepEqual(p({ruleType: 'cells', cellsKind: 'cellValue', operator: 'greaterThan', value: '3'}), []);
  assert.deepEqual(p({ruleType: 'cells', cellsKind: 'text', text: ''}).map(x => x.field), ['text']);
  assert.deepEqual(p({ruleType: 'rank', rank: 0}).map(x => x.field), ['rank']);
  assert.deepEqual(p({ruleType: 'rank', rank: 101, rankPercent: true}).map(x => x.field), ['rank']);
  assert.deepEqual(p({ruleType: 'formula', formula: ' '}).map(x => x.field), ['formula']);
  assert.deepEqual(p({ruleType: 'scale', formatStyle: '2color', minType: 'num', minValue: '', maxType: 'max'}).map(x => x.field), ['minValue']);
  assert.deepEqual(p({ruleType: 'scale', formatStyle: '2color', minType: 'num', minValue: 'abc'}).map(x => x.field), ['minValue']);
  assert.deepEqual(p({ruleType: 'scale', formatStyle: 'dataBar', barMinType: 'percent', barMinValue: '150'}).map(x => x.field), ['barMinValue']);
  assert.deepEqual(p({ruleType: 'scale', formatStyle: 'iconSet', iconRules: [{type: 'num', value: '', gte: true}, {type: 'percent', value: '33', gte: true}]}).map(x => x.field), ['iconRules.0']);
  assert.deepEqual(p({ruleType: 'duplicates'}), []);
});

test('the conditional Format Cells collects a differential format and gives it back', () => {
  const dxf = {numFmt: '0.0', font: {bold: true, italic: true, underline: 'single', strike: true, color: '#FF0000'}, fill: {pattern: 'solid', fg: '#FFFF00'},
    borders: {top: {style: 'thin', color: '#00FF00'}, left: {style: 'double'}}};
  const v0 = valuesFromDxf(dxf);
  assert.equal(v0.category, 'Number');
  assert.equal(v0.fontStyle, 'Bold Italic');
  assert.equal(v0.background, '#FFFF00');
  assert.equal(v0.top, 'thin');
  assert.deepEqual(dxfFromValues(v0), dxf);
  assert.deepEqual(dxfFromValues(valuesFromDxf(null)), {});
  assert.deepEqual(dxfFromValues({...valuesFromDxf(null), patternStyle: 'darkGrid', patternColor: '#112233', background: '#AABBCC'}), {fill: {pattern: 'darkGrid', fg: '#112233', bg: '#AABBCC'}});
  assert.deepEqual(cfFormatCells.toCommand({}).batch, []);
  assert.equal(cfFormatCells.init({}, {dxf: {font: {bold: true}}}).bold, true);
  assert.deepEqual(cfFormatCells.validate(valuesFromDxf({numFmt: 'General'})), []);
});

test('the Rules Manager dialog: every sheet\'s rules, and OK sends the sheets that changed', async () => {
  const t = await book();
  await run(t, 'home.conditionalFormat', {range: 'B2:B3', rule: {type: 'cellIs', operator: 'greater', value: '5'}});
  await run(t, 'home.conditionalFormat', {range: 'B2:B3', preset: 'dataBar.blue'});
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sh:s1/B2', focus: '/sh:s1/B2'}], primary: 0});
  const init = manageRules.init(ctxOf(t));
  assert.equal(init.showFor, 'selection');
  assert.equal(init.sheetId, 's1');
  assert.deepEqual(init.sheets.map(x => x.name), ['Sheet1', 'Sheet2']);
  assert.equal(init.rules.s1.length, 2);
  assert.equal(init.rules.s2.length, 0);
  assert.equal(manageRules.toCommand(init).batch.length, 0, 'nothing changed, nothing sent');
  const next = structuredClone(init);
  next.rules.s1.reverse();
  next.rules.s1[0].stopIfTrue = true;
  next.rules.s1[1].ranges = '$B$2:$B$3,D1';
  const call = manageRules.toCommand(next);
  assert.equal(call.batch.length, 1);
  assert.equal(call.batch[0].params.sheet, '/sh:s1');
  await t.batch(call.batch);
  const rules = t.content.sheets[0].conditionalFormats;
  assert.equal(rules[0].rule.type, 'cellIs');
  assert.equal(rules[0].stopIfTrue, true);
  assert.deepEqual(rules[1].ranges, ['B2:B3', 'D1']);
  assert.equal(manageRules.validate({rules: {s1: [{ranges: 'nonsense'}]}}).length, 1);
  assert.equal(manageRules.validate({rules: {s1: [{ranges: 'A1:B2,C3'}]}}).length, 0);
});
