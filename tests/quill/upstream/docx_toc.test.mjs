// Ported from wordcraft crates/docx at aadb077e072b7de05f724e359d8db82e151f125c:
//   tests/it/toc_ranges.rs        TOC and HYPERLINK field ranges from the public OOXML complex-field contract
//   tests/it/roundtrip.rs         toc_field_wraps_its_entries, range_toc_dirty_flag_round_trips
//   tests/it/content_controls.rs  the Table of Contents content control (#2427)
// Each test names the Rust test it ports.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: the engine's TOC (a heading ending in an empty TOC field, then TOC1..TOC9 entries) is
//    written inside Word's Table of Contents content control with the field opening in the first
//    entry and ending after the last (write/story/toc.rs), and reads back into that shape
//    (read/toc.rs); any other TOC keeps its explicit range. Word writes and reads its TOC the same way
//    (References > Table of Contents, Update Table).
// 2. Ours: core/quill/formats/docx-write.mjs (tocSpan, writtenTocSpan and the Writer's TOC hooks) and
//    docx-read.mjs (unstyleTocLinks, tocControlToToc, tocFieldToHeading); the same assertions on the
//    same values (UTF-16 offsets: OBJ is one unit; paths are arrays).
// 3. These tests (engine).
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {read} from '../../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../../core/quill/formats/docx-write.mjs';
import {createContent} from '../../../core/quill/model/content.mjs';
import {Document, BODY} from '../../../core/quill/model/document.mjs';
import {walkControls} from '../../../core/quill/model/ranges.mjs';
import {OBJ} from '../../../core/quill/model/text.mjs';
import * as P from '../../../core/quill/model/para.mjs';

