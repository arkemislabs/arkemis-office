// Quill page view: the caret, select and text ui-commands (src/apps/quill/ui-commands/{caret,text}.ts
// over src/apps/quill/surface/editing.mjs), run headless through the kernel.
//
// 1. What ArtCraft does: wordcraft crates/engine/src/cmd/caret.rs (every caret.* / select.*),
//    cmd/text.rs + text/delete.rs + text/enter_tab.rs + text/autoformat.rs (`insert`,
//    `typing_options`, smart quotes) + cmd.rs (`insert_text`, `split_para`, `delete_selection`,
//    tracked insert/delete) + session/run.rs (consecutive typing is one "Typing" undo step).
//    Word: typing, Enter, Backspace/Delete, Ctrl+Backspace, Tab in lists and tables, arrows,
//    Home/End, Ctrl+arrows, Shift-extend, double/triple-click units behave the same way.
// 2. Ours runs the same steps over the schema-2 model and the layout; AutoCorrect and AutoFormat as
//    you type (lists from "* ", dashes, capitals) are not translated yet, so the upstream tests
//    that start a list by typing "* " start from a list paragraph made directly (marked "adapted").
// 3. These tests (upstream ports name the Rust test) and tests/e2e/quill/surface-page-view.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {contentFromText, createContent} from '../../core/quill/model/content.mjs';
import {paragraphWithText} from '../../core/quill/model/para.mjs';
import {addList} from '../../core/quill/model/numbering.mjs';
import {resetViews} from '../../src/apps/quill/surface/live.mjs';
import caret from '../../src/apps/quill/ui-commands/caret.ts';
import text from '../../src/apps/quill/ui-commands/text.ts';

const generated = await import('../../core/generated/quill.commands.mjs');
const apps = await import('../../core/generated/apps.mjs');

async function session(content, opts = {}) {
  resetViews();
  return createTestSession('quill', {modules: [...generated.modules, caret, text], foundation: apps.apps.quill, content, ...opts});
}

const body = t => t.content.body.chunks.flat();
const texts = t => body(t).filter(b => b.kind === 'para').map(p => p.text);
const paras = t => body(t).filter(b => b.kind === 'para').map(p => [p.text, p.props?.numbering && p.props.numbering.num !== 0 ? p.props.numbering.level : null,
  p.props?.style === 'ListParagraph']);
const run = (t, id, params = {}) => t.exec(id, params);
/** Type like a person (upstream `typ`): \n Enter, \t Tab, \b Backspace, else one character at a time. */
async function typ(t, keys) {
  for (const c of keys) {
    if (c === '\n') await run(t, 'text.newParagraph');
    else if (c === '\t') await run(t, 'text.tab');
    else if (c === '\b') await run(t, 'text.backspace');
    else await run(t, 'text.insert', {text: c});
  }
}
async function typed(keys, content = createContent(), opts = {}) {
  const t = await session(content, opts);
  await typ(t, keys);
  return t;
}
/** A document whose first paragraph is a bulleted (or numbered) List Paragraph with `first` (adapted for "* " / "1. "). */
function listDoc(first, kind = 'bullet') {
  const c = createContent();
  const {numbering, num} = addList(c.numbering, kind);
  c.numbering = numbering;
  c.body.chunks = [[{...paragraphWithText(first), props: {style: 'ListParagraph', numbering: {num, level: 0}}}]];
  return c;
}
async function listTyped(first, keys, kind) {
  const t = await session(listDoc(first, kind));
  await run(t, 'caret.docEnd');
  await typ(t, keys);
  return t;
}
const sel = t => t.doc.selection.ranges[t.doc.selection.primary];
const offOf = addr => Number(/\/t:(\d+)/.exec(addr)?.[1]);

test('typing goes in at the caret, one character per text.insert, and is one Typing undo step', async () => {
  const t = await typed('Hello world');
  assert.deepEqual(texts(t), ['Hello world']);
  assert.equal(t.doc.undo.size, 1, 'one undo step for the burst');
  assert.equal(t.doc.undo.peek().label, 'Typing');
  await t.undo();
  assert.deepEqual(texts(t), ['']);
});

test('typing_then_selecting_then_typing_are_two_undo_steps (upstream tests/typing.rs)', async () => {
  const t = await typed('alpha');
  await run(t, 'select.text', {text: 'ph'});
  await run(t, 'text.insert', {text: 'X'});
  assert.deepEqual(texts(t), ['alXa']);
  await t.undo();
  assert.deepEqual(texts(t), ['alpha']);
  assert.ok(t.doc.undo.size > 0);
  await t.undo();
  assert.deepEqual(texts(t), ['']);
});

