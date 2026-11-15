// U:grid/view: the Window group (New Window, Arrange All, Hide, Unhide, View Side by Side, Synchronous
// Scrolling, Reset Window Position, Switch Windows) against a window service that records what it is asked,
// and the dialogs that go with them.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/windows.rs (new_window, hide_window, unhide_window, window_list)
//    and cmd/extra/window.rs (arrange_all: tiled / horizontal / vertical / cascade, activeWorkbook, the active
//    window first; hide_window; unhide_window; switch_windows) at fb1e59f, dialogs.rs:234 (Arrange Windows).
//    View Side by Side, Synchronous Scrolling and Reset Window Position are not in gridcraft: Excel's.
// 2. Ours: a window is the application's window service (electron/preload.cjs `windows`), not an engine value.
// 3. These tests; tests/e2e/grid/view.e2e.mjs drives the ribbon.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import {workbook} from './edit-helpers.mjs';
import arrangeAll from '../../core/grid/dialogs/arrangeAll.mjs';
import unhideWindow from '../../core/grid/dialogs/unhideWindow.mjs';
import compareSideBySide from '../../core/grid/dialogs/compareSideBySide.mjs';

/** A window service with `n` windows; the first is this one. `arrange` keeps the state the main process keeps. */
function windowsHost(n = 1, answer = null) {
  const calls = [];
  const asked = [];
  const list = Array.from({length: n}, (_, i) => ({id: i + 1, title: n > 1 ? `Book1:${i + 1}` : 'Book1', doc: 'doc1', self: i === 0, hidden: false}));
  let st = {windows: list, sideBySide: false, syncScroll: false};
  const windows = {
    state: () => st,
    list: async () => st.windows,
    open: async req => {
      calls.push(['open', req]);
      st = {...st, windows: [...st.windows.map((w, i) => ({...w, title: `Book1:${i + 1}`})), {id: st.windows.length + 1, title: `Book1:${st.windows.length + 1}`, doc: req.doc, self: false, hidden: false}]};
      return {window: st.windows.length, doc: req.doc};
    },
    focus: async id => { calls.push(['focus', id]); return {window: id}; },
    arrange: async req => {
      calls.push(['arrange', req]);
      if (req.mode === 'sideBySide') st = {...st, sideBySide: true, syncScroll: true};
      if (req.mode === 'off') st = {...st, sideBySide: false, syncScroll: false};
      if (req.mode === 'syncScroll') st = {...st, syncScroll: req.value};
      if (req.mode === 'hide') st = {...st, windows: st.windows.map(w => (w.id === req.with ? {...w, hidden: true} : w))};
      if (req.mode === 'unhide') st = {...st, windows: st.windows.map(w => (w.id === req.with ? {...w, hidden: false} : w))};
      return st;
    },
  };
  const saved = [];
  const host = createTestHost({windows, openDialog: async (id, init) => { asked.push([id, init]); return answer; }, save: async file => { saved.push(file); return {revision: 1}; }});
  return {host, calls, saved, asked, state: () => st};
}
const session = (w, opts = {}) => createTestSession('grid', {host: w.host, content: workbook(), ...opts});

test('New Window writes the working copy, then asks for a window on the document; Switch Windows lists them numbered, the current one checked', async () => {
  const w = windowsHost();
  const t = await session(w);
  assert.equal(t.state('view.newWindow').enabled, true);
  assert.deepEqual((await t.exec('view.newWindow')).result, {window: 2, doc: t.docId});
  assert.equal(w.saved.length, 1, 'the new window reads what this one has');
  assert.deepEqual(t.state('view.switchWindows').value.map(x => [x.label, x.checked]), [['1 Book1:1', true], ['2 Book1:2', false]]);
  assert.deepEqual((await t.exec('view.switchWindows')).result.windows.map(x => x.title), ['Book1:1', 'Book1:2']);
  await t.exec('view.switchWindows', {value: 2});
  assert.deepEqual(w.calls.at(-1), ['focus', 2]);
  assert.equal(t.session.get(t.docId).undo.size, 0, 'a window is not an edit');
});

test('Arrange All: tiled by default, the four arrangements, activeWorkbook; returns the visible windows', async () => {
  const w = windowsHost(3);
  const t = await session(w);
  const r = (await t.exec('view.arrangeAll')).result;
  assert.deepEqual(r, {arrange: 'tiled', windows: [1, 2, 3]});
  for (const arrange of ['horizontal', 'vertical', 'cascade']) await t.exec('view.arrangeAll', {arrange});
  await t.exec('view.arrangeAll', {arrange: 'tiled', activeWorkbook: true});
  assert.deepEqual(w.calls.map(c => c[1].mode), ['tiled', 'horizontal', 'vertical', 'cascade', 'tiled']);
  assert.equal(w.calls.at(-1)[1].activeWorkbook, true);
  await assert.rejects(t.exec('view.arrangeAll', {arrange: 'diagonal'}), e => e.code === 'invalid_params');
});

