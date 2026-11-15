// Watermark and Header & Footer text in any script an installed font has: the marks go through the same shaped Unicode path as added text (lib/unicode-text.mjs, via
// lib/edit-marks.mjs markUnicode), with the font names made free on each page; Latin text keeps the standard faces; a character no font has is refused with nothing written.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFDict} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import {unicodeFor} from '../../core/folio/lib/unicode-text.mjs';

after(() => releaseTextSources());
const U = (...cps) => String.fromCodePoint(...cps);
const TEXTS = {
  Cyrillic: U(0x41F, 0x440, 0x438, 0x432, 0x435, 0x442),
  Arabic: U(0x645, 0x631, 0x62D, 0x628, 0x627),
  CJK: U(0x4F60, 0x597D, 0x4E16, 0x754C),
};
const probe = await (async () => { try { return await unicodeFor(await PDFDocument.create(), Object.values(TEXTS)); } catch { return null; } })();
const skip = probe && Object.values(TEXTS).every(t => probe.canDraw(t)) ? false : 'no system fonts for these scripts here';
const open = () => createTestSession('folio', {fixture: 'textPages'});
const N = s => PDFName.of(s);

const textOf = async (bytes, page = 1) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({data: new Uint8Array(bytes), verbosity: 0});
  const out = (await (await (await task.promise).getPage(page)).getTextContent()).items.map(i => i.str).join('');
  await task.destroy();
  return out;
};
const letters = s => [...s].filter(c => !/\s/.test(c));
const fontNames = async bytes => {
  const doc = await PDFDocument.load(bytes);
  const fonts = doc.getPage(0).node.Resources().lookup(N('Font'), PDFDict);
  return fonts.keys().map(k => k.decodeText());
};

for (const [script, text] of Object.entries(TEXTS)) {
  test(`${script}: a watermark is drawn with the embedded font, reads back, and keeps the page's own fonts`, {skip}, async () => {
    const t = await open();
    const before = await fontNames(await writeFolioPdf(t.content));
    await t.exec('edit.watermark', {text, fontSize: 40, rotation: 0, opacity: 1, color: [0.2, 0.2, 0.2]});
    const bytes = await writeFolioPdf(t.content);
    const out = await textOf(bytes);
    for (const ch of letters(text)) assert.ok(out.includes(ch), `${script} watermark in the page text: ${out}`);
    assert.equal(out.includes('?'), false);
    const names = await fontNames(bytes);
    for (const own of before) assert.ok(names.includes(own), `${own} is kept`);
    assert.ok(names.some(k => /^PCM\d+$/.test(k)), 'an embedded font was added to the page');
    // The watermark can be replaced by another.
    await t.exec('edit.watermark', {text: `${text} ${text}`, fontSize: 30, rotation: 0, replace: true});
    assert.equal((await textOf(await writeFolioPdf(t.content))).includes('?'), false);
  });

  test(`${script}: a header and footer with page numbers are drawn with the embedded font and read back`, {skip}, async () => {
    const t = await open();
    await t.exec('edit.header_footer', {text: [`${text} <<1>>`, text, '', `${text}`, '<<Page 1 of n>>', text], fontSize: 12});
    const out = await textOf(await writeFolioPdf(t.content));
    for (const ch of letters(text)) assert.ok(out.includes(ch), `${script} header in the page text: ${out}`);
    assert.equal(out.includes('?'), false);
    assert.ok(out.includes('1'), 'the page number is drawn beside it');
    assert.ok(/Page 1 of \d/.test(out), 'a Latin box on the same page keeps its tokens');
  });
}

test('a header and a watermark in different scripts on one page use separate font names', {skip}, async () => {
  const t = await open();
  await t.exec('edit.header_footer', {text: [TEXTS.Cyrillic, '', '', '', '', ''], fontSize: 12});
  await t.exec('edit.watermark', {text: TEXTS.CJK, fontSize: 40, rotation: 0, opacity: 1});
  const bytes = await writeFolioPdf(t.content);
  const out = await textOf(bytes);
  for (const text of [TEXTS.Cyrillic, TEXTS.CJK]) for (const ch of letters(text)) assert.ok(out.includes(ch), `${text} in ${out}`);
  assert.equal(out.includes('?'), false);
  const names = (await fontNames(bytes)).filter(k => /^PCM\d+$/.test(k));
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.length >= 2, 'one font for each script');
});

test('Latin marks keep the standard faces; a character no font has is refused with nothing written', async () => {
  const t = await open();
  const base = t.content.sourceBase64;
  await t.exec('edit.watermark', {text: 'DRAFT'});
  assert.equal((await fontNames(await writeFolioPdf(t.content))).some(k => /^PCM/.test(k)), false);
  const before = t.content.sourceBase64;
  await assert.rejects(() => t.exec('edit.header_footer', {text: [`x ${U(0x10FFFD)}`, '', '', '', '', '']}), /standard fonts can't draw/);
  await assert.rejects(() => t.exec('edit.watermark', {text: `x ${U(0x10FFFD)}`, replace: true}), /standard fonts can't draw/);
  assert.equal(t.content.sourceBase64, before);
  assert.notEqual(base, undefined);
});