test('backspace_at_the_start_of_the_document_is_not_an_edit (upstream tests/typing.rs)', async () => {
  const t = await typed('alpha');
  await run(t, 'caret.docStart');
  const depth = t.doc.undo.size;
  const v = t.version;
  await typ(t, '\b');
  assert.equal(t.doc.undo.size, depth, 'no undo step');
  assert.equal(t.version, v, 'no change');
  assert.deepEqual(texts(t), ['alpha']);
});

test('smart_quotes_nested_and_opening_delimiters (upstream tests/typing.rs)', async () => {
  let t = await typed('"\'nested\'" \'"inner"\' ("\'parens\'")');
  assert.deepEqual(texts(t), ['\u201C\u2018nested\u2019\u201D \u2018\u201Cinner\u201D\u2019 (\u201C\u2018parens\u2019\u201D)']);
  t = await typed('"" \'\'');
  assert.deepEqual(texts(t), ['\u201C\u201D \u2018\u2019']);
  t = await typed('\u00AB\'french\'\u00BB \u201E\'german\'\u201C');
  assert.deepEqual(texts(t), ['\u00AB\u2018french\u2019\u00BB \u201E\u2018german\u2019\u201C']);
});

test('raw text.insert keeps straight quotes; paragraphs mode types lines with Enter between, one undo step', async () => {
  const t = await session(createContent());
  await run(t, 'text.insert', {text: '"a"', raw: true});
  assert.deepEqual(texts(t), ['"a"']);
  await run(t, 'text.insert', {text: '\none\ntwo', paragraphs: true});
  // Enter runs AutoCorrect on the word it finishes, as in Word: the sentence's first letter is capitalised.
  assert.deepEqual(texts(t), ['"a"', 'One', 'two']);
  await t.undo();
  assert.deepEqual(texts(t), ['"a"']);
});

test('sample_text_formulas_expand_on_enter (upstream tests/typing.rs)', async () => {
  for (const name of ['rand', 'lorem']) {
    for (const [args, paragraphs, sentences] of [['', 5, 3], ['2', 2, 3], [' 2 ', 2, 3], ['2,4', 2, 4], ['2, 4', 2, 4], [' 2 , 4 ', 2, 4], ['1,1', 1, 1], ['1,200', 1, 200]]) {
      const t = await typed(`=${name}(${args})`);
      const depth = t.doc.undo.size;
      await typ(t, '\n');
      const generated = texts(t);
      assert.equal(generated.length, paragraphs + 1, `${name}(${args})`);
      for (const p of generated.slice(0, paragraphs)) {
        assert.equal(p.split('.').length - 1, sentences);
        assert.ok(p.startsWith(name === 'lorem' ? 'Lorem ipsum' : 'A blank page'), p);
      }
      assert.equal(generated[generated.length - 1], '');
      assert.equal(t.doc.undo.size, depth + 1);
      await t.undo();
      assert.deepEqual(texts(t), [`=${name}(${args})`]);
    }
  }
});

test('sample_text_invalid_parameters_use_defaults and sample_text_requires_an_exact_paragraph_and_caret_at_end (upstream tests/typing.rs)', async () => {
  for (const args of ['0', '-1', '201', 'abc', '1.5', '99999999999999999999999999999', '2,0', '0,4', '2,201', '2,no', '2,', ',4', '1,2,3']) {
    const t = await typed(`=rand(${args})\n`);
    assert.equal(texts(t).length, 6, args);
  }
  // Only =rand()/=lorem() detection is checked here, so sentence capitals are off (Word would make "prefix" "Prefix").
  const noCaps = {prefs: {autocorrect: {capSentences: false}}};
  for (const formula of [' =rand()', '=rand() ', 'prefix =rand()', '=lorem() suffix', '=other()', '=rand(', '=rand(())']) {
    assert.deepEqual(texts(await typed(`${formula}\n`, createContent(), noCaps)), [formula, ''], formula);
  }
  const t = await typed('=rand()');
  await run(t, 'caret.home');
  await typ(t, '\n');
  assert.deepEqual(texts(t), ['', '=rand()']);
});

test('enter_twice_after_a_list_item_ends_the_list (upstream tests/typing.rs, adapted: list paragraph made directly)', async () => {
  const t = await listTyped('Item', '\n\ntext');
  assert.deepEqual(paras(t), [['Item', 0, true], ['text', null, false]]);
});

