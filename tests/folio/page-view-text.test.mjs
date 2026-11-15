// The page view draws a comment's text in any script as the saved file does. The view paints the appearance the writer saves (model/appearance.mjs `build`) on a canvas; the saved
// file draws Cyrillic, Devanagari, Arabic, Chinese... with a system font embedded at write time, and the standard faces would show "?" on the canvas. The view's text set
// (core/folio/lib/browser-text.mjs) writes the same appearance with a pseudo font that the painter (lib/content-paint.mjs) draws with fillText: the browser's own fonts, its own
// shaping and bidirectional ordering, the direction of the paragraph. The same text as the saved file, line by line and in total; Latin text keeps Helvetica.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {recordAppearance, paintForm} from '../../core/folio/lib/content-paint.mjs';
import {browserText, browserCss, decodeUtf16, directionOf, BROWSER_FAMILY} from '../../core/folio/lib/browser-text.mjs';
import {createAnnotation} from '../../core/folio/model/annots.mjs';
import {defaultStyle} from '../../core/folio/model/types.mjs';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';

const U = (...cps) => String.fromCodePoint(...cps);
const TEXTS = {
  Cyrillic: U(0x41F, 0x440, 0x438, 0x432, 0x435, 0x442, 0x20, 0x43C, 0x438, 0x440),
  Devanagari: U(0x928, 0x92E, 0x938, 0x94D, 0x924, 0x947),
  CJK: U(0x4F60, 0x597D, 0x4E16, 0x754C),
  Arabic: U(0x645, 0x631, 0x62D, 0x628, 0x627),
  Hebrew: U(0x5E9, 0x5DC, 0x5D5, 0x5DD),
  Thai: U(0xE2A, 0xE27, 0xE31, 0xE2A, 0xE14, 0xE35),
};

/** A Canvas 2D stand-in: records every fillText with the font, direction and alignment it was drawn with, and measures one em per character. */
function recorder() {
  const calls = [];
  const ctx = {calls, lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', strokeStyle: '', font: '', direction: 'ltr', textAlign: 'start', lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
    lineDashOffset: 0, getTransform: () => ({a: 2, b: 0}), measureText: s => ({width: [...s].length * 6})};
  for (const m of ['save', 'restore', 'transform', 'translate', 'scale', 'beginPath', 'moveTo', 'lineTo', 'bezierCurveTo', 'closePath', 'rect', 'clip', 'setLineDash', 'strokeText', 'setTransform']) ctx[m] = (...a) => calls.push([m, ...a]);
  ctx.fillText = (s, x, y) => calls.push(['fillText', s, x, y, ctx.font, ctx.direction, ctx.textAlign]);
  ctx.fill = () => {};
  ctx.stroke = () => {};
  return ctx;
}
const measure = (text, size) => [...text].length * size * 0.5;
const set = () => browserText(measure);
const textBox = (contents, rect = [100, 100, 400, 160]) => createAnnotation({shape: {kind: 'TextBox', rect, fontSize: 12}, style: defaultStyle({kind: 'TextBox'}), contents}, {id: 't1'});
const drawn = (rec, text) => { const ap = recordAppearance(rec, text); const ctx = recorder(); paintForm(ctx, ap.form, ap.rect); return {ap, ctx, texts: ctx.calls.filter(c => c[0] === 'fillText')}; };

test('the view text set writes UTF-16 for a pseudo font, measures with the browser, and keeps the style', () => {
  const t = set();
  assert.equal(t.canDraw('x'), true);
  assert.equal(t.canDraw(''), false);
  assert.equal(t.width('abcd', 10), 20);
  assert.equal(t.width('a\tb', 10), 15, 'control characters are a space');
  const ops = t.ops('A\u{1F600}', 12);
  assert.equal(ops, '/PCBr 12 Tf <0041d83dde00> Tj\n');
  assert.equal(t.ops('x', 10, {bold: true}), '/PCBrB 10 Tf <0078> Tj\n');
  assert.deepEqual(t.fonts().map(f => f.name), ['PCBr', 'PCBrB']);
  assert.deepEqual(t.fonts()[1].ref.PCBrowser, {bold: true, italic: false});
  assert.equal(decodeUtf16(String.fromCharCode(0, 0x41, 0xd8, 0x3d, 0xde, 0)), 'A\u{1F600}');
  assert.equal(browserCss({bold: true, italic: true}, 14), `italic bold 14px ${BROWSER_FAMILY}`);
  assert.equal(directionOf('abc'), 'ltr');
  assert.equal(directionOf(TEXTS.Arabic), 'rtl');
  assert.equal(directionOf(`123 ${TEXTS.Hebrew}`), 'rtl', 'the first strong letter decides, not a digit');
  assert.equal(directionOf(`abc ${TEXTS.Hebrew}`), 'ltr');
});

