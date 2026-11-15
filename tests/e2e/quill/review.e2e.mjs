// Quill's Review tab (U:quill/review) end to end through the bridge, in the new shell. No OS input:
// ribbon controls through ui.activate / ui.menu, typing through ui.type (the page view's own input
// handler), keys through ui.key (KeyRouter), dialogs through ui.dialog.*, right-click menus through
// ui.contextMenu, and the document read back over the bridge.
//
// Behaviour fidelity:
// 1. ArtCraft crates/engine/src/cmd/review.rs and review/*.rs (comments, changes, proofing),
//    tools/compare.rs, protect.rs, the ribbon in crates/ui-egui/src/ribbon/review.rs, the balloons
//    in canvas/balloons.rs and the dialogs in dispatch.rs (Word Count) and dialogs_review.rs
//    (Compare); Word: with Track Changes on, typing is an insertion underlined in the author's
//    colour and deleting strikes the text through; a comment's balloon holds its thread; Simple
//    Markup shows the final text with a red bar; Accept All makes every change plain; Word Count
//    shows the statistics; Compare marks the differences as tracked changes.
// 2. The same commands run from the window (the person's path), each one undo step, and the page
//    view draws them (captures below).
// 3. This file; the engine side is tests/quill/review.test.mjs and tests/quill/upstream/review_tests.test.mjs.
//
// Evidence: artifacts/e2e/quill/review/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {contentFromText} from '../../../core/quill/model/content.mjs';
import {writeDocx} from '../../../core/quill/formats/docx-write.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

function seedDoc(id) {
  const seed = createFile('quill', 'Review');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Project proposal'}]},
    {type: 'paragraph', content: [{type: 'text', text: 'The team will deliver the first release in March and gather feedback from early users.'}]},
    {type: 'paragraph', content: [{type: 'text', text: 'Budget approval is still pending from the finance office.'}]},
    {type: 'paragraph', content: [{type: 'text', text: 'Next steps are listed in the appendix.'}]},
  ]};
  return migrateFile(seed);
}

const textOf = body => JSON.stringify(body);

