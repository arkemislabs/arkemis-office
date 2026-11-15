// U:prism/edit on schema-2 presentations: cut/copy/paste of text, shapes and slides through the
// session and system clipboards, Paste Special, Paste and Match Formatting, Duplicate, Delete
// (shapes with their animations, text, slides), Select All / Deselect / Select Objects.
//
// 1. What ArtCraft does: deckcraft crates/engine/src/cmd/edit.rs (copy_inner:78, cut:160, paste:266,
//    paste_special:398, paste_text:506, duplicate:511, delete:558, select_all:626, deselect:659,
//    select:676); PowerPoint: Home › Clipboard (Cut, Copy, Paste with its options, Paste Special),
//    Ctrl+D, Delete, Ctrl+A, Esc.
// 2. Ours: the same, with the system clipboard through the Host (plain text + HTML) and deckcraft's
//    rich clipboard in the session; every change is one undo step.
// 3. Proved by these tests, tests/prism/upstream/edit_tests.test.mjs and the bridge E2E
//    tests/e2e/prism/edit-clipboard.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {bodyText} from '../../core/prism/model/text.mjs';
import {selectedSlideIds} from '../../core/prism/model/doc.mjs';
import {withNew, textBox, rect, textOf, shapeOf, selected, textSel, curSlide} from './upstream/text_deck.mjs';

test('cut of shapes: copies them and removes them with their animations (one undo step)', async () => {
  const t = await withNew({shapes: [rect('500', [10, 10, 50, 50], 'A'), rect('501', [100, 10, 50, 50])]});
  const c = structuredClone(t.content);
  c.slides[0].animations = [{shape: '500', effect: 'fade', trigger: null}, {shape: '501', effect: 'fly', trigger: '500'}];
  t.session.reload(t.docId, {...t.file, content: c});
  await t.exec('edit.select', {ids: ['500']});
  const r = await expectUndoRoundTrip(t, 'edit.cut', {}, after => {
    const sl = after.content.slides[0];
    assert.ok(!sl.shapes.some(x => x.id === '500'));
    assert.deepEqual(sl.animations, [{shape: '501', effect: 'fly', trigger: null}], 'animations of cut shapes go; their triggers fall back');
  });
  assert.equal(r.result.text, 'A');
  assert.equal(t.host.clipboard?.text ?? (await t.host.clipboardRead()).text, 'A');
  await expectUndoRoundTrip(t, 'edit.paste', {}, after => assert.ok(after.content.slides[0].shapes.some(x => bodyText(x.text) === 'A')));
});

test('copy and paste text inside a text box keeps formatting; another app\'s text pastes as plain', async () => {
  const box = textBox('500', [10, 10, 300, 40], '');
  box.text.paragraphs = [{level: 0, runs: [{text: 'Bold', props: {bold: true}}, {text: ' plain'}]}];
  const t = await withNew({shapes: [box]});
  await t.exec('text.edit', {id: '500', at: [0, 0]});
  await t.exec('text.select', {anchor: [0, 0], caret: [0, 4]});
  const v = (await t.exec('edit.copy', {})).result;
  assert.deepEqual(v, {text: 'Bold', html: '<p><b>Bold</b></p>'});
  await t.exec('text.move', {to: 'end'});
  await expectUndoRoundTrip(t, 'edit.paste', {}, after => {
    const runs = after.content.slides[0].shapes.at(-1).text.paragraphs[0].runs;
    assert.equal(runs.at(-1).text, 'Bold');
    assert.equal(runs.at(-1).props.bold, true);
  });
  // Another app put text on the system clipboard: it wins over ours.
  await t.host.clipboardWrite({text: 'from mail', html: ''});
  await t.exec('edit.paste', {});
  assert.equal(textOf(t, '500'), 'Bold plainBoldfrom mail');
});

test('paste outside text makes a text box in the middle of the slide (insert.textBox not registered: translated here)', async () => {
  const t = await withNew();
  await t.host.clipboardWrite({text: 'Loose words', html: ''});
  const r = await expectUndoRoundTrip(t, 'edit.paste', {});
  const sh = shapeOf(t, r.result.id);
  assert.equal(bodyText(sh.text), 'Loose words');
  assert.equal(sh.textBox, true);
  assert.deepEqual([sh.xfrm.x, sh.xfrm.y, sh.xfrm.w], [240, 216, 480]);
  assert.match(sh.name, /^TextBox \d+$/);
  assert.deepEqual(selected(t), [r.result.id]);
});

