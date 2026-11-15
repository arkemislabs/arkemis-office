// Ported from wordcraft crates/layout/src/fields.rs (mod tests) at aadb077e072b7de05f724e359d8db82e151f125c.
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCaseSwitch, dollarText, fieldCodeText, fieldCtx, fieldName, fieldNumber, fieldText, referenceLink} from '../../../core/quill/layout/fields.mjs';

test('ref_link_switches', () => {
  for (const instr of ['REF mark\\w\\h', ' REF "mark" \\h', 'REF\tmark \\H']) assert.equal(referenceLink(instr), '#mark', instr);
  for (const instr of ['', 'REF', 'REF \\h', 'REF "" \\h', 'REF "mark \\h', 'REF mark \\hidden', 'NOTEREF mark \\h', 'REF mark \\d "\\h"']) {
    assert.equal(referenceLink(instr), null, instr);
  }
});

test('filename_field', () => {
  const ctx = fieldCtx({filename: 'report.docx', filepath: '/home/user/docs/report.docx'});
  assert.deepEqual(fieldText('FILENAME', '', ctx), ['report.docx', false]);
  assert.deepEqual(fieldText('FILENAME \\p', '', ctx), ['/home/user/docs/report.docx', false]);
  assert.deepEqual(fieldText('FILENAME \\* MERGEFORMAT', '', ctx), ['report.docx', false]);
  assert.deepEqual(fieldText('FILENAME', 'cached.docx', ctx), ['cached.docx', false]);
  const def = fieldCtx();
  assert.deepEqual(fieldText('FILENAME', '', def), ['Document1', false]);
  assert.deepEqual(fieldText('FILENAME \\p', '', def), ['Document1', false]);
});

test('page_fields', () => {
  const ctx = fieldCtx({page: 4, pages: 12});
  assert.deepEqual(fieldText('PAGE', '', ctx), ['4', true]);
  assert.equal(fieldText(' PAGE \\* ROMAN ', '', ctx)[0], 'IV');
  assert.equal(fieldText('PAGE \\*roman', '', ctx)[0], 'iv');
  assert.equal(fieldText('PAGE \\*roman\\*MERGEFORMAT', '', ctx)[0], 'iv');
  assert.equal(fieldText('NUMPAGES \\* CardText', '', ctx)[0], 'twelve');
  assert.equal(fieldText('NUMPAGES \\* CHINESENUM1', '', ctx)[0], '十二');
  assert.equal(fieldText('PAGE \\* ChineseNum2', '', ctx)[0], '肆');
  assert.deepEqual(fieldText('DATE \\@ "M/d/yyyy"', '1/2/2026', ctx), ['1/2/2026', false]);
  assert.equal(fieldName('=SUM(ABOVE)'), 'SUM(ABOVE)');
  assert.equal(fieldCodeText(' PAGE \\* ROMAN '), '{ PAGE \\* ROMAN }');
  assert.equal(fieldCodeText(''), '{  }');
});

test('capitalization_switches', () => {
  const ctx = fieldCtx({page: 21, pages: 790, title: 'weekly report on sales', filename: 'Weekly Sales Report.doc'});
  const text = instr => fieldText(instr, '', ctx)[0];
  assert.equal(text('NUMPAGES \\* CardText'), 'seven hundred ninety');
  assert.equal(text('NUMPAGES \\* CardText \\* Caps'), 'Seven Hundred Ninety');
  assert.equal(text('PAGE \\* OrdText'), 'twenty-first');
  assert.equal(text('PAGE \\* OrdText \\* FirstCap'), 'Twenty-first');
  assert.equal(text('PAGE \\* CardText \\* Upper'), 'TWENTY-ONE');
  assert.equal(text('PAGE \\* roman \\* upper'), 'XXI');
  assert.equal(text('TITLE \\* FirstCap \\* MERGEFORMAT'), 'Weekly report on sales');
  assert.equal(text('TITLE \\*Caps'), 'Weekly Report On Sales');
  assert.equal(text('FILENAME \\* Lower'), 'weekly sales report.doc');
  assert.equal(text('AUTHOR \\* Upper'), '');
  for (const [title, caps, firstCap] of [['"weekly report"', '"Weekly Report"', '"Weekly report"'], ['(weekly) report', '(Weekly) Report', '(Weekly) report'],
    ['  q3 - final', '  Q3 - Final', '  Q3 - final']]) {
    const c = fieldCtx({title});
    assert.equal(fieldText('TITLE \\* Caps', '', c)[0], caps);
    assert.equal(fieldText('TITLE \\* FirstCap', '', c)[0], firstCap);
  }
  assert.equal(fieldText('TITLE "x \\* Upper"', '', ctx)[0], 'weekly report on sales');
  assert.equal(fieldText('REF mark \\* Upper', 'stored', ctx)[0], 'stored', 'a stored result shows as it is');
});

