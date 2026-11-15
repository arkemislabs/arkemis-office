// U:quill/format — paragraph formatting and lists (Home › Paragraph, Layout › Paragraph).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/para.rs (specs 28-265) and para/format.rs
//    (`cur` 4, `fmt` 19, `align` 31, `direction` 54, `tog` 61, `set_props` 99, `indent` 138,
//    `outdent` 163), para/lists.rs (`list` 5, `restart_numbering` 73, `list_buttons` 196),
//    para/outline.rs (`move_paras` 10, `outline_step` 107, `sort` 159), para/tabs_borders.rs
//    (`tabs` 8, `border_sides` 66, `borders` 85). Word: alignment buttons act on every selected
//    paragraph (clicking the active one returns to the start edge), Increase Indent moves to the
//    next default tab or a list level down, Bullets/Numbering toggle and continue the list above,
//    Alt+Shift+Up/Down move paragraphs, Sort orders paragraphs (numbers first).
// 2. Ours runs the same algorithms over schema-2 paragraphs (core/quill/commands/para.mjs, one
//    undoable op each, selection following moved paragraphs); not translated: Outline view's
//    collapsed headings and column/whole-cell selections (openIssues).
// 3. Proof: this file, tests/quill/upstream/para_*.test.mjs, tests/e2e/quill/format-home.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {quill} from './format-fixture.mjs';

test('alignment buttons: every selected paragraph, the active one returns to the start edge, state follows', async () => {
  const q = await quill('one\ntwo\nthree');
  q.sel([0, 1], [1, 2]);
  await expectUndoRoundTrip(q.t, 'para.alignCenter', {}, after => {
    const [a, b, c] = after.content.body.chunks[0];
    assert.deepEqual([a.props?.align, b.props?.align, c.props?.align], ['center', 'center', undefined]);
  });
  assert.equal(q.state('para.alignCenter').checked, true);
  assert.equal(q.state('para.alignLeft').checked, false);
  await q.exec('para.alignCenter');
  assert.equal(q.props(0).align, 'left', 'clicking the active alignment goes back to the start edge');
  for (const [id, a] of [['para.alignRight', 'right'], ['para.justify', 'justify'], ['para.distribute', 'distribute']]) {
    await q.exec(id);
    assert.equal(q.props(1).align, a, id);
  }
  await q.exec('para.align', {value: 'center'});
  await q.exec('para.align', {value: 'center'});
  assert.equal(q.props(0).align, 'center', 'para.align sets, never toggles');
  await q.exec('para.align', {value: 'end'});
  assert.equal(q.props(0).align, 'right');
});

test('a selection ending at the next paragraph\'s start does not format that paragraph (#418)', async () => {
  const q = await quill('one\ntwo');
  q.sel([0, 0], [1, 0]);
  await q.exec('para.alignCenter');
  assert.deepEqual([q.props(0).align, q.props(1).align], ['center', undefined]);
  assert.equal(q.state('para.alignCenter').checked, true, 'the state comes from the last paragraph it covers');
});

test('right-to-left: Align Right in an RTL paragraph is its start edge; rtl/ltr set the direction only', async () => {
  const q = await quill('שלום');
  q.sel(0, 0);
  await q.exec('para.rtl');
  assert.equal(q.props(0).bidi, true);
  assert.equal(q.state('para.rtl').checked, true);
  assert.equal(q.state('para.alignRight').checked, true, 'logical left shows as right in RTL');
  await q.exec('para.alignLeft');
  assert.equal(q.props(0).align, 'right', 'visual left is the logical end of an RTL paragraph');
  await q.exec('para.ltr');
  assert.equal(q.props(0).bidi, false);
  await q.exec('para.rtl', {value: false});
  assert.equal(q.props(0).bidi, false);
});

test('indents: increase/decrease to default tabs; list items change level; hanging; para.indents clamps', async () => {
  const q = await quill('a');
  q.sel(0, 0);
  await expectUndoRoundTrip(q.t, 'para.indent', {}, after => assert.equal(after.content.body.chunks[0][0].props.indentLeft, 36));
  await q.exec('para.indent');
  assert.equal(q.props(0).indentLeft, 72);
  await q.exec('para.outdent');
  assert.equal(q.props(0).indentLeft, 36);
  await q.exec('para.hangingIndent');
  assert.deepEqual([q.props(0).indentLeft, q.props(0).indentFirst], [72, -36]);
  await q.exec('para.removeHanging');
  assert.deepEqual([q.props(0).indentLeft, q.props(0).indentFirst], [36, 0]);
  await q.exec('para.indents', {left: 5000, right: 10, firstLine: -12});
  assert.deepEqual([q.props(0).indentLeft, q.props(0).indentRight, q.props(0).indentFirst], [1584, 10, -12]);
  await q.exec('para.bullets');
  await q.exec('para.indent');
  assert.equal(q.props(0).numbering.level, 1, 'a list item goes down a level');
  await q.exec('para.outdent');
  assert.equal(q.props(0).numbering.level, 0);
});

