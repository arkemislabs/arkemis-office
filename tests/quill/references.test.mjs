// U:quill/references — the References tab: Table of Contents (gallery, Manual Table, Custom, Update
// Table with page numbers only or the entire table, Remove, Add Text), Footnotes (Insert Footnote and
// Endnote, Next/Previous, Show Notes, Footnote and Endnote options and Convert), Citations &
// Bibliography (sources, placeholders, styles, bibliography), Captions (Insert Caption, Table of
// Figures, Cross-reference), Index, Table of Authorities, the field keys and their dialogs, the
// layout of notes, and .docx round trips.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/references.rs (specs), references/toc.rs (insert_toc
//    463, regenerate_toc 375, remove_toc 196, range_toc_to_field 260), references/notes.rs (note 7,
//    note_options 38), references/fields.rs (caption 26, update_seq 87, update_fields_in 173),
//    citations.rs (specs), citations/sources.rs (sources 47, citation 158, bib_order 208),
//    citations/generated.rs (generated_list_with 51, update_generated 172), citations/cross_refs.rs
//    (cross_ref 4), index.rs (mark_entry 63, rebuild 230), fields.rs (toggle_code, set_code,
//    unlink, go); layout/notes.rs (note areas); docx write/story/toc.rs and read/toc.rs; the dialogs
//    in ui-egui dialogs_refs/*.rs and dialogs_notes.rs. Word: a TOC is a field built from the
//    headings, with dot leaders and page numbers, its entries linked to the headings; Update Table
//    asks page numbers only or the entire table; a footnote's reference is a superscript number and
//    its text sits at the bottom of the page under a short separator, endnotes at the end; citations
//    show in the document's style and the bibliography lists the cited sources; captions number with
//    SEQ fields; cross-references are REF/PAGEREF fields to hidden _Ref bookmarks; index entries are
//    hidden XE fields; right-clicking a field offers Update Field, Edit Field and Toggle Field Codes.
// 2. Ours: the same engine (core/quill/lib/references-toc.mjs, references-lists.mjs,
//    references-cite.mjs), each command one undo step; the page view draws notes from the same
//    layout; the .docx writer keeps the TOC in Word's Table of Contents control, notes in
//    footnotes.xml/endnotes.xml, sources in the bibliography custom XML part. Word additions: Manual
//    Table, Update page numbers only, placeholders, Insert as hyperlink. Not here: Researcher and
//    Search (no engine upstream), the Office.com and Save Selection gallery entries, TOC Modify… styles.
// 3. Proof: this file, tests/quill/upstream/references_tests.test.mjs, citations_tests.test.mjs,
//    docx_citations.test.mjs, docx_toc.test.mjs and tests/e2e/quill/references.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {openDialogModel, changeDialogValues} from '../../core/kernel/dialog.mjs';
import {quill, blocks} from './format-fixture.mjs';
import * as P from '../../core/quill/model/para.mjs';
import {Document, BODY} from '../../core/quill/model/document.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {parseField, tocRange, caretInToc} from '../../core/quill/lib/references-toc.mjs';
import {selectedFields} from '../../core/quill/commands/fields.mjs';
import tocDialog, {tocParams} from '../../core/quill/dialogs/toc.mjs';
import updateTocDialog from '../../core/quill/dialogs/updateToc.mjs';
import noteDialog from '../../core/quill/dialogs/noteOptions.mjs';
import sourceDialog, {sourceFields} from '../../core/quill/dialogs/source.mjs';
import placeholderDialog from '../../core/quill/dialogs/placeholder.mjs';
import captionDialog, {captionPreview} from '../../core/quill/dialogs/caption.mjs';
import crossRefDialog from '../../core/quill/dialogs/crossReference.mjs';
import markDialog from '../../core/quill/dialogs/markEntry.mjs';
import indexDialog from '../../core/quill/dialogs/index.mjs';
import figuresDialog from '../../core/quill/dialogs/tableOfFigures.mjs';
import fieldCodeDialog from '../../core/quill/dialogs/fieldCode.mjs';

const OBJ = P.OBJ;
const textOf = p => P.plainText(p).split(OBJ).join('');
const paras = q => blocks(q.t).filter(b => b.kind === 'para');
const tocEntries = q => paras(q).filter(p => /^TOC\d$/.test(p.props?.style ?? '')).map(p => [p.props.style, textOf(p)]);
const open = (q, dialog) => openDialogModel(q.t.session, q.t.docId, dialog);

