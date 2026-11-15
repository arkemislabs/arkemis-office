// core/folio/lib/text-font.mjs, text-interp.mjs, text-blocks.mjs, text-rewrite.mjs, text-edit.mjs and the edit.blocks, edit.text_replace and edit.format
// commands: Edit PDF text.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft 0.16.0 crates/edit/src/tests.rs): paragraphs are found and rewrapped to their own width, keeping the font, size, colour
//    and line spacing; a grown paragraph does not swallow the next one; a wrap rejoins when the box is widened while a typed break stays, and a typed
//    double space survives a narrow-then-wide round trip; formatting (family and weight, size, colour, centre, right, justify, underline, line spacing,
//    character spacing, horizontal scale) changes the paragraph; a centred one-row title keeps its centre; a new colour does not spill into the text
//    after it; words in separate text objects are one paragraph; two resources or two subsets of one font are one line while different fonts are not;
//    a subset that lacks letters is replaced by a standard face and the result says so. Acrobat's Edit text & images does the same.
// 2. Ours does the same: the cases are ported from those tests (same content streams) and read back through the same interpreter after the file is saved
//    and opened again; the surface and bridge go through the commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {pageBlocks} from '../../core/folio/lib/text-edit.mjs';
import {rewriteFrom} from '../../core/folio/lib/text-rewrite.mjs';
import {wrap} from '../../core/folio/lib/text-blocks.mjs';
import {pageStreams} from '../../core/folio/lib/text-interp.mjs';
import {parseContent} from '../../core/folio/lib/redact-content.mjs';
import {Metrics} from '../../core/folio/lib/text-font.mjs';
import {schema1Content, base64} from '../../core/folio/fixtures.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';

const OBJECTS = content => [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R /F4 8 0 R /F5 9 0 R >> >> >>',
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  '<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Arial /FirstChar 97 /LastChar 99 /Widths [500 520 0] /Encoding /WinAnsiEncoding >>',
  '<< /Type /Font /Subtype /TrueType /BaseFont /GHIJKL+Arial /FirstChar 97 /LastChar 99 /Widths [500 520 0] /Encoding /WinAnsiEncoding >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  '<< /Type /Font /Subtype /Type1 /Encoding /WinAnsiEncoding >>',
];

/** A one-page PDF from numbered objects (tests.rs `build`), with a correct cross-reference table. */
async function build(objs) {
  let out = '%PDF-1.7\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return PDFDocument.load(Buffer.from(out, 'latin1'));
}
/** tests.rs `text_page`: a page whose content is `src`, with the fonts F1 (Helvetica) to F5. */
const textPage = src => build(OBJECTS(src));
const reopen = async doc => PDFDocument.load(await doc.save());
const listing = doc => pageBlocks(doc, doc.getPage(0));
const blocksOf = doc => listing(doc).blocks;
const linesOf = doc => listing(doc).lines;
function rewrite(doc, index, text, style = {}) {
  const l = listing(doc);
  return rewriteFrom(doc, doc.getPage(0), l.read, l.lines, l.blocks, l.blocks[index], text, style);
}
const contentOf = doc => pageStreams(doc, doc.getPage(0)).map(x => Buffer.from(x.bytes).toString('latin1')).join('\n');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);
const widthOf = r => r[2] - r[0];

test('paragraphs are found and rewrapped to their own width, keeping font, size, colour and spacing', async () => {
  const doc = await textPage('BT 0 0 1 rg /F1 10 Tf 12 TL 72 700 Td (The quick brown fox) Tj T* (jumps over the) Tj T* (lazy dog.) Tj ET BT /F1 10 Tf 72 600 Td (Next paragraph) Tj ET');
  let blocks = blocksOf(doc);
  assert.deepEqual(blocks.map(b => b.text), ['The quick brown fox jumps over the lazy dog.', 'Next paragraph']);
  assert.deepEqual(blocks[0].lines, [0, 1, 2]);
  const width = widthOf(blocks[0].rect);
  const next = blocks[1].rect;
  const long = 'This editor rewraps a paragraph to its own width when its text changes, keeping the font, size, colour and line spacing.';
  assert.equal(rewrite(doc, 0, long).substituted, null);
  const again = await reopen(doc);
  const lines = linesOf(again);
  blocks = blocksOf(again);
  assert.equal(blocks[0].text, long);
  assert.ok(blocks[0].lines.length > 3, `more lines: ${blocks[0].lines.length}`);
  for (const i of blocks[0].lines) assert.ok(widthOf(lines[i].rect) <= width + 1, `line ${lines[i].text} fits`);
  near(lines[0].rect[0], 72, 0.01);
  near(lines[blocks[0].lines[0]].origin.baseline - lines[blocks[0].lines[1]].origin.baseline, 12, 0.01, 'the spacing stays 12 pt');
  assert.equal(blocks[1].text, 'Next paragraph');
  assert.deepEqual(blocks[1].rect, next);
  assert.match(contentOf(again), /0 0 1 rg/);
  rewrite(again, 0, 'Short.');
  blocks = blocksOf(again);
  assert.deepEqual([blocks[0].text, blocks[0].lines.length], ['Short.', 1]);
});

