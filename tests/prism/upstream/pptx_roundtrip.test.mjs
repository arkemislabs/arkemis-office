// Ported from deckcraft crates/pptx/tests/it/roundtrip.rs, notes.rs, transition_xml.rs, comments.rs,
// malformed.rs, sniff.rs and crates/pptx/src/lib.rs `import_theme_tests` (f893f6af7d36a5409fd804e81a34fd895cfefedf).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. What does ArtCraft do? deckcraft `pptx::export` writes the whole model as an OOXML package
//    (write.rs:export) and `pptx::import` reads it back (read.rs:import_checked); every test here is
//    one of its round-trip/robustness tests. PowerPoint's File > Save writes the same parts (masters,
//    layouts, themes, slides, notes, comments, transitions in mc:AlternateContent, timing trees).
// 2. Does ours do the same? core/prism/formats/pptx-write.mjs and pptx-read.mjs translate those
//    modules over Prism schema 2; the assertions are upstream's, run on our model. Charts are kept as
//    opaque objects (no chart model yet), so charts_round_trip is replaced by an opaque keep test.
// 3. Which test proves it? This file (engine), tests/prism/formats-pptx.test.mjs (format worker
//    File > Save / Open contract) and tests/e2e/prism/formats-pptx.e2e.mjs (bridge save → disk → reopen).

import test from 'node:test';
import assert from 'node:assert/strict';
import {richDeck, round, byName, take, para, addSlide, box, repack, partText, entries, addMedia, png} from '../formats-pptx-fixtures.mjs';
import {exportPptx, exportAs, exportPptxChecked, CT_TEMPLATE, CT_SHOW} from '../../../core/prism/formats/pptx-write.mjs';
import {importPptx, importChecked, importTheme, sniff, TRANSITIONS, ANIMATIONS, animationInfo, base64Decode} from '../../../core/prism/formats/pptx-read.mjs';
import {newPresentation} from '../../../core/prism/model/defaults.mjs';
import {validateContent} from '../../../core/prism/schema.mjs';
import {validatePresentation, layoutById, notesText} from '../../../core/prism/model/presentation.mjs';
import {schemeSet} from '../../../core/prism/model/color.mjs';
import JSZip from 'jszip';

const defAnim = (shape, fields = {}) => ({shape, class: 'entrance', effect: 'fade', option: '', start: 'onClick', durationMs: 500, delayMs: 0, repeat: 1, rewind: false,
  textBuild: 'asOne', paragraph: null, path: null, trigger: null, amount: null, color: null, presetId: null, presetSubtype: null, after: null, sound: null,
  smoothStart: 0, smoothEnd: 0, bounceEnd: 0, autoReverse: false, ...fields});

test('rich deck exports a package', async () => {
  const bytes = await exportPptx(richDeck());
  assert.ok(bytes.length > 1000);
  assert.equal(await sniff(bytes), true);
});

test('deck level round trip', async () => {
  const p = richDeck();
  const q = await round(p);
  assert.equal(q.slides.length, p.slides.length);
  assert.deepEqual(validatePresentation(q), []);
  validateContent(q);
  assert.deepEqual(q.slideSize, p.slideSize);
  assert.equal(q.firstSlideNumber, 0);
  assert.equal(q.props.title, 'Rich deck');
  assert.equal(q.props.author, 'DeckCraft tests');
  assert.equal(q.props.created, '2025-01-02T03:04:05Z');
  assert.deepEqual(q.sections.map(s => [s.name, s.slides.length]), [['Start', 2], ['Rest', 3]]);
  assert.equal(q.customShows.length, 1);
  assert.deepEqual(q.customShows[0].slides, [q.slides[0].id, q.slides[3].id]);
  assert.ok(q.slides[2].hidden);
  assert.equal(q.masters.length, 1);
  const [pm, qm] = [p.masters[0], q.masters[0]];
  assert.deepEqual(qm.theme.colors.colors, pm.theme.colors.colors);
  assert.equal(qm.theme.fonts.major.latin, pm.theme.fonts.major.latin);
  assert.equal(qm.layouts.length, pm.layouts.length);
  pm.layouts.forEach((a, i) => assert.deepEqual([a.name, a.kind, a.shapes.length], [qm.layouts[i].name, qm.layouts[i].kind, qm.layouts[i].shapes.length]));
  assert.deepEqual(qm.titleStyle, pm.titleStyle);
  assert.deepEqual(qm.bodyStyle, pm.bodyStyle);
  assert.deepEqual(q.defaultTextStyle, p.defaultTextStyle);
  p.slides.forEach((a, i) => assert.equal(layoutById(p, a.layout)?.[1].name, layoutById(q, q.slides[i].layout)?.[1].name));
  assert.deepEqual(q.guides, p.guides);
});

test('text and formatting round trip', async () => {
  const p = richDeck();
  const q = await round(p);
  assert.equal(notesText(q.slides[0]), 'Speaker notes line 1\nline 2');
  assert.deepEqual(q.slides[0].shapes[0].text, p.slides[0].shapes[0].text);
  assert.equal(q.slides[0].shapes[0].xfrm, null, 'placeholder without xfrm inherits');
  const [sa, sb] = [byName(p.slides[1], 'Pattern Box'), byName(q.slides[1], 'Pattern Box')];
  assert.deepEqual(sb.text, sa.text);
  assert.deepEqual(sb.click, sa.click);
  assert.ok(byName(q.slides[1], 'Text Box').textBox);
  assert.equal(byName(q.slides[1], 'Text Box').descr, 'alt text');
  assert.deepEqual(byName(q.slides[4], 'Go to shapes').click.action, {kind: 'slide', slide: q.slides[1].id});
});

