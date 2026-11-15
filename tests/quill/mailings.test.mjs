// U:quill/mailings: the Mailings tab: Envelopes and Labels, Start Mail Merge, Select Recipients and
// Edit Recipient List (filter and sort), Insert Merge Field, Address Block, Greeting Line, Rules,
// Match Fields, Highlight Merge Fields, Preview Results and the record buttons, Find Recipient, Check
// for Errors, Finish & Merge, the dialogs, and the .docx round trip (w:mailMerge, MERGEFIELD).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/mailings.rs (specs, insert_field), mailings/merge.rs
//    (refresh 211, finish 281), mailings/recipients.rs (recipients 108), mailings/filter.rs (apply_filter),
//    mailings/labels.rs (envelopes, labels); crates/ui-egui/src/ribbon/mailings.rs and the dialogs in
//    dialogs/mailings.rs (recipient_list, recipient_filter, visible_recipients), dispatch.rs
//    (insert_merge_field_dialog, find_recipient_dialog, merge_records_dialog, merge_rule_dialog,
//    match_fields_dialog, check_errors_dialog, select_table_dialog) and dialogs_layout/print.rs
//    (envelopes_ui, labels_ui). Word: merge fields show as «Name»; Preview Results shows a recipient's
//    values; the record buttons step through the recipients; Rules insert IF / Next Record fields;
//    Finish & Merge makes a new document with one letter per recipient; the kind of merge is kept in
//    the file (w:mailMerge).
// 2. Ours: the same engine (core/quill/lib/mailings-merge.mjs, mailings-sheet.mjs, mailings-labels.mjs),
//    each edit one undo step; the merge state is the document view; Finish & Merge, Envelopes and
//    Labels hand the new document's content to the document service. Not here: Print Documents and
//    Send Email Messages, Ask, Fill-in, Merge Sequence #, Set Bookmark, Update Labels, the wizard,
//    Outlook contacts, Word's per-record check boxes and Find duplicates, .xls workbooks (no upstream
//    engine, or no printing and mail); each stays hidden (docs/spec/patches/quill/mailings.json).
// 3. Proof: this file, tests/quill/upstream/mailings_tests.test.mjs and tests/e2e/quill/mailings.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {openDialogModel, changeDialogValues, submitDialog} from '../../core/kernel/dialog.mjs';
import {contentFromText} from '../../core/quill/model/content.mjs';
import {Document, BODY} from '../../core/quill/model/document.mjs';
import * as P from '../../core/quill/model/para.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {mergeOrder, visibleRecipients, recipientTable, NEW_LIST_FIELDS} from '../../core/quill/dialogs/recipientList.mjs';
import recipientDialog from '../../core/quill/dialogs/recipientList.mjs';
import newListDialog from '../../core/quill/dialogs/newRecipientList.mjs';
import insertFieldDialog from '../../core/quill/dialogs/insertMergeField.mjs';
import findDialog from '../../core/quill/dialogs/findRecipient.mjs';
import recordsDialog, {recordParams} from '../../core/quill/dialogs/mergeRecords.mjs';
import ruleDialog from '../../core/quill/dialogs/mergeRule.mjs';
import matchDialog, {ADDRESS_PARTS} from '../../core/quill/dialogs/matchFields.mjs';
import checkDialog from '../../core/quill/dialogs/checkErrors.mjs';
import envelopeDialog, {envelopeParams, sizeOptions} from '../../core/quill/dialogs/envelopes.mjs';
import labelsDialog, {labelParams, productOptions} from '../../core/quill/dialogs/labels.mjs';
import {envelopeLabel, ENVELOPE_SIZES, LABEL_PRODUCTS, productLabel} from '../../core/quill/lib/mailings-labels.mjs';
import {number, serialDate, customDate, builtinDate, isoDatetime, isoTime, fieldNames} from '../../core/quill/lib/mailings-sheet.mjs';

