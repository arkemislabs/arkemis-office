// U:quill/word-core: Show/Hide ¶, Select Text with Similar Formatting, Phonetic Guide, Format Page Numbers and Hyphenation.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/phonetic.rs (the guide over the selection, its edit and removal, the size and offset it takes),
//    page.rs (layout.pageNumberFormat keeps, clears or sets the start; layout.hyphenation keeps the options), tools/actions.rs (select_similar)
//    and view.rs (view.marks). Word: the same boxes (Page Number Format, Hyphenation Options, Phonetic Guide).
// 2. Ours: the model is core/quill/model (ruby objects, section page-number fields, document settings); each command is one undo step.
// 3. Proof: this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill} from './format-fixture.mjs';
import {openDialogModel} from '../../core/kernel/dialog.mjs';
import phoneticDialog from '../../core/quill/dialogs/phonetic.mjs';
import pageNumbersDialog from '../../core/quill/dialogs/pageNumbers.mjs';
import hyphenationDialog from '../../core/quill/dialogs/hyphenation.mjs';
import {Document} from '../../core/quill/model/document.mjs';

const TEXT = 'I read 漢字 daily.\nA second paragraph.';
const rubyOf = q => q.para(0).objects?.find(o => o.type === 'ruby');

test('Show/Hide ¶ is the view flag the page view draws marks from', async () => {
  const q = await quill(TEXT);
  assert.equal((await q.state('view.marks')).checked, false);
  assert.equal((await q.exec('view.marks', {})).result.value, true);
  assert.equal((await q.state('view.marks')).checked, true);
  assert.equal((await q.exec('view.marks', {value: false})).result.value, false);
});

test('Select Text with Similar Formatting runs from the first run formatted like the caret to the last', async () => {
  const q = await quill('plain one\nbold two\nplain three');
  q.sel(1, 0, 4);
  await q.exec('format.bold', {});
  q.sel(0, 0);
  const r = (await q.exec('select.similar', {})).result;
  assert.equal(r.runs >= 2, true, 'the plain runs around the bold one');
  const sel = q.t.doc.selection.ranges[0];
  assert.ok(sel.anchor.includes('/t:0') && sel.focus.includes('/t:'), JSON.stringify(sel));
});

test('Phonetic Guide: a guide over the selection, edited, removed, undone; the state reports it', async () => {
  const q = await quill(TEXT);
  const text = q.para(0).text;
  const at = text.indexOf('漢字');
  q.sel(0, at, at + 2);
  let st = (await q.exec('format.phonetic', {})).result;
  assert.deepEqual([st.base, st.ruby, st.existing, st.align], ['漢字', '', false, 'center']);
  st = (await q.exec('format.phonetic', {ruby: 'かんじ', align: 'distributeSpace'})).result;
  assert.deepEqual([st.base, st.ruby, st.existing], ['漢字', 'かんじ', true]);
  const o = rubyOf(q);
  assert.deepEqual([o.base, o.ruby, o.align, o.size], ['漢字', 'かんじ', 'distributeSpace', st.size]);
  assert.equal(q.para(0).text.length, TEXT.split('\n')[0].length - 2 + 1, 'the two characters are one object');
  st = (await q.exec('format.phonetic', {ruby: 'カンジ', offset: 2})).result;
  assert.deepEqual([st.ruby, st.offset], ['カンジ', 2]);
  assert.equal(q.para(0).objects.length, 1);
  await q.exec('format.phonetic', {ruby: null});
  assert.ok(!rubyOf(q), 'the base text is plain text again');
  assert.equal(q.para(0).text, TEXT.split('\n')[0]);
  await q.t.exec('edit.undo', {});
  assert.equal(rubyOf(q).ruby, 'カンジ');
  await assert.rejects(() => q.exec('format.phonetic', {ruby: 'x', align: 'sideways'}), /unknown alignment/);
  q.sel(1, 2);
  await assert.rejects(() => q.exec('format.phonetic', {ruby: 'x'}), /select the text/);
});

