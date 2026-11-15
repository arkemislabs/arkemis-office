// U:quill/format — character formatting (Home › Font) on schema-2 documents.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/format.rs (specs 17-153, `target` 157, `apply` 199,
//    `resolved` 234, `toggle` 285, `underline` 293, `font` 306, `size` 339, `step_size` 356,
//    `highlight` 459, `change_case` 482, `clear` 755, `reset_char` 776, `set` 790, `state` 801,
//    `enclose` 894). Word: Home › Font buttons act on the selection or the word at the caret;
//    between words they arm the formatting for what is typed next; Grow/Shrink Font step through
//    the size list; Shift+F3 cycles lower → UPPER → Title; Clear All Formatting also resets the
//    paragraph to Normal.
// 2. Ours runs the same algorithms on the schema-2 model (core/quill/commands/format.mjs over
//    lib/format-target.mjs): one undoable model op per command, the selection kept, pending caret
//    formatting kept as view state the ribbon reads. Gap (openIssues): arming caret formatting is
//    not an undo step (upstream #23 test), because kernel undo covers content only.
// 3. Proof: this file (engine, undo round trips, bridge-origin validation), the upstream ports in
//    tests/quill/upstream/format_*.test.mjs, and tests/e2e/quill/format-home.e2e.mjs (ribbon).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {quill} from './format-fixture.mjs';
import {convertCase, parseHighlight, isEastAsianFont, SIZES} from '../../core/quill/commands/format.mjs';

const pick = (runs, ...keys) => runs.map(([t, c]) => [t, Object.fromEntries(keys.filter(k => c[k] !== undefined).map(k => [k, c[k]]))]);

test('format.bold on a selection: undo round trip, both scripts, toggles back', async () => {
  const q = await quill('Hello world');
  q.sel(0, 0, 5);
  assert.deepEqual(q.state('format.bold'), {enabled: true, checked: false});
  const r = await expectUndoRoundTrip(q.t, 'format.bold', {}, after => {
    const runs = after.content.body.chunks[0][0].runs;
    assert.deepEqual(runs[0], {len: 5, props: {bold: true, boldCs: true}});
  });
  assert.equal(r.result.value, true);
  assert.equal(q.state('format.bold').checked, true, 'redo left it bold');
  await q.exec('format.bold');
  // Off is an explicit false (it overrides a bold style), as upstream sets `Some(false)`.
  assert.deepEqual(q.runs(0), [['Hello', {bold: false, boldCs: false}], [' world', {}]]);
  assert.equal(q.state('format.bold').checked, false);
});

test('italic toggles off only when every targeted run has it; value sets explicitly', async () => {
  const q = await quill('abcd');
  q.sel(0, 0, 2);
  await q.exec('format.italic');
  q.sel(0, 0, 4);
  assert.equal(q.state('format.italic').checked, false);
  await q.exec('format.italic');
  assert.deepEqual(pick(q.runs(0), 'italic'), [['abcd', {italic: true}]]);
  await q.exec('format.italic');
  assert.deepEqual(pick(q.runs(0), 'italic'), [['abcd', {italic: false}]]);
  await q.exec('format.italic', {value: false});
  assert.deepEqual(pick(q.runs(0), 'italic'), [['abcd', {italic: false}]]);
});

test('a caret inside a word formats the word (not its trailing space); between words it arms the typing formatting', async () => {
  const q = await quill('one two three');
  q.sel(0, 5);
  await q.exec('format.bold');
  assert.deepEqual(pick(q.runs(0), 'bold'), [['one ', {}], ['two', {bold: true}], [' three', {}]]);
  const u = await quill('one two');
  u.sel(0, 4);
  const before = structuredClone(u.t.content);
  const r = await u.exec('format.bold');
  assert.equal(r.result.pending, true);
  assert.deepEqual(u.t.content, before, 'arming the caret is not a document change');
  assert.equal(u.state('format.bold').checked, true, 'the ribbon shows what typing will get');
  assert.deepEqual(u.t.doc.view.pendingFormat.props, {bold: true, boldCs: true});
  // Moving the caret makes the armed formatting stale, as upstream clears `pending`.
  u.sel(0, 1);
  assert.equal(u.state('format.bold').checked, false);
});

