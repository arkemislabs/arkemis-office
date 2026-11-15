// U:prism/presenter: Presenter View (deckcraft show/presenter.rs): what it shows for a slide (position, next slide,
// notes), its clock with pause and reset, and show.presenter / show.presenterState over a running show.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {slide as newSlide} from '../../core/prism/model/presentation.mjs';
import {bodyFromText} from '../../core/prism/model/text.mjs';
import {presenterView, PresenterTimer, formatElapsed, NOTES_DEFAULT} from '../../core/prism/lib/presenter.mjs';

function deck({hide = [], custom = null} = {}) {
  const c = createContent('Presenter');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.slides = ['s1', 's2', 's3', 's4'].map((id, i) => newSlide({id, layout, shapes: [], notes: bodyFromText(`Notes for slide ${i + 1}`), hidden: hide.includes(id)}));
  if (custom) c.customShows = [{name: 'Short', slides: custom}];
  return c;
}

test('the presenter view names the slide position, the next slide and the notes, skipping hidden slides', () => {
  const c = deck({hide: ['s3']});
  assert.deepEqual(presenterView(c, 0), {position: 1, total: 3, next: 1, notes: 'Notes for slide 1'});
  assert.deepEqual(presenterView(c, 1), {position: 2, total: 3, next: 3, notes: 'Notes for slide 2'});
  assert.deepEqual(presenterView(c, 3), {position: 3, total: 3, next: null, notes: 'Notes for slide 4'});
});

test('a custom show shows its own slides in its own order', () => {
  const c = deck({custom: ['s4', 's2']});
  assert.deepEqual(presenterView(c, 3, 'Short'), {position: 1, total: 2, next: 1, notes: 'Notes for slide 4'});
  assert.equal(presenterView(c, 1, 'Short').next, null);
});

test('the timer counts, pauses (the show keeps going), resumes and resets (presenter.rs PresenterTimer)', () => {
  const t = new PresenterTimer(100);
  assert.equal(t.elapsed(100), 0);
  assert.equal(t.elapsed(165), 65);
  t.toggle(170);
  assert.equal(t.paused, true);
  assert.equal(t.elapsed(500), 70, 'paused: the number stays');
  t.toggle(500);
  assert.equal(t.elapsed(510), 80);
  t.reset(520);
  assert.equal(t.elapsed(521), 1);
  t.toggle(530);
  t.reset(540);
  assert.equal(t.elapsed(900), 0, 'a paused timer stays paused at zero');
  assert.equal(t.elapsed(NaN), 0);
  assert.equal(formatElapsed(3725), '01:02:05');
  assert.equal(formatElapsed(-4), '00:00:00');
  assert.equal(formatElapsed(1e9), '99:59:59');
  assert.equal(NOTES_DEFAULT, 18);
});

test('show.presenter toggles the second window with the show; the window reports what it drew, show.status returns it', async () => {
  const c = deck();
  const t = await createTestSession('prism', {content: c, selection: {ranges: [{anchor: '/sl:s1', focus: '/sl:s1'}], primary: 0}});
  const view = () => t.session.get(t.docId).view ?? {};
  assert.equal(t.state('show.presenter', {}).checked, false);
  await t.exec('show.presenter', {});
  assert.equal(view().presenter, true);
  assert.equal(t.state('show.presenter', {}).checked, true);
  await t.exec('show.start', {});
  await t.exec('show.report', {slide: 0, step: 0, playing: false, ended: false, transition: null, blank: null});
  assert.deepEqual((await t.exec('show.status', {})).result.presenter, {open: false});
  await t.exec('show.presenterState', {open: true, slide: 0, info: {count: 'Slide 1 of 4', notes: 'Notes for slide 1', next: 1}});
  assert.deepEqual((await t.exec('show.status', {})).result.presenter, {open: true, slide: 0, count: 'Slide 1 of 4', notes: 'Notes for slide 1', next: 1});
  await t.exec('show.presenterState', {open: false});
  assert.deepEqual((await t.exec('show.status', {})).result.presenter, {open: false});
  await t.exec('show.presenter', {on: false});
  assert.equal('presenter' in (await t.exec('show.status', {})).result, false);
});
