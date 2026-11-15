// Ported from wordcraft crates/engine/src/cmd/references/tests.rs, crates/engine/src/cmd/citations/
// tests.rs (the Session parts), crates/engine/src/cmd/index.rs (tests) and crates/engine/src/cmd/
// fields.rs (tests) at aadb077e072b7de05f724e359d8db82e151f125c (MIT, see
// assets/third-party-licenses/artcraft-reference.txt): the References tab's engine tests. Each test
// names the Rust test it ports. Upstream's `select.text` is `selText` here; `styles.apply` is
// `para.style` with the style id.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from '../format-fixture.mjs';
import * as P from '../../../core/quill/model/para.mjs';
import {Document, BODY} from '../../../core/quill/model/document.mjs';
import {ENTRY_STYLE, figuresInstr, captionLabels, refTargets} from '../../../core/quill/lib/references-lists.mjs';
import {bookmarkText} from '../../../core/quill/lib/references-toc.mjs';
import {read as readDocx} from '../../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../../core/quill/formats/docx-write.mjs';

const OBJ = P.OBJ;
const plain = q => new Document(q.t.content).plainText(BODY).split(OBJ).join('');
const paras = q => blocks(q.t).filter(b => b.kind === 'para');
const textOf = p => P.plainText(p).split(OBJ).join('');
/** Field instructions and results in the body, in order (fields). */
const fields = q => paras(q).flatMap(p => (p.objects ?? []).filter(o => o.type === 'field').map(o => [o.instr, o.result ?? '']));
/** Select `text` (its first occurrence, as upstream select.text). */
function selText(q, text) {
  const bl = blocks(q.t);
  for (let i = 0; i < bl.length; i++) {
    const k = bl[i].text.indexOf(text);
    if (k >= 0) { q.sel(i, k, k + text.length); return; }
  }
  throw new Error(`no ${text}`);
}
const styleOf = async (q, text, style) => { selText(q, text); await q.exec('para.style', {style}); };
const listEntries = q => paras(q).filter(p => p.props?.style === ENTRY_STYLE).map(p => [textOf(p), p.props?.tabs?.at(-1)?.leader ?? null]);

// ---- references/tests.rs ----------------------------------------------------------------------

test('toc_switches_shape_the_entries (references/tests.rs:107)', async () => {
  const q = await quill('Intro\nPart\nDeep\nNote');
  for (const [t, st] of [['Intro', 'Heading1'], ['Part', 'Heading2'], ['Deep', 'Heading3'], ['Note', 'Quote']]) await styleOf(q, t, st);
  await q.exec('caret.docStart');
  await q.exec('references.toc', {levels: 2, hyperlinks: false, rightAlign: false, styleLevels: {Quote: 2}});
  assert.equal(fields(q)[0][0], 'TOC \\o "1-2" \\z \\u \\p " " \\t "Quote,2"');
  const entries = paras(q).filter(p => /^TOC\d$/.test(p.props?.style ?? '')).map(p => [p.props.style, textOf(p)]);
  assert.deepEqual(entries, [['TOC1', 'Intro 1'], ['TOC2', 'Part 1'], ['TOC2', 'Note 1']]);
  assert.equal(new Document(q.t.content).bookmarks().length, 0, 'no hyperlinks, no _Toc bookmarks');
  await q.exec('references.toc', {levels: 3, pageNumbers: false});
  assert.equal(plain(q).split('Contents').length - 1, 1);
  assert.deepEqual(paras(q).filter(p => p.props?.style === 'TOC3').map(textOf), ['Deep']);
  const first = paras(q).find(p => p.props?.style === 'TOC1');
  const link = first.runs[0].props.link;
  assert.ok(new Document(q.t.content).bookmarks().some(([n]) => `#${n}` === link), link);
});

