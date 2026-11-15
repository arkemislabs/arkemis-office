// U:quill/shapes-gallery and U:quill/equation: Insert › Shapes draws the whole preset catalogue (stored under the preset's own name and saved to .docx
// as `a:prstGeom`), and an equation is edited where it stands (the page view starts its editor from view.equationEdit).
//
// Behaviour fidelity:
// 1. wordcraft crates/engine/src/cmd/insert shapes (insert.shape) and cmd/equation.rs (insert.equation, equation.edit); deckcraft crates/geom presets
//    (core/prism/model/geom/preset) for the geometry.
// 2. Ours: a shape's kind is Word's own name or the preset's OOXML name; Edit Equation has no box, the equation is typed in place.

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {quill} from './format-fixture.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {CATALOG, presetSteps, kindOfPreset, presetOfKind} from '../../core/quill/lib/shape-presets.mjs';

const objects = content => content.body.chunks.flat().flatMap(b => b.objects ?? []);

test('every preset of the catalogue has geometry, and a kind that names it again', () => {
  assert.ok(CATALOG.length >= 170, `${CATALOG.length} presets`);
  for (const p of CATALOG.filter(x => x.name !== 'textBox')) {
    const steps = presetSteps(p.name, 100, 60);
    assert.ok(steps?.length, `${p.name} has geometry`);
    assert.equal(presetOfKind(kindOfPreset(p.name)), p.name, `${p.name} round-trips through its kind`);
  }
});

test('insert.shape takes any preset: callouts, block arrows, flowchart; connectors keep their arrowhead; unknown names are refused', async () => {
  const q = await quill('Before\nAfter');
  q.sel(0, 6);
  await q.exec('insert.shape', {preset: 'wedgeRectCallout'});
  await q.exec('insert.shape', {preset: 'chevron'});
  await q.exec('insert.shape', {preset: 'flowChartProcess'});
  await q.exec('insert.shape', {preset: 'straightConnector1'});
  await q.exec('insert.shape', {preset: 'rect'});
  const [callout, chevron, flow, conn, rect] = objects(q.t.content);
  assert.deepEqual([callout.kind, chevron.kind, flow.kind, conn.kind, rect.kind], ['wedgeRectCallout', 'chevron', 'flowChartProcess', 'straightConnector', 'rectangle']);
  assert.ok(callout.fill && !conn.fill, 'a connector is an open line');
  assert.equal(conn.extra.arrowEnd, true);
  await assert.rejects(() => q.exec('insert.shape', {preset: 'nonsense'}), /unknown shape/);
});

test('a preset shape is saved under its own name and read back as the same kind', async () => {
  const q = await quill('Before\nAfter');
  q.sel(0, 6);
  await q.exec('insert.shape', {preset: 'star8'});
  await q.exec('insert.shape', {preset: 'wedgeEllipseCallout'});
  const bytes = await writeDocx(q.t.content);
  const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string');
  assert.ok(xml.includes('prst="star8"') && xml.includes('prst="wedgeEllipseCallout"'));
  assert.deepEqual(objects(await readDocx(bytes)).map(o => o.kind), ['star8', 'wedgeEllipseCallout']);
});

test('Insert Equation and Edit Equation edit in place: no box, a view flag starts the page view\'s editor, typing is equation.edit', async () => {
  const q = await quill('Before\nAfter');
  q.sel(0, 6);
  const before = q.t.doc.view?.equationEdit ?? 0;
  await q.exec('insert.equation', {});
  const [eq] = objects(q.t.content);
  assert.equal(eq.type, 'equation');
  assert.equal(eq.linear, '');
  assert.equal(q.t.doc.view.equationEdit, before + 1);
  await q.exec('equation.edit', {linear: 'x^2+y^2=r^2'});
  assert.equal(objects(q.t.content)[0].linear, 'x^2+y^2=r^2');
  await q.exec('equation.edit', {});
  assert.equal(q.t.doc.view.equationEdit, before + 2);
});

