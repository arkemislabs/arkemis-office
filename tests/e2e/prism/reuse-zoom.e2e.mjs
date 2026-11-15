// Prism's Reuse Slides and Insert Zoom through the bridge and the real window (U:prism/reuse, U:prism/zoom).
//
// What deckcraft does (cmd/reuse.rs, cmd/zoom.rs): Reuse Slides brings the checked slides of another presentation in after the
// current slide (keeping the destination's look, or the source master); Insert > Zoom puts a picture of a slide (or a summary
// slide of pictures) that jumps to it in the show. PowerPoint: the same.
// What this proves in the app: the real dialogs open from the ribbon, the checklists show the slides, the reused slides and
// the zoom pictures (the slides really drawn) land on the slide, as looked at in the captures. Captures in artifacts/e2e/prism/reuse-zoom/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';
import {exportPptx} from '../../../core/prism/formats/pptx-write.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('prism reuse slides and zoom: dialogs, reused slides, zoom pictures', {timeout: 300_000}, async () => {
  // The other presentation: three titled slides, the second with a coloured box so it is recognisable when drawn.
  const other = createFile('prism', 'Other deck', {schema: 2});
  const c = other.content;
  const lay = c.masters[0].layouts.find(l => l.kind === 'titleOnly').id;
  c.slides = ['Roadmap', 'Pricing', 'Team'].map((t, i) => {
    const sl = structuredClone(c.slides[0]);
    sl.id = String(7000 + i);
    sl.layout = lay;
    sl.shapes = sl.shapes.filter(s => s.ph?.kind === 'title' || s.ph?.kind === 'ctrTitle').slice(0, 1);
    sl.shapes[0].id = String(7100 + i);
    sl.shapes[0].text = bodyFromText(t);
    return sl;
  });
  const data = Buffer.from(await exportPptx(c)).toString('base64');

  const file = createFile('prism', 'Zoom deck', {schema: 2});
  file.id = 'prism-reuse-zoom';
  file.content.slides[0].shapes[0].text = bodyFromText('Welcome');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/reuse-zoom', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const activate = control => app.rpc('ui.activate', {doc, control});
  const title = sl => (sl.shapes.find(s => s.ph?.kind === 'title' || s.ph?.kind === 'ctrTitle')?.text?.paragraphs ?? []).map(p => p.runs.map(r => r.text ?? '').join('')).join('');
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});

    // Reuse Slides from the Home tab's New Slide menu.
    await app.rpc('ui.tab', {doc, tab: 'home'});
    await app.rpc('ui.menu', {doc, control: 'home.slides.new-slide'});
    await sleep(400);
    await app.capture('1-new-slide-menu');
    await activate('home.slides.new-slide.reuse-slides');
    await sleep(500);
    let dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.reuseSlides');
    await app.capture('2-reuse-dialog-empty');
    const list = [{index: 0, title: 'Roadmap', hidden: false}, {index: 1, title: 'Pricing', hidden: false}, {index: 2, title: 'Team', hidden: false}];
    await app.rpc('ui.dialog.set', {field: 'data', value: data});
    await app.rpc('ui.dialog.set', {field: 'name', value: 'Other deck.pptx'});
    await app.rpc('ui.dialog.set', {field: 'list', value: list});
    await app.rpc('ui.dialog.set', {field: 'picked', value: [0, 2]});
    await sleep(400);
    await app.capture('3-reuse-dialog-filled');
    await app.rpc('ui.dialog.submit', {});
    await sleep(1000);
    let d = await deck();
    assert.deepEqual(d.slides.map(title), ['Welcome', 'Roadmap', 'Team']);
    await app.capture('4-reused-slides');

    // Slide Zoom, then Summary Zoom, from Insert > Zoom.
    await run('slide.go', {index: 0});
    await app.rpc('ui.tab', {doc, tab: 'insert'});
    await app.rpc('ui.menu', {doc, control: 'insert.links.zoom'});
    await sleep(400);
    await app.capture('5-zoom-menu');
    await activate('insert.links.zoom.slide-zoom');
    await sleep(500);
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.insertZoom');
    assert.equal(dlg.values.list.length, 3);
    await app.capture('6-slide-zoom-dialog');
    await app.rpc('ui.dialog.set', {field: 'picked', value: [1]});
    await app.rpc('ui.dialog.submit', {});
    await sleep(1500);
    d = await deck();
    const zoomPic = d.slides[0].shapes.find(s => s.kind?.type === 'picture' && /Zoom/.test(s.name));
    assert.ok(zoomPic, 'a zoom picture is on the first slide');
    assert.equal(zoomPic.click.action.slide, d.slides[1].id);
    const media = d.media.find(m => m.id === zoomPic.kind.fill.media);
    assert.equal(media.contentType, 'image/png', 'the slide drawn to a picture');
    await app.capture('7-slide-zoom-on-slide');

    await app.rpc('ui.menu', {doc, control: 'insert.links.zoom'});
    await sleep(300);
    await activate('insert.links.zoom.summary-zoom');
    await sleep(500);
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.insertZoomSummary');
    await app.rpc('ui.dialog.set', {field: 'picked', value: [0, 1, 2]});
    await app.rpc('ui.dialog.submit', {});
    await sleep(1800);
    d = await deck();
    assert.equal(title(d.slides[0]), 'Summary');
    assert.equal(d.slides[0].shapes.filter(s => s.kind?.type === 'picture').length, 3);
    await app.capture('8-summary-zoom');
  } finally {
    await app.close();
  }
});
