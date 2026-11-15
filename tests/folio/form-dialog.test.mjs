// Field Properties, Shared Field Properties and Duplicate Field: dialog models and the props they send.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft crates/ui-egui/src/tools/prepare/{draft,properties,tabs}.rs, bulk_fields.rs):
//    Field Properties has General, Appearance and Position always, Options for most kinds, Format,
//    Validate and Calculate for text and drop-down, Actions always; a locked field keeps its properties
//    until unlocked; a comb needs a limit; several selected fields open Shared Field Properties where
//    only changed properties apply. Acrobat's Field Properties behaves the same way.
// 2. Ours does the same: the model opens from the selected field, OK sends only what changed as one
//    form.field.properties edit; the E2E (tests/e2e/folio/form.e2e.mjs) drives the window.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {openDialogModel, submitDialog, changeDialogValues} from '../../core/kernel/dialog.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import props from '../../core/folio/dialogs/field-properties.mjs';
import bulk from '../../core/folio/dialogs/bulk-field-properties.mjs';
import dup from '../../core/folio/dialogs/duplicate-field.mjs';
import {tabsFor, actionOf, describeAction, propsOf, draftOf} from '../../core/folio/lib/form-dialog.mjs';

after(() => releaseTextSources());

const session = () => createTestSession('folio', {fixture: 'textPages'});
const open = (t, dialog) => openDialogModel(t.session, t.docId, dialog);

test('tabs by field kind (draft.rs tabs)', () => {
  assert.deepEqual(tabsFor('text'), ['General', 'Appearance', 'Position', 'Options', 'Format', 'Validate', 'Calculate', 'Actions']);
  assert.deepEqual(tabsFor('combo'), ['General', 'Appearance', 'Position', 'Options', 'Format', 'Validate', 'Calculate', 'Actions']);
  assert.deepEqual(tabsFor('checkbox'), ['General', 'Appearance', 'Position', 'Options', 'Actions']);
  assert.deepEqual(tabsFor('signature'), ['General', 'Appearance', 'Position', 'Actions']);
});

test('opening needs a selected field; it opens on that field, Calculate when it comes from the calculation order', async () => {
  const t = await session();
  assert.throws(() => open(t, props), /Select a field first/);
  await t.exec('form.add.text', {page: 1, rect: [72, 72, 150, 22], name: 'a'});
  const v = open(t, props);
  assert.equal(v.__title, 'Text Field Properties');
  assert.equal(v.name, 'a');
  assert.deepEqual(v.position, [72, 698, 150, 22].map((x, i) => (i === 1 ? 698 : x)), 'Left, Bottom, Width, Height from the page bottom-left');
  assert.equal(v.__tab, 'General');
  assert.equal(v.fontSize, 0, 'Auto');
  assert.deepEqual(v.look.border, [0.55, 0.55, 0.55]);
  assert.equal(v.look.style, 'Solid');
  assert.equal(v.look.font, 'Helvetica');
  await t.exec('form.calculation_order', {});
  assert.equal(open(t, props).__tab, 'Calculate');
});

test('OK sends only what changed, as one edit; an unchanged dialog changes nothing', async () => {
  const t = await session();
  await t.exec('form.add.text', {page: 1, rect: [72, 72, 150, 22], name: 'a'});
  let v = open(t, props);
  assert.deepEqual(propsOf(v, v.__orig), {});
  const none = await submitDialog(t.session, t.docId, props, v);
  assert.deepEqual(none.result, {name: 'a', unchanged: true});
  v = changeDialogValues(props, v, 'name', 'first');
  v = {...v, tooltip: 'Given name', flags: v.flags | 2 | (1 << 12), quadding: 1, fontSize: 14, limit: true, maxLen: 8,
    look: {...v.look, border: null, fill: [1, 1, 0], width: 2, style: 'Dashed', text: [1, 0, 0], font: 'Courier'}, position: [100, 600, 160, 30], rotation: 0,
    defaultValue: 'x', format: {kind: 'date', fmt: 'mm/dd/yyyy'}, validate: {kind: 'none'}};
  const sent = propsOf(v, v.__orig);
  assert.deepEqual(Object.keys(sent).sort(), ['appearance', 'defaultValue', 'flags', 'fontSize', 'format', 'maxLen', 'name', 'quadding', 'tooltip', 'userRect']);
  assert.deepEqual(sent.appearance, {border: null, fill: [1, 1, 0], width: 2, style: 'Dashed', text: [1, 0, 0], font: 'Courier'});
  assert.deepEqual(sent.userRect, [0, [100, 600, 260, 630]]);
  assert.equal(sent.maxLen, 8);
  const done = await submitDialog(t.session, t.docId, props, v);
  assert.equal(done.result.name, 'first');
  const f = t.content.fields[0];
  assert.equal(f.name, 'first');
  assert.equal(f.da, '/Cour 14 Tf 1 0 0 rg');
  assert.equal(f.maxLen, 8);
  assert.deepEqual(f.widgets[0].rect, [100, 600, 260, 630]);
  assert.equal(f.widgets[0].look.style, 'D');
  assert.equal(f.actions.format.fmt, 'mm/dd/yyyy');
  assert.deepEqual(f.defaultValue, ['x']);
  assert.equal(t.doc.undoLabel ?? 'Change field properties', 'Change field properties');
});