// ---- the review's remaining dialogs and galleries ----------------------------------------------------------------------------------------------
import {openDialogModel, changeDialogValues} from '../../core/kernel/dialog.mjs';
import linkDialog from '../../core/quill/dialogs/link.mjs';
import fontDialog from '../../core/quill/dialogs/font.mjs';
import equationOptions from '../../core/quill/dialogs/equationOptions.mjs';
import formulaDialog from '../../core/quill/dialogs/tableFormula.mjs';
import {tableSession} from './table-helpers.mjs';

test('Insert Hyperlink: E-mail Address makes a mailto: link, validated, and reads one back', async () => {
  const q = await quill('Write to us');
  q.sel(0, 0, 5);
  const v = openDialogModel(q.t.session, q.t.docId, linkDialog);
  const w = {...v, linkTo: 'email', email: 'hello@example.com', subject: 'Hi there'};
  assert.deepEqual(linkDialog.validate(w), []);
  assert.equal(linkDialog.validate({...w, email: 'nope'}).length, 1);
  assert.deepEqual(linkDialog.toCommand(w).params.url, 'mailto:hello@example.com?subject=Hi%20there');
  await q.exec('insert.link', linkDialog.toCommand(w).params);
  q.sel(0, 0, 5);
  const back = openDialogModel(q.t.session, q.t.docId, linkDialog);
  assert.deepEqual([back.linkTo, back.email, back.subject], ['email', 'hello@example.com', 'Hi there']);
});

test('the Font dialog has Shadow, Outline, Emboss and Engrave, the last two excluding each other', async () => {
  const q = await quill('Hello');
  q.sel(0, 0, 5);
  let v = openDialogModel(q.t.session, q.t.docId, fontDialog);
  v = changeDialogValues(fontDialog, v, 'shadow', true);
  v = changeDialogValues(fontDialog, v, 'emboss', true);
  v = changeDialogValues(fontDialog, v, 'engrave', true);
  assert.equal(v.emboss, false);
  assert.equal(v.engrave, true);
  const call = fontDialog.toCommand(v);
  assert.equal(call.params.props?.shadow ?? call.params.shadow, true);
  assert.equal(call.params.props?.engrave ?? call.params.engrave, true);
});

test('the Styles gallery draws each style as it looks: its own font, size and weight', async () => {
  const q = await quill('Hello');
  const st = await q.state('para.style', {});
  const art = id => st.value.find(x => x.id === id)?.art;
  assert.equal(art('Normal').kind, 'textStyle');
  assert.equal(art('Heading1').kind, 'textStyle');
  assert.ok(art('Heading1').size > art('Normal').size, 'Heading 1 is larger');
  assert.equal(art('Heading1').label, st.value.find(x => x.id === 'Heading1').label);
});

test('Equation Options reads and sets how equations are typed; the Formula boxes open on a choice, not blank', async () => {
  const q = await quill('Hello');
  const v = openDialogModel(q.t.session, q.t.docId, equationOptions);
  assert.equal(v.format, 'unicode');
  assert.deepEqual(equationOptions.toCommand({format: 'latex'}), {command: 'equation.inputFormat', params: {format: 'latex'}});
  const t = await tableSession(2, 2);
  const id = t.content.body.chunks.flat().find(b => b.kind === 'table').id;
  t.session.setSelection(t.docId, {ranges: [{anchor: `/body/b:${id}/r:0/c:0/b:0/t:0`, focus: `/body/b:${id}/r:0/c:0/b:0/t:0`}], primary: 0});
  const f = openDialogModel(t.session, t.docId, formulaDialog);
  assert.deepEqual([f.pasteFunction, f.pasteBookmark, f.numberFormat], ['', '', '']);
  const next = changeDialogValues(formulaDialog, f, 'pasteFunction', 'SUM');
  assert.equal(next.formula, '=SUM()');
  assert.equal(next.pasteFunction, '');
});
