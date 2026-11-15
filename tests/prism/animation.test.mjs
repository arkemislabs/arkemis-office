// U:prism/transitions: the Animations tab and Animation Pane commands (animation.set, add, remove,
// move, timing, options, clear, painter, pick, preview, list, get).
//
// 1. ArtCraft: crates/engine/src/cmd/animation.rs (`set` keeps the shapes' place in the sequence,
//    `add` appends with the second shape With Previous, `timing`, `options` with direction words,
//    `painter`/`painterApply` replacing the target's animations), tests `animation_painter_copies_
//    effects_between_shapes`, `animation_painter_sticky_mode`, `deleting_a_trigger_shape_clears_the_
//    trigger`, `deleting_a_group_clears_triggers_of_its_children`, `invalid_index_is_an_error_not_
//    the_selection`, `direction_words_resolve_to_codes` (ported below). PowerPoint: Animations tab
//    and Animation Pane do the same.
// 2. Ours: core/prism/commands/animation.mjs on the schema-2 slide; every edit is one undo step.
// 3. These tests and tests/e2e/prism/animations.e2e.mjs (the ribbon, the pane, the show).

import test from 'node:test';
import assert from 'node:assert/strict';
import animation from '../../core/prism/commands/animation.mjs';
import transition from '../../core/prism/commands/transition.mjs';
import show from '../../core/prism/commands/show.mjs';
import arrange from '../../core/prism/commands/arrange.mjs';
import {withNew, rect, curSlide} from './upstream/text_deck.mjs';
import {resolveOption} from '../../core/prism/lib/anim-tables.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';

const shapes = () => [rect('11', [10, 10, 100, 100]), rect('12', [150, 10, 100, 100]), rect('13', [300, 10, 100, 100])];
async function deck() { return withNew({extra: [animation, transition, show, arrange], shapes: shapes()}); }
const anims = t => curSlide(t).animations;
const select = (t, ...ids) => t.session.setSelection(t.docId, {ranges: ids.map(id => ({anchor: `/sl:${curSlide(t).id}/sp:${id}`, focus: `/sl:${curSlide(t).id}/sp:${id}`}))});

test('direction_words_resolve_to_codes', () => {
  const fly = ['b', 'lb', 'l', 'lt', 't', 'rt', 'r', 'rb'];
  assert.equal(resolveOption(fly, 'fromBottom'), 'b');
  assert.equal(resolveOption(fly, 'bottom'), 'b');
  assert.equal(resolveOption(fly, 'fromTopLeft'), 'lt');
  assert.equal(resolveOption(fly, 'fromBottomRight'), 'rb');
  assert.equal(resolveOption(fly, 'lt'), 'lt');
  assert.equal(resolveOption(fly, 'sideways'), null);
  assert.equal(resolveOption(fly, 'fromBottomTopLeft'), null);
  const wipe = ['r', 'l', 'u', 'd', 'ru', 'lu', 'rd', 'ld'];
  assert.equal(resolveOption(wipe, 'fromBottom'), 'd');
  assert.equal(resolveOption(wipe, 'upRight'), 'ru');
  assert.equal(resolveOption(['horzIn', 'horzOut', 'vertIn', 'vertOut'], 'HorzIn'), 'horzIn');
  assert.equal(resolveOption([], 'anything'), 'anything');
});