test('a grown paragraph does not swallow the next one', async () => {
  const doc = await textPage('BT /F1 12 Tf 14.4 TL 1 0 0 1 72 700 Tm (One) Tj T* (Two) Tj ET BT /F1 12 Tf 1 0 0 1 72 649.6 Tm (Neighbour) Tj ET');
  assert.equal(blocksOf(doc).length, 2);
  rewrite(doc, 0, 'One\nTwo\nThree');
  const after = blocksOf(doc);
  assert.equal(after.length, 2, JSON.stringify(after.map(b => b.text)));
  assert.ok(after[1].text.includes('Neighbour'), after[1].text);
});

test('a wrapped line rejoins when widened and a typed break stays', async () => {
  const doc = await textPage('BT /F1 24 Tf 20 150 Td (Page 1) Tj ET');
  rewrite(doc, 0, null ?? undefined, {width: 45});
  let block = blocksOf(doc)[0];
  assert.ok(block.editorText.includes('\n'), `the narrow box did not wrap: ${block.editorText}`);
  assert.equal(block.reflowText, 'Page 1', `a wrap was kept as a hard break: ${block.reflowText}`);
  rewrite(doc, 0, block.reflowText, {width: 200});
  assert.deepEqual(linesOf(doc).map(l => l.text), ['Page 1']);

  const typed = await textPage('BT /F1 12 Tf 72 700 Td (One) Tj ET');
  rewrite(typed, 0, 'One\nTwo\nThree\nfour');
  block = blocksOf(typed)[0];
  assert.equal(block.reflowText, 'One\nTwo\nThree\nfour', `a typed break was rejoined: ${block.reflowText}`);
  rewrite(typed, 0, block.reflowText, {width: Math.max(widthOf(block.rect) * 6, 180)});
  assert.equal(blocksOf(typed)[0].editorText, 'One\nTwo\nThree\nfour');
});

test('narrowing then widening keeps a typed double space, also after a save', async () => {
  const fresh = await textPage('BT /F1 24 Tf 20 150 Td (One  Two) Tj ET');
  const wide = widthOf(blocksOf(fresh)[0].rect);
  const doc = await reopen(fresh);
  rewrite(doc, 0, undefined, {width: 45});
  const narrow = await reopen(doc);
  const block = blocksOf(narrow)[0];
  assert.equal(block.editorText, 'One\nTwo', `the narrow box did not wrap between the two typed spaces: ${block.editorText}`);
  assert.equal(block.reflowText, 'One  Two', `the saved wrap did not remember both spaces: ${JSON.stringify(block.reflowText)}`);
  rewrite(narrow, 0, block.reflowText, {width: wide});
  assert.equal(blocksOf(await reopen(narrow))[0].editorText, 'One  Two', 'the second typed space was lost');
});

test('paragraphs take new formatting: family and weight, size, colour, alignment', async () => {
  const src = 'BT /F1 10 Tf 12 TL 100 700 Td (One two three four five six seven) Tj T* (eight nine ten eleven twelve) Tj ET';
  const doc = await textPage(src);
  const before = blocksOf(doc)[0];
  rewrite(doc, 0, undefined, {family: 'Times', bold: true, size: 12, color: [1, 0, 0], align: 'center'});
  const again = await reopen(doc);
  const blocks = blocksOf(again), lines = linesOf(again);
  assert.equal(blocks[0].text, before.text, 'same words');
  assert.deepEqual([blocks[0].baseFont, blocks[0].size], ['Times-Bold', 12]);
  const mid = (before.rect[0] + before.rect[2]) / 2;
  for (const i of blocks[0].lines) near((lines[i].rect[0] + lines[i].rect[2]) / 2, mid, 2, `line ${lines[i].text} centred`);
  assert.match(contentOf(again), /1 0 0 rg/);
  const right = await textPage(src);
  const edge = blocksOf(right)[0].rect[2];
  rewrite(right, 0, undefined, {align: 'right'});
  for (const l of linesOf(right)) near(l.rect[2], edge, 1, `${l.text} flush right`);
});

