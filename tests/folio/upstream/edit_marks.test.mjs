// Ports of printcraft crates/edit/src/tests.rs (page marks) at
// 3109bb2359759e24ef490e1cdbdba00722b20972: tokens_expand,
// header_and_footer_are_drawn_in_display_space_and_wrap_the_original_content,
// header_and_footer_are_drawn_in_the_chosen_standard_face,
// a_header_never_takes_over_a_font_name_the_page_already_draws_with,
// header_start_number_that_would_wrap_is_refused_without_drawing,
// header_bates_start_that_would_overflow_is_refused_without_drawing,
// replace_and_remove_restore_the_original_content,
// shrink_scales_the_original_content_into_the_band_between_header_and_footer,
// shrink_is_undone_by_remove_and_not_doubled_by_update, shrink_with_no_room_left_is_refused_without_drawing,
// watermarks_rotate_fade_and_can_go_behind, a_second_background_is_drawn_over_the_first,
// backgrounds_stay_below_watermarks_behind_the_content,
// a_watermark_behind_goes_under_one_on_top_of_a_page_without_content,
// watermark_offset_moves_the_centre_right_and_up, a_watermark_offset_that_is_not_finite_is_refused,
// invalid_requests_change_nothing, new_marks_do_not_accumulate_wrappers_for_self_contained_marks.
//
// Behaviour fidelity: (1) upstream crates/edit/src/apply.rs + place.rs + marks.rs; Acrobat's Edit a
// PDF ▸ Header & Footer / Watermark / Background add tagged page content. (2) Ours writes the same
// streams (the same operators and numbers) through pdf-lib. (3) These tests, plus
// tests/folio/edit-marks.test.mjs (commands, undo, save) and tests/e2e/folio/edit-marks.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFDict, PDFArray, PDFRef} from 'pdf-lib';
import {
  expand, batesStart, addHeaderFooter, addWatermark, addBackground, removeMarks, marksPresent, defaultHeaderFooter, defaultWatermark, defaultBackground, familyWidth,
} from '../../../core/folio/lib/edit-marks.mjs';
import {decoded, str, pageFonts} from '../../../core/folio/lib/edit-place.mjs';
import {textWidth, n} from '../../../core/folio/lib/fonts.mjs';

const DATE = [2026, 10, 1];

/** The fixture of tests.rs: three pages 600 x 800, page 2 turned 90°, page 3 without content, shared resources. */
async function fixture() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 /MediaBox [0 0 600 800] /Resources 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Rotate 90 /Contents [7 0 R] >>',
    '<< /Type /Page /Parent 2 0 R >>',
    '<< /Font << /F1 8 0 R >> >>',
    '<< /Length 37 >>\nstream\n2 0 0 2 0 0 cm BT /F1 9 Tf (Hi) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  let out = '%PDF-1.7\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return PDFDocument.load(new TextEncoder().encode(out), {updateMetadata: false});
}
const reopen = async doc => PDFDocument.load(await doc.save(), {updateMetadata: false});
/** The decoded content streams of a page, in order. */
function streams(doc, i) {
  const page = doc.getPages()[i];
  const c = page.node.get(PDFName.of('Contents'));
  if (!c) return [];
  const t = c instanceof PDFRef ? doc.context.lookup(c) : c;
  const list = t instanceof PDFArray ? t.asArray() : [c];
  return list.map(o => str(decoded(o instanceof PDFRef ? doc.context.lookup(o) : o)));
}
const hf = (patch = {}) => ({...defaultHeaderFooter(), ...patch});
const text6 = (k, v, base = ['', '', '', '', '', '']) => { const t = [...base]; t[k] = v; return t; };

test('tests.rs tokens_expand', () => {
  assert.equal(expand('Page <<1>> of <<n>>', 3, 10, 0n, DATE), 'Page 3 of 10');
  assert.equal(expand('<<1 of n>> · <<Page 1>> · <<1/n>>', 2, 5, 0n, DATE), '2 of 5 · Page 2 · 2/5');
  assert.equal(expand('<<m/d/yyyy>> <<yyyy-mm-dd>> <<mmmm d, yyyy>>', 1, 1, 0n, DATE), '10/1/2026 2026-10-01 October 1, 2026');
  assert.equal(expand('<<yyyy/mm/dd>> <<yyyy/m/d>>', 1, 1, 0n, DATE), '2026/10/01 2026/10/1');
  assert.equal(expand('<<dd.mm.yyyy>> <<d.m.yyyy>> <<dd.mm.yy>> <<d.m.yy>>', 1, 1, 0n, DATE), '01.10.2026 1.10.2026 01.10.26 1.10.26');
  assert.equal(expand('<<Bates Number#6#100#ABC#-X>>', 1, 1, 104n, DATE), 'ABC000104-X');
  assert.equal(expand('keep <<unknown>> and <<unclosed', 1, 1, 0n, DATE), 'keep <<unknown>> and <<unclosed');
  assert.equal(batesStart('x <<Bates Number#6#100#A#B>>'), 100n);
});

