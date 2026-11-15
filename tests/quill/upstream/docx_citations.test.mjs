// Ported from wordcraft crates/docx at aadb077e072b7de05f724e359d8db82e151f125c:
//   tests/it/citations.rs            citation-manager documents (Zotero ADDIN fields, custom properties)
//   src/bibliography.rs (mod tests)  Word `Sources.xml` / `b:Sources` reading
//   tests/it/roundtrip.rs            bibliography_sources_round_trip
// Each test names the Rust test it ports.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: ADDIN fields keep their formatted, multi-paragraph results and custom document
//    properties round-trip; a bibliography's sources read from its `b:Sources` custom XML part (or a
//    Word `Sources.xml`, either namespace) and are written back as customXml/item1.xml with its
//    itemProps1.xml. Word's References > Manage Sources reads and writes the same part.
// 2. Ours: core/quill/formats/_docx-bibliography.mjs (readSources, bibliographyXml) and
//    docx-read.mjs / docx-write.mjs over the schema-2 model (content.sources, settings.bibStyle);
//    the same assertions on the same values (UTF-16 offsets; paths are arrays).
// 3. These tests (engine). Manage Sources > Browse calls readSources.
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {read, DocxError} from '../../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../../core/quill/formats/docx-write.mjs';
import {readSources} from '../../../core/quill/formats/_docx-bibliography.mjs';
import {contentFromText, createContent, source} from '../../../core/quill/model/content.mjs';
import {Document, BODY} from '../../../core/quill/model/document.mjs';
import * as P from '../../../core/quill/model/para.mjs';

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const ROOT_RELS = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>';

const CITE_A = ' ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"k1","properties":{"formattedCitation":"(Doe, 2020)"},';
const CITE_B = '"citationItems":[{"id":7,"uris":["http://zotero.org/users/local/x/items/ABCD"]}]} ';
const BIBL = ' ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY ';

const enc = s => (typeof s === 'string' ? new TextEncoder().encode(s) : s);
async function zip(entries) { const z = new JSZip(); for (const [n, b] of entries) z.file(n, enc(b)); return z.generateAsync({type: 'uint8array'}); }
async function unzip(bytes) { const z = await JSZip.loadAsync(bytes); const out = {}; for (const n of Object.keys(z.files)) if (!z.files[n].dir) out[n] = await z.file(n).async('string'); return out; }

const fld = kind => `<w:r><w:fldChar w:fldCharType="${kind}"/></w:r>`;
const instr = s => `<w:r><w:instrText xml:space="preserve">${s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')}</w:instrText></w:r>`;
const t = s => `<w:r><w:t xml:space="preserve">${s}</w:t></w:r>`;
const ti = s => `<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">${s}</w:t></w:r>`;

function customXml() {
  const p = (pid, name, v) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${pid}" name="${name}">${v}</property>`;
  return `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${
    p(2, 'ZOTERO_PREF_1', '<vt:lpwstr>&lt;data data-version="3"&gt;&lt;session id="abc"/&gt;</vt:lpwstr>')}${
    p(3, 'ZOTERO_PREF_2', '<vt:lpwstr>&lt;style id="http://www.zotero.org/styles/apa"/&gt;&lt;/data&gt;</vt:lpwstr>')}${
    p(4, 'Pages', '<vt:i4>12</vt:i4>')}${
    p(5, 'Tags', '<vt:vector size="2" baseType="lpwstr"><vt:lpwstr>a</vt:lpwstr><vt:lpwstr>b &amp; c</vt:lpwstr></vt:vector>')}</Properties>`;
}

const pkg = body => zip([['_rels/.rels', ROOT_RELS], ['word/document.xml', `<w:document ${W_NS}><w:body>${body}</w:body></w:document>`], ['docProps/custom.xml', customXml()]]);

