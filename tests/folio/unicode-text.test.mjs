// The person's own text in Cyrillic, Devanagari and Chinese/Japanese: added text, free text comments, a text file made into a PDF, the comment summary, a form field and the OCR
// layer are drawn with a system font embedded through core/common/lib/pdf-fonts.mjs (core/folio/lib/unicode-text.mjs), not written as "?".
//
// Behaviour fidelity (docs/behaviour-fidelity.md): printcraft 0.16.0 draws text with the standard faces and refuses what they lack ("only Western European characters can be added as
// text for now", crates/fonts first_undrawable); Acrobat writes any script with an embedded font. Here the standard faces are kept for text they can draw (a Western document is
// written as before) and the shared Unicode helper takes the rest. Text is shaped by fontkit's OpenType layout and set in reading order (tests/folio/shaping.test.mjs).
// The tests need the operating system's fonts for these scripts and skip where there are none.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFDict, PDFStream, decodePDFRawStream, StandardFonts} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {unicodeFor, needsUnicode, needsShaping, wrapLines} from '../../core/folio/lib/unicode-text.mjs';
import {textPdf} from '../../core/folio/lib/create.mjs';
import {summaryPdf} from '../../core/folio/lib/comment-pdf.mjs';
import {addOcrTextLayer} from '../../core/pdf-ocr.mjs';

const TEXTS = {Cyrillic: 'Привет, мир', Devanagari: 'नमस्ते दुनिया', CJK: '你好世界 こんにちは'};
const N = s => PDFName.of(s);

const probe = await (async () => { try { return await unicodeFor(await PDFDocument.create(), Object.values(TEXTS)); } catch { return null; } })();
const haveFonts = !!probe && Object.values(TEXTS).every(t => probe.canDraw(t));
const skip = haveFonts ? false : 'no system fonts for Cyrillic, Devanagari and CJK here';

const textOf = async (bytes, page = 1) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({data: new Uint8Array(bytes), verbosity: 0});
  const d = await task.promise;
  const out = (await (await d.getPage(page)).getTextContent()).items.map(x => x.str).join('');
  await task.destroy();
  return out;
};
// Every letter of the text is in what the page reads back (a reader may order Devanagari vowel signs by where they are drawn, so the order is not compared).
const has = (out, text) => [...text.split(String.fromCharCode(32)).join('').split(String.fromCharCode(10)).join('')].every(ch => out.includes(ch));
const source = t => Buffer.from(t.content.sourceBase64, 'base64');

test('what needs the Unicode path and what stays on the standard faces', () => {
  assert.equal(needsUnicode('Café, naïve, “quotes”'), false, 'Western European text is drawn by the standard faces as before');
  for (const t of Object.values(TEXTS)) assert.equal(needsUnicode(t), true, t);
  for (const t of ['مرحبا', 'שלום', 'สวัสดี']) assert.equal(needsShaping(t), true, 'Arabic, Hebrew and Thai need shaping');
  for (const t of Object.values(TEXTS)) assert.equal(needsShaping(t), false, t);
  const measure = s => s.length * 10;
  assert.deepEqual(wrapLines('你好世界你好世界', 40, measure), ['你好世界', '你好世界'], 'text with no spaces breaks between characters');
  assert.deepEqual(wrapLines('ab cd\n\nef', 100, measure), ['ab cd', '', 'ef']);
});

