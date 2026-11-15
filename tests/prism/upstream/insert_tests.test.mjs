// Ported from deckcraft crates/engine/src/cmd/insert.rs `mod tests` (Date & Time),
// crates/engine/src/icons.rs `mod tests` and crates/text/src/datetime.rs `mod tests` at
// f893f6af7d36a5409fd804e81a34fd895cfefedf (each test names its Rust original). Rendering-pixel
// assertions of `insert_icon_strokes_the_outline…` and its PPTX round trip belong to the surface
// and pptx units; the geometry assertions are here.
//
// 1. What ArtCraft does: Insert › Date & Time with no keys opens its dialog and edits nothing; a
//    format at the caret is one updating field (one undo step "Date & Time"); update:false inserts
//    plain text in the chosen language; bad values change nothing. Icons are Lucide outlines
//    stroked at 1/12 of the box. Date fields follow ECMA-376 formats per language.
// 2. Ours: the same commands on a schema-2 deck; text editing through U:prism/text's session.
// 3. Proved here; the dialog in tests/prism/insert.test.mjs and tests/e2e/prism/insert-shapes.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../../core/kernel/testing.mjs';
import {createContent} from '../../../core/prism/schema.mjs';
import {ICONS, findIcon, pathData, outline, VIEW} from '../../../core/prism/lib/insert-icons.mjs';
import {fieldText, dateTime, isDateField, fromMillis} from '../../../core/prism/lib/insert-datetime.mjs';
import {parsePath} from '../../../core/prism/model/render.mjs';
import {selectText} from '../../../core/prism/model/doc.mjs';

async function session() {
  const c = createContent('Insert');
  const sid = c.slides[0].id;
  return createTestSession('prism', {content: c, selection: {ranges: [{anchor: `/sl:${sid}`, focus: `/sl:${sid}`}], primary: 0}});
}
const undos = t => t.doc.undo.size;
const titleOf = t => t.content.slides[0].shapes[0];
/** `edit_title`: type "On " into the title placeholder. */
async function editTitle(t) {
  const sl = t.content.slides[0];
  t.session.setSelection(t.docId, selectText(sl.id, [sl.shapes[0].id], 0, 0));
  await t.exec('text.insert', {text: 'On '});
}
const bodyText = b => b.paragraphs.map(p => p.runs.map(r => r.text ?? '').join('')).join('\n');

test('insert.rs no_params_opens_the_dialog_and_edits_nothing', async () => {
  const t = await session();
  const v = t.version;
  const r = await t.exec('insert.dateTime', {});
  assert.equal(r.result.dialog, 'dialog.dateTime');
  assert.equal(t.version, v);
  assert.equal(undos(t), 0);
});

test('insert.rs a_format_at_the_caret_is_one_updating_field', async () => {
  const t = await session();
  await editTitle(t);
  const before = undos(t);
  const r = await t.exec('insert.dateTime', {format: 'datetime10', update: true});
  assert.equal(r.result.where, 'caret');
  const run = titleOf(t).text.paragraphs[0].runs.find(x => x.kind?.kind === 'field');
  assert.equal(run.kind.field, 'datetime10');
  assert.match(run.text, /:/);
  assert.equal(undos(t), before + 1);
  assert.equal(t.doc.undo.labels()[0], 'Date & Time');
  await t.undo();
  assert.equal(bodyText(titleOf(t).text), 'On ');
});

test('insert.rs update_false_inserts_plain_text_in_the_chosen_language', async () => {
  const t = await session();
  await editTitle(t);
  const before = undos(t);
  const expect = fieldText('datetime1', 'en-GB', fromMillis(t.host.now()));
  await t.exec('insert.dateTime', {format: 'datetime1', update: false, language: 'en-GB'});
  const run = titleOf(t).text.paragraphs[0].runs.find(x => x.text === expect);
  assert.ok(run, `a run reads ${expect}`);
  assert.ok(!run.kind || run.kind.kind === 'text');
  assert.equal(run.props.lang, 'en-GB');
  assert.equal(undos(t), before + 1);
});