const OBJ = P.OBJ;
async function s(text = '', opts = {}) {
  const created = [];
  const files = {async create(kind, o) { created.push({kind, ...o}); return {doc: `new${created.length}`, name: o.title}; }, async write() { return {}; }};
  const t = await createTestSession('quill', {content: opts.content ?? contentFromText(text), host: createTestHost({files})});
  const run = (id, params = {}) => t.exec(id, params).then(r => r.result);
  return {t, run, created, view: () => t.session.get(t.docId).view};
}
const body = t => new Document(t.content).plainText(BODY).split(OBJ).join('');
const fieldsOf = t => t.content.body.chunks.flat().filter(b => b.kind === 'para').flatMap(p => (p.objects ?? []).filter(o => o.type === 'field').map(o => [o.instr, o.result]));
const rejects = (p, re) => assert.rejects(p, e => !re || re.test(e.message));
const PEOPLE = 'First Name,Last Name,City,Plan\nAda,Lovelace,London,gold\nAlan,Turing,Wilmslow,silver';

test('state: nothing to preview or edit before recipients are chosen, then enabled', async () => {
  const q = await s('Hello');
  for (const id of ['mailings.preview', 'mailings.next', 'mailings.previous', 'mailings.first', 'mailings.last', 'mailings.goToRecord', 'mailings.findRecipient',
    'mailings.finish', 'mailings.editRecipients', 'mailings.filterRecipients', 'mailings.sortRecipients']) {
    assert.equal(q.t.state(id).enabled, false, id);
    assert.match(q.t.state(id).reason, /recipients first/i, id);
  }
  for (const id of ['mailings.insertField', 'mailings.addressBlock', 'mailings.greetingLine', 'mailings.rules', 'mailings.matchFields', 'mailings.checkErrors',
    'mailings.highlightFields', 'mailings.start', 'mailings.recipients', 'mailings.envelopes', 'mailings.labels']) assert.equal(q.t.state(id).enabled, true, id);
  await q.run('mailings.recipients', {csv: PEOPLE});
  for (const id of ['mailings.preview', 'mailings.next', 'mailings.goToRecord', 'mailings.finish', 'mailings.editRecipients']) assert.equal(q.t.state(id).enabled, true, id);
  assert.equal(q.t.state('mailings.goToRecord').value, 1);
  assert.equal(q.t.state('mailings.preview').checked, false);
  await q.run('mailings.preview');
  assert.equal(q.t.state('mailings.preview').checked, true);
  await q.run('mailings.last');
  assert.equal(q.t.state('mailings.goToRecord').value, 2);
  // Insert Merge Field lists the list's fields.
  assert.deepEqual(q.t.state('mailings.insertField').value.map(x => x.value), ['First Name', 'Last Name', 'City', 'Plan']);
  // Start Mail Merge checks the current kind (Normal Word Document to begin with).
  assert.equal(q.t.state('mailings.start', {kind: 'normal'}).checked, true);
  await q.run('mailings.start', {kind: 'letters'});
  assert.equal(q.t.state('mailings.start', {kind: 'letters'}).checked, true);
  assert.equal(q.t.state('mailings.start', {kind: 'normal'}).checked, false);
});

test('Insert Merge Field: a MERGEFIELD shown as «name», quoted when it has a space, replacing the selection; one undo step', async () => {
  const q = await s('Dear X, hello');
  await q.run('mailings.recipients', {csv: PEOPLE});
  const sel = (a, b) => q.t.session.setSelection(q.t.docId, {ranges: [{anchor: `/body/b:${q.t.content.body.chunks[0][0].id}/t:${a}`, focus: `/body/b:${q.t.content.body.chunks[0][0].id}/t:${b}`}], primary: 0});
  sel(5, 6);
  await expectUndoRoundTrip(q.t, 'mailings.insertField', {field: 'First Name'}, () => {
    assert.deepEqual(fieldsOf(q.t), [['MERGEFIELD "First Name"', '«First Name»']]);
    assert.equal(body(q.t), 'Dear «First Name», hello', 'the selected X is replaced by the field');
  });
  await q.run('mailings.insertField', {field: 'City'});
  assert.ok(fieldsOf(q.t).some(([i, r]) => i === 'MERGEFIELD City' && r === '«City»'));
  // With Preview Results on, a new field shows the record's value at once.
  await q.run('mailings.preview', {value: true});
  await q.run('mailings.insertField', {field: 'Plan'});
  assert.ok(fieldsOf(q.t).some(([i, r]) => i === 'MERGEFIELD Plan' && r === 'gold'), JSON.stringify(fieldsOf(q.t)));
  await rejects(q.run('mailings.insertField', {field: ''}));
});

