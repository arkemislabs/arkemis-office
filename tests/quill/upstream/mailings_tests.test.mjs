// Ported from wordcraft crates/engine/src/cmd/mailings/tests.rs at
// aadb077e072b7de05f724e359d8db82e151f125c (MIT, see assets/third-party-licenses/artcraft-reference.txt):
// the Mailings tab's engine tests. Each test names the Rust test it ports. Upstream replaces the
// session's document by the merged one (`s.add_document`): here Finish & Merge, Envelopes and Labels
// hand the new document's content to the document service (`files.create`), which the fixture records;
// `merged(t)` reads it as upstream reads `s.doc` after the merge. Not ported: the GBK/Big5/Shift_JIS
// byte fixtures made with encoding_rs (the same decoding is tested with TextEncoder-free byte arrays
// below), the .xls fixture (xls is refused) and the ODS fixture built with a zip writer (made with JSZip).

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {createTestSession} from '../../../core/kernel/testing.mjs';
import {createTestHost} from '../../../core/kernel/host.mjs';
import {contentFromText} from '../../../core/quill/model/content.mjs';
import {Document, BODY} from '../../../core/quill/model/document.mjs';
import * as P from '../../../core/quill/model/para.mjs';
import {parseCsv, compareCells, selectRecords, mergefieldName, placeholder, MERGE_KINDS} from '../../../core/quill/lib/mailings-merge.mjs';
import {isSpreadsheetName, RECIPIENT_EXTENSIONS} from '../../../core/quill/lib/mailings-sheet.mjs';

const OBJ = P.OBJ;

/** A session over `text` whose document service records the documents it creates. */
async function s(text = '') {
  const created = [];
  const files = {
    async create(kind, opts) { created.push({kind, ...opts}); return {doc: `new${created.length}`, name: opts.title}; },
    async write(doc, file, opts) { created.push({written: true, file, ...opts}); return {path: opts.path}; },
  };
  const t = await createTestSession('quill', {content: contentFromText(text), host: createTestHost({files})});
  const run = (id, params = {}) => t.exec(id, params).then(r => r.result);
  return {t, run, created};
}
const body = t => new Document(t.content).plainText(BODY).split(OBJ).join('');
/** The text of the document Finish & Merge made (the last one created). */
const merged = q => new Document(q.created.at(-1).content);
const mergedText = q => merged(q).plainText(BODY).split(OBJ).join('');
const rejects = async (p, re) => { await assert.rejects(p, e => (re ? re.test(e.message) : true)); };
const b64 = bytes => Buffer.from(bytes).toString('base64');

test('csv_parsing', () => {
  assert.deepEqual(parseCsv('Name,City\n"Smith, Ann",Paris\r\nBo,"Oslo ""N"""\n\n'), [['Name', 'City'], ['Smith, Ann', 'Paris'], ['Bo', 'Oslo "N"']]);
  assert.deepEqual(parseCsv('a;b\n1;2')[1], ['1', '2']);
});

test('csv_delimiter_ignores_quoted_text', () => {
  assert.deepEqual(parseCsv('"Name, first, last";City\nAnn;Paris\n'), [['Name, first, last', 'City'], ['Ann', 'Paris']]);
});

test('finishing_a_merge_opens_a_new_document_with_a_new_history (#4001)', async () => {
  const q = await s('Hello');
  await q.run('text.insert', {text: '!'});
  await q.run('caret.docStart');
  await q.run('mailings.recipients', {rows: [{Name: 'Ada'}]});
  const r = await q.run('mailings.finish');
  assert.equal(r.records, 1);
  assert.equal(q.created.at(-1).kind, 'quill');
  assert.equal(mergedText(q), '!Hello');
  assert.equal(body(q.t), '!Hello', 'the open document is not replaced');
});

test('finishing_a_merge_to_a_file_is_not_an_edit (#4004)', async () => {
  const q = await s('Hello');
  await q.run('text.insert', {text: '!'});
  await q.run('mailings.recipients', {rows: [{Name: 'Ada'}]});
  const depth = q.t.doc.undo.size, dirty = q.t.doc.dirty, text = body(q.t);
  const r = await q.run('mailings.finish', {path: 'C:/tmp/merged.docx'});
  assert.equal(r.path, 'C:/tmp/merged.docx');
  assert.equal(q.created.at(-1).written, true);
  assert.equal(q.created.at(-1).mode, 'copy');
  assert.equal(q.created.at(-1).bind, false);
  assert.equal(body(q.t), text);
  assert.equal(q.t.doc.undo.size, depth);
  assert.equal(q.t.doc.dirty, dirty);
});

