// Ported from printcraft crates/render/src/text/tests.rs at 3109bb2359759e24ef490e1cdbdba00722b20972
// (MIT, see assets/third-party-licenses/artcraft-reference.txt): page extraction with writing
// directions (device.rs extract_page_filtered, layout.rs flows), translated in
// core/folio/model/extract.mjs and core/folio/model/text.mjs (layoutPage, toUpright, columnText).
// Upstream builds the pages with lopdf and reads them with hayro; here pdf-lib writes the same
// content streams and pdf.js's operator list is read (the renderer paints from the same operators).
// Each test names the Rust test it ports.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName} from 'pdf-lib';
import {extractPageText} from '../../../core/folio/model/extract.mjs';
import {toUpright, fromUpright, PageText} from '../../../core/folio/model/text.mjs';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const open = [];
after(async () => { for (const d of open) await d.destroy(); });

/** tests.rs `text_page`: a 400 × 400 page with /F1 Helvetica and /F2 Courier drawing `ops`. */
async function textPage(ops, {rotate = 0, crop = null} = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const helvetica = doc.context.register(doc.context.obj({Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica'}));
  const courier = doc.context.register(doc.context.obj({Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier'}));
  page.node.set(PDFName.of('Resources'), doc.context.obj({Font: {F1: helvetica, F2: courier}}));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(ops)));
  if (rotate) page.node.set(PDFName.of('Rotate'), doc.context.obj(rotate));
  if (crop) page.node.set(PDFName.of('CropBox'), doc.context.obj(crop));
  const task = pdfjs.getDocument({data: await doc.save(), verbosity: 0, useSystemFonts: false, isEvalSupported: false});
  open.push(task);
  const loaded = await task.promise;
  return loaded.getPage(1);
}
const pageText = async (ops, opts) => (await extractPageText(pdfjs, await textPage(ops, opts))).plainText();

/** tests.rs `turned`: `body` in /F`font` at `size` with its baseline turned `degrees` counter-clockwise. */
function turned(degrees, font, size, x, y, body) {
  const a = degrees * Math.PI / 180, s = Math.sin(a), c = Math.cos(a);
  return `BT /F${font} ${size} Tf ${c.toFixed(6)} ${s.toFixed(6)} ${(-s).toFixed(6)} ${c.toFixed(6)} ${x.toFixed(4)} ${y.toFixed(4)} Tm ${body} ET\n`;
}

test('upright_mapping_round_trips', () => {
  const r = [10, 20, 30, 25];
  for (let q = 0; q < 4; q++) assert.deepEqual(fromUpright(toUpright(r, q, 300, 200), q, 300, 200), r, `quarter ${q}`);
  assert.deepEqual(toUpright([290, 0, 300, 10], 1, 300, 200), [0, 0, 10, 10]);
});

test('turned_lines_group_along_their_baseline', async () => {
  for (const degrees of [12, 30, 37, 45, 60, 135, 200, 300, -45]) {
    const a = degrees * Math.PI / 180, s = Math.sin(a), c = Math.cos(a);
    const second = turned(degrees, 1, 12, 200 + s * 13, 200 - c * 13, '[(Second) -400 (line) -400 (here)] TJ');
    const first = turned(degrees, 1, 12, 200, 200, '[(First) -400 (line) -400 (text)] TJ');
    assert.equal(await pageText(second + first), 'First line text\nSecond line here', `${degrees}°`);
  }
});

test('crossing_turned_lines_stay_apart', async () => {
  const up = 'Upward words here', down = 'Downward words now';
  const a = 30 * Math.PI / 180, s = Math.sin(a), c = Math.cos(a);
  let ops = '';
  for (let k = 0; k < Math.min(up.length, down.length); k++) {
    const along = 7.2 * k;
    ops += turned(30, 2, 12, 100 + c * along, 150 + s * along, `(${up[k]}) Tj`);
    ops += turned(-30, 2, 12, 100 + c * along, 250 - s * along, `(${down[k]}) Tj`);
  }
  ops += turned(-30, 2, 12, 100 + c * 7.2 * 17, 250 - s * 7.2 * 17, '(w) Tj');
  assert.equal(await pageText(ops), 'Downward words now\nUpward words here');
});

test('text_along_a_curve_is_one_line', async () => {
  const arc = (text, from, clockwise, radius) => {
    const step = (7.2 / radius) * 180 / Math.PI * (clockwise ? -1 : 1);
    let ops = '';
    [...text].forEach((ch, k) => {
      const a = from + step * k, r = a * Math.PI / 180;
      ops += turned(clockwise ? a - 90 : a + 90, 2, 12, 200 + radius * Math.cos(r), 200 + radius * Math.sin(r), `(${ch}) Tj`);
    });
    return ops;
  };
  assert.equal(await pageText(arc('CURVED STAMP TEXT', 150, true, 90)), 'CURVED STAMP TEXT');
  assert.equal(await pageText(arc('BOTTOM ARC WORDS', 220, false, 90)), 'BOTTOM ARC WORDS');
  assert.equal(await pageText(arc('ROUND SEAL OF THE COMPANY LIMITED', 180, true, 50)), 'ROUND SEAL OF THE COMPANY LIMITED');
});

test('sheared_text_keeps_its_word_gaps', async () => {
  const ops = 'BT /F1 12 Tf 1 0.6 0 1 100 200 Tm [(Sheared) -400 (first)] TJ 1 0.6 0 1 100 187 Tm [(Sheared) -400 (second)] TJ ET';
  assert.equal(await pageText(ops), 'Sheared first\nSheared second');
});

test('turned_text_keeps_its_place_in_the_reading_order', async () => {
  const ops = 'BT /F1 14 Tf 1 0 0 1 50 360 Tm (Heading above) Tj ET\n' + turned(30, 1, 12, 80, 250, '(Turned label) Tj')
    + 'BT /F1 12 Tf 1 0 0 1 50 150 Tm (Caption below) Tj ET\n';
  assert.equal(await pageText(ops), 'Heading above\nTurned label\nCaption below');
});

test('turned_glyphs_keep_their_shape_and_direction', async () => {
  const text = await extractPageText(pdfjs, await textPage(turned(30, 1, 20, 100, 100, '(Ab) Tj') + 'BT /F1 20 Tf 1 0 0.5 1 100 300 Tm (Ab) Tj ET'));
  assert.equal(text.plainText(), 'Ab\nAb');
  for (const g of text.glyphs) {
    assert.ok([...g.quad.flat(), ...g.direction, ...g.rect].every(Number.isFinite));
    const xs = g.quad.map(p => p[0]), ys = g.quad.map(p => p[1]);
    assert.deepEqual(g.rect, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], 'the box bounds the quad');
    const x = g.quad[1][0] - g.quad[0][0], y = g.quad[1][1] - g.quad[0][1];
    assert.ok(Math.abs(x * g.direction[1] - y * g.direction[0]) < 1e-3 && x * g.direction[0] + y * g.direction[1] > 0, 'quad[0] → quad[1] runs along the direction');
  }
  const skewed = text.glyphs[0], turnedGlyph = text.glyphs[2];
  assert.ok(Math.abs(turnedGlyph.direction[0] - Math.cos(Math.PI / 6)) < 1e-6 && Math.abs(turnedGlyph.direction[1] + 0.5) < 1e-6);
  assert.deepEqual(skewed.direction, [1, 0]);
  assert.ok(Math.abs(skewed.quad[3][0] - skewed.quad[0][0] - 10) < 1e-3, 'the skewed glyph leans by half its 20 pt height');
});

test('vertical_lines_keep_reading_order (column_text)', () => {
  const cell = (t, x, y) => ({text: t, rect: [x, y, x + 10, y + 10], quad: [[x, y], [x, y + 10], [x + 10, y + 10], [x + 10, y]], direction: [0, 1]});
  const t = new PageText([cell('日', 40, 10), cell('本', 40, 20), cell('語', 20, 10), cell('文', 20, 20)], [0, 0, 1, 1], [false, false, false, false]);
  assert.equal(t.columnText(t.glyphsIn([0, 0, 60, 40])), '日本\n語文');
});

test('text_outside_the_crop_box_is_clipped (glyphs only; /ActualText spans are not read from pdf.js operator lists)', async () => {
  const ops = 'BT /F1 12 Tf 1 0 0 1 100 200 Tm (Inside crop) Tj ET\nBT /F1 12 Tf 1 0 0 1 -100 125 Tm (OutSpan) Tj ET\n';
  assert.equal(await pageText(ops), 'Inside crop');
});

test('a page turned by /Rotate reads its lines in order (quarter-turn flow)', async () => {
  const ops = 'BT /F1 12 Tf 1 0 0 1 72 300 Tm (First line) Tj ET\nBT /F1 12 Tf 1 0 0 1 72 282 Tm (Second line) Tj ET\n';
  for (const rotate of [90, 180, 270]) assert.equal(await pageText(ops, {rotate}), 'First line\nSecond line', `${rotate}°`);
});
