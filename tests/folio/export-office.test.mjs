// core/folio/lib/export-office.mjs, reading-blocks.mjs and the export.docx, .pptx, .html and .rtf commands: Export a PDF to Word,
// PowerPoint, HTML and RTF.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft 0.16.0 crates/export tests.rs, crates/edit text_regions grouping, crates/engine compare.rs, ui-egui files.rs
//    export_office_dialog): a page is paragraphs and images in reading order; headings are the text set larger than the body
//    (1.6x: heading 1, 1.25x: heading 2); an italic or linked word that continues a line is a run of its sentence in its own
//    style; grid text becomes a real table (spans, empty cells for holes) in every format and running text is never mistaken for
//    one; RTF escapes and sizes (half points, \\u for non-ASCII); a Word package holds its parts and media; pages with rotated or
//    overlapped text stay as positioned shapes; the export needs the right to copy the content and goes through the Save dialog.
//    Acrobat's Save as Word, PowerPoint, HTML and RTF do the same kind of conversion.
// 2. Ours does the same: the writers are ported against upstream's own tests (synthetic blocks), and real PDFs go through the
//    page text of the page view and out as files that are opened again here (zip parts read, text found).
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {PDFDocument, StandardFonts, rgb} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {schema1Content} from '../../core/folio/fixtures.mjs';
import {pageText, releaseTextSources} from '../../core/folio/model/page-text.mjs';
import {exportBlocks, textLines, leaderEntry, opensWithMarker} from '../../core/folio/lib/reading-blocks.mjs';
import * as X from '../../core/folio/lib/export-office.mjs';
import {exportPages} from '../../core/folio/commands/export.mjs';

after(() => releaseTextSources());

const block = (text, x0, y0, x1, y1, extra = {}) => ({text, rect: [x0, y0, x1, y1], size: 12, bold: false, italic: false, color: [0, 0, 0], rotation: 0, spaceAround: [false, false], ...extra});
const parts = async bytes => { const z = await JSZip.loadAsync(bytes); return z; };
const part = async (bytes, name) => (await parts(bytes)).file(name).async('string');

/** upstream tests.rs `page()`: a heading, a subheading, two paragraphs and a picture. */
const samplePage = () => {
  const b = (t, y, size, bold) => block(t, 72, y, 500, y + size, {size, bold});
  return {
    width: 612, height: 792,
    blocks: [
      b('Body text after the picture, which is long enough to be the main text size of the page.', 400, 11, false),
      b('Annual Report', 700, 24, true),
      b('Overview', 650, 14, true),
      b('Some <body> text & more of it so that eleven points is the body size here.', 620, 11, false),
    ],
    images: [{ext: 'png', bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3]), rect: [72, 450, 272, 600], size: [200, 150], rotation: 0}],
    background: null,
  };
};

/** upstream tests.rs `table_page()`: a 3-column table with a spanning row and a hole, then a paragraph. */
const tablePage = () => {
  const cell = (t, x, y, w) => block(t, x, y, x + w, y + 12, {size: 11});
  return {
    width: 612, height: 792,
    blocks: [cell('Meter', 72, 620, 120), cell('Unit', 232, 620, 80), cell('Reading', 392, 620, 100), cell('A1', 72, 590, 120), cell('kWh', 232, 590, 80), cell('37414.00', 392, 590, 100),
      cell('A2', 72, 560, 120), cell('kW', 232, 560, 80), cell('Totals', 72, 530, 240),
      block('Notes follow the table and are long enough to be the body text size of the page here.', 72, 460, 500, 471, {size: 11})],
    images: [], background: null,
  };
};

