// Ports of wordcraft crates/engine/src/tests/typing.rs (ArtCraft aadb077e072b7de05f724e359d8db82e151f125c):
// typing checked side by side against Word, keystroke by keystroke through the same commands the
// keyboard runs (one text.insert per character, Enter, Tab, Backspace).
//
// 1. What ArtCraft does: tests/typing.rs drives cmd/text.rs (+ text/autoformat.rs, enter_tab.rs,
//    delete.rs, unicode.rs), cmd/tools/typing.rs (AutoCorrect as you type), cmd/caret.rs and
//    cmd/edit.rs; each expectation is what Word produces for the same keys.
// 2. Ours runs the same commands (core/quill/commands/{text,caret,edit,paste}.mjs over the
//    schema-2 model). Upstream options set through `tools.autocorrect` / `file.options` (U:quill/tools)
//    are set here as the prefs those commands store (prefs.autocorrect, prefs.typingReplacesSelection);
//    Track Changes through content.settings.trackChanges. Tests whose expectation is the separate
//    "AutoFormat" undo step wait on the kernel's undo checkpoint
//    (design note U-quill-text--integrator--undo-checkpoint) and are marked todo.
// 3. These tests, plus tests/quill/{text,caret,edit,paste}.test.mjs and the bridge E2E
//    tests/e2e/quill/text-editing.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {s, run, typ, typed, paras, para, texts, plain, labelAt, sel, pos, setSel, undo, redo, undoDepth, bodyParas, blocks, BACKSPACE, charAt}
  from '../text-fixture.mjs';

const ac = autocorrect => ({prefs: {autocorrect}});
const CHECKPOINT = 'needs the kernel undo checkpoint (U-quill-text--integrator--undo-checkpoint)';

test('sample_text_formulas_expand_on_enter', async () => {
  for (const name of ['rand', 'lorem']) {
    for (const [args, paragraphs, sentences] of [['', 5, 3], ['2', 2, 3], [' 2 ', 2, 3], ['2,4', 2, 4], ['2, 4', 2, 4], [' 2 , 4 ', 2, 4], ['1,1', 1, 1], ['1,200', 1, 200]]) {
      const t = await typed(`=${name}(${args})`);
      await typ(t, '\n');
      const generated = paras(t).map(p => p[0]);
      assert.equal(generated.length, paragraphs + 1, `${name}(${args})`);
      for (const text of generated.slice(0, paragraphs)) {
        assert.equal(text.split('.').length - 1, sentences);
        assert.ok(text.startsWith(name === 'lorem' ? 'Lorem ipsum' : 'A blank page'), `${name}(${args}): ${text}`);
      }
      assert.equal(generated.at(-1), '');
      assert.deepEqual(sel(t).focus, pos(paragraphs, 0));
      const expanded = structuredClone(t.content);
      await undo(t);
      assert.deepEqual(paras(t).map(p => p[0]), [`=${name}(${args})`]);
      await redo(t);
      assert.deepEqual(t.content, expanded);
    }
  }
});

test('sample_text_invalid_parameters_use_defaults', async () => {
  for (const name of ['rand', 'lorem']) {
    for (const args of ['0', '-1', '201', 'abc', '1.5', '99999999999999999999999999999', '2,0', '0,4', '2,201', '2,no', '2,', ',4', '1,2,3']) {
      const t = await typed(`=${name}(${args})\n`);
      const ps = paras(t).map(p => p[0]);
      assert.equal(ps.length, 6, `${name}(${args})`);
      assert.ok(ps.slice(0, 5).every(x => x.split('.').length - 1 === 3));
    }
  }
});

test('sample_text_requires_an_exact_paragraph_and_caret_at_end', async () => {
  for (const formula of [' =rand()', '=rand() ', 'prefix =rand()', '=lorem() suffix', '=other()', '=rand(', '=rand(())']) {
    const t = await typed(`${formula}\n`);
    assert.deepEqual(paras(t).map(p => p[0]).map(x => x.toLowerCase()), [formula.toLowerCase(), ''], formula);
  }
  let t = await typed('=rand()');
  await run(t, 'caret.home');
  await typ(t, '\n');
  assert.deepEqual(texts(t), ['', '=rand()']);
  t = await typed('=rand()suffix');
  await setSel(t, pos(0, 7), pos(0, 13));
  await typ(t, '\n');
  assert.deepEqual(texts(t), ['=rand()', '']);
});

