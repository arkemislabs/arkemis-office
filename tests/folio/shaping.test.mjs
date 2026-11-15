// Shaping: Arabic, Hebrew, Thai and Devanagari text is set the way fontkit's OpenType layout (font.layout) places it, in reading order, not one glyph per character.
//
// Each text is run through the Unicode glue (core/folio/lib/unicode-text.mjs); the glyph codes in the content stream operators it writes are mapped back to the glyphs of the
// embedded font and compared with fontkit's own layout of the same string: the glyph ids, their order, the advances. The checks that a script is actually shaped: the Arabic
// letters have their joining forms (the glyphs are not the ones the cmap gives the letters alone), the right-to-left runs come out in visual order, a Devanagari conjunct is one
// glyph and the vowel sign i is drawn before its consonant, a Thai tone mark is lifted by a text rise. The bidirectional order of mixed text is checked on the runs.
// The tests that need fonts use the operating system's and skip where there are none (Segoe UI or Arial for Arabic and Hebrew, Nirmala UI for Devanagari, Leelawadee UI for Thai).
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFDict, PDFName, PDFStream, decodePDFRawStream} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {unicodeFor, textFace} from '../../core/folio/lib/unicode-text.mjs';
import {visualRuns} from '../../core/folio/lib/shape-text.mjs';
import {textPdf} from '../../core/folio/lib/create.mjs';

const N = s => PDFName.of(s);
const U = (...cps) => String.fromCodePoint(...cps);
const ARABIC = U(0x645, 0x631, 0x62D, 0x628, 0x627, 0x20, 0x628, 0x627, 0x644, 0x639, 0x627, 0x644, 0x645);   // marhaba bil-alam
const HEBREW = U(0x5E9, 0x5DC, 0x5D5, 0x5DD, 0x20, 0x5E2, 0x5D5, 0x5DC, 0x5DD);                               // shalom olam
const THAI = U(0xE2A, 0xE27, 0xE31, 0xE2A, 0xE14, 0xE35, 0xE04, 0xE23, 0xE31, 0xE1A, 0x20, 0xE17, 0xE35, 0xE48, 0xE19, 0xE35, 0xE48);
const DEVA = U(0x939, 0x93F, 0x928, 0x94D, 0x926, 0x940, 0x20, 0x915, 0x94D, 0x937, 0x924, 0x94D, 0x930, 0x93F, 0x92F);
const MIXED = `abc ${U(0x645, 0x631, 0x62D, 0x628, 0x627)} 123`;
const ALL = [ARABIC, HEBREW, THAI, DEVA, MIXED];

const probe = await (async () => { try { return await unicodeFor(await PDFDocument.create(), ALL); } catch { return null; } })();
const has = text => !!probe && probe.canDraw(text);
const skipFor = text => (has(text) ? false : 'no system font for this script here');

// ── the runs (no fonts) ───────────────────────────────────────────────────────────────────────

test('the bidirectional runs: left to right text stays in one run; right to left runs are marked; numbers and Latin words keep their direction inside right to left text', () => {
  assert.deepEqual(visualRuns('Hello, world').map(r => [r.text, r.rtl]), [['Hello, world', false]]);
  assert.deepEqual(visualRuns('').length, 0);
  // Latin first: the paragraph is left to right; the Hebrew run is the only right to left one.
  const a = visualRuns(`abc ${HEBREW}`);
  assert.deepEqual(a.map(r => r.rtl), [false, true]);
  assert.equal(a[0].text, 'abc ');
  assert.equal(a[1].text, HEBREW);
  // Hebrew first: the paragraph is right to left, so the Latin words and the number are drawn to the left of the Hebrew, in their own order.
  const b = visualRuns(`${U(0x5E9, 0x5DC, 0x5D5, 0x5DD)} hello 123`);
  assert.deepEqual(b.map(r => r.text), ['hello 123', `${U(0x5E9, 0x5DC, 0x5D5, 0x5DD)} `]);
  assert.deepEqual(b.map(r => r.rtl), [false, true]);
  // Digits inside Arabic text stay left to right, after the Arabic that precedes them.
  const c = visualRuns(`${U(0x645, 0x631, 0x62D, 0x628, 0x627)} 123`);
  assert.deepEqual(c.map(r => r.text.trim()), ['123', U(0x645, 0x631, 0x62D, 0x628, 0x627)]);
  // A bracket pair around right to left text is mirrored, and the pair still surrounds it.
  const d = visualRuns(`${U(0x5D0)}(${U(0x5D1)})`);
  assert.equal(d.length, 1);
  assert.equal(d[0].rtl, true);
  assert.equal(d[0].text, `${U(0x5D0)})${U(0x5D1)}(`, 'the logical order with each bracket replaced by its mirror: the layout then reverses the run to (' + U(0x5D1) + ')' + U(0x5D0));
  // Two scripts shaped differently are two runs even at one level.
  assert.equal(visualRuns(`${U(0x5D0, 0x20, 0x627)}`).length, 2);
});