test('tests.rs header_and_footer_are_drawn_in_display_space_and_wrap_the_original_content', async () => {
  let doc = await fixture();
  addHeaderFooter(doc, [0, 1, 2], hf({text: ['Left', '', '<<Page 1 of n>>', '', 'Confidential (draft)', '']}), false, DATE);
  doc = await reopen(doc);
  const s0 = streams(doc, 0);
  assert.equal(s0.length, 4, JSON.stringify(s0));
  assert.deepEqual([s0[0], s0[2]], ['q %Arkemis\n', '\nQ %Arkemis\n']);
  const mark = s0[3];
  assert.ok(mark.includes('/PCMark /HeaderFooter') && mark.includes('(Page 1 of 3) Tj') && mark.includes('(Confidential \\(draft\\)) Tj'), mark);
  assert.ok(mark.includes('1 0 0 1 0 0 cm'), 'upright page: identity');
  const s1 = streams(doc, 1);
  assert.ok(s1.at(-1).includes('0 1 -1 0 600 0 cm') && s1.at(-1).includes('(Page 2 of 3)'), JSON.stringify(s1));
  assert.equal(streams(doc, 2).length, 1);
  const fonts = pageFonts(doc, doc.getPages()[2]);
  assert.ok(fonts.get(PDFName.of('PCHelv')) && fonts.get(PDFName.of('F1')));
  const shared = doc.context.lookup(PDFRef.of(6, 0));
  assert.ok(!shared.lookup(PDFName.of('Font')).get(PDFName.of('PCHelv')), 'the shared dictionary is untouched');
  assert.deepEqual(marksPresent(doc), ['HeaderFooter']);
});

test('tests.rs header_and_footer_are_drawn_in_the_chosen_standard_face', async () => {
  const text = 'Wide words';
  for (const [font, resource, base] of [['Times', 'PCTimes', 'Times-Roman'], ['Courier', 'PCCour', 'Courier']]) {
    let doc = await fixture();
    addHeaderFooter(doc, [0], hf({text: text6(2, text), font}), false, DATE);
    doc = await reopen(doc);
    const mark = streams(doc, 0).at(-1);
    assert.ok(mark.includes(`/${resource} 8 Tf`), `${base}: ${mark}`);
    const x = 600 - 72 - familyWidth(font, text, 8);
    assert.ok(Math.abs(x - (600 - 72 - textWidth(text, 8))) > 1, `${base}: the faces differ in width`);
    assert.ok(mark.includes(`1 0 0 1 ${n(x)} `), `${base}: right-aligned by its own widths: ${mark}`);
    const face = pageFonts(doc, doc.getPages()[0]).lookup(PDFName.of(resource));
    assert.equal(face.get(PDFName.of('BaseFont')).decodeText(), base);
  }
  const doc = await fixture();
  addHeaderFooter(doc, [0], hf({text: text6(0, text)}), false, DATE);
  const mark = streams(await reopen(doc), 0).at(-1);
  assert.ok(mark.includes('/PCHelv 8 Tf') && !mark.includes('/PCTimes') && !mark.includes('/PCCour'), mark);
});

