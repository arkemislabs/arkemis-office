// Ported from deckcraft crates/pptx/tests/it/tags.rs, sniff.rs, placeholders.rs, anchor.rs, locks.rs,
// kept_parts.rs, trigger_steps.rs, table_styles.rs, math_ns.rs, malformed.rs (truncated_zip,
// fuzz_mutations, zip_bomb_entry_is_capped), roundtrip.rs (transition_defaults_read_like_powerpoint,
// an_embedded_font_list_already_in_the_package_is_read, the file half of
// transition_sound_is_set_saved_and_removed / transition_sound_options_round_trip), fills.rs,
// comments.rs, ole.rs, ole_vml.rs and the crates/pptx/src/cfb.rs, opc.rs (inflate budget, xml_bytes)
// and png.rs unit tests, at f893f6af7d36a5409fd804e81a34fd895cfefedf.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. What does ArtCraft do? deckcraft's reader keeps what PowerPoint and add-ins put in a package
//    (tags, custom XML, sensitivity labels, custom properties, table style definitions, embedded
//    font lists, math namespaces declared on ancestors), reads PowerPoint's defaults the way
//    PowerPoint does (a missing text anchor is top, partial locks are not Lock, an omitted
//    transition option is the element's default, a placeholder without geometry takes its
//    layout's), writes Lock with PowerPoint's full attribute set and triggered sequences with one
//    click per step, survives truncated, mutated and zip-bomb packages, and names a
//    password-protected file instead of failing as an unknown one.
// 2. Does ours do the same? core/prism/formats/pptx-read.mjs and pptx-write.mjs translate those
//    paths over Prism schema 2; the assertions here are upstream's. Where upstream drives an engine
//    command (transition.sound), the command half belongs to the transitions family and only the
//    file half (the sound, its loop and Stop Previous Sound written and read back) is asserted.
//    Upstream's "sample" deck is replaced by the rich fixture deck (tests/prism/formats-pptx-fixtures.mjs).
// 3. Which test proves it? This file.

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {richDeck, round, take, para, box, repack, partText, entries, addMedia, addSlide, png} from '../formats-pptx-fixtures.mjs';
import {exportPptx} from '../../../core/prism/formats/pptx-write.mjs';
import {importPptx, sniff, isEncrypted, directoryNames, read, SIGNATURE, END_OF_CHAIN} from '../../../core/prism/formats/pptx-read.mjs';
import {newPresentation} from '../../../core/prism/model/defaults.mjs';
import {shape as newShape, walk, validatePresentation, layoutById} from '../../../core/prism/model/presentation.mjs';
import {newTable} from '../../../core/prism/model/table.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';

const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);
async function zipOf(list, opts = {}) {
  const z = new JSZip();
  for (const [n, d] of list) z.file(n, d, opts);
  return z.generateAsync({type: 'uint8array', compression: opts.compression ?? 'STORE'});
}
const find = (slide, name) => {
  let hit = null;
  walk(slide.shapes, s => { if (!hit && s.name === name) hit = s; });
  if (!hit) throw new Error(`no shape ${name}`);
  return hit;
};
const shapeAt = (p, name, x) => newShape({id: take(p), name, xfrm: {x, y: 40, w: 80, h: 60}});

// ---- tags.rs ----

test('tags survive round trip', async () => {
  const p = richDeck();
  p.tags = [['THINKCELLPRESENTATIONDONOTDELETE', '<xml & stuff>']];
  const slide = p.slides[0];
  slide.tags = [['TIMING', '5'], ['SECTION', 'Intro']];
  const shapeId = slide.shapes[0].id;
  slide.shapes[0].tags = [['THINKCELLSHAPEDONOTDELETE', 't!abc']];
  const bytes = await exportPptx(p);
  const e = await entries(bytes);
  assert.ok(dec(e['[Content_Types].xml']).includes('presentationml.tags+xml'));
  assert.equal(Object.keys(e).filter(n => n.startsWith('ppt/tags/')).length, 3);
  const back = await importPptx(bytes);
  assert.deepEqual(back.tags, p.tags);
  assert.deepEqual(back.slides[0].tags, p.slides[0].tags);
  const first = back.slides[0].shapes[0];
  assert.equal(first.name, p.slides[0].shapes.find(s => s.id === shapeId).name);
  assert.deepEqual(first.tags, [['THINKCELLSHAPEDONOTDELETE', 't!abc']]);
  assert.ok(back.slides.slice(1).every(s => !(s.tags?.length)));
});

// ---- sniff.rs ----

async function contentTypesLast(bytes) {
  const src = await JSZip.loadAsync(bytes);
  const out = new JSZip();
  out.file('ppt/media/padding.bin', new Uint8Array(64 * 1024), {compression: 'STORE'});
  const names = Object.keys(src.files).filter(n => !src.files[n].dir);
  for (const n of [...names.filter(n => n !== '[Content_Types].xml'), '[Content_Types].xml']) out.file(n, await src.file(n).async('uint8array'));
  return out.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
}

test('sniff accepts content types anywhere in the archive', async () => {
  const bytes = await exportPptx(richDeck());
  assert.equal(await sniff(bytes), true);
  const moved = await contentTypesLast(bytes);
  const first4k = dec(moved.subarray(0, 4096));
  assert.ok(!first4k.includes('[Content_Types].xml'), 'test setup: name must not be in the prefix');
  assert.equal(await sniff(moved), true);
  const p = await importPptx(moved);
  assert.ok(p.slides.length > 0);
});

test('sniff rejects non packages', async () => {
  assert.equal(await sniff(new Uint8Array()), false);
  assert.equal(await sniff(enc('PK')), false);
  assert.equal(await sniff(enc('%PDF-1.7 [Content_Types].xml')), false);
  assert.equal(await sniff(await zipOf([['hello.txt', 'not an office package']])), false);
});

// ---- placeholders.rs ----

test('a placeholder without geometry takes its layouts', async () => {
  const p = newPresentation();
  const [, layout] = layoutById(p, p.slides[0].layout);
  for (const s of layout.shapes) if (s.ph) s.geom = {kind: 'preset', name: 'ellipse', adj: []};
  const bytes = await exportPptx(p);
  // Strip the slide's own geometry, as PowerPoint writes inheriting placeholders.
  const bare = await repack(bytes, (n, x) => (n.startsWith('ppt/slides/slide') && n.endsWith('.xml') ? x.replace(/<a:prstGeom[\s\S]*?<\/a:prstGeom>/g, '') : x));
  const q = await importPptx(bare);
  const phs = q.slides[0].shapes.filter(s => s.ph);
  assert.ok(phs.length > 0);
  for (const s of phs) assert.ok(s.geom?.kind === 'preset' && s.geom.name === 'ellipse', JSON.stringify(s.geom));
  // A placeholder with its own geometry keeps it.
  for (const s of p.slides[0].shapes) if (s.ph) s.geom = {kind: 'preset', name: 'triangle', adj: []};
  const r = await round(p);
  assert.ok(r.slides[0].shapes.filter(s => s.ph).every(s => s.geom?.kind === 'preset' && s.geom.name === 'triangle'));
});

// ---- anchor.rs ----

/** Anchors of the shapes with text that aren't placeholders, text boxes or tables. */
const anchors = p => p.slides.flatMap(s => s.shapes).filter(s => !s.ph && !s.textBox && s.kind?.type !== 'table' && s.text).map(s => s.text.body?.anchor ?? null);

test('shapes keep their middle anchor and files without one anchor at the top', async () => {
  const p = richDeck();
  // The sample's shapes with the model's default anchor (middle, left unset).
  p.slides[1].shapes.push(box(p, 'Centred', 600, 300, 120, 60, {text: {body: {}, paragraphs: [para('Middle')]}}));
  assert.ok(anchors(p).includes(null), 'the deck has shapes with the model\'s default anchor');
  const bytes = await exportPptx(p);
  // Written explicitly, so PowerPoint (which reads a missing anchor as top) centres them too.
  const back = await importPptx(bytes);
  assert.deepEqual(anchors(back), anchors(p), 'the middle anchor survives (as the model\'s default)');
  // The same file without the anchors: their text sits at the top.
  const bare = await repack(bytes, (n, x) => (n.startsWith('ppt/slides/slide') ? x.replaceAll(' anchor="ctr"', '') : x));
  const a = anchors(await importPptx(bare));
  assert.ok(a.every(x => x === 'top'), JSON.stringify(a));
  // Also when the theme's shape defaults centre new shapes, as Office's themes do.
  const themed = await repack(bare, (n, x) => (n.startsWith('ppt/theme/')
    ? x.replace('<a:objectDefaults/>', '<a:objectDefaults><a:spDef><a:spPr/><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/></a:spDef></a:objectDefaults>') : x));
  const t = anchors(await importPptx(themed));
  assert.ok(t.every(x => x === 'top'), JSON.stringify(t));
});

