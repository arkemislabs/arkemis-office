// Quill Layout and Design tabs (U:quill/page, U:quill/design, U:quill/objects/arrange) end to end
// through the bridge, in the new shell. No OS input: ribbon controls through ui.activate / ui.menu,
// dialogs through ui.dialog.get / set / submit, Undo through ui.key (KeyRouter), and the document
// read back over the bridge.
//
// Behaviour fidelity:
// 1. ArtCraft crates/engine/src/cmd/page.rs, design.rs and objects/specs.rs, the ribbon in
//    crates/ui-egui/src/ribbon/layout.rs and design.rs, the dialogs in dispatch.rs (page setup,
//    watermark), page_setup.rs, dialogs_insert/columns.rs, dialogs_para.rs (Borders and Shading);
//    Word's Layout and Design tabs: Margins presets with previews, Custom Margins… opens Page Setup,
//    Orientation turns the pages, Columns lays text in columns, Breaks insert breaks the pages
//    honour, Watermark draws on every page, Page Color paints the paper, Page Borders opens Borders
//    and Shading on Page Border and draws the box.
// 2. The same commands run from the window (the person's path), land in the document as one undo
//    step each, and the page view shows them (captures below).
// 3. This file; the engine side is tests/quill/layout-page.test.mjs, tests/quill/design.test.mjs and
//    tests/quill/upstream/page_tests.test.mjs, design_tests.test.mjs.
//
// Evidence: artifacts/e2e/quill/layout-design/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

const TEXT = 'Arkemis Quill lays out pages the way Word does: margins, orientation, paper size, columns and breaks all reflow the page view. ';

function seedDoc(id) {
  const seed = createFile('quill', 'Layout and Design');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Quarterly report'}]},
    ...Array.from({length: 9}, (_, i) => ({type: 'paragraph', content: [{type: 'text', text: `${i + 1}. ${TEXT.repeat(2)}`}]})),
  ]};
  return migrateFile(seed);
}

