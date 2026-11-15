// Quill Home, Insert and Layout leftovers (U:quill/word-core) end to end through the bridge: Phonetic Guide, Show/Hide ¶, Format Page Numbers
// and Hyphenation Options, each from its ribbon control and dialog. No OS input: ribbon controls through ui.activate, dialogs through ui.dialog.*.
//
// Behaviour fidelity:
// 1. wordcraft crates/engine/src/cmd/phonetic.rs, page.rs (layout.pageNumberFormat, layout.hyphenation) and view.rs (view.marks); Word: the Phonetic
//    Guide, Page Number Format and Hyphenation boxes and the paragraph-mark toggle.
// 2. The same commands run from the window (the person's path); the engine side is tests/quill/word-core.test.mjs.
//
// Evidence: artifacts/e2e/quill/word-core/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

const para = text => ({type: 'paragraph', content: [{type: 'text', text}]});
function seedDoc(id) {
  const seed = createFile('quill', 'Reading');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Reading notes'}]},
    para('I read 漢字 every day before work.'),
    para('A second paragraph of ordinary text.'),
    para(Array.from({length: 12}, () => 'Internationalization and typography require compositional consideration.').join(' ')),
  ]};
  return migrateFile(seed);
}

test('quill word-core: Phonetic Guide, Show/Hide marks, Format Page Numbers, Hyphenation Options', {timeout: 600_000}, async () => {
  const seed = seedDoc('quill-word-core');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/word-core', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async () => JSON.stringify((await app.rpc('document.read', {doc, address: '/body', as: 'json'})).value);
  const settle = (ms = 450) => new Promise(r => setTimeout(r, ms));
  const inspect = () => app.rpc('ui.inspect', {doc});
  const control = async id => (await inspect()).controls?.find(c => c.id === id) ?? null;
  const activate = (id, value) => app.rpc('ui.activate', {doc, control: id, ...(value === undefined ? {} : {value})});
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await inspect(); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });

    // Phonetic Guide: select the two characters, open the box from the Home tab, type the reading.
    await app.rpc('ui.tab', {doc, id: 'home'});
    await settle();
    for (const id of ['home.font.phonetic-guide', 'home.paragraph.show-hide-marks']) assert.ok((await control(id)), `${id} is on the Home tab`);
    const text = 'I read 漢字 every day before work.';
    const at = text.indexOf('漢字');
    await run('select.range', {anchor: {block: 1, off: at}, focus: {block: 1, off: at + 2}});
    await activate('home.font.phonetic-guide');
    let dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.phonetic');
    assert.equal(dlg.values.base, '漢字');
    await app.rpc('ui.dialog.set', {doc, values: {ruby: 'かんじ', alignment: 'Distribute spacing'}});
    await settle();
    await app.capture('1-phonetic-guide', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    assert.ok((await read()).includes('"type":"ruby"'), 'the guide is in the paragraph');
    await settle();
    await app.capture('2-phonetic-on-page', {doc});

    assert.ok((await run('select.similar', {})).runs >= 1, 'Select Text with Similar Formatting answers the runs it found');

    // Show/Hide ¶.
    await activate('home.paragraph.show-hide-marks');
    assert.equal((await control('home.paragraph.show-hide-marks'))?.checked, true);
    await settle();
    await app.capture('3-marks-shown', {doc});
    await activate('home.paragraph.show-hide-marks');

    // Format Page Numbers from Insert › Page Number.
    await app.rpc('ui.tab', {doc, id: 'insert'});
    await settle();
    await app.rpc('ui.menu', {doc, control: 'insert.header-footer.page-number'});
    await settle();
    await activate('insert.header-footer.page-number.format-page-numbers');
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.pageNumbers');
    assert.deepEqual([dlg.values.format, dlg.values.numbering], ['1, 2, 3, …', 'Continue from previous section']);
    await app.rpc('ui.dialog.set', {doc, values: {format: 'I, II, III, …', numbering: 'Start at:', startAt: 4}});
    await settle();
    await app.capture('4-page-number-format', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    const sect = (await run('layout.pageNumberFormat', {})).section;
    assert.deepEqual([sect.pageNumFormat, sect.pageNumStart], ['upperRoman', 4]);

    // Hyphenation Options from Layout › Hyphenation (Automatic and Manual stay hidden).
    await app.rpc('ui.tab', {doc, id: 'layout'});
    await settle();
    await app.rpc('ui.menu', {doc, control: 'layout.page-setup.hyphenation'});
    await settle();
    await app.capture('5-hyphenation-menu', {doc});
    await activate('layout.page-setup.hyphenation.hyphenation-options');
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.hyphenation');
    await app.rpc('ui.dialog.set', {doc, values: {auto: true, zone: 24, limit: 2, caps: false}});
    await settle();
    await app.capture('6-hyphenation-options', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    const h = await run('layout.hyphenation', {zone: 24});
    assert.deepEqual([h.zone, h.caps, h.limit, h.value], [24, false, 2, true]);
    await settle();
    await app.capture('7-hyphenated-page', {doc});

    // Manual…: the first word that could end a line, with its break points.
    await app.rpc('ui.menu', {doc, control: 'layout.page-setup.hyphenation'});
    await settle();
    await activate('layout.page-setup.hyphenation.manual');
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.manualHyphenation');
    assert.equal(dlg.values.done, false, JSON.stringify(dlg.values));
    await settle();
    await app.capture('8-manual-hyphenation', {doc});
    await app.rpc('ui.dialog.submit', {doc, field: 'yes'});
    assert.ok((await read()).includes('\u00ad'), 'Yes put an optional hyphen in the word');
    await settle();
    await app.capture('9-manual-next', {doc});
    await app.rpc('ui.dialog.cancel', {doc});
  } finally {
    await app.close();
  }
});