test('sample_text_preserves_typing_and_paragraph_formatting', async () => {
  const t = await s();
  await run(t, 'format.bold');
  await run(t, 'para.alignCenter');
  await typ(t, '=rand(2,1)\n');
  for (const [i, p] of bodyParas(t).slice(0, 2).entries()) {
    assert.equal(p.props?.align, 'center');
    assert.equal((await charAt(t, i, 0)).bold, true);
  }
});

test('enter_twice_after_a_list_item_ends_the_list', async () => {
  assert.deepEqual(paras(await typed('* item\n\ntext')), [para('Item', 0), para('text')]);
});

test('more_enters_after_a_list_make_blank_paragraphs', async () => {
  assert.deepEqual(paras(await typed('* item\n\n\ntext')), [para('Item', 0), para(''), para('text')]);
  assert.deepEqual(paras(await typed('1. item\n\n\n\nafter')), [para('Item', 0), para(''), para(''), para('after')]);
});

test('the_paragraph_after_a_list_is_normal_text', async () => {
  const t = await typed('* Apple\nBanana\n\nAfter list');
  const p = bodyParas(t).at(-1);
  assert.equal(p.props?.style ?? null, null, 'back to Normal, not an indented List Paragraph');
  assert.equal(p.props?.numbering ?? null, null);
  await typ(t, '\nMore');
  assert.deepEqual(paras(t).at(-1), para('More'));
});

test('enter_on_an_empty_nested_item_moves_it_up_a_level_first', async () => {
  assert.deepEqual(paras(await typed('* a\n\tb\n\ntext')), [para('A', 0), para('B', 1), para('text', 0)]);
  assert.deepEqual(paras(await typed('* a\n\tb\n\n\ntext')), [para('A', 0), para('B', 1), para('text')]);
  assert.deepEqual(paras(await typed('* a\n\tb\n\n\n\ntext')), [para('A', 0), para('B', 1), para(''), para('text')]);
  assert.deepEqual(paras(await typed('* a\n\tb\n\tc\n\n\n\ntext')), [para('A', 0), para('B', 1), para('C', 2), para('text')]);
  assert.deepEqual(paras(await typed('1. a\n\tb\n\n\ntext')), [para('A', 0), para('B', 1), para('text')]);
});

test('shift_tab_and_tab_change_list_levels', async () => {
  const t = await typed('1. One\nTwo\n\tSub a\nSub b\n');
  await run(t, 'text.backTab');
  await typ(t, 'Three\n\nDone');
  assert.deepEqual(paras(t), [para('One', 0), para('Two', 0), para('Sub a', 1), para('Sub b', 1), para('Three', 0), para('Done')]);
});

test('backspace_at_the_start_of_an_item_removes_the_number_then_the_indent', async () => {
  const t = await typed('* One\nTwo');
  await run(t, 'caret.home');
  await typ(t, BACKSPACE);
  assert.deepEqual(paras(t)[1], ['Two', null, true], 'number gone, still indented with the list');
  await typ(t, BACKSPACE + '|');
  assert.deepEqual(paras(t), [para('One', 0), para('|Two')]);
});

test('backspace_on_an_empty_item_keeps_the_paragraph', async () => {
  assert.deepEqual(paras(await typed(`* One\n${BACKSPACE}Z`)), [para('One', 0), ['Z', null, true]]);
});

test('enter_in_the_middle_or_at_the_start_of_an_item', async () => {
  let t = await typed('* Hello world');
  for (let i = 0; i < 5; i++) await run(t, 'caret.left');
  await typ(t, '\nX');
  assert.deepEqual(paras(t), [para('Hello ', 0), para('Xworld', 0)]);
  t = await typed('* first\nsecond');
  await run(t, 'caret.home');
  await typ(t, '\nY');
  assert.deepEqual(paras(t), [para('First', 0), para('', 0), para('Ysecond', 0)]);
});

test('list_autoformat_triggers', async () => {
  let t = await typed('- Item\nNext');
  assert.equal(labelAt(t, 0), '-');
  assert.deepEqual(paras(t), [para('Item', 0), para('Next', 0)]);
  t = await typed('1) a\nb');
  assert.equal(labelAt(t, 0), '%1)');
  t = await typed('a. alpha\nbeta');
  assert.deepEqual(paras(t), [para('Alpha', 0), para('beta', 0)]);
  assert.equal(labelAt(t, 0), '%1.');
});