test('an empty paragraph takes the formatting on its mark (so it shows the new size)', async () => {
  const q = await quill('text\n');
  q.sel(1, 0);
  await expectUndoRoundTrip(q.t, 'format.size', {size: 20}, after => {
    assert.deepEqual(after.content.body.chunks[0][1].mark, {size: 20, sizeCs: 20});
  });
});

test('format.underline: a style turns it on, value:false clears it, word and double shortcuts', async () => {
  const q = await quill('Hello world');
  q.sel(0, 6, 11);
  await q.exec('format.underline', {style: 'wave'});
  assert.deepEqual(pick(q.runs(0), 'underline'), [['Hello ', {}], ['world', {underline: 'wave'}]]);
  assert.deepEqual(q.state('format.underline'), {enabled: true, checked: true, value: 'wave'});
  await q.exec('format.underline', {value: false});
  assert.deepEqual(pick(q.runs(0), 'underline'), [['Hello ', {}], ['world', {underline: 'none'}]]);
  await q.exec('format.underline');
  assert.equal(q.runs(0)[1][1].underline, 'single');
  await q.exec('format.doubleUnderline');
  assert.equal(q.runs(0)[1][1].underline, 'double');
  await q.exec('format.wordUnderline');
  assert.equal(q.runs(0)[1][1].underline, 'words');
  assert.equal(q.state('format.wordUnderline').checked, true);
});

test('every toggle in the family sets its property and round-trips through undo', async () => {
  const cases = [
    ['format.strikethrough', c => c.strike === true], ['format.doubleStrikethrough', c => c.doubleStrike === true],
    ['format.subscript', c => c.vertAlign === 'subscript'], ['format.superscript', c => c.vertAlign === 'superscript'],
    ['format.allCaps', c => c.caps === true], ['format.smallCaps', c => c.smallCaps === true], ['format.hidden', c => c.hidden === true],
    ['format.outline', c => c.outline === true], ['format.shadow', c => c.shadow === true], ['format.emboss', c => c.emboss === true],
    ['format.engrave', c => c.engrave === true], ['format.border', c => c.border?.style === 'single' && c.border.width === 0.5],
  ];
  for (const [id, ok] of cases) {
    const q = await quill('abc def');
    q.sel(0, 0, 3);
    await expectUndoRoundTrip(q.t, id, {}, after => assert.ok(ok(after.content.body.chunks[0][0].runs[0].props), id));
    assert.equal(q.state(id).checked, true, id);
    await q.exec(id);
    assert.equal(q.state(id).checked, false, `${id} toggles off`);
  }
  // Subscript and superscript replace each other.
  const q = await quill('x2');
  q.sel(0, 1, 2);
  await q.exec('format.superscript');
  await q.exec('format.subscript');
  assert.equal(q.runs(0)[1][1].vertAlign, 'subscript');
  assert.equal(q.state('format.superscript').checked, false);
});

test('format.font: name sets Latin and complex-script fonts; a CJK font also sets the East Asian font; eastAsia alone', async () => {
  const q = await quill('abc');
  q.sel(0, 0, 3);
  await expectUndoRoundTrip(q.t, 'format.font', {name: 'Georgia'}, after => {
    assert.deepEqual(after.content.body.chunks[0][0].runs[0].props, {font: 'Georgia', fontCs: 'Georgia'});
  });
  await q.exec('format.font', {name: 'Yu Gothic'});
  assert.deepEqual(pick(q.runs(0), 'font', 'fontCs', 'fontEa'), [['abc', {font: 'Yu Gothic', fontCs: 'Yu Gothic', fontEa: 'Yu Gothic'}]]);
  await q.exec('format.font', {eastAsia: 'SimSun'});
  assert.equal(q.runs(0)[0][1].fontEa, 'SimSun');
  assert.equal(q.runs(0)[0][1].font, 'Yu Gothic');
  assert.deepEqual(q.state('format.font'), {enabled: true, value: 'Yu Gothic'});
  await assert.rejects(q.t.bridge('format.font', {}), /name|eastAsia/);
  await assert.rejects(q.t.bridge('format.font', {name: '   '}), /bad font name/);
  assert.equal(isEastAsianFont('Malgun Gothic'), true);
  assert.equal(isEastAsianFont('Calibri'), false);
});

