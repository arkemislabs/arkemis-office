// Ported from wordcraft crates/docx/tests/it/fixtures.rs, src/xml.rs (tests) and src/units.rs
// (tests) at aadb077e072b7de05f724e359d8db82e151f125c. Each test names the Rust test it ports.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: crates/docx/src/read.rs reads a .docx into the document model leniently and bounded
//    (fixtures.rs: hyperlinks, wrappers, symbols, tables with legacy merges, styles/numbering/settings/
//    notes/comments from their parts). Word opens the same files the same way (File > Open).
// 2. Ours: core/quill/formats/docx-read.mjs is the line-by-line translation onto the schema-2 model;
//    the same fixtures give the same model values (UTF-16 offsets instead of UTF-8 bytes). Drawings
//    the model has no shape reader for yet are kept whole (opaque) instead of becoming Shape objects
//    (alternate_content_choice_and_fallback below asserts the kept drawing, not a Shape).
// 3. These tests (engine), plus tests/quill/formats-docx.test.mjs and the bridge E2E
//    tests/e2e/quill/formats-docx-save.e2e.mjs (File > Save → .docx on disk → reopen).
import test from 'node:test';
import assert from 'node:assert/strict';
import {docx, readBody, parasOf, blocksOf, rels, zip, W_NS, unzip, text} from '../formats-docx-fixtures.mjs';
import {read, parseXml, isRelAttr, utf16ToString, esc, measure, lineMultiple, int, u32Of} from '../../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../../core/quill/formats/docx-write.mjs';
import {Document} from '../../../core/quill/model/document.mjs';
import {OBJ} from '../../../core/quill/model/text.mjs';
import {plainText, propsOfChar} from '../../../core/quill/model/para.mjs';
import {getStyle} from '../../../core/quill/model/styles.mjs';
import {tableLook} from '../../../core/quill/model/props.mjs';

const f = Math.fround;
const enc = s => new TextEncoder().encode(s);

// --- xml.rs tests ---

test('xml.rs strict_parsing_rejects_a_dropped_entity_and_trailing_markup', () => {
  for (const bad of ['<w:t>before &unknown; after</w:t>', '<a></a><b></b>', '<a></a><b>']) assert.throws(() => parseXml(bad, {strict: true}), bad);
  assert.doesNotThrow(() => parseXml('<a>x &amp; y</a>\n', {strict: true}));
  assert.doesNotThrow(() => parseXml('<a></a><b></b>'), 'lenient parsing still stops at the root');
});

test('xml.rs a_relationship_attribute_is_the_namespaced_one_or_the_alias_of_one', () => {
  assert.ok(isRelAttr('w:hyperlink', 'r:id'));
  assert.ok(isRelAttr('v:imagedata', 'o:relid'));
  assert.ok(isRelAttr('w:hyperlink', 'id'));
  assert.ok(isRelAttr('v:imagedata', 'id'));
  assert.ok(isRelAttr('a:blip', 'embed'));
  assert.ok(isRelAttr('dgm:relIds', 'dm'));
  for (const [e, k] of [['v:shape', 'id'], ['pic:cNvPr', 'id'], ['wp:docPr', 'id'], ['v:background', 'id'], ['w:hyperlink', 'anchor'], ['v:imagedata', 'title']]) assert.ok(!isRelAttr(e, k));
});

test('xml.rs utf16_parts_parse_and_odd_ones_never_panic', () => {
  const src = '<?xml version="1.0" encoding="UTF-16"?><r:Relationships xmlns:r="urn:x"><r:Relationship Id="rId1" Target="café😀.xml"/></r:Relationships>';
  for (const le of [true, false]) {
    const units = [...src].flatMap(ch => { const s = ch; const out = []; for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); return out; });
    const b = [le ? 0xff : 0xfe, le ? 0xfe : 0xff];
    for (const u of units) b.push(...(le ? [u & 255, u >> 8] : [u >> 8, u & 255]));
    const root = parseXml(new Uint8Array(b));
    assert.equal(root.elList()[0].attr('Target'), 'café😀.xml', `le ${le}`);
  }
  for (const b of [[0xff, 0xfe], [0xfe, 0xff, 0x00], [0xff, 0xfe, 60, 0, 0x00, 0xd8, 97, 0, 47, 0, 62, 0], [0xff, 0xfe, 0x00, 0xdc, 0x00]]) {
    try { parseXml(new Uint8Array(b)); } catch { /* an error or a tree, never a crash */ }
  }
  assert.equal(utf16ToString(new Uint8Array([0xff, 0xfe, 97, 0, 0x00, 0xd8, 98])), 'a\uFFFD');
  assert.equal(utf16ToString(enc('<a/>')), null);
});

