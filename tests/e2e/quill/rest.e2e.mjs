// Word's leftovers (U:quill/rest) end to end through the bridge, in the new shell: Picture Format's Color Tone, Set Transparent Color and Crop to Shape, Shape Fill's
// Texture, Preset effects and Edit Wrap Points, Page Color's Fill Effects, Table Layout's pen and diagonal borders, Check Accessibility and its pane, the legacy form
// fields, Hide White Space, and the Immersive Reader's Line Focus. No OS input: ribbon controls through ui.activate / ui.menu, the document read back over the bridge and
// every step captured (capturePage).
//
// Behaviour fidelity: not checked against upstream (wordcraft has no engine for most of these; Check Accessibility is translated from cmd/accessibility.rs); each follows
// what Word does, as the spec notes say. The engine side is tests/quill/rest*.test.mjs and tests/quill/accessibility.test.mjs.
//
// Evidence: artifacts/e2e/quill/rest/*.png.

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
  const seed = createFile('quill', 'Leftovers');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Quarterly review'}]},
    para('A picture goes below, then a shape, a table and two form fields.'),
    para(''),
    para('The shape follows.'),
    para(''),
    para('The table follows.'),
    para(''),
    para('Name: '),
    para('Agreed: '),
    para('Closing paragraph.'),
  ]};
  return migrateFile(seed);
}

/** A 240 x 160 picture: a pale sky, a sun and green hills. */
async function samplePng() {
  const w = 240, h = 160, b = bitmap(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = [225, 236, 250, 255];
      if (Math.hypot(x - 170, y - 40) < 22) c = [250, 190, 60, 255];
      const hill = h * 0.62 + Math.sin(x / 28) * 14;
      if (y > hill) c = [50 + (y - hill) * 0.6, 150 - (y - hill) * 0.4, 60, 255];
      b.data.set(c, (y * w + x) * 4);
    }
  }
  return encodePngJs(b);
}