test('format.size rounds to half points and refuses out-of-range sizes; grow/shrink step through Word\'s list', async () => {
  const q = await quill('abc');
  q.sel(0, 0, 3);
  await q.exec('format.size', {size: 13.3});
  assert.equal(q.runs(0)[0][1].size, 13.5);
  assert.equal(q.state('format.size').value, 13.5);
  await assert.rejects(q.t.bridge('format.size', {size: 0}), /between 1 and 1638/);
  await assert.rejects(q.t.bridge('format.size', {size: 'big'}), /invalid|number/i);
  await q.exec('format.growFont');
  assert.equal(q.runs(0)[0][1].size, 14);
  await q.exec('format.growFont');
  assert.equal(q.runs(0)[0][1].size, 16);
  await q.exec('format.shrinkFont');
  assert.equal(q.runs(0)[0][1].size, 14);
  await q.exec('format.size', {size: 72});
  await q.exec('format.growFont');
  assert.equal(q.runs(0)[0][1].size, 80, 'past 72 grows to the next ten');
  await q.exec('format.growFont1');
  assert.equal(q.runs(0)[0][1].size, 81);
  await q.exec('format.shrinkFont1');
  assert.equal(q.runs(0)[0][1].size, 80);
  await q.exec('format.size', {size: 8});
  await q.exec('format.shrinkFont');
  assert.equal(q.runs(0)[0][1].size, 1, 'below the list: 1 pt');
  assert.deepEqual(SIZES.slice(0, 4), [8, 9, 10, 10.5]);
});

test('font colour, underline colour and character shading take hex (with or without #) and auto', async () => {
  const q = await quill('abc');
  q.sel(0, 0, 3);
  await expectUndoRoundTrip(q.t, 'format.color', {color: '#C00000'}, after => {
    assert.deepEqual(after.content.body.chunks[0][0].runs[0].props.color, {Rgb: [192, 0, 0]});
  });
  await q.exec('format.color', {color: '00B050'});
  assert.deepEqual(q.runs(0)[0][1].color, {Rgb: [0, 176, 80]});
  await q.exec('format.color', {color: 'auto'});
  assert.equal(q.runs(0)[0][1].color, 'Auto');
  await assert.rejects(q.t.bridge('format.color', {color: 'blue'}), /RRGGBB or auto/);
  await q.exec('format.underline');
  await q.exec('format.underlineColor', {color: 'FF0000'});
  assert.deepEqual(q.runs(0)[0][1].underlineColor, [255, 0, 0]);
  assert.equal(q.runs(0)[0][1].underline, 'single', 'the style stays');
  await q.exec('format.underlineColor', {color: 'auto'});
  assert.equal(q.runs(0)[0][1].underlineColor, undefined);
  await q.exec('format.shading', {color: 'D9D9D9'});
  assert.deepEqual(q.runs(0)[0][1].shading, [217, 217, 217]);
  await q.exec('format.shading', {color: null});
  assert.equal(q.runs(0)[0][1].shading, undefined);
});