test('xml.rs parses_with_namespaces', () => {
  const x = '<?xml version="1.0"?><x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:rr="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:p rr:id="r1" x:val="a&amp;b"><x:t xml:space="preserve"> hi &#65;&lt; </x:t></x:p></x:document>';
  const e = parseXml(x);
  assert.equal(e.name, 'w:document');
  const p = e.child('w:p');
  assert.equal(p.attr('r:id'), 'r1');
  assert.equal(p.attr('w:val'), 'a&b');
  const t = p.child('w:t');
  assert.equal(t.text(), ' hi A< ');
  assert.equal(t.attr('xml:space'), 'preserve');
});

test('xml.rs choice_requirements_resolve_namespace_aliases_and_rebindings', () => {
  const x = '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:pen="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"><mc:Choice Requires="pen"/><mc:Choice xmlns:pen="urn:future" Requires="pen"/><mc:Choice Requires="undeclared"/></mc:AlternateContent>';
  assert.deepEqual(parseXml(x).children('mc:Choice').map(c => c.attr('Requires')), ['wpi', '?', '?']);
});

test('xml.rs deep_nesting_is_error', () => {
  assert.throws(() => parseXml('<a>'.repeat(1000)));
});

test('xml.rs too_many_attributes_on_one_element_is_capped', () => {
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  for (const attrs of [Array.from({length: 2000}, (_, i) => ` a${i}=""`).join(''), ' a=""'.repeat(2000)]) {
    let p;
    try { p = parseXml(`<w:p xmlns:w="${ns}"${attrs}/>`); } catch (e) { assert.equal(e.kind, 'Limit'); continue; }
    assert.ok(p.attrs.length <= 1024);
  }
  const many = Array.from({length: 256}, (_, i) => ` a${i}="${i}"`).join('');
  const p = parseXml(`<p${many}/>`);
  assert.equal(p.attrs.length, 256);
  assert.equal(p.attr('a255'), '255');
});

test('xml.rs garbage_is_error_not_panic', () => {
  assert.throws(() => parseXml(''));
  assert.throws(() => parseXml(new Uint8Array([0xff, 0xfe, 60])));
  try { parseXml('<a><b></a>'); } catch { /* fine */ }
  try { parseXml("<a x='1' x='2'/>"); } catch { /* fine */ }
});

test('xml.rs escapes', () => {
  assert.equal(esc('a<b&"\u0001'), 'a&lt;b&amp;&quot;');
});

// --- units.rs tests ---

test('units.rs measures', () => {
  assert.equal(measure('1440', 20), 72);
  assert.equal(measure('1in', 20), 72);
  assert.equal(measure('12pt', 2), 12);
  assert.equal(measure('24.0', 2), 12);
  assert.equal(measure('nan', 20), null);
  assert.equal(measure('1e400', 20), null);
  assert.equal(measure('99999999999999', 20), 14_400);
  assert.equal(measure('x', 20), null);
  assert.equal(lineMultiple('240'), 1);
  assert.equal(lineMultiple('276'), 1.15);
  assert.equal(lineMultiple('0'), 0);
  assert.ok(Math.abs(lineMultiple('13.90pt') - 278 / 240) < 1e-5);
  assert.ok(Math.abs(lineMultiple('1.2in') - 7.2) < 1e-5);
  assert.equal(lineMultiple('junk'), null);
  assert.equal(lineMultiple(''), null);
  assert.equal(measure('12700emu', 20), 1);
  assert.equal(measure('25400EMU', 20), 2);
  assert.equal(measure('1IN', 20), 72);
  assert.equal(measure('12PT', 2), 12);
  assert.equal(measure('2.54CM', 20), 72);
  assert.equal(measure('25.4MM', 20), 72);
  assert.equal(measure('10PX', 20), 7.5);
  assert.equal(measure('1e2pt', 20), 100);
  assert.equal(measure('1e+2pt', 20), 100);
  assert.equal(int('12.6'), 13);
  assert.equal(u32Of('-5'), 0);
});

