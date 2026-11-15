// Ported from the in-module tests of deckcraft crates/pptx/src/xml.rs, opc.rs, read/dml.rs,
// custgeom.rs, maps.rs, tables.rs, write/dml.rs and write/shapes.rs (f893f6af7d36a5409fd804e81a34fd895cfefedf).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. What does ArtCraft do? These are the building blocks of its PPTX reader/writer: the bounded XML
//    parser and escaper (xml.rs), package paths (opc.rs), DrawingML colours/body properties
//    (read/dml.rs), custom geometry guides and arcs (custgeom.rs), transition/animation maps
//    (maps.rs), table style GUIDs (tables.rs), colour and preset-guide writing.
// 2. Does ours do the same? Yes: core/prism/formats/pptx-read.mjs and pptx-write.mjs translate them
//    one to one; these tests are upstream's assertions on our functions.
// 3. Which test proves it? This file; the end-to-end behaviour is in pptx_roundtrip.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseXml, esc, escAttr, resolve, relsPath, relative, sidecarPart, color, bodyPr, Guides, readCustGeom, transitionFromXml, TRANSITIONS,
  optionFromSubtype, subtypeFromOption, effectForPreset, tableStyleFromGuid, guid,
} from '../../../core/prism/formats/pptx-read.mjs';
import {W, color as writeColor, writeCustGeom, parsePath, geometry, transitionToXml, guidForStyle, tableStylesXml} from '../../../core/prism/formats/pptx-write.mjs';
import {tableStyles} from '../../../core/prism/model/table.mjs';

// xml.rs ------------------------------------------------------------------------------------------
test('literal CR LF and lone CR read as LF but a char ref stays', () => {
  const d = parseXml('<a:p><a:t>one\r\ntwo\rthree&#13;four</a:t><a:t><![CDATA[x\r\ny]]></a:t></a:p>');
  assert.deepEqual(d.root.childrenNamed('t').map(t => t.text()), ['one\ntwo\nthree\rfour', 'x\ny']);
});
test('CR in text survives write/read', () => {
  assert.equal(esc('a\rb'), 'a&#13;b');
  const w = W.frag();
  w.elt('a:t', 'one\rtwo\r\nthree');
  assert.equal(parseXml(w.s).root.text(), 'one\rtwo\r\nthree');
});
test('parse basic and entities', () => {
  const d = parseXml('<?xml version="1.0"?><a:p xmlns:a="x"><a:r><a:t>A &amp; B &#x41; &lt;</a:t></a:r><a:x r:id="rId1" id="5"/></a:p>');
  assert.equal(d.root.local, 'p');
  assert.equal(d.root.find('t').text(), 'A & B A <');
  const x = d.root.child('x');
  assert.equal(x.attr('id'), '5');
  assert.equal(x.attr('r:id'), 'rId1');
  assert.equal(d.nsDecls().length, 1);
});
test('truncated and garbage', () => {
  assert.ok(parseXml('<a><b><c>text'));
  assert.throws(() => parseXml(''));
  assert.throws(() => parseXml('<a>'.repeat(256 + 10)));
});
test('escape drops control characters', () => {
  assert.equal(esc('a\u000bb<\u0000'), 'ab&lt;');
  assert.equal(escAttr('"x"\n'), '&quot;x&quot;&#10;');
});
test('round-trip serialize', () => {
  assert.equal(parseXml('<p:sp a="1"><p:t>x &amp; y</p:t><e/></p:sp>').root.toXml(), '<p:sp a="1"><p:t>x &amp; y</p:t><e/></p:sp>');
});