test('format.highlight: a colour sets it; omitted toggles the last colour off only when all of it has it', async () => {
  const q = await quill('one two');
  q.sel(0, 0, 3);
  await expectUndoRoundTrip(q.t, 'format.highlight', {color: 'brightGreen'}, after => {
    assert.equal(after.content.body.chunks[0][0].runs[0].props.highlight, 'brightGreen');
  });
  await q.exec('format.highlight', {color: 'Turquoise'});
  assert.equal(q.t.doc.view.lastHighlight, 'turquoise');
  assert.equal(q.state('format.highlight').value, '#00FFFF');
  // The shortcut (no colour) on text that all has the last colour takes it off.
  await q.exec('format.highlight');
  assert.equal(q.runs(0)[0][1].highlight, 'none');
  // On mixed text it applies the last colour to all of it.
  q.sel(0, 0, 7);
  await q.exec('format.highlight');
  assert.deepEqual(q.runs(0).map(([, c]) => c.highlight), ['turquoise']);
  await q.exec('format.highlight', {color: 'none'});
  assert.deepEqual(q.runs(0).map(([, c]) => c.highlight), ['none']);
  await assert.rejects(q.t.bridge('format.highlight', {color: 'mauve'}), /unknown highlight/);
  assert.equal(parseHighlight('#FFFF00'), 'yellow');
  assert.equal(parseHighlight('cyan'), 'turquoise');
  assert.equal(parseHighlight('Gray-25%'), 'gray25');
  assert.equal(parseHighlight('#123456'), null);
});

test('format.changeCase: modes, Shift+F3 cycle, selection kept when lengths change, each run keeps its formatting', async () => {
  const q = await quill('hello world. again');
  q.sel(0, 0, 18);
  await expectUndoRoundTrip(q.t, 'format.changeCase', {mode: 'upper'}, after => {
    assert.equal(after.content.body.chunks[0][0].text, 'HELLO WORLD. AGAIN');
  });
  await q.exec('format.changeCase', {mode: 'sentence'});
  assert.equal(q.texts()[0], 'Hello world. Again');
  await q.exec('format.changeCase', {mode: 'title'});
  assert.equal(q.texts()[0], 'Hello World. Again');
  // Shift+F3 (no mode): Title → lower → UPPER → Title.
  await q.exec('format.changeCase');
  assert.equal(q.texts()[0], 'hello world. again');
  await q.exec('format.changeCase');
  assert.equal(q.texts()[0], 'HELLO WORLD. AGAIN');
  await q.exec('format.changeCase');
  assert.equal(q.texts()[0], 'Hello World. Again');
  // ß → SS lengthens the text: the selection still covers it, and the bold run stays bold.
  const s = await quill('straße x');
  s.sel(0, 0, 3);
  await s.exec('format.bold');
  s.sel(0, 0, 6);
  await s.exec('format.changeCase', {mode: 'upper'});
  assert.equal(s.texts()[0], 'STRASSE x');
  assert.deepEqual(pick(s.runs(0), 'bold'), [['STR', {bold: true}], ['ASSE x', {}]]);
  assert.match(s.t.doc.selection.ranges[0].focus, /t:7$/);
  // A caret inside a word changes that word.
  const w = await quill('one two');
  w.sel(0, 5);
  await w.exec('format.changeCase', {mode: 'upper'});
  assert.equal(w.texts()[0], 'one TWO');
});

test('format.changeCase under Track Changes is a tracked deletion of the old letters and an insertion of the new', async () => {
  const q = await quill('abc', c => ({...c, settings: {...c.settings, trackChanges: true}}));
  q.sel(0, 0, 3);
  await q.exec('format.changeCase', {mode: 'upper'});
  assert.equal(q.texts()[0], 'abcABC');
  const runs = q.runs(0);
  assert.equal(runs[0][0], 'abc');
  assert.equal(typeof runs[0][1].del, 'number');
  assert.equal(runs[1][0], 'ABC');
  assert.equal(typeof runs[1][1].ins, 'number');
  assert.deepEqual(q.t.content.revisions.map(r => r.kind), ['delete', 'insert']);
});

test('Clear All Formatting resets characters and paragraphs to Normal; Reset Character Formatting keeps the character style', async () => {
  const q = await quill('Hello world');
  q.sel(0, 0, 11);
  await q.exec('format.bold');
  await q.exec('format.charStyle', {style: 'Strong'});
  await q.exec('para.style', {style: 'Heading 1'});
  q.sel(0, 0, 11);
  await q.exec('format.resetChar');
  assert.deepEqual(pick(q.runs(0), 'bold', 'style'), [['Hello world', {style: 'Strong'}]]);
  assert.equal(q.props(0).style, 'Heading1', 'the paragraph style stays');
  await expectUndoRoundTrip(q.t, 'format.clear', {}, after => {
    const p = after.content.body.chunks[0][0];
    assert.equal(p.props, undefined);
    assert.equal(p.runs[0].props, undefined);
  });
});