test('line spacing: multiples, at least, exactly; the menu shows the current one; space before/after toggles', async () => {
  const q = await quill('a');
  q.sel(0, 0);
  await expectUndoRoundTrip(q.t, 'para.lineSpacing', {value: 1.5}, after => {
    assert.deepEqual(after.content.body.chunks[0][0].props.lineSpacing, {rule: 'multiple', value: 1.5});
  });
  assert.equal(q.state('para.lineSpacing', {value: 1.5}).checked, true);
  assert.equal(q.state('para.lineSpacing', {value: 2}).checked, false);
  await q.exec('para.lineSpacing', {atLeast: 14});
  assert.deepEqual(q.props(0).lineSpacing, {rule: 'atLeast', value: 14});
  await q.exec('para.lineSpacing', {exactly: 0.1});
  assert.deepEqual(q.props(0).lineSpacing, {rule: 'exactly', value: 0.7});
  await assert.rejects(q.t.bridge('para.lineSpacing', {}), /value/);
  for (const [id, v] of [['para.single', 1], ['para.double', 2], ['para.oneAndHalf', 1.5]]) {
    await q.exec(id);
    assert.deepEqual(q.props(0).lineSpacing, {rule: 'multiple', value: v}, id);
  }
  await q.exec('para.addSpaceBefore');
  assert.equal(q.props(0).spaceBefore, 12);
  await q.exec('para.addSpaceBefore');
  assert.equal(q.props(0).spaceBefore, 0);
  await q.exec('para.removeSpaceAfter');
  assert.equal(q.props(0).spaceAfter, 0, 'Normal has 8 pt after: removed');
  await q.exec('para.removeSpaceAfter');
  assert.equal(q.props(0).spaceAfter, 8);
  await q.exec('para.spacing', {before: 6, after: 3});
  assert.deepEqual([q.props(0).spaceBefore, q.props(0).spaceAfter], [6, 3]);
});

test('para.reset keeps the style, list and drop cap; shading and the Line and Page Breaks toggles', async () => {
  const q = await quill('a');
  q.sel(0, 0);
  await q.exec('para.style', {style: 'Quote'});
  await q.exec('para.alignRight');
  await q.exec('para.shading', {color: 'FFFF00'});
  assert.deepEqual(q.props(0).shading, [255, 255, 0]);
  await expectUndoRoundTrip(q.t, 'para.reset', {}, after => assert.deepEqual(after.content.body.chunks[0][0].props, {style: 'Quote'}));
  for (const [id, k] of [['para.keepNext', 'keepNext'], ['para.keepLines', 'keepLines'], ['para.pageBreakBefore', 'pageBreakBefore']]) {
    await q.exec(id);
    assert.equal(q.props(0)[k], true, id);
    assert.equal(q.state(id).checked, true, id);
    await q.exec(id, {value: true});
    assert.equal(q.props(0)[k], true, `${id} value:true stays on`);
    await q.exec(id);
    assert.equal(q.props(0)[k], false, `${id} toggles off`);
  }
  assert.equal(q.state('para.widowControl').checked, true, 'Word turns widow control on by default');
  await q.exec('para.widowControl', {value: false});
  assert.equal(q.state('para.widowControl').checked, false);
});

test('bullets and numbering toggle, continue the list above, reuse a bullet list, and the buttons show the paragraph\'s own level', async () => {
  const q = await quill('a\nb\nc');
  q.sel(0, 0);
  await expectUndoRoundTrip(q.t, 'para.bullets', {}, after => {
    const p = after.content.body.chunks[0][0];
    assert.equal(p.props.style, 'ListParagraph');
    assert.equal(p.props.numbering.level, 0);
  });
  assert.equal(q.state('para.bullets').checked, true);
  assert.equal(q.state('para.numbering').checked, false);
  q.sel(1, 0);
  await q.exec('para.bullets');
  assert.equal(q.props(1).numbering.num, q.props(0).numbering.num, 'continues the list above');
  q.sel(1, 0);
  await q.exec('para.bullets');
  assert.deepEqual(q.props(1).numbering, {num: 0, level: 0}, 'toggled off: explicitly not in a list');
  assert.equal(q.props(1).style, undefined, 'List Paragraph goes back to Normal');
  q.sel(2, 0);
  await q.exec('para.numbering', {kind: 'upperLetter'});
  const n = q.props(2).numbering.num;
  assert.equal(q.state('para.numbering').checked, true);
  assert.deepEqual(q.labels(), ['•', null, 'A.']);
  await q.exec('para.numbering', {off: true});
  assert.deepEqual(q.props(2).numbering, {num: 0, level: 0});
  assert.notEqual(n, 0);
  await q.exec('para.bullets', {kind: '✓'});
  assert.equal(q.labels()[2], '✓');
  await q.exec('para.multilevel');
  assert.equal(q.state('para.multilevel').checked, true);
  await assert.rejects(q.t.bridge('para.numbering', {kind: 'squiggle'}), /must be one of/);
});

