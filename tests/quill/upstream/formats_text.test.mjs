// Ported from wordcraft crates/formats/src/tests.rs, src/model.rs (tests), src/markdown/tests.rs and
// src/html/tests.rs at aadb077e072b7de05f724e359d8db82e151f125c. Each test names the Rust test it ports.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: crates/formats imports and exports plain text, Markdown and HTML through its flow model
//    (headings, formatted runs, links, nested lists, tables, quotes, code, pictures), the way Word's
//    Save As > Plain Text / Web Page and File > Open of those files keep a document's structure.
// 2. Ours: core/quill/formats/{_flow,txt-*,md-*,html-*}.mjs translate those modules onto the schema-2
//    model; the same assertions on the same inputs. Equations in HTML are the one difference
//    (linear text in <math><mtext>, MathML conversion not translated; see html-write.mjs).
// 3. These tests (engine) plus tests/quill/formats-docx.test.mjs (formats-v2 routing: File > Save As
//    and File > Open dispatch by extension to these modules).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../../../core/quill/formats/_flow.mjs';
import * as TR from '../../../core/quill/formats/txt-read.mjs';
import * as TW from '../../../core/quill/formats/txt-write.mjs';
import * as MR from '../../../core/quill/formats/md-read.mjs';
import * as MW from '../../../core/quill/formats/md-write.mjs';
import * as HR from '../../../core/quill/formats/html-read.mjs';
import * as HW from '../../../core/quill/formats/html-write.mjs';
import {createContent} from '../../../core/quill/model/content.mjs';
import {Document} from '../../../core/quill/model/document.mjs';
import * as P from '../../../core/quill/model/para.mjs';
import {addList} from '../../../core/quill/model/numbering.mjs';
import {newTable} from '../../../core/quill/model/table.mjs';

const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);
const PNG = F.base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAFklEQVR42mNk+M9QzwAEjDAGDEMAAJr2BPJ1hxcKAAAAAElFTkSuQmCC');
const FORMATS = {txt: [TR, TW], md: [MR, MW], html: [HR, HW]};
const exportAs = (ext, c) => FORMATS[ext][1].write({content: c});
const importAs = (ext, b) => FORMATS[ext][0].read(b);
const plain = c => c.body.chunks.flat().filter(b => b.kind === 'para').map(P.plainText).join('\n');
const styled = (t, st) => { const p = P.paragraphWithText(t); p.props = {style: st}; return p; };

/** tests.rs `sample`: headings, formatted runs, a link, nested lists, a table, a quote, code and a picture. */
function sample() {
  const c = createContent();
  c.core.title = 'Sample Title';
  c.core.creator = 'Ada Writer';
  const blocks = [styled('Main Heading', 'Heading1')];
  const p = P.paragraphWithText('Plain ');
  for (const [t, cp] of [['bold', {bold: true}], [' and ', {}], ['italic', {italic: true}], [' then ', {}], ['a link', {link: 'https://example.com/x'}], ['.', {}]]) P.insertText(p, p.text.length, t, cp);
  blocks.push(p, styled('Second Level', 'Heading2'));
  let r = addList(c.numbering, 'bullet'); c.numbering = r.numbering; const bul = r.num;
  r = addList(c.numbering, 'numbered'); c.numbering = r.numbering; const num = r.num;
  for (const [t, nm, lvl] of [['first bullet', bul, 0], ['second bullet', bul, 0], ['nested bullet', bul, 1]]) { const q = styled(t, 'ListParagraph'); q.props.numbering = {num: nm, level: lvl}; blocks.push(q); }
  blocks.push(P.paragraphWithText('Between lists'));
  for (const t of ['step one', 'step two']) { const q = styled(t, 'ListParagraph'); q.props.numbering = {num, level: 0}; blocks.push(q); }
  const tb = newTable(2, 2, 400);
  for (const [ri, ci, s] of [[0, 0, 'Name'], [0, 1, 'Value'], [1, 0, 'alpha'], [1, 1, '42']]) tb.rows[ri].cells[ci].blocks = [P.paragraphWithText(s)];
  blocks.push(tb, styled('A wise quote', 'Quote'));
  const ctr = P.paragraphWithText('Centered text'); ctr.props = {align: 'center'}; blocks.push(ctr);
  const doc = new Document(c);
  const key = doc.addMedia(F.base64Encode(PNG), 'png');
  const ip = P.paragraphWithText('Picture: ');
  P.insertObject(ip, ip.text.length, {type: 'image', media: key, w: 60, h: 30, alt: 'tiny', float: P.defaultFloat(), crop: [0, 0, 0, 0]});
  blocks.push(ip, P.paragraphWithText('The end'));
  const out = doc.c;
  out.body = createContent(blocks).body;
  return out;
}
const flat = c => F.fromContent(c).blocks;
function paraTexts(c) {
  const out = [];
  const walk = bl => { for (const x of bl) { if (x.t === 'para') { const t = F.paraText(x); if (t.trim()) out.push(t.trim()); } else for (const r of x.rows) for (const cl of r) walk(cl.blocks); } };
  walk(flat(c));
  return out;
}
const findPara = (bl, text) => bl.find(x => x.t === 'para' && F.paraText(x).trim() === text) ?? null;

