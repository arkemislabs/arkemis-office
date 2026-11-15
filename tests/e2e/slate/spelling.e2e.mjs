// Spelling in OneNote (U:slate/spelling) end to end through the bridge, in the new shell. No OS or DOM input: the ribbon control through ui.activate, the
// right-click menu through ui.contextMenu (the surface names the word the caret is in), commands through engine.execute, and the window's pixels read back
// through ui.capture (what the page editor painted: the squiggles).
//
// Behaviour fidelity: OneNote has no upstream here (Slate is modelled on OneNote directly): red wavy underlines under misspelt words of the page, the right-click
// menu on one (suggestions, Ignore All, Add to Dictionary) and Review > Spelling (F7), which opens the Spelling pane on the first misspelt word and selects it.
// The words are looked up by the bundled en_US dictionary in a worker (core/common/lib/spelling.mjs); the editor draws again when the answers arrive.
// Not checked against upstream (there is none). The engine side is tests/spelling/slate-spelling.test.mjs. Evidence: artifacts/e2e/slate/spelling/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createContent, newPageRecord, SECTION_COLORS, validateContent} from '../../../core/slate/schema.mjs';
import {decodePng} from '../prism/png.mjs';

const NOW = new Date().toISOString();
const para = (id, text) => ({type: 'paragraph', attrs: {id, style: 'normal', align: null, indent: 0, dir: null, tags: [], spacing: null, audio: null}, ...(text ? {content: [{type: 'text', text}]} : {})});
const body = (cid, lines) => ({type: 'doc', content: [{type: 'container', attrs: {id: cid, x: 60, y: 130, width: 520}, content: lines.map((t, i) => para(`${cid}p${i}`, t))}]});

function seed() {
  let n = 0;
  const c = createContent('Journal', {uid: () => `r${(n++).toString(36).padStart(4, '0')}`, now: NOW});
  c.tree = ['spub']; c.groups = {}; c.pages = {};
  c.sections = {spub: {id: 'spub', name: 'Public', color: SECTION_COLORS[1], created: NOW, pages: [{id: 'phome', level: 0}]}};
  c.pages.phome = {...newPageRecord({id: 'phome', title: 'Home', created: NOW}), body: body('cphome', ['The team will recieve the first report.', 'A seperate plan, teh end.', 'Everything here is fine.'])};
  return validateContent(c);
}
const fileOf = (id, content) => ({id, schema: 2, kind: 'slate', title: content.notebook.name, revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [], content});

/** Pixels of the window that are the squiggle's red. */
async function redPixels(app) {
  const shot = await app.rpc('ui.capture', {});
  const img = decodePng(shot.png);
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) { const [r, g, b] = img.px(x, y); if (r > 180 && g < 100 && b < 100) n++; }
  return n;
}