// opc.rs ------------------------------------------------------------------------------------------
test('resolve keeps an encoded hash and strips the fragment', () => {
  assert.equal(resolve('ppt/slides', '../media/a%23b.png'), 'ppt/media/a#b.png');
  assert.equal(resolve('ppt/slides', '../media/a.png#frag'), 'ppt/media/a.png');
});
test('percent decoding needs two hex digits', () => {
  assert.equal(resolve('ppt/slides', '../media/a%+5b.png'), 'ppt/media/a%+5b.png');
  assert.equal(resolve('ppt/slides', '../media/a%20b.png'), 'ppt/media/a b.png');
});
test('backslash targets', () => {
  assert.equal(resolve('ppt/slides', '..\\media\\image1.png'), 'ppt/media/image1.png');
  assert.equal(resolve('ppt/slides', '\\ppt\\media\\a.png'), 'ppt/media/a.png');
});
test('path resolution', () => {
  assert.equal(resolve('ppt/slides', '../media/image1.png'), 'ppt/media/image1.png');
  assert.equal(resolve('ppt', 'slides/slide1.xml'), 'ppt/slides/slide1.xml');
  assert.equal(resolve('ppt/slides', '/ppt/media/a%20b.png'), 'ppt/media/a b.png');
  assert.equal(resolve('', '../../../x.xml'), 'x.xml');
  assert.equal(relsPath('ppt/presentation.xml'), 'ppt/_rels/presentation.xml.rels');
  assert.equal(relsPath('[Content_Types].xml'), '_rels/[Content_Types].xml.rels');
  assert.equal(relative('ppt/slides/slide1.xml', 'ppt/media/image1.png'), '../media/image1.png');
  assert.equal(relative('ppt/presentation.xml', 'ppt/slides/slide1.xml'), 'slides/slide1.xml');
  assert.equal(relative('ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'), 'slide2.xml');
});
test('sidecar parts stay inside chart folders', () => {
  assert.ok(sidecarPart('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx'));
  assert.ok(sidecarPart('ppt/charts/style1.xml'));
  assert.ok(sidecarPart('ppt/drawings/chartDrawing1.xml'));
  assert.ok(sidecarPart('ppt/media/image1.png'));
  assert.ok(!sidecarPart('ppt/charts/chart1.xml'));
  assert.ok(!sidecarPart('ppt/charts/_rels/chart1.xml.rels'));
  assert.ok(!sidecarPart('ppt/slides/slide1.xml'));
  assert.ok(!sidecarPart('ppt/embeddings/../../ppt/slides/slide1.xml'));
  assert.ok(!sidecarPart('/etc/passwd'));
});

// read/dml.rs ------------------------------------------------------------------------------------
test('colours and transforms', () => {
  let c = color(parseXml('<a:solidFill xmlns:a="x"><a:schemeClr val="accent2"><a:lumMod val="75000"/><a:alpha val="50000"/></a:schemeClr></a:solidFill>').root);
  assert.deepEqual(c.base, {kind: 'scheme', slot: 'accent2'});
  assert.deepEqual(c.mods, [{op: 'lumMod', val: 75000}, {op: 'alpha', val: 50000}]);
  c = color(parseXml('<x><a:sysClr val="window" lastClr="FFFFFF"/></x>').root);
  assert.equal(c.base.kind, 'system');
  assert.deepEqual(c.base.last, {r: 255, g: 255, b: 255, a: 255});
  c = color(parseXml('<x><a:scrgbClr r="100000" g="0" b="0"/></x>').root);
  assert.deepEqual(c.base, {kind: 'rgb', rgb: {r: 255, g: 0, b: 0, a: 255}});
});
test('body properties', () => {
  let b = bodyPr(parseXml('<a:bodyPr lIns="91440" anchor="ctr" wrap="none" vert="vert270" numCol="2"><a:normAutofit fontScale="62500" lnSpcReduction="20000"/></a:bodyPr>').root);
  assert.equal(b.insetL, 7.2);
  assert.equal(b.anchor, 'middle');
  assert.equal(b.wrap, false);
  assert.equal(b.vert, 'vertical270');
  assert.equal(b.columns, 2);
  assert.deepEqual(b.autofit, {kind: 'shrink', fontScale: 0.625, lineReduction: 0.2});
  assert.equal(b.spaceFirstLast, undefined);
  assert.deepEqual(bodyPr(parseXml('<a:bodyPr><a:normAutofit/></a:bodyPr>').root).autofit, {kind: 'shrink', lineReduction: 0});
  assert.deepEqual(bodyPr(parseXml('<a:bodyPr><a:normAutofit fontScale="100000"/></a:bodyPr>').root).autofit, {kind: 'shrink', fontScale: 1, lineReduction: 0});
  assert.equal(bodyPr(parseXml('<a:bodyPr spcFirstLastPara="1"/>').root).spaceFirstLast, true);
  assert.equal(bodyPr(parseXml('<a:bodyPr vert="mongolianVert"/>').root).vert, 'mongolianVertical');
  assert.equal(bodyPr(parseXml('<a:bodyPr vert="wordArtVertRtl"/>').root).vert, 'stackedRtl');
});