test('animation.add appends effects; the second shape starts With Previous; set replaces in place; undo restores', async () => {
  const t = await deck();
  select(t, '11', '12');
  const r = await expectUndoRoundTrip(t, 'animation.add', {effect: 'fly', class: 'entrance', option: 'fromBottom'});
  assert.equal(r.result.count, 2);
  assert.deepEqual(anims(t).map(a => [a.shape, a.effect, a.option, a.start, a.durationMs]), [['11', 'fly', 'b', 'onClick', 500], ['12', 'fly', 'b', 'withPrevious', 500]]);
  assert.equal(anims(t)[0].presetId, 2);
  // Set on shape 11 replaces its animation but keeps its place and its Start.
  select(t, '11');
  await t.exec('animation.timing', {index: 0, start: 'afterPrevious'});
  await t.exec('animation.set', {effect: 'zoom', class: 'entrance'});
  assert.deepEqual(anims(t).map(a => [a.shape, a.effect, a.start]), [['11', 'zoom', 'afterPrevious'], ['12', 'fly', 'withPrevious']]);
  // Set on a shape with none appends one.
  select(t, '13');
  await t.exec('animation.set', {effect: 'spin', class: 'emphasis'});
  assert.deepEqual(anims(t).map(a => a.shape), ['11', '12', '13']);
  assert.equal(anims(t)[2].amount, 360);
  assert.equal(anims(t)[2].class, 'emphasis');
  // "<class>:<effect>" is what the gallery's tiles send; none removes the shapes' animations.
  await t.exec('animation.set', {effect: 'exit:fadeOut'});
  assert.deepEqual([anims(t)[2].class, anims(t)[2].effect], ['exit', 'fadeOut']);
  await t.exec('animation.set', {effect: 'none'});
  assert.deepEqual(anims(t).map(a => a.shape), ['11', '12']);
});

test('animation commands refuse bad effects, options and indices; nothing changes', async () => {
  const t = await deck();
  select(t, '11');
  await assert.rejects(t.exec('animation.add', {effect: 'nope'}), e => e.code === 'invalid_params' && e.data.path === '/effect');
  await assert.rejects(t.exec('animation.add', {effect: 'fly', option: 'sideways'}), e => e.code === 'invalid_params' && e.data.path === '/option');
  await t.exec('animation.add', {effect: 'fade'});
  for (const index of [-1, 1.5, 'x']) {
    for (const cmd of ['animation.remove', 'animation.timing', 'animation.options']) {
      await assert.rejects(t.exec(cmd, {index, duration: 100}), undefined, `${cmd} accepted index ${JSON.stringify(index)}`);
    }
    await assert.rejects(t.exec('animation.move', {index, to: 0}));
    assert.equal(anims(t).length, 1);
  }
  await assert.rejects(t.exec('animation.timing', {index: 7, duration: 100}), e => /no animation to change/.test(e.message));
  assert.equal(anims(t)[0].durationMs, 500);
});

test('animation.timing: Start (ids and the ribbon labels), Duration, Delay, repeat, rewind, trigger', async () => {
  const t = await deck();
  select(t, '11');
  await t.exec('animation.add', {effect: 'fade'});
  await expectUndoRoundTrip(t, 'animation.timing', {start: 'With Previous', duration: 1250, delay: 250, repeat: 3, rewind: true, trigger: '12'});
  const a = anims(t)[0];
  assert.deepEqual([a.start, a.durationMs, a.delayMs, a.repeat, a.rewind, a.trigger], ['withPrevious', 1250, 250, 3, true, '12']);
  await t.exec('animation.timing', {trigger: null});
  assert.equal(anims(t)[0].trigger, null);
  // State: the ribbon boxes read the current animation.
  assert.equal(t.state('animation.timing', {field: 'start'}).value, 'With Previous');
  assert.equal(t.state('animation.timing', {field: 'duration'}).value, 1.25);
  assert.equal(t.state('animation.timing', {field: 'delay'}).value, 0.25);
  assert.equal(t.state('animation.timing', {trigger: null}).checked, true);
  const rows = t.state('animation.timing', {field: 'trigger'}).value;
  assert.deepEqual(rows.map(r => r.value).slice(-2), ['12', '13']);
  assert.equal(rows.at(-2).label, 'On Click of Rectangle 12');
  select(t, '13');
  assert.equal(t.state('animation.timing', {field: 'start'}).enabled, false, 'a shape without an animation disables the boxes');
});

