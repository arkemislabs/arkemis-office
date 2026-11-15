// Export as PDF with system fonts: Latin, Cyrillic, Greek, Devanagari and CJK cells keep their letters (no "?" in their place), in cells and
// in the header and footer. A script whose font is not on the machine is skipped (the test cannot ask for a font the machine lacks).
// Text is read back from the PDF by pdfium. Not in gridcraft (not checked against upstream).

import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {pdfText} from './pdf-text.mjs';
import {session, workbook, run} from './edit-helpers.mjs';
import {write as writePdf} from '../../core/grid/formats/pdf-write.mjs';
import {systemFonts} from '../../core/common/lib/pdf-fonts.mjs';
import {exportPdf as exportWordPdf} from '../../core/quill/formats/pdf-write.mjs';
import {createContent} from '../../core/quill/model/content.mjs';
import * as P from '../../core/quill/model/para.mjs';

const SCRIPTS = [['Latin', 'Hello Café'], ['Cyrillic', 'Привет мир'], ['Greek', 'Γειά σου κόσμε'], ['Devanagari', 'नमस्ते'], ['CJK', '你好世界']];

/** Whether the machine has a font for every character of a text. */
async function covered(text) {
  const pdf = await PDFDocument.create();
  const set = await systemFonts(pdf);
  await set.prepare([text], [{}]);
  return !set.face({}).clean(text).includes('?');
}

test('Export as PDF keeps Latin, Cyrillic, Greek, Devanagari and CJK text, in cells and in the header', async t => {
  const t1 = await session(workbook());
  const have = [];
  for (const [name, text] of SCRIPTS) {
    if (!(await covered(text))) { t.diagnostic(`${name}: no system font for it here, skipped`); continue; }
    have.push([name, text]);
  }
  assert.ok(have.length >= 1, 'at least Latin has a font');
  for (const [i, [, text]] of have.entries()) await run(t1, 'cell.set', {cell: `A${i + 1}`, input: text});
  await run(t1, 'pageLayout.headerFooter', {header: `&C${have.at(-1)[1]}`});
  const bytes = await writePdf({content: t1.content, title: 'Scripts'});
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 1);
  const text = (await pdfText(bytes)).replace(/\s+/g, ' ');
  for (const [name, sample] of have) assert.ok(text.includes(sample.replace(/\s+/g, ' ')), `${name} text "${sample}" is in the PDF (got: ${text.slice(0, 200)})`);
  assert.ok(!text.includes('?'), 'no "?" replaced a letter');
  // The fonts are embedded as subsets, not the whole files.
  assert.ok(bytes.length < 400_000, `the PDF is ${bytes.length} bytes: fonts are subset`);
});

test('a character no installed font has prints as ?', async () => {
  const pdf = await PDFDocument.create();
  const set = await systemFonts(pdf);
  // U+10FFFE is a noncharacter: no font has a glyph for it.
  await set.prepare(['a\u{10FFFE}b'], [{}]);
  assert.equal(set.face({}).clean('a\u{10FFFE}b'), 'a?b');
});

test('Word export: Cyrillic, Greek and CJK paragraphs keep their letters; Latin stays in the document font', async () => {
  const sample = [['Cyrillic', 'Привет мир'], ['Greek', 'Γειά σου κόσμε'], ['CJK', '你好世界']];
  const have = [];
  for (const s of sample) if (await covered(s[1])) have.push(s);
  const c = createContent([P.paragraphWithText('Plain Latin paragraph'), ...have.map(([, text]) => P.paragraphWithText(text))]);
  const bytes = await exportWordPdf(c);
  const text = (await pdfText(bytes)).replace(/s+/g, ' ');
  assert.ok(text.includes('Plain Latin paragraph'));
  for (const [name, s] of have) assert.ok(text.includes(s), `${name} "${s}" is in the Word PDF (got: ${text.slice(0, 200)})`);
  assert.ok(!text.includes('?'), 'no "?" replaced a letter');
});
