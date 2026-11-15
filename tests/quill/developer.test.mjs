// U:quill/developer: the Developer tab: the nine content controls, Design Mode, Properties with its dialog, Toggle
// Check Box / Choose List Item / Set Date / Remove, the w:sdt round trip in .docx, Restrict Editing's effect on
// controls, macros (Record Macro, Macros), and the document template.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/controls.rs (the specs and commands), crates/doc/src/control.rs
//    (the model, in core/quill/model/ranges.mjs), cmd/tools/actions.rs and templates.rs, and the dialogs in
//    ui-egui dialogs_controls.rs and dialogs_templates.rs. Word: a content control wraps the selection or
//    stands at the caret showing its placeholder; typing replaces the placeholder; a check box toggles, a list
//    takes its entries, a date shows in its format; locks refuse deleting the control or editing its contents;
//    a template name and "update styles" are the document's settings.
// 2. Ours: controls are paired markers in the paragraph model (control start / end), one undo step per command;
//    macros are lists of editing commands in the person's settings, never code and never in the document.
// 3. Proof: this file and tests/e2e/quill/developer.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {quill, blocks} from './format-fixture.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import {Document} from '../../core/quill/model/document.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {openDialogModel} from '../../core/kernel/dialog.mjs';
import controlProperties from '../../core/quill/dialogs/controlProperties.mjs';
import {layout} from '../../core/quill/layout/index.mjs';

const TEXT = 'The quick brown fox jumps over the lazy dog.\nA second paragraph of text.\nAnd a third one.';
const controls = q => new Document(q.t.content).controlRanges('body').filter(r => Number.isInteger(r.start.off));
const only = q => { const all = controls(q); assert.equal(all.length, 1, `one control, got ${all.length}`); return all[0]; };
const textOf = (q, r = only(q)) => new Document(q.t.content).controlText(r);
const put = (q, n, off) => q.sel(n, off);

test('each of the nine controls is inserted at the caret with its placeholder showing, in one undo step', async () => {
  const kinds = {
    'developer.richText': 'richText', 'developer.plainText': 'text', 'developer.picture': 'picture', 'developer.buildingBlock': 'gallery', 'developer.checkBox': 'checkBox',
    'developer.comboBox': 'comboBox', 'developer.dropDown': 'dropDown', 'developer.datePicker': 'date', 'developer.repeatingSection': 'repeatingSection',
  };
  for (const [id, type] of Object.entries(kinds)) {
    const q = await quill(TEXT);
    put(q, 1, 8);
    const before = q.texts();
    await q.exec(id, {title: 'T', tag: 'tg'});
    const all = controls(q);
    assert.ok(all.length >= 1, `${id}: a control is there`);
    // (a repeating section's item closes first)
    const c0 = all.find(r => r.control.kind.type === type);
    assert.ok(c0, `${id}: a ${type} control`);
    assert.equal(c0.control.title, 'T');
    assert.equal(c0.control.tag, 'tg');
    assert.ok(Number.isInteger(c0.control.id), 'a control id');
    if (['richText', 'plainText', 'comboBox', 'dropDown', 'datePicker'].includes(id.split('.')[1])) {
      assert.equal(c0.control.showingPlaceholder, true, `${id} shows its placeholder`);
      assert.ok(textOf(q, c0).length > 0);
    }
    await q.t.undo();
    assert.equal(controls(q).length, 0, `${id}: undo removes it`);
    assert.deepEqual(q.texts(), before);
  }
});

test('a repeating section holds one item; control ids are distinct', async () => {
  const q = await quill(TEXT);
  put(q, 0, 3);
  await q.exec('developer.repeatingSection', {});
  await q.exec('developer.richText', {});
  const all = controls(q);
  assert.equal(all.length, 3);
  assert.ok(all.some(r => r.control.kind.type === 'repeatingSection') && all.some(r => r.control.kind.type === 'repeatingSectionItem'));
  assert.equal(new Set(all.map(r => r.control.id)).size, 3, 'distinct ids');
});