async function checkRoundTrip(ext, rich) {
  const back = await importAs(ext, await exportAs(ext, sample()));
  const texts = paraTexts(back);
  for (const want of ['Main Heading', 'Second Level', 'first bullet', 'second bullet', 'nested bullet', 'step one', 'step two', 'Name', 'Value', 'alpha', '42', 'A wise quote', 'Centered text', 'The end']) {
    assert.ok(texts.some(t => (rich ? t.endsWith(want) : t.includes(want))), `${ext}: missing ${want} in ${JSON.stringify(texts)}`);
  }
  assert.ok(texts.join('\n').includes('Plain bold and italic then a link.'), ext);
  if (!rich) return;
  const b = flat(back);
  assert.deepEqual([findPara(b, 'Main Heading')?.kind, findPara(b, 'Main Heading')?.level], ['heading', 1], ext);
  assert.deepEqual([findPara(b, 'Second Level')?.kind, findPara(b, 'Second Level')?.level], ['heading', 2], ext);
  assert.equal(findPara(b, 'A wise quote')?.kind, 'quote', ext);
  if (ext !== 'md') assert.equal(findPara(b, 'Centered text')?.align, 'center', ext);
  const fb = findPara(b, 'first bullet').list;
  assert.ok(!fb.ordered && fb.level === 0, ext);
  assert.equal(findPara(b, 'nested bullet').list.level, 1, ext);
  assert.ok(findPara(b, 'step one').list.ordered, ext);
  assert.equal(findPara(b, 'Between lists').list, null, ext);
  const body = findPara(b, 'Plain bold and italic then a link.');
  const has = (t, f) => body.inlines.some(i => i.t === 'text' && i.text === t && f(i.fmt));
  assert.ok(has('bold', f => f.bold && !f.italic), ext);
  assert.ok(has('italic', f => f.italic && !f.bold), ext);
  assert.ok(has('a link', f => f.link === 'https://example.com/x'), ext);
  const table = b.find(x => x.t === 'table');
  assert.equal(table.rows.length, 2, ext);
  assert.deepEqual(table.rows[1].map(F.cellText), ['alpha', '42'], ext);
}