const enc = s => (typeof s === 'string' ? new TextEncoder().encode(s) : s);
async function zip(entries) { const z = new JSZip(); for (const [n, b] of entries) z.file(n, enc(b)); return z.generateAsync({type: 'uint8array'}); }
const documentXml = async bytes => (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string');
async function replacePart(bytes, name, data) { const z = await JSZip.loadAsync(bytes); z.file(name, data); return z.generateAsync({type: 'uint8array'}); }
const readDoc = async bytes => new Document(await read(bytes));
const write = d => writeDocx(d.content);
const body = d => d.content.body.chunks.flat();
const count = (s, needle) => s.split(needle).length - 1;

// --- toc_ranges.rs ------------------------------------------------------------------------------

const package_ = b => zip([
  ['word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${b}</w:body></w:document>`],
  ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
]);
const start = code => `<w:r><w:fldChar w:fldCharType="begin" w:fldLock="true"/></w:r><w:r><w:instrText>${code}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`;
const END = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
const PAGE = '<w:fldSimple w:instr="PAGEREF Original"><w:r><w:t>7</w:t></w:r></w:fldSimple>';
const ENTRY = '<w:hyperlink w:anchor="Original"><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>Scope</w:t></w:r><w:r><w:tab/></w:r>';

test('toc_ranges.rs unstyled_toc_keeps_range_nested_field_and_formatting_through_two_edited_saves', async () => {
  for (const split of [false, true]) {
    const content = split ? `${ENTRY}${PAGE}</w:hyperlink></w:p><w:p><w:r><w:t>Delivery</w:t></w:r>` : `${ENTRY}${PAGE}</w:hyperlink>`;
    const b = `<w:p><w:r><w:t>Before.</w:t></w:r></w:p><w:p>${start('TOC \\o "1-2" \\h')}${content}${END}</w:p><w:p><w:r><w:t>After.</w:t></w:r></w:p>`;
    let doc = await readDoc(await package_(b));
    for (let cycle = 0; cycle <= 2; cycle++) {
      const ranges = doc.fieldRanges(BODY);
      assert.equal(ranges.length, 1);
      assert.equal(ranges[0].instr, 'TOC \\o "1-2" \\h');
      assert.ok(ranges[0].locked);
      assert.deepEqual(ranges[0].start.path, [1]);
      assert.equal(ranges[0].start.off, 0);
      assert.deepEqual(ranges[0].end.path, [split ? 2 : 1]);
      const entry = body(doc)[1];
      assert.equal(P.plainText(entry), 'Scope\t7');
      const props = P.propsOfChar(entry, OBJ.length);
      assert.equal(props.bold, true);
      assert.equal(props.italic, true);
      assert.equal(props.link, '#Original');
      assert.ok(P.objectsOf(entry).some(o => o.type === 'field' && o.instr === 'PAGEREF Original' && o.result === '7'));
      assert.equal(P.plainText(body(doc).at(-1)), 'After.');
      if (cycle === 2) break;
      const c = doc.content;
      P.insertText(c.body.chunks.flat()[0], 0, 'Independent edit. ', {});
      doc = await readDoc(await writeDocx(c));
    }
  }
});

test('toc_ranges.rs styled_heading_does_not_expand_partial_custom_or_short_ranges', async () => {
  const heading = '<w:p><w:pPr><w:pStyle w:val="TOCHeading"/></w:pPr><w:r><w:t>Contents</w:t></w:r></w:p>';
  const extra = '<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:t>Outside entry.</w:t></w:r></w:p>';
  for (const [style, prefix, suffix, following] of [['TOC1', 'Prefix.', '', ''], ['TOC1', '', 'Suffix.', ''], ['TOC1', '', '', extra], ['CompanyContents', '', '', '']]) {
    const b = `${heading}<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${prefix}</w:t></w:r>${start('TOC')}<w:r><w:t>Scope</w:t></w:r>${END}<w:r><w:t>${suffix}</w:t></w:r></w:p>${following}<w:p><w:r><w:t>Body.</w:t></w:r></w:p>`;
    let doc = await readDoc(await package_(b));
    const text = doc.plainText(BODY);
    for (let cycle = 0; cycle <= 2; cycle++) {
      const ranges = doc.fieldRanges(BODY);
      assert.equal(ranges.length, 1, `${style} ${prefix} ${suffix} ${following}`);
      assert.deepEqual(ranges[0].start.path, [1]);
      assert.deepEqual(ranges[0].end.path, [1]);
      assert.equal(ranges[0].start.off, prefix.length);
      assert.equal(ranges[0].end.off, prefix.length + OBJ.length + 'Scope'.length);
      assert.equal(doc.plainText(BODY), text);
      if (cycle === 2) break;
      doc = await readDoc(await write(doc));
    }
  }
});

test('toc_ranges.rs simple_lowercase_toc_and_multiple_tocs_keep_their_own_ranges', async () => {
  const b = `<w:p><w:fldSimple w:instr="toc \\h" w:fldLock="true">${ENTRY}${PAGE}</w:hyperlink></w:fldSimple><w:r><w:t>Between.</w:t></w:r>${start('TOC \\o "1-1"')}<w:r><w:t>Other result.</w:t></w:r>${END}<w:r><w:t>After.</w:t></w:r></w:p>`;
  let doc = await readDoc(await package_(b));
  for (let cycle = 0; cycle <= 2; cycle++) {
    const r = doc.fieldRanges(BODY);
    assert.equal(r.length, 2);
    assert.equal(r[0].instr, 'toc \\h');
    assert.equal(r[1].instr, 'TOC \\o "1-1"');
    assert.ok(r.every(x => x.locked));
    assert.ok(r[0].end.off < r[1].start.off);
    assert.equal(doc.plainText(BODY), 'Scope\t7Between.Other result.After.');
    if (cycle === 2) break;
    doc = await readDoc(await write(doc));
  }
});

test('toc_ranges.rs toc_in_table_cell_does_not_capture_the_next_cell', async () => {
  const b = `<w:tbl><w:tr><w:tc><w:p>${start('TOC')}${ENTRY}${PAGE}</w:hyperlink>${END}</w:p></w:tc><w:tc><w:p><w:r><w:t>Other cell.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
  let doc = await readDoc(await package_(b));
  for (let cycle = 0; cycle <= 2; cycle++) {
    const ranges = doc.fieldRanges(BODY);
    assert.equal(ranges.length, 1);
    assert.deepEqual(ranges[0].start.path, [0, 0, 0, 0]);
    assert.deepEqual(ranges[0].end.path, ranges[0].start.path);
    assert.equal(P.plainText(body(doc)[0].rows[0].cells[1].blocks[0]), 'Other cell.');
    if (cycle === 2) break;
    doc = await readDoc(await write(doc));
  }
});

test('toc_ranges.rs missing_end_and_excessive_nesting_stay_bounded_and_save_balanced', async () => {
  for (const [starts, ends] of [[1, 0], [40, 40]]) {
    const b = `<w:p>${start('TOC').repeat(starts)}<w:r><w:t>Visible result.</w:t></w:r>${END.repeat(ends)}</w:p>`;
    const doc = await readDoc(await package_(b));
    const saved = await readDoc(await write(doc));
    assert.ok(!saved.hasUnbalancedFieldRanges());
    assert.equal(saved.plainText(BODY), 'Visible result.');
    assert.ok(saved.fieldRanges(BODY).length <= 32);
  }
});

test('toc_ranges.rs section_break_keeps_an_explicit_range_and_toc_prefix_is_not_a_toc', async () => {
  const b = `<w:p><w:pPr><w:pStyle w:val="TOCHeading"/></w:pPr><w:r><w:t>Contents</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="TOC1"/><w:sectPr/></w:pPr>${start('TOC')}<w:r><w:t>Scope</w:t></w:r>${END}</w:p><w:p>${start('TOC_OTHER')}<w:r><w:t>Other.</w:t></w:r>${END}</w:p>`;
  const doc = await readDoc(await package_(b));
  for (const d of [doc, await readDoc(await write(doc))]) {
    const ranges = d.fieldRanges(BODY);
    assert.equal(ranges.length, 1);
    assert.deepEqual(ranges[0].start.path, [1]);
    assert.ok(body(d)[1].section);
    assert.ok(P.objectsOf(body(d)[2]).some(o => o.type === 'field' && o.instr === 'TOC_OTHER' && o.result === 'Other.'));
  }
});

/** The paragraph's characters other than objects, each with the link it carries. */
const linkedChars = p => [...p.text].map((c, i) => [c, i]).filter(([c]) => c !== OBJ).map(([c, i]) => [c, P.propsOfChar(p, i).link ?? null]);

/** #2174: Word for the web writes each table of contents entry as a `HYPERLINK` complex field around the heading's text, a tab and a `PAGEREF` field. */
test('toc_ranges.rs hyperlink_field_entries_read_as_linked_text_with_their_page_field', async () => {
  const entry = (anchor, text, page) => `${start(`HYPERLINK  \\l  "${anchor}" `)}<w:r><w:t>${text}</w:t></w:r><w:r><w:tab/></w:r>${start(`PAGEREF ${anchor} \\h`)}<w:r><w:t>${page}</w:t></w:r>${END}${END}`;
  const ppr = '<w:pPr><w:pStyle w:val="TOC1"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9015"/></w:tabs></w:pPr>';
  const b = `<w:p>${ppr}${start('TOC \\o \\z \\u \\h')}${entry('_Toc1', 'Intro', '1')}</w:p><w:p>${ppr}${entry('_Toc2', 'Title 2', '2')}${END}</w:p><w:p><w:r><w:t>After.</w:t></w:r></w:p>`;
  const doc = await readDoc(await package_(b));
  const saved = await readDoc(await write(doc));
  for (const d of [doc, saved]) {
    for (const [i, anchor, text, page] of [[0, '_Toc1', 'Intro', '1'], [1, '_Toc2', 'Title 2', '2']]) {
      const p = body(d)[i];
      assert.equal(P.plainText(p), `${text}\t${page}`);
      const link = `#${anchor}`;
      assert.deepEqual(linkedChars(p), [...`${text}\t`].map(c => [c, link]));
      assert.ok(P.objectsOf(p).every(o => !(o.type === 'field' && o.instr.startsWith('HYPERLINK'))));
      const pageref = `PAGEREF ${anchor} \\h`;
      assert.ok(P.objectsOf(p).some(o => o.type === 'field' && o.instr === pageref && o.result === page));
    }
    assert.equal(d.fieldRanges(BODY).length, 1);
    assert.equal(P.plainText(body(d)[2]), 'After.');
  }
});

