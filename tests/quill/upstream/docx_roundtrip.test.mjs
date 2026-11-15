// Ported from wordcraft crates/docx/tests/it/roundtrip.rs at aadb077e072b7de05f724e359d8db82e151f125c:
// build documents programmatically → write → read → compare. Each test names the Rust test it ports.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft_docx::write then read gives back the document it was given (every character,
//    paragraph, table, section, note, comment, revision and setting property), and a second save is
//    stable. Word's File > Save → File > Open keeps the same things.
// 2. Ours: core/quill/formats/docx-write.mjs + docx-read.mjs over the schema-2 model, the same
//    assertions on the same values (UTF-16 offsets; JSON shapes as the model README describes; a plain
//    upstream `bool` is absent when false).
// 3. These tests (engine). The File > Save path is covered by tests/quill/formats-docx.test.mjs
//    (formats-v2 routing, legacy reader) and the bridge E2E tests/e2e/quill/formats-docx-save.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {read} from '../../../core/quill/formats/docx-read.mjs';
import {writeDocx, write} from '../../../core/quill/formats/docx-write.mjs';
import {createContent, comment, revision} from '../../../core/quill/model/content.mjs';
import {Document} from '../../../core/quill/model/document.mjs';
import * as P from '../../../core/quill/model/para.mjs';
import {newTable, cellWithText, mergeCells} from '../../../core/quill/model/table.mjs';
import {addList} from '../../../core/quill/model/numbering.mjs';
import {upsertStyle, getStyle, style as newStyle, styleSetTablePart, styleTablePart, TABLE_PARTS} from '../../../core/quill/model/styles.mjs';
import {defaultSection} from '../../../core/quill/model/section.mjs';
import {bordersAll, bordersBox, singleBorder} from '../../../core/quill/model/props.mjs';

const f = Math.fround;
const rt = async c => read(await writeDocx(c));
const blocksOf = c => c.body.chunks.flat();
const parasOf = c => blocksOf(c).filter(b => b.kind === 'para');
const docWith = paras => createContent(paras);
const paraRuns = runs => { const p = P.newParagraph(); for (const [t, c] of runs) P.insertText(p, p.text.length, t, c); return p; };
const partText = (c, id) => (id === null || id === undefined || !c.parts[id] ? '' : c.parts[id].blocks.filter(b => b.kind === 'para').map(P.plainText).join('\n'));
/** JSON without ids (stable ids are an Arkemis addition; upstream compares without them). */
const noIds = v => JSON.parse(JSON.stringify(v, (k, x) => ((k === 'id' && typeof x === 'string') || k === 'oid' ? undefined : x)));
const sameJson = (a, b, msg) => assert.deepEqual(noIds(a), noIds(b), msg);
// A 3x2 PNG (any valid PNG: the writer sniffs the type).
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAFklEQVR42mNk+M9QzwAEjDAGDEMAAJr2BPJ1hxcKAAAAAElFTkSuQmCC';
const unzipText = async (bytes, name) => (await JSZip.loadAsync(bytes)).file(name).async('string');

test('roundtrip.rs every_char_prop_round_trips', async () => {
  const all = {
    style: 'Strong', font: 'Georgia', symFont: 'Wingdings', size: 10.5, bold: true, italic: false, underline: 'dotDash', underlineColor: [1, 2, 3],
    strike: true, doubleStrike: false, color: {Rgb: [0xaa, 0x10, 0x20]}, highlight: 'turquoise', shading: [0xee, 0xee, 0x00],
    border: {style: 'double', width: 1.5, color: [0xc0, 0, 0], space: 2}, vertAlign: 'superscript', caps: true, smallCaps: false, hidden: true,
    spacing: 1.5, scale: 150, position: 3, kern: 8, ligatures: {standard: true, contextual: false, historical: true, discretional: false},
    outline: true, shadow: true, emboss: false, engrave: true, lang: 'fr-FR', noProof: true, rtl: false, cs: true, fontCs: 'B Nazanin',
    fontEa: '宋体', sizeCs: 13, boldCs: false, italicCs: true, langBidi: 'fa-IR', langEa: 'ja-JP',
    eastAsianLayout: {id: 3, combine: true, combineBrackets: 'square', vert: false, vertCompress: true},
  };
  const auto = {color: 'Auto', highlight: 'none', vertAlign: 'subscript'};
  const d = docWith([paraRuns([['plain ', {}], ['everything', all], [' auto', auto]])]);
  const p = parasOf(await rt(d))[0];
  assert.equal(p.text, 'plain everything auto');
  assert.equal(p.runs.length, 3);
  assert.deepEqual(p.runs[1].props, all);
  assert.deepEqual(p.runs[2].props, auto);
  assert.equal(p.runs[0].props, undefined);
});