test('more_enters_after_a_list_make_blank_paragraphs (upstream tests/typing.rs, adapted)', async () => {
  const t = await listTyped('Item', '\n\n\ntext');
  assert.deepEqual(paras(t), [['Item', 0, true], ['', null, false], ['text', null, false]]);
});

test('enter_on_an_empty_nested_item_moves_it_up_a_level_first (upstream tests/typing.rs, adapted)', async () => {
  let t = await listTyped('A', '\n\tB\n\ntext');
  assert.deepEqual(paras(t).map(p => p.slice(0, 2)), [['A', 0], ['B', 1], ['text', 0]]);
  t = await listTyped('A', '\n\tB\n\n\ntext');
  assert.deepEqual(paras(t).map(p => p.slice(0, 2)), [['A', 0], ['B', 1], ['text', null]]);
  t = await listTyped('A', '\n\tB\n\tC\n\n\n\ntext');
  assert.deepEqual(paras(t).map(p => p.slice(0, 2)), [['A', 0], ['B', 1], ['C', 2], ['text', null]]);
});

test('shift_tab_and_tab_change_list_levels (upstream tests/typing.rs, adapted)', async () => {
  const t = await listTyped('One', '\nTwo\n\tSub a\nSub b\n', 'numbered');
  await run(t, 'text.backTab');
  await typ(t, 'Three\n\nDone');
  assert.deepEqual(paras(t).map(p => p.slice(0, 2)), [['One', 0], ['Two', 0], ['Sub a', 1], ['Sub b', 1], ['Three', 0], ['Done', null]]);
});

test('backspace_at_the_start_of_an_item_removes_the_number_then_the_indent (upstream tests/typing.rs, adapted)', async () => {
  const t = await listTyped('One', '\nTwo');
  await run(t, 'caret.home');
  await typ(t, '\b');
  assert.deepEqual(paras(t)[1], ['Two', null, true], 'number gone, still a List Paragraph');
  await typ(t, '\b|');
  assert.deepEqual(paras(t), [['One', 0, true], ['|Two', null, false]]);
});

test('backspace_on_an_empty_item_keeps_the_paragraph (upstream tests/typing.rs, adapted)', async () => {
  const t = await listTyped('One', '\n\bZ');
  assert.deepEqual(paras(t), [['One', 0, true], ['Z', null, true]]);
});

test('enter_in_the_middle_or_at_the_start_of_an_item (upstream tests/typing.rs, adapted)', async () => {
  let t = await listTyped('Hello world', '');
  for (let i = 0; i < 5; i++) await run(t, 'caret.left');
  await typ(t, '\nX');
  assert.deepEqual(paras(t).map(p => p.slice(0, 2)), [['Hello ', 0], ['Xworld', 0]]);
  t = await listTyped('First', '\nsecond');
  await run(t, 'caret.home');
  await typ(t, '\nY');
  assert.deepEqual(paras(t).map(p => p.slice(0, 2)), [['First', 0], ['', 0], ['Ysecond', 0]]);
});

test('shift_enter_stays_inside_the_list_item (upstream tests/typing.rs, adapted)', async () => {
  const t = await listTyped('Line one', '');
  await run(t, 'text.lineBreak');
  await typ(t, 'cont\ntwo');
  assert.deepEqual(paras(t).map(p => p.slice(0, 2)), [['Line one\ncont', 0], ['two', 0]]);
});

test('Tab at a paragraph start indents the first line by a default tab stop; Backspace takes it back (enter_tab.rs indent_by_tab)', async () => {
  // "Set left- and first-indent with tabs and backspaces" (AutoCorrect, off by default upstream).
  const t = await typed('Body text', createContent(), {prefs: {autocorrect: {tabIndent: true}}});
  await run(t, 'caret.home');
  await typ(t, '\t');
  assert.equal(body(t)[0].props?.indentFirst, 36);
  assert.deepEqual(texts(t), ['Body text']);
  await typ(t, '\b');
  assert.equal(body(t)[0].props?.indentFirst ?? 0, 0);
  // Mid-line, Tab is a tab character.
  await run(t, 'caret.end');
  await typ(t, '\t');
  assert.deepEqual(texts(t), ['Body text\t']);
});

