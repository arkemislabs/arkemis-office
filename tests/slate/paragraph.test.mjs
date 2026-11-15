// U:slate/paragraph: lists, indent, alignment, spacing, outline moves, line break and styles.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `list.*`, `paragraph.*` and
//    `style.apply` (sourceRef core/slate-paragraph.mjs) name the commands; OneNote's behaviour:
//    Bullets (Ctrl+.) / Numbering (Ctrl+/) toggle lists, gallery items change the bullet or number
//    format, None removes the list; Increase / Decrease Indent Position nest list items and move
//    other paragraphs an outline level; Ctrl+L / Ctrl+R / Center align; Paragraph Spacing Options
//    set Before / After / At Least in points; Alt+Shift+Up / Down move a paragraph with its
//    subordinates; Ctrl+Shift+- selects them; Shift+Enter breaks the line; the Styles gallery
//    (Heading 1–6, Page Title, Citation, Quote, Code, Normal; Ctrl+Alt+1..6).
// 2. Ours does the same on the page body (list nodes, paragraph attributes), one undo entry each;
//    adjacent lists of the same look join so numbering continues.
// 3. Proof: these tests (engine, undo round trips, dialog models) and
//    tests/e2e/slate/format-home.e2e.mjs (ribbon presses, captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import spacingDialog from '../../core/slate/dialogs/paragraph-spacing.mjs';
import numberingDialog, {numberText} from '../../core/slate/dialogs/customize-numbering.mjs';
import {textSession, textSel} from './format-helpers.mjs';

const text = p => (p.content ?? []).map(c => c.text ?? '/').join('');
const shape = node => (node.type === 'paragraph' ? text(node) + (node.attrs.indent ? `>${node.attrs.indent}` : '')
  : `${node.type === 'bulletList' ? `b:${node.attrs.symbol}` : `o:${node.attrs.format}`}(${node.content.map(li => li.content.map(shape).join(',')).join(' ')})`);
const sum = t => t.blocks.map(shape).join(' | ');

test('list.bullets toggles bullets on the selected paragraphs (each its own item); a second press removes them', async () => {
  const t = await textSession(['One', 'Two', 'Three', 'Four'], {selection: p => textSel(p, 'b1', 0, 2, 'b3')});
  await expectUndoRoundTrip(t, 'list.bullets', {});
  assert.equal(sum(t), 'b:disc(One Two Three) | Four');
  assert.deepEqual(t.state('list.bullets'), {enabled: true, checked: true, value: 'disc'});
  assert.equal(t.state('list.bullets', {style: 'star'}).checked, false);
  await t.exec('list.bullets', {style: 'star'});
  assert.equal(sum(t), 'b:star(One Two Three) | Four');
  await t.exec('list.bullets');
  assert.equal(sum(t), 'One | Two | Three | Four');
});

test('list.numbering: formats from the gallery, a numbered list next to another joins it, none removes it', async () => {
  const t = await textSession(['One', 'Two', 'Three'], {selection: p => textSel(p, 'b1', 0, 1, 'b2')});
  await expectUndoRoundTrip(t, 'list.numbering', {format: 'upper-roman'});
  assert.equal(sum(t), 'o:upper-roman(One Two) | Three');
  t.select(textSel(t.pageId, 'b3', 1));
  await t.exec('list.numbering', {format: 'upper-roman'});
  assert.equal(sum(t), 'o:upper-roman(One Two Three)');
  await t.exec('list.numbering', {format: 'decimal-paren'});
  assert.equal(sum(t), 'o:decimal-paren(One Two Three)');
  await expectUndoRoundTrip(t, 'list.numbering', {format: 'none'});
  assert.equal(sum(t), 'o:decimal-paren(One Two) | Three');
  // Bullets on numbered paragraphs change the list's kind.
  t.select(textSel(t.pageId, 'b1', 0));
  await t.exec('list.bullets', {style: 'check'});
  assert.equal(sum(t), 'b:check(One Two) | Three');
});