test('roundtrip.rs every_para_prop_round_trips', async () => {
  const b = {style: 'double', width: 0.75, color: [9, 8, 7], space: 4};
  const pp = {
    style: 'Heading1', align: 'justify', indentLeft: 36, indentRight: 18, indentFirst: -18, indentLeftChars: 1.5, indentRightChars: 0,
    indentFirstChars: -1, spaceBefore: 6, spaceAfter: 12, spaceBeforeAuto: true, spaceAfterAuto: false, lineSpacing: {rule: 'multiple', value: 1.5},
    contextualSpacing: true, mirrorIndents: true, keepNext: true, keepLines: false, pageBreakBefore: true, widowControl: false, outlineLevel: 2,
    numbering: {num: 0, level: 0},
    tabs: [{pos: 72, align: 'center', leader: 'dot'}, {pos: 144, align: 'right', leader: 'none'}, {pos: 200, align: 'decimal', leader: 'underscore'},
      {pos: 216, align: 'clear', leader: 'none'}, {pos: 250, align: 'bar', leader: 'middleDot'}],
    shading: [0xdd, 0xee, 0xff], borders: {top: b, left: singleBorder(0.5), bottom: b, between: b},
    suppressHyphens: true, suppressLineNumbers: true, bidi: false,
    frame: {w: 144, h: 36, hExact: true, x: 0, y: 12, xAlign: 'right', hAnchor: 'margin', vAnchor: 'text', wrap: 'around', hSpace: 9, vSpace: 0},
    kinsoku: false, wordWrap: false, overflowPunct: false, topLinePunct: true, autoSpaceDE: false, autoSpaceDN: true, snapToGrid: false,
  };
  const variants = [
    {lineSpacing: {rule: 'atLeast', value: 14}, indentFirst: 24, align: 'center'},
    {lineSpacing: {rule: 'exactly', value: 20}, align: 'right'},
    {align: 'distribute'},
    {kinsoku: true, wordWrap: true, autoSpaceDN: false},
    {},
  ];
  const ps = [P.paragraphWithText('main')];
  ps[0].props = pp;
  ps[0].mark = {bold: true, size: 14};
  for (const v of variants) { const p = P.paragraphWithText('v'); if (Object.keys(v).length) p.props = v; ps.push(p); }
  const got = parasOf(await rt(docWith(ps)));
  assert.deepEqual(got[0].props, pp);
  assert.deepEqual(got[0].mark, {bold: true, size: 14});
  variants.forEach((v, i) => assert.deepEqual(got[i + 1].props ?? {}, v, `variant ${i}`));
});

test('roundtrip.rs styles_and_lists_round_trip', async () => {
  const d = createContent();
  d.styles = upsertStyle(d.styles, newStyle({id: 'MyStyle', name: 'My Style', kind: 'paragraph', basedOn: 'Normal', next: 'Normal', linked: 'MyStyleChar',
    para: {spaceAfter: 3, align: 'center'}, chr: {italic: true, color: {Rgb: [1, 2, 3]}}, priority: 5, quick: true, hidden: false, builtin: false,
    locked: true}));
  d.styles = upsertStyle(d.styles, newStyle({id: 'MyStyleChar', name: 'My Style Char', kind: 'character', linked: 'MyStyle', chr: {italic: true}, hidden: true}));
  const list = kind => { const r = addList(d.numbering, kind); d.numbering = r.numbering; return r.num; };
  const bullets = list('bullet');
  const nums = list('legal');
  const outline = list('outline');
  d.numbering.nums.find(n => n.id === outline).startOverrides.push([0, 4]);
  const ps = [bullets, nums, nums, outline].map((num, i) => { const p = P.paragraphWithText(`item ${i}`); p.props = {style: 'MyStyle', numbering: {num, level: i % 2}}; return p; });
  d.body = createContent(ps).body;
  const r = await rt(d);
  assert.deepEqual(r.numbering, d.numbering);
  assert.deepEqual(r.styles.defaultChr, d.styles.defaultChr);
  assert.deepEqual(r.styles.defaultPara, d.styles.defaultPara);
  for (const s of d.styles.styles) assert.deepEqual(getStyle(r.styles, s.id), s, `style ${s.id}`);
  assert.equal(r.styles.styles.length, d.styles.styles.length);
  assert.deepEqual(parasOf(r)[1].props.numbering, {num: nums, level: 1});
});

test('roundtrip.rs tables_with_merges_round_trip', async () => {
  const doc = new Document(createContent());
  let t = newTable(3, 3, 468);
  Object.assign(t.props, {width: 468, align: 'center', indent: 5, borders: bordersAll(singleBorder(0.5)), cellMargins: [1, 5.4, 1, 5.4], fixed: true,
    look: {headerRow: true, totalRow: true, bandedRows: false, firstColumn: false, lastColumn: true, bandedColumns: true}, shading: [1, 1, 1], caption: 'Sales'});
  t.rows[0].props = {height: 20, heightRule: 'exact', header: true, cantSplit: true};
  t.rows[1].props = {height: 15, heightRule: 'atLeast'};
  t = mergeCells(t, 0, 0, 0, 1); // horizontal
  t = mergeCells(t, 1, 2, 2, 2); // vertical
  const c = t.rows[1].cells[0];
  Object.assign(c.props, {shading: [0xff, 0, 0], valign: 'bottom', textDirection: 'up', noWrap: true, margins: [2, 3, 4, 5], widthPct: 40,
    borders: bordersBox({style: 'dashed', width: 1, color: [0, 0, 255], space: 0})});
  delete c.props.width;
  c.blocks = [P.paragraphWithText('red')];
  t.rows[2].cells[0].blocks = [newTable(1, 2, 100), P.newParagraph()];
  const d = createContent([P.paragraphWithText('before'), t, P.newParagraph()]);
  void doc;
  const got = blocksOf(await rt(d))[1];
  assert.equal(got.kind, 'table');
  assert.deepEqual(got.props, t.props);
  assert.deepEqual(got.grid, t.grid);
  assert.equal(got.rows.length, 3);
  got.rows.forEach((gr, i) => {
    const er = t.rows[i];
    assert.deepEqual(gr.props, er.props, `row ${i}`);
    assert.equal(gr.cells.length, er.cells.length);
    gr.cells.forEach((gc, j) => { assert.deepEqual(gc.props, er.cells[j].props, `cell ${i},${j}`); sameJson(gc.blocks, er.cells[j].blocks); });
  });
  assert.equal(got.rows[0].cells[0].props.span, 2);
  assert.equal(got.rows[2].cells[2].props.vmerge, 'continue');
});

