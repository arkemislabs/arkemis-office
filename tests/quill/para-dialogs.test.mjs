// The U:quill/para dialogs: Tabs, Sort Text, Create New Style from Formatting, Modify Style,
// Manage Styles (core/quill/dialogs/{tabs,sortText,newStyle,modifyStyle,manageStyles}.mjs).
//
// Behaviour fidelity:
// 1. ArtCraft: dialogs_para.rs `TabsForm` (New/Clear/Clear All, only changed stops and the default
//    interval go to one para.tabs); dispatch.rs new_style_dialog / modify_style_dialog
//    (styles.create from the paragraph's formatting, styles.modify with name/chr/para);
//    styles.rs manage_styles (styles.setVisibility, styles.delete). Word: Tabs Set/Clear/Clear All,
//    Sort Text (Paragraphs by Text/Number/Date, header row), Create/Modify Style with Style type,
//    based on, following style and the formatting toolbar, Manage Styles applying on OK.
// 2. Ours runs the same commands with the same params through the kernel's dialog submit, one undo
//    step per OK; the dialog views (src/apps/quill/dialogs/*.tsx) only edit these values.
// 3. These tests; tests/e2e/quill/format-home.e2e.mjs opens the dialogs in the window.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill} from './format-fixture.mjs';
import {submitDialog, changeDialogValues} from '../../core/kernel/dialog.mjs';
import {resolvePara, getStyle, findStyle, resolveChar} from '../../core/quill/model/styles.mjs';
import tabs, {setStop, clearStop, clearAll, newStop, clearedText} from '../../core/quill/dialogs/tabs.mjs';
import sortText from '../../core/quill/dialogs/sortText.mjs';
import newStyle from '../../core/quill/dialogs/newStyle.mjs';
import modifyStyle, {modifyValues} from '../../core/quill/dialogs/modifyStyle.mjs';
import manageStyles from '../../core/quill/dialogs/manageStyles.mjs';

const open = (q, d) => d.init(q.t.session.readContext(q.t.docId));
const submit = (q, d, v) => (d.toCommand(v) ? submitDialog(q.t.session, q.t.docId, d, v) : null);
const set = (d, v, field, value) => changeDialogValues(d, v, field, value);
const stopsOf = q => resolvePara(q.t.content.styles, q.props(0)).tabs.map(t => [t.pos, t.align, t.leader]);

test('Tabs: Set, Clear and the default interval go to one para.tabs; undo restores them', async () => {
  const q = await quill('Name\tPrice');
  q.sel(0, 0);
  await q.exec('para.style', {style: 'Header'});
  const before = stopsOf(q);
  let v = open(q, tabs);
  assert.equal(v.stops.stops.length, 2, 'Header\'s own stops');
  assert.equal(v.defaultTab, 0.5);
  assert.equal(tabs.toCommand(v), null, 'nothing changed: OK runs nothing');
  v = set(tabs, v, 'stops', setStop(v.stops, 100, 'decimal', 'dot'));
  v = set(tabs, v, 'stops', clearStop(v.stops, v.stops.stops.findIndex(t => t.pos === 234)));
  assert.equal(v.clearedText, '3.25"', 'Tab stops to be cleared lists it');
  v = set(tabs, v, 'defaultTab', 0.25);
  const version = q.t.session.get(q.t.docId).version;
  await submit(q, tabs, v);
  assert.equal(q.t.session.get(q.t.docId).version, version + 1, 'one undo step');
  assert.deepEqual(stopsOf(q), [[100, 'decimal', 'dot'], [468, 'right', 'none']]);
  assert.equal(q.t.content.settings.defaultTab, 18);
  await q.t.undo();
  assert.deepEqual(stopsOf(q), before);
  assert.equal(q.t.content.settings.defaultTab, 36);
});

test('Tabs: Clear All clears inherited stops; New takes the next free default multiple', async () => {
  const q = await quill('a\tb');
  q.sel(0, 0);
  await q.exec('para.tabs', {set: [{pos: 72}]});
  let v = open(q, tabs);
  const n = newStop(v.stops, 36);
  assert.deepEqual(n.stops.map(t => t.pos), [72, 108], 'after the last stop');
  v = set(tabs, v, 'stops', clearAll(v.stops));
  assert.equal(v.clearedText, 'All');
  await submit(q, tabs, v);
  assert.deepEqual(stopsOf(q), []);
});

test('Sort Text: descending, numbers and a header row', async () => {
  let q = await quill('Name\n10 apples\n9 pears\n100 plums');
  q.sel([0, 0], [3, 2]);
  let v = {...open(q, sortText), type: 'number', order: 'descending', header: 'yes'};
  assert.deepEqual(sortText.toCommand(v), {command: 'para.sort', params: {descending: true, type: 'number', header: true}});
  await submit(q, sortText, v);
  assert.deepEqual(q.texts(), ['Name', '100 plums', '10 apples', '9 pears']);
  await q.t.undo();
  assert.deepEqual(q.texts(), ['Name', '10 apples', '9 pears', '100 plums']);
  q = await quill('2024-03-01 c\n2023-12-25 a\n2024-01-10 b');
  q.sel([0, 0], [2, 2]);
  await submit(q, sortText, {...open(q, sortText), type: 'date'});
  assert.deepEqual(q.texts(), ['2023-12-25 a', '2024-01-10 b', '2024-03-01 c']);
});