/** A `HYPERLINK` field's target, whatever the field's spelling; one with no target stays a field. */
test('toc_ranges.rs hyperlink_field_targets_follow_the_field_code', async () => {
  const simple = code => `<w:p><w:fldSimple w:instr="${code}"><w:r><w:t>Go</w:t></w:r></w:fldSimple></w:p>`;
  const complex = code => `<w:p>${start(code)}<w:r><w:t>Go</w:t></w:r>${END}</w:p>`;
  for (const [para, link] of [
    [complex('HYPERLINK "https://example.org/a" \\l "sec"'), 'https://example.org/a#sec'],
    [complex('hyperlink \\o "A tip" \\t "_blank" "https://example.org/"'), 'https://example.org/'],
    [complex('HYPERLINK "C:\\\\Docs\\\\My file.docx"'), 'C:\\Docs\\My file.docx'],
    [simple('HYPERLINK \\l &quot;Sec&quot; \\m'), '#Sec'],
    [simple('HYPERLINK https://example.org/b'), 'https://example.org/b'],
    [complex('HYPERLINK'), null],
    [complex('HYPERLINKS "https://example.org/"'), null],
  ]) {
    const doc = await readDoc(await package_(para));
    const p = body(doc)[0];
    assert.equal(P.plainText(p), 'Go');
    if (link !== null) assert.deepEqual(linkedChars(p), [...'Go'].map(c => [c, link]), para);
    else assert.ok(P.objectsOf(p).length === 1 && P.objectsOf(p)[0].type === 'field' && P.objectsOf(p)[0].result === 'Go', para);
  }
});

