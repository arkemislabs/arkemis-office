// U:quill/format — the Styles group (Home › Styles): apply, gallery, create, modify, update to
// match, delete, visibility, Manage Styles, the Styles pane.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/para.rs (`para.style`…`styles.addToGallery`, 155-262)
//    and para/styles.rs (`apply_styles` 13, `apply_style` 25, `create_style` 70, `modify_style` 107,
//    `update_to_match` 137, `retarget` 211, `delete_style` 238, `set_visibility` 280); para/lists.rs
//    `manage_list` 97. Word: a gallery click applies the style (headings and Normal drop direct
//    numbering and the font/size/colour a paragraph style replaces), Create a Style takes the
//    current paragraph's formatting, Update to Match makes the style look like the selection,
//    custom styles delete back to their base, built-ins can't be deleted.
// 2. Ours: core/quill/commands/para/styles.mjs over the schema-2 style sheet, one op each; the pane
//    is view state (`view.stylesPane`). Table-style deletion stays with Table Design (openIssues).
// 3. Proof: this file, tests/quill/upstream/para_styles_*.test.mjs, tests/e2e/quill/format-home.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {quill} from './format-fixture.mjs';
import {getStyle} from '../../core/quill/model/styles.mjs';

const style = (q, id) => getStyle(q.t.content.styles, id);

test('para.style applies by name or id; the gallery state lists Quick Styles and marks the current one', async () => {
  const q = await quill('a\nb');
  q.sel(0, 0);
  await expectUndoRoundTrip(q.t, 'para.style', {style: 'Heading 1'}, after => assert.equal(after.content.body.chunks[0][0].props.style, 'Heading1'));
  const st = q.state('para.style');
  assert.equal(st.current, 'Heading1');
  assert.deepEqual(st.value.slice(0, 4).map(i => i.label), ['Normal', 'No Spacing', 'Heading 1', 'Title']);
  assert.equal(q.state('para.style', {style: 'Heading1'}).checked, true);
  await assert.rejects(q.t.bridge('para.style', {style: 'Nope'}), /no style `Nope`/);
  for (const [id, s] of [['para.heading2', 'Heading2'], ['para.heading3', 'Heading3'], ['para.normal', 'Normal'], ['para.heading1', 'Heading1']]) {
    await q.exec(id);
    assert.equal(q.props(0).style, s, id);
    assert.equal(q.state(id).checked, true, id);
  }
});

test('a paragraph style clears direct font, size and colour (one paragraph) and direct list numbering for headings', async () => {
  const q = await quill('abc');
  q.sel(0, 0, 3);
  await q.exec('format.font', {name: 'Georgia'});
  await q.exec('format.size', {size: 30});
  await q.exec('format.bold');
  await q.exec('para.numbering');
  await q.exec('para.style', {style: 'Heading 1'});
  const c = q.runs(0)[0][1];
  assert.deepEqual([c.font, c.size, c.bold], [undefined, undefined, true], 'bold stays, font and size go');
  assert.equal(q.props(0).numbering, undefined);
  // A character style applies to the selection's runs.
  await q.exec('para.style', {style: 'Strong'});
  assert.equal(q.runs(0)[0][1].style, 'Strong');
  assert.equal(q.props(0).style, 'Heading1');
});

test('styles.create takes the current paragraph\'s formatting, applies it, refuses a duplicate name', async () => {
  const q = await quill('abc');
  q.sel(0, 1);
  await q.exec('para.alignCenter');
  q.sel(0, 0, 3);
  await q.exec('format.italic');
  q.sel(0, 1);
  const r = await q.exec('styles.create', {name: 'Callout', basedOn: 'Quote'});
  assert.equal(r.result.id, 'Callout');
  const st = style(q, 'Callout');
  assert.deepEqual([st.kind, st.basedOn, st.next, st.quick, st.priority, st.para.align, st.chr.italic], ['paragraph', 'Quote', 'Callout', true, 50, 'center', true]);
  assert.equal(q.props(0).style, 'Callout');
  await assert.rejects(q.t.bridge('styles.create', {name: 'callout'}), /already exists/);
  await assert.rejects(q.t.bridge('styles.create', {name: '   '}), /name is empty/);
  assert.equal(q.t.registry.get('styles.create').dialog, 'dialog.newStyle');
});

test('styles.modify overlays character and paragraph formatting, renames, sets the next style (hex colours too)', async () => {
  const q = await quill('a');
  q.sel(0, 0);
  await expectUndoRoundTrip(q.t, 'styles.modify', {style: 'Heading 1', chr: {color: 'FF0000', size: 24}, para: {align: 'center'}, name: 'Big Heading', next: 'Quote'}, after => {
    const st = getStyle(after.content.styles, 'Heading1');
    assert.deepEqual([st.chr.color, st.chr.size, st.para.align, st.name, st.next], [{Rgb: [255, 0, 0]}, 24, 'center', 'Big Heading', 'Quote']);
  });
  await assert.rejects(q.t.bridge('styles.modify', {style: 'Heading1', chr: {color: 'pink'}}), /color/);
});