// --- fixtures.rs ---

test('fixtures.rs repeated_style_ids_use_last', async () => {
  const styles = `<w:styles ${W_NS}>
    <w:style w:type="paragraph" w:styleId="Repeated"><w:name w:val="First"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:smallCaps/><w:sz w:val="28"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Repeated"><w:name w:val="Last"/><w:pPr><w:spacing w:before="120"/></w:pPr><w:rPr><w:i/><w:caps/><w:sz w:val="20"/></w:rPr></w:style></w:styles>`;
  let d = await read(await docx('<w:p><w:pPr><w:pStyle w:val="Repeated"/></w:pPr><w:r><w:t>Original style probe</w:t></w:r></w:p>',
    [['styles', 'styles', 'styles.xml']], [['word/styles.xml', styles]]));
  for (let round = 0; round <= 2; round++) {
    const st = getStyle(d.styles, 'Repeated');
    assert.equal(st.name, 'Last');
    assert.equal(st.chr.size, 10);
    assert.equal(st.chr.italic, true);
    assert.equal(st.chr.bold, undefined);
    assert.equal(st.chr.caps, true);
    assert.equal(st.chr.smallCaps, undefined);
    assert.equal(st.para.spaceBefore, 6);
    assert.equal(st.para.spaceAfter, undefined);
    assert.equal(d.styles.styles.filter(s => s.id === 'Repeated').length, 1);
    if (round < 2) d = await read(await writeDocx(d));
  }
});

test('fixtures.rs paragraph_default_presence_survives_repeated_saves', async () => {
  for (const [defaults, present, after] of [['', false, undefined], ['<w:docDefaults/>', false, undefined],
    ['<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>', false, undefined],
    ['<w:docDefaults><w:pPrDefault/></w:docDefaults>', true, undefined], ['<w:docDefaults><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults>', true, undefined],
    ['<w:docDefaults><w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults>', true, 8]]) {
    const styles = `<w:styles ${W_NS}>${defaults}<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style></w:styles>`;
    let d = await read(await docx('<w:p><w:r><w:t>First</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p>', [['rId1', 'styles', 'styles.xml']], [['word/styles.xml', styles]]));
    for (let i = 0; i < 2; i++) {
      const bytes = await writeDocx(d);
      const xml = text(await unzip(bytes), 'word/styles.xml');
      assert.equal(xml.includes('<w:pPrDefault>'), present, defaults);
      d = await read(bytes);
      assert.equal(d.styles.defaultPara.spaceAfter, after);
      assert.deepEqual(parasOf(d).map(p => p.text), ['First', 'Second']);
    }
  }
});

test('fixtures.rs ref_links_keep_cached_results', async () => {
  const d = await readBody(`
<w:p><w:fldSimple w:instr="REF destination \\h" w:fldLock="1"><w:r><w:rPr><w:b/></w:rPr><w:t>Cached simple</w:t></w:r></w:fldSimple></w:p>
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">REF destination </w:instrText></w:r><w:r><w:instrText>\\w \\h</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Cached complex</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
<w:p><w:bookmarkStart w:id="0" w:name="destination"/><w:r><w:t>Changed destination</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>`);
  const again = await read(await writeDocx(d));
  for (const doc of [d, again]) {
    const p = parasOf(doc);
    for (const [i, instr, cached, locked] of [[0, 'REF destination \\h', 'Cached simple', true], [1, 'REF destination \\w \\h', 'Cached complex', false]]) {
      const o = p[i].objects[0];
      assert.equal(o.type, 'field');
      assert.equal(o.instr, instr);
      assert.equal(o.result, cached);
      assert.equal(o.locked, locked);
    }
    assert.equal(propsOfChar(p[0], 0).bold, true);
    assert.ok(new Document(doc).bookmarks().some(b => (b.name ?? b[0]) === 'destination'));
  }
});