test('roundtrip.rs sections_headers_footers_round_trip', async () => {
  const page = instr => { const p = P.paragraphWithText('Page '); P.insertObject(p, 5, {type: 'field', instr, result: '1', locked: false}); return p; };
  const doc = new Document(createContent());
  const h1 = doc.addPart('header', [P.paragraphWithText('Header one')]);
  const hf = doc.addPart('header', [P.paragraphWithText('First page header')]);
  const f1 = doc.addPart('footer', [page('PAGE')]);
  const f2 = doc.addPart('footer', [page('NUMPAGES')]);
  const d = doc.c;
  const s1 = {...defaultSection(), titlePage: true, pageNumStart: 3, pageNumFormat: 'upperRoman', valign: 'center', pageBorders: bordersBox(singleBorder(1)),
    lineNumbers: {countBy: 5, start: 1, distance: 18, restart: 'section'}, gutter: 18, docGrid: {type: 'linesAndChars', linePitch: 17.5, charSpace: -1843}};
  s1.headers = {default: h1, first: hf, even: null};
  s1.footers = {default: f1, first: null, even: null};
  const s2 = {...defaultSection(), start: 'oddPage', rtl: true, docGrid: {type: 'default', linePitch: 18, charSpace: 0}};
  Object.assign(s2, {landscape: true, pageW: 792, pageH: 612});
  s2.columns = {count: 2, space: 24, separator: true, widths: []};
  s2.footers = {default: f2, first: null, even: null};
  s2.headers = {default: h1, first: null, even: null};
  const s3 = {...defaultSection(), start: 'continuous', columns: {count: 2, space: 10, separator: false, widths: [[200, 20], [248, 0]]}};
  const p1 = P.paragraphWithText('Section one'); p1.section = s1;
  const p2 = P.paragraphWithText('Section two'); p2.section = s2;
  d.body = createContent([p1, p2, P.paragraphWithText('Last')]).body;
  d.lastSection = s3;
  const r = await rt(d);
  const secs = new Document(r).sections();
  assert.equal(secs.length, 3);
  const strip = s => noIds({...s, headers: null, footers: null});
  assert.deepEqual(strip(secs[0][1]), strip(s1));
  assert.deepEqual(strip(secs[1][1]), strip(s2));
  assert.deepEqual(strip(secs[2][1]), strip(s3));
  assert.equal(partText(r, secs[0][1].headers.default), 'Header one');
  assert.equal(partText(r, secs[0][1].headers.first), 'First page header');
  assert.equal(secs[0][1].headers.default, secs[1][1].headers.default, 'shared header part stays shared');
  const fp = r.parts[secs[0][1].footers.default].blocks[0];
  sameJson(fp.objects, [{type: 'field', instr: 'PAGE', result: '1', locked: false}]);
  assert.equal(partText(r, secs[1][1].footers.default), 'Page 1');
  assert.equal(r.parts[secs[0][1].headers.default].kind, 'header');
});

test('roundtrip.rs images_round_trip', async () => {
  const doc = new Document(createContent());
  const key = doc.addMedia(TINY_PNG, 'png');
  const fl = (o = {}) => ({...P.defaultFloat(), ...o});
  const inline = {type: 'image', media: key, w: 72, h: 48, alt: 'A tiny picture', float: fl({effect: [12, 12, 27, 27]}), crop: [0.1, 0, 0.25, 0.05]};
  const floating = {type: 'image', media: key, w: 100, h: 50, alt: '', float: fl({wrap: 'square', hRel: 'page', vRel: 'margin', x: 36, y: 12.5, dist: 9}), crop: [0, 0, 0, 0]};
  const aligned = {type: 'image', media: key, w: 20, h: 20, alt: '', crop: [0, 0, 0, 0],
    float: fl({wrap: 'square', hRel: 'rightMargin', hAlign: 'center', vRel: 'topMargin', vAlign: 'end', dist: 9, distTop: 2.5, distBottom: 4})};
  const floats = [floating, aligned];
  for (const wrap of ['tight', 'through', 'topAndBottom', 'behindText', 'inFrontOfText']) {
    floats.push({type: 'image', media: key, w: 10, h: 10, alt: '', crop: [0, 0, 0, 0], float: fl({wrap, hRel: 'column', vRel: 'paragraph'})});
  }
  const p = P.paragraphWithText('pic: ');
  P.insertObject(p, 5, inline);
  for (const o of floats) P.insertObject(p, p.text.length, o);
  const d = doc.c;
  d.body = createContent([p]).body;
  const r = await rt(d);
  const got = parasOf(r)[0].objects.map(o => { if (o.float?.z !== undefined) { const fz = {...o.float}; delete fz.z; return {...o, float: fz}; } return o; });
  sameJson(got, [inline, ...floats]);
  assert.equal(r.media[key], TINY_PNG);
  assert.equal(Object.keys(r.media).length, 1);
});