test('merge_field_types_ignore_case', async () => {
  assert.equal(mergefieldName(' mergefield City '), 'City');
  assert.equal(mergefieldName('MergeField "First Name"'), 'First Name');
  assert.equal(mergefieldName('MERGEFIELD"City"'), 'City');
  assert.equal(mergefieldName('MERGEFIELDX City'), null);
  assert.equal(placeholder('mergefield City'), '«City»');
  assert.equal(placeholder('if { mergefield City } = "x" "y" "z"'), '');
  const q = await s();
  await q.run('mailings.recipients', {rows: [{Name: 'Alpha'}, {Name: 'Beta'}]});
  await q.run('mailings.start', {kind: 'directory'});
  await q.run('insert.field', {instr: 'mergefield Name', result: ''});
  await q.run('insert.field', {instr: 'if { mergefield Name } = "Beta" " (b)" ""', result: ''});
  await q.run('mailings.finish');
  assert.equal(mergedText(q), 'Alpha\nBeta (b)');
});

test('an_if_on_another_field_is_not_a_merge_rule', async () => {
  const other = 'IF { PAGE } = "mergefield" "yes" "no"';
  assert.equal(placeholder(other), null);
  assert.equal(placeholder('IF { PAGE } = { MERGEFIELD City } "yes" "no"'), null);
  assert.equal(placeholder('IF { MERGEFIELD City } = "mergefield" "yes" "no"'), '');
  const q = await s();
  await q.run('mailings.recipients', {rows: [{Name: 'Alpha'}]});
  await q.run('mailings.start', {kind: 'directory'});
  await q.run('insert.field', {instr: 'mergefield Name', result: ''});
  await q.run('insert.field', {instr: other, result: ' kept'});
  await q.run('mailings.finish');
  assert.equal(mergedText(q), 'Alpha kept');
});

test('merge_end_to_end', async () => {
  const q = await s();
  await q.run('mailings.recipients', {csv: 'First Name,Last Name,City\nAda,Lovelace,London\nAlan,Turing,Wilmslow'});
  await q.run('mailings.greetingLine');
  await q.run('text.newParagraph');
  await q.run('text.insert', {text: 'See you in '});
  await q.run('mailings.insertField', {field: 'City'});
  assert.ok(body(q.t).includes('«City»'));
  await q.run('mailings.preview', {value: true});
  assert.ok(body(q.t).includes('Dear Ada Lovelace,'));
  await q.run('mailings.next');
  assert.ok(body(q.t).includes('Wilmslow'));
  assert.equal((await q.run('mailings.checkErrors')).ok, true);
  const r = await q.run('mailings.finish');
  assert.equal(r.records, 2);
  const t = mergedText(q);
  assert.ok(t.includes('See you in London') && t.includes('Dear Alan Turing,'), t);
  // The letters are separated by a page break.
  assert.ok(t.includes('\u000C') || merged(q).story(BODY).len() > 2);
});

async function xlsxFixture(sheets) {
  const z = new JSZip();
  z.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  z.file('xl/workbook.xml', `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map(([n], i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  z.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId98" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  const strings = [];
  const sst = t => { let i = strings.indexOf(t); if (i < 0) { strings.push(t); i = strings.length - 1; } return i; };
  sheets.forEach(([, rows], i) => z.file(`xl/worksheets/sheet${i + 1}.xml`, `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => (c === '' ? '' : typeof c === 'number'
    ? `<c r="${String.fromCharCode(65 + ci)}${ri + 1}"${c.date ? ' s="1"' : ''}><v>${c}</v></c>`
    : `<c r="${String.fromCharCode(65 + ci)}${ri + 1}" t="s"><v>${sst(c)}</v></c>`)).join('')}</row>`).join('')}</sheetData></worksheet>`));
  z.file('xl/sharedStrings.xml', `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map(t => `<si><t>${t}</t></si>`).join('')}</sst>`);
  z.file('xl/styles.xml', '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>');
  return z.generateAsync({type: 'uint8array'});
}