// custgeom.rs -------------------------------------------------------------------------------------
test('guide formulas', () => {
  const g = new Guides(1000, 500);
  assert.equal(g.eval('*/ w 1 2'), 500);
  assert.equal(g.eval('+- w h 100'), 1400);
  assert.equal(g.eval('+/ w h 3'), 500);
  assert.equal(g.eval('?: -1 5 7'), 7);
  assert.equal(g.eval('?: 1 5 7'), 5);
  assert.equal(g.eval('abs -42'), 42);
  assert.equal(g.eval('max 3 9'), 9);
  assert.equal(g.eval('min 3 9'), 3);
  assert.equal(g.eval('mod 3 4 0'), 5);
  assert.equal(g.eval('pin 0 150 100'), 100);
  assert.equal(g.eval('pin 0 -5 100'), 0);
  assert.equal(g.eval('sqrt 16'), 4);
  assert.equal(g.eval('val ss'), 500);
  assert.ok(Math.abs(g.eval('at2 1 1') - 2700000) < 1e-6);
  assert.ok(Math.abs(g.eval('cos 100 5400000')) < 1e-9);
  assert.ok(Math.abs(g.eval('sin 100 5400000') - 100) < 1e-9);
  assert.ok(Math.abs(g.eval('tan 100 2700000') - 100) < 1e-6);
  assert.ok(Math.abs(g.eval('cat2 10 1 0') - 10) < 1e-9);
  assert.ok(Math.abs(g.eval('sat2 10 0 1') - 10) < 1e-9);
  assert.equal(g.eval('*/ 1 1 0'), 0, 'division by zero is 0');
  assert.equal(g.eval('bogus 1 2'), 0);
  assert.equal(g.eval(''), 0);
  g.set('x1', 7);
  assert.equal(g.eval('+- x1 0 2'), 5);
  assert.equal(g.get('hc'), 500);
  assert.equal(g.get('cd4'), 5400000);
});
test('custGeom with guides and an arc', () => {
  const x = `<a:custGeom xmlns:a="x"><a:avLst/><a:gdLst><a:gd name="mid" fmla="*/ w 1 2"/></a:gdLst>
    <a:pathLst><a:path w="200" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="mid" y="h"/></a:lnTo>
    <a:arcTo wR="50" hR="50" stAng="0" swAng="5400000"/><a:close/></a:path>
    <a:path w="10" h="10" fill="none" stroke="0"><a:moveTo><a:pt x="1" y="1"/></a:moveTo><a:quadBezTo><a:pt x="2" y="2"/><a:pt x="3" y="1"/></a:quadBezTo></a:path></a:pathLst></a:custGeom>`;
  const paths = readCustGeom(parseXml(x).root, 1000, 1000);
  assert.equal(paths.length, 2);
  assert.ok(paths[0].d.startsWith('M 0 0 L 100 100 C'), paths[0].d);
  assert.ok(paths[0].d.endsWith('Z'));
  assert.ok(paths[0].d.includes('50 150'), paths[0].d);
  assert.equal(paths[1].fill, 'none');
  assert.equal(paths[1].stroke, false);
  assert.equal(paths[1].d, 'M 1 1 Q 2 2 3 1');
});
test('write then read a path', () => {
  const p = {w: 100, h: 50, d: 'M 0 0 L 100 0 C 100 10 90 50 50 50 Q 0 50 0 0 Z', fill: 'norm', stroke: true};
  const w = W.frag();
  writeCustGeom(w, [p]);
  const back = readCustGeom(parseXml(w.s).root, 1, 1);
  assert.equal(back.length, 1);
  assert.equal(back[0].w, 100000);
  assert.equal(back[0].d, 'M 0 0 L 100000 0 C 100000 10000 90000 50000 50000 50000 Q 0 50000 0 0 Z');
});
test('path tokens', () => {
  const v = parsePath('M0,0 L10-5 Z');
  assert.equal(v.length, 3);
  assert.deepEqual(v[1], ['L', [10, -5]]);
});