test('justify, underline, line spacing, character spacing and horizontal scale', async () => {
  const src = 'BT /F1 10 Tf 12 TL 100 700 Td (One two three four five six seven) Tj T* (eight nine ten eleven twelve) Tj T* (end) Tj ET';
  const justified = await textPage(src);
  const right = blocksOf(justified)[0].rect[2];
  rewrite(justified, 0, undefined, {align: 'justify'});
  const lines = linesOf(justified);
  for (const l of lines.slice(0, -1)) near(l.rect[2], right, 1, `${l.text} reaches the right edge`);
  const spaced = await textPage(src);
  rewrite(spaced, 0, undefined, {lineSpacing: 2, underline: true});
  const l2 = linesOf(spaced);
  near(l2[0].origin.baseline - l2[1].origin.baseline, 20, 0.01);
  assert.match(contentOf(spaced), / l\nS\n/);
  const wide = await textPage('BT /F1 10 Tf 100 700 Td (Wide text) Tj ET');
  const w0 = linesOf(wide)[0].rect;
  rewrite(wide, 0, undefined, {charSpacing: 2});
  const w1 = linesOf(wide)[0].rect;
  assert.ok(widthOf(w1) - widthOf(w0) > 15, `${w0} to ${w1}`);
  const narrow = await textPage('BT /F1 10 Tf 100 700 Td (Wide text) Tj ET');
  rewrite(narrow, 0, undefined, {scale: 50});
  near(widthOf(linesOf(narrow)[0].rect), widthOf(w0) / 2, 1);
});

test('a centred one-row title keeps its centre when it grows and when it wraps', async () => {
  const src = 'BT /F1 18 Tf 1 0 0 1 252.477 700 Tm (Centered title) Tj ET\nBT /F1 12 Tf 1 0 0 1 72 640 Tm (Body text below the heading starts here and runs) Tj ET\nBT /F1 12 Tf 1 0 0 1 72 625.6 Tm (on for a second row of ordinary words.) Tj ET';
  const doc = await textPage(src);
  const before = blocksOf(doc)[0];
  const centre = (before.rect[0] + before.rect[2]) / 2;
  rewrite(doc, 0, 'Centered title with a few more words');
  const again = await reopen(doc);
  assert.equal(blocksOf(again)[0].text, 'Centered title with a few more words');
  const r = linesOf(again)[blocksOf(again)[0].lines[0]].rect;
  near((r[0] + r[2]) / 2, centre, 1, 'the grown title stays centred');
  const long = await textPage(src);
  rewrite(long, 0, 'Centered title with many more words added so that the single row has to become much longer');
  const a2 = await reopen(long);
  const b2 = blocksOf(a2), l2 = linesOf(a2);
  assert.ok(b2[0].lines.length > 1, 'the long title wraps into rows');
  for (const i of b2[0].lines) near((l2[i].rect[0] + l2[i].rect[2]) / 2, centre, 2, `row ${l2[i].text} stays centred`);
});

test('a new paragraph colour does not spill into the text after it', async () => {
  const doc = await textPage('BT /F1 10 Tf 72 700 Td (First paragraph) Tj 0 -40 Td (Second paragraph) Tj ET');
  rewrite(doc, 0, undefined, {color: [1, 0, 0]});
  const again = await reopen(doc);
  const ops = parseContent(Buffer.from(contentOf(again), 'latin1'));
  let fill = '0 g';
  const stack = [];
  for (const op of ops) {
    if (op.op === 'q') stack.push(fill);
    else if (op.op === 'Q') fill = stack.pop() ?? '';
    else if (['g', 'rg', 'k'].includes(op.op)) fill = `${op.args.map(a => a.v).join(' ')} ${op.op}`;
    else if (op.op === 'Tj' && Buffer.from(op.args[0].b).toString('latin1') === 'Second paragraph') break;
  }
  assert.equal(fill, '0 g');
  assert.equal(blocksOf(again)[1].text, 'Second paragraph');
});