test('roundtrip.rs hyperlinks_and_bookmarks_round_trip', async () => {
  const ext = {link: 'https://example.com/a?b=1&c=2', underline: 'single'};
  const int = {link: '#target'};
  const p = paraRuns([['see ', {}], ['example', ext], [' and ', {}], ['here', int]]);
  P.insertObject(p, 0, {type: 'bookmarkStart', name: 'target'});
  P.insertObject(p, p.text.length, {type: 'bookmarkEnd', name: 'target'});
  const r = await rt(docWith([structuredClone(p)]));
  const got = parasOf(r)[0];
  assert.equal(got.text, p.text);
  sameJson(got.objects, p.objects);
  assert.deepEqual(P.propsOfChar(got, got.text.indexOf('example')), ext);
  assert.deepEqual(P.propsOfChar(got, got.text.indexOf('here')), int);
  assert.equal(new Document(r).bookmarks().length, 1);
});

test('roundtrip.rs comments_round_trip', async () => {
  const doc = new Document(createContent());
  const c0 = doc.addPart('comment', [P.paragraphWithText('Please check this.')]);
  const c1 = doc.addPart('comment', [P.paragraphWithText('Done.')]);
  const d = doc.c;
  d.comments = {0: comment({author: 'Ann', initials: 'A', date: '2026-01-02T03:04:05Z', parent: null, resolved: true, part: c0}),
    1: comment({author: 'Ben', initials: 'B', date: '2026-01-03T00:00:00Z', parent: 0, resolved: false, part: c1})};
  const p = P.paragraphWithText('commented text');
  P.insertObject(p, 0, {type: 'commentStart', id: 0});
  P.insertObject(p, p.text.length, {type: 'commentEnd', id: 0});
  d.body = createContent([structuredClone(p)]).body;
  const r = await rt(d);
  sameJson(parasOf(r)[0].objects, p.objects);
  assert.equal(Object.keys(r.comments).length, 2);
  for (const [id, c] of Object.entries(d.comments)) {
    const g = r.comments[id];
    assert.ok(g, 'comment');
    assert.deepEqual([g.author, g.initials, g.date, g.parent, g.resolved], [c.author, c.initials, c.date, c.parent, c.resolved]);
    assert.equal(partText(r, g.part), partText(d, c.part));
    assert.equal(r.parts[g.part].kind, 'comment');
  }
});

test('roundtrip.rs table_style_formatting_round_trips', async () => {
  const d = docWith([P.paragraphWithText('x')]);
  const parts = {borders: {top: singleBorder(1)}, fill: [0xdd, 0xeb, 0xf7], cellMargins: [1, 14.4, 0, 14.4], headerChr: {italic: true}, headerFill: [0xff, 0xff, 0],
    headerBorders: bordersAll(singleBorder(1.5)), bandFill: [0xf2, 0xf2, 0xf2], bandChr: {bold: true, color: {Rgb: [0, 0x70, 0xc0]}},
    bandBorders: bordersBox({style: 'none', width: 0, color: null, space: 0}), bandSize: 3};
  d.styles = upsertStyle(d.styles, newStyle({id: 'Whole', name: 'Whole', kind: 'table', basedOn: 'TableGrid', para: {align: 'center', spaceAfter: 0},
    chr: {bold: true, color: {Rgb: [0xc0, 0, 0]}}, table: parts}));
  const got = getStyle((await rt(d)).styles, 'Whole');
  assert.equal(got.basedOn, 'TableGrid');
  assert.equal(got.para.align, 'center');
  assert.equal(got.para.spaceAfter, 0);
  assert.deepEqual([got.chr.bold, got.chr.color], [true, {Rgb: [0xc0, 0, 0]}]);
  assert.deepEqual(got.table, parts);
});

test('roundtrip.rs every_table_style_part_round_trips', async () => {
  const d = docWith([P.paragraphWithText('x')]);
  let st = newStyle({id: 'Parts', name: 'Parts', kind: 'table', basedOn: 'TableGrid'});
  const aligns = ['left', 'center', 'right'], valigns = ['top', 'center', 'bottom'];
  TABLE_PARTS.forEach((part, i) => {
    const fmt = {
      chr: {bold: i % 2 === 0, italic: i % 3 === 0, ...(i % 4 === 0 ? {underline: 'single'} : {}), size: 8 + i, font: `Face ${i}`, color: {Rgb: [i, 0x20, 0x40]}},
      fill: [0x10 + i, 0x80, 0xf0 - i],
      borders: {top: {style: 'double', width: 1.5, color: [i, 0, 0], space: 0}, bottom: singleBorder(f(0.5 + i / 4)), left: {style: 'none', width: 0, color: null, space: 0},
        ...(i % 2 === 1 ? {inside_v: singleBorder(0.25)} : {})},
      align: aligns[i % 3], vAlign: valigns[i % 3],
    };
    st = styleSetTablePart(st, part, fmt) ?? st;
  });
  d.styles = upsertStyle(d.styles, st);
  const r = await rt(d);
  const got = getStyle(r.styles, 'Parts');
  for (const part of TABLE_PARTS) assert.deepEqual(styleTablePart(got, part), styleTablePart(st, part), part);
  assert.deepEqual(got.table, st.table);
});

