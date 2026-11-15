// Standards, Preflight, Output Preview, Space Audit, Action Wizard, Print pages, exports, Combine sorting and the Link Properties page action, end to end in the window
// (docs/behaviour-fidelity.md).
//
// Behaviour fidelity:
// 1. printcraft 0.16.0: crates/ui-egui/src/dialogs/standards_ui.rs (PDF/A), workflows/optimize_ui.rs (Space Audit), workflows/actions_ui.rs (Action Wizard), workflows/print_ui,
//    workflows/combine_ui (sorting, dropping), tools/link_ui.rs (the link target). Standards other than PDF/A, Output Preview, the spreadsheet, XML and PostScript exports and the
//    combine options are Acrobat's and are not checked against upstream.
// 2. The window runs the new shell (devRenderer); controls are activated and dialogs driven through the bridge, no OS input; captures through capturePage.
// 3. Evidence: artifacts/e2e/common/folio-rest-tools/*.png.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import JSZip from 'jszip';
import {textPdf} from '../../../core/folio/fixtures.mjs';
import {documentsFolder, run, show, start} from '../common/file-helpers.mjs';

const require = createRequire(import.meta.url);
const {PDFDocument} = require('pdf-lib');

test('folio tools: standards dialogs, space audit, actions, print, exports, combine, links', {timeout: 900_000}, async () => {
  const folder = await documentsFolder('folio-rest-tools');
  const source = path.join(folder, 'Quarterly.pdf');
  const other = path.join(folder, 'Appendix.pdf');
  await fs.writeFile(source, await textPdf({pages: 4}));
  await fs.writeFile(other, await textPdf({pages: 2}));
  const app = await start('folio', 'folio-rest-tools', {args: [source]});
  await run(async () => {
    const entry = await app.until(async () => (await app.rpc('documents.list', {})).documents.find(d => d.path === source) || null, {timeout: 30_000});
    const doc = entry.id;
    await show(app, doc);
    const settle = ms => new Promise(r => setTimeout(r, ms));
    const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
    const dlg = async (id, args = null, wait = 1500) => { await settle(900); await app.rpc('ui.dialog.open', {doc, id, args}); await settle(wait); };
    await app.until(async () => (await exec('surface.view')).renders.count > 0 || null, {timeout: 60_000});

    // PDF/A: the dialog verifies on open and lists what the document needs; a pass would still list what is not verified.
    await app.rpc('ui.tab', {doc, id: 'all-tools'});
    await dlg('dialog.pdfa');
    await app.capture('01-pdfa-verify', {doc});
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.pdfa'});
    const converted = await exec('standards.pdfa.convert', {level: 'PDF/A-2b'});
    assert.ok(converted.fixed.length >= 2);
    assert.match(converted.message, /not a statement|remain/);
    await dlg('dialog.pdfa');
    await app.capture('02-pdfa-after-convert', {doc});
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.pdfa'});

    // Preflight on the PDF/UA profile (the control Check PDF/UA), then Output Preview.
    await dlg('dialog.preflight', {profile: 'pdfua-1'});
    await app.capture('03-preflight-pdfua', {doc});
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.preflight'});
    await dlg('dialog.output-preview');
    await app.capture('04-output-preview', {doc});
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.output-preview'});
    await exec('standards.panel', {open: true});
    await settle(900);
    await app.capture('05-standards-panel', {doc});
    await exec('standards.panel', {open: false});

    // Space audit.
    await dlg('dialog.audit-space');
    await app.capture('06-space-audit', {doc});
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.audit-space'});

    // Action Wizard on Prepare for Distribution, then run it.
    await dlg('dialog.action-wizard', {action: 'Mark as Confidential'});
    await app.capture('07-action-wizard', {doc});
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.action-wizard'});
    const ran = await exec('actions.run', {action: 'Mark as Confidential'});
    assert.equal(ran.failed, 0);

    // Print pages: the dialog (booklet), then the sheets.
    await dlg('dialog.print');
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.print', field: 'handling', value: 'Booklet'});
    await settle(400);
    await app.capture('08-print', {doc});
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.print'});
    const sheets = await exec('print.pages', {handling: 'booklet'});
    assert.equal(sheets.sheets, 2, 'four pages: two sides of one sheet');
    assert.equal((await PDFDocument.load(Buffer.from(sheets.base64, 'base64'))).getPageCount(), 2);

    // Exports: a workbook, XML, PostScript.
    const xlsx = (await app.rpc('ui.activate', {doc, control: 'alltools.export.spreadsheet-xlsx'})).result;
    assert.equal(xlsx.name, 'Quarterly.xlsx');
    assert.ok((await JSZip.loadAsync(Buffer.from(xlsx.base64, 'base64'))).file('xl/workbook.xml'));
    const xml = (await app.rpc('ui.activate', {doc, control: 'alltools.export.xml'})).result;
    assert.match(Buffer.from(xml.base64, 'base64').toString('utf8'), /<document title="Quarterly" pages="4">/);
    const ps = (await app.rpc('ui.activate', {doc, control: 'alltools.export.postscript-eps'})).result;
    const psText = Buffer.from(ps.base64, 'base64').toString('latin1');
    assert.match(psText, /^%!PS-Adobe-3\.0/);
    assert.equal((psText.match(/showpage/g) ?? []).length, 4);
    assert.match(ps.note, /pictures/);
    const eps = (await app.rpc('ui.activate', {doc, control: 'alltools.export.eps'})).result;
    assert.match(Buffer.from(eps.base64, 'base64').toString('latin1'), /^%!PS-Adobe-3\.0 EPSF-3\.0/);

    // Link Properties: a link to a page.
    await dlg('dialog.link-properties', null, 800);
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.link-properties', tab: 'Actions', field: 'action', value: 'Go to a page'});
    await settle(300);
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.link-properties', field: 'page', value: 3});
    await settle(300);
    await app.capture('09-link-go-to-page', {doc});
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.link-properties'});
    const pageId = (await app.rpc('document.read', {doc, address: '/pages'})).value[0].id;
    const link = await exec('edit.link', {page: pageId, rect: [72, 100, 172, 120], gotoPage: 2});
    assert.ok(link.goto);

    // Combine: the list sorted by name, a second click reverses it, a file dropped on another.
    await exec('page.combine', {});
    const b64 = async p => (await fs.readFile(p)).toString('base64');
    await exec('combine.add_folder', {files: [{name: 'scan10.pdf', base64: await b64(other), modified: 3000}, {name: 'scan2.pdf', base64: await b64(source), modified: 1000}, {name: 'scan1.pdf', base64: await b64(other)}]});
    await settle(1200);
    await exec('combine.view', {mode: 'list'}).catch(() => {});
    await exec('combine.sort', {key: 'name'});
    await settle(900);
    await app.capture('10-combine-sorted', {doc});
    const names = async () => (await exec('combine.read')).files.map(f => f.name);
    assert.deepEqual(await names(), ['scan1.pdf', 'scan2.pdf', 'scan10.pdf']);
    await exec('combine.sort', {key: 'name'});
    assert.deepEqual(await names(), ['scan10.pdf', 'scan2.pdf', 'scan1.pdf']);
    const ids = (await exec('combine.read')).files.map(f => f.id);
    await exec('combine.select', {ids: [ids[0]]});
    await exec('combine.drop', {file: ids[0], onto: ids[2]});
    assert.deepEqual(await names(), ['scan2.pdf', 'scan1.pdf', 'scan10.pdf']);
    await exec('combine.view', {mode: 'grid'});
    await settle(1500);
    await app.capture('11-combine-grid', {doc});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.combine-options', args: null});
    await settle(500);
    await app.capture('12-combine-options', {doc});
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.combine-options'});
  }, app);
  await fs.rm(folder, {recursive: true, force: true});
});
