// U:quill/shapes: Picture Format (Adjust, Picture Styles, Size, Alt Text) and Shape Format (Shape Fill, Outline,
// Effects, Change Shape, the Text group, Drawing Canvas, WordArt Styles).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/objects/{picture,shape,select,specs}.rs, shape_fill.rs, wordart.rs and
//    canvas.rs (the commands), crates/ui-egui/src/ribbon/{picture,shape}.rs (the two tabs). Word: Picture Format
//    corrects, recolours, styles and crops the selected picture; Shape Format fills, outlines and adds effects to the
//    selected shape.
// 2. Ours: pixel edits rewrite the picture's bitmap as a PNG (the pixel engine is core/quill/lib/picture-pixels.mjs,
//    here fed by the plain-JavaScript PNG codec); every command is one undo step.
// 3. Proof: this file and tests/e2e/quill/shapes.e2e.mjs (both tabs through the bridge, with captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from './format-fixture.mjs';
import {base64Encode} from '../../core/quill/lib/insert-objects.mjs';
import {encodePngJs, decodePngJs} from '../../core/quill/lib/picture-host.mjs';
import * as X from '../../core/quill/lib/picture-pixels.mjs';
import * as P from '../../core/quill/model/para.mjs';
import {openDialogModel, submitDialog, changeDialogValues} from '../../core/kernel/dialog.mjs';

const dialogs = (await import('../../core/generated/quill.dialogs.mjs')).dialogs;

/** A w × h picture: red on the left half, blue on the right, opaque. */
async function twoTone(w = 40, h = 20) {
  const b = X.bitmap(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.data.set(x < w / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * w + x) * 4);
  return encodePngJs(b);
}
async function withPicture(w = 40, h = 20) {
  const q = await quill('Before the picture.\nAfter it.');
  q.sel(0, 6);
  await q.exec('insert.picture', {data: base64Encode(await twoTone(w, h)), width: w});
  return q;
}
const object = (q, type = 'image') => {
  for (const b of blocks(q.t)) for (const o of b.objects ?? []) if (o.type === type) return o;
  return null;
};
const pixels = async (q, key) => decodePngJs(Uint8Array.from(atob(q.t.content.media[key]), c => c.charCodeAt(0)));

test('the PNG codec round trips pixels', async () => {
  const b = X.bitmap(3, 2, [10, 20, 30, 40]);
  const back = await decodePngJs(await encodePngJs(b));
  assert.deepEqual([back.width, back.height, [...back.data]], [3, 2, [...b.data]]);
});

test('pixel ops: brighten, contrast, colour, transparency, remove background', () => {
  const grey = X.bitmap(4, 4, [100, 100, 100, 255]);
  assert.equal(X.brighten(grey, 20).data[0], 120);
  assert.equal(X.brighten(grey, 200).data[0], 255, 'clamped');
  assert.ok(X.contrast(grey, 20).data[0] < 100, 'a dark grey gets darker with more contrast');
  const red = X.bitmap(2, 2, [255, 0, 0, 255]);
  const g = X.recolor(red, 'grayscale').data;
  assert.deepEqual([g[0], g[1], g[2]], [76, 76, 76]);
  assert.equal(X.recolor(red, 'saturation', 100).data[0], 255);
  assert.equal(X.transparency(red, 50).data[3], 127);
  assert.equal(X.transparency(X.transparency(red, 50), 0).data[3], 127, 'absolute from the bitmap it is given');
  // A white page with a black dot: the white border region goes, the dot stays.
  const page = X.bitmap(5, 5, [255, 255, 255, 255]);
  page.data.set([0, 0, 0, 255], (2 * 5 + 2) * 4);
  const cut = X.removeBackground(page, 30).data;
  assert.equal(cut[3], 0, 'the corner is clear');
  assert.equal(cut[(2 * 5 + 2) * 4 + 3], 255, 'the dot stays');
});

test('pixel ops: blur keeps a flat picture, unsharpen keeps it, compress shrinks the longer side', () => {
  const flat = X.bitmap(8, 8, [80, 90, 100, 255]);
  assert.deepEqual([...X.blur(flat, 3).data.slice(0, 4)], [80, 90, 100, 255]);
  assert.deepEqual([...X.unsharpen(flat, 2, 2).data.slice(0, 4)], [80, 90, 100, 255]);
  const big = X.bitmap(400, 200, [1, 2, 3, 255]);
  const small = X.compress(big, 100);
  assert.deepEqual([small.width, small.height], [100, 50]);
  assert.deepEqual([...small.data.slice(0, 4)], [1, 2, 3, 255]);
  assert.deepEqual([X.compress(big, 1600).width], [400], 'nothing to shrink');
});