test('roundtrip.rs notes_round_trip', async () => {
  const doc = new Document(createContent());
  const fn1 = doc.addPart('footnote', [P.paragraphWithText('A footnote.')]);
  const fn2 = doc.addPart('footnote', [P.paragraphWithText('Custom.')]);
  const en = doc.addPart('endnote', [P.paragraphWithText('An endnote.'), P.paragraphWithText('Second para.')]);
  const d = doc.c;
  const p = P.paragraphWithText('Text');
  const sup = {vertAlign: 'superscript'};
  P.insertObject(p, 4, {type: 'noteRef', kind: 'footnote', id: fn1}, sup);
  P.insertObject(p, 1, {type: 'noteRef', kind: 'endnote', id: en}, sup);
  P.insertObject(p, p.text.length, {type: 'noteRef', kind: 'footnote', id: fn2, custom: '*'}, sup);
  d.settings.footnoteFormat = 'lowerLetter';
  d.settings.endnoteFormat = 'upperRoman';
  d.body = createContent([structuredClone(p)]).body;
  const r = await rt(d);
  const got = parasOf(r)[0];
  assert.equal(got.text, p.text);
  assert.deepEqual(got.runs, p.runs);
  assert.deepEqual(got.objects.map(o => [o.kind, partText(r, o.id), o.custom ?? '']),
    [['endnote', 'An endnote.\nSecond para.', ''], ['footnote', 'A footnote.', ''], ['footnote', 'Custom.', '*']]);
  assert.equal(r.settings.footnoteFormat, 'lowerLetter');
  assert.equal(r.settings.endnoteFormat, 'upperRoman');
});

test('roundtrip.rs note_options_round_trip_per_section', async () => {
  const d = createContent();
  d.settings.footnoteFormat = 'upperLetter';
  d.settings.footnotePr = {pos: 'beneathText', numStart: 4, numRestart: 'eachPage'};
  d.settings.endnotePr = {pos: 'sectEnd'};
  const first = P.paragraphWithText('Section one');
  const own = {numFmt: 'lowerRoman', numStart: 7, numRestart: 'eachSect'};
  first.section = {...defaultSection(), footnotePr: own, endnotePr: {numFmt: 'decimal'}};
  d.body = createContent([first, P.paragraphWithText('Section two')]).body;
  const bytes = await writeDocx(d);
  const r = await read(bytes);
  assert.equal(r.settings.footnoteFormat, 'upperLetter');
  assert.deepEqual([r.settings.footnotePr, r.settings.endnotePr], [d.settings.footnotePr, d.settings.endnotePr]);
  const rd = new Document(r);
  const sections = rd.sections();
  assert.deepEqual(sections[0][1].footnotePr, own);
  assert.equal(sections[0][1].endnotePr.numFmt, 'decimal');
  assert.equal(rd.noteOptions(sections[0][1], false).numStart, 7);
  assert.equal(rd.noteOptions(sections[1][1], false).numStart, 4);
  const xml = await unzipText(bytes, 'word/document.xml');
  const at = s => { const i = xml.indexOf(s); assert.ok(i >= 0, `${s} missing`); return i; };
  assert.ok(at('<w:footnotePr><w:numFmt w:val="lowerRoman"/><w:numStart w:val="7"/><w:numRestart w:val="eachSect"/></w:footnotePr>') < at('<w:type'));
});

test('roundtrip.rs tracked_changes_round_trip', async () => {
  const d = createContent();
  d.revisions = [revision('insert', 'Alice', '2026-05-01T10:00:00Z'), revision('delete', 'Bob', '2026-05-02T10:00:00Z')];
  d.settings.trackChanges = true;
  const ins = {ins: 0}, del = {del: 1, bold: true}, both = {ins: 0, del: 1};
  const p = paraRuns([['kept ', {}], ['added\t', ins], ['removed', del], ['gone', both]]);
  P.insertObject(p, p.text.length, {type: 'field', instr: 'DATE', result: 'today', locked: false}, del);
  d.body = createContent([structuredClone(p)]).body;
  const r = await rt(d);
  assert.deepEqual(r.revisions, d.revisions);
  const got = parasOf(r)[0];
  assert.equal(got.text, p.text);
  assert.deepEqual(got.runs, p.runs);
  sameJson(got.objects, p.objects);
  assert.equal(r.settings.trackChanges, true);
});

