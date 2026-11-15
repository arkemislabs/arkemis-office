// Tests for core/common: edit.undo / edit.redo / edit.undoTo / edit.undoHistory / edit.repeat,
// file.save / file.rename / file.close / file.autosave / file.properties, view.zoom / view.zoom100 /
// view.zoomIn / view.zoomOut, tools.customizeRibbon, the common dialogs and the clipboard core.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip, expectApprovalRequired} from '../../core/kernel/testing.mjs';
import {defineCommands} from '../../core/kernel/command.mjs';
import {s} from '../../core/kernel/schema.mjs';
import {openDialogModel, submitDialog, changeDialogValues, pressDialogButton} from '../../core/kernel/dialog.mjs';
import {modules as quillModules, sources as quillSources} from '../../core/generated/quill.commands.mjs';
import {dialogs as quillDialogs} from '../../core/generated/quill.dialogs.mjs';
import {apps} from '../../core/generated/apps.mjs';
import {RibbonLayout} from '../../core/common/lib/ribbon-layout.mjs';
import {writeClipboard, readClipboard, clipboardList} from '../../core/common/lib/clipboard.mjs';
import {listFamily, listContent} from './helpers.mjs';

// Stand-ins for app commands the ribbon tests add to custom groups (wordcraft ids), for the ids
// no Quill family registers yet.
const registered = new Set(quillModules.flatMap(m => m.commands.map(c => c.id)));
const stubs = defineCommands({family: 'stubs', app: 'quill', upstream: {repo: 'wordcraft', files: []}, commands: ['format.bold', 'format.italic', 'edit.copy']
  .filter(id => !registered.has(id))
  .map(id => ({id, label: id, risk: 'edit', params: s.object({}), run() {}}))});

const make = (opts = {}) => createTestSession('quill', {
  modules: [...quillModules, listFamily, stubs], sources: [...quillSources, 'tests/kernel/helpers.mjs', 'stubs'],
  foundation: apps.quill, content: listContent(), ...opts});

test('edit.undo, edit.redo and edit.undoTo step through the history; edit.undoHistory lists it', async () => {
  const t = await make();
  for (const v of ['e', 'f', 'g']) await t.exec('list.push', {value: v});
  assert.deepEqual((await t.exec('edit.undoHistory')).result, {undo: ['Push', 'Push', 'Push'], depth: 3, redo: null});
  const u = await t.exec('edit.undo');
  assert.equal(u.result.undone, 1);
  assert.deepEqual(t.content.items.slice(-1), ['f']);
  const r = await t.exec('edit.undoTo', {count: 2});
  assert.deepEqual(r.result.undone, 2);
  assert.equal(r.result.depth, 0);
  assert.deepEqual(t.content.items, ['a', 'b', 'c', 'd']);
  assert.equal(t.state('edit.undo').enabled, false);
  await assert.rejects(t.exec('edit.undo'), e => e.code === 'disabled' && e.message === 'there is nothing to undo');
  await t.exec('edit.redo', {steps: 3});
  assert.deepEqual(t.content.items.slice(-3), ['e', 'f', 'g']);
  assert.equal(t.state('edit.redo').enabled, false);
  await t.exec('edit.undo', {steps: 1});
  assert.equal(t.state('edit.redo').value, 'Push');
  await t.exec('list.push', {value: 'h'});
  assert.equal(t.state('edit.redo').enabled, false, 'a new edit clears redo');
});

test('edit.repeat runs the last command again as its own undo entry', async () => {
  const t = await make();
  await assert.rejects(t.exec('edit.repeat'), e => e.code === 'disabled' && e.message === 'nothing to repeat');
  await t.exec('list.push', {value: 'x'});
  const r = await t.exec('edit.repeat');
  assert.equal(r.undoLabel, 'Push');
  assert.deepEqual(t.content.items.slice(-2), ['x', 'x']);
  await t.exec('edit.undo');
  await t.exec('edit.repeat');
  assert.deepEqual(t.content.items.slice(-2), ['x', 'x'], 'undo does not change what Repeat repeats');
});