test('pixel ops: styles and borders', () => {
  const b = X.bitmap(80, 40, [200, 10, 10, 255]);
  const m = 2; // 80 / 40
  assert.equal(X.pictureStyle(b, 'simpleFrame').width, 80 + 2 * Math.max(m, 4));
  assert.equal(X.pictureStyle(b, 'shadow').width, 80 + Math.max(m, 4));
  const rounded = X.pictureStyle(b, 'rounded');
  assert.equal(rounded.data[3], 0, 'the corner is cut');
  assert.equal(rounded.data[(20 * 80 + 40) * 4 + 3], 255, 'the middle stays');
  assert.equal(X.relookBitmap(b, {effect: null, style: null, border: [0, 0, 0, 3]}).width, 86);
  const inverted = X.artisticEffect(b, 'invert').data;
  assert.deepEqual([inverted[0], inverted[1], inverted[3]], [55, 245, 255]);
  const pix = X.artisticEffect(X.bitmap(24, 24, [5, 5, 5, 255]), 'pixelate');
  assert.deepEqual([pix.width, pix.height], [24, 24]);
});

test('picture.size: one side keeps the proportions, both set both; scale and original; one undo step', async () => {
  const q = await withPicture(40, 20);
  const w0 = object(q).w;
  await q.exec('picture.size', {width: w0 * 2});
  assert.deepEqual([object(q).w, object(q).h], [80, 40]);
  await q.exec('picture.size', {width: 50, height: 50});
  assert.deepEqual([object(q).w, object(q).h], [50, 50]);
  await q.exec('picture.size', {height: 25, lockAspect: false});
  assert.deepEqual([object(q).w, object(q).h], [50, 25]);
  await q.exec('picture.size', {scale: 200});
  assert.deepEqual([object(q).w, object(q).h], [100, 50]);
  // 40 × 20 pixels at 96 ppi: 30 × 15 points.
  await q.exec('picture.size', {original: true});
  assert.deepEqual([object(q).w, object(q).h], [30, 15]);
  await q.exec('picture.size', {original: true, scale: 50});
  assert.deepEqual([object(q).w, object(q).h], [15, 7.5]);
  await q.exec('picture.size', {width: 99999});
  assert.equal(object(q).w, 4000, 'at most 4000 pt');
  assert.equal(object(q).h, 2000, 'with the proportions kept');
  await q.exec('edit.undo', {});
  assert.equal(object(q).w, 15);
});

test('picture.crop: fractions, 5% kept between two sides, size and floating position in one step', async () => {
  const q = await withPicture(40, 20);
  await q.exec('picture.crop', {left: 0.25, right: 0.25});
  assert.deepEqual(object(q).crop, [0.25, 0, 0.25, 0]);
  await q.exec('picture.crop', {left: 0.9, right: 0.9});
  assert.ok(Math.abs(object(q).crop[2] - 0.05) < 1e-9, 'the second side stops where 5% is left');
  await q.exec('picture.crop', {});
  assert.deepEqual(object(q).crop, [0, 0, 0, 0]);
  // A floating picture moves by what a left crop trims.
  await q.exec('arrange.position', {preset: 'topLeft'});
  const x0 = object(q).float.x;
  await q.exec('picture.crop', {left: 0.5, width: 20});
  assert.equal(object(q).w, 20);
  assert.ok(Math.abs(object(q).float.x - (x0 + 0.5 * 40)) < 1e-9, 'the visible part stays put');
});

test('picture.cropAspect: the sides are cropped evenly to the shape', async () => {
  const q = await withPicture(60, 30);
  await q.exec('picture.cropAspect', {aspect: 'square'});
  const c = object(q).crop;
  assert.ok(Math.abs(c[0] - 0.25) < 1e-9 && Math.abs(c[2] - 0.25) < 1e-9 && c[1] === 0 && c[3] === 0, `a 2:1 picture loses a quarter each side, got ${c}`);
  assert.ok(Math.abs(object(q).w - object(q).h) < 1e-6, 'the frame is square too');
});

test('object.altText and picture.altText: text, title and decorative', async () => {
  const q = await withPicture();
  await q.exec('picture.altText', {text: 'Two colours', title: 'Flag', decorative: false});
  assert.equal(object(q).alt, 'Two colours');
  assert.equal(object(q).float.alt.title, 'Flag');
  await q.exec('object.altText', {decorative: true});
  assert.equal(P.isDecorative(object(q)), true);
  await assert.rejects(q.exec('object.altText', {}), /required/);
});

