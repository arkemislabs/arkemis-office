// U:prism/insert: Insert-tab commands on a schema-2 deck, one undo step each.
//
// 1. What ArtCraft does: deckcraft crates/engine/src/cmd/insert.rs and insert/{picture,
//    text_fields,links}.rs add shapes named "<Kind> n" (first free number), selected; a text box
//    with no text starts typing; a picture fills a selected empty content placeholder (cropped to
//    its aspect); fields, symbols and links go in at the caret; action settings and links on
//    selected shapes. PowerPoint's Insert tab does the same.
// 2. Ours: the same commands over the kernel change API.
// 3. Proved here; upstream tests in tests/prism/upstream/insert_tests.test.mjs; the ribbon path in
//    tests/e2e/prism/insert-shapes.e2e.mjs.
import hyperlinkDialog from '../../core/prism/dialogs/hyperlink.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {selectText} from '../../core/prism/model/doc.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwQZGBgAJPwF+4uP4SAAAAAASUVORK5CYII=';

async function session(opts = {}) {
  const c = createContent('Insert');
  const sid = c.slides[0].id;
  return createTestSession('prism', {content: c, selection: {ranges: [{anchor: `/sl:${sid}`, focus: `/sl:${sid}`}], primary: 0}, ...opts});
}
const shapes = r => r.content.slides[0].shapes;
const last = r => shapes(r).at(-1);

test('shapes: preset, line style, connector arrowhead, automatic names, selection', async () => {
  const t = await session();
  const sid = t.content.slides[0].id;
  const r = await expectUndoRoundTrip(t, 'shape.insert', {preset: 'star5', rect: [10, 20, 100, 100], text: 'Hi'}, rd => {
    const s = last(rd);
    assert.deepEqual(s.geom, {kind: 'preset', name: 'star5'});
    assert.deepEqual(s.style.fillRef[1], {base: {kind: 'scheme', slot: 'accent1'}});
    assert.equal(s.text.paragraphs[0].props.align, 'center');
    assert.match(s.name, /^Star: 5 Points \d+$|^Star \d+$/);
  });
  assert.deepEqual(t.doc.selection.ranges.map(x => x.anchor), [`/sl:${sid}/sp:${r.result.id}`]);
  await t.exec('shape.insert', {preset: 'straightConnector1'});
  const c = last(t);
  assert.equal(c.kind.type, 'connector');
  assert.deepEqual(c.line.tail, {kind: 'triangle', w: 'med', len: 'med'});
  assert.equal(c.xfrm.h, 0, 'a click-inserted line is flat');
  await assert.rejects(t.exec('shape.insert', {preset: 'blob'}), /unknown preset `blob`/);
  assert.ok((await t.exec('shape.presets', {})).result.some(p => p.name === 'rect' && p.category === 'Rectangles'));
  assert.equal(t.state('tool.shape', {}).value.length > 180, true);
});

test('text box and WordArt: wrapping, autofit, typing starts in an empty box', async () => {
  const t = await session();
  const sid = t.content.slides[0].id;
  const r = await expectUndoRoundTrip(t, 'insert.textBox', {}, rd => {
    const s = last(rd);
    assert.equal(s.textBox, true);
    assert.deepEqual([s.text.body.wrap, s.text.body.autofit], [true, {kind: 'shape'}]);
  });
  assert.equal(t.doc.selection.ranges[0].anchor, `/sl:${sid}/sp:${r.result.id}/t:0`, 'typing starts immediately');
  await expectUndoRoundTrip(t, 'insert.textBox', {rect: [10, 10, 0, 0], text: 'Grow'}, rd => {
    const s = last(rd);
    assert.equal(s.text.body.wrap, false, 'a click-created box grows sideways');
  });
  await expectUndoRoundTrip(t, 'insert.wordArt', {style: 5}, rd => {
    const run = last(rd).text.paragraphs[0].runs[0];
    assert.deepEqual([run.text, run.props.size, run.props.bold], ['Your text here', 54, true]);
    assert.deepEqual(run.props.fill.color, {base: {kind: 'scheme', slot: 'accent1'}});
    assert.equal(run.props.outline.width, 1);
  });
  assert.equal(t.state('insert.wordArt', {}).value.length, 6);
});