test('file.rename is undoable, and dialog.renameDocument submits it', async () => {
  const t = await make();
  await expectUndoRoundTrip(t, 'file.rename', {name: '  Quarterly report  '}, after => assert.equal(after.file.title, 'Quarterly report'));
  const d = quillDialogs['dialog.renameDocument'];
  const values = openDialogModel(t.session, t.docId, d);
  assert.equal(values.name, 'Quarterly report');
  assert.deepEqual(d.validate({name: ' '}), [{field: 'name', message: 'Enter a name'}]);
  await assert.rejects(submitDialog(t.session, t.docId, d, {name: ''}), e => e.code === 'invalid_params' && e.data.fields[0].field === 'name');
  const r = await submitDialog(t.session, t.docId, d, {name: 'Final'});
  assert.equal(r.undoLabel, 'Rename Document');
  assert.equal(t.file.title, 'Final');
});

test('file.properties sets and removes properties undoably', async () => {
  const t = await make();
  await expectUndoRoundTrip(t, 'file.properties', {author: 'Ada', custom: {client: 'Acme'}}, after => {
    assert.deepEqual(after.file.properties, {author: 'Ada', custom: {client: 'Acme'}});
  });
  await t.exec('file.properties', {custom: {client: null, region: 'EU'}});
  assert.deepEqual(t.file.properties.custom, {region: 'EU'});
  const read = await t.exec('file.properties', {});
  assert.equal(read.result.properties.author, 'Ada');
  assert.equal(read.changed.length, 0, 'reading changes nothing');
});

test('file.save persists through the host; saving a copy to a path asks over the bridge', async () => {
  const t = await make();
  await t.exec('list.push', {value: 'e'});
  assert.equal(t.doc.dirty, true);
  const events = [];
  t.session.subscribe(e => events.push(e.type));
  const r = await t.exec('file.save', {});
  assert.equal(r.result.saved, true);
  assert.equal(t.doc.dirty, false);
  assert.equal(t.doc.storeRevision, 1);
  assert.ok(events.includes('doc.saved'));
  assert.equal(t.host.saved.length, 1);
  await t.bridge('file.save', {});
  const ask = await expectApprovalRequired(t, 'file.save', {path: 'C:/out/report.docx', password: 'pw'});
  assert.equal(ask.risk, 'irreversible');
  assert.match(ask.summary, /Save a copy of "Test document" to C:\/out\/report\.docx/);
  await t.bridge('file.save', {path: 'C:/out/report.docx', password: 'pw'}, {approval: {nonce: ask.nonce}});
  assert.equal(t.host.saved.at(-1).opts.path, 'C:/out/report.docx');
  assert.equal(t.session.journal.at(-1).params.password, '••••', 'passwords are never journaled');
});

test('file.close: unsaved changes need save or force; force over the bridge needs approval', async () => {
  const t = await make();
  await t.exec('list.push', {value: 'e'});
  await assert.rejects(t.exec('file.close'), /unsaved changes/);
  const ask = await expectApprovalRequired(t, 'file.close', {force: true});
  assert.equal(ask.risk, 'destructive');
  assert.match(ask.summary, /discard its unsaved changes/);
  const r = await t.bridge('file.close', {force: true}, {approval: {nonce: ask.nonce}});
  assert.equal(r.result.closed, true);
  assert.equal(t.session.docs.size, 0);
  assert.deepEqual(t.host.closed[0], {docId: 'doc1', opts: {discard: true}});
  const t2 = await make();
  await t2.exec('list.push', {value: 'e'});
  await t2.bridge('file.close', {save: true});
  assert.equal(t2.host.saved.length, 1);
  assert.equal(t2.host.closed[0].opts.discard, false);
});

