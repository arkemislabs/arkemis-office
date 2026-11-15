// U:slate/tags: the Tags gallery, To Do tags, Tags Summary and Customize Tags.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `tag.*`, `tags.*` and the
//    Arkemis `note.tags` extension (sourceRef core/slate-tags.mjs) name the commands; OneNote's
//    behaviour: a gallery tag (Ctrl+1..9) tags the paragraphs or removes it when all have it; a
//    check box tag cycles unchecked → checked → removed and its box is clicked to check it; Ctrl+0
//    removes all tags; Customize Tags reorders, adds, modifies and removes tags in the person's
//    list while tagged notes keep their look; Find Tags opens the Tags Summary grouped by tag
//    name / section / title / date / note text with a search scope and "unchecked items only";
//    Create Summary Page writes them to a new page.
// 2. Ours does the same: tags live on the paragraphs (one undo entry per change), the tag list in
//    prefs, the summary is collected from the notebook.
// 3. Proof: these tests (engine, undo round trips, dialog models) and
//    tests/e2e/slate/format-home.e2e.mjs (Tags group presses, captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {DEFAULT_TAGS} from '../../core/slate/lib/tags-catalog.mjs';
import {collectTags, groupTags} from '../../core/slate/commands/tags.mjs';
import customizeDialog from '../../core/slate/dialogs/customize-tags.mjs';
import editorDialog from '../../core/slate/dialogs/tag-editor.mjs';
import {textSession, textSel} from './format-helpers.mjs';

const tags = t => t.blocks.map(b => b.attrs.tags.map(x => x.id + (x.checkbox ? (x.checked ? '[x]' : '[ ]') : '')).join(','));

test('the default gallery is OneNote\'s 29 tags in order; the first nine are Ctrl+1..9', () => {
  assert.equal(DEFAULT_TAGS.length, 29);
  assert.deepEqual(DEFAULT_TAGS.slice(0, 9).map(t => t.id), ['to-do', 'important', 'question', 'remember-for-later', 'definition', 'highlight', 'contact', 'address', 'phone-number']);
  assert.equal(DEFAULT_TAGS.find(t => t.id === 'remember-for-later').highlightColor, '#ffff00');
});

test('tag.toggle: To Do (Ctrl+1) cycles unchecked, checked, removed; tag.check clicks the box', async () => {
  const t = await textSession(['Buy milk', 'Call Bob'], {selection: p => textSel(p, 'b1', 2)});
  await expectUndoRoundTrip(t, 'tag.toggle', {tagId: 'to-do'});
  assert.deepEqual(tags(t), ['to-do[ ]', '']);
  assert.equal(t.state('tag.toggle', {tagId: 'to-do'}).checked, true);
  await expectUndoRoundTrip(t, 'tag.toggle', {tagId: 'to-do'});
  assert.deepEqual(tags(t), ['to-do[x]', '']);
  await t.exec('tag.toggle', {tagId: 'to-do'});
  assert.deepEqual(tags(t), ['', '']);
  await t.exec('tag.toggle', {tagId: 'to-do'});
  await expectUndoRoundTrip(t, 'tag.check', {paragraphId: 'b1', checked: true});
  assert.deepEqual(tags(t), ['to-do[x]', '']);
  await assert.rejects(t.exec('tag.check', {paragraphId: 'b2', checked: true}), e => e.code === 'not_found');
});

test('tag.toggle on several paragraphs adds where missing, removes when all have it; tags stack', async () => {
  const t = await textSession(['One', 'Two'], {selection: p => textSel(p, 'b1', 0, 1, 'b2')});
  await t.exec('tag.toggle', {tagId: 'important'});
  await t.exec('tag.toggle', {tagId: 'question'});
  assert.deepEqual(tags(t), ['important,question', 'important,question']);
  t.select(textSel(t.pageId, 'b2', 0));
  await t.exec('tag.toggle', {tagId: 'important'});
  t.select(textSel(t.pageId, 'b1', 0, 1, 'b2'));
  await t.exec('tag.toggle', {tagId: 'important'});
  assert.deepEqual(tags(t), ['important,question', 'question,important']);
  await t.exec('tag.toggle', {tagId: 'important'});
  assert.deepEqual(tags(t), ['question', 'question']);
  await expectUndoRoundTrip(t, 'tag.removeAll', {});
  assert.deepEqual(tags(t), ['', '']);
  assert.deepEqual(t.state('tag.removeAll'), {enabled: false, reason: 'The selection has no tags'});
  await assert.rejects(t.exec('tag.toggle', {tagId: 'nope'}), e => e.code === 'disabled' && /no tag nope/.test(e.message));
});

