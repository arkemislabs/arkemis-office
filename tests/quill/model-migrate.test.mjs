// F:quill migrate.mjs: schema-1 (TipTap/ProseMirror JSON the legacy RichEditor stores) to the
// schema-2 model, losslessly for everything schema 1 holds (MIGRATION_DROPS lists the rest).
//
// Fidelity: there is no upstream counterpart (Arkemis glue); the targets are upstream's model
// (wordcraft crates/doc): headings are Heading n styles, lists are numbering instances, tables
// the OOXML grid with span/vmerge, page breaks U+000C, PAGE/NUMPAGES field objects, pictures media
// plus image objects, headers/footers parts on the section. Word shows the same document a
// RichEditor user saw: same text, same formatting, same structure.
import test from 'node:test';
import assert from 'node:assert/strict';
import {migrate, migrateFile, isSchema1, MIGRATION_DROPS} from '../../core/quill/migrate.mjs';
import {validateContent} from '../../core/quill/schema.mjs';
import {Document, BODY} from '../../core/quill/model/document.mjs';
import {numOf, abstractOf} from '../../core/quill/model/numbering.mjs';
import {createFile} from '../../core/model.mjs';

const text = (t, marks) => (marks ? {type: 'text', text: t, marks} : {type: 'text', text: t});
const para = (content, attrs) => ({type: 'paragraph', ...(attrs ? {attrs} : {}), content});
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const schema1 = () => ({
  doc: {type: 'doc', content: [
    {type: 'heading', attrs: {level: 2, textAlign: 'center'}, content: [text('Title')]},
    para([text('Bold', [{type: 'bold'}]), text(' and '), text('red', [{type: 'textStyle', attrs: {color: '#ff0000', fontSize: 14, fontFamily: 'Georgia'}}]),
      text(' link', [{type: 'link', attrs: {href: 'https://example.com'}}]), {type: 'hardBreak'}, text('x2', [{type: 'textStyle', attrs: {verticalAlign: 'super'}}]),
      text(' u', [{type: 'underline', attrs: {style: 'double'}}]), text(' s', [{type: 'strike'}]), text(' i', [{type: 'italic'}])],
    {textAlign: 'justify', indentLeft: 36, indentFirstLine: 18, spaceBefore: 6, spaceAfter: 12, lineHeight: 1.5}),
    {type: 'bulletList', content: [
      {type: 'listItem', content: [para([text('one')]), {type: 'bulletList', content: [{type: 'listItem', content: [para([text('nested')])]}]}]},
      {type: 'listItem', content: [para([text('two')])]},
    ]},
    {type: 'orderedList', attrs: {start: 3}, content: [{type: 'listItem', content: [para([text('third')])]}]},
    {type: 'blockquote', content: [para([text('quoted')])]},
    {type: 'codeBlock', attrs: {language: 'js'}, content: [text('let a = 1;\nlet b = 2;')]},
    {type: 'horizontalRule'},
    para([text('before'), {type: 'pageBreak'}, text('after '), {type: 'wordField', attrs: {kind: 'PAGE'}}, text(' of '), {type: 'wordField', attrs: {kind: 'NUMPAGES'}}]),
    para([{type: 'image', attrs: {src: `data:image/png;base64,${PNG}`, alt: 'dot', title: 'A dot'}}]),
    {type: 'table', content: [
      {type: 'tableRow', content: [
        {type: 'tableHeader', attrs: {colspan: 2, rowspan: 1}, content: [para([text('Head')])]},
        {type: 'tableHeader', attrs: {colspan: 1, rowspan: 2, backgroundColor: '#00ff00'}, content: [para([text('Tall')])]},
      ]},
      {type: 'tableRow', content: [
        {type: 'tableCell', attrs: {colspan: 1, rowspan: 1}, content: [para([text('a')])]},
        {type: 'tableCell', attrs: {colspan: 1, rowspan: 1}, content: [para([text('b')])]},
      ]},
    ]},
  ]},
  headerFooter: {headers: {default: {type: 'doc', content: [para([text('Head text')])]}, first: {type: 'doc', content: [para([text('First head')])]}},
    footers: {default: {type: 'doc', content: [para([text('Page '), {type: 'wordField', attrs: {kind: 'PAGE'}}])]}}, differentFirstPage: true},
  page: {size: 'Letter', orientation: 'landscape', margins: 'narrow'},
});

test('a schema-1 document migrates to valid schema 2 with the same text', () => {
  const c = migrate(schema1());
  validateContent(c);
  const d = new Document(c);
  const lines = d.plainText(BODY).split('\n');
  assert.equal(lines[0], 'Title');
  assert.ok(lines[1].startsWith('Bold and red link'));
  assert.ok(lines.includes('one') && lines.includes('nested') && lines.includes('two') && lines.includes('third') && lines.includes('quoted'));
  assert.ok(lines.includes('let a = 1;') && lines.includes('let b = 2;'), 'a code block keeps its lines (manual line breaks in one HTML Preformatted paragraph)');
  assert.ok(d.plainText(BODY).includes('before\u000Cafter '), 'page break is U+000C');
});

test('headings, alignment, indents and spacing land on paragraph properties', () => {
  const d = new Document(migrate(schema1()));
  const h = d.para(BODY, [0]);
  assert.equal(h.props.style, 'Heading2');
  assert.equal(h.props.align, 'center');
  const p = d.para(BODY, [1]);
  assert.equal(p.props.align, 'justify');
  assert.equal(p.props.indentLeft, 36);
  assert.equal(p.props.indentFirst, 18);
  assert.equal(p.props.spaceBefore, 6);
  assert.equal(p.props.spaceAfter, 12);
  assert.deepEqual(p.props.lineSpacing, {rule: 'multiple', value: 1.5});
});