test('the Arrange Windows dialog: Tiled and "Windows of active workbook" off, submit runs view.arrangeAll', () => {
  assert.deepEqual(arrangeAll.init(), {arrange: 'tiled', activeWorkbook: false});
  assert.deepEqual(arrangeAll.toCommand({arrange: 'cascade', activeWorkbook: true}), {command: 'view.arrangeAll', params: {arrange: 'cascade', activeWorkbook: true}});
  assert.equal(arrangeAll.validate({arrange: 'nope'}).length, 1);
});

test('Hide needs another visible window; Unhide lists the hidden ones and brings one back', async () => {
  const w = windowsHost();
  const t = await session(w);
  assert.equal(t.state('view.hideWindow').enabled, false, 'the only window cannot be hidden');
  assert.equal(t.state('view.unhideWindow').enabled, false, 'nothing is hidden');
  await t.exec('view.newWindow');
  assert.equal(t.state('view.hideWindow').enabled, true);
  await t.exec('view.hideWindow');
  assert.deepEqual(w.calls.at(-1), ['arrange', {mode: 'hide', with: 1}]);
  assert.deepEqual(t.state('view.switchWindows').value.map(x => x.label), ['1 Book1:2'], 'a hidden window is not listed');
  assert.equal(t.state('view.unhideWindow').enabled, true);
  const init = unhideWindow.init(t.session.readContext(t.docId));
  assert.deepEqual(init, {windows: [{id: 1, title: 'Book1:1'}], window: 1});
  assert.deepEqual(unhideWindow.toCommand(init), {command: 'view.unhideWindow', params: {window: 1}});
  assert.equal(unhideWindow.validate({windows: [], window: null}).length, 1);
  await t.exec('view.unhideWindow', {window: 1});
  assert.deepEqual(w.calls.at(-1), ['arrange', {mode: 'unhide', with: 1}]);
  await t.exec('view.hideWindow');
  await assert.rejects(t.exec('view.unhideWindow', {window: 9}), e => e.code === 'invalid_params');
});

test('View Side by Side, Synchronous Scrolling and Reset Window Position follow the pair', async () => {
  const w = windowsHost();
  const t = await session(w);
  assert.equal(t.state('view.sideBySide').enabled, false, 'one window: nothing to compare with');
  assert.equal(t.state('view.syncScroll').enabled, false);
  assert.equal(t.state('view.resetWindowPosition').enabled, false);
  await t.exec('view.newWindow');
  assert.equal(t.state('view.sideBySide').enabled, true);
  await t.exec('view.sideBySide');
  assert.equal(t.state('view.sideBySide').checked, true);
  assert.equal(t.state('view.syncScroll').checked, true, 'Synchronous Scrolling comes on with it (Excel)');
  await t.exec('view.syncScroll');
  assert.equal(t.state('view.syncScroll').checked, false);
  await t.exec('view.resetWindowPosition');
  await t.exec('view.sideBySide');
  assert.equal(t.state('view.sideBySide').checked, false);
  assert.deepEqual(w.calls.map(c => (c[0] === 'arrange' ? `arrange:${c[1].mode}` : c[0])), ['open', 'arrange:sideBySide', 'arrange:syncScroll', 'arrange:reset', 'arrange:off']);
});

test('Compare Side by Side: the dialog lists the other windows and answers with the one picked', async () => {
  const w = windowsHost(3, {with: 3});
  const asked = w.asked;
  const t = await session(w);
  await t.exec('view.sideBySide', {}, {origin: 'ui'});
  assert.equal(asked[0][0], 'dialog.compareSideBySide');
  assert.deepEqual(asked[0][1].windows.map(x => x.id), [2, 3]);
  assert.deepEqual(w.calls.at(-1), ['arrange', {mode: 'sideBySide', with: 3}]);
  assert.deepEqual(compareSideBySide.toCommand({windows: [{id: 2}], with: 2}), {command: 'view.sideBySide', params: {with: 2}});
  assert.equal(compareSideBySide.validate({windows: [{id: 2}], with: 5}).length, 1);
});

test('headless there are no windows: the commands say so', async () => {
  const t = await createTestSession('grid', {content: workbook()});
  for (const id of ['view.newWindow', 'view.arrangeAll', 'view.hideWindow', 'view.unhideWindow', 'view.sideBySide', 'view.switchWindows']) {
    assert.equal(t.state(id).enabled, false, id);
  }
  await assert.rejects(t.exec('view.newWindow'), e => e.code === 'disabled' || e.code === 'unavailable');
});