test('shapes, fills, lines and effects round trip', async () => {
  const p = richDeck();
  const q = await round(p);
  for (const name of ['Gradient Star', 'Pattern Box', 'Freeform', 'Uses background']) {
    const [a, b] = [byName(p.slides[1], name), byName(q.slides[1], name)];
    for (const k of ['geom', 'fill', 'line', 'effects', 'xfrm']) assert.deepEqual(b[k], a[k], `${name}.${k}`);
  }
  const g = byName(q.slides[1], 'Group');
  assert.equal(g.kind.type, 'group');
  assert.equal(g.kind.children.length, 2);
  assert.equal(g.kind.child.w, 110);
  const c = byName(q.slides[1], 'Connector');
  assert.deepEqual(c.kind.start, [byName(q.slides[1], 'Child 1').id, 2]);
  assert.deepEqual(c.kind.end, [byName(q.slides[1], 'Child 2').id, 0]);
  assert.deepEqual(c.line, byName(p.slides[1], 'Connector').line);
  assert.equal(byName(q.slides[1], 'Group').id, byName(p.slides[1], 'Group').id, 'ids are kept');
});

test('pictures, media and ink round trip', async () => {
  const p = richDeck();
  const q = await round(p);
  const [a, b] = [byName(p.slides[2], 'Picture'), byName(q.slides[2], 'Picture')];
  assert.equal(b.kind.type, 'picture');
  assert.deepEqual(b.kind.fill.crop, a.kind.fill.crop);
  assert.equal(b.kind.fill.alpha, a.kind.fill.alpha);
  assert.deepEqual(b.kind.fill.adjust, a.kind.fill.adjust);
  const media = (pres, id) => pres.media.find(m => m.id === id);
  assert.equal(media(q, b.kind.fill.media).data, media(p, a.kind.fill.media).data);
  const t = byName(q.slides[2], 'Tiled');
  assert.equal(t.fill.kind, 'picture');
  assert.equal(t.fill.mode.kind, 'tile');
  assert.equal(t.fill.mode.sx, 0.5);
  const v = byName(q.slides[2], 'Video');
  assert.equal(v.kind.type, 'media');
  assert.ok(v.kind.video);
  assert.deepEqual([v.kind.trimStartMs, v.kind.fadeInMs], [500, 250]);
  assert.deepEqual([...base64Decode(media(q, v.kind.media).data).slice(4, 8)], [0x66, 0x74, 0x79, 0x70], 'ftyp bytes');
  assert.ok(v.kind.poster);
  [0.1, 0, 0.2, 0.25].forEach((want, i) => assert.ok(Math.abs(v.kind.crop[i] - want) < 1e-4, `video crop ${v.kind.crop}`));
  assert.deepEqual(v.kind.bookmarks, [['Start', 100]]);
  const ink = byName(q.slides[2], 'Ink');
  assert.equal(ink.kind.type, 'group');
  assert.equal(ink.kind.children.length, 1);
  assert.equal(ink.kind.children[0].geom.kind, 'custom');
  assert.ok(Math.abs(ink.kind.children[0].line.width - 3) < 0.05, 'a flat 0.5 stroke keeps the pen width');
});

test('pressured ink exports at its mean width', async () => {
  const p = newPresentation();
  p.slides[0].shapes.push(box(p, 'Ink', 0, 0, 960, 540, {kind: {type: 'ink', strokes: [{points: [[10, 10, 1], [40, 10, 0.5], [80, 10, 0]], color: {r: 0, g: 0, b: 0, a: 255}, width: 10, highlighter: false}]}}));
  const q = await round(p);
  const w = byName(q.slides[0], 'Ink').kind.children[0].line.width;
  assert.ok(Math.abs(w - (10 + 5 + 0.8) / 3) < 0.05, String(w));
});

test('tables round trip', async () => {
  const p = richDeck();
  const q = await round(p);
  const norm = t => ({...t, rows: t.rows.map(r => ({...r, cells: r.cells.map(c => ({...c, text: {...c.text, paragraphs: c.text.paragraphs.filter(pp => pp.runs.length)}}))}))});
  assert.deepEqual(norm(byName(q.slides[3], 'Table 1').kind), norm(byName(p.slides[3], 'Table 1').kind));
});

test('transitions and animations round trip', async () => {
  const p = richDeck();
  const q = await round(p);
  p.slides.forEach((a, i) => {
    const b = q.slides[i];
    if (a.transition || b.transition) {
      const pick = t => [t.kind, t.option, t.durationMs, t.advanceOnClick, t.advanceAfterMs];
      assert.deepEqual(pick(b.transition), pick(a.transition));
    }
    assert.equal(b.animations.length, a.animations.length);
    a.animations.forEach((x, k) => {
      const y = b.animations[k];
      const pick = z => [z.effect, z.option, z.class, z.start, z.durationMs, z.delayMs, z.textBuild];
      assert.deepEqual(pick(y), pick(x));
      assert.equal(y.shape, x.shape);
      assert.equal(y.trigger, x.trigger);
      if (x.class === 'path') assert.equal(y.path, x.path);
    });
  });
});

