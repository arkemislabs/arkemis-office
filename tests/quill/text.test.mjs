// Quill text family (core/quill/commands/text.mjs): typing and deleting, every key that edits text.
//
// 1. What ArtCraft does: wordcraft crates/engine/src/cmd/text.rs `specs` (text.insert … text.ellipsis),
//    text/enter_tab.rs (Enter, Tab, Shift+Tab), text/delete.rs (Backspace, Delete, word deletes),
//    text/unicode.rs (Alt+X, Alt+numpad codes, typed symbols), text/autoformat.rs + cmd/tools/typing.rs
//    (AutoCorrect and AutoFormat as you type) and session/run.rs (consecutive typing is one "Typing"
//    undo step). Word: the same keys, shortcuts and symbols (Ctrl+Enter page break, Ctrl+Shift+Enter
//    column break, Ctrl+Alt+C ©, Alt+X, Alt+0233).
// 2. Ours runs the same steps over the schema-2 model, through the kernel (one undo entry per
//    command, typing bursts merged with mergeUndo), the same from the page view, a shortcut and the
//    bridge. The keystroke and its AutoFormat are one undo step until the kernel has an undo
//    checkpoint (design note U-quill-text--integrator--undo-checkpoint).
// 3. This file (every text.* id, undo round trip, bridge params), tests/quill/upstream/text_typing.test.mjs
//    (upstream tests/typing.rs ports) and tests/e2e/quill/text-editing.e2e.mjs (bridge E2E).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {s, run, typ, typed, paras, para, plain, sel, pos, setSel, undo, undoDepth, bodyParas, blocks} from './text-fixture.mjs';

const roundTrip = async (keys, id, params, check, at = null) => {
  const t = await typed(keys);
  if (at) await setSel(t, ...at);
  await expectUndoRoundTrip(t, id, params, () => check(t));
  return t;
};

test('text.insert types at the caret and a burst is one Typing undo step', async () => {
  const t = await typed('Hello world');
  assert.deepEqual(paras(t), [para('Hello world')]);
  assert.equal(t.doc.undo.size, 1);
  assert.equal(t.doc.undo.peek().label, 'Typing');
  await undo(t);
  assert.equal(plain(t), '');
  // After a caret move the burst is closed: the next character is a step of its own.
  await roundTrip('ab', 'text.insert', {text: 'c'}, t => assert.equal(plain(t), 'acb'), [pos(0, 1)]);
});

test('text.insert raw skips AutoCorrect; paragraphs makes each line a paragraph in one step', async () => {
  let t = await s();
  await run(t, 'text.insert', {text: 'teh "x" ', raw: true});
  assert.equal(plain(t), 'teh "x" ');
  t = await s();
  await run(t, 'text.insert', {text: 'one\ntwo\nthree', paragraphs: true});
  assert.deepEqual(bodyParas(t).map(p => p.text), ['One', 'Two', 'three'], 'Enter finishes a word; the last line is not finished yet');
  assert.equal(t.doc.undo.size, 1);
});

test('text.newParagraph splits the paragraph (Enter)', async () => {
  const t = await roundTrip('abcd', 'text.newParagraph', {}, t => assert.deepEqual(bodyParas(t).map(p => p.text), ['Ab', 'cd']), [pos(0, 2)]);
  assert.deepEqual([].concat(t.registry.get('text.newParagraph').shortcut), ['Enter']);
});

test('text.lineBreak, pageBreak and columnBreak insert their characters', async () => {
  await roundTrip('ab', 'text.lineBreak', {}, t => assert.equal(bodyParas(t)[0].text, 'ab\n'));
  await roundTrip('ab', 'text.pageBreak', {}, t => assert.ok(bodyParas(t).map(p => p.text).join('|').includes(String.fromCharCode(0x0C))));
  await roundTrip('ab', 'text.columnBreak', {}, t => assert.ok(bodyParas(t).map(p => p.text).join('|').includes(String.fromCharCode(0x0E))));
});