for (const [script, text] of Object.entries(TEXTS)) {
  test(`${script}: added text is embedded with a system font and reads back as typed, with no "?"`, {skip}, async () => {
    const t = await createTestSession('folio', {fixture: 'textPages'});
    const r = (await t.exec('edit.text', {page: 1, rect: [100, 300, 360, 340], text, size: 14})).result;
    assert.equal(r.item.kind, 'text');
    const [item] = (await t.exec('edit.added', {page: 1})).result.items;
    assert.equal(item.text, text);
    const pdf = await textOf(source(t));
    assert.ok(has(pdf, text), `the text layer has ${text}: ${pdf}`);
    assert.equal(pdf.includes('?'), false, 'no question mark');
    const doc = await PDFDocument.load(source(t));
    const fonts = [...doc.context.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFDict && o.get(N('Type'))?.decodeText?.() === 'Font' && o.get(N('Subtype'))?.decodeText?.() === 'Type0');
    assert.ok(fonts.length >= 1, 'a Type 0 font is embedded');
    // The item can be retyped and moved: the font is made again each time.
    await t.exec('edit.added_change', {page: 1, change: 'text', text: `${text} ${text}`});
    await t.exec('edit.added_change', {page: 1, change: 'move', offset: [10, 10]});
    assert.equal((await t.exec('edit.added', {page: 1})).result.items[0].text, `${text} ${text}`);
    assert.equal((await textOf(source(t))).includes('?'), false);
  });

  test(`${script}: a free text comment and its note are drawn with the embedded font, the comment's own text is kept, and the saved file has no "?"`, {skip}, async () => {
    const t = await createTestSession('folio', {fixture: 'textPages'});
    await t.exec('comment.freetext', {page: 'p1', rect: [100, 500, 220, 60], text});
    await t.exec('comment.note', {page: 'p1', at: [300, 300], text});
    const bytes = await writeFolioPdf(t.content);
    const doc = await PDFDocument.load(bytes);
    const annots = doc.getPage(0).node.lookup(N('Annots')).asArray().map(r => doc.context.lookup(r)).filter(a => a instanceof PDFDict);
    const free = annots.find(a => a.get(N('Subtype'))?.decodeText() === 'FreeText');
    const note = annots.find(a => a.get(N('Subtype'))?.decodeText() === 'Text');
    assert.equal(free.lookup(N('Contents')).decodeText(), text, 'the contents are the person\'s own words');
    assert.equal(note.lookup(N('Contents')).decodeText(), text);
    const ap = free.lookup(N('AP'), PDFDict).lookup(N('N'));
    assert.ok(ap instanceof PDFStream);
    const content = new TextDecoder('latin1').decode(decodePDFRawStream(ap).decode());
    assert.match(content, /\/PCU\d+ [\d.]+ Tf [<[]/, 'drawn with an embedded font');
    assert.equal(/\(\?+\)/.test(content), false, 'no question marks drawn');
    const fonts = ap.dict.lookup(N('Resources'), PDFDict).lookup(N('Font'), PDFDict);
    const embedded = [...fonts.entries()].filter(([k]) => /^PCU/.test(k.decodeText()));
    assert.ok(embedded.length >= 1);
    const font = doc.context.lookup(embedded[0][1]);
    assert.equal(font.get(N('Subtype')).decodeText(), 'Type0');
    assert.ok(font.has(N('ToUnicode')), 'copying the text gives the text back');
  });
}

test('a text file in these scripts becomes a PDF that reads back as typed', {skip}, async () => {
  const text = `${TEXTS.Cyrillic}\n${TEXTS.Devanagari}\n${TEXTS.CJK}`;
  const bytes = await textPdf(text);
  const out = (await textOf(bytes)).replace(/\s+/g, '');
  for (const t of Object.values(TEXTS)) assert.ok(has(out, t), `${t} in ${out}`);
  assert.equal(out.includes('?'), false);
  const latin = await textPdf('Plain Latin text');
  assert.equal((await PDFDocument.load(latin)).context.enumerateIndirectObjects().some(([, o]) => o instanceof PDFDict && o.get(N('Subtype'))?.decodeText?.() === 'Type0'), false, 'Latin text keeps the standard font');
});

test('the comment summary prints comments in these scripts', {skip}, async () => {
  const bytes = await summaryPdf(`Page 1\n  ${TEXTS.Cyrillic}\n  ${TEXTS.CJK}\n  ${TEXTS.Devanagari}`, 'Summary');
  const out = (await textOf(bytes)).replace(/\s+/g, '');
  for (const t of Object.values(TEXTS)) assert.ok(has(out, t), `${t} in ${out}`);
  assert.equal(out.includes('?'), false);
});

test('a form field filled in Cyrillic or CJK shows it in an embedded font', {skip}, async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  doc.getForm().createTextField('name').addToPage(page, {x: 20, y: 100, width: 200, height: 24});
  const base = await doc.save();
  const {createPdfContent} = await import('../../core/pdf-document.mjs');
  const {migrateContent} = await import('../../core/folio/migrate.mjs');
  const t = await createTestSession('folio', {content: await migrateContent(await createPdfContent(base, 'form.pdf'))});
  await t.exec('form.value', {name: 'name', value: TEXTS.Cyrillic}).catch(async () => t.exec('form.fill', {name: 'name', value: TEXTS.Cyrillic}));
  const filled = await PDFDocument.load(source(t));
  const widget = filled.getPage(0).node.lookup(N('Annots')).asArray().map(r => filled.context.lookup(r))[0];
  const ap = widget.lookup(N('AP'), PDFDict).lookup(N('N'));
  const content = new TextDecoder('latin1').decode(decodePDFRawStream(ap).decode());
  assert.match(content, /\/PCU\d+ [\d.]+ Tf [<[]/);
  assert.equal(/\(\?+\)/.test(content), false);
});

test('the OCR text layer takes any script the recogniser reports', {skip}, async () => {
  const {createPdfContent} = await import('../../core/pdf-document.mjs');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 200]).drawText('x', {x: 10, y: 10, size: 8, font});
  const content = await createPdfContent(await doc.save(), 'scan.pdf');
  const word = {text: TEXTS.Cyrillic, x: 20, y: 20, width: 120, height: 14, confidence: 90};
  const next = await addOcrTextLayer(content, content.pages[0].id, {language: 'eng', geometry: 'page-points-top-left', width: content.pages[0].width, height: content.pages[0].height, text: word.text, words: [word], confidence: 90});
  const out = await textOf(Buffer.from(next.sourceBase64, 'base64'));
  assert.ok(out.includes('Привет'), out);
  assert.equal(out.includes('?'), false);
});
