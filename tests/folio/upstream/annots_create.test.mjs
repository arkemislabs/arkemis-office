// Ported from printcraft crates/annot/src/tests.rs at 3109bb2359759e24ef490e1cdbdba00722b20972
// (MIT, see assets/third-party-licenses/artcraft-reference.txt): building and editing comments
// (core/folio/model/annots.mjs, appearance.mjs) and writing them (model/pdf-write.mjs). Upstream
// edits a COS document and reopens it; here the comment records are written with the folio writer
// and the file is read back with pdf-lib.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFName, PDFDict} from 'pdf-lib';
import {fixtureContent, make, addTo, replaceIn, reopen, name, text, nums, rect, apContent, apResources, meta} from './annots_helpers.mjs';
import {createAnnotation, moveAnnotation, setRect, setStyle, setPoints, replyTo, withReplies, eraseInk, setContents} from '../../../core/folio/model/annots.mjs';
import {defaultStyle} from '../../../core/folio/model/types.mjs';

test('every_tool_creates_a_drawable_comment', async () => {
  const shapes = [
    {kind: 'Note', at: [100, 700], icon: 'Comment'},
    {kind: 'TextMarkup', markup: 'Highlight', quads: [[72, 712, 200, 712, 72, 700, 200, 700]]},
    {kind: 'TextMarkup', markup: 'Underline', quads: [[72, 612, 200, 612, 72, 600, 200, 600]]},
    {kind: 'TextMarkup', markup: 'StrikeOut', quads: [[72, 512, 200, 512, 72, 500, 200, 500]]},
    {kind: 'TextMarkup', markup: 'Squiggly', quads: [[72, 412, 200, 412, 72, 400, 200, 400]]},
    {kind: 'Rectangle', rect: [300, 300, 200, 200]},
    {kind: 'Oval', rect: [300, 300, 400, 350]},
    {kind: 'Line', from: [50, 50], to: [150, 100], start: 'None', end: 'OpenArrow'},
    {kind: 'Ink', strokes: [[[10, 10], [20, 30], [30, 10]], [[40, 40]]]},
    {kind: 'TextBox', rect: [300, 600, 500, 650], fontSize: 14},
  ];
  let content = await fixtureContent();
  shapes.forEach((s, i) => { content = addTo(content, 0, make(s, `id-${i}`)); });
  const {doc, list} = await reopen(content);
  const all = list(0);
  // The inline square, 10 comments and the sticky note's pop-up.
  assert.equal(all.length, 12);
  assert.deepEqual(all.map(e => name(e.dict, 'Subtype')),
    ['Square', 'Text', 'Popup', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Square', 'Circle', 'Line', 'Ink', 'FreeText']);
  for (const {dict} of all.slice(1)) {
    if (name(dict, 'Subtype') === 'Popup') continue;
    assert.equal(text(dict, 'T'), 'Ada');
    assert.equal(text(dict, 'Contents'), 'hello');
    assert.ok(dict.get(PDFName.of('P')), '/P points at the page');
    assert.ok(apContent(doc, dict).length > 0, `${name(dict, 'Subtype')} has an appearance`);
  }
  // Highlight multiplies; the rectangle was normalized.
  const gs = apResources(doc, all[3].dict).lookup(PDFName.of('ExtGState')).lookup(PDFName.of('GS0'));
  assert.equal(gs.lookup(PDFName.of('BM')).decodeText(), 'Multiply');
  assert.deepEqual(rect(all[7].dict), [200, 200, 300, 300]);
  // The arrow's rectangle includes the arrowhead and the stroke.
  const r = rect(all[9].dict);
  assert.ok(r[0] < 50 && r[2] > 151);
  // The text box draws its contents in Helvetica.
  assert.match(apContent(doc, all[11].dict), /\(hello\) Tj/);
  assert.match(apContent(doc, all[11].dict), /\/Helv 14 Tf/);
  // The note is a fixed-size icon with a closed pop-up.
  assert.equal(all[1].dict.lookup(PDFName.of('F')).asNumber(), 28);
  assert.equal(all[2].dict.get(PDFName.of('Parent')).toString(), all[1].ref.toString());
  assert.equal(all[1].dict.get(PDFName.of('Popup')).toString(), all[2].ref.toString());
});

test('ink_strokes_are_smooth_curves_through_their_points', async () => {
  const strokes = [[[0, 0], [10, 10], [20, 0]], [[30, 0], [40, 10]], [[50, 50]]];
  let content = addTo(await fixtureContent(), 0, make({kind: 'Ink', strokes}, 'ink'));
  const rise = make({kind: 'Ink', strokes: [[[0, 0], [10, 10], [20, 20], [21, 0]]]}, 'rise');
  content = addTo(content, 0, rise);
  const {doc, list} = await reopen(content);
  const ap = apContent(doc, list(0)[1].dict);
  assert.ok(ap.includes('0 0 m\n1.667 1.667 6.667 10 10 10 c\n13.333 10 18.333 1.667 20 0 c\nS\n'), ap);
  assert.ok(ap.includes('30 0 m\n40 10 l\nS\n'), ap);
  assert.ok(ap.includes('50 50 m\n50.01 50 l\nS\n'), ap);
  assert.ok(rect(list(0)[2].dict)[3] >= 21.667 + 2 - 0.01);
});

test('invalid_geometry_is_rejected', () => {
  const bad = [
    {kind: 'TextMarkup', markup: 'Highlight', quads: []},
    {kind: 'Rectangle', rect: [0, 0, 0.5, 10]},
    {kind: 'Line', from: [1, 1], to: [1, 1], start: 'None', end: 'None'},
    {kind: 'Ink', strokes: [[]]},
    {kind: 'Note', at: [NaN, 0], icon: 'Note'},
  ];
  for (const s of bad) assert.throws(() => make(s, 'x'), e => e.code === 'invalid_params', s.kind);
});

test('replies_and_status_thread_onto_the_parent', async () => {
  let content = await fixtureContent();
  const square = content.pages[0].annots[0];
  const r1 = replyTo(square, 'Agreed', 'Bob', meta('r1'));
  const r2 = replyTo(square, 'Accepted set by Bob', 'Bob', meta('r2'), 'Accepted');
  content = addTo(addTo(content, 0, r1), 0, r2);
  const {doc, list} = await reopen(content);
  const all = list(0);
  assert.equal(all[1].dict.get(PDFName.of('IRT')).toString(), all[0].ref.toString());
  assert.equal(text(all[1].dict, 'Contents'), 'Agreed');
  assert.deepEqual(rect(all[1].dict), [10, 10, 50, 50]);
  assert.equal(apContent(doc, all[1].dict), '', 'replies draw nothing');
  assert.equal(text(all[2].dict, 'State'), 'Accepted');
  assert.equal(text(all[2].dict, 'StateModel'), 'Review');
  assert.equal(text(all[2].dict, 'Contents'), 'Accepted set by Bob');
});

test('delete_takes_popup_and_reply_chain', async () => {
  let content = await fixtureContent();
  const note = make({kind: 'Note', at: [100, 100], icon: 'Comment'}, 'n');
  const reply = replyTo(note, 'first', 'Bob', meta('r1'));
  const reply2 = replyTo(reply, 'reply to reply', 'Ada', meta('r2'));
  const onSquare = replyTo(content.pages[0].annots[0], 'on the square', 'Ada', meta('r3'));
  for (const r of [note, reply, reply2, onSquare]) content = addTo(content, 0, r);
  const going = withReplies(content, ['n']);
  assert.deepEqual([...going].sort(), ['n', 'r1', 'r2']);
  content = {...content, pages: content.pages.map((p, i) => (i ? p : {...p, annots: p.annots.filter(r => !going.has(r.id))}))};
  const {list} = await reopen(content);
  assert.deepEqual(list(0).map(e => `${name(e.dict, 'Subtype')}:${text(e.dict, 'Contents')}`), ['Square:', 'Text:on the square']);
});

test('deleting_the_last_comment_removes_annots', async () => {
  const content = await fixtureContent();
  const empty = {...content, pages: content.pages.map((p, i) => (i ? p : {...p, annots: []}))};
  const {doc} = await reopen(empty);
  assert.equal(doc.getPage(0).node.get(PDFName.of('Annots')), undefined);
});

test('move_shifts_all_geometry_and_the_popup', async () => {
  const q = [72, 712, 200, 712, 72, 700, 200, 700];
  let content = await fixtureContent();
  const h = make({kind: 'TextMarkup', markup: 'Highlight', quads: [q]}, 'h');
  const i = make({kind: 'Ink', strokes: [[[10, 10], [20, 20]]]}, 'i');
  const n = make({kind: 'Note', at: [100, 100], icon: 'Note'}, 'n');
  for (const r of [h, i, n]) content = addTo(content, 0, moveAnnotation(r, 10, -5, meta('')));
  const {list} = await reopen(content);
  const all = list(0);
  assert.deepEqual(nums(all[1].dict, 'QuadPoints'), [82, 707, 210, 707, 82, 695, 210, 695]);
  const ink = all[2].dict.lookup(PDFName.of('InkList')).asArray()[0].asArray().map(x => x.asNumber());
  assert.deepEqual(ink, [20, 5, 30, 15]);
  assert.deepEqual(rect(all[3].dict), [110, 75, 130, 95]);
  assert.equal(rect(all[4].dict)[0], 140);
});

test('restyle_and_resize_redraw_the_appearance', async () => {
  let r = make({kind: 'Rectangle', rect: [10, 10, 110, 60]}, 'r');
  r = setStyle(r, {color: [1, 0, 0], opacity: 0.5, width: 4}, meta(''));
  r = setRect(r, [0, 0, 200, 100], meta(''));
  const content = addTo(await fixtureContent(), 0, r);
  const {doc, list} = await reopen(content);
  const d = list(0)[1].dict;
  const ap = apContent(doc, d);
  assert.ok(ap.includes('1 0 0 RG') && ap.includes('4 w') && ap.includes('/GS0 gs'), ap);
  assert.ok(ap.includes('2 2 196 96 re'), `inset by half the border: ${ap}`);
  assert.equal(d.lookup(PDFName.of('CA')).asNumber(), 0.5);
  // A stamp's appearance can't be regenerated, so restyling it changes nothing.
  const stamp = (await fixtureContent()).pages[1].annots[0];
  assert.throws(() => setStyle(stamp, {color: [0, 0, 0]}, meta('')), /Stamp comments can't be restyled/);
  // Lines can't be resized as rectangles.
  const l = make({kind: 'Line', from: [0, 0], to: [10, 10], start: 'None', end: 'None'}, 'l');
  assert.throws(() => setRect(l, [0, 0, 5, 5], meta('')), e => e.code === 'invalid_params');
});

test('unknown_keys_survive_edits', async () => {
  let content = await fixtureContent();
  const sq = content.pages[0].annots[0];
  content = replaceIn(content, 0, 0, {...sq, dict: {...sq.dict, Custom: '/KeepMe'}});
  content = replaceIn(content, 0, 0, setStyle(content.pages[0].annots[0], {color: [0, 0, 1]}, meta('')));
  const {list} = await reopen(content);
  assert.equal(name(list(0)[0].dict, 'Custom'), 'KeepMe');
  assert.deepEqual(nums(list(0)[0].dict, 'C'), [0, 0, 1]);
});

test('lines_and_polygons_are_reshaped_by_their_points', () => {
  const line = make({kind: 'Line', from: [10, 10], to: [100, 10], start: 'None', end: 'None'}, 'l');
  const moved = setPoints(line, [[20, 20], [120, 40]], meta(''));
  assert.deepEqual(moved.dict.L, [20, 20, 120, 40]);
  assert.ok(moved.dict.Rect[0] <= 20 - 1 && moved.dict.Rect[3] >= 41);
  assert.throws(() => setPoints(line, [[0, 0]], meta('')), /a line has two ends/);
  const poly = make({kind: 'Polygon', vertices: [[0, 0], [50, 0], [25, 40]], cloud: false}, 'p');
  assert.deepEqual(setPoints(poly, [[0, 0], [60, 0], [30, 50]], meta('')).dict.Vertices, [0, 0, 60, 0, 30, 50]);
});

test('the_eraser_cuts_strokes_and_removes_empty_drawings', () => {
  const ink = make({kind: 'Ink', strokes: [[[0, 0], [100, 0]]]}, 'ink');
  const cut = eraseInk(ink, [[50, 0]], 5, meta(''));
  assert.equal(cut.dict.InkList.length, 2, 'the stroke was split where the eraser crossed it');
  assert.equal(eraseInk(ink, [[500, 500]], 5, meta('')), ink, 'nothing erased');
  assert.equal(eraseInk(ink, [[0, 0], [100, 0]], 5, meta('')), null, 'a drawing with nothing left goes');
});

test('editing_a_text_box_refits_its_rectangle', () => {
  const box = createAnnotation({shape: {kind: 'TextBox', rect: [100, 600, 300, 650], fontSize: 12}, style: defaultStyle({kind: 'TextBox'}), contents: 'one'}, meta('b'));
  const edited = setContents(box, 'one\ntwo\nthree\nfour', meta(''));
  const r = edited.dict.Rect;
  assert.equal(r[3], 650, 'the top edge stays');
  assert.equal(r[2] - r[0], 200, 'the wrap width stays');
  assert.ok(650 - r[1] > 4 * 12 * 1.2, 'the height fits four lines');
});