test('list_autoformat_triggers_in_front_of_existing_text', async () => {
  const t = await s();
  await typ(t, 'On peut faire mieux');
  await run(t, 'caret.home');
  await typ(t, '- ');
  assert.deepEqual(paras(t), [para('On peut faire mieux', 0)]);
  assert.equal(labelAt(t, 0), '-');
});

test('typing_1_dot_starts_numbering_again', async () => {
  const t = await typed('1. a\nb\n\nmid\n1. c\nd');
  const num = i => bodyParas(t)[i].props?.numbering?.num;
  assert.equal(num(0), num(1));
  assert.equal(num(3), num(4));
  assert.notEqual(num(0), num(3), 'a new list restarts at 1');
});

test('undo_right_after_autoformat_undoes_only_the_autoformat', {todo: CHECKPOINT}, async () => {
  let t = await typed('* ');
  assert.notEqual(paras(t)[0][1], null);
  await undo(t);
  await typ(t, 'x');
  assert.deepEqual(paras(t), [['* x', null, false]]);
  t = await typed('teh ');
  await undo(t);
  assert.equal(plain(t), 'teh ');
});

test('autocorrect_as_you_type', async () => {
  let t = await typed('teh cat said hello. world (c) "quoted" don\'t -- yes wait... i think so. e.g. this. ');
  assert.equal(plain(t), 'The cat said hello. World © “quoted” don’t – yes wait… I think so. E.g. this. ');
  t = await typed('see e.g. the map. Ask J. smith or Dr. jones ');
  assert.equal(plain(t), 'See e.g. the map. Ask J. smith or Dr. jones ');
  t = await typed('1/2 cup. iPhone. see readme.txt ');
  assert.equal(plain(t), '½ cup. iPhone. See readme.txt ');
});

test('smart_quotes_nested_and_opening_delimiters', async () => {
  assert.equal(plain(await typed('"\'nested\'" \'"inner"\' ("\'parens\'")')), '“‘nested’” ‘“inner”’ (“‘parens’”)');
  assert.equal(plain(await typed('"" \'\'')), '“” ‘’');
  assert.equal(plain(await typed('«\'french\'» „\'german\'“')), '«‘french’» „‘german’“');
});

test('double_hyphen_arrow_autocorrect_preserves_typing_scope_and_undo', async () => {
  let t = await typed('go --> ');
  assert.equal(plain(t), 'Go → ');
  assert.equal(paras(t)[0][1], null);
  t = await typed('go --> here');
  assert.equal(plain(t), 'Go → here');
  t = await typed('--> ');
  assert.equal(plain(t), '→ ');
  assert.equal(paras(t)[0][1], null);
});

test('double_hyphen_arrow_respects_autocorrect_preferences', async () => {
  for (const prefs of [{enabled: false}, {replaceText: false}, {removed: ['-->']}]) {
    const t = await typed('go --> here', ac(prefs));
    assert.ok(plain(t).endsWith(' --> here'), JSON.stringify(prefs));
  }
  const t = await typed('go --> here', ac({entries: [['-->', 'custom']]}));
  assert.equal(plain(t), 'Go custom here');
});

test('autocorrect_options_change_what_typing_does', async () => {
  let t = await typed('wc ships on monday. teh end is approx. three weeks ', ac({entries: [['wc', 'WordCraft']], removed: ['teh'], exceptions: ['approx.']}));
  assert.equal(plain(t), 'WordCraft ships on Monday. Teh end is approx. three weeks ');
  t = await typed('* "hi" a -- b sunday ', ac({smartQuotes: false, dashes: false, bullets: false, capSentences: false, capDays: false}));
  assert.equal(plain(t), '* "hi" a -- b sunday ');
  assert.equal(paras(t)[0][1], null);
});

test('enter_finishes_a_word_for_autocorrect', async () => {
  assert.equal(plain(await typed('hello\nteh end\n')), 'Hello\nThe end\n');
});

test('autocorrect_finds_the_word_after_a_wide_space', async () => {
  const NB = String.fromCharCode(0xA0), ID = String.fromCharCode(0x3000);
  assert.equal(plain(await typed(`a${NB}teh x${ID}teh `)), `a${NB}the x${ID}the `);
  assert.equal(plain(await typed(`end.${NB}hello end.${ID}world `)), `End.${NB}Hello end.${ID}World `);
});

