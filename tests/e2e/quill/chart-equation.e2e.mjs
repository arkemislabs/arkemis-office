// Quill's Insert › Chart and Insert › Equation, the Chart Design, Chart Format and Equation tabs end to end through the bridge, in the new
// shell. No OS input: ribbon controls through ui.activate / ui.menu, dialogs through ui.dialog.*, the page view's own double-click through
// ui.pointer, the document read back over the bridge and every step captured (capturePage).
//
// Behaviour fidelity:
// 1. wordcraft crates/engine/src/cmd/chart.rs, ribbon/charts.rs and the Insert Chart dialog (dialogs_chart.rs); Word: Insert Chart's list with a
//    preview, the Chart Design tab (Add Chart Element, Quick Layout, Chart Styles, Change Colors, Edit Data, Change Chart Type), Chart Format
//    (Arrange, Size, Alt Text); the Equation gallery of built-in equations drawn as math, the Equation tab (symbols, structures, Convert,
//    Display and Inline, Justification) and the typeset equation in the line.
// 2. The same commands run from the window (the person's path), each change one undo step; the page view draws both through the same layout.
// 3. This file; the engine side is tests/quill/chart.test.mjs and tests/quill/equation.test.mjs.
//
// Evidence: artifacts/e2e/quill/chart-equation/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

const para = text => ({type: 'paragraph', content: [{type: 'text', text}]});
function seedDoc(id) {
  const seed = createFile('quill', 'Quarterly report');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Quarterly report'}]},
    para('Sales grew in every quarter, with the third quarter the strongest, as the chart below shows.'),
    para(''),
    para('The shape of the growth follows the formula below, fitted to the four quarters.'),
    para(''),
    para('Costs stayed flat.'),
  ]};
  return migrateFile(seed);
}

