// Quill's Picture Format and Shape Format tabs (U:quill/shapes) end to end through the bridge, in the new shell. No OS
// input: the ribbon through ui.activate / ui.menu, the panes through the view commands, and the document read back over
// the bridge.
//
// Behaviour fidelity:
// 1. ArtCraft crates/ui-egui/src/ribbon/picture.rs and shape.rs (the two tabs), engine/src/cmd/objects/*.rs, shape_fill.rs,
//    wordart.rs and canvas.rs (the commands); Word: a selected picture shows Picture Format (corrections, colour, styles,
//    border, crop, size, alt text), a selected shape Shape Format (fill, outline, effects, WordArt, text direction).
// 2. The same commands run from the window (the person's path); each change is one undo step; the page view draws
//    the result from the same layout (captures below).
// 3. This file; the engine side is tests/quill/shapes.test.mjs.
//
// Evidence: artifacts/e2e/quill/shapes/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {base64Encode} from '../../../core/quill/lib/insert-objects.mjs';
import {encodePngJs} from '../../../core/quill/lib/picture-host.mjs';
import {bitmap} from '../../../core/quill/lib/picture-pixels.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

const para = text => ({type: 'paragraph', content: [{type: 'text', text}]});

function seedDoc(id) {
  const seed = createFile('quill', 'Objects');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Pictures and shapes'}]},
    para('A picture goes below, then a shape and a text box. Each gets its own tab when it is selected.'),
    para('Closing paragraph.'),
  ]};
  return migrateFile(seed);
}

/** A 240 × 160 picture: a sky gradient, a sun and green hills, so every correction shows. */
async function samplePng() {
  const w = 240, h = 160, b = bitmap(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = [90 + (y / h) * 110, 150 + (y / h) * 70, 235, 255];
      if (Math.hypot(x - 170, y - 40) < 22) c = [250, 214, 80, 255];
      const hill = h * 0.62 + Math.sin(x / 28) * 14 + Math.sin(x / 11) * 3;
      if (y > hill) c = [50 + (y - hill) * 0.6, 150 - (y - hill) * 0.4, 60, 255];
      b.data.set(c, (y * w + x) * 4);
    }
  }
  return encodePngJs(b);
}

function objectsIn(body, type) {
  const out = [];
  const walk = v => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.type === type && (type !== 'shape' || v.kind)) out.push(v);
      Object.values(v).forEach(walk);
    }
  };
  walk(body);
  return out;
}