test('tests.rs markdown_round_trip', () => checkRoundTrip('md', true));
test('tests.rs html_round_trip', async () => {
  await checkRoundTrip('html', true);
  const html = dec(await exportAs('html', sample()));
  assert.ok(html.includes('data:image/png;base64,'));
  const back = await importAs('html', enc(html));
  assert.equal(Object.keys(back.media).length, 1, 'picture survives');
  assert.equal(back.core.title, 'Sample Title');
});
test('tests.rs txt_round_trip', async () => {
  await checkRoundTrip('txt', false);
  assert.equal(plain(TR.read(enc('a\r\nb\nc'))), 'a\nb\nc');
  const u16le = [0xff, 0xfe];
  for (const ch of 'héllo') { const u = ch.charCodeAt(0); u16le.push(u & 0xff, u >> 8); }
  assert.equal(plain(TR.read(Uint8Array.from(u16le))), 'héllo');
  const raw = [];
  for (const ch of 'hello world') { const u = ch.charCodeAt(0); raw.push(u >> 8, u & 0xff); }
  assert.equal(plain(TR.read(Uint8Array.from(raw))), 'hello world');
  assert.equal(plain(TR.read(Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x80]))), 'café€');
});
test('tests.rs txt_export_writes_symbol_font_text_as_unicode', () => {
  const p = P.paragraphWithText('Done ');
  P.insertText(p, 5, 'J', {font: 'Wingdings'});
  assert.equal(dec(TW.write({content: createContent([p])})), 'Done ☺✓');
});
test('tests.rs txt_export_keeps_list_labels', () => {
  const c = createContent();
  const r = addList(c.numbering, 'bullet'); c.numbering = r.numbering;
  const p = P.paragraphWithText('alpha'); p.props = {numbering: {num: r.num, level: 0}};
  c.body = createContent([p, P.paragraphWithText('plain')]).body;
  const lines = dec(TW.write({content: c})).split('\r\n');
  assert.ok(lines[0].includes('alpha') && !lines[0].startsWith('alpha'));
  assert.equal(lines[1], 'plain');
});
test('tests.rs text_sniffing', () => {
  const b = a => Uint8Array.from(a);
  assert.ok(TR.isText(b([])));
  assert.ok(TR.isText(enc('#EXTM3U\r\n#EXTINF:123,Artist - Title\r\nC:\\Music\\song.mp3\r\n')));
  assert.ok(TR.isText(enc('#EXTM3U\n#EXTINF:-1,Мелодия — ünïcødé\nhttp://x/y.mp3\n')));
  assert.ok(TR.isText(b([0x23, 0x45, 0x58, 0x54, 0xe9, 0x0d, 0x0a, 0x1a])));
  assert.ok(TR.isText(b([0xef, 0xbb, 0xbf, 0x61])));
  const u16 = [];
  for (const ch of '#EXTM3U\r\n') u16.push(ch.charCodeAt(0), 0);
  assert.ok(TR.isText(b(u16)));
  assert.ok(!TR.isText(b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])));
  assert.ok(!TR.isText(b([0x50, 0x4b, 3, 4, 0x14, 0, 6, 0])));
  assert.ok(!TR.isText(enc('%PDF-1.7\n')));
  assert.ok(!TR.isText(b([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 3, 4, 5, 6, 7, 8])));
  assert.ok(!TR.isText(b([1, 0, 2, 0, 3])));
});
test('tests.rs page_break_char_splits_paragraph (txt part)', () => {
  const c = createContent([P.paragraphWithText('num two\u000CPage two')]);
  const b = flat(c);
  assert.equal(b.length, 2);
  assert.ok(F.paraText(b[0]) === 'num two' && !b[0].pageBreak && F.paraText(b[1]) === 'Page two' && b[1].pageBreak);
  assert.ok(!dec(TW.write({content: c})).includes('twoPage'));
});
test('tests.rs markdown_list_items_that_start_like_blocks_keep_their_text', () => {
  for (const text of ['---', '--', '1. Intro', '# Agenda', 'ordinary item']) {
    const c = createContent();
    const r = addList(c.numbering, 'bullet'); c.numbering = r.numbering;
    const p = styled(text, 'ListParagraph'); p.props.numbering = {num: r.num, level: 0};
    c.body = createContent([p]).body;
    const bytes = MW.write({content: c});
    const blocks = flat(MR.read(bytes));
    assert.equal(blocks.length, 1, `${text}: ${dec(bytes)}`);
    assert.deepEqual([F.paraText(blocks[0]), blocks[0].kind, blocks[0].list], [text, 'normal', {ordered: false, level: 0, start: 1}]);
  }
});
test('tests.rs markdown_code_fence_outgrows_its_content', () => {
  const line = '`'.repeat(100);
  const c = MR.read(enc(`    ${line}\n`));
  assert.equal(plain(c).trim(), line);
  const text = dec(MW.write({content: c}));
  assert.ok(text.includes('`'.repeat(101)), text);
  assert.equal(plain(MR.read(enc(text))).trim(), line);
});
test('tests.rs markdown_text_shapes', () => {
  const md = dec(MW.write({content: sample()}));
  assert.ok(md.includes('# Main Heading'));
  assert.ok(md.includes('**bold**') && md.includes('*italic*'));
  assert.ok(md.includes('[a link](https://example.com/x)'));
  assert.ok(md.includes('- first bullet') && md.includes('    - nested bullet') && md.includes('1. step one'), md);
  assert.ok(md.includes('| Name | Value |'));
  assert.ok(md.includes('> A wise quote'));
  assert.ok(md.includes('![tiny]('));
});
test('tests.rs code_blocks_and_rules (md, html)', () => {
  const c = MR.read(enc('```\nfn main() {}\n  indented\n```\n\n***\n\nafter'));
  const b = flat(c);
  assert.ok(b[0].kind === 'code' && F.paraText(b[0]) === 'fn main() {}');
  assert.ok(b[1].kind === 'code' && F.paraText(b[1]) === '  indented');
  assert.equal(b[2].kind, 'rule');
  for (const ext of ['md', 'html']) {
    const bb = flat(importAs(ext, exportAs(ext, c)));
    assert.ok(bb.some(x => x.kind === 'code' && F.paraText(x) === '  indented'), ext);
    assert.ok(bb.some(x => x.kind === 'rule'), ext);
  }
});
test('tests.rs rtf_merged_cells_and_lists (html part)', () => {
  const t = newTable(3, 2, 300);
  t.rows[0].cells[0].blocks = [P.paragraphWithText('tall')];
  t.rows[0].cells[0].props.vmerge = 'restart';
  t.rows[1].cells[0].props.vmerge = 'continue';
  const c = createContent([t, P.newParagraph()]);
  const bt = HR.read(HW.write({content: c})).body.chunks.flat()[0];
  assert.equal(bt.kind, 'table');
  assert.equal(bt.rows.length, 3);
  assert.equal(bt.rows[0].cells[0].props.vmerge, 'restart');
  assert.equal(bt.rows[1].cells[0].props.vmerge, 'continue');
});
test('tests.rs numbered_list_after_bullets_keeps_its_kind (md part)', () => {
  const c = createContent();
  let r = addList(c.numbering, 'bullet'); c.numbering = r.numbering; const bul = r.num;
  r = addList(c.numbering, 'numbered'); c.numbering = r.numbering; const num = r.num;
  c.body = createContent([['dot one', bul], ['dot two', bul], ['num one', num], ['num two', num]].map(([t, nm]) => { const q = styled(t, 'ListParagraph'); q.props.numbering = {num: nm, level: 0}; return q; })).body;
  const md = dec(MW.write({content: c}));
  assert.ok(md.includes('1. num one') && md.includes('2. num two'), md);
});

