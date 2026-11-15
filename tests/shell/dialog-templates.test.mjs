// Dialog text templates (src/shell/dialogs/templates.ts): the upstream placeholders in titles, labels and
// buttons are filled from the dialog's values and never shown raw.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fillTemplate, stripTokens, resolveText, dialogTitle, resolveField, buttonLabel} from '../../src/shell/dialogs/templates.ts';
import {previewKind} from '../../src/shell/fields/previewKind.ts';

test('named tokens fill from the values, with or without the __ prefix', () => {
  assert.equal(fillTemplate('Unlock {name}', {__name: 'a.pdf'}).text, 'Unlock a.pdf');
  assert.equal(resolveText('Move or copy "<section>" into the notebook', {section: 'Plan'}), 'Move or copy "Plan" into the notebook');
});

test('a token without a value is dropped with its connecting word', () => {
  assert.equal(resolveText('Replacement: pages of {name}', {}), 'Replacement: pages');
  assert.equal(resolveText('Strength: {s}', {}), 'Strength:');
  assert.equal(stripTokens('Text styles ({font}, {size} pt, {n} lines)'), 'Text styles (pt, lines)');
});

test('{A|B} picks the word whose own flag is true, else the editing one, else the first', () => {
  assert.equal(resolveText('{Create|Change} {signature|initials}', {}), 'Create signature');
  assert.equal(resolveText('{Create|Change} {signature|initials}', {initials: true, editing: true}), 'Change initials');
  assert.equal(resolveText('{Add|Update} Watermark', {__replace: true}), 'Update Watermark');
});

test('a title: the values win, then the model, then the spec', () => {
  const spec = {title: 'New Tag / Modify Tag'};
  assert.equal(dialogTitle({spec, values: {}}, {title: 'New Tag', titleFor: v => (v.mode === 'modify' ? 'Modify Tag' : 'New Tag')}), 'New Tag');
  assert.equal(dialogTitle({spec, values: {mode: 'modify'}}, {title: 'New Tag', titleFor: v => (v.mode === 'modify' ? 'Modify Tag' : 'New Tag')}), 'Modify Tag');
  assert.equal(dialogTitle({spec, values: {__title: 'Shared'}}, null), 'Shared');
  assert.equal(dialogTitle({spec: {title: 'Unlock {name}'}, values: {}}, {title: 'Unlock file'}), 'Unlock file');
  assert.equal(dialogTitle({spec: {title: 'Unlock {name}'}, values: {}, args: {name: 'b.pdf'}}, {title: 'Unlock file'}), 'Unlock b.pdf');
  assert.equal(dialogTitle({spec: {title: 'About {product}'}, values: {}}, null), 'About');
});

test('a field label is resolved and a button is never blank', () => {
  const f = {id: 'x', kind: 'list', options: [], label: 'Move "<section>" now'};
  assert.equal(resolveField(f, {section: 'Q1'}).label, 'Move "Q1" now');
  assert.equal(buttonLabel({id: 'ok', label: '', role: 'ok'}), 'OK');
  assert.equal(buttonLabel({id: 'sync-all', label: undefined, role: 'other'}), 'Sync all');
});

test('a preview is drawn from its data, and a font sample only for font dialogs', () => {
  const f = {id: 'strength', kind: 'preview', options: [], label: 'Strength: {s}'};
  assert.equal(previewKind(f, {type: 'meter', score: 1, label: 'Strong'}, {}), 'meter');
  assert.equal(previewKind(f, {text: 'Applied when you save.'}, {}), 'text');
  assert.equal(previewKind(f, {items: ['a']}, {}), 'list');
  assert.equal(previewKind(f, {}, {}), 'empty');
  assert.equal(previewKind({id: 'path', kind: 'preview', options: [], label: 'Path'}, {}, {path: 'C:/x'}), 'path');
  assert.equal(previewKind({id: 'message', kind: 'preview', options: [], label: 'Are you sure you want to delete this page/section?'}, {message: 'Sure?'}, {}), 'text');
  assert.equal(previewKind({id: 'preview', kind: 'preview', options: [], label: 'Preview'}, {text: 'Aa'}, {font: 'Arial'}), 'font');
  assert.equal(previewKind({id: 'preview', kind: 'preview', options: [], label: 'Preview'}, {new: '#fff', current: '#000'}, {}), 'colors');
});