test('ordinals_become_superscript', async () => {
  const t = await typed('the 1st and 22nd and 13th but not 1th ');
  const text = bodyParas(t)[0].text;
  const sup = async w => (await charAt(t, 0, text.indexOf(w) + w.length - 2)).vertAlign === 'superscript';
  assert.ok(await sup('1st') && await sup('22nd') && await sup('13th'));
  assert.ok(!(await sup('1th')));
});

test('bold_and_italic_marks_become_formatting', async () => {
  const t = await typed('say *very* nice, _quite_ good *two words*. ok\n*end*\nnext', ac({boldItalic: true, capSentences: false}));
  assert.equal(plain(t), 'say very nice, quite good two words. ok\nend\nnext');
  const text = bodyParas(t)[0].text;
  const at = w => charAt(t, 0, text.indexOf(w));
  assert.equal((await at('very')).bold, true);
  assert.equal((await at('very')).italic, undefined);
  assert.equal((await at('quite')).italic, true);
  assert.equal((await at('two')).bold, true);
  assert.equal((await at('words')).bold, true);
  for (const w of ['say', ' nice', ', ', ' good', '. ok']) assert.equal((await at(w)).bold, undefined, w);
  assert.equal((await charAt(t, 1, 0)).bold, true);
  assert.equal((await charAt(t, 2, 0)).bold, undefined);
});

test('bold_and_italic_marks_stay_as_typed_unless_they_enclose_words', async () => {
  const keys = '2*3* file_name_ * x* *x * ** __ *?!* _-_ ';
  assert.equal(plain(await typed(keys, ac({boldItalic: true, capSentences: false}))), keys);
});

test('web_addresses_become_links', async () => {
  const t = await typed('see https://example.org/log, then ');
  const text = bodyParas(t)[0].text;
  assert.equal((await charAt(t, 0, text.indexOf('https'))).link, 'https://example.org/log');
  assert.equal((await charAt(t, 0, text.indexOf(','))).link, undefined, 'trailing comma stays outside');
  await typ(t, 'more');
  assert.equal((await charAt(t, 0, bodyParas(t)[0].text.indexOf('more'))).link, undefined);
});

test('dashes', async () => {
  assert.equal(plain(await typed('a -- b and c - d and e--f and café--g ')), 'A – b and c – d and e—f and café—g ');
});

test('border_line_autoformat', async () => {
  let t = await typed('Above\n---\nBelow');
  assert.equal(plain(t), 'Above\nBelow');
  assert.equal(bodyParas(t)[0].props?.borders?.bottom?.style, 'single');
  assert.equal(bodyParas(t)[1].props?.borders ?? null, null);
  for (const [keys, style] of [['===', 'double'], ['***', 'dotted'], ['___', 'thick']]) {
    t = await typed(`x\n${keys}\n`);
    assert.equal(bodyParas(t)[0].props?.borders?.bottom?.style, style, keys);
  }
  t = await typed('---\nText');
  assert.equal(plain(t), '\nText');
  assert.ok(bodyParas(t)[0].props?.borders);
  assert.equal(bodyParas(t)[1].props?.borders ?? null, null);
});

test('undo_right_after_a_border_line_brings_the_characters_back', {todo: CHECKPOINT}, async () => {
  const t = await typed('Above\n---\n');
  assert.equal(plain(t), 'Above\n');
  await undo(t);
  assert.equal(plain(t), 'Above\n---\n');
});

test('tab_and_backspace_at_a_paragraph_start_set_its_indents', async () => {
  const t = await s(undefined, ac({tabIndent: true}));
  const indents = () => [bodyParas(t)[0].props?.indentLeft ?? null, bodyParas(t)[0].props?.indentFirst ?? null];
  await typ(t, 'Some text');
  await run(t, 'caret.docStart');
  await typ(t, '\t');
  assert.deepEqual(indents(), [null, 36]);
  await typ(t, '\t');
  assert.deepEqual(indents(), [36, 36]);
  assert.equal(plain(t), 'Some text');
  await typ(t, BACKSPACE);
  assert.deepEqual(indents(), [36, 0]);
  await typ(t, BACKSPACE + BACKSPACE);
  assert.deepEqual(indents(), [0, 0]);
  assert.equal(plain(t), 'Some text');
  await typ(t, '\t');
  await undo(t);
  assert.deepEqual(indents(), [0, 0]);
});

