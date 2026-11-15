// core/folio/commands/form.mjs: Prepare a form (detect, add fields, move, align, duplicate, delete,
// Field Properties, tab order, calculation order), filling forms, Clear form, Flatten, Import and
// Export form data, Merge data files, Highlight existing fields.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft crates/ui-egui/src/commands.rs:547-667, tools/prepare.rs, crates/forms,
//    crates/xfdf, crates/engine/src/edit/labels.rs): form.prepare opens the tool and detects fields in a
//    document without any; a field tool placed by a click gets its default size with the top-left at the
//    point, or by a drag the rectangle; a new field is selected; Properties, Align, Match size and
//    Distribute work against the first selected field; Delete removes the selected widgets in one step;
//    Clear form goes back to /DV; Import data sets values through the form's own checks; each edit has
//    its label ("Fill in {name}", "Add field", "Change field properties", "Clear form", ...).
//    Acrobat's Prepare Form and Fill & Sign behave the same way.
// 2. Ours does the same end to end: these tests run the commands on real PDFs, save the result with
//    the folio writer and read it back with pdf-lib's own form API (the way another reader sees it).
// 3. Tests below, tests/folio/form-engine.test.mjs (the engine), tests/e2e/folio/form.e2e.mjs (the window).
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {schema1Content} from '../../core/folio/fixtures.mjs';

after(() => releaseTextSources());

const blank = () => createTestSession('folio', {fixture: 'blankForm'});
const plain = () => createTestSession('folio', {fixture: 'textPages'});
const reopen = async t => PDFDocument.load(await writeFolioPdf(t.content));
const fieldNames = t => t.content.fields.map(f => f.name);

test('Prepare a form detects the blanks of a form that has no fields, as Acrobat does on the way in', async () => {
  const t = await blank();
  const r = await t.exec('form.prepare', {});
  assert.equal(r.result.detected, 5);
  assert.deepEqual(fieldNames(t), ['Full name', 'Email', 'I agree', 'Comments', 'Text1']);
  assert.equal(t.doc.view.rightPanel, 'fields', 'the Form fields panel opens');
  assert.equal(t.doc.view.formPrepare, true);
  const f = Object.fromEntries(t.content.fields.map(x => [x.name, x]));
  assert.equal(f['I agree'].kind, 'checkbox');
  assert.ok(f.Text1.flags & (1 << 24) && f.Text1.maxLen === 5, 'a row of 5 cells is a comb field with a limit of 5');
  const back = await reopen(t);
  assert.deepEqual(back.getForm().getFields().map(x => x.getName()), ['Full name', 'Email', 'I agree', 'Comments', 'Text1']);
  // A document that already has fields is not detected on again.
  assert.equal((await t.exec('form.prepare', {})).result.detected, 0);
});

test('form.detect on its own: "Detect form fields", nothing changes when nothing is found', async () => {
  const t = await plain();
  const none = await t.exec('form.detect', {});
  assert.equal(none.result.detected, 0);
  assert.equal(t.content.fields?.length ?? 0, 0);
  const b = await blank();
  assert.equal((await b.exec('form.detect', {pages: [2]})).result.detected, 0, 'page 2 has no blanks');
  assert.equal(b.content.fields?.length ?? 0, 0);
  const all = await expectUndoRoundTrip(b, 'form.detect', {}, after => assert.equal(after.content.fields.length, 5));
  assert.equal(all.undoLabel, 'Detect form fields');
});