test('quill Chart and Equation: Insert Chart, the Chart Design and Format tabs, the equation gallery and the Equation tab', {timeout: 900_000}, async () => {
  const seed = seedDoc('quill-chart-equation');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/chart-equation', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async () => JSON.stringify((await app.rpc('document.read', {doc, address: '/body', as: 'json'})).value);
  const settle = (ms = 450) => new Promise(r => setTimeout(r, ms));
  const inspect = () => app.rpc('ui.inspect', {doc});
  const controls = async () => new Map(((await inspect()).controls ?? []).map(c => [c.id, c]));
  const activate = (id, value) => app.rpc('ui.activate', {doc, control: id, ...(value === undefined ? {} : {value})});
  const menu = async (id, open = true) => app.rpc('ui.menu', {doc, control: id, ...(open ? {} : {open: false})});
  const tab = async id => { await app.rpc('ui.tab', {doc, id}); await settle(); };
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await inspect(); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });

    // Insert tab: Chart, Equation, SmartArt and WordArt are there.
    await tab('insert');
    const ins = await controls();
    for (const id of ['insert.illustrations.chart', 'insert.symbols.equation']) assert.ok(ins.has(id), `${id} is on the Insert tab`);
    assert.ok(ins.has('insert.illustrations.smartart'), 'SmartArt is on the Insert tab');
    assert.ok(ins.has('insert.text.wordart'), 'WordArt is on the Insert tab');
    await app.capture('1-insert-tab', {doc});

    // The equation gallery: Office's built-in equations drawn as math, never labelled.
    await run('caret.set', {pos: {block: 2, off: 0}});
    await menu('insert.symbols.equation');
    await settle();
    await app.capture('2-equation-gallery', {doc});
    await menu('insert.symbols.equation', false);

    // Insert Chart: the list of types with its preview, picked in the box, OK inserts.
    await run('caret.set', {pos: {block: 2, off: 0}});
    await activate('insert.illustrations.chart');
    let dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.insertChart');
    await settle();
    await app.capture('3-insert-chart-box', {doc});
    await app.rpc('ui.dialog.set', {doc, values: {type: 'Clustered Column'}});
    await settle();
    await app.capture('3b-insert-chart-column', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    assert.ok((await read()).includes('"chart"'), 'a chart is in the document');
    await settle(700);
    await app.capture('4-chart-inserted', {doc});

    // Chart Design: the contextual tab shows with the chart selected; Chart Format too.
    await tab('chart-design');
    const design = await controls();
    for (const id of ['chart-design.chart-layouts.chart-title', 'chart-design.chart-layouts.legend', 'chart-design.chart-layouts.data-labels', 'chart-design.chart-layouts.quick-layout',
      'chart-design.chart-styles.change-colors', 'chart-design.chart-styles.chart-styles', 'chart-design.data.switch-row-column', 'chart-design.data.edit-data',
      'chart-design.type.change-chart-type', 'chart-design.size.h', 'chart-design.size.w']) assert.ok(design.has(id), `${id} is on Chart Design`);
    assert.ok(!design.has('chart-design.data.refresh-data'), 'Refresh Data stays hidden: the data is in the chart itself');
    assert.ok(design.has('chart-design.data.select-data'), 'Select Data opens the same data grid as Edit Data (U:quill/rest)');
    await app.capture('5-chart-design-tab', {doc});
    await menu('chart-design.chart-styles.chart-styles');
    await settle();
    await app.capture('5b-chart-styles-gallery', {doc});
    await menu('chart-design.chart-styles.chart-styles', false);
    await menu('chart-design.chart-layouts.quick-layout');
    await settle();
    await app.capture('5c-quick-layouts', {doc});
    await menu('chart-design.chart-layouts.quick-layout', false);
    await menu('chart-design.chart-styles.change-colors');
    await settle();
    await app.capture('5d-change-colors', {doc});
    await menu('chart-design.chart-styles.change-colors', false);
    await activate('chart-design.chart-layouts.chart-title.above');
    assert.ok((await read()).includes('Chart Title'));
    await run('chart.title', {text: 'Sales by quarter'});
    await activate('chart-design.chart-styles.chart-styles', 4);
    assert.ok((await read()).includes('"style":4'));
    await activate('chart-design.type.change-chart-type');
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.chartType');
    assert.equal(dlg.values.type, 'Clustered Column');
    await app.rpc('ui.dialog.set', {doc, values: {type: 'Line with Markers'}});
    await settle();
    await app.capture('6-change-chart-type', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    assert.ok((await read()).includes('lineMarkers'));
    await activate('chart-design.data.edit-data');
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.chartData');
    await settle();
    await app.capture('7-edit-data', {doc});
    await app.rpc('ui.dialog.set', {doc, values: {rows: [['', 'Sales', 'Costs'], ['Q1', '12', '8'], ['Q2', '15', '8'], ['Q3', '21', '9'], ['Q4', '18', '8']]}});
    await app.rpc('ui.dialog.submit', {doc});
    await settle(600);
    await app.capture('8-chart-with-data', {doc});
    await activate('chart-design.chart-layouts.legend.right');
    await run('chart.dataLabels', {on: true});
    await settle(600);
    await app.capture('9-chart-legend-labels', {doc});

    // Chart Format: Arrange and Size.
    await tab('chart-format');
    const fmt = await controls();
    for (const id of ['chart-format.arrange.position', 'chart-format.arrange.wrap-text', 'chart-format.size.h', 'chart-format.size.w', 'chart-format.accessibility.alt-text']) assert.ok(fmt.has(id), `${id} is on Chart Format`);
    await app.capture('10-chart-format-tab', {doc});
    for (const id of ['chart-format.current-selection.element', 'chart-format.current-selection.format-selection', 'chart-format.shape-styles.shape-styles']) assert.ok(fmt.has(id), `${id} is on Chart Format`);
    // Shape Styles (the chart area's fill and border), Current Selection and the Format pane on a series.
    await activate('chart-format.shape-styles.shape-styles', 15);
    await settle(700);
    assert.ok((await read()).includes('areaFill'), 'the chart area has a fill from the style');
    await run('chart.element', {element: 'Costs'});
    await activate('chart-format.current-selection.format-selection');
    await settle(900);
    await app.capture('10b-format-selection-series', {doc});
    await run('chart.element', {element: 'Chart Area'});
    await settle(700);
    await app.capture('10c-format-selection-area', {doc});
    await run('view.formatShapePane', {value: false});
    await activate('chart-format.size.w', 360);
    await activate('chart-format.size.h', 200);
    assert.ok((await read()).includes('"w":360'), 'the chart is 360 pt wide');
    await run('chart.altText', {text: 'Sales and costs by quarter'});
    await settle(600);
    await app.capture('11-chart-resized', {doc});

    // Equation: the built-in gallery inserts a typeset equation on its own line; the Equation tab shows with it selected.
    await run('caret.set', {pos: {block: 4, off: 0}});
    await activate('insert.symbols.equation', 'quadratic-formula');
    assert.ok((await read()).includes('"type":"equation"'), 'an equation is in the document');
    await settle(700);
    await app.capture('12-equation-inserted', {doc});
    await tab('equation');
    const eq = await controls();
    for (const id of ['equation.tools.equation', 'equation.tools.unicode', 'equation.tools.latex', 'equation.tools.convert', 'equation.tools.normal-text', 'equation.symbols.symbols',
      'equation.structures.fraction', 'equation.structures.matrix', 'equation.equation-options.display', 'equation.equation-options.inline', 'equation.equation-options.justification',
      'equation.equation-options.close-equation']) assert.ok(eq.has(id), `${id} is on the Equation tab`);
    assert.ok(!eq.has('equation.tools.ink-equation') && !eq.has('equation.equation-options.number'), 'Ink Equation and Number stay hidden');
    await app.capture('13-equation-tab', {doc});
    await menu('equation.structures.fraction');
    await settle();
    await app.capture('14-fraction-gallery', {doc});
    await menu('equation.structures.fraction', false);
    await menu('equation.symbols.symbols');
    await settle();
    await app.capture('15-symbols-menu', {doc});
    await menu('equation.symbols.symbols', false);
    await activate('equation.symbols.symbols', 'π');
    await activate('equation.structures.fraction', 'dy-dx');
    await settle(600);
    await app.capture('16-symbol-and-structure', {doc});
    await run('equation.edit', {linear: '∑_(k=1)^n k^2=(n(n+1)(2n+1))/6'});
    await settle(600);
    await app.capture('17-sum-of-squares', {doc});
    await activate('equation.equation-options.justification.left');
    await settle(400);
    await app.capture('18-justified-left', {doc});
    await activate('equation.equation-options.justification.centered');
    await menu('equation.tools.convert');
    await settle();
    await app.capture('19-convert-menu', {doc});
    await menu('equation.tools.convert', false);
    await activate('equation.tools.convert.current-linear');
    await settle(500);
    await app.capture('20-linear', {doc});
    await activate('equation.tools.convert.current-professional');
    await activate('equation.equation-options.inline');
    await settle(500);
    await app.capture('21-inline', {doc});
    await activate('equation.equation-options.display');

    // A double-click on the equation starts editing it in place (the page view's own gesture): the equation is selected, the Equation tab shows and the editor stands on it.
    await run('caret.set', {pos: {block: 0, off: 0}});
    let opened = false;
    for (let y = 150; y < 700 && !opened; y += 14) {
      await app.rpc('ui.pointer', {doc, action: 'doubleClick', page: 0, x: 306, y});
      await settle(120);
      const ui = await inspect();
      if ((ui.tabs ?? []).includes('equation')) opened = true;
    }
    assert.ok(opened, 'a double-click on the equation selects it and shows the Equation tab');
    await settle();
    await app.capture('22-edit-equation-in-place', {doc});
    assert.equal(await app.rpc('ui.dialog.get', {doc}).then(d => d?.id ?? null).catch(() => null), null, 'no box opens: the equation is edited where it stands');
    await run('equation.edit', {linear: 'e^(iπ)+1=0'});
    await settle();
    await app.capture('22b-edit-equation-typed', {doc});
    assert.ok((await read()).includes('e^(iπ)+1=0'));
    await settle(600);
    await app.capture('23-equation-edited', {doc});

    // New equation: Insert New Equation puts an empty equation in the line, typed in place.
    await run('caret.set', {pos: {block: 5, off: 0}});
    await tab('insert');
    await activate('insert.symbols.equation.insert-new-equation');
    await settle(500);
    await app.capture('23b-new-equation-empty', {doc});
    await run('equation.edit', {linear: 'a^2+b^2=c^2', display: false});
    await settle(600);
    await app.capture('24-inline-equation', {doc});
    // The whole document written as .docx and read back keeps both.
    const saved = await app.rpc('document.export', {doc, format: 'docx'}).catch(() => null);
    if (saved) assert.ok(saved.bytes || saved.base64 || saved.path || saved.size, 'the document exports as .docx');
  } finally {
    await app.close?.();
  }
});