test('plus_and_hyphen_line_becomes_a_table', async () => {
  let t = await typed('+--+------+\nA');
  const tb = blocks(t)[0];
  assert.equal(tb.kind, 'table', JSON.stringify(paras(t)));
  assert.equal(tb.rows.length, 1);
  assert.equal(tb.grid.length, 2);
  assert.ok(Math.abs(tb.grid[1] / tb.grid[0] - 3) < 0.01, `widths follow the hyphens: ${tb.grid}`);
  assert.equal(tb.rows[0].cells[0].blocks[0].text, 'A', 'the caret is in the first cell');
  assert.ok(blocks(t)[1]?.kind === 'para' && blocks(t)[1].text === '', 'a paragraph follows the table');
  t = await typed('x +--+--+\n');
  assert.equal(plain(t), 'X +--+--+\n');
  t = await typed(`+${'-+'.repeat(64)}\n`);
  assert.ok(blocks(t).every(b => b.kind === 'para'));
});

test('two_enters_after_a_short_line_make_it_a_heading', async () => {
  const styled = t => bodyParas(t).map(p => [p.text, p.props?.style ?? null]);
  for (const [keys, style] of [['Introduction\n\nText', 'Heading1'], ['\tOur methods\n\nText', 'Heading2'], ['\t\tStep 2\n\nText', 'Heading3']]) {
    const t = await typed(keys, ac({headingStyles: true}));
    const text = keys.replace(/^\t+/, '').split('\n')[0];
    assert.deepEqual(styled(t), [[text, style], ['Text', null]], JSON.stringify(keys));
  }
  const t = await typed('One two three four five\n\n', ac({headingStyles: true}));
  assert.equal(bodyParas(t)[0].props?.style, 'Heading1');
  assert.deepEqual(styled(await typed('Introduction\nText', ac({headingStyles: true}))), [['Introduction', null], ['Text', null]]);
  for (const keys of ['One two three four five six\n\n', 'Dear Sir,\n\n', 'Is it?\n\n', '\t\t\tDeep\n\n', '* Item\n\n']) {
    const u = await typed(keys, ac({headingStyles: true}));
    assert.ok(bodyParas(u).every(p => !String(p.props?.style ?? '').startsWith('Heading')), JSON.stringify(keys));
  }
});

test('arrow_bullets', async () => {
  for (const [keys, bullet] of [['> ', String.fromCodePoint(0x27A2)], ['-> ', String.fromCodePoint(0x2794)], ['=> ', String.fromCodePoint(0x21E8)]]) {
    const t = await typed(`${keys}item\nnext`);
    assert.deepEqual(paras(t), [para('Item', 0), para('next', 0)], keys);
    assert.equal(labelAt(t, 0), bullet, keys);
  }
  const t = await typed('* a\n\n> b');
  assert.equal(labelAt(t, 0), '•');
  assert.equal(labelAt(t, 1), String.fromCodePoint(0x27A2));
});

test('smileys_are_replaced_inside_words_too', async () => {
  const [smile, frown, neutral] = [String.fromCodePoint(0x263A), String.fromCodePoint(0x2639), String.fromCodePoint(0x1F610)];
  assert.equal(plain(await typed('so ok:) sad:( meh:| :) fine:-) ')), `So ok${smile} sad${frown} meh${neutral} ${smile} fine${smile} `);
});

test('enter_right_after_starting_a_list_cancels_it', async () => {
  assert.deepEqual(paras(await typed('* \nPlain')), [para('Plain')]);
});

test('shift_enter_stays_inside_the_list_item', async () => {
  const t = await typed('* line one');
  await run(t, 'text.lineBreak');
  await typ(t, 'cont\ntwo');
  assert.deepEqual(paras(t), [para('Line one\ncont', 0), para('two', 0)]);
});