test('recipients_from_a_workbook_ask_for_the_sheet_when_there_are_several (#334)', async () => {
  const book = await xlsxFixture([['Notes', [['n']]], ['Guests', [['Name', '', 'Name'], ['Ada', 'London', 'A'], ['Alan', 'Wilmslow', 'B']]]]);
  const q = await s();
  const data = b64(book);
  // Two sheets and none chosen: the names come back and nothing loads.
  assert.deepEqual(await q.run('mailings.recipients', {data, path: 'g.xlsx'}), {sheets: ['Notes', 'Guests'], chooseSheet: true});
  assert.equal(q.t.state('mailings.editRecipients').enabled, false, 'nothing loaded');
  const r = await q.run('mailings.recipients', {data, path: 'g.xlsx', sheet: 'guests'});
  assert.deepEqual(r, {fields: ['Name', 'Column 2', 'Name 2'], records: 2, sheet: 'Guests'});
  assert.deepEqual((await q.run('mailings.editRecipients', {})).rows[1], ['Alan', 'Wilmslow', 'B']);
  // Without a header row every row is a record.
  const h = await q.run('mailings.recipients', {data, path: 'g.xlsx', sheet: 2, headers: false});
  assert.deepEqual(h.fields, ['Column 1', 'Column 2', 'Column 3']);
  assert.equal(h.records, 3);
  await rejects(q.run('mailings.recipients', {data, path: 'g.xlsx', sheet: 3}));
  await rejects(q.run('mailings.recipients', {data, path: 'g.xlsx', sheet: 0}));
  await rejects(q.run('mailings.recipients', {data: '%%%'}), /base64/);
});

test('recipients from an .ods workbook and dates as ISO text', async () => {
  const cell = t => `<table:table-cell office:value-type="string"><text:p>${t}</text:p></table:table-cell>`;
  const row = cells => `<table:table-row>${cells.map(cell).join('')}</table:table-row>`;
  const content = `<office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x"><office:body><office:spreadsheet><table:table table:name="Notes">${row(['n'])}</table:table><table:table table:name="Guests">${row(['Name', '', 'Name'])}${row(['Ada', 'London', 'A'])}${row(['Alan', 'Wilmslow', 'B'])}<table:table-row><table:table-cell office:value-type="date" office:date-value="2024-03-05"><text:p>x</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="7.50"><text:p>7.5</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`;
  const z = new JSZip();
  z.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  z.file('content.xml', content);
  const data = b64(await z.generateAsync({type: 'uint8array'}));
  const q = await s();
  assert.deepEqual(await q.run('mailings.recipients', {data}), {sheets: ['Notes', 'Guests'], chooseSheet: true});
  const r = await q.run('mailings.recipients', {data, sheet: 'guests'});
  assert.deepEqual(r, {fields: ['Name', 'Column 2', 'Name 2'], records: 3, sheet: 'Guests'});
  assert.deepEqual((await q.run('mailings.editRecipients', {})).rows[2], ['2024-03-05', '7.5', '']);
});

test('an xlsx date cell is read as an ISO date (sheet.rs date formats)', async () => {
  const q = await s();
  // 45356 = 2024-03-05 in the 1900 system.
  const book = await xlsxFixture([['S', [['When', 'N'], [45356, 3]]]]);
  const z = await JSZip.loadAsync(book);
  const sheetXml = await z.file('xl/worksheets/sheet1.xml').async('string');
  z.file('xl/worksheets/sheet1.xml', sheetXml.replace('<c r="A2">', '<c r="A2" s="1">'));
  const out = await z.generateAsync({type: 'uint8array'});
  await q.run('mailings.recipients', {data: b64(out), path: 'd.xlsx'});
  assert.deepEqual((await q.run('mailings.editRecipients', {})).rows[0], ['2024-03-05', '3']);
});

test('an .xls workbook is refused with a message', async () => {
  const q = await s();
  const xls = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 1]);
  await rejects(q.run('mailings.recipients', {path: 'a.xls', data: b64(xls)}), /\.xls/);
  assert.ok(!RECIPIENT_EXTENSIONS.includes('xls'));
  assert.ok(isSpreadsheetName('a.XLSX') && isSpreadsheetName('b.ods') && !isSpreadsheetName('c.csv'));
  // A CSV named .xls reads as text; an HTML page named .xls says what it is.
  const r = await q.run('mailings.recipients', {path: 'export.xls', data: b64(Buffer.from('Name\tCity\nAda\tLondon\n'))});
  assert.deepEqual(r.fields, ['Name', 'City']);
  await rejects(q.run('mailings.recipients', {path: 'export.xls', data: b64(Buffer.from('<html><table><tr><td>x</td></tr></table></html>'))}), /web page/);
  await rejects(q.run('mailings.recipients', {path: 'export.xls', data: b64(Buffer.from('<?xml version="1.0"?><Workbook/>'))}), /XML spreadsheet/);
});