test('Backspace and Delete join paragraphs; Ctrl+Backspace/Delete remove words', async () => {
  const t = await session(contentFromText('alpha beta\ngamma'));
  await run(t, 'caret.docEnd');
  await run(t, 'caret.home');
  await run(t, 'text.backspace');
  assert.deepEqual(texts(t), ['alpha betagamma']);
  await run(t, 'text.deleteWordBack');
  assert.deepEqual(texts(t), ['alpha gamma']);
  await run(t, 'caret.docStart');
  await run(t, 'text.deleteWordForward');
  assert.deepEqual(texts(t), ['gamma'], 'Ctrl+Delete takes the word and its trailing space, as in Word');
  await run(t, 'text.delete');
  assert.deepEqual(texts(t), ['amma']);
  await run(t, 'caret.docEnd');
  await run(t, 'text.delete');
  assert.deepEqual(texts(t), ['amma'], 'Delete at the story end changes nothing');
});

test('every text edit is one undo step that round-trips', async () => {
  const t = await session(contentFromText('alpha beta\ngamma'));
  await run(t, 'caret.docEnd');
  await expectUndoRoundTrip(t, 'text.newParagraph', {});
  await expectUndoRoundTrip(t, 'text.backspace', {});
  await expectUndoRoundTrip(t, 'text.pageBreak', {}, after => assert.ok(after.content.body.chunks.flat().some(p => p.text.includes('\u000C'))));
  await expectUndoRoundTrip(t, 'text.emDash', {});
  await run(t, 'select.all');
  await expectUndoRoundTrip(t, 'text.insert', {text: 'Z'}, after => assert.deepEqual(after.content.body.chunks.flat().map(p => p.text), ['Z']));
});

test('typing over a selection replaces it; with "Typing replaces selected text" off it goes in front', async () => {
  let t = await session(contentFromText('one two three'));
  await run(t, 'select.text', {text: 'two'});
  await typ(t, 'X');
  assert.deepEqual(texts(t), ['one X three']);
  t = await session(contentFromText('one two three'), {prefs: {typingReplacesSelection: false}});
  await run(t, 'select.text', {text: 'two'});
  await typ(t, 'X');
  assert.deepEqual(texts(t), ['one Xtwo three']);
});

test('overtype replaces the characters after the caret, never past an object', async () => {
  const t = await session(contentFromText('abcdef'), {prefs: {overtype: true}});
  await run(t, 'caret.docStart');
  await typ(t, 'XY');
  assert.deepEqual(texts(t), ['XYcdef']);
});

test('Track Changes: typed text is a tracked insertion, Backspace over other text marks it deleted', async () => {
  const c = contentFromText('keep');
  c.settings = {...c.settings, trackChanges: true};
  const t = await session(c, {prefs: {userName: 'Ada'}});
  await run(t, 'caret.docEnd');
  await typ(t, 'X');
  const p = body(t)[0];
  assert.equal(p.text, 'keepX');
  const ins = p.runs.find(r => r.props?.ins !== undefined);
  assert.ok(ins, 'the typed run carries ins');
  assert.equal(t.content.revisions[ins.props.ins].author, 'Ada');
  assert.equal(t.content.revisions[ins.props.ins].kind, 'insert');
  // Own insertion: Backspace removes it outright.
  await typ(t, '\b');
  assert.equal(body(t)[0].text, 'keep');
  // Other text: marked deleted, still there.
  await typ(t, '\b');
  const q = body(t)[0];
  assert.equal(q.text, 'keep');
  assert.ok(q.runs.some(r => r.props?.del !== undefined), 'the p is marked deleted');
});

test('caret: Left/Right by character, across paragraphs; a selection collapses to its edge; Shift extends', async () => {
  const t = await session(contentFromText('ab\ncd'));
  await run(t, 'caret.right');
  await run(t, 'caret.right');
  await run(t, 'caret.right');
  assert.equal(offOf(sel(t).focus), 0, 'past the end of a paragraph: the next one\'s start');
  assert.notEqual(sel(t).focus.split('/t:')[0], (await t.exec('caret.docStart')).result.focus.split('/t:')[0]);
  await run(t, 'caret.right', {extend: true});
  await run(t, 'caret.right', {extend: true});
  assert.equal(offOf(sel(t).anchor), 0);
  assert.equal(offOf(sel(t).focus), 2);
  await run(t, 'caret.left');
  assert.equal(offOf(sel(t).focus), 0, 'Left collapses a selection to its start');
  assert.equal(sel(t).anchor, sel(t).focus);
});

