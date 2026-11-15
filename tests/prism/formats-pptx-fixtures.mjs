// Fixture decks for the PPTX reader/writer tests: a "rich deck" built through the schema-2 model the
// way deckcraft crates/pptx/tests/it/roundtrip.rs `rich_deck()` builds its own (f893f6af), plus small
// package helpers (unzip a part, patch a part, rezip) used to feed the reader hand-written XML.

import JSZip from 'jszip';
import {newPresentation, newSlide, layoutOfKind} from '../../core/prism/model/defaults.mjs';
import {shape, allocId} from '../../core/prism/model/presentation.mjs';
import {exportPptx} from '../../core/prism/formats/pptx-write.mjs';
import {importPptx, base64Encode} from '../../core/prism/formats/pptx-read.mjs';

export const take = p => { const a = allocId(p); p.nextId = a[1]; return a[0]; };
export const solid = hex => ({kind: 'solid', color: {base: {kind: 'rgb', rgb: {r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 255}}}});
export const scheme = slot => ({base: {kind: 'scheme', slot}});
export const para = (text, extra = {}) => ({level: 0, runs: text ? [{text}] : [], ...extra});

/** A tiny valid PNG (1×1, the given colour). */
export function png(rgb = [255, 0, 0]) {
  // Built once by hand: 1x1 RGB PNG with a stored (uncompressed) zlib block.
  const crc = data => { let c = 0xFFFFFFFF; for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; } return (c ^ 0xFFFFFFFF) >>> 0; };
  const be = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const chunk = (t, d) => { const k = [...t].map(c => c.charCodeAt(0)); return [...be(d.length), ...k, ...d, ...be(crc([...k, ...d]))]; };
  const raw = [0, ...rgb];
  let a = 1, b = 0; for (const x of raw) { a = (a + x) % 65521; b = (b + a) % 65521; }
  const z = [0x78, 0x01, 0x01, raw.length, 0, (~raw.length) & 255, 0xFF, ...raw, ...be(((b << 16) | a) >>> 0)];
  return new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...chunk('IHDR', [...be(1), ...be(1), 8, 2, 0, 0, 0]), ...chunk('IDAT', z), ...chunk('IEND', [])]);
}

export function addMedia(p, name, contentType, bytes) {
  const id = take(p);
  p.media.push({id, name, contentType, data: base64Encode(bytes), link: null});
  return id;
}
export function addSlide(p, kind = 'blank') {
  const made = newSlide(p, layoutOfKind(p, kind));
  Object.assign(p, {nextId: made.nextId});
  p.slides.push(made.slide);
  return made.slide;
}
export const box = (p, name, x, y, w, h, extra = {}) => shape({id: take(p), name, xfrm: {x, y, w, h}, ...extra});

