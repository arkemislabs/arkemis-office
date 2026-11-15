// U:prism/format: every edit command of the family round-trips through undo/redo on a schema-2
// deck; the Font, Paragraph, Tabs, Columns, Bullets and Numbering, and Language dialogs open with
// the selection's values and their OK runs the command once; the ribbon state reads the selection.
//
// 1. What ArtCraft does: deckcraft crates/engine/src/cmd/format.rs and format/{font,paragraph,
//    painter,ruler,text_effects}.rs format the text being edited (a bare caret: the word it is in)
//    or the selected shapes' text, one undo step each; nothing selected disables them ("select text
//    or a shape"); the dialogs (crates/ui-egui/src/dialogs/{font,paragraph,tabs,columns}.rs,
//    body.rs dlg_bullets / dlg_language) seed from the selection and send one command on OK.
//    PowerPoint's Home › Font and Paragraph groups and their dialogs behave the same way.
// 2. Ours: the same commands through the kernel change API; dialogs as pure models submitted by
//    the shell (here through the kernel's submitDialog, as the shell does).
// 3. Proved here and in tests/prism/upstream/format_tests.test.mjs; the ribbon and dialogs in the
//    running app in tests/e2e/prism/format-ribbon.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {submitDialog, openDialogModel, changeDialogValues} from '../../core/kernel/dialog.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {findShape} from '../../core/prism/model/presentation.mjs';
import {selectText} from '../../core/prism/model/doc.mjs';
import fontDialog from '../../core/prism/dialogs/font.mjs';
import paragraphDialog from '../../core/prism/dialogs/paragraph.mjs';
import tabsDialog from '../../core/prism/dialogs/tabs.mjs';
import columnsDialog from '../../core/prism/dialogs/columns.mjs';
import bulletsDialog from '../../core/prism/dialogs/bullets.mjs';
import languageDialog from '../../core/prism/dialogs/language.mjs';

async function deck() {
  const c = createContent('Format tests');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.slides = [{...structuredClone(c.slides[0]), id: 's1', layout, shapes: []}];
  const t = await createTestSession('prism', {content: c, selection: {ranges: [{anchor: '/sl:s1', focus: '/sl:s1'}], primary: 0}});
  const id = (await t.exec('shape.insert', {preset: 'rect', rect: [40, 40, 300, 120], text: 'Hello world\nSecond line'})).result.id;
  return {t, id};
}
const sh = (r, id) => findShape(r.content.slides[0].shapes, id);
const run0 = (r, id) => sh(r, id).text.paragraphs[0].runs[0].props ?? {};
const para0 = (r, id) => sh(r, id).text.paragraphs[0].props ?? {};
const body = (r, id) => sh(r, id).text.body ?? {};