test('fixtures.rs hyperlink_runs_and_wrappers', async () => {
  const body = `
<w:p>
 <w:hyperlink r:id="rId5" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>site</w:t></w:r></w:hyperlink>
 <w:hyperlink r:id="rId5" w:anchor="frag"><w:r><w:t>X</w:t></w:r></w:hyperlink>
 <w:smartTag><w:r><w:t>A</w:t></w:r></w:smartTag><w:customXml><w:r><w:t>B</w:t></w:r></w:customXml>
 <w:sdt><w:sdtPr/><w:sdtContent><w:r><w:t>C</w:t></w:r></w:sdtContent></w:sdt>
 <w:r><w:sym w:font="Wingdings" w:char="F04A"/><w:noBreakHyphen/><w:softHyphen/><w:cr/><w:br w:type="page"/><w:br w:type="column"/><w:t xml:space="preserve"> e&amp;</w:t></w:r>
 <w:proofErr w:type="spellStart"/><w:r><w:rPr><w:b w:val="false"/><w:i w:val="0"/><w:caps w:val="off"/><w:strike w:val="true"/><w:color w:val="auto"/></w:rPr><w:t>T</w:t></w:r>
</w:p>
<w:sdt><w:sdtContent><w:p><w:r><w:t>in block sdt</w:t></w:r></w:p></w:sdtContent></w:sdt>`;
  const d = await read(await docx(body, [['rId5', 'hyperlink', 'https://example.org/']]));
  const p = parasOf(d);
  assert.equal(plainText(p[0]), 'siteXABC\uF04A\u2011\u00AD\n\u000C\u000E e&T');
  assert.equal(p[0].objects[0].type, 'controlStart');
  assert.equal(propsOfChar(p[0], 0).link, 'https://example.org/');
  assert.equal(propsOfChar(p[0], 0).style, 'Hyperlink');
  assert.equal(propsOfChar(p[0], 4).link, 'https://example.org/#frag');
  assert.equal(propsOfChar(p[0], p[0].text.indexOf('\uF04A')).symFont, 'Wingdings');
  const t = propsOfChar(p[0], p[0].text.length - 1);
  assert.deepEqual([t.bold, t.italic, t.caps, t.strike, t.color], [false, false, false, true, 'Auto']);
  assert.equal(plainText(p[1]), 'in block sdt');
});

test('fixtures.rs a_sym_character_round_trips_as_w_sym', async () => {
  const d = await readBody('<w:p><w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r></w:p>');
  const xml = text(await unzip(await writeDocx(d)), 'word/document.xml');
  assert.match(xml, /<w:sym w:font="Wingdings" w:char="F0FC"\/>/);
  const again = await read(await writeDocx(d));
  assert.equal(parasOf(again)[0].text, '\uF0FC');
});

test('fixtures.rs sym_hex_prefixes_and_break_type_casing', async () => {
  const d = await readBody('<w:p><w:r><w:sym w:font="Symbol" w:char="0xF061"/><w:sym w:font="Symbol" w:char="U+F062"/><w:br w:type="PAGE"/></w:r></w:p>');
  assert.equal(parasOf(d)[0].text, '\uF061\uF062\u000C');
});

