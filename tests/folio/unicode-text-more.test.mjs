// The last of the person's own text, in any script an installed font has: a line's caption, a measurement's label and a redaction's overlay text are drawn with the shared Unicode
// helper (core/folio/lib/unicode-text.mjs) where the standard faces lack the characters, shaped and in reading order; Latin text keeps Helvetica. A character no font has is still
// refused for the overlay text (nothing is redacted).
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFDict, PDFStream, decodePDFRawStream} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import {unicodeFor} from '../../core/folio/lib/unicode-text.mjs';
import {withUnicode, lineLayout, lineCaption, CAPTION_SIZE} from '../../core/folio/model/appearance.mjs';

after(() => releaseTextSources());
const N = s => PDFName.of(s);
const U = (...cps) => String.fromCodePoint(...cps);
const TEXTS = {
  Cyrillic: U(0x41F, 0x440, 0x438, 0x432, 0x435, 0x442),
  Devanagari: U(0x928, 0x92E, 0x938, 0x94D, 0x924, 0x947),
  CJK: U(0x4F60, 0x597D, 0x4E16, 0x754C),
  Arabic: U(0x645, 0x631, 0x62D, 0x628, 0x627),
  Hebrew: U(0x5E9, 0x5DC, 0x5D5, 0x5DD),
  Thai: U(0xE2A, 0xE27, 0xE31, 0xE2A, 0xE14, 0xE35),
};
const probe = await (async () => { try { return await unicodeFor(await PDFDocument.create(), Object.values(TEXTS)); } catch { return null; } })();
const skip = probe && Object.values(TEXTS).every(t => probe.canDraw(t)) ? false : 'no system fonts for these scripts here';

const textOf = async (bytes, page = 1) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({data: new Uint8Array(bytes), verbosity: 0});
  const out = (await (await (await task.promise).getPage(page)).getTextContent()).items.map(i => i.str).join('');
  await task.destroy();
  return out;
};
const hasLetters = (out, text) => [...text].filter(c => !/\s/.test(c)).every(ch => out.includes(ch));
const apOf = async (t, subtype) => {
  const doc = await PDFDocument.load(await writeFolioPdf(t.content));
  const annot = doc.getPage(0).node.lookup(N('Annots')).asArray().map(r => doc.context.lookup(r)).find(a => a instanceof PDFDict && a.get(N('Subtype'))?.decodeText() === subtype);
  const ap = annot.lookup(N('AP'), PDFDict).lookup(N('N'));
  assert.ok(ap instanceof PDFStream);
  return {annot, ap, content: new TextDecoder('latin1').decode(decodePDFRawStream(ap).decode()), doc};
};
const embeddedFonts = ({ap}) => {
  const fonts = ap.dict.lookup(N('Resources'), PDFDict).lookup(N('Font'), PDFDict);
  return [...fonts.entries()].filter(([k]) => /^PCU/.test(k.decodeText()));
};

for (const [script, text] of Object.entries(TEXTS)) {
  test(`${script}: a line's caption is drawn with the embedded font, centred on its real width, with no "?"`, {skip}, async () => {
    const t = await createTestSession('folio', {fixture: 'textPages'});
    await t.exec('comment.line', {page: 'p1', points: [[100, 400], [300, 400]]});
    const rec = t.content.pages[0].annots.find(r => r.dict.Subtype === '/Line');
    rec.dict.Cap = true;
    rec.dict.Contents = {$t: text};
    const {content, ap, doc} = await apOf(t, 'Line');
    assert.match(content, /\/PCU\d+ [\d.]+ Tf [<[]/, 'the caption uses an embedded font');
    assert.equal(/\(\?+\)/.test(content), false);
    assert.equal(/\/Helv\b/.test(content), false, 'no Helvetica for the caption');
    const font = doc.context.lookup(embeddedFonts({ap})[0][1]);
    assert.equal(font.get(N('Subtype')).decodeText(), 'Type0');
    assert.ok(font.has(N('ToUnicode')));
    // The layout centres the caption on the width of the glyphs that are drawn.
    const uni = await unicodeFor(await PDFDocument.create(), [text]);
    const layout = withUnicode(uni, () => lineLayout(rec.dict, [[100, 400], [300, 400]], 1));
    const size = CAPTION_SIZE;
    assert.ok(layout.caption, 'a caption');
    const width = uni.width(lineCaption(rec.dict), size);
    const [, m] = layout.caption;
    assert.ok(Math.abs(m[4] - (200 - width / 2)) < 1e-6, `centred on the drawn width: starts at ${m[4]}, width ${width}`);
  });
}

test('a Latin caption keeps Helvetica', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  await t.exec('comment.line', {page: 'p1', points: [[100, 400], [300, 400]]});
  const rec = t.content.pages[0].annots.find(r => r.dict.Subtype === '/Line');
  rec.dict.Cap = true;
  rec.dict.Contents = {$t: 'Plain caption'};
  const {content} = await apOf(t, 'Line');
  assert.match(content, /\/Helv 9 Tf|\/Helv [\d.]+ Tf/);
  assert.equal(/\/PCU/.test(content), false);
});