test('paste of slides goes after the current slide; edit.pasteText pastes plain text; undo', async () => {
  const t = await withNew();
  await t.exec('slide.new', {layout: 'blank'});
  await t.exec('slide.go', {index: 0});
  await t.exec('edit.copy', {scope: 'slides'});
  await expectUndoRoundTrip(t, 'edit.paste', {}, after => assert.equal(after.content.slides.length, 3));
  assert.equal(selectedSlideIds(t.content, t.doc.selection)[0], t.content.slides[1].id);
  await t.exec('text.edit', {id: curSlide(t).shapes[0].id});
  await expectUndoRoundTrip(t, 'edit.pasteText', {text: 'typed\nlines'}, after => {
    assert.equal(bodyText(after.content.slides[1].shapes[0].text), 'typed\nlines');
  });
});

test('edit.pasteSpecial: Keep Text Only and Use Destination Theme; undo', async () => {
  const t = await withNew({shapes: [rect('500', [10, 10, 80, 40], 'Shape text')]});
  await t.exec('edit.copy', {});
  await expectUndoRoundTrip(t, 'edit.pasteSpecial', {as: 'text'}, after => assert.equal(bodyText(after.content.slides[0].shapes.at(-1).text), 'Shape text'));
  await expectUndoRoundTrip(t, 'edit.pasteSpecial', {as: 'destinationTheme'}, after => {
    const sh = after.content.slides[0].shapes.at(-1);
    assert.deepEqual([sh.xfrm.x, sh.xfrm.y], [22, 22], 'pasted on the same slide: offset');
  });
});

test('edit.duplicate offsets the copies and names them "… copy"; undo', async () => {
  const t = await withNew({shapes: [rect('500', [10, 10, 50, 50], undefined, 'Box')]});
  const r = await expectUndoRoundTrip(t, 'edit.duplicate', {}, after => {
    const sh = after.content.slides[0].shapes.at(-1);
    assert.equal(sh.name, 'Box copy');
    assert.deepEqual([sh.xfrm.x, sh.xfrm.y], [22, 22]);
  });
  assert.deepEqual(selected(t), r.result.ids);
  await t.exec('edit.duplicate', {});
  assert.equal(curSlide(t).shapes.at(-1).name, 'Box copy');
  assert.deepEqual(t.state('edit.duplicate').enabled, true);
  await t.exec('edit.deselect', {});
  assert.deepEqual(t.state('edit.duplicate'), {enabled: false, reason: 'nothing selected'});
});

test('edit.delete: shapes by ids (groups emptied go), the next character while editing, the slide with nothing selected', async () => {
  const child = rect('502', [0, 0, 10, 10]);
  const group = {...rect('503', [10, 10, 100, 40]), text: null, kind: {type: 'group', children: [child], child: {x: 0, y: 0, w: 10, h: 10}}};
  const t = await withNew({shapes: [textBox('500', [10, 10, 100, 40], 'abc'), group]});
  await expectUndoRoundTrip(t, 'edit.delete', {ids: ['502']}, after => assert.ok(!after.content.slides[0].shapes.some(x => x.id === '503'), 'the emptied group goes'));
  await t.exec('text.edit', {id: '500', at: [0, 0]});
  await t.exec('edit.delete', {});
  assert.equal(textOf(t, '500'), 'bc');
  await t.exec('text.exit', {});
  await t.exec('slide.new', {});
  await t.exec('edit.deselect', {});
  await t.exec('edit.deselect', {});
  assert.equal(t.content.slides.length, 2);
  await t.exec('edit.delete', {});
  assert.equal(t.content.slides.length, 1, 'with only the slide selected, Delete deletes it (deckcraft slides scope)');
});

test('edit.selectAll skips hidden and locked shapes; selects all text while editing; edit.select add/toggle; deselect', async () => {
  const t = await withNew({shapes: [rect('500', [0, 0, 10, 10]), rect('501', [0, 0, 10, 10], undefined, undefined, {hidden: true}),
    rect('502', [0, 0, 10, 10], undefined, undefined, {locked: true}), textBox('503', [0, 0, 100, 20], 'xyz')]});
  await t.exec('edit.selectAll', {});
  const ids = selected(t);
  assert.ok(ids.includes('500') && ids.includes('503') && !ids.includes('501') && !ids.includes('502'));
  await t.exec('edit.select', {ids: ['500']});
  await t.exec('edit.select', {ids: ['503'], add: true});
  assert.deepEqual(selected(t), ['500', '503']);
  await t.exec('edit.select', {ids: ['500'], toggle: true});
  assert.deepEqual(selected(t), ['503']);
  await t.exec('text.edit', {id: '503', at: [0, 1]});
  await t.exec('edit.selectAll', {});
  assert.deepEqual([textSel(t).anchor, textSel(t).caret], [[0, 0], [0, 3]]);
  await t.exec('edit.deselect', {});
  assert.deepEqual(selected(t), ['503'], 'Esc while editing selects the shape');
  await t.exec('edit.deselect', {});
  assert.deepEqual(selected(t), []);
});