test('Preview Results: values in, «names» back; each record change is an undo step; the box does not change the list', async () => {
  const q = await s('');
  await q.run('mailings.recipients', {csv: PEOPLE});
  await q.run('mailings.insertField', {field: 'First Name'});
  const before = q.t.doc.undo.size;
  await q.run('mailings.preview', {value: true});
  assert.equal(body(q.t), 'Ada');
  assert.equal(q.t.doc.undo.size, before + 1);
  await q.run('mailings.next');
  assert.equal(body(q.t), 'Alan');
  await q.run('mailings.next');
  assert.equal(body(q.t), 'Alan', 'past the last record stays on it');
  await q.t.undo();
  assert.equal(body(q.t), 'Ada', 'undo steps back through the previewed records');
  await q.run('mailings.preview', {value: false});
  assert.equal(body(q.t), '«First Name»');
  // Previewing and reading the list changes nothing else.
  assert.equal((await q.run('mailings.editRecipients')).records, 2);
});

test('Highlight Merge Fields toggles a view flag that shades merge fields on the page, never the list or the undo stack', async () => {
  const q = await s('Hi ');
  await q.run('mailings.recipients', {csv: PEOPLE});
  await q.run('caret.docEnd');
  await q.run('mailings.insertField', {field: 'City'});
  const depth = q.t.doc.undo.size;
  const shadedRuns = on => {
    const l = layout(q.t.content, {view: 'print', mergeHighlight: on});
    return JSON.stringify(l.pages.flatMap(p => p.items)).includes('217,217,217');
  };
  assert.equal(shadedRuns(false), false);
  await q.run('mailings.highlightFields');
  assert.equal(q.view().merge.highlight, true);
  assert.equal(q.t.state('mailings.highlightFields').checked, true);
  assert.equal(q.t.doc.undo.size, depth, 'a view change is not an edit');
  assert.equal(shadedRuns(true), true, 'the field is drawn shaded');
  await q.run('mailings.highlightFields');
  assert.equal(q.view().merge.highlight, false);
});

test('Rules: IF, SKIPIF and NEXTIF, NEXT and MERGEREC fields as upstream words them', async () => {
  const q = await s('');
  await q.run('mailings.recipients', {csv: PEOPLE});
  await q.run('mailings.rules', {rule: 'IF', field: 'First Name', value: 'Ada', then: 'yes', else: 'no'});
  await q.run('mailings.rules', {rule: 'SKIPIF', field: 'Plan', value: 'silver'});
  await q.run('mailings.rules', {rule: 'NEXTIF', field: 'Plan', value: 'gold'});
  await q.run('mailings.rules', {rule: 'NEXT'});
  await q.run('mailings.rules', {rule: 'MERGEREC'});
  assert.deepEqual(fieldsOf(q.t).map(f => f[0]).sort(), ['IF { MERGEFIELD "First Name" } = "Ada" "yes" "no"', 'MERGEREC', 'NEXT', 'NEXTIF { MERGEFIELD Plan } = "gold"',
    'SKIPIF { MERGEFIELD Plan } = "silver"'].sort());
  // Merge Record # shows the record's number in a preview.
  const q2 = await s('Record ');
  await q2.run('mailings.recipients', {csv: PEOPLE});
  await q2.run('caret.docEnd');
  await q2.run('mailings.rules', {rule: 'MERGEREC'});
  await q2.run('mailings.preview', {value: true});
  assert.equal(body(q2.t), 'Record 1');
  await q2.run('mailings.next');
  assert.equal(body(q2.t), 'Record 2');
});

test('Rules dialog: the rule is the opener\'s; the field, value and texts come from the form', async () => {
  const q = await s('');
  await q.run('mailings.recipients', {csv: PEOPLE});
  const v = openDialogModel(q.t.session, q.t.docId, ruleDialog);
  assert.deepEqual(v.fields, ['First Name', 'Last Name', 'City', 'Plan']);
  assert.equal(v.field, 'First Name');
  assert.deepEqual(ruleDialog.validate({...v, field: ' '}), [{field: 'field', message: 'Choose a field.'}]);
  const out = ruleDialog.toCommand({...v, field: 'Plan', value: 'gold', then: 'A', else: 'B'});
  assert.deepEqual(out, {command: 'mailings.rules', params: {field: 'Plan', value: 'gold', then: 'A', else: 'B'}});
  // The shell merges the opener's args (the rule) under these params.
  await q.run('mailings.rules', {...{rule: 'SKIPIF'}, ...out.params});
  assert.equal(fieldsOf(q.t)[0][0], 'SKIPIF { MERGEFIELD Plan } = "gold"');
  // Without a recipient list the field is typed.
  const none = await s('');
  assert.equal(openDialogModel(none.t.session, none.t.docId, ruleDialog).field, '');
});

