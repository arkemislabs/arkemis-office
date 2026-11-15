// What printcraft 8f16855 changed in the forms engine since 3109bb2 (crates/forms: af/calc.rs, af/script.rs, calc_order.rs, author/edit.rs,
// lib.rs export_values): a Calculate script that builds field names at run time, notation that cannot be stored, fields a formula reads
// that the form does not have, a button's export value, and form data exported with those export values.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft 0.16.0: `getField("row" + i)` and an AFSimple_Calculate list that is not written out are names built at run time (the
//    calculation order says it cannot check against them); a formula that reads a field the form does not have is flagged; notation
//    that would be stored as a different formula (empty, holding EVCALC or */, ending in a lone backslash) is refused before anything
//    is written; one check box or radio button's export value changes without changing its appearance state (widgets sharing the state
//    stay in sync; empty, Off and a clash with another choice are refused); FDF, XFDF, XML and CSV exports write export values.
//    Acrobat's calculation order, Calculate tab and Options tab work the same way.
// 2. Ours does the same on real PDFs built with pdf-lib, read back after save.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFString} from 'pdf-lib';
import {textPdf} from '../../core/folio/fixtures.mjs';
import * as E from '../../core/folio/lib/form-edit.mjs';
import * as D from '../../core/folio/lib/form-data.mjs';
import * as af from '../../core/folio/lib/form-af.mjs';
import {readFields, refOfKey} from '../../core/folio/lib/form-read.mjs';

const fresh = async () => PDFDocument.load(await textPdf({pages: 1}));

test('names built at run time are sites of their own: they are not reads, and a script that has them says so', () => {
  assert.equal(af.readsBuiltNames('event.value = this.getField("a").value;'), false);
  assert.deepEqual(af.calculationReads('event.value = this.getField("a").value;'), ['a']);
  assert.equal(af.readsBuiltNames('event.value = this.getField("row" + i).value;'), true);
  assert.deepEqual(af.calculationReads('event.value = this.getField("row" + i).value;'), []);
  assert.equal(af.readsBuiltNames('AFSimple_Calculate("SUM", "a,b");'), false);
  assert.equal(af.readsBuiltNames('AFSimple_Calculate("SUM", "a," + more);'), true);
  assert.equal(af.readsBuiltNames('AFSimple_Calculate("SUM", new Array("a", "b"));'), false);
  assert.deepEqual(af.calculationReads('AFSimple_Calculate("SUM", new Array("a", "b" + i));'), ['a']);
  assert.equal(af.readsBuiltNames('AFSimple_Calculate("SUM", new Array("a", "b" + i));'), true);
  assert.equal(af.readsBuiltNames('AFSimple_Calculate("SUM", ["a", "b"].concat(more));'), true);
  assert.deepEqual(af.calculationReads('AFSimple_Calculate("SUM", ["a", "b"].concat(more));'), ['a', 'b']);
  assert.equal(af.readsBuiltNames('AFSimple_Calculate("SUM", names);'), true);
  assert.equal(af.readsBuiltNames('AFSimple_Calculate("SUM", "a,b", extra);'), true);
  assert.equal(af.renameInCalculation('this.getField("row" + i).value', 'row', 'x'), null, 'a built name has nothing to rename');
});