test('change list level, restart at 1 and the disabled reasons outside a list', async () => {
  const q = await quill('a\nb\nc');
  q.sel([0, 0], [2, 1]);
  await q.exec('para.numbering');
  assert.deepEqual(q.labels(), ['1.', '2.', '3.']);
  q.sel(1, 0);
  await q.exec('para.listLevel', {level: 1});
  assert.deepEqual(q.labels(), ['1.', 'a.', '2.']);
  assert.equal(q.state('para.listLevel', {level: 1}).checked, true);
  q.sel(2, 0);
  await expectUndoRoundTrip(q.t, 'para.restartNumbering', {}, () => {});
  assert.deepEqual(q.labels(), ['1.', 'a.', '1.']);
  const r = await quill('plain');
  r.sel(0, 0);
  assert.deepEqual(r.state('para.restartNumbering'), {enabled: false, reason: 'not in a numbered list'});
  assert.equal(r.state('para.listLevel').enabled, false);
});

test('move paragraphs up and down in their container; the selection follows; refused at the ends', async () => {
  const q = await quill('one\ntwo\nthree');
  q.sel(1, 1);
  await expectUndoRoundTrip(q.t, 'para.moveUp', {}, after => {
    assert.deepEqual(after.content.body.chunks[0].map(b => b.text), ['two', 'one', 'three']);
  });
  assert.match(q.t.doc.selection.ranges[0].anchor, new RegExp(`/b:${q.id(0)}/t:1$`));
  await assert.rejects(q.t.bridge('para.moveUp'), /already at the top/);
  q.sel([0, 0], [1, 3]);
  await q.exec('para.moveDown');
  assert.deepEqual(q.texts(), ['three', 'two', 'one']);
  await assert.rejects(q.t.bridge('para.moveDown'), /already at the bottom/);
});

test('promote/demote: headings step, body text promoted takes the heading level above, list items change level', async () => {
  const q = await quill('Title\nbody\nitem');
  q.sel(0, 0);
  await q.exec('para.style', {style: 'Heading 2'});
  q.sel(1, 0);
  await expectUndoRoundTrip(q.t, 'para.promote', {}, after => assert.equal(after.content.body.chunks[0][1].props.style, 'Heading2'));
  await q.exec('para.demote');
  assert.equal(q.props(1).style, 'Heading3');
  await q.exec('para.promote');
  await q.exec('para.promote');
  assert.equal(q.props(1).style, 'Heading1');
  await assert.rejects(q.t.bridge('para.promote'), /nothing to promote/);
  q.sel(2, 0);
  await assert.rejects(q.t.bridge('para.demote'), /nothing to demote/);
  await q.exec('para.bullets');
  await q.exec('para.demote');
  assert.equal(q.props(2).numbering.level, 1);
});

test('borders: toggling sides, all/outside/inside/none, horizontal line, exact sides, inside vertical is a table border', async () => {
  const q = await quill('a');
  q.sel(0, 0);
  await expectUndoRoundTrip(q.t, 'para.borders', {kind: 'bottom'}, after => {
    assert.deepEqual(after.content.body.chunks[0][0].props.borders, {bottom: {style: 'single', width: 0.5, color: null, space: 1}});
  });
  assert.equal(q.state('para.borders', {kind: 'bottom'}).checked, true);
  await q.exec('para.borders', {kind: 'bottom'});
  assert.deepEqual(q.props(0).borders, {}, 'clicking an on side takes it off');
  await q.exec('para.borders', {kind: 'outside', width: 1, color: 'FF0000', style: 'double'});
  assert.deepEqual(Object.keys(q.props(0).borders).sort(), ['bottom', 'left', 'right', 'top']);
  assert.equal(q.props(0).borders.left.space, 1, 'upstream spaces every side of Outside like the kind: 1 pt');
  await q.exec('para.borders', {kind: 'insideH'});
  assert.ok(q.props(0).borders.between, 'a paragraph\'s inside horizontal border is the border between paragraphs');
  await q.exec('para.borders', {kind: 'none'});
  assert.deepEqual(q.props(0).borders, {});
  await q.exec('para.borders', {kind: 'horizontalLine'});
  assert.equal(q.props(0).borders.bottom.width, 1.5);
  await q.exec('para.borders', {sides: {top: {style: 'dotted', width: 2}, left: null}});
  assert.deepEqual(q.props(0).borders, {top: {style: 'dotted', width: 2, color: null, space: 1}});
  assert.equal(q.state('para.borders', {kind: 'insideV'}).enabled, false);
  await assert.rejects(q.t.bridge('para.borders', {kind: 'insideV'}), /table cells/);
});

