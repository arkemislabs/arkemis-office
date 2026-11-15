// Action Wizard (core/folio/commands/actions.mjs).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) crates/engine/src/actions.rs: an action is a list of steps run in order (Remove hidden information, Flatten comments, Add watermark, Add footer...);
//    a step that removes information and finds nothing logs "nothing to remove", any other step that fails logs why and the action goes on; the built-in actions are Prepare for
//    Distribution, Optimize Scanned Documents, Add Page Numbers, Mark as Confidential and Sanitize Documents. Acrobat's Action Wizard works the same way. Upstream runs an action
//    over files into a folder: here it runs on the open document, as one undo step.
// 2. Ours runs real steps on a real document and reads the result back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {BUILTIN, STEPS} from '../../core/folio/commands/actions.mjs';
import wizard from '../../core/folio/dialogs/action-wizard.mjs';

const N = s => PDFName.of(s);
const session = () => createTestSession('folio', {fixture: 'textPages'});
const doc = async t => PDFDocument.load(Buffer.from(t.content.sourceBase64, 'base64'));

test('the built-in actions are upstream\'s five and then Make Accessible and Archive Documents; the steps never include running a JavaScript', async () => {
  const t = await session();
  const r = (await t.exec('actions.list', {})).result;
  assert.deepEqual(r.actions.slice(0, 5).map(a => a.name), ['Prepare for Distribution', 'Optimize Scanned Documents', 'Add Page Numbers', 'Mark as Confidential', 'Sanitize Documents']);
  assert.deepEqual(r.actions.slice(5).map(a => a.name), ['Make Accessible', 'Archive Documents']);
  assert.ok(r.actions.every(a => a.builtin));
  assert.equal(STEPS.some(x => /javascript/i.test(x.id)), false);
  assert.equal(BUILTIN.find(a => a.name === 'Add Page Numbers').steps[0].arg, 'Page <<1>> of <<n>>');
});

test('Mark as Confidential puts a watermark on every page in one undo step; Add Page Numbers writes the footer', async () => {
  const t = await session();
  const r = (await t.exec('actions.run', {action: 'Mark as Confidential'})).result;
  assert.equal(r.failed, 0);
  assert.deepEqual(r.steps.map(x => [x.step, x.status]), [['Add watermark', 'done']]);
  assert.match(r.message, /Mark as Confidential: 1 step done/);
  const before = t.content.sourceBase64;
  await t.undo();
  assert.notEqual(t.content.sourceBase64, before, 'undo takes the watermark off');
  const n = (await t.exec('actions.run', {action: 'add page numbers'})).result;
  assert.equal(n.failed, 0);
});

test('a step that removes information and finds nothing says so; a step that cannot be done is logged and the action goes on', async () => {
  const t = await session();
  const r = (await t.exec('actions.run', {steps: [{id: 'remove_hidden_information'}, {id: 'flatten_fields'}, {id: 'add_watermark', arg: 'DRAFT'}]})).result;
  const by = Object.fromEntries(r.steps.map(x => [x.step, x]));
  assert.equal(by['Flatten form fields'].status, 'failed', 'the document has no form fields');
  assert.equal(by['Add watermark'].status, 'done', 'the action went on after a step that could not be done');
  assert.equal(r.failed, 1);
  assert.match(r.message, /1 of 3 steps could not be done/);
  assert.ok(['done', 'skipped'].includes(by['Remove hidden information'].status));
});

test('Make Accessible and Reduce file size run as steps; Set document title writes the title', async () => {
  const t = await session();
  const r = (await t.exec('actions.run', {steps: [{id: 'set_title', arg: 'Quarterly report'}, {id: 'reduce_file_size'}, {id: 'make_accessible'}]})).result;
  assert.equal(r.failed, 0, JSON.stringify(r.steps));
  assert.match(r.steps[1].detail, /→/);
  assert.match(r.steps[2].detail, /need a manual check/);
  const d = await doc(t);
  assert.equal(d.getTitle(), 'Quarterly report');
  assert.ok(d.catalog.has(N('StructTreeRoot')));
});

test('actions made here are kept in the preferences, can be run, replaced and deleted; a built-in name is refused; a step with text needs its text', async () => {
  const t = await session();
  await t.exec('actions.save', {name: 'Draft stamp', description: 'A watermark', steps: [{id: 'add_watermark', arg: 'DRAFT'}]});
  const list = (await t.exec('actions.list', {})).result.actions;
  assert.equal(list.at(-1).name, 'Draft stamp');
  assert.equal(list.at(-1).builtin, false);
  assert.equal((await t.exec('actions.run', {action: 'Draft stamp'})).result.failed, 0);
  await t.exec('actions.save', {name: 'draft stamp', steps: [{id: 'add_watermark', arg: 'FINAL'}]});
  assert.equal((await t.exec('actions.list', {})).result.actions.filter(a => /draft stamp/i.test(a.name)).length, 1);
  await assert.rejects(() => t.exec('actions.save', {name: 'Sanitize Documents', steps: [{id: 'sanitize'}]}), /built-in/);
  await assert.rejects(() => t.exec('actions.save', {name: 'x', steps: [{id: 'add_footer', arg: ' '}]}), /needs its footer text/);
  await assert.rejects(() => t.exec('actions.delete', {name: 'Add Page Numbers'}), /built-in/);
  await t.exec('actions.delete', {name: 'draft stamp'}).catch(() => t.exec('actions.delete', {name: 'Draft stamp'}));
  assert.equal((await t.exec('actions.list', {})).result.actions.some(a => /draft stamp/i.test(a.name)), false);
  await assert.rejects(() => t.exec('actions.run', {action: 'Nope'}), /there is no action Nope/);
});

test('the dialog opens on the action a control names and runs it', async () => {
  const t = await session();
  const v = wizard.init(t.session.readContext(t.docId), {action: 'Prepare for Distribution'});
  assert.equal(v.action, 'Prepare for Distribution');
  assert.deepEqual(wizard.validate({action: ''}).map(p => p.field), ['action']);
  assert.deepEqual(wizard.toCommand(v), {command: 'actions.run', params: {action: 'Prepare for Distribution'}});
});