test('animation.options: option and text build; each target keeps its own option set; gallery state marks the current effect', async () => {
  const t = await deck();
  select(t, '11', '12');
  await t.exec('animation.add', {effect: 'fly', class: 'entrance'});
  await t.exec('animation.options', {option: 'upRight'}).catch(() => {});
  await expectUndoRoundTrip(t, 'animation.options', {option: 'fromTopRight', textBuild: 'byParagraph'});
  assert.deepEqual(anims(t).map(a => [a.option, a.textBuild]), [['rt', 'byParagraph'], ['rt', 'byParagraph']]);
  select(t, '11');
  const rows = t.state('animation.options', {}).value;
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.filter(r => r.checked).map(r => r.value), ['rt']);
  assert.equal(t.state('animation.options', {textBuild: 'byParagraph'}).checked, true);
  assert.equal(t.state('animation.options', {textBuild: 'asOne'}).checked, false);
  const gal = t.state('animation.set', {}).value;
  assert.equal(gal.filter(g => g.selected).map(g => g.id).join(), 'entrance:fly');
  assert.ok(gal.some(g => g.group === 'Motion Paths') && gal.some(g => g.group === 'Exit'));
  assert.ok(gal.every(g => g.icon), 'every tile is a drawn picture');
  // A motion path takes its option as a new default path.
  select(t, '13');
  await t.exec('animation.add', {effect: 'lines', class: 'path'});
  const before = anims(t).at(-1).path;
  await t.exec('animation.options', {option: 'right'});
  assert.notEqual(anims(t).at(-1).path, before);
  assert.equal(anims(t).at(-1).path, 'M 0 0 L 0.25 0 E');
});

test('animation.remove, move (index, to and by), clear and the pane rows', async () => {
  const t = await deck();
  for (const id of ['11', '12', '13']) { select(t, id); await t.exec('animation.add', {effect: 'fade'}); }
  await expectUndoRoundTrip(t, 'animation.move', {index: 0, to: 2});
  assert.deepEqual(anims(t).map(a => a.shape), ['12', '13', '11']);
  select(t, '11');
  assert.equal(t.state('animation.move', {by: 1}).enabled, false, 'already last');
  await t.exec('animation.move', {by: -1});
  assert.deepEqual(anims(t).map(a => a.shape), ['12', '11', '13']);
  await t.exec('animation.remove', {index: 1});
  assert.deepEqual(anims(t).map(a => a.shape), ['12', '13']);
  select(t, '13');
  await t.exec('animation.remove', {});
  assert.deepEqual(anims(t).map(a => a.shape), ['12']);
  await t.exec('animation.clear', {});
  assert.equal(anims(t).length, 0);
});

test('animation_painter_copies_effects_between_shapes', async () => {
  const t = await deck();
  select(t, '11');
  await t.exec('animation.add', {effect: 'fade', class: 'entrance'});
  await t.exec('animation.add', {effect: 'spin', class: 'emphasis'});
  assert.equal(anims(t).length, 2);
  let r = await t.exec('animation.painter', {});
  assert.deepEqual([r.result.armed, r.result.count], [true, 2]);
  assert.equal(t.state('animation.painter').checked, true);
  select(t, '12');
  r = await t.exec('animation.painterApply', {});
  assert.equal(r.result.applied, 2);
  assert.ok(!t.doc.view?.animPainter, 'a single paint disarms the painter');
  // Painting again replaces shape 12's animations instead of adding to them; undo restores.
  await t.exec('animation.painter', {id: '11'});
  await t.exec('animation.painterApply', {ids: ['12']});
  const count = id => anims(t).filter(a => a.shape === id).length;
  assert.equal(count('12'), 2);
  await t.undo();
  assert.equal(count('12'), 2, 'undo restores the first painting');
  await t.undo();
  assert.equal(count('12'), 0, 'undo removes the painted animations');
  await t.redo();
  const s12 = anims(t).filter(a => a.shape === '12');
  assert.deepEqual(s12.map(a => a.effect), ['fade', 'spin']);
  // Picking from a shape with no animations is an error.
  await t.exec('animation.clear', {});
  await assert.rejects(t.exec('animation.painter', {id: '11'}), e => /no animations to copy/.test(e.message));
});