/** A cited sentence, a PAGE field, and a bibliography spanning two paragraphs. */
function zoteroDocx() {
  const p0 = `<w:p>${[t('See '), fld('begin'), instr(CITE_A), instr(CITE_B), fld('separate'), t('(Doe, '), ti('2020'), t(')'), fld('end'), t('. Page '),
    fld('begin'), instr('PAGE'), fld('separate'), t('1'), fld('end')].join('')}</w:p>`;
  const p1 = `<w:p>${fld('begin')}${instr(BIBL)}${fld('separate')}${t('Doe, J. (2020). ')}${ti('A Title')}</w:p>`;
  const p2 = `<w:p>${t('Roe, R. (2019). Other.')}${fld('end')}</w:p>`;
  const p3 = `<w:p>${t('After')}</w:p>`;
  return pkg(`${p0}${p1}${p2}${p3}`);
}

const doc = c => new Document(c);
const blocksOf = d => d.content.body.chunks.flat();
const paraText = (d, i) => { const b = blocksOf(d)[i]; return b?.kind === 'para' ? P.plainText(b) : ''; };
function italicAt(d, i, needle) {
  const p = blocksOf(d)[i];
  const off = p.text.indexOf(needle);
  return P.propsOfChar(p, off).italic === true;
}

function checkZotero(d) {
  assert.equal(paraText(d, 0), 'See (Doe, 2020). Page 1');
  assert.equal(paraText(d, 1), 'Doe, J. (2020). A Title');
  assert.equal(paraText(d, 2), 'Roe, R. (2019). Other.');
  assert.equal(paraText(d, 3), 'After');
  // The result keeps its formatting.
  assert.ok(italicAt(d, 0, '2020'));
  assert.ok(!italicAt(d, 0, '(Doe'));
  assert.ok(italicAt(d, 1, 'A Title'));

  const r = d.fieldRanges(BODY);
  assert.equal(r.length, 2, JSON.stringify(r));
  assert.equal(r[0].instr, `${CITE_A}${CITE_B}`.trim());
  assert.deepEqual(r[0].start.path, [0]);
  assert.deepEqual(r[0].end.path, [0]);
  assert.equal(r[1].instr, BIBL.trim());
  assert.deepEqual([r[1].start.path, r[1].start.off], [[1], 0]);
  assert.deepEqual(r[1].end.path, [2]);
  assert.ok(!d.hasUnbalancedFieldRanges());

  // Engine fields stay atomic.
  const p0 = blocksOf(d)[0];
  assert.ok(P.objectsOf(p0).some(o => o.type === 'field' && o.instr === 'PAGE'));

  const cp = d.content.customProps;
  assert.deepEqual(cp.map(p => p.name), ['ZOTERO_PREF_1', 'ZOTERO_PREF_2', 'Pages', 'Tags']);
  assert.equal(d.customProp('ZOTERO_PREF_1'), '<data data-version="3"><session id="abc"/>');
  assert.equal(d.customProp('zotero_pref_2'), '<style id="http://www.zotero.org/styles/apa"/></data>');
  assert.deepEqual([cp[2].kind, cp[2].value], ['i4', '12']);
  assert.equal(cp[3].kind, 'raw');
  assert.ok(cp[3].value.includes('b &amp; c'));
}