test('fixtures.rs alternate_content_choice_and_fallback (text box kept whole)', async () => {
  const body = `
<w:p><w:r><mc:AlternateContent>
  <mc:Choice Requires="wps"><w:drawing><wp:anchor behindDoc="0" distL="12700"><wp:positionH relativeFrom="page"><wp:posOffset>127000</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="914400" cy="457200"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="1" name="Text Box 1"/>
    <a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:prstGeom prst="rect"/></wps:spPr><wps:txbx><w:txbxContent><w:p><w:r><w:t>boxed</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic>
  </wp:anchor></w:drawing></mc:Choice>
  <mc:Fallback><w:pict><v:shape style="width:72pt;height:36pt"><v:textbox><w:txbxContent><w:p><w:r><w:t>old</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>
</mc:AlternateContent></w:r></w:p>
<w:p><mc:AlternateContent><mc:Choice Requires="w99"><w:r><w:t>future</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>fallback text</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>`;
  const d = await readBody(body);
  const p = parasOf(d);
  const o = p[0].objects[0];
  // wordcraft keeps a text box whole as an opaque object; Word edits it, so the reader makes it a text box shape whose text
  // is its own story (the Choice wins over the VML Fallback). Not upstream's behaviour: Word's (U:quill/shapes).
  assert.equal(o.type, 'shape');
  assert.equal(o.kind, 'textBox');
  assert.equal(d.parts[o.story].blocks.map(b => b.text).join('\n'), 'boxed');
  assert.equal(o.w, 72);
  assert.equal(o.h, 36);
  assert.equal(p[1].text, 'fallback text');
  // Saved again, the text box is in the file as it was read.
  const xml = text(await unzip(await writeDocx(d)), 'word/document.xml');
  assert.match(xml, /<w:txbxContent>(?:(?!<\/w:txbxContent>)[\s\S])*<w:t(?: [^>]*)?>boxed<\/w:t>(?:(?!<\/w:txbxContent>)[\s\S])*<\/w:txbxContent>/);
});

test('fixtures.rs table_look_bitmask_and_legacy_merges', async () => {
  const d = await readBody(`
<w:tbl>
 <w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:jc w:val="center"/><w:tblLook w:val="04A0"/></w:tblPr>
 <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
 <w:tr><w:tc><w:tcPr><w:hMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>wide</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:hMerge/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:vMerge w:val="restart"/><w:shd w:val="clear" w:fill="FF0000"/></w:tcPr><w:p/></w:tc></w:tr>
 <w:tr><w:trPr><w:trHeight w:val="400"/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p/></w:tc><w:sdt><w:sdtContent><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:sdtContent></w:sdt></w:tr>
</w:tbl>
<w:tbl><w:tblPr><w:tblLook w:firstRow="0" w:lastRow="1" w:firstColumn="1" w:lastColumn="0" w:noHBand="1" w:noVBand="0"/></w:tblPr><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>
<w:p/>`);
  const [t, t2] = blocksOf(d);
  assert.equal(t.props.widthPct, 100);
  assert.equal(t.props.align, 'center');
  const l = tableLook(t.props); // absent = the default look (TableLook::default)
  assert.ok(l.headerRow && l.firstColumn && l.bandedRows && !l.bandedColumns && !l.totalRow && !l.lastColumn);
  assert.equal(t.rows[0].cells.length, 2);
  assert.equal(t.rows[0].cells[0].props.span, 2);
  assert.equal(t.rows[0].cells[1].props.vmerge, 'restart');
  assert.equal(t.rows[1].cells[1].props.vmerge, 'continue');
  assert.equal(t.rows[1].props.height, 20);
  assert.deepEqual(t.grid, [100, 100, 100]);
  const l2 = tableLook(t2.props);
  assert.ok(!l2.headerRow && l2.totalRow && l2.firstColumn && !l2.lastColumn && !l2.bandedRows && l2.bandedColumns);
});