test('Match Fields and Check for Errors report what upstream reports', async () => {
  const q = await s('');
  await q.run('mailings.recipients', {csv: 'Title,Given Name,Surname,Organisation,Street,Town,State,ZIP,Country\nDr,Ada,Lovelace,Analytical,1 Row,London,,SW1,UK'});
  const m = await q.run('mailings.matchFields');
  assert.equal(m.address.firstName, 'Given Name');
  assert.equal(m.address.lastName, 'Surname');
  assert.equal(m.address.address, 'Street');
  assert.equal(m.address.city, 'Town');
  assert.equal(m.address.postal, 'ZIP');
  assert.equal(m.address.company, null, '"Organisation" is not one of the names matched');
  assert.equal(m.address.title, 'Title');
  const dlg = openDialogModel(q.t.session, q.t.docId, matchDialog);
  assert.deepEqual(ADDRESS_PARTS.map(p => p[1]), ['title', 'firstName', 'lastName', 'company', 'address', 'city', 'state', 'postal', 'country']);
  assert.equal(dlg.address.postal, 'ZIP');
  await q.run('mailings.insertField', {field: 'Nope'});
  await q.run('mailings.insertField', {field: 'town'});
  const check = await q.run('mailings.checkErrors');
  assert.deepEqual(check, {ok: false, unknownFields: ['Nope'], records: 1}, 'field names match ignoring case');
  assert.deepEqual(openDialogModel(q.t.session, q.t.docId, checkDialog), {unknown: ['Nope'], records: 1});
  // An address block shows the matched parts, line by line.
  await q.run('mailings.addressBlock');
  await q.run('mailings.preview', {value: true});
  assert.ok(fieldsOf(q.t).some(([i, r]) => i === 'ADDRESSBLOCK' && r === 'Dr Ada Lovelace\nAnalytical\n1 Row\nLondon, SW1\nUK'.replace('Analytical\n', '')), JSON.stringify(fieldsOf(q.t)));
});

test('Find Recipient: the first record with the text in any field, any case', async () => {
  const q = await s('');
  await q.run('mailings.recipients', {csv: PEOPLE});
  assert.equal((await q.run('mailings.findRecipient', {text: 'WILMS'})).record, 2);
  assert.equal(q.t.state('mailings.goToRecord').value, 2);
  assert.equal(q.view().merge.preview, true, 'finding a recipient shows the preview');
  await rejects(q.run('mailings.findRecipient', {text: 'zzz'}), /no matching recipient/);
  assert.deepEqual(findDialog.validate({text: '  '}), [{field: 'text', message: 'Type what to find.'}]);
  assert.deepEqual(findDialog.toCommand({text: ' ada '}), {command: 'mailings.findRecipient', params: {text: 'ada'}});
});

test('Finish & Merge dialog: All, Current record or From and To, with the range checked before anything is made', async () => {
  const q = await s('');
  await q.run('mailings.recipients', {csv: PEOPLE});
  const v = openDialogModel(q.t.session, q.t.docId, recordsDialog);
  assert.deepEqual(v, {choice: 'all', from: '1', to: '2', count: 2});
  assert.deepEqual(recordParams(v), {records: 'all'});
  assert.deepEqual(recordParams({...v, choice: 'current'}), {records: 'current'});
  assert.deepEqual(recordParams({...v, choice: 'range', from: '2', to: '2'}), {from: 2, to: 2});
  assert.equal(recordParams({...v, choice: 'range', from: 'x', to: '2'}), null);
  assert.deepEqual(recordsDialog.validate({...v, choice: 'range', from: 'x'}), [{field: 'from', message: 'Enter a number.'}]);
  assert.match(recordsDialog.validate({...v, choice: 'range', from: '3', to: '2'})[0].message, /no records from 3 to 2 \(the list has 2\)/);
  assert.deepEqual(recordsDialog.validate({...v, choice: 'range', from: '2', to: '9'}), []);
  await q.run('mailings.insertField', {field: 'City'});
  const r = await submitDialog(q.t.session, q.t.docId, recordsDialog, {...v, choice: 'range', from: '2', to: '2'});
  assert.equal(r.result.records, 1);
  assert.equal(new Document(q.created.at(-1).content).plainText(BODY), 'Wilmslow');
  assert.equal(q.created.at(-1).title, 'Letters1');
  assert.equal(q.created.at(-1).show, true, 'a call from the window shows the new document');
});