test('comments round trip', async () => {
  const q = await round(richDeck());
  const c = q.slides[1].comments;
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].author, c[0].initials, c[0].text], ['Ada', 'AL', 'Nice star']);
  assert.deepEqual([c[0].x, c[0].y], [120, 64]);
});

test('every transition kind survives', async () => {
  const p = newPresentation();
  const base = p.slides[0];
  p.slides = TRANSITIONS.map(([kind]) => ({...structuredClone(base), id: take(p), shapes: [], transition: {kind, option: '', durationMs: 1200, advanceOnClick: true, advanceAfterMs: null, sound: null}}));
  const q = await round(p);
  p.slides.forEach((a, i) => {
    if (a.transition.kind === 'none') return;
    assert.equal(q.slides[i].transition?.kind, a.transition.kind);
    assert.equal(q.slides[i].transition?.durationMs, 1200, a.transition.kind);
  });
});

test('every animation effect survives', async () => {
  const p = newPresentation();
  const sh = box(p, 'Target', 100, 100, 100, 100, {text: {body: {}, paragraphs: [para('hi')]}});
  p.slides[0].shapes.push(sh);
  p.slides[0].animations = ANIMATIONS.map(([effect, , cls, , dur, opts]) => defAnim(sh.id, {class: cls, effect, option: opts[0] ?? '', durationMs: Math.max(dur, 1)}));
  const q = await round(p);
  const [a, b] = [p.slides[0].animations, q.slides[0].animations];
  assert.equal(b.length, a.length);
  a.forEach((x, i) => {
    const y = b[i];
    const same = animationInfo(x.effect, x.class)?.[3] === animationInfo(y.effect, y.class)?.[3];
    assert.ok(x.effect === y.effect || same, `${x.effect} vs ${y.effect}`);
    assert.equal(y.class, x.class);
  });
});

test('animation rewind survives', async () => {
  const p = newPresentation();
  const sh = box(p, 'Target', 100, 100, 100, 100);
  p.slides[0].shapes.push(sh);
  p.slides[0].animations = [defAnim(sh.id, {rewind: true}), defAnim(sh.id, {effect: 'fly', option: 'l', start: 'withPrevious'})];
  const b = (await round(p)).slides[0].animations;
  assert.equal(b.length, 2);
  assert.ok(b[0].rewind);
  assert.ok(!b[1].rewind);
});

test('rtl paragraphs, script fonts and justLow round trip', async () => {
  const p = newPresentation();
  p.slides[0].shapes.push(box(p, 'RTL', 60, 60, 300, 100, {text: {body: {}, paragraphs: [{level: 0, props: {rtl: true, align: 'justLow'}, runs: [{text: 'שלום', props: {fontCs: 'Arial', lang: 'he-IL'}}]}]}}));
  p.masters[0].theme.fonts.minor.scripts = [{script: 'Hebr', typeface: 'David'}];
  const q = await round(p);
  assert.deepEqual(byName(q.slides[0], 'RTL').text.paragraphs, byName(p.slides[0], 'RTL').text.paragraphs);
  assert.deepEqual(q.masters[0].theme.fonts.minor.scripts, [{script: 'Hebr', typeface: 'David'}]);
});

test('date fields keep their type and saved text', async () => {
  const p = newPresentation();
  p.slides[0].shapes.push(box(p, 'Date', 60, 60, 200, 40, {text: {body: {}, paragraphs: [{level: 0, runs: [{text: '1/2/2025', kind: {kind: 'field', field: 'datetime1'}}]}]}}));
  const r = byName((await round(p)).slides[0], 'Date').text.paragraphs[0].runs[0];
  assert.deepEqual(r.kind, {kind: 'field', field: 'datetime1'});
  assert.equal(r.text, '1/2/2025');
});

test('colour map overrides round trip', async () => {
  const p = newPresentation();
  p.slides[0].colorMap = [['bg1', 'dk1'], ['tx1', 'lt1'], ['bg2', 'dk2'], ['tx2', 'lt2'], ['accent1', 'accent1'], ['accent2', 'accent2'], ['accent3', 'accent3'],
    ['accent4', 'accent4'], ['accent5', 'accent5'], ['accent6', 'accent6'], ['hlink', 'hlink'], ['folHlink', 'folHlink']];
  const q = await round(p);
  assert.deepEqual(q.slides[0].colorMap, p.slides[0].colorMap);
  assert.equal(q.masters[0].layouts[0].colorMap, undefined);
});

test('a picture duotone round trips', async () => {
  const p = newPresentation();
  const m = addMedia(p, 'a.png', 'image/png', png());
  const duo = [{base: {kind: 'scheme', slot: 'accent1'}, mods: [{op: 'shade', val: 50000}]}, {base: {kind: 'rgb', rgb: {r: 255, g: 255, b: 255, a: 255}}}];
  p.slides[0].shapes.push(box(p, 'Pic', 0, 0, 100, 100, {kind: {type: 'picture', fill: {media: m, crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null,
    adjust: {brightness: 0, contrast: 0, saturation: null, grayscale: false, duotone: duo, clearColor: null, sharpen: 0}}}}));
  assert.deepEqual(byName((await round(p)).slides[0], 'Pic').kind.fill.adjust.duotone, duo);
});