// ---- locks.rs ----

/** Slide 1 of a blank deck holds: a locked shape, an unlocked one, a hidden locked text box, a
 * locked group (one child unlocked, one hidden), and a locked picture, connector and table. */
function lockDeck() {
  const p = newPresentation();
  const img = addMedia(p, 'image1.png', 'image/png', png([10, 200, 30]));
  const v = [];
  v.push({...shapeAt(p, 'Locked', 0), locked: true});
  v.push(shapeAt(p, 'Free', 100));
  v.push({...shapeAt(p, 'Hidden text', 200), textBox: true, hidden: true, locked: true});
  const c1 = {...shapeAt(p, 'Child locked', 300), locked: true};
  const c2 = shapeAt(p, 'Child free', 400);
  const c3 = {...shapeAt(p, 'Child hidden', 500), hidden: true};
  const gx = {x: 300, y: 40, w: 280, h: 60};
  v.push(newShape({id: take(p), name: 'Group', xfrm: gx, kind: {type: 'group', children: [c1, c2, c3], child: {...gx}}, locked: true}));
  v.push({...shapeAt(p, 'Pic', 0), kind: {type: 'picture', fill: {media: img, crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null, adjust: null}}, locked: true});
  v.push({...shapeAt(p, 'Conn', 100), kind: {type: 'connector', start: null, end: null}, geom: {kind: 'preset', name: 'straightConnector1', adj: []}, locked: true});
  v.push({...shapeAt(p, 'Tbl', 200), kind: {type: 'table', ...newTable(2, 2, 160, 30)}, locked: true});
  p.slides[0].shapes = v;
  return p;
}
/** The element following `name="…"` up to the end of the object's non-visual properties. */
const nvOf = (xml, name) => {
  const i = xml.indexOf(`name="${name}"`);
  assert.ok(i >= 0, `no ${name}`);
  const rest = xml.slice(i);
  const j = rest.indexOf('<p:nvPr');
  return j < 0 ? rest : rest.slice(0, j);
};

test('lock and hidden round trip', async () => {
  const q = await round(lockDeck());
  const s = q.slides[0];
  for (const [name, locked, hidden] of [['Locked', true, false], ['Free', false, false], ['Hidden text', true, true], ['Group', true, false],
    ['Child locked', true, false], ['Child free', false, false], ['Child hidden', false, true], ['Pic', true, false], ['Conn', true, false], ['Tbl', true, false]]) {
    const sh = find(s, name);
    assert.deepEqual([!!sh.locked, !!sh.hidden], [locked, hidden], name);
  }
  // The stacking order of the slide and of the group survives too.
  assert.deepEqual(s.shapes.map(x => x.name), ['Locked', 'Free', 'Hidden text', 'Group', 'Pic', 'Conn', 'Tbl']);
  assert.deepEqual(find(s, 'Group').kind.children.map(x => x.name), ['Child locked', 'Child free', 'Child hidden']);
});

test('lock writes PowerPoint\'s full attribute set', async () => {
  const xml = await partText(await exportPptx(lockDeck()), 'ppt/slides/slide1.xml');
  const sp = 'noGrp="1" noRot="1" noMove="1" noResize="1" noEditPoints="1" noAdjustHandles="1" noChangeArrowheads="1" noChangeShapeType="1"';
  assert.ok(nvOf(xml, 'Locked').includes(`<a:spLocks ${sp}/>`), nvOf(xml, 'Locked'));
  assert.ok(nvOf(xml, 'Hidden text').includes(`<a:spLocks ${sp}/>`));
  assert.ok(nvOf(xml, 'Hidden text').includes('hidden="1"'));
  assert.ok(!nvOf(xml, 'Free').includes('Locks'), `an unlocked shape writes no locks: ${nvOf(xml, 'Free')}`);
  assert.ok(nvOf(xml, 'Group').includes('<a:grpSpLocks noGrp="1" noUngrp="1" noRot="1" noMove="1" noResize="1"/>'));
  assert.ok(nvOf(xml, 'Conn').includes(`<a:cxnSpLocks ${sp}/>`), nvOf(xml, 'Conn'));
  assert.ok(nvOf(xml, 'Pic').includes(`<a:picLocks noChangeAspect="1" ${sp} noCrop="1"/>`), nvOf(xml, 'Pic'));
  assert.ok(nvOf(xml, 'Tbl').includes('<a:graphicFrameLocks noGrp="1" noDrilldown="1" noMove="1" noResize="1"/>'));
});

test('partial locks are not Lock', async () => {
  const p = newPresentation();
  const [a, b, c] = ['A', 'B', 'C'].map((n, i) => shapeAt(p, n, i * 100));
  const d = {...shapeAt(p, 'D', 300), locked: true};
  p.slides[0].shapes = [a, b, c, d];
  const swap = (xml, name, locks) => {
    const i = xml.indexOf(`name="${name}"`);
    const j = i + xml.slice(i).indexOf('<p:cNvSpPr');
    const k = j + xml.slice(j).indexOf('<p:nvPr');
    return `${xml.slice(0, j)}<p:cNvSpPr>${locks}</p:cNvSpPr>${xml.slice(k)}`;
  };
  const bytes = await repack(await exportPptx(p), (n, x) => {
    if (n !== 'ppt/slides/slide1.xml') return x;
    x = swap(x, 'A', '<a:spLocks noMove="1" noResize="1"/>');
    x = swap(x, 'B', '<a:spLocks noRot="1" noMove="1" noResize="1" noEditPoints="1" noAdjustHandles="1" noChangeArrowheads="1" noChangeShapeType="1"/>');
    return swap(x, 'C', '<a:spLocks noGrp="1" noRot="1" noMove="1" noResize="1" noEditPoints="1" noAdjustHandles="1" noChangeShapeType="1"/>');
  });
  const s = (await importPptx(bytes)).slides[0];
  assert.equal(!!find(s, 'A').locked, false);
  assert.equal(!!find(s, 'B').locked, false);
  assert.equal(!!find(s, 'C').locked, false);
  assert.equal(find(s, 'D').locked, true);
});

test('an empty locks element is unlocked', async () => {
  const p = newPresentation();
  p.slides[0].shapes = [shapeAt(p, 'A', 0)];
  const bytes = await repack(await exportPptx(p), (n, x) => (n === 'ppt/slides/slide1.xml' ? x.replace('<p:cNvSpPr/>', '<p:cNvSpPr><a:spLocks/></p:cNvSpPr>') : x));
  assert.equal(!!find((await importPptx(bytes)).slides[0], 'A').locked, false);
});

// ---- kept_parts.rs ----

const ITEM = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"/>';
const PROPS = '<?xml version="1.0" encoding="UTF-8" standalone="no"?><ds:datastoreItem ds:itemID="{11111111-2222-3333-4444-555555555555}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs/></ds:datastoreItem>';
const ITEM_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps1.xml"/></Relationships>';
const LABEL = '<?xml version="1.0" encoding="utf-8" standalone="yes"?><clbl:labelList xmlns:clbl="http://schemas.microsoft.com/office/2020/mipLabelMetadata"><clbl:label id="{aaaaaaaa-0000-0000-0000-000000000001}" enabled="1" method="Standard" siteId="{bbbbbbbb-0000-0000-0000-000000000002}" removed="0"/></clbl:labelList>';
const CUSTOM = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ContentTypeId"><vt:lpwstr>0x0101</vt:lpwstr></property></Properties>';
const KEPT = [['customXml/item1.xml', ITEM], ['customXml/itemProps1.xml', PROPS], ['customXml/_rels/item1.xml.rels', ITEM_RELS], ['docMetadata/LabelInfo.xml', LABEL], ['docProps/custom.xml', CUSTOM]];

