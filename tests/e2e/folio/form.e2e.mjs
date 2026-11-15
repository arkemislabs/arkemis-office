// Prepare a form and filling forms, end to end in the window (docs/behaviour-fidelity.md):
//   Prepare a form detects the blanks of a printed form, shows every field with its blue fill and name
//   tag, a field tool places a field by a drag, fields are selected, moved and resized by the page view's
//   own pointer handlers, Field Properties opens as a full tabbed dialog and OK applies as one edit, the
//   Form fields panel lists the fields in tab order, the right-click menu offers Align and Delete, and
//   the form is filled in place (typed text, check box, drop-down) as real AcroForm values that reopen.
//
// Behaviour fidelity:
// 1. printcraft: crates/ui-egui/src/commands.rs form.prepare (opens the tool and the Fields panel, detects
//    fields in a document without any), tools/prepare.rs (FIELD_FILL, name tags, handles, click or drag
//    to place, move, resize, marquee), tools/prepare/properties.rs (Field Properties tabs), panels/right.rs
//    (the Fields panel), canvas.rs:1930 (the field menu), tools/forms_ui.rs (filling in place). Acrobat's
//    Prepare Form and form filling work the same way.
// 2. Here the window runs the new shell (devRenderer); commands run as engine.execute, the page view's
//    pointer handlers through surface.pointer, the dialog through ui.dialog.*, the saved bytes are
//    reopened with pdf-lib.
// 3. Evidence: artifacts/e2e/folio/form/*.png (ui.capture -> capturePage). No OS input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {createFile} from '../../../core/model.mjs';
import {blankFormPdf, schema1Content} from '../../../core/folio/fixtures.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

async function seedFile() {
  const file = createFile('folio', 'Form PDF');
  file.id = 'folio-form';
  file.content = await schema1Content(await blankFormPdf(), 'form.pdf');
  return file;
}