test('table: rows × columns centred, data filled', async () => {
  const t = await session();
  await expectUndoRoundTrip(t, 'insert.table', {rows: 2, cols: 3, data: [['a', 'b'], ['c']]}, rd => {
    const s = last(rd);
    assert.equal(s.kind.type, 'table');
    assert.equal(s.kind.rows.length, 2);
    assert.equal(s.kind.cols.length, 3);
    assert.equal(s.kind.rows[0].cells[1].text.paragraphs[0].runs[0].text, 'b');
    assert.deepEqual([s.xfrm.x, s.xfrm.w, s.xfrm.h], [96, 768, 80]);
    assert.match(s.name, /^Table \d+$/);
  });
});

test('pictures: natural size, placeholder fill with crop, non-pictures refused, the Open dialog on the UI path', async () => {
  const t = await session();
  await expectUndoRoundTrip(t, 'insert.picture', {data: PNG, name: 'dot.png'}, rd => {
    const s = last(rd);
    assert.equal(s.kind.type, 'picture');
    assert.deepEqual([s.xfrm.w, s.xfrm.h], [1.5, 0.75], '2×1 px at 96 dpi');
    assert.equal(s.descr, 'dot.png');
    assert.equal(rd.content.media.at(-1).contentType, 'image/png');
  });
  await assert.rejects(t.exec('insert.picture', {data: btoa('hello'), name: 'notes.txt'}), /is not a picture/);
  await assert.rejects(t.bridge('insert.picture', {}), /missing `path` or `data`/);
  // A selected empty content placeholder takes the picture, cropped to its aspect.
  const sl = t.content.slides[0];
  const body = sl.shapes.find(s => s.ph?.kind === 'subTitle' || s.ph?.kind === 'body' || s.ph?.kind === 'obj');
  if (body) {
    t.content.slides[0].shapes = sl.shapes.map(s => (s.id === body.id ? {...s, ph: {...s.ph, kind: 'body'}, text: null} : s));
    t.session.setSelection(t.docId, {ranges: [{anchor: `/sl:${sl.id}/sp:${body.id}`, focus: `/sl:${sl.id}/sp:${body.id}`}], primary: 0});
    const r = await t.exec('insert.picture', {data: PNG, name: 'dot.png'});
    assert.equal(r.result.id, body.id);
    const s = t.content.slides[0].shapes.find(x => x.id === body.id);
    assert.equal(s.ph.kind, 'picture');
    assert.ok(s.kind.fill.crop.some(v => v > 0), 'cropped to the placeholder');
  }
  const host = createTestHost();
  host.pickImage = async () => `data:image/png;base64,${PNG}`;
  const u = await session({host});
  const r = await u.exec('insert.picture', {});
  assert.ok(r.result.id, 'the UI path asks the system Open dialog');
  host.pickImage = async () => null;
  const v = u.version;
  await u.exec('insert.picture', {});
  assert.equal(u.version, v, 'cancelling the Open dialog changes nothing');
});

test('audio and video: embedded media, type checked', async () => {
  const t = await session();
  const MP4 = btoa('\0\0\0\x18ftypmp42\0\0\0\0mp42isom');
  await expectUndoRoundTrip(t, 'insert.video', {data: MP4, name: 'clip.mp4'}, rd => {
    const s = last(rd);
    assert.equal(s.kind.type, 'media');
    assert.equal(s.kind.video, true);
    assert.match(s.name, /^Video \d+$/);
  });
  const MP3 = btoa('ID3\x03\0\0\0\0\0\0');
  await expectUndoRoundTrip(t, 'insert.audio', {data: MP3, name: 'a.mp3'}, rd => assert.deepEqual([last(rd).xfrm.w, last(rd).kind.video], [48, false]));
  await assert.rejects(t.exec('insert.video', {data: MP3, name: 'a.mp3'}), /not a supported video/);
});

