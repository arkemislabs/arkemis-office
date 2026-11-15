import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip, expectApprovalRequired, deepEqual} from '../../core/kernel/testing.mjs';
import {createSession} from '../../core/kernel/session.mjs';
import {buildRegistry} from '../../core/kernel/registry.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import {listFamily, listContent, appInfo} from './helpers.mjs';
import edit from '../../core/common/commands/edit.mjs';

const make = (opts = {}) => createTestSession('quill', {modules: [edit, listFamily], foundation: {spec: appInfo}, content: listContent(), ...opts});

test('undo round trip: run, undo restores content and selection, redo reproduces', async () => {
  const t = await make();
  await t.exec('list.select', {index: 1});
  await expectUndoRoundTrip(t, 'list.push', {value: 'e'}, after => {
    assert.deepEqual(after.content.items, ['a', 'b', 'c', 'd', 'e']);
  });
  await expectUndoRoundTrip(t, 'list.remove', {index: 0});
  await expectUndoRoundTrip(t, 'list.set', {index: 2, value: 'X'});
  await expectUndoRoundTrip(t, 'list.title', {title: 'New'});
});

test('a command that throws rolls everything back', async () => {
  const t = await make();
  const before = structuredClone(t.file);
  await assert.rejects(t.exec('list.pushThenFail'), e => e.code === 'failed' && /boom/.test(e.message));
  assert.ok(deepEqual(t.file, before));
  assert.equal(t.version, 0);
  assert.equal(t.doc.undo.size, 0);
});

test('composite commands are one undo entry', async () => {
  const t = await make();
  const r = await t.exec('list.pushTwice', {value: 'z'});
  assert.equal(r.undoLabel, 'Push Twice');
  assert.deepEqual(t.content.items.slice(-2), ['z', 'z']);
  assert.equal(t.doc.undo.size, 1);
  await t.undo();
  assert.deepEqual(t.content.items, ['a', 'b', 'c', 'd']);
});

test('errors: not_found, invalid_params with the JSON-Schema path, disabled with the reason', async () => {
  const t = await make({content: {items: [], meta: {}}});
  await assert.rejects(t.exec('list.nope'), e => e.code === 'not_found');
  await assert.rejects(t.exec('list.push', {value: 3}), e => e.code === 'invalid_params' && e.data.path === '/value');
  await assert.rejects(t.exec('list.push', {}), e => e.code === 'invalid_params' && e.data.path === '/value');
  await assert.rejects(t.exec('list.remove', {index: 0}), e => e.code === 'disabled' && e.message === 'the list is empty');
  assert.deepEqual(t.state('list.remove', {index: 0}), {enabled: false, reason: 'the list is empty'});
  assert.equal(t.state('list.push').enabled, true);
});

test('baseVersion mismatches are conflicts carrying the current version', async () => {
  const t = await make();
  await t.exec('list.push', {value: 'e'});
  await assert.rejects(t.exec('list.push', {value: 'f'}, {baseVersion: 0}), e => e.code === 'conflict' && e.data.version === 1 && e.status === 409);
  const r = await t.exec('list.push', {value: 'f'}, {baseVersion: 1});
  assert.equal(r.version, 2);
});

test('dryRun reports the would-be change and commits nothing', async () => {
  const t = await make();
  const r = await t.exec('list.push', {value: 'e'}, {dryRun: true});
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.changed, ['/items']);
  assert.equal(t.version, 0);
  assert.equal(t.content.items.length, 4);
});

test('a command declaring undo:none may not change the document', async () => {
  const t = await make();
  await assert.rejects(t.exec('list.lieAboutUndo'), /undo:'none' but changed/);
  assert.equal(t.content.meta.title, 'List');
});

test('batch: one undo entry, all or nothing', async () => {
  const t = await make();
  const r = await t.batch([{command: 'list.push', params: {value: 'e'}}, {command: 'list.set', params: {index: 0, value: 'A'}}], {label: 'Tidy'});
  assert.equal(r.undoLabel, 'Tidy');
  assert.equal(t.doc.undo.size, 1);
  assert.deepEqual(t.content.items, ['A', 'b', 'c', 'd', 'e']);
  await assert.rejects(t.batch([{command: 'list.push', params: {value: 'x'}}, {command: 'list.remove', params: {index: 99}}]),
    e => e.code === 'invalid_params');
  assert.deepEqual(t.content.items, ['A', 'b', 'c', 'd', 'e'], 'failed batch left nothing behind');
  await assert.rejects(t.batch([{command: 'list.push', params: {value: 1}}]), e => e.data.path === '/steps/0/params/value');
  await t.undo();
  assert.deepEqual(t.content.items, ['a', 'b', 'c', 'd']);
});