test('character spacing, scale, position, character style and format.set (both scripts) clamp as upstream', async () => {
  const q = await quill('abc');
  q.sel(0, 0, 3);
  await q.exec('format.spacing', {points: 250});
  await q.exec('format.scale', {percent: 0});
  await q.exec('format.position', {points: -3});
  assert.deepEqual(pick(q.runs(0), 'spacing', 'scale', 'position'), [['abc', {spacing: 100, scale: 1, position: -3}]]);
  await q.exec('format.charStyle', {style: 'Emphasis'});
  assert.equal(q.runs(0)[0][1].style, 'Emphasis');
  await assert.rejects(q.t.bridge('format.charStyle', {style: 'Nope'}), /no style/);
  await expectUndoRoundTrip(q.t, 'format.set', {props: {size: 18, bold: true, color: 'FF0000', kern: 14}}, after => {
    const c = after.content.body.chunks[0][0].runs[0].props;
    assert.deepEqual([c.size, c.sizeCs, c.bold, c.boldCs, c.color, c.kern], [18, 18, true, true, {Rgb: [255, 0, 0]}, 14]);
  });
  await assert.rejects(q.t.bridge('format.set', {props: {sparkle: true}}), /unknown character property/);
});

test('format.state reports the Font group (mixed values null), format.fontDialog names the dialog', async () => {
  const q = await quill('ab');
  q.sel(0, 0, 1);
  await q.exec('format.size', {size: 20});
  q.sel(0, 0, 2);
  const st = (await q.exec('format.state')).result;
  assert.equal(st.size, null, 'mixed');
  assert.equal(st.font, 'Aptos');
  assert.equal(st.style, 'Normal');
  assert.equal(st.styleName, 'Normal');
  assert.equal(st.bold, false);
  const r = await q.exec('format.fontDialog');
  assert.equal(r.result.open, 'font');
  assert.equal(q.t.registry.get('format.fontDialog').dialog, 'dialog.font');
});

test('format.enclose makes an EQ \\o field and takes it back out', async () => {
  const q = await quill('a字b');
  q.sel(0, 1, 2);
  await expectUndoRoundTrip(q.t, 'format.enclose', {shape: 'circle'}, after => {
    const p = after.content.body.chunks[0][0];
    assert.equal(p.text, 'a￼b');
    assert.equal(p.objects[0].type, 'field');
    assert.match(p.objects[0].instr, /^eq \\o\\ac\(○,字\)$/);
  });
  await q.exec('format.enclose', {shape: 'square', style: 'enlarge'});
  q.sel(0, 1, 2);
  await q.exec('format.enclose', {shape: null});
  assert.equal(q.texts()[0], 'a字b');
  q.sel(0, 0, 3);
  await assert.rejects(q.t.bridge('format.enclose', {shape: 'circle'}), /one full-width character/);
  await assert.rejects(q.t.bridge('format.enclose', {}), /shape/);
});

test('every format command is disabled with a reason on a schema-1 document', async () => {
  const {createTestSession} = await import('../../core/kernel/testing.mjs');
  const t = await createTestSession('quill', {content: {doc: {type: 'doc', content: [{type: 'paragraph'}]}}});
  for (const id of ['format.bold', 'format.size', 'format.changeCase', 'format.clear']) {
    assert.deepEqual(t.state(id), {enabled: false, reason: 'This document has not been converted to the new Quill format yet'}, id);
  }
});

test('upstream helpers: convert, sentence case keeps decimal points', () => {
  assert.equal(convertCase('one 3.14 apples', 'sentence', true), 'One 3.14 apples');
});