test('tests.rs a_header_never_takes_over_a_font_name_the_page_already_draws_with', async () => {
  let doc = await fixture();
  const page = doc.getPages()[0];
  page.node.set(PDFName.of('Resources'), doc.context.obj({Font: {PCTimes: {Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica-Bold'}}}));
  const settings = hf({text: text6(0, 'Serif'), font: 'Times'});
  const baseOf = (d, name) => pageFonts(d, d.getPages()[0]).lookup(PDFName.of(name))?.get(PDFName.of('BaseFont'))?.decodeText() ?? null;
  addHeaderFooter(doc, [0], settings, false, DATE);
  doc = await reopen(doc);
  assert.equal(baseOf(doc, 'PCTimes'), 'Helvetica-Bold', "the page's own font is untouched");
  assert.equal(baseOf(doc, 'PCTimes_1'), 'Times-Roman');
  assert.ok(streams(doc, 0).at(-1).includes('/PCTimes_1 8 Tf'));
  addHeaderFooter(doc, [0], settings, true, DATE);
  doc = await reopen(doc);
  assert.ok(streams(doc, 0).at(-1).includes('/PCTimes_1 8 Tf'));
  assert.equal(baseOf(doc, 'PCTimes_2'), null, 'no new name on update');
});

test('tests.rs header_start_number_that_would_wrap_is_refused_without_drawing', async () => {
  const doc = await fixture();
  const settings = hf({text: text6(2, '<<1>>'), startNumber: 4294967295});
  assert.throws(() => addHeaderFooter(doc, [0, 1], settings, false, DATE), /leaves no room/);
  assert.deepEqual(marksPresent(doc), []);
  addHeaderFooter(doc, [0], settings, false, DATE);
  assert.equal(marksPresent(doc).length, 1);
});

test('tests.rs header_bates_start_that_would_overflow_is_refused_without_drawing', async () => {
  const doc = await fixture();
  const settings = hf({text: text6(2, '<<Bates Number#6#18446744073709551615#A#B>>')});
  assert.throws(() => addHeaderFooter(doc, [0, 1], settings, false, DATE), /Bates/);
  assert.deepEqual(marksPresent(doc), []);
  addHeaderFooter(doc, [0], settings, false, DATE);
  assert.equal(marksPresent(doc).length, 1);
});

test('tests.rs replace_and_remove_restore_the_original_content', async () => {
  const doc = await fixture();
  const original = streams(doc, 0);
  addHeaderFooter(doc, [0], hf({text: text6(1, 'First')}), false, DATE);
  addHeaderFooter(doc, [0], hf({text: text6(1, 'Second')}), true, DATE);
  let s = streams(doc, 0);
  assert.equal(s.filter(x => x.includes('/PCMark')).length, 1, 'replaced, not added');
  assert.ok(s.at(-1).includes('(Second)'));
  addWatermark(doc, [0], {...defaultWatermark(), text: 'DRAFT'}, false);
  addBackground(doc, [0], {...defaultBackground(), color: [1, 1, 0.9], opacity: 1}, false);
  assert.equal(marksPresent(doc).length, 3);
  assert.equal(removeMarks(doc, [0], 'HeaderFooter'), 1);
  assert.equal(removeMarks(doc, [0], 'Watermark'), 1);
  s = streams(doc, 0);
  assert.ok(s[0].includes('/PCMark /Background'), 'the background stays behind');
  assert.equal(removeMarks(doc, [0], 'Background'), 1);
  assert.deepEqual(streams(await reopen(doc), 0), original, 'back to exactly the original content');
});

const firstCm = content => content.split('\n').find(l => l.endsWith(' cm')).split(/\s+/).slice(0, 6).map(Number);
const mapPoint = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const near = (a, b) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
const shrinking = (header, footer) => hf({shrink: true, text: text6(5, footer, text6(1, header))});

test('tests.rs shrink_scales_the_original_content_into_the_band_between_header_and_footer', async () => {
  let doc = await fixture();
  addHeaderFooter(doc, [0], shrinking('ACME', '<<Bates Number#6#1##>>'), false, DATE);
  doc = await reopen(doc);
  const s = streams(doc, 0);
  assert.equal(s.length, 5, JSON.stringify(s));
  assert.deepEqual([s[0], s[3]], ['q %Arkemis\n', '\nQ %Arkemis\n']);
  assert.ok(s[2].includes('(Hi) Tj'));
  const m = firstCm(s[1]);
  const k = (800 - 48 - 46.4) / 800;
  assert.ok(Math.abs(m[0] - k) < 1e-3 && Math.abs(m[3] - k) < 1e-3 && m[1] === 0 && m[2] === 0, `uniform scale ${k}: ${m}`);
  assert.ok(near(mapPoint(m, 0, 0), [(600 - 600 * k) / 2, 46.4]), String(m));
  assert.ok(near(mapPoint(m, 600, 800), [(600 + 600 * k) / 2, 800 - 48]), String(m));
  assert.ok(s[4].includes('(000001) Tj'), s[4]);
});

test('tests.rs shrink_is_undone_by_remove_and_not_doubled_by_update', async () => {
  const doc = await fixture();
  const original = streams(doc, 0);
  addBackground(doc, [0], defaultBackground(), false);
  addHeaderFooter(doc, [0], shrinking('First', ''), false, DATE);
  addHeaderFooter(doc, [0], shrinking('Second', ''), true, DATE);
  let s = streams(doc, 0);
  assert.equal(s.filter(x => x.includes(' cm') && !x.includes('/PCMark')).length, 2, JSON.stringify(s));
  assert.ok(s[0].includes('/PCMark /Background'));
  addHeaderFooter(doc, [0], {...shrinking('Third', ''), shrink: false}, true, DATE);
  assert.equal(streams(doc, 0).length, 5, JSON.stringify(streams(doc, 0)));
  addHeaderFooter(doc, [0], shrinking('Fourth', ''), true, DATE);
  assert.equal(removeMarks(doc, [0], 'HeaderFooter'), 2, 'the header and its shrink');
  assert.equal(removeMarks(doc, [0], 'Background'), 1);
  s = streams(await reopen(doc), 0);
  assert.deepEqual(s, original);
});

test('tests.rs shrink_with_no_room_left_is_refused_without_drawing', async () => {
  let doc = await fixture();
  const settings = {...shrinking('Top', 'Bottom'), margins: [400, 400, 72, 72]};
  assert.throws(() => addHeaderFooter(doc, [0, 1], settings, false, DATE), /no room/);
  assert.deepEqual(marksPresent(doc), []);
  doc = await fixture();
  addHeaderFooter(doc, [2], shrinking('Top', ''), false, DATE);
  assert.equal(streams(doc, 2).length, 1);
});

test('tests.rs watermarks_rotate_fade_and_can_go_behind', async () => {
  const doc = await fixture();
  addWatermark(doc, [0], {...defaultWatermark(), text: 'CONFIDENTIAL\nDo not copy', opacity: 0.3, rotation: 45, behind: true}, false);
  const s = streams(doc, 0);
  assert.ok(s[0].includes('/PCMark /Watermark'), 'behind: first');
  assert.ok(s[0].includes('/PCGS30 gs') && s[0].includes('0.707 0.707 -0.707 0.707 300 400 cm'), s[0]);
  assert.ok(s[0].includes('(CONFIDENTIAL) Tj') && s[0].includes('(Do not copy) Tj'));
  assert.equal(s.length, 2, 'no wrapper needed for content behind');
});

test('tests.rs a_second_background_is_drawn_over_the_first', async () => {
  const doc = await fixture();
  addBackground(doc, [0], {...defaultBackground(), color: [0, 0, 1], opacity: 1}, false);
  addBackground(doc, [0], {...defaultBackground(), color: [0, 1, 0], opacity: 1}, false);
  const s = streams(doc, 0);
  assert.equal(s.length, 3);
  assert.ok(s[0].includes('0 0 1 rg') && s[1].includes('0 1 0 rg'));
  assert.ok(s[2].includes('(Hi) Tj'));
});

test('tests.rs backgrounds_stay_below_watermarks_behind_the_content', async () => {
  const doc = await fixture();
  addBackground(doc, [0], {...defaultBackground(), color: [0, 0, 1], opacity: 1}, false);
  addWatermark(doc, [0], {...defaultWatermark(), text: 'DRAFT', behind: true}, false);
  addBackground(doc, [0], {...defaultBackground(), color: [0, 1, 0], opacity: 1}, false);
  const s = streams(doc, 0);
  assert.equal(s.length, 4);
  assert.ok(s[0].includes('0 0 1 rg') && s[1].includes('0 1 0 rg'));
  assert.ok(s[2].includes('/PCMark /Watermark') && s[3].includes('(Hi) Tj'));
});

test('tests.rs a_watermark_behind_goes_under_one_on_top_of_a_page_without_content', async () => {
  const doc = await fixture();
  addWatermark(doc, [2], {...defaultWatermark(), text: 'TOP'}, false);
  addWatermark(doc, [2], {...defaultWatermark(), text: 'BEHIND', behind: true}, false);
  const s = streams(doc, 2);
  assert.equal(s.length, 2);
  assert.ok(s[0].includes('(BEHIND) Tj') && s[1].includes('(TOP) Tj'));
});

test('tests.rs watermark_offset_moves_the_centre_right_and_up', async () => {
  const doc = await fixture();
  addWatermark(doc, [0], {...defaultWatermark(), text: 'DRAFT', rotation: 0, offset: [-100, 50]}, false);
  const mark = streams(doc, 0).find(c => c.includes('/PCMark /Watermark'));
  assert.ok(mark.includes('1 0 0 1 200 450 cm'), mark);
});

test('tests.rs a_watermark_offset_that_is_not_finite_is_refused', async () => {
  for (const offset of [[NaN, 0], [0, Infinity], [-Infinity, 0]]) {
    const doc = await fixture();
    assert.throws(() => addWatermark(doc, [0], {...defaultWatermark(), text: 'DRAFT', offset}, false), /invalid watermark settings/);
    assert.deepEqual(marksPresent(doc), []);
  }
});

test('tests.rs invalid_requests_change_nothing', async () => {
  const doc = await fixture();
  assert.throws(() => addHeaderFooter(doc, [0], defaultHeaderFooter(), false, DATE), /type the header or footer text first/);
  assert.throws(() => addWatermark(doc, [0], defaultWatermark(), false), /type the watermark text first/);
  assert.throws(() => addHeaderFooter(doc, [7], hf({text: text6(0, 'x')}), false, DATE), /page 8 does not exist/);
  assert.throws(() => addHeaderFooter(doc, [0], hf({text: text6(0, 'Ω')}), false, DATE), /standard fonts can't draw "Ω"/);
  assert.deepEqual(marksPresent(doc), []);
});

test('tests.rs new_marks_do_not_accumulate_wrappers_for_self_contained_marks', async () => {
  const doc = await fixture();
  addHeaderFooter(doc, [0], hf({text: text6(0, 'One')}), false, DATE);
  addWatermark(doc, [0], {...defaultWatermark(), text: 'Two'}, false);
  const s = streams(doc, 0);
  assert.equal(s.filter(x => x === 'q %Arkemis\n').length, 1, JSON.stringify(s));
});

test('wrapper markers: written as %Arkemis, and files saved earlier with %PdfCraft (and the oldest close marker) are still recognised and unwrapped', async () => {
  const {WRAP_OPEN, WRAP_CLOSE, LEGACY_WRAP_OPEN, LEGACY_WRAP_CLOSE, OLD_WRAP_CLOSE, isWrapClose, isWrapOpen} = await import('../../../core/folio/lib/edit-place.mjs');
  assert.deepEqual([WRAP_OPEN, WRAP_CLOSE], ['q %Arkemis\n', '\nQ %Arkemis\n']);
  assert.ok(isWrapOpen(LEGACY_WRAP_OPEN) && isWrapOpen(WRAP_OPEN) && !isWrapOpen('q\n'));
  assert.ok(isWrapClose(WRAP_CLOSE) && isWrapClose(LEGACY_WRAP_CLOSE) && isWrapClose(OLD_WRAP_CLOSE) && !isWrapClose('\nQ %Other\n'));
  assert.ok(isWrapClose('\nEMC' + LEGACY_WRAP_CLOSE) && isWrapClose('\nQ' + WRAP_CLOSE));
  for (const [open, close] of [[LEGACY_WRAP_OPEN, LEGACY_WRAP_CLOSE], [LEGACY_WRAP_OPEN, OLD_WRAP_CLOSE]]) {
    const doc = await fixture();
    const original = streams(doc, 0);
    addHeaderFooter(doc, [0], hf({text: text6(1, 'Header')}), false, DATE);
    const saved = await reopen(doc);
    // The file as an earlier version saved it: the markers carry the old name.
    const ctx = saved.context;
    const refs = saved.getPages()[0].node.get(PDFName.of('Contents')).asArray().map(o => (o instanceof PDFRef ? o : null));
    const mk = text => ctx.stream(text, {PCMark: PDFName.of('Wrap')});
    ctx.assign(refs[0], mk(open));
    ctx.assign(refs[2], mk(close));
    const legacy = await reopen(saved);
    assert.deepEqual([streams(legacy, 0)[0], streams(legacy, 0)[2]], [open, close]);
    assert.equal(removeMarks(legacy, [0], 'HeaderFooter'), 1, 'the header of a file saved earlier is found');
    assert.deepEqual(streams(await reopen(legacy), 0), original, 'and its wrapper goes with it');
  }
});
