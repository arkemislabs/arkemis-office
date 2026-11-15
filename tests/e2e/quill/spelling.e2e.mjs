// Spelling in Word (U:quill/spelling) end to end through the bridge, in the new shell. No OS input: ribbon controls through ui.activate, right-click menus
// through ui.contextMenu (the surface looks up the suggestions before the menu opens), the Editor pane through its ribbon control, commands through
// engine.execute, and the page's pixels read back through document.render (the page view's own display list: squiggles included).
//
// Behaviour fidelity:
// 1. ArtCraft wordcraft crates/engine/src/cmd/review.rs and review/proofing.rs (F7 selects the next issue with suggestions; Ignore All, Add to Dictionary,
//    Change), crates/layout/src/para/proof.rs (squiggles under misspelt words; hidden text, links and "do not check" runs left out). Word: red wavy underlines
//    under misspelt words, the right-click menu on one with suggestions first, then Ignore All and Add to Dictionary, and the Editor pane (Review >
//    Spelling & Grammar, F7).
// 2. The words are looked up by the bundled en_US dictionary in a worker (core/common/lib/spelling.mjs); the page draws again when the answers arrive.
// 3. This file; the engine side is tests/spelling/quill-spelling.test.mjs.
//
// Evidence: artifacts/e2e/quill/spelling/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';
import {decodePng} from '../prism/png.mjs';

function seedDoc(id) {
  const seed = createFile('quill', 'Spelling');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Project proposal'}]},
    {type: 'paragraph', content: [{type: 'text', text: 'The team will recieve the first release in March.'}]},
    {type: 'paragraph', content: [{type: 'text', text: 'A seperate budget teh lines are still pending.'}]},
    {type: 'paragraph', content: [{type: 'text', text: 'Next steps are listed in the appendix.'}]},
  ]};
  return migrateFile(seed);
}

/** Pixels of a page render that are the squiggle's red (and not anything else a page draws). */
async function redPixels(app, doc) {
  const {png} = await app.rpc('document.render', {doc, target: {page: 1}, scale: 2});
  const img = decodePng(png);
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) { const [r, g, b] = img.px(x, y); if (r > 190 && g < 110 && b < 110) n++; }
  return n;
}