// --- roundtrip.rs -------------------------------------------------------------------------------

const withText = (text, style) => { const p = P.newParagraph(); P.insertText(p, 0, text, {}); if (style) P.styled(p, style); return p; };
const paras = c => c.body.chunks.flat().filter(b => b.kind === 'para');

/**
 * The TOC is a `Contents` paragraph ending in an empty `TOC` field, followed by TOC-styled entries.
 * In the file the field must contain the entries, inside Word's Table of Contents content control,
 * or Word shows them as plain text with no Update Table.
 */
test('roundtrip.rs toc_field_wraps_its_entries', async () => {
  for (const entries of [[['Intro\t1', 'TOC1']], [['Intro\t1', 'TOC1'], ['Detail\t2', 'TOC2']]]) {
    const head = withText('Contents', 'TOCHeading');
    P.insertObject(head, head.text.length, {type: 'field', instr: 'TOC \\o "1-2" \\h \\z \\u', result: '', locked: false}, {});
    const blocks = [head, ...entries.map(([t, st]) => withText(t, st)), withText('Body')];
    const bytes = await writeDocx(createContent(blocks));
    const xml = await documentXml(bytes);
    const sdt = xml.indexOf('<w:sdt>');
    assert.ok(sdt >= 0, 'TOC content control');
    assert.ok(xml.includes('<w:docPartGallery w:val="Table of Contents"/>'), xml);
    const [begin, fend] = [xml.indexOf('fldCharType="begin"'), xml.indexOf('fldCharType="end"')];
    const lastEntry = xml.indexOf(entries.at(-1)[0].split('\t')[0]);
    assert.ok(sdt < xml.indexOf('Contents') && xml.indexOf('</w:sdt>') < xml.indexOf('>Body<'), xml);
    assert.ok(begin < xml.indexOf('Intro') && fend > lastEntry && fend < xml.indexOf('</w:sdt>'), `field must span the entries: ${xml}`);
    // Word starts the field in the first entry; started in the heading, LibreOffice splits the heading.
    const headingEnd = xml.slice(0, xml.indexOf('Intro')).lastIndexOf('</w:p>');
    assert.ok(begin > headingEnd, `field must start in the first entry, not the heading: ${xml}`);

    // WordCraft reads its own TOC back unchanged.
    const ps = paras(await read(bytes));
    assert.deepEqual(ps.map(P.plainText), ['Contents', ...entries.map(([t]) => t), 'Body']);
    const first = P.objectsOf(ps[0])[0];
    assert.ok(first?.type === 'field' && first.instr.startsWith('TOC'), JSON.stringify(P.objectsOf(ps[0])));
    assert.equal(P.objectsOf(ps[1]).length, 0, `the field goes back on the heading: ${JSON.stringify(P.objectsOf(ps[1]))}`);
    assert.equal(ps[1].props?.style, 'TOC1');
  }
});