test('the Phonetic Guide box: Alignment names, Remove only on an existing guide, OK needs the ruby text', async () => {
  const q = await quill(TEXT);
  const at = q.para(0).text.indexOf('漢字');
  q.sel(0, at, at + 2);
  const v = openDialogModel(q.t.session, q.t.docId, phoneticDialog);
  assert.deepEqual([v.base, v.existing, v.alignment], ['漢字', false, 'Center']);
  assert.deepEqual(phoneticDialog.validate(v).map(e => e.field), ['ruby']);
  assert.equal(phoneticDialog.buttons.remove(null, v), null);
  const cmd = phoneticDialog.toCommand({...v, ruby: 'かんじ', alignment: 'Distribute spacing', offset: 1, size: 5});
  assert.deepEqual(cmd, {command: 'format.phonetic', params: {ruby: 'かんじ', align: 'distributeSpace', size: 5, offset: 1}});
  await q.exec(cmd.command, cmd.params);
  const again = openDialogModel(q.t.session, q.t.docId, phoneticDialog);
  assert.deepEqual([again.existing, again.ruby, again.alignment], [true, 'かんじ', 'Distribute spacing']);
  assert.deepEqual(phoneticDialog.buttons.remove(null, again), {command: 'format.phonetic', params: {ruby: null}});
});

test('Format Page Numbers keeps, clears or sets the start; the box shows the section\'s format and start', async () => {
  const q = await quill(TEXT);
  const sect = () => new Document(q.t.content).sectionOfBlock(0);
  await q.exec('layout.pageNumberFormat', {format: 'upperRoman', start: 3});
  assert.deepEqual([sect().pageNumFormat, sect().pageNumStart], ['upperRoman', 3]);
  await q.exec('layout.pageNumberFormat', {format: 'lowerLetter'});
  assert.deepEqual([sect().pageNumFormat, sect().pageNumStart], ['lowerLetter', 3], 'the start is kept');
  await q.exec('layout.pageNumberFormat', {start: null});
  assert.equal(sect().pageNumStart, null, 'null: numbers on from the section before');
  await q.exec('layout.pageNumberFormat', {format: 'nonsense'});
  assert.equal(sect().pageNumFormat, 'decimal');
  await q.exec('layout.pageNumberFormat', {format: 'numberInDash', start: 5});
  const v = openDialogModel(q.t.session, q.t.docId, pageNumbersDialog);
  assert.deepEqual([v.format, v.numbering, v.startAt], ['- 1 -, - 2 -, …', 'Start at:', 5]);
  assert.deepEqual(pageNumbersDialog.toCommand({...v, format: 'I, II, III, …', numbering: 'Continue from previous section'}),
    {command: 'layout.pageNumberFormat', params: {format: 'upperRoman', start: null}});
  assert.deepEqual(pageNumbersDialog.toCommand({...v, numbering: 'Start at:', startAt: 7}).params, {format: 'numberInDash', start: 7});
});

test('Hyphenation keeps its options (zone, capitals, consecutive limit) and the automatic flag; the box edits them', async () => {
  const q = await quill(TEXT);
  const st = () => new Document(q.t.content).settings;
  const r = (await q.exec('layout.hyphenation', {zone: 36, caps: false, limit: 3})).result;
  assert.deepEqual([r.zone, r.caps, r.limit, r.value], [36, false, 3, false]);
  assert.deepEqual([st().hyphenationZone, st().hyphenateCaps, st().consecutiveHyphenLimit], [36, false, 3]);
  assert.equal((await q.exec('layout.hyphenation', {})).result.value, true, 'nothing given: it toggles');
  assert.equal((await q.exec('layout.hyphenation', {value: false})).result.value, false);
  const v = openDialogModel(q.t.session, q.t.docId, hyphenationDialog);
  assert.deepEqual([v.zone, v.caps, v.limit], [36, false, 3]);
  assert.deepEqual(hyphenationDialog.toCommand({...v, zone: 20, limit: 0}).params, {value: false, caps: false, zone: 20, limit: 0});
  assert.deepEqual(hyphenationDialog.validate({...v, zone: -1}).map(e => e.field), ['zone']);
});