for (const [script, text] of Object.entries(TEXTS)) {
  test(`${script}: a text box on screen draws the typed text with the browser's fonts, with no "?"`, () => {
    const rec = textBox(text);
    const before = drawn(rec, null);
    assert.ok(before.texts.some(c => c[1].includes('?')), 'the standard faces show a question mark');
    const view = drawn(rec, set());
    assert.equal(view.texts.some(c => c[1].includes('?')), false);
    assert.equal(view.texts.map(c => c[1]).join('').replace(/\s/g, ''), text.replace(/\s/g, ''), 'the whole text is drawn');
    for (const c of view.texts) {
      assert.ok(c[4].includes(BROWSER_FAMILY), 'the browser family');
      assert.equal(c[5], directionOf(c[1]), 'the paragraph direction');
      assert.equal(c[6], 'left', 'x is the left edge in either direction');
    }
    assert.equal(/\/Helv\b/.test(view.ap.form.content) && view.ap.form.content.includes('PCBr'), true, 'Helvetica stays the default font of the form; the text is in the pseudo font');
  });

  test(`${script}: screen and saved file hold the same text`, async () => {
    const t = await createTestSession('folio', {fixture: 'textPages'});
    await t.exec('comment.freetext', {page: 'p1', rect: [100, 500, 220, 60], text});
    const rec = t.content.pages[0].annots.find(r => r.dict.Subtype === '/FreeText');
    const screen = drawn(rec, set()).texts.map(c => c[1]).join('').replace(/\s/g, '');
    const bytes = await writeFolioPdf(t.content);
    const doc = await PDFDocument.load(bytes);
    assert.equal(doc.getPage(0).node.Annots().size() >= 1, true);
    const {PDFName, PDFDict, decodePDFRawStream, PDFStream} = await import('pdf-lib');
    const annot = doc.getPage(0).node.lookup(PDFName.of('Annots')).asArray().map(r => doc.context.lookup(r)).find(a => a instanceof PDFDict && a.get(PDFName.of('Subtype'))?.decodeText() === 'FreeText');
    assert.equal(annot.lookup(PDFName.of('Contents')).decodeText(), text, 'the file keeps the contents');
    const ap = annot.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'));
    assert.ok(ap instanceof PDFStream);
    assert.equal(screen, text.replace(/\s/g, ''), 'the screen draws the contents the file keeps');
  });
}

test('a Latin text box on screen still draws with Helvetica and no pseudo font', () => {
  const view = drawn(textBox('Hello'), set());
  assert.ok(view.texts.some(c => c[1] === 'Hello' && /Helvetica/.test(c[4])));
  assert.equal(view.ap.form.content.includes('PCBr'), false);
});

test("a line's caption and a measurement's label are drawn on screen with the browser's fonts", () => {
  const line = createAnnotation({shape: {kind: 'Line', from: [100, 400], to: [300, 400], start: 'None', end: 'None'}, style: defaultStyle({kind: 'Line'})}, {id: 'l1'});
  line.dict.Cap = true;
  line.dict.Contents = {$t: TEXTS.Cyrillic};
  const cap = drawn(line, set());
  assert.equal(cap.texts.map(c => c[1]).join(''), TEXTS.Cyrillic);
  const measured = createAnnotation({shape: {kind: 'Line', from: [100, 400], to: [300, 400], start: 'None', end: 'None'}, style: defaultStyle({kind: 'Line'})}, {id: 'l2'});
  measured.dict.Measure = {Type: '/Measure'};
  measured.dict.PCMeasureValue = {$t: `2.00 ${TEXTS.Devanagari}`};
  const label = drawn(measured, set());
  assert.equal(label.texts.map(c => c[1]).join(''), `2.00 ${TEXTS.Devanagari}`);
  assert.equal(label.texts.some(c => c[1].includes('?')), false);
});

test('the caption is centred on the width the browser measures', () => {
  const line = createAnnotation({shape: {kind: 'Line', from: [100, 400], to: [300, 400], start: 'None', end: 'None'}, style: defaultStyle({kind: 'Line'})}, {id: 'l3'});
  line.dict.Cap = true;
  line.dict.Contents = {$t: TEXTS.CJK};
  const text = browserText((s, size) => [...s].length * size * 1.0);   // one em a character
  const ap = recordAppearance(line, text);
  const width = TEXTS.CJK.length * 10;
  const m = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) Tm/.exec(ap.form.content);
  assert.ok(m, 'a caption is set');
  assert.ok(Math.abs(Number(m[5]) - (200 - width / 2)) < 1e-6, `starts at ${m[5]}`);
});