// ── the glyphs ────────────────────────────────────────────────────────────────────────────────

/** The glyphs the content stream operators of a text draw, run by run, as the embedded font's own glyph ids (the subset's code mapped back through the embedder's table). */
function drawn(uni, text, size = 12) {
  const items = uni.plan(text);
  const byName = new Map(items.map(it => [it.name, it.pdfFont]));
  const ops = uni.ops(text, size);
  const runs = [];
  let at = -1;
  for (const m of ops.matchAll(/\/(PCU\d+) [\d.]+ Tf |<([0-9a-f]+)>/gi)) {
    if (m[1]) { runs.push({name: m[1], ids: [], font: byName.get(m[1])}); at++; } else for (let i = 0; i < m[2].length; i += 4) {
      const code = parseInt(m[2].slice(i, i + 4), 16);
      runs[at].ids.push(runs[at].font.embedder.glyphs[code - 1].id);
    }
  }
  return {items, ops, runs};
}

/** fontkit's own layout of one run. */
const layoutOf = item => item.pdfFont.embedder.font.layout(item.text);

for (const [name, text] of [['Arabic', ARABIC], ['Hebrew', HEBREW], ['Thai', THAI], ['Devanagari', DEVA], ['mixed Latin, Arabic and digits', MIXED]]) {
  test(`${name}: the glyphs written are fontkit's layout of the text: same ids in the same order, same advances`, {skip: skipFor(text)}, async () => {
    const uni = await unicodeFor(await PDFDocument.create(), [text]);
    const {items, runs} = drawn(uni, text);
    assert.equal(runs.length, items.length);
    items.forEach((item, k) => {
      const lay = layoutOf(item);
      assert.deepEqual(runs[k].ids, lay.glyphs.map(g => g.id), `glyph ids of "${item.text}"`);
      assert.equal(item.glyphs.length, lay.glyphs.length);
      lay.glyphs.forEach((g, i) => {
        assert.ok(Math.abs(item.glyphs[i].adv - lay.positions[i].xAdvance * 1000 / item.pdfFont.embedder.font.unitsPerEm) < 1e-9, `advance of glyph ${i} of "${item.text}"`);
      });
    });
    const size = 14;
    const expected = items.reduce((w, item) => w + layoutOf(item).positions.reduce((s, p) => s + p.xAdvance, 0) * size / item.pdfFont.embedder.font.unitsPerEm, 0);
    assert.ok(Math.abs(uni.width(text, size) - expected) < 1e-6, 'the width is the sum of the layout advances');
  });
}

test('Arabic letters get their joining forms and the run is drawn right to left: the first glyph on the page is the last letter', {skip: skipFor(ARABIC)}, async () => {
  const word = U(0x645, 0x631, 0x62D, 0x628, 0x627);
  const uni = await unicodeFor(await PDFDocument.create(), [word]);
  const {items, runs} = drawn(uni, word);
  assert.equal(items.length, 1);
  const font = items[0].pdfFont.embedder.font;
  const lay = layoutOf(items[0]);
  assert.deepEqual(lay.glyphs[0].codePoints, [0x627], 'fontkit lays the run out right to left: the alef, the last letter, is the leftmost glyph');
  assert.deepEqual(runs[0].ids, lay.glyphs.map(g => g.id));
  const alone = [...word].map(c => font.glyphForCodePoint(c.codePointAt(0)).id).reverse();
  const joined = runs[0].ids.filter((id, i) => id !== alone[i]).length;
  assert.ok(joined >= 3, `the letters are drawn in their initial, medial and final forms, not as the isolated letters the cmap gives (${joined} of ${alone.length} differ)`);
});