test('slate spelling: squiggles on the page, the right-click menu, F7 and the Spelling pane', {timeout: 300_000}, async () => {
  const doc = 'slate-spelling';
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'slate', flow: 'slate/spelling', files: [fileOf(doc, seed())], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const text = async n => (await app.rpc('document.read', {doc, address: `/pg:phome/b:cphomep${n}`, as: 'text'})).value;
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const select = (anchor, focus = anchor) => app.rpc('selection.set', {doc, ranges: [{anchor, focus}]});
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}).catch(() => null); return ui?.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000})
      .catch(e => { throw new Error(e.message + log()); });
    await select('/pg:phome/b:cphomep2/t:0');
    await app.rpc('ui.tab', {doc, id: 'review'});
    await settle(700);
    const spell = (await app.rpc('ui.inspect', {doc})).controls.find(c => c.id === 'review.proofing.spelling');
    assert.ok(spell && spell.enabled && !spell.pending, 'Spelling is on the Review tab and works');

    // Squiggles: with every word ignored the window has only the red it always has (a coloured tab); Recheck lets the dictionary's answers draw red waves
    // under recieve, seperate and teh (the dictionary loads in its worker, the editor draws again when the words are looked up).
    for (const w of ['recieve', 'seperate', 'teh']) await exec('review.ignoreAll', {word: w});
    await settle(1200);
    const base = await redPixels(app);
    await exec('review.spellingRecheck');
    const red = await app.until(async () => { const n = await redPixels(app); return n > base + 60 ? n : null; }, {timeout: 40_000, interval: 700}).catch(e => { throw new Error(`no squiggles drawn (window red ${base}): ${e.message}${log()}`); });
    await app.capture('1-squiggles', {doc});
    await exec('review.ignoreAll', {word: 'recieve'});
    await exec('review.ignoreAll', {word: 'seperate'});
    await exec('review.ignoreAll', {word: 'teh'});
    await settle(900);
    const gone = await redPixels(app);
    assert.ok(gone < base + (red - base) / 3, `the squiggles are gone after Ignore All (${gone} vs ${red}, ${base} without)`);
    await exec('review.spellingRecheck');
    await app.until(async () => ((await redPixels(app)) > base + (red - base) / 2 ? true : null), {timeout: 15_000, interval: 600});

    // Right-click on recieve: its suggestions, then Ignore All and Add to Dictionary; a correct word has no spelling entries.
    await select('/pg:phome/b:cphomep0/t:16');
    let menu = await app.rpc('ui.contextMenu', {doc, target: 'text-selection'});
    assert.deepEqual(menu.items.slice(0, 3).map(i => i.label), ['Suggestions', 'Ignore All', 'Add to Dictionary'], JSON.stringify(menu.items.map(i => i.label)));
    await app.capture('2-right-click-menu', {doc});
    await app.rpc('ui.activate', {doc, control: menu.items[0].id, value: 'receive'});
    assert.equal(await text(0), 'The team will receive the first report.');
    await select('/pg:phome/b:cphomep2/t:12');
    menu = await app.rpc('ui.contextMenu', {doc, target: 'text-selection'});
    assert.ok(!menu.items.some(i => i.command === 'review.ignoreAll' || i.command === 'review.addToDictionary'), 'no spelling entries on a correct word');
    await app.rpc('ui.contextMenu', {doc, open: false});

    // F7 / the ribbon control: the Spelling pane opens on the first misspelt word of the page, selected.
    await select('/pg:phome/b:cphomep0/t:0');
    await app.rpc('ui.activate', {doc, control: 'review.proofing.spelling'});
    await app.until(async () => ((await app.rpc('ui.inspect', {doc})).controls.find(c => c.id === 'review.proofing.spelling')?.checked ? true : null), {timeout: 15_000});
    await settle(900);
    await app.capture('3-spelling-pane', {doc});
    const sel = JSON.stringify(await app.rpc('selection.get', {doc}));
    assert.ok(sel.includes('cphomep1') && sel.includes('t:2'), `the first misspelt word is selected: ${sel}`);
    // The pane's buttons are commands: Change, Ignore, Add.
    let list = await exec('review.spellingList');
    assert.deepEqual(list.map(i => i.word), ['seperate', 'teh']);
    assert.ok(list[0].suggestions.includes('separate'));
    await exec('review.spellingChange', {from: list[0].from, to: list[0].to, word: 'seperate', text: 'separate'});
    assert.equal(await text(1), 'A separate plan, teh end.');
    list = await exec('review.spellingList');
    await exec('review.ignoreOnce', {key: list[0].key});
    assert.equal((await exec('review.spellingList')).length, 0, 'every word is dealt with');
    await settle(700);
    await app.capture('4-spelling-pane-done', {doc});
    await exec('review.spellingRecheck');
    await exec('review.addToDictionary', {word: 'teh'});
    assert.equal((await exec('review.spellingList')).length, 0, 'Add keeps the word for good');
    await exec('history.closePane');
    assert.ok(!app.log.join('').includes('[spelling]'), 'the dictionary ran in its worker: no fall back to the window thread was logged');
  } catch (e) { throw new Error(`${e.message}${log()}`, {cause: e}); } finally { await app.close(); }
});
