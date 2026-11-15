// Quill's Insert > Shapes gallery (the whole preset catalogue, Recently Used), the WordArt Styles and SmartArt Layouts drop-downs and the in-place
// equation, end to end through the bridge, in the new shell. No OS input: ribbon controls through ui.activate / ui.menu, the document read back over the
// bridge and every step captured (capturePage).
//
// Behaviour fidelity:
// 1. wordcraft crates/ui-egui/src/ribbon/insert.rs (Shapes), deckcraft crates/geom presets for the shapes; Word: Insert > Shapes in nine groups, the
//    WordArt Styles gallery as a drop-down, the SmartArt Layouts gallery, an equation typed where it stands.
// 2. The same commands run from the window (the person's path).
// 3. This file; the engine side is tests/quill/misc-fixes.test.mjs.
//
// Evidence: artifacts/e2e/quill/misc-fixes/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

const para = text => ({type: 'paragraph', content: [{type: 'text', text}]});
function seedDoc(id) {
  const seed = createFile('quill', 'Shapes notes');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Shapes notes'}]},
    para('Shapes go below.'),
    para(''),
    para('Done.'),
  ]};
  return migrateFile(seed);
}

test('quill Shapes gallery, drop-down galleries and the in-place equation', {timeout: 900_000}, async () => {
  const seed = seedDoc('quill-misc-fixes');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/misc-fixes', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async () => JSON.stringify((await app.rpc('document.read', {doc, address: '/body', as: 'json'})).value);
  const settle = (ms = 450) => new Promise(r => setTimeout(r, ms));
  const inspect = () => app.rpc('ui.inspect', {doc});
  const activate = (id, value) => app.rpc('ui.activate', {doc, control: id, ...(value === undefined ? {} : {value})});
  const menu = async (id, open = true) => app.rpc('ui.menu', {doc, control: id, ...(open ? {} : {open: false})});
  const tab = async id => { await app.rpc('ui.tab', {doc, id}); await settle(); };
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await inspect(); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });

    await tab('insert');
    await menu('insert.illustrations.shapes');
    await settle(700);
    await app.capture('1-shapes-gallery', {doc});
    await menu('insert.illustrations.shapes', false);
    await run('caret.set', {pos: {block: 2, off: 0}});
    for (const preset of ['wedgeRectCallout', 'chevron', 'star8', 'flowChartDecision', 'rightArrow', 'straightConnector1']) await activate('insert.illustrations.shapes', preset);
    await settle(700);
    const body = await read();
    for (const k of ['wedgeRectCallout', 'chevron', 'star8', 'flowChartDecision']) assert.ok(body.includes(k), `${k} is in the document`);
    await app.capture('2-presets-inserted', {doc});
    await menu('insert.illustrations.shapes');
    await settle(500);
    await app.capture('3-recently-used', {doc});
    await menu('insert.illustrations.shapes', false);

    await run('insert.shape', {preset: 'cloudCallout', width: 200, height: 110});
    await settle(500);
    await tab('shape-format');
    await menu('shape-format.wordart-styles.styles');
    await settle(600);
    await app.capture('4-wordart-dropdown', {doc});
    await menu('shape-format.wordart-styles.styles', false);

    await run('insert.smartArt', {layout: 'process'});
    await tab('smart-art-design');
    await menu('smartart-design.layouts.layouts');
    await settle(700);
    await app.capture('5-smartart-layouts', {doc});
    await menu('smartart-design.layouts.layouts', false);

    await run('insert.equation', {});
    await settle(600);
    await app.capture('6-new-equation-in-place', {doc});
    await run('equation.edit', {linear: 'x=(-b±√(b^2-4ac))/2a'});
    await settle(600);
    await app.capture('7-equation-typed', {doc});

    // The Styles gallery draws each style; the View tab's Window group; the dialogs the review listed.
    await run('caret.set', {pos: {block: 1, off: 0}});
    await tab('home');
    await menu('home.styles.styles');
    await settle(600);
    await app.capture('8-styles-gallery', {doc});
    await menu('home.styles.styles', false);
    await tab('view');
    await app.capture('9-view-tab', {doc});
    await run('insert.table', {rows: 2, cols: 3});
    await settle(500);
    const pickers = [['10-font', 'dialog.font'], ['11-hyperlink', 'dialog.link'], ['12-equation-options', 'dialog.equationOptions'], ['13-table-properties', 'dialog.tableProperties'], ['14-table-formula', 'dialog.tableFormula'], ['15-paste-special', 'dialog.pasteSpecial']];
    for (const [n, id] of pickers) {
      await app.rpc('ui.dialog.open', {doc, id});
      await settle(900);
      await app.capture(n, {doc});
      await app.rpc('ui.dialog.cancel', {doc});
      await settle(200);
    }
    // Round 4: the text menu has Synonyms, Bullets, Numbering and Styles submenus (and the mini toolbar), the Drop Cap and Envelopes boxes draw their own layouts.
    const ctxMenu = await app.rpc('ui.contextMenu', {doc, target: 'selection', x: 420, y: 330});
    const labels = ctxMenu.items.map(i => i.label);
    for (const l of ['Synonyms', 'Bullets', 'Numbering', 'Styles']) assert.ok(labels.includes(l), `the text menu lists ${l}: ${labels.join(', ')}`);
    await app.rpc('ui.contextMenu', {doc, open: false});
    for (const [n, id] of [['16-drop-cap', 'dialog.dropCap'], ['17-envelopes', 'dialog.envelopes'], ['18-bookmark', 'dialog.bookmark'], ['19-hyperlink-browse', 'dialog.link'], ['20-select-place', 'dialog.selectPlace'], ['21-screentip', 'dialog.screenTip'], ['22-watermark-picture', 'dialog.watermark'], ['23-table-style', 'dialog.tableStyle']]) {
      await app.rpc('ui.dialog.open', {doc, id});
      await settle(900);
      if (n === '22-watermark-picture') await app.rpc('ui.dialog.set', {doc, values: {kind: 'picture'}});
      await settle(300);
      await app.capture(n, {doc});
      await app.rpc('ui.dialog.cancel', {doc});
      await settle(200);
    }
  } catch (e) { throw new Error(`${e.message}${log()}`); } finally { await app.close(); }
});
