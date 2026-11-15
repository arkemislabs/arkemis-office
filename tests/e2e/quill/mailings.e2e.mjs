// Quill's Mailings tab (U:quill/mailings) end to end through the bridge, in the new shell. No OS
// input: ribbon controls through ui.activate / ui.menu, dialogs through ui.dialog.*, the system Open
// dialog answered by the scripted queue (test.dialogs), and the documents read back over the bridge.
//
// Behaviour fidelity:
// 1. ArtCraft crates/engine/src/cmd/mailings.rs (+ mailings/*.rs), the ribbon in crates/ui-egui/src/
//    ribbon/mailings.rs and the dialogs in dialogs/mailings.rs, dispatch.rs (Insert Merge Field, Find
//    Recipient, Merge Records, Merge Rule, Match Fields, Check for Errors, Select Table) and
//    dialogs_layout/print.rs (Envelopes, Labels); Word: Select Recipients types a new list or reads
//    an existing one (CSV, Excel), merge fields show as «Name», Preview Results shows a recipient's
//    values and the record buttons step through the recipients, Rules insert IF / Next Record, Check
//    for Errors lists fields the list lacks, Finish & Merge makes a new document with one letter per
//    recipient, Envelopes and Labels make an envelope or a sheet of labels.
// 2. The same commands run from the window (the person's path); the merge's kind is saved in the
//    .docx as w:mailMerge (tests/quill/mailings.test.mjs).
// 3. This file; the engine side is tests/quill/mailings.test.mjs and tests/quill/upstream/mailings_tests.test.mjs.
//
// Evidence: artifacts/e2e/quill/mailings/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';
import {documentsFolder, script} from '../common/file-helpers.mjs';

const para = text => ({type: 'paragraph', content: [{type: 'text', text}]});

function seedDoc(id) {
  const seed = createFile('quill', 'Letter');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [para('Harbor Pottery Studio'), para(''), para(''), para('Thank you for supporting the studio this year.'), para('Your next class is in ')]};
  return migrateFile(seed);
}

const CSV = 'First Name,Last Name,Address,City,Postal Code,Plan\nAda,Lovelace,12 Crown Row,London,SW1A 1AA,gold\nAlan,Turing,3 Bletchley Park,Milton Keynes,MK3 6EB,silver\nGrace,Hopper,1 Navy Yard,Arlington,22202,gold\n';