test('character commands round-trip through undo on the selected shape', async () => {
  const {t, id} = await deck();
  const cases = [
    ['format.bold', {}, r => assert.equal(run0(r, id).bold, true)],
    ['format.italic', {on: true}, r => assert.equal(run0(r, id).italic, true)],
    ['format.underline', {style: 'dbl'}, r => assert.equal(run0(r, id).underline, 'dbl')],
    ['format.strikethrough', {double: true}, r => assert.equal(run0(r, id).strike, 'double')],
    ['format.superscript', {}, r => assert.equal(run0(r, id).baseline, 0.3)],
    ['format.subscript', {}, r => assert.equal(run0(r, id).baseline, -0.25)],
    ['format.font', {family: 'Georgia'}, r => assert.equal(run0(r, id).font, 'Georgia')],
    ['format.size', {size: '28'}, r => assert.equal(run0(r, id).size, 28)],
    ['format.grow', {}, r => assert.equal(run0(r, id).size, 32, '28 → 32 on PowerPoint\'s size list (the redo above left 28)')],
    ['format.shrink', {}, r => assert.equal(run0(r, id).size, 28)],
    ['format.color', {color: 'accent2'}, r => assert.deepEqual(run0(r, id).fill, {kind: 'solid', color: {base: {kind: 'scheme', slot: 'accent2'}}})],
    ['format.textTransparency', {value: 0.4}, r => assert.equal(run0(r, id).fill.color.mods[0].val, 60000)],
    ['format.language', {lang: 'fr-FR', noProof: true}, r => assert.deepEqual([run0(r, id).lang, run0(r, id).noProof], ['fr-FR', true])],
    ['format.languageAll', {lang: 'de-DE'}, r => assert.equal(r.content.defaultTextStyle.levels[0].run.lang, 'de-DE')],
    ['format.highlight', {color: '#FFFF00'}, r => assert.equal(run0(r, id).highlight.base.kind, 'rgb')],
    ['format.case', {mode: 'upper'}, r => assert.equal(sh(r, id).text.paragraphs[0].runs[0].text, 'HELLO WORLD')],
    ['format.caps', {caps: 'small'}, r => assert.equal(run0(r, id).caps, 'small')],
    ['format.spacing', {pt: 3}, r => assert.equal(run0(r, id).spacing, 3)],
    ['format.fontDialog', {size: 30, bold: true}, r => assert.deepEqual([run0(r, id).size, run0(r, id).bold], [30, true])],
    ['format.textShadow', {}, r => assert.equal(run0(r, id).shadow.blur, 3)],
    ['format.textOutline', {color: 'accent1', width: 1}, r => assert.equal(run0(r, id).outline.width, 1)],
  ];
  for (const [cmd, p, check] of cases) await expectUndoRoundTrip(t, cmd, p, check);
  await t.exec('format.bold', {on: true});
  await expectUndoRoundTrip(t, 'format.clear', {}, r => assert.equal(run0(r, id).bold, undefined));
});

test('paragraph and text box commands round-trip through undo', async () => {
  const {t, id} = await deck();
  const cases = [
    ['format.align', {align: 'right'}, r => assert.equal(para0(r, id).align, 'right')],
    ['format.alignLeft', {}, r => assert.equal(para0(r, id).align, 'left')],
    ['format.alignRight', {}, r => assert.equal(para0(r, id).align, 'right')],
    ['format.justify', {}, r => assert.equal(para0(r, id).align, 'justify')],
    ['format.rtl', {}, r => assert.deepEqual([para0(r, id).rtl, para0(r, id).align], [true, 'justify'], 'only left and right mirror')],
    ['format.bullets', {char: '■'}, r => assert.deepEqual(para0(r, id).bullet, {kind: 'char', char: '■'})],
    ['format.numbering', {}, r => assert.equal(para0(r, id).bullet.kind, 'autoNum')],
    ['format.indent', {}, r => assert.equal(sh(r, id).text.paragraphs[0].level, 1)],
    ['format.lineSpacing', {lines: 1.5}, r => assert.deepEqual(para0(r, id).lineSpacing, {kind: 'pct', v: 1.5})],
    ['format.paragraph', {indentLeft: 18}, r => assert.equal(para0(r, id).marginLeft, 18)],
    ['format.paragraphDialog', {spaceAfter: 12}, r => assert.deepEqual(para0(r, id).spaceAfter, {kind: 'pts', v: 12})],
    ['format.tabs', {add: {pos: 72, align: 'dec'}}, r => assert.deepEqual(para0(r, id).tabs, [{pos: 72, align: 'dec'}])],
    ['format.anchor', {anchor: 'bottom'}, r => assert.equal(body(r, id).anchor, 'bottom')],
    ['format.direction', {dir: 'rotate270'}, r => assert.equal(body(r, id).vert, 'vertical270')],
    ['format.columns', {count: 2, spacing: 18}, r => assert.deepEqual([body(r, id).columns, body(r, id).colSpacing], [2, 18])],
    ['format.autofit', {mode: 'shrink'}, r => assert.equal(body(r, id).autofit.kind, 'shrink')],
    ['format.wrap', {on: false}, r => assert.equal(body(r, id).wrap, false)],
    ['format.margins', {left: 12, bottom: 2}, r => assert.deepEqual([body(r, id).insetL, body(r, id).insetB], [12, 2])],
    ['format.textWarp', {preset: 'textArchUp'}, r => assert.equal(body(r, id).warp, 'textArchUp')],
  ];
  for (const [cmd, p, check] of cases) await expectUndoRoundTrip(t, cmd, p, check);
  await t.exec('format.indent', {});
  await expectUndoRoundTrip(t, 'format.outdent', {}, r => assert.equal(sh(r, id).text.paragraphs[0].level, 1, 'level 2 → 1'));
  await t.exec('format.alignLeft', {});
  await expectUndoRoundTrip(t, 'format.alignCenter', {}, r => assert.equal(para0(r, id).align, 'center'));
});