test('Rich Text and Plain Text wrap the selection; one crossing another control is refused', async () => {
  const q = await quill(TEXT);
  q.sel(0, 4, 9);
  await q.exec('developer.richText', {title: 'Quick'});
  const r = only(q);
  assert.equal(textOf(q, r), 'quick');
  assert.equal(r.control.showingPlaceholder, false);
  assert.deepEqual(q.texts()[0].replace(/￼/g, ''), 'The quick brown fox jumps over the lazy dog.');
  // Selected whole paragraphs get a block-level control.
  q.sel(1, 0, q.texts()[1].length);
  await q.exec('developer.richText', {tag: 'para'});
  const para = controls(q).find(c => c.control.tag === 'para');
  assert.equal(para.control.block, true, 'a whole paragraph: a block-level control');
  assert.equal(textOf(q, para), 'A second paragraph of text.');
});

test('typing replaces the placeholder; emptying the control brings it back', async () => {
  const q = await quill(TEXT);
  put(q, 2, 0);
  await q.exec('developer.plainText', {});
  const placeholder = textOf(q);
  assert.ok(placeholder.length > 0 && only(q).control.showingPlaceholder);
  await q.exec('text.insert', {text: 'Ada'});
  assert.equal(textOf(q), 'Ada');
  assert.equal(only(q).control.showingPlaceholder, false);
  for (let i = 0; i < 3; i++) await q.exec('text.backspace', {});
  assert.equal(textOf(q), placeholder, 'the placeholder is back');
  assert.equal(only(q).control.showingPlaceholder, true);
});

