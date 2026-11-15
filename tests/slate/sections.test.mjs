// U:slate/sections: sections and section groups on schema-2 notebooks.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `section.*` and
//    `sectionGroup.*` (sourceRef core/slate-sections.mjs) name the commands; OneNote's behaviour:
//    New Section (Ctrl+T) "New Section <n>" with one untitled page after the current section (or
//    in the section group shown) and opened, next colour; Rename (no / \ : * ? " < > | # %, unique);
//    Delete to the Notebook Recycle Bin after a confirmation; Move or Copy into a notebook or group
//    or after a section; Merge into Another Section (optionally deleting the original); Section
//    Color; Move Up / Down; section groups: New, Rename, Delete, Move.
// 2. Ours does the same over the notebook model, one undo entry per edit, always a valid notebook.
// 3. Proof: these tests (engine, undo round trips, dialog models) and
//    tests/e2e/slate/pages-sections.e2e.mjs (section tabs, captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {validateFile} from '../../core/model.mjs';
import {binOf} from '../../core/slate/lib/pages-recycle.mjs';
import {filterTree, notebookTree} from '../../core/slate/lib/sections-tree.mjs';
import moveSectionDialog from '../../core/slate/dialogs/move-copy-section.mjs';
import mergeDialog from '../../core/slate/dialogs/merge-section.mjs';
import confirmMerge from '../../core/slate/dialogs/confirm-merge-section.mjs';
import confirmDelete from '../../core/slate/dialogs/confirm-delete.mjs';
import {buildNotebook, model, notebookSession} from './foundation-helpers.mjs';

async function sectionsSession() {
  const t = await notebookSession(buildNotebook({sections: [{name: 'Week 1', pages: ['A', 'B']}, {name: 'Week 2', pages: ['X']}],
    groups: [{name: 'Old', sections: [{name: 'Term 1', pages: ['T']}]}]}));
  t.names = () => model.treeEntries(t.content).map(e => `${'>'.repeat(e.depth)}${e.kind === 'section' ? t.content.sections[e.id].name : `[${t.content.groups[e.id].name}]`}`).join(' ');
  t.sid = name => Object.values(t.content.sections).find(s => s.name === name).id;
  t.gid = name => Object.values(t.content.groups).find(g => g.name === name).id;
  t.open = name => t.session.setSelection(t.docId, model.selectPage(t.content.sections[t.sid(name)].pages[0].id), {origin: 'test'});
  return t;
}

test('section.new adds "New Section <n>" with an untitled page after the current section, opens it, next colour', async () => {
  const t = await sectionsSession();
  t.open('Week 1');
  const r = await expectUndoRoundTrip(t, 'section.new', {});
  assert.equal(t.names(), 'Week 1 New Section 1 Week 2 [Old] >Term 1');
  assert.equal(r.result.name, 'New Section 1');
  assert.equal(t.content.sections[r.result.section].pages.length, 1);
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${r.result.page}`);
  assert.equal(r.result.color, '#bd94d3');
  await t.exec('section.new', {groupId: t.gid('Old'), name: 'Term 2'});
  assert.equal(t.names(), 'Week 1 New Section 1 Week 2 [Old] >Term 1 >Term 2');
  await assert.rejects(t.exec('section.new', {name: 'week 1'}), e => e.code === 'invalid_params');
  await assert.rejects(t.exec('section.new', {name: 'a/b'}), e => e.code === 'invalid_params' && /cannot contain/.test(e.message));
  await assert.rejects(t.exec('section.new', {groupId: 'nope'}), e => e.code === 'not_found');
  await assert.rejects(t.exec('section.new', {notebookId: 'other'}), e => e.code === 'not_found');
  validateFile(t.file);
});

test('section.rename and section.setColor', async () => {
  const t = await sectionsSession();
  t.open('Week 2');
  await expectUndoRoundTrip(t, 'section.rename', {name: 'Lab'});
  assert.equal(t.names(), 'Week 1 Lab [Old] >Term 1');
  await assert.rejects(t.exec('section.rename', {name: 'Term 1'}), e => e.code === 'invalid_params');
  await expectUndoRoundTrip(t, 'section.setColor', {color: '#E48FA0'});
  assert.deepEqual(t.state('section.setColor', {color: '#e48fa0'}), {enabled: true, value: '#e48fa0', checked: true});
  await t.exec('section.setColor', {color: null});
  assert.equal(t.content.sections[t.sid('Lab')].color, null);
});

test('section.moveUp / moveDown move past the neighbouring tab in the same parent', async () => {
  const t = await sectionsSession();
  t.open('Week 2');
  await expectUndoRoundTrip(t, 'section.moveUp', {});
  assert.equal(t.names(), 'Week 2 Week 1 [Old] >Term 1');
  assert.deepEqual(t.state('section.moveUp'), {enabled: false, reason: 'This is the first section'});
  await expectUndoRoundTrip(t, 'section.moveDown', {});
  assert.equal(t.names(), 'Week 1 Week 2 [Old] >Term 1');
  t.open('Term 1');
  assert.deepEqual(t.state('section.moveDown'), {enabled: false, reason: 'This is the last section'});
});

test('section.delete sends the section with its pages to the Recycle Bin and opens the next section; the confirmation names it', async () => {
  const t = await sectionsSession();
  t.open('Week 1');
  const ctx = t.session.readContext(t.docId);
  const v = confirmDelete.init(ctx);
  assert.deepEqual(confirmDelete.preview(ctx, v), {message: 'Are you sure you want to delete this section (Week 1)? It is moved to the Notebook Recycle Bin.'});
  assert.deepEqual(confirmDelete.toCommand(v), {command: 'section.delete', params: {sectionId: t.sid('Week 1')}});
  assert.deepEqual(confirmDelete.toCommand({kind: 'page', id: 'p1'}), {command: 'page.delete', params: {pageIds: ['p1']}});
  await expectUndoRoundTrip(t, 'section.delete', {});
  assert.equal(t.names(), 'Week 2 [Old] >Term 1');
  const bin = binOf(t.content)[0];
  assert.equal(bin.kind, 'section');
  assert.equal(bin.section.name, 'Week 1');
  assert.equal(Object.keys(bin.pages).length, 2);
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.content.sections[t.sid('Week 2')].pages[0].id}`);
  validateFile(t.file);
});