test('HTML has headings, paragraphs and images in order, escaped, with a rule between pages', () => {
  const h = X.html([samplePage(), samplePage()], 'Report');
  const at = ['<h1>Annual Report</h1>', '<h2>Overview</h2>', '<p>Some &lt;body&gt; text &amp;', '<img', '<p>Body text after'].map(x => { const i = h.indexOf(x); assert.ok(i >= 0, `${x} missing in ${h}`); return i; });
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
  assert.equal(h.split('<hr>').length - 1, 1);
  assert.match(h, /<title>Report<\/title>/);
  assert.match(h, /src="data:image\/png;base64,iVBORw0KGgo/);
});

test('a Word package holds its parts and the picture; headings use the heading styles; text is escaped', async () => {
  const d = await X.docx([samplePage()], 'Report');
  assert.deepEqual([d[0], d[1]], [0x50, 0x4b]);
  const z = await parts(d);
  for (const n of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'word/media/image1.png', '_rels/.rels', 'docProps/core.xml']) assert.ok(z.file(n), n);
  const xml = await z.file('word/document.xml').async('string');
  assert.match(xml, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(xml, /<w:pStyle w:val="Heading2"\/>/);
  assert.match(xml, /Some &lt;body&gt; text &amp; more/);
  assert.match(xml, /<w:sz w:val="48"\/>/, '24 pt is 48 half points');
  assert.match(await z.file('word/_rels/document.xml.rels').async('string'), /Target="media\/image1\.png"/);
});

test('Word does not invent borders for aligned fields, and a table\'s cell widths follow the columns they span', async () => {
  const xml = await part(await X.docx([tablePage()], 'Invoice'), 'word/document.xml');
  assert.ok(xml.includes('<w:tbl>'));
  assert.ok(!xml.includes('w:val="single"'), 'text alignment is not evidence of a border');
  assert.ok(xml.includes('<w:insideH w:val="nil"/>'));
  const cell = (text, span) => ({text, size: 11, bold: false, italic: false, color: [0, 0, 0], span});
  const t = X.docxTable({rect: [0, 0, 300, 100], cols: [0, 50, 150], rows: [
    [cell('First', 1), cell('Second', 1), cell('Third', 1)], [cell('First', 1), cell('Last two', 2)], [cell('First two', 2), cell('Third', 1)], [cell('All', 3)], [cell('First', 1)]]});
  assert.ok(t.includes('<w:gridCol w:w="1000"/><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/>'), t);
  const widths = t.split('<w:tr>').slice(1).map(row => row.split('<w:tcW w:w="').slice(1).map(c => c.split('"')[0]));
  assert.deepEqual(widths, [['1000', '2000', '3000'], ['1000', '5000'], ['3000', '3000'], ['6000'], ['1000', '0', '0']]);
});

test('RTF escapes and sizes: half points, \\u for non-ASCII, braces and backslashes', () => {
  const p = samplePage();
  p.blocks.push(block('Café {x}', 72, 100, 200, 110, {size: 10, italic: true}));
  const r = X.rtf([p]);
  assert.ok(r.startsWith('{\\rtf1') && r.endsWith('}'));
  assert.ok(r.includes('\\fs48\\b Annual Report'));
  assert.ok(r.includes('\\fs20\\i Caf\\u233? \\{x\\}'), r);
  assert.ok(X.rtf([{width: 100, height: 100, blocks: [block('\u{1F600}', 0, 0, 10, 10)], images: []}]).includes('\\u-10179?\\u-8704?'), 'surrogates as signed 16-bit units');
});

test('text colour survives every format', async () => {
  const p = {width: 612, height: 792, blocks: [block('Red words in a long enough sentence to be the main text of the page.', 72, 700, 500, 712, {color: [1, 0, 0]})], images: []};
  assert.ok(X.html([p], 't').includes('style="color:#FF0000"'));
  assert.ok(X.rtf([p]).includes('{\\colortbl;\\red255\\green0\\blue0;}') && X.rtf([p]).includes('\\cf1'));
  assert.ok((await part(await X.docx([p], 't'), 'word/document.xml')).includes('<w:color w:val="FF0000"/>'));
  assert.ok((await part(await X.pptx([p], 't'), 'ppt/slides/slide1.xml')).includes('<a:srgbClr val="FF0000"/>'));
});

test('grid text becomes a real table in every format; the hole is an empty cell; the paragraph after stays', async () => {
  const p = tablePage();
  const h = X.html([p], 'Bill');
  assert.ok(h.includes('<table>'), h);
  assert.ok(h.includes('<td colspan="2">Totals</td>'), h);
  assert.equal(h.split('<tr>').length - 1, 4);
  assert.ok(h.includes('<td></td>'), 'the hole');
  assert.ok(h.includes('<p>Notes follow'));
  const [tabs] = X.tables(p.blocks);
  assert.equal(tabs.length, 1);
  const t = X.docxTable(tabs[0]);
  assert.ok(t.includes('<w:tblGrid>') && t.includes('<w:gridSpan w:val="2"/>'));
  assert.equal(t.split('<w:tr>').length - 1, 4);
  const r = X.rtf([p]);
  assert.equal(r.split('\\row').length - 1, 4);
  assert.ok(r.includes('\\trowd\\trgaph108\\cellx4640\\cellx7840\\cellx9920{'), r);
  assert.ok(r.includes('\\trowd\\trgaph108\\cellx7840{\\intbl\\fs22 Totals}\\cell\\row'), r);
  const slide = await part(await X.pptx([p], 'Bill'), 'ppt/slides/slide1.xml');
  assert.ok(slide.includes('<a:tbl>') && slide.includes('gridSpan="2"'));
  assert.equal(slide.split('<a:tr ').length - 1, 4);
});

test('a link inside a sentence is a run of it, not a table column; sentences that run on into links are not a table', () => {
  const blue = (t, x0, y0, x1, y1) => block(t, x0, y0, x1, y1, {color: [0.02, 0.388, 0.757]});
  const p = {width: 612, height: 792, images: [], blocks: [
    block('6.3. 2. All content shown at', 121.7, 710.3, 272, 724.9), blue('http', 273.5, 710.3, 294.1, 724.9), blue('s', 294.1, 709.8, 298.8, 725.8),
    blue('://women', 298.8, 710.3, 348, 724.9), blue('g', 348.1, 709.8, 353.7, 725.8), blue('randprix.fide.com', 353.7, 710.3, 443.2, 724.9),
    block('shall be reviewed and approved by the Press Officer.', 164.3, 622.5, 533.1, 724.9),
    block('6.3. 3. The Organiser shall warrant that', 121.7, 601.8, 345.1, 616.5), blue('https://womengrandprix.fide.com', 350.2, 601.3, 519.9, 617.4),
    block('is managed in a professional way and furthermore that it is capable of', 164.3, 557.9, 533, 616.5),
    block('6. 3. 4. The Press Officer shall report to the FIDE Head of PR.', 121.7, 516.6, 530.3, 551.9), block('conducted during a WGP tournament.', 164.3, 502, 352.5, 516.6)]};
  const h = X.html([p], 'Regulations');
  assert.ok(!h.includes('<table>'), h);
  assert.ok(h.includes('<p>6.3. 2. All content shown at <span style="color:#0563C1">http</span>'), h);
  for (const b of p.blocks) assert.ok(h.includes(b.text), `${b.text} was lost`);
  const lines = [];
  ['Rules are published at', 'Pairings are posted at', 'Results are listed at'].forEach((lead, n) => {
    const y = 700 - 16 * n;
    lines.push(block(lead, 72, y, 211, y + 12), blue('https://example.org/event', 212.5, y, 360, y + 12));
  });
  const h2 = X.html([{width: 612, height: 792, blocks: lines, images: []}], 'Event');
  assert.ok(!h2.includes('<table>'), h2);
  assert.equal(h2.split('https://example.org/event').length - 1, 3);
});

test('runs keep the spaces the source had; a block on the next line starts a paragraph; table cells are not runs; turned text is not a run of the line beside it', () => {
  const para = blocks => X.paragraphs(blocks, []).map(runs => runs.map(r => r.text));
  const italic = [block('The court held in', 72, 700, 160, 712), block('Smith v. Jones', 162, 700, 240, 712, {italic: true}), block('that the claim fails.', 242, 700, 330, 712)];
  assert.deepEqual(para(italic), [['The court held in ', 'Smith v. Jones ', 'that the claim fails.']]);
  assert.deepEqual(para([block('First line of text', 72, 700, 200, 712), block('Second paragraph below', 72, 680, 200, 692)]).length, 2);
  assert.equal(para([block('Turned', 72, 700, 160, 712, {rotation: 90}), block('beside', 162, 700, 240, 712)]).length, 2);
});

test('a paragraph is a heading only when its text is: long or small text stays body text', () => {
  const body = block('Body text that is long enough to be the main size of the document, repeated for weight.'.repeat(8), 72, 600, 500, 611, {size: 11});
  const big = block('A Big Title', 72, 700, 300, 740, {size: 24});
  const longBig = block('x'.repeat(250), 72, 500, 500, 540, {size: 24});
  const h = X.html([{width: 612, height: 792, blocks: [body, big, longBig], images: []}], 't');
  assert.ok(h.includes('<h1>A Big Title</h1>'));
  assert.ok(!h.includes('<h1>xxx'), 'a long paragraph is never a heading');
});

test('the body size is the size most characters are set in; with no text it is 11', () => {
  assert.equal(X.bodySize([{blocks: []}]), 11);
  assert.equal(X.bodySize([{blocks: [block('aaaaaaaaaa', 0, 0, 1, 1, {size: 9}), block('bb', 0, 0, 1, 1, {size: 14})]}]), 9);
});

test('XML-forbidden control characters never reach the output', async () => {
  const p = {width: 612, height: 792, blocks: [block('ok\u0001\u0008text￾￿end', 72, 700, 300, 712)], images: []};
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(await part(await X.docx([p], 't'), 'word/document.xml')));
  assert.ok(X.html([p], 't').includes('oktextend'));
  assert.equal(X.esc('a&b<c>"d"'), 'a&amp;b&lt;c&gt;&quot;d&quot;');
});

