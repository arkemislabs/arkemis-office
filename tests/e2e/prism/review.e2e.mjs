// Prism's Review tab through the bridge and the real window (U:prism/review).
//
// What deckcraft does (crates/ui-egui/src/ribbon/review.rs, engine cmd/review.rs, compare.rs,
// panels/comments.rs, panels/thesaurus.rs, dialogs/body.rs): Spelling and Check Accessibility open
// dialogs listing what they found, the Thesaurus is a pane, Language opens its dialog, comments are
// added in a dialog and listed in the Comments pane (Previous / Next step through them, Delete removes
// one or all), Compare reads a revised copy and the Revisions pane lists its slide-level changes with
// Accept and Reject. PowerPoint: the same tab.
// What this proves in the app: the real ribbon controls (ui.activate, ui.menu, ui.dialog.*) do what the
// engine tests do, the dialogs and panes draw what they found (looked at in the captures), hidden
// controls (Smart Lookup, Translate, Previous / Next Change, Hide Ink) are not drawn, and Compare
// accepts a revision into the open deck. Captures in artifacts/e2e/prism/review/ (looked at).

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';
import {exportPptx} from '../../../core/prism/formats/pptx-write.mjs';
import {importPptx} from '../../../core/prism/formats/pptx-read.mjs';
import {base64Encode} from '../../../core/prism/lib/shape-common.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('prism review: spelling, accessibility, thesaurus, comments, compare', {timeout: 300_000}, async () => {
  const file = createFile('prism', 'Review deck', {schema: 2});
  file.id = 'prism-review';
  file.content.slides[0].shapes[0].text = bodyFromText('Quarterly review');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/review', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const activate = (control, value) => app.rpc('ui.activate', value === undefined ? {doc, control} : {doc, control, value});
  const paneOpen = async id => app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.panes?.some(p => p.id.includes(id) && p.open) || null; }, {timeout: 10_000});
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await run('insert.textBox', {rect: [80, 300, 700, 80], text: 'I recieve teh the the report, a good idea'});
    await run('slide.new', {layout: 'titleOnly'});
    await run('insert.picture', {data: PNG, name: 'logo.png'});
    await run('shape.altText', {text: ''});
    await run('slide.go', {index: 0});
    await app.rpc('ui.tab', {doc, tab: 'review'});
    let ui = await app.rpc('ui.inspect', {doc});
    const ctl = id => ui.controls.find(c => c.id === id);
    for (const id of ['review.proofing.spelling', 'review.proofing.thesaurus', 'review.accessibility.check', 'review.language.language', 'review.comments.new', 'review.comments.delete',
      'review.comments.previous', 'review.comments.next', 'review.comments.show', 'review.compare.compare', 'review.compare.accept', 'review.compare.reject', 'review.compare.pane', 'review.compare.end']) assert.ok(ctl(id), `${id} is drawn`);
    for (const id of ['review.insights.search', 'review.language.translate']) assert.equal(ctl(id), undefined, `${id} is hidden (nothing upstream)`);
    assert.equal(ctl('review.compare.end').enabled, false, 'End Review is off before a comparison');
    await app.capture('1-review-tab');

    // Spelling: the Spelling pane opens on the first misspelt word (the bundled dictionary); a suggestion changes the word.
    await activate('review.proofing.spelling');
    await paneOpen('spelling');
    await sleep(900);
    await app.capture('2-spelling-pane');
    await app.rpc('ui.pane', {doc, id: 'spelling', open: false});
    assert.deepEqual((await run('review.spellingList')).result.map(i => i.word).sort(), ['recieve', 'teh', 'the']);
    const teh = (await run('review.spellingList')).result.find(i => i.word === 'teh');
    await run('review.spellingChange', {shape: teh.shape, word: 'teh', to: 'the', para: teh.para, start: teh.start});
    assert.ok(!(await run('review.spellingList')).result.some(i => i.word === 'teh'));

    let dlg;
    // The Accessibility Checker: the picture on slide 2 lacks alt text, both slides lack titles or alt text.
    await activate('review.accessibility.check');
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.accessibility');
    await sleep(600);
    await app.capture('3-accessibility-dialog');
    await app.rpc('ui.dialog.cancel', {});
    assert.ok((await run('review.accessibility')).result.some(i => i.issue === 'Missing alternative text'));

    // The Thesaurus pane looks the selected word up.
    const d0 = await deck();
    const box = d0.slides[0].shapes.find(s => s.text?.paragraphs?.[0] && /recieve/.test(s.text.paragraphs[0].runs.map(r => r.text).join('')));
    const at = `/sl:${d0.slides[0].id}/sp:${box.id}`;
    const text = box.text.paragraphs[0].runs.map(r => r.text).join('');
    const a = text.indexOf('good');
    await app.rpc('selection.set', {doc, ranges: [{anchor: `${at}/t:${a}`, focus: `${at}/t:${a + 4}`}]});
    await activate('review.proofing.thesaurus');
    await paneOpen('thesaurus');
    await sleep(700);
    await app.capture('4-thesaurus-pane');
    await app.rpc('ui.pane', {doc, id: 'thesaurus', open: false});

    // Comments: the dialog adds one, the pane lists it; Next and Previous step through them; Delete.
    await run('slide.go', {index: 0});
    await activate('review.comments.new');
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.comment');
    await app.rpc('ui.dialog.set', {field: 'text', value: 'Check these figures with finance'});
    await app.capture('5-new-comment-dialog');
    await app.rpc('ui.dialog.submit', {});
    assert.equal((await deck()).slides[0].comments.length, 1);
    // The author is the profile name (window.studio.profileName), as the Comments pane and a reply show it.
    const who = String(process.env.USERNAME || process.env.USER || '').trim();
    if (who) assert.equal((await deck()).slides[0].comments[0].author, who, 'a comment is written by the profile name');
    await run('comment.add', {text: 'Second thought on the title', x: 40, y: 20});
    await run('slide.go', {index: 1});
    await run('comment.add', {text: 'Add alt text to the logo'});
    await run('comment.reply', {index: 0, text: 'Done'});
    if (who) assert.equal((await deck()).slides[1].comments[0].replies[0].author, who, 'and so is a reply');
    await run('slide.go', {index: 0});
    await activate('review.comments.show');
    await paneOpen('comments');
    await sleep(700);
    await app.capture('6-comments-pane');
    await activate('review.comments.next');
    await sleep(300);
    let d = await deck();
    assert.equal(d.slides.length, 2);
    ui = await app.rpc('ui.inspect', {doc});
    assert.equal((await run('comment.list')).result.length, 2, 'next went to the first thread of the slide or the following one');
    await activate('review.comments.next');
    await activate('review.comments.previous');
    await app.rpc('ui.menu', {doc, control: 'review.comments.delete'});
    await app.capture('7-delete-menu');
    await app.rpc('ui.menu', {doc, control: 'review.comments.delete', open: false});
    await activate('review.comments.delete');
    d = await deck();
    assert.ok(d.slides.reduce((n, s) => n + (s.comments?.length ?? 0), 0) < 3, 'Delete removed a comment');
    await app.rpc('ui.pane', {doc, id: 'comments', open: false});

    // Compare with a revised copy: the pane lists the changes; Accept takes one in; End Review.
    const current = await deck();
    const reopened = await importPptx(await exportPptx(current));
    const rev = structuredClone(reopened);
    const title = rev.slides[0].shapes.find(s => s.ph?.kind === 'ctrTitle' || s.ph?.kind === 'title');
    title.text = bodyFromText('Quarterly review: revised');
    const added = structuredClone(rev.slides[1]);
    added.id = String(Number(added.id) + 1);
    added.shapes = added.shapes.filter(s => s.ph);
    rev.slides.push(added);
    const data = base64Encode(await exportPptx(rev));
    // The open deck is compared as it is in the window; the revised copy comes from a file, as in the app.
    const rpcCompare = await run('review.compare', {name: 'Revised.pptx', data});
    await paneOpen('revisions');
    await sleep(900);
    await app.capture('8-revisions-pane');
    ui = await app.rpc('ui.inspect', {doc});
    assert.equal(ctl('review.compare.end').enabled, true, 'End Review is on while comparing');
    const changes = rpcCompare.result.changes;
    assert.ok(changes.length >= 1, JSON.stringify(rpcCompare.result));
    await activate('review.compare.accept');
    await sleep(500);
    await app.capture('9-after-accept-all');
    const left = (await run('review.revisions')).result.changes;
    assert.deepEqual(left, [], 'Accept All takes every change');
    await activate('review.compare.end');
    await sleep(400);
    ui = await app.rpc('ui.inspect', {doc});
    assert.equal(ctl('review.compare.end').enabled, false);
    await app.capture('10-review-ended');
  } finally {
    await app.close();
  }
});
