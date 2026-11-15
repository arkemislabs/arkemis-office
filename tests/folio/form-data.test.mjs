// core/folio/lib/form-data.mjs and form-detect.mjs: Export data, Import data, Merge data files and
// automatic field detection.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft crates/xfdf/src/lib.rs, xfdf.rs, fdf.rs, common.rs; crates/forms/src/detect.rs):
//    Export data writes the field values as XFDF (nested <field> per name part), FDF, XML, CSV or tab
//    text, check boxes and radio groups as Off when empty; Import reads any of them, a DTD is refused,
//    nesting is bounded, a CSV cell that would run as a spreadsheet formula gets a leading apostrophe
//    that import takes off again; detection finds underscore runs, rules, boxes, comb rows and small
//    squares and names each from its label. Acrobat's data export and Prepare Form's auto-detect do
//    the same.
// 2. Ours does the same: real PDFs built with pdf-lib, exported, cleared and imported back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {textPdf} from '../../core/folio/fixtures.mjs';
import * as E from '../../core/folio/lib/form-edit.mjs';
import * as D from '../../core/folio/lib/form-data.mjs';
import {readFields} from '../../core/folio/lib/form-read.mjs';
import {detect, shapesOfContent, contentOps} from '../../core/folio/lib/form-detect.mjs';

const form = async () => {
  const pdf = await PDFDocument.load(await textPdf({pages: 1}));
  E.addField(pdf, 0, [72, 700, 200, 722], {kind: 'text'}, 'person.first');
  E.addField(pdf, 0, [72, 660, 200, 682], {kind: 'text'}, 'person.last');
  E.addField(pdf, 0, [72, 620, 86, 634], {kind: 'checkbox'}, 'agree');
  E.addField(pdf, 0, [72, 580, 100, 594], {kind: 'radio', group: 'size', exportValue: 'S'});
  E.addField(pdf, 0, [110, 580, 138, 594], {kind: 'radio', group: 'size', exportValue: 'L'});
  E.addField(pdf, 0, [72, 540, 200, 562], {kind: 'combo', options: ['Red', 'Green']}, 'colour');
  E.addField(pdf, 0, [72, 440, 200, 520], {kind: 'list', options: ['a', 'b', 'c'], multi: true}, 'letters');
  E.addField(pdf, 0, [72, 400, 172, 424], {kind: 'button', caption: 'Go'}, 'go');
  E.addField(pdf, 0, [72, 360, 252, 396], {kind: 'signature'}, 'sig');
  return pdf;
};
const valuesOf = pdf => Object.fromEntries(readFields(pdf).map(f => [f.name, f.value]));
const bytes = s => (typeof s === 'string' ? new TextEncoder().encode(s) : s);

test('XFDF export nests fields by name part; buttons and signatures carry no data; Off when empty', async () => {
  const pdf = await form();
  E.setValue(pdf, 'person.first', 'Zoë & <Ada>');
  E.setValue(pdf, 'agree', true);
  E.setValue(pdf, 'size', 'L');
  E.setValue(pdf, 'letters', ['a', 'c']);
  const x = D.exportXfdf(pdf, 'form.pdf');
  assert.match(x, /<field name="person">\s*<field name="first"><value>Zoë &amp; &lt;Ada&gt;<\/value><\/field>/);
  assert.match(x, /<field name="agree"><value>[^<]+<\/value><\/field>/);
  assert.match(x, /<field name="size"><value>[^<]+<\/value><\/field>/);
  assert.match(x, /<field name="letters"><value>a<\/value><value>c<\/value><\/field>/);
  assert.ok(!x.includes('name="go"') && !x.includes('name="sig"'));
  assert.match(x, /<f href="form\.pdf"\/>/);
});

test('every data format round trips: XFDF, FDF, XML, CSV and tab text', async () => {
  const filled = await form();
  E.setValue(filled, 'person.first', 'Zoë');
  E.setValue(filled, 'person.last', 'Lovelace, "Ada"');
  E.setValue(filled, 'agree', true);
  E.setValue(filled, 'size', 'L');
  E.setValue(filled, 'colour', 'Green');
  E.setValue(filled, 'letters', ['b', 'c']);
  const want = valuesOf(filled);
  for (const format of ['xfdf', 'fdf', 'xml', 'csv', 'txt']) {
    const target = await form();
    const data = bytes(D.exportAs(filled, format, 'f.pdf'));
    const report = D.importInto(target, data);
    assert.ok(report.fields >= 6, `${format}: ${JSON.stringify(report)}`);
    assert.deepEqual(valuesOf(target)['person.first'], want['person.first'], format);
    assert.deepEqual(valuesOf(target)['person.last'], want['person.last'], format);
    assert.equal(valuesOf(target).agree.length, 1, format);
    assert.deepEqual(valuesOf(target).size, want.size, format);
    assert.deepEqual(valuesOf(target).colour, ['Green'], format);
    assert.deepEqual(valuesOf(target).letters, ['b', 'c'], format);
  }
});