test('file.autosave toggles the preference and saves prefs through the host', async () => {
  const t = await make();
  assert.equal(t.state('file.autosave').checked, true);
  await t.exec('file.autosave');
  assert.equal(t.session.prefs.autosave, false);
  assert.equal(t.state('file.autosave').checked, false);
  await t.exec('file.autosave', {value: true});
  assert.deepEqual(t.host.savedPrefs, {autosave: true});
  assert.equal(t.version, 0, 'preferences never touch the document');
});

test('view.zoom, view.zoom100, view.zoomIn and view.zoomOut change view state, never the undo list', async () => {
  const t = await make();
  assert.deepEqual((await t.exec('view.zoom', {value: 150})).result, {zoom: 150, fit: null});
  assert.deepEqual((await t.exec('view.zoomIn')).result, {zoom: 160, fit: null});
  await t.exec('view.zoom', {percent: 33});
  assert.equal((await t.exec('view.zoomOut')).result.zoom, 20);
  await t.exec('view.zoom100');
  assert.equal(t.doc.view.zoom, 100);
  assert.equal(t.state('view.zoom100').checked, true);
  await t.exec('view.zoom', {value: 'pageWidth'});
  assert.equal(t.doc.view.fit, 'pageWidth');
  await assert.rejects(t.exec('view.zoom', {value: 600}), e => e.code === 'invalid_params');
  await assert.rejects(t.exec('view.zoom', {}), e => e.code === 'invalid_params');
  await t.exec('view.zoom', {value: 500});
  assert.equal(t.state('view.zoomIn').enabled, false);
  assert.equal(t.version, 0);
  assert.equal(t.doc.undo.size, 0);
  const g = await createTestSession('grid', {modules: quillModules, foundation: {}, content: listContent()});
  await assert.rejects(g.exec('view.zoom', {percent: 450}), /10–400%/, 'Grid zooms to 400% at most');
});

test('the PDF view zooms 8–6400% and steps through Acrobat\'s zoom menu (printcraft zoom.rs zoom_step)', async () => {
  const f = await createTestSession('folio', {modules: quillModules, foundation: {}, content: {pages: []}});
  await f.exec('view.zoom', {value: 8});
  assert.equal(f.doc.view.zoom, 8);
  assert.equal(f.state('view.zoomOut').enabled, false, '8% has no smaller step');
  assert.equal((await f.exec('view.zoomIn')).result.zoom, 10);
  await f.exec('view.zoom', {value: 100});
  assert.equal((await f.exec('view.zoomIn')).result.zoom, 125);
  assert.equal((await f.exec('view.zoomOut')).result.zoom, 100);
  assert.equal((await f.exec('view.zoomOut')).result.zoom, 75);
  await f.exec('view.zoom', {value: 99.5});
  assert.equal((await f.exec('view.zoomIn')).result.zoom, 125, 'a step must be more than 1% away (s > z * 1.01)');
  await f.exec('view.zoom', {value: 6400});
  assert.equal(f.state('view.zoomIn').enabled, false);
  assert.equal((await f.exec('view.zoomOut')).result.zoom, 3200);
  await assert.rejects(f.exec('view.zoom', {value: 7}), e => e.code === 'invalid_params');
  await assert.rejects(f.exec('view.zoom', {value: 6500}), e => e.code === 'invalid_params');
});

test('dialog.zoom maps presets, modes and percents onto view.zoom', async () => {
  const t = await make();
  const d = quillDialogs['dialog.zoom'];
  await t.exec('view.zoom', {value: 75});
  const v = openDialogModel(t.session, t.docId, d);
  assert.equal(v.preset, '75%');
  assert.equal(v.percent, 75);
  const v2 = changeDialogValues(d, v, 'preset', '200%');
  assert.equal(v2.percent, 200);
  assert.deepEqual(d.toCommand(v2), {command: 'view.zoom', params: {percent: 200}});
  assert.deepEqual(d.toCommand({mode: 'Fit'}), {command: 'view.zoom', params: {value: 'fit'}});
  assert.deepEqual(d.toCommand({preset: 'fit'}), {command: 'view.zoomToSelection', params: {}});
  assert.equal(d.validate({percent: 5}).length, 1);
  await submitDialog(t.session, t.docId, d, v2);
  assert.equal(t.doc.view.zoom, 200);
  await pressDialogButton(t.session, t.docId, d, 'pageWidth', v2);
  assert.equal(t.doc.view.fit, 'pageWidth');
});