test('picture.corrections: absolute from the original; picture.reset puts the original back', async () => {
  const q = await withPicture();
  const key0 = object(q).media;
  await q.exec('picture.corrections', {brightness: 20});
  const key1 = object(q).media;
  assert.notEqual(key1, key0);
  assert.equal(object(q).orig, key0);
  const lit = (await pixels(q, key1)).data;
  assert.deepEqual([lit[0], lit[1], lit[2]], [255, 51, 51], 'brightness +20% adds 51');
  // Again at +20%: not 102, the original's +51.
  await q.exec('picture.corrections', {brightness: 20});
  assert.deepEqual([...(await pixels(q, object(q).media)).data.slice(0, 3)], [255, 51, 51]);
  // 0 restores the original pixels.
  await q.exec('picture.corrections', {});
  assert.deepEqual([...(await pixels(q, object(q).media)).data.slice(0, 3)], [255, 0, 0]);
  await q.exec('picture.crop', {left: 0.2});
  await q.exec('picture.color', {mode: 'grayscale'});
  await q.exec('picture.reset', {});
  assert.equal(object(q).media, key0);
  assert.deepEqual(object(q).crop, [0, 0, 0, 0]);
  assert.equal(object(q).orig, undefined);
});

test('picture.color, transparency, iconColor, effects, removeBackground, compress make a new bitmap', async () => {
  const q = await withPicture(40, 20);
  const grey = async args => { await q.exec('picture.color', args); const d = (await pixels(q, object(q).media)).data; return [d[0], d[1], d[2]]; };
  assert.deepEqual(await grey({mode: 'grayscale'}), [76, 76, 76]);
  await q.exec('picture.transparency', {percent: 50});
  assert.equal((await pixels(q, object(q).media)).data[3], 127);
  await q.exec('picture.iconColor', {color: '00FF00'});
  assert.deepEqual([...(await pixels(q, object(q).media)).data.slice(0, 4)], [0, 255, 0, 127], 'one colour, transparency kept');
  await q.exec('picture.reset', {});
  await q.exec('picture.effects', {effect: 'invert'});
  assert.deepEqual([...(await pixels(q, object(q).media)).data.slice(0, 3)], [0, 255, 255]);
  await q.exec('picture.effects', {effect: 'none'});
  assert.equal(object(q).look, undefined);
  await q.exec('picture.removeBackground', {});
  assert.equal((await pixels(q, object(q).media)).data[3], 0, 'the area of the corner colour is clear');
  const q2 = await withPicture(200, 100);
  await q2.exec('picture.compress', {maxPixels: 50});
  const d = await pixels(q2, object(q2).media);
  assert.deepEqual([d.width, d.height], [50, 25]);
});

test('picture.style replaces the style and border; picture.border keeps the style; undo is one step', async () => {
  const q = await withPicture(40, 20);
  const base = object(q).media;
  await q.exec('picture.style', {style: 'simpleFrame'});
  const framed = await pixels(q, object(q).media);
  assert.equal(framed.width, 40 + 2 * 4, 'a white frame of a fortieth, at least 4');
  await q.exec('picture.style', {style: 'softEdge'});
  const soft = await pixels(q, object(q).media);
  assert.equal(soft.width, 40, 'a second style replaces the first, it is not framed again');
  await q.exec('picture.border', {width: 3, color: '000000'});
  const bordered = await pixels(q, object(q).media);
  assert.equal(bordered.width, 40 + 6, 'the border is drawn round the style');
  assert.equal(bordered.data[3], 255, 'a black frame');
  assert.equal(object(q).look.style, 'softEdge');
  await q.exec('picture.border', {none: true});
  assert.equal((await pixels(q, object(q).media)).width, 40);
  await q.exec('picture.style', {style: 'simpleFrame'});
  await q.exec('picture.reset', {});
  assert.equal(object(q).media, base);
  await q.exec('edit.undo', {});
  assert.equal(object(q).look.style, 'simpleFrame', 'undo put the reset back');
  const st = await q.state('picture.style', {});
  assert.deepEqual(st.value.map(v => v.id), ['simpleFrame', 'thickFrame', 'rounded', 'softEdge', 'shadow']);
  assert.equal(st.value.find(v => v.selected).id, 'simpleFrame');
});

test('picture.change swaps the bitmap and keeps the frame; a non-picture is refused', async () => {
  const q = await withPicture(40, 20);
  await q.exec('picture.crop', {left: 0.1});
  const w = object(q).w;
  await q.exec('picture.change', {data: base64Encode(await twoTone(10, 10))});
  assert.equal(object(q).w, w);
  assert.deepEqual(object(q).crop, [0.1, 0, 0, 0]);
  assert.equal((await pixels(q, object(q).media)).width, 10);
  await assert.rejects(q.exec('picture.change', {data: base64Encode(Uint8Array.from('not a picture at all'.split('').map(c => c.charCodeAt(0))))}), /supported image/);
});

test('Picture Format commands are disabled when no picture is selected', async () => {
  const q = await quill('Plain text');
  q.sel(0, 0);
  for (const id of ['picture.size', 'picture.crop', 'picture.corrections', 'picture.reset']) {
    const st = await q.state(id, {});
    assert.equal(st.enabled, false, id);
    assert.match(st.reason, /select a picture/, id);
  }
  await assert.rejects(q.exec('picture.corrections', {brightness: 5}), /select a picture/);
});

