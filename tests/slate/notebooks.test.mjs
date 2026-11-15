// U:slate/notebooks: File › New / Open, Close This Notebook, Notebook Properties and colour.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `notebook.*` (sourceRef
//    core/slate-notebooks.mjs) names the commands; OneNote's behaviour: File › New asks where the
//    notebook goes and opens it; File › Open (Ctrl+O) opens a notebook folder (an open one comes
//    forward); Close This Notebook keeps its files; Notebook Properties changes the display name
//    and colour.
// 2. Ours calls the host's notebook service (the main process shows the system dialogs and reads
//    and writes the folder, design note integrator--slate-notebook--host-notebooks); without
//    it (headless, tests) New and Open are disabled with the reason. Properties edit the notebook
//    record, one undo entry.
// 3. Proof: these tests (engine with a recording notebook service, dialog models) and
//    tests/e2e/slate/pages-sections.e2e.mjs (Notebook Properties through the bridge).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import propertiesDialog from '../../core/slate/dialogs/notebook-properties.mjs';
import newDialog, {BROWSE} from '../../core/slate/dialogs/new-notebook.mjs';
import {buildNotebook, notebookSession} from './foundation-helpers.mjs';

function recordingHost() {
  const calls = [];
  const host = createTestHost();
  host.notebooks = {
    async create(mode, opts) { calls.push([mode, opts]); return opts?.cancel ? null : {doc: 'nb2', path: opts?.path ?? 'C:/Notes/Physics', name: opts?.name ?? 'Physics', alreadyOpen: false, warnings: mode === 'open' ? ['A page of Week 1 is missing (p1.json).'] : []}; },
    async recent() { return []; }, async pick() { return null; },
  };
  host.close = async (doc, opts) => { calls.push(['close', doc, opts]); };
  return {host, calls};
}

test('without a notebook service New and Open are disabled: "Notebooks on disk need the desktop app"', async () => {
  const t = await notebookSession();
  assert.deepEqual(t.state('notebook.new'), {enabled: false, reason: 'Notebooks on disk need the desktop app'});
  assert.deepEqual(t.state('notebook.open'), {enabled: false, reason: 'Notebooks on disk need the desktop app'});
});

test('notebook.new and notebook.open go through host.notebooks (system dialogs in the desktop app) and report warnings', async () => {
  const {host, calls} = recordingHost();
  const t = await notebookSession(buildNotebook(), {host});
  const made = await t.exec('notebook.new', {name: 'Physics'});
  assert.deepEqual(made.result, {doc: 'nb2', path: 'C:/Notes/Physics', name: 'Physics'});
  await t.exec('notebook.new', {name: 'Chem', location: 'D:/School/'});
  assert.deepEqual(calls[1], ['new', {show: false, name: 'Chem', path: 'D:/School/Chem'}]);
  await assert.rejects(t.exec('notebook.new', {name: 'a:b'}), e => e.code === 'invalid_params');
  const opened = await t.exec('notebook.open', {path: 'C:/Notes/Physics'});
  assert.deepEqual(opened.result.warnings, ['A page of Week 1 is missing (p1.json).']);
  assert.deepEqual(calls[2], ['open', {path: 'C:/Notes/Physics', show: true}]);
  await t.exec('notebook.close');
  assert.deepEqual(calls[3], ['close', t.docId, {discard: false}]);
  const v = newDialog.init();
  assert.equal(v.location, BROWSE);
  assert.deepEqual(newDialog.toCommand({...v, name: ' Bio '}), {command: 'notebook.new', params: {name: 'Bio'}});
  assert.equal(newDialog.validate({...v, location: 'This Computer (Arkemis workspace)'})[0].field, 'folder');
});

test('notebook.properties and notebook.setColor change the display name and colour; the dialog reads them', async () => {
  const t = await notebookSession();
  const ctx = t.session.readContext(t.docId);
  const v = propertiesDialog.init(ctx);
  assert.deepEqual([v.displayName, v.color, v.path], ['Course notes', '#7f6fd1', '(not saved to a folder)']);
  assert.equal(propertiesDialog.validate({...v, displayName: ''})[0].field, 'displayName');
  await expectUndoRoundTrip(t, 'notebook.properties', propertiesDialog.toCommand({...v, displayName: 'Physics', color: '#4A8FDD'}).params);
  assert.deepEqual([t.content.notebook.name, t.content.notebook.color], ['Physics', '#4a8fdd']);
  await expectUndoRoundTrip(t, 'notebook.setColor', {color: '#3fa68c'});
  assert.equal(t.state('notebook.setColor', {color: '#3fa68c'}).checked, true);
  await assert.rejects(t.exec('notebook.properties', {notebookId: 'other', displayName: 'X'}), e => e.code === 'not_found');
});