test('Toggle Check Box, Choose List Item, Set Date', async () => {
  const q = await quill(TEXT);
  put(q, 0, 0);
  await q.exec('developer.checkBox', {tag: 'ok'});
  assert.equal(textOf(q), '☐');
  let r = (await q.exec('developer.toggleCheckBox', {control: 'ok'})).result;
  assert.equal(r.checked, true);
  assert.equal(textOf(q), '☒');
  r = (await q.exec('developer.toggleCheckBox', {control: 'ok', value: false})).result;
  assert.equal(textOf(q), '☐');
  await assert.rejects(() => q.exec('developer.chooseItem', {control: 'ok', index: 0}), /isn't in a combo box or drop-down list/);

  put(q, 1, 0);
  await q.exec('developer.dropDown', {tag: 'pick', items: ['Red', {display: 'Green', value: 'g'}, 'Blue', {display: '', value: 'dropped'}]});
  assert.deepEqual(controls(q).find(c => c.control.tag === 'pick').control.kind.items, [{display: 'Red', value: 'Red'}, {display: 'Green', value: 'g'}, {display: 'Blue', value: 'Blue'}], 'a value left out is the text; an entry with no text is dropped');
  assert.equal(controls(q).find(c => c.control.tag === 'pick').control.showingPlaceholder, true);
  await q.exec('developer.chooseItem', {control: 'pick', value: 'g'});
  const pick = controls(q).find(c => c.control.tag === 'pick');
  assert.equal(textOf(q, pick), 'Green');
  assert.equal(pick.control.kind.lastValue, 'g');
  await assert.rejects(() => q.exec('developer.chooseItem', {control: 'pick', text: 'Purple'}), /no such entry/);

  put(q, 2, 0);
  await q.exec('developer.comboBox', {tag: 'combo', items: ['A', 'B']});
  await q.exec('developer.chooseItem', {control: 'combo', index: 1});
  assert.equal(textOf(q, controls(q).find(c => c.control.tag === 'combo')), 'B');
  await assert.rejects(() => q.exec('developer.chooseItem', {control: 'combo', text: 'free text'}), /no such entry/);

  put(q, 2, 0);
  await q.exec('developer.datePicker', {tag: 'when', format: 'MMMM d, yyyy'});
  assert.equal(controls(q).find(c => c.control.tag === 'when').control.showingPlaceholder, true);
  await q.exec('developer.setDate', {control: 'when', date: '2026-10-31'});
  const when = controls(q).find(c => c.control.tag === 'when');
  assert.equal(textOf(q, when), 'October 31, 2026');
  assert.equal(when.control.kind.fullDate, '2026-10-31T00:00:00Z');
  await assert.rejects(() => q.exec('developer.setDate', {control: 'when', date: '2026-02-30'}), /YYYY-MM-DD/);
});

test('Properties: title, tag, locks, temporary, multi-line, date format, check box symbols and list entries', async () => {
  const q = await quill(TEXT);
  put(q, 0, 0);
  await q.exec('developer.plainText', {});
  await q.exec('developer.properties', {title: 'Name', tag: 'n', temporary: true, multiLine: true, placeholder: 'Your name'});
  let c = only(q).control;
  assert.deepEqual([c.title, c.tag, c.temporary, c.kind.multiLine, c.placeholderText], ['Name', 'n', true, true, 'Your name']);
  assert.equal(textOf(q), 'Your name', 'the placeholder showing follows the new text');
  await q.exec('developer.properties', {lockDelete: true});
  assert.equal(only(q).control.lock, 'sdtLocked');
  await q.exec('developer.properties', {lockEdit: true});
  assert.equal(only(q).control.lock, 'sdtContentLocked');
  await assert.rejects(() => q.exec('developer.removeControl', {}), /can't be deleted/);
  q.sel(0, only(q).start.off + 4);
  await assert.rejects(() => q.exec('text.insert', {text: 'x'}), /can't be edited/);
  await q.exec('developer.properties', {lockDelete: false, lockEdit: false});
  assert.equal(only(q).control.lock, 'unlocked');

  put(q, 1, 0);
  await q.exec('developer.checkBox', {tag: 'cb', checked: true});
  await q.exec('developer.properties', {control: 'cb', checkedSymbol: 'Y', uncheckedSymbol: 'N'});
  assert.equal(textOf(q, controls(q).find(r => r.control.tag === 'cb')), 'Y');
  await q.exec('developer.properties', {control: 'cb', checkedSymbol: 'YY'});
  assert.equal(controls(q).find(r => r.control.tag === 'cb').control.kind.checkedChar, 'Y', 'a symbol of two characters is not one: ignored');

  put(q, 2, 0);
  await q.exec('developer.dropDown', {tag: 'dd', items: ['x']});
  await q.exec('developer.properties', {control: 'dd', items: [{display: 'One', value: '1'}, 'Two']});
  assert.deepEqual(controls(q).find(r => r.control.tag === 'dd').control.kind.items, [{display: 'One', value: '1'}, {display: 'Two', value: 'Two'}]);
  await q.exec('developer.properties', {control: 'n', items: ['a'], format: 'yyyy'});
  assert.equal(controls(q).find(r => r.control.tag === 'n').control.kind.items, undefined, 'a plain text control has no list: ignored');
});

test('the Content Control Properties dialog, as Word has it: General, Locking and the type own properties; OK applies, w:sdt keeps them', async () => {
  const q = await quill(TEXT);
  put(q, 0, 0);
  await q.exec('developer.dropDown', {title: 'Colour', tag: 'c', items: [{display: 'Red', value: 'r'}, 'Blue']});
  await q.exec('styles.create', {name: 'Entry', kind: 'character'}).catch(() => {});
  const v = openDialogModel(q.t.session, q.t.docId, controlProperties);
  assert.deepEqual([v.kind, v.title, v.tag, v.lockDelete, v.lockEdit, v.appearance, v.color, v.useStyle], ['dropDown', 'Colour', 'c', false, false, 'Bounding Box', 'auto', false]);
  assert.deepEqual(v.entries, [{display: 'Red', value: 'r'}, {display: 'Blue', value: 'Blue'}], 'the list has Display Name and Value columns');
  const out = controlProperties.toCommand({...v, title: 'Shade', appearance: 'Start/End Tag', color: '#C00000', lockEdit: true, entries: [...v.entries, {display: 'Green', value: 'g'}]});
  assert.equal(out.command, 'developer.properties');
  assert.ok(!('lockDelete' in controlProperties.toCommand(v).params), 'unchanged locks are not sent');
  await q.exec(out.command, out.params);
  let c = only(q).control;
  assert.deepEqual([c.title, c.kind.items.length, c.lock, c.appearance, c.color], ['Shade', 3, 'contentLocked', 'tags', 'C00000']);
  // Use a style to format text typed into the empty control.
  const styleId = q.t.content.styles.styles.find(x => x.kind === 'character' && !x.builtin)?.id ?? q.t.content.styles.styles.find(x => x.kind === 'character')?.id;
  await q.exec('developer.properties', {style: styleId});
  assert.equal(only(q).control.runProps.style, styleId);
  assert.ok(only(q).control.rprXml.includes(`<w:rStyle w:val="${styleId}"/>`));
  await assert.rejects(() => q.exec('developer.properties', {style: 'NoSuchStyle'}), /no style/);
  await q.exec('developer.properties', {style: ''});
  assert.equal(only(q).control.runProps, undefined);
  assert.equal(only(q).control.rprXml, undefined);
  await assert.rejects(() => q.exec('developer.properties', {color: 'red'}), /RRGGBB/);
  // w:sdt keeps Show as and Color.
  const xml = await (await JSZip.loadAsync(await writeDocx(q.t.content))).file('word/document.xml').async('string');
  assert.ok(xml.includes('<w15:appearance w15:val="tags"/>') && xml.includes('<w15:color w:val="C00000"/>'));
  const back = new Document(await readDocx(await writeDocx(q.t.content))).controlRanges('body').find(r => r.control.tag === 'c').control;
  assert.deepEqual([back.appearance, back.color], ['tags', 'C00000']);
  assert.deepEqual(controlProperties.validate({...v, useStyle: true, style: ''}).map(e => e.field), ['style']);

  // Date Picker: the format, Locale, Calendar type and Store XML contents as.
  put(q, 1, 0);
  await q.exec('developer.datePicker', {tag: 'when'});
  const dv = openDialogModel(q.t.session, q.t.docId, controlProperties);
  assert.deepEqual([dv.kind, dv.dateFormat, dv.locale, dv.calendar, dv.storeAs], ['date', 'M/d/yyyy', 'English (United States)', 'Gregorian', 'Date and Time']);
  await q.exec(...Object.values(controlProperties.toCommand({...dv, dateFormat: 'yyyy-MM-dd', locale: 'German (Germany)', calendar: 'Hijri', storeAs: 'Text'})));
  const dk = controls(q).find(r => r.control.tag === 'when').control.kind;
  assert.deepEqual([dk.format, dk.lid, dk.calendar, dk.storeAs], ['yyyy-MM-dd', 'de-DE', 'hijri', 'text']);
  // Check Box: the symbols with their fonts.
  put(q, 2, 0);
  await q.exec('developer.checkBox', {tag: 'cb'});
  const cv = openDialogModel(q.t.session, q.t.docId, controlProperties);
  assert.deepEqual([cv.kind, cv.checkedSymbol, cv.uncheckedSymbol], ['checkBox', '\u2612', '\u2610']);
  await q.exec(...Object.values(controlProperties.toCommand({...cv, checkedSymbol: '\u2714', checkedFont: 'Segoe UI Symbol'})));
  const ck = controls(q).find(r => r.control.tag === 'cb').control.kind;
  assert.deepEqual([ck.checkedChar, ck.checkedFont], ['\u2714', 'Segoe UI Symbol']);
  assert.deepEqual(controlProperties.validate({...cv, checkedSymbol: '', uncheckedSymbol: 'x'}).map(e => e.field), ['checkedSymbol']);
});

test('Add Choice and Modify Choice: the value follows the display name until it is typed', async () => {
  const add = (await import('../../core/quill/dialogs/addChoice.mjs')).default;
  const modify = (await import('../../core/quill/dialogs/modifyChoice.mjs')).default;
  assert.deepEqual([add.id, modify.id], ['dialog.addChoice', 'dialog.modifyChoice']);
  const v0 = add.init();
  const v1 = {...v0, display: 'Red'};
  assert.deepEqual(add.derive(v1, ['display']), {value: 'Red'});
  assert.deepEqual(add.derive({...v1, value: 'r'}, ['value']), {_typed: true});
  assert.deepEqual(add.derive({...v1, _typed: true}, ['display']), {}, 'a typed value stays');
  assert.deepEqual(add.validate(v0).map(e => e.field), ['display']);
  assert.deepEqual(add.validate(v1), []);
});

test('Remove Content Control keeps typed content and drops a placeholder; Content Control at Selection reports', async () => {
  const q = await quill(TEXT);
  put(q, 0, 0);
  await q.exec('developer.richText', {tag: 'a'});
  const at = (await q.exec('developer.control', {})).result;
  assert.deepEqual([at.type, at.tag, at.showingPlaceholder, at.text], ['richText', 'a', true, '']);
  await q.exec('developer.removeControl', {});
  assert.equal(controls(q).length, 0);
  assert.equal(q.texts()[0], TEXT.split('\n')[0], 'the placeholder went with the control');
  await assert.rejects(() => q.exec('developer.control', {}), /isn't in a content control/);

  q.sel(0, 4, 9);
  await q.exec('developer.richText', {tag: 'b'});
  await q.exec('developer.removeControl', {control: 'b'});
  assert.equal(controls(q).length, 0);
  assert.equal(q.texts()[0], TEXT.split('\n')[0], 'the typed content stays');
});

test('Design Mode is view state, off by default', async () => {
  const q = await quill(TEXT);
  assert.equal((await q.state('developer.designMode')).checked, false);
  await q.exec('developer.designMode', {});
  assert.equal((await q.state('developer.designMode')).checked, true);
  await q.exec('developer.designMode', {value: false});
  assert.equal((await q.state('developer.designMode')).checked, false);
  assert.equal(q.t.content.settings?.designMode, undefined, 'not saved in the document');
});

test('controls and their properties survive a .docx round trip as w:sdt', async () => {
  const q = await quill(TEXT);
  put(q, 0, 0);
  await q.exec('developer.richText', {title: 'Rich', tag: 'rt'});
  put(q, 1, 0);
  await q.exec('developer.checkBox', {tag: 'cb', checked: true});
  put(q, 1, 3);
  await q.exec('developer.dropDown', {tag: 'dd', items: [{display: 'One', value: '1'}, 'Two']});
  await q.exec('developer.chooseItem', {control: 'dd', text: 'Two'});
  put(q, 2, 0);
  await q.exec('developer.datePicker', {tag: 'dt', format: 'yyyy-MM-dd', date: '2026-01-02'});
  put(q, 2, 5);
  await q.exec('developer.plainText', {tag: 'pt'});
  await q.exec('developer.properties', {tag: 'pt', lockDelete: true, multiLine: true});
  const bytes = await writeDocx(q.t.content);
  const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string');
  for (const tag of ['<w:sdt>', '<w:alias w:val="Rich"/>', '<w:tag w:val="rt"/>', '<w14:checkbox>', '<w:dropDownList', '<w:date', '<w:text w:multiLine="1"/>', '<w:lock w:val="sdtLocked"/>', '<w:showingPlcHdr/>']) {
    assert.ok(xml.includes(tag), `${tag} is written`);
  }
  const back = await readDocx(bytes);
  const read = new Document(back).controlRanges('body').filter(r => Number.isInteger(r.start.off));
  const by = t => read.find(r => r.control.tag === t);
  assert.equal(read.length, 5);
  assert.equal(by('rt').control.title, 'Rich');
  assert.equal(by('cb').control.kind.checked, true);
  assert.deepEqual(by('dd').control.kind.items, [{display: 'One', value: '1'}, {display: 'Two', value: 'Two'}]);
  assert.equal(by('dd').control.kind.lastValue, 'Two');
  assert.equal(by('dt').control.kind.fullDate, '2026-01-02T00:00:00Z');
  assert.equal(by('dt').control.kind.format, 'yyyy-MM-dd');
  assert.equal(by('pt').control.lock, 'sdtLocked');
  assert.equal(by('pt').control.kind.multiLine, true);
  assert.equal(new Document(back).controlText(by('dd')), 'Two');
});

test('Restrict Editing: a form-filling document refuses inserting, removing and changing controls, and takes check boxes', async () => {
  const q = await quill(TEXT);
  put(q, 0, 0);
  await q.exec('developer.checkBox', {tag: 'cb'});
  await q.exec('review.restrict', {mode: 'forms'});
  put(q, 2, 0);
  await assert.rejects(() => q.exec('developer.richText', {}), /protection/);
  await assert.rejects(() => q.exec('developer.removeControl', {control: 'cb'}), /protection/);
  await assert.rejects(() => q.exec('developer.properties', {control: 'cb', tag: 'x'}), /protection/);
  await q.exec('developer.toggleCheckBox', {control: 'cb'});
  assert.equal(controls(q)[0].control.kind.checked, true, 'forms can be filled in');
});

test('macros: record, keep in settings, run as one undo step; only editing commands; protection holds', async () => {
  const host = createTestHost();
  const q = await quill(TEXT, undefined, {host});
  assert.equal((await q.state('tools.recordMacro')).checked, false);
  put(q, 0, 0);
  await q.exec('tools.recordMacro', {name: 'Greet'});
  assert.equal((await q.state('tools.recordMacro')).checked, true);
  await q.exec('text.insert', {text: 'Hel'});
  await q.exec('text.insert', {text: 'lo '});
  await q.exec('caret.right', {});
  await q.t.undo();
  await q.exec('tools.recordMacro', {});
  assert.equal((await q.state('tools.recordMacro')).checked, false);
  const saved = host.savedPrefs?.macros?.Greet;
  assert.deepEqual(saved.map(x => [x.command, x.params.text ?? null]).slice(0, 3), [['text.insert', 'Hel'], ['text.insert', 'lo '], ['caret.right', null]], 'every editing and caret command is a step, kept in the settings');
  assert.ok(!JSON.stringify(q.t.content).includes('Greet'), 'not in the document');
  assert.deepEqual(Object.keys((await q.exec('tools.macros', {})).result), ['Greet'], 'with nothing to do it answers every macro');
  const steps = q.t.doc.undo.size;
  put(q, 1, 0);
  await q.exec('tools.macros', {run: 'Greet'});
  assert.ok(q.texts()[1].startsWith('Hello A second'), q.texts()[1]);
  assert.equal(q.t.doc.undo.size, steps + 1, 'one undo step');
  await q.t.undo();
  assert.ok(q.texts()[1].startsWith('A second'));
  // A macro holds document-editing commands only.
  await assert.rejects(() => q.exec('tools.macros', {define: {name: 'Bad', steps: [{command: 'file.save', params: {}}]}}), /can't be part of a macro/);
  await assert.rejects(() => q.exec('tools.macros', {define: {name: 'Bad', steps: [{command: 'edit.find', params: {}}]}}), /macro/);
  await assert.rejects(() => q.exec('tools.macros', {define: {name: 'Bad', steps: [{command: 'nope.nothing'}]}}), /no command/);
  await assert.rejects(() => q.exec('tools.macros', {define: {name: ' ', steps: [{command: 'text.insert', params: {text: 'x'}}]}}), /macro name/);
  await q.exec('tools.macros', {define: {name: 'Hi', steps: [{command: 'text.insert', params: {text: 'Hi'}}]}});
  await q.exec('tools.macros', {delete: 'Hi'});
  assert.deepEqual(Object.keys(host.savedPrefs.macros), ['Greet']);
  await assert.rejects(() => q.exec('tools.macros', {run: 'Nope'}), /no macro/);
  // The settings are the person's: another launch has the macro.
  const q2 = await quill(TEXT, undefined, {host: createTestHost(), prefs: host.savedPrefs});
  assert.deepEqual(Object.keys((await q2.exec('tools.macros', {})).result), ['Greet']);
  // A read-only document refuses what the macro would do.
  await q2.exec('review.restrict', {mode: 'readOnly'});
  put(q2, 0, 0);
  await assert.rejects(() => q2.exec('tools.macros', {run: 'Greet'}), /protected/);
});

test('the document template: attach, detach, update styles automatically; Update Styles from Template copies styles', async () => {
  const q = await quill(TEXT);
  assert.deepEqual((await q.exec('tools.templates', {})).result, {template: null, linkStyles: false});
  await q.exec('tools.attachTemplate', {path: 'Letter.dotx', linkStyles: true});
  assert.deepEqual((await q.exec('tools.templates', {})).result, {template: 'Letter.dotx', linkStyles: true});
  assert.equal(q.t.content.settings.attachedTemplate, 'Letter.dotx');
  const bytes = await writeDocx(q.t.content);
  assert.match(await (await JSZip.loadAsync(bytes)).file('word/settings.xml').async('string'), /w:attachedTemplate/);
  assert.equal((await readDocx(bytes)).settings.attachedTemplate, 'Letter.dotx');
  await q.exec('tools.linkStyles', {value: false});
  assert.equal((await q.state('tools.linkStyles')).checked, false);
  // The dialog's OK: a path and the automatic update attach it (updating the styles now), no path detaches, a switch alone changes the switch.
  const dlg = (await import('../../core/quill/dialogs/templates.mjs')).default;
  const v = openDialogModel(q.t.session, q.t.docId, dlg);
  assert.deepEqual([v.template, v.linkStyles], ['Letter.dotx', false]);
  assert.deepEqual(dlg.toCommand({...v, linkStyles: true}), {command: 'tools.attachTemplate', params: {path: 'Letter.dotx', linkStyles: true, update: true}});
  assert.deepEqual(dlg.toCommand({...v, template: 'Other.dotx'}).params, {path: 'Other.dotx', linkStyles: false, update: false});
  assert.deepEqual(dlg.toCommand({...v, template: ''}), {command: 'tools.detachTemplate', params: {}});
  assert.deepEqual(dlg.toCommand(v), {batch: []}, 'nothing changed: nothing to do');
  await q.exec('tools.detachTemplate', {});
  assert.deepEqual((await q.exec('tools.templates', {})).result, {template: null, linkStyles: false});

  // A template's styles: one the document has (replaced) and one it lacks (added).
  const tpl = await quill(TEXT);
  await tpl.exec('styles.create', {name: 'Callout', kind: 'paragraph'}).catch(() => {});
  const tbytes = Buffer.from(await writeDocx(tpl.t.content)).toString('base64');
  const r = (await q.exec('tools.updateStyles', {path: 'T.dotx', data: tbytes})).result;
  assert.ok(r.added.length + r.replaced.length > 0 && Array.isArray(r.skipped), JSON.stringify(r));
  await assert.rejects(() => q.exec('tools.updateStyles', {path: 'T.dotx', data: Buffer.from('not a zip').toString('base64')}), /not a Word/);
  await assert.rejects(() => q.exec('tools.updateStyles', {}), /path/);
});

test('Organizer commands: styles.organizer lists, styles.copyFrom brings a style and the styles it is based on, styles.rename renames custom styles', async () => {
  const {style, upsertStyle} = await import('../../core/quill/model/styles.mjs');
  const tpl = await quill(TEXT, c => {
    c.styles = upsertStyle(c.styles, style({id: 'Box', name: 'Box', kind: 'paragraph', basedOn: 'Normal', para: {spaceAfter: 20}}));
    c.styles = upsertStyle(c.styles, style({id: 'Callout', name: 'Callout', kind: 'paragraph', basedOn: 'Box', next: 'Normal', chr: {bold: true}}));
    c.styles = {...c.styles, styles: c.styles.styles.map(x => (x.id === 'Heading1' ? {...x, chr: {...x.chr, size: 31}} : x))};
  });
  const data = Buffer.from(await writeDocx(tpl.t.content)).toString('base64');
  const q = await quill(TEXT);
  const org = (await q.exec('styles.organizer', {path: 'T.dotx', data})).result;
  assert.ok(org.document.some(x => x.id === 'Heading1' && x.builtIn), "the document's styles by name");
  assert.ok(org.file.styles.some(x => x.name === 'Callout' && x.type === 'paragraph' && !x.builtIn), "the template's styles");
  const r = (await q.exec('styles.copyFrom', {path: 'T.dotx', data, styles: ['Callout']})).result;
  assert.deepEqual([r.added.sort(), r.replaced, r.skipped], [['Box', 'Callout'], [], []], 'the style and the one it is based on come');
  const sheet = q.t.content.styles.styles;
  assert.equal(sheet.find(x => x.id === 'Callout').basedOn, 'Box');
  assert.equal(sheet.find(x => x.id === 'Callout').next, 'Normal');
  await assert.rejects(() => q.exec('styles.copyFrom', {path: 'T.dotx', data, styles: ['Nope']}), /no style/);
  const u = (await q.exec('tools.updateStyles', {path: 'T.dotx', data})).result;
  assert.ok(u.replaced.includes('Heading 1') || u.replaced.includes('heading 1'), JSON.stringify(u));
  assert.equal(q.t.content.styles.styles.find(x => x.id === 'Heading1').chr.size, 31, 'a style of the same name is replaced');
  await q.exec('styles.rename', {style: 'Callout', name: 'Note box'});
  assert.equal(q.t.content.styles.styles.find(x => x.id === 'Callout').name, 'Note box');
  await assert.rejects(() => q.exec('styles.rename', {style: 'Heading1', name: 'H'}), /built-in/);
  await assert.rejects(() => q.exec('styles.rename', {style: 'Box', name: 'note box'}), /already exists/);
});

test('exported files carry our name, not upstream\'s: the HTML generator and the .docx application', async () => {
  const q = await quill(TEXT);
  const html = new TextDecoder().decode((await import('../../core/quill/formats/html-write.mjs')).write({content: q.t.content}));
  assert.ok(html.includes('<meta name="generator" content="Arkemis Quill">'), html.slice(0, 300));
  assert.ok(!/wordcraft/i.test(html));
  const app = await (await JSZip.loadAsync(await writeDocx(q.t.content))).file('docProps/app.xml').async('string');
  assert.ok(app.includes('<Application>Arkemis Quill</Application>') && !/wordcraft/i.test(app));
});

test('Design Mode draws the title on both tags, the end tag mirrored, in one paragraph and across two', async () => {
  const q = await quill(TEXT);
  q.sel(0, 4, 9);
  await q.exec('developer.richText', {title: 'Colour', tag: 'c'});
  q.sel([1, 2], [2, 3]);
  await q.exec('developer.richText', {title: 'Spread', tag: 's'});
  const shown = designMode => {
    const l = layout(q.t.content, {view: 'print', designMode});
    const out = [];
    for (const p of l.pages) for (const it of p.items) if (it.kind === 'lines' && it.story === 'body' && it.l0 === 0) out.push((it.para.clusters ?? []).map(c => c.shown ?? ''));
    return out;
  };
  const on = shown(true).flat();
  assert.equal(on.filter(s => s === ' Colour ').length, 2, 'Colour on the start tag and on the end tag: ' + JSON.stringify(on));
  assert.equal(on.filter(s => s === ' Spread ').length, 2, 'the same when the control ends in another paragraph');
  assert.ok(!on.includes(' › '), 'no bare chevron any more');
  assert.equal(shown(false).flat().filter(s => s === ' Colour ').length, 0, 'no tags with Design Mode off');
});

test('Content Control Properties: the style goes with OK only when Use a style is ticked', async () => {
  const q = await quill(TEXT);
  q.sel(0, 4, 9);
  await q.exec('developer.richText', {title: 'S'});
  const m = openDialogModel(q.t.session, q.t.docId, controlProperties);
  assert.equal(m.useStyle, false);
  assert.equal(controlProperties.toCommand({...m, useStyle: false, style: 'Strong'}).params.style, '', 'unticked: no style');
  assert.equal(controlProperties.toCommand({...m, useStyle: true, style: 'Strong'}).params.style, 'Strong');
  assert.deepEqual(controlProperties.validate({...m, useStyle: true, style: ''}).map(e => e.field), ['style'], 'ticked with none chosen');
});
