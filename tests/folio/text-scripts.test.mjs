// model/text.mjs: superscripts and subscripts stay in the line they belong to (printcraft 8f16855, crates/render/src/text/order.rs
// is_script_on and Seg::extend_box, layout.rs; its test paragraph_selection_includes_lines_with_footnote_references).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft 0.16.0 (issue #2929): a footnote reference on a line stays in that line, whether it is drawn inline or in a later pass
//    after the body text, instead of splitting out as a raised segment that pushes the host line after the paragraph; a bracketed
//    reference [12] and a subscript do too; a wide justified gap after an inline superscript stays on the line; a line that begins
//    with a raised marker and continues in taller text takes the body text's band. Acrobat selects such lines whole.
// 2. Ours runs the same page content through the page view's own text extraction (pdf.js operators) and the ported layout.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, StandardFonts} from 'pdf-lib';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {schema1Content} from '../../core/folio/fixtures.mjs';
import {pageText, releaseTextSources} from '../../core/folio/model/page-text.mjs';

after(() => releaseTextSources());

/** The text of a page (400 pt tall) drawn by the given content operators in Helvetica as /F1. */
async function glyphs(ops) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(ops)));
  page.node.set(PDFName.of('Resources'), doc.context.obj({Font: {F1: font.ref}}));
  const content = await migrateContent(await schema1Content(await doc.save(), 'scripts.pdf'));
  return pageText(content, content.pages[0]);
}
const lines = t => t.lineRects(0, t.glyphs.length).length;

test('a footnote reference stays in its line, inline or drawn in a later pass; the footnote below stays apart (#2929)', async () => {
  for (const inline of [true, false]) {
    const ops = inline
      ? 'BT /F1 12 Tf 1 0 0 1 40 300 Tm (First line of the paragraph) Tj 1 0 0 1 40 285 Tm (Second line with a note) Tj /F1 8 Tf 5.5 Ts (1) Tj 0 Ts /F1 12 Tf ( and more text) Tj 1 0 0 1 40 270 Tm (Third line of the paragraph) Tj /F1 7 Tf 1 0 0 1 40 104 Tm (1) Tj /F1 10 Tf 1 0 0 1 47 100 Tm (Footnote at the bottom) Tj ET'
      : 'BT /F1 12 Tf 1 0 0 1 40 300 Tm (First line of the paragraph) Tj 1 0 0 1 40 285 Tm (Second line with a note) Tj 1 0 0 1 173 285 Tm (and more text) Tj 1 0 0 1 40 270 Tm (Third line of the paragraph) Tj /F1 10 Tf 1 0 0 1 47 100 Tm (Footnote at the bottom) Tj /F1 8 Tf 1 0 0 1 165 290.5 Tm (1) Tj /F1 7 Tf 1 0 0 1 40 104 Tm (1) Tj ET';
    const t = await glyphs(ops);
    assert.equal(t.plainText(), 'First line of the paragraph\nSecond line with a note1 and more text\nThird line of the paragraph\n1 Footnote at the bottom', `inline=${inline}`);
    const first = t.nearest(40, 95), last = t.nearest(185, 128);
    void first; void last;
    assert.equal(lines(t), 4, `four lines in all, inline=${inline}`);
  }
});

test('a superscript, a bracketed reference [12] and a subscript each stay in their lines, inline or out of order', async () => {
  for (const inline of [true, false]) {
    const ops = inline
      ? 'BT /F1 12 Tf 1 0 0 1 40 300 Tm (Opening claim) Tj /F1 8 Tf 5.5 Ts (1) Tj 0 Ts /F1 12 Tf ( in the first line) Tj 1 0 0 1 40 285 Tm (Middle citation) Tj /F1 8 Tf 5.5 Ts ([12]) Tj 0 Ts /F1 12 Tf ( continues here) Tj 1 0 0 1 40 270 Tm (Formula H) Tj /F1 8 Tf -3 Ts (2) Tj 0 Ts /F1 12 Tf (O in the third line) Tj ET'
      : 'BT /F1 12 Tf 1 0 0 1 40 300 Tm (Opening claim) Tj 1 0 0 1 125 300 Tm (in the first line) Tj 1 0 0 1 40 285 Tm (Middle citation) Tj 1 0 0 1 135 285 Tm (continues here) Tj 1 0 0 1 40 270 Tm (Formula H) Tj 1 0 0 1 101 270 Tm (O in the third line) Tj /F1 8 Tf 1 0 0 1 117 305.5 Tm (1) Tj 1 0 0 1 117 290.5 Tm ([12]) Tj 1 0 0 1 96.5 267 Tm (2) Tj ET';
    const t = await glyphs(ops);
    assert.equal(t.plainText(), 'Opening claim1 in the first line\nMiddle citation[12] continues here\nFormula H2O in the third line', `inline=${inline}`);
    assert.equal(lines(t), 3, `inline=${inline}`);
  }
});

test('a wide justified gap after an inline superscript stays on the line, and a superscript kerned over punctuation does not break the host word', async () => {
  const t = await glyphs('BT /F1 12 Tf 1 0 0 1 40 300 Tm (Justified clause.) Tj /F1 8 Tf 5.5 Ts (1) Tj 0 Ts /F1 12 Tf 1 0 0 1 151 300 Tm (Next sentence on the same line) Tj 1 0 0 1 40 285 Tm (Kerned clause.) Tj 1 0 0 1 130 285 Tm (continues cleanly) Tj /F1 8 Tf 1 0 0 1 118 290.5 Tm (2) Tj ET');
  assert.equal(t.plainText(), 'Justified clause.1 Next sentence on the same line\nKerned clause.2 continues cleanly');
  assert.equal(lines(t), 2);
});

test('a line that begins with a raised marker and continues in taller text takes the body text\'s band', async () => {
  const t = await glyphs('BT /F1 8 Tf 1 0 0 1 40 300 Tm 6 Ts (1) Tj 0 Ts /F1 12 Tf ( See the appendix) Tj 1 0 0 1 146 300 Tm (for details) Tj /F1 8 Tf 1 0 0 1 139 303.6 Tm (2) Tj ET');
  assert.equal(t.plainText(), '1 See the appendix2 for details');
  assert.equal(lines(t), 1);
  const marker = t.glyphs[0].rect;
  const body = t.glyphs.find(g => g.text === 'S').rect;
  assert.ok(marker[1] < body[1] && marker[3] < body[3], 'the marker is raised above the body');
});