test('recipients_from_fields_and_array_rows', async () => {
  const q = await s();
  const r = await q.run('mailings.recipients', {fields: ['Last Name', ' City ', 'Age'], rows: [['Lovelace', 'London', 36], ['Turing'], 7]});
  assert.deepEqual(r, {fields: ['Last Name', 'City', 'Age'], records: 2});
  assert.deepEqual((await q.run('mailings.editRecipients', {})).rows, [['Lovelace', 'London', '36'], ['Turing', '', '']]);
  // Objects follow `fields` too; missing and null cells are blank.
  await q.run('mailings.editRecipients', {fields: ['Name', 'City'], rows: [{City: 'Paris', Name: null}]});
  const e = await q.run('mailings.editRecipients', {});
  assert.deepEqual([e.headers, e.rows], [['Name', 'City'], [['', 'Paris']]]);
  // Array rows need the field names.
  await rejects(q.run('mailings.recipients', {rows: [['Ada']]}), /fields/);
});

test('merge_kinds_and_edit_list_needs_recipients', async () => {
  const q = await s();
  for (const k of MERGE_KINDS) assert.deepEqual(await q.run('mailings.start', {kind: k}), {kind: k});
  assert.deepEqual(await q.run('mailings.start', {kind: ' Directory '}), {kind: 'directory'});
  await rejects(q.run('mailings.start', {kind: 'fax'}));
  assert.equal(q.t.content.settings.mailMerge.kind, 'directory', 'a rejected kind leaves the current one');
  await q.run('mailings.start', {kind: 'normal'});
  assert.equal(q.t.content.settings.mailMerge, null);
  await rejects(q.run('mailings.editRecipients', {}), /recipients first/i);
  await q.run('mailings.recipients', {csv: 'Name\nAda'});
  assert.deepEqual(await q.run('mailings.editRecipients', {}), {headers: ['Name'], rows: [['Ada']], records: 1, rules: [], sort: []});
});

async function mergedWith(rule, rows) {
  const q = await s();
  await q.run('mailings.recipients', {rows});
  await q.run('mailings.start', {kind: 'directory'});
  if (rule) await q.run('mailings.rules', rule);
  await q.run('mailings.insertField', {field: 'Name'});
  await q.run('mailings.finish');
  return mergedText(q);
}

test('skipif_drops_matching_records (#427)', async () => {
  const rows = [{Name: 'Alpha', Skip: 'yes'}, {Name: 'Beta', Skip: 'no'}];
  const skip = v => ({rule: 'SKIPIF', field: 'Skip', value: v});
  assert.equal(await mergedWith(skip('yes'), rows), 'Beta');
  assert.equal(await mergedWith(skip('no'), rows), 'Alpha');
  assert.equal(await mergedWith(skip('absent'), rows), 'Alpha\nBeta');
  assert.equal(await mergedWith(null, rows), 'Alpha\nBeta');
  assert.equal(await mergedWith(skip('yes'), [{Name: 'Alpha', Skip: 'yes'}, {Name: 'Beta', Skip: 'yes'}]), '');
});

test('next_record_advances_following_fields (#428)', async () => {
  const q = await s();
  await q.run('mailings.recipients', {rows: [{Name: 'Alpha'}, {Name: 'Beta'}, {Name: 'Gamma'}]});
  await q.run('mailings.start', {kind: 'directory'});
  await q.run('mailings.insertField', {field: 'Name'});
  await q.run('text.insert', {text: ' / '});
  await q.run('mailings.rules', {rule: 'NEXT'});
  await q.run('mailings.insertField', {field: 'Name'});
  await q.run('mailings.preview', {value: true});
  assert.equal(body(q.t), 'Alpha / Beta');
  await q.run('mailings.finish');
  // Gamma has no record after it: NEXT past the end leaves the field blank.
  assert.equal(mergedText(q), 'Alpha / Beta\nGamma / ');
});