test('a field tool placed by a click (default size, top-left at the point) or a drag; the new field is selected', async () => {
  const t = await plain();
  assert.deepEqual((await t.exec('form.add.text', {})).result, {tool: 'form.add.text'}, 'picking the tool makes it the quick tool');
  assert.equal(t.doc.view.tool, 'form.add.text');
  const r = await expectUndoRoundTrip(t, 'form.add.text', {page: 'p1', at: [100, 100]}, after => {
    const f = after.content.fields[0];
    assert.equal(f.name, 'Text1');
    // 144 x 22 default size, the top-left at the click: view y 100..122 is user y 670..692.
    assert.deepEqual(f.widgets[0].rect, [100, 670, 244, 692]);
  });
  assert.equal(r.undoLabel, 'Add field');
  assert.deepEqual(r.result, {name: 'Text1', widget: 0, page: 'p1'});
  assert.deepEqual(t.doc.view.formSel, [{name: 'Text1', widget: 0}]);
  assert.equal(t.doc.view.tool, null, 'placing a field ends the tool');
  const sizes = {};
  for (const [id, name] of [['form.add.checkbox', 'Check Box1'], ['form.add.combo', 'Dropdown1'], ['form.add.list', 'List Box1'], ['form.add.button', 'Button1'], ['form.add.image', 'Image1'], ['form.add.date', 'Date1'], ['form.add.signature', 'Signature1']]) {
    const tool = id.slice('form.add.'.length);
    const out = (await t.exec(id, {page: 1, at: [72, 300 + Object.keys(sizes).length * 40]})).result;
    assert.equal(out.name, name);
    const w = t.content.fields.find(f => f.name === name).widgets[0].rect;
    sizes[tool] = [w[2] - w[0], w[3] - w[1]];
  }
  assert.deepEqual(sizes, {checkbox: [14, 14], combo: [144, 22], list: [144, 54], button: [72, 22], image: [144, 108], date: [108, 22], signature: [180, 36]});
  const drag = (await t.exec('form.add.text', {page: 'p2', rect: [72, 72, 200, 30], name: 'Email'})).result;
  assert.equal(drag.name, 'Email');
  assert.deepEqual(t.content.fields.find(f => f.name === 'Email').widgets[0].rect.map(Math.round), [72, 690, 272, 720].map(v => v));
});

test('radio buttons dropped next to a selected radio group join it with the next free choice', async () => {
  const t = await plain();
  await t.exec('form.add.radio', {page: 1, at: [72, 100]});
  assert.equal(t.content.fields[0].name, 'Group1');
  assert.deepEqual(t.content.fields[0].widgets.map(w => w.onState), ['Choice1']);
  await t.exec('form.add.radio', {page: 1, at: [120, 100]});
  assert.equal(t.content.fields.length, 1, 'the second button joined the selected group');
  assert.deepEqual(t.content.fields[0].widgets.map(w => w.onState), ['Choice1', 'Choice2']);
  assert.deepEqual(t.doc.view.formSel, [{name: 'Group1', widget: 1}]);
  await t.exec('form.fill', {name: 'Group1', value: 'Choice2'});
  assert.equal((await reopen(t)).getForm().getRadioGroup('Group1').getSelected(), 'Choice2');
});

test('filling in: real AcroForm values, "Fill in {name}", validation, read-only and the form recalculating', async () => {
  const t = await plain();
  await t.exec('form.add.text', {page: 1, rect: [72, 72, 150, 22], name: 'price'});
  await t.exec('form.add.text', {page: 1, rect: [72, 110, 150, 22], name: 'qty'});
  await t.exec('form.add.text', {page: 1, rect: [72, 148, 150, 22], name: 'total'});
  await t.exec('form.add.checkbox', {page: 1, rect: [72, 190, 14, 14], name: 'agree'});
  await t.exec('form.field.properties', {name: 'total', props: {calculate: {kind: 'notation', expr: 'price * qty'}, readOnly: true}});
  const r = await expectUndoRoundTrip(t, 'form.fill', {name: 'price', value: '12.5'}, after => assert.deepEqual(after.content.fields.find(f => f.name === 'price').value, ['12.5']));
  assert.equal(r.undoLabel, 'Fill in price');
  await t.exec('form.fill', {name: 'qty', value: '4'});
  await t.exec('form.fill', {name: 'agree', value: true});
  const f = Object.fromEntries(t.content.fields.map(x => [x.name, x]));
  assert.deepEqual(f.total.value, ['50']);
  await assert.rejects(t.exec('form.fill', {name: 'total', value: '1'}), /read-only/);
  await assert.rejects(t.exec('form.fill', {name: 'nope', value: '1'}), /no field named/);
  const form = (await reopen(t)).getForm();
  assert.equal(form.getTextField('price').getText(), '12.5');
  assert.equal(form.getTextField('total').getText(), '50');
  assert.equal(form.getCheckBox('agree').isChecked(), true);
  const read = (await t.exec('form.read', {name: 'price'})).result.fields[0];
  assert.equal(read.kind, 'text');
  assert.deepEqual(read.value, ['12.5']);
  assert.deepEqual(read.widgets[0].rect, [72, 72, 222, 94], 'rectangles come back in page view points');
});