// --- model.rs tests ---
test('model.rs percent_decode_requires_hex_digits + base64_round_trip', () => {
  assert.equal(dec(F.percentDecode('%+A')), '%+A');
  assert.equal(dec(F.percentDecode('%G1')), '%G1');
  assert.equal(dec(F.percentDecode('%41')), 'A');
  for (const s of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) assert.equal(dec(F.base64Decode(F.base64Encode(enc(s)))), s);
  assert.equal(F.base64Encode(enc('foobar')), 'Zm9vYmFy');
  assert.equal(F.base64Decode('@@'), null);
  assert.equal(dec(F.dataUri('data:text/plain,a%20b')), 'a b');
});
test('model.rs colors', () => {
  assert.deepEqual(F.parseColor('#f00'), [255, 0, 0]);
  assert.deepEqual(F.parseColor('#f00f'), [255, 0, 0]);
  assert.deepEqual(F.parseColor('#0080FF'), [0, 128, 255]);
  assert.deepEqual(F.parseColor('#0080ff80'), [0, 128, 255]);
  assert.deepEqual(F.parseColor('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.deepEqual(F.parseColor('rgb(1 2 3)'), [1, 2, 3]);
  assert.deepEqual(F.parseColor('rgb(1 2 3 / 50%)'), [1, 2, 3]);
  assert.deepEqual(F.parseColor('hsl(0, 100%, 50%)'), [255, 0, 0]);
  assert.deepEqual(F.parseColor('hsl(120deg 100% 50%)'), [0, 255, 0]);
  assert.deepEqual(F.parseColor('hsla(240, 100%, 50%, 0.8)'), [0, 0, 255]);
  assert.deepEqual(F.parseColor('navy'), [0, 0, 128]);
  assert.equal(F.parseColor('#zz'), null);
  assert.equal(F.parseColor('rgb(1)'), null);
});
test('model.rs list_labels', () => {
  const c = new F.ListCounter();
  const o = level => ({ordered: true, level, start: 1});
  assert.equal(c.label(o(0)), '1.');
  assert.equal(c.label(o(1)), 'a.');
  assert.equal(c.label(o(1)), 'b.');
  assert.equal(c.label(o(0)), '2.');
  assert.equal(c.label({ordered: false, level: 0, start: 1}), '•');
});
test('model.rs covered_cells_inserted + insert_covered_is_bounded_on_hostile_rowspan', () => {
  const t = F.ftable({rows: [[F.cell({rowspan: 2}), F.cell()], [F.cell()]]});
  F.insertCovered(t);
  assert.equal(t.rows[1].length, 2);
  assert.ok(t.rows[1][0].covered);
  const big = F.ftable({rows: Array.from({length: 20_000}, () => [F.cell({rowspan: 1000})])});
  F.insertCovered(big);
  assert.ok(big.rows.every(r => r.length <= 64));
});
test('model.rs trim_drops_a_long_run_of_blank_spans_in_linear_time', () => {
  const p = F.para();
  const b = F.fmt({bold: true}), i = F.fmt({italic: true});
  for (let k = 0; k < 200_000; k++) { F.pushText(p, '\n', b); F.pushText(p, ' ', i); }
  F.pushText(p, '  x ', F.fmt());
  const t0 = Date.now();
  F.trim(p);
  assert.ok(Date.now() - t0 < 10_000);
  assert.deepEqual(p.inlines, [{t: 'text', text: 'x', fmt: F.fmt()}]);
  const q = F.para();
  F.pushText(q, ' \t', b); F.pushText(q, ' a ', i); F.pushText(q, 'b ', b);
  F.trim(q);
  assert.deepEqual(q.inlines, [{t: 'text', text: 'a ', fmt: i}, {t: 'text', text: 'b', fmt: b}]);
});

// --- markdown/tests.rs ---
const inl = s => MR.parseInlines(s, F.fmt(), 0, new Map());
const spans = s => inl(s).filter(i => i.t === 'text').map(i => [i.text, i.fmt.bold, i.fmt.italic]);
test('markdown/tests.rs emphasis', () => {
  assert.deepEqual(spans('a *b* c'), [['a ', false, false], ['b', false, true], [' c', false, false]]);
  assert.deepEqual(spans('**b**'), [['b', true, false]]);
  assert.deepEqual(spans('***x***'), [['x', true, true]]);
  assert.deepEqual(spans('*a **b** c*'), [['a ', false, true], ['b', true, true], [' c', false, true]]);
  assert.deepEqual(spans('snake_case_name'), [['snake_case_name', false, false]]);
  assert.deepEqual(spans('2 * 3 * 4'), [['2 * 3 * 4', false, false]]);
  assert.deepEqual(spans('**unclosed'), [['**unclosed', false, false]]);
  const s = inl('~~gone~~');
  assert.ok(s[0].text === 'gone' && s[0].fmt.strike);
});
test('markdown/tests.rs links_code_escapes', () => {
  const s = inl('see [the *site*](http://x.org "T") and `a*b*` \\*lit\\* &amp; <https://y.com>');
  const link = s.filter(i => i.t === 'text' && i.fmt.link).map(i => [i.text, i.fmt.link, i.fmt.italic]);
  assert.deepEqual(link[0], ['the ', 'http://x.org', false]);
  assert.deepEqual(link[1], ['site', 'http://x.org', true]);
  assert.ok(link.some(l => l[1] === 'https://y.com'));
  assert.ok(s.some(i => i.t === 'text' && i.text === 'a*b*' && i.fmt.code));
  const text = s.filter(i => i.t === 'text').map(i => i.text).join('');
  assert.ok(text.includes('*lit* & '), text);
});
test('markdown/tests.rs reference_links_resolve_and_their_definitions_leave_the_body', () => {
  const links = md => { const b = MR.parse(md).blocks[0]; return b?.t === 'para' ? b.inlines.filter(x => x.t === 'text' && x.fmt.link).map(x => [x.text, x.fmt.link]) : []; };
  const def = '\n\n[ref1]: https://example.com/ref\n';
  const toRef = t => [[t, 'https://example.com/ref']];
  assert.deepEqual(links(`[click here][ref1]${def}`), toRef('click here'));
  assert.deepEqual(links(`[ref1][]${def}`), toRef('ref1'));
  assert.deepEqual(links(`[ref1]${def}`), toRef('ref1'));
  assert.deepEqual(links(`[click here][  REF1  ]${def}`), toRef('click here'));
  assert.deepEqual(links(`[nope]${def}`), []);
  assert.deepEqual(links('[x](https://inline.example)'), [['x', 'https://inline.example']]);
  assert.equal(plain(MR.importMarkdown(`Reference link: [click here][ref1]${def}`)), 'Reference link: click here');
  const fenced = '```\n[ref1]: https://example.com/ref\n```\n\n[ref1]\n';
  assert.ok(plain(MR.importMarkdown(fenced)).includes('[ref1]: https://example.com/ref'));
  assert.deepEqual(links(fenced), []);
});
test('markdown/tests.rs a_definition_shaped_line_that_is_not_a_definition_stays_in_the_document', () => {
  const body = md => plain(MR.importMarkdown(md));
  assert.equal(body('Status update\n[Warning]: unstable\nmore text\n'), 'Status update [Warning]: unstable more text');
  const code = '```\n```rust\n[foo]: /bar\n```\n\nSee [foo].\n';
  assert.ok(body(code).includes('[foo]: /bar') && body(code).endsWith('See [foo].'));
  const t = body('    ```\n\n[x]: /y\n\nSee [x].\n');
  assert.ok(t.includes('```') && t.endsWith('See x.'), t);
  assert.equal(body('[a]: /a\n[b]: /b\n\n# Head\n[c]: /c\n\nSee [a], [b], [c].\n'), 'Head\nSee a, b, c.');
  assert.ok(body('x[^1]\n\n[^1]: Note\n').includes('[^1]: Note'));
});
test('markdown/tests.rs blocks', () => {
  const f = MR.parse('# Title\n\nPara one\ncontinues.\n\n> quoted\n\n- a\n- b\n    1. nested\n\n```\ncode *x*\n```\n\n---\n\n| A | B |\n|---|:-:|\n| 1 | 2 |\n');
  const kinds = f.blocks.map(b => (b.t === 'para' ? `${b.kind}${b.kind === 'heading' ? b.level : ''}${b.list ? `(${b.list.ordered},${b.list.level})` : ''}:${F.paraText(b)}` : `table${b.rows.length}`));
  assert.deepEqual(kinds, ['heading1:Title', 'normal:Para one continues.', 'quote:quoted', 'normal(false,0):a', 'normal(false,0):b', 'normal(true,1):nested', 'code:code *x*', 'rule:', 'table2']);
});

// --- html/tests.rs ---
test('html/tests.rs numeric_entity_rejects_sign + entities', () => {
  assert.equal(HR.decodeEntity('#+65'), null);
  assert.equal(HR.decodeEntity('#65'), 'A');
  assert.equal(HR.decodeEntity('#x41'), 'A');
  assert.equal(HR.unescape('a &amp; b &lt;c&gt; &unknown; &#8364;'), 'a & b <c> &unknown; €');
});
test('html/tests.rs tag_soup + styles_and_links', () => {
  const f = HR.parse('<p>one<p>two<ul><li>a<li>b</ul><h2>head<p><b>bold <i>both</b> italic</i> <a href="javascript:x()">bad</a> <a href="https://ok">good</a>');
  const ps = f.blocks.filter(b => b.t === 'para');
  assert.deepEqual(ps.map(F.paraText), ['one', 'two', 'a', 'b', 'head', 'bold both italic bad good']);
  assert.equal(ps[4].kind, 'heading');
  const last = ps[5].inlines;
  assert.ok(last.some(i => i.text.includes('bad') && !i.fmt.link));
  assert.ok(last.some(i => i.text === 'good' && i.fmt.link === 'https://ok'), JSON.stringify(last));
  assert.ok(last.some(i => i.text === 'both' && i.fmt.bold && i.fmt.italic));
});
test('html/tests.rs borderless_tables_get_no_grid_style', () => {
  const t1 = HR.parse('<table><tr><td>x</td></tr></table>').blocks[0];
  assert.equal(t1.borderless, true);
  const t2 = HR.parse('<table border="1"><tr><td>x</td></tr></table>').blocks[0];
  assert.equal(t2.borderless, false);
  const c = HR.read(enc('<table><tr><td>x</td></tr></table>'));
  assert.equal(c.body.chunks.flat()[0].props.style, undefined);
});
test('html/tests.rs page_break_after_and_before', () => {
  const f = HR.parse('<p>a</p><p style="page-break-after:always">b</p><p>c</p><p style="break-before:page">d</p>');
  assert.deepEqual(f.blocks.map(b => b.pageBreak), [false, false, true, true]);
});
test('html/tests.rs wbr_word_break_opportunity + raw_text_elements_skip_only_matching_end_tag', () => {
  assert.equal(F.paraText(HR.parse('<p>long<wbr>word</p>').blocks[0]), 'long​word');
  const f = HR.parse('<script>if (a</b) {}</script><p>after</p><style>p{}</style><p>end</p>');
  assert.deepEqual(f.blocks.map(F.paraText), ['after', 'end']);
});
test('html/tests.rs decode_with_charset_declarations', () => {
  const bytes = Uint8Array.from([...enc('<meta charset="windows-1252"><p>caf'), 0xe9, ...enc('</p>')]);
  assert.ok(HR.decode(bytes).includes('café'));
});
test('html/tests.rs ruby_survives_an_html_round_trip', () => {
  const f = HR.parse('<p>x <ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby> y</p>');
  const r = f.blocks[0].inlines.find(i => i.t === 'ruby');
  assert.deepEqual([r.base, r.ruby], ['漢', 'kan']);
  const c = F.toContent(f);
  const o = c.body.chunks.flat()[0].objects.find(x => x.type === 'ruby');
  assert.deepEqual([o.base, o.ruby, o.align], ['漢', 'kan', 'center']);
  const back = HR.parse(dec(HW.write({content: c}))).blocks[0].inlines.find(i => i.t === 'ruby');
  assert.deepEqual([back.base, back.ruby], ['漢', 'kan']);
});
test('html/tests.rs table_cell_vertical_alignment + header cells bold', () => {
  const t = HR.parse('<table><tr><th>H</th></tr><tr><td valign="bottom">a</td><td style="vertical-align: middle">b</td></tr></table>').blocks[0];
  assert.equal(t.rows[1][0].valign, 'bottom');
  assert.equal(t.rows[1][1].valign, 'center');
  assert.ok(t.rows[0][0].header && t.rows[0][0].blocks[0].inlines[0].fmt.bold);
});
test('html/tests.rs small_big_and_css_font_sizes + css_important_casing_and_spacing', () => {
  const sizes = HR.parse('<p><small>s</small><big>b</big><span style="font-size:18px">p</span><span style="FONT-SIZE : 14pt !important">i</span></p>').blocks[0].inlines.map(i => i.fmt.size);
  assert.deepEqual(sizes, [10, 14, 13.5, 14]);
});
