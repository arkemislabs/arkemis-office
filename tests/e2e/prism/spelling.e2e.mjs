// Spelling in PowerPoint (U:prism/spelling) end to end through the bridge, in the new shell. No OS input: the ribbon control through ui.activate, the
// right-click menu through ui.contextMenu (the surface names the misspelt word), commands through engine.execute, and the window's pixels read back through
// ui.capture (what the slide canvas painted: the squiggles).
//
// Behaviour fidelity:
// 1. deckcraft crates/ui-egui/src/canvas/squiggles.rs and context_menu.rs (a red wavy underline under each misspelt word of the slide, not under the word
//    being typed; the right-click menu: its suggestions, Delete Repeated Word, Ignore All, Add to Dictionary), crates/engine/src/spell.rs and cmd/review.rs.
//    PowerPoint: Review > Spelling opens the Spelling pane (Ignore, Ignore All, Add, the suggestions, Change, Change All).
// 2. The words are looked up by the bundled en_US dictionary in a worker (core/common/lib/spelling.mjs); the slide draws again when the answers arrive.
// 3. This file; the engine side is tests/spelling/prism-spelling.test.mjs.
//
// Evidence: artifacts/e2e/prism/spelling/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';
import {decodePng} from './png.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Pixels of the window that are the squiggle's red. */
async function redPixels(app) {
  const shot = await app.rpc('ui.capture', {});
  const img = decodePng(shot.png);
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) { const [r, g, b] = img.px(x, y); if (r > 200 && g < 70 && b < 70) n++; }
  return n;
}

test('prism spelling: squiggles on the slide, the right-click menu, F7 and the Spelling pane', {timeout: 300_000}, async () => {
  const file = createFile('prism', 'Spelling deck', {schema: 2});
  file.id = 'prism-spelling';
  file.content.slides[0].shapes[0].text = bodyFromText('Quarterly review');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/spelling', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const bodies = async () => JSON.stringify((await app.rpc('document.read', {doc, address: '/', as: 'json'})).value.slides[0].shapes.map(s => s.text?.paragraphs?.map(p => p.runs.map(r => r.text).join(''))));
  const paneOpen = (id, open = true) => app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.panes?.some(p => p.id.includes(id) && p.open === open) || (!open && !ui.panes?.some(p => p.id.includes(id) && p.open)) || null; }, {timeout: 10_000});
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await run('insert.textBox', {rect: [80, 440, 700, 60], text: 'I recieve teh the the report, a seperate plan'});
    await run('slide.go', {index: 0});

    // Squiggles: before anything opens, the slide draws red waves under the misspelt words (recieve, teh, the, seperate).
    await app.rpc('ui.tab', {doc, tab: 'review'});
    const ctl = (await app.rpc('ui.inspect', {doc})).controls.find(c => c.id === 'review.proofing.spelling');
    assert.ok(ctl && ctl.enabled && !ctl.pending, 'Spelling is on the Review tab and works');
    await run('edit.select', {ids: []}).catch(() => {});
    // Wait until the count settles: a repeated word is flagged at once, the dictionary words when the worker answers.
    let last = 0;
    const red = await app.until(async () => { const n = await redPixels(app); const settled = n > 40 && Math.abs(n - last) < 3; last = n; return settled ? n : null; }, {timeout: 40_000, interval: 1200}).catch(e => { throw new Error(`no squiggles drawn: ${e.message}${log()}`); });
    await app.capture('1-squiggles');
    // Ignore All for each word takes them away; Recheck brings them back.
    for (const w of ['recieve', 'teh', 'the', 'seperate']) await run('review.ignoreAll', {word: w});
    await sleep(600);
    const gone = await redPixels(app);
    assert.ok(gone < red / 3, `the squiggles are gone after Ignore All (${gone} vs ${red})`);
    await run('review.spellingRecheck');
    await app.until(async () => ((await redPixels(app)) > red / 2 ? true : null), {timeout: 15_000, interval: 600});

    // Right-click on recieve: its suggestions, then Ignore All and Add to Dictionary (a repeated word offers Delete Repeated Word instead of suggestions).
    await run('review.spellingMenu', {start: 2});
    let menu = await app.rpc('ui.contextMenu', {doc, target: 'misspelled-word'});
    const labels = menu.items.map(i => i.label);
    assert.deepEqual(labels.slice(0, 3), ['Suggestions', 'Ignore All', 'Add to Dictionary'], JSON.stringify(labels));
    await app.capture('2-right-click-menu');
    await app.rpc('ui.activate', {doc, control: menu.items[0].id, value: 'receive'});
    assert.match(await bodies(), /I receive teh the the report/);
    const rep = (await run('review.spellingList')).find(i => i.repeated);
    await run('review.spellingMenu', {start: rep.start});
    menu = await app.rpc('ui.contextMenu', {doc, target: 'misspelled-word'});
    assert.deepEqual(menu.items.slice(0, 3).map(i => i.label), ['Delete Repeated Word', 'Ignore All', 'Add to Dictionary']);
    await app.rpc('ui.activate', {doc, control: menu.items[0].id});
    assert.match(await bodies(), /I receive teh the report/);
    await app.rpc('ui.contextMenu', {doc, open: false});

    // F7 / the ribbon control: the Spelling pane opens on the first misspelt word of the slide and goes to it.
    await app.rpc('ui.activate', {doc, control: 'review.proofing.spelling'});
    await paneOpen('spelling');
    await sleep(900);
    await app.capture('3-spelling-pane');
    // The pane's buttons are commands: Change, Ignore, Add.
    let list = await run('review.spellingList');
    assert.deepEqual(list.map(i => i.word), ['teh', 'seperate']);
    assert.ok(list[0].suggestions.includes('the'));
    await run('review.spellingChange', {shape: list[0].shape, word: 'teh', to: 'then', para: list[0].para, start: list[0].start});
    list = await run('review.spellingList');
    assert.deepEqual(list.map(i => i.word), ['seperate']);
    await run('review.ignoreOnce', {key: list[0].key});
    list = await run('review.spellingList');
    assert.equal(list.length, 0, 'every word is dealt with');
    await sleep(600);
    await app.capture('4-spelling-pane-done');
    await run('review.spellingRecheck');
    assert.deepEqual((await run('review.spellingList')).map(i => i.word), ['seperate']);
    await run('review.addToDictionary', {word: 'seperate'});
    assert.equal((await run('review.spellingList')).length, 0, 'Add keeps the word for good');
    await app.rpc('ui.pane', {doc, id: 'spelling', open: false});
    await paneOpen('spelling', false);
    assert.ok(!app.log.join('').includes('[spelling]'), 'the dictionary ran in its worker: no fall back to the window thread was logged');
  } catch (e) { throw new Error(`${e.message}${log()}`, {cause: e}); } finally { await app.close(); }
});