test('paragraph.indent / outdent nest list items, and move other paragraphs an outline level', async () => {
  const t = await textSession([{text: 'A', list: 'bullet'}, {text: 'B', list: 'bullet'}, 'C'], {selection: p => textSel(p, 'b2', 0)});
  await expectUndoRoundTrip(t, 'paragraph.indent', {});
  assert.equal(sum(t), 'b:disc(A,b:circle(B)) | C');
  await expectUndoRoundTrip(t, 'paragraph.outdent', {});
  assert.equal(sum(t), 'b:disc(A B) | C');
  t.select(textSel(t.pageId, 'b3', 0));
  await t.exec('paragraph.indent');
  await t.exec('paragraph.indent');
  assert.equal(sum(t), 'b:disc(A B) | C>2');
  await t.exec('paragraph.outdent');
  assert.equal(sum(t), 'b:disc(A B) | C>1');
});

test('paragraph.align, paragraph.textDirection, paragraph.spacing and its dialog', async () => {
  const t = await textSession(['One', 'Two'], {selection: p => textSel(p, 'b1', 0, 1, 'b2')});
  await expectUndoRoundTrip(t, 'paragraph.align', {alignment: 'center'});
  assert.deepEqual(t.blocks.map(b => b.attrs.align), ['center', 'center']);
  assert.deepEqual(t.state('paragraph.align', {alignment: 'center'}), {enabled: true, value: 'center', checked: true});
  await t.exec('paragraph.align', {alignment: 'left'});
  assert.deepEqual(t.blocks.map(b => b.attrs.align), [null, null]);
  await expectUndoRoundTrip(t, 'paragraph.textDirection', {direction: 'rtl'});
  assert.deepEqual(t.blocks.map(b => b.attrs.dir), ['rtl', 'rtl']);
  await expectUndoRoundTrip(t, 'paragraph.spacing', {spaceBefore: 6, spaceAfter: 12});
  assert.deepEqual(t.blocks[0].attrs.spacing, {spaceBefore: 6, spaceAfter: 12, lineSpacingAtLeast: 0});
  const ctx = t.session.readContext(t.docId);
  const v = spacingDialog.init(ctx);
  assert.deepEqual(v, {spaceBefore: 6, spaceAfter: 12, lineSpacingAtLeast: 0});
  assert.deepEqual(spacingDialog.validate({...v, spaceAfter: -1}), [{field: 'spaceAfter', message: 'Enter a number of points from 0 to 999.'}]);
  assert.deepEqual(spacingDialog.toCommand({...v, lineSpacingAtLeast: '14'}), {command: 'paragraph.spacing', params: {spaceBefore: 6, spaceAfter: 12, lineSpacingAtLeast: 14}});
  await t.exec('paragraph.spacing', {spaceBefore: 0, spaceAfter: 0});
  assert.equal(t.blocks[0].attrs.spacing, null);
});