test('custom XML, the sensitivity label and custom properties survive save', async () => {
  const add = (x, at, more) => x.replace(at, more + at);
  const deck = await repack(await exportPptx(richDeck()), (n, x) => {
    if (n === '[Content_Types].xml') return add(x, '</Types>', '<Override PartName="/customXml/itemProps1.xml" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/><Override PartName="/docMetadata/LabelInfo.xml" ContentType="application/vnd.ms-office.classificationlabels+xml"/>');
    if (n === '_rels/.rels') return add(x, '</Relationships>', '<Relationship Id="rIdL" Type="http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels" Target="docMetadata/LabelInfo.xml"/><Relationship Id="rIdC" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>');
    if (n === 'ppt/_rels/presentation.xml.rels') return add(x, '</Relationships>', '<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/>');
    return x;
  }, Object.fromEntries(KEPT));
  const p = await importPptx(deck);
  assert.equal(p.keptParts.length, 5);
  const saved = await exportPptx(p);
  const e = await entries(saved);
  for (const [n, d] of KEPT) assert.equal(e[n] && dec(e[n]), d, n);
  const ct = dec(e['[Content_Types].xml']);
  assert.ok(ct.includes('/docMetadata/LabelInfo.xml') && ct.includes('customXmlProperties+xml') && ct.includes('custom-properties+xml'));
  const root = dec(e['_rels/.rels']);
  assert.ok(root.includes('classificationlabels') && root.includes('Target="docProps/custom.xml"'));
  assert.ok(dec(e['ppt/_rels/presentation.xml.rels']).includes('Target="../customXml/item1.xml"'));
  // And again: a second save keeps them once.
  const again = await importPptx(saved);
  assert.deepEqual(again.keptParts, p.keptParts);
});

// ---- trigger_steps.rs ----

const anim = (fields = {}) => ({shape: null, class: 'entrance', effect: 'appear', option: '', start: 'onClick', durationMs: 500, delayMs: 0, repeat: 1, rewind: false,
  textBuild: 'asOne', paragraph: null, path: null, trigger: null, amount: null, color: null, presetId: null, presetSubtype: null, after: null, sound: null,
  smoothStart: 0, smoothEnd: 0, bounceEnd: 0, autoReverse: false, ...fields});
function triggerDeck() {
  const p = newPresentation();
  p.slides[0].shapes = ['Button', 'Other button', 'Content'].map(name => newShape({id: take(p), name, xfrm: {x: 40, y: 40, w: 200, h: 100}, text: bodyFromText('First\nSecond\nThird')}));
  return p;
}
const slideXml = async p => partText(await exportPptx(p), 'ppt/slides/slide1.xml');
const count = (s, needle) => s.split(needle).length - 1;

test('triggered click steps survive import, edit, save and reopen', async () => {
  const p = triggerDeck();
  const ids = p.slides[0].shapes.map(s => s.id);
  ['onClick', 'withPrevious', 'afterPrevious', 'onClick', 'withPrevious', 'onClick'].forEach((start, i) =>
    p.slides[0].animations.push(anim({shape: ids[2], trigger: ids[0], start, delayMs: i * 100})));
  // An independent button and the main sequence must not borrow this button's steps.
  for (const trigger of [ids[1], null]) for (const start of ['onClick', 'afterPrevious', 'onClick']) p.slides[0].animations.push(anim({shape: ids[2], trigger, start, effect: 'fade'}));
  let q = await round(p);
  for (let pass = 0; pass < 2; pass++) {
    for (const trigger of [ids[0], ids[1], null]) {
      const state = deck => deck.slides[0].animations.filter(a => (a.trigger ?? null) === trigger).map(a => [a.start, a.delayMs]);
      assert.deepEqual(state(q), state(p), `trigger ${trigger}, pass ${pass}`);
    }
    assert.equal(q.slides[0].animations.length, p.slides[0].animations.length);
    q.slides[0].shapes[2].name = 'Edited content';
    q = await round(q);
  }
  const xml = await slideXml(p);
  assert.equal(count(xml, 'nodeType="interactiveSeq"'), 2);
  assert.equal(count(xml, 'nodeType="clickEffect"'), 7);
  // The first step in each interactive sequence begins at zero; subsequent steps wait.
  assert.equal(count(xml, 'delay="indefinite"'), 5);
});

test('a triggered paragraph build keeps a click for each paragraph', async () => {
  const p = triggerDeck();
  const ids = p.slides[0].shapes.map(s => s.id);
  p.slides[0].animations = [anim({shape: ids[2], trigger: ids[0], textBuild: 'byParagraph', start: 'onClick', effect: 'fade'})];
  for (const q of [structuredClone(p), await round(p)]) {
    const xml = await slideXml(q);
    assert.equal(count(xml, 'nodeType="clickEffect"'), 3);
    assert.equal(count(xml, 'delay="indefinite"'), 2);
    const back = await round(q);
    assert.equal(back.slides[0].animations.length, 1);
    assert.equal(back.slides[0].animations[0].textBuild, 'byParagraph');
    assert.equal(back.slides[0].animations[0].trigger, ids[0]);
  }
});

// ---- table_styles.rs ----