test('Clear form: "Clear form", every field back to its default; names limit it', async () => {
  const t = await plain();
  await t.exec('form.add.text', {page: 1, rect: [72, 72, 150, 22], name: 'a'});
  await t.exec('form.add.text', {page: 1, rect: [72, 110, 150, 22], name: 'b'});
  await t.exec('form.field.properties', {name: 'a', props: {defaultValue: 'start'}});
  await t.exec('form.fill', {name: 'a', value: 'x'});
  await t.exec('form.fill', {name: 'b', value: 'y'});
  const r = await expectUndoRoundTrip(t, 'form.clear', {}, after => {
    assert.deepEqual(after.content.fields.map(f => f.value), [['start'], []]);
  });
  assert.equal(r.undoLabel, 'Clear form');
  assert.equal(r.result.cleared, 2);
  await t.exec('form.fill', {name: 'a', value: 'x'});
  await t.exec('form.fill', {name: 'b', value: 'y'});
  await t.exec('form.clear', {names: ['b']});
  assert.deepEqual(t.content.fields.map(f => f.value), [['x'], []]);
});

test('Field Properties: one undo step, every tab; a refused change leaves the document as it was', async () => {
  const t = await plain();
  await t.exec('form.add.text', {page: 1, rect: [72, 72, 150, 22], name: 'a'});
  await t.exec('form.add.text', {page: 1, rect: [72, 110, 150, 22], name: 'b'});
  await t.exec('form.select', {fields: [{name: 'a'}]});
  const r = await expectUndoRoundTrip(t, 'form.field.properties', {name: 'a', props: {
    name: 'first', tooltip: 'Given name', required: true, quadding: 2, fontSize: 10, maxLen: 20,
    appearance: {border: [1, 0, 0], fill: null, width: 2, style: 'Beveled', text: [0, 0, 1]},
    format: {kind: 'number', decimals: 2, sep: 0, neg: 0, currency: '', prepend: true}, validate: {kind: 'range', min: 0, max: 9}}}, after => {
    const f = after.content.fields.find(x => x.name === 'first');
    assert.equal(f.tooltip, 'Given name');
    assert.ok(f.flags & 2);
    assert.equal(f.maxLen, 20);
    assert.equal(f.quadding, 2);
    assert.equal(f.da, '/Helv 10 Tf 0 0 1 rg');
    assert.deepEqual(f.widgets[0].look.border, [1, 0, 0]);
    assert.equal(f.widgets[0].look.fill, null);
    assert.equal(f.widgets[0].look.style, 'B');
    assert.equal(f.actions.format.kind, 'number');
    assert.equal(f.actions.validate.max, 9);
  });
  assert.equal(r.undoLabel, 'Change field properties');
  await t.exec('form.select', {fields: [{name: 'b'}]});
  await t.exec('form.field.properties', {name: 'b', props: {name: 'second'}});
  assert.deepEqual(t.doc.view.formSel.map(x => x.name), ['second'], 'a renamed field stays selected');
  await t.exec('form.field.properties', {name: 'second', props: {name: 'b'}});
  await assert.rejects(t.exec('form.field.properties', {name: 'first', props: {name: 'b'}}), /already exists/);
  assert.equal(fieldNames(t).join(), 'first,b');
  await assert.rejects(t.exec('form.field.properties', {name: 'first', props: {fontSize: -5}}), /non-negative|at least|must be/);
  const open = await t.exec('form.field.properties', {name: 'b'});
  assert.deepEqual(open.result, {name: 'b', open: true}, 'without props the Field Properties window opens');
  // Shared properties: only the ones given change.
  const shared = await t.exec('form.field.properties', {names: ['first', 'b'], props: {readOnly: true, tooltip: 'both'}});
  assert.equal(shared.result.changed, 2);
  assert.deepEqual(t.content.fields.map(f => [f.readOnly, f.tooltip]), [[true, 'both'], [true, 'both']]);
});