test('dialog.pictureSize: scale follows the width, lock keeps the proportions, OK runs picture.size and arrange.rotation', async () => {
  const q = await withPicture(40, 20);
  await q.exec('picture.size', {original: true, scale: 200});
  const model = dialogs['dialog.pictureSize'];
  let v = openDialogModel(q.t.session, q.t.docId, model);
  assert.deepEqual([v.width, v.height, v.scaleW, v.scaleH], [60, 30, 200, 200]);
  v = changeDialogValues(model, v, 'width', 30);
  assert.deepEqual([v.width, v.height, v.scaleW, v.scaleH], [30, 15, 100, 100], 'the height follows, the scales are of the original');
  v = changeDialogValues(model, v, 'scaleH', 50);
  assert.deepEqual([v.width, v.height], [15, 7.5]);
  v = {...v, lock: false};
  v = changeDialogValues(model, v, 'width', 20);
  assert.deepEqual([v.width, v.height], [20, 7.5], 'unlocked: only the width changes');
  v = {...v, rotation: 90};
  await submitDialog(q.t.session, q.t.docId, model, v);
  assert.deepEqual([object(q).w, object(q).h, object(q).float.rot], [20, 7.5, 90]);
  assert.ok(model.validate({...v, width: 0}).length);
});

// ---- Shape Format ----------------------------------------------------------------------------------------

async function withShape(kind = 'rectangle') {
  const q = await quill('Before the shape.\nAfter it.');
  q.sel(0, 6);
  await q.exec('insert.shape', {kind, width: 100, height: 50});
  return q;
}

test('shape.fill: colour, transparency kept by a later colour, gradient, No Gradient, none', async () => {
  const q = await withShape();
  await q.exec('shape.fill', {color: 'FFC000'});
  assert.deepEqual(object(q, 'shape').fill, [255, 192, 0]);
  await q.exec('shape.fill', {color: '#FFC000', transparency: 40});
  assert.deepEqual(object(q, 'shape').fill, {type: 'solid', color: [255, 192, 0], transparency: 40});
  await q.exec('shape.fill', {color: '00B050'});
  assert.equal(object(q, 'shape').fill.transparency, 40, 'a colour alone keeps the transparency');
  await q.exec('shape.fill', {gradient: {stops: [{pos: 0, color: 'FF0000'}, {pos: 100, color: '0000FF'}], angle: 45}});
  const g = object(q, 'shape').fill;
  assert.equal(g.type, 'gradient');
  assert.deepEqual(g.kind, {type: 'linear', angle: 45, scaled: false});
  assert.deepEqual(g.stops.map(s => s.pos), [0, 100]);
  await q.exec('shape.fill', {gradient: {type: 'radial', stops: [{pos: 0, color: 'FFFFFF'}, {pos: 100, color: '000000'}]}});
  assert.equal(object(q, 'shape').fill.kind.type, 'path');
  await q.exec('shape.fill', {gradient: 'none'});
  assert.equal(object(q, 'shape').fill.type, undefined, 'No Gradient: a solid');
  await q.exec('shape.fill', {color: null});
  assert.equal(object(q, 'shape').fill, null);
  await assert.rejects(q.exec('shape.fill', {gradient: {stops: [{pos: 0, color: 'FF0000'}]}}), /two or more stops/);
  await assert.rejects(q.exec('shape.fill', {color: 'zzz'}), /RRGGBB/);
});

test('shape.lightVariation and shape.darkVariation list 13 gradients each and apply one', async () => {
  const q = await withShape();
  await q.exec('shape.fill', {color: '4472C4'});
  const light = await q.state('shape.lightVariation', {});
  const dark = await q.state('shape.darkVariation', {});
  assert.equal(light.value.length, 13);
  assert.equal(dark.value.length, 13);
  assert.equal(light.value[3].label, 'From Bottom Right Corner');
  await q.exec('shape.darkVariation', {gradient: dark.value[1].value});
  const f = object(q, 'shape').fill;
  assert.equal(f.type, 'gradient');
  assert.equal(f.stops.length, 3);
  assert.ok(f.stops[0].color[0] < 0x44, 'dark variations shade the colour');
});