test('Word keeps a page with rotated text as positioned shapes, and a flowing page as paragraphs', async () => {
  const turned = {width: 612, height: 792, blocks: [block('DRAFT', 100, 300, 400, 500, {size: 60, rotation: 45})], images: []};
  assert.equal(X.positioned(turned), true);
  assert.equal(X.positioned(samplePage()), false);
  const xml = await part(await X.docx([turned], 't'), 'word/document.xml');
  assert.match(xml, /<v:rect id="Text1"/);
  assert.match(xml, /rotation:315\.000/);
});

test('a presentation has a slide per page with the largest text as its title; an empty document still opens', async () => {
  const z = await parts(await X.pptx([samplePage(), samplePage()], 'Deck'));
  for (const n of ['ppt/presentation.xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/theme/theme1.xml', 'ppt/media/image1.png']) assert.ok(z.file(n), n);
  const slide = await z.file('ppt/slides/slide1.xml').async('string');
  assert.match(slide, /name="Title 2"[\s\S]*Annual Report/);
  assert.match(slide, /<p:pic>/);
  const empty = await parts(await X.pptx([], 'Nothing'));
  assert.ok(empty.file('ppt/slides/slide1.xml'), 'a blank slide');
});

test('list markers and dotted leaders are told from prose', () => {
  for (const t of ['• item', '- item', '1. item', '2) item', 'a. item', 'A) item']) assert.equal(opensWithMarker(t), true, t);
  for (const t of ['1.5 meters', 'Dr. Smith', 'ab. x', 'Plain text']) assert.equal(opensWithMarker(t), false, t);
  assert.equal(leaderEntry('Chapter One ........ 12'), true);
  assert.equal(leaderEntry('Wait... what 12'), false);
  assert.equal(leaderEntry('Article 3.2.1 12'), false);
});