test('quill Layout and Design tabs: margins, page setup, orientation, columns, breaks, watermark, page color, page borders, arrange', {timeout: 240_000}, async () => {
  const seed = seedDoc('quill-layout-design');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/layout-design', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const section = () => run('layout.section');
  const settle = () => new Promise(r => setTimeout(r, 400));
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });

    // The Layout tab with Page Setup, Paragraph and Arrange.
    await app.rpc('ui.tab', {doc, id: 'layout'});
    await settle();
    const ui = await app.rpc('ui.inspect', {doc});
    const ids = new Set((ui.controls ?? []).map(c => c.id));
    for (const id of ['layout.page-setup.margins', 'layout.page-setup.orientation', 'layout.page-setup.size', 'layout.page-setup.columns',
      'layout.page-setup.breaks', 'layout.page-setup.line-numbers', 'layout.arrange.position', 'layout.arrange.wrap-text', 'layout.arrange.rotate']) {
      assert.ok(ids.has(id), `${id} is on the Layout tab`);
    }
    assert.ok(!ids.has('layout.page-setup.hyphenation'), 'Hyphenation stays hidden: the layout does not hyphenate yet');
    await app.capture('1-layout-tab', {doc});

    // Margins: the menu with its previews, then Wide.
    await app.rpc('ui.menu', {doc, control: 'layout.page-setup.margins'});
    await settle();
    await app.capture('2-margins-menu', {doc});
    await app.rpc('ui.menu', {doc, control: 'layout.page-setup.margins', open: false});
    await app.rpc('ui.activate', {doc, control: 'layout.page-setup.margins.wide'});
    let x = await section();
    assert.deepEqual([x.marginLeft, x.marginRight], [144, 144], 'Wide: 2" left and right');

    // Custom Margins… opens Page Setup on its Margins page; Landscape and Normal margins as one step.
    await app.rpc('ui.activate', {doc, control: 'layout.page-setup.margins.custom-margins'});
    let dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.pageSetup');
    assert.equal(dlg.tab, 'Margins', 'opened on Margins');
    assert.deepEqual([dlg.values.left, dlg.values.right], [2, 2]);
    await app.rpc('ui.dialog.set', {doc, values: {left: 1, right: 1}});
    await app.rpc('ui.dialog.set', {doc, values: {orientation: 'landscape'}});
    await settle();
    await app.capture('3-page-setup-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    x = await section();
    assert.equal(x.landscape, true);
    assert.ok(x.pageW > x.pageH, 'the page is landscape');
    await settle();
    await app.capture('4-landscape-pages', {doc});
    // One undo step takes the whole dialog back.
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    x = await section();
    assert.deepEqual([x.landscape, x.marginLeft], [false, 144], 'undo: portrait with the Wide margins again');
    await app.rpc('ui.activate', {doc, control: 'layout.page-setup.orientation.landscape'});
    assert.equal((await section()).landscape, true);
    await app.rpc('ui.activate', {doc, control: 'layout.page-setup.orientation.portrait'});
    await app.rpc('ui.activate', {doc, control: 'layout.page-setup.margins.normal'});

    // Size › A4.
    await app.rpc('ui.activate', {doc, control: 'layout.page-setup.size.a4'});
    x = await section();
    assert.deepEqual([Math.round(x.pageW), Math.round(x.pageH)], [595, 842]);

    // Columns › Two, then More Columns… (Left preset with a line between).
    await app.rpc('ui.activate', {doc, control: 'layout.page-setup.columns.two'});
    assert.equal((await section()).columns.count, 2);
    await settle();
    await app.capture('5-two-columns', {doc});
    await app.rpc('ui.activate', {doc, control: 'layout.page-setup.columns.more-columns'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.columns');
    assert.equal(dlg.values.count, 2);
    await app.rpc('ui.dialog.set', {doc, values: {presets: 'left'}});
    await app.rpc('ui.dialog.set', {doc, values: {separator: true}});
    await settle();
    await app.capture('6-columns-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    x = await section();
    assert.equal(x.columns.separator, true);
    assert.ok(x.columns.widths[0][0] < x.columns.widths[1][0], 'Left: the narrower column on the left');
    await app.rpc('ui.activate', {doc, control: 'layout.page-setup.columns.one'});

    // Breaks › Next Page before the fourth paragraph: a second section on a new page.
    await run('caret.docStart');
    for (let i = 0; i < 4; i++) await run('caret.paraDown');
    await app.rpc('ui.activate', {doc, control: 'layout.page-setup.breaks.next-page'});
    const body = await app.rpc('document.read', {doc, address: '/body', as: 'json'});
    assert.ok(JSON.stringify(body).includes('"section"'), 'a section break in the body');
    // Line Numbers › Continuous.
    await app.rpc('ui.activate', {doc, control: 'layout.page-setup.line-numbers.continuous'});
    assert.equal((await section()).lineNumbers?.restart, 'continuous');
    await app.rpc('ui.activate', {doc, control: 'layout.page-setup.line-numbers.line-numbering-options'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.lineNumbers');
    await app.rpc('ui.dialog.set', {doc, values: {countBy: 5}});
    await app.rpc('ui.dialog.submit', {doc});
    assert.equal((await section()).lineNumbers.countBy, 5);
    await app.rpc('ui.activate', {doc, control: 'layout.page-setup.line-numbers.none'});

    // The Design tab: a watermark, a page colour, a page border.
    await app.rpc('ui.tab', {doc, id: 'design'});
    await settle();
    const dui = await app.rpc('ui.inspect', {doc});
    const dids = new Set((dui.controls ?? []).map(c => c.id));
    for (const id of ['design.themes.themes', 'design.document-formatting.style-set', 'design.document-formatting.colors', 'design.document-formatting.fonts',
      'design.document-formatting.paragraph-spacing', 'design.page-background.watermark', 'design.page-background.page-color', 'design.page-background.page-borders']) {
      assert.ok(dids.has(id), `${id} is on the Design tab`);
    }
    await app.capture('7-design-tab', {doc});
    await app.rpc('ui.activate', {doc, control: 'design.themes.themes.studio'});
    await app.rpc('ui.activate', {doc, control: 'design.page-background.watermark.confidential'});
    await app.rpc('ui.activate', {doc, control: 'design.page-background.watermark.custom-watermark'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.watermark');
    assert.deepEqual([dlg.values.kind, dlg.values.text], ['text', 'CONFIDENTIAL']);
    await app.rpc('ui.dialog.set', {doc, values: {text: 'DRAFT'}});
    await app.rpc('ui.dialog.submit', {doc});
    await app.rpc('ui.activate', {doc, control: 'design.page-background.page-color.theme-colors-standard-colors-recent-colors-palette', value: '#FFF2CC'});
    await app.rpc('ui.activate', {doc, control: 'design.page-background.page-borders'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.borders');
    assert.equal(dlg.tab, 'Page Border', 'Page Borders opens Borders and Shading on Page Border');
    await app.rpc('ui.dialog.set', {doc, values: {pageSetting: 'box'}});
    await app.rpc('ui.dialog.set', {doc, values: {pageStyle: 'double', pageWidth: 3, pageColor: '#2F5597'}});
    await settle();
    await app.capture('8-page-border-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    x = await section();
    assert.equal(x.pageBorders?.top?.style, 'double');
    await settle();
    await app.capture('9-watermark-color-border', {doc});
    const pageColor = (await app.rpc('ui.inspect', {doc})).controls?.find(c => c.id === 'design.page-background.page-color');
    assert.equal(pageColor?.value, '#FFF2CC', 'the page colour is set');

    // Arrange: a shape, Square wrapping, then Position › Top Right.
    await app.rpc('ui.tab', {doc, id: 'layout'});
    await run('caret.docStart');
    await run('insert.shape', {kind: 'ellipse', width: 96, height: 64});
    await app.rpc('ui.activate', {doc, control: 'layout.arrange.wrap-text.square'});
    await app.rpc('ui.activate', {doc, control: 'layout.arrange.position.top-right'});
    const json = JSON.stringify(await app.rpc('document.read', {doc, address: '/body', as: 'json'}));
    assert.ok(json.includes('"wrap":"square"'), 'the shape wraps square');
    assert.ok(json.includes('"hRel":"margin"'), 'positioned on the margins');
    await settle();
    await app.capture('10-arrange-shape', {doc});
  } catch (e) {
    throw new Error(`${e.message}${log()}`);
  } finally {
    await app.close();
  }
});