test('line break options round trip', async () => {
  const p = newPresentation();
  p.slides[0].shapes.push(box(p, 'T', 0, 0, 100, 100, {text: {body: {}, paragraphs: [{level: 0, props: {eastAsianLineBreak: false, latinLineBreak: true, hangingPunct: false}, runs: [{text: 'x'}]}]}}));
  assert.deepEqual(byName((await round(p)).slides[0], 'T').text.paragraphs[0].props, {eastAsianLineBreak: false, latinLineBreak: true, hangingPunct: false});
});

test('a table fill round trips', async () => {
  const p = richDeck();
  byName(p.slides[3], 'Table 1').kind.background = {kind: 'solid', color: {base: {kind: 'scheme', slot: 'accent4'}}};
  assert.deepEqual(byName((await round(p)).slides[3], 'Table 1').kind.background, {kind: 'solid', color: {base: {kind: 'scheme', slot: 'accent4'}}});
});

test('wordart warps and their adjusts round trip', async () => {
  const p = newPresentation();
  p.slides[0].shapes.push(box(p, 'Arch', 0, 0, 300, 100, {text: {body: {warp: 'textArchUp', warpAdj: [10000000]}, paragraphs: [para('Arch')]}}));
  p.slides[0].shapes.push(box(p, 'Wave', 0, 200, 300, 100, {text: {body: {warp: 'textWave1', warpAdj: [12500, 5000]}, paragraphs: [para('Wave')]}}));
  const q = await round(p);
  assert.deepEqual([byName(q.slides[0], 'Arch').text.body.warp, byName(q.slides[0], 'Arch').text.body.warpAdj], ['textArchUp', [10000000]]);
  assert.deepEqual(byName(q.slides[0], 'Wave').text.body.warpAdj, [12500, 5000]);
  const xml = await partText(await exportPptx(p), 'ppt/slides/slide1.xml');
  assert.ok(xml.includes('<a:gd name="adj" fmla="val 10000000"/>'), 'a single adjust is named adj');
  assert.ok(xml.includes('<a:gd name="adj1" fmla="val 12500"/>') && xml.includes('<a:gd name="adj2" fmla="val 5000"/>'));
});

test('transition XML matches PowerPoint elements', async () => {
  const p = newPresentation();
  const cases = [['fade', 'smoothly', '<p:fade/>'], ['push', 'u', '<p:push dir="u"/>'], ['morph', 'words', '<p159:morph option="byWord"/>'],
    ['zoom', 'in', '<p14:warp dir="in"/>'], ['clock', 'counterClockwise', '<p14:wheelReverse spokes="1"/>'], ['fallOver', 'l', '<p15:prstTrans prst="fallOver"/>'],
    ['wind', 'l', '<p15:prstTrans prst="wind" invX="1"/>'], ['cube', 'r', '<p14:prism dir="r"/>']];
  p.slides = cases.map(([kind, option]) => ({...structuredClone(p.slides[0]), id: take(p), shapes: [], transition: {kind, option, durationMs: 1000, advanceOnClick: true, advanceAfterMs: null, sound: null}}));
  const bytes = await exportPptx(p);
  for (let i = 0; i < cases.length; i++) {
    const xml = await partText(bytes, `ppt/slides/slide${i + 1}.xml`);
    assert.ok(xml.includes(cases[i][2]), `${cases[i][0]}: ${xml.slice(xml.indexOf('<mc:AlternateContent'), xml.indexOf('</mc:AlternateContent>'))}`);
  }
  const q = await importPptx(bytes);
  cases.forEach(([kind, option], i) => assert.deepEqual([q.slides[i].transition.kind, q.slides[i].transition.option], [kind, option]));
});

async function importWithTransition(xml) {
  const p = newPresentation();
  p.slides[0].transition = {kind: 'fade', option: '', durationMs: 3000, advanceOnClick: true, advanceAfterMs: null, sound: null};
  const bytes = await repack(await exportPptx(p), (n, s) => {
    if (n !== 'ppt/slides/slide1.xml') return s;
    const t = s.indexOf('<p:transition');
    const a = s.lastIndexOf('<mc:AlternateContent', t);
    const end = '</mc:AlternateContent>';
    const b = t + s.slice(t).indexOf(end) + end.length;
    return s.slice(0, a) + xml + s.slice(b);
  });
  return (await importPptx(bytes)).slides[0].transition;
}
const mc = (ns, req, choice, fallback) => `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:${req}="${ns}" Requires="${req}">${choice}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent>`;
const P159 = 'http://schemas.microsoft.com/office/powerpoint/2015/09/main', P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';