/** deckcraft roundtrip.rs `rich_deck`, as far as Prism's model holds it. */
export function richDeck() {
  const p = newPresentation();
  p.props = {...p.props, title: 'Rich deck', author: 'DeckCraft tests', created: '2025-01-02T03:04:05Z'};
  p.firstSlideNumber = 0;
  const s0 = p.slides[0];
  s0.shapes[0].text = {body: {}, paragraphs: [para('Hello deck', {runs: [{text: 'Hello ', props: {bold: true}}, {text: 'deck', props: {italic: true, size: 40}}]})]};
  s0.notes = {body: {}, paragraphs: [para('Speaker notes line 1'), para('line 2')]};
  // Slide 1: shapes, fills, lines, effects, groups, connectors, a comment.
  const s1 = addSlide(p, 'blank');
  const star = box(p, 'Gradient Star', 60, 60, 120, 120, {geom: {kind: 'preset', name: 'star5', adj: [19098]},
    fill: {kind: 'gradient', stops: [{pos: 0, color: scheme('accent1')}, {pos: 1, color: {base: {kind: 'scheme', slot: 'accent2'}, mods: [{op: 'lumMod', val: 75000}]}}], shape: {kind: 'linear', angle: 45, scaled: false}, rotateWithShape: true},
    line: {fill: solid('112233'), width: 2, dash: {kind: 'preset', name: 'dash'}, cap: 'round', join: 'round', head: {kind: 'triangle', w: 'med', len: 'lg'}},
    effects: {outerShadow: {color: {base: {kind: 'rgb', rgb: {r: 0, g: 0, b: 0, a: 255}}, mods: [{op: 'alpha', val: 40000}]}, blur: 6, dist: 3, dir: 45, inner: false, sx: 1, sy: 1, kx: 0, ky: 0, align: 'b', rotateWithShape: false}}});
  const pat = box(p, 'Pattern Box', 220, 60, 160, 80, {fill: {kind: 'pattern', preset: 'dkDnDiag', fg: scheme('accent3'), bg: {base: {kind: 'rgb', rgb: {r: 255, g: 255, b: 255, a: 255}}}},
    text: {body: {anchor: 'top', insetL: 10}, paragraphs: [para('Link me', {runs: [{text: 'Link me', props: {link: {action: {kind: 'url', url: 'https://example.com/'}, tooltip: 'Example', highlightClick: false}}}]})]},
    click: {action: {kind: 'nextSlide'}, tooltip: '', highlightClick: false}});
  const free = box(p, 'Freeform', 420, 60, 100, 100, {geom: {kind: 'custom', paths: [{w: 21600, h: 21600, d: 'M 0 0 L 21600 0 L 10800 21600 Z', fill: 'norm', stroke: true}]}, fill: solid('FF8800')});
  const bg = box(p, 'Uses background', 560, 60, 100, 60, {fill: {kind: 'background'}});
  const tb = box(p, 'Text Box', 60, 220, 200, 40, {textBox: true, descr: 'alt text', text: {body: {wrap: false, autofit: {kind: 'shape'}}, paragraphs: [para('A text box')]}});
  const c1 = box(p, 'Child 1', 300, 300, 50, 50);
  const c2 = box(p, 'Child 2', 360, 300, 50, 50);
  const grp = shape({id: take(p), name: 'Group', xfrm: {x: 300, y: 300, w: 110, h: 50}, kind: {type: 'group', children: [c1, c2], child: {x: 300, y: 300, w: 110, h: 50}}});
  const cxn = box(p, 'Connector', 350, 325, 10, 0, {geom: {kind: 'preset', name: 'straightConnector1'}, kind: {type: 'connector', start: [c1.id, 2], end: [c2.id, 0]},
    line: {fill: solid('000000'), width: 1.5, tail: {kind: 'arrow', w: 'med', len: 'med'}}});
  s1.shapes.push(star, pat, free, bg, tb, grp, cxn);
  s1.comments = [{author: 'Ada', initials: 'AL', text: 'Nice star', date: '2025-01-02T03:04:05.000', x: 120, y: 64, resolved: false, replies: [], shape: null}];
  s1.transition = {kind: 'push', option: 'l', durationMs: 1000, advanceOnClick: true, advanceAfterMs: 3000, sound: null};
  s1.animations = [
    {shape: star.id, class: 'entrance', effect: 'fly', option: 'l', start: 'onClick', durationMs: 500, delayMs: 0, repeat: 1, rewind: false, textBuild: 'asOne', paragraph: null, path: null, trigger: null, amount: null, color: null, presetId: null, presetSubtype: null, after: null, sound: null, smoothStart: 0, smoothEnd: 0, bounceEnd: 0, autoReverse: false},
    {shape: pat.id, class: 'emphasis', effect: 'spin', option: '', start: 'withPrevious', durationMs: 2000, delayMs: 250, repeat: 1, rewind: false, textBuild: 'asOne', paragraph: null, path: null, trigger: null, amount: 360, color: null, presetId: null, presetSubtype: null, after: null, sound: null, smoothStart: 0, smoothEnd: 0, bounceEnd: 0, autoReverse: false},
    {shape: free.id, class: 'path', effect: 'customPath', option: '', start: 'afterPrevious', durationMs: 2000, delayMs: 0, repeat: 1, rewind: false, textBuild: 'asOne', paragraph: null, path: 'M 0 0 L 0.25 0.1 E', trigger: null, amount: null, color: null, presetId: null, presetSubtype: null, after: null, sound: null, smoothStart: 0, smoothEnd: 0, bounceEnd: 0, autoReverse: false},
    {shape: tb.id, class: 'exit', effect: 'fadeOut', option: '', start: 'onClick', durationMs: 500, delayMs: 0, repeat: 1, rewind: false, textBuild: 'asOne', paragraph: null, path: null, trigger: pat.id, amount: null, color: null, presetId: null, presetSubtype: null, after: null, sound: null, smoothStart: 0, smoothEnd: 0, bounceEnd: 0, autoReverse: false},
  ];
  // Slide 2: pictures, media, ink (hidden slide).
  const s2 = addSlide(p, 'blank');
  s2.hidden = true;
  const img = addMedia(p, 'red.png', 'image/png', png([255, 0, 0]));
  const pf = (media, extra = {}) => ({media, crop: [0.1, 0, 0, 0.2], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: 0.5,
    adjust: {brightness: 0.2, contrast: -0.1, saturation: null, grayscale: false, duotone: null, clearColor: null, sharpen: 0}, ...extra});
  const pic = box(p, 'Picture', 60, 60, 200, 150, {kind: {type: 'picture', fill: pf(img)}});
  const tiled = box(p, 'Tiled', 300, 60, 200, 150, {fill: {kind: 'picture', ...pf(img, {crop: [0, 0, 0, 0], alpha: null, mode: {kind: 'tile', tx: 0, ty: 0, sx: 0.5, sy: 0.5, flip: 'none', align: 'tl'}})}});
  const vid = addMedia(p, 'clip.mp4', 'video/mp4', new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6D, 0x70, 0x34, 0x32, 0, 0, 0, 0]));
  const video = box(p, 'Video', 520, 60, 160, 90, {kind: {type: 'media', media: vid, video: true, poster: img, crop: [0.1, 0, 0.2, 0.25], trimStartMs: 500, trimEndMs: 0, fadeInMs: 250, fadeOutMs: 0,
    volume: 1, autoplay: false, loopPlay: false, rewind: false, playAcrossSlides: false, hideWhileNotPlaying: false, fullScreen: false, bookmarks: [['Start', 100]], durationMs: 0, width: 0, height: 0}});
  const ink = box(p, 'Ink', 0, 0, 960, 540, {kind: {type: 'ink', strokes: [{points: [[10, 10, 0.5], [40, 20, 0.5], [80, 10, 0.5]], color: {r: 0, g: 0, b: 255, a: 255}, width: 3, highlighter: false}]}});
  s2.shapes.push(pic, tiled, video, ink);
  // Slide 3: a table.
  const s3 = addSlide(p, 'titleOnly');
  const cell = (t, extra = {}) => ({text: {body: {}, paragraphs: [para(t)]}, fill: null, borders: [null, null, null, null], diagDown: null, diagUp: null, margins: null, anchor: null,
    gridSpan: 1, rowSpan: 1, hMerge: false, vMerge: false, vertical: null, ...extra});
  s3.shapes.push(box(p, 'Table 1', 60, 140, 400, 80, {kind: {type: 'table', cols: [200, 200], style: 'light1-accent2', firstRow: true, firstCol: false, lastRow: false, lastCol: false, bandRow: true, bandCol: false,
    rows: [{height: 40, cells: [cell('a', {gridSpan: 2}), cell('', {hMerge: true})]}, {height: 40, cells: [cell('c', {fill: solid('FFEEDD'), anchor: 'middle', margins: [5, 5, 2, 2], borders: [{fill: solid('FF0000'), width: 1}, null, null, null]}), cell('d')]}]}}));
  // Slide 4: links back to slide 1.
  const s4 = addSlide(p, 'blank');
  s4.shapes.push(box(p, 'Go to shapes', 60, 60, 200, 60, {click: {action: {kind: 'slide', slide: s1.id}, tooltip: '', highlightClick: false}}));
  p.sections = [{name: 'Start', slides: [s0.id, s1.id]}, {name: 'Rest', slides: [s2.id, s3.id, s4.id]}];
  p.customShows = [{name: 'Short', slides: [s0.id, s3.id]}];
  p.guides = [{vertical: true, pos: 480}, {vertical: false, pos: 270}];
  return p;
}