/** #877: a TOC imported as a range field keeps `w:dirty` through a round trip — the flag sits on the begin marker Word rebuilds the field from. */
test('roundtrip.rs range_toc_dirty_flag_round_trips', async () => {
  const toc = P.newParagraph();
  P.insertObject(toc, 0, {type: 'fieldStart', instr: 'TOC \\o "1-3" \\h \\z \\u', locked: false}, {});
  P.insertText(toc, toc.text.length, 'Placeholder: update fields (F9).', {});
  P.insertObject(toc, toc.text.length, {type: 'fieldEnd'}, {});
  const blocks = [toc];
  for (const [t, style] of [['Alpha', 'Heading1'], ['Body text.', null], ['Beta', 'Heading2'], ['Gamma', 'Heading1']]) blocks.push(withText(t, style));
  const bytes = await writeDocx(createContent(blocks));
  const xml = await documentXml(bytes);
  const marked = xml.replace('<w:fldChar w:fldCharType="begin"/>', '<w:fldChar w:fldCharType="begin" w:dirty="true"/>');
  assert.notEqual(marked, xml, `the written begin marker must be bare: ${xml}`);
  const r = await read(await replacePart(bytes, 'word/document.xml', marked));
  // Still the imported shape: a range field holding the placeholder as ordinary content.
  assert.equal(P.objectsOf(paras(r)[0])[0]?.type, 'fieldStart', JSON.stringify(P.objectsOf(paras(r)[0])));
  assert.equal(P.objectsOf(paras(r)[0]).at(-1)?.type, 'fieldEnd');
  assert.equal(P.plainText(paras(r)[0]), 'Placeholder: update fields (F9).');
  const out = await documentXml(await writeDocx(r));
  assert.equal(count(out, 'w:dirty'), 1, `the TOC keeps its flag: ${out}`);
  const [begin, placeholder] = [out.indexOf('fldCharType="begin"'), out.indexOf('Placeholder')];
  const [separate, end] = [out.indexOf('fldCharType="separate"'), out.indexOf('fldCharType="end"')];
  assert.ok(begin < separate && separate < placeholder && placeholder < end, `the placeholder stays the field's result: ${out}`);
});

// --- content_controls.rs ------------------------------------------------------------------------

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';
const ROOT_RELS = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const ccPackage = b => zip([['_rels/.rels', ROOT_RELS], ['word/document.xml', `<w:document ${NS}><w:body>${b}</w:body></w:document>`]]);
const t = s => `<w:r><w:t xml:space="preserve">${s}</w:t></w:r>`;
const p = inner => `<w:p>${inner}</w:p>`;
const sdt = (pr, content) => `<w:sdt><w:sdtPr>${pr}</w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt>`;
const controls = c => { const out = []; walkControls(c.body.chunks.flat(), x => out.push(x)); return out; };
const styleP = (s, inner) => `<w:p><w:pPr><w:pStyle w:val="${s}"/></w:pPr>${inner}</w:p>`;
const BEGIN = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>';
const GALLERY = '<w:id w:val="-1234567"/><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj>';

/** Word's Table of Contents control around a TOC the engine's heading/entry form doesn't cover is kept as read: nothing rebuilds it on save. */
test('content_controls.rs toc_gallery_around_a_free_form_toc_round_trips', async () => {
  const pr = '<w:sdtPr><w:id w:val="-1234567"/><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtEndPr/><w:sdtContent>';
  const field = `${BEGIN}${t('Chapter One')}<w:r><w:tab/></w:r>${t('1')}`;
  const b = `<w:sdt>${pr}${p(t('Contents'))}${p(field)}${p(END)}</w:sdtContent></w:sdt>${p(t('Chapter One'))}`;
  let bytes = await ccPackage(b);
  for (let pass = 0; pass < 2; pass++) {
    const d = await read(bytes);
    bytes = await writeDocx(d);
    const xml = await documentXml(bytes);
    assert.equal(count(xml, '<w:sdt>'), 1, `pass ${pass}: ${xml}`);
    const open = xml.indexOf(pr);
    assert.ok(open >= 0, `pass ${pass}: ${xml}`);
    const close = xml.indexOf('</w:sdtContent></w:sdt>');
    const [contents, fend] = [xml.indexOf('>Contents<'), xml.indexOf('w:fldCharType="end"')];
    assert.ok(open < contents && fend < close, `pass ${pass}: ${xml}`);
    assert.ok(close < xml.lastIndexOf('>Chapter One<'), `the body paragraph stays outside: ${xml}`);
  }
});