for (const [script, unit] of [['Cyrillic', TEXTS.Cyrillic], ['Devanagari', TEXTS.Devanagari], ['Arabic', TEXTS.Arabic]]) {
  test(`${script}: a measurement label with a unit in the person's own words is drawn with the embedded font`, {skip}, async () => {
    const t = await createTestSession('folio', {fixture: 'drawing'});
    await t.exec('measure.options', {pageDistance: 1, pageUnit: 'in', realDistance: 1, unit});
    await t.exec('measure.scale', {});
    const m = (await t.exec('measure.distance', {page: 'p1', points: [[20, 700], [92, 700]]})).result;
    assert.ok(m.label.includes(unit), m.label);
    const rec = t.content.pages[0].annots.find(r => r.dict.Subtype === '/Line');
    delete rec.dict.Cap;   // the label under the line, not the caption above it
    const {content, ap} = await apOf(t, 'Line');
    assert.match(content, /\/PCU\d+ [\d.]+ Tf [<[]/, 'the label uses an embedded font');
    assert.equal(/\(\?+\)/.test(content), false);
    assert.ok(embeddedFonts({ap}).length >= 1);
  });
}

for (const [script, text] of Object.entries(TEXTS)) {
  test(`${script}: a redaction's overlay text is drawn in its box with the embedded font and reads back; the text under the mark is gone`, {skip}, async () => {
    const t = await createTestSession('folio', {fixture: 'textPages'});
    await t.exec('redact.properties', {useOverlay: true, overlay: text, fill: [0.9, 0.9, 0.9], align: 1});
    await t.exec('redact.pages', {from: 1, to: 1});
    const applied = await t.exec('redact.apply', {});
    assert.equal(applied.result.verified, true);
    const bytes = await writeFolioPdf(t.content);
    const out = await textOf(bytes, 1);
    assert.ok(hasLetters(out, text), `${script} overlay on the page: ${out}`);
    assert.equal(out.includes('?'), false);
    assert.equal(out.includes('quick'), false, 'the text that was under the mark is gone');
    const doc = await PDFDocument.load(bytes);
    const fonts = [...doc.context.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFDict && o.get(N('Subtype'))?.decodeText?.() === 'Type0');
    assert.ok(fonts.length >= 1, 'a Type 0 font holds the overlay glyphs');
  });
}

test('an overlay text made of characters no installed font has is refused when applying, with nothing redacted; the properties accept any text', {skip}, async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  const before = t.content.sourceBase64;
  await t.exec('redact.properties', {useOverlay: true, overlay: `x ${U(0x10FFFD)}`});
  await t.exec('redact.pages', {from: 1, to: 1});
  await assert.rejects(() => t.exec('redact.apply', {}), /standard fonts can't draw/);
  assert.equal(t.content.sourceBase64, before, 'nothing was redacted');
  assert.equal((await textOf(await writeFolioPdf(t.content), 1)).includes('quick'), true);
});

test('a Latin overlay text is still drawn with Helvetica', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  await t.exec('redact.properties', {useOverlay: true, overlay: '(b)(6)', fill: [0, 0, 0]});
  await t.exec('redact.pages', {from: 1, to: 1});
  await t.exec('redact.apply', {});
  const doc = await PDFDocument.load(await writeFolioPdf(t.content));
  assert.equal([...doc.context.enumerateIndirectObjects()].some(([, o]) => o instanceof PDFDict && o.get(N('Subtype'))?.decodeText?.() === 'Type0'), false);
});