test('quill Review tab: track changes, comments, display for review, accept all, word count, compare', {timeout: 240_000}, async () => {
  const seed = seedDoc('quill-review');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/review', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = () => app.rpc('document.read', {doc, address: '/body', as: 'json'});
  const settle = () => new Promise(r => setTimeout(r, 450));
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });

    // The Review tab: its groups, with the untranslated controls hidden.
    await app.rpc('ui.tab', {doc, id: 'review'});
    await settle();
    const ui = await app.rpc('ui.inspect', {doc});
    const ids = new Set((ui.controls ?? []).map(c => c.id));
    for (const id of ['review.proofing.thesaurus', 'review.proofing.word-count', 'review.language.language', 'review.comments.new-comment', 'review.comments.delete',
      'review.comments.previous', 'review.comments.next', 'review.comments.show-comments', 'review.tracking.track-changes', 'review.tracking.display-for-review',
      'review.tracking.show-markup', 'review.tracking.reviewing-pane', 'review.changes.accept', 'review.changes.reject', 'review.changes.previous',
      'review.changes.next', 'review.compare.compare', 'review.protect.restrict-editing']) {
      assert.ok(ids.has(id), `${id} is on the Review tab`);
    }
    assert.ok(ids.has('review.proofing.spelling-grammar'), 'Spelling & Grammar is on the tab (U:quill/spelling)');
    assert.ok(!ids.has('review.protect.block-authors'), 'Block Authors has no upstream engine');
    await app.capture('1-review-tab', {doc});

    // Track Changes on; typing records an insertion, deleting a deletion.
    await app.rpc('ui.activate', {doc, control: 'review.tracking.track-changes'});
    assert.equal((await app.rpc('ui.inspect', {doc})).controls.find(c => c.id === 'review.tracking.track-changes')?.checked, true, 'Track Changes is on');
    await run('caret.set', {pos: {block: 1, off: 49}});
    await app.rpc('ui.type', {doc, text: 'and April '});
    await run('select.range', {anchor: {block: 2, off: 0}, focus: {block: 2, off: 16}});
    await app.rpc('ui.key', {doc, keys: 'Delete'});
    let changes = await run('review.changes', {list: true});
    assert.deepEqual(changes.map(c => [c.kind, c.text]), [['insert', 'and April '], ['delete', 'Budget approval ']], JSON.stringify(changes));
    await run('caret.set', {pos: {block: 0, off: 0}});
    await settle();
    await app.capture('2-tracked-insert-delete', {doc});

    // Right-click on the inserted text: Accept / Reject Insertion first.
    let menu = await app.rpc('ui.contextMenu', {doc, target: 'trackedInsertion'});
    assert.deepEqual(menu.items.slice(0, 2).map(i => [i.label, i.command]), [['Accept Insertion', 'review.accept'], ['Reject Insertion', 'review.reject']]);
    await app.rpc('ui.contextMenu', {doc, open: false});

    // A comment on "first release", a reply, shown in its balloon.
    await run('select.range', {anchor: {block: 1, off: 26}, focus: {block: 1, off: 39}});
    await app.rpc('ui.activate', {doc, control: 'review.comments.new-comment'});
    let comments = await run('review.comments');
    assert.equal(comments.length, 1, 'New Comment adds one');
    const id = comments[0].id;
    await run('review.editComment', {id, text: 'Can we commit to a date?'});
    await run('review.reply', {id, text: 'Yes, the 14th.'});
    comments = await run('review.comments');
    assert.deepEqual(comments.map(c => [c.text, c.parent]), [['Can we commit to a date?', null], ['Yes, the 14th.', id]]);
    await settle();
    await app.capture('3-comment-thread', {doc});
    menu = await app.rpc('ui.contextMenu', {doc, target: 'commentBalloon'});
    assert.ok(menu.items.some(i => i.command === 'review.resolveComment') && menu.items.some(i => i.command === 'review.deleteComment'), JSON.stringify(menu.items));
    await app.rpc('ui.contextMenu', {doc, open: false});
    await app.rpc('ui.pane', {doc, id: 'pane.comments', open: false});

    // Display for Review: Simple Markup (the final text, a red bar), then All Markup again.
    await app.rpc('ui.menu', {doc, control: 'review.tracking.display-for-review'});
    await settle();
    await app.capture('4-display-for-review-menu', {doc});
    await app.rpc('ui.menu', {doc, control: 'review.tracking.display-for-review', open: false});
    await app.rpc('ui.activate', {doc, control: 'review.tracking.display-for-review.simple-markup'});
    await settle();
    await app.capture('5-simple-markup', {doc});
    await app.rpc('ui.activate', {doc, control: 'review.tracking.display-for-review.all-markup'});
    await settle();
    await app.capture('6-all-markup', {doc});

    // Next Change selects the first change after the caret.
    await run('caret.set', {pos: {block: 0, off: 0}});
    await app.rpc('ui.activate', {doc, control: 'review.changes.next'});
    const sel = await app.rpc('selection.get', {doc});
    const first = (await run('review.changes', {list: true}))[0];
    assert.ok(JSON.stringify(sel).includes(first.start) && JSON.stringify(sel).includes(first.end), `the insertion is selected: ${JSON.stringify(sel)} vs ${first.start}..${first.end}`);

    // Accept All Changes: the text reads as it was edited, with no marks left.
    await app.rpc('ui.activate', {doc, control: 'review.changes.accept.accept-all-changes'});
    changes = await run('review.changes', {list: true});
    assert.deepEqual(changes, []);
    const body = textOf(await read());
    assert.ok(body.includes('in March and April and gather') && !body.includes('Budget approval'), 'accepted');
    await settle();
    await app.capture('7-accept-all', {doc});
    // One undo step brings every change back.
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.equal((await run('review.changes', {list: true})).length, 2);
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Y'});

    // Word Count: of the selection while there is one ("and April " from Next Change), else the document's.
    await app.rpc('ui.activate', {doc, control: 'review.proofing.word-count'});
    assert.equal((await app.rpc('ui.dialog.get', {doc})).values.words, '2', 'the selected words');
    await app.rpc('ui.dialog.cancel', {doc});
    await run('caret.set', {pos: {block: 0, off: 0}});
    await app.rpc('ui.activate', {doc, control: 'review.proofing.word-count'});
    let dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.wordCount');
    assert.deepEqual(dlg.fields.map(f => f.id), ['pages', 'words', 'characters', 'charactersWithSpaces', 'paragraphs', 'lines', 'includeTextBoxes']);
    assert.equal(dlg.values.pages, '1');
    assert.ok(Number(dlg.values.words) > 30, dlg.values.words);
    assert.equal(dlg.values.paragraphs, '4');
    await settle();
    await app.capture('8-word-count', {doc});
    await app.rpc('ui.dialog.cancel', {doc});

    // Compare with a revised version (its .docx bytes, as Browse… hands them over): tracked changes.
    const revised = contentFromText('Project proposal\nThe team will deliver the first release in May and gather feedback from early users.\nBudget approval came from the finance office.\nNext steps are listed in the appendix.');
    revised.body.chunks[0][0].props = {style: 'Heading1'};
    const data = Buffer.from(await writeDocx(revised)).toString('base64');
    await app.rpc('ui.menu', {doc, control: 'review.compare.compare'});
    await app.rpc('ui.activate', {doc, control: 'review.compare.compare.compare'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.compare');
    await app.rpc('ui.dialog.set', {doc, values: {revisedData: data, revisedFormat: 'docx', revised: 'Proposal (revised).docx', label: 'Reviewer'}});
    await settle();
    await app.capture('9-compare-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    changes = await run('review.changes', {list: true});
    assert.ok(changes.length >= 4, JSON.stringify(changes.map(c => [c.kind, c.text])));
    assert.ok(changes.every(c => c.author === 'Reviewer'));
    assert.ok(changes.some(c => c.kind === 'insert' && c.text.includes('May')) && changes.some(c => c.kind === 'delete' && c.text.includes('March')));
    await run('caret.set', {pos: {block: 0, off: 0}});
    await settle();
    await app.capture('10-compare-result', {doc});
  } catch (e) {
    throw new Error(`${e.stack ?? e.message}${log()}`);
  } finally {
    await app.close();
  }
});