test('caret: word moves, paragraph moves, document start/end, and Home/End/Up/Down through the layout', async () => {
  const t = await session(contentFromText('alpha beta gamma\nsecond line'));
  await run(t, 'caret.docStart');
  await run(t, 'caret.wordRight');
  assert.equal(offOf(sel(t).focus), 6, 'Word Right goes past the space, to the next word');
  await run(t, 'caret.wordRight');
  await run(t, 'caret.wordLeft');
  assert.equal(offOf(sel(t).focus), 6);
  await run(t, 'caret.end');
  assert.equal(offOf(sel(t).focus), 16);
  await run(t, 'caret.home');
  assert.equal(offOf(sel(t).focus), 0);
  await run(t, 'caret.down');
  assert.match(sel(t).focus, /\/t:\d+$/);
  const r = (await t.exec('caret.paraUp')).result;
  assert.equal(offOf(r.focus), 0);
  await run(t, 'caret.docEnd');
  assert.equal(offOf(sel(t).focus), 11);
  await run(t, 'caret.up');
  await run(t, 'caret.paraDown', {extend: true});
  assert.notEqual(sel(t).anchor, sel(t).focus);
});

test('select: word, sentence, paragraph (with its mark), line, all, dragUnit by words, collapse', async () => {
  const t = await session(contentFromText('One two. Three four.\nNext'));
  await run(t, 'caret.docStart');
  await run(t, 'caret.wordRight');
  await run(t, 'select.word');
  assert.equal(offOf(sel(t).anchor), 4);
  assert.ok(offOf(sel(t).focus) >= 7, 'the word "two"');
  await run(t, 'select.sentence');
  assert.equal(offOf(sel(t).anchor), 0);
  await run(t, 'select.paragraph');
  assert.equal(offOf(sel(t).anchor), 0);
  assert.equal(offOf(sel(t).focus), 0, 'the paragraph ends at the next paragraph\'s start (its mark is selected)');
  assert.notEqual(sel(t).anchor.split('/t:')[0], sel(t).focus.split('/t:')[0]);
  await run(t, 'select.all');
  assert.equal(offOf(sel(t).focus), 4);
  await run(t, 'select.collapse');
  assert.equal(sel(t).anchor, sel(t).focus);
  // Drag by words from "two" to "four": whole words.
  const r = t.content.body.chunks.flat()[0].id;
  await run(t, 'select.dragUnit', {unit: 'word', start: `/body/b:${r}/t:4`, end: `/body/b:${r}/t:7`, pos: `/body/b:${r}/t:16`});
  assert.equal(offOf(sel(t).anchor), 4);
  assert.equal(offOf(sel(t).focus), 19, 'to the end of "four"');
  await run(t, 'select.line', {pos: `/body/b:${r}/t:3`});
  assert.equal(offOf(sel(t).anchor), 0);
});

test('caret.set by page point hits the nearest text; select.range takes addresses', async () => {
  const t = await session(contentFromText('Hello world'));
  const r = (await t.exec('caret.set', {page: 0, x: 72 + 1, y: 80})).result;
  assert.match(r.focus, /\/t:\d+$/);
  const id = body(t)[0].id;
  await run(t, 'select.range', {anchor: `/body/b:${id}/t:0`, focus: `/body/b:${id}/t:5`});
  assert.equal(offOf(sel(t).focus), 5);
  await assert.rejects(t.exec('caret.set', {}), /pos/);
});

test('Tab in a table cell moves to the next cell and adds a row after the last', async () => {
  const c = createContent();
  const id = n => `c${String(n).padStart(7, '0')}`;
  let k = 0;
  const cell = txt => ({id: id(k++), props: {}, blocks: [paragraphWithText(txt, {}, id(k++))]});
  c.body.chunks = [[{kind: 'table', id: id(k++), props: {}, grid: [100, 100], rows: [{id: id(k++), props: {}, cells: [cell('a'), cell('b')]}]}, paragraphWithText('after', {}, id(k++))]];
  const t = await session(c);
  await run(t, 'caret.docStart');
  await run(t, 'text.tab');
  assert.match(sel(t).focus, /\/c:/);
  await run(t, 'text.tab');
  assert.equal(body(t)[0].rows.length, 2, 'a new row after the last cell');
  await run(t, 'text.backTab');
  await run(t, 'text.backTab');
  assert.match(sel(t).focus, /\/c:/);
});

test('commands are disabled on a schema-1 document and validate params over the bridge', async () => {
  const t = await session(contentFromText('x'));
  await assert.rejects(t.bridge('text.insert', {}), /text/);
  await assert.rejects(t.bridge('select.dragUnit', {unit: 'page', start: '/body', end: '/body', pos: '/body'}));
  const legacy = await createTestSession('quill', {modules: [...generated.modules, caret, text], foundation: apps.apps.quill});
  const st = legacy.state('text.insert', {text: 'a'});
  assert.equal(st.enabled, false);
});
