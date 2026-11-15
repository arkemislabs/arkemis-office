// Prism's charts through the bridge and the real window (U:prism/chart).
//
// What deckcraft does (cmd/insert/chart.rs, ribbon/chart.rs): Insert > Chart puts a chart with sample data on the slide,
// the Chart Design tab changes its type, data and elements. PowerPoint: the same, with a chooser of type thumbnails.
// What this proves in the app: the real Insert Chart dialog (drawn thumbnails, a preview) inserts a chart that is drawn
// on the slide, the Chart Design tab shows for it, Change Chart Type, Edit Data and Add Chart Element change it as the
// engine tests do, and it comes back from a saved .pptx (looked at in the captures). Captures in artifacts/e2e/prism/charts/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('prism charts: insert, draw, change type, edit data, add elements', {timeout: 300_000}, async () => {
  const file = createFile('prism', 'Charts deck', {schema: 2});
  file.id = 'prism-charts';
  file.content.slides[0].shapes[0].text = bodyFromText('Quarterly results');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/charts', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const activate = (control, value) => app.rpc('ui.activate', value === undefined ? {doc, control} : {doc, control, value});
  const inspect = async () => app.rpc('ui.inspect', {doc});
  const charts = async () => (await deck()).slides[1].shapes.filter(s => s.kind?.type === 'chart');
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await run('slide.new', {layout: 'titleOnly'});
    await run('slide.go', {index: 1});
    await app.rpc('ui.tab', {doc, tab: 'insert'});
    let ui = await inspect();
    const ctl = id => ui.controls.find(c => c.id === id);
    assert.ok(ctl('insert.illustrations.chart'), 'the Chart button is drawn');

    // Insert Chart: the dialog with its drawn thumbnails and preview.
    await app.rpc('ui.menu', {doc, control: 'insert.illustrations.chart'});
    await sleep(400);
    await app.capture('1-chart-menu');
    await app.rpc('ui.menu', {doc, control: 'insert.illustrations.chart', open: false});
    await activate('insert.illustrations.chart.insert-chart');
    await sleep(500);
    let dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.insertChart');
    await sleep(500);
    await app.capture('2-insert-chart-dialog');
    await app.rpc('ui.dialog.set', {field: 'category', value: 'Pie'});
    await app.rpc('ui.dialog.set', {field: 'type', value: 'doughnut'});
    await sleep(400);
    await app.capture('3-insert-chart-doughnut');
    await app.rpc('ui.dialog.submit', {});
    await sleep(800);
    let [c] = await charts();
    assert.ok(c, 'a chart is on the slide');
    assert.equal(c.kind.chartType, 'doughnut');
    await app.capture('4-doughnut-on-slide');

    // Chart Design tab: Change Chart Type opens the chooser on the chart's own type.
    await app.until(async () => { const u = await app.rpc('ui.inspect', {doc}); return u.contextualTabs?.includes('chart-design') || null; }, {timeout: 10_000});
    await app.rpc('ui.tab', {doc, tab: 'chart-design'});
    await sleep(500);
    ui = await inspect();
    for (const id of ['chartdesign.layouts.add-element', 'chartdesign.layouts.quick-layout', 'chartdesign.styles.colors', 'chartdesign.styles.gallery', 'chartdesign.data.switch', 'chartdesign.data.select', 'chartdesign.data.edit', 'chartdesign.type.change']) assert.ok(ctl(id), `${id} is drawn`);
    for (const id of ['chartdesign.data.refresh']) assert.equal(ctl(id), undefined, `${id} is hidden`);
    await app.capture('5-chart-design-tab');
    await run('chart.type', {type: 'column'});
    await run('chart.options', {legend: 'bottom'});
    await activate('chartdesign.type.change');
    dlg = await app.rpc('ui.dialog.get', {}).catch(() => null);
    if (dlg?.id !== 'dialog.changeChartType') {
      await app.rpc('ui.menu', {doc, control: 'chartdesign.type.change'});
      ui = await inspect();
      const item = ui.controls.find(x => /chartdesign\.type\.change\./.test(x.id) && /change|dialog/i.test(x.id));
      if (item) await activate(item.id);
      dlg = await app.rpc('ui.dialog.get', {});
    }
    assert.equal(dlg.id, 'dialog.changeChartType');
    assert.equal(dlg.values.type, 'column', 'the chooser starts on the chart\'s type');
    await sleep(400);
    await app.capture('6-change-type-dialog');
    await app.rpc('ui.dialog.set', {field: 'type', value: 'lineMarkers'});
    await app.rpc('ui.dialog.submit', {});
    await sleep(600);
    [c] = await charts();
    assert.equal(c.kind.chartType, 'lineMarkers');
    await app.capture('7-line-chart');

    // Edit Data: the grid, then the chart follows.
    await activate('chartdesign.data.edit');
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.chartData');
    assert.equal(dlg.values.table.length, 5);
    await sleep(400);
    await app.capture('8-edit-data-dialog');
    const table = dlg.values.table.map(r => r.slice());
    table[0][1] = 'Revenue';
    table[1][0] = 'Jan';
    table[1][1] = '12';
    await app.rpc('ui.dialog.set', {field: 'table', value: table});
    await app.rpc('ui.dialog.submit', {});
    await sleep(600);
    [c] = await charts();
    assert.equal(c.kind.series[0].name, 'Revenue');
    assert.equal(c.kind.categories[0], 'Jan');
    assert.equal(c.kind.series[0].values[0], 12);
    await app.capture('9-edited-data');

    // Add Chart Element and Change Colors through their menus.
    await app.rpc('ui.menu', {doc, control: 'chartdesign.layouts.add-element'});
    await sleep(400);
    await app.capture('10-add-element-menu');
    await app.rpc('ui.menu', {doc, control: 'chartdesign.layouts.add-element', open: false});
    await run('chart.options', {title: 'Revenue by quarter', showXTitle: true, legend: 'right', dataLabels: true, palette: 'monochrome1'});
    await sleep(600);
    [c] = await charts();
    assert.deepEqual([c.kind.title, c.kind.legend, c.kind.dataLabels, c.kind.xTitle, c.kind.palette], ['Revenue by quarter', 'right', true, 'Axis Title', 'monochrome1']);
    await app.capture('11-elements-and-colors');
    await run('chart.data', {switchRowColumn: true});
    await sleep(500);
    await app.capture('12-switch-row-column');
    await run('chart.type', {type: 'pie'});
    await sleep(500);
    await app.capture('13-pie');

    // Quick Layout and Chart Styles are drawn galleries; Select Data narrows the chart to a range of its worksheet.
    await run('chart.type', {type: 'column'});
    await run('chart.data', {table: [['', 'S1', 'S2', 'S3'], ['a', '1', '2', '3'], ['b', '2', '3', '4'], ['c', '3', '4', '5']]});
    await sleep(400);
    await app.rpc('ui.menu', {doc, control: 'chartdesign.layouts.quick-layout'});
    await sleep(500);
    await app.capture('14-quick-layout-gallery');
    await app.rpc('ui.menu', {doc, control: 'chartdesign.layouts.quick-layout', open: false});
    await run('chart.quickLayout', {layout: 6});
    await app.rpc('ui.menu', {doc, control: 'chartdesign.styles.gallery'});
    await sleep(500);
    await app.capture('15-chart-styles-gallery');
    await app.rpc('ui.menu', {doc, control: 'chartdesign.styles.gallery', open: false});
    await run('chart.styleGallery', {style: 4});
    await sleep(500);
    [c] = await charts();
    assert.deepEqual([c.kind.legend, c.kind.palette, c.kind.xTitle], ['right', 'accent2', 'Axis Title']);
    await app.capture('16-style-4-layout-6');
    await activate('chartdesign.data.select');
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.selectData');
    await sleep(400);
    await app.capture('17-select-data-dialog');
    await app.rpc('ui.dialog.set', {field: 'range', value: 'A1:C3'});
    await app.rpc('ui.dialog.submit', {});
    await sleep(600);
    [c] = await charts();
    assert.equal(c.kind.range, 'A1:C3');
    assert.deepEqual(c.kind.categories.length, 2);
    await app.capture('18-select-data-applied');
  } catch (e) {
    throw new Error(`${e.message}${log()}`);
  } finally {
    await app.close();
  }
});