test('notation that would be stored as another formula is refused before anything is written; the notation read back keeps an escaped space', async () => {
  for (const bad of ['', '   ', 'a EVCALC b', 'a */ b', 'Total\\']) assert.equal(af.notationStorable(bad), false, JSON.stringify(bad));
  for (const ok of ['price * qty', '(a + b) / 2', 'Total\\ cost * 2']) assert.equal(af.notationStorable(ok), true, ok);
  assert.ok(af.NOTATION_NOT_STORABLE.includes('EVCALC'));
  const pdf = await fresh();
  E.addField(pdf, 0, [72, 600, 172, 622], {kind: 'text'}, 'a');
  E.addField(pdf, 0, [72, 560, 172, 582], {kind: 'text'}, 'Total cost');
  const before = JSON.stringify(readFields(pdf).map(f => f.actions));
  assert.throws(() => E.setProps(pdf, 'a', {calculate: {kind: 'notation', expr: 'x EVCALC y'}}), /can't be stored/);
  assert.equal(JSON.stringify(readFields(pdf).map(f => f.actions)), before, 'nothing was written');
  E.setProps(pdf, 'a', {calculate: {kind: 'notation', expr: 'Total\\ cost * 2'}});
  assert.equal(readFields(pdf).find(f => f.name === 'a').actions.calculate.expr, 'Total\\ cost * 2');
});

test('the calculation order flags a read of a field the form does not have (a group name is not missing)', async () => {
  const pdf = await fresh();
  for (const [k, n] of ['total', 'price', 'row.1'].entries()) E.addField(pdf, 0, [72, 600 - 40 * k, 172, 622 - 40 * k], {kind: 'text'}, n);
  E.setProps(pdf, 'total', {calculate: {kind: 'notation', expr: 'price * ghost + row'}});
  let order = E.calculationOrder(pdf);
  assert.deepEqual(order.fields[0].issues, [{kind: 'missing_field', field: 'ghost'}], 'row finds row.1: a group, not a missing field');
  E.setProps(pdf, 'total', {calculate: {kind: 'notation', expr: 'price * 2'}});
  assert.deepEqual(E.calculationOrder(pdf).fields[0].issues, []);
});

test('a check box or radio button export value changes without changing its appearance state; conflicts are refused', async () => {
  const pdf = await fresh();
  E.addField(pdf, 0, [72, 600, 86, 614], {kind: 'radio', group: 'size', exportValue: 'S'}, null);
  E.addField(pdf, 0, [100, 600, 114, 614], {kind: 'radio', group: 'size', exportValue: 'M'}, null);
  const f0 = readFields(pdf).find(f => f.name === 'size');
  assert.equal(f0.widgets.length, 2);
  const states = f0.widgets.map(w => w.onState);
  E.setProps(pdf, 'size', {exportValue: [1, 'Medium']});
  const f1 = readFields(pdf).find(f => f.name === 'size');
  assert.deepEqual(f1.widgets.map(w => w.onState), states, 'the appearance states stay');
  assert.deepEqual(f1.widgets.map((_, i) => E.exportOf(f1, i)), [states[0], 'Medium'].map((x, i) => (i === 0 ? E.exportOf(f0, 0) : x)));
  for (const [bad, message] of [[[1, ''], /non-empty/], [[1, 'Off'], /not Off/], [[5, 'X'], /out of range/], [[1, E.exportOf(f1, 0)], /conflicts/]]) {
    assert.throws(() => E.setProps(pdf, 'size', {exportValue: bad}), message, JSON.stringify(bad));
  }
  assert.throws(() => E.setProps(pdf, 'size', {exportValue: [0, 'Z'], options: ['a']}), /not both/);
  E.addField(pdf, 0, [72, 560, 86, 574], {kind: 'text'}, 'name');
  assert.throws(() => E.setProps(pdf, 'name', {exportValue: [0, 'Z']}), /only check boxes and radio buttons/);
});

test('form data exports write the export value a button choice has, not its appearance state', async () => {
  const pdf = await fresh();
  E.addField(pdf, 0, [72, 600, 86, 614], {kind: 'radio', group: 'size', exportValue: 'S'}, null);
  E.addField(pdf, 0, [100, 600, 114, 614], {kind: 'radio', group: 'size', exportValue: 'M'}, null);
  E.setProps(pdf, 'size', {exportValue: [1, 'Medium']});
  E.setValue(pdf, 'size', 'Medium');
  const reread = readFields(pdf).find(f => f.name === 'size');
  assert.notEqual(reread.value[0], 'Medium', 'the state is still the appearance name');
  assert.match(D.exportData(pdf, 'csv'), /^size\nMedium$/m);
  assert.match(Buffer.from(D.exportFdf(pdf)).toString('latin1'), /\/V \/Medium/);
  assert.match(D.exportData(pdf, 'xml'), />Medium</);
});

test('the calculation order says when a script also reads fields by names it builds, which it cannot check the order against', async () => {
  const pdf = await fresh();
  E.addField(pdf, 0, [72, 600, 172, 622], {kind: 'text'}, 'total');
  E.addField(pdf, 0, [72, 560, 172, 582], {kind: 'text'}, 'row1');
  const field = readFields(pdf).find(f => f.name === 'total');
  const script = 'var s = 0; for (var i = 1; i < 3; i++) s += Number(this.getField("row" + i).value); event.value = s + Number(this.getField("row1").value);';
  pdf.context.lookup(refOfKey(field.id)).set(PDFName.of('AA'), pdf.context.obj({C: {S: 'JavaScript', JS: PDFString.of(script)}}));
  const order = E.calculationOrder(pdf);
  const total = order.fields.find(f => f.name === 'total');
  assert.deepEqual(total.reads, ['row1'], 'the literal read is listed; the built name is not');
  assert.ok(total.issues.map(i => i.kind).includes('built_names'));
});