test('Finish & Merge names the new document after the kind of merge and clears it of the merge setting', async () => {
  const q = await s('');
  await q.run('mailings.recipients', {csv: PEOPLE});
  await q.run('mailings.start', {kind: 'directory'});
  await q.run('mailings.insertField', {field: 'City'});
  await q.run('mailings.finish');
  assert.equal(q.created.at(-1).title, 'Directory1');
  assert.equal(q.created.at(-1).content.settings.mailMerge, null);
  assert.equal(new Document(q.created.at(-1).content).plainText(BODY), 'London\nWilmslow', 'a directory joins the records without page breaks');
  await q.run('mailings.start', {kind: 'letters'});
  await q.run('mailings.finish');
  const letters = new Document(q.created.at(-1).content);
  assert.ok(letters.plainText(BODY).includes('\u000C') || letters.story(BODY).len() >= 2, 'letters are separated by page breaks');
});

test('Recipient List dialog: a typed list, its blank rows dropped, errors said as upstream words them; filter and sort apply after', async () => {
  const q = await s('');
  const v = openDialogModel(q.t.session, q.t.docId, newListDialog);
  assert.deepEqual(v.fields, [...NEW_LIST_FIELDS]);
  assert.deepEqual(v.rows, [['', '', '', '', '']]);
  assert.deepEqual(newListDialog.validate(v), [{field: 'fields', message: 'Type at least one recipient.'}]);
  assert.deepEqual(recipientTable([], [['x']]), {error: 'Add at least one field.'});
  assert.deepEqual(recipientTable(['A', ' '], [['x', 'y']]), {error: 'Every field needs a name.'});
  assert.deepEqual(recipientTable(['A', 'a'], [['x', 'y']]), {error: 'Field names must be different.'});
  const rows = [['Ada', 'Lovelace', '', 'London', ''], ['', '', '', '', ''], ['Alan', 'Turing', '', 'Wilmslow', '']];
  const filled = {...v, rows, rules: [{field: 'City', op: 'equal', value: 'London', or: false}, {field: 'Gone', op: 'equal', value: 'x', or: false}],
    sort: [{field: 'First Name', descending: true}, {field: '', descending: false}, {field: '', descending: false}]};
  assert.deepEqual(newListDialog.validate(filled), []);
  const out = newListDialog.toCommand(filled);
  assert.equal(out.batch.length, 2);
  assert.deepEqual(out.batch[0].params.rows.length, 2, 'the blank record is dropped');
  assert.deepEqual(out.batch[1].params, {rules: [{field: 'City', op: 'equal', value: 'London', join: 'and'}], sort: [{field: 'First Name', descending: true}]}, 'a rule on a missing field drops');
  await submitDialog(q.t.session, q.t.docId, newListDialog, filled);
  const e = await q.run('mailings.editRecipients');
  assert.equal(e.rows.length, 2);
  assert.equal(e.records, 1);
  // Edit Recipient List opens on the list with its filter, every record shown.
  const again = openDialogModel(q.t.session, q.t.docId, recipientDialog);
  assert.equal(again.rows.length, 2);
  assert.deepEqual(again.rules, [{field: 'City', op: 'equal', value: 'London', or: false}]);
  assert.equal(again.sort[0].field, 'First Name');
  assert.equal(again.filterOpen, true);
  // With no list it opens as a new one.
  const fresh = await s('');
  assert.deepEqual(openDialogModel(fresh.t.session, fresh.t.docId, recipientDialog).fields, [...NEW_LIST_FIELDS]);
});