async function xlsx(rows) {
  const z = new JSZip();
  z.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  z.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Guests" sheetId="1" r:id="rId1"/></sheets></workbook>');
  z.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  z.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((c, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${c}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`);
  return z.generateAsync({type: 'nodebuffer'});
}

const textOf = body => JSON.stringify(body);

test('quill Mailings tab: recipients, merge fields, preview, rules, check, Finish & Merge, envelopes, labels', {timeout: 300_000}, async () => {
  const seed = seedDoc('quill-mailings');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/mailings', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = () => app.rpc('document.read', {doc, address: '/body', as: 'json'});
  const settle = (ms = 450) => new Promise(r => setTimeout(r, ms));
  const inspect = () => app.rpc('ui.inspect', {doc});
  const control = async id => (await inspect()).controls?.find(c => c.id === id) ?? null;
  const folder = await documentsFolder('mailings');
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await inspect(); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });

    // The Mailings tab: every group, the hidden controls (no upstream engine) absent.
    await app.rpc('ui.tab', {doc, id: 'mailings'});
    await settle();
    const ui = await inspect();
    const ids = new Set((ui.controls ?? []).map(c => c.id));
    for (const id of ['mailings.create.envelopes', 'mailings.create.labels', 'mailings.start-mail-merge.start-mail-merge', 'mailings.start-mail-merge.select-recipients',
      'mailings.start-mail-merge.edit-recipient-list', 'mailings.write-insert-fields.highlight-merge-fields', 'mailings.write-insert-fields.address-block',
      'mailings.write-insert-fields.greeting-line', 'mailings.write-insert-fields.insert-merge-field', 'mailings.write-insert-fields.rules',
      'mailings.write-insert-fields.match-fields', 'mailings.preview-results.preview-results', 'mailings.preview-results.first-record',
      'mailings.preview-results.previous-record', 'mailings.preview-results.go-to-record', 'mailings.preview-results.next-record',
      'mailings.preview-results.last-record', 'mailings.preview-results.find-recipient', 'mailings.preview-results.check-for-errors', 'mailings.finish.finish-merge']) {
      assert.ok(ids.has(id), `${id} is on the Mailings tab`);
    }
    assert.ok(!ids.has('mailings.write-insert-fields.update-labels'), 'Update Labels has no upstream engine');
    // Nothing to preview or edit before recipients are chosen.
    assert.equal((await control('mailings.preview-results.preview-results'))?.enabled, false);
    assert.equal((await control('mailings.start-mail-merge.edit-recipient-list'))?.enabled, false);
    await app.capture('1-mailings-tab', {doc});

    // Start Mail Merge › Letters (checked), saved as the document's kind.
    await app.rpc('ui.menu', {doc, control: 'mailings.start-mail-merge.start-mail-merge'});
    await settle();
    await app.capture('2-start-mail-merge-menu', {doc});
    await app.rpc('ui.menu', {doc, control: 'mailings.start-mail-merge.start-mail-merge', open: false});
    await app.rpc('ui.activate', {doc, control: 'mailings.start-mail-merge.start-mail-merge.letters'});
    await app.rpc('ui.menu', {doc, control: 'mailings.start-mail-merge.start-mail-merge'});
    await settle();
    await app.capture('2b-letters-checked', {doc});
    await app.rpc('ui.menu', {doc, control: 'mailings.start-mail-merge.start-mail-merge', open: false});

    // Select Recipients › Type a New List…: the Recipient List dialog with the starting fields.
    await app.rpc('ui.menu', {doc, control: 'mailings.start-mail-merge.select-recipients'});
    await settle();
    await app.capture('3-select-recipients-menu', {doc});
    await app.rpc('ui.menu', {doc, control: 'mailings.start-mail-merge.select-recipients', open: false});
    await app.rpc('ui.activate', {doc, control: 'mailings.start-mail-merge.select-recipients.type-a-new-list'});
    let dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.newRecipientList');
    assert.deepEqual(dlg.values.fields, ['First Name', 'Last Name', 'Address', 'City', 'Postal Code']);
    await app.rpc('ui.dialog.set', {doc, values: {rows: [['Jo', 'Doe', '1 Main St', 'Oslo', '0150'], ['', '', '', '', '']]}});
    await settle();
    await app.capture('4-new-list-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    let list = await run('mailings.editRecipients');
    assert.deepEqual(list.rows, [['Jo', 'Doe', '1 Main St', 'Oslo', '0150']], 'the blank record is dropped');

    // Use an Existing List…: the system Open dialog (scripted) reads a CSV; Edit Recipient List shows it.
    const csvPath = path.join(folder, 'guests.csv');
    await fs.writeFile(csvPath, CSV);
    await script(app, {type: 'open', path: csvPath});
    await app.rpc('ui.menu', {doc, control: 'mailings.start-mail-merge.select-recipients'});
    await app.rpc('ui.activate', {doc, control: 'mailings.start-mail-merge.select-recipients.use-an-existing-list'});
    list = await run('mailings.editRecipients');
    assert.deepEqual(list.headers, ['First Name', 'Last Name', 'Address', 'City', 'Postal Code', 'Plan']);
    assert.equal(list.rows.length, 3);
    const asked = (await app.rpc('test.dialogs', {})).log.filter(x => x.type === 'open');
    assert.ok(asked.at(-1).options.filters[0].extensions.includes('xlsx') && asked.at(-1).options.filters[0].extensions.includes('csv'), 'the Open dialog lists recipient lists');
    // An Excel workbook is a recipient list too.
    const xlsxPath = path.join(folder, 'guests.xlsx');
    await fs.writeFile(xlsxPath, await xlsx([['Name', 'City'], ['Ola', 'Bergen']]));
    await script(app, {type: 'open', path: xlsxPath});
    await app.rpc('ui.activate', {doc, control: 'mailings.start-mail-merge.select-recipients.use-an-existing-list'});
    assert.deepEqual((await run('mailings.editRecipients')).headers, ['Name', 'City']);
    // Back to the CSV.
    await script(app, {type: 'open', path: csvPath});
    await app.rpc('ui.activate', {doc, control: 'mailings.start-mail-merge.select-recipients.use-an-existing-list'});
    assert.equal((await run('mailings.editRecipients')).rows.length, 3);

    // Merge fields: the letter gets an address block, a greeting line, a field and an IF rule.
    await run('caret.set', {pos: {block: 1, off: 0}});
    await app.rpc('ui.activate', {doc, control: 'mailings.write-insert-fields.address-block'});
    await run('caret.set', {pos: {block: 2, off: 0}});
    await app.rpc('ui.activate', {doc, control: 'mailings.write-insert-fields.greeting-line'});
    await run('caret.set', {pos: {block: 4, off: 'Your next class is in '.length}});
    await app.rpc('ui.menu', {doc, control: 'mailings.write-insert-fields.insert-merge-field'});
    await settle();
    await app.capture('5-insert-merge-field-menu', {doc});
    await app.rpc('ui.menu', {doc, control: 'mailings.write-insert-fields.insert-merge-field', open: false});
    await app.rpc('ui.activate', {doc, control: 'mailings.write-insert-fields.insert-merge-field.fields', value: 'City'});
    let body = textOf(await read());
    assert.ok(body.includes('«AddressBlock»') && body.includes('«GreetingLine»') && body.includes('«City»'), body.slice(0, 600));
    // The Insert Merge Field dialog (the button): the list's fields, a typed one too.
    await app.rpc('ui.activate', {doc, control: 'mailings.write-insert-fields.insert-merge-field'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.insertMergeField');
    assert.deepEqual(dlg.values.fields, list.headers);
    await app.rpc('ui.dialog.set', {doc, values: {field: 'Plan'}});
    await settle();
    await app.capture('6-insert-merge-field-dialog', {doc});
    await app.rpc('ui.dialog.cancel', {doc});

    // Rules › If…Then…Else… (a dialog), Next Record and Merge Record # (direct).
    await run('text.insert', {text: ' (plan: '});
    await app.rpc('ui.menu', {doc, control: 'mailings.write-insert-fields.rules'});
    await settle();
    await app.capture('7-rules-menu', {doc});
    await app.rpc('ui.menu', {doc, control: 'mailings.write-insert-fields.rules', open: false});
    await app.rpc('ui.activate', {doc, control: 'mailings.write-insert-fields.rules.if-then-else'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.mergeRule');
    await app.rpc('ui.dialog.set', {doc, values: {field: 'Plan', value: 'gold', then: 'priority seat', else: 'general seat'}});
    await settle();
    await app.capture('8-if-then-else-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    await run('text.insert', {text: ')'});
    assert.ok(textOf(await read()).includes('(plan: '), 'the IF rule is in the paragraph');

    // Highlight Merge Fields and Preview Results: the first recipient's values, then the next ones.
    await app.rpc('ui.activate', {doc, control: 'mailings.write-insert-fields.highlight-merge-fields'});
    assert.equal((await control('mailings.write-insert-fields.highlight-merge-fields'))?.checked, true);
    await app.rpc('ui.activate', {doc, control: 'mailings.preview-results.preview-results'});
    body = textOf(await read());
    assert.ok(body.includes('Ada Lovelace') && body.includes('Dear Ada Lovelace,') && body.includes('London') && body.includes('priority seat'), body.slice(0, 900));
    await run('caret.set', {pos: {block: 0, off: 0}});
    await settle();
    await app.capture('9-preview-first-record', {doc});
    await app.rpc('ui.activate', {doc, control: 'mailings.preview-results.next-record'});
    body = textOf(await read());
    assert.ok(body.includes('Alan Turing') && body.includes('Milton Keynes') && body.includes('general seat'), body.slice(0, 900));
    assert.equal((await control('mailings.preview-results.go-to-record'))?.value, 2);
    await app.rpc('ui.activate', {doc, control: 'mailings.preview-results.go-to-record', value: '3'});
    assert.ok(textOf(await read()).includes('Grace Hopper'));
    await app.rpc('ui.activate', {doc, control: 'mailings.preview-results.last-record'});
    assert.equal((await control('mailings.preview-results.go-to-record'))?.value, 3);
    await app.rpc('ui.activate', {doc, control: 'mailings.preview-results.first-record'});
    assert.ok(textOf(await read()).includes('Ada Lovelace'));
    await app.rpc('ui.activate', {doc, control: 'mailings.preview-results.previous-record'});
    assert.equal((await control('mailings.preview-results.go-to-record'))?.value, 1, 'Previous Record stays on the first');
    await settle();
    await app.capture('10-ribbon-with-recipients', {doc});

    // Find Recipient: the dialog, a miss and a hit.
    await app.rpc('ui.activate', {doc, control: 'mailings.preview-results.find-recipient'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.findRecipient');
    await app.rpc('ui.dialog.set', {doc, values: {text: 'nobody'}});
    await assert.rejects(app.rpc('ui.dialog.submit', {doc}), /no matching recipient/);
    await app.rpc('ui.dialog.set', {doc, values: {text: 'hopper'}});
    await settle();
    await app.capture('11-find-recipient', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    assert.equal((await control('mailings.preview-results.go-to-record'))?.value, 3);

    // Match Fields and Check for Errors.
    await app.rpc('ui.activate', {doc, control: 'mailings.write-insert-fields.match-fields'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.matchFields');
    assert.equal(dlg.values.address.firstName, 'First Name');
    assert.equal(dlg.values.address.postal, 'Postal Code');
    await settle();
    await app.capture('12-match-fields', {doc});
    await app.rpc('ui.dialog.cancel', {doc});
    await run('caret.set', {pos: {block: 3, off: 0}});
    await run('mailings.insertField', {field: 'Nickname'});
    await app.rpc('ui.activate', {doc, control: 'mailings.preview-results.check-for-errors'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.checkErrors');
    assert.deepEqual(dlg.values.unknown, ['Nickname']);
    await settle();
    await app.capture('13-check-for-errors', {doc});
    await app.rpc('ui.dialog.cancel', {doc});

    // Edit Recipient List with a filter: Plan equals gold leaves two records to merge.
    await app.rpc('ui.activate', {doc, control: 'mailings.start-mail-merge.edit-recipient-list'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.recipientList');
    assert.equal(dlg.values.rows.length, 3);
    await app.rpc('ui.dialog.set', {doc, values: {filterOpen: true, rules: [{field: 'Plan', op: 'equal', value: 'gold', or: false}], sort: [{field: 'Last Name', descending: true}, {field: '', descending: false}, {field: '', descending: false}]}});
    await settle();
    await app.capture('14-edit-recipient-list-filter', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    list = await run('mailings.editRecipients');
    assert.equal(list.rows.length, 3, 'every record stays in the list');
    assert.equal(list.records, 2, 'two records merge');
    assert.deepEqual(list.sort, [{field: 'Last Name', descending: true}]);

    // Finish & Merge › Edit Individual Documents…: a new document with one letter per merged record.
    await run('caret.docEnd');
    await run('mailings.insertField', {field: 'Plan'});
    await app.rpc('ui.menu', {doc, control: 'mailings.finish.finish-merge'});
    await settle();
    await app.capture('15-finish-merge-menu', {doc});
    await app.rpc('ui.menu', {doc, control: 'mailings.finish.finish-merge', open: false});
    await app.rpc('ui.activate', {doc, control: 'mailings.finish.finish-merge.edit-individual-documents'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.mergeRecords');
    assert.equal(dlg.values.to, '2');
    await app.rpc('ui.dialog.set', {doc, values: {choice: 'range', from: '1', to: '9'}});
    await settle();
    await app.capture('16-merge-records-dialog', {doc});
    await app.rpc('ui.dialog.set', {doc, values: {choice: 'all'}});
    const before = (await app.rpc('documents.list', {})).documents?.length ?? (await app.rpc('documents.list', {})).length;
    const done = await app.rpc('ui.dialog.submit', {doc});
    assert.equal(done.result?.records ?? done.records, 2);
    const mergedDoc = done.result?.doc ?? done.doc;
    assert.ok(mergedDoc && mergedDoc !== doc, 'a new document was made');
    const listing = await app.rpc('documents.list', {});
    assert.equal((listing.documents ?? listing).length, before + 1);
    await app.rpc('documents.open', {doc: mergedDoc, show: false});
    const merged = textOf(await app.rpc('document.read', {doc: mergedDoc, address: '/body', as: 'json'}));
    assert.ok(merged.includes('Dear Grace Hopper,') && merged.includes('Dear Ada Lovelace,') && !merged.includes('Alan Turing') && !merged.includes('«'), merged.slice(0, 900));
    assert.ok(merged.indexOf('Ada Lovelace') < merged.indexOf('Grace Hopper'), 'the sort (Last Name, descending) orders the letters');
    await app.rpc('documents.open', {doc: mergedDoc, show: true});
    await app.until(async () => { const u = await app.rpc('ui.inspect', {doc: mergedDoc}); return u.doc?.id === mergedDoc && u.tabs?.length ? u : null; }, {timeout: 45_000});
    await settle(900);
    await app.capture('17-merged-document', {doc: mergedDoc});

    // Envelopes: the dialog (the selected text is the delivery address), Add to Document.
    await run('select.range', {anchor: {block: 0, off: 0}, focus: {block: 0, off: 14}});
    await app.rpc('ui.activate', {doc, control: 'mailings.create.envelopes'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.envelopes');
    assert.equal(dlg.values.delivery, 'Harbor Pottery');
    assert.deepEqual(dlg.buttons.map(b => b.label), ['Add to Document', 'New Document', 'Cancel']);
    await app.rpc('ui.dialog.set', {doc, values: {delivery: 'Ada Lovelace\n12 Crown Row\nLondon SW1A 1AA', ret: 'Harbor Pottery Studio\n5 Dock Street', size: 3}});
    await settle();
    await app.capture('18-envelopes-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    body = textOf(await read());
    assert.ok(body.includes('Harbor Pottery Studio') && body.includes('12 Crown Row'));
    const secs = await run('layout.sections').catch(() => null);
    void secs;

    // Labels: the dialog; New Document makes the sheet, one label per recipient.
    await app.rpc('ui.activate', {doc, control: 'mailings.create.labels'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.labels');
    assert.equal(dlg.values.recipients, true);
    await settle();
    await app.capture('19-labels-dialog', {doc});
    const labels = await app.rpc('ui.dialog.submit', {doc});
    const labelDoc = labels.result?.doc ?? labels.doc;
    assert.ok(labelDoc, 'the labels are a new document');
    assert.equal(labels.result?.filled ?? labels.filled, 2, 'one label per merged recipient');
  } catch (e) {
    e.message += log();
    throw e;
  } finally {
    await app.close();
    await fs.rm(folder, {recursive: true, force: true}).catch(() => {});
  }
});