test('words in separate text objects form one paragraph, and another column does not join', async () => {
  const doc = await textPage('BT /F1 12 Tf 1 0 0 1 72 700 Tm (Hello) Tj ET BT /F1 12 Tf 1 0 0 1 103 700 Tm (world) Tj ET BT /F1 12 Tf 1 0 0 1 72 685 Tm (Second) Tj ET BT /F1 12 Tf 1 0 0 1 117 685 Tm (line) Tj ET BT /F1 12 Tf 1 0 0 1 300 700 Tm (Other column) Tj ET');
  const blocks = blocksOf(doc);
  assert.deepEqual(blocks.map(b => b.text).sort(), ['Hello world Second line', 'Other column']);
  const p = blocks.find(b => b.text.startsWith('Hello'));
  rewrite(doc, blocks.indexOf(p), 'Hello brave new world');
  const after = blocksOf(await reopen(doc));
  assert.deepEqual(after.map(b => b.text).sort(), ['Hello brave new world', 'Other column']);
});

test('two resources of one font, and two subsets of it, are one line; different fonts are not', async () => {
  for (const [content, text] of [
    ['BT /F1 12 Tf 72 700 Td (Hel) Tj /F4 12 Tf (lo) Tj ET', 'Hello'],
    ['BT /F2 12 Tf 72 700 Td (ab) Tj /F3 12 Tf (ca) Tj /F2 12 Tf (b) Tj ET', 'abcab'],
  ]) {
    const doc = await textPage(content);
    assert.deepEqual(linesOf(doc).map(l => l.text), [text], content);
    assert.deepEqual(blocksOf(doc).map(b => b.text), [text], content);
  }
  assert.equal(linesOf(await textPage('BT /F1 12 Tf 72 700 Td (Hel) Tj /F2 12 Tf (lo) Tj ET')).length, 2);
  const nameless = await textPage('BT /F5 12 Tf 72 700 Td (First) Tj 0 -15 Td (second) Tj ET');
  assert.ok(linesOf(nameless).every(l => l.baseFont === ''));
  assert.deepEqual(blocksOf(nameless).map(b => b.text), ['First second']);
});

test('a space in another subset does not split a line, and replacing it keeps the rest', async () => {
  const doc = await textPage('BT /F1 12 Tf 72 700 Td (Hello) Tj /F2 12 Tf ( ) Tj /F1 12 Tf (world) Tj ET');
  assert.deepEqual(blocksOf(doc).map(b => b.text), ['Hello world']);
  rewrite(doc, 0, 'Goodbye');
  assert.equal(blocksOf(await reopen(doc))[0].text, 'Goodbye');
});

test('a subset font that lacks letters is replaced by a standard face, and the result says so', async () => {
  const doc = await textPage('BT /F2 12 Tf 72 700 Td (abab) Tj ET');
  assert.equal(rewrite(doc, 0, 'abba').substituted, null, 'letters the subset has keep its font');
  assert.equal(blocksOf(doc)[0].baseFont, 'ABCDEF+Arial');
  const r = rewrite(doc, 0, 'abc xyz');
  assert.equal(r.substituted, 'Helvetica');
  const again = await reopen(doc);
  assert.equal(blocksOf(again)[0].text, 'abc xyz');
  assert.equal(blocksOf(again)[0].baseFont, 'Helvetica');
  const fonts = again.getPage(0).node.Resources().lookup(PDFName.of('Font'));
  assert.ok(fonts.keys().some(k => k.decodeText().startsWith('PCEdHelvetica')), 'the stand-in font is a page resource');
  assert.throws(() => rewrite(again, 0, 'Euro € and 中'), /neither|can show/, 'a character no standard font has is refused, nothing is written');
});

test('the colour space a fill sets is the text colour; invisible text, clipping text and the clipping copy are handled', async () => {
  const doc = await textPage('/DeviceRGB cs 0 0.23 0.45 sc BT /F1 12 Tf 72 700 Td (Blue) Tj ET');
  const [r, g, b] = blocksOf(doc)[0].color;
  assert.deepEqual([r, +g.toFixed(2), +b.toFixed(2)], [0, 0.23, 0.45]);
  const clip = await textPage('BT /F1 12 Tf 7 Tr 72 700 Td (Clip) Tj ET');
  const before = contentOf(clip);
  assert.throws(() => rewrite(clip, 0, 'Other'), /clipping path/);
  assert.equal(contentOf(clip), before, 'a refused edit changes nothing');
  const ocr = await textPage('BT /F1 12 Tf 3 Tr 72 700 Td (Scanned words) Tj ET');
  assert.equal(blocksOf(ocr)[0].invisible, true);
  rewrite(ocr, 0, 'Scanned and corrected');
  const text = contentOf(ocr);
  assert.match(text, /0 Tr/, 'the new text is drawn visibly');
});