test('typing_then_selecting_then_typing_are_two_undo_steps', async () => {
  let t = await typed('alpha');
  await run(t, 'select.text', {text: 'ph'});
  await run(t, 'text.insert', {text: 'X'});
  assert.equal(bodyParas(t)[0].text, 'alXa');
  await undo(t);
  assert.equal(bodyParas(t)[0].text, 'alpha');
  const r = sel(t);
  assert.equal(bodyParas(t)[0].text.slice(Math.min(r.anchor.off, r.focus.off), Math.max(r.anchor.off, r.focus.off)), 'ph');
  assert.ok(t.doc.undo.size > 0);
  await undo(t);
  assert.equal(bodyParas(t)[0].text, '');
  // Uninterrupted typing (a read-only command in between included) is still one step.
  t = await typed('alpha');
  await run(t, 'edit.clipboardItems');
  await typ(t, 'X');
  await undo(t);
  assert.equal(bodyParas(t)[0].text, '');
});

test('backspace_at_the_start_of_the_document_is_not_an_edit', async () => {
  const t = await typed('alpha');
  await setSel(t, pos(0, 0));
  t.doc.dirty = false;
  const depth = undoDepth(t);
  await typ(t, BACKSPACE);
  assert.equal(undoDepth(t), depth, 'no undo step');
  assert.equal(t.doc.dirty, false, 'no unsaved changes');
  assert.equal(bodyParas(t)[0].text, 'alpha');
});

test('alt_x_toggles_between_a_character_and_its_code', async () => {
  const t = await s();
  assert.equal(t.registry.byShortcut?.('Alt+X')?.id ?? t.registry.get('text.toggleUnicode').shortcut, 'Alt+X');
  await run(t, 'text.insert', {text: 'x 00e9'});
  await run(t, 'text.toggleUnicode');
  assert.deepEqual(texts(t), ['x é']);
  await run(t, 'text.toggleUnicode');
  assert.deepEqual(texts(t), ['x 00e9']);
  await undo(t);
  assert.deepEqual(texts(t), ['x é'], 'one undo step');
  await run(t, 'text.insert', {text: ' U+1F600'});
  await run(t, 'text.toggleUnicode');
  assert.deepEqual(texts(t), [`x é ${String.fromCodePoint(0x1F600)}`]);
  await run(t, 'text.insert', {text: ' 2014'});
  await run(t, 'select.text', {text: '2014'});
  await run(t, 'text.toggleUnicode');
  assert.deepEqual(texts(t), [`x é ${String.fromCodePoint(0x1F600)} —`]);
});

test('alt_numpad_code_types_one_character', async () => {
  const raw = t => paras(t).map(p => p[0]);
  const t = await s();
  await run(t, 'text.insert', {text: 'caf'});
  await run(t, 'text.typeCode', {code: '0233'});
  await run(t, 'text.insert', {text: ' '});
  await run(t, 'text.typeCode', {code: '233', oem: 437});
  await run(t, 'text.insert', {text: ' '});
  await run(t, 'text.typeCode', {code: '155', oem: 850});
  assert.deepEqual(raw(t), ['Café Θ ø']);
  await undo(t);
  assert.deepEqual(raw(t), ['Café Θ '], 'one undo step per code');
  await assert.rejects(run(t, 'text.typeCode', {code: '0'}));
  await assert.rejects(run(t, 'text.typeCode', {code: '65', oem: 855}));
  await assert.rejects(run(t, 'text.typeCode', {code: '065', ansi: 932}));
  await assert.rejects(run(t, 'text.typeCode', {code: '065', ansi: 70000}));
  assert.deepEqual(raw(t), ['Café Θ ']);
  await run(t, 'text.typeCode', {code: '0185', ansi: 1250, oem: 852});
  await run(t, 'text.typeCode', {code: '165', ansi: 1250, oem: 852});
  await run(t, 'text.typeCode', {code: '143', oem: 866});
  assert.deepEqual(raw(t), ['Café Θ ąąП']);
});

test('shift_f5_goes_back_through_the_last_edits', async () => {
  const t = await typed('One\nTwo\nThree');
  await run(t, 'caret.docStart');
  const back = async () => { await run(t, 'edit.goBack', {}, 'shortcut'); return sel(t).focus; };
  assert.deepEqual(await back(), pos(2, 5), 'the last edit first');
  assert.deepEqual(await back(), pos(1, 3));
  assert.deepEqual(await back(), pos(0, 3));
  assert.deepEqual(await back(), pos(2, 5), 'then round again');
  await assert.rejects(run(await s(), 'edit.goBack'), /no edits/);
});

test('two_initial_capitals_are_corrected', async () => {
  assert.equal(plain(await typed('the WOrd and THe end, not IDs or CDs. TV is fine ')), 'The Word and The end, not IDs or CDs. TV is fine ');
  assert.equal(plain(await typed('TEh ')), 'The ');
  assert.equal(plain(await typed('WCraft ', ac({initialCapsExceptions: ['WCraft']}))), 'WCraft ');
});