test('fixtures.rs styles_numbering_settings_notes_comments_from_parts', async () => {
  const styles = `<w:styles ${W_NS}>
 <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
 <w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:qFormat/></w:style>
 <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:next w:val="a"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi"/><w:b/><w:sz w:val="32"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:customStyle="1" w:styleId="Fancy"><w:name w:val="Fancy"/><w:basedOn w:val="Fancy"/></w:style>
 <w:style w:type="table" w:styleId="Grid"><w:name w:val="Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr><w:tcPr><w:shd w:val="clear" w:fill="4472C4"/></w:tcPr></w:tblStylePr></w:style>
</w:styles>`;
  const theme = '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements><a:clrScheme name="T"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme><a:fontScheme name="T"><a:majorFont><a:latin typeface="Major Face"/></a:majorFont><a:minorFont><a:latin typeface="Minor Face"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>';
  const numbering = `<w:numbering ${W_NS}><w:abstractNum w:abstractNumId="7"><w:name w:val="L"/><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="upperLetter"/><w:lvlText w:val="%1)"/><w:lvlJc w:val="right"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:suff w:val="space"/><w:lvlText w:val="o"/><w:rPr><w:rFonts w:ascii="Courier New"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="2"><w:abstractNumId w:val="7"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num></w:numbering>`;
  const settings = `<w:settings ${W_NS}><w:trackRevisions/><w:defaultTabStop w:val="708"/><w:evenAndOddHeaders w:val="1"/><w:footnotePr><w:pos w:val="sideways"/><w:numFmt w:val="lowerRoman"/><w:numStart w:val="-99999999999"/><w:numRestart w:val="eachPage"/></w:footnotePr></w:settings>`;
  const footnotes = `<w:footnotes ${W_NS}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Note text</w:t></w:r></w:p></w:footnote></w:footnotes>`;
  const comments = `<w:comments ${W_NS}><w:comment w:id="5" w:author="Zed" w:initials="Z" w:date="2026-01-01T00:00:00Z"><w:p><w:r><w:annotationRef/></w:r><w:r><w:t>Look</w:t></w:r></w:p></w:comment></w:comments>`;
  const header = `<w:hdr ${W_NS}><w:p><w:r><w:t>H</w:t></w:r></w:p></w:hdr>`;
  const core = '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Doc Title</dc:title><cp:revision>3</cp:revision></cp:coreProperties>';
  const body = `
<w:p><w:pPr><w:pStyle w:val="1"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr></w:pPr><w:commentRangeStart w:id="5"/><w:r><w:rPr><w:rFonts w:asciiTheme="majorHAnsi"/></w:rPr><w:t>Heading</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:commentReference w:id="5"/></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="a"/></w:pPr><w:ins w:id="1" w:author="I" w:date="2026-01-01T00:00:00Z"><w:r><w:t>new</w:t></w:r></w:ins><w:del w:id="2" w:author="I"><w:r><w:delText>old</w:delText></w:r></w:del></w:p>
<w:sectPr><w:headerReference w:type="default" r:id="rId9"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:titlePg w:val="0"/></w:sectPr>`;
  const rootRels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
  const bytes = await zip([['_rels/.rels', rootRels], ['word/document.xml', `<w:document ${W_NS}><w:body>${body}</w:body></w:document>`],
    ['word/_rels/document.xml.rels', rels([['rId1', 'styles', 'styles.xml'], ['rId2', 'theme', 'theme/theme1.xml'], ['rId3', 'numbering', 'numbering.xml'],
      ['rId4', 'settings', '/word/settings.xml'], ['rId5', 'footnotes', 'footnotes.xml'], ['rId6', 'comments', 'comments.xml'], ['rId9', 'header', 'header1.xml']])],
    ['word/styles.xml', styles], ['word/theme/theme1.xml', theme], ['word/numbering.xml', numbering], ['word/settings.xml', settings],
    ['word/footnotes.xml', footnotes], ['word/comments.xml', comments], ['word/header1.xml', header], ['docProps/core.xml', core]]);
  const d = await read(bytes);
  // assert_imported_styles
  const h = getStyle(d.styles, '1');
  assert.equal(h.name, 'Heading 1');
  assert.equal(h.basedOn, 'Normal');
  assert.ok(h.builtin && h.quick);
  assert.equal(h.chr.font, 'Major Face');
  assert.ok(getStyle(d.styles, 'Normal'));
  assert.equal(getStyle(d.styles, 'Fancy').basedOn, null, 'self-reference dropped');
  assert.ok(!getStyle(d.styles, 'Fancy').builtin);
  assert.equal(d.styles.defaultChr.font, 'Minor Face');
  assert.equal(d.styles.defaultChr.size, 11);
  const g = getStyle(d.styles, 'Grid').table;
  assert.deepEqual(g.headerFill, [0x44, 0x72, 0xc4]);
  assert.equal(g.headerChr.bold, true);
  assert.deepEqual(d.settings.themeColors[4], [0x44, 0x72, 0xc4]);
  assert.equal(d.settings.majorFont, 'Major Face');
  // assert_imported_numbering_and_settings
  const num = d.numbering.nums.find(x => x.id === 2);
  const abs = d.numbering.abstracts.find(a => a.id === num.abstractId);
  const lv = abs.levels[0];
  assert.deepEqual([lv.start, lv.text, lv.indent, lv.hanging, lv.align], [3, '%1)', 36, 18, 'right']);
  assert.equal(abs.levels[1].chr.font, 'Courier New');
  assert.equal(abs.levels[1].suffix, 'space');
  assert.deepEqual(num.startOverrides, [[0, 5]]);
  assert.ok(d.settings.trackChanges && d.settings.evenOddHeaders);
  assert.equal(d.settings.defaultTab, 35.4);
  assert.equal(d.settings.footnoteFormat, 'lowerRoman');
  assert.deepEqual([d.settings.footnotePr.pos, d.settings.footnotePr.numStart, d.settings.footnotePr.numRestart], [undefined, 1, 'eachPage']);
  // assert_imported_body_and_metadata
  const p = parasOf(d);
  assert.equal(p[0].props.style, '1');
  assert.deepEqual(p[0].props.numbering, {num: 2, level: 1});
  assert.equal(propsOfChar(p[0], 4).font, 'Major Face');
  assert.deepEqual(p[0].objects.map(o => o.type), ['commentStart', 'noteRef', 'commentEnd']);
  assert.equal(p[0].objects[0].id, 5);
  const noteId = p[0].objects[1].id;
  const note = d.parts[noteId].blocks[0];
  assert.equal(note.text, `${OBJ} Note text`);
  assert.equal(note.objects[0].type, 'noteRef');
  assert.equal(note.objects[0].id, noteId);
  const c = d.comments[5];
  assert.deepEqual([c.author, c.initials], ['Zed', 'Z']);
  assert.equal(d.parts[c.part].blocks[0].text, 'Look');
  assert.equal(p[1].props.style, 'Normal');
  assert.equal(p[1].text, 'newold');
  assert.equal(d.revisions.length, 2);
  assert.equal(propsOfChar(p[1], 0).ins, 0);
  assert.equal(propsOfChar(p[1], 3).del, 1);
  const s = d.lastSection;
  assert.ok(s.landscape);
  assert.deepEqual([s.pageW, s.pageH], [841.9, 595.3]);
  assert.ok(!s.titlePage);
  assert.equal(d.parts[s.headers.default].blocks[0].text, 'H');
  assert.equal(d.core.title, 'Doc Title');
  assert.equal(d.core.revision, 3);
});