test('quill Picture Format and Shape Format: both tabs, their menus, the Format Shape and Alt Text panes, and the page', {timeout: 900_000}, async () => {
  const seed = seedDoc('quill-shapes');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/shapes', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async () => (await app.rpc('document.read', {doc, address: '/body', as: 'json'})).value;
  const settle = (ms = 500) => new Promise(r => setTimeout(r, ms));
  const inspect = () => app.rpc('ui.inspect', {doc});
  const control = async id => (await inspect()).controls?.find(c => c.id === id) ?? null;
  const activate = (id, value) => app.rpc('ui.activate', {doc, control: id, ...(value === undefined ? {} : {value})});
  const menu = async (id, open = true) => { await app.rpc('ui.menu', {doc, control: id, open}); await settle(open ? 500 : 150); };
  const picture = async () => objectsIn(await read(), 'image')[0];
  const shape = async () => objectsIn(await read(), 'shape')[0];
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await inspect(); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });

    // A picture at the end of the second paragraph: Picture Format comes forward.
    await run('caret.set', {pos: {block: 1, off: 93}});
    await run('insert.picture', {data: base64Encode(await samplePng()), width: 240, alt: 'Hills under a sun'});
    await app.rpc('ui.tab', {doc, id: 'picture-format'});
    await settle(900);
    let ids = new Set(((await inspect()).controls ?? []).map(c => c.id));
    for (const id of ['picture-format.adjust.remove-background', 'picture-format.adjust.corrections', 'picture-format.adjust.color', 'picture-format.adjust.icon-color', 'picture-format.adjust.artistic-effects',
      'picture-format.adjust.transparency', 'picture-format.adjust.compress-pictures', 'picture-format.adjust.change-picture', 'picture-format.adjust.reset-picture',
      'picture-format.picture-styles.styles', 'picture-format.picture-styles.picture-border', 'picture-format.picture-styles.picture-effects', 'picture-format.accessibility.alt-text', 'picture-format.size.crop', 'picture-format.size.reset-crop',
      'picture-format.size.width', 'picture-format.size.height']) assert.ok(ids.has(id), `${id} is on the Picture Format tab`);
    for (const id of ['picture-format.picture-styles.picture-layout', 'picture-format.size.crop-l-t-r-b']) assert.ok(!ids.has(id), `${id} has no engine and is hidden`);
    await app.capture('1-picture-format', {doc});

    // Menus: Corrections, Color, Artistic Effects, the Styles gallery (drawn tiles), Picture Border, Crop > Aspect Ratio.
    for (const [n, id] of [['2-corrections', 'picture-format.adjust.corrections'], ['3-color', 'picture-format.adjust.color'], ['4-artistic-effects', 'picture-format.adjust.artistic-effects'],
      ['5-picture-styles', 'picture-format.picture-styles.styles'], ['6-picture-border', 'picture-format.picture-styles.picture-border'], ['7-crop', 'picture-format.size.crop']]) {
      await menu(id);
      await app.capture(n, {doc});
      await menu(id, false);
    }
    const styles = (await control('picture-format.picture-styles.styles'))?.value ?? [];
    assert.deepEqual(styles.map(s => s.id), ['simpleFrame', 'thickFrame', 'rounded', 'softEdge', 'shadow'], 'the five styles are tiles');
    assert.ok(styles.every(s => s.art?.kind === 'pictureStyle'), 'each is drawn as a sample picture in its style');

    // Brighter, a style, then reset.
    const media0 = (await picture()).media;
    await activate('picture-format.adjust.corrections.brighter-20');
    await settle(900);
    assert.notEqual((await picture()).media, media0, 'a new bitmap');
    await activate('picture-format.picture-styles.styles', 'rounded');
    await settle(900);
    await app.capture('8-brighter-rounded', {doc});
    await activate('picture-format.adjust.color.sepia');
    await settle(900);
    await app.capture('9-sepia', {doc});
    await activate('picture-format.adjust.artistic-effects.posterize');
    await settle(900);
    await app.capture('10-posterize', {doc});
    await activate('picture-format.adjust.reset-picture.reset-picture');
    await settle(700);
    assert.equal((await picture()).media, media0, 'Reset Picture puts the original back');
    await activate('picture-format.picture-styles.picture-border.medium');
    await settle(900);
    await activate('picture-format.size.crop.aspect-ratio.square');
    await settle(700);
    assert.ok(Math.abs((await picture()).w - (await picture()).h) < 0.5, 'the Square aspect ratio crop makes the frame square');
    await app.capture('11-border-square', {doc});

    // Crop opens the Format Picture pane on its Crop offsets; Alt Text opens its pane; both are real panes.
    await activate('picture-format.size.crop.crop');
    await settle(900);
    await app.capture('12-format-picture-pane', {doc});
    await run('view.formatShapePane', {value: false});
    await activate('picture-format.accessibility.alt-text');
    await settle(900);
    await app.capture('13-alt-text-pane', {doc});
    await run('view.altTextPane', {value: false});
    await settle(500);

    // The Size dialog, from the group's launcher.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.pictureSize'});
    await settle(700);
    await app.capture('14-size-dialog', {doc});
    await app.rpc('ui.dialog.cancel', {doc, id: 'dialog.pictureSize'});

    // A shape: Shape Format comes forward; fill, gradient variations, outline, effects.
    await run('caret.set', {pos: {block: 2, off: 0}});
    await run('insert.shape', {kind: 'roundedRectangle', width: 150, height: 80});
    await app.rpc('ui.tab', {doc, id: 'shape-format'});
    await settle(900);
    ids = new Set(((await inspect()).controls ?? []).map(c => c.id));
    for (const id of ['shape-format.shape-styles.shape-styles', 'shape-format.shape-styles.shape-fill', 'shape-format.shape-styles.shape-outline', 'shape-format.shape-styles.shape-effects', 'shape-format.insert-shapes.edit-shape',
      'shape-format.wordart-styles.styles', 'shape-format.wordart-styles.text-fill', 'shape-format.wordart-styles.text-outline', 'shape-format.wordart-styles.text-effects',
      'shape-format.text.text-direction', 'shape-format.text.align-text', 'shape-format.size.width', 'shape-format.accessibility.alt-text']) assert.ok(ids.has(id), `${id} is on the Shape Format tab`);
    await app.capture('15-shape-format', {doc});
    for (const [n, id] of [['16-shape-fill', 'shape-format.shape-styles.shape-fill'], ['17-shape-outline', 'shape-format.shape-styles.shape-outline'], ['18-shape-effects', 'shape-format.shape-styles.shape-effects'],
      ['19-wordart-styles', 'shape-format.wordart-styles.styles'], ['20-text-effects', 'shape-format.wordart-styles.text-effects']]) {
      await menu(id);
      await app.capture(n, {doc});
      await menu(id, false);
    }
    const tiles = (await control('shape-format.wordart-styles.styles'))?.value ?? [];
    assert.equal(tiles.length, 8, 'the eight WordArt styles are drawn tiles');
    assert.ok(tiles.every(t => t.art?.kind === 'wordArt'));

    await run('shape.fill', {gradient: {stops: [{pos: 0, color: '4472C4'}, {pos: 100, color: 'B4C7E7'}], angle: 90}});
    await run('shape.outline', {color: '1F3864', width: 3});
    await run('shape.effects', {shadow: 'offsetBottomRight', glow: 8});
    await settle(900);
    assert.equal((await shape()).fill.type, 'gradient');
    await app.capture('21-gradient-shadow-glow', {doc});
    await run('shape.fill', {color: 'FFC000', transparency: 40});
    await run('shape.effects', {shadow: null, glow: null, softEdge: 10});
    await settle(900);
    await app.capture('22-transparent-soft-edges', {doc});

    // The Format Shape pane: Fill & Line, Effects, Layout & Properties.
    await run('shape.effects', {softEdge: null});
    await run('shape.fill', {gradient: {stops: [{pos: 0, color: 'FFFFFF'}, {pos: 100, color: '2F5597'}], angle: 45}});
    await run('view.formatShapePane', {tab: 'fill'});
    await settle(1200);
    await app.capture('23-format-shape-fill', {doc});
    await run('view.formatShapePane', {tab: 'effects'});
    await settle(900);
    await app.capture('24-format-shape-effects', {doc});
    await run('view.formatShapePane', {tab: 'layout'});
    await settle(900);
    await app.capture('25-format-shape-layout', {doc});
    await run('view.formatShapePane', {value: false});

    // A text box: select it, turn its text, pick WordArt styles and a text warp.
    await run('caret.set', {pos: {block: 2, off: 0}});
    await run('insert.textBox', {text: 'Text box'});
    await settle(500);
    const selectObject = async index => {
      // The paragraphs that hold objects, in document order, wherever the read puts them.
      const paras = [];
      const walk = v => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
          if (typeof v.text === 'string' && Array.isArray(v.objects) && v.id) paras.push(v);
          else Object.values(v).forEach(walk);
        }
      };
      walk(await read());
      let n = 0;
      for (const blk of paras) {
        const offs = [...blk.text].map((c, i) => (c === String.fromCharCode(0xfffc) ? i : -1)).filter(i => i >= 0);
        for (const off of offs) if (n++ === index) return run('select.range', {anchor: `/body/b:${blk.id}/t:${off}`, focus: `/body/b:${blk.id}/t:${off + 1}`});
      }
      throw new Error('no object ' + index + ' of ' + n);
    };
    await selectObject(1);  // the text box went in at the start of the paragraph, before the shape
    await app.rpc('ui.tab', {doc, id: 'shape-format'});
    await settle(700);
    await run('wordArt.style', {style: 'outlined'});
    await run('shape.fill', {color: '2F5597'});
    await settle(800);
    await app.capture('26-text-box-wordart', {doc});
    await run('wordArt.style', {style: 'gradient'});
    await run('shape.textDirection', {dir: 'vert'});
    await settle(800);
    await app.capture('27-text-box-turned', {doc});
    await run('shape.textDirection', {dir: 'horz'});
    await run('wordArt.style', {style: 'shadowed'});
    await run('shape.fill', {color: null});
    await run('wordArt.transform', {preset: 'textArchUp'});
    await settle(800);
    await app.capture('28-text-warp-arch', {doc});
    await run('wordArt.transform', {preset: 'textWave1'});
    await settle(800);
    await app.capture('29-text-warp-wave', {doc});
    await run('shape.textDirection', {dir: 'stacked'});
    await run('wordArt.transform', {preset: 'none'});
    await settle(800);
    await app.capture('30-text-stacked', {doc});
    await run('shape.textDirection', {dir: 'horz'});

    // Arrange: several objects picked, Group and Ungroup, the Selection Pane, flips, crop mode, Picture Effects, Shape Styles.
    // Objects in line with text can't be grouped: float the shape and the text box first, one below the other.
    await run('select.objects', {index: 2});
    await run('arrange.position', {preset: 'topLeft', x: 40, y: 330});
    await run('select.objects', {index: 1});
    await run('arrange.position', {preset: 'topLeft', x: 260, y: 330});
    await run('select.objects', {index: 2});
    await run('select.addObject', {index: 1});
    await app.rpc('ui.tab', {doc, id: 'shape-format'});
    await settle(700);
    await app.capture('31-two-picked', {doc});
    assert.equal((await control('shape-format.arrange.group'))?.enabled, true, 'Group is on with two picked');
    await menu('shape-format.arrange.group');
    await app.capture('32-group-menu', {doc});
    await menu('shape-format.arrange.group', false);
    await activate('shape-format.arrange.group.group');
    await settle(800);
    assert.ok(objectsIn(await read(), 'group').length >= 1, 'a group is in the document');
    await app.capture('33-grouped', {doc});
    await activate('shape-format.arrange.group.ungroup');
    await settle(800);
    assert.equal(objectsIn(await read(), 'group').length, 0, 'Ungroup gives the members back');
    await menu('shape-format.arrange.align');
    await app.capture('34-align-menu', {doc});
    await menu('shape-format.arrange.align', false);
    await run('arrange.selectionPane', {value: true});
    await settle(900);
    await app.capture('35-selection-pane', {doc});
    await run('arrange.selectionPane', {value: false});
    await menu('shape-format.shape-styles.shape-styles');
    await app.capture('36-shape-styles', {doc});
    await menu('shape-format.shape-styles.shape-styles', false);
    await run('select.objects', {index: 2});
    await activate('shape-format.shape-styles.shape-styles', 4 * 7 + 3);
    await settle(700);
    await menu('shape-format.shape-styles.shape-effects');
    await app.capture('37-shape-effects-menu', {doc});
    await menu('shape-format.shape-styles.shape-effects', false);
    await run('shape.effects', {reflection: 'half', bevel: 'circle'});
    await settle(800);
    await app.capture('38-shape-reflection-bevel', {doc});
    await run('select.objects', {index: 0});
    await app.rpc('ui.tab', {doc, id: 'picture-format'});
    await settle(700);
    await menu('picture-format.picture-styles.picture-effects');
    await app.capture('39-picture-effects-menu', {doc});
    await menu('picture-format.picture-styles.picture-effects', false);
    await run('shape.effects', {reflection: 'full', shadow: 'offsetBottomRight'});
    await run('arrange.rotate', {direction: 'flipHorizontal'});
    await settle(900);
    await app.capture('40-picture-reflection-flip', {doc});
    await run('shape.effects', {reflection: null, shadow: null, bevel: 'relaxedInset', glow: 8});
    await run('arrange.rotate', {direction: 'flipHorizontal'});
    await activate('picture-format.size.crop.crop');
    await settle(900);
    assert.equal((await control('picture-format.size.crop'))?.enabled, true);
    await app.capture('41-crop-mode', {doc});
    await run('view.cropMode', {value: false});
    await settle(400);

    // WordArt: the Insert gallery's text box, drawn with its effects; Home's Text Effects on ordinary text. Insert WordArt leaves its text
    // selected; the object is picked by its place in the document for Shape Format and the Layout dialog.
    await run('caret.set', {pos: {block: 2, off: 0}});
    await run('insert.wordArt', {text: 'Arkemis', style: 'gradient', transform: 'textWave1'});
    const drawings = [];
    const walk = v => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        if (['image', 'group', 'graphic'].includes(v.type) || (v.type === 'shape' && v.kind)) drawings.push(v);
        else Object.values(v).forEach(walk);
      }
    };
    walk(await read());
    assert.ok(drawings.some(o => o.kind === 'textBox'), 'WordArt is a text box');
    await run('select.objects', {index: drawings.findIndex(o => o.kind === 'textBox' && o.extra?.warp)});
    await app.rpc('ui.tab', {doc, id: 'shape-format'});
    await settle(900);
    await app.capture('46-wordart', {doc});
    await run('wordArt.style', {style: 'glowing'});
    await run('format.textEffects', {outline: 'C00000', shadow: 'offsetBottomRight'});
    await settle(700);
    await app.capture('47-wordart-glow-outline', {doc});

    // The Layout dialog (More Layout Options): Position, Text Wrapping and Size tabs on the selected object.
    await activate('shape-format.arrange.wrap-text.more-layout-options');
    await settle(700);
    let dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.pictureSize');
    await app.capture('48-layout-dialog', {doc});
    await app.rpc('ui.dialog.set', {doc, values: {wrap: 'tight', dist: 6}});
    await settle(300);
    await app.rpc('ui.dialog.submit', {doc});
    await settle(700);
    assert.equal(objectsIn(await read(), 'shape').find(s => s.kind === 'textBox')?.float?.wrap, 'tight', 'the Layout dialog set Tight wrapping');
    await app.capture('49-layout-applied', {doc});

    // Edit Points (not checked against upstream: wordcraft has none): a triangle becomes a freeform, its vertices show on the page,
    // a point is added, made smooth and its handle moved, and the curves are kept in the document.
    await run('caret.set', {pos: {block: 2, off: 0}});
    await run('insert.shape', {kind: 'triangle', width: 150, height: 100});
    await run('arrange.position', {preset: 'topLeft', x: 330, y: 250});
    await app.rpc('ui.tab', {doc, id: 'shape-format'});
    await settle(700);
    const ep = 'shape-format.insert-shapes.edit-shape.edit-points';
    await menu('shape-format.insert-shapes.edit-shape');
    await app.capture('42-edit-shape-menu', {doc});
    await activate(ep);
    await settle(900);
    const freeform = objectsIn(await read(), 'shape').find(s => s.kind === 'freeform');
    assert.ok(freeform, 'the triangle is a freeform now');
    await app.capture('43-edit-points-triangle', {doc});
    const before = await run('shape.points', {});
    assert.equal(before.paths[0].length, 3);
    await run('shape.addPoint', {segment: 1});
    await run('shape.pointType', {index: 1, type: 'smooth'});
    const mid = (await run('shape.points', {})).paths[0][1];
    await run('shape.moveHandle', {index: 1, side: 'out', x: mid[0] + 40, y: mid[1] - 30});
    await settle(900);
    await app.capture('44-edit-points-curved', {doc});
    assert.ok(objectsIn(await read(), 'shape').some(s => s.kind === 'freeform' && s.freeform?.paths?.some(q => /C/.test(q.d ?? ''))), 'the curve is kept as path data');
    await run('shape.movePoint', {index: 0, x: before.paths[0][0][0] - 30, y: before.paths[0][0][1] + 10});
    await settle(700);
    await app.capture('45-edit-points-moved', {doc});
    await run('shape.editPoints', {on: false});
    await settle(400);
  } finally {
    await app.close({keepData: false});
  }
});