test('animation_painter_sticky_mode, and a second click turns it off', async () => {
  const t = await deck();
  select(t, '11');
  await t.exec('animation.add', {effect: 'zoom', class: 'entrance'});
  await t.exec('animation.painter', {id: '11', sticky: true});
  await t.exec('animation.painterApply', {ids: ['12']});
  assert.ok(t.doc.view?.animPainter, 'sticky stays armed');
  await t.exec('animation.painterApply', {ids: ['13']});
  assert.ok(t.doc.view?.animPainter);
  assert.equal(anims(t).length, 3);
  const off = await t.exec('animation.painter', {});
  assert.equal(off.result.armed, false);
  assert.ok(!t.doc.view?.animPainter);
  await assert.rejects(t.exec('animation.painterApply', {ids: ['12']}), e => /Animation Painter first/.test(e.message));
});

test('deleting_a_trigger_shape_clears_the_trigger', async () => {
  const t = await deck();
  select(t, '11');
  await t.exec('animation.add', {effect: 'fade'});
  select(t, '13');
  await t.exec('animation.add', {effect: 'fade'});
  await t.exec('animation.timing', {index: 0, trigger: '12'});
  await t.exec('animation.timing', {index: 1, trigger: '12'});
  assert.deepEqual(anims(t).map(a => a.trigger), ['12', '12']);
  await t.exec('edit.delete', {ids: ['12']});
  assert.deepEqual(anims(t).map(a => a.trigger), [null, null]);
  assert.equal(anims(t).length, 2, 'the animated shapes keep their effects');
});

test('animation.pick selects the shape and remembers the row; preview and Play From are view state; list and get answer queries', async () => {
  const t = await deck();
  select(t, '11');
  await t.exec('animation.add', {effect: 'fade'});
  await t.exec('animation.add', {effect: 'zoom'});
  select(t, '12');
  await t.exec('animation.add', {effect: 'wipe'});
  await t.exec('animation.pick', {index: 1});
  assert.equal(t.doc.view.animIndex, 1);
  assert.equal(t.state('animation.timing', {field: 'start'}).enabled, true);
  await t.exec('animation.timing', {duration: 2000});
  assert.deepEqual(anims(t).map(a => a.durationMs), [500, 2000, 500], 'the picked row, not the first of the shape');
  await assert.rejects(t.exec('animation.pick', {index: 9}));
  let r = await t.exec('animation.preview', {from: 1});
  assert.equal(r.result.on, true);
  assert.deepEqual([t.doc.view.animPreview.on, t.doc.view.animPreview.from], [true, 1]);
  r = await t.exec('animation.preview', {});
  assert.equal(r.result.on, false);
  const list = (await t.exec('animation.list', {})).result;
  assert.ok(list.length > 100 && list.find(a => a.id === 'fly').options.length === 8);
  assert.equal((await t.exec('animation.get', {})).result.length, 3);
});

test('every gallery tile has its own drawn icon (transitions, animation effects, None)', async () => {
  const fs = await import('node:fs');
  const {animationList, transitionList} = await import('../../core/prism/lib/anim-tables.mjs');
  const have = id => fs.existsSync(new URL(`../../assets/icons/ribbon/${id}.svg`, import.meta.url));
  for (const t of transitionList()) assert.ok(have(`transition-${t.id}`), `transition-${t.id}`);
  for (const a of animationList().filter(x => x.class !== 'media')) assert.ok(have(`anim-${a.id}`), `anim-${a.id}`);
  assert.ok(have('animation-none'));
  // The Animations gallery lists None first, then every effect by class; nothing is selected without an animation.
  const t = await deck();
  select(t, '11');
  const gal = t.state('animation.set', {}).value;
  assert.equal(gal[0].id, 'none');
  assert.equal(gal[0].selected, true);
  assert.deepEqual([...new Set(gal.map(g => g.group))], ['None', 'Entrance', 'Emphasis', 'Exit', 'Motion Paths']);
  assert.ok(gal.filter(g => g.inline).length >= 12 && gal.filter(g => g.inline).length < gal.length);
  // With nothing selected the tiles are still there, greyed (the state is disabled but carries them).
  select(t);
  t.session.setSelection(t.docId, {ranges: [{anchor: `/sl:${curSlide(t).id}`}], primary: 0});
  const off = t.state('animation.set', {});
  assert.equal(off.enabled, false);
  assert.ok(off.value.length > 100);
});