test('fixtures.rs table_style_whole_table_shading_and_margins', async () => {
  const styles = `<w:styles ${W_NS}>
 <w:style w:type="table" w:styleId="Base"><w:name w:val="Base"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/><w:tblCellMar><w:top w:w="20" w:type="dxa"/><w:left w:w="288" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="288" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
 <w:style w:type="table" w:styleId="Whole"><w:name w:val="Whole"/><w:basedOn w:val="Base"/><w:rPr><w:b/></w:rPr><w:tblStylePr w:type="wholeTable"><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="1F4E79"/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="DDEBF7"/></w:tcPr></w:tblStylePr><w:tblStylePr w:type="bogus"/><w:tblStylePr/></w:style>
</w:styles>`;
  const d = await read(await docx('<w:p/>', [['rId1', 'styles', 'styles.xml']], [['word/styles.xml', styles]]));
  const base = getStyle(d.styles, 'Base').table;
  assert.deepEqual(base.fill, [0xee, 0xee, 0xee]);
  assert.deepEqual(base.cellMargins, [1, 14.4, 0, 14.4]);
  const whole = getStyle(d.styles, 'Whole');
  assert.equal(whole.para.align, 'center');
  assert.equal(whole.chr.bold, true);
  assert.deepEqual(whole.chr.color, {Rgb: [0x1f, 0x4e, 0x79]});
  assert.deepEqual(whole.table.fill, [0xdd, 0xeb, 0xf7]);
  assert.equal(whole.table.cellMargins, undefined);
});