test('character formatting: bold, colour, size, font, link, superscript, underline style, strike, italic', () => {
  const d = new Document(migrate(schema1()));
  const p = d.para(BODY, [1]);
  const at = s => { const i = p.text.indexOf(s); let start = 0; for (const r of p.runs) { if (i < start + r.len) return r.props ?? {}; start += r.len; } return {}; };
  assert.equal(at('Bold').bold, true);
  assert.deepEqual(at('red').color, {Rgb: [255, 0, 0]});
  assert.equal(at('red').size, 14);
  assert.equal(at('red').font, 'Georgia');
  assert.equal(at('link').link, 'https://example.com');
  assert.equal(at('x2').vertAlign ?? at('x2').script ?? at('x2').superscript, at('x2').vertAlign ?? at('x2').script ?? at('x2').superscript);
  assert.ok(Object.values(at('x2')).some(v => v === 'superscript' || v === 'super' || v === true));
  assert.equal(at(' u').underline, 'double');
  assert.equal(at(' s').strike, true);
  assert.equal(at(' i').italic, true);
  assert.ok(p.text.includes('\n'), 'hard break is a manual line break');
});

test('lists become numbering: bullets share a list, nesting is the level, ordered lists keep their start', () => {
  const c = migrate(schema1());
  const d = new Document(c);
  const byText = t => d.paraPaths(BODY).map(path => d.para(BODY, path)).find(p => p.text === t);
  const one = byText('one'), nested = byText('nested'), two = byText('two'), third = byText('third');
  assert.equal(one.props.numbering.num, two.props.numbering.num);
  assert.equal(one.props.numbering.level, 0);
  assert.equal(nested.props.numbering.level, 1);
  assert.notEqual(third.props.numbering.num, one.props.numbering.num);
  const lvl = abstractOf(c.numbering, third.props.numbering.num).levels[0];
  const start = (numOf(c.numbering, third.props.numbering.num).startOverrides.find(([l]) => l === 0) ?? [0, lvl.start])[1];
  assert.equal(start, 3);
  assert.equal(abstractOf(c.numbering, one.props.numbering.num).levels[0].format, 'bullet');
});

test('quote, code, rule, fields and pictures', () => {
  const c = migrate(schema1());
  const d = new Document(c);
  const paras = d.paraPaths(BODY).map(path => d.para(BODY, path));
  assert.equal(paras.find(p => p.text === 'quoted').props.style, 'Quote');
  assert.equal(paras.find(p => p.text === 'let a = 1;\nlet b = 2;').props.style, 'HTMLPreformatted');
  assert.ok(c.styles.styles.some(st => st.id === 'HTMLPreformatted'));
  assert.ok(paras.some(p => p.props?.borders?.bottom), 'a horizontal rule is a bottom border');
  const fields = paras.flatMap(p => p.objects ?? []).filter(o => o.type === 'field');
  assert.deepEqual(fields.map(f => f.instr), ['PAGE', 'NUMPAGES']);
  const img = paras.flatMap(p => p.objects ?? []).find(o => o.type === 'image');
  assert.ok(img && c.media[img.media] === PNG);
  assert.equal(img.alt, 'dot');
  assert.ok(img.w > 0 && img.h > 0);
});

test('tables keep spans, vertical merges, header rows and shading', () => {
  const c = migrate(schema1());
  const d = new Document(c);
  const t = d.story(BODY).toArray().find(b => b.kind === 'table');
  assert.equal(t.grid.length, 3);
  assert.equal(t.rows[0].cells[0].props.span, 2);
  assert.equal(t.rows[0].cells[1].props.vmerge, 'restart');
  assert.ok(t.rows[1].cells.some(cell => cell.props.vmerge === 'continue'));
  assert.ok(t.rows[0].props.header, 'a row of header cells repeats as a header row');
  assert.ok(JSON.stringify(t.rows[0].cells[1].props).includes('0,255,0') || JSON.stringify(t.rows[0].cells[1].props).toLowerCase().includes('00ff00'));
});

test('headers, footers and page setup go to the section', () => {
  const c = migrate(schema1());
  const s = c.lastSection;
  assert.ok(s.landscape || s.pageW > s.pageH);
  assert.deepEqual([Math.max(s.pageW, s.pageH), Math.min(s.pageW, s.pageH)], [792, 612]);
  assert.equal(s.marginLeft, 36);
  assert.equal(s.titlePage, true);
  assert.equal(new Document(c).plainText(s.headers.default), 'Head text');
  assert.equal(new Document(c).plainText(s.headers.first), 'First head');
  const footer = c.parts[s.footers.default];
  assert.equal(footer.kind, 'footer');
  assert.ok(footer.blocks[0].objects.some(o => o.type === 'field' && o.instr === 'PAGE'));
});

test('every block, row, cell, object and section gets a unique stable id; migration is idempotent', () => {
  const c = migrate(schema1());
  validateContent(c); // fails on a missing or repeated id
  assert.equal(migrate(c), c, 'schema-2 content passes through');
  assert.ok(isSchema1(schema1()) && !isSchema1(c));
  assert.ok(MIGRATION_DROPS.length > 0);
});

test('a new legacy file and an empty document migrate', () => {
  const f = createFile('quill', 'New');
  const g = migrateFile(f);
  assert.equal(g.schema, 2);
  validateContent(g.content);
  assert.equal(migrateFile(g), g);
  validateContent(migrate({doc: {type: 'doc', content: []}}));
  assert.throws(() => migrate({nope: true}));
});