// maps.rs -----------------------------------------------------------------------------------------
test('exit presets import as their own effects', () => {
  for (const [preset, sub, effect, option] of [[3, 10, 'blindsOut', 'horz'], [4, 32, 'boxOut', 'out'], [5, 5, 'checkerboardOut', 'down'], [8, 16, 'diamondOut', 'in'],
    [12, 4, 'peekOut', 'b'], [18, 6, 'stripsOut', 'rd'], [37, 0, 'sinkDown', ''], [49, 0, 'spinnerOut', ''], [55, 0, 'contract', '']]) {
    const e = effectForPreset('exit', preset);
    assert.deepEqual([e, optionFromSubtype(e, sub)], [effect, option], `preset ${preset}`);
  }
});
test('every transition kind round trips through its XML', () => {
  for (const [kind, , , , opts] of TRANSITIONS) {
    if (kind === 'none') continue;
    for (const o of opts.length ? opts : ['']) {
      const w = W.frag();
      const ns = transitionToXml(w, kind, o);
      assert.ok(ns, `no xml for ${kind}`);
      const [k, opt] = transitionFromXml(parseXml(w.s).root) ?? [];
      assert.equal(k, kind, `kind for ${kind}/${o}`);
      if (o) assert.equal(opt, o, `option for ${kind}`);
    }
  }
});
test('subtypes', () => {
  assert.equal(subtypeFromOption('fly', 'b'), 4);
  assert.equal(optionFromSubtype('fly', 8), 'l');
  assert.equal(optionFromSubtype('fade', 0), '');
  assert.equal(effectForPreset('entrance', 2), 'fly');
  assert.equal(effectForPreset('emphasis', 8), 'spin');
});

// tables.rs ---------------------------------------------------------------------------------------
test('style parts follow the schema order', () => {
  const ORDER = ['tblBg', 'wholeTbl', 'band1H', 'band2H', 'band1V', 'band2V', 'lastCol', 'firstCol', 'lastRow', 'seCell', 'swCell', 'firstRow', 'neCell', 'nwCell'];
  const d = parseXml(tableStylesXml(tableStyles().map(([id]) => id), []));
  let n = 0;
  for (const st of d.root.childrenNamed('tblStyle')) {
    n++;
    const pos = st.elements().map(e => ORDER.indexOf(e.local));
    assert.ok(pos.every((v, i) => i === 0 || pos[i - 1] < v), `${st.attr('styleName')}: ${pos}`);
  }
  assert.ok(n > 30);
});
test('table style GUIDs round trip', () => {
  for (const [id] of tableStyles()) {
    const [g] = guidForStyle(id);
    assert.equal(tableStyleFromGuid(g), id, `${id} via ${g}`);
    assert.equal(g.length, 38);
  }
  assert.equal(tableStyleFromGuid('{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'), 'medium2-accent1');
  assert.equal(tableStyleFromGuid('{ABCDEF00-0000-0000-0000-000000000000}'), '{ABCDEF00-0000-0000-0000-000000000000}');
  assert.match(guid('anything'), /^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-8[0-9A-F]{3}-[0-9A-F]{12}\}$/);
});

// write/dml.rs, write/shapes.rs ------------------------------------------------------------------
test('unknown preset and system names save as black and windowText', () => {
  const out = base => { const w = W.frag(); writeColor(w, {base}); return w.s; };
  assert.equal(out({kind: 'preset', name: 'notAColor'}), '<a:prstClr val="black"/>');
  assert.equal(out({kind: 'preset', name: 'darkBlue'}), '<a:prstClr val="darkBlue"/>');
  const last = {r: 0x12, g: 0x34, b: 0x56, a: 255};
  assert.equal(out({kind: 'system', name: 'notAColor', last}), '<a:sysClr val="windowText" lastClr="123456"/>');
  assert.equal(out({kind: 'system', name: '3dLight', last}), '<a:sysClr val="3dLight" lastClr="123456"/>');
});
test('preset guides are complete', () => {
  let w = W.frag();
  geometry(w, {kind: 'preset', name: 'star5', adj: [20000]});
  assert.equal(w.s, '<a:prstGeom prst="star5"><a:avLst><a:gd name="adj" fmla="val 20000"/><a:gd name="hf" fmla="val 105146"/><a:gd name="vf" fmla="val 110557"/></a:avLst></a:prstGeom>');
  w = W.frag();
  geometry(w, {kind: 'preset', name: 'rightArrow', adj: [10000]});
  assert.ok(w.s.includes('name="adj1" fmla="val 10000"') && w.s.includes('name="adj2" fmla="val 50000"'), w.s);
  w = W.frag();
  geometry(w, {kind: 'preset', name: 'textBox'});
  assert.equal(w.s, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>');
});