test('paragraph.moveUp / moveDown move a paragraph with its indented subordinates; the caret stays in the moved text', async () => {
  const t = await textSession(['A', 'B', {text: 'B1', indent: 1}, 'C'], {selection: p => textSel(p, 'b2', 1)});
  await expectUndoRoundTrip(t, 'paragraph.moveUp', {});
  assert.equal(sum(t), 'B | B1>1 | A | C');
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pageId}/b:b2/t:1`);
  await expectUndoRoundTrip(t, 'paragraph.moveDown', {});
  assert.equal(sum(t), 'A | B | B1>1 | C');
  t.select(textSel(t.pageId, 'b1', 0));
  assert.deepEqual((await t.exec('paragraph.moveUp')).result, {moved: false});
  // A list item moves within its list.
  const l = await textSession([{text: 'x', list: 'ordered'}, {text: 'y', list: 'ordered'}], {selection: p => textSel(p, 'b2', 0)});
  await l.exec('paragraph.moveUp');
  assert.equal(sum(l), 'o:decimal-period(y x)');
});

test('paragraph.selectWithChildren selects the paragraph and the ones indented under it (no undo entry)', async () => {
  const t = await textSession(['A', {text: 'A1', indent: 1}, {text: 'A2', indent: 1}, 'B'], {selection: p => textSel(p, 'b1', 0)});
  const v = t.version;
  await t.exec('paragraph.selectWithChildren');
  assert.deepEqual(t.doc.selection.ranges[0], {anchor: `/pg:${t.pageId}/b:b1/t:0`, focus: `/pg:${t.pageId}/b:b3/t:2`});
  assert.equal(t.doc.undo.size, 0);
  assert.ok(t.version >= v);
});

test('paragraph.lineBreak inserts a line break at the caret (replacing a selection) and puts the caret after it', async () => {
  const t = await textSession(['Hello world'], {selection: p => textSel(p, 'b1', 5, 6)});
  await expectUndoRoundTrip(t, 'paragraph.lineBreak', {});
  assert.deepEqual(t.blocks[0].content.map(c => c.type === 'text' ? c.text : '|'), ['Hello', '|', 'world']);
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pageId}/b:b1/t:6`);
});

test('style.apply sets OneNote paragraph styles; the gallery reads the current one', async () => {
  const t = await textSession(['Title', 'Body'], {selection: p => textSel(p, 'b1', 0)});
  await expectUndoRoundTrip(t, 'style.apply', {style: 'heading-1'});
  assert.equal(t.blocks[0].attrs.style, 'h1');
  assert.deepEqual(t.state('style.apply', {style: 'heading-1'}), {enabled: true, value: 'heading-1', checked: true});
  for (const [id, style] of [['page-title', 'pageTitle'], ['citation', 'citation'], ['quote', 'quote'], ['code', 'code'], ['heading-6', 'h6'], ['normal', 'normal']]) {
    await t.exec('style.apply', {style: id});
    assert.equal(t.blocks[0].attrs.style, style);
  }
  await assert.rejects(t.bridge('style.apply', {style: 'heading-7'}), e => e.code === 'invalid_params');
});

test('list.customizeNumbering and the Customize Numbering pane: sequence, start at, restart; the preview numbers', async () => {
  const t = await textSession(['One', 'Two'], {selection: p => textSel(p, 'b1', 0, 1, 'b2')});
  await expectUndoRoundTrip(t, 'list.customizeNumbering', {sequence: 'a, b, c', startAt: 3, textAfter: ')'});
  assert.equal(sum(t), 'o:lower-alpha-paren(One Two)');
  assert.equal(t.blocks[0].attrs.start, 3);
  await t.exec('list.customizeNumbering', {sequence: 'I, II, III', startAt: 5, restart: true});
  assert.equal(t.blocks[0].attrs.start, 5);
  assert.equal(t.blocks[0].attrs.format, 'upper-roman');
  await assert.rejects(t.exec('list.customizeNumbering', {textBefore: 'Step '}), e => e.code === 'invalid_params');
  const v = numberingDialog.init();
  assert.deepEqual(numberingDialog.preview(null, {...v, sequence: 'First, Second, Third', startAt: 2}).lines, ['Second.', 'Third.', 'Fourth.']);
  assert.deepEqual(numberingDialog.preview(null, {...v, sequence: 'i, ii, iii', startAt: 4}).lines, ['iv.', 'v.', 'vi.']);
  assert.equal(numberText('1st, 2nd, 3rd', 12), '12th');
  assert.equal(numberText('A, B, C', 28), 'AB');
  assert.deepEqual(numberingDialog.toCommand({...v, restart: 'Restart numbering', startAt: '4'}), {command: 'list.customizeNumbering', params: {sequence: '1, 2, 3', startAt: 4, restart: true, textAfter: '.'}});
  assert.equal(numberingDialog.validate({...v, startAt: 0})[0].field, 'startAt');
});