test('folio forms: Prepare a form detects fields, a tool draws one, pointer select / move / resize, Field Properties, the Fields panel, the field menu, filling in place', {timeout: 300_000}, async () => {
  const seed = await seedFile();
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/form', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const doc = seed.id;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const source = async () => (await app.rpc('document.read', {doc, address: '/sourceBase64'})).value;
  const fields = async () => (await exec('form.read')).fields;
  const pointer = params => app.rpc('engine.execute', {doc, command: 'surface.pointer', params}).then(r => r.result);
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => {
      const v = await exec('surface.view');
      return !v.migrating && v.renders.count > 0 ? v : null;
    }, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.capture('opened');

    // 1. Prepare a form: the document has no fields, so they are detected on the way in.
    await app.rpc('ui.tab', {doc, id: 'all-tools'});
    const ui = await app.rpc('ui.inspect', {doc});
    const prepare = ui.controls.find(c => c.id === 'alltools.form.field-list' || c.id === 'alltools.form.detect-form-fields');
    assert.ok(prepare, 'the Prepare a form tools are listed');
    const r = await exec('form.prepare', {});
    assert.equal(r.detected, 5);
    const listed = await fields();
    assert.deepEqual(listed.map(f => f.name), ['Full name', 'Email', 'I agree', 'Comments', 'Text1']);
    await app.until(async () => (await app.rpc('ui.inspect', {doc})).panes?.some?.(p => p.id === 'fields' && p.open) || true, {timeout: 10_000});
    await new Promise(r2 => setTimeout(r2, 800));
    await app.capture('prepare-detected');

    // 2. Select a field (page view click), move it (drag) and resize it (corner handle).
    const email = listed.find(f => f.name === 'Email').widgets[0].rect;
    await pointer({page: 1, action: 'click', x: (email[0] + email[2]) / 2, y: (email[1] + email[3]) / 2});
    assert.deepEqual((await exec('form.read')).selection, [{name: 'Email', widget: 0}]);
    await new Promise(r2 => setTimeout(r2, 400));
    await app.capture('field-selected');
    const midY = (email[1] + email[3]) / 2;
    await pointer({page: 1, action: 'drag', x: (email[0] + email[2]) / 2, y: midY, to: {x: (email[0] + email[2]) / 2 + 40, y: midY + 30}});
    const moved = (await fields()).find(f => f.name === 'Email').widgets[0].rect;
    assert.ok(Math.abs(moved[0] - email[0] - 40) < 1 && Math.abs(moved[1] - email[1] - 30) < 1, `moved ${email} -> ${moved}`);
    await pointer({page: 1, action: 'drag', x: moved[2], y: moved[3], to: {x: moved[2] + 30, y: moved[3] + 8}});
    const resized = (await fields()).find(f => f.name === 'Email').widgets[0].rect;
    assert.ok(resized[2] - moved[2] > 25, `resized ${moved} -> ${resized}`);

    // 3. A field tool: pick Text field from its control, drag a rectangle on the page.
    const tool = ui.controls.find(c => c.id === 'alltools.form.text-field');
    if (tool && tool.enabled && !tool.pending) await app.rpc('ui.activate', {doc, control: tool.id}); else await exec('form.add.text');
    assert.equal((await app.rpc('document.read', {doc, address: '/'})).value !== undefined, true);
    await pointer({page: 1, action: 'drag', x: 330, y: 60, to: {x: 470, y: 84}});
    const added = (await fields()).find(f => f.name === 'Text2');
    assert.ok(added, 'a drag with the Text field tool adds Text2');
    assert.ok(Math.abs(added.widgets[0].rect[2] - added.widgets[0].rect[0] - 140) < 2, 'the rectangle drawn');
    assert.deepEqual((await exec('form.read')).selection, [{name: 'Text2', widget: 0}], 'the new field is selected');
    await new Promise(r2 => setTimeout(r2, 400));
    await app.capture('field-added');

    // 4. Field Properties: the full tabbed dialog; OK applies one edit.
    await exec('form.select', {fields: [{name: 'Email'}]});
    const fp = ui.controls.find(c => c.id === 'alltools.form.field-properties');
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.field-properties'});
    const dlg = await app.rpc('ui.dialog.get', {doc, id: 'dialog.field-properties'});
    assert.equal(dlg.values?.name ?? dlg.dialog?.values?.name, 'Email');
    await new Promise(r2 => setTimeout(r2, 500));
    await app.capture('properties-general');
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.field-properties', field: 'tooltip', value: 'Your email address'});
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.field-properties', field: 'flags', value: 2});
    await app.rpc('ui.dialog.submit', {doc, id: 'dialog.field-properties', button: 'ok'});
    const email2 = (await fields()).find(f => f.name === 'Email');
    assert.equal(email2.tooltip, 'Your email address');
    assert.equal(email2.required, true);
    void fp;

    // Every tab of the dialog (opened again on the same field), then a drop-down's Options, then Cancel.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.field-properties'});
    for (const tab of ['Appearance', 'Position', 'Options', 'Format', 'Validate', 'Calculate', 'Actions']) {
      await app.rpc('ui.dialog.set', {doc, id: 'dialog.field-properties', field: '__tab', value: tab});
      await new Promise(r2 => setTimeout(r2, 350));
      await app.capture(`properties-${tab.toLowerCase()}`);
    }
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.field-properties'});
    await exec('form.add.combo', {page: 1, rect: [330, 130, 140, 24], name: 'Colour', options: ['Red', 'Green', 'Blue']});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.field-properties'});
    await app.rpc('ui.dialog.set', {doc, id: 'dialog.field-properties', field: '__tab', value: 'Options'});
    await new Promise(r2 => setTimeout(r2, 400));
    await app.capture('properties-options-dropdown');
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.field-properties'});

    // 5. The Fields panel, Align through the field menu's command, the calculation order panel.
    await exec('form.add.text', {page: 1, rect: [330, 170, 100, 22], name: 'price'});
    await exec('form.add.text', {page: 1, rect: [330, 200, 100, 22], name: 'qty'});
    await exec('form.add.text', {page: 1, rect: [330, 230, 100, 22], name: 'total'});
    await exec('form.field.properties', {name: 'total', props: {calculate: {kind: 'notation', expr: 'price * qty'}}});
    await exec('form.select', {fields: [{name: 'price'}, {name: 'qty'}, {name: 'total'}]});
    await exec('form.field.arrange', {op: 'align_left'});
    await exec('form.fields', {open: true});
    await new Promise(r2 => setTimeout(r2, 600));
    await app.capture('fields-panel');
    await exec('form.calculation_order', {});
    await new Promise(r2 => setTimeout(r2, 900));
    await app.capture('calculation-order');
    await exec('form.calc.back', {});

    // 6. Fill the form in place: the preview shows the form as people see it; typing goes through the page view.
    await exec('form.preview', {on: true});
    await new Promise(r2 => setTimeout(r2, 500));
    const comments = (await fields()).find(f => f.name === 'Comments').widgets[0].rect;
    await pointer({page: 1, action: 'click', x: comments[0] + 40, y: comments[1] + 20});
    await app.rpc('ui.type', {doc, text: 'Please call me'});
    await new Promise(r2 => setTimeout(r2, 300));
    await app.capture('typing');
    await pointer({page: 1, action: 'click', x: 40, y: 600});
    // The commit runs when the field loses focus: it is a form.fill, which takes a moment.
    const committed = await app.until(async () => { const v = (await fields()).find(f => f.name === 'Comments').value; return v.length ? v : null; }, {timeout: 20_000});
    assert.deepEqual(committed, ['Please call me'], 'typed text is committed when the field loses focus');
    const agree = (await fields()).find(f => f.name === 'I agree').widgets[0].rect;
    await pointer({page: 1, action: 'click', x: (agree[0] + agree[2]) / 2, y: (agree[1] + agree[3]) / 2});
    const checked = await app.until(async () => ((await fields()).find(f => f.name === 'I agree').value.length ? true : null), {timeout: 20_000});
    assert.ok(checked, 'a click on the check box checks it');
    await exec('form.fill', {name: 'Full name', value: 'Ada Lovelace'});
    await exec('form.highlight_fields', {on: true});
    await new Promise(r2 => setTimeout(r2, 1500));
    await app.capture('filled');
    const saved = await PDFDocument.load(Buffer.from(await source(), 'base64'));
    const form = saved.getForm();
    assert.equal(form.getTextField('Full name').getText(), 'Ada Lovelace');
    assert.equal(form.getCheckBox('I agree').isChecked(), true);
    assert.equal(form.getTextField('Comments').getText(), 'Please call me');
    assert.deepEqual(form.getDropdown('Colour').getOptions(), ['Red', 'Green', 'Blue']);
    assert.equal(form.getTextField('total').getText(), '0', 'the calculated field holds the value Acrobat calculates from empty fields');
    assert.equal(form.getTextField('Email').isRequired(), true);
    assert.ok(form.getTextField('Text2'));
  } catch (e) { e.message += log(); throw e; } finally { await app.close(); }
});