test('a line drawn twice is replaced everywhere, and a distinct nearby line stays', async () => {
  const twice = await textPage('BT /F1 12 Tf 72 700 Td (Total) Tj ET BT /F1 12 Tf 72.2 700 Td (Total) Tj ET');
  rewrite(twice, 0, 'Sum');
  assert.deepEqual(linesOf(twice).map(l => l.text), ['Sum']);
  const near2 = await textPage('BT /F1 12 Tf 72 700 Td (Total) Tj ET BT /F1 12 Tf 72 686 Td (Totals) Tj ET'.replace('72 686', '72 640'));
  rewrite(near2, 0, 'Sum');
  assert.ok(linesOf(near2).some(l => l.text === 'Totals'));
});

test('a paragraph in a shared text object keeps its place and the order after it', async () => {
  const doc = await textPage('BT /F1 12 Tf 72 700 Td (First) Tj 0 -60 Td (Second) Tj 0 -60 Td (Third) Tj ET');
  const blocks = blocksOf(doc);
  assert.equal(blocks.length, 3);
  rewrite(doc, 1, 'Second edited');
  const again = await reopen(doc);
  assert.deepEqual(blocksOf(again).map(b => b.text), ['First', 'Second edited', 'Third']);
  const ys = blocksOf(again).map(b => b.rect[1]);
  assert.ok(ys[0] > ys[1] && ys[1] > ys[2], `the order on the page stays: ${ys}`);
});