const count = (xml, kind) => xml.split(`w:fldCharType="${kind}"`).length - 1;
const documentXml = async bytes => (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string');
const write = d => writeDocx(d.content);
const readDoc = async bytes => doc(await read(bytes));

// --- citations.rs -----------------------------------------------------------------------------

test('citations.rs zotero_fields_and_prefs_are_read', async () => {
  checkZotero(await readDoc(await zoteroDocx()));
});

test('citations.rs zotero_fields_and_prefs_round_trip', async () => {
  const d = await readDoc(await zoteroDocx());
  const out = await write(d);
  const xml = await documentXml(out);
  assert.equal(count(xml, 'begin'), 3);
  assert.equal(count(xml, 'separate'), 3);
  assert.equal(count(xml, 'end'), 3);
  const d2 = await readDoc(out);
  checkZotero(d2);
  assert.deepEqual(d.content.customProps, d2.content.customProps);
  // And a second generation is stable.
  assert.deepEqual((await readDoc(await write(d2))).content.customProps, d.content.customProps);
});

test('citations.rs unterminated_and_resultless_addin_fields', async () => {
  // A field left open at the end of the document, and one with no result at all.
  const body = `<w:p>${fld('begin')}${instr(' ADDIN EMPTY ')}${fld('end')}${t('x')}</w:p><w:p>${fld('begin')}${instr(BIBL)}${fld('separate')}${t('dangling')}</w:p>`;
  const d = await readDoc(await pkg(body));
  const r = d.fieldRanges(BODY);
  assert.equal(r.length, 1);
  assert.equal(r[0].instr, 'ADDIN EMPTY');
  assert.equal(paraText(d, 0), 'x');
  assert.ok(d.hasUnbalancedFieldRanges());
  const out = await write(d);
  const xml = await documentXml(out);
  assert.equal(count(xml, 'begin'), count(xml, 'end'));
  const d2 = await readDoc(out);
  assert.ok(!d2.hasUnbalancedFieldRanges());
  assert.equal(paraText(d2, 1), 'dangling');
});

test('citations.rs orphan_markers_from_editing_are_dropped_on_save', async () => {
  const c = contentFromText('one\ntwo');
  const bl = c.body.chunks.flat();
  P.insertObject(bl[0], 0, {type: 'fieldEnd'}, {});
  P.insertObject(bl[1], 1, {type: 'fieldStart', instr: 'ADDIN X', locked: true}, {});
  const d = doc(c);
  const xml = await documentXml(await write(d));
  assert.equal(count(xml, 'begin'), 0);
  assert.equal(count(xml, 'end'), 0);
  // The document itself is untouched.
  assert.ok(d.hasUnbalancedFieldRanges());
});

test('citations.rs programmatic_range_field_writes_as_word_field', async () => {
  const c = contentFromText('ab');
  const p = c.body.chunks.flat()[0];
  P.insertObject(p, 1, {type: 'fieldStart', instr: 'ADDIN ZOTERO_ITEM {}', locked: false}, {});
  const end = 1 + 1 + 1; // 1 + OBJ.len (one UTF-16 unit) + 1
  P.insertObject(p, end, {type: 'fieldEnd'}, {});
  const d = doc(c);
  d.setCustomProp('ZOTERO_PREF_1', '<data/>');
  const d2 = await readDoc(await write(d));
  const r = d2.fieldRanges(BODY);
  assert.equal(r.length, 1);
  assert.equal(r[0].instr, 'ADDIN ZOTERO_ITEM {}');
  assert.equal(paraText(d2, 0), 'ab');
  assert.equal(d2.customProp('ZOTERO_PREF_1'), '<data/>');
});

// --- bibliography.rs (mod tests) --------------------------------------------------------------

const WORD_SOURCES = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"
           xmlns="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"
           SelectedStyle="\\MLA.XSL" StyleName="MLA">
  <b:Source>
    <b:Tag>Riv21</b:Tag>
    <b:SourceType>Book</b:SourceType>
    <b:Author>
      <b:Author>
        <b:NameList>
          <b:Person><b:Last>Rivera</b:Last><b:First>Alex</b:First></b:Person>
          <b:Person><b:Last>Chen</b:Last><b:First>Mei</b:First><b:Middle>L.</b:Middle></b:Person>
        </b:NameList>
      </b:Author>
    </b:Author>
    <b:Title>Shared Spaces</b:Title>
    <b:Year>2021</b:Year>
    <b:City>Portland</b:City>
    <b:Publisher>Harbor Books</b:Publisher>
  </b:Source>
  <b:Source>
    <b:Tag>Web19</b:Tag>
    <b:SourceType>InternetSite</b:SourceType>
    <b:Author>
      <b:Author>
        <b:NameList>
          <b:Person><b:Last>Okafor</b:Last><b:First>Ada</b:First></b:Person>
        </b:NameList>
      </b:Author>
    </b:Author>
    <b:Title>Dockyards of the north</b:Title>
    <b:Year>2019</b:Year>
    <b:URL>https://example.org/docks</b:URL>
    <b:YearAccessed>2024</b:YearAccessed>
    <b:MonthAccessed>May</b:MonthAccessed>
    <b:DayAccessed>17</b:DayAccessed>
    <b:StandardNumber>10.1234/x</b:StandardNumber>
  </b:Source>
  <b:Source>
    <b:Tag>NoDate</b:Tag>
    <b:SourceType>JournalArticle</b:SourceType>
    <b:Title>Untitled notes</b:Title>
    <b:JournalName>Field Notes</b:JournalName>
    <b:Volume>4</b:Volume>
  </b:Source>
  <b:Source>
    <b:Tag>Riv21</b:Tag>
    <b:SourceType>Book</b:SourceType>
    <b:Title>A duplicate of Riv21</b:Title>
    <b:Year>2021</b:Year>
  </b:Source>
  <b:Source>
    <b:SourceType>Book</b:SourceType>
  </b:Source>
</b:Sources>`;

/** A Word `Sources.xml` (`b:Sources`): its style, the `b:Source` elements with their names, kinds and fallback fields; a repeated tag and an entry with no content at all are dropped. */
test('bibliography.rs a_word_sources_file_reads_into_sources', () => {
  const f = readSources(enc(WORD_SOURCES));
  assert.equal(f.style, 'MLA', 'the citation style comes from StyleName');
  assert.equal(f.sources.length, 3, `the repeated tag and the empty b:Source are dropped: ${f.sources.map(s => s.tag)}`);
  const book = f.sources[0];
  assert.deepEqual([book.tag, book.kind], ['Riv21', 'book']);
  assert.equal(book.author, 'Rivera, Alex; Chen, Mei L.');
  assert.equal(book.title, 'Shared Spaces', 'the first source of a repeated tag wins');
  assert.deepEqual([book.title, book.year, book.city, book.publisher], ['Shared Spaces', '2021', 'Portland', 'Harbor Books']);
  const web = f.sources[1];
  assert.equal(web.kind, 'website');
  assert.equal(web.author, 'Okafor, Ada');
  assert.equal(web.accessed, '2024-May-17', 'assemble the accessed date from its parts');
  assert.equal(web.doi, '10.1234/x', 'StandardNumber stands in for a missing DOI');
  const notes = f.sources[2];
  assert.deepEqual([notes.kind, notes.journal, notes.volume], ['article', 'Field Notes', '4']);
  // A string reads the same as its bytes (Manage Sources > Browse may hand over either).
  assert.deepEqual(readSources(WORD_SOURCES), f);
});

/** Anything whose root isn't `b:Sources` is refused, not read as an empty bibliography. */
test('bibliography.rs a_file_that_is_not_b_sources_is_an_error', () => {
  assert.throws(() => readSources(enc('<html><body>hi</body></html>')));
  assert.throws(() => readSources(enc('not xml at all')), e => e instanceof DocxError && e.kind === 'Xml');
  assert.throws(() => readSources(enc('<Sources><Source><Tag>A</Tag></Source></Sources>')), 'no namespace');
  assert.throws(() => readSources(enc('<o:Sources xmlns:o="urn:example:other"><o:Source/></o:Sources>')), 'an unrelated namespace');
});

/** Word's own 2004/10 bibliography namespace (`Sources.xml` written by scripts and older builds, the VBA `Source.XML` format) reads as well as OOXML's. */
test('bibliography.rs word_2004_bibliography_namespace_is_accepted', () => {
  const xml = enc(`<b:Sources xmlns:b="http://schemas.microsoft.com/office/word/2004/10/bibliography" StyleName="MLA">
  <b:Source><b:Tag>Riv21</b:Tag><b:SourceType>Book</b:SourceType><b:Title>Shared Spaces</b:Title><b:Year>2021</b:Year></b:Source>
</b:Sources>`);
  const f = readSources(xml);
  assert.equal(f.style, 'MLA');
  assert.equal(f.sources.length, 1);
  assert.equal(f.sources[0].tag, 'Riv21');
});

// --- roundtrip.rs bibliography_sources_round_trip -----------------------------------------------

function bibliographyDoc() {
  const c = createContent();
  c.sources.push(source({tag: 'Rivera2021', kind: 'book', author: 'Rivera, Alex; Chen, Mei', title: 'Shared Spaces', year: '2021', publisher: 'Harbor Books',
    city: 'Portland', editor: 'Johnson, Robert', edition: '2nd', month: '10', day: '15'}));
  c.sources.push(source({tag: 'Smith2023', kind: 'article', author: 'Smith, John David', title: 'Modern Typography', year: '2023', journal: 'Design Quarterly',
    volume: '12', pages: '45-60', url: 'https://example.com/typo', issue: '4', doi: '10.1000/182'}));
  c.sources.push(source({tag: 'WebSite2024', kind: 'website', author: 'Solo', title: 'Open Fonts', year: '2024', url: 'https://example.org', accessed: '2024-05-15'}));
  c.sources.push(source({tag: 'Chapter2025', kind: 'bookSection', author: 'Lee, Harper', title: 'Chapter One', year: '2025', journal: 'Anthology of Prose', pages: '1-20'}));
  c.sources.push(source({tag: 'Misc2026', kind: 'other', title: 'Archive Manuscript', year: '2026', city: 'Oxford'}));
  return c;
}

test('roundtrip.rs bibliography_sources_round_trip', async () => {
  const bytes = await writeDocx(bibliographyDoc());

  // assert_bibliography_parts
  const files = await unzip(bytes);
  assert.ok(files['customXml/item1.xml'] !== undefined);
  assert.ok(files['customXml/itemProps1.xml'] !== undefined);
  assert.ok(files['customXml/_rels/item1.xml.rels'] !== undefined);
  const relsXml = files['_rels/.rels'];
  assert.ok(relsXml.includes('relationships/customXml'), relsXml);
  assert.ok(relsXml.includes('Target="customXml/item1.xml"'), relsXml);
  const ctXml = files['[Content_Types].xml'];
  assert.ok(ctXml.includes('PartName="/customXml/item1.xml"'), ctXml);
  assert.ok(ctXml.includes('PartName="/customXml/itemProps1.xml"'), ctXml);
  const item = files['customXml/item1.xml'];
  // assert_bibliography_types
  assert.ok(item.includes('SelectedStyle="\\APA.XSL"'), item);
  assert.ok(item.includes('StyleName="APA"'), item);
  for (const st of ['Book', 'JournalArticle', 'InternetSite', 'BookSection', 'Misc']) assert.ok(item.includes(`<b:SourceType>${st}</b:SourceType>`), item);
  // assert_bibliography_people
  assert.ok(item.includes('<b:Author><b:Author><b:NameList><b:Person>'), item);
  assert.ok(item.includes('<b:Last>Rivera</b:Last><b:First>Alex</b:First>'), item);
  assert.ok(item.includes('<b:Last>Smith</b:Last><b:First>John</b:First><b:Middle>David</b:Middle>'), item);
  assert.ok(item.includes('<b:Last>Solo</b:Last>'), item);
  assert.ok(item.includes('<b:Editor>'), item);
  assert.ok(item.includes('<b:Last>Johnson</b:Last><b:First>Robert</b:First>'), item);
  // assert_bibliography_details
  for (const x of ['<b:Edition>2nd</b:Edition>', '<b:Month>10</b:Month>', '<b:Day>15</b:Day>', '<b:Issue>4</b:Issue>', '<b:DOI>10.1000/182</b:DOI>',
    '<b:YearAccessed>2024</b:YearAccessed>', '<b:MonthAccessed>05</b:MonthAccessed>', '<b:DayAccessed>15</b:DayAccessed>', '<b:Accessed>2024-05-15</b:Accessed>']) {
    assert.ok(item.includes(x), item);
  }

  // assert_bibliography_sources_round_trip
  const back = await read(bytes);
  assert.equal(back.sources.length, 5);
  const [s0, s1, s2, s3, s4] = back.sources;
  assert.deepEqual([s0.tag, s0.kind, s0.author, s0.title, s0.year, s0.publisher, s0.city, s0.editor, s0.edition, s0.month, s0.day],
    ['Rivera2021', 'book', 'Rivera, Alex; Chen, Mei', 'Shared Spaces', '2021', 'Harbor Books', 'Portland', 'Johnson, Robert', '2nd', '10', '15']);
  assert.deepEqual([s1.tag, s1.kind, s1.author, s1.title, s1.journal, s1.volume, s1.pages, s1.url, s1.issue, s1.doi],
    ['Smith2023', 'article', 'Smith, John David', 'Modern Typography', 'Design Quarterly', '12', '45-60', 'https://example.com/typo', '4', '10.1000/182']);
  assert.deepEqual([s2.tag, s2.kind, s2.author, s2.title, s2.url, s2.accessed], ['WebSite2024', 'website', 'Solo', 'Open Fonts', 'https://example.org', '2024-05-15']);
  assert.deepEqual([s3.tag, s3.kind, s3.author, s3.title, s3.journal, s3.pages], ['Chapter2025', 'bookSection', 'Lee, Harper', 'Chapter One', 'Anthology of Prose', '1-20']);
  assert.deepEqual([s4.tag, s4.kind, s4.title, s4.city], ['Misc2026', 'other', 'Archive Manuscript', 'Oxford']);
});

// --- Automation: the bibliography part and kept custom XML (keep_custom_xml) ----------------------

const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const rels = rows => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows.map(([id, kind, target]) => `<Relationship Id="${id}" Type="${RT}${kind}" Target="${target}"/>`).join('')}</Relationships>`;
const DATA = '<?xml version="1.0"?><c:customer xmlns:c="urn:original:customer"><c:name>Atlas Studios</c:name></c:customer>';

/** A file's bibliography is read into content.sources and written once: never kept as well (two `b:Sources` parts). */
test('bibliography read from a file is written once, from the model', async () => {
  const c = bibliographyDoc();
  c.settings.bibStyle = 'MLA';
  const once = await read(await writeDocx(c));
  assert.equal(once.settings.bibStyle, 'MLA');
  assert.equal(once.sources.length, 5);
  assert.ok(!Object.keys(once.passthrough).some(k => k.startsWith('customXml/')), Object.keys(once.passthrough).join(' '));
  const files = await unzip(await writeDocx(once));
  const sources = Object.entries(files).filter(([, v]) => v.includes('<b:Sources'));
  assert.deepEqual(sources.map(([n]) => n), ['customXml/item1.xml']);
  assert.ok(files['customXml/item1.xml'].includes('StyleName="MLA"') && files['customXml/item1.xml'].includes('SelectedStyle="\\MLA.XSL"'));
  assert.equal((await read(await writeDocx(once))).sources.length, 5);
});

/** A kept custom XML store named item1 keeps its name and its data; the bibliography takes item2 (upstream renames the store to item1_2). */
test('bibliography part does not shadow a kept custom XML store', async () => {
  const bytes = await zip([
    ['_rels/.rels', rels([['office', 'officeDocument', 'word/document.xml']])],
    ['word/document.xml', `<w:document ${W_NS}><w:body><w:p><w:r><w:t>Text.</w:t></w:r></w:p></w:body></w:document>`],
    ['word/_rels/document.xml.rels', rels([['data', 'customXml', '../customXml/item1.xml']])],
    ['customXml/item1.xml', DATA],
  ]);
  const c = await read(bytes);
  assert.equal(c.sources.length, 0);
  c.sources.push(source({tag: 'OriginalSource', title: 'Original synthetic reference'}));
  const files = await unzip(await writeDocx(c));
  assert.equal(files['customXml/item1.xml'], DATA);
  assert.ok(files['customXml/item2.xml'].includes('<b:Tag>OriginalSource</b:Tag>'));
  assert.ok(files['customXml/_rels/item2.xml.rels'].includes('Target="itemProps2.xml"'));
  const back = await read(await writeDocx(c));
  assert.deepEqual(back.sources.map(s => s.tag), ['OriginalSource']);
});