test('bridge edits are labelled for the Undo list and events carry changed addresses', async () => {
  const t = await make();
  const events = [];
  t.session.subscribe(e => events.push(e));
  const r = await t.bridge('list.push', {value: 'e'});
  assert.equal(r.undoLabel, 'Automation: Push');
  assert.equal(events[0].type, 'doc.changed');
  assert.deepEqual(events[0].changed, ['/items']);
  assert.equal(events[0].version, 1);
  assert.equal(t.session.journal.at(-1).command, 'list.push');
});

test('approval nonces are bound to the doc, command, params and version, and single use', async () => {
  const t = await make();
  const data = await expectApprovalRequired(t, 'list.publish', {to: 'team'});
  assert.equal(data.risk, 'irreversible');
  assert.equal(data.summary, 'Publish the list to team');
  assert.match(data.nonce, /^[0-9a-f]{32}$/);
  await assert.rejects(t.bridge('list.publish', {to: 'everyone'}, {approval: {nonce: data.nonce}}), e => e.code === 'approval_invalid');
  const again = await expectApprovalRequired(t, 'list.publish', {to: 'team'});
  const r = await t.bridge('list.publish', {to: 'team'}, {approval: {nonce: again.nonce}});
  assert.deepEqual(r.result, {published: 'team'});
  await assert.rejects(t.bridge('list.publish', {to: 'team'}, {approval: {nonce: again.nonce}}), e => e.code === 'approval_invalid', 'replay refused');
  // UI and test origins never ask.
  await t.exec('list.clear');
  assert.equal(t.content.items.length, 0);
});

test('approvals expire and a version change invalidates them', async () => {
  const t = await make();
  const a = await expectApprovalRequired(t, 'list.clear');
  assert.equal(a.summary, 'Remove all 4 items');
  t.host.advance(5 * 60 * 1000 + 1);
  await assert.rejects(t.bridge('list.clear', {}, {approval: {nonce: a.nonce}}), e => e.code === 'approval_invalid');
  const b = await expectApprovalRequired(t, 'list.clear');
  await t.exec('list.push', {value: 'e'});
  await assert.rejects(t.bridge('list.clear', {}, {approval: {nonce: b.nonce}}), e => e.code === 'approval_invalid');
});

test('commands queue: concurrent executes never interleave', async () => {
  const t = await make();
  await Promise.all([t.exec('list.slow', {value: 'x', ms: 15}), t.exec('list.push', {value: 'y'})]);
  assert.deepEqual(t.content.items.slice(-2), ['x', 'y']);
  assert.equal(t.version, 2);
});

test('selection maps through edits and is restored by undo', async () => {
  const t = await make();
  await t.exec('list.select', {index: 3});
  await t.exec('list.remove', {index: 0});
  assert.equal(t.doc.selection.ranges[0].anchor, '/items/2');
  await t.undo();
  assert.equal(t.doc.selection.ranges[0].anchor, '/items/3');
});

test('state() is memoized per tick', async () => {
  let calls = 0;
  const t = await make();
  const reg = t.registry.get('list.remove');
  const orig = reg.state;
  const session = createSession({app: 'quill', registry: {get: id => (id === 'list.remove' ? {...reg, state: ctx => { calls++; return orig(ctx); }} : t.registry.get(id)), has: () => true}, host: createTestHost()});
  session.open({id: 'd', schema: 2, kind: 'quill', title: 'x', revision: 0, content: listContent()});
  session.state('d', 'list.remove', {index: 0});
  session.state('d', 'list.remove', {index: 0});
  assert.equal(calls, 1);
  session.setSelection('d', {ranges: [], primary: 0});
  session.state('d', 'list.remove', {index: 0});
  assert.equal(calls, 2);
});

test('sessions open, activate and close documents', async () => {
  const registry = buildRegistry([listFamily], {app: 'grid'});
  const session = createSession({app: 'grid', registry, host: createTestHost()});
  const events = [];
  session.subscribe(e => events.push(e.type));
  session.open({id: 'a', schema: 2, kind: 'grid', title: 'A', revision: 3, content: listContent()});
  session.open({id: 'b', schema: 2, kind: 'grid', title: 'B', revision: 0, content: listContent()}, {activate: false});
  assert.equal(session.activeDocId, 'a');
  assert.equal(session.get('a').storeRevision, 3);
  await session.execute(null, 'list.push', {value: 'e'}, {origin: 'ui'});
  assert.equal(session.get('a').file.content.items.length, 5);
  assert.throws(() => session.open({id: 'a', content: {}}), e => e.code === 'conflict');
  session.close('a');
  assert.equal(session.activeDocId, 'b');
  await assert.rejects(session.execute('a', 'list.push', {value: 'x'}, {origin: 'ui'}), e => e.code === 'not_found');
  assert.deepEqual(events, ['document.opened', 'document.opened', 'doc.changed', 'document.closed']);
});