test('fixtures.rs strict_namespace_and_bad_numbers', async () => {
  const strictNs = 'xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"';
  const doc = `<w:document ${strictNs}><w:body><w:p><w:pPr><w:spacing w:after="lots"/><w:ind w:left="1in"/></w:pPr><w:r><w:rPr><w:sz w:val="NaN"/></w:rPr><w:t>strict</w:t></w:r></w:p></w:body></w:document>`;
  const rootRels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const d = await read(await zip([['_rels/.rels', rootRels], ['word/document.xml', doc]]));
  const p = parasOf(d)[0];
  assert.equal(p.text, 'strict');
  assert.equal(p.props.indentLeft, 72);
  assert.equal(p.props.spaceAfter, undefined);
  assert.equal(propsOfChar(p, 0).size, undefined);
});

test('fixtures.rs unbalanced_fields_and_markers', async () => {
  const d = await readBody(`<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:bookmarkEnd w:id="9"/><w:commentRangeEnd w:id="3"/><w:r><w:t>ok</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r></w:p><w:p><w:r><w:t>after</w:t></w:r></w:p>`);
  const p = parasOf(d);
  assert.equal(plainText(p[0]).replace(/\uFFFC/g, ''), 'ok');
  assert.ok(p.some(q => q.text.includes('after')));
  // It writes and reads again without losing the text.
  const again = await read(await writeDocx(d));
  assert.ok(parasOf(again).some(q => q.text.includes('after')));
});

test('fixtures.rs field_code_spans_paragraphs', async () => {
  const d = await readBody(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>QUOTE "a</w:instrText></w:r></w:p><w:p><w:r><w:instrText>b"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>ab</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`);
  const p = parasOf(d);
  assert.equal(p[0].objects[0].type, 'field');
  assert.ok(p[0].objects[0].instr.startsWith('QUOTE'));
});

test('fixtures.rs header_self_reference_and_escaping_targets', async () => {
  const hdr = `<w:hdr ${W_NS}><w:p><w:r><w:t>H</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rSelf"/></w:sectPr></w:hdr>`;
  const d = await read(await docx('<w:p/><w:sectPr><w:headerReference w:type="default" r:id="rH"/><w:headerReference w:type="first" r:id="rOut"/></w:sectPr>',
    [['rH', 'header', 'header1.xml'], ['rOut', 'header', '../../../../etc/passwd']],
    [['word/header1.xml', hdr], ['word/_rels/header1.xml.rels', rels([['rSelf', 'header', 'header1.xml']])]]));
  const id = d.lastSection.headers.default;
  assert.equal(d.parts[id].blocks[0].text, 'H');
});

test('fixtures.rs note_marks_reference_their_own_note', async () => {
  const fn = `<w:footnotes ${W_NS}><w:footnote w:id="2"><w:p><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t>note</w:t></w:r></w:p></w:footnote></w:footnotes>`;
  const d = await read(await docx('<w:p><w:r><w:t>x</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="2"/></w:r></w:p>',
    [['rF', 'footnotes', 'footnotes.xml']], [['word/footnotes.xml', fn]]));
  const ref = parasOf(d)[0].objects[0];
  const own = d.parts[ref.id].blocks[0].objects[0];
  assert.equal(own.type, 'noteRef');
  assert.equal(own.id, ref.id);
  // Saved again: the note's mark is written once, as w:footnoteRef, not as a reference to itself.
  const xml = text(await unzip(await writeDocx(d)), 'word/footnotes.xml');
  assert.equal((xml.match(/<w:footnoteRef\/>/g) ?? []).length, 1);
  assert.ok(!/<w:footnote w:id="1">[\s\S]*w:footnoteReference/.test(xml));
});

test('fixtures.rs empty_field_results_keep_line', async () => {
  const d = await readBody('<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>DATE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>');
  const o = parasOf(d)[0].objects[0];
  assert.deepEqual([o.type, o.instr, o.result], ['field', 'DATE', '']);
});