test('insert.rs a_named_format_in_french_and_a_bad_value_change_nothing', async () => {
  const t = await session();
  await editTitle(t);
  const v = t.version, n = undos(t);
  await assert.rejects(t.exec('insert.dateTime', {format: 'datetime2', language: 'fr-FR'}), /isn't available/);
  assert.equal(t.version, v);
  assert.equal(undos(t), n);
  for (const p of [{format: 'datetime14'}, {format: 'nope'}, {update: 'yes'}, {language: 'de-DE'}, {language: ''}]) {
    await assert.rejects(t.exec('insert.dateTime', p), /insert\.dateTime/, JSON.stringify(p));
    assert.equal(t.version, v);
    assert.equal(undos(t), n);
  }
});

test('icons.rs every_icon_converts_and_a_second_subpath_keeps_its_own_origin', () => {
  assert.ok(ICONS.length >= 60);
  for (const icon of ICONS) {
    const els = outline(icon.name);
    assert.ok(els && els.length >= 2, icon.name);
    const d = pathData(icon.name);
    assert.ok(d.startsWith('M'), d);
    assert.ok(parsePath(d).length > 0, icon.name);
  }
  // `m19 12…` is a second SVG element, not a continuation of the shaft.
  assert.ok(pathData('arrow-down').includes('M 19 12'), pathData('arrow-down'));
  // Relative arcs in the star become cubics our renderer understands.
  assert.ok(pathData('star').includes(' C '), pathData('star'));
  assert.equal(findIcon('arrow_right')?.name, 'arrow-right');
  assert.equal(findIcon('Star')?.name, 'star');
  assert.equal(findIcon('nope'), null);
});

test('icons.rs insert_icon_strokes_the_outline (geometry and stroke width)', async () => {
  const t = await session();
  await assert.rejects(t.exec('insert.icon', {}));
  await assert.rejects(t.exec('insert.icon', {name: 'not-an-icon'}));
  const listed = (await t.exec('insert.icons', {})).result;
  assert.ok(listed.some(i => i.name === 'star' && i.category === 'Marks'));
  const before = t.content.slides[0].shapes.length;
  const id = (await t.exec('insert.icon', {name: 'star', rect: [100, 80, 72, 72]})).result.id;
  const sh = t.content.slides[0].shapes.find(s => s.id === id);
  assert.equal(t.content.slides[0].shapes.length, before + 1);
  assert.equal(sh.name, 'Star');
  assert.equal(sh.fill.kind, 'none');
  assert.equal(sh.geom.kind, 'custom');
  assert.equal(sh.geom.paths.length, 1);
  assert.equal(sh.geom.paths[0].fill, 'none');
  assert.equal(sh.geom.paths[0].stroke, true);
  assert.deepEqual([sh.geom.paths[0].w, sh.geom.paths[0].h], [VIEW, VIEW]);
  assert.ok(sh.geom.paths[0].d.includes('M') && sh.geom.paths[0].d.includes('C'));
  assert.ok(Math.abs(sh.line.width - 6) < 1e-6, String(sh.line.width));
  await t.undo();
  assert.equal(t.content.slides[0].shapes.length, before);
  await t.exec('insert.icon', {name: 'arrow-right', rect: [200, 200, 96, 96]});
  const arrow = t.content.slides[0].shapes.find(s => s.name === 'Arrow right');
  assert.ok(Math.abs(arrow.line.width - 8) < 1e-6);
});

const FRI = dateTime(2026, 10, 9, 20, 5, 7);
test('datetime.rs english_formats_of_every_type', () => {
  const f = k => fieldText(k, 'en-US', FRI);
  assert.equal(f('datetime1'), '10/9/2026');
  assert.equal(f('datetime2'), 'Friday, October 9, 2026');
  assert.equal(f('datetime3'), '9 October 2026');
  assert.equal(f('datetime4'), 'October 9, 2026');
  assert.equal(f('datetime5'), '9-Oct-26');
  assert.equal(f('datetime6'), 'October 26');
  assert.equal(f('datetime7'), 'Oct-26');
  assert.equal(f('datetime8'), '10/9/2026 8:05 PM');
  assert.equal(f('datetime9'), '10/9/2026 8:05:07 PM');
  assert.equal(f('datetime10'), '20:05');
  assert.equal(f('datetime11'), '20:05:07');
  assert.equal(f('datetime12'), '8:05 PM');
  assert.equal(f('datetime13'), '8:05:07 PM');
  assert.equal(f('datetimeFigureOut'), '10/9/2026');
  assert.equal(f('datetime'), '10/9/2026');
  assert.equal(fieldText('datetime12', null, dateTime(2024, 2, 29, 0, 0, 0)), '12:00 AM');
  assert.equal(fieldText('datetime12', null, dateTime(2024, 2, 29, 12, 30, 0)), '12:30 PM');
  assert.equal(fieldText('datetime2', null, dateTime(2000, 1, 1, 0, 0, 0)), 'Saturday, January 1, 2000');
});

test('datetime.rs language_orders_numeric_dates_and_keeps_names_english_only', () => {
  assert.equal(fieldText('datetime1', 'en-GB', FRI), '09/10/2026');
  assert.equal(fieldText('datetimeFigureOut', 'de-DE', FRI), '09.10.2026');
  assert.equal(fieldText('datetime1', 'ja-JP', FRI), '2026/10/9');
  assert.equal(fieldText('datetime1', 'sv-SE', FRI), '2026-10-09');
  assert.equal(fieldText('datetime10', 'fr-FR', FRI), '20:05');
  assert.equal(fieldText('datetime2', 'de-DE', FRI), null);
  assert.equal(fieldText('datetime12', 'fr-FR', FRI), null);
  assert.equal(fieldText('datetime4', 'en-GB', FRI), 'October 9, 2026');
});

test('datetime.rs unknown_types_and_impossible_dates_give_nothing', () => {
  assert.equal(fieldText('slidenum', null, FRI), null);
  assert.equal(fieldText('datetime14', null, FRI), null);
  for (const bad of [dateTime(2026, 0, 9), dateTime(2026, 13, 9), dateTime(2026, 2, 29), dateTime(2026, 4, 31), dateTime(2026, 1, 1, 24),
    dateTime(-2147483648, 1, 1), dateTime(2147483647, 4294967295, 4294967295, 4294967295, 4294967295, 4294967295)]) {
    assert.equal(fieldText('datetime2', null, bad), null, JSON.stringify(bad));
  }
  assert.ok(isDateField('datetimeFigureOut') && !isDateField('slidenum'));
});

test('datetime.rs the_clock_reads_a_real_date', () => {
  assert.notEqual(fieldText('datetime1', null, fromMillis(Date.now())), null);
});