// Port of wordcraft crates/engine/src/ribbon.rs #[test] layout_changes_through_the_command (#379).
test('tools.customizeRibbon: layout_changes_through_the_command', async () => {
  const t = await make();
  const run = params => t.session.execute(null, 'tools.customizeRibbon', params, {origin: 'bridge'});
  const r1 = await run({newTab: {name: 'Mine', after: 'Home'}, hide: 'Draw'});
  assert.equal(r1.result.tab, 'Mine');
  await run({add: {tab: 'Mine', group: 'New Group', command: 'format.bold'}});
  await run({newGroup: {tab: 'Insert', name: 'Extras'}});
  await run({add: {tab: 'Insert', group: 'Extras', command: 'edit.copy'}});
  await run({rename: {tab: 'Mine', to: 'Writing'}});
  const r = (await run({move: {tab: 'Writing', by: -5}, qatAdd: 'format.bold', qatRemove: 'file.save'})).result;
  assert.equal(r.tabs[0].name, 'Writing');
  assert.deepEqual(r.tabs[0].groups[0].commands, ['format.bold']);
  assert.ok(r.tabs.some(x => x.name === 'Draw' && x.hidden === true));
  assert.deepEqual(r.qat, ['edit.undo', 'edit.redo', 'format.bold']);
  // Built-in tabs keep their names and can only be hidden; reserved and unknown names fail.
  await assert.rejects(run({rename: {tab: 'Home', to: 'Start'}}), e => e.code === 'invalid_params');
  await assert.rejects(run({remove: {tab: 'Home'}}), /built-in tab: hide it instead/);
  await assert.rejects(run({rename: {tab: 'Writing', to: 'insert'}}), /already a tab named/);
  await assert.rejects(run({add: {tab: 'Writing', group: 'New Group', command: 'no.such'}}), /unknown command/);
  await assert.rejects(run({move: {tab: 'Nope', by: 1}}), /no tab `Nope`/);
  assert.deepEqual(t.session.prefs.ribbon.qat, ['edit.undo', 'edit.redo', 'format.bold']);
  await run({reset: true});
  assert.deepEqual(t.session.prefs.ribbon, {});
  const read = await run({});
  assert.equal(read.result.tabs.length, apps.quill.spec.tabs.length);
  assert.deepEqual(read.result.qat, ['file.save', 'edit.undo', 'edit.redo']);
});

// Port of wordcraft crates/engine/src/ribbon.rs #[test] saved_layouts_round_trip_and_junk_is_ignored.
test('ribbon layout: saved_layouts_round_trip_and_junk_is_ignored', () => {
  const info = apps.quill.spec;
  const known = new Set(['format.bold', 'format.italic', 'edit.undo', 'edit.redo', 'edit.repeat', 'file.save']);
  const has = id => known.has(id);
  const l = new RibbonLayout(info);
  l.newTab(null, null);
  l.add(has, 'New Tab', 'New Group', 'format.italic', null);
  l.setHidden('Mailings', true);
  l.qatAdd(has, 'edit.repeat');
  const back = RibbonLayout.fromValue(info, JSON.parse(JSON.stringify(l.toValue())));
  assert.deepEqual(back.toValue(), l.toValue());
  const junk = {
    tabs: [
      {name: 'Home', groups: [{name: 'G', commands: ['format.bold', 'gone.command', 7, 'format.bold']}]},
      {name: 'Home'}, {name: 'Bogus'}, {name: 'Review', custom: true}, {name: '  '},
      {name: 'Mine', custom: true, hidden: 'yes', groups: 'x'}, 5,
    ],
    qat: ['edit.undo', 'gone.command', 3, 'edit.undo'],
  };
  const j = RibbonLayout.fromValue(info, junk);
  j.retainKnown(has);
  const tabs = j.tabs();
  assert.equal(tabs.length, info.tabs.length + 1, 'the built-in tabs and Mine');
  assert.deepEqual(tabs[0].groups[0].commands, ['format.bold']);
  assert.ok(tabs.some(x => x.custom && x.name === 'Mine' && !x.hidden));
  assert.deepEqual(j.qat(), ['edit.undo']);
  for (const v of [null, 5, 'x', {tabs: {a: 1}, qat: 'file.save'}]) assert.deepEqual(RibbonLayout.fromValue(info, v).toValue(), {});
});

