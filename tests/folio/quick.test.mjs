// core/folio/commands/quick.mjs: the quick bar's comment tool properties and Fill & Sign font size.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) crates/ui-egui/src/tools/comments/menu.rs quick_bar_controls, comments.rs (has_fill, has_width, min_width),
//    canvas/bars.rs: the controls change the default style of the comment tool in use (colour, fill for six tools, opacity 10–100 %,
//    thickness for the drawing, point, text box and callout tools); a colour also recolours the selected comment its tool made; Fill & Sign's
//    Font size sets the next text and the selected Fill & Sign text. Acrobat's tool properties bar does the same.
// 2. Ours does the same on a real PDF.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import {hasFill, hasWidth} from '../../core/folio/commands/quick.mjs';
import {props} from '../../core/folio/model/annots.mjs';

after(() => releaseTextSources());
const open = () => createTestSession('folio', {fixture: 'textPages'});
const state = (t, id, args = {}) => t.session.state(t.docId, id, args);

test('the properties apply to the tool in use: none without one, a fill only for the six tools that have one, a thickness for the line tools', async () => {
  assert.deepEqual(['comment.square', 'comment.circle', 'comment.polygon', 'comment.cloud', 'comment.freetext', 'comment.callout'].map(hasFill), Array(6).fill(true));
  assert.equal(hasFill('comment.ink'), false);
  assert.equal(hasWidth('comment.highlight'), false);
  assert.equal(hasWidth('comment.note'), false);
  assert.equal(hasWidth('comment.eraser'), true);
  const t = await open();
  const none = await state(t, 'comment.tool_color');
  assert.equal(none.enabled, false);
  assert.equal(none.hidden, true, 'no comment tool picked: the quick bar shows no properties');
  await t.exec('comment.ink', {});
  assert.equal((await state(t, 'comment.tool_color')).enabled, true);
  assert.equal((await state(t, 'comment.tool_fill')).hidden, true, 'the pen has no fill');
  assert.equal((await state(t, 'comment.tool_width')).enabled, true);
  await t.exec('comment.square', {});
  assert.equal((await state(t, 'comment.tool_fill')).enabled, true);
  await t.exec('comment.highlight', {});
  assert.equal((await state(t, 'comment.tool_width')).hidden, true, 'a highlight has no thickness');
});

test('a property changes the default of the tool in use and the controls read it back; opacity steps by 5 within 10 to 100', async () => {
  const t = await open();
  await t.exec('comment.square', {});
  assert.equal((await state(t, 'comment.tool_width')).value, 2, 'the default of a rectangle');
  await t.exec('comment.tool_width', {width: 4.5});
  assert.equal((await state(t, 'comment.tool_width')).value, 4.5);
  await t.exec('comment.tool_color', {color: '#0000ff'});
  assert.equal((await state(t, 'comment.tool_color')).value, '#0000ff');
  await t.exec('comment.tool_fill', {fill: '#ffff00'});
  assert.equal((await state(t, 'comment.tool_fill')).value, '#ffff00');
  await t.exec('comment.tool_fill', {fill: null});
  assert.equal((await state(t, 'comment.tool_fill')).value, null, 'No fill');
  assert.equal((await t.exec('comment.tool_opacity', {percent: 47})).result.opacityPercent, 45);
  assert.equal((await t.exec('comment.tool_opacity', {percent: 10})).result.opacityPercent, 10);
  await assert.rejects(t.exec('comment.tool_opacity', {percent: 5}), /percent/);
  // The next rectangle is drawn so.
  const r = await t.exec('comment.square', {page: 1, points: [[40, 40], [120, 100]]});
  const style = t.content.pages[0].annots.at(-1);
  assert.ok(r.result);
  assert.deepEqual(style.dict.C, [0, 0, 1]);
  assert.equal(style.dict.CA, 0.1);
  // Another tool keeps its own look.
  await t.exec('comment.circle', {});
  assert.equal((await state(t, 'comment.tool_color')).value, '#e32121', 'the oval still has its own red');
  await assert.rejects(t.exec('comment.tool_style', {tool: 'comment.ink', fill: '#ffffff'}), /no fill/);
  await assert.rejects(t.exec('comment.tool_style', {tool: 'comment.note', width: 3}), /thickness/);
});

test('a colour picked also recolours the selected comment when the tool in use made it', async () => {
  const t = await open();
  await t.exec('comment.square', {page: 1, points: [[40, 40], [120, 100]]});
  const rec = t.content.pages[0].annots.at(-1);
  t.session.setSelection(t.docId, {ranges: [{anchor: `/pg:${encodeURIComponent(t.content.pages[0].id)}/annot:${encodeURIComponent(rec.id)}`, focus: `/pg:${encodeURIComponent(t.content.pages[0].id)}/annot:${encodeURIComponent(rec.id)}`}], primary: 0});
  await t.exec('comment.square', {});
  const r = await t.exec('comment.tool_color', {color: '#00ff00'});
  assert.equal(r.result.recoloured, true);
  assert.deepEqual(t.content.pages[0].annots.find(a => a.id === rec.id).dict.C, [0, 1, 0]);
  // A rectangle's colour does not recolour a selected oval.
  await t.exec('comment.circle', {page: 1, points: [[60, 160], [140, 220]]});
  const oval = t.content.pages[0].annots.at(-1);
  const addr = `/pg:${encodeURIComponent(t.content.pages[0].id)}/annot:${encodeURIComponent(oval.id)}`;
  t.session.setSelection(t.docId, {ranges: [{anchor: addr, focus: addr}], primary: 0});
  await t.exec('comment.square', {});
  const r2 = await t.exec('comment.tool_color', {color: '#123456'});
  assert.equal(r2.result.recoloured, undefined);
});

test('Fill & Sign Font size: the next text takes it, 4 to 300 pt', async () => {
  const t = await open();
  assert.equal((await state(t, 'sign.fill.text_size')).hidden, true, 'only for Fill & Sign text and date');
  await t.exec('sign.fill.text', {});
  assert.equal((await state(t, 'sign.fill.text_size')).value, 10, 'the default size');
  await t.exec('sign.fill.text_size', {size: 18});
  assert.equal((await state(t, 'sign.fill.text_size')).value, 18);
  await assert.rejects(t.exec('sign.fill.text_size', {size: 3}), /size/);
  await assert.rejects(t.exec('sign.fill.text_size', {size: 301}), /size/);
  const r = await t.exec('sign.fill.text', {page: 1, at: [60, 80], text: 'Hello'});
  assert.ok(r.result);
  const sm = t.content.pages[0].annots.at(-1);
  assert.equal(props(sm).fontSize, 18, 'the text is set at 18 pt');
});