test('transition_xml: PowerPoint half-second morph without spd', async () => {
  const t = await importWithTransition(mc(P159, 'p159', '<p:transition><p159:morph option="byObject"/></p:transition>', '<p:transition><p:fade/></p:transition>'));
  assert.deepEqual([t.kind, t.durationMs], ['morph', 500]);
});
test('transition_xml: missing spd is fast for a plain transition', async () => {
  const t = await importWithTransition('<p:transition><p:fade/></p:transition>');
  assert.deepEqual([t.kind, t.durationMs], ['fade', 500]);
});
test('transition_xml: spd and dur still apply', async () => {
  assert.equal((await importWithTransition('<p:transition spd="med"><p:fade/></p:transition>')).durationMs, 750);
  const t = await importWithTransition(mc(P159, 'p159', `<p:transition xmlns:p14="${P14}" spd="slow" p14:dur="1250"><p159:morph option="byObject"/></p:transition>`, '<p:transition spd="slow"><p:fade/></p:transition>'));
  assert.deepEqual([t.kind, t.durationMs], ['morph', 1250]);
});

test('linked pictures are written with r:link', async () => {
  const p = newPresentation();
  const id = take(p);
  p.media.push({id, name: 'logo.png', contentType: 'image/png', data: '', link: 'https://example.com/logo.png'});
  p.slides[0].shapes.push(box(p, 'Linked', 0, 0, 100, 100, {kind: {type: 'picture', fill: {media: id, crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null, adjust: {}}}}));
  const bytes = await exportPptx(p);
  const xml = await partText(bytes, 'ppt/slides/slide1.xml');
  assert.ok(/<a:blip r:link="rId\d+"\/>/.test(xml), xml);
  const rels = await partText(bytes, 'ppt/slides/_rels/slide1.xml.rels');
  assert.ok(rels.includes('Target="https://example.com/logo.png" TargetMode="External"'));
  const q = await importPptx(bytes);
  const m = q.media.find(x => x.id === byName(q.slides[0], 'Linked').kind.fill.media);
  assert.equal(m.link, 'https://example.com/logo.png');
});

test('templates and slide shows declare their own main content type', async () => {
  const p = newPresentation();
  for (const [ext, ct] of [['potx', CT_TEMPLATE], ['ppsx', CT_SHOW]]) {
    const ctx = await partText(await exportAs(p, ext), '[Content_Types].xml');
    assert.ok(ctx.includes(`PartName="/ppt/presentation.xml" ContentType="${ct}"`), ext);
  }
});

test('single guide names follow the preset', async () => {
  const p = newPresentation();
  p.slides[0].shapes.push(box(p, 'R', 0, 0, 100, 100, {geom: {kind: 'preset', name: 'roundRect', adj: [25000]}}));
  p.slides[0].shapes.push(box(p, 'A', 0, 0, 100, 100, {geom: {kind: 'preset', name: 'rightArrow', adj: [10000]}}));
  p.slides[0].shapes.push(box(p, 'S', 0, 0, 100, 100, {geom: {kind: 'preset', name: 'star5', adj: [20000]}}));
  const xml = await partText(await exportPptx(p), 'ppt/slides/slide1.xml');
  assert.ok(xml.includes('<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 25000"/></a:avLst>'));
  assert.ok(xml.includes('name="adj1" fmla="val 10000"') && xml.includes('name="adj2" fmla="val 50000"'));
  assert.ok(xml.includes('<a:prstGeom prst="star5"><a:avLst><a:gd name="adj" fmla="val 20000"/><a:gd name="hf" fmla="val 105146"/><a:gd name="vf" fmla="val 110557"/></a:avLst></a:prstGeom>'));
});

test('float down is preset 47 both ways', async () => {
  const p = newPresentation();
  const sh = box(p, 'T', 0, 0, 100, 100);
  p.slides[0].shapes.push(sh);
  p.slides[0].animations = [defAnim(sh.id, {effect: 'float', option: 'd', durationMs: 1000}), defAnim(sh.id, {class: 'exit', effect: 'floatOut', option: 'd', durationMs: 1000})];
  const bytes = await exportPptx(p);
  const xml = await partText(bytes, 'ppt/slides/slide1.xml');
  assert.equal((xml.match(/presetID="47"/g) ?? []).length, 2);
  const b = (await importPptx(bytes)).slides[0].animations;
  assert.deepEqual(b.map(a => [a.effect, a.option]), [['float', 'd'], ['floatOut', 'd']]);
});

test('embedded fonts round trip', async () => {
  const p = newPresentation();
  const reg = addMedia(p, 'f.ttf', 'application/x-fontdata', new Uint8Array([0, 1, 0, 0, 1, 2, 3]));
  p.embeddedFonts = [{typeface: 'Inter', panose: '020B0604020202020204', pitchFamily: 34, charset: 0, regular: reg, bold: null, italic: null, boldItalic: null}];
  const bytes = await exportPptx(p);
  assert.ok((await partText(bytes, 'ppt/presentation.xml')).includes('embedTrueTypeFonts="1"'));
  const q = await importPptx(bytes);
  assert.equal(q.embeddedFonts.length, 1);
  assert.deepEqual([q.embeddedFonts[0].typeface, q.embeddedFonts[0].panose, q.embeddedFonts[0].pitchFamily], ['Inter', '020B0604020202020204', 34]);
  assert.equal(q.media.find(m => m.id === q.embeddedFonts[0].regular).data, p.media.find(m => m.id === reg).data);
});