test('validation: names, a comb needs a limit, a list needs an option, the field must be big enough', async () => {
  const t = await session();
  await t.exec('form.add.combo', {page: 1, rect: [72, 72, 150, 22], name: 'pick', options: ['a']});
  let v = open(t, props);
  v = {...v, options: []};
  assert.deepEqual(props.validate(v).map(p => p.field), ['items']);
  v = {...v, options: ['a'], name: '  ', position: [0, 0, 2, 2]};
  assert.deepEqual(props.validate(v).map(p => p.field), ['name', 'width']);
  const text = draftOf({name: 't', kind: 'text', flags: 1 << 24, maxLen: null, options: [], defaultValue: [], widgets: [{rect: [0, 0, 10, 10], look: null, locked: false}], actions: {format: {kind: 'none'}, validate: {kind: 'none'}, calculate: {kind: 'none'}}}, 0, []);
  assert.equal(text.maxLen, 10, 'a comb with no limit starts at 10 cells');
  assert.deepEqual(props.validate({...text, maxLen: 0}).map(p => p.field), ['comb']);
});

test('a locked field keeps its properties until it is unlocked', async () => {
  const t = await session();
  await t.exec('form.add.text', {page: 1, rect: [72, 72, 150, 22], name: 'a'});
  await t.exec('form.field.properties', {name: 'a', props: {locked: true}});
  const v = open(t, props);
  assert.equal(v.locked, true);
  assert.deepEqual(propsOf({...v, tooltip: 'x'}, v.__orig), {}, 'nothing but Locked applies while it is locked');
  assert.deepEqual(propsOf({...v, locked: false, tooltip: 'x'}, v.__orig), {tooltip: 'x', locked: false});
});

test('Actions tab: the action each kind makes and how it is listed', () => {
  assert.deepEqual(actionOf(0, 'app.alert("hi")').action, {kind: 'javascript', script: 'app.alert("hi")'});
  assert.equal(actionOf(1, '').error, 'Enter a URL');
  assert.deepEqual(actionOf(2, 'a, b').action, {kind: 'reset', fields: ['a', 'b']});
  assert.deepEqual(actionOf(3, '').action, {kind: 'named', name: 'Print'});
  assert.equal(actionOf(4, '0').error, 'Enter a page number');
  assert.deepEqual(actionOf(4, '3').action, {kind: 'goto', page: 2});
  assert.deepEqual(actionOf(6, 'x').action, {kind: 'showhide', fields: ['x'], hide: true});
  assert.equal(actionOf(5, '').error, 'Enter the field names');
  assert.equal(describeAction({kind: 'goto', page: 2}), 'Go to a page view: page 3');
  assert.equal(describeAction({kind: 'showhide', fields: ['a', 'b'], hide: false}), 'Show a field: a, b');
});

test('actions are written to the widget and read back; an action of another type is kept', async () => {
  const t = await session();
  await t.exec('form.add.button', {page: 1, rect: [72, 72, 100, 24], name: 'go', caption: 'Go'});
  const v = open(t, props);
  const next = {...v, actions: [['mouse_up', {kind: 'javascript', script: 'app.alert("x")'}], ['mouse_enter', {kind: 'uri', uri: 'https://example.org'}], ['on_blur', {kind: 'reset', fields: []}]], caption: 'Send'};
  await submitDialog(t.session, t.docId, props, next);
  const f = t.content.fields[0];
  assert.deepEqual(f.triggers.map(x => x[0]), ['mouse_up', 'mouse_enter', 'on_blur']);
  assert.equal(f.triggers[0][1].script, 'app.alert("x")');
  assert.equal(f.widgets[0].caption, 'Send');
  assert.equal(f.button.kind, 'alert');
  const v2 = open(t, props);
  await submitDialog(t.session, t.docId, props, {...v2, actions: v2.actions.filter(a => a[0] !== 'mouse_up')});
  assert.deepEqual(t.content.fields[0].triggers.map(x => x[0]), ['mouse_enter', 'on_blur']);
});

test('several fields selected: Shared Field Properties, only the changed properties apply', async () => {
  const t = await session();
  await t.exec('form.add.text', {page: 1, rect: [72, 72, 150, 22], name: 'a'});
  await t.exec('form.add.text', {page: 1, rect: [72, 110, 150, 22], name: 'b'});
  await t.exec('form.field.properties', {name: 'a', props: {readOnly: true, tooltip: 'same'}});
  await t.exec('form.select', {fields: [{name: 'a'}, {name: 'b'}]});
  const v = open(t, props);
  assert.equal(v.__bulk, true);
  assert.equal(v.count, '2 fields selected');
  assert.equal(v['read-only'], 'Mixed');
  assert.equal(v.required, 'No');
  assert.equal(v.tooltip, '');
  const b = open(t, bulk);
  assert.deepEqual(b.names, ['a', 'b']);
  const out = await submitDialog(t.session, t.docId, props, {...v, tooltip: 'both', 'read-only': 'No', 'text-color': '#0000ff', limit: 5});
  assert.equal(out.result.changed, 2);
  assert.deepEqual(t.content.fields.map(f => [f.readOnly, f.tooltip, f.maxLen, f.da]), [[false, 'both', 5, '/Helv 0 Tf 0 0 1 rg'], [false, 'both', 5, '/Helv 0 Tf 0 0 1 rg']]);
});

test('Duplicate Field: All pages, or From / to', async () => {
  const t = await session();
  await t.exec('form.add.text', {page: 1, rect: [72, 72, 150, 22], name: 'a'});
  const v = open(t, dup);
  assert.deepEqual(dup.toCommand(v), {command: 'form.field.duplicate', params: {name: 'a', pages: [1, 2]}});
  assert.deepEqual(dup.validate({...v, scope: 'From', from: 2, to: 1}).map(p => p.field), ['to']);
  assert.deepEqual(dup.validate({...v, scope: 'From', from: 0, to: 1}).map(p => p.field), ['from']);
  const r = await submitDialog(t.session, t.docId, dup, {...v, scope: 'From', from: 2, to: 2});
  assert.equal(r.result.added, 1);
  assert.deepEqual(t.content.fields[0].widgets.map(w => w.pageId), ['p1', 'p2']);
});