test('caption_numbering_with_chapters (references/tests.rs:140)', async () => {
  const q = await quill('One\nPic\nPic two\nTwo\nPic three');
  for (const t of ['One', 'Two']) await styleOf(q, t, 'Heading1');
  for (const t of ['Pic three', 'Pic two', 'Pic']) {
    const bl = blocks(q.t);
    const i = bl.findIndex(b => b.text === t);
    q.sel(i, 0, t.length);
    await q.exec('references.caption', {label: 'Photo Plate', format: 'upperLetter', chapter: 1, separator: '.', position: 'above', text: t});
  }
  const caps = paras(q).filter(p => p.props?.style === 'Caption').map(textOf);
  assert.deepEqual(caps, ['Photo Plate 1.A: Pic', 'Photo Plate 1.B: Pic two', 'Photo Plate 2.A: Pic three']);
  assert.ok(fields(q).some(([i, r]) => i === 'SEQ Photo_Plate \\* ALPHABETIC \\s 1' && r === 'A'), JSON.stringify(fields(q)));
  const bl = paras(q);
  const i = bl.findIndex(p => textOf(p) === 'Pic');
  assert.equal(textOf(bl[i - 1]), 'Photo Plate 1.A: Pic');
  await q.exec('caret.docEnd');
  await q.exec('references.caption', {label: 'Table', excludeLabel: true, format: 'ROMAN'});
  assert.equal(textOf(paras(q).at(-1)), 'I');
});

test('update_fields_ref_and_pageref (references/tests.rs:167)', async () => {
  const q = await quill('Bookmark target text here.\nSecond paragraph.');
  selText(q, 'Bookmark target text');
  await q.exec('insert.bookmark', {name: 'TargetMark'});
  await q.exec('caret.docEnd');
  for (const [instr, result] of [['REF "TargetMark" \\h', 'old'], ['REF TargetMark\\h', 'old'], ['PAGEREF "TargetMark" \\* Roman', '0'], ['PAGEREF TargetMark \\p', 'above'], ['REF TargetMark \\p', 'above']]) {
    await q.exec('insert.field', {instr, result});
  }
  await q.exec('references.updateFields', {});
  const res = fields(q);
  assert.deepEqual(res[0], ['REF "TargetMark" \\h', 'Bookmark target text']);
  assert.deepEqual(res[1], ['REF TargetMark\\h', 'Bookmark target text']);
  assert.deepEqual(res[2], ['PAGEREF "TargetMark" \\* Roman', 'I']);
  assert.deepEqual(res[3], ['PAGEREF TargetMark \\p', 'above']);
  assert.deepEqual(res[4], ['REF TargetMark \\p', 'above']);
});

/** A session whose first header holds fields `instrs` (stale results), the caret in it (header_fields_session). */
async function headerFields(core, instrs) {
  const q = await quill('one two three', c => ({...c, core: {...c.core, ...core}}));
  await q.exec('insert.editHeader', {});
  for (const instr of instrs) await q.exec('insert.field', {instr, result: 'stale'});
  const d = new Document(q.t.content);
  const hdr = Number(Object.keys(q.t.content.parts).find(k => q.t.content.parts[k].kind === 'header'));
  const got = () => new Document(q.t.content).para(hdr, [0]).objects.filter(o => o.type === 'field').map(o => o.result);
  void d;
  return {q, hdr, got};
}

test('document_information_fields_show_the_properties (references/tests.rs:316)', async () => {
  const codes = ['SUBJECT', 'KEYWORDS', 'COMMENTS', 'LASTSAVEDBY', 'REVNUM', 'REVNUM \\* ROMAN', 'NUMCHARS', 'NUMWORDS \\* roman'];
  const {q, got} = await headerFields({subject: 'Budget', keywords: 'plan; costs', description: 'Draft for review', lastModifiedBy: 'Grace', revision: 7}, codes);
  await q.exec('references.updateFields', {});
  assert.deepEqual(got(), ['Budget', 'plan; costs', 'Draft for review', 'Grace', '7', 'VII', '11', 'iii']);
});

test('summary_fields_take_one_word_without_quotes (references/tests.rs:360)', async () => {
  const {q, got} = await headerFields({subject: 'Old', creator: 'Grace', title: 'Plan'}, ['SUBJECT Draft', 'AUTHOR Ada', 'TITLE \\* Upper']);
  await q.exec('references.updateFields', {});
  assert.deepEqual(got(), ['Draft', 'Ada', 'PLAN']);
  const c = q.t.content.core;
  assert.deepEqual([c.subject, c.creator, c.title], ['Draft', 'Ada', 'Plan']);
});