test('text transparency round trips', async () => {
  const p = newPresentation();
  const fill = {kind: 'solid', color: {base: {kind: 'rgb', rgb: {r: 10, g: 20, b: 30, a: 255}}, mods: [{op: 'alpha', val: 40000}]}};
  p.slides[0].shapes.push(box(p, 'T', 0, 0, 100, 100, {text: {body: {}, paragraphs: [{level: 0, runs: [{text: 'x', props: {fill}}]}]}}));
  assert.deepEqual(byName((await round(p)).slides[0], 'T').text.paragraphs[0].runs[0].props.fill, fill);
});

test('literal line ends in run text read as breaks and survive save', async () => {
  const p = newPresentation();
  p.slides[0].shapes.push(box(p, 'T', 0, 0, 100, 100, {text: {body: {}, paragraphs: [{level: 0, runs: [{text: 'one\ntwo'}]}]}}));
  const runs = byName((await round(p)).slides[0], 'T').text.paragraphs[0].runs;
  assert.deepEqual(runs.map(r => [r.kind?.kind ?? 'text', r.text]), [['text', 'one'], ['break', ''], ['text', 'two']]);
});

test('colour pulse keeps its effect colour and duration', async () => {
  const p = newPresentation();
  const sh = box(p, 'T', 0, 0, 100, 100);
  p.slides[0].shapes.push(sh);
  const color = {base: {kind: 'rgb', rgb: {r: 0, g: 128, b: 0, a: 255}}};
  p.slides[0].animations = [defAnim(sh.id, {class: 'emphasis', effect: 'colorPulse', durationMs: 1500, color})];
  const a = (await round(p)).slides[0].animations[0];
  assert.deepEqual([a.effect, a.durationMs, a.color], ['colorPulse', 1500, color]);
});

test('notes master placeholders and colour map survive save', async () => {
  const p = newPresentation();
  p.slides[0].notes = {body: {}, paragraphs: [para('Notes')]};
  const q = await round(p);
  const nm = q.notesMaster;
  assert.ok(nm);
  assert.deepEqual(nm.shapes.map(s => s.ph?.kind), ['header', 'date', 'slideImage', 'body', 'footer', 'slideNum']);
  const r = await round(q);
  assert.deepEqual(r.notesMaster.shapes.map(s => [s.ph?.kind, s.xfrm]), nm.shapes.map(s => [s.ph?.kind, s.xfrm]));
  assert.equal(r.notesMaster.colorMap.length, 12);
});

// ------------------------------------------------------------------------------------------------
// notes.rs

const NOTES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="sk-SK" b="1" dirty="0"/><a:t>Metodický prehľad</a:t></a:r></a:p><a:p><a:r><a:rPr lang="sk-SK" dirty="0"/><a:t>Žiaci pracujú vo dvojiciach.</a:t></a:r></a:p><a:p><a:pPr marL="285750" lvl="1" indent="-285750"><a:buFont typeface="Wingdings" panose="05000000000000000000" pitchFamily="2" charset="2"/><a:buChar char="&#167;"/></a:pPr><a:r><a:rPr lang="sk-SK" b="1" dirty="0"/><a:t>Cieľ: </a:t></a:r><a:r><a:rPr lang="sk-SK" dirty="0"/><a:t>vysvetliť cyklus</a:t></a:r></a:p><a:p><a:pPr marL="285750" lvl="1" indent="-285750"><a:buFont typeface="Wingdings" panose="05000000000000000000" pitchFamily="2" charset="2"/><a:buChar char="&#167;"/></a:pPr><a:r><a:rPr lang="sk-SK" i="1" dirty="0"/><a:t>Reflexia</a:t></a:r></a:p><a:p><a:pPr marL="285750" lvl="1" indent="-285750"><a:buNone/></a:pPr><a:r><a:rPr lang="sk-SK" dirty="0"/><a:t>Bez odrážky</a:t></a:r></a:p><a:p><a:r><a:rPr lang="sk-SK" dirty="0"/><a:t>Pomôcky: počítač</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';
async function notesDeck() {
  const p = newPresentation();
  p.slides[0].notes = {body: {}, paragraphs: [para('placeholder')]};
  return repack(await exportPptx(p), (n, s) => (n === 'ppt/notesSlides/notesSlide1.xml' ? NOTES_XML : s));
}
function assertFormatted(notes) {
  assert.equal(notes.paragraphs.map(pp => pp.runs.map(r => r.text).join('')).join('\n'), 'Metodický prehľad\nŽiaci pracujú vo dvojiciach.\nCieľ: vysvetliť cyklus\nReflexia\nBez odrážky\nPomôcky: počítač');
  const [head, plain, goal, reflect, unbulleted, closing] = notes.paragraphs;
  assert.equal(head.runs[0].props.bold, true);
  for (const pp of [head, plain, closing]) { assert.equal(pp.level, 0); assert.equal(pp.props, undefined); }
  assert.equal(plain.runs[0].props.bold, undefined);
  for (const pp of [goal, reflect]) {
    assert.equal(pp.level, 1);
    assert.equal(pp.props.marginLeft, 22.5);
    assert.equal(pp.props.indent, -22.5);
    assert.deepEqual(pp.props.bullet, {kind: 'char', char: '§'});
    assert.equal(pp.props.bulletFont, 'Wingdings');
  }
  assert.deepEqual([goal.runs[0].text, goal.runs[0].props.bold], ['Cieľ: ', true]);
  assert.deepEqual([goal.runs[1].text, goal.runs[1].props.bold], ['vysvetliť cyklus', undefined]);
  assert.equal(reflect.runs[0].props.italic, true);
  assert.deepEqual([unbulleted.level, unbulleted.props.bullet, unbulleted.props.marginLeft], [1, {kind: 'none'}, 22.5]);
}
test('notes import keeps bold, levels and indents', async () => assertFormatted((await importPptx(await notesDeck())).slides[0].notes));
test('notes formatting survives a round trip', async () => {
  const p = await importPptx(await notesDeck());
  const again = await round(p);
  assertFormatted(again.slides[0].notes);
  const xml = await partText(await exportPptx(again), 'ppt/notesSlides/notesSlide1.xml');
  assert.ok(xml.includes('b="1"'));
  assert.ok(xml.includes('lvl="1"') && xml.includes('marL="285750"') && xml.includes('indent="-285750"'));
});

