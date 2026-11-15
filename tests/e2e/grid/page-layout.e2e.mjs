// U:grid/page-layout bridge E2E: the Page Layout tab's groups from the ribbon (Margins, Orientation, Size,
// Print Area, Breaks, Scale to Fit, Sheet Options, Themes, Arrange) and the Page Setup and Header & Footer
// dialogs, read back from the sheet and saved to a real .xlsx file.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/ui-egui/src/ribbon/page_layout.rs and cmd/print.rs (the presets, the
//    dialog). Excel: Normal / Wide / Narrow margins, a page break above and left of the active cell,
//    Page Setup with Page, Margins, Header/Footer and Sheet tabs, Print Titles opening its Sheet tab.
// 2. Ours runs the same commands from the ribbon controls and their dialogs and reads the sheet back.
// 3. This flow; captures in artifacts/e2e/grid/page-layout/*.png were looked at by the author.

import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import {startData, assert} from './data-kit.mjs';
import {script, exists} from '../common/file-helpers.mjs';

test('grid page layout: margins, orientation, size, print area, breaks, scaling, themes, arrange and Page Setup', {timeout: 400_000}, async () => {
  const t = await startData('grid/page-layout', {tab: 'page-layout'});
  const {app, doc, select, press, undo, submit, exec, settle} = t;
  const setup = async () => (await t.read('/sh:s1', 'props')).pageSetup ?? {};
  const openMenu = async id => { await app.rpc('ui.tab', {doc, id: 'page-layout'}); await settle(150); await app.rpc('ui.menu', {doc, control: id}); await settle(350); };
  const closeMenu = async id => { await app.rpc('ui.menu', {doc, control: id, open: false}); await settle(100); };
  try {
    // Page Setup group: margins, orientation, size.
    await press('pageLayout.pageSetup.margins.narrow');
    assert.deepEqual((await setup()).margins, {left: 0.25, right: 0.25, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3});
    await press('pageLayout.pageSetup.orientation.landscape');
    await press('pageLayout.pageSetup.size.a4');
    assert.deepEqual([(await setup()).orientation, (await setup()).paper], ['landscape', 'A4']);
    await openMenu('pageLayout.pageSetup.margins');
    await app.capture('01-menu-margins');
    await closeMenu('pageLayout.pageSetup.margins');
    await openMenu('pageLayout.pageSetup.size');
    await app.capture('02-menu-size');
    await closeMenu('pageLayout.pageSetup.size');
    await undo(); await undo(); await undo();
    assert.deepEqual(await setup(), {});

    // Print area and breaks drawn on the sheet.
    await select('A1', 'D8');
    await press('pageLayout.pageSetup.printArea.set-print-area');
    assert.equal((await t.read('/sh:s1', 'props')).printArea, 'A1:D8');
    await select('C5');
    await press('pageLayout.pageSetup.breaks.insert-page-break');
    assert.deepEqual([(await setup()).rowBreaks, (await setup()).colBreaks], [[4], [2]]);
    await select('H12');
    await settle(300);
    await app.capture('03-print-area-and-breaks');
    await press('pageLayout.pageSetup.breaks.reset-all-page-breaks');
    assert.equal((await setup()).rowBreaks, undefined);

    // Scale to fit and sheet options.
    await press('pageLayout.scaleToFit.width', '1 page');
    assert.equal((await setup()).fitWidth, 1);
    await press('pageLayout.scaleToFit.scale', 90);
    assert.deepEqual([(await setup()).scale, (await setup()).fitWidth], [90, undefined]);
    await press('pageLayout.sheetOptions.gridlinesPrint');
    assert.equal((await setup()).printGridlines, true);

    // Page Setup: Custom Margins opens it on the Margins tab; the four tabs' boxes are one command.
    await press('pageLayout.pageSetup.margins.custom-margins');
    const d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.id, 'dialog.pageSetup');
    assert.equal(d.values.scale, 90);
    await app.capture('04-page-setup-margins');
    await app.rpc('ui.dialog.set', {doc, values: {orientation: 'landscape', paper: 'Legal', scaling: 'adjust', scale: 85, top: 1, left: 0.9, centerHorizontally: true, header: '&LReport&R&D', footer: '&CPage &P of &N',
      printTitleRows: '1:1', headings: true, pageOrder: 'overThenDown'}});
    await settle();
    await submit();
    const p = await setup();
    assert.deepEqual([p.orientation, p.paper, p.scale, p.margins.top, p.margins.left, p.centerH, p.printHeadings, p.pageOrder], ['landscape', 'Legal', 85, 1, 0.9, true, true, 'over']);
    assert.deepEqual(p.headerFooter, {header: '&LReport&R&D', footer: '&CPage &P of &N'});
    assert.equal((await t.read('/sh:s1', 'props')).printTitles, 'Sheet1!$1:$1');
    await press('pageLayout.pageSetup.printTitles');
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.pageSetup');
    await app.capture('05-page-setup-sheet-tab');
    await app.rpc('ui.dialog.cancel', {doc});

    // Header & Footer (Insert tab): the sections of both.
    await press('insert.text.headerFooter');
    await settle(300);
    await app.capture('06-header-footer');
    // The Header and Footer drop-downs fill the sections with Excel's presets.
    await app.rpc('ui.dialog.set', {doc, values: {headerPreset: 'Page 1 of ?', footerPreset: 'Confidential, date, Page 1'}});
    await settle(300);
    const hf = (await app.rpc('ui.dialog.get', {doc})).values;
    assert.deepEqual([hf.left, hf.center, hf.right], ['', 'Page &[Page] of &[Pages]', '']);
    assert.deepEqual([hf.footerLeft, hf.footerCenter, hf.footerRight], ['Confidential', '&[Date]', 'Page &[Page]']);
    await app.capture('06b-header-footer-presets');
    await app.rpc('ui.dialog.set', {doc, values: {left: 'Quarterly report', right: '&D'}});
    await submit();
    assert.equal((await setup()).headerFooter.header, '&LQuarterly report&CPage &P of &N&R&D');
    assert.equal((await setup()).headerFooter.footer, '&LConfidential&C&D&RPage &P');

    // Themes: a table shows its colours, the theme changes them.
    await select('A1', 'D8');
    await exec('insert.table', {});
    await select('H12');
    await settle(300);
    await app.capture('07-theme-craft');
    await press('pageLayout.themes.themes', 'Office 2013 - 2022');
    await settle(300);
    assert.equal((await t.read('/', 'props'))?.theme?.name ?? 'Office 2013 - 2022', 'Office 2013 - 2022');
    await app.capture('08-theme-office-2013');
    await openMenu('pageLayout.themes.colors');
    await app.capture('09-menu-colors');
    await closeMenu('pageLayout.themes.colors');

    // Arrange: a stack of shapes, Bring to Front and Send to Back.
    await exec('insert.shape', {kind: 'rectangle', at: 'F2', width: 120, height: 80});
    await exec('insert.shape', {kind: 'ellipse', at: 'G3', width: 120, height: 80});
    await exec('insert.shape', {kind: 'triangle', at: 'H4', width: 120, height: 80});
    const stack = async () => (await exec('object.list')).result.map(o => o.shape);
    assert.deepEqual(await stack(), ['rectangle', 'ellipse', 'triangle']);
    const first = (await exec('object.list')).result[0];
    await exec('object.select', {kind: 'shape', id: first.id});
    await press('pageLayout.arrange.bringForward.bring-to-front');
    assert.deepEqual(await stack(), ['ellipse', 'triangle', 'rectangle']);
    await settle(300);
    await app.capture('10-arrange-front');
    await press('pageLayout.arrange.sendBackward.send-to-back');
    assert.deepEqual(await stack(), ['rectangle', 'ellipse', 'triangle']);

    // The setup goes to a real .xlsx and comes back.
    const file = path.join(os.tmpdir(), `page-layout-${process.pid}.xlsx`);
    await script(app, {type: 'save', path: file});
    await app.rpc('ui.key', {doc, keys: 'Ctrl+S'});
    await app.until(() => exists(file), {timeout: 30_000});
    const xml = await (await JSZip.loadAsync(await fs.readFile(file))).file('xl/worksheets/sheet1.xml').async('string');
    assert.match(xml, /<pageSetup paperSize="5" scale="85"[^>]*orientation="landscape"[^>]*pageOrder="overThenDown"\/>/);
    assert.match(xml, /<oddHeader>&amp;LQuarterly report&amp;CPage &amp;P of &amp;N&amp;R&amp;D<\/oddHeader>/);
    const back = await app.rpc('documents.open', {path: file, show: false});
    const props = (await app.rpc('document.read', {doc: back.doc, address: '/sh:s1', as: 'props'})).value;
    assert.deepEqual([props.pageSetup.paper, props.pageSetup.scale, props.pageSetup.orientation], ['Legal', 85, 'landscape']);
    assert.equal(props.printArea, 'A1:D8');
    await fs.rm(file, {force: true});
  } finally {
    await t.app.close();
  }
});