test('a bare caret formats the word it is in; the ribbon state follows the caret', async () => {
  const {t, id} = await deck();
  t.session.setSelection(t.docId, selectText('s1', [id], 2, 2));
  await t.exec('format.bold', {});
  const runs = findShape(t.content.slides[0].shapes, id).text.paragraphs[0].runs;
  assert.deepEqual(runs.map(r => [r.text, !!r.props?.bold]), [['Hello', true], [' world', false]]);
  assert.equal(t.state('format.bold').checked, true);
  assert.equal(t.state('format.size').value, 18);
  assert.equal(t.state('format.alignCenter').checked, true);
  t.session.setSelection(t.docId, selectText('s1', [id], 8, 8));
  assert.equal(t.state('format.bold').checked, false);
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sl:s1', focus: '/sl:s1'}], primary: 0});
  assert.deepEqual(t.state('format.bold'), {enabled: false, reason: 'select text or a shape'});
});

test('Format Painter: pick on one shape, paste on another, one use unless sticky', async () => {
  const {t, id} = await deck();
  await t.exec('shape.fill', {color: '#336699'});
  await t.exec('format.italic', {on: true});
  const other = (await t.exec('shape.insert', {preset: 'ellipse', rect: [400, 40, 100, 100], text: 'x'})).result.id;
  t.session.setSelection(t.docId, {ranges: [{anchor: `/sl:s1/sp:${id}`, focus: `/sl:s1/sp:${id}`}], primary: 0});
  await t.exec('format.painter', {});
  assert.equal(t.state('format.painter').checked, true);
  await expectUndoRoundTrip(t, 'format.painterApply', {ids: [other]}, r => {
    assert.deepEqual(sh(r, other).fill, sh(r, id).fill);
    assert.equal(sh(r, other).text.paragraphs[0].runs[0].props.italic, true);
  });
  assert.equal(t.doc.view.painter, null, 'one use');
  await assert.rejects(t.exec('format.painterApply', {ids: [other]}), /pick formatting/);
  await t.exec('format.painter', {sticky: true});
  await t.exec('format.painterApply', {ids: [other]});
  assert.ok(t.doc.view.painter, 'sticky stays armed');
  await t.exec('edit.deselect', {});
  assert.equal(t.doc.view.painter, null, 'Escape puts it down');
});

test('font.rescan reports the host fonts; format.state reads the selection', async () => {
  const {t} = await deck();
  t.host.fonts = async () => [{family: 'Arial'}, {family: 'Arial'}, {family: 'Georgia'}];
  assert.deepEqual((await t.exec('font.rescan', {})).result, {faces: 3, families: 2});
  const st = (await t.exec('format.state', {})).result;
  assert.equal(st.align, 'center');
  assert.equal(st.size, 18);
  assert.equal(typeof st.font, 'string');
});

test('AutoFormat lists reach format.bullets and format.numbering (request from U:prism/text)', async () => {
  const {t} = await deck();
  const box = (await t.exec('insert.textBox', {rect: [40, 200, 300, 40]})).result.id;
  for (const c of '* ') await t.exec('text.insert', {text: c});
  const p = findShape(t.content.slides[0].shapes, box).text.paragraphs[0];
  assert.equal(p.props?.bullet?.kind, 'char');
});

async function submit(t, dialog, edits = {}) {
  let v = openDialogModel(t.session, t.docId, dialog);
  for (const [k, val] of Object.entries(edits)) v = changeDialogValues(dialog, v, k, val);
  return {values: v, result: await submitDialog(t.session, t.docId, dialog, v)};
}