// ── real PDFs through the page text ────────────────────────────────────────────────────────

async function realPdf() {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold), it = await doc.embedFont(StandardFonts.HelveticaOblique);
  const page = doc.addPage([612, 792]);
  page.drawText('Annual Report', {x: 72, y: 700, size: 26, font: bold, color: rgb(0.1, 0.2, 0.6)});
  const wrap = ['The quick brown fox jumps over the lazy dog and keeps running through', 'the field until it reaches the river where it stops to drink some water.'];
  wrap.forEach((l, i) => page.drawText(l, {x: 72, y: 650 - i * 15, size: 11, font: reg}));
  page.drawText('The court held in', {x: 72, y: 600, size: 11, font: reg});
  page.drawText('Smith v. Jones', {x: 72 + reg.widthOfTextAtSize('The court held in ', 11), y: 600, size: 11, font: it});
  const rows = [['Meter', 'Unit', 'Reading'], ['A1', 'kWh', '37414'], ['A2', 'kW', '12']];
  rows.forEach((row, r) => row.forEach((c, k) => page.drawText(c, {x: 72 + k * 150, y: 520 - r * 30, size: 11, font: reg})));
  return migrateContent(await schema1Content(await doc.save(), 'real.pdf'));
}

test('reading blocks: a wrapped paragraph is one block, a heading keeps its size, weight and colour, an italic run stays beside its sentence, grid text is a table', async () => {
  const content = await realPdf();
  const page = content.pages[0];
  const text = await pageText(content, page);
  const runs = textLines(text);
  assert.ok(runs.some(l => l.bold && Math.abs(l.size - 26) < 0.5), 'the heading is a bold 26 pt run');
  const blocks = exportBlocks(text, 792);
  const heading = blocks.find(b => b.text === 'Annual Report');
  assert.ok(heading && heading.bold && Math.abs(heading.size - 26) < 0.5);
  assert.ok(Math.abs(heading.color[2] - 0.6) < 0.01 && Math.abs(heading.color[0] - 0.1) < 0.01, `colour ${heading.color}`);
  assert.ok(heading.rect[3] > 700 && heading.rect[3] < 740, 'the box is turned to the page with y up');
  const wrapped = blocks.find(b => b.text.startsWith('The quick brown fox'));
  assert.equal(wrapped.text, 'The quick brown fox jumps over the lazy dog and keeps running through the field until it reaches the river where it stops to drink some water.');
  assert.ok(blocks.some(b => b.italic && b.text === 'Smith v. Jones'), 'the italic run is a block of its own, to join its sentence');
  const out = await exportPages(content);
  const [tabs] = X.tables(out[0].blocks);
  assert.equal(tabs.length, 1, JSON.stringify(out[0].blocks.map(b => [b.text, b.rect.map(Math.round)])));
  assert.deepEqual(tabs[0].rows.map(r => r.map(c => c.text)), [['Meter', 'Unit', 'Reading'], ['A1', 'kWh', '37414'], ['A2', 'kW', '12']]);
  const h = X.html(out, 'real');
  assert.match(h, /<h1[^>]*>Annual Report<\/h1>/);
  assert.match(h, /<p>The court held in <em>Smith v\. Jones<\/em><\/p>/);
  assert.match(h, /<table>/);
});