const STYLE_GUID = '{ABCDEF01-2345-4678-9ABC-DEF012345678}';
const styleXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="${STYLE_GUID}"><a:tblStyle styleId="${STYLE_GUID}" styleName="Probe Style"><a:tblBg><a:fillRef idx="1"><a:srgbClr val="FF0000"/></a:fillRef></a:tblBg><a:wholeTbl><a:tcTxStyle b="on"><a:srgbClr val="00FF00"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left><a:ln w="25400"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln></a:left><a:insideH><a:ln><a:noFill/></a:ln></a:insideH></a:tcBdr><a:fill><a:noFill/></a:fill></a:tcStyle></a:wholeTbl><a:band1H><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:srgbClr val="FFFFFF"><a:alpha val="20000"/></a:srgbClr></a:solidFill></a:fill></a:tcStyle></a:band1H></a:tblStyle></a:tblStyleLst>`;
async function tableDeck() {
  const p = newPresentation();
  const t = {type: 'table', ...newTable(3, 2, 300, 30), style: 'medium2-accent1'};
  p.slides[0].shapes.push(newShape({id: take(p), name: 'Styled', xfrm: {x: 10, y: 10, w: 300, h: 90}, kind: t}));
  return repack(await exportPptx(p), (n, x) => {
    if (n === 'ppt/tableStyles.xml') return styleXml();
    if (n.startsWith('ppt/slides/slide') && n.endsWith('.xml')) return x.replace(/(<a:tableStyleId>)[^<]*(<\/a:tableStyleId>)/, `$1${STYLE_GUID}$2`);
    return x;
  });
}
const part = (def, name) => def.parts.find(([n]) => n === name)?.[1] ?? null;

test('table styles the file defines are read, used and kept', async () => {
  const p = await importPptx(await tableDeck());
  const def = p.tableStyles.find(d => d.id === STYLE_GUID);
  assert.ok(def, 'the probe style is read');
  assert.equal(def.name, 'Probe Style');
  assert.ok(def.background, 'table background');
  assert.equal(def.background.fillRef?.[0], 1);
  const whole = part(def, 'wholeTbl');
  assert.equal(whole.bold, true);
  assert.ok(whole.textColor);
  assert.equal(whole.borders[0]?.kind, 'line');
  assert.equal(whole.borders[0].line.width, 2);
  assert.equal(whole.borders[4]?.kind, 'line');
  assert.equal(whole.borders[4].line.fill?.kind, 'none');
  assert.equal(part(def, 'band1H')?.fill?.kind, 'solid');
  // The table keeps the style's GUID, so it's drawn from the definition.
  const t = p.slides[0].shapes.find(s => s.name === 'Styled');
  assert.equal(t.kind.type, 'table');
  assert.equal(t.kind.style, STYLE_GUID);
  // Saving writes the definition back, unchanged.
  const q = await round(p);
  const def2 = q.tableStyles.find(d => d.id === STYLE_GUID);
  assert.ok(def2, 'kept on save');
  assert.deepEqual(def2.parts, def.parts);
});

test('a table style no table uses is kept on save', async () => {
  const p = await importPptx(await tableDeck());
  assert.ok(p.tableStyles.some(d => d.id === STYLE_GUID));
  for (const s of p.slides) s.shapes = s.shapes.filter(sh => sh.kind?.type !== 'table');
  const q = await round(p);
  const d = q.tableStyles.find(x => x.id === STYLE_GUID);
  assert.ok(d, 'style kept');
  assert.equal(d.name, 'Probe Style');
});

// ---- math_ns.rs ----

const NS_M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
async function movedTo(host) {
  const p = newPresentation();
  const omml = `<m:oMathPara ${NS_M}><m:oMath><m:r><m:t>x=1</m:t></m:r></m:oMath></m:oMathPara>`;
  p.slides[0].shapes = [newShape({id: take(p), name: 'Equation', xfrm: {x: 10, y: 10, w: 200, h: 40},
    text: {body: {}, paragraphs: [{level: 0, runs: [{text: 'x=1', props: {}, kind: {kind: 'math', omml}}]}]}})];
  const bytes = await repack(await exportPptx(p), (n, x) => {
    if (n !== 'ppt/slides/slide1.xml') return x;
    assert.ok(x.includes(host), x);
    const out = x.replace(` ${NS_M}`, '').replace(host, `${host}${NS_M} `);
    assert.equal(count(out, NS_M), 1);
    return out;
  });
  const q = await importPptx(bytes);
  const run = q.slides[0].shapes.find(s => s.name === 'Equation')?.text?.paragraphs?.[0]?.runs?.[0];
  assert.equal(run?.kind?.kind, 'math', JSON.stringify(run));
  return run.kind.omml;
}

test('a math namespace declared on the slide root is kept', async () => {
  const omml = await movedTo('<p:sld ');
  assert.ok(omml.includes(NS_M), omml);
});

test('a math namespace declared on an enclosing wrapper is kept', async () => {
  const omml = await movedTo('<mc:Choice ');
  assert.ok(omml.includes(NS_M), omml);
});

// ---- malformed.rs (the ones not in pptx_roundtrip.test.mjs) ----

const valid = () => exportPptx(newPresentation());

test('a truncated zip never throws anything but an error', async () => {
  const v = await valid();
  for (const cut of [10, v.length >> 2, v.length >> 1, v.length - 30, v.length - 1]) {
    try { await importPptx(v.subarray(0, cut)); } catch (e) { assert.ok(e instanceof Error); }
  }
});

test('fuzz mutations import or fail cleanly, and what imports exports again', async () => {
  const e = Object.entries(await entries(await exportPptx(richDeck())));
  let seed = 0x5eedn;
  const mask = (1n << 64n) - 1n;
  const rnd = n => { seed ^= (seed << 13n) & mask; seed ^= seed >> 7n; seed ^= (seed << 17n) & mask; return Number(seed % BigInt(Math.max(n, 1))); };
  // Upstream runs 300 iterations in debug builds; a JS run of the whole reader is slower per case.
  for (let it = 0; it < 120; it++) {
    const v = e.map(([n, d]) => [n, [...d]]);
    const k = rnd(v.length);
    const d = v[k][1];
    for (let m = 0, times = 1 + rnd(8); m < times; m++) {
      if (!d.length) break;
      const at = rnd(d.length);
      switch (rnd(4)) {
        case 0: d[at] = rnd(256); break;
        case 1: d.length = at; break;
        case 2: d.splice(at, 0, '<>"&='.charCodeAt(rnd(5))); break;
        default: { const end = Math.min(at + rnd(64), d.length); d.splice(at, end - at); break; }
      }
    }
    const bytes = await zipOf(v.map(([n, x]) => [n, new Uint8Array(x)]));
    let p = null;
    try { p = await importPptx(bytes); } catch (err) { assert.ok(err instanceof Error); continue; }
    assert.deepEqual(validatePresentation(p), [], `mutating ${v[k][0]}`);
    await exportPptx(p);
  }
  // Raw byte flips of the whole zip, too.
  const bytes = await exportPptx(richDeck());
  for (let it = 0; it < 120; it++) {
    const b = bytes.slice();
    for (let m = 0, times = 1 + rnd(16); m < times; m++) b[rnd(b.length)] = rnd(256);
    try { await importPptx(b); } catch (err) { assert.ok(err instanceof Error); }
  }
});

test('a zip-bomb entry is capped', async () => {
  const e = Object.entries(await entries(await valid()));
  e.push(['ppt/big.xml', new Uint8Array(64 * 1024 * 1024).fill(0x20)]);
  const bytes = await zipOf(e, {compression: 'DEFLATE'});
  assert.ok(bytes.length < 2 * 1024 * 1024);
  const p = await importPptx(bytes);
  assert.equal(p.slides.length, 1);
});

// ---- roundtrip.rs: transitions as PowerPoint writes them, embedded font lists, transition sounds ----

test('transition defaults read like PowerPoint', async () => {
  const cases = [
    ['<p:push/>', 'push', 'l'], ['<p:wipe/>', 'wipe', 'l'], ['<p:strips/>', 'wipe', 'lu'], ['<p:randomBar/>', 'randomBar', 'horz'],
    ['<p:checker/>', 'checker', 'horz'], ['<p:blinds/>', 'blinds', 'horz'], ['<p:comb/>', 'comb', 'horz'], ['<p:zoom/>', 'shape', 'out'],
    ['<p:zoom dir="in"/>', 'shape', 'in'], ['<p:split/>', 'split', 'horzOut'], ['<p14:doors/>', 'doors', 'horz'], ['<p14:window/>', 'window', 'horz'],
    ['<p14:pan/>', 'pan', 'l'], ['<p14:warp/>', 'zoom', 'out'], ['<p14:glitter/>', 'glitter', 'l'], ['<p14:shred/>', 'shred', 'stripsIn'],
    ['<p14:reveal/>', 'reveal', 'smoothlyLeft'], ['<p14:prism/>', 'cube', 'l'], ['<p15:prstTrans prst="airplane"/>', 'airplane', 'r'],
    ['<p15:prstTrans prst="peelOff"/>', 'peelOff', 'l'], ['<p15:prstTrans prst="pageCurlSingle"/>', 'pageCurlDouble', 'singleL'],
  ];
  const p = newPresentation();
  p.slides = [p.slides[0]];
  p.slides[0].transition = {kind: 'fade', option: 'smoothly', durationMs: 2000, advanceOnClick: true, advanceAfterMs: null, sound: null};
  const bytes = await exportPptx(p);
  const x = await partText(bytes, 'ppt/slides/slide1.xml');
  const start = x.indexOf('<mc:AlternateContent');
  const end = x.indexOf('</mc:AlternateContent>') + '</mc:AlternateContent>'.length;
  assert.ok(start >= 0 && end > start, 'transition');
  const p14 = 'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"';
  const p15 = 'xmlns:p15="http://schemas.microsoft.com/office/powerpoint/2012/main"';
  for (const [el, kind, option] of cases) {
    const tr = `<p:transition ${p14} ${p15} spd="slow" p14:dur="2000">${el}</p:transition>`;
    const edited = x.slice(0, start) + tr + x.slice(end);
    const q = await importPptx(await repack(bytes, (n, s) => (n === 'ppt/slides/slide1.xml' ? edited : s)));
    const t = q.slides[0].transition;
    assert.ok(t, el);
    assert.deepEqual([t.kind, t.option, t.durationMs], [kind, option, 2000], el);
  }
});

test('an embedded font list already in the package is read', async () => {
  const font = enc('FACE-BYTES-FROM-THE-PACKAGE');
  const patched = await repack(await exportPptx(newPresentation()), (n, x) => {
    if (n === 'ppt/presentation.xml') return x.replace('<p:defaultTextStyle', '<p:embeddedFontLst><p:embeddedFont><p:font typeface="Package Face" pitchFamily="2"/><p:bold r:id="rIdFont"/></p:embeddedFont></p:embeddedFontLst><p:defaultTextStyle');
    if (n === 'ppt/_rels/presentation.xml.rels') return x.replace('</Relationships>', '<Relationship Id="rIdFont" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font1.fntdata"/></Relationships>');
    if (n === '[Content_Types].xml') return x.replace('</Types>', '<Default Extension="fntdata" ContentType="application/x-fontdata"/></Types>');
    return x;
  }, {'ppt/fonts/font1.fntdata': font});
  const p = await importPptx(patched);
  const f = p.embeddedFonts[0];
  assert.ok(f, 'font');
  assert.equal(f.typeface, 'Package Face');
  assert.equal(f.pitchFamily, 2);
  assert.ok(f.panose == null && f.regular == null && f.italic == null && f.boldItalic == null);
  const m = p.media.find(x => x.id === f.bold);
  assert.ok(m, 'media');
  assert.deepEqual([...Buffer.from(m.data, 'base64')], [...font]);
});

/** A silent 16-bit mono 8 kHz WAV with `n` samples (roundtrip.rs `wav`). */
function wav(n) {
  const b = new Uint8Array(44 + n * 2);
  const dv = new DataView(b.buffer);
  b.set(enc('RIFF'), 0); dv.setUint32(4, 36 + n * 2, true); b.set(enc('WAVEfmt '), 8);
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 8000, true); dv.setUint32(28, 16000, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); b.set(enc('data'), 36); dv.setUint32(40, n * 2, true);
  return b;
}

test('a transition sound is saved and read back (file half of transition.sound)', async () => {
  const p = newPresentation();
  const m = addMedia(p, 'chime.wav', 'audio/wav', wav(800));
  p.slides[0].transition = {kind: 'fade', option: '', durationMs: 700, advanceOnClick: true, advanceAfterMs: null, sound: m};
  const back = await round(p);
  const t = back.slides[0].transition;
  assert.equal(t.kind, 'fade');
  assert.ok(t.sound, 'sound survives the save');
  assert.equal(Buffer.from(back.media.find(x => x.id === t.sound).data, 'base64').length, wav(800).length);
});

test('transition sound options round trip (loop, Stop Previous Sound)', async () => {
  const p = newPresentation();
  addSlide(p, 'blank');
  addSlide(p, 'blank');
  const m = addMedia(p, 'Chime.wav', 'audio/wav', wav(400));
  const tr = extra => ({kind: 'none', option: '', durationMs: 0, advanceOnClick: true, advanceAfterMs: null, sound: null, ...extra});
  p.slides[0].transition = tr({sound: m, soundLoop: true});
  p.slides[1].transition = tr({sound: m});
  p.slides[2].transition = tr({stopSound: true});
  const bytes = await exportPptx(p);
  const slide1 = await partText(bytes, 'ppt/slides/slide1.xml');
  assert.ok(slide1.includes('<p:stSnd loop="1">') && slide1.includes('name="Chime.wav"'), slide1);
  const back = await importPptx(bytes);
  const t = back.slides.map(s => s.transition ?? {});
  assert.ok(t[0].sound && t[0].soundLoop && !t[0].stopSound);
  assert.ok(t[1].sound && !t[1].soundLoop);
  assert.ok(!t[2].sound && t[2].stopSound, JSON.stringify(t[2]));
  assert.equal(Object.keys(await entries(bytes)).filter(n => n.endsWith('.wav')).length, 1, 'the same sound is embedded once');
});

// ---- cfb.rs ----

/** A minimal valid compound file (512-byte sectors: FAT at sector 0, directory at sector 1) whose
 * directory holds a root entry plus the given stream names. */
function build(streams) {
  const b = new Uint8Array(512 * 3);
  const dv = new DataView(b.buffer);
  b.set(SIGNATURE, 0);
  dv.setUint16(24, 0x3E, true); dv.setUint16(26, 3, true); dv.setUint16(28, 0xFFFE, true); dv.setUint16(30, 9, true); dv.setUint16(32, 6, true);
  dv.setUint32(44, 1, true); dv.setUint32(48, 1, true); dv.setUint32(60, END_OF_CHAIN, true); dv.setUint32(68, END_OF_CHAIN, true);
  for (let i = 0; i < 109; i++) dv.setUint32(76 + i * 4, 0xFFFFFFFF, true);
  dv.setUint32(76, 0, true);
  for (let i = 0; i < 128; i++) dv.setUint32(512 + i * 4, 0xFFFFFFFF, true);
  dv.setUint32(512, 0xFFFFFFFD, true);
  dv.setUint32(516, END_OF_CHAIN, true);
  ['Root Entry', ...streams].slice(0, 4).forEach((name, k) => {
    const e = 1024 + k * 128;
    const units = [...name].map(c => c.charCodeAt(0)).slice(0, 31);
    units.forEach((u, i) => dv.setUint16(e + i * 2, u, true));
    dv.setUint16(e + 64, (units.length + 1) * 2, true);
    b[e + 66] = k === 0 ? 5 : 2;
  });
  return b;
}

test('cfb: reads directory names', () => {
  const b = build(['EncryptionInfo', 'EncryptedPackage']);
  assert.deepEqual(directoryNames(b), ['Root Entry', 'EncryptionInfo', 'EncryptedPackage']);
  assert.equal(isEncrypted(b), true);
  // A PowerPoint 97-2003 .ppt is a compound file too, without the encryption streams.
  assert.equal(isEncrypted(build(['PowerPoint Document', 'Current User'])), false);
  assert.equal(isEncrypted(enc('PK\x03\x04')), false);
});

test('cfb: hostile headers never throw', () => {
  const b = build(['PowerPoint Document']);
  for (const at of [30, 48, 68, 76, 512, 516, 1024 + 64]) {
    for (const v of [0, 1, 7, 0xFFFFFFFA, 0xFFFFFFFF, 0x7FFFFFFF]) {
      const c = b.slice();
      new DataView(c.buffer).setUint32(at, v, true);
      isEncrypted(c);
      for (const cut of [0, 8, 100, 600, 1100]) isEncrypted(c.subarray(0, Math.min(cut, c.length)));
    }
  }
  // A directory chain that loops back on itself stops at the bound.
  new DataView(b.buffer).setUint32(516, 1, true);
  assert.equal(isEncrypted(b), false);
});

test('cfb: a password-protected presentation is named as such', async () => {
  const locked = build(['EncryptionInfo', 'EncryptedPackage']);
  await assert.rejects(read(locked, {title: 'Locked'}), e => e.message.includes('Locked.pptx is password-protected'));
  const ppt = build(['PowerPoint Document', 'Current User']);
  await assert.rejects(read(ppt, {title: 'Old', name: 'Old.ppt'}), e => !e.message.includes('password'));
});

test('opening a file keeps its own document properties (the title is not taken from the file name)', async () => {
  const p = newPresentation();
  p.props = {...p.props, title: ''};
  const q = await read(await exportPptx(p), {title: 'Quarterly'});
  assert.equal(q.props.title ?? '', '');
});

// ---- fills.rs ----

const editSlides = (bytes, edit) => repack(bytes, (n, x) => (n.startsWith('ppt/slides/slide') && n.endsWith('.xml') ? edit(x) : x));
const picFill = (media, extra = {}) => ({kind: 'picture', media, crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null,
  adjust: {brightness: 0, contrast: 0, saturation: null, grayscale: false, duotone: null, clearColor: null, sharpen: 0}, ...extra});
/** A deck with one shape filled with a stretched picture, exported. */
async function texturedDeck() {
  const p = newPresentation();
  const media = addMedia(p, 'tile.png', 'image/png', png([10, 200, 30]));
  p.slides[0].shapes.push(newShape({id: take(p), name: 'Textured', xfrm: {x: 10, y: 10, w: 200, h: 100}, fill: picFill(media)}));
  return exportPptx(p);
}
const named = async (bytes, name) => (await importPptx(bytes)).slides[0].shapes.find(s => s.name === name);
/** `s` without the first `open`…`close` span inside a blipFill. */
function stripInBlipFill(s, open, close) {
  const b = s.indexOf('<a:blipFill');
  if (b < 0) return s;
  const i = s.indexOf(open, b);
  if (i < 0) return s;
  const j = s.indexOf(close, i);
  return j < 0 ? s : s.slice(0, i) + s.slice(j + close.length);
}

test('a shape picture fill without stretch or tile tiles', async () => {
  // tdf#128596: <a:blipFill><a:blip/></a:blipFill> on a shape; PowerPoint tiles the picture at its own size.
  const bare = await editSlides(await texturedDeck(), s => {
    const out = stripInBlipFill(s, '<a:stretch>', '</a:stretch>');
    assert.ok(!out.includes('<a:stretch'), 'the test deck lost its stretch');
    return out;
  });
  const mode = (await named(bare, 'Textured')).fill.mode;
  assert.ok(mode.kind === 'tile' && mode.sx === 1 && mode.sy === 1, JSON.stringify(mode));
  // An explicit stretch is still a stretch.
  assert.equal((await named(await texturedDeck(), 'Textured')).fill.mode.kind, 'stretch');
});

test('a gradient without stops is saved without stops', async () => {
  const {accentStyle} = await import('../../../core/prism/model/style.mjs');
  const p = newPresentation();
  const own = {stops: [], shape: {kind: 'linear', angle: 45, scaled: true}, rotateWithShape: true};
  p.slides[0].shapes.push(newShape({id: take(p), name: 'Styled', xfrm: {x: 10, y: 10, w: 200, h: 100}, fill: {kind: 'gradient', ...own}, style: accentStyle('accent1')}));
  const s = (await round(p)).slides[0].shapes.find(x => x.name === 'Styled');
  assert.deepEqual(s.fill, {kind: 'gradient', ...own});
});

test('a fill overlay round trips', async () => {
  const p = newPresentation();
  const overlay = {blend: 'mult', fill: {kind: 'gradient', stops: [{pos: 0, color: {base: {kind: 'scheme', slot: 'accent1'}}}, {pos: 1, color: {base: {kind: 'rgb', rgb: {r: 10, g: 20, b: 30, a: 255}}}}],
    shape: {kind: 'linear', angle: 4.5, scaled: true}, rotateWithShape: true}};
  p.slides[0].shapes.push(newShape({id: take(p), name: 'Overlaid', xfrm: {x: 10, y: 10, w: 200, h: 100},
    fill: {kind: 'solid', color: {base: {kind: 'rgb', rgb: {r: 255, g: 255, b: 255, a: 255}}}}, effects: {fillOverlay: overlay}}));
  const s = (await round(p)).slides[0].shapes.find(x => x.name === 'Overlaid');
  assert.deepEqual(s.effects?.fillOverlay, overlay);
});

test('a gradient tile rect is read and round trips', async () => {
  // PowerPoint's "from top-left corner" radial: focus on the corner, tile reaching a box up and to the left.
  const g = {stops: [{pos: 0, color: {base: {kind: 'rgb', rgb: {r: 0, g: 128, b: 255, a: 255}}}}, {pos: 1, color: {base: {kind: 'rgb', rgb: {r: 255, g: 255, b: 255, a: 255}}}}],
    shape: {kind: 'path', path: 'circle', focus: [0, 0, 1, 1]}, rotateWithShape: true, tile: [-1, -1, 0, 0]};
  const p = newPresentation();
  p.slides[0].shapes.push(newShape({id: take(p), name: 'Corner', xfrm: {x: 10, y: 10, w: 200, h: 100}, fill: {kind: 'gradient', ...g}}));
  const bytes = await exportPptx(p);
  assert.deepEqual((await named(bytes, 'Corner')).fill, {kind: 'gradient', ...g});
  // As written by PowerPoint (attributes it leaves out are 0).
  const edited = await editSlides(bytes, x => x.replace('<a:tileRect l="-100000" t="-100000" r="0" b="0"/>', '<a:tileRect l="-100000" t="-100000"/>'));
  assert.deepEqual((await named(edited, 'Corner')).fill.tile, [-1, -1, 0, 0]);
});

test('a table naming no style is drawn with the table grid', async () => {
  const p = newPresentation();
  p.slides[0].shapes.push(newShape({id: take(p), name: 'Grid', xfrm: {x: 10, y: 10, w: 200, h: 80}, kind: {type: 'table', ...newTable(2, 2, 200, 40), style: 'none'}}));
  const bytes = await exportPptx(p);
  // Written with its style, it reads back as written.
  assert.equal((await named(bytes, 'Grid')).kind.style, 'none');
  // Without a:tableStyleId PowerPoint draws thin dark grid lines.
  const bare = await editSlides(bytes, x => x.replace(/<a:tableStyleId>[^<]*<\/a:tableStyleId>/, ''));
  assert.equal((await named(bare, 'Grid')).kind.style, 'grid');
});

test('black and white and inverted alpha pictures round trip', async () => {
  const p = newPresentation();
  const media = addMedia(p, 'tile.png', 'image/png', png([10, 200, 30]));
  const pf = picFill(media);
  pf.adjust.bilevel = 0.3;
  pf.adjust.alphaInv = true;
  p.slides[0].shapes.push(newShape({id: take(p), name: 'BW', xfrm: {x: 10, y: 10, w: 200, h: 100}, fill: pf}));
  const s = (await round(p)).slides[0].shapes.find(x => x.name === 'BW');
  assert.deepEqual([s.fill.adjust.bilevel, s.fill.adjust.alphaInv], [0.3, true]);
});

test('an upright picture fill round trips', async () => {
  const bytes = await texturedDeck();
  const edited = await editSlides(bytes, x => x.replace('rotWithShape="1"', 'rotWithShape="0"'));
  const q = await importPptx(edited);
  assert.equal(q.slides[0].shapes.find(s => s.name === 'Textured').fill.upright, true);
  const r = await round(q);
  assert.equal(r.slides[0].shapes.find(s => s.name === 'Textured').fill.upright, true);
  // Rotating with the shape is the default.
  assert.ok(!(await named(bytes, 'Textured')).fill.upright);
});

// ---- comments.rs ----

function commentDeck() {
  const p = newPresentation();
  const c = (fields = {}) => ({author: '', initials: '', text: '', date: '', x: 0, y: 0, resolved: false, replies: [], shape: null, ...fields});
  p.slides[0].comments = [
    c({author: 'Ada', initials: 'AL', text: 'Top thread\nsecond line', date: '2025-03-04T05:06:07Z', x: 90, y: 45, resolved: true, replies: [
      c({author: 'Bob', text: 'A <reply> & more', date: '2025-03-04T06:00:00Z'}),
      c({author: 'Ada', text: 'Another reply', date: '2025-03-04T06:30:00Z', resolved: true}),
    ]}),
    c({author: 'Bob', initials: 'BC', text: 'Open thread', date: '2025-03-05T01:02:03Z', x: 120, y: 60}),
  ];
  return p;
}

test('comment threads and resolved state round trip', async () => {
  const p = commentDeck();
  const b = (await round(p)).slides[0].comments;
  assert.equal(b.length, p.slides[0].comments.length, `comments duplicated: ${JSON.stringify(b)}`);
  assert.equal(b[0].author, 'Ada');
  assert.equal(b[0].initials, 'AL');
  assert.equal(b[0].text, 'Top thread\nsecond line');
  assert.equal(b[0].date, '2025-03-04T05:06:07Z');
  assert.equal(b[0].resolved, true);
  assert.deepEqual([b[0].x, b[0].y], [90, 45]);
  assert.equal(b[0].replies.length, 2);
  assert.equal(b[0].replies[0].author, 'Bob');
  assert.equal(b[0].replies[0].text, 'A <reply> & more');
  assert.equal(b[0].replies[0].date, '2025-03-04T06:00:00Z');
  assert.equal(b[0].replies[1].text, 'Another reply');
  assert.ok(!b[0].replies[0].resolved);
  assert.ok(b[0].replies[1].resolved);
  assert.equal(b[1].author, 'Bob');
  assert.ok(!b[1].resolved);
  assert.equal(b[1].text, 'Open thread');
});

test('the package carries both comment parts and the slide anchor', async () => {
  const bytes = await exportPptx(commentDeck());
  const modern = await partText(bytes, 'ppt/comments/modernComment1.xml');
  assert.ok(modern.includes('p188:cmLst'), modern);
  // The thread and the second reply are resolved; the first reply is not.
  assert.equal(count(modern, 'status="resolved"'), 2, modern);
  assert.ok(modern.includes('p188:replyLst') && modern.includes('A &lt;reply&gt; &amp; more'), modern);
  assert.ok(modern.includes('<a:t>second line</a:t>'), modern);
  const legacy = await partText(bytes, 'ppt/comments/comment1.xml');
  assert.ok(legacy.includes('<p:cm ') && legacy.includes('Top thread'), legacy);
  const authors = await partText(bytes, 'ppt/authors.xml');
  assert.ok(authors.includes('p188:authorLst') && authors.includes('Ada'), authors);
  assert.ok((await partText(bytes, 'ppt/commentAuthors.xml')).includes('p:cmAuthorLst'));
  const rels = await partText(bytes, 'ppt/slides/_rels/slide1.xml.rels');
  assert.ok(rels.includes('2018/10/relationships/comments'), rels);
  // The slide's commentRel anchor names the relationship that points at THIS modern part.
  const slide = await partText(bytes, 'ppt/slides/slide1.xml');
  assert.ok(slide.includes('commentRel') && slide.includes('{6950BFC3-D8DA-4A85-94F7-54DA5524770B}'), slide);
  const rid = slide.slice(slide.indexOf('commentRel')).split('r:id="')[1].split('"')[0];
  const rel = rels.split('<Relationship ').find(r => r.includes(`Id="${rid}"`));
  assert.ok(rel && rel.includes('2018/10/relationships/comments') && rel.includes('../comments/modernComment1.xml'), rel);
  const ct = await partText(bytes, '[Content_Types].xml');
  assert.ok(ct.includes('application/vnd.ms-powerpoint.comments+xml') && ct.includes('application/vnd.ms-powerpoint.authors+xml'), ct);
});

test('comments on several slides round trip', async () => {
  const p = commentDeck();
  while (p.slides.length < 3) addSlide(p, 'blank');
  p.slides[2].comments = [{author: 'Cara', initials: '', text: 'Slide three', date: '2025-03-06T00:00:00Z', x: 0, y: 0, resolved: false, replies: [], shape: null}];
  const bytes = await exportPptx(p);
  assert.ok((await partText(bytes, 'ppt/comments/modernComment1.xml')).includes('Top thread'));
  // The parts are numbered by comment slide: the comment-free middle slide is skipped.
  assert.ok((await partText(bytes, 'ppt/comments/comment2.xml')).includes('Slide three'));
  assert.ok((await partText(bytes, 'ppt/comments/modernComment2.xml')).includes('Slide three'));
  const rels2 = await partText(bytes, 'ppt/slides/_rels/slide2.xml.rels');
  assert.ok(!rels2.includes('relationships/comments'), rels2);
  const q = await importPptx(bytes);
  assert.equal(q.slides[0].comments.length, 2);
  assert.equal(q.slides[1].comments.length, 0);
  assert.equal(q.slides[2].comments.length, 1);
  assert.equal(q.slides[2].comments[0].text, 'Slide three');
});

test('a legacy-only comments package imports', async () => {
  const e = await entries(await exportPptx(commentDeck()));
  for (const n of ['ppt/comments/modernComment1.xml', 'ppt/authors.xml']) delete e[n];
  e['ppt/slides/_rels/slide1.xml.rels'] = enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments/comment1.xml"/></Relationships>`);
  let xml = dec(e['ppt/slides/slide1.xml']);
  const start = xml.indexOf('<p:extLst>');
  if (start >= 0) { const end = xml.indexOf('</p:extLst>'); xml = xml.slice(0, start) + xml.slice(end < 0 ? xml.length : end + '</p:extLst>'.length); }
  e['ppt/slides/slide1.xml'] = enc(xml);
  const q = await importPptx(await zipOf(Object.entries(e)));
  const b = q.slides[0].comments;
  // The legacy part flattened the two replies into siblings: four top-level comments.
  assert.equal(b.length, 4, JSON.stringify(b));
  assert.equal(b[0].text, 'Top thread\nsecond line');
  // The legacy format has no resolved state, exactly what the modern part adds.
  assert.ok(!b[0].resolved);
  assert.deepEqual([b[0].x, b[0].y], [90, 45], 'legacy positions are 1/8 pt');
  assert.ok(b.every(c => !c.replies?.length));
});