test('dialog.customizeRibbon buttons drive tools.customizeRibbon', async () => {
  const t = await make();
  const d = quillDialogs['dialog.customizeRibbon'];
  let v = openDialogModel(t.session, t.docId, d);
  assert.deepEqual(v.qat, ['file.save', 'edit.undo', 'edit.redo']);
  await pressDialogButton(t.session, t.docId, d, 'newTab', {...v, tab: 'Home'});
  v = openDialogModel(t.session, t.docId, d);
  assert.equal(v.tabs[1].name, 'New Tab');
  await pressDialogButton(t.session, t.docId, d, 'add', {...v, page: 'qat', command: 'format.italic'});
  await pressDialogButton(t.session, t.docId, d, 'up', {...v, page: 'qat', qatCommand: 'format.italic'});
  assert.deepEqual(t.session.prefs.ribbon.qat, ['file.save', 'edit.undo', 'format.italic', 'edit.redo']);
  await submitDialog(t.session, t.docId, d, openDialogModel(t.session, t.docId, d));
  await pressDialogButton(t.session, t.docId, d, 'reset', {...v, page: 'ribbon'});
  assert.equal(t.session.prefs.ribbon.tabs, undefined);
});

test('the save-changes message boxes answer through file.close', async () => {
  const t = await make();
  await t.exec('list.push', {value: 'e'});
  for (const id of ['dialog.saveChanges', 'dialog.close', 'prompt.save-changes']) {
    const d = quillDialogs[id];
    assert.ok(d, id);
    assert.match(openDialogModel(t.session, t.docId, d).message, /“Test document”/);
    assert.deepEqual(d.toCommand({}), {command: 'file.close', params: {save: true}});
  }
  await pressDialogButton(t.session, t.docId, quillDialogs['dialog.saveChanges'], 'dont-save', {});
  assert.equal(t.session.docs.size, 0);
  assert.equal(t.host.closed[0].opts.discard, true);
});

test('clipboard core keeps the rich payload while the system clipboard still holds the copy', async () => {
  const copy = defineCommands({family: 'clip', app: 'quill', upstream: {repo: 'office', files: []}, commands: [
    {id: 'clip.copy', label: 'Copy', risk: 'read', params: s.object({}),
      run: ctx => writeClipboard(ctx, {text: ctx.doc.items.join('\r\n'), html: '<ul></ul>', kind: 'items', data: ctx.doc.items})},
    {id: 'clip.read', label: 'Read', risk: 'read', params: s.object({}), run: ctx => readClipboard(ctx)},
    {id: 'clip.list', label: 'List', risk: 'read', params: s.object({}), run: ctx => clipboardList(ctx)},
  ]});
  const t = await createTestSession('quill', {modules: [copy], foundation: {}, content: listContent()});
  await t.exec('clip.copy');
  assert.deepEqual((await t.host.clipboardRead()).text, 'a\r\nb\r\nc\r\nd');
  const r = (await t.exec('clip.read')).result;
  assert.equal(r.source, 'internal');
  assert.deepEqual(r.data, ['a', 'b', 'c', 'd']);
  await t.host.clipboardWrite({text: 'from elsewhere'});
  assert.deepEqual((await t.exec('clip.read')).result, {source: 'external', text: 'from elsewhere', html: ''});
  const items = (await t.exec('clip.list')).result;
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'a b c d');
});
