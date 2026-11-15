// Redact, end to end in the window (docs/behaviour-fidelity.md):
//   the Redact tool marks text and boxes (the box by a drag through the page view's own pointer handlers),
//   Find text and redact marks every match of a pattern, Redaction tool properties set the overlay text,
//   Apply redactions asks for confirmation and cuts the content out of the page, and Remove hidden
//   information lists its categories.
//
// Behaviour fidelity:
// 1. printcraft: crates/ui-egui/src/tools/redact_ui.rs (the tool, the dialogs), commands.rs:724-764,
//    crates/redact (apply: content removed, boxes drawn, verified). Acrobat's Redact tool works the same way.
// 2. Here the window runs the new shell (devRenderer); commands run as engine.execute, the page view's pointer
//    handlers through surface.pointer, the dialogs through ui.dialog.*; what the document holds after Apply is
//    read back and searched with every stream decoded. No OS input.
// 3. Evidence: artifacts/e2e/folio/redact/*.png (ui.capture -> capturePage).
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, StandardFonts, PDFStream, PDFRawStream, decodePDFRawStream} from 'pdf-lib';
import {createFile} from '../../../core/model.mjs';
import {schema1Content} from '../../../core/folio/fixtures.mjs';
import {devRenderer, launchApp} from '../harness.mjs';
import {everythingOfBytes} from '../../folio/redact-helpers.mjs';

async function seedFile() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  [
    'Customer record for review',
    'Contact: ada.lovelace@example.org or call (555) 123-4567.',
    'Card 4111 1111 1111 1111, SSN 123-45-6789.',
    'Invoice dated March 5, 2024 for 99 widgets.',
    'The quarterly figures stay visible.',
  ].forEach((line, i) => page.drawText(line, {x: 72, y: 700 - i * 28, size: 14, font}));
  doc.setTitle('Confidential record');
  const file = createFile('folio', 'Redact PDF');
  file.id = 'folio-redact';
  file.content = await schema1Content(await doc.save(), 'record.pdf');
  return file;
}

test('folio redact: mark text and a box, find patterns, set properties, apply with confirmation, remove hidden information', {timeout: 400_000}, async () => {
  const seed = await seedFile();
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/redact', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const doc = seed.id;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const pointer = params => app.rpc('engine.execute', {doc, command: 'surface.pointer', params}).then(r => r.result);
  const pages = async () => (await app.rpc('document.read', {doc, address: '/pages'})).value;
  const marks = async () => (await pages()).flatMap(p => (p.annots ?? []).filter(r => r.dict.Subtype === '/Redact'));
  const set = (id, field, value) => app.rpc('ui.dialog.set', {doc, id, field, value});
  // Apply and Remove hidden information are destructive: the bridge asks the person, and the test answers yes for them after the dialog said what it does.
  const approve = async () => true;
  const settle = ms => new Promise(r => setTimeout(r, ms));
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const v = await exec('surface.view'); return !v.migrating && v.renders.count > 0 ? v : null; }, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('ui.tab', {doc, id: 'all-tools'});
    await settle(500);
    await app.capture('opened');

    // 1. The Redact tool: a drag over empty page makes a box mark (through the page view's pointer handlers).
    await exec('redact.mark', {});
    await pointer({page: 1, action: 'drag', x: 400, y: 600, to: {x: 520, y: 640}});
    assert.equal((await marks()).length, 1, 'a drag with the Redact tool draws a box mark');
    await settle(500);
    await app.capture('area-marked');

    // 2. Find text and redact with a pattern: the dialog, every match marked.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.redact-search'});
    await set('dialog.redact-search', 'mode', 'Patterns');
    await set('dialog.redact-search', 'pattern', 'Email Addresses');
    await settle(400);
    await app.capture('search-dialog');
    await app.rpc('ui.dialog.submit', {doc, id: 'dialog.redact-search', button: 'search-mark'});
    assert.equal((await marks()).length, 2, 'the email address is marked');
    for (const pattern of ['Phone Numbers', 'Credit Card Numbers', 'Social Security Numbers', 'Dates']) await exec('redact.search', {mode: 'Patterns', pattern});
    assert.equal((await marks()).length, 6);
    await exec('redact.search', {text: 'Customer record'});
    assert.equal((await marks()).length, 7);

    // 3. Redaction tool properties: an overlay text for the marks made from now on.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.redact-properties'});
    await set('dialog.redact-properties', 'overlay', true);
    await set('dialog.redact-properties', 'custom', 'REDACTED');
    await set('dialog.redact-properties', 'font-color', '#FFFFFF');
    await settle(500);
    await app.capture('properties');
    await app.rpc('ui.dialog.submit', {doc, id: 'dialog.redact-properties', button: 'ok'});
    await exec('redact.mark', {page: (await pages())[0].id, area: [72, 380, 300, 22]});
    await exec('tool.select', {}).catch(() => {});
    await settle(700);
    await app.capture('marks-on-page');

    // 4. Apply redactions: the confirmation says what will happen; applying removes the content.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.redact-apply'});
    await settle(500);
    await app.capture('apply-dialog');
    await app.rpc('ui.dialog.submit', {doc, id: 'dialog.redact-apply', button: 'ok'}, {approve});
    assert.equal((await marks()).length, 0, 'the marks are applied');
    const bytes = Buffer.from((await app.rpc('document.read', {doc, address: '/sourceBase64'})).value, 'base64');
    const all = await everythingOfBytes(bytes);
    for (const gone of ['example.org', 'lovelace', '555', '4111', '6789', 'March', 'Customer record']) assert.ok(!all.includes(gone), `${gone} is still in the page content`);
    assert.ok(all.includes('quarterly'), 'the rest of the page stays');
    assert.ok(all.includes('REDACTED'), 'the overlay text is drawn');
    await app.until(async () => { const v = await exec('surface.view'); return v.renders.count > 0 ? v : null; }, {timeout: 30_000});
    await settle(1200);
    await app.capture('applied');

    // 5. Remove hidden information.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.remove-hidden'});
    await settle(500);
    await app.capture('remove-hidden');
    await set('dialog.remove-hidden', 'comments', false);
    await app.rpc('ui.dialog.submit', {doc, id: 'dialog.remove-hidden', button: 'remove'}, {approve});
    const clean = await everythingOfBytes(Buffer.from((await app.rpc('document.read', {doc, address: '/sourceBase64'})).value, 'base64'));
    assert.ok(!clean.includes('Confidential record'));
    const saved = await PDFDocument.load(Buffer.from((await app.rpc('document.read', {doc, address: '/sourceBase64'})).value, 'base64'), {updateMetadata: false});
    assert.equal(saved.getTitle(), undefined, 'the metadata is gone');
  } catch (e) { e.message += log(); throw e; } finally { await app.close(); }
});