test('record_navigation_and_merge_ranges (#3028)', async () => {
  const names = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  const fresh = async () => {
    const q = await s();
    await q.run('mailings.recipients', {rows: names.map(Name => ({Name}))});
    await q.run('mailings.start', {kind: 'directory'});
    await q.run('mailings.insertField', {field: 'Name'});
    return q;
  };
  let q = await fresh();
  assert.deepEqual(await q.run('mailings.last'), {record: 4, of: 4});
  assert.equal(body(q.t), 'Delta');
  assert.equal((await q.run('mailings.first')).record, 1);
  assert.equal(body(q.t), 'Alpha');
  assert.equal((await q.run('mailings.goToRecord', {record: 3})).record, 3);
  assert.equal(body(q.t), 'Gamma');
  assert.equal((await q.run('mailings.goToRecord', {record: ' 2 '})).record, 2);
  assert.equal((await q.run('mailings.goToRecord', {record: 1141})).record, 4);
  assert.equal((await q.run('mailings.goToRecord', {record: -5})).record, 1);
  for (const bad of [{}, {record: 'two'}, {record: 2.5}]) await rejects(q.run('mailings.goToRecord', bad));
  await q.run('mailings.goToRecord', {record: 3});
  assert.equal((await q.run('mailings.finish', {records: 'current'})).records, 1);
  assert.equal(mergedText(q), 'Gamma');
  q = await fresh();
  assert.equal((await q.run('mailings.finish', {from: 2, to: 3})).records, 2);
  assert.equal(mergedText(q), 'Beta\nGamma');
  q = await fresh();
  assert.equal((await q.run('mailings.finish', {records: 'all', from: 3, to: 99})).records, 2);
  assert.equal(mergedText(q), 'Gamma\nDelta');
  // An empty range is refused and nothing is made.
  q = await fresh();
  for (const bad of [{from: 3, to: 2}, {from: 5}, {records: 'some'}]) await rejects(q.run('mailings.finish', bad));
  assert.equal(q.created.length, 0);
  await rejects(q.run('mailings.finish', {from: 5}), /no records from 5 to 4 \(the list has 4\)/);
});

test('if_rule_previews_its_result (#429)', async () => {
  const q = await s();
  await q.run('mailings.recipients', {rows: [{Name: 'Alpha', Flag: 'yes'}, {Name: 'Beta', Flag: 'no'}]});
  await q.run('mailings.start', {kind: 'directory'});
  await q.run('mailings.rules', {rule: 'IF', field: 'Flag', value: 'yes', then: 'Selected', else: 'Other'});
  await q.run('mailings.preview', {value: true});
  assert.equal(body(q.t), 'Selected');
  await q.run('mailings.next');
  assert.equal(body(q.t), 'Other');
  await q.run('mailings.previous');
  assert.equal(body(q.t), 'Selected');
  await q.run('mailings.finish');
  assert.equal(mergedText(q), 'Selected\nOther');
});

test('header_and_footer_fields_merge (#430)', async () => {
  const q = await s();
  await q.run('mailings.recipients', {rows: [{Name: 'Alpha'}, {Name: 'Beta'}]});
  const hdr = (await q.run('insert.header', {text: 'Recipient: '})).story ?? Number(Object.keys(q.t.content.parts)[0]);
  await q.run('caret.docEnd');
  await q.run('mailings.insertField', {field: 'Name'});
  await q.run('insert.closeHeader');
  await q.run('text.insert', {text: 'Body: '});
  await q.run('mailings.insertField', {field: 'Name'});
  const header = id => new Document(q.t.content).plainText(id).split(OBJ).join('');
  const id = Number(Object.keys(q.t.content.parts).find(k => q.t.content.parts[k].kind === 'header'));
  void hdr;
  await q.run('mailings.preview', {value: true});
  assert.equal(header(id), 'Recipient: Alpha');
  await q.run('mailings.preview', {value: false});
  assert.equal(header(id), 'Recipient: «Name»');
  await q.run('mailings.finish');
  assert.equal(mergedText(q), 'Body: Alpha\nBody: Beta');
  const d = merged(q);
  const secs = d.sections();
  assert.equal(secs.length, 2, 'one section per letter');
  const texts = secs.map(([, sp]) => d.plainText(sp.headers.default).split(OBJ).join(''));
  assert.deepEqual(texts, ['Recipient: Alpha', 'Recipient: Beta']);
  assert.ok(!(id in d.content.parts), 'the template header is replaced by the letters\' copies');
});

test('label_and_envelope_text_is_capped', async () => {
  const q = await s();
  const long = 'x'.repeat(2001);
  await rejects(q.run('mailings.labels', {text: long}), /longer than/);
  await rejects(q.run('mailings.envelopes', {delivery: long}), /longer than/);
  await rejects(q.run('mailings.envelopes', {return: long}), /longer than/);
  await q.run('mailings.labels', {text: 'x'.repeat(2000), rows: 40, cols: 10});
});