test('quill spelling: squiggles, the right-click menu, F7 and the Editor pane', {timeout: 300_000}, async () => {
  const seed = seedDoc('quill-spelling');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/spelling', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const body = async () => JSON.stringify((await app.rpc('document.read', {doc, address: '/body', as: 'json'})).value);
  const settle = () => new Promise(r => setTimeout(r, 500));
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });

    // The controls are drawn: Review > Spelling & Grammar and Home > Editor.
    await app.rpc('ui.tab', {doc, id: 'review'});
    await settle();
    let ui = await app.rpc('ui.inspect', {doc});
    const spell = ui.controls.find(c => c.id === 'review.proofing.spelling-grammar');
    assert.ok(spell && spell.enabled && !spell.pending, 'Spelling & Grammar is on the Review tab and works');
    await app.rpc('ui.tab', {doc, id: 'home'});
    await settle();
    ui = await app.rpc('ui.inspect', {doc});
    assert.ok(ui.controls.some(c => c.id === 'home.editor.editor' && c.enabled), 'Home > Editor is drawn');

    // Squiggles: the dictionary loads in its worker, the words are looked up, the page draws red waves under recieve, seperate and teh.
    const red = await app.until(async () => { const n = await redPixels(app, doc); return n > 30 ? n : null; }, {timeout: 40_000, interval: 600}).catch(e => { throw new Error(`no squiggles drawn: ${e.message}${log()}`); });
    await app.capture('1-squiggles', {doc});
    // Turning Check Spelling as You Type off removes them; on again brings them back.
    await run('review.proofing', {value: false});
    await settle();
    const none = await redPixels(app, doc);
    assert.ok(none < red / 4, `the squiggles are gone with Check Spelling as You Type off (${none} vs ${red})`);
    await run('review.proofing', {value: true});
    await app.until(async () => ((await redPixels(app, doc)) > red / 2 ? true : null), {timeout: 15_000, interval: 500});

    // Right-click on recieve: its suggestions first, then Ignore All and Add to Dictionary; a correct word has no spelling entries.
    await run('caret.set', {pos: {block: 1, off: 20}});
    let menu = await app.rpc('ui.contextMenu', {doc, target: 'selection'});
    const labels = menu.items.map(i => [i.label, i.command]);
    assert.deepEqual(labels.slice(0, 3), [['Suggestions', 'review.applySuggestion'], ['Ignore All', 'review.ignoreAll'], ['Add to Dictionary', 'review.addToDictionary']], JSON.stringify(labels));
    await app.capture('2-right-click-menu', {doc});
    await app.rpc('ui.activate', {doc, control: menu.items[0].id, value: 'receive'});
    assert.match(await body(), /The team will receive the first release/);
    await run('caret.set', {pos: {block: 3, off: 16}});
    menu = await app.rpc('ui.contextMenu', {doc, target: 'selection'});
    assert.ok(!menu.items.some(i => i.command === 'review.ignoreAll' || i.command === 'review.addToDictionary'), 'no spelling entries on a correct word');
    await app.rpc('ui.contextMenu', {doc, open: false});

    // Ignore All through the menu's command hides every case of the word.
    await run('caret.set', {pos: {block: 2, off: 3}});
    menu = await app.rpc('ui.contextMenu', {doc, target: 'selection'});
    await app.rpc('ui.activate', {doc, control: menu.items.find(i => i.command === 'review.ignoreAll').id});
    assert.deepEqual((await run('review.issues')).map(i => i.text), ['teh']);
    await run('review.recheck');
    assert.deepEqual((await run('review.issues')).map(i => i.text), ['seperate', 'teh']);

    // F7 / the ribbon control: the Editor pane opens on the next misspelt word (selected, with its sentence and suggestions).
    await run('caret.set', {pos: {block: 0, off: 0}});
    await app.rpc('ui.tab', {doc, id: 'review'});
    await app.rpc('ui.activate', {doc, control: 'review.proofing.spelling-grammar'});
    await app.until(async () => ((await app.rpc('ui.inspect', {doc})).panes?.some(p => p.id.includes('editor') && p.open) || null), {timeout: 15_000});
    await settle();
    await app.capture('3-editor-pane', {doc});
    let issue = await app.rpc('selection.get', {doc});
    assert.ok(JSON.stringify(issue).includes('t:'), 'the misspelt word is selected');
    // The pane's buttons are commands: Change (one), Ignore Once, then Change All and Add to Dictionary.
    let next = await run('review.suggestions');
    assert.equal(next.text, 'seperate', 'F7 stopped on the first misspelt word after the caret');
    assert.ok(next.suggestions.includes('separate'));
    assert.ok(next.context.before.startsWith('A ') && next.context.after.includes('budget'));
    await run('review.applySuggestion', {text: 'separate'});
    next = await run('review.spelling');
    assert.equal(next.text, 'teh');
    await run('review.ignoreOnce');
    next = await run('review.spelling');
    assert.equal(next.done, true, 'nothing left: the pane says the check is complete');
    await settle();
    await app.capture('4-editor-pane-done', {doc});
    await run('review.recheck');
    next = await run('review.spelling');
    assert.equal(next.text, 'teh');
    assert.equal((await run('review.changeAll', {text: 'the'})).changed, 1);
    assert.match(await body(), /A separate budget the lines are still pending/);
    await app.rpc('ui.pane', {doc, id: 'pane.editor', open: false});
    assert.ok(!app.log.join('').includes('[spelling]'), 'the dictionary ran in its worker: no fall back to the window thread was logged');
  } catch (e) { throw new Error(`${e.message}${log()}`, {cause: e}); } finally { await app.close(); }
});