test('counts_past_the_number_format_keep_their_digits (references/tests.rs:436)', async () => {
  const {q, got} = await headerFields({revision: 1_000_000}, ['REVNUM \\* ROMAN', 'REVNUM \\* CardText', 'REVNUM \\* alphabetic', 'NUMWORDS \\* ROMAN']);
  await q.exec('references.updateFields', {});
  assert.deepEqual(got(), ['1000000', '1000000', '1000000', 'III']);
});

// ---- citations/tests.rs -----------------------------------------------------------------------

test('citations_and_bibliography (citations/tests.rs:5)', async () => {
  const q = await quill('');
  await q.exec('text.insert', {text: 'Studios matter '});
  await q.exec('references.citation', {source: {author: 'Rivera, Alex; Chen, Mei', title: 'Shared Spaces', year: '2021', publisher: 'Harbor Books', city: 'Portland'}});
  assert.ok(plain(q).includes('(Rivera & Chen, 2021)'), plain(q));
  await q.exec('text.newParagraph', {});
  await q.exec('references.bibliography', {});
  assert.ok(plain(q).includes('Rivera, A., & Chen, M. (2021). Shared Spaces. Harbor Books.'), plain(q));
  await q.exec('references.citationStyle', {style: 'MLA'});
  assert.ok(plain(q).includes('(Rivera and Chen)'), plain(q));
  await q.exec('references.citationStyle', {style: 'IEEE'});
  assert.ok(plain(q).includes('[1]'));
});

test('update_fields_adds_the_entry_style_only_with_a_list (citations/tests.rs:24)', async () => {
  const q = await quill('plain text');
  await q.exec('select.all', {});
  await q.exec('references.updateFields', {});
  assert.equal(q.t.content.styles.styles.some(s => s.id === ENTRY_STYLE), false);
  await q.exec('caret.docEnd');
  await q.exec('text.newParagraph', {});
  await q.exec('references.citation', {source: {author: 'Rivera, Alex', title: 'Shared Spaces', year: '2021'}});
  await q.exec('text.newParagraph', {});
  await q.exec('references.bibliography', {});
  assert.equal(q.t.content.styles.styles.some(s => s.id === ENTRY_STYLE), true);
});

test('citation_style_survives_docx_save_and_reopen (citations/tests.rs:87)', async () => {
  const q = await quill('');
  await q.exec('references.citation', {source: {author: 'Rivera, Alex', title: 'Shared Spaces', year: '2021'}});
  await q.exec('references.citationStyle', {style: 'Harvard (Anglia)'});
  const back = await readDocx(await writeDocx(q.t.content));
  assert.equal(back.settings.bibStyle, 'Harvard (Anglia)');
  const q2 = await quill('x');
  assert.equal((await q2.exec('references.citationStyle', {style: 'APA'})).result.style, 'APA', 'a document without one is APA');
});

test('index_and_figures (citations/tests.rs:103)', async () => {
  const q = await quill('Kilns are hot.\nPresses are heavy.\nMore kilns.');
  selText(q, 'Kilns');
  await q.exec('references.markEntry', {});
  selText(q, 'Presses');
  await q.exec('references.markEntry', {});
  await q.exec('caret.docEnd');
  await q.exec('text.newParagraph', {});
  await q.exec('references.index', {});
  assert.ok(plain(q).includes('Kilns, 1') && plain(q).includes('Presses, 1'), plain(q));
  await q.exec('caret.docStart');
  await q.exec('references.caption', {label: 'Figure', text: 'The kiln'});
  await q.exec('caret.docEnd');
  await q.exec('references.tableOfFigures', {});
  assert.ok(new Document(q.t.content).plainText(BODY).split(OBJ).join('').includes('Figure 1: The kiln\t1'));
  const list = (await q.exec('insert.crossReference', {to: 'figure'})).result;
  assert.equal(list.length, 1);
  await q.exec('insert.crossReference', {to: 'figure', target: 'Figure 1', show: 'number'});
  const d = new Document(q.t.content);
  const name = d.bookmarks().find(([n]) => n.startsWith('_Ref'))[0];
  assert.equal(bookmarkText(d, name), 'Figure 1');
  assert.ok(fields(q).some(([i, r]) => i === `REF ${name} \\h` && r === 'Figure 1'), JSON.stringify(fields(q)));
});