/** import(export(p)) */
export const round = async p => importPptx(await exportPptx(p));
export const byName = (sl, name) => {
  const all = [];
  const rec = list => { for (const s of list) { all.push(s); if (s.kind?.type === 'group') rec(s.kind.children); } };
  rec(sl.shapes);
  const hit = all.find(s => s.name === name);
  if (!hit) throw new Error(`no shape ${name}`);
  return hit;
};

/** The parts of a package as {name: Uint8Array}. */
export async function entries(bytes) {
  const z = await JSZip.loadAsync(bytes);
  const out = {};
  for (const f of Object.values(z.files)) if (!f.dir) out[f.name] = await f.async('uint8array');
  return out;
}
export async function partText(bytes, name) { const e = await entries(bytes); return e[name] ? new TextDecoder().decode(e[name]) : null; }
/** Rezip with `edit(name, text) → text` applied to every XML part and `extra` parts added. */
export async function repack(bytes, edit, extra = {}) {
  const e = await entries(bytes);
  const z = new JSZip();
  for (const [n, d] of Object.entries(e)) z.file(n, /\.(xml|rels)$/.test(n) ? edit(n, new TextDecoder().decode(d)) : d);
  for (const [n, d] of Object.entries(extra)) z.file(n, d);
  return z.generateAsync({type: 'uint8array'});
}