// ------------------------------------------------------------------------------------------------
// comments.rs: modern comments are written beside legacy ones and preferred on read

test('modern comments are written and read with replies and resolution', async () => {
  const p = newPresentation();
  p.slides[0].comments = [{author: 'Ada', initials: 'AL', text: 'First\nline two', date: '2025-03-04T05:06:07.000', x: 10, y: 20, resolved: true,
    replies: [{author: 'Bob', initials: 'BB', text: 'Reply', date: '2025-03-05T05:06:07.000', x: 0, y: 0, resolved: false, replies: [], shape: null}], shape: null}];
  const bytes = await exportPptx(p);
  const e = await entries(bytes);
  assert.ok(e['ppt/comments/comment1.xml'] && e['ppt/comments/modernComment1.xml'] && e['ppt/authors.xml'] && e['ppt/commentAuthors.xml']);
  const c = (await importPptx(bytes)).slides[0].comments;
  assert.equal(c.length, 1, 'the modern part wins: no duplicate from the legacy part');
  assert.deepEqual([c[0].author, c[0].text, c[0].resolved, c[0].x, c[0].y], ['Ada', 'First\nline two', true, 10, 20]);
  assert.deepEqual(c[0].replies.map(r => [r.author, r.text]), [['Bob', 'Reply']]);
});

// ------------------------------------------------------------------------------------------------
// malformed.rs / sniff.rs

test('random bytes, empty input and garbage zips are errors', async () => {
  await assert.rejects(importPptx(new Uint8Array(0)));
  await assert.rejects(importPptx(new TextEncoder().encode('PK\u0003\u0004garbage')));
  assert.equal(await sniff(new Uint8Array(0)), false);
  assert.equal(await sniff(new TextEncoder().encode('not a zip')), false);
});
test('a zip without a presentation is an error', async () => {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types/>');
  z.file('hello.txt', 'x');
  await assert.rejects(importPptx(await z.generateAsync({type: 'uint8array'})), /not a PPTX/);
});
test('missing parts still import (or fail cleanly)', async () => {
  const base = await entries(await exportPptx(richDeck()));
  for (const name of Object.keys(base)) {
    if (name.endsWith('/')) continue;
    const z = new JSZip();
    for (const [n, d] of Object.entries(base)) if (n !== name) z.file(n, d);
    const bytes = await z.generateAsync({type: 'uint8array'});
    let p = null;
    try { p = await importPptx(bytes); } catch { continue; }
    assert.deepEqual(validatePresentation(p), [], `dropping ${name}`);
    validateContent(p);
  }
});
test('bad XML in each part is ignored', async () => {
  const base = await entries(await exportPptx(richDeck()));
  for (const name of Object.keys(base).filter(n => /\.(xml|rels)$/.test(n))) {
    const z = new JSZip();
    for (const [n, d] of Object.entries(base)) z.file(n, n === name ? '<<<not xml' : d);
    let p = null;
    try { p = await importPptx(await z.generateAsync({type: 'uint8array'})); } catch { continue; }
    validateContent(p);
  }
});
test('huge numbers and nonsense attributes stay finite', async () => {
  const bytes = await repack(await exportPptx(richDeck()), (n, s) => (n.startsWith('ppt/slides/slide') ? s.replace(/(x|y|cx|cy|w|h|rot|sz)="-?\d+"/g, '$1="99999999999999999999999"') : s));
  const p = await importPptx(bytes);
  const nums = [];
  const rec = v => { if (typeof v === 'number') nums.push(v); else if (v && typeof v === 'object') for (const x of Object.values(v)) rec(x); };
  rec(p.slides);
  assert.ok(nums.every(Number.isFinite));
});
test('deep nesting is bounded', async () => {
  const base = await exportPptx(newPresentation());
  const deep = `<?xml version="1.0"?><p:sld xmlns:p="x" xmlns:a="y"><p:cSld><p:spTree>${'<p:grpSp>'.repeat(200)}${'</p:grpSp>'.repeat(200)}</p:spTree></p:cSld></p:sld>`;
  const p = await importPptx(await repack(base, (n, s) => (n === 'ppt/slides/slide1.xml' ? deep : s)));
  await exportPptx(p); // re-export
  // Beyond the XML depth limit the part is rejected, the deck still loads.
  const deeper = `<p:sld>${'<a>'.repeat(5000)}</p:sld>`;
  const q = await importChecked(await repack(base, (n, s) => (n === 'ppt/slides/slide1.xml' ? deeper : s)));
  assert.deepEqual(q.lost, ['ppt/slides/slide1.xml']);
});
test('relationship cycles and bad targets', async () => {
  const bytes = await repack(await exportPptx(newPresentation()), (n, s) => (n === 'ppt/slides/_rels/slide1.xml.rels'
    ? '<Relationships xmlns="x"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../../../../../etc/passwd"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slide1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="slide1.xml"/></Relationships>'
    : s));
  const p = await importPptx(bytes);
  assert.equal(p.slides.length, 1);
  assert.deepEqual(validatePresentation(p), []);
});
test('an unreadable slide is reported and left out', async () => {
  const p = newPresentation();
  addSlide(p, 'blank');
  const good = await exportPptx(p);
  const {pres, lost} = await importChecked(good);
  assert.deepEqual([pres.slides.length, lost.length], [2, 0]);
  const z = new JSZip();
  for (const [n, d] of Object.entries(await entries(good))) if (n !== 'ppt/slides/slide2.xml') z.file(n, d);
  const broken = await importChecked(await z.generateAsync({type: 'uint8array'}));
  assert.equal(broken.pres.slides.length, 1);
  assert.deepEqual(broken.lost, ['ppt/slides/slide2.xml']);
});
test('export of odd models is valid', async () => {
  const p = newPresentation();
  addSlide(p, 'blank');
  p.slides[1].layout = 'no-such-layout';
  p.slides[0].shapes.push(box(p, 'NaN', NaN, Infinity, -5, 10));
  const q = await round(p);
  assert.equal(q.slides.length, 2);
  validateContent(q);
});