test('cross_reference_to_a_custom_caption_label (citations/tests.rs:132)', async () => {
  const q = await quill('Rock\nSee ');
  selText(q, 'Rock');
  await q.exec('references.caption', {label: 'Plate', text: 'A rock'});
  const d = () => new Document(q.t.content);
  assert.deepEqual(captionLabels(d()), ['Plate']);
  assert.deepEqual((await q.exec('insert.crossReference', {to: 'label:Plate'})).result, ['Plate 1: A rock']);
  assert.equal(refTargets(d(), 'label:Figure').length, 0);
  assert.equal(refTargets(d(), 'label:').length + refTargets(d(), 'label:Pla').length, 0);
  await q.exec('caret.docEnd');
  await q.exec('insert.crossReference', {to: 'label:Plate', target: 'Plate 1', show: 'number'});
  assert.ok(plain(q).endsWith('See Plate 1'), plain(q));
});

test('caption_labels_do_not_need_a_digit (citations/tests.rs:150)', async () => {
  const q = await quill('Rock\nGem\nSand\nSee ');
  for (const [text, label, format] of [['Rock', 'Plate', 'ALPHABETIC'], ['Gem', 'Photo Plate', 'ROMAN'], ['Sand', 'Chart', 'ARABIC']]) {
    const i = blocks(q.t).findIndex(b => b.text === text);
    q.sel(i, 0, text.length);
    await q.exec('references.caption', {label, text, format});
  }
  const d = new Document(q.t.content);
  assert.deepEqual(captionLabels(d), ['Plate', 'Photo Plate', 'Chart']);
  for (const l of ['Plate', 'Photo Plate', 'Chart']) assert.equal(refTargets(d, `label:${l}`).length, 1);
  await q.exec('caret.docEnd');
  await q.exec('insert.crossReference', {to: 'label:Photo Plate', target: 'Photo Plate I', show: 'number'});
  assert.ok(plain(q).endsWith('See Photo Plate I'), plain(q));
});

test('table_of_figures_options (citations/tests.rs:215)', async () => {
  assert.equal(figuresInstr({}), 'TOC \\c "Figure"');
  assert.equal(figuresInstr({label: 'Table', includeLabel: false}), 'TOC \\a "Table"');
  assert.equal(figuresInstr({pageNumbers: false}), 'TOC \\c "Figure" \\n');
  assert.equal(figuresInstr({rightAlign: false}), 'TOC \\c "Figure" \\p " "');
  assert.equal(figuresInstr({label: '"\\ '}), 'TOC \\c "Figure"');
  for (const [params, entry] of [[{includeLabel: false}, 'The kiln\t1'], [{pageNumbers: false}, 'Figure 1: The kiln'], [{rightAlign: false, includeLabel: false}, 'The kiln 1']]) {
    const q = await quill('Kiln\n');
    selText(q, 'Kiln');
    await q.exec('references.caption', {label: 'Figure', text: 'The kiln'});
    await q.exec('caret.docEnd');
    await q.exec('references.tableOfFigures', params);
    const entries = listEntries(q);
    assert.deepEqual(entries.map(([t]) => t), [entry], JSON.stringify(params));
    assert.equal(entries[0][1] !== null, entry.includes('\t'), 'a tab stop only for a tab');
  }
});

test('table_of_authorities_updates (citations/tests.rs:389)', async () => {
  const q = await quill('Smith v. Jones held it.\nDoe v. Roe agreed.');
  selText(q, 'Smith v. Jones');
  await q.exec('references.markCitation', {});
  await q.exec('caret.docEnd');
  await q.exec('text.newParagraph', {});
  await q.exec('references.tableOfAuthorities', {});
  const t = plain(q);
  assert.ok(t.includes('Smith v. Jones') && !t.includes('Doe v. Roe, '), t);
  selText(q, 'Doe v. Roe');
  await q.exec('references.markCitation', {});
  await q.exec('references.updateAuthorities', {});
  const after = plain(q);
  assert.ok(after.split('Doe v. Roe').length > t.split('Doe v. Roe').length, after);
});

