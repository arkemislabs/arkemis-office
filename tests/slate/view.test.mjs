// U:slate/view: OneNote's View tab (Views, Immersive Reader, Show, Page Width, Window).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `view.*` and `window.*` name the
//    commands. OneNote's behaviour: Normal View and Full Page View (only the page), the navigation
//    panes (notebook list, page list) turned off and on, the section tabs along the top or down the
//    side, Switch Background for a dark page, the Immersive Reader, Page Width zoom, New Window,
//    New Docked Window, Dock to Desktop and Always on Top.
// 2. Ours does the same as view state (this document's session) or preferences (tabs layout, dark
//    page), and the window commands call the app's window service.
// 3. Proof: these tests and tests/e2e/slate/home-view.e2e.mjs (ribbon, surface, captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestHost} from '../../core/kernel/host.mjs';
import {DARK_PAGE_PREF, PANES, TABS_LAYOUT_PREF, panesOf, readerOf} from '../../core/slate/commands/view.mjs';
import {textSession, textSel} from './format-helpers.mjs';

const view = t => t.doc.view ?? {};
const windows = () => {
  const calls = [];
  let st = {docked: false, alwaysOnTop: false, windows: []};
  return {calls, open: async req => { calls.push(['open', req]); return {window: 2, doc: req.doc}; }, state: () => st,
    dock: async on => { calls.push(['dock', on]); st = {...st, docked: on}; }, pin: async on => { calls.push(['pin', on]); st = {...st, alwaysOnTop: on}; }};
};

test('Normal View and Full Page View: one or the other, and Normal View leaves the reader too', async () => {
  const t = await textSession(['Page text'], {selection: p => textSel(p, 'b1', 2)});
  assert.equal(t.state('view.mode', {mode: 'normal'}).checked, true);
  assert.equal(t.state('view.fullPage').checked, false);
  await t.exec('view.fullPage');
  assert.equal(view(t).fullPage, true);
  assert.equal(t.state('view.mode', {mode: 'normal'}).checked, false);
  assert.equal(t.state('view.fullPage').checked, true);
  await t.exec('view.mode', {mode: 'normal'});
  assert.equal(view(t).fullPage, false);
  await t.exec('view.immersiveReader', {value: true});
  assert.equal(t.state('view.mode', {mode: 'normal'}).checked, false, 'in the reader, not Normal View');
  await t.exec('view.mode', {mode: 'normal'});
  assert.equal(view(t).immersive.on, false);
  await t.exec('view.fullPage', {value: true});
  await t.exec('view.fullPage', {value: false});
  assert.equal(view(t).fullPage, false);
});

test('Show > Navigation Panes turns the navigation, the notebook list and the page list off and on', async () => {
  const t = await textSession(['x'], {selection: p => textSel(p, 'b1', 0)});
  assert.deepEqual(panesOf(view(t)), {navigation: true, notebooks: true, pages: true});
  assert.equal(t.state('view.navigationPanes', {pane: 'pages'}).checked, true);
  await t.exec('view.navigationPanes', {pane: 'pages'});
  assert.deepEqual(panesOf(view(t)), {navigation: true, notebooks: true, pages: false});
  assert.equal(t.state('view.navigationPanes', {pane: 'pages'}).checked, false);
  await t.exec('view.navigationPanes', {pane: 'notebooks', value: false});
  assert.deepEqual(panesOf(view(t)), {navigation: true, notebooks: false, pages: false});
  await t.exec('view.navigationPanes', {pane: 'navigation'});
  assert.equal(panesOf(view(t)).navigation, false);
  assert.equal(t.state('view.navigationPanes').checked, false, 'the menu is not all on');
  const back = await t.exec('view.navigationPanes', {});
  assert.deepEqual(back.result, {navigation: true, notebooks: true, pages: true}, 'with no pane, all three come back');
  assert.equal(PANES.length, 3);
});

