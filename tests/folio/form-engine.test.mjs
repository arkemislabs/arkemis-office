// core/folio/lib/form-*.mjs: the AcroForm engine behind Prepare Form and filling forms.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft crates/forms: lib.rs, read.rs, values.rs, author/*, tab_order.rs,
//    calc_order.rs, af/*; crates/ui-egui/src/tools/prepare.rs arrange): fields read from the field tree
//    with inherited attributes; set_value validates and redraws; Clear form goes back to /DV; new fields
//    are named Text1, Check Box1, Group1, Dropdown1, List Box1, Button1, Date1, Signature1, with a thin
//    grey border and white fill, Helvetica auto size, and appearance streams drawn at once. Acrobat's
//    Prepare Form behaves the same way.
// 2. Ours does the same end to end: the tests below build real PDFs, fill them, save and reload them
//    with pdf-lib's own form API (the way another reader sees them).
// 3. Proved here; the window flow is tests/e2e/folio/form.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName} from 'pdf-lib';
import {textPdf} from '../../core/folio/fixtures.mjs';
import * as E from '../../core/folio/lib/form-edit.mjs';
import {readFields, refOfKey} from '../../core/folio/lib/form-read.mjs';
import * as af from '../../core/folio/lib/form-af.mjs';

const fresh = async () => PDFDocument.load(await textPdf({pages: 2}));
const roundTrip = async pdf => PDFDocument.load(await pdf.save({updateFieldAppearances: false}));
const R = [72, 600, 216, 622];

test('new fields follow Acrobat: names, flags, thin grey border, appearance drawn at once', async () => {
  const pdf = await fresh();
  const names = {};
  for (const [kind, spec] of [['text', {}], ['checkbox', {}], ['radio', {exportValue: 'A'}], ['combo', {options: ['x', 'y']}], ['list', {options: ['p', 'q', 'r']}],
    ['button', {caption: 'Go'}], ['date', {}], ['signature', {}], ['image', {}]]) {
    const r = E.addField(pdf, 0, [72, 100 + Object.keys(names).length * 40, 200, 130 + Object.keys(names).length * 40], {kind, ...spec});
    names[kind] = r.name;
  }
  assert.deepEqual(names, {text: 'Text1', checkbox: 'Check Box1', radio: 'Group1', combo: 'Dropdown1', list: 'List Box1', button: 'Button1', date: 'Date1', signature: 'Signature1', image: 'Image1'});
  const back = await roundTrip(pdf);
  const fields = readFields(back);
  assert.equal(fields.length, 9);
  const text = fields.find(f => f.name === 'Text1');
  assert.equal(text.da, '/Helv 0 Tf 0 g');
  assert.deepEqual(text.widgets[0].look.border, [0.55, 0.55, 0.55]);
  assert.deepEqual(text.widgets[0].look.fill, [1, 1, 1]);
  const form = back.getForm();
  assert.equal(form.getTextField('Text1').getText(), undefined);
  assert.ok(form.getCheckBox('Check Box1'));
  assert.ok(form.getRadioGroup('Group1'));
  assert.deepEqual(form.getDropdown('Dropdown1').getOptions(), ['x', 'y']);
  assert.deepEqual(form.getOptionList('List Box1').getOptions(), ['p', 'q', 'r']);
  assert.ok(form.getButton('Button1'));
  assert.ok(form.getSignature('Signature1'));
  // Every widget has a normal appearance.
  for (const f of fields) for (const w of f.widgets) {
    const ap = back.context.lookup(refOfKey(w.id)).lookup(PDFName.of('AP'));
    assert.ok(ap?.lookup(PDFName.of('N')), `${f.name} has a normal appearance`);
  }
  assert.equal(fields.find(f => f.name === 'Date1').actions.format.kind, 'date');
  assert.equal(fields.find(f => f.name === 'Date1').actions.format.fmt, 'mm/dd/yyyy');
});