test('cross_references_point_at_real_bookmarks (citations/tests.rs:419)', async () => {
  const q = await quill('Kilns\nSee here.');
  await q.exec('caret.docStart');
  await q.exec('para.style', {style: 'Heading1'});
  await q.exec('caret.docEnd');
  await q.exec('insert.crossReference', {to: 'heading', target: 'Kilns'});
  const marks = new Document(q.t.content).bookmarks();
  assert.equal(marks.length, 1);
  const name = marks[0][0];
  assert.ok(name.startsWith('_Ref') && name.length > 4, name);
  assert.deepEqual(marks[0][1].path, [0]);
  assert.deepEqual(fields(q), [[`REF ${name} \\h`, 'Kilns']]);
  await q.exec('insert.crossReference', {to: 'heading', target: 'Kilns', show: 'page'});
  assert.equal(new Document(q.t.content).bookmarks().length, 1);
  assert.deepEqual(fields(q)[1], [`PAGEREF ${name} \\h`, '1']);
  selText(q, 'ilns');
  await q.exec('text.insert', {text: 'ILNS'});
  await q.exec('references.updateFields', {});
  assert.equal(fields(q)[0][1], 'KILNS');
  assert.ok(plain(q).endsWith('See here.KILNS1'), plain(q));
});

test('cross_reference_to_a_bookmark_shows_its_text (citations/tests.rs:445)', async () => {
  const q = await quill('Kilns are hot.\nSee ');
  selText(q, 'Kilns');
  await q.exec('insert.bookmark', {name: 'Spot'});
  await q.exec('caret.docEnd');
  await q.exec('insert.crossReference', {to: 'bookmark', target: 'Spot'});
  assert.equal(new Document(q.t.content).bookmarks().length, 1);
  assert.deepEqual(fields(q), [['REF Spot \\h', 'Kilns']]);
});

test('cross_reference_inside_its_own_target_paragraph (citations/tests.rs:456)', async () => {
  const q = await quill('Kilns');
  await q.exec('para.style', {style: 'Heading1'});
  await q.exec('caret.docEnd');
  await q.exec('insert.crossReference', {to: 'heading', target: 'Kilns'});
  assert.equal(plain(q), 'KilnsKilns');
  const d = new Document(q.t.content);
  assert.equal(bookmarkText(d, d.bookmarks()[0][0]), 'Kilns');
});

const srcOf = (author, year) => ({author, year, title: 'T'});

test('editing_author_and_year_keeps_the_tag_and_updates_the_citation_text (citations/tests.rs:472)', async () => {
  const q = await quill('');
  await q.exec('references.sources', {add: srcOf('Smith, Ann', '2020')});
  assert.equal(q.t.content.sources[0].tag, 'Smi20');
  await q.exec('references.citation', {tag: 'Smi20'});
  await q.exec('references.sources', {add: {...srcOf('Jones, Bo', '2021'), tag: 'Smi20'}});
  assert.equal(q.t.content.sources.length, 1);
  assert.equal(q.t.content.sources[0].tag, 'Smi20');
  const f = fields(q);
  assert.equal(f[0][0], 'CITATION Smi20');
  assert.ok(f[0][1].includes('Jones') && f[0][1].includes('2021'), f[0][1]);
});

test('a_new_sources_tag_is_three_letters_and_two_year_digits (citations/tests.rs:489)', async () => {
  const q = await quill('');
  for (const [a, y] of [['Kim', '2000'], ['Kim', '2000'], ['Kim', '2000'], ['Lee', '2019'], ['Li', '1999'], ['', ''], ['', ''], ['Ünal, Ece', '7'], ["O'Neil", '20x5']]) {
    await q.exec('references.sources', {add: srcOf(a, y)});
  }
  assert.deepEqual(q.t.content.sources.map(x => x.tag), ['Kim00', 'Kim001', 'Kim002', 'Lee19', 'Li99', 'Src', 'Src1', 'Üna7', 'ONe05']);
  const q2 = await quill('');
  await q2.exec('references.sources', {add: {...srcOf('Lee', '2019'), tag: 'MyTag'}});
  assert.equal(q2.t.content.sources[0].tag, 'MyTag');
});