test('Tabs Layout and Switch Background are saved as preferences', async () => {
  const t = await textSession(['x'], {selection: p => textSel(p, 'b1', 0)});
  assert.equal(t.state('view.tabsLayout', {layout: 'horizontal'}).checked, true);
  assert.equal(t.state('view.tabsLayout', {layout: 'vertical'}).checked, false);
  await t.exec('view.tabsLayout', {layout: 'vertical'});
  assert.equal(t.session.prefs[TABS_LAYOUT_PREF], 'vertical');
  assert.equal(t.state('view.tabsLayout', {layout: 'vertical'}).checked, true);
  await t.exec('view.tabsLayout', {layout: 'horizontal'});
  assert.equal(t.session.prefs[TABS_LAYOUT_PREF], 'horizontal');
  assert.equal(t.state('view.switchBackground').checked, false);
  await t.exec('view.switchBackground');
  assert.equal(t.session.prefs[DARK_PAGE_PREF], true);
  assert.equal(t.state('view.switchBackground').checked, true);
  await t.exec('view.switchBackground');
  assert.equal(t.session.prefs[DARK_PAGE_PREF], false);
  await t.exec('view.switchBackground', {value: true});
  assert.equal(t.state('view.switchBackground').checked, true);
});

test('Immersive Reader: on and off, text size, spacing, theme and Line Focus are its state', async () => {
  const t = await textSession(['Read me'], {selection: p => textSel(p, 'b1', 0)});
  assert.deepEqual(readerOf(view(t)), {size: 2, spacing: false, theme: 'white', lineFocus: 0});
  assert.equal(t.state('view.immersiveReader').checked, false);
  await t.exec('view.immersiveReader');
  assert.equal(view(t).immersive.on, true);
  await t.exec('view.immersiveReader', {textSize: 4, spacing: true, theme: 'sepia', lineFocus: 3});
  assert.deepEqual(readerOf(view(t)), {size: 4, spacing: true, theme: 'sepia', lineFocus: 3});
  assert.equal(view(t).immersive.on, true, 'an option keeps it on');
  assert.deepEqual(t.state('view.immersiveReader').value, {size: 4, spacing: true, theme: 'sepia', lineFocus: 3});
  await t.exec('view.immersiveReader', {value: false});
  assert.equal(view(t).immersive.on, false);
  assert.equal(readerOf(view(t)).size, 4, 'the options are kept for next time');
  await assert.rejects(t.exec('view.immersiveReader', {textSize: 9}));
  await assert.rejects(t.exec('view.immersiveReader', {lineFocus: 2}));
});

test('Page Width asks for the page-width zoom; a percent drops it', async () => {
  const t = await textSession(['x'], {selection: p => textSel(p, 'b1', 0)});
  const r = await t.exec('view.zoomPageWidth');
  assert.equal(r.result.fit, 'pageWidth');
  assert.equal(view(t).fit, 'pageWidth');
  await t.exec('view.zoom', {value: 130});
  assert.deepEqual([view(t).zoom, view(t).fit], [130, null]);
});

test('New Window, New Docked Window, Dock to Desktop and Always on Top call the window service; outside the application window they are disabled', async () => {
  const w = windows();
  const t = await textSession(['x'], {selection: p => textSel(p, 'b1', 0), host: createTestHost({windows: w})});
  for (const id of ['window.new', 'window.newDocked', 'window.alwaysOnTop', 'view.dock']) assert.equal(t.state(id).enabled, true, id);
  await t.exec('window.new');
  await t.exec('window.newDocked');
  assert.deepEqual(w.calls, [['open', {doc: t.docId}], ['open', {doc: t.docId, docked: true}]]);
  assert.equal(t.state('window.alwaysOnTop').checked, false);
  await t.exec('window.alwaysOnTop');
  assert.equal(t.state('window.alwaysOnTop').checked, true);
  await t.exec('window.alwaysOnTop');
  assert.equal(t.state('window.alwaysOnTop').checked, false);
  await t.exec('view.dock');
  assert.equal(t.state('view.dock').checked, true);
  await t.exec('view.dock', {value: false});
  assert.deepEqual(w.calls.slice(2), [['pin', true], ['pin', false], ['dock', true], ['dock', false]]);
  const bare = await textSession(['x'], {selection: p => textSel(p, 'b1', 0)});
  for (const id of ['window.new', 'window.newDocked', 'window.alwaysOnTop', 'view.dock']) {
    assert.equal(bare.state(id).enabled, false, id);
    assert.match(bare.state(id).reason, /application window/);
  }
  await assert.rejects(bare.exec('window.new'));
});

test('Send to OneNote Tool is not registered; the rest of the View tab is', async () => {
  const t = await textSession(['x']);
  assert.equal(t.registry.has('window.sendToTool'), false);
  for (const id of ['view.mode', 'view.fullPage', 'view.dock', 'view.immersiveReader', 'view.navigationPanes', 'view.tabsLayout', 'view.switchBackground', 'view.zoomPageWidth', 'window.new', 'window.newDocked', 'window.alwaysOnTop']) assert.ok(t.registry.has(id), id);
});