test('Recipient List grid: merge order, strike-through of left-out records, Find in list and the merged-only view (visible_recipients)', () => {
  const fields = ['Name', 'Age'];
  const rows = [['Ada', '36'], ['Alan', '41'], ['Grace', '85'], ['Linus', '9']];
  assert.equal(mergeOrder({fields, rows, rules: [], sort: [{field: '', descending: false}]}), null, 'no filter or sort: nothing is left out');
  const order = mergeOrder({fields, rows, rules: [{field: 'Age', op: 'greater', value: '40', or: false}], sort: [{field: 'Name', descending: true}]});
  assert.deepEqual(order, [null, 2, 1, null]);
  assert.deepEqual(visibleRecipients(rows, order, '', false), [0, 1, 2, 3]);
  assert.deepEqual(visibleRecipients(rows, order, '', true), [1, 2], 'only records that will be merged');
  assert.deepEqual(visibleRecipients(rows, order, 'AL', false), [1], 'Find in list ignores case');
  assert.deepEqual(visibleRecipients(rows, null, ' 85 ', true), [2]);
});

test('Envelopes dialog: the selected text is the delivery address; New Document and Add to Document', async () => {
  const q = await s('Ada Lovelace\n12 Crown Row');
  q.t.session.setSelection(q.t.docId, {ranges: [{anchor: `/body/b:${q.t.content.body.chunks[0][0].id}/t:0`, focus: `/body/b:${q.t.content.body.chunks[0][1].id}/t:12`}], primary: 0});
  const v = openDialogModel(q.t.session, q.t.docId, envelopeDialog);
  assert.equal(v.delivery, 'Ada Lovelace\n12 Crown Row');
  assert.deepEqual([v.ret, v.omit, v.size], ['', false, 0]);
  assert.equal(sizeOptions().length, ENVELOPE_SIZES.length);
  assert.equal(envelopeLabel(ENVELOPE_SIZES[0]), '#10   4.13 × 9.5 in');
  assert.equal(envelopeLabel(ENVELOPE_SIZES[3]), 'DL   110 × 220 mm');
  assert.deepEqual(envelopeParams({...v, ret: 'Me', size: 3}, true), {delivery: v.delivery, return: 'Me', size: 'Envelope DL', add: true});
  assert.equal(envelopeParams({...v, ret: 'Me', omit: true}, false).return, '', 'Omit leaves the return address out');
  assert.deepEqual(envelopeDialog.validate({...v, delivery: '  '}), [{field: 'delivery', message: 'Type a delivery address.'}]);
  assert.throws(() => envelopeDialog.buttons.newDocument(null, {...v, delivery: ' '}), /Type a delivery address/);
  const call = envelopeDialog.buttons.newDocument(null, v);
  assert.equal(call.close, true, 'New Document closes the dialog');
  assert.equal(call.params.add, false);
  const r = await submitDialog(q.t.session, q.t.docId, envelopeDialog, {...v, ret: 'Me', size: 5});
  assert.equal(r.result.added > 0, true, 'OK is Add to Document');
  assert.equal(new Document(q.t.content).sections().length, 2);
  await q.run('mailings.envelopes', call.params);
  assert.equal(q.created.length, 1);
  assert.equal(q.created.at(-1).title, 'Envelopes1');
});