test('Hebrew is drawn right to left: the first glyph on the page is the last letter', {skip: skipFor(HEBREW)}, async () => {
  const word = U(0x5E9, 0x5DC, 0x5D5, 0x5DD);
  const uni = await unicodeFor(await PDFDocument.create(), [word]);
  const {items, runs} = drawn(uni, word);
  const lay = layoutOf(items[0]);
  assert.deepEqual(lay.glyphs.map(g => g.codePoints[0]), [0x5DD, 0x5D5, 0x5DC, 0x5E9]);
  assert.deepEqual(runs[0].ids, lay.glyphs.map(g => g.id));
});

test('Devanagari conjuncts are single glyphs and the vowel sign i is drawn before its consonant', {skip: skipFor(DEVA)}, async () => {
  const uni = await unicodeFor(await PDFDocument.create(), [DEVA]);
  const conj = U(0x915, 0x94D, 0x937);
  const c = drawn(uni, conj);
  assert.equal(c.runs[0].ids.length, 1, 'ka + virama + ssa is one glyph (the conjunct)');
  assert.deepEqual(layoutOf(c.items[0]).glyphs[0].codePoints, [0x915, 0x94D, 0x937]);
  const ki = drawn(uni, U(0x915, 0x93F));
  const lay = layoutOf(ki.items[0]);
  assert.deepEqual(lay.glyphs.map(g => g.codePoints[0]), [0x93F, 0x915], 'the sign i comes first on the page');
  assert.deepEqual(ki.runs[0].ids, lay.glyphs.map(g => g.id));
  // Not one glyph per character.
  assert.ok(drawn(uni, DEVA).runs.reduce((n, r) => n + r.ids.length, 0) < [...DEVA].length);
});

test('Thai tone marks and vowels are placed by the font: zero advance, lifted by a text rise or moved by a TJ shift', {skip: skipFor(THAI)}, async () => {
  const uni = await unicodeFor(await PDFDocument.create(), [THAI]);
  const {items, ops} = drawn(uni, THAI, 16);
  const marks = items.flatMap(it => it.glyphs).filter(g => g.adv === 0);
  assert.ok(marks.length >= 3, 'the marks are glyphs of no advance');
  // Positioning comes from the font's OpenType tables (Windows' Leelawadee UI, Linux's Noto Sans Thai). macOS's Thai
  // fonts use Apple's own tables, which the engine doesn't apply: there a mark keeps the design's own placement.
  if (!marks.some(g => g.yo !== 0) && process.platform === 'darwin') return;
  assert.ok(marks.some(g => g.yo !== 0), 'a mark sits above its consonant');
  assert.match(ops, / Ts\b/, 'raised with a text rise');
  assert.match(ops, /\] TJ/, 'moved with a TJ shift');
  assert.match(ops, /(^|\s)0 Ts/m, 'the rise is put back');
});

test('mixed text is set in reading order: the Latin word, then the digits, then the Arabic run (right to left paragraph reading order of a left to right paragraph)', {skip: skipFor(MIXED)}, async () => {
  const uni = await unicodeFor(await PDFDocument.create(), [MIXED]);
  const items = uni.plan(MIXED);
  const texts = items.map(i => i.text);
  assert.ok(texts[0].startsWith('abc'));
  assert.equal(texts.includes('123'), true);
  assert.ok(texts.indexOf('123') < texts.findIndex(t => /[؀-ۿ]/.test(t)), 'digits are drawn to the left of the Arabic that precedes them in the text');
  assert.equal(items.find(i => /[؀-ۿ]/.test(i.text)).rtl, true);
});

// ── in documents ──────────────────────────────────────────────────────────────────────────────

const textOf = async (bytes, page = 1) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({data: new Uint8Array(bytes), verbosity: 0});
  const d = await task.promise;
  const out = (await (await d.getPage(page)).getTextContent()).items.map(x => x.str).join('');
  await task.destroy();
  return out;
};
const letters = s => [...s].filter(c => !/\s/.test(c));
const hasLetters = (out, text) => letters(text).every(ch => out.includes(ch));

