// Quill typing, clipboard, Find and Replace and Paste Special end to end through the bridge, in the
// new shell (devRenderer, ARKEMIS_NEW_HOST=1). No OS or DOM input: the window is inactive and not
// focusable; text goes in through ui.type (the page view's own typing path: one text.insert per
// character, Enter = text.newParagraph), keys through ui.key, dialogs through ui.dialog.*.
//
// 1. What ArtCraft / Word do: typing with AutoCorrect and AutoFormat as you type ("teh" → "The",
//    "* " starts a bulleted list, "--" an en dash, straight quotes curl); Ctrl+X / Ctrl+V move text;
//    Home › Editing › Replace opens Find and Replace on its Replace tab, Find Next selects the next
//    match and says "Match 1 of 1", Replace All says "All done. We made 6 replacements."; Go To moves
//    to a page; Paste Special lists the formats the clipboard holds.
// 2. Ours: the same commands (core/quill/commands/{text,caret,edit,paste}.mjs) run from the window;
//    the evidence is document.read of the result and window captures.
// 3. This file; unit tests in tests/quill/{text,caret,edit,paste}.test.mjs and tests/quill/upstream/.
//
// Evidence: artifacts/e2e/quill/text-editing/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

function emptyLetter(id) {
  const seed = createFile('quill', 'Typing');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [{type: 'paragraph'}]};
  return migrateFile(seed);
}

const pause = ms => new Promise(r => setTimeout(r, ms));

test('quill text: type with AutoCorrect, cut and paste, Find and Replace, Go To, Paste Special', {timeout: 240_000}, async t => {
  const seed = emptyLetter('quill-text-editing');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/text-editing', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const bodyText = async () => String((await app.rpc('document.read', {doc, address: '/body', as: 'text'})).value);
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => {
      const ui = await app.rpc('ui.inspect', {doc});
      return ui.doc?.id === doc && ui.tabs?.length ? ui : null;
    }, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });

    // 1. Typing through the page view: AutoCorrect, smart quotes, a dash and a bulleted list.
    await app.rpc('ui.type', {doc, text: 'teh cat said "hello" -- twice more\n* apples\npears\n\nThe end. teh end.'});
    let text = await bodyText();
    assert.match(text, /^The cat said “hello” – twice more\nApples\nPears\nThe end\. The end\./, text);
    const list = (await app.rpc('document.read', {doc, address: '/body', as: 'json'})).value;
    assert.ok(JSON.stringify(list).includes('"numbering"'), 'the "* " line became a list');
    await pause(300);
    await app.capture('1-typed', {doc});

    // 2. Shift+Home selects the line; Cut, Ctrl+Home, Paste puts it at the top. Cut and Paste run as
    //    bridge commands (the app's own clipboard): Ctrl+X / Ctrl+V from the window also write and read
    //    the system clipboard, which a test must not touch on the person's machine
    //    (design note U-quill-edit--integrator--surface-clipboard asks for a test-mode clipboard).
    const home = await app.rpc('ui.key', {doc, keys: 'Shift+Home'});
    assert.equal(home.command, 'caret.home');
    await run('edit.cut');
    assert.doesNotMatch(await bodyText(), /The end\. The end\./);
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Home'});
    await run('edit.paste');
    assert.match(await bodyText(), /^The end\. The end\.The cat said/);
    await pause(300);
    await app.capture('2-pasted', {doc});
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.match(await bodyText(), /^The cat said/, 'Ctrl+Z took the paste back');

    // 3. Home › Editing › Replace: Find and Replace on its Replace tab; Find Next, then Replace All.
    await app.rpc('ui.tab', {doc, id: 'home'});
    await app.rpc('ui.activate', {doc, control: 'home.editing.replace'});
    await app.until(async () => {
      const d = await app.rpc('ui.dialog.get', {}).catch(() => null);
      return d?.id === 'dialog.find' ? d : null;
    }, {timeout: 10_000});
    await app.until(async () => ((await app.rpc('ui.dialog.get', {})).tab === 1 ? true : null), {timeout: 5_000})
      .catch(() => app.rpc('ui.dialog.set', {tab: 'Replace'}));
    await app.rpc('ui.dialog.set', {values: {findWhat: 'cat', replaceWith: 'dog'}});
    await run('caret.docStart');
    await app.rpc('ui.dialog.submit', {field: 'findNext'});
    let d = await app.rpc('ui.dialog.get', {});
    assert.equal(d.values.status, 'Match 1 of 1', JSON.stringify(d.values));
    await pause(300);
    await app.capture('3-find-next', {doc});
    await app.rpc('ui.dialog.set', {values: {findWhat: 'e', replaceWith: 'E'}});
    await app.rpc('ui.dialog.submit', {field: 'replaceAll'});
    d = await app.rpc('ui.dialog.get', {});
    assert.equal(d.values.status, 'All done. We made 6 replacements.');
    assert.equal((await bodyText()).split('\n').slice(0, 3).join('|'), 'ThE cat said “hEllo” – twicE morE|ApplEs|PEars');
    await pause(300);
    await app.capture('3-replace-all', {doc});

    // 4. The Go To tab; Search Options open the extra checks.
    await app.rpc('ui.dialog.set', {tab: 'Find', values: {more: true}});
    await pause(200);
    await app.capture('4-search-options', {doc});
    await app.rpc('ui.dialog.set', {tab: 'Go To', values: {pageNumber: '1'}});
    await app.rpc('ui.dialog.submit', {field: 'goTo'});
    await pause(200);
    await app.capture('4-go-to', {doc});
    await app.rpc('ui.dialog.cancel', {});

    // 5. Paste Special lists our own copy and its text; OK pastes the chosen format.
    await run('select.text', {text: 'PEars'});
    await run('edit.copy');
    await run('caret.docEnd');
    await app.rpc('ui.dialog.open', {id: 'dialog.pasteSpecial'});
    d = await app.rpc('ui.dialog.get', {});
    assert.deepEqual(d.values.formats.slice(0, 1), ['formatted'], JSON.stringify(d.values));
    await pause(300);
    await app.capture('5-paste-special', {doc});
    await app.rpc('ui.dialog.set', {values: {as: 'text'}});
    await app.rpc('ui.dialog.submit', {button: 'ok'});
    text = await bodyText();
    assert.match(text, /PEars$/m, text);
  } finally {
    await app.close();
  }
});