test('move, resize and nudge: "Change field properties" in page view points', async () => {
  const t = await plain();
  await t.exec('form.add.text', {page: 1, rect: [72, 72, 100, 20], name: 'a'});
  const r = await expectUndoRoundTrip(t, 'form.field.set_rect', {name: 'a', rect: [100, 120, 160, 30]}, after => assert.deepEqual(after.content.fields[0].widgets[0].rect, [100, 642, 260, 672]));
  assert.equal(r.undoLabel, 'Change field properties');
  assert.deepEqual(r.result.rect, [100, 120, 260, 150]);
  const n = await t.exec('form.field.set_rect', {name: 'a', dx: 1, dy: -10});
  assert.deepEqual(n.result.rect, [101, 110, 261, 140]);
  await assert.rejects(t.exec('form.field.set_rect', {name: 'a', rect: [10, 10, 2, 2]}), /too small/);
});

test('Align, Distribute and Match size against the first selected field, one undo step', async () => {
  const t = await plain();
  for (const [name, x, y, w] of [['a', 72, 72, 100], ['b', 200, 130, 80], ['c', 300, 200, 60]]) await t.exec('form.add.text', {page: 1, rect: [x, y, w, 20], name});
  await t.exec('form.select', {fields: [{name: 'a'}, {name: 'b'}, {name: 'c'}]});
  assert.equal(t.doc.view.formSel.length, 3);
  const r = await expectUndoRoundTrip(t, 'form.field.arrange', {op: 'align_left'}, after => {
    assert.deepEqual(after.content.fields.map(f => f.widgets[0].rect[0]), [72, 72, 72]);
  });
  assert.equal(r.undoLabel, 'Align fields');
  assert.equal(r.result.moved, 2);
  const same = await expectUndoRoundTrip(t, 'form.field.arrange', {op: 'same_width'}, after => assert.deepEqual(after.content.fields.map(f => f.widgets[0].rect[2] - f.widgets[0].rect[0]), [100, 100, 100]));
  assert.equal(same.undoLabel, 'Match field sizes');
  const dist = await expectUndoRoundTrip(t, 'form.field.arrange', {op: 'distribute_v'}, () => {});
  assert.equal(dist.undoLabel, 'Distribute fields');
  await t.exec('form.select', {fields: [{name: 'a'}]});
  await assert.rejects(t.exec('form.field.arrange', {op: 'align_left'}), /two or more/);
});

test('Delete removes the selected widgets in one step; Duplicate adds a widget per page sharing one value', async () => {
  const t = await plain();
  await t.exec('form.add.text', {page: 1, rect: [72, 72, 100, 20], name: 'a'});
  await t.exec('form.add.text', {page: 1, rect: [72, 110, 100, 20], name: 'b'});
  const d = await expectUndoRoundTrip(t, 'form.field.duplicate', {name: 'a', pages: [1, 2]}, after => assert.deepEqual(after.content.fields[0].widgets.map(w => w.pageId), ['p1', 'p2']));
  assert.equal(d.undoLabel, 'Duplicate field');
  assert.equal(d.result.added, 1, 'the page that already has a widget is skipped');
  await t.exec('form.fill', {name: 'a', value: 'shared'});
  const back = await reopen(t);
  assert.equal(back.getForm().getTextField('a').getText(), 'shared');
  assert.equal(back.getForm().getTextField('a').acroField.getWidgets().length, 2);
  await t.exec('form.select', {fields: [{name: 'a', widget: 1}]});
  const one = await expectUndoRoundTrip(t, 'form.field.delete', {}, after => assert.deepEqual(after.content.fields[0].widgets.map(w => w.pageId), ['p1']));
  assert.equal(one.undoLabel, 'Delete field');
  await t.exec('form.select', {fields: [{name: 'a'}, {name: 'b'}]});
  const two = await expectUndoRoundTrip(t, 'form.field.delete', {}, after => assert.equal(after.content.fields.length, 0));
  assert.equal(two.undoLabel, 'Delete 2 fields');
  assert.deepEqual(t.doc.view.formSel, [], 'the selection clears');
});