test('Font dialog: seeded from the selection, Font style and Offset map to the command, one undo step', async () => {
  const {t, id} = await deck();
  await t.exec('format.italic', {on: true});
  const v0 = openDialogModel(t.session, t.docId, fontDialog);
  assert.equal(v0.style, 'italic');
  assert.equal(v0.size, 18);
  assert.match(v0.color, /^#[0-9A-F]{6}$/);
  const n = t.doc.undo.size;
  await submit(t, fontDialog, {style: 'boldItalic', size: 24, baseline: 'super', offset: 20, spacingPreset: '3', underline: 'wavy', color: '#112233'});
  const r = findShape(t.content.slides[0].shapes, id).text.paragraphs[0].runs[0].props;
  assert.deepEqual([r.bold, r.italic, r.size, r.baseline, r.spacing, r.underline], [true, true, 24, 0.2, 3, 'wavy']);
  assert.equal(r.fill.color.base.rgb.r, 0x11);
  assert.equal(t.doc.undo.size, n + 1);
  const bad = fontDialog.validate({...v0, family: ' '});
  assert.equal(bad[0].field, 'family');
});

test('Paragraph dialog: inches and line presets; a spacing kept keeps its kind', async () => {
  const {t, id} = await deck();
  const v0 = openDialogModel(t.session, t.docId, paragraphDialog);
  assert.deepEqual([v0.align, v0.lineKind, v0.lineValue, v0.special], ['center', 'single', 1, 'none']);
  const {values} = await submit(t, paragraphDialog, {before: 0.5, special: 'hanging', by: 0.25, lineKind: 'exactly'});
  assert.equal(values.lineValue, 18, 'Exactly starts at 18 pt');
  const p = findShape(t.content.slides[0].shapes, id).text.paragraphs[0].props;
  assert.deepEqual([p.marginLeft, p.indent, p.lineSpacing], [36, -18, {kind: 'pts', v: 18}]);
});

test('Tabs, Columns, Bullets and Numbering, Language dialogs submit their command', async () => {
  const {t, id} = await deck();
  const shape = () => findShape(t.content.slides[0].shapes, id);
  await submit(t, tabsDialog, {stops: [{pos: 2, align: 'ctr'}, {pos: 1, align: 'l'}], defaultTab: 0.5});
  assert.deepEqual(shape().text.paragraphs[1].props.tabs, [{pos: 72, align: 'l'}, {pos: 144, align: 'ctr'}]);
  assert.equal(shape().text.paragraphs[0].props.defaultTab, 36);
  assert.deepEqual(openDialogModel(t.session, t.docId, tabsDialog).stops, [{pos: 1, align: 'l'}, {pos: 2, align: 'ctr'}]);
  await submit(t, columnsDialog, {count: 3, spacing: 0.25});
  assert.deepEqual([shape().text.body.columns, shape().text.body.colSpacing], [3, 18]);
  assert.equal(openDialogModel(t.session, t.docId, columnsDialog).count, 3);
  await submit(t, bulletsDialog, {scheme: 'romanUcPeriod', start: 4, color: 'accent3', size: 80});
  assert.deepEqual(shape().text.paragraphs[0].props.bullet, {kind: 'autoNum', scheme: 'romanUcPeriod', startAt: 4});
  assert.equal(shape().text.paragraphs[0].props.bulletSize, 0.8);
  assert.equal(openDialogModel(t.session, t.docId, bulletsDialog).kind, 'numbered');
  await submit(t, bulletsDialog, {custom: '♦'});
  assert.deepEqual(shape().text.paragraphs[0].props.bullet, {kind: 'char', char: '♦'});
  const none = bulletsDialog.toCommand({none: true, kind: 'bulleted'});
  assert.deepEqual(none, {command: 'format.bullets', params: {on: false}});
  await submit(t, languageDialog, {lang: 'sv-SE', noProof: true});
  assert.equal(shape().text.paragraphs[0].runs[0].props.lang, 'sv-SE');
  await submit(t, languageDialog, {scope: 'all', lang: 'nl-NL'});
  assert.equal(t.content.defaultTextStyle.levels[0].run.lang, 'nl-NL');
});