test('text.tab types a tab, moves to the next table cell and adds a row after the last', async () => {
  await roundTrip('ab', 'text.tab', {}, t => assert.equal(plain(t), 'ab\t'));
  const t = await s();
  await run(t, 'insert.table', {rows: 1, cols: 2});
  await typ(t, 'a\tb');
  await run(t, 'text.tab');
  const tb = blocks(t).find(b => b.kind === 'table');
  assert.equal(tb.rows.length, 2, 'Tab in the last cell adds a row');
  assert.deepEqual(sel(t).focus.path.slice(-3), [1, 0, 0]);
});

test('text.backTab moves a list item up a level', async () => {
  const t = await typed('* a\n\tb');
  assert.equal(paras(t)[1][1], 1);
  await expectUndoRoundTrip(t, 'text.backTab', {}, () => assert.equal(paras(t)[1][1], 0));
});

test('text.insertTab types a tab character', async () => {
  await roundTrip('ab', 'text.insertTab', {}, t => assert.equal(plain(t), 'ab\t'));
});

test('text.backspace and text.delete remove one character, join paragraphs at the edges', async () => {
  await roundTrip('abc', 'text.backspace', {}, t => assert.equal(plain(t), 'ab'));
  await roundTrip('abc', 'text.delete', {}, t => assert.equal(plain(t), 'bc'), [pos(0, 0)]);
  await roundTrip('ab\ncd', 'text.backspace', {}, t => assert.equal(plain(t), 'Abcd'), [pos(1, 0)]);
  await roundTrip('ab\ncd', 'text.delete', {}, t => assert.equal(plain(t), 'Abcd'), [pos(0, 2)]);
  // A selection goes as a whole.
  await roundTrip('hello world', 'text.delete', {}, t => assert.equal(plain(t), 'Hello'), [pos(0, 5), pos(0, 11)]);
});

test('text.deleteWordBack and deleteWordForward delete to the word edge', async () => {
  await roundTrip('one two three', 'text.deleteWordBack', {}, t => assert.equal(plain(t), 'One two '));
  await roundTrip('one two three', 'text.deleteWordForward', {}, t => assert.equal(plain(t), 'One three'), [pos(0, 4)]);
});

test('typed symbols: nbsp, nbHyphen, optionalHyphen, emDash, copyright, registered, trademark, ellipsis', async () => {
  for (const [id, ch, key] of [['text.nbsp', String.fromCharCode(0xA0), 'Mod+Shift+Space'], ['text.nbHyphen', String.fromCharCode(0x2011), 'Mod+Shift+-'],
    ['text.optionalHyphen', String.fromCharCode(0xAD), 'Mod+-'], ['text.emDash', '—', 'Mod+Alt+-'], ['text.copyright', '©', 'Mod+Alt+C'],
    ['text.registered', '®', 'Mod+Alt+R'], ['text.trademark', '™', 'Mod+Alt+T'], ['text.ellipsis', '…', 'Mod+Alt+.']]) {
    const t = await roundTrip('ab', id, {}, t => assert.equal(plain(t), `ab${ch}`, id));
    assert.deepEqual([].concat(t.registry.get(id).shortcut), [key], id);
  }
});

test('text.toggleUnicode and text.typeCode', async () => {
  await roundTrip('x 00e9', 'text.toggleUnicode', {}, t => assert.equal(plain(t), 'X é'));
  await roundTrip('caf', 'text.typeCode', {code: '0233'}, t => assert.equal(plain(t), 'café'));
  const t = await s();
  await assert.rejects(t.bridge('text.typeCode', {code: '0'}), /code|character|0/i);
});

test('bridge: text commands validate params and need no approval', async () => {
  const t = await s();
  await t.bridge('text.insert', {text: 'Hi'});
  assert.equal(plain(t), 'Hi');
  await assert.rejects(t.bridge('text.insert', {}), e => e.code === 'invalid_params');
  await assert.rejects(t.bridge('text.insert', {text: 5}), e => e.code === 'invalid_params');
  await t.bridge('text.newParagraph');
  assert.equal(bodyParas(t).length, 2);
});

test('a key that changes nothing adds no undo step', async () => {
  const t = await typed('alpha');
  await setSel(t, pos(0, 0));
  const d = undoDepth(t);
  await run(t, 'text.backspace');
  assert.equal(undoDepth(t), d);
});
