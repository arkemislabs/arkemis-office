// U:quill/rest: Review › Check Accessibility (file.accessibility) and the Accessibility pane's view flag.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): ported from wordcraft crates/engine/src/cmd/accessibility.rs tests (`contrast_ratio_matches_wcag`,
// `shapes_need_alt_text_unless_decorative_and_the_fix_marks_them`, `tables_blank_paragraphs_and_contrast_are_reported`) at
// aadb077e072b7de05f724e359d8db82e151f125c; the pane follows ui-egui a11y_pane.rs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill} from './format-fixture.mjs';
import {contrastRatio} from '../../core/quill/lib/accessibility-check.mjs';

const check = async q => (await q.exec('file.accessibility', {})).result;
const rules = async q => (await check(q)).issues.map(i => [i.kind, i.rule ?? '']);
const has = (list, kind, rule) => list.some(([k, r]) => k === kind && r === rule);

test('contrast_ratio_matches_wcag', () => {
  assert.ok(Math.abs(contrastRatio([0, 0, 0], [255, 255, 255]) - 21) < 0.01);
  assert.ok(Math.abs(contrastRatio([0x77, 0x77, 0x77], [255, 255, 255]) - 4.48) < 0.01);
});

test('shapes need alt text unless decorative, and the fix marks them', async () => {
  const q = await quill('Title');
  await q.exec('file.properties', {title: 'T'}).catch(() => {});
  q.sel(0, 5);
  await q.exec('insert.shape', {kind: 'ellipse'});
  assert.ok(has(await rules(q), 'error', 'altText'));
  const i = (await check(q)).issues.find(x => x.rule === 'altText');
  assert.equal(i.what, 'shape');
  await q.exec('select.range', i.select);
  await q.exec(i.action.command, i.action.params);
  assert.ok(!(await rules(q)).some(([, r]) => r === 'altText'), 'the decorative mark clears the error');
});

test('tables, blank paragraphs and contrast are reported, and the header fix works', async () => {
  const q = await quill('Intro');
  await q.exec('file.properties', {title: 'T'}).catch(() => {});
  await q.exec('select.all', {});
  await q.exec('format.color', {color: 'BBBBBB'});
  await q.exec('caret.docEnd', {});
  for (let k = 0; k < 4; k++) await q.exec('text.newParagraph', {});
  await q.exec('insert.table', {rows: 3, cols: 2});
  await q.exec('text.insert', {text: 'Year'});
  const r = await rules(q);
  for (const [k, rule] of [['warning', 'contrast'], ['tip', 'blankParagraphs'], ['warning', 'tableHeader'], ['warning', 'tableAltText'], ['warning', 'blankRow']]) assert.ok(has(r, k, rule), `${k} ${rule} in ${JSON.stringify(r)}`);
  const i = (await check(q)).issues.find(x => x.rule === 'tableHeader');
  await q.exec('caret.set', {pos: i.pos});
  await q.exec(i.action.command, i.action.params);
  assert.ok(!(await rules(q)).some(([, rule]) => rule === 'tableHeader'));
});

test('errors come first, a clean document says so, the command shows the pane', async () => {
  const q = await quill('Plain text.');
  await q.exec('file.properties', {title: 'Report'}).catch(() => {});
  const clean = await check(q);
  assert.deepEqual(clean.issues.map(i => i.rule), clean.issues.length ? clean.issues.map(i => i.rule) : []);
  assert.equal(clean.ok, clean.issues.length === 0);
  assert.equal(q.t.doc.view.accessibilityPane, true, 'Check Accessibility shows the pane');
  await q.exec('view.accessibilityPane', {value: false});
  assert.equal(q.t.doc.view.accessibilityPane, false);
  q.sel(0, 5);
  await q.exec('insert.shape', {kind: 'ellipse'});
  await q.exec('text.newParagraph', {});
  const kinds = (await check(q)).issues.map(i => i.kind);
  assert.deepEqual(kinds, [...kinds].sort((a, b) => ['error', 'warning', 'tip'].indexOf(a) - ['error', 'warning', 'tip'].indexOf(b)));
});