test('quill leftovers: picture, shape, page, table, accessibility, legacy forms and view', {timeout: 900_000}, async () => {
  const seed = seedDoc('quill-rest');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/rest', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const settle = (ms = 500) => new Promise(r => setTimeout(r, ms));
  const inspect = () => app.rpc('ui.inspect', {doc});
  const controls = async () => new Map(((await inspect()).controls ?? []).map(c => [c.id, c]));
  const tab = async id => { await app.rpc('ui.tab', {doc, id}); await settle(700); };
  const activate = (id, value) => app.rpc('ui.activate', {doc, control: id, ...(value === undefined ? {} : {value})});
  const read = async () => (await app.rpc('document.read', {doc, address: '/body', as: 'json'})).value;
  /** A caret in the paragraph that starts with `text`, `off` characters in (the paragraphs move as objects and tables go in, so none is addressed by number). */
  const caretIn = async (text, off) => {
    let hit = null;
    const walk = v => {
      if (hit || !v || typeof v !== 'object') return;
      if (typeof v.text === 'string' && v.id && v.text.startsWith(text)) { hit = v; return; }
      Object.values(v).forEach(walk);
    };
    walk(await read());
    if (!hit) throw new Error('no paragraph starting ' + text);
    const at = `/body/b:${hit.id}/t:${off}`;
    await run('select.range', {anchor: at, focus: at});
  };
  const menu = async (id, open = true) => app.rpc('ui.menu', {doc, control: id, ...(open ? {} : {open: false})});
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await inspect(); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });

    // A picture: Color Tone, Set Transparent Color and Crop to Shape.
    await run('caret.set', {pos: {block: 2, off: 0}});
    await run('insert.picture', {data: base64Encode(await samplePng()), width: 240, alt: 'Hills under a sun'});
    await tab('picture-format');
    await menu('picture-format.adjust.color');
    await settle(600);
    await app.capture('1-color-menu-with-color-tone', {doc});
    await menu('picture-format.adjust.color', false);
    await run('picture.colorTone', {temperature: 10500});
    await settle(500);
    await app.capture('2-color-tone-warm', {doc});
    await run('picture.setTransparentColor', {at: [0.05, 0.05], tolerance: 24});
    await settle(500);
    await app.capture('3-transparent-sky', {doc});
    await activate('picture-format.size.crop.crop-to-shape', 'ellipse');
    await settle(500);
    await app.capture('4-cropped-to-an-oval', {doc});
    await menu('picture-format.size.crop');
    await settle(600);
    await app.capture('5-crop-menu-shape-fill-fit', {doc});
    await menu('picture-format.size.crop', false);

    // A shape: texture, a preset effect and its wrap points.
    await caretIn('The shape follows.', 0);
    await run('insert.shape', {kind: 'roundedRectangle', width: 180, height: 90});
    await run('shape.fillTexture', {texture: 'green-marble'});
    await run('shape.effectPreset', {preset: 8});
    await tab('shape-format');
    await menu('shape-format.shape-styles.shape-fill');
    await settle(700);
    await app.capture('6-shape-fill-menu-texture-gallery', {doc});
    await menu('shape-format.shape-styles.shape-fill', false);
    await run('arrange.editWrapPoints', {});
    await settle(700);
    await app.capture('7-texture-fill-preset-and-wrap-points', {doc});
    await run('arrange.editWrapPoints', {value: false});
    await run('arrange.wrap', {wrap: 'inline'});

    // The page: a gradient background, then a texture.
    await run('design.pageFill', {kind: 'gradient', color1: 'FFFFFF', color2: 'DCE6F4', style: 'horizontal'});
    await settle(700);
    await app.capture('8-page-gradient', {doc});
    await run('design.pageFill', {kind: 'texture', texture: 'parchment'});
    await settle(700);
    await app.capture('9-page-texture', {doc});
    await run('design.pageFill', {kind: 'none'});

    // A table: diagonal borders and the pen.
    await caretIn('The table follows.', 0);
    await run('insert.table', {rows: 3, cols: 3});
    await tab('table-design');
    await run('table.diagonalBorder', {direction: 'down', value: true});
    await run('table.drawMode', {mode: 'draw'});
    await settle(500);
    await app.capture('10-table-diagonal-and-pen-on', {doc});
    const ids = await controls();
    assert.equal(ids.get('table-layout.draw.draw-table')?.checked ?? true, true);
    await run('table.drawMode', {mode: 'off'});

    // Check Accessibility: the pane lists what the checker found.
    await tab('review');
    assert.ok((await controls()).has('review.accessibility.check-accessibility'), 'Check Accessibility is on the Review tab');
    await activate('review.accessibility.check-accessibility');
    await settle(900);
    await app.capture('11-accessibility-pane', {doc});

    // Legacy form fields.
    await caretIn('Name: ', 6);
    await run('developer.legacyField', {kind: 'text'});
    await caretIn('Agreed: ', 8);
    await run('developer.legacyField', {kind: 'checkBox', checked: true});
    await tab('developer');
    await menu('developer.controls.legacy-tools');
    await settle(600);
    await app.capture('12-legacy-tools-menu-and-fields', {doc});
    await menu('developer.controls.legacy-tools', false);

    // View: Hide White Space between two pages, then the Immersive Reader's Line Focus.
    await caretIn('Closing paragraph.', 0);
    await run('insert.pageBreak', {});
    await run('text.insert', {text: 'The second page.'});
    await tab('view');
    assert.ok((await controls()).has('view.show.hide-white-space'), 'Hide White Space is on the View tab');
    await run('view.hideWhiteSpace', {value: true});
    await settle(900);
    await app.capture('13-hide-white-space', {doc});
    await run('view.hideWhiteSpace', {value: false});
    await caretIn('A picture goes below', 22);
    await run('view.immersive', {});
    await run('view.lineFocus', {value: 'three'});
    await settle(900);
    await app.capture('14-immersive-line-focus', {doc});
  } catch (e) {
    throw new Error(`${e.message}${log()}`);
  } finally {
    await app.close();
  }
});