test('tab order by rows, columns, structure and manually; the calculation order and Fix order', async () => {
  const t = await plain();
  await t.exec('form.add.text', {page: 1, rect: [72, 72, 100, 20], name: 'a'});
  await t.exec('form.add.text', {page: 1, rect: [250, 72, 100, 20], name: 'b'});
  await t.exec('form.add.text', {page: 1, rect: [72, 110, 100, 20], name: 'c'});
  const row = await expectUndoRoundTrip(t, 'form.tab_order.row', {}, after => assert.deepEqual(after.content.fields.map(f => f.widgets[0].tab), [0, 1, 2]));
  assert.equal(row.undoLabel, 'Set tab order');
  await t.exec('form.tab_order.column', {});
  assert.deepEqual(t.content.fields.map(f => f.widgets[0].tab), [0, 2, 1]);
  await t.exec('form.tab_order.structure', {pages: [1]});
  const moved = await t.exec('form.tab_order.move', {name: 'c', earlier: true});
  assert.equal(moved.result.moved, true);
  await t.exec('form.field.properties', {name: 'a', props: {calculate: {kind: 'simple', op: 'SUM', fields: ['b']}}});
  await t.exec('form.field.properties', {name: 'b', props: {calculate: {kind: 'notation', expr: 'c * 2'}}});
  const order = (await t.exec('form.calc.read', {})).result;
  assert.deepEqual(order.fields.map(f => f.name), ['a', 'b']);
  assert.deepEqual(order.fixed, ['b', 'a']);
  const fix = await expectUndoRoundTrip(t, 'form.calc.fix', {}, () => {});
  assert.equal(fix.undoLabel, 'Set calculation order');
  assert.deepEqual((await t.exec('form.calc.read', {})).result.fields.map(f => f.name), ['b', 'a']);
  await t.exec('form.calc.move', {name: 'a', earlier: true});
  assert.deepEqual((await t.exec('form.calc.read', {})).result.fields.map(f => f.name), ['a', 'b']);
  await t.exec('form.calculation_order', {});
  assert.equal(t.doc.view.calcOrder, true);
  await t.exec('form.calc.select', {name: 'b'});
  assert.equal(t.doc.view.calcSel, 'b');
  assert.deepEqual(t.doc.view.formSel, [{name: 'b', widget: 0}], 'the field picked in the order is selected on the page');
  assert.equal((await t.exec('form.calc.move', {earlier: false})).result.name, 'b', 'Earlier / Later act on the picked field');
  await t.exec('form.calc.back', {});
  assert.equal(t.doc.view.calcOrder, false);
});

test('Flatten draws the fields into the pages and removes them; Import and Export form data round trip', async () => {
  const t = await plain();
  await t.exec('form.add.text', {page: 1, rect: [72, 72, 150, 22], name: 'name'});
  await t.exec('form.add.checkbox', {page: 1, rect: [72, 110, 14, 14], name: 'agree'});
  await t.exec('form.add.combo', {page: 1, rect: [72, 148, 150, 22], name: 'colour', options: ['Red', 'Green']});
  await t.exec('form.fill', {name: 'name', value: 'Ada'});
  const exp = (await t.exec('form.export_data', {format: 'xfdf'})).result;
  assert.match(exp.text, /<field name="name"><value>Ada<\/value><\/field>/);
  assert.match(exp.text, /<field name="agree"><value>Off<\/value>/);
  const csv = (await t.exec('form.export_data', {format: 'csv'})).result.text;
  assert.equal(csv, 'name,agree,colour\nAda,Off,\n');
  const fdf = (await t.exec('form.export_data', {format: 'fdf'})).result;
  assert.ok(atob(fdf.base64).startsWith('%FDF-1.2'));
  await t.exec('form.clear', {});
  // XFDF, FDF, CSV and tab-delimited text all import; values go through the form's checks.
  const r1 = await expectUndoRoundTrip(t, 'form.import_data', {text: exp.text}, after => assert.deepEqual(after.content.fields.map(f => f.value), [['Ada'], [], []]));
  assert.equal(r1.undoLabel, 'Import form data');
  assert.equal(r1.result.fields, 3);
  await t.exec('form.clear', {});
  await t.exec('form.import_data', {base64: fdf.base64, name: 'x.fdf'});
  assert.deepEqual(t.content.fields[0].value, ['Ada']);
  await t.exec('form.clear', {});
  const imp = await t.exec('form.import_data', {text: 'name,agree,colour\nGrace,Yes,Purple\n'});
  assert.deepEqual(imp.result, {fields: 2, rejected: ['colour']}, 'a value the form refuses is reported, the rest is taken');
  assert.deepEqual(t.content.fields.map(f => f.value), [['Grace'], ['Yes'], []]);
  await assert.rejects(t.exec('form.import_data', {text: 'nothing,here\nx,y\n'}), /nothing in the file matches/);
  const flat = await expectUndoRoundTrip(t, 'form.flatten', {}, after => assert.equal(after.content.fields.length, 0));
  assert.equal(flat.undoLabel, 'Flatten form fields');
  assert.equal(flat.result.flattened, 2 + 1);
  assert.equal((await reopen(t)).getForm().getFields().length, 0);
});