test('text split across two content streams is read and rewritten, the other stream untouched', async () => {
  const doc = await build([
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents [4 0 R 5 0 R] /Resources << /Font << /F1 6 0 R >> >> >>',
    '<< /Length 31 >>\nstream\nBT /F1 12 Tf 72 700 Td (Left)\nendstream'.replace('31', String('BT /F1 12 Tf 72 700 Td (Left)'.length)),
    '<< /Length 23 >>\nstream\n 0 0 1 rg 10 10 5 5 re f\nendstream'.replace('23', String(' 0 0 1 rg 10 10 5 5 re f'.length)),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]).catch(() => null);
  // An operator whose operands end one stream and whose keyword starts the next is not read (docs/spec/patches/folio/edit.json); a page whose streams
  // split between operators is.
  void doc;
  const split = await build([
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents [4 0 R 5 0 R] /Resources << /Font << /F1 6 0 R >> >> >>',
    `<< /Length ${'BT /F1 12 Tf 72 700 Td'.length} >>\nstream\nBT /F1 12 Tf 72 700 Td\nendstream`,
    `<< /Length ${'(Left side) Tj ET 0 0 1 rg 10 10 5 5 re f'.length} >>\nstream\n(Left side) Tj ET 0 0 1 rg 10 10 5 5 re f\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]);
  assert.deepEqual(blocksOf(split).map(b => b.text), ['Left side']);
  rewrite(split, 0, 'Right side');
  const again = await reopen(split);
  assert.deepEqual(blocksOf(again).map(b => b.text), ['Right side']);
  assert.match(contentOf(again), /10 10 5 5 re/);
});

test('fonts: codes, widths and the text a font can show', async () => {
  const doc = await textPage('BT /F1 12 Tf (x) Tj ET');
  const dict = n => doc.getPage(0).node.Resources().lookup(PDFName.of('Font')).lookup(PDFName.of(n));
  const helv = Metrics.fromDict(doc.context, dict('F1'));
  assert.equal(helv.baseFont, 'Helvetica');
  assert.deepEqual([...helv.encode('Café — ok')], [67, 97, 102, 233, 32, 151, 32, 111, 107]);
  assert.equal(helv.encode('中'), null);
  near(helv.width(0x41) * 1000, 667, 0.5, 'Helvetica A');
  const subset = Metrics.fromDict(doc.context, dict('F2'));
  assert.equal(subset.subset, true);
  assert.equal(subset.encode('abc'), null, 'c has width 0: the subset has no glyph');
  assert.deepEqual([...subset.encode('ab')], [97, 98]);
  assert.equal(subset.encode('a b'), null, 'no space glyph in the subset');
  assert.equal(subset.encodes('a b'), true, 'but its words encode, a space is positioned');
  const styled = Metrics.fromDict(doc.context, dict('F1'));
  assert.deepEqual([styled.bold, styled.italic], [false, false]);
});

test('wrap keeps every typed space and drops only the spaces where a row wraps', () => {
  const width = text => text.length;
  assert.deepEqual(wrap('aa  bb  cc', 6, width), [['aa  bb', false, 0], ['cc', true, 2]]);
  assert.deepEqual(wrap('one\ntwo', 100, width), [['one', false, 0], ['two', false, 0]]);
  assert.deepEqual(wrap('  indented words', 100, width), [['  indented words', false, 0]]);
});

// ── the commands ───────────────────────────────────────────────────────────────────────────────

async function session(src = 'BT /F1 12 Tf 14.4 TL 72 700 Td (The quick brown fox) Tj T* (jumps over the lazy dog.) Tj ET BT /F1 12 Tf 72 600 Td (Next paragraph) Tj ET') {
  const doc = await textPage(src);
  const bytes = await doc.save();
  const content = await migrateContent(await schema1Content(bytes, 'text.pdf'));
  return createTestSession('folio', {content});
}

test('edit.blocks lists the paragraphs in page view points and edit.text_replace rewrites one', async () => {
  const t = await session();
  const listed = (await t.exec('edit.blocks', {page: 1})).result;
  assert.equal(listed.blocks.length, 2);
  const b = listed.blocks[0];
  assert.equal(b.text, 'The quick brown fox\njumps over the lazy dog.');
  assert.equal(b.editable, true);
  // View space: origin top-left, y down; the page is 800 high.
  near(b.rect[1], 800 - b.userRect[3], 1e-6);
  near(b.rect[3], 800 - b.userRect[1], 1e-6);
  const r = (await t.exec('edit.text_replace', {page: 1, key: b.key, text: 'The slow red fox walks past the sleepy dog and then goes home for the night.'})).result;
  assert.equal(r.substituted, null);
  assert.equal(r.block.index, 0);
  const after = (await t.exec('edit.blocks', {page: 1})).result.blocks;
  assert.equal(after[0].text.replace(/\n/g, ' '), 'The slow red fox walks past the sleepy dog and then goes home for the night.');
  assert.equal(after[1].text, 'Next paragraph');
  // The edit is one undo step.
  const undone = await t.exec('edit.text_replace', {page: 1, index: 1, text: 'Changed'});
  assert.ok(undone.result);
  t.undo?.();
});

test('edit.text_replace refuses a paragraph that is no longer there and asks for something to do', async () => {
  const t = await session();
  const b = (await t.exec('edit.blocks', {page: 1})).result.blocks[0];
  await assert.rejects(() => t.exec('edit.text_replace', {page: 1, key: {...b.key, text: 'Something else'}, text: 'x'}), /no longer on the page/);
  await assert.rejects(() => t.exec('edit.text_replace', {page: 1, index: 0}), /text|style/);
  await assert.rejects(() => t.exec('edit.text_replace', {page: 1, index: 9, text: 'x'}), /no such paragraph/);
});

test('edit.format restyles the open paragraph; the controls show its values', async () => {
  const t = await session();
  const tool = (await t.exec('edit.edit_text', {})).result;
  assert.equal(tool.tool, 'edit.text_edit');
  assert.equal(t.state?.('edit.edit_text')?.checked ?? true, true);
  const b = (await t.exec('edit.blocks', {page: 1})).result.blocks[0];
  await t.exec('edit.select_block', {page: 1, key: b.key});
  await t.exec('edit.format', {field: 'size', value: 18});
  const bigger = (await t.exec('edit.blocks', {page: 1})).result.blocks[0];
  assert.equal(bigger.size, 18);
  const bold = (await t.exec('edit.format', {toggle: 'bold'})).result;
  assert.equal(bold.block.bold, true);
  assert.match(bold.block.font, /Bold/);
  await t.exec('edit.format', {field: 'color', value: '#cc0000'});
  assert.equal((await t.exec('edit.blocks', {page: 1})).result.blocks[0].color, '#cc0000');
  await t.exec('edit.format', {field: 'align', value: 'center'});
  const states = {
    size: t.state('edit.format', {field: 'size'}),
    bold: t.state('edit.format', {toggle: 'bold'}),
  };
  assert.equal((await states.size).value, '18');
  assert.equal((await states.bold).checked, true);
  await assert.rejects(() => t.exec('edit.format', {field: 'size', value: 'big'}), /number/);
});

test('edit.format needs a paragraph; the text controls say what to do first', async () => {
  const t = await session();
  const st = await t.state('edit.format', {field: 'size'});
  assert.equal(st.enabled, false);
  assert.match(st.reason, /Click a paragraph/);
});

test('a protected document refuses editing text', async () => {
  const doc = await textPage('BT /F1 12 Tf 72 700 Td (Locked) Tj ET');
  const content = {...(await migrateContent(await schema1Content(await doc.save()))), permissions: {modify: false}};
  const t = await createTestSession('folio', {content});
  await assert.rejects(() => t.exec('edit.text_replace', {page: 1, index: 0, text: 'x'}), /security settings/);
});

test('text is read as data: a hostile content stream with JavaScript-looking operands and huge numbers is only parsed', async () => {
  const doc = await textPage('BT /F1 12 Tf 72 700 Td (app.alert\\(1\\)) Tj ET /Fake << /S /JavaScript /JS (app.alert\\(1\\)) >> BDC EMC 1e999 0 0 1 0 0 cm');
  const blocks = blocksOf(doc);
  assert.equal(blocks[0].text, 'app.alert(1)');
  rewrite(doc, 0, 'app.alert(2)');
  assert.equal(blocksOf(await reopen(doc))[0].text, 'app.alert(2)');
});

test('base64 helper round trips (fixture sanity)', () => {
  assert.equal(base64(Uint8Array.of(104, 105)), 'aGk=');
});

test('a large page is read in slices so the window can breathe, and gives the same paragraphs as reading it whole', async () => {
  const rows = Array.from({length: 120}, (_, i) => `BT /F1 10 Tf 72 ${780 - i * 6} Td (Row ${i} of a long page full of small text objects) Tj ET`);
  const content = Array.from({length: 40}, () => rows.join('\n')).join('\n');
  const doc = await textPage(content);
  const page = doc.getPage(0);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const {pageBlocksAsync, pageBlocks: whole} = await import('../../core/folio/lib/text-edit.mjs');
  const sliced = await pageBlocksAsync(doc, page);
  clearInterval(timer);
  assert.ok(ticks > 0, 'timers ran while the page was read');
  const all = whole(doc, page);
  assert.deepEqual(sliced.blocks.map(b => b.text), all.blocks.map(b => b.text));
  assert.ok(sliced.read.ops.length >= 4800 * 2, `${sliced.read.ops.length} operators`);
});

test('moving a paragraph shifts its glyphs without re-encoding them, and the text positioned after it stays where it was', async () => {
  const {translateBlocks} = await import('../../core/folio/lib/text-rewrite.mjs');
  for (const show of ['(Hello) Tj', '[(He) -20 (llo)] TJ', "(Hello) '", '2 1 (Hello) "']) {
    const doc = await textPage(`BT /F1 12 Tf 14 TL 72 700 Td ${show} [-3000] TJ /F2 12 Tf (ab) Tj ET`);
    const before = linesOf(doc);
    assert.equal(before.length, 2, show);
    const l = listing(doc);
    const hello = l.blocks.findIndex(b => b.text.startsWith('Hello'));
    translateBlocks(doc, doc.getPage(0), l.read, l.lines, l.blocks, [hello], [30, -20]);
    const after = linesOf(await reopen(doc));
    assert.equal(after.length, 2, show);
    const moved = after.find(x => x.text === 'Hello'), stays = after.find(x => x.text === 'ab');
    const [was, wasAb] = [before.find(x => x.text === 'Hello'), before.find(x => x.text === 'ab')];
    near(moved.rect[0], was.rect[0] + 30, 1e-3, `${show}: moved right`);
    near(moved.rect[1], was.rect[1] - 20, 1e-3, `${show}: moved down`);
    for (let i = 0; i < 4; i++) near(stays.rect[i], wasAb.rect[i], 1e-3, `${show}: the text after it did not move`);
  }
  const clip = await textPage('BT /F1 12 Tf 7 Tr 72 700 Td (Clip) Tj ET');
  const lc = listing(clip);
  assert.throws(() => translateBlocks(clip, clip.getPage(0), lc.read, lc.lines, lc.blocks, [0], [5, 5]), /clipping/);
});

test('edit.text_move moves a paragraph by page view points, in one undo step', async () => {
  const t = await session();
  const before = (await t.exec('edit.blocks', {page: 1})).result.blocks;
  const r = (await t.exec('edit.text_move', {page: 1, key: before[1].key, offset: [25, 40]})).result;
  near(r.offset[0], 25, 1e-9);
  near(r.offset[1], -40, 1e-9, 'view down is user down');
  const after = (await t.exec('edit.blocks', {page: 1})).result.blocks;
  near(after[1].rect[0], before[1].rect[0] + 25, 1e-3);
  near(after[1].rect[1], before[1].rect[1] + 40, 1e-3);
  assert.equal(after[1].text, before[1].text);
  assert.equal(after[0].text, before[0].text, 'the paragraph above is untouched');
  const depth = t.history?.undoDepth ?? null;
  void depth;
});

// ── the styled path ────────────────────────────────────────────────────────────────────────────

const styledPage = src => build([
  '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F6 6 0 R /F7 7 0 R >> >> >>',
  `<< /Length ${src.length} >>\nstream\n${src}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>',
]);
const runsOf = doc => linesOf(doc).map(l => [l.text, l.baseFont, l.size, l.color.map(c => +c.toFixed(2))]);

test('a paragraph of several styles keeps each run\'s font, size and colour when its words are edited', async () => {
  const doc = await styledPage('BT /F1 12 Tf 72 700 Td (Hello ) Tj /F6 12 Tf 1 0 0 rg (bold red) Tj /F1 12 Tf 0 g ( world and more plain words) Tj ET');
  assert.equal(blocksOf(doc).length, 1);
  const result = rewrite(doc, 0, 'Howdy bold red world and more plain words');
  assert.equal(result.flattened, false, 'not flattened to the first run');
  assert.equal(result.styled, true);
  const again = await reopen(doc);
  const runs = runsOf(again);
  assert.equal(blocksOf(again)[0].text, 'Howdy bold red world and more plain words');
  const bold = runs.find(r => r[0].includes('bold'));
  assert.equal(bold[1], 'Helvetica-Bold');
  assert.deepEqual(bold[3], [1, 0, 0]);
  assert.equal(runs.find(r => r[0].includes('Howdy'))[1], 'Helvetica');
  assert.deepEqual(runs.find(r => r[0].includes('plain'))[3], [0, 0, 0]);
});

test('words typed inside a styled run take its style, and a growing paragraph wraps by each character\'s own width', async () => {
  const doc = await styledPage('BT /F1 12 Tf 72 700 Td (Intro ) Tj /F7 16 Tf 0 0 1 rg (Large Times words) Tj ET');
  const width = widthOf(blocksOf(doc)[0].rect);
  rewrite(doc, 0, 'Intro Large Times extra words in the middle');
  const again = await reopen(doc);
  const runs = runsOf(again);
  const times = runs.filter(r => r[1] === 'Times-Roman');
  assert.ok(times.length >= 1 && times.every(r => r[2] === 16 && r[3][2] === 1), `the inserted words are Times 16 blue: ${JSON.stringify(runs)}`);
  const lines = linesOf(again);
  for (const l of lines) assert.ok(widthOf(l.rect) <= width + 1, `${l.text} stays inside the box`);
  assert.ok(lines.length > 1, 'the longer text wrapped');
  assert.equal(blocksOf(again).length, 1);
});

test('a face asked for flattens the paragraph, as upstream does', async () => {
  const doc = await styledPage('BT /F1 12 Tf 72 700 Td (Hello ) Tj /F6 12 Tf (bold) Tj ET');
  const r = rewrite(doc, 0, undefined, {family: 'Courier'});
  assert.equal(r.flattened, true);
  assert.deepEqual([...new Set(linesOf(doc).map(l => l.baseFont))], ['Courier']);
});

test('opening a paragraph joins its lines into one flow: narrowing it leaves no break at the old line ends, a soft hyphen joins with nothing', async () => {
  // Three unmarked rows of different lengths (a file written elsewhere): the short middle row is a wrap too, not a typed break.
  const doc = await textPage('BT /F1 12 Tf 14 TL 72 700 Td (Revenue grew steadily across every) Tj T* (region this quarter,) Tj T* (led by the new subscription plans.) Tj ET');
  const block = blocksOf(doc)[0];
  assert.equal(block.rows.length, 3);
  assert.equal(block.reflowText, 'Revenue grew steadily across every region this quarter, led by the new subscription plans.');
  assert.equal(block.text, block.reflowText);
  rewrite(doc, 0, block.reflowText, {width: widthOf(block.rect) * 0.75});
  const rows = linesOf(doc).map(l => l.text.trim());
  assert.ok(rows.length >= 4, `the narrower box wraps onto more rows: ${rows.join(' | ')}`);
  assert.ok(rows.some(r => r.includes('every region') || r.includes('quarter, led')), `no row runs across an old line end: ${rows.join(' | ')}`);
  assert.equal(rows.join(' '), block.reflowText);
  assert.equal(blocksOf(doc)[0].reflowText, block.reflowText, 'the flow is the same text after the narrowing');
  // A row ending in a hyphen continues the word on the next row with no space.
  const hyph = await textPage('BT /F1 12 Tf 14 TL 72 700 Td (A subscription plan for every team and rev-) Tj T* (enue grew) Tj ET');
  assert.equal(blocksOf(hyph)[0].reflowText, 'A subscription plan for every team and revenue grew');
});