/** The control around a TOC in the engine's form still goes to the TOC: written once, around the heading and the entries. */
test('content_controls.rs toc_gallery_around_the_engine_form_goes_to_the_toc', async () => {
  const content = `${styleP('TOCHeading', t('Contents'))}${styleP('TOC1', `${BEGIN}${t('Chapter One\t1')}`)}${styleP('TOC2', `${t('Section\t2')}${END}`)}`;
  let bytes = await ccPackage(`${sdt(GALLERY, content)}${p(t('Chapter One'))}`);
  for (let pass = 0; pass < 2; pass++) {
    const d = await read(bytes);
    assert.equal(controls(d).length, 0, `pass ${pass}`);
    const heading = d.body.chunks.flat()[0];
    assert.ok(P.objectsOf(heading).some(o => o.type === 'field' && o.instr.trim().startsWith('TOC')));
    bytes = await writeDocx(d);
    const xml = await documentXml(bytes);
    assert.equal(count(xml, '<w:sdt>'), 1, `pass ${pass}: ${xml}`);
    assert.ok(xml.includes('<w:docPartGallery w:val="Table of Contents"/>'), `pass ${pass}: ${xml}`);
    assert.ok(xml.indexOf('</w:sdt>') < xml.lastIndexOf('>Chapter One<'), `pass ${pass}: ${xml}`);
  }
});

/** A rich text control around the heading and the first entry, inside Word's Table of Contents control: the outer one is kept as read rather than lost on save. */
test('content_controls.rs toc_gallery_around_a_toc_whose_heading_is_in_a_block_control_round_trips', async () => {
  const content = `${sdt('<w:id w:val="31"/><w:richText/>', `${styleP('TOCHeading', t('Contents'))}${styleP('TOC1', `${BEGIN}${t('Chapter One\t1')}`)}`)}${styleP('TOC2', `${t('Section\t2')}${END}`)}`;
  let bytes = await ccPackage(`${sdt(GALLERY, content)}${p(t('Chapter One'))}`);
  for (let pass = 0; pass < 2; pass++) {
    const d = await read(bytes);
    bytes = await writeDocx(d);
    const xml = await documentXml(bytes);
    assert.equal(count(xml, '<w:sdt>'), 2, `pass ${pass}: ${xml}`);
    const gallery = xml.indexOf(`<w:sdtPr>${GALLERY}`);
    const rich = xml.indexOf('<w:id w:val="31"/>');
    assert.ok(gallery >= 0, `pass ${pass}: ${xml}`);
    assert.ok(gallery < rich && rich < xml.indexOf('>Contents<'), `pass ${pass}: ${xml}`);
    assert.ok(xml.lastIndexOf('</w:sdt>') < xml.lastIndexOf('>Chapter One<'), `pass ${pass}: ${xml}`);
  }
});

// --- Automation: read/toc.rs unstyle_toc_links -----------------------------------------------------

/** Word draws a TOC's entry links without the Hyperlink character style: the style is dropped from linked runs inside a TOC range, kept elsewhere. */
test('unstyle_toc_links drops Hyperlink from linked runs inside a TOC range only', async () => {
  const link = (s, txt) => `<w:hyperlink w:anchor="${s}"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>${txt}</w:t></w:r></w:hyperlink>`;
  const b = `<w:p>${start('TOC \\h')}${link('A', 'Inside')}${END}</w:p><w:p>${link('B', 'Outside')}</w:p>`;
  const c = await read(await package_(b));
  const [p0, p1] = c.body.chunks.flat();
  const inside = P.propsOfChar(p0, p0.text.indexOf('Inside'));
  assert.equal(inside.link, '#A');
  assert.equal(inside.style, undefined);
  const outside = P.propsOfChar(p1, 0);
  assert.equal(outside.link, '#B');
  assert.equal(outside.style, 'Hyperlink');
});