test('Create New Style from Formatting: name Style1, the paragraph\'s look plus the toolbar, applied', async () => {
  const q = await quill('Quote me');
  q.sel(0, 0, 5);
  await q.exec('para.alignCenter');
  let v = open(q, newStyle);
  assert.equal(v.name, 'Style1');
  assert.equal(v.basedOn, 'Normal');
  assert.equal(v.styleType, 'linked', 'Word\'s default type');
  assert.equal(v.alignment, 'center', 'the current paragraph\'s formatting');
  v = {...v, name: 'Pull Quote', italic: true, size: '14', after: 12};
  const r = await submit(q, newStyle, v);
  const id = r.result.id;
  const st = getStyle(q.t.content.styles, id);
  assert.equal(st.name, 'Pull Quote');
  assert.equal(st.para.align, 'center');
  assert.equal(st.para.spaceAfter, 12);
  assert.deepEqual([st.chr.italic, st.chr.size], [true, 14]);
  assert.ok(st.linked && getStyle(q.t.content.styles, st.linked)?.kind === 'character', 'a linked character twin');
  assert.equal(q.props(0).style, id, 'the paragraph takes it');
  await q.t.undo();
  assert.equal(findStyle(q.t.content.styles, 'Pull Quote'), null, 'one undo step');
  const bad = newStyle.validate({...v, name: '  '});
  assert.ok(bad.some(e => e.field === 'name'));
});

test('Create New Style: a character style takes only character formatting', async () => {
  const q = await quill('Mark this');
  q.sel(0, 0, 4);
  const r = await submit(q, newStyle, {...open(q, newStyle), name: 'Marker', styleType: 'character', bold: true});
  const st = getStyle(q.t.content.styles, r.result.id);
  assert.equal(st.kind, 'character');
  assert.equal(st.chr.bold, true);
  assert.equal(resolveChar(q.t.content.styles, null, q.runs(0)[0][1]).bold, true, 'the selection shows it');
});

test('Modify Style: only what changed, one undo step; based on and gallery', async () => {
  const q = await quill('Body');
  q.sel(0, 0);
  await q.exec('para.heading1');
  let v = modifyValues(q.t.content.styles, 'Heading1');
  assert.equal(modifyStyle.toCommand(v), null, 'nothing changed: OK runs nothing');
  v = {...v, color: '#C00000', bold: true, after: 18, addToGallery: false};
  const before = structuredClone(getStyle(q.t.content.styles, 'Heading1'));
  await submit(q, modifyStyle, v);
  const st = getStyle(q.t.content.styles, 'Heading1');
  assert.equal(st.chr.bold, true);
  assert.deepEqual(st.chr.color, {Rgb: [0xc0, 0, 0]});
  assert.equal(st.para.spaceAfter, 18);
  assert.equal(st.quick, false);
  assert.equal(st.chr.font, before.chr.font, 'the font is left alone');
  await q.t.undo();
  assert.deepEqual(getStyle(q.t.content.styles, 'Heading1'), before);
  assert.ok(modifyStyle.validate({...modifyValues(q.t.content.styles, 'Heading1'), basedOn: 'Heading1'}).length, 'not based on itself');
});

test('Manage Styles: show/hide apply on OK as one step; Delete removes the picked style', async () => {
  const q = await quill('Text');
  q.sel(0, 0);
  let v = open(q, manageStyles);
  assert.equal(v.style, 'Normal');
  assert.ok(v._order.recommended.length > 5);
  v = set(manageStyles, v, 'style', 'Heading4');
  assert.equal(v.showInGallery, false);
  v = set(manageStyles, v, 'showInGallery', true);
  v = set(manageStyles, v, 'style', 'Title');
  v = set(manageStyles, v, 'hide', true);
  v = set(manageStyles, v, 'style', 'Heading4');
  assert.equal(v.showInGallery, true, 'the pending change shows when the style is picked again');
  const version = q.t.session.get(q.t.docId).version;
  await submit(q, manageStyles, v);
  assert.equal(q.t.session.get(q.t.docId).version, version + 1, 'one undo step');
  assert.equal(getStyle(q.t.content.styles, 'Heading4').quick, true);
  assert.equal(getStyle(q.t.content.styles, 'Title').hidden, true);
  await q.exec('styles.create', {name: 'Gone'});
  v = set(manageStyles, open(q, manageStyles), 'style', findStyle(q.t.content.styles, 'Gone').id);
  const call = manageStyles.buttons.deleteButton(q.t.session.readContext(q.t.docId), v);
  await q.t.session.execute(q.t.docId, call.command, call.params, {origin: 'dialog'});
  assert.equal(findStyle(q.t.content.styles, 'Gone'), null);
});