test('styles.updateToMatch makes the style look like the selection and drops the now-redundant direct formatting', async () => {
  const q = await quill('Title text\nother');
  q.sel(1, 0);
  await q.exec('para.style', {style: 'Heading 1'});
  q.sel(0, 0);
  await q.exec('para.style', {style: 'Heading 1'});
  q.sel(0, 0, 10);
  await q.exec('format.color', {color: '00B050'});
  await q.exec('format.italic');
  q.sel(0, 0, 10);
  await expectUndoRoundTrip(q.t, 'styles.updateToMatch', {}, after => {
    const st = getStyle(after.content.styles, 'Heading1');
    assert.deepEqual(st.chr.color, {Rgb: [0, 176, 80]});
    assert.equal(st.chr.italic, true);
    assert.equal(st.para.outlineLevel, 0, 'a heading stays a heading');
    const run = after.content.body.chunks[0][0].runs[0];
    assert.equal(run.props?.color, undefined, 'the direct colour the style now gives is dropped');
  });
});

test('styles.delete: custom styles fall back to their base; built-in and table styles are refused', async () => {
  const q = await quill('a');
  q.sel(0, 0);
  await q.exec('styles.create', {name: 'Mine', basedOn: 'Quote'});
  assert.equal(q.props(0).style, 'Mine');
  const r = await q.exec('styles.delete', {style: 'Mine'});
  assert.deepEqual(r.result, {deleted: ['Mine'], restyled: 1});
  assert.equal(q.props(0).style, 'Quote');
  assert.equal(style(q, 'Mine'), null);
  await q.t.undo();
  assert.equal(q.props(0).style, 'Mine');
  await assert.rejects(q.t.bridge('styles.delete', {style: 'Heading 1'}), /built-in style/);
  await assert.rejects(q.t.bridge('styles.delete', {style: 'Table Grid'}), /table style/);
});

test('visibility: gallery and hidden flags, Add to Style Gallery, Manage Styles lists the four kinds', async () => {
  const q = await quill('a');
  q.sel(0, 0);
  const r = await q.exec('styles.setVisibility', {style: 'Caption', gallery: true});
  assert.deepEqual(r.result, {style: 'Caption', inGallery: true, hidden: false});
  assert.ok(q.state('para.style').value.some(i => i.id === 'Caption'));
  await q.exec('styles.setVisibility', {style: 'Caption', hidden: true});
  assert.ok(!q.state('para.style').value.some(i => i.id === 'Caption'));
  await assert.rejects(q.t.bridge('styles.setVisibility', {style: 'Caption'}), /gallery/);
  await q.exec('styles.addToGallery', {style: 'TOC 1'});
  assert.equal(style(q, 'TOC1').quick, true);
  await q.exec('styles.addToGallery', {style: 'TOC 1', value: false});
  assert.equal(style(q, 'TOC1').quick, false);
  const list = (await q.exec('styles.manage', {sort: 'alphabetical'})).result;
  assert.ok(list.some(s => s.type === 'table' && s.name === 'Table Grid'));
  assert.ok(list.some(s => s.type === 'character' && s.id === 'Strong'));
  const names = list.map(s => s.name.toLowerCase());
  assert.deepEqual(names, [...names].sort());
  const rec = (await q.exec('styles.manage')).result;
  assert.equal(rec[0].name, 'Normal', 'recommended order is by priority');
  assert.deepEqual(rec.find(s => s.id === 'Heading1').format, {font: 'Aptos Display', size: 20, color: '0F4761', spaceBefore: 18, spaceAfter: 4});
  assert.equal((await q.exec('styles.list')).result.find(s => s.id === 'Normal').kind, 'paragraph');
});

test('the Styles pane is view state; Apply Styles with a style is one undoable edit', async () => {
  const q = await quill('a');
  q.sel(0, 0);
  const before = q.t.version;
  const r = await q.exec('styles.pane');
  assert.equal(r.result.pane, true);
  assert.equal(q.t.doc.view.stylesPane, true);
  assert.equal(q.t.version, before, 'not an edit');
  assert.equal(q.state('styles.pane').checked, true);
  await q.exec('styles.pane');
  assert.equal(q.t.doc.view.stylesPane, false);
  await q.exec('styles.apply');
  assert.equal(q.t.doc.view.stylesPane, true);
  await expectUndoRoundTrip(q.t, 'styles.apply', {style: 'Title'}, after => assert.equal(after.content.body.chunks[0][0].props.style, 'Title'));
  await assert.rejects(q.t.bridge('styles.apply', {style: ' '}), /must not be empty/);
});