test('envelopes_and_labels', async () => {
  const q = await s();
  await q.run('mailings.envelopes', {delivery: 'Jo Doe\n1 Main St'});
  const env = merged(q);
  assert.ok(env.c.lastSection.pageW > env.c.lastSection.pageH);
  await q.run('mailings.labels', {text: 'Hello'});
  assert.equal(mergedText(q).split('Hello').length - 1, 30);
});

test('envelope_sizes_add_to_document_and_label_products (#407)', async () => {
  const q = await s('Dear Jo,');
  const r = await q.run('mailings.envelopes', {delivery: 'Jo Doe\n1 Main St', return: 'Me', size: 'C5', add: true});
  assert.deepEqual([Math.round(r.width), Math.round(r.height)], [649, 459]);
  const d = new Document(q.t.content);
  const secs = d.sections();
  assert.equal(secs.length, 2, 'an envelope section of its own');
  assert.ok(secs[0][1].landscape && Math.abs(secs[0][1].pageW - 649.1) < 0.1);
  const text = d.plainText(BODY);
  assert.ok(text.startsWith('Me') && text.includes('1 Main St') && text.trimEnd().endsWith('Dear Jo,'), text);
  await rejects(q.run('mailings.envelopes', {size: 'Envelope X'}));
  const l = await q.run('mailings.labels', {text: 'Ada', product: 'a4-2x7'});
  assert.equal(l.labels, 14);
  let doc = merged(q);
  assert.ok(Math.abs(doc.c.lastSection.pageW - 595.3) < 0.1, 'A4 sheet');
  let t = doc.story(BODY).get(0);
  assert.deepEqual([t.rows.length, t.grid.length], [7, 3], 'two label columns and the gap between');
  assert.equal(mergedText(q).split('Ada').length - 1, 14);
  const one = await q.run('mailings.labels', {text: 'Bo', product: 'letter-3x10', single: {row: 2, col: 3}});
  assert.equal(one.filled, 1);
  doc = merged(q);
  t = doc.story(BODY).get(0);
  // Row 2, column 3 (grid column 5: label, gap, label, gap, label).
  assert.equal(t.rows[1].cells[4].blocks[0].text, 'Bo');
  await rejects(q.run('mailings.labels', {product: 'nope'}));
});

test('recipient lists in other encodings: UTF-16 and Windows-1252', async () => {
  const q = await s();
  const u16 = [0xff, 0xfe];
  for (const u of '姓名\t城市\r\n张三\t北京\r\n') u16.push(u.charCodeAt(0) & 255, u.charCodeAt(0) >> 8);
  await q.run('mailings.recipients', {path: 'list.txt', data: b64(u16)});
  const e = await q.run('mailings.editRecipients', {});
  assert.deepEqual([e.headers, e.rows], [['姓名', '城市'], [['张三', '北京']]]);
  await q.run('mailings.recipients', {data: b64([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x4a, 0x6f, 0x73, 0xe9, 0x0a])});
  assert.deepEqual((await q.run('mailings.editRecipients', {})).rows, [['José']]);
  // An explicit encoding wins over detection; an unknown one is a params error.
  await q.run('mailings.recipients', {data: b64([0x96, 0xbc, 0x91, 0x4f, 0x0a, 0x93, 0x63, 0x92, 0x86, 0x0a]), encoding: 'shift_jis'});
  assert.deepEqual((await q.run('mailings.editRecipients', {})).rows, [['田中']]);
  await rejects(q.run('mailings.recipients', {data: b64([0x41]), encoding: 'klingon'}), /encoding/);
});

async function people() {
  const q = await s();
  await q.run('mailings.recipients', {csv: 'Name,City,Age,Email\nAda,London,36,ada@x.org\nAlan,Wilmslow,41,\nGrace,New York,85,grace@navy.mil\nKatherine,Hampton,101,\nLinus,Helsinki,9,linus@kernel.org'});
  return q;
}
const names = async q => (await q.run('mailings.editRecipients', {})).rows;
const merging = async q => { const e = await q.run('mailings.editRecipients', {}); const f = await q.run('mailings.filterRecipients', {rules: e.rules, sort: e.sort}); void f; return e; };
const filter = async (q, rules) => { await q.run('mailings.filterRecipients', {rules}); await q.run('mailings.first'); return q.t.session.get(q.t.docId).view.merge.rows.map(r => r[0]); };