test('roundtrip.rs tracked_paragraph_marks_round_trip', async () => {
  const d = createContent();
  d.revisions = [revision('insert', 'Alice', '2026-05-01T10:00:00Z'), revision('delete', 'Bob', '2026-05-02T10:00:00Z')];
  const split = P.paragraphWithText('Owned ALPHA '); split.mark = {ins: 0};
  const joined = P.paragraphWithText('Owned BETA'); joined.mark = {bold: true, del: 1};
  d.body = createContent([split, joined, P.paragraphWithText('plain')]).body;
  const bytes = await writeDocx(d);
  const xml = await unzipText(bytes, 'word/document.xml');
  assert.ok(xml.includes('<w:rPr><w:ins w:id='), xml);
  assert.ok(xml.includes('<w:rPr><w:del w:id='), xml);
  const r = await read(bytes);
  const got = parasOf(r);
  assert.equal(got.length, 3);
  const rev = i => (i === undefined || i === null ? null : [r.revisions[i].kind, r.revisions[i].author, r.revisions[i].date]);
  assert.deepEqual(rev(got[0].mark?.ins), ['insert', 'Alice', '2026-05-01T10:00:00Z']);
  assert.equal(got[0].mark?.del, undefined);
  assert.deepEqual(rev(got[1].mark?.del), ['delete', 'Bob', '2026-05-02T10:00:00Z']);
  assert.equal(got[1].mark.bold, true);
  assert.equal(got[1].mark.ins, undefined);
  assert.equal(got[2].mark, undefined);
  assert.deepEqual(got.map(p => p.text), ['Owned ALPHA ', 'Owned BETA', 'plain']);
});

test('roundtrip.rs fields_and_special_chars_round_trip', async () => {
  const p = P.paragraphWithText('a\tb\nc\u000Cd\u000Ee‑f­g  spaced  ');
  const fields = [
    {type: 'field', instr: 'PAGE', result: '4', locked: false},
    {type: 'field', instr: 'DATE \\@ "M/d/yyyy"', result: '1/2/2026', locked: true},
    {type: 'field', instr: 'NUMPAGES', result: '', locked: false},
  ];
  for (const fl of fields) P.insertObject(p, p.text.length, fl, {bold: true});
  const got = parasOf(await rt(docWith([structuredClone(p)])))[0];
  assert.equal(got.text, p.text);
  sameJson(got.objects, p.objects);
  assert.deepEqual(got.runs, p.runs);
});

test('roundtrip.rs settings_core_theme_round_trip', async () => {
  const d = createContent();
  Object.assign(d.settings, {trackChanges: true, defaultTab: 18, evenOddHeaders: true, mirrorMargins: true, autoHyphenation: true, hyphenationZone: 27,
    hyphenateCaps: false, consecutiveHyphenLimit: 2, pageColor: [250, 240, 230], majorFont: 'Cambria', minorFont: 'Calibri', themeName: 'Mine',
    protection: 'readOnly', gridH: 5.5, gridV: 18, math: {brkBin: 'repeat', brkBinSub: 'plusMinus', wrapIndent: 36, wrapRight: false}});
  d.settings.themeColors = d.settings.themeColors.map((c, i) => (i === 4 ? [1, 2, 3] : c));
  Object.assign(d.core, {title: 'Title & <stuff>', subject: 'Subj', creator: 'Me', keywords: 'a, b', description: 'Desc', category: 'Cat',
    lastModifiedBy: 'You', created: '2026-01-01T00:00:00Z', modified: '2026-02-01T00:00:00Z', revision: 7});
  const r = await rt(d);
  assert.deepEqual(r.settings, d.settings);
  assert.deepEqual(r.core, d.core);
});

/** roundtrip.rs kitchen_sink. */
function kitchenSink() {
  const doc = new Document(createContent());
  const key = doc.addMedia(TINY_PNG, 'png');
  const d = doc.c;
  const added = addList(d.numbering, 'numbered');
  d.numbering = added.numbering;
  const num = added.num;
  const h = doc.addPart('header', [P.paragraphWithText('Head')]);
  const fn = doc.addPart('footnote', [P.paragraphWithText('Note')]);
  const c = doc.addPart('comment', [P.paragraphWithText('Comment')]);
  d.comments = {3: comment({author: 'X', part: c})};
  d.revisions = [revision('insert', 'A', '')];
  d.lastSection.headers = {default: h, first: null, even: null};
  const p = paraRuns([['Hello ', {}], ['bold', {bold: true}], [' link', {link: 'https://x.org'}]]);
  P.insertObject(p, 0, {type: 'commentStart', id: 3});
  P.insertObject(p, p.text.length, {type: 'commentEnd', id: 3});
  P.insertObject(p, p.text.indexOf('bold'), {type: 'noteRef', kind: 'footnote', id: fn});
  const li = P.paragraphWithText('listed', {ins: 0});
  li.props = {numbering: {num, level: 0}};
  const img = P.newParagraph();
  P.insertObject(img, 0, {type: 'image', media: key, w: 30, h: 20, alt: 'pic', float: P.defaultFloat(), crop: [0, 0, 0, 0]});
  const t = newTable(2, 2, 300);
  t.rows[0].cells[0] = cellWithText('cell');
  d.body = createContent([p, li, img, t, P.newParagraph()]).body;
  d.sources = [{tag: 'Sink2026', kind: 'book', author: 'Author, First', title: 'Title', year: '2026', publisher: '', city: '', journal: '', volume: '',
    pages: '', url: '', editor: 'Editor, Chief', edition: '3rd', issue: '2', month: '08', day: '24', accessed: '2026-08-25', doi: '10.1234/sink.2026'}];
  return d;
}