test('FDF files: PDF syntax, escapes, hex and UTF-16 strings, nested /Kids names', () => {
  const fdf = '%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [<< /T (a) /V (x\\(y\\)\\nz) >> << /T (g) /Kids [<< /T (k) /V <FEFF00E900E8> >> 3 0 R] >> << /T (c) /V /Yes >>] /F (f.pdf) >> >>\nendobj\n3 0 obj\n<< /T (m) /V [(p) (q)] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';
  assert.deepEqual(D.dataValues(bytes(fdf)), [['a', ['x(y)\nz']], ['g.k', ['éè']], ['g.m', ['p', 'q']], ['c', ['Yes']]]);
  assert.throws(() => D.dataValues(bytes('%FDF-1.2\n1 0 obj\n<< /Nothing 1 >>\nendobj\n')), /no FDF data/);
});

test('a data file with a DTD is refused, deep nesting is bounded, an unknown file is refused', () => {
  const dtd = '<?xml version="1.0"?><!DOCTYPE xfdf [<!ENTITY x "boom">]><xfdf xmlns="http://ns.adobe.com/xfdf/"><fields><field name="a"><value>&x;</value></field></fields></xfdf>';
  assert.throws(() => D.dataValues(bytes(dtd)), /DTD/);
  const deep = `<xfdf xmlns="http://ns.adobe.com/xfdf/"><fields>${'<field name="a">'.repeat(70)}${'</field>'.repeat(70)}</fields></xfdf>`;
  assert.throws(() => D.dataValues(bytes(deep)), /nest more than 64/);
  assert.throws(() => D.dataValues(bytes('just some words')), /not form data/);
});

test('Import reports what the form refused and refuses a file that matches nothing', async () => {
  const pdf = await form();
  const report = D.importInto(pdf, bytes('colour,person.first\nPurple,Ada\n'));
  assert.deepEqual(report, {fields: 1, rejected: ['colour']});
  assert.deepEqual(valuesOf(pdf)['person.first'], ['Ada']);
  assert.throws(() => D.importInto(pdf, bytes('zzz,yyy\n1,2\n')), /nothing in the file matches/);
  // A read-only field still takes imported data.
  E.setProps(pdf, 'person.last', {readOnly: true});
  D.importInto(pdf, bytes('person.last\nLovelace\n'));
  assert.deepEqual(valuesOf(pdf)['person.last'], ['Lovelace']);
});

test('CSV: formula-like cells are written with a leading apostrophe and read back unchanged', async () => {
  const pdf = await form();
  E.setValue(pdf, 'person.first', '=HYPERLINK("x")');
  E.setValue(pdf, 'person.last', "'=already");
  const csv = D.exportData(pdf, 'csv');
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /''=already/);
  const target = await form();
  D.importInto(target, bytes(csv));
  assert.deepEqual(valuesOf(target)['person.first'], ['=HYPERLINK("x")']);
  assert.deepEqual(valuesOf(target)['person.last'], ["'=already"]);
  assert.equal(D.mergeCsv([[['a', ['=1']], ['b', ['-12.5']]], [['b', ['x']]]]), "a,b\n'=1,-12.5\n,x\n");
});

test('content stream shapes: rectangles (with points along the sides), rules, flat filled rectangles', () => {
  const s = shapesOfContent('q 1 0 0 1 10 10 cm 0 0 20 20 re S Q 100 100 m 300 100 l S 50 50 100 1 re f 0 0 m 10 0 l 10 10 l 0 10 l h S 0 0 m 5 0 l 10 0 l 10 10 l 0 10 l h S');
  assert.deepEqual(s.boxes, [[10, 10, 30, 30], [0, 0, 10, 10], [0, 0, 10, 10]]);
  assert.deepEqual(s.rules, [[100, 100, 300, 100], [50, 50.5, 150, 50.5]]);
  assert.deepEqual(contentOps('BI /W 1 ID xx EI (a (b) c) Tj 5 6 m').map(o => o.op), ['Tj', 'm']);
});

test('detection: names from labels, reading order, no overlap with existing fields, unique names', () => {
  const words = [
    {text: 'Name:', rect: [72, 700, 110, 712]}, {text: '__________', rect: [114, 700, 220, 712]},
    {text: 'Date', rect: [72, 650, 100, 662]}, {text: 'Agree', rect: [92, 610, 130, 622]},
  ];
  const shapes = {boxes: [[72, 608, 86, 622], [72, 540, 90, 560], [90, 540, 108, 560], [108, 540, 126, 560]], rules: [[110, 650, 300, 650]]};
  const found = detect(words, shapes, [], ['Name']);
  assert.deepEqual(found.map(c => [c.kind, c.name]), [['text', 'Name2'], ['text', 'Date'], ['checkbox', 'Agree'], ['comb', 'Text1']]);
  assert.equal(found[3].cells, 3);
  assert.deepEqual(found[2].rect, [72, 608, 86, 622]);
  assert.deepEqual(detect(words, shapes, [[70, 698, 225, 714]], []).map(c => c.name), ['Date', 'Agree', 'Text1'], 'a blank under an existing widget is not proposed');
});