// ------------------------------------------------------------------------------------------------
// lib.rs import_theme_tests

test('reads the theme of a pptx and of a thmx', async () => {
  const p = newPresentation();
  const t = p.masters[0].theme;
  t.name = 'Harbour';
  t.fonts.major.latin = 'Lato';
  t.fonts.minor.latin = 'Source Sans 3';
  t.colors = schemeSet(t.colors, 'accent1', {r: 0x12, g: 0x34, b: 0x56, a: 255});
  const pptx = await exportPptx(p);
  const theme = await partText(pptx, 'ppt/theme/theme1.xml');
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/theme/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="theme/theme/theme1.xml"/></Relationships>');
  z.file('theme/theme/theme1.xml', theme);
  const thmx = await z.generateAsync({type: 'uint8array'});
  for (const bytes of [pptx, thmx]) {
    const {theme: th} = await importTheme(bytes);
    assert.equal(th.name, 'Harbour');
    assert.equal(th.fonts.major.latin, 'Lato');
    assert.equal(th.fonts.minor.latin, 'Source Sans 3');
    assert.deepEqual(th.colors.colors[4], {r: 0x12, g: 0x34, b: 0x56, a: 255});
  }
});
test('non-theme packages are errors', async () => {
  await assert.rejects(importTheme(new TextEncoder().encode('not a zip')));
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types/>');
  await assert.rejects(importTheme(await z.generateAsync({type: 'uint8array'})));
});

test('an opaque object (chart / OLE) is written back with every part it uses', async () => {
  // Stand-in for charts_round_trip: Prism keeps charts as opaque objects with their parts.
  const p = newPresentation();
  const chartXml = '<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart/><c:externalData r:id="rId1"/></c:chartSpace>';
  const chart = addMedia(p, 'chart7.xml', 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml', new TextEncoder().encode(chartXml));
  const book = addMedia(p, 'Book1.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', new Uint8Array([0x50, 0x4B, 3, 4, 9, 9]));
  const frame = '<p:graphicFrame xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:nvGraphicFramePr><p:cNvPr id="4" name="Chart 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>';
  p.slides[0].shapes.push(box(p, 'Chart 3', 0, 0, 100, 100, {kind: {type: 'opaque', xml: frame, preview: null, label: 'Chart',
    parts: [['rId9', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart', chart, [['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package', book]]]]}}));
  const bytes = await exportPptx(p);
  const e = await entries(bytes);
  const chartName = Object.keys(e).find(n => /^ppt\/charts\/chart7\.xml$/.test(n));
  assert.ok(chartName, Object.keys(e).join(','));
  assert.ok(e['ppt/charts/_rels/chart7.xml.rels'], 'the chart keeps its own relationships');
  const rels = new TextDecoder().decode(e['ppt/charts/_rels/chart7.xml.rels']);
  assert.ok(rels.includes('Id="rId1"') && rels.includes('../embeddings/Book1.xlsx'), rels);
  const q = await importPptx(bytes);
  const o = byName(q.slides[0], 'Chart 3');
  assert.equal(o.kind.type, 'opaque');
  assert.equal(o.kind.label, 'Chart');
  assert.equal(o.kind.parts.length, 1);
  assert.equal(o.kind.parts[0][3].length, 1, 'the embedded workbook is kept');
});
