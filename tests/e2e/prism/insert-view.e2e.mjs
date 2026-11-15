// Prism's Header & Footer dialog, the media pickers and the View tab through the bridge and the real
// window (U:prism/insert, U:prism/view).
//
// What deckcraft does (ribbon/view.rs, app/commands.rs, sorter.rs, dialogs/body.rs dlg_header_footer):
// View switches between Normal, Outline, Slide Sorter and Notes Page, toggles Ruler, Gridlines, Guides and
// Notes, Fit, Zoom and Grayscale; Insert > Header & Footer puts the date, slide number and footer on the
// slides. PowerPoint: the same tabs.
// What this proves in the app: the real controls (ui.activate, ui.menu, ui.dialog.*) change the deck and
// the surface as the engine tests do, and each view draws what it should (looked at in the captures).
// Captures in artifacts/e2e/prism/insert-view/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('prism insert and view: header and footer, view modes, show toggles, grayscale', {timeout: 300_000}, async () => {
  const file = createFile('prism', 'View deck', {schema: 2});
  file.id = 'prism-view';
  file.content.slides[0].shapes[0].text = bodyFromText('Quarterly review');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/insert-view', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const activate = (control, value) => app.rpc('ui.activate', value === undefined ? {doc, control} : {doc, control, value});
  const inspect = async () => app.rpc('ui.inspect', {doc});
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await run('slide.new', {layout: 'titleAndContent'});
    await run('slide.new', {layout: 'titleOnly'});
    await run('slide.go', {index: 1});
    await run('shape.insert', {preset: 'ellipse', rect: [520, 200, 300, 260]});
    await run('slide.go', {index: 0});
    await run('slide.notes', {text: 'Open with the revenue chart. Mention the Q3 dip.'});

    // Insert > Header & Footer.
    await app.rpc('ui.tab', {doc, tab: 'insert'});
    let ui = await inspect();
    const ctl = id => ui.controls.find(c => c.id === id);
    assert.ok(ctl('insert.text.header-footer') && ctl('insert.media.video') && ctl('insert.media.audio'), 'the Insert controls are drawn');
    for (const id of ['insert.media.screen-recording', 'insert.images.screenshot', 'insert.text.object', 'insert.camera.cameo']) assert.equal(ctl(id), undefined, `${id} is hidden`);
    await activate('insert.text.header-footer');
    let dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.headerFooter');
    await app.rpc('ui.dialog.set', {field: 'footer', value: true});
    await app.rpc('ui.dialog.set', {field: 'footerText', value: 'Acme Corp'});
    await app.rpc('ui.dialog.set', {field: 'num', value: true});
    await app.rpc('ui.dialog.set', {field: 'date', value: true});
    await app.rpc('ui.dialog.set', {field: 'hide', value: true});
    await app.capture('1-header-footer-dialog');
    await app.rpc('ui.dialog.submit', {});
    let d = await deck();
    const kinds = sl => sl.shapes.filter(s => s.ph && ['footer', 'slideNum', 'date'].includes(s.ph.kind)).map(s => s.ph.kind).sort();
    assert.deepEqual(kinds(d.slides[0]), [], "not on the title slide (Don't show on title slide)");
    assert.deepEqual(kinds(d.slides[1]), ['date', 'footer', 'slideNum']);
    await app.rpc('ui.dialog.cancel', {}).catch(() => {});
    await run('slide.go', {index: 1});
    await app.capture('2-footer-on-slide');
    await run('slide.go', {index: 0});

    // View: the views, one by one.
    await app.rpc('ui.tab', {doc, tab: 'view'});
    ui = await inspect();
    for (const id of ['view.views.normal', 'view.views.outline', 'view.views.sorter', 'view.views.notes-page', 'view.views.reading', 'view.show.ruler', 'view.show.gridlines', 'view.show.guides', 'view.show.notes',
      'view.zoom.zoom', 'view.zoom.fit', 'view.color.color', 'view.color.grayscale', 'view.window.new', 'view.window.arrange-all', 'view.window.switch']) assert.ok(ctl(id), `${id} is drawn`);
    for (const id of ['view.color.black-white', 'view.color.dark-mode', 'view.window.cascade', 'view.macros.macros']) assert.equal(ctl(id), undefined, `${id} is hidden`);
    assert.equal(ctl('view.views.normal').checked, true);
    await app.capture('3-view-tab-normal');
    await activate('view.views.outline');
    await sleep(500);
    ui = await inspect();
    assert.equal(ctl('view.views.outline').checked, true);
    await app.capture('4-outline-view');
    await activate('view.views.sorter');
    await sleep(600);
    await app.capture('5-slide-sorter');
    await activate('view.views.notes-page');
    await sleep(600);
    await app.capture('6-notes-page');
    await activate('view.views.normal');
    await sleep(400);

    // Show: Ruler, Gridlines, Guides (the two centre guides appear), Notes off.
    await activate('view.show.ruler');
    await activate('view.show.gridlines');
    await activate('view.show.guides');
    d = await deck();
    assert.equal(d.guides.length, 2, 'a deck without guides gets the two centre guides');
    await sleep(500);
    await app.capture('7-ruler-grid-guides');
    await activate('view.show.ruler');
    await activate('view.show.gridlines');
    await activate('view.show.guides');
    await activate('view.show.notes');
    await sleep(400);
    ui = await inspect();
    assert.equal(ctl('view.show.notes').checked, false);
    await app.capture('8-notes-hidden');
    await activate('view.show.notes');

    // Grayscale, Zoom and Fit.
    await activate('view.color.grayscale');
    await sleep(400);
    ui = await inspect();
    assert.equal(ctl('view.color.grayscale').checked, true);
    await app.capture('9-grayscale');
    await activate('view.color.color');
    await run('view.zoom', {value: 150});
    await sleep(300);
    await app.capture('10-zoom-150');
    await activate('view.zoom.fit');
    await sleep(300);
    ui = await inspect();
    assert.equal(ctl('view.zoom.fit').checked ?? true, true);
    await app.rpc('ui.menu', {doc, control: 'view.zoom.zoom'});
    await app.capture('11-zoom-menu');
    await app.rpc('ui.menu', {doc, control: 'view.zoom.zoom', open: false});
    await activate('view.views.reading');
    await app.until(async () => (await run('show.status')).result?.slide === 0 || null, {timeout: 15_000});
    await sleep(500);
    await app.capture('12-reading-view');
    await run('show.end');
  } finally {
    await app.close();
  }
});
