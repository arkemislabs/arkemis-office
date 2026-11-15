// Prism's SmartArt through the bridge and the real window (U:prism/smartart).
//
// What deckcraft does (cmd/smartart.rs, ribbon/smartart.rs, panels/smartart.rs): Insert > SmartArt picks a graphic, which is a group of
// shapes drawn from an outline; the SmartArt Design tab adds shapes, promotes and demotes, changes layout and colours; the Text Pane
// edits the outline. PowerPoint: the same.
// What this proves in the app: the real Choose a SmartArt Graphic dialog (layouts drawn as thumbnails) inserts a graphic that is drawn,
// the SmartArt Design tab shows for it with drawn layout and colour galleries, and the Text Pane edits its text (looked at in the
// captures). Captures in artifacts/e2e/prism/smartart/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('prism smartart: insert from the gallery, design tab, text pane', {timeout: 300_000}, async () => {
  const file = createFile('prism', 'SmartArt deck', {schema: 2});
  file.id = 'prism-smartart';
  file.content.slides[0].shapes[0].text = bodyFromText('Our process');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/smartart', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const activate = (control, value) => app.rpc('ui.activate', value === undefined ? {doc, control} : {doc, control, value});
  const graphic = async () => (await deck()).slides[1].shapes.find(s => s.diagram);
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await run('slide.new', {layout: 'titleOnly'});
    await run('slide.go', {index: 1});
    await app.rpc('ui.tab', {doc, tab: 'insert'});
    await activate('insert.illustrations.smartart');
    await sleep(600);
    let dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.smartart');
    await app.capture('1-gallery-dialog');
    await app.rpc('ui.dialog.set', {field: 'category', value: 'Cycle'});
    await sleep(400);
    await app.capture('2-gallery-cycle');
    await app.rpc('ui.dialog.set', {field: 'category', value: 'All'});
    await app.rpc('ui.dialog.set', {field: 'kind', value: 'process'});
    await app.rpc('ui.dialog.submit', {});
    await sleep(900);
    let g = await graphic();
    assert.ok(g, 'a SmartArt graphic is on the slide');
    assert.equal(g.diagram.kind, 'process');
    await app.capture('3-process-on-slide');

    // The SmartArt Design tab and its galleries.
    await app.until(async () => { const u = await app.rpc('ui.inspect', {doc}); return u.contextualTabs?.includes('smart-art-design') || null; }, {timeout: 10_000});
    await app.rpc('ui.tab', {doc, tab: 'smart-art-design'});
    await sleep(500);
    const ui = await app.rpc('ui.inspect', {doc});
    const ctl = id => ui.controls.find(c => c.id === id);
    for (const id of ['smartart.create.text-pane', 'smartart.create.add-shape', 'smartart.create.promote', 'smartart.create.demote', 'smartart.layouts.gallery', 'smartart.styles.colors']) assert.ok(ctl(id), `${id} is drawn`);
    for (const id of ['smartart.reset.reset', 'smartart.create.rtl', 'smartart.create.move-up', 'smartart.create.move-down', 'smartart.create.layout']) assert.ok(ctl(id), `${id} is drawn`);
    for (const id of ['smartart.styles.gallery', 'smartart.create.insert-picture']) assert.ok(ctl(id), `${id} is drawn`);
    await app.capture('4-smartart-design-tab');
    await app.rpc('ui.menu', {doc, control: 'smartart.layouts.gallery'});
    await sleep(500);
    await app.capture('5-layout-gallery');
    await app.rpc('ui.menu', {doc, control: 'smartart.layouts.gallery', open: false});
    await run('smartArt.layout', {kind: 'cycle'});
    await sleep(500);
    await app.capture('6-cycle');

    // The Text Pane: type into the outline.
    await activate('smartart.create.text-pane');
    await sleep(700);
    await run('smartArt.setNodes', {lines: ['Discover', '\tInterviews', '\tSurvey', 'Design', 'Build', 'Ship']});
    await sleep(600);
    g = await graphic();
    assert.deepEqual(g.diagram.nodes.map(n => n.level), [0, 1, 1, 0, 0, 0]);
    await app.capture('7-text-pane');
    await run('smartArt.layout', {kind: 'hierarchy'});
    await run('smartArt.colors', {colors: 'accent2'});
    await sleep(600);
    await app.capture('8-hierarchy-orange');
    await run('smartArt.layout', {kind: 'pyramid'});
    await sleep(500);
    await app.capture('9-pyramid');
    // SmartArt Styles gallery, drawn on the graphic itself, and a bevelled style.
    await app.rpc('ui.menu', {doc, control: 'smartart.styles.gallery'});
    await sleep(500);
    await app.capture('10-styles-gallery');
    await app.rpc('ui.menu', {doc, control: 'smartart.styles.gallery', open: false});
    await run('smartArt.layout', {kind: 'gear'});
    await run('smartArt.style', {style: 'polished'});
    await sleep(600);
    g = await graphic();
    assert.equal(g.diagram.style, 'polished');
    await app.capture('11-gear-polished');
    await run('smartArt.layout', {kind: 'nameTitleOrgChart'});
    await run('smartArt.style', {style: 'flat'});
    await sleep(500);
    await app.capture('12-org-chart');
    // Layout (organization chart branches), Move Up / Down, Right to Left and Reset Graphic.
    await app.rpc('ui.menu', {doc, control: 'smartart.create.layout'});
    await sleep(500);
    await app.capture('13-layout-dropdown');
    await app.rpc('ui.menu', {doc, control: 'smartart.create.layout', open: false});
    await run('smartArt.branch', {branch: 'left'});
    await sleep(500);
    g = await graphic();
    assert.equal(g.diagram.hang, 'left');
    await app.capture('14-left-hanging');
    await run('smartArt.branch', {branch: 'standard'});
    await run('smartArt.moveUp', {index: 4});
    g = await graphic();
    assert.deepEqual(g.diagram.nodes.map(n => n.text), ['Discover', 'Interviews', 'Survey', 'Build', 'Design', 'Ship'], 'Move Up swapped Build above Design');
    await activate('smartart.create.rtl');
    await sleep(500);
    g = await graphic();
    assert.equal(g.diagram.rtl, true, 'Right to Left');
    await app.capture('15-right-to-left');
    await run('smartArt.colors', {colors: 'accent3'});
    await run('smartArt.style', {style: 'cartoon'});
    await activate('smartart.reset.reset');
    await sleep(500);
    g = await graphic();
    assert.deepEqual([g.diagram.style, g.diagram.colors, g.diagram.rtl], ['flat', 'colorful', undefined], 'Reset Graphic');
    assert.equal(g.diagram.nodes.length, 6, 'the text stays');
    await app.capture('16-reset');
    // A text box converts to a graphic in its place.
    await run('slide.new', {layout: 'titleOnly'});
    await run('slide.go', {index: 2});
    await run('insert.textBox', {rect: [80, 400, 300, 90], text: ['Plan', 'Build', 'Ship'].join(String.fromCharCode(10))});
    await run('smartArt.fromText', {kind: 'verticalBoxList'});
    await sleep(500);
    await app.capture('17-from-text');
  } finally {
    await app.close();
  }
});