test('accidental_caps_lock_is_corrected', async () => {
  assert.equal(plain(await typed('a wORD and hELLO there. iOS stays ')), 'A Word and Hello there. iOS stays ');
});

test('capitalisation_fixes_undo_and_turn_off', async () => {
  const t = await typed('x WOrd wORD ', ac({twoInitialCaps: false, capsLock: false}));
  assert.equal(plain(t), 'X WOrd wORD ');
});

test('first_letter_of_a_table_cell_is_capitalised', async () => {
  const cellText = (t, c) => blocks(t).find(b => b.kind === 'table')?.rows[0]?.cells[c]?.blocks[0]?.text;
  let t = await s();
  await run(t, 'insert.table', {rows: 1, cols: 2});
  await typ(t, 'apples and pears\tplums ');
  assert.equal(cellText(t, 0), 'Apples and pears');
  assert.equal(cellText(t, 1), 'Plums ');
  t = await s(undefined, ac({capCells: false}));
  await run(t, 'insert.table', {rows: 1, cols: 1});
  await typ(t, 'plums ');
  assert.equal(cellText(t, 0), 'plums ');
});

test('typing_over_a_selection_follows_the_replace_selection_option', async () => {
  let t = await typed('One two');
  await run(t, 'select.text', {text: 'two'});
  await typ(t, 'X');
  assert.equal(plain(t), 'One X');
  t = await typed('One two', {prefs: {typingReplacesSelection: false}});
  await run(t, 'select.text', {text: 'two'});
  await typ(t, 'XY');
  assert.equal(plain(t), 'One XYtwo');
});

test('overtype_replaces_the_characters_after_the_caret (the Overtype option)', async () => {
  const t = await typed('Abcdef\nXy');
  t.session.prefs = {...t.session.prefs, overtype: true};
  await setSel(t, pos(0, 1));
  await typ(t, 'XY');
  assert.equal(plain(t), 'AXYdef\nXy');
  await setSel(t, pos(0, 5));
  await typ(t, '123');
  assert.equal(plain(t), 'AXYde123\nXy', "the paragraph mark isn't typed over");
});

test('plain_text_paste_keeps_an_empty_paragraph_in_a_list', async () => {
  for (const [id, v] of [['edit.pasteText', {text: 'A\n\nB'}], ['edit.pasteSpecial', {as: 'text', text: 'A\n\nB'}], ['edit.paste', {text: 'A\n\nB'}]]) {
    const t = await s();
    await run(t, 'para.bullets');
    await run(t, id, v);
    assert.deepEqual(paras(t), [para('A', 0), para('', 0), para('B', 0)], id);
  }
  const t = await s();
  await run(t, 'para.bullets');
  await typ(t, 'A\n\nB');
  assert.deepEqual(paras(t), [para('A', 0), para('B')]);
});

test('plain_text_paste_keeps_empty_lines_as_paragraphs', async () => {
  const t = await s();
  await run(t, 'text.insert', {text: 'Lead ', raw: true});
  await run(t, 'select.all');
  await run(t, 'format.bold');
  await run(t, 'caret.docEnd');
  await run(t, 'para.alignCenter');
  const props = bodyParas(t)[0].props;
  await run(t, 'edit.paste', {text: 'Alpha one.\n\nAlpha two.\n\n\nAlpha three.\n'});
  assert.deepEqual(bodyParas(t).map(p => p.text), ['Lead Alpha one.', '', 'Alpha two.', '', '', 'Alpha three.', '']);
  assert.ok(bodyParas(t).every(p => JSON.stringify(p.props) === JSON.stringify(props)));
  assert.deepEqual(sel(t).focus, pos(6, 0), 'the caret ends after the pasted text');
  assert.ok(bodyParas(t).every(p => p.runs.every(r => r.props?.bold === true)), 'the pasted text takes the bold before the caret');
});