test('roundtrip.rs second_generation_is_stable', async () => {
  const d1 = await rt(kitchenSink());
  const d2 = await rt(d1);
  for (const k of ['body', 'parts', 'styles', 'numbering', 'comments', 'revisions', 'settings', 'media', 'sources']) assert.deepEqual(d2[k], d1[k], k);
  assert.deepEqual(d2, d1);
  // Ids made on the first open are written as paraIds, so they survive every later save and open.
  assert.deepEqual(blocksOf(d2).map(b => b.id), blocksOf(d1).map(b => b.id));
});

test('roundtrip.rs builtin_stylesheet_survives', async () => {
  const d = createContent();
  const r = await rt(d);
  assert.deepEqual(r.styles, d.styles);
  sameJson(r.body, d.body); // paragraph ids: a model id that isn't a paraId is saved as a new one
  sameJson(r.lastSection, d.lastSection);
});

test('roundtrip.rs hostile_model_values_still_write', async () => {
  const d = createContent();
  const p = P.paragraphWithText('x\u0001￾y<&>"\'', {size: NaN, spacing: Infinity, font: 'A"B<'});
  p.props = {indentLeft: -Infinity, lineSpacing: {rule: 'multiple', value: NaN}};
  P.insertObject(p, 0, {type: 'opaque', format: 'docx', xml: '<w:r><w:t>raw</w:t></w:r>', text: 'raw'});
  P.insertObject(p, 0, {type: 'opaque', format: 'docx', xml: '<broken', text: 'fallback'});
  P.insertObject(p, 0, {type: 'image', media: 'missing.png', w: -5, h: NaN, alt: '', float: P.defaultFloat(), crop: [NaN, NaN, NaN, NaN]});
  P.insertObject(p, 0, {type: 'commentEnd', id: 99});
  P.insertObject(p, 0, {type: 'noteRef', kind: 'endnote', id: 12345});
  d.body = createContent([p]).body;
  d.media = {'weird name/../x': 'R0lGODlhLi4uLg==', '': 'AAEC'};
  const r = await read(await writeDocx(d));
  const t = P.plainText(parasOf(r)[0]);
  assert.ok(t.includes('y<&>"\''), t);
  assert.ok(t.includes('raw') && t.includes('fallback'), t);
  assert.deepEqual(r.media, {}, "media nothing references aren't written");
});

test('roundtrip.rs ensure_empty_and_table_end_document_is_valid', async () => {
  const d = createContent([newTable(1, 1, 100)]);
  const r = await rt(d);
  const bl = blocksOf(r);
  assert.equal(bl[0].kind, 'table');
  assert.equal(bl.at(-1).kind, 'para');
  const e = createContent();
  e.body = {chunks: [[]]};
  assert.equal(blocksOf(await rt(e)).length, 1);
});

test('formats-v2 contract: write(file) gives the .docx bytes of file.content', async () => {
  const content = docWith([P.paragraphWithText('via write()')]);
  const bytes = await write({kind: 'quill', schema: 2, title: 'T', content});
  assert.equal(parasOf(await read(bytes))[0].text, 'via write()');
});

// --- watermark (roundtrip.rs #1290, #3994) ---
const headerIds = c => Object.entries(c.parts).filter(([, p]) => p.kind === 'header').map(([id]) => Number(id));

test('roundtrip.rs watermark_roundtrips', async () => {
  const {defaultWatermark} = await import('../../../core/quill/model/content.mjs');
  for (const wm of [defaultWatermark(), {text: 'Riservato & <interno>', font: 'Georgia', color: [0x80, 0x10, 0x20], diagonal: false, semitransparent: false},
    {...defaultWatermark(), text: 'COPY', size: [300, 80]}]) {
    const d = docWith([P.paragraphWithText('Body')]);
    d.settings.watermark = wm;
    const r = await rt(d);
    assert.deepEqual(r.settings.watermark, wm);
    assert.equal(parasOf(r).length, 1, 'the body gains nothing');
  }
});

test('roundtrip.rs watermark_font_roundtrips_through_the_textpath_style', async () => {
  const {defaultWatermark} = await import('../../../core/quill/model/content.mjs');
  for (const font of ['Georgia', "Bob's Serif", 'A;Named:Font', 'Quote"Inside', 'Ends with \\', 'All "of" ;it: \'here\\', "'Serif'", "Trailing'"]) {
    const d = docWith([P.paragraphWithText('Body')]);
    d.settings.watermark = {...defaultWatermark(), font};
    assert.equal((await rt(d)).settings.watermark?.font, font, font);
  }
});

test('roundtrip.rs watermark_font_name_writes_wellformed_css', async () => {
  const {defaultWatermark} = await import('../../../core/quill/model/content.mjs');
  const d = docWith([P.paragraphWithText('Body')]);
  d.settings.watermark = {...defaultWatermark(), font: 'Ends with \\ and \n"quoted"'};
  const hdr = await unzipText(await writeDocx(d), 'word/header1.xml');
  const style = hdr.split('v:textpath style="')[1].split('"')[0];
  assert.ok(!style.includes('\n'), style);
  assert.ok(style.includes('font-family:&quot;Ends with \\5c  and \\22 quoted\\22 &quot;;'), style);
});