test('sort: numbers first in numeric order, then text; descending; refuses across containers', async () => {
  const q = await quill('banana\n10 items\napple\n2 items');
  q.sel([0, 0], [3, 7]);
  await expectUndoRoundTrip(q.t, 'para.sort', {}, after => {
    assert.deepEqual(after.content.body.chunks[0].map(b => b.text), ['2 items', '10 items', 'apple', 'banana']);
  });
  await q.exec('para.sort', {descending: true});
  assert.deepEqual(q.texts(), ['banana', 'apple', '10 items', '2 items']);
  assert.equal(q.t.registry.get('para.sort').dialog, 'dialog.sortText');
});

test('tabs: set, clear, clear all over a style\'s stops, the default interval (a settings change alone undoes)', async () => {
  const q = await quill('a');
  q.sel(0, 0);
  await expectUndoRoundTrip(q.t, 'para.tabs', {set: [{pos: 72, align: 'center', leader: 'dot'}, {pos: 144}]}, after => {
    assert.deepEqual(after.content.body.chunks[0][0].props.tabs, [{pos: 72, align: 'center', leader: 'dot'}, {pos: 144, align: 'left', leader: 'none'}]);
  });
  await q.exec('para.tabs', {clear: [72]});
  assert.deepEqual(q.props(0).tabs, [{pos: 144, align: 'left', leader: 'none'}]);
  await q.exec('para.style', {style: 'Header'});
  await q.exec('para.tabs', {clearAll: true});
  assert.deepEqual(q.props(0).tabs, [{pos: 234, align: 'clear', leader: 'none'}, {pos: 468, align: 'clear', leader: 'none'}],
    'clearing a stop the style defines records a clear stop over it');
  await expectUndoRoundTrip(q.t, 'para.tabs', {default: 18}, after => assert.equal(after.content.settings.defaultTab, 18));
  await assert.rejects(q.t.bridge('para.tabs', {set: [{pos: 99999}]}), /±1584/);
  assert.equal(q.t.registry.get('para.tabs').dialog, 'dialog.tabs');
});

test('para.set applies props and on-page alignment/indents in each paragraph\'s own direction, as one step', async () => {
  const q = await quill('ltr\nשלום');
  q.sel(1, 0);
  await q.exec('para.rtl');
  q.sel([0, 0], [1, 2]);
  await expectUndoRoundTrip(q.t, 'para.set', {props: {spaceAfter: 4, keepNext: true}, onPage: {align: 'left', left: 18, right: 9}}, after => {
    const [a, b] = after.content.body.chunks[0];
    assert.deepEqual([a.props.align, a.props.indentLeft, a.props.indentRight, a.props.spaceAfter, a.props.keepNext], ['left', 18, 9, 4, true]);
    assert.deepEqual([b.props.align, b.props.indentLeft, b.props.indentRight], ['right', 9, 18], 'the RTL paragraph\'s start is its right');
  });
  await assert.rejects(q.t.bridge('para.set', {props: {wobble: 1}}), /unknown paragraph property/);
  const r = await q.exec('para.dialog');
  assert.equal(r.result.open, 'paragraph');
});

test('asian typography sets only the flags given and reports them; outline level', async () => {
  const q = await quill('a');
  q.sel(0, 0);
  const r = await q.exec('para.asianTypography', {kinsoku: false, autoSpaceDN: false});
  assert.deepEqual(r.result.asianTypography, {kinsoku: false, wordWrap: true, overflowPunct: true, topLinePunct: false, autoSpaceDE: true, autoSpaceDN: false});
  assert.deepEqual([q.props(0).kinsoku, q.props(0).autoSpaceDN, q.props(0).wordWrap], [false, false, undefined]);
  await q.exec('para.outlineLevel', {level: 2});
  assert.equal(q.props(0).outlineLevel, 2);
  assert.equal(q.state('para.outlineLevel').value, 2);
  await q.exec('para.outlineLevel', {});
  assert.equal(q.props(0).outlineLevel, undefined);
});