for (const [name, text] of [['Arabic', ARABIC], ['Hebrew', HEBREW], ['Thai', THAI]]) {
  test(`${name}: added text is accepted, written with the shaped glyphs, and reads back with no "?"`, {skip: skipFor(text)}, async () => {
    const t = await createTestSession('folio', {fixture: 'textPages'});
    const r = (await t.exec('edit.text', {page: 1, rect: [100, 300, 360, 340], text, size: 14})).result;
    assert.equal(r.item.kind, 'text');
    assert.equal((await t.exec('edit.added', {page: 1})).result.items[0].text, text);
    const out = await textOf(Buffer.from(t.content.sourceBase64, 'base64'));
    assert.ok(hasLetters(out, text), `the text layer has ${name}: ${out}`);
    assert.equal(out.includes('?'), false);
    // It can be changed: the glyphs are made again.
    await t.exec('edit.added_change', {page: 1, change: 'text', text: `${text} ${text}`});
    assert.equal((await t.exec('edit.added', {page: 1})).result.items[0].text, `${text} ${text}`);
    t.undo?.();
  });

  test(`${name}: a free text comment is drawn with the shaped glyphs`, {skip: skipFor(text)}, async () => {
    const t = await createTestSession('folio', {fixture: 'textPages'});
    await t.exec('comment.freetext', {page: 'p1', rect: [100, 500, 220, 60], text});
    const bytes = await writeFolioPdf(t.content);
    const doc = await PDFDocument.load(bytes);
    const annot = doc.getPage(0).node.lookup(N('Annots')).asArray().map(r => doc.context.lookup(r)).find(a => a instanceof PDFDict && a.get(N('Subtype'))?.decodeText() === 'FreeText');
    assert.equal(annot.lookup(N('Contents')).decodeText(), text);
    const ap = annot.lookup(N('AP'), PDFDict).lookup(N('N'));
    assert.ok(ap instanceof PDFStream);
    const content = new TextDecoder('latin1').decode(decodePDFRawStream(ap).decode());
    assert.match(content, /\/PCU\d+ [\d.]+ Tf [<[]/);
    assert.equal(/\(\?+\)/.test(content), false);
  });
}

test('a text file in Arabic, Hebrew and Thai becomes a PDF that reads back as typed', {skip: skipFor(ARABIC) || skipFor(HEBREW) || skipFor(THAI)}, async () => {
  const bytes = await textPdf(`${ARABIC}\n${HEBREW}\n${THAI}`);
  const out = await textOf(bytes);
  for (const text of [ARABIC, HEBREW, THAI]) assert.ok(hasLetters(out, text), `${text} in ${out}`);
  assert.equal(out.includes('?'), false);
});

test('textFace draws shaped text through pdf-lib operators and measures it with the layout advances', {skip: skipFor(ARABIC)}, async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const face = await textFace(doc, await doc.embedFont('Helvetica'), [ARABIC]);
  assert.equal(face.unicode, true);
  face.draw(page, ARABIC, {x: 20, y: 100, size: 16});
  const uni = await unicodeFor(doc, [ARABIC]);
  assert.ok(Math.abs(face.width(ARABIC, 16) - uni.width(ARABIC, 16)) < 1e-9);
  const bytes = await doc.save();
  assert.ok(hasLetters(await textOf(bytes), ARABIC));
});

test('a form field filled in Arabic, Hebrew or Thai shows it shaped in an embedded font', {skip: skipFor(ARABIC) || skipFor(HEBREW) || skipFor(THAI)}, async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  doc.getForm().createTextField('name').addToPage(page, {x: 20, y: 100, width: 200, height: 24});
  const base = await doc.save();
  const {createPdfContent} = await import('../../core/pdf-document.mjs');
  const {migrateContent} = await import('../../core/folio/migrate.mjs');
  for (const text of [ARABIC.split(' ')[0], HEBREW.split(' ')[0], THAI.split(' ')[0]]) {
    const t = await createTestSession('folio', {content: await migrateContent(await createPdfContent(base, 'form.pdf'))});
    await t.exec('form.value', {name: 'name', value: text}).catch(async () => t.exec('form.fill', {name: 'name', value: text}));
    const filled = await PDFDocument.load(Buffer.from(t.content.sourceBase64, 'base64'));
    const widget = filled.getPage(0).node.lookup(N('Annots')).asArray().map(r => filled.context.lookup(r))[0];
    const ap = widget.lookup(N('AP'), PDFDict).lookup(N('N'));
    const content = new TextDecoder('latin1').decode(decodePDFRawStream(ap).decode());
    assert.match(content, /\/PCU\d+ [\d.]+ Tf [<[]/, text);
    assert.equal(/\(\?+\)/.test(content), false);
  }
});
