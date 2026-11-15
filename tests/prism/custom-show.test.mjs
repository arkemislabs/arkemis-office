// U:prism/custom-show: the Custom Shows dialog (deckcraft body.rs dlg_custom_show) over show.customShow and show.start.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {openDialogModel, submitDialog} from '../../core/kernel/dialog.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {slide as newSlide} from '../../core/prism/model/presentation.mjs';
import dialog from '../../core/prism/dialogs/customShow.mjs';

async function session() {
  const c = createContent('Shows');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.slides = ['s1', 's2', 's3', 's4'].map(id => newSlide({id, layout, shapes: []}));
  return createTestSession('prism', {content: c, selection: {ranges: [{anchor: '/sl:s1', focus: '/sl:s1'}], primary: 0}});
}
const shows = t => t.session.get(t.docId).file.content.customShows ?? [];

test('the dialog starts with a free name, needs a name and slides, and Save creates the show in the chosen order', async () => {
  const t = await session();
  const v = openDialogModel(t.session, t.docId, dialog);
  assert.equal(v.name, 'Custom Show 1');
  assert.match(dialog.validate({...v, name: ' '})[0].message, /name/);
  assert.match(dialog.validate(v)[0].message, /at least one slide/);
  await submitDialog(t.session, t.docId, dialog, {...v, chosen: [2, 0, 3]});
  assert.deepEqual(shows(t).map(s => [s.name, s.slides]), [['Custom Show 1', ['s3', 's1', 's4']]]);
  const again = openDialogModel(t.session, t.docId, dialog);
  assert.equal(again.name, 'Custom Show 2');
  assert.match(dialog.validate({...again, name: 'Custom Show 1', chosen: [0]})[0].message, /already exists/);
});

test('editing under a new name replaces the old show; show.start plays a custom show and refuses an unknown one', async () => {
  const t = await session();
  await t.exec('show.customShow', {name: 'Intro', slides: [0, 1]});
  const v = {name: 'Opening', orig: 'Intro', chosen: [1], existing: ['Intro']};
  assert.deepEqual(dialog.validate(v), []);
  await submitDialog(t.session, t.docId, dialog, v);
  assert.deepEqual(shows(t).map(s => [s.name, s.slides]), [['Opening', ['s2']]]);
  await t.exec('show.start', {custom: 'Opening'});
  assert.equal(t.session.get(t.docId).view.show.custom, 'Opening');
  await assert.rejects(t.exec('show.start', {custom: 'Nope'}), /no custom show/);
  await t.exec('show.customShow', {name: 'Opening', delete: true});
  assert.deepEqual(shows(t), []);
});

test('show.rehearse starts the show with a clock; show.rehearsed turns the times into Advance Slide After times and ends it', async () => {
  const t = await session();
  await t.exec('show.rehearse', {current: true});
  assert.equal(t.session.get(t.docId).view.show.rehearse, true);
  assert.equal(t.session.get(t.docId).view.show.from, 0);
  await t.exec('show.rehearsed', {timings: [[0, 2500], [1, 4000], [2, 1200]]});
  const c = t.session.get(t.docId).file.content;
  assert.deepEqual(c.slides.slice(0, 3).map(s => s.transition.advanceAfterMs), [2500, 4000, 1200]);
  assert.equal(t.session.get(t.docId).view.show, null);
  assert.equal(c.slides[3].transition ?? null, null, 'a slide that was not timed is left alone');
});
