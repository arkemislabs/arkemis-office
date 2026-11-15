// Prism's master views through the bridge and the real window (U:prism/masters).
//
// What deckcraft does (ribbon/masters.rs, engine design/master_view.rs): View > Slide Master opens the
// master and its layouts with a Slide Master tab (Insert Layout, Delete, Rename, Preserve, Title,
// Footers, Insert Placeholder, Themes, Background Styles, Close Master View); Handout Master and Notes
// Master open their own tabs with their placeholder check boxes. PowerPoint: the same.
// What this proves in the app: the real controls (ui.activate, ui.menu, ui.dialog.*) open each master
// view, show its contextual tab, change the master as the engine tests do, and Close Master View goes
// back (looked at in the captures). Captures in artifacts/e2e/prism/masters/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('prism masters: slide master, layouts, handout master, notes master', {timeout: 300_000}, async () => {
  const file = createFile('prism', 'Masters deck', {schema: 2});
  file.id = 'prism-masters';
  file.content.slides[0].shapes[0].text = bodyFromText('Quarterly review');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/masters', files: [file], renderer});
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
    await run('slide.go', {index: 1});
    await app.rpc('ui.tab', {doc, tab: 'view'});
    let ui = await inspect();
    const ctl = id => ui.controls.find(c => c.id === id);
    assert.ok(ctl('view.masters.slide') && ctl('view.masters.handout') && ctl('view.masters.notes'), 'the master buttons are drawn');

    // Slide Master: the tab, the layouts, Insert Layout, Rename, Preserve, Title, Footers, Insert Placeholder.
    await activate('view.masters.slide');
    await app.until(async () => { const u = await app.rpc('ui.inspect', {doc}); return u.contextualTabs?.includes('slide-master') || null; }, {timeout: 10_000});
    await app.rpc('ui.tab', {doc, tab: 'slide-master'});
    await sleep(600);
    ui = await inspect();
    for (const id of ['slidemaster.edit.insert-layout', 'slidemaster.edit.delete', 'slidemaster.edit.rename', 'slidemaster.edit.preserve', 'slidemaster.layout.title', 'slidemaster.layout.footers',
      'slidemaster.layout.insert-placeholder', 'slidemaster.theme.themes', 'slidemaster.background.styles', 'slidemaster.close.close']) assert.ok(ctl(id), `${id} is drawn`);
    for (const id of ['slidemaster.edit.insert-master', 'slidemaster.layout.master-layout']) assert.equal(ctl(id), undefined, `${id} is hidden`);
    await app.capture('1-slide-master');
    const n = (await deck()).masters[0].layouts.length;
    await activate('slidemaster.edit.insert-layout');
    await sleep(500);
    let d = await deck();
    assert.equal(d.masters[0].layouts.length, n + 1);
    await activate('slidemaster.edit.rename');
    let dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.renameLayout');
    await app.rpc('ui.dialog.set', {field: 'name', value: 'Brand layout'});
    await app.capture('2-rename-layout-dialog');
    await app.rpc('ui.dialog.submit', {});
    d = await deck();
    assert.ok(d.masters[0].layouts.some(l => l.name === 'Brand layout'));
    ui = await inspect();
    assert.equal(ctl('slidemaster.edit.preserve').checked, true);
    await activate('slidemaster.edit.preserve', false);
    d = await deck();
    assert.equal(d.masters[0].layouts.find(l => l.name === 'Brand layout').preserve, false);
    await activate('slidemaster.layout.footers', true);
    await app.rpc('ui.menu', {doc, control: 'slidemaster.layout.insert-placeholder'});
    await app.capture('3-insert-placeholder-menu');
    await app.rpc('ui.menu', {doc, control: 'slidemaster.layout.insert-placeholder', open: false});
    await activate('slidemaster.layout.insert-placeholder.picture');
    await sleep(500);
    d = await deck();
    const brand = d.masters[0].layouts.find(l => l.name === 'Brand layout');
    assert.ok(brand.shapes.some(s => s.ph?.kind === 'picture') && brand.shapes.some(s => s.ph?.kind === 'footer'));
    await app.capture('4-brand-layout');
    // The layout is edited on the canvas like a slide: click a placeholder, drag it, type into it.
    {
      const lay = (await deck()).masters[0].layouts.find(l => l.name === 'Brand layout');
      const pic = lay.shapes.find(s => s.ph?.kind === 'picture');
      const cx = pic.xfrm.x + pic.xfrm.w / 2, cy = pic.xfrm.y + pic.xfrm.h / 2;
      await app.rpc('ui.pointer', {doc, events: [{kind: 'down', x: cx, y: cy}, {kind: 'drag', x: cx + 60, y: cy + 40}, {kind: 'up', x: cx + 60, y: cy + 40}]});
      await sleep(400);
      const moved = (await deck()).masters[0].layouts.find(l => l.name === 'Brand layout').shapes.find(s => s.id === pic.id);
      assert.ok(Math.abs(moved.xfrm.x - (pic.xfrm.x + 60)) < 6 && Math.abs(moved.xfrm.y - (pic.xfrm.y + 40)) < 6, `dragging a layout placeholder moves it: ${JSON.stringify(pic.xfrm)} -> ${JSON.stringify(moved.xfrm)}`);
      await app.capture('4b-layout-placeholder-dragged');
      const title = lay.shapes.find(s => s.ph?.kind === 'title');
      const tx = title.xfrm?.x ?? 60, ty = title.xfrm?.y ?? 30;
      await app.rpc('ui.pointer', {doc, events: [{kind: 'down', x: tx + 20, y: ty + 20}, {kind: 'up', x: tx + 20, y: ty + 20}, {kind: 'doubleClick', x: tx + 20, y: ty + 20}]});
      for (const ch of 'Brand title') await app.rpc('ui.type', {doc, text: ch});
      await sleep(300);
      const typed = (await deck()).masters[0].layouts.find(l => l.name === 'Brand layout').shapes.find(s => s.id === title.id);
      assert.match(typed.text.paragraphs.map(p => p.runs.map(r => r.text ?? '').join('')).join('\n'), /Brand title/, 'typing in a layout placeholder');
      await app.capture('4c-layout-placeholder-typed');
      await app.rpc('ui.key', {doc, key: 'Escape'}).catch(() => {});
    }
    // Background Styles opens the Format Background pane on the open layout.
    await activate('slidemaster.background.styles');
    await app.until(async () => { const u = await app.rpc('ui.inspect', {doc}); return u.panes?.some(p => /background/.test(p.id) && p.open) || null; }, {timeout: 10_000});
    await run('design.background', {color: '#dfe8f5'});
    await sleep(700);
    await app.capture('5-layout-background-pane');
    assert.ok((await deck()).masters[0].layouts.find(l => l.name === 'Brand layout').background);
    await app.rpc('ui.pane', {doc, id: 'background', open: false});
    await run('view.slideMaster', {master: 0});
    await sleep(500);
    await app.capture('6-master-itself');
    await activate('slidemaster.close.close');
    await sleep(500);
    ui = await inspect();
    assert.equal(ui.contextualTabs.includes('slide-master'), false, 'the Slide Master tab closes');
    await app.capture('7-back-to-slides');

    // Handout Master.
    await app.rpc('ui.tab', {doc, tab: 'view'});
    await activate('view.masters.handout');
    await app.rpc('ui.tab', {doc, tab: 'handout-master'});
    await sleep(600);
    ui = await inspect();
    assert.ok(ctl('handoutmaster.placeholders.header') && ctl('handoutmaster.setup.per-page') && ctl('handoutmaster.close.close'));
    assert.equal(ctl('handoutmaster.setup.orientation'), undefined, 'page orientation is hidden');
    assert.equal(ctl('handoutmaster.placeholders.header').checked, true);
    await app.capture('8-handout-master');
    await activate('handoutmaster.placeholders.header', false);
    d = await deck();
    assert.ok(!d.handoutMaster.shapes.some(s => s.ph?.kind === 'header'));
    await sleep(400);
    await app.capture('9-handout-header-off');
    await activate('handoutmaster.close.close');

    // Notes Master.
    await app.rpc('ui.tab', {doc, tab: 'view'});
    await activate('view.masters.notes');
    await app.rpc('ui.tab', {doc, tab: 'notes-master'});
    await sleep(600);
    ui = await inspect();
    assert.ok(ctl('notesmaster.placeholders.slideImage') && ctl('notesmaster.placeholders.body'));
    await app.capture('10-notes-master');
    await activate('notesmaster.placeholders.body', false);
    d = await deck();
    assert.ok(!d.notesMaster.shapes.some(s => s.ph?.kind === 'body'));
    await sleep(400);
    await app.capture('11-notes-body-off');
    await activate('notesmaster.close.close');
  } finally {
    await app.close();
  }
});
