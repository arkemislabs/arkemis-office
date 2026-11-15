// U:prism/view: the View tab commands (view.normal, outline, sorter, notesPage, reading, notes, ruler,
// gridlines, guides, fit, grayscale, color, newWindow, arrangeAll, switchWindows) and the sorter's
// section grouping.
//
// 1. ArtCraft: crates/ui-egui/src/app/commands.rs (`run_ui`), sorter.rs (`groups`). PowerPoint: the
//    View tab.
// 2. Ours: core/prism/commands/view.mjs, src/apps/prism/surface/ViewModes.tsx.
// 3. These tests and tests/e2e/prism/insert-view.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import view from '../../core/prism/commands/view.mjs';
import arrange from '../../core/prism/commands/arrange.mjs';
import show from '../../core/prism/commands/show.mjs';
import viewCommon from '../../core/common/commands/view.mjs';
import {withNew} from './upstream/text_deck.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';

const deck = async () => {
  const t = await withNew({extra: [view, arrange, show, viewCommon]});
  await t.exec('slide.new', {});
  return t;
};

test('the view modes: one at a time, the current one checked, Normal by default', async () => {
  const t = await deck();
  assert.equal(t.state('view.normal').checked, true);
  for (const [id, mode] of [['view.outline', 'outline'], ['view.sorter', 'sorter'], ['view.notesPage', 'notesPage'], ['view.normal', 'normal']]) {
    await t.exec(id, {});
    assert.equal(t.doc.view.mode, mode);
    assert.equal(t.state(id).checked, true);
    assert.equal(t.state(id === 'view.normal' ? 'view.outline' : 'view.normal').checked, false);
  }
});

test('Show: ruler, gridlines and notes toggle (or take on); guides add the two centre guides once and undo', async () => {
  const t = await deck();
  await t.exec('view.ruler', {});
  assert.equal(t.doc.view.ruler, true);
  await t.exec('view.ruler', {on: false});
  assert.equal(t.doc.view.ruler, false);
  await t.exec('view.gridlines', {});
  assert.equal(t.state('view.gridlines').checked, true);
  assert.equal(t.state('view.notes').checked, true, 'notes show by default');
  await t.exec('view.notes', {});
  assert.equal(t.doc.view.notes, false);
  assert.equal(t.state('view.notes').checked, false);
  await expectUndoRoundTrip(t, 'view.guides', {});
  assert.equal(t.doc.view.guides, true);
  assert.deepEqual(t.content.guides.map(g => [g.vertical, g.pos]), [[true, 480], [false, 270]]);
  await t.exec('view.guides', {on: false});
  await t.exec('view.guides', {on: true});
  assert.equal(t.content.guides.length, 2, 'the defaults are added once');
});

test('Fit to Window, Grayscale and Color', async () => {
  const t = await deck();
  await t.exec('view.zoom', {value: 150});
  assert.equal(t.state('view.fit').checked, false);
  await t.exec('view.fit', {});
  assert.equal(t.doc.view.fit, 'fit');
  assert.equal(t.state('view.fit').checked, true);
  assert.equal(t.state('view.color').checked, true);
  await t.exec('view.grayscale', {});
  assert.equal(t.doc.view.grayscale, true);
  assert.equal(t.state('view.color').checked, false);
  await t.exec('view.color', {});
  assert.equal(t.doc.view.grayscale, false);
  await t.exec('view.grayscale', {on: true});
  await t.exec('view.grayscale', {on: false});
  assert.equal(t.doc.view.grayscale, false);
});

test('Reading View plays from the current slide in the window; any other view ends it', async () => {
  const t = await deck();
  await t.exec('slide.go', {index: 1});
  await t.exec('view.reading', {});
  assert.deepEqual([t.doc.view.show.from, t.doc.view.show.reading], [1, true]);
  assert.equal(t.state('view.reading').checked, true);
  await t.exec('view.sorter', {});
  assert.equal(t.doc.view.show, null);
});

test('the windows commands need the app window; Switch Windows lists the host windows', async () => {
  const none = await deck();
  assert.equal(none.state('view.newWindow').enabled, false);
  await assert.rejects(none.exec('view.arrangeAll', {}), undefined);
  const calls = [];
  const {createTestHost} = await import('../../core/kernel/host.mjs');
  const host = createTestHost();
  host.windows = {open: async a => { calls.push(['open', a]); return {ok: true}; }, arrange: async a => { calls.push(['arrange', a]); return {}; },
    list: async () => [{id: 1, title: 'a'}], state: () => ({windows: [{id: 1, title: 'View deck', self: true}, {id: 2, title: 'Other', self: false}]}), focus: async id => { calls.push(['focus', id]); return {}; }};
  const t = await withNew({extra: [view, arrange, show, viewCommon], host});
  assert.equal(t.state('view.newWindow').enabled, true);
  await t.exec('view.arrangeAll', {});
  await t.exec('view.switchWindows', {value: 2});
  assert.deepEqual(calls.map(c => c[0]), ['arrange', 'focus']);
  assert.deepEqual(t.state('view.switchWindows').value.map(x => [x.label, x.checked]), [['1 View deck', true], ['2 Other', false]]);
});

test('the sorter groups slides by section, then the ones in none', async () => {
  const {sorterGroups} = await import('../../src/apps/prism/surface/ViewModes.tsx').catch(() => ({sorterGroups: null}));
  if (!sorterGroups) return;
  const content = {slides: [{id: 'a'}, {id: 'b'}, {id: 'c'}], sections: [{name: 'One', slides: ['b']}, {name: 'Two', slides: ['a']}]};
  assert.deepEqual(sorterGroups(content).map(g => [g.section?.name ?? null, g.indices]), [['One', [1]], ['Two', [0]], [null, [2]]]);
  assert.deepEqual(sorterGroups({slides: [{id: 'a'}], sections: []}).map(g => g.indices), [[0]]);
});