test('Customize Tags: tag.create puts a tag at the top, tag.modify / tag.reorder / tag.delete edit the list; tagged notes keep their look', async () => {
  const t = await textSession(['Idea'], {selection: p => textSel(p, 'b1', 0)});
  const made = await t.exec('tag.create', {displayName: 'Follow up', symbol: 'flag-green', highlightColor: '#ccffcc'});
  const id = made.result.tag.id;
  assert.deepEqual(t.session.prefs['slate.tags'].slice(0, 2).map(x => x.name), ['Follow up', 'To Do']);
  await assert.rejects(t.exec('tag.create', {displayName: 'to do'}), e => e.code === 'invalid_params');
  await t.exec('tag.toggle', {tagId: id});
  await t.exec('tag.modify', {tagId: id, displayName: 'Later', symbol: 'star'});
  assert.equal(t.blocks[0].attrs.tags[0].name, 'Follow up');
  assert.equal(t.session.prefs['slate.tags'][0].name, 'Later');
  await t.exec('tag.reorder', {tagId: id, direction: 'down'});
  assert.deepEqual(t.session.prefs['slate.tags'].slice(0, 2).map(x => x.name), ['To Do', 'Later']);
  assert.deepEqual((await t.exec('tag.reorder', {tagId: 'to-do', direction: 'up'})).result, {index: 0, moved: false});
  await t.exec('tag.delete', {tagId: id});
  assert.equal(t.session.prefs['slate.tags'].length, 29);
  assert.equal(t.blocks[0].attrs.tags[0].name, 'Follow up');
  const list = (await t.exec('tag.customize')).result.tags;
  assert.deepEqual([list[0].shortcut, list[8].shortcut, list[9].shortcut], ['Ctrl+1', 'Ctrl+9', null]);
  // The dialogs.
  const ctx = t.session.readContext(t.docId);
  const v = customizeDialog.init(ctx);
  assert.equal(v.tags, 'to-do');
  assert.deepEqual(customizeDialog.buttons.moveDown(ctx, v), {command: 'tag.reorder', params: {tagId: 'to-do', direction: 'down'}});
  assert.deepEqual(customizeDialog.buttons.removeTag(ctx, v), {command: 'tag.delete', params: {tagId: 'to-do'}});
  const e = editorDialog.init(ctx);
  assert.equal(editorDialog.validate(e)[0].field, 'displayName');
  assert.deepEqual(editorDialog.toCommand({...e, displayName: ' Reading '}), {command: 'tag.create', params: {displayName: 'Reading', symbol: 'none', fontColor: null, highlightColor: null}});
  assert.deepEqual(editorDialog.toCommand({...e, mode: 'modify', tagId: 'idea', displayName: 'Ideas', symbol: 'lightbulb'}).command, 'tag.modify');
});

test('tags.find collects tagged notes by scope and groups them; uncheckedOnly keeps open To Dos; tags.refresh repeats it', async () => {
  const t = await textSession(['Buy milk', 'Call Bob', 'Big idea'], {selection: p => textSel(p, 'b1', 0, 1, 'b2')});
  await t.exec('tag.toggle', {tagId: 'to-do'});
  await t.exec('tag.check', {paragraphId: 'b2', checked: true});
  t.select(textSel(t.pageId, 'b3', 0));
  await t.exec('tag.toggle', {tagId: 'idea'});
  const all = (await t.exec('tags.find', {})).result;
  assert.equal(all.count, 3);
  assert.deepEqual(all.groups.map(g => [g.name, g.items.length]), [['To Do', 2], ['Idea', 1]]);
  const open = (await t.exec('tags.find', {uncheckedOnly: true, groupBy: 'title'})).result;
  assert.deepEqual(open.groups.map(g => [g.name, g.items.map(i => i.text)]), [['Lecture 1', ['Buy milk']]]);
  assert.deepEqual(t.doc.view?.tagsSummary ?? null, {groupBy: 'title', scope: 'notebook', uncheckedOnly: true});
  assert.equal((await t.exec('tags.refresh')).result.count, 1);
  const ctx = t.session.readContext(t.docId);
  const items = collectTags(ctx, {scope: 'section'});
  assert.deepEqual(groupTags(items, 'note-text').map(g => g.name), ['B', 'C']);
  assert.deepEqual(groupTags(items, 'date', t.host.now()).map(g => g.name), ['Today']);
  assert.equal(collectTags(ctx, {scope: 'last-week'}).length, 0);
});

test('tags.createSummaryPage adds "Tags Summary" at the end of the section with the notes under their group headings', async () => {
  const t = await textSession(['Buy milk'], {selection: p => textSel(p, 'b1', 0)});
  await t.exec('tag.toggle', {tagId: 'to-do'});
  const r = await expectUndoRoundTrip(t, 'tags.createSummaryPage', {groupBy: 'tag-name'});
  const page = t.content.pages[r.result.page];
  assert.equal(page.title, 'Tags Summary');
  assert.equal(t.content.sections[t.sectionId].pages.at(-1).id, r.result.page);
  const blocks = page.body.content[0].content;
  assert.deepEqual(blocks.map(b => [b.attrs.style, b.content[0].text, b.attrs.tags.map(x => x.id).join()]), [['h2', 'To Do', ''], ['normal', 'Buy milk', 'to-do']]);
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${r.result.page}`);
});

test('note.tags adds and removes page-level #tags', async () => {
  const t = await textSession(['x'], {selection: p => textSel(p, 'b1', 0)});
  await expectUndoRoundTrip(t, 'note.tags', {add: '#Physics'});
  assert.deepEqual(t.content.pages[t.pageId].noteTags, ['physics']);
  await t.exec('note.tags', {add: 'exam'});
  await t.exec('note.tags', {remove: 'physics'});
  assert.deepEqual(t.state('note.tags').value, ['exam']);
});
