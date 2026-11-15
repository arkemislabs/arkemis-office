// Dialog state (src/shell/dialogs/dialogState.ts): the values object the fields and the bridge edit,
// units, visibility rules, validation, submission through a model or the generic mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDialogState, setValue, validateState, submission, genericParams, initialValues, fieldVisible, fieldEnabled, parseNumber, formatNumber, stepNumber,
  changedFields, tabOf, snapshot, primaryUnit,
} from '../../src/shell/dialogs/dialogState.ts';
import {defineDialog} from '../../core/kernel/dialog.mjs';

const spec = {
  id: 'dialog.paragraph', title: 'Paragraph', command: 'para.set', presentation: 'modal', relatedCommands: [], sourceRef: null,
  buttons: [{id: 'ok', label: 'OK', role: 'ok', command: null}, {id: 'cancel', label: 'Cancel', role: 'cancel', command: null}],
  tabs: [
    {name: 'Indents and Spacing', fields: [
      {id: 'alignment', label: 'Alignment:', kind: 'select', options: [{value: 'left', label: 'Left'}, {value: 'center', label: 'Centered'}]},
      {id: 'left', label: 'Left:', kind: 'number', options: [], unit: 'pt', min: -1584, max: 1584, step: 1},
      {id: 'special', label: 'Special:', kind: 'radio', options: [{value: 'none', label: '(none)'}, {value: 'first', label: 'First line'}]},
      {id: 'by', label: 'By:', kind: 'number', options: [], unit: 'pt', visibleWhen: 'special in first|hanging', min: 0, max: 1584},
      {id: 'preview', label: 'Preview', kind: 'preview', options: []},
    ]},
    {name: 'Line and Page Breaks', fields: [
      {id: 'keepNext', label: 'Keep with next', kind: 'checkbox', options: []},
      {id: 'style', label: 'Style', kind: 'text', options: [], default: 'Normal', param: 'styleId'},
    ]},
  ],
};

test('initial values: spec defaults, kinds, then the model init', () => {
  const v = initialValues(spec, {left: 36});
  assert.equal(v.alignment, null);
  assert.equal(v.special, 'none', 'a radio starts on its first option');
  assert.equal(v.keepNext, false);
  assert.equal(v.style, 'Normal');
  assert.equal(v.left, 36);
  assert.equal('preview' in v, false, 'previews hold no value');
});

test('numbers with units parse into the field unit and format back', () => {
  assert.equal(parseNumber('1 in', 'pt'), 72);
  assert.equal(parseNumber('2.54 cm', 'pt'), 72);
  assert.equal(parseNumber('12', 'pt'), 12);
  assert.equal(parseNumber('12,5 pt', 'pt'), 12.5);
  assert.equal(parseNumber('50%', '%'), 50);
  assert.equal(parseNumber('abc', 'pt'), null);
  assert.equal(formatNumber(12, 'pt'), '12 pt');
  assert.equal(formatNumber(50, '%'), '50%');
  assert.equal(primaryUnit('in|cm (preference)'), 'in');
  assert.equal(stepNumber(10, {min: 0, max: 12, step: 1}, 1), 11);
  assert.equal(stepNumber(11.5, {min: 0, max: 12, step: 1}, 1, true), 12, 'Shift steps ten and clamps');
  assert.equal(stepNumber(null, {min: 4}, -1), 4);
});

test('setValue parses, derives through the model and clears that field error', () => {
  const model = defineDialog({id: 'dialog.paragraph', init: () => ({}), validate: () => [], toCommand: v => ({command: 'para.set', params: v}),
    derive: (values, changed) => (changed[0] === 'special' && values.special === 'first' ? {by: 36} : {})});
  let s = createDialogState(spec, {init: {}});
  s = {...s, errors: [{field: 'left', message: 'bad'}]};
  s = setValue(s, 'left', '0.5 in', model);
  assert.equal(s.values.left, 36);
  assert.deepEqual(s.errors, []);
  s = setValue(s, 'special', 'first', model);
  assert.equal(s.values.by, 36);
  assert.throws(() => setValue(s, 'left', 'nope', model), e => e.code === 'invalid_params');
  assert.throws(() => setValue(s, 'missing', 1, model), e => e.code === 'not_found');
  assert.deepEqual(changedFields(s).sort(), ['by', 'left', 'special']);
});