test('shape.outline: colour and weight, a weight keeps the colour, none; undo is one step', async () => {
  const q = await withShape();
  await q.exec('shape.outline', {color: 'C00000', width: 3});
  assert.deepEqual([object(q, 'shape').stroke, object(q, 'shape').strokeWidth], [[192, 0, 0], 3]);
  await q.exec('shape.outline', {width: 6});
  assert.deepEqual([object(q, 'shape').stroke, object(q, 'shape').strokeWidth], [[192, 0, 0], 6]);
  await q.exec('shape.outline', {color: null});
  assert.equal(object(q, 'shape').stroke, null);
  await q.exec('shape.outline', {width: 1});
  assert.ok(object(q, 'shape').stroke, 'a weight on a shape with no outline gives it the default colour');
  await q.exec('edit.undo', {});
  assert.equal(object(q, 'shape').stroke, null);
});

test('shape.effects: shadow presets, glow, soft edges, effect extent; omitted keys stay', async () => {
  const q = await withShape();
  await q.exec('shape.effects', {shadow: 'offsetBottomRight'});
  assert.equal(object(q, 'shape').effects.shadow.angle, 45);
  await q.exec('shape.effects', {glow: 8});
  assert.equal(object(q, 'shape').effects.glow.size, 8);
  assert.ok(object(q, 'shape').effects.shadow, 'the shadow stays');
  assert.ok(object(q, 'shape').float.effect.every(v => v >= 8), 'room for the glow');
  await q.exec('shape.effects', {softEdge: 5});
  assert.equal(object(q, 'shape').effects.softEdge, 5);
  await q.exec('shape.effects', {shadow: null, glow: null, softEdge: null});
  assert.equal(object(q, 'shape').effects, undefined);
  assert.deepEqual(object(q, 'shape').float.effect, [0, 0, 0, 0]);
  await q.exec('shape.effects', {shadow: {preset: 'offsetCenter', color: 'FF0000', blur: 12}});
  assert.deepEqual([object(q, 'shape').effects.shadow.color, object(q, 'shape').effects.shadow.blur, object(q, 'shape').effects.shadow.distance], [[255, 0, 0], 12, 0]);
  await assert.rejects(q.exec('shape.effects', {shadow: 'bogus'}), /unknown shadow preset/);
});

test('shape.change turns the shape into another kind', async () => {
  const q = await withShape('rectangle');
  await q.exec('shape.change', {kind: 'ellipse'});
  assert.equal(object(q, 'shape').kind, 'ellipse');
  const st = await q.state('shape.change', {});
  assert.ok(st.value.some(v => v.id === 'diamond'));
});

test('Shape Format commands need a shape', async () => {
  const q = await withPicture();
  assert.match((await q.state('shape.change', {})).reason, /select a shape/);
  assert.equal((await q.state('shape.effects', {})).enabled, true, 'Picture Effects are the same effects');
  assert.equal((await q.state('shape.fill', {})).enabled, false);
});

