// Round 6 fixes in the window: the Print dialog (Print to PDF, with the sheet preview), the Header & Footer dialog kept inside the window with the buttons visible, Output Preview
// (Color spelling, the separations box), the Accessibility Checker and Tags panels (scroll bar, tag icons) and the image row of the Edit tab (labelled buttons).
// Evidence: artifacts/e2e/common/folio-round6/*.png. Not checked against upstream (Acrobat's Print dialog has a printer and a page preview; ours writes a PDF).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {editImagePdf} from '../../../core/folio/fixtures.mjs';
import {textPdf} from '../../../core/folio/fixtures.mjs';
import {documentsFolder, run, show, start} from '../common/file-helpers.mjs';

test('folio round 6: print preview, header & footer fit, panels and the image row', {timeout: 900_000}, async () => {
  const folder = await documentsFolder('folio-round6');
  const source = path.join(folder, 'Report.pdf');
  await fs.writeFile(source, await textPdf({pages: 5}));
  const images = path.join(folder, 'Picture.pdf');
  await fs.writeFile(images, await editImagePdf());
  const app = await start('folio', 'folio-round6', {args: [source, images]});
  await run(async () => {
    const entry = await app.until(async () => (await app.rpc('documents.list', {})).documents.find(d => d.path === source) || null, {timeout: 30_000});
    const doc = entry.id;
    await show(app, doc);
    const settle = ms => new Promise(r => setTimeout(r, ms));
    const exec = async (command, params = {}, id = doc) => (await app.rpc('engine.execute', {doc: id, command, params})).result;
    const dlg = async (id, args = null, wait = 1800) => { await settle(900); await app.rpc('ui.dialog.open', {doc, id, args}); await settle(wait); };
    await app.until(async () => (await exec('surface.view')).renders.count > 0 || null, {timeout: 60_000});

    await app.rpc('ui.tab', {doc, id: 'all-tools'});
    await dlg('dialog.print');
    await app.capture('01-print-one-to-a-sheet', {doc});
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.print', field: 'handling', value: 'Multiple'});
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.print', field: 'pps', value: '4'});
    await settle(900);
    await app.capture('02-print-four-to-a-sheet', {doc});
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.print'});

    await dlg('dialog.header-footer');
    await app.capture('03-header-footer', {doc});
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.header-footer'});

    await dlg('dialog.output-preview');
    await app.capture('04-output-preview', {doc});
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.output-preview'});

    await exec('a11y.check', {});
    await settle(1500);
    await exec('a11y.panel', {open: true});
    await settle(1200);
    await app.capture('05-accessibility-panel', {doc});
    await exec('a11y.autotag', {});
    await settle(1500);
    await exec('tags.panel', {open: true}).catch(() => {});
    await app.rpc('ui.pane', {doc, id: 'tags', open: true}).catch(() => {});
    await settle(1200);
    await app.capture('06-tags-panel', {doc});
    assert.ok((await exec('tags.list')).tags.length > 0);

    const second = (await app.rpc('documents.list', {})).documents.find(d => d.path === images);
    await show(app, second.id);
    await app.until(async () => (await exec('surface.view', {}, second.id)).renders.count > 0 || null, {timeout: 60_000});
    await app.rpc('ui.tab', {doc: second.id, id: 'edit'});
    await settle(700);
    await app.rpc('ui.activate', {doc: second.id, control: 'quick.bar.edit-text'});
    await settle(900);
    const list = (await exec('edit.images', {page: 1}, second.id)).images;
    if (list.length) await exec('edit.image_select', {page: 1, obj: list[0].obj}, second.id).catch(() => {});
    await settle(900);
    await app.capture('07-edit-image-row', {doc: second.id});
  });
});