test('visibleWhen expressions', () => {
  const f = spec.tabs[0].fields[3];
  assert.equal(fieldVisible(f, {special: 'none'}), false);
  assert.equal(fieldVisible(f, {special: 'first'}), true);
  assert.equal(fieldVisible({visibleWhen: 'type==list'}, {type: 'list'}), true);
  assert.equal(fieldVisible({visibleWhen: 'type!=list'}, {type: 'list'}), false);
  assert.equal(fieldVisible({visibleWhen: 'operator in between|notBetween'}, {operator: 'notBetween'}), true);
  assert.equal(fieldVisible({visibleWhen: '!advanced'}, {advanced: false}), true);
  assert.equal(fieldVisible({visibleWhen: 'something odd ~~'}, {}), true, 'unknown shapes stay visible');
});

test('enabledWhen greys a field out with the same expressions; no expression keeps it enabled', () => {
  assert.equal(fieldEnabled({enabledWhen: 'lineNumbers'}, {lineNumbers: false}), false);
  assert.equal(fieldEnabled({enabledWhen: 'lineNumbers'}, {lineNumbers: true}), true);
  assert.equal(fieldEnabled({enabledWhen: 'kind==picture'}, {kind: 'text'}), false);
  assert.equal(fieldEnabled({enabledWhen: 'kind in picture|text'}, {kind: 'text'}), true);
  assert.equal(fieldEnabled({}, {}), true);
  assert.equal(fieldVisible({enabledWhen: 'lineNumbers'}, {lineNumbers: false}), true, 'a greyed field stays visible');
});

test('validation: ranges of visible fields plus the model, errors switch to their tab', () => {
  const model = defineDialog({id: 'dialog.paragraph', init: () => ({}), toCommand: v => ({command: 'para.set', params: v}),
    validate: v => (v.keepNext && v.style === '' ? [{field: 'style', message: 'Choose a style'}] : [])});
  let s = createDialogState(spec, {init: {left: 5000, by: -10}});
  let problems = validateState(s, model);
  assert.deepEqual(problems.map(p => p.field), ['left'], 'hidden fields are not validated');
  assert.match(problems[0].message, /at most 1584 pt/);
  s = setValue(setValue(setValue(s, 'left', 0), 'keepNext', true), 'style', '');
  problems = validateState(s, model);
  assert.deepEqual(problems, [{field: 'style', message: 'Choose a style'}]);
  assert.equal(tabOf(s, 'style'), 1);
});

test('submission: the model maps values; without one, the spec command gets params by field param/id', () => {
  const model = defineDialog({id: 'dialog.paragraph', init: () => ({}), validate: () => [], toCommand: v => ({command: 'para.indents', params: {left: v.left}})});
  const s = createDialogState(spec, {init: {left: 18}, args: {scope: 'selection'}});
  assert.deepEqual(submission(s, model), {command: 'para.indents', params: {scope: 'selection', left: 18}});
  const generic = submission(setValue(s, 'alignment', 'center'));
  assert.equal(generic.command, 'para.set');
  assert.deepEqual(generic.params, {scope: 'selection', alignment: 'center', left: 18, special: 'none', keepNext: false, styleId: 'Normal'});
  assert.equal('by' in genericParams(s), false, 'hidden fields are left out');
  const batchModel = defineDialog({id: 'dialog.paragraph', init: () => ({}), validate: () => [], toCommand: () => ({batch: [{command: 'a', params: {}}, {command: 'b', params: {}}]})});
  assert.equal(submission(s, batchModel).batch.length, 2);
});

test('snapshot is what ui.dialog.get returns', () => {
  const s = createDialogState(spec, {init: {left: 4}});
  const snap = snapshot(s);
  assert.equal(snap.id, 'dialog.paragraph');
  assert.deepEqual(snap.tabs, ['Indents and Spacing', 'Line and Page Breaks']);
  assert.equal(snap.tab, 'Indents and Spacing');
  assert.equal(snap.values.left, 4);
  assert.deepEqual(snap.buttons.map(b => b.role), ['ok', 'cancel']);
  assert.equal(snap.fields.find(f => f.id === 'by').visible, false);
  assert.equal(snap.fields.find(f => f.id === 'left').label, 'Left');
  assert.match(s.key, /^dialog\.paragraph#\d+$/);
});