async function headed(text = 'Intro\nChapter One\nBody one\nChapter Two\nBody two', styles = [[0, 'Heading1'], [1, 'Heading1'], [3, 'Heading2']]) {
  const q = await quill(text);
  for (const [i, st] of styles) { q.sel(i, 0); await q.exec('para.style', {style: st}); }
  q.sel(0, 0);
  return q;
}

// ---- Table of Contents -------------------------------------------------------------------------

test('references.toc: Automatic Table puts Contents and linked, dot-led, numbered entries above the caret paragraph (one undo step)', async () => {
  const q = await headed();
  await expectUndoRoundTrip(q.t, 'references.toc', {levels: 3, title: 'Contents'}, after => {
    const bl = after.content.body.chunks.flat();
    assert.equal(bl[0].props.style, 'TOCHeading', 'no empty paragraph is left above the table');
  });
  await q.exec('references.toc', {levels: 3, title: 'Contents'});
  assert.deepEqual(tocEntries(q), [['TOC1', 'Intro\t1'], ['TOC1', 'Chapter One\t1'], ['TOC2', 'Chapter Two\t1']]);
  const e = paras(q).find(p => p.props?.style === 'TOC1');
  assert.deepEqual(e.props.tabs.at(-1), {pos: 467.5, align: 'right', leader: 'dot'});
  assert.match(e.runs[0].props.link, /^#_Toc\d{9}$/);
  assert.equal(caretInToc(new Document(q.t.content), {story: BODY, path: [2], off: 0}), true);
});

test('Update Table: the entire table picks up a new heading; page numbers only keeps edited entry text', async () => {
  const q = await headed();
  await q.exec('references.toc', {levels: 3});
  const last = blocks(q.t).length - 1;
  q.sel(last, 8);
  await q.exec('text.newParagraph', {});
  await q.exec('text.insert', {text: 'Chapter Three'});
  await q.exec('para.style', {style: 'Heading1'});
  // Push Chapter Three to page 2.
  q.sel(blocks(q.t).length - 1, 0);
  await q.exec('insert.pageBreak', {});
  await q.exec('references.updateToc', {pagesOnly: false});
  assert.deepEqual(tocEntries(q).at(-1), ['TOC1', 'Chapter Three\t2']);
  // An edited entry keeps its text when only the page numbers update.
  const i = blocks(q.t).findIndex(b => b.props?.style === 'TOC1');
  q.sel(i, 0, 5);
  await q.exec('text.insert', {text: 'Opening'});
  await q.exec('references.updateToc', {pagesOnly: true});
  assert.equal(tocEntries(q)[0][1], 'Opening\t1');
  await q.exec('references.updateToc', {});
  assert.equal(tocEntries(q)[0][1], 'Intro\t1', 'the entire table rebuilds the entry');
});

test('Remove Table of Contents and Manual Table (Word)', async () => {
  const q = await headed();
  await q.exec('references.toc', {levels: 2});
  assert.ok(tocRange(new Document(q.t.content)));
  await q.exec('references.removeToc', {});
  assert.equal(tocRange(new Document(q.t.content)), null);
  assert.equal(paras(q).some(p => p.props?.style === 'TOCHeading'), false, 'its heading goes with it');
  q.sel(0, 0);
  await q.exec('references.toc', {manual: true});
  assert.deepEqual(tocEntries(q).map(([, t]) => t), ['Type chapter title (level 1)\t1', 'Type chapter title (level 2)\t2', 'Type chapter title (level 3)\t3',
    'Type chapter title (level 1)\t4', 'Type chapter title (level 2)\t5', 'Type chapter title (level 3)\t6']);
  assert.equal(q.state('references.updateToc').enabled, false, 'a manual table has no field to update');
});

test('Add Text sets the outline level the TOC reads; its menu checks the paragraph\'s level', async () => {
  const q = await quill('Plain\nMore');
  q.sel(1, 0);
  await expectUndoRoundTrip(q.t, 'references.addText', {level: 2}, after => assert.equal(after.content.body.chunks.flat()[1].props.outlineLevel, 1));
  await q.exec('references.addText', {level: 2});
  assert.equal(q.state('references.addText', {level: 2}).checked, true);
  q.sel(0, 0);
  await q.exec('references.toc', {});
  assert.deepEqual(tocEntries(q), [['TOC2', 'More\t1']]);
  q.sel(blocks(q.t).findIndex(b => b.text.includes('More') && !b.props?.style), 1);
  await q.exec('references.addText', {level: 0});
  assert.equal(blocks(q.t).find(b => b.text.includes('More') && !b.props?.style).props.outlineLevel, 9, 'Do Not Show in Table of Contents');
});

test('a TOC round-trips through .docx inside Word\'s Table of Contents control and updates again after reopening', async () => {
  const q = await headed();
  await q.exec('references.toc', {levels: 3});
  const bytes = await writeDocx(q.t.content);
  const JSZip = (await import('jszip')).default;
  const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string');
  assert.match(xml, /<w:docPartGallery w:val="Table of Contents"\/>/);
  assert.ok(xml.includes(String.raw` TOC \o &quot;1-3&quot; \h \z \u `), 'the field opens in the first entry');
  const back = await readDocx(bytes);
  const bl = back.body.chunks.flat();
  assert.deepEqual(bl.filter(b => /^TOC\d$/.test(b.props?.style ?? '')).map(textOf), ['Intro\t1', 'Chapter One\t1', 'Chapter Two\t1']);
  const q2 = await quill('x', () => back);
  await q2.exec('references.updateToc', {});
  assert.equal(tocEntries(q2).length, 3, 'Update Table rebuilds the reopened table instead of adding a second one');
});

// ---- Footnotes ---------------------------------------------------------------------------------

test('Insert Footnote: a superscript reference, the note at the page bottom, the caret in the note; Insert Endnote goes to the end', async () => {
  const q = await quill('Alpha beta gamma.\nSecond.');
  q.sel(0, 5);
  await expectUndoRoundTrip(q.t, 'references.footnote', {text: 'A note.'}, after => assert.equal(Object.values(after.content.parts).filter(p => p.kind === 'footnote').length, 1));
  const id = Number(Object.keys(q.t.content.parts).find(k => q.t.content.parts[k].kind === 'footnote'));
  assert.equal(q.t.content.parts[id].kind, 'footnote');
  assert.equal(textOf(q.t.content.parts[id].blocks[0]), ' A note.');
  const ref = blocks(q.t)[0].objects.find(o => o.type === 'noteRef');
  assert.equal(ref.id, id);
  assert.equal(P.propsAt(blocks(q.t)[0], 6)?.style ?? P.runRanges(blocks(q.t)[0]).find(([a]) => a === 5)[2].style, 'FootnoteReference');
  q.sel(1, 7);
  await q.exec('references.endnote', {text: 'End note.'});
  const l = layout(q.t.content, {view: 'print'});
  const items = l.pages[0].items.filter(it => it.kind === 'lines');
  const foot = items.find(it => it.story === id), end = items.find(it => it.story !== BODY && it.story !== id);
  const lastBody = items.filter(it => it.story === BODY).at(-1);
  assert.ok(foot.y > 650, `the footnote sits at the page bottom (${foot.y})`);
  assert.ok(end.y > lastBody.y && end.y < 300, `the endnote follows the text at the document's end (${end.y})`);
  assert.ok(l.pages[0].items.some(it => it.kind === 'rule'), 'a separator line above the notes');
});

test('Next/Previous Footnote and Endnote move the caret between references; Show Notes goes to the note and back', async () => {
  const q = await quill('One two three four.');
  for (const off of [3, 7]) { q.sel(0, off); await q.exec('references.footnote', {text: `n${off}`}); }
  q.sel(0, 13);
  await q.exec('references.endnote', {text: 'e'});
  await q.exec('caret.docStart');
  await q.exec('references.nextFootnote', {});
  const at = () => q.t.session.get(q.t.docId).selection.ranges[0].focus;
  assert.match(at(), /t:3$/);
  await q.exec('references.nextFootnote', {});
  assert.match(at(), /t:7$/);
  await q.exec('references.nextFootnote', {previous: true});
  assert.match(at(), /t:3$/);
  await q.exec('references.nextFootnote', {endnote: true});
  assert.match(at(), /t:13$/);
  const notes = (await q.exec('references.notes', {})).result;
  assert.equal(notes.length, 3);
  assert.match(at(), /^\/en:/, 'Show Notes goes into the note of the reference');
  await q.exec('references.notes', {});
  assert.match(at(), /^\/body\//, 'and back to its reference');
});

test('Footnote and Endnote options: number format, start at and position apply to the whole document; Convert swaps kinds', async () => {
  const q = await quill('Text here.');
  q.sel(0, 4);
  await q.exec('references.footnote', {text: 'x'});
  const r = (await q.exec('references.noteOptions', {kind: 'footnote', numFmt: 'lowerRoman', numStart: 3, pos: 'beneathText'})).result;
  assert.deepEqual([r.footnote.numFmt, r.footnote.numStart, r.footnote.pos], ['lowerRoman', 3, 'beneathText']);
  assert.equal(q.t.content.settings.footnoteFormat, 'lowerRoman');
  const bytes = await writeDocx(q.t.content);
  const back = await readDocx(bytes);
  assert.equal(back.settings.footnoteFormat, 'lowerRoman');
  assert.equal(Object.values(back.parts).filter(p => p.kind === 'footnote').length, 1, 'footnotes.xml round-trips');
  await q.exec('references.convertNotes', {to: 'endnote'});
  assert.equal(Object.values(q.t.content.parts).filter(p => p.kind === 'endnote').length, 1);
  await assert.rejects(q.exec('references.noteOptions', {kind: 'endnote', numRestart: 'eachPage'}), /each page/);
});

// ---- Citations, captions, index ---------------------------------------------------------------

test('Add New Placeholder (Word): the citation shows the tag in parentheses and the Source Manager lists it', async () => {
  const q = await quill('Claim ');
  await q.exec('caret.docEnd');
  await q.exec('references.citation', {placeholder: 'Placeholder1'});
  const f = blocks(q.t)[0].objects.find(o => o.type === 'field');
  assert.deepEqual([f.instr, f.result], ['CITATION Placeholder1', '(Placeholder1)']);
  assert.equal(q.t.content.sources[0].tag, 'Placeholder1');
  const v = open(q, placeholderDialog);
  assert.equal(v.name, 'Placeholder2');
  assert.deepEqual(q.state('references.citation').value.map(x => x.value), ['Placeholder1']);
});

test('sources, citations and the style survive .docx (the bibliography custom XML part)', async () => {
  const q = await quill('Studios ');
  await q.exec('caret.docEnd');
  await q.exec('references.citation', {source: {kind: 'article', author: 'Okafor, Ngozi', title: 'Kilns and Clay', journal: 'Studio Quarterly', year: '2019'}});
  await q.exec('references.citationStyle', {style: 'MLA'});
  const bytes = await writeDocx(q.t.content);
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const item = Object.keys(zip.files).find(n => /^customXml\/item\d+\.xml$/.test(n));
  assert.match(await zip.file(item).async('string'), /<b:Sources[^>]*StyleName="MLA"/);
  const back = await readDocx(bytes);
  assert.deepEqual([back.sources[0].tag, back.sources[0].kind, back.settings.bibStyle], ['Oka19', 'article', 'MLA']);
});

test('the field keys: Field Codes (Alt+F9) is the view\'s; the right-click target finds the field at the caret', async () => {
  const q = await quill('Date: ');
  await q.exec('caret.docEnd');
  await q.exec('insert.field', {instr: 'AUTHOR', result: 'Ada'});
  assert.equal((await q.exec('view.fieldCodes', {})).result.value, true);
  assert.equal(q.state('view.fieldCodes').checked, true);
  const d = new Document(q.t.content);
  assert.equal(selectedFields(d, {anchor: {story: BODY, path: [0], off: 7}, focus: {story: BODY, path: [0], off: 7}})[0].instr, 'AUTHOR');
  q.sel(0, 6);
  assert.equal(open(q, fieldCodeDialog).code, 'AUTHOR');
  assert.equal(q.state('fields.toggleCode').enabled, true);
  q.sel(0, 0);
  assert.equal(q.state('fields.toggleCode').enabled, false);
});

// ---- dialogs -----------------------------------------------------------------------------------

test('Custom Table of Contents reads the TOC there; Options… style levels become \\t', async () => {
  const q = await headed();
  await q.exec('references.toc', {levels: 2, hyperlinks: false, tabLeader: 'hyphen'});
  const v = open(q, tocDialog);
  assert.deepEqual([v.levels, v.hyperlinks, v.tabLeader, v.pageNumbers, v.rightAlign], [2, false, 'hyphen', true, true]);
  const quote = v.styleLevels.find(([n]) => n === 'Quote');
  assert.ok(quote, 'paragraph styles are listed');
  const params = tocParams({...v, styleLevels: v.styleLevels.map(([n, l]) => [n, n === 'Quote' ? 3 : l])});
  assert.deepEqual(params.styleLevels, {Quote: 3});
  assert.deepEqual(updateTocDialog.toCommand({mode: 'pages'}), {command: 'references.updateToc', params: {pagesOnly: true}});
});

test('Footnote and Endnote dialog: switching to Endnotes shows their format; Insert applies then inserts with the custom mark', async () => {
  const q = await quill('Text');
  let v = open(q, noteDialog);
  assert.deepEqual([v.kind, v.numFmt, v.footnotePos], ['footnote', 'decimal', 'pageBottom']);
  v = changeDialogValues(noteDialog, v, 'kind', 'endnote');
  assert.equal(v.numFmt, 'lowerRoman');
  v = {...v, customMark: '*'};
  const call = noteDialog.toCommand(v);
  assert.deepEqual(call.batch.map(c => c.command), ['references.noteOptions', 'references.endnote']);
  assert.equal(call.batch[1].params.mark, '*');
});

test('Create Source shows the type\'s fields (all with Show All) and cites the new source from Insert Citation', async () => {
  assert.deepEqual(sourceFields('website', false).map(([k]) => k), ['author', 'title', 'journal', 'year', 'month', 'day', 'url']);
  assert.ok(sourceFields('book', true).some(([k]) => k === 'doi'));
  const q = await quill('x');
  const v = {...open(q, sourceDialog), author: 'Rivera, Alex', title: 'Shared Spaces', year: '2021'};
  const call = sourceDialog.toCommand(v);
  assert.equal(call.command, 'references.citation');
  await q.exec(call.command, call.params);
  assert.equal(q.t.content.sources[0].tag, 'Riv21');
  assert.deepEqual(sourceDialog.toCommand({...v, edit: true, tag: 'Riv21'}).command, 'references.sources');
});

test('Caption, Table of Figures, Cross-reference, Mark Entry and Index dialogs', async () => {
  const q = await quill('Chart\nSee ');
  q.sel(0, 0, 5);
  let v = open(q, captionDialog);
  assert.equal(captionPreview(v), 'Figure 1');
  assert.equal(captionPreview({...v, chapter: true, separator: '.', format: 'ROMAN'}), 'Figure 1.I');
  await q.exec('references.caption', captionDialog.toCommand({...v, text: 'Sales'}).params);
  await q.exec('references.captionLabels', {add: 'Plate'});
  assert.ok(open(q, captionDialog).labels.includes('Plate'), 'a new label stays the person\'s');
  assert.ok(open(q, figuresDialog).labels.includes('Plate'));
  let x = open(q, crossRefDialog);
  x = changeDialogValues(crossRefDialog, x, 'to', 'figure');
  assert.equal(x.target, 'Figure 1: Sales');
  const call = crossRefDialog.toCommand({...x, show: 'number', hyperlink: false});
  assert.deepEqual(call.params, {to: 'figure', target: 'Figure 1: Sales', show: 'number', hyperlink: false});
  q.sel(blocks(q.t).length - 1, 4);
  await q.exec(call.command, call.params);
  assert.ok(blocks(q.t).at(-1).objects.some(o => o.type === 'field' && /^REF _Ref\d+$/.test(o.instr)), 'no \\h without Insert as hyperlink');
  q.sel(blocks(q.t).length - 1, 0, 3);
  const m = open(q, markDialog);
  assert.equal(m.entry, 'See');
  assert.deepEqual(markDialog.buttons.markAll(null, m), {command: 'references.markEntry', params: {entry: 'See', all: true, text: 'See'}});
  assert.deepEqual(indexDialog.toCommand(open(q, indexDialog)).params, {type: 'indented', columns: 1, rightAlign: false, tabLeader: 'dot', headings: true});
});

test('every References command parses its field codes as Word writes them (FieldCode)', () => {
  const f = parseField('TOC \\o "1-3" \\h \\z \\u \\t "Quote,2"');
  assert.equal(f.name, 'TOC');
  assert.deepEqual(f.switches, [['o', '1-3'], ['h', null], ['z', null], ['u', null], ['t', 'Quote,2']]);
  assert.deepEqual(parseField('XE "Kilns:firing" \\b').args, ['Kilns:firing']);
});

test('references.inToc answers whether the caret is in the table; references.updateFigures rebuilds a table of figures', async () => {
  const q = await headed();
  await q.exec('references.toc', {});
  q.sel(2, 0);
  assert.equal((await q.exec('references.inToc', {})).result.inToc, true);
  q.sel(blocks(q.t).length - 1, 0);
  assert.equal((await q.exec('references.inToc', {})).result.inToc, false);
  q.sel(blocks(q.t).length - 1, 0, 4);
  await q.exec('references.caption', {label: 'Figure', text: 'One'});
  await q.exec('caret.docEnd');
  await q.exec('text.newParagraph', {});
  await q.exec('references.tableOfFigures', {});
  q.sel(blocks(q.t).findIndex(b => b.props?.style === 'Caption'), 0);
  await q.exec('caret.docEnd');
  await q.exec('references.caption', {label: 'Figure', text: 'Two'});
  await q.exec('references.updateFigures', {});
  assert.deepEqual(paras(q).filter(p => p.props?.style === 'ListEntry').map(textOf), ['Figure 1: One\t1', 'Figure 2: Two\t1']);
});