test('dollar_text_hex_and_arabic_dash_switches', () => {
  const ctx = fieldCtx({page: 31, pages: 458, section: 790});
  const text = instr => fieldText(instr, '', ctx)[0];
  assert.equal(text('PAGE \\* ArabicDash'), '- 31 -');
  assert.equal(text('PAGE \\*arabicdash \\* MERGEFORMAT'), '- 31 -');
  assert.equal(text('NUMPAGES \\* ArabicDash'), '- 458 -');
  assert.equal(text('NUMPAGES \\* ArabicDash \\* roman'), '- 458 -');
  assert.equal(text('NUMPAGES \\* Hex'), '1CA');
  assert.equal(text('NUMPAGES \\* hex \\* Lower'), '1ca');
  assert.equal(text('PAGE \\* Hex'), '1F');
  assert.equal(text('SECTION \\* DollarText'), 'seven hundred ninety and 00/100');
  assert.equal(text('SECTION \\* DollarText \\* Upper'), 'SEVEN HUNDRED NINETY AND 00/100');
  assert.equal(text('PAGE \\* DollarText \\* FirstCap'), 'Thirty-one and 00/100');
  assert.equal(dollarText(9.20 + 5.35), 'fourteen and 55/100');
  assert.equal(dollarText(0.999), 'one and 00/100');
  assert.equal(dollarText(999_999.99), 'nine hundred ninety-nine thousand nine hundred ninety-nine and 99/100');
  assert.equal(dollarText(999_999.995), null);
  assert.equal(dollarText(-1), null);
  assert.equal(dollarText(-0.004), 'zero and 00/100');
  assert.equal(dollarText(NaN), null);
  for (const fmt of ['cardinalText', 'ordinalText', 'dollarText']) assert.equal(fieldNumber('SEQ x \\* Upper', fmt, 1_000_140), '1000140', fmt);
  assert.equal(fieldNumber('SEQ x', 'cardinalText', 999_999), 'nine hundred ninety-nine thousand nine hundred ninety-nine');
});

test('capitalization_switches_apply_in_order', () => {
  const ctx = fieldCtx({title: 'WEEKLY REPORT'});
  const text = instr => fieldText(instr, '', ctx)[0];
  assert.equal(text('TITLE \\* Lower \\* Caps'), 'Weekly Report');
  assert.equal(text('TITLE \\* Lower \\* FirstCap'), 'Weekly report');
  assert.equal(text('TITLE \\* Caps \\* Lower'), 'weekly report');
  assert.equal(text('TITLE \\* Lower \\* MERGEFORMAT \\* Upper'), 'WEEKLY REPORT');
  assert.equal(applyCaseSwitch('X', 'abc'), 'abc');
});

test('ask_and_set_show_nothing', () => {
  const ctx = fieldCtx();
  assert.deepEqual(fieldText(' ASK Nominativo "Inserire nome" \\d "«NOME»" ', '«NOME» «COGNOME»', ctx), ['', false]);
  assert.deepEqual(fieldText('SET Codice "COD"', 'COD', ctx), ['', false]);
  assert.equal(fieldText('set Codice COD', 'COD', ctx)[0], '');
  assert.equal(fieldText('MERGEFIELD NOME', '«NOME»', ctx)[0], '«NOME»');
});

test('page_references_show_their_bookmarks_page', () => {
  const pages = new Map([['End_1', [3, 'decimal']], ['Intro', [4, 'lowerRoman']], ['Chapter One', [7, 'decimal']]]);
  const ctx = fieldCtx({bookmarkPages: pages, bookmarksKey: 1});
  assert.deepEqual(fieldText('PAGEREF End_1 \\* Arabic \\* MERGEFORMAT', '9', ctx), ['3', true]);
  assert.equal(fieldText(' PAGEREF End_1 \\h ', '9', ctx)[0], '3');
  assert.equal(fieldText('PAGEREF End_1\\h', '9', ctx)[0], '3');
  assert.equal(fieldText('PAGEREF Intro', '9', ctx)[0], 'iv');
  assert.equal(fieldText('PAGEREF Intro \\* Arabic', '9', ctx)[0], '4');
  assert.equal(fieldText('PAGEREF "End_1"', '9', ctx)[0], '3');
  assert.equal(fieldText('PAGEREF "Chapter One" \\h', '9', ctx)[0], '7');
  assert.equal(fieldText('PAGEREF "Chapter One"\\h', '9', ctx)[0], '7');
  assert.deepEqual(fieldText('PAGEREF Missing', '9', ctx), ['9', false]);
  for (const instr of ['PAGEREF End_1 \\p', 'PAGEREF End_1 \\P', 'PAGEREF End_1 \\p\\h', 'PAGEREF End_1\\h\\p']) assert.deepEqual(fieldText(instr, 'above', ctx), ['above', false], instr);
  assert.equal(fieldText('PAGEREF End_1 \\* MERGEFORMAT', '9', ctx)[0], '3');
  assert.deepEqual(fieldText('PAGEREF \\h', '9', ctx), ['9', false]);
  assert.deepEqual(fieldText('PAGEREF', '9', ctx), ['9', false]);
  assert.deepEqual(fieldText('PAGEREF End_1', '9', fieldCtx()), ['9', false]);
});