test('section.moveOrCopy: into a group (end), after a section; a copy gets fresh pages and "(2)"; the dialog maps the pick', async () => {
  const t = await sectionsSession();
  t.open('Week 1');
  await expectUndoRoundTrip(t, 'section.moveOrCopy', {target: t.gid('Old'), mode: 'move'});
  assert.equal(t.names(), 'Week 2 [Old] >Term 1 >Week 1');
  await t.exec('section.moveOrCopy', {target: t.sid('Week 2'), mode: 'move', position: 'after'});
  assert.equal(t.names(), 'Week 2 Week 1 [Old] >Term 1');
  const r = await expectUndoRoundTrip(t, 'section.moveOrCopy', {target: t.content.notebook.id, mode: 'copy'});
  assert.equal(t.names(), 'Week 2 Week 1 [Old] >Term 1 Week 1 (2)');
  const copy = t.content.sections[r.result.section];
  assert.equal(copy.pages.length, 2);
  assert.ok(copy.pages.every(e => !t.content.sections[t.sid('Week 1')].pages.some(o => o.id === e.id)));
  validateFile(t.file);
  const ctx = t.session.readContext(t.docId);
  const v = moveSectionDialog.init(ctx);
  assert.deepEqual(moveSectionDialog.toCommand({...v, target: t.gid('Old')}).params.position, 'into');
  assert.deepEqual(moveSectionDialog.toCommand({...v, target: t.sid('Week 2')}).params.position, 'after');
  assert.equal(moveSectionDialog.validate({...v, target: v.sectionId})[0].field, 'target');
  assert.deepEqual(filterTree(notebookTree(t.content), 'term').map(x => x.label), ['Course notes', 'Old', 'Term 1']);
});

test('section.merge copies every page to the end of the target; deleteSource sends the original to the Recycle Bin', async () => {
  const t = await sectionsSession();
  t.open('Week 1');
  await expectUndoRoundTrip(t, 'section.merge', {targetSectionId: t.sid('Week 2')});
  const titles = sid => t.content.sections[sid].pages.map(e => t.content.pages[e.id].title).join(' ');
  assert.equal(titles(t.sid('Week 2')), 'X A B');
  assert.equal(titles(t.sid('Week 1')), 'A B');
  await t.undo();
  await t.exec('section.merge', {targetSectionId: t.sid('Week 2'), deleteSource: true});
  assert.equal(t.names(), 'Week 2 [Old] >Term 1');
  assert.equal(binOf(t.content)[0].section.name, 'Week 1');
  await assert.rejects(t.exec('section.merge', {targetSectionId: t.sid('Week 2')}), e => e.code === 'invalid_params');
  const ctx = t.session.readContext(t.docId);
  const v = mergeDialog.init(ctx);
  assert.equal(mergeDialog.validate({...v, target: t.gid('Old')})[0].message, 'Choose a section to merge into.');
  assert.deepEqual(mergeDialog.toCommand({...v, target: t.sid('Term 1')}).params.targetSectionId, t.sid('Term 1'));
  const c = confirmMerge.init(ctx);
  assert.deepEqual(confirmMerge.toCommand({...c, targetSectionId: t.sid('Term 1'), deleteSource: true}).params.deleteSource, true);
  validateFile(t.file);
});

test('section groups: sectionGroup.new, rename, move (not into itself), delete to the Recycle Bin', async () => {
  const t = await sectionsSession();
  const r = await expectUndoRoundTrip(t, 'sectionGroup.new', {});
  assert.equal(t.names(), 'Week 1 Week 2 [Old] >Term 1 [New Section Group 1]');
  const gid = r.result.group;
  await expectUndoRoundTrip(t, 'sectionGroup.rename', {groupId: gid, name: 'Archive'});
  await expectUndoRoundTrip(t, 'sectionGroup.move', {groupId: t.gid('Old'), target: gid});
  assert.equal(t.names(), 'Week 1 Week 2 [Archive] >[Old] >>Term 1');
  await assert.rejects(t.exec('sectionGroup.move', {groupId: gid, target: t.gid('Old')}), e => e.code === 'invalid_params');
  await t.exec('sectionGroup.new', {parentGroupId: gid, name: 'Inner'});
  t.open('Term 1');
  await expectUndoRoundTrip(t, 'sectionGroup.delete', {groupId: gid});
  assert.equal(t.names(), 'Week 1 Week 2');
  const bin = binOf(t.content)[0];
  assert.deepEqual([bin.kind, bin.group.name, Object.keys(bin.groups).length, Object.keys(bin.sections).length], ['group', 'Archive', 3, 1]);
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.content.sections[t.sid('Week 2')].pages[0].id}`);
  validateFile(t.file);
});