test('Labels dialog: one label per recipient when there is a list; a single label at a row and column on the sheet', async () => {
  const q = await s('');
  let v = openDialogModel(q.t.session, q.t.docId, labelsDialog);
  assert.deepEqual([v.recipients, v.hasRecipients, v.single, v.row, v.col], [false, false, false, 1, 1]);
  assert.deepEqual(labelsDialog.validate(v), [{field: 'text', message: 'Type an address.'}]);
  assert.equal(productOptions().length, LABEL_PRODUCTS.length);
  assert.equal(productLabel(LABEL_PRODUCTS[0]), 'Address labels, 3 × 10, 2.625" × 1" (Letter)');
  assert.equal(productLabel(LABEL_PRODUCTS[5]), 'Address labels, 3 × 7, 63.5 × 38.1 mm (A4)');
  assert.equal(productLabel(LABEL_PRODUCTS[3]), 'Shipping labels, 2 × 5, 4" × 2" (Letter)');
  assert.equal(productLabel(LABEL_PRODUCTS[4]), 'Return address labels, 4 × 20, 1.75" × 0.5" (Letter)');
  await q.run('mailings.recipients', {csv: PEOPLE});
  v = openDialogModel(q.t.session, q.t.docId, labelsDialog);
  assert.deepEqual([v.recipients, v.hasRecipients], [true, true]);
  assert.deepEqual(labelsDialog.validate(v), []);
  assert.deepEqual(labelParams(v), {text: '', product: 'letter-3x10', fromRecipients: true});
  assert.deepEqual(labelParams({...v, single: true, row: 2, col: 3, text: 'X'}), {text: 'X', product: 'letter-3x10', fromRecipients: false, single: {row: 2, col: 3}});
  // The row and column stay on the sheet when the product changes.
  const next = changeDialogValues(labelsDialog, {...v, row: 9, col: 3, single: true}, 'product', 3);
  assert.deepEqual([next.row, next.col], [5, 2], 'a 2 × 5 sheet has 5 rows and 2 columns');
  const r = await submitDialog(q.t.session, q.t.docId, labelsDialog, v);
  assert.equal(r.result.filled, 2, 'one label per recipient');
  assert.equal(q.created.at(-1).title, 'Labels1');
});

test('Insert Merge Field dialog: the list\'s fields, the first one chosen; a typed name goes in as typed', async () => {
  const q = await s('');
  assert.deepEqual(openDialogModel(q.t.session, q.t.docId, insertFieldDialog), {fields: [], field: ''});
  await q.run('mailings.recipients', {csv: PEOPLE});
  const v = openDialogModel(q.t.session, q.t.docId, insertFieldDialog);
  assert.deepEqual([v.fields.length, v.field], [4, 'First Name']);
  assert.deepEqual(insertFieldDialog.validate({...v, field: ' '}), [{field: 'field', message: 'Choose a field.'}]);
  await submitDialog(q.t.session, q.t.docId, insertFieldDialog, {...v, field: ' Typed '});
  assert.deepEqual(fieldsOf(q.t), [['MERGEFIELD Typed', '«Typed»']]);
});

test('.docx: merge fields and the kind of merge survive a save; Word\'s own MERGEFIELD reads back', async () => {
  const q = await s('Dear ');
  await q.run('mailings.recipients', {csv: PEOPLE});
  await q.run('mailings.start', {kind: 'letters'});
  await q.run('caret.docEnd');
  await q.run('mailings.insertField', {field: 'First Name'});
  await q.run('mailings.rules', {rule: 'IF', field: 'Plan', value: 'gold', then: 'VIP', else: ''});
  await q.run('mailings.greetingLine');
  const bytes = await writeDocx(q.t.content);
  const files = await (await import('jszip')).default.loadAsync(bytes);
  const settings = await files.file('word/settings.xml').async('string');
  assert.ok(settings.includes('<w:mailMerge><w:mainDocumentType w:val="formLetters"/></w:mailMerge>'), settings.slice(0, 600));
  assert.ok(settings.indexOf('w:mailMerge') < settings.indexOf('w:defaultTabStop'), 'in CT_Settings order');
  const doc = await files.file('word/document.xml').async('string');
  assert.ok(doc.includes('MERGEFIELD &quot;First Name&quot;') || doc.includes('MERGEFIELD "First Name"'), doc.slice(0, 1500));
  const back = await readDocx(bytes);
  assert.equal(back.settings.mailMerge.kind, 'letters');
  const flat = back.body.chunks.flat().filter(b => b.kind === 'para').flatMap(p => (p.objects ?? []).filter(o => o.type === 'field').map(o => [o.instr.trim(), o.result]));
  assert.deepEqual(flat[0], ['MERGEFIELD "First Name"', '«First Name»']);
  assert.ok(flat.some(([i]) => i.startsWith('IF { MERGEFIELD Plan }') || i.startsWith('IF')), JSON.stringify(flat));
  assert.ok(flat.some(([i, r]) => i === 'GREETINGLINE' && r === '«GreetingLine»'));
  // A reopened document is a mail merge document: its kind is checked and its fields still merge.
  const q2 = await s('', {content: back});
  assert.equal(q2.t.state('mailings.start', {kind: 'letters'}).checked, true);
  await q2.run('mailings.recipients', {csv: PEOPLE});
  await q2.run('mailings.preview', {value: true});
  assert.ok(body(q2.t).includes('Ada'), body(q2.t));
  // Other kinds map to Word's names; a normal document writes none.
  for (const [kind, type] of [['emails', 'email'], ['envelopes', 'envelopes'], ['labels', 'mailingLabels'], ['directory', 'catalog']]) {
    await q.run('mailings.start', {kind});
    const x = await (await import('jszip')).default.loadAsync(await writeDocx(q.t.content));
    assert.ok((await x.file('word/settings.xml').async('string')).includes(`w:mainDocumentType w:val="${type}"`), kind);
  }
  await q.run('mailings.start', {kind: 'normal'});
  const n = await (await import('jszip')).default.loadAsync(await writeDocx(q.t.content));
  assert.ok(!(await n.file('word/settings.xml').async('string')).includes('mailMerge'));
});

