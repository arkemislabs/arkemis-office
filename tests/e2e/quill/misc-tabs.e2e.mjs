// Quill's SmartArt Design tab (PowerPoint's SmartArt engine drawn on the page), Table Design's pen and View Gridlines, and View's Dark Mode, end
// to end through the bridge, in the new shell. No OS input: ribbon controls through ui.activate / ui.menu, the document read back over the bridge
// and every step captured (capturePage).
//
// Behaviour fidelity:
// 1. wordcraft crates/engine/src/cmd/smart_art.rs and ribbon/charts.rs (SmartArt Design), cmd/view.rs (table.viewGridlines, view.darkMode),
//    cmd/tools/specs.rs (table.borderPainter); Word: SmartArt Design (Add Shape, Text Pane, Promote, Demote, Layouts, Change Colors, SmartArt
//    Styles, Reset Graphic), Table Design's Line Style, Line Weight and Pen Color, View Gridlines, Dark Mode.
// 2. The same commands run from the window (the person's path), each change one undo step.
// 3. This file; the engine side is tests/quill/smartart.test.mjs and tests/quill/misc-tabs.test.mjs.
//
// Evidence: artifacts/e2e/quill/misc-tabs/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

const para = text => ({type: 'paragraph', content: [{type: 'text', text}]});
function seedDoc(id) {
  const seed = createFile('quill', 'Process notes');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Process notes'}]},
    para('Every release follows the steps in the diagram below.'),
    para(''),
    para('The table lists who owns each step.'),
    para(''),
    para('Done.'),
  ]};
  return migrateFile(seed);
}

test('quill SmartArt Design, Table Design pen, View Gridlines and Dark Mode', {timeout: 900_000}, async () => {
  const seed = seedDoc('quill-misc-tabs');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/misc-tabs', files: [seed], renderer});
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

    // SmartArt: inserted at the caret, selected, drawn on the page; the SmartArt Design tab shows.
    await run('caret.set', {pos: {block: 2, off: 0}});
    await tab('insert');
    assert.ok((await controls()).has('insert.illustrations.smartart'), 'Insert › SmartArt is on the Insert tab');
    await activate('insert.illustrations.smartart');
    const dlg0 = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg0.id, 'dialog.insertSmartArt');
    await app.rpc('ui.dialog.set', {doc, values: {category: 'Process', kind: 'chevron'}});
    await settle(600);
    await app.capture('0-choose-smartart', {doc});
    await app.rpc('ui.dialog.set', {doc, values: {kind: 'process'}});
    await app.rpc('ui.dialog.submit', {doc});
    await run('smartArt.items', {items: ['Plan', 'Build', 'Test', 'Ship']});
    await settle(700);
    await app.capture('1-smartart-inserted', {doc});
    await tab('smart-art-design');
    const ids = await controls();
    for (const id of ['smartart-design.create-graphic.add-shape', 'smartart-design.create-graphic.add-bullet', 'smartart-design.create-graphic.promote', 'smartart-design.create-graphic.demote',
      'smartart-design.create-graphic.text-pane', 'smartart-design.create-graphic.right-to-left', 'smartart-design.create-graphic.move-up', 'smartart-design.create-graphic.move-down',
      'smartart-design.layouts.layouts', 'smartart-design.smartart-styles.change-colors', 'smartart-design.smartart-styles.smartart-styles', 'smartart-design.reset.reset-graphic',
      'smartart-design.size.h', 'smartart-design.size.w']) assert.ok(ids.has(id), `${id} is on SmartArt Design`);
    assert.ok(!ids.has('smartart-design.create-graphic.layout') && !ids.has('smartart-design.reset.convert'), 'Layout and Convert stay hidden');
    await app.capture('2-smartart-design-tab', {doc});
    await menu('smartart-design.layouts.layouts');
    await settle();
    await app.capture('3-layouts-gallery', {doc});
    await menu('smartart-design.layouts.layouts', false);
    await menu('smartart-design.smartart-styles.change-colors');
    await settle();
    await app.capture('4-change-colors', {doc});
    await menu('smartart-design.smartart-styles.change-colors', false);
    await menu('smartart-design.smartart-styles.smartart-styles');
    await settle();
    await app.capture('5-smartart-styles', {doc});
    await menu('smartart-design.smartart-styles.smartart-styles', false);

    // Edit: the Text Pane, Add Shape, Demote, a layout, colours, a style.
    await activate('smartart-design.create-graphic.text-pane');
    await settle(700);
    await app.capture('6-text-pane', {doc});
    await activate('smartart-design.create-graphic.add-shape');
    assert.ok((await read()).includes('"level":0'), 'an item was added');
    await activate('smartart-design.create-graphic.demote');
    await activate('smartart-design.layouts.layouts', 'hierarchy');
    await settle(600);
    assert.ok((await read()).includes('hierarchy'), 'the layout changed');
    await activate('smartart-design.smartart-styles.change-colors', 'colorful');
    await activate('smartart-design.smartart-styles.smartart-styles', 'polished');
    await settle(700);
    await app.capture('7-hierarchy-colorful', {doc});
    await run('smartArt.layout', {layout: 'gear'});
    await run('smartArt.style', {style: 'subtle'});
    await run('smartArt.colors', {colors: 'range34'});
    await settle(700);
    await app.capture('8-gear-range', {doc});
    await run('smartArt.layout', {layout: 'orgChart'});
    await run('smartArt.rtl', {value: true});
    await settle(700);
    await app.capture('9-org-chart-right-to-left', {doc});
    await activate('smartart-design.reset.reset-graphic');
    await settle(600);
    await app.capture('10-reset', {doc});

    // Table Design: the pen, the Border Painter, View Gridlines (Table Layout).
    await run('caret.set', {pos: {block: 4, off: 0}});
    await run('insert.table', {rows: 3, cols: 3});
    await settle(600);
    await tab('table-design');
    const td = await controls();
    for (const id of ['table-design.borders.line-style', 'table-design.borders.line-weight', 'table-design.borders.pen-color', 'table-design.borders.border-painter']) assert.ok(td.has(id), `${id} is on Table Design`);
    await menu('table-design.borders.line-style');
    await settle();
    await app.capture('11-line-style', {doc});
    await menu('table-design.borders.line-style', false);
    await run('table.pen', {style: 'double', width: 1.5, color: '#C00000'});
    await activate('table-design.borders.border-painter');
    await settle(600);
    assert.ok((await read()).includes('"double"'), 'the Border Painter drew the pen on the cells');
    await app.capture('12-border-painter', {doc});
    await tab('table-layout');
    await activate('table-layout.table.view-gridlines');
    await settle(600);
    await app.capture('13-view-gridlines', {doc});
    await activate('table-layout.alignment.cell-margins');
    const dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.tableCellMargins');
    await app.rpc('ui.dialog.set', {doc, values: {top: 4, left: 14, bottom: 4, right: 14}});
    await settle();
    await app.capture('14-cell-margins-box', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    await settle(600);
    await app.capture('15-cell-margins-applied', {doc});

    // View: Dark Mode draws the pages dark.
    await tab('view');
    await activate('view.dark-mode.switch-modes');
    await settle(700);
    await app.capture('16-dark-mode', {doc});
    await activate('view.dark-mode.switch-modes');
  } catch (e) { throw new Error(`${e.message}${log()}`); } finally { await app.close(); }
});