test('a modern-only comments package imports', async () => {
  const e = await entries(await exportPptx(commentDeck()));
  delete e['ppt/comments/comment1.xml'];
  const b = (await importPptx(await zipOf(Object.entries(e)))).slides[0].comments;
  assert.equal(b.length, 2, JSON.stringify(b));
  assert.equal(b[0].replies.length, 2);
  assert.ok(b[0].resolved);
  assert.deepEqual([b[0].x, b[0].y], [90, 45], 'modern positions are EMU');
});

/** Element and attribute prefixes with no xmlns declaration in scope (quick_xml NsReader's check). */
function unboundPrefixes(xml) {
  const bad = [];
  const stack = [new Set(['xml'])];
  const tag = /<(\/?)([A-Za-z_][\w.\-]*(?::[\w.\-]+)?)((?:\s+[^\s=\/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const body = xml.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const pre = n => (n.includes(':') ? n.split(':')[0] : null);
  let m;
  while ((m = tag.exec(body))) {
    const [, close, name, attrs, empty] = m;
    if (close) { stack.pop(); continue; }
    const scope = new Set(stack[stack.length - 1]);
    const list = [...attrs.matchAll(/([^\s=]+)\s*=\s*(?:"[^"]*"|'[^']*')/g)].map(a => a[1]);
    for (const a of list) if (a.startsWith('xmlns:')) scope.add(a.slice(6));
    if (pre(name) && !scope.has(pre(name))) bad.push(`<${name}>`);
    for (const a of list) if (!a.startsWith('xmlns') && pre(a) && !scope.has(pre(a))) bad.push(`<${name} ${a}>`);
    if (!empty) stack.push(scope);
  }
  return bad;
}

test('every written XML part binds its prefixes', async () => {
  for (const deck of [commentDeck(), richDeck()]) {
    const e = await entries(await exportPptx(deck));
    let modern = 0;
    for (const [n, d] of Object.entries(e)) {
      if (!/\.(xml|rels)$/.test(n)) continue;
      modern += n.includes('modernComment') ? 1 : 0;
      assert.deepEqual(unboundPrefixes(dec(d)), [], n);
    }
    assert.ok(modern > 0, 'the deck should write a modern comments part');
  }
});

// ---- ole.rs ----

const b64 = d => Buffer.from(d, 'base64');
/** An exported new deck with `parts` added (or replaced) and `edit` applied to every XML part. */
async function withParts(parts, edit) {
  const e = await entries(await exportPptx(newPresentation()));
  for (const [n, d] of Object.entries(e)) if (/\.(xml|rels)$/.test(n)) e[n] = enc(edit(n, dec(d)));
  for (const [n, d] of parts) e[n] = d;
  return zipOf(Object.entries(e));
}
const greenPng = () => png([10, 200, 30]);
/** PowerPoint 2007 style: p:oleObj spid with no p:pic; the preview is the v:imagedata of the VML
 * shape with that id in the slide's legacy drawing part. */
function oleDeck(spidInVml) {
  const vml = `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
 <v:shape id="_x0000_s9999" style='position:absolute;left:0;top:0;width:1in;height:1in'><v:imagedata o:relid="rId7" o:title=""/></v:shape>
 <v:shape id="${spidInVml}" style='position:absolute;left:0;top:0;width:2in;height:1in'><v:imagedata o:relid="rId1" o:title=""/></v:shape>
</xml>`;
  const vmlRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/preview.png"/><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/other.png"/></Relationships>';
  const frame = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="900" name="Object 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><p:oleObj spid="_x0000_s681987" name="Slide" r:id="rIdOle" imgW="4664160" imgH="3497400" progId="PowerPoint.Slide.8"><p:embed/></p:oleObj></a:graphicData></a:graphic></p:graphicFrame>';
  return withParts([['ppt/drawings/vmlDrawing1.vml', enc(vml)], ['ppt/drawings/_rels/vmlDrawing1.vml.rels', enc(vmlRels)], ['ppt/media/preview.png', greenPng()],
    ['ppt/media/other.png', new Uint8Array([1, 2, 3])], ['ppt/embeddings/oleObject1.bin', new Uint8Array(16)]], (n, s) => {
    if (n === 'ppt/slides/slide1.xml') return s.replace('</p:spTree>', `${frame}</p:spTree>`);
    if (n === 'ppt/slides/_rels/slide1.xml.rels') return s.replace('</Relationships>', '<Relationship Id="rIdVml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/><Relationship Id="rIdOle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../embeddings/oleObject1.bin"/></Relationships>');
    return s;
  });
}
async function objectPreview(bytes) {
  const p = await importPptx(bytes);
  const s = p.slides[0].shapes.find(x => x.name === 'Object 3');
  assert.equal(s?.kind?.type, 'opaque', JSON.stringify(s?.kind));
  assert.equal(s.kind.label, 'PowerPoint.Slide.8');
  const m = s.kind.preview == null ? null : p.media.find(x => x.id === s.kind.preview);
  return m ? [...b64(m.data)] : null;
}

test('an old OLE object shows its VML preview', async () => {
  assert.deepEqual(await objectPreview(await oleDeck('_x0000_s681987')), [...greenPng()], 'the VML shape with the object\'s spid');
});

test('an OLE object without a matching VML shape has no preview', async () => {
  assert.equal(await objectPreview(await oleDeck('_x0000_s1')), null);
});

test('an OLE object\'s fallback picture gives it its fill and outline', async () => {
  const pic = spr => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="900" name="Object 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:v="urn:schemas-microsoft-com:vml" Requires="v"><p:oleObj name="Equation" r:id="rIdOle" imgW="1663700" imgH="228600" progId="Equation.3"><p:embed/></p:oleObj></mc:Choice><mc:Fallback><p:oleObj name="Equation" r:id="rIdOle" imgW="1663700" imgH="228600" progId="Equation.3"><p:embed/><p:pic><p:nvPicPr><p:cNvPr id="0" name="Object 3"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${spr}</p:spPr></p:pic></p:oleObj></mc:Fallback></mc:AlternateContent></a:graphicData></a:graphic></p:graphicFrame>`;
  const deck = frame => withParts([['ppt/media/eq.png', greenPng()], ['ppt/embeddings/oleObject1.bin', new Uint8Array(16)]], (n, s) => {
    if (n === 'ppt/slides/slide1.xml') return s.replace('</p:spTree>', `${frame}</p:spTree>`);
    if (n === 'ppt/slides/_rels/slide1.xml.rels') return s.replace('</Relationships>', '<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/eq.png"/><Relationship Id="rIdOle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../embeddings/oleObject1.bin"/></Relationships>');
    return s;
  });
  const object = async bytes => {
    const s = (await importPptx(bytes)).slides[0].shapes.find(x => x.name === 'Object 3');
    assert.ok(s.kind.type === 'opaque' && s.kind.preview != null && s.kind.label === 'Equation.3', JSON.stringify(s.kind).slice(0, 300));
    return s;
  };
  const orange = {kind: 'solid', color: {base: {kind: 'rgb', rgb: {r: 0xFF, g: 0x99, b: 0, a: 255}}}};
  const filled = await object(await deck(pic('<a:solidFill><a:srgbClr val="FF9900"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln>')));
  assert.deepEqual(filled.fill, orange);
  assert.equal(filled.line?.width, 1);
  // Saved as its preview picture (its kept XML can't be written back), it keeps the fill.
  const p = await importPptx(await deck(pic('<a:solidFill><a:srgbClr val="FF9900"/></a:solidFill>')));
  for (const s of p.slides[0].shapes) if (s.kind.type === 'opaque') s.kind.xml = '';
  const saved = (await round(p)).slides[0].shapes.find(x => x.name === 'Object 3');
  assert.equal(saved.kind.type, 'picture', JSON.stringify(saved.kind).slice(0, 300));
  assert.deepEqual(saved.fill, orange);
  // Without a fill of its own the object stays unfilled.
  assert.equal((await object(await deck(pic('')))).fill ?? null, null);
});

// ---- ole_vml.rs ----

const FRAME = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="90" name="Object 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><p:oleObj spid="_x0000_s2050" name="Slide" r:id="rIdOle" progId="Thing.1"><p:embed/></p:oleObj></a:graphicData></a:graphic></p:graphicFrame>';
const VML = '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><v:shape id="_x0000_s2049"><v:imagedata o:relid="rIdA"/></v:shape><v:shape id="_x0000_s2050" style=\'position:absolute;left:0;top:0;width:1in;height:1in\'><v:imagedata o:relid="rIdB" o:title=""/></v:shape></xml>';
const VML_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/other.png"/><Relationship Id="rIdB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/preview.png"/></Relationships>';
const SLIDE_RELS = '<Relationship Id="rIdVml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/><Relationship Id="rIdPic" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/preview.png"/>';
/** An ActiveX control as PowerPoint writes it: a VML-only choice, and a fallback with its picture. */
const CONTROLS = '<p:controls><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:v="urn:schemas-microsoft-com:vml" Requires="v"><p:control spid="1137" name="CheckBox1" r:id="rIdX" imgW="1933560" imgH="514440"/></mc:Choice><mc:Fallback><p:control name="CheckBox1" r:id="rIdX" imgW="1933560" imgH="514440"><p:pic><p:nvPicPr><p:cNvPr id="4" name="CheckBox1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdPic"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="12700" y="25400"/><a:ext cx="127000" cy="63500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:control></mc:Fallback></mc:AlternateContent><p:control name="NoPicture" r:id="rIdY"/></p:controls>';
const vmlDeck = (frames = FRAME) => withParts([['ppt/drawings/vmlDrawing1.vml', enc(VML)], ['ppt/drawings/_rels/vmlDrawing1.vml.rels', enc(VML_RELS)],
  ['ppt/media/other.png', png([10, 10, 10])], ['ppt/media/preview.png', png([200, 200, 200])]], (n, s) => {
  if (n === 'ppt/slides/slide1.xml') {
    let at = s.lastIndexOf('</p:spTree>');
    s = s.slice(0, at) + frames + s.slice(at);
    at = s.lastIndexOf('</p:cSld>');
    return s.slice(0, at) + CONTROLS + s.slice(at);
  }
  if (n === 'ppt/slides/_rels/slide1.xml.rels') return s.replace('</Relationships>', `${SLIDE_RELS}</Relationships>`);
  return s;
});
const mediaName = (p, id) => (id == null ? null : p.media.find(m => m.id === id)?.name ?? null);

test('an OLE object without a picture shows its VML preview', async () => {
  const p = await importPptx(await vmlDeck());
  const s = p.slides[0].shapes.find(x => x.name === 'Object 3');
  assert.equal(s.kind.type, 'opaque');
  assert.equal(s.kind.label, 'Thing.1');
  // The shape whose id is the object's spid, not the first one in the drawing.
  assert.equal(mediaName(p, s.kind.preview), 'preview.png');
});

test('ActiveX controls show their pictures', async () => {
  const p = await importPptx(await vmlDeck());
  const s = p.slides[0].shapes.find(x => x.name === 'CheckBox1');
  assert.ok(s, 'control picture');
  assert.equal(s.kind.type, 'picture');
  assert.equal(mediaName(p, s.kind.fill.media), 'preview.png');
  assert.deepEqual([s.xfrm.x, s.xfrm.y, s.xfrm.w, s.xfrm.h], [1, 2, 10, 5]);
  assert.ok(!p.slides[0].shapes.some(x => x.name === 'NoPicture'), 'a control without a picture draws nothing');
});

test('many objects sharing one VML drawing each get their preview', async () => {
  const spids = ['_x0000_s2050', '_x0000_s9999', '_x0000_s2049', 'missing'];
  let frames = '';
  for (let i = 0; i < 200; i++) frames += FRAME.replace('id="90" name="Object 3"', `id="${1000 + i}" name="Obj ${i}"`).replace('_x0000_s2050', spids[i % 4]);
  const p = await importPptx(await vmlDeck(frames));
  for (let i = 0; i < 200; i++) {
    const s = p.slides[0].shapes.find(x => x.name === `Obj ${i}`);
    assert.equal(s.kind.type, 'opaque');
    assert.equal(mediaName(p, s.kind.preview), [ 'preview.png', null, 'other.png', null ][i % 4], `frame ${i}`);
  }
});

// ---- opc.rs / png.rs unit tests not in pptx_units.test.mjs ----

test('discarded parts count against the inflate budget', async () => {
  const {internals} = await import('../../../core/prism/formats/pptx-read.mjs');
  const z = await zipOf([['a', new Uint8Array(80)], ['b', new Uint8Array(80)], ['c', new Uint8Array(80)], ['d', new Uint8Array(80)], ['e', new Uint8Array(5)]]);
  // Kept bytes cap at 100: b, c and d are inflated past what's left and discarded. That work is
  // charged, so after d the budget (130) is spent and e is not read, although it would have fit.
  let p = await internals.Package.open(z, {maxPart: 1000, maxTotal: 100, maxWork: 130});
  assert.ok(p.get('a'));
  assert.ok(!p.get('b') && !p.get('d'));
  assert.equal(p.get('e'), null, 'the inflate budget stops reading');
  // With room to spare the same small part is kept.
  p = await internals.Package.open(z, {maxPart: 1000, maxTotal: 100, maxWork: 10_000});
  assert.ok(p.get('e'));
});

test('xmlBytes applies the XML limit', async () => {
  const {internals} = await import('../../../core/prism/formats/pptx-read.mjs');
  const p = await internals.Package.open(await zipOf([['small.xml', new Uint8Array(10)]]));
  assert.equal(p.xmlBytes('small.xml')?.length, 10);
  assert.equal(p.xmlBytes('missing.xml'), null);
});

test('png: crc known', async () => {
  const {crc32, transparent1x1} = await import('../../../core/prism/formats/pptx-write.mjs');
  assert.equal(crc32(enc('IEND')), 0xAE426082);
  assert.deepEqual([...transparent1x1().slice(0, 4)], [0x89, 0x50, 0x4E, 0x47]);
});