test('export.docx, .pptx, .html and .rtf write the file the program asks for as base64 and refuse a document that forbids copying', async () => {
  const content = await realPdf();
  const t = await createTestSession('folio', {content});
  for (const [ext, check] of [
    ['docx', async b => assert.match(await part(b, 'word/document.xml'), /Annual Report/)],
    ['pptx', async b => assert.match(await part(b, 'ppt/slides/slide1.xml'), /Annual Report/)],
    ['html', async b => assert.match(Buffer.from(b).toString('utf8'), /<h1[^>]*>Annual Report<\/h1>/)],
    ['rtf', async b => assert.match(Buffer.from(b).toString('latin1'), /^\{\\rtf1/)],
  ]) {
    assert.equal(t.state(`export.${ext}`).enabled, true);
    const r = (await t.exec(`export.${ext}`, {})).result;
    assert.equal(r.name, 'real.' + ext);
    assert.equal(r.pages, 1);
    await check(Buffer.from(r.base64, 'base64'));
  }
  const locked = await createTestSession('folio', {content: {...content, permissions: {copy: false}}});
  for (const ext of ['docx', 'pptx', 'html', 'rtf']) {
    assert.equal(locked.state(`export.${ext}`).enabled, false);
    await assert.rejects(() => locked.exec(`export.${ext}`, {}), /copying/);
  }
});

/** Tags open and close in order (a package part that is not well formed makes Word and PowerPoint refuse the file). */
function wellFormed(xml) {
  const stack = [];
  for (const m of xml.replace(/<\?[\s\S]*?\?>/g, '').matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g)) {
    if (m[4]) continue;
    if (m[1]) { assert.equal(stack.pop(), m[2], `unbalanced </${m[2]}>`); } else stack.push(m[2]);
  }
  assert.deepEqual(stack, [], 'tags left open');
}

test('every XML part of a Word and a PowerPoint file made from a real page is well formed', async () => {
  const content = await realPdf();
  const pages = await exportPages(content);
  for (const [bytes, names] of [[await X.docx(pages, 'Real & <title>'), ['word/document.xml', 'word/styles.xml', '[Content_Types].xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']],
    [await X.pptx(pages, 'Real'), ['ppt/slides/slide1.xml', 'ppt/presentation.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/theme/theme1.xml', '[Content_Types].xml']]]) {
    for (const n of names) wellFormed(await part(bytes, n));
  }
  assert.match(await part(await X.docx(pages, 'Real & <title>'), 'docProps/core.xml'), /Real &amp; &lt;title&gt;/);
});

test('the four Office exports are registered under the catalogue ids', async () => {
  const t = await createTestSession('folio', {content: await realPdf()});
  for (const id of ['export.docx', 'export.pptx', 'export.html', 'export.rtf']) assert.equal(t.state(id).enabled, true, id);
});