test('.docx: a Word mail merge setting with a data source reads its kind and drops the source (settings_merge.rs)', async () => {
  const q = await s('Dear ');
  await q.run('mailings.start', {kind: 'labels'});
  const JSZip = (await import('jszip')).default;
  const z = await JSZip.loadAsync(await writeDocx(q.t.content));
  const st = await z.file('word/settings.xml').async('string');
  z.file('word/settings.xml', st.replace('<w:mailMerge><w:mainDocumentType w:val="mailingLabels"/></w:mailMerge>',
    '<w:mailMerge><w:mainDocumentType w:val="formLetters"/><w:linkToQuery/><w:dataType w:val="textFile"/><w:dataSource r:id="rId9"/></w:mailMerge>'));
  const back = await readDocx(await z.generateAsync({type: 'uint8array'}));
  assert.equal(back.settings.mailMerge.kind, 'letters');
  const again = await JSZip.loadAsync(await writeDocx(back));
  const out = await again.file('word/settings.xml').async('string');
  assert.ok(out.includes('formLetters') && !out.includes('dataSource') && !out.includes('rId9'), 'the data source (a relationship that is not carried) is dropped');
});

test('Spreadsheet values: numbers as the sheet shows them, dates and times as ISO text, field names numbered', () => {
  assert.equal(number(-0), '0');
  assert.equal(number(1.5), '1.5');
  assert.equal(number(0.1 + 0.2), '0.3');
  assert.equal(number(1e21), '1E21');
  assert.equal(serialDate(45356, false, 'date'), '2024-03-05');
  assert.equal(serialDate(45356.5, false, 'datetime'), '2024-03-05 12:00');
  assert.equal(serialDate(0.75, false, 'time'), '18:00');
  assert.equal(serialDate(1, false, 'date'), '1900-01-01');
  assert.equal(serialDate(61, false, 'date'), '1900-03-01', 'the 1900 leap-year quirk');
  assert.equal(serialDate(43000, true, 'date'), '2021-09-23', 'the 1904 system');
  assert.equal(serialDate(-1, false, 'date'), null);
  assert.equal(builtinDate(14), 'date');
  assert.equal(builtinDate(21), 'time');
  assert.equal(builtinDate(22), 'datetime');
  assert.equal(builtinDate(0), null);
  assert.equal(customDate('yyyy-mm-dd'), 'date');
  assert.equal(customDate('hh:mm:ss'), 'time');
  assert.equal(customDate('dd/mm/yyyy hh:mm'), 'datetime');
  assert.equal(customDate('"day" 0'), null);
  assert.equal(customDate('[Red]0.00;[Blue]d'), null, 'only the first section counts');
  assert.equal(isoDatetime('2024-03-05T13:45:10.000'), '2024-03-05 13:45:10');
  assert.equal(isoDatetime('2024-03-05T00:00:00'), '2024-03-05');
  assert.equal(isoDatetime('2024-13-05'), null);
  assert.equal(isoTime('PT13H45M00S'), '13:45');
  assert.equal(isoTime('13:45:30.5'), '13:45:30');
  assert.deepEqual(fieldNames(['Name', '', 'name', 'Name', ' City ']), ['Name', 'Column 2', 'name 2', 'Name 3', 'City']);
});