test('roundtrip.rs watermark_without_header_gains_one', async () => {
  const {defaultWatermark} = await import('../../../core/quill/model/content.mjs');
  const d = docWith([P.paragraphWithText('Body')]);
  d.settings.watermark = defaultWatermark();
  const bytes = await writeDocx(d);
  const hdr = await unzipText(bytes, 'word/header1.xml');
  assert.equal(hdr.split('<v:shape ').length - 1, 1);
  assert.ok(hdr.includes('id="PowerPlusWaterMarkObject1"') && hdr.includes('rotation:315') && hdr.includes('<v:fill opacity=".5"/>'));
  assert.ok(hdr.includes('path="m0,0l21600,0m0,21600l21600,21600e"'));
  assert.ok((await unzipText(bytes, 'word/document.xml')).includes('<w:headerReference w:type="default"'));
  const r = await read(bytes);
  assert.deepEqual(r.settings.watermark, d.settings.watermark);
  const ids = headerIds(r);
  assert.equal(ids.length, 1);
  assert.equal(r.lastSection.headers.default, ids[0]);
  const blocks = r.parts[ids[0]].blocks;
  assert.equal(blocks.length, 1);
  assert.ok(!blocks[0].text && !(blocks[0].objects ?? []).length, 'the shape leaves nothing behind');
  const r2 = await rt(r);
  assert.deepEqual(r2.settings.watermark, d.settings.watermark);
  assert.equal(headerIds(r2).length, 1);
  assert.equal(r2.parts[headerIds(r2)[0]].blocks.length, 1);
});

test('roundtrip.rs watermark_joins_existing_headers', async () => {
  const {defaultWatermark} = await import('../../../core/quill/model/content.mjs');
  const doc = new Document(docWith([P.paragraphWithText('Body')]));
  const h = doc.addPart('header', [P.paragraphWithText('Head')]);
  const hf = doc.addPart('header', [P.paragraphWithText('First')]);
  const fo = doc.addPart('footer', [P.paragraphWithText('Foot')]);
  const d = doc.c;
  d.lastSection = {...d.lastSection, headers: {default: h, first: hf, even: null}, titlePage: true, footers: {default: fo, first: null, even: null}};
  d.settings.watermark = defaultWatermark();
  const bytes = await writeDocx(d);
  for (const name of ['word/header1.xml', 'word/header2.xml']) assert.equal((await unzipText(bytes, name)).split('<v:shape ').length - 1, 1, name);
  assert.ok(!(await unzipText(bytes, 'word/footer1.xml')).includes('v:shape'));
  const r = await read(bytes);
  assert.deepEqual(r.settings.watermark, d.settings.watermark);
  assert.equal(headerIds(r).length, 2, 'no header was added');
  assert.equal(partText(r, r.lastSection.headers.default), 'Head');
  assert.equal(partText(r, r.lastSection.headers.first), 'First');
  for (const id of headerIds(r)) assert.equal(r.parts[id].blocks.length, 1);
});

test('roundtrip.rs watermark_header_respects_linking + watermark_even_pages_header', async () => {
  const {defaultWatermark} = await import('../../../core/quill/model/content.mjs');
  for (const even of [false, true]) {
    const doc = new Document(createContent());
    const h = doc.addPart('header', [P.paragraphWithText('Head')]);
    const d = doc.c;
    const p1 = P.paragraphWithText('One');
    p1.section = {...defaultSection(), headers: {default: h, first: null, even: null}, titlePage: !even};
    d.body = createContent([p1, P.paragraphWithText('Two')]).body;
    d.lastSection = {...d.lastSection, titlePage: !even};
    if (even) d.settings.evenOddHeaders = true;
    d.settings.watermark = defaultWatermark();
    const r = await rt(d);
    assert.deepEqual(r.settings.watermark, d.settings.watermark);
    const secs = new Document(r).sections();
    assert.equal(partText(r, secs[0][1].headers.default), 'Head');
    if (even) assert.ok(secs[0][1].headers.even !== null && secs[0][1].headers.first === null);
    else assert.equal(partText(r, secs[0][1].headers.first), '');
    assert.deepEqual(secs[1][1].headers, {default: null, first: null, even: null}, 'the second section still links to the first');
    assert.equal(headerIds(r).length, 2);
  }
});

test('roundtrip.rs watermark_in_table_only_header + blank_watermark_writes_nothing', async () => {
  const {defaultWatermark} = await import('../../../core/quill/model/content.mjs');
  const doc = new Document(docWith([P.paragraphWithText('Body')]));
  const h = doc.addPart('header', [newTable(1, 2, 400)]);
  const d = doc.c;
  d.lastSection = {...d.lastSection, headers: {default: h, first: null, even: null}};
  const blocks = c => c.parts[c.lastSection.headers.default].blocks.length;
  const plain = blocks(await rt(d));
  d.settings.watermark = defaultWatermark();
  const r = await rt(d);
  assert.deepEqual(r.settings.watermark, d.settings.watermark);
  assert.equal(blocks(r), plain);
  const b = docWith([P.paragraphWithText('Body')]);
  b.settings.watermark = {...defaultWatermark(), text: '  '};
  const rb = await rt(b);
  assert.equal(rb.settings.watermark, null);
  assert.deepEqual(headerIds(rb), []);
});