const SOURCES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"
           xmlns="http://schemas.openxmlformats.org/officeDocument/2006/bibliography" SelectedStyle="\\APA.XSL" StyleName="APA">
  <b:Source><b:Tag>Riv21</b:Tag><b:SourceType>Book</b:SourceType>
    <b:Author><b:Author><b:NameList><b:Person><b:Last>Rivera</b:Last><b:First>Alex</b:First></b:Person></b:NameList></b:Author></b:Author>
    <b:Title>Shared Spaces</b:Title><b:Year>2021</b:Year><b:City>Portland</b:City><b:Publisher>Harbor Books</b:Publisher>
  </b:Source>
  <b:Source><b:SourceType>Book</b:SourceType></b:Source>
  <b:Source><b:SourceType>JournalArticle</b:SourceType>
    <b:Author><b:Author><b:NameList><b:Person><b:Last>Okafor</b:Last><b:First>Ngozi</b:First></b:Person></b:NameList></b:Author></b:Author>
    <b:Title>Kilns and Clay</b:Title><b:JournalName>Studio Quarterly</b:JournalName><b:Year>2019</b:Year>
  </b:Source>
</b:Sources>`;

test('import_sources_reads_a_word_bibliography_file (citations/tests.rs:560; the file\'s XML is passed as importData)', async () => {
  const q = await quill('');
  await q.exec('references.sources', {importData: SOURCES_XML});
  const src = () => q.t.content.sources;
  assert.equal(src().length, 2, 'the source with no content is dropped');
  assert.equal(src()[0].tag, 'Riv21');
  assert.deepEqual([src()[0].author, src()[0].title], ['Rivera, Alex', 'Shared Spaces']);
  assert.deepEqual([src()[1].tag, src()[1].kind], ['Oka19', 'article']);
  await q.exec('edit.undo', {});
  assert.equal(src().length, 0, 'one undo takes the whole import back');
  await q.exec('references.sources', {importData: SOURCES_XML});
  await q.exec('references.sources', {add: {...src()[0], title: 'Shared Spaces, revised'}});
  await q.exec('references.sources', {importData: SOURCES_XML});
  assert.equal(src().length, 2);
  assert.equal(src()[0].title, 'Shared Spaces, revised', 'an import never overwrites an edited source');
  assert.equal(src()[1].tag, 'Oka19');
  await assert.rejects(q.exec('references.sources', {importData: '<html><body>no</body></html>'}), /bibliography/);
});

test('an_import_tags_each_untagged_source_once (citations/tests.rs:611)', async () => {
  const xml = `<b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography">
  <b:Source><b:SourceType>Book</b:SourceType><b:Title>First Work</b:Title><b:Year>2021</b:Year>
    <b:Author><b:Author><b:NameList><b:Person><b:Last>Rivera</b:Last><b:First>Alex</b:First></b:Person></b:NameList></b:Author></b:Author></b:Source>
  <b:Source><b:SourceType>Book</b:SourceType><b:Title>Second Work</b:Title><b:Year>2021</b:Year>
    <b:Author><b:Author><b:NameList><b:Person><b:Last>Rivera</b:Last><b:First>Alex</b:First></b:Person></b:NameList></b:Author></b:Author></b:Source>
  <b:Source><b:SourceType>Book</b:SourceType><b:Title>Third Work</b:Title></b:Source>