test('filter_recipients_comparisons_and_joins (#778)', async () => {
  const q = await people();
  assert.deepEqual(await filter(q, [{field: 'city', op: 'equal', value: 'london'}]), ['Ada']);
  assert.deepEqual(await filter(q, [{field: 'City', op: '<>', value: 'London'}]), ['Alan', 'Grace', 'Katherine', 'Linus']);
  // 9 < 36 as numbers, though "9" > "36" as text.
  assert.deepEqual(await filter(q, [{field: 'Age', op: 'less', value: '36'}]), ['Linus']);
  assert.deepEqual(await filter(q, [{field: 'Age', op: 'greater', value: '41'}]), ['Grace', 'Katherine']);
  assert.deepEqual(await filter(q, [{field: 'Age', op: 'lessOrEqual', value: 36}]), ['Ada', 'Linus']);
  assert.deepEqual(await filter(q, [{field: 'Age', op: '>=', value: '85'}]), ['Grace', 'Katherine']);
  assert.deepEqual(await filter(q, [{field: 'Email', op: 'blank'}]), ['Alan', 'Katherine']);
  assert.deepEqual(await filter(q, [{field: 'Email', op: 'isNotBlank'}]), ['Ada', 'Grace', 'Linus']);
  assert.deepEqual(await filter(q, [{field: 'Email', op: 'contains', value: '.ORG'}]), ['Ada', 'Linus']);
  assert.deepEqual(await filter(q, [{field: 'Email', op: 'doesNotContain', value: 'org'}]), ['Alan', 'Grace', 'Katherine']);
  // And binds tighter than Or: (Email blank And Age > 50) Or City = London.
  assert.deepEqual(await filter(q, [{field: 'Email', op: 'blank'}, {field: 'Age', op: 'greater', value: '50', join: 'and'}, {field: 'City', op: 'equal', value: 'London', join: 'or'}]),
    ['Ada', 'Katherine']);
  const r = await q.run('mailings.filterRecipients', {rules: [{field: 'Age', op: 'less', value: 50}, {field: 'City', op: 'contains', value: 'on', join: 'and'}]});
  assert.equal(r.records, 1);
  assert.equal(r.of, 5);
  assert.deepEqual(r.rules[1], {field: 'City', op: 'contains', value: 'on', join: 'and'});
  assert.equal((await q.run('mailings.filterRecipients', {})).records, 5);
  await filter(q, [{field: 'City', op: 'equal', value: 'Hampton'}]);
  for (const bad of [{rules: [{field: 'Nope', op: 'equal', value: 'x'}]}, {rules: [{field: 'City', op: 'resembles', value: 'x'}]}, {rules: [{field: 'City', join: 'xor'}]},
    {rules: [{op: 'equal'}]}, {rules: 'City = London'}, {rules: [], sort: [{field: 'Nope'}]}]) await rejects(q.run('mailings.filterRecipients', bad));
  assert.deepEqual(q.t.session.get(q.t.docId).view.merge.rows.map(r => r[0]), ['Katherine']);
  // Loading another list clears the filter.
  await q.run('mailings.recipients', {csv: 'Name\nA\nB'});
  assert.deepEqual(q.t.session.get(q.t.docId).view.merge.rows.map(r => r[0]), ['A', 'B']);
  assert.deepEqual(q.t.session.get(q.t.docId).view.merge.filter, []);
});

const shown = q => q.t.session.get(q.t.docId).view.merge.rows.map(r => r[0]);