test('Merge data files: one row per file, one column per field name, formula cells made safe', async () => {
  const t = await plain();
  const a = '<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><fields><field name="name"><value>Ada</value></field><field name="note"><value>=1+1</value></field></fields></xfdf>';
  const b = '%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [<< /T (name) /V (Grace) >> << /T (city) /V (NYC) >>] >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';
  const r = await t.exec('form.merge_data', {files: [{base64: btoa(a), name: 'a.xfdf'}, {base64: btoa(b), name: 'b.fdf'}]});
  assert.equal(r.result.merged, 2);
  assert.equal(r.result.csv, "name,note,city\nAda,'=1+1,\nGrace,,NYC\n");
});

test('Highlight existing fields, Preview and the Form fields panel are view state', async () => {
  const t = await blank();
  await t.exec('form.detect', {});
  assert.equal((await t.exec('form.highlight_fields', {})).result.highlight, true);
  assert.equal(t.doc.view.formHighlight, true);
  assert.equal((await t.exec('form.highlight_fields', {})).result.highlight, false);
  assert.equal((await t.exec('form.preview', {})).result.preview, true);
  assert.deepEqual((await t.exec('form.fields', {})).result, {panel: 'fields'});
  assert.deepEqual((await t.exec('form.fields', {})).result, {panel: null});
});

test('a signed PDF refuses form edits; a document with no PDF refuses them; permissions are honoured', async () => {
  const none = await createTestSession('folio', {});
  const st = await none.session.state?.('form.add.text', {});
  void st;
  const t = await createTestSession('folio', {fixture: 'textPages'});
  t.content.permissions = {modify: false};
  await assert.rejects(t.exec('form.add.text', {page: 1, at: [72, 72]}), /permissions|disabled|allow/);
});

test('fields written by another program: nested names, inherited flags and values read from the field tree', async () => {
  const bytes = await (async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const tf = form.createTextField('person.first');
    tf.addToPage(page, {x: 72, y: 700, width: 150, height: 20});
    tf.setText('Ada');
    const cb = form.createCheckBox('person.agree');
    cb.addToPage(page, {x: 72, y: 660, width: 14, height: 14});
    cb.check();
    const dd = form.createDropdown('size');
    dd.addOptions(['S', 'M', 'L']);
    dd.addToPage(page, {x: 72, y: 620, width: 100, height: 20});
    dd.select('M');
    return doc.save();
  })();
  const t = await createTestSession('folio', {content: await migrateContent(await schema1Content(bytes))});
  const f = Object.fromEntries(t.content.fields.map(x => [x.name, x]));
  assert.deepEqual(Object.keys(f), ['person.first', 'person.agree', 'size']);
  assert.deepEqual(f['person.first'].value, ['Ada']);
  assert.equal(f['person.agree'].kind, 'checkbox');
  assert.equal(f['person.agree'].value.length, 1);
  assert.deepEqual(f.size.options, [['S', 'S'], ['M', 'M'], ['L', 'L']]);
  await t.exec('form.fill', {name: 'person.first', value: 'Grace'});
  await t.exec('form.fill', {name: 'size', value: 'L'});
  await t.exec('form.fill', {name: 'person.agree', value: false});
  const form = (await reopen(t)).getForm();
  assert.equal(form.getTextField('person.first').getText(), 'Grace');
  assert.deepEqual(form.getDropdown('size').getSelected(), ['L']);
  assert.equal(form.getCheckBox('person.agree').isChecked(), false);
  assert.equal((await t.exec('form.read', {})).result.count, 3);
});