test('a too-small field, a clash and a radio without an export value are refused', async () => {
  const pdf = await fresh();
  assert.throws(() => E.addField(pdf, 0, [10, 10, 12, 12], {kind: 'text'}), /too small/);
  E.addField(pdf, 0, R, {kind: 'text'}, 'name');
  assert.throws(() => E.addField(pdf, 0, R, {kind: 'text'}, 'name'), /already exists/);
  assert.throws(() => E.addField(pdf, 0, R, {kind: 'text'}, 'name.first'), /can't be used beside/);
  assert.throws(() => E.addField(pdf, 5, R, {kind: 'text'}), /page 6 does not exist/);
  assert.throws(() => E.addField(pdf, 0, R, {kind: 'radio', exportValue: 'Off', group: 'g'}), /other than Off/);
});

test('filling: text, check box, radio, drop-down and list are real AcroForm values another reader sees', async () => {
  const pdf = await fresh();
  E.addField(pdf, 0, R, {kind: 'text'}, 'name');
  E.addField(pdf, 0, [72, 560, 86, 574], {kind: 'checkbox'}, 'agree');
  E.addField(pdf, 0, [72, 520, 86, 534], {kind: 'radio', group: 'size', exportValue: 'S'});
  E.addField(pdf, 0, [100, 520, 114, 534], {kind: 'radio', group: 'size', exportValue: 'L'});
  E.addField(pdf, 0, [72, 480, 216, 502], {kind: 'combo', options: ['Red', 'Green']}, 'colour');
  E.addField(pdf, 0, [72, 400, 216, 460], {kind: 'list', options: ['a', 'b', 'c', 'd', 'e', 'f'], multi: true}, 'letters');
  E.setValue(pdf, 'name', 'Ada Lovelace');
  E.setValue(pdf, 'agree', true);
  E.setValue(pdf, 'size', 'L');
  E.setValue(pdf, 'colour', 'Green');
  E.setValue(pdf, 'letters', ['b', 'f']);
  const back = await roundTrip(pdf);
  const form = back.getForm();
  assert.equal(form.getTextField('name').getText(), 'Ada Lovelace');
  assert.equal(form.getCheckBox('agree').isChecked(), true);
  assert.equal(form.getRadioGroup('size').getSelected(), 'L');
  assert.deepEqual(form.getDropdown('colour').getSelected(), ['Green']);
  assert.deepEqual(form.getOptionList('letters').getSelected(), ['b', 'f']);
  const fields = readFields(back);
  assert.deepEqual(fields.find(f => f.name === 'letters').value, ['b', 'f']);
  // The list box scrolls so the picks show.
  E.setValue(pdf, 'agree', false);
  assert.equal(readFields(pdf).find(f => f.name === 'agree').value.length, 0);
});

test('values are validated: options, max length, read-only, single versus multi-select; a failed call changes nothing', async () => {
  const pdf = await fresh();
  E.addField(pdf, 0, R, {kind: 'text'}, 'code');
  E.setProps(pdf, 'code', {maxLen: 3});
  E.addField(pdf, 0, [72, 560, 216, 582], {kind: 'combo', options: ['a', 'b']}, 'pick');
  E.addField(pdf, 0, [72, 520, 216, 542], {kind: 'text'}, 'locked');
  E.setProps(pdf, 'locked', {readOnly: true});
  assert.throws(() => E.setValue(pdf, 'code', 'abcd'), /at most 3/);
  assert.throws(() => E.setValue(pdf, 'pick', 'zzz'), /has no option/);
  assert.throws(() => E.setValue(pdf, 'pick', ['a', 'b']), /single value/);
  assert.throws(() => E.setValue(pdf, 'locked', 'x'), /read-only/);
  assert.throws(() => E.setValue(pdf, 'missing', 'x'), /no field named/);
  assert.deepEqual(readFields(pdf).find(f => f.name === 'code').value, []);
  E.setValue(pdf, 'locked', 'imported', {force: true});
  assert.deepEqual(readFields(pdf).find(f => f.name === 'locked').value, ['imported']);
});

test('Clear form goes back to /DV', async () => {
  const pdf = await fresh();
  E.addField(pdf, 0, R, {kind: 'text'}, 'a');
  E.setProps(pdf, 'a', {defaultValue: 'start'});
  E.addField(pdf, 0, [72, 560, 86, 574], {kind: 'checkbox'}, 'c');
  E.setValue(pdf, 'a', 'changed');
  E.setValue(pdf, 'c', true);
  assert.equal(E.reset(pdf), 2);
  const f = readFields(pdf);
  assert.deepEqual(f.find(x => x.name === 'a').value, ['start']);
  assert.deepEqual(f.find(x => x.name === 'c').value, []);
  E.setValue(pdf, 'a', 'again');
  assert.equal(E.reset(pdf, ['c']), 1);
  assert.deepEqual(readFields(pdf).find(x => x.name === 'a').value, ['again']);
});

test('Format, Validate and Calculate tabs are written as Acrobat scripts and run', async () => {
  const pdf = await fresh();
  E.addField(pdf, 0, [72, 600, 172, 622], {kind: 'text'}, 'price');
  E.addField(pdf, 0, [72, 560, 172, 582], {kind: 'text'}, 'qty');
  E.addField(pdf, 0, [72, 520, 172, 542], {kind: 'text'}, 'total');
  E.setProps(pdf, 'price', {format: {kind: 'number', decimals: 2, sep: 0, neg: 0, currency: '$', prepend: true}, validate: {kind: 'range', min: 0, max: 1000}});
  E.setProps(pdf, 'total', {calculate: {kind: 'notation', expr: 'price * qty'}});
  assert.throws(() => E.setValue(pdf, 'price', 'ten'), /does not match the format/);
  assert.throws(() => E.setValue(pdf, 'price', '5000'), /less than or equal to 1000/);
  E.setValue(pdf, 'price', '$12.50');
  E.setValue(pdf, 'qty', '4');
  const fields = readFields(pdf);
  assert.deepEqual(fields.find(f => f.name === 'total').value, ['50']);
  assert.equal(fields.find(f => f.name === 'price').actions.format.kind, 'number');
  assert.equal(fields.find(f => f.name === 'price').actions.validate.max, 1000);
  assert.equal(fields.find(f => f.name === 'total').actions.calculate.expr, 'price * qty');
  // Renaming a field renames it in the calculation that reads it.
  E.setProps(pdf, 'qty', {name: 'quantity'});
  assert.equal(readFields(pdf).find(f => f.name === 'total').actions.calculate.expr, 'price * quantity');
  E.setValue(pdf, 'quantity', '2');
  assert.deepEqual(readFields(pdf).find(f => f.name === 'total').value, ['25']);
  const order = E.calculationOrder(pdf);
  assert.deepEqual(order.fields.map(f => [f.name, f.reads, f.listed]), [['total', ['price', 'quantity'], true]]);
});

test('calculation order: reads, runs-too-early and cycles, Fix order, move', async () => {
  const pdf = await fresh();
  for (const n of ['a', 'b', 'c']) E.addField(pdf, 0, [72, 600 - 40 * 'abc'.indexOf(n), 172, 622 - 40 * 'abc'.indexOf(n)], {kind: 'text'}, n);
  E.setProps(pdf, 'a', {calculate: {kind: 'simple', op: 'SUM', fields: ['b']}});
  E.setProps(pdf, 'b', {calculate: {kind: 'notation', expr: 'c * 2'}});
  let order = E.calculationOrder(pdf);
  assert.deepEqual(order.fields.map(f => f.name), ['a', 'b']);
  assert.deepEqual(order.fields[0].issues, [{kind: 'runs_too_early', field: 'b'}]);
  assert.equal(order.fixable, true);
  assert.deepEqual(order.fixed, ['b', 'a']);
  E.setCalculationOrder(pdf, order.fixed);
  order = E.calculationOrder(pdf);
  assert.deepEqual(order.fields.map(f => f.name), ['b', 'a']);
  assert.equal(order.fixable, false);
  assert.equal(E.moveInCalculationOrder(pdf, 'a', true), true);
  assert.deepEqual(E.calculationOrder(pdf).fields.map(f => f.name), ['a', 'b']);
  E.setProps(pdf, 'b', {calculate: {kind: 'notation', expr: 'a + 1'}});
  assert.equal(E.calculationOrder(pdf).fields[0].issues[0].kind, 'cycle');
});

test('properties: rename, tooltip, flags, look patch keeps the rest, rotation, lock', async () => {
  const pdf = await fresh();
  E.addField(pdf, 0, R, {kind: 'text'}, 'a');
  E.addField(pdf, 0, [72, 560, 216, 582], {kind: 'text'}, 'b');
  assert.throws(() => E.setProps(pdf, 'a', {name: 'b'}), /already exists/);
  const r = E.setProps(pdf, 'a', {name: 'first.name', tooltip: 'Your name', required: true, multiline: true, quadding: 1, fontSize: 14,
    appearance: {border: null, fill: [1, 0.9, 0.9], width: 3, style: 'Dashed', text: [0, 0, 1]}});
  assert.equal(r.name, 'first.name');
  let f = readFields(pdf).find(x => x.name === 'first.name');
  assert.equal(f.tooltip, 'Your name');
  assert.ok(f.flags & E.FLAG.REQUIRED && f.flags & E.FLAG.MULTILINE);
  assert.equal(f.quadding, 1);
  assert.equal(f.da, '/Helv 14 Tf 0 0 1 rg');
  assert.equal(f.widgets[0].look.border, null);
  assert.deepEqual(f.widgets[0].look.fill, [1, 0.9, 0.9]);
  assert.equal(f.widgets[0].look.width, 3);
  assert.equal(f.widgets[0].look.style, 'D');
  E.setProps(pdf, 'first.name', {rotation: [0, 90]});
  f = readFields(pdf).find(x => x.name === 'first.name');
  assert.equal(f.widgets[0].rotation, 90);
  assert.ok(Math.abs((f.widgets[0].rect[3] - f.widgets[0].rect[1]) - 144) < 1e-6, 'width and height swap around the centre');
  E.setProps(pdf, 'first.name', {locked: true});
  assert.throws(() => E.setProps(pdf, 'first.name', {tooltip: 'x'}), /is locked/);
  E.setProps(pdf, 'first.name', {locked: false});
  assert.throws(() => E.setProps(pdf, 'first.name', {flags: [[E.FLAG.COMB, true]]}), /character limit/);
  assert.throws(() => E.setProps(pdf, 'first.name', {fontSize: -1}), /non-negative/);
});

test('delete, duplicate onto another page, delete one widget; tab order; arrange', async () => {
  const pdf = await fresh();
  E.addField(pdf, 0, [72, 600, 172, 622], {kind: 'text'}, 'a');
  E.addField(pdf, 0, [200, 600, 300, 622], {kind: 'text'}, 'b');
  E.addField(pdf, 0, [72, 540, 172, 562], {kind: 'text'}, 'c');
  assert.equal(E.duplicateField(pdf, 'a', [0, 1]), 1);
  let f = readFields(pdf);
  assert.deepEqual(f.find(x => x.name === 'a').widgets.map(w => w.page), [0, 1]);
  E.setValue(pdf, 'a', 'shared');
  assert.deepEqual(readFields(pdf).find(x => x.name === 'a').widgets.length, 2);
  E.deleteWidget(pdf, 'a', 1);
  assert.deepEqual(readFields(pdf).find(x => x.name === 'a').widgets.map(w => w.page), [0]);
  E.setTabOrder(pdf, [0], 'row');
  assert.deepEqual(readFields(pdf).map(x => [x.name, x.widgets[0].tab]), [['a', 0], ['b', 1], ['c', 2]]);
  E.setTabOrder(pdf, [0], 'column');
  assert.deepEqual(readFields(pdf).map(x => [x.name, x.widgets[0].tab]), [['a', 0], ['b', 2], ['c', 1]]);
  assert.deepEqual(E.tabOrders(pdf), ['column', 'annotations']);
  assert.equal(E.moveInTabOrder(pdf, 'c', true), true);
  assert.equal(E.tabOrders(pdf)[0], 'annotations');
  E.deleteField(pdf, 'b');
  assert.deepEqual(readFields(pdf).map(x => x.name), ['a', 'c']);
  assert.throws(() => E.deleteField(pdf, 'b'), /no field named/);
  const back = await roundTrip(pdf);
  assert.deepEqual(back.getForm().getFields().map(x => x.getName()), ['a', 'c']);
});

test('arrange: align, centre, distribute and match size against the anchor', () => {
  const anchor = {key: 'a', rect: [100, 100, 200, 120]};
  const others = [{key: 'b', rect: [150, 200, 230, 230]}, {key: 'c', rect: [60, 300, 140, 340]}];
  const m = op => Object.fromEntries(E.arrange(anchor, others, op).map(x => [x.key, x.rect]));
  assert.deepEqual(m('align_left'), {b: [100, 200, 180, 230], c: [100, 300, 180, 340]});
  assert.deepEqual(m('align_right'), {b: [120, 200, 200, 230], c: [120, 300, 200, 340]});
  assert.deepEqual(m('align_bottom'), {b: [150, 100, 230, 130], c: [60, 100, 140, 140]});
  assert.deepEqual(m('same_width'), {b: [150, 200, 250, 230], c: [60, 300, 160, 340]});
  assert.deepEqual(m('same_height'), {b: [150, 210, 230, 230], c: [60, 320, 140, 340]});
  assert.deepEqual(m('center_h'), {b: [110, 200, 190, 230], c: [110, 300, 190, 340]});
  const d = E.arrange({key: 'x', rect: [0, 0, 10, 10]}, [{key: 'y', rect: [20, 0, 30, 10]}, {key: 'z', rect: [100, 0, 110, 10]}], 'distribute_h');
  assert.deepEqual(d.map(x => [x.key, x.rect[0]]), [['y', 50]], 'even gaps: the outer two stay');
  assert.deepEqual(E.arrange(anchor, [], 'align_left'), []);
});

test('flatten draws the widget appearances into the pages and removes the form', async () => {
  const pdf = await fresh();
  E.addField(pdf, 0, R, {kind: 'text'}, 'name');
  E.addField(pdf, 0, [72, 560, 86, 574], {kind: 'checkbox'}, 'agree');
  E.setValue(pdf, 'name', 'Ada');
  E.setValue(pdf, 'agree', true);
  assert.equal(E.flattenFields(pdf), 2);
  assert.equal(readFields(pdf).length, 0);
  const back = await roundTrip(pdf);
  assert.equal(back.getForm().getFields().length, 0);
});

test('AF scripts: formats, dates, masks and calculations (ported af/tests.rs)', () => {
  const n = (d, s, ng, c, p) => ({kind: 'number', decimals: d, sep: s, neg: ng, currency: c, prepend: p});
  assert.equal(af.formatValue(n(2, 0, 0, '$', true), '1234.5'), '$1,234.50');
  assert.equal(af.formatValue(n(2, 2, 0, ' €', false), '1234.5'), '1.234,50 €');
  assert.equal(af.formatValue(n(2, 0, 2, '', true), '-12'), '(12.00)');
  assert.equal(af.formatValue({kind: 'percent', decimals: 1, sep: 0}, '0.125'), '12.5%');
  assert.equal(af.makeNumber('$1,234.50'), 1234.5);
  assert.equal(af.makeNumber('1.234,5'), 1234.5);
  assert.equal(af.makeNumber('(7)'), -7);
  assert.equal(af.keystroke(n(2, 0, 0, '$', true), 'Total', '$1,000').value, '1000');
  assert.match(af.keystroke(n(2, 0, 0, '$', true), 'Total', 'ten').error, /\[ Total \]/);
  assert.equal(af.keystroke(n(2, 0, 0, '$', true), 'Total', ' \t').value, '');
  const d = {kind: 'date', fmt: 'mm/dd/yyyy'};
  assert.equal(af.formatValue(d, '1/2/24'), '01/02/2024');
  assert.equal(af.formatValue({kind: 'date', fmt: 'mmmm d, yyyy'}, '10/1/2026'), 'October 1, 2026');
  assert.equal(af.formatValue({kind: 'date', fmt: 'dddd, mmm d, yyyy'}, '10/1/2026'), 'Thursday, Oct 1, 2026');
  assert.ok(af.keystroke(d, 'Due', '2/30/2024').error);
  assert.equal(af.formatValue({kind: 'date', fmt: 'dd.mm.26'}, '3.1'), '03.01.26');
  assert.equal(af.formatValue({kind: 'time', fmt: 'h:MM tt'}, '14:05'), '2:05 pm');
  assert.equal(af.formatValue({kind: 'special', n: 2}, '5551234567'), '(555) 123-4567');
  assert.equal(af.formatValue({kind: 'mask', mask: 'AA-9999'}, 'ab1234'), 'ab-1234');
  assert.ok(af.keystroke({kind: 'mask', mask: 'AA-9999'}, 'Code', 'a11234').error);
  assert.equal(af.parseDate('20261018', 'yyyymmdd').d, 18);
  assert.equal(af.parseDate('202610018', 'yyyymmdd'), null);
  assert.equal(af.validate({kind: 'range', min: 0, max: 100}, '120'), 'Invalid value: must be greater than or equal to 0 and less than or equal to 100.');
  const vals = name => ({a: ['2'], b: ['$3.50'], row: ['1', '2', '3'], 'Unit Price': ['4']}[name] ?? []);
  assert.equal(af.calculate({kind: 'simple', op: 'SUM', fields: ['a', 'b']}, vals), '5.5');
  assert.equal(af.calculate({kind: 'simple', op: 'AVG', fields: ['row']}, vals), '2');
  assert.equal(af.calculate({kind: 'notation', expr: '(a + b) * 2 - Unit\\ Price / 4'}, vals), '10');
  assert.equal(af.calculate({kind: 'notation', expr: 'a +'}, vals), null);
  assert.deepEqual(af.parseFormat('AFNumber_Format(2, 0, 0, 0, "\\x24", true);'), n(2, 0, 0, '$', true));
  assert.deepEqual(af.parseCalculate('/** BVCALC Price * Qty EVCALC **/ event.value = 1'), {kind: 'notation', expr: 'Price * Qty'});
  const nn = e => af.calculateJs({kind: 'notation', expr: e});
  assert.equal(nn('(Unit\\ Price * Qty) / 2'), '/** BVCALC (Unit\\ Price * Qty) / 2 EVCALC **/ event.value = (AFMakeNumber(this.getField("Unit Price").value) * AFMakeNumber(this.getField("Qty").value)) / 2;');
  assert.equal(af.renameInCalculation(nn('(a + ab) * a / 2'), 'a', 'Unit Price'), nn('(Unit\\ Price + ab) * Unit\\ Price / 2'));
  assert.equal(af.renameInCalculation('AFSimple_Calculate("SUM", new Array ("a", "b"));', 'a', 'qty'), 'AFSimple_Calculate("SUM", new Array ("qty", "b"));');
  assert.equal(af.renameInCalculation(nn('a * 2'), 'a', 'qtyEVCALC'), null);
  assert.deepEqual(af.calculationReads('var t = getField("sub").value; // getField("x")\nevent.value = t + getField("tax").value + getField("row" + 1).value;'), ['sub', 'tax']);
  assert.equal(af.notationName('2nd + (x)\\'), '\\2nd\\ \\+\\ \\(x\\)\\\\');
});