test('sort_recipients (#778)', async () => {
  const q = await people();
  await q.run('mailings.sortRecipients', {field: 'Age', descending: true});
  assert.deepEqual(shown(q), ['Katherine', 'Grace', 'Alan', 'Ada', 'Linus']);
  await q.run('mailings.sortRecipients', {sort: [{field: 'Email'}, {field: 'Name', descending: true}]});
  assert.deepEqual(shown(q), ['Katherine', 'Alan', 'Ada', 'Grace', 'Linus']);
  // Filter and sort together; a filter call without `sort` keeps the sort.
  await q.run('mailings.filterRecipients', {rules: [{field: 'Age', op: 'greater', value: 20}], sort: [{field: 'City'}]});
  assert.deepEqual(shown(q), ['Katherine', 'Ada', 'Grace', 'Alan']);
  await q.run('mailings.filterRecipients', {rules: [{field: 'Age', op: 'less', value: 90}]});
  assert.deepEqual(shown(q), ['Linus', 'Ada', 'Grace', 'Alan']);
  await q.run('mailings.sortRecipients', {});
  assert.deepEqual(shown(q), ['Ada', 'Alan', 'Grace', 'Linus']);
  // Edit Recipient List shows every record, and editing keeps the filter.
  const r = await q.run('mailings.editRecipients', {});
  assert.equal(r.rows.length, 5);
  assert.equal(r.records, 4);
  await q.run('mailings.editRecipients', {fields: ['Name', 'City', 'Age', 'Email'], rows: [...r.rows, ['Margaret', 'Boston', '88', '']]});
  assert.deepEqual(shown(q), ['Ada', 'Alan', 'Grace', 'Linus', 'Margaret']);
  assert.equal(q.t.session.get(q.t.docId).view.merge.filter.length, 1);
  // Removing the filtered field drops its rule.
  await q.run('mailings.editRecipients', {fields: ['Name'], rows: [['X'], ['Y']]});
  assert.deepEqual(q.t.session.get(q.t.docId).view.merge.filter, []);
  assert.deepEqual(shown(q), ['X', 'Y']);
});

test('failed_edit_recipients_keeps_filter_and_sort (#1287)', async () => {
  const q = await people();
  await q.run('mailings.filterRecipients', {rules: [{field: 'Age', op: 'greater', value: 20}], sort: [{field: 'City'}]});
  const before = shown(q);
  await rejects(q.run('mailings.editRecipients', {rows: [['X', 'Y']]}), /fields/);
  const m = q.t.session.get(q.t.docId).view.merge;
  assert.equal(m.filter.length, 1);
  assert.equal(m.sort.length, 1);
  assert.deepEqual(shown(q), before);
  assert.equal((await q.run('mailings.editRecipients', {})).rules.length, 1);
});

test('sort_mixed_number_and_text_column (#885)', () => {
  const headers = ['Id'];
  const rows = vals => vals.map(v => [v]);
  const sorted = (r, desc) => selectRecords(headers, r, [], [{field: 'Id', descending: desc}]).map(i => r[i][0]);
  let r = rows(['1a', '9', '10', 'b', '2']);
  assert.deepEqual(sorted(r, false), ['2', '9', '10', '1a', 'b']);
  assert.deepEqual(sorted(r, true), ['b', '1a', '10', '9', '2']);
  r = rows(['x', '1', 'X', '1.0', '']);
  assert.deepEqual(sorted(r, false), ['1', '1.0', '', 'x', 'X']);
  const vals = Array.from({length: 400}, (_, i) => [`${(i * 37) % 101}`, `${(i * 13) % 17}a`, `${(i * 7) % 23}`, `Z${i % 11}`][i % 4]);
  const out = sorted(rows(vals), false);
  for (let i = 1; i < out.length; i++) assert.ok(compareCells(out[i - 1], out[i]) <= 0);
});

test('merge_uses_only_filtered_records_in_sort_order (#778)', async () => {
  let q = await people();
  await q.run('mailings.insertField', {field: 'Name'});
  await q.run('mailings.filterRecipients', {rules: [{field: 'Email', op: 'notBlank'}], sort: [{field: 'Age', descending: true}]});
  await q.run('mailings.preview', {value: true});
  assert.ok(body(q.t).includes('Grace'));
  await q.run('mailings.next');
  assert.ok(body(q.t).includes('Ada'));
  assert.equal((await q.run('mailings.next')).of, 3);
  await rejects(q.run('mailings.findRecipient', {text: 'Alan'}), /no matching recipient/);
  const r = await q.run('mailings.finish');
  assert.equal(r.records, 3);
  const t = mergedText(q);
  const [g, a, l] = ['Grace', 'Ada', 'Linus'].map(n => t.indexOf(n));
  assert.ok(g < a && a < l, t);
  assert.ok(!t.includes('Alan') && !t.includes('Katherine'), t);
  q = await people();
  await q.run('mailings.filterRecipients', {rules: [{field: 'City', op: 'equal', value: 'Atlantis'}]});
  await rejects(q.run('mailings.finish'), /recipients first/i);
  assert.equal((await q.run('mailings.editRecipients', {})).rows.length, 5);
});

test('merging helper stays quiet', async () => { void names; void merging; });