test('the form-field right-click menu: every entry runs a registered command; Align, Distribute and Same Size need two fields', async () => {
  const {readFileSync} = await import('node:fs');
  const spec = JSON.parse(readFileSync(new URL('../../docs/spec/pdf.json', import.meta.url), 'utf8'));
  const menu = spec.contextMenus.find(m => m.target.startsWith('form-field'));
  const entries = [];
  const walk = items => { for (const it of items) { if (it.command) entries.push(it); if (it.items) walk(it.items); } };
  walk(menu.items);
  assert.deepEqual(menu.items.map(i => i.label ?? '-'), ['Align', 'Distribute', 'Set Fields to Same Size', '-', 'Properties…', 'Duplicate…', '-', 'Delete']);
  assert.equal(entries.length, 6 + 2 + 3 + 3);
  const t = await plain();
  for (const e of entries) assert.ok(t.registry.has(e.command), `${e.label} -> ${e.command}`);
  await t.exec('form.add.text', {page: 1, rect: [72, 72, 100, 20], name: 'a'});
  assert.equal((await t.state('form.field.arrange', {op: 'align_left'})).enabled, false, 'one field selected');
  await t.exec('form.add.text', {page: 1, rect: [72, 110, 100, 20], name: 'b'});
  await t.exec('form.select', {fields: [{name: 'a'}, {name: 'b'}]});
  assert.equal((await t.state('form.field.arrange', {op: 'align_left'})).enabled, true);
  assert.equal((await t.state('form.field.delete', {})).enabled, true);
  await t.exec('form.select', {fields: []});
  assert.equal((await t.state('form.field.delete', {})).enabled, false, 'nothing selected');
});

test('Export and Import form data go through the system dialogs (the window path): the dialogs name the file types, bytes move only at the chosen paths', async () => {
  const {createTestHost} = await import('../../core/kernel/host.mjs');
  const disk = new Map();
  const asked = [];
  const files = {
    pickDataSave: async req => { asked.push(['save', req]); return {path: 'C:/data/answers.xfdf', format: 'xfdf'}; },
    writeFile: async (doc, {path, base64}) => { disk.set(path, base64); return {path}; },
    pickOpen: async req => { asked.push(['open', req]); return 'C:/data/answers.xfdf'; },
    readFile: async path => ({name: 'answers.xfdf', base64: disk.get(path)}),
  };
  const t = await createTestSession('folio', {fixture: 'textPages', host: {...createTestHost(), kind: 'renderer', files}});
  await t.exec('form.add.text', {page: 1, rect: [72, 72, 150, 22], name: 'name'});
  await t.exec('form.fill', {name: 'name', value: 'Ada'});
  assert.equal((await t.state('form.export_data', {}, {origin: 'ui'})).enabled, true);
  const out = await t.exec('form.export_data', {}, {origin: 'ui'});
  assert.deepEqual(out.result, {path: 'C:/data/answers.xfdf', format: 'xfdf'});
  assert.equal(asked[0][0], 'save');
  assert.equal(asked[0][1].title, 'Export form data');
  assert.equal(asked[0][1].name, 'fixture.xfdf');
  assert.deepEqual(asked[0][1].filters.map(f => f.extensions[0]), ['xfdf', 'fdf', 'xml', 'csv', 'txt']);
  assert.match(atob(disk.get('C:/data/answers.xfdf')), /<field name="name"><value>Ada<\/value>/);
  await t.exec('form.clear', {});
  const back = await t.exec('form.import_data', {}, {origin: 'ui'});
  assert.deepEqual(back.result, {fields: 1, rejected: []});
  assert.equal(asked[1][0], 'open');
  assert.deepEqual(asked[1][1].filters[0].extensions, ['xfdf', 'fdf', 'xml', 'xdp', 'csv', 'txt']);
  assert.deepEqual(t.content.fields[0].value, ['Ada']);
  // Cancelling either dialog changes nothing.
  files.pickOpen = async () => null;
  assert.deepEqual((await t.exec('form.import_data', {}, {origin: 'ui'})).result, {canceled: true});
  // The Merge dialog asks for several files, then where to save the spreadsheet.
  files.pickOpen = async req => { asked.push(['open', req]); return ['C:/data/answers.xfdf', 'C:/data/answers.xfdf']; };
  files.pickDataSave = async req => { asked.push(['save', req]); return {path: 'C:/data/report.csv', format: 'csv'}; };
  const merged = await t.exec('form.merge_data', {}, {origin: 'ui'});
  assert.deepEqual(merged.result, {merged: 2, path: 'C:/data/report.csv'});
  assert.equal(asked.at(-2)[1].multiple, true);
  assert.equal(atob(disk.get('C:/data/report.csv')), 'name\nAda\nAda\n');
});