test('ctrl_tab_inserts_a_tab_inside_a_table_cell', async () => {
  const t = await s();
  await run(t, 'insert.table', {rows: 1, cols: 2});
  await typ(t, 'A');
  await run(t, 'text.insertTab');
  await typ(t, 'B');
  const f = sel(t).focus;
  assert.deepEqual(f.path.slice(-3, -1), [0, 0], 'Ctrl+Tab stays in the cell');
  assert.equal(blocks(t)[0].rows[0].cells[0].blocks[0].text, 'A\tB');
  assert.deepEqual([].concat(t.registry.get('text.insertTab').shortcut), ['Mod+Tab']);
});

test('tab_with_a_whole_paragraph_selected_indents_it', async () => {
  const t = await typed('Hello world');
  await run(t, 'select.paragraph');
  const selected = t.doc.selection;
  const depth = undoDepth(t);
  await run(t, 'text.tab');
  assert.deepEqual(paras(t), [para('Hello world')]);
  assert.equal(bodyParas(t)[0].props?.indentLeft, 36);
  assert.deepEqual(t.doc.selection, selected, 'the whole paragraph stays selected');
  assert.equal(undoDepth(t), depth + 1);
  await undo(t);
  assert.equal(bodyParas(t)[0].props?.indentLeft ?? null, null);
  assert.deepEqual(t.doc.selection, selected);
});

test('tab_with_a_partial_selection_still_inserts_a_tab', async () => {
  const t = await typed('Hello world');
  await run(t, 'select.text', {text: 'ello'});
  await run(t, 'text.tab');
  assert.deepEqual(paras(t), [para('H\t world')]);
});

test('double_space_adds_a_period_when_asked', async () => {
  const opt = keys => typed(keys, ac({doubleSpacePeriod: true}));
  assert.equal(plain(await typed('Hello  world')), 'Hello  world');
  assert.equal(plain(await opt('Hello  world')), 'Hello. world');
  assert.equal(plain(await opt('Hello  world ')), 'Hello. World ');
  assert.equal(plain(await opt('See page 5  Then')), 'See page 5. Then');
  assert.equal(plain(await opt('(it is done)  Next')), '(it is done). Next');
  assert.equal(plain(await opt('He said "stop"  Next')), 'He said “stop”. Next');
  for (const keys of ['Hello.  x', 'Hello,  x', 'Hello?  x', 'Hello;  x', 'Hello:  x', 'Hello x', '  x', '\n  x', 'a\t  x']) {
    assert.equal(plain(await opt(keys)), plain(await typed(keys)), JSON.stringify(keys));
  }
  assert.equal(plain(await opt('Hello   x')), 'Hello.  x');
  const t = await typed('Hello  world', ac({doubleSpacePeriod: true, enabled: false}));
  assert.equal(plain(t), 'Hello  world');
});

test('a_large_mixed_document_types_like_word', async () => {
  const t = await s();
  const prose = "The keeper's log runs to four hundred pages, and almost every one begins with the weather. ";
  await typ(t, `Notes\n${prose.repeat(3)}\n`);
  await typ(t, 'The supplies were:\n* Lamp oil, 1/2 barrel\nWicks of the 1st quality\n\tSpare chimneys\nSpare springs\n');
  await run(t, 'text.backTab');
  await typ(t, 'Salt beef\n\nThe schedule:\n1. Signal the boat\nLower the stores\n\tCheck the net\n');
  await run(t, 'text.backTab');
  await typ(t, 'Sign the manifest\n\n---\nIn March the storm broke -- and he slept.\n');
  await typ(t, 'a. Inspect the glass\nReplace the seals\n\n');
  await typ(t, `Afterword. teh keeper retired. ${prose}\n* one more\nsecond\n\n\nFinal.`);
  const got = paras(t).map(([x, l]) => [[...x].slice(0, 24).join(''), l]);
  assert.deepEqual(got, [
    ['Notes', null], ['The keeper’s log runs to', null], ['The supplies were:', null], ['Lamp oil, ½ barrel', 0], ['Wicks of the 1st quality', 0],
    ['Spare chimneys', 1], ['Spare springs', 1], ['Salt beef', 0], ['The schedule:', null], ['Signal the boat', 0], ['Lower the stores', 0],
    ['Check the net', 1], ['Sign the manifest', 0], ['In March the storm broke', null], ['Inspect the glass', 0], ['Replace the seals', 0],
    ['Afterword. The keeper re', null], ['One more', 0], ['Second', 0], ['', null], ['Final.', null],
  ]);
  for (const [x, l, lp] of paras(t)) assert.ok(l !== null || !lp, `${x} still a List Paragraph`);
});