test('text boxes: shape.textDirection, shape.alignText, Create Link and Break Link', async () => {
  const q = await quill('Intro.');
  q.sel(0, 6);
  await q.exec('insert.textBox', {text: 'First box'});
  const first = object(q, 'shape').story;
  q.sel(0, 6);
  await q.exec('insert.textBox', {text: ''});
  const boxes = blocks(q.t).flatMap(b => (b.objects ?? []).filter(o => o.type === 'shape'));
  assert.equal(boxes.length, 2);
  const second = boxes.find(o => o.story !== first).story;
  // Select the first box (its object) and set its text direction and alignment.
  const sel = id => {
    const para = blocks(q.t).find(b => (b.objects ?? []).some(o => o.story === id));
    const off = P.objectsWithOffsets(para).find(([, o]) => o.story === id)[0];
    q.t.session.setSelection(q.t.docId, {ranges: [{anchor: `/body/b:${para.id}/t:${off}`, focus: `/body/b:${para.id}/t:${off + 1}`}], primary: 0});
  };
  sel(first);
  await q.exec('shape.textDirection', {dir: 'vert'});
  assert.equal(q.t.content.parts[first].body.vert, 'vert');
  await q.exec('shape.textDirection', {dir: 'wordArtVert'});
  assert.equal(q.t.content.parts[first].body.vert, 'stacked');
  await q.exec('shape.alignText', {anchor: 'ctr'});
  assert.equal(q.t.content.parts[first].body.anchor, 'center');
  assert.equal((await q.state('shape.alignText', {})).value, 'center');
  await assert.rejects(q.exec('shape.textDirection', {dir: 'sideways'}), /one of/);
  await q.exec('shape.link', {});
  assert.equal(q.t.content.parts[first].body.next, second);
  assert.equal((await q.state('shape.link', {})).enabled, false);
  await q.exec('shape.breakLink', {});
  assert.equal(q.t.content.parts[first].body.next, null);
  await assert.rejects(q.exec('shape.breakLink', {}), /isn't linked/);
  await q.exec('edit.undo', {});
  assert.equal(q.t.content.parts[first].body.next, second, 'undo of a break is the link back');
});

test('wordArt.style, textFill, textOutline and transform on a text box', async () => {
  const q = await quill('Intro.');
  q.sel(0, 6);
  await q.exec('insert.textBox', {text: 'Hello art'});
  const para = blocks(q.t).find(b => (b.objects ?? []).length);
  const off = P.objectsWithOffsets(para)[0][0];
  q.t.session.setSelection(q.t.docId, {ranges: [{anchor: `/body/b:${para.id}/t:${off}`, focus: `/body/b:${para.id}/t:${off + 1}`}], primary: 0});
  const story = object(q, 'shape').story;
  const fx = () => q.t.content.parts[story].blocks[0].runs.map(r => r.props?.textEffects);
  await q.exec('wordArt.style', {style: 'outlined'});
  assert.equal(fx()[0].fill.type, 'solid');
  assert.ok(fx()[0].outline.color, 'Light with Outline has an outline');
  await q.exec('wordArt.textFill', {fill: 'none'});
  assert.deepEqual(fx()[0].fill, {type: 'none'});
  await q.exec('wordArt.textFill', {color: 'FF0000'});
  assert.deepEqual(fx()[0].fill.color, [255, 0, 0]);
  await q.exec('wordArt.textFill', {fill: {gradient: ['FF0000', '0000FF'], angle: 45}});
  assert.equal(fx()[0].fill.type, 'gradient');
  const outline0 = fx()[0].outline;
  await q.exec('wordArt.textOutline', {width: 3});
  assert.deepEqual([fx()[0].outline.width, fx()[0].outline.color], [3, outline0.color], 'a weight keeps the colour');
  await q.exec('wordArt.textOutline', {outline: null});
  assert.equal(fx()[0].outline, undefined);
  await q.exec('wordArt.transform', {preset: 'textArchUp'});
  assert.equal(object(q, 'shape').extra.warp.preset, 'textArchUp');
  await q.exec('wordArt.transform', {preset: 'none'});
  assert.equal(object(q, 'shape').extra, undefined);
  await assert.rejects(q.exec('wordArt.style', {style: 'nope'}), /one of/);
  const st = await q.state('wordArt.style', {});
  assert.equal(st.value.length, 8);
});

test('canvas.fit, canvas.expand, canvas.scale', async () => {
  const q = await quill('Canvas below.');
  q.sel(0, 13);
  await q.exec('insert.canvas', {width: 400, height: 300});
  const canvas = () => object(q, 'group');
  await q.exec('canvas.expand', {by: 20});
  assert.deepEqual([canvas().w, canvas().h], [420, 320]);
  await q.exec('canvas.scale', {factor: 0.5});
  assert.deepEqual([canvas().w, canvas().h], [210, 160]);
  await assert.rejects(q.exec('canvas.scale', {factor: 0}), /at least/);
  await q.exec('shape.fill', {color: 'FFF2CC'});
  await q.exec('shape.outline', {color: '1F4E79', width: 1.5});
  assert.deepEqual([canvas().canvas.fill, canvas().canvas.stroke, canvas().canvas.strokeWidth], [[255, 242, 204], [31, 78, 121], 1.5]);
  await q.exec('edit.undo', {});
  assert.equal(canvas().canvas.strokeWidth, 0.75);
});

test('view.altTextPane and view.formatShapePane are view flags', async () => {
  const q = await withPicture();
  await q.exec('view.altTextPane', {value: true});
  assert.equal((await q.state('view.altTextPane', {})).checked, true);
  await q.exec('view.formatShapePane', {tab: 'picture'});
  assert.equal((await q.state('view.formatShapePane', {})).checked, true);
  await q.exec('view.formatShapePane', {value: false});
  assert.equal((await q.state('view.formatShapePane', {})).checked, false);
});

// ---- .docx and the page --------------------------------------------------------------------------------------

import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {pageDisplay} from '../../core/quill/layout/display.mjs';

test('docx: a see-through fill, a gradient, shadow, glow and soft edges save and read back', async () => {
  const q = await withShape();
  await q.exec('shape.fill', {color: 'FFC000', transparency: 30});
  await q.exec('shape.effects', {shadow: 'offsetBottomRight', glow: 8, softEdge: 4});
  const read = async () => {
    const back = await readDocx(await writeDocx(q.t.content));
    return back.body.chunks.flat().flatMap(b => b.objects ?? []).find(o => o?.type === 'shape');
  };
  let s = await read();
  assert.ok(s, 'the shape reads back as a shape');
  assert.deepEqual([s.fill.type, [...s.fill.color], s.fill.transparency], ['solid', [255, 192, 0], 30]);
  assert.equal(s.effects.shadow.angle, 45);
  assert.equal(s.effects.glow.size, 8);
  assert.equal(s.effects.softEdge, 4);
  assert.ok(s.float.effect.every(v => v >= 8), 'room for the glow');
  await q.exec('shape.fill', {gradient: {stops: [{pos: 0, color: 'FF0000', transparency: 20}, {pos: 100, color: '0000FF'}], angle: 45, scaled: true}});
  s = await read();
  assert.equal(s.fill.type, 'gradient');
  assert.deepEqual(s.fill.kind, {type: 'linear', angle: 45, scaled: true});
  assert.deepEqual(s.fill.stops.map(g => [g.pos, [...g.color], g.transparency]), [[0, [255, 0, 0], 20], [100, [0, 0, 255], 0]]);
  await q.exec('shape.fill', {gradient: {type: 'radial', stops: [{pos: 0, color: 'FFFFFF'}, {pos: 100, color: '000000'}], focus: [100, 100, 0, 0], tile: [0, 0, -100, -100]}});
  s = await read();
  assert.deepEqual(s.fill.kind, {type: 'path', shape: 'circle', focus: [100, 100, 0, 0]});
  assert.deepEqual(s.fill.tile, [0, 0, -100, -100]);
});

test('docx: a Drawing Canvas with a gradient background does not break saving and reads back', async () => {
  const q = await quill('Canvas below.');
  q.sel(0, 13);
  await q.exec('insert.canvas', {width: 300, height: 150});
  await q.exec('shape.fill', {color: 'FFF2CC', transparency: 50});
  const back = await readDocx(await writeDocx(q.t.content));
  const c = back.body.chunks.flat().flatMap(b => b.objects ?? []).find(o => o?.type === 'group');
  assert.deepEqual([c.canvas.fill.type, c.canvas.fill.transparency], ['solid', 50]);
});

test('the page: a see-through or gradient fill and the effects reach the draw items; turned text carries its rotation', async () => {
  const q = await withShape();
  await q.exec('shape.fill', {gradient: {stops: [{pos: 0, color: 'FF0000'}, {pos: 100, color: '0000FF'}]}});
  await q.exec('shape.effects', {glow: 6});
  const items = pageDisplay(layout(q.t.content, {view: 'print'}).pages[0], {}).filter(i => i.type === 'shape');
  assert.equal(items.length, 1);
  assert.equal(items[0].fillFx.type, 'gradient');
  assert.deepEqual(items[0].fill, [0, 0, 255].map((v, i) => items[0].fill[i]), 'the one colour standing for it');
  assert.equal(items[0].effects.glow.size, 6);

  const t2 = await quill('Intro.');
  t2.sel(0, 6);
  await t2.exec('insert.textBox', {text: 'Turned text'});
  const para = blocks(t2.t).find(b => (b.objects ?? []).length);
  const off = P.objectsWithOffsets(para)[0][0];
  t2.t.session.setSelection(t2.t.docId, {ranges: [{anchor: `/body/b:${para.id}/t:${off}`, focus: `/body/b:${para.id}/t:${off + 1}`}], primary: 0});
  const texts = () => pageDisplay(layout(t2.t.content, {view: 'print'}).pages[0], {}).filter(i => i.type === 'text' && /T|u|r|n|e|d/.test(i.text) && i.y > 0);
  const boxText = () => texts().find(i => i.text.includes('Turned'));
  assert.ok(boxText(), 'the text is on the page');
  assert.equal(boxText().turn, undefined, 'horizontal text is not turned');
  await t2.exec('shape.textDirection', {dir: 'vert'});
  assert.equal(boxText().turn.deg, 90);
  await t2.exec('shape.textDirection', {dir: 'vert270'});
  assert.equal(boxText().turn.deg, -90);
  await t2.exec('shape.textDirection', {dir: 'stacked'});
  const letters = texts().filter(i => !i.turn && i.y > 0).map(i => i.text);
  assert.ok(letters.some(x => x === 'T') && letters.some(x => x === 'u'), 'each letter of stacked text is on a line of its own');
  await t2.exec('shape.textDirection', {dir: 'horz'});
  assert.equal(boxText().turn, undefined);
  await t2.exec('wordArt.style', {style: 'shadowed'});
  assert.ok(boxText().fx.shadow, 'the run carries its WordArt effects');
});

import {warpAt} from '../../src/apps/quill/surface/shape-fx.mjs';

test('a text warp reaches the draw items of the box and bends letters along its preset', async () => {
  const q = await quill('Intro.');
  q.sel(0, 6);
  await q.exec('insert.textBox', {text: 'Bent words'});
  const para = blocks(q.t).find(b => (b.objects ?? []).length);
  const off = P.objectsWithOffsets(para)[0][0];
  q.t.session.setSelection(q.t.docId, {ranges: [{anchor: `/body/b:${para.id}/t:${off}`, focus: `/body/b:${para.id}/t:${off + 1}`}], primary: 0});
  const text = () => pageDisplay(layout(q.t.content, {view: 'print'}).pages[0], {}).find(i => i.type === 'text' && i.text.includes('Bent'));
  assert.equal(text().warp, undefined);
  await q.exec('wordArt.transform', {preset: 'textArchUp'});
  assert.equal(text().warp.preset, 'textArchUp');
  assert.ok(text().warp.frame.w > 0);
  await q.exec('wordArt.transform', {preset: 'textPlain'});
  assert.equal(text().warp, undefined, 'a plain warp draws flat');

  const frame = {x: 0, y: 0, w: 240, h: 80};
  const mid = warpAt('textArchUp', frame, 120, 40, 18), end = warpAt('textArchUp', frame, 10, 40, 18);
  assert.ok(end.dy > mid.dy, 'arch up: the ends are lower than the middle');
  assert.ok(end.rot < 0 && warpAt('textArchUp', frame, 230, 40, 18).rot > 0, 'and turn away from it');
  assert.ok(warpAt('textArchDown', frame, 10, 40, 18).dy < 0, 'arch down: the ends are higher');
  assert.ok(warpAt('textInflate', frame, 120, 40, 18).sy > warpAt('textInflate', frame, 10, 40, 18).sy, 'inflate: the middle is taller');
  assert.deepEqual(warpAt('textStop', frame, 120, 40, 18), {dx: 0, dy: 0, rot: 0, sy: 1}, 'a warp not drawn bent is flat');
  const circle = warpAt('textCircle', frame, 120, 40, 18);
  assert.ok(Number.isFinite(circle.dx) && Number.isFinite(circle.dy));
});

test('object.info: what the Format Shape and Alt Text panes read of the selected object', async () => {
  const q = await withShape('ellipse');
  await q.exec('shape.fill', {color: 'FFC000'});
  await q.exec('shape.effects', {glow: 5});
  let info = (await q.state('object.info', {})).value;
  assert.deepEqual([info.type, info.kind, info.width, info.height, info.textBox, info.canvas], ['shape', 'ellipse', 100, 50, false, false]);
  assert.deepEqual(info.fill, {type: 'solid', color: [255, 192, 0], transparency: 0});
  assert.equal(info.effects.glow.size, 5);
  const p = await withPicture(40, 20);
  await p.exec('picture.altText', {text: 'Flag'});
  await p.exec('picture.border', {width: 3});
  info = (await p.state('object.info', {})).value;
  assert.deepEqual([info.type, info.alt, info.original, info.edited], ['image', 'Flag', {width: 30, height: 15}, true]);
  assert.deepEqual(info.border, [0, 0, 0, 3]);
  const none = await quill('Plain');
  none.sel(0, 0);
  assert.equal((await none.state('object.info', {})).enabled, false);
});

test('picture.width and picture.height show the size and set one side; the Alt box shows the text', async () => {
  const q = await withPicture(40, 20);
  assert.equal((await q.state('picture.width', {})).value, 40);
  assert.equal((await q.state('picture.height', {})).value, 20);
  await q.exec('picture.height', {height: 40});
  assert.deepEqual([object(q).w, object(q).h], [80, 40], 'the width follows');
  await q.exec('picture.width', {width: 20, lockAspect: false});
  assert.deepEqual([object(q).w, object(q).h], [20, 40]);
  await q.exec('picture.altText', {text: 'Hello'});
  assert.equal((await q.state('picture.altText', {})).value, 'Hello');
});

test('the palette: auto and none are the default colour and no colour', async () => {
  const q = await withShape();
  await q.exec('shape.fill', {color: 'auto'});
  assert.equal(object(q, 'shape').fill, null, 'the palette No Color arrives as auto');
  await q.exec('shape.outline', {color: 'auto'});
  assert.deepEqual(object(q, 'shape').stroke, [0x0e, 0x40, 0x5a]);
  await q.exec('shape.outline', {color: 'none'});
  assert.equal(object(q, 'shape').stroke, null);
  const p = await withPicture();
  await p.exec('picture.border', {color: 'auto', width: 2});
  assert.deepEqual(object(p).look.border, [0, 0, 0, 2]);
});

test('a crop cuts the picture inside its style or border frame: the frame width is recorded and the layout carries it (no black bars)', async () => {
  const q = await withPicture(40, 20);
  await q.exec('picture.border', {width: 3, color: '000000'});
  assert.equal(object(q).look.pad, 3, 'the frame is 3 pixels wide');
  await q.exec('picture.crop', {left: 0.25, right: 0.25});
  const items = layout(q.t.content, {view: 'print'}).pages.flatMap(p => p.items).filter(i => i.kind === 'image');
  assert.equal(items[0].pad, 3);
  assert.deepEqual(items[0].crop.map(v => Math.round(v * 100) / 100), [0.25, 0, 0.25, 0]);
  await q.exec('picture.border', {none: true});
  assert.equal(object(q).look, undefined);
});