</b:Sources>`;
  const q = await quill('');
  await q.exec('references.sources', {importData: xml});
  assert.deepEqual(q.t.content.sources.map(x => x.tag), ['Riv21', 'Riv211', 'Src']);
  await q.exec('references.sources', {importData: xml});
  assert.equal(q.t.content.sources.length, 3);
});

// ---- index.rs ---------------------------------------------------------------------------------

test('index_switches_shape_the_index (index.rs tests)', async () => {
  const q = await quill('Kilns are hot.\nGlaze the kilns.\nKilns again.\nPresses.');
  selText(q, 'Kilns');
  await q.exec('references.markEntry', {subentry: 'firing', bold: true});
  selText(q, 'Presses');
  await q.exec('references.markEntry', {crossReference: 'See Kilns'});
  const all = (await q.exec('references.markEntry', {entry: 'Kilns', text: 'Kilns', all: true})).result;
  assert.equal(all.marked, 2, 'the paragraphs with a whole-word, same-case match');
  const instrs = fields(q).map(([i]) => i);
  assert.ok(instrs.includes('XE "Kilns:firing" \\b') && instrs.includes('XE "Presses" \\t "See Kilns"'), JSON.stringify(instrs));
  await q.exec('caret.docEnd');
  await q.exec('text.newParagraph', {});
  await q.exec('references.index', {type: 'runIn', rightAlign: true, columns: 2, tabLeader: 'hyphen'});
  const bl = () => blocks(q.t);
  const idx = () => bl().findIndex(b => (b.objects ?? []).some(o => o.type === 'field' && o.instr.startsWith('INDEX')));
  const i = idx();
  assert.equal(bl()[i].objects.find(o => o.type === 'field').instr, 'INDEX \\h "A" \\c "2" \\e "\t" \\r');
  assert.deepEqual(listEntries(q).map(([t]) => t), ['K', 'Kilns\t1: firing, 1', 'P', 'Presses. See Kilns']);
  const entry = bl()[i + 2];
  assert.equal(entry.props.tabs[0].leader, 'hyphen');
  assert.ok(P.runRanges(entry).some(([, , p]) => p?.bold === true), 'the \\b page number is bold');
  const last = bl()[i + 4];
  assert.deepEqual([last.section?.columns?.count, last.section?.start], [2, 'continuous']);
  await q.exec('references.index', {columns: 1, rightAlign: true});
  assert.deepEqual(listEntries(q).map(([t]) => t), ['K', 'Kilns\t1', 'firing\t1', 'P', 'Presses. See Kilns']);
  assert.ok(bl().every(b => !b.section), 'one section again');
  await q.exec('references.updateIndex', {});
  assert.equal(bl()[idx() + 2].props.tabs[0].leader, 'hyphen');
});

// ---- fields.rs --------------------------------------------------------------------------------

test('edit_lock_unlink_and_walk_fields (fields.rs tests)', async () => {
  const q = await quill('');
  await q.exec('text.insert', {text: 'Made by '});
  await q.exec('insert.field', {instr: 'AUTHOR', result: 'Old'});
  await q.exec('text.insert', {text: ' on '});
  await q.exec('insert.field', {instr: 'TITLE', result: 'T'});
  // Alt+F1 from the start selects the first field, then the next; Shift+F11 goes back.
  await q.exec('caret.docStart');
  await q.exec('fields.next', {});
  let sel = (await q.exec('fields.selected', {})).result;
  assert.equal(sel[0].instr, 'AUTHOR');
  await q.exec('fields.next', {});
  assert.equal((await q.exec('fields.selected', {})).result[0].instr, 'TITLE');
  await q.exec('fields.previous', {});
  sel = (await q.exec('fields.selected', {})).result;
  assert.equal(sel[0].instr, 'AUTHOR');
  // Lock: the field keeps its result on update; unlock: it updates.
  await q.exec('fields.lock', {});
  assert.equal(fields(q)[0][0], 'AUTHOR');
  assert.equal(blocks(q.t)[0].objects[0].locked, true);
  await q.exec('fields.unlock', {});
  assert.equal(blocks(q.t)[0].objects[0].locked, false);
  // Edit the code; Shift+F9 shows the code; Ctrl+Shift+F9 unlinks to text.
  await q.exec('fields.setCode', {code: 'TITLE'});
  assert.equal(fields(q)[0][0], 'TITLE');
  await q.exec('fields.toggleCode', {});
  assert.equal(blocks(q.t)[0].objects[0].code, true);
  await q.exec('fields.toggleCode', {});
  await q.exec('fields.unlink', {});
  assert.equal(fields(q).length, 1, 'the first field is plain text now');
});