test('fields, symbols and links at the caret; links and actions on shapes; action buttons', async () => {
  const t = await session();
  const sl = t.content.slides[0];
  const title = sl.shapes[0];
  t.session.setSelection(t.docId, selectText(sl.id, [title.id], 0, 0));
  await t.exec('text.insert', {text: 'Slide '});
  await expectUndoRoundTrip(t, 'insert.slideNumber', {}, rd => {
    const runs = rd.content.slides[0].shapes[0].text.paragraphs[0].runs;
    assert.ok(runs.some(r => r.kind?.kind === 'field' && r.kind.field === 'slidenum' && r.text === '‹#›'));
  });
  await expectUndoRoundTrip(t, 'insert.symbol', {text: '€'}, rd => assert.match(rd.content.slides[0].shapes[0].text.paragraphs[0].runs.map(r => r.text).join(''), /€/));
  await expectUndoRoundTrip(t, 'insert.hyperlink', {url: 'mailto:a@b.c'}, rd => {
    const run = rd.content.slides[0].shapes[0].text.paragraphs[0].runs.find(r => r.props?.link);
    assert.equal(run.text, 'a@b.c');
    assert.deepEqual(run.props.link, {action: {kind: 'url', url: 'mailto:a@b.c'}, tooltip: '', highlightClick: false});
  });
  t.session.setSelection(t.docId, {ranges: [{anchor: `/sl:${sl.id}/sp:${title.id}`, focus: `/sl:${sl.id}/sp:${title.id}`}], primary: 0});
  await assert.rejects(t.exec('insert.symbol', {text: 'x'}), /place the insertion point in text first/);
  await expectUndoRoundTrip(t, 'insert.hyperlink', {slide: 0, tooltip: 'Back'}, rd => assert.deepEqual(rd.content.slides[0].shapes[0].click,
    {action: {kind: 'slide', slide: sl.id}, tooltip: 'Back', highlightClick: false}));
  await expectUndoRoundTrip(t, 'insert.hyperlink', {jump: 'next', tooltip: ''}, rd => assert.deepEqual(rd.content.slides[0].shapes[0].click,
    {action: {kind: 'nextSlide'}, tooltip: '', highlightClick: false}));
  // Place in This Document: the four jumps, then every slide by title; a slide or a jump goes to the command.
  const hv = hyperlinkDialog.init(t.session.readContext(t.docId));
  assert.deepEqual(hv.slideTargets.slice(0, 4).map(o => o.value), ['first', 'last', 'next', 'previous']);
  assert.equal(hv.slideTargets.length, 4 + t.content.slides.length);
  assert.deepEqual(hyperlinkDialog.toCommand({...hv, mode: 'slide', slide: 'last'}).params.jump, 'last');
  assert.equal(hyperlinkDialog.toCommand({...hv, mode: 'slide', slide: 2}).params.slide, 1);
  assert.equal(hyperlinkDialog.validate({...hv, mode: 'slide', slide: 'previous'}).length, 0);
  assert.equal(hyperlinkDialog.validate({...hv, mode: 'slide', slide: 'nowhere'}).length, 1);
  await expectUndoRoundTrip(t, 'shape.action', {on: 'hover', action: 'url', url: 'https://x.y'}, rd => assert.deepEqual(rd.content.slides[0].shapes[0].hover,
    {action: {kind: 'url', url: 'https://x.y'}, tooltip: '', highlightClick: true}));
  await assert.rejects(t.exec('shape.action', {action: 'customShow', show: 'Nope'}), /no custom show `Nope`/);
  await assert.rejects(t.exec('shape.action', {on: 'wiggle'}), /`on` is click or hover/);
  await expectUndoRoundTrip(t, 'insert.actionButton', {kind: 'home'}, rd => {
    const s = last(rd);
    assert.deepEqual(s.geom, {kind: 'preset', name: 'actionButtonHome'});
    assert.deepEqual(s.click.action, {kind: 'firstSlide'});
  });
});

test('Equation dialog (body.rs dlg_equation): pretty_equation and one undo step inserting the italic 28 pt box', async () => {
  const {prettyEquation} = await import('../../core/prism/dialogs/equation.mjs');
  const dialog = (await import('../../core/prism/dialogs/equation.mjs')).default;
  const {submitDialog, openDialogModel} = await import('../../core/kernel/dialog.mjs');
  assert.equal(prettyEquation('a^2+b^2=c^2'), 'a²⁺b²=c²', 'deckcraft takes a sign right after the exponent digits into it');
  assert.equal(prettyEquation('x^10*y^n+1'), 'x¹⁰·yⁿ+1');
  assert.equal(prettyEquation('sqrt(x)<=pi +-1 != 2'), '√(x)≤π ±1 ≠ 2');
  const t = await session();
  const n = t.doc.undo.size;
  const v = {...openDialogModel(t.session, t.docId, dialog), text: 'E=mc^2'};
  assert.deepEqual(dialog.validate({text: ''}).map(e => e.field), ['text']);
  await submitDialog(t.session, t.docId, dialog, v);
  assert.equal(t.doc.undo.size, n + 1, 'one undo step');
  const box = t.content.slides[0].shapes.at(-1);
  assert.equal(box.text.paragraphs[0].runs[0].text, 'E=mc²');
  assert.deepEqual([box.text.paragraphs[0].runs[0].props.font, box.text.paragraphs[0].runs[0].props.italic, box.text.paragraphs[0].runs[0].props.size],
    ['Liberation Serif', true, 28]);
});
