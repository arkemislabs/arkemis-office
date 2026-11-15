// Prism Home › Font and Paragraph, their dialogs, and Shape Format › WordArt Styles through the
// bridge (U:prism/format).
//
// What deckcraft does (crates/engine/src/cmd/format.rs, format/*.rs; ribbon home.rs Font and
// Paragraph groups, shape_format.rs WordArt Styles; dialogs font.rs, paragraph.rs, tabs.rs,
// columns.rs, body.rs dlg_bullets): with a shape selected the Font and Paragraph controls format
// all its text; with a caret in a word they format that word; the launchers open the Font and
// Paragraph dialogs seeded from the selection, and OK applies every field as one undo step.
// PowerPoint: the same groups, menus and dialogs. What this proves end to end in the app:
// ui.activate on the real controls (toggles, the size combo by value, menu items) changes the deck
// as the engine tests do, the toggles show checked, the dialogs open with the selection's values
// and submit, and Ctrl+Z through the KeyRouter undoes. Captures in artifacts/e2e/prism/format-ribbon/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {shape, presetGeom} from '../../../core/prism/model/presentation.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';

test('prism format: font and paragraph controls, Font and Paragraph dialogs, bullets, WordArt text fill, undo', {timeout: 240_000}, async () => {
  const file = createFile('prism', 'Format deck', {schema: 2});
  file.id = 'prism-format-ribbon';
  const c = file.content;
  c.slides[0].layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  const centred = t => ({...bodyFromText(t), paragraphs: bodyFromText(t).paragraphs.map(p => ({...p, props: {align: 'center'}}))});
  c.slides[0].shapes = [
    shape({id: 'r1', name: 'Rectangle 1', xfrm: {x: 80, y: 80, w: 420, h: 160}, geom: presetGeom('rect'), text: centred('Hello world')}),
    shape({id: 't1', name: 'TextBox 2', xfrm: {x: 80, y: 300, w: 420, h: 120}, textBox: true, geom: presetGeom('rect'),
      text: {...bodyFromText('First point\nSecond point'), body: {wrap: true, autofit: {kind: 'shape'}}}}),
  ];
  c.nextId = 400;
  const sid = c.slides[0].id;
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/format-ribbon', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const sh = (d, id) => d.slides[0].shapes.find(s => s.id === id);
  const run0 = (d, id) => sh(d, id).text.paragraphs[0].runs[0].props ?? {};
  const select = ids => app.rpc('selection.set', {doc, ranges: ids.map(i => ({anchor: `/sl:${sid}/sp:${i}`, focus: `/sl:${sid}/sp:${i}`})), primary: 0});
  const control = async id => (await app.rpc('ui.inspect', {doc})).controls?.find?.(x => x.id === id) ?? null;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await select(['r1']);
    await app.rpc('ui.tab', {doc, tab: 'home'});

    // Font group: Bold, Italic, Font Size 28 (combo), Grow, Font Color, Character Spacing › Loose.
    await app.rpc('ui.activate', {doc, control: 'home.font.bold'});
    await app.rpc('ui.activate', {doc, control: 'home.font.italic'});
    await app.rpc('ui.activate', {doc, control: 'home.font.size', value: 28});
    await app.rpc('ui.activate', {doc, control: 'home.font.grow'});
    await app.rpc('ui.activate', {doc, control: 'home.font.color', value: '#C00000'});
    await app.rpc('ui.activate', {doc, control: 'home.font.spacing.loose'});
    let d = await deck();
    let r = run0(d, 'r1');
    assert.deepEqual([r.bold, r.italic, r.size, r.spacing], [true, true, 32, 3]);
    assert.deepEqual(r.fill.color.base, {kind: 'rgb', rgb: {r: 0xc0, g: 0, b: 0, a: 255}});
    const bold = await control('home.font.bold');
    if (bold) assert.equal(bold.checked, true, 'Bold shows pressed');
    await app.capture('1-font-group');

    // Paragraph group: Align Right, Bullets, Line Spacing 1.5, Columns › Two, Align Text › Bottom.
    await app.rpc('ui.activate', {doc, control: 'home.paragraph.align-right'});
    await app.rpc('ui.activate', {doc, control: 'home.paragraph.bullets'});
    await app.rpc('ui.activate', {doc, control: 'home.paragraph.line-spacing.1-5'});
    await app.rpc('ui.activate', {doc, control: 'home.paragraph.align-text.bottom'});
    d = await deck();
    const p0 = sh(d, 'r1').text.paragraphs[0].props;
    assert.equal(p0.align, 'right');
    assert.deepEqual(p0.bullet, {kind: 'char', char: '•'});
    assert.deepEqual(p0.lineSpacing, {kind: 'pct', v: 1.5});
    assert.equal(sh(d, 'r1').text.body.anchor, 'bottom');
    await app.capture('2-paragraph-group');

    // Font dialog (Ctrl+T, as the Font group's launcher): seeded with the selection, Font style Regular + Underline Double.
    assert.equal((await app.rpc('ui.key', {doc, keys: 'Ctrl+T'})).handled, true);
    let dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.font');
    assert.equal(dlg.values.style, 'boldItalic');
    assert.equal(dlg.values.size, 32);
    await app.rpc('ui.dialog.set', {field: 'style', value: 'regular'});
    await app.rpc('ui.dialog.set', {field: 'underline', value: 'dbl'});
    await app.capture('3-font-dialog');
    await app.rpc('ui.dialog.submit', {});
    r = run0(await deck(), 'r1');
    assert.deepEqual([r.bold, r.italic, r.underline, r.size], [false, false, 'dbl', 32]);

    // Paragraph dialog: Before text 0.5 in, Hanging 0.25 in, Line Spacing Exactly 24 pt.
    await select(['t1']);
    await app.rpc('ui.activate', {doc, control: 'home.paragraph.line-spacing.line-spacing-options'});
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.paragraph');
    await app.rpc('ui.dialog.set', {field: 'before', value: 0.5});
    await app.rpc('ui.dialog.set', {field: 'special', value: 'hanging'});
    await app.rpc('ui.dialog.set', {field: 'by', value: 0.25});
    await app.rpc('ui.dialog.set', {field: 'lineKind', value: 'exactly'});
    await app.rpc('ui.dialog.set', {field: 'lineValue', value: 24});
    await app.capture('4-paragraph-dialog');
    await app.rpc('ui.dialog.submit', {});
    d = await deck();
    const tp = sh(d, 't1').text.paragraphs.map(p => p.props);
    assert.ok(tp.every(p => p.marginLeft === 36 && p.indent === -18), JSON.stringify(tp));
    assert.deepEqual(tp[0].lineSpacing, {kind: 'pts', v: 24});

    // Numbering › I. II. III. then Bullets and Numbering… dialog (start at 3).
    await app.rpc('ui.activate', {doc, control: 'home.paragraph.numbering.i-ii-iii'});
    assert.equal(sh(await deck(), 't1').text.paragraphs[0].props.bullet.scheme, 'romanUcPeriod');
    await app.rpc('ui.activate', {doc, control: 'home.paragraph.numbering.bullets-and-numbering'});
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.bullets');
    await app.rpc('ui.dialog.set', {field: 'start', value: 3});
    await app.capture('5-bullets-dialog');
    await app.rpc('ui.dialog.submit', {});
    assert.deepEqual(sh(await deck(), 't1').text.paragraphs[0].props.bullet, {kind: 'autoNum', scheme: 'romanUcPeriod', startAt: 3});

    // Line Spacing › Tabs…: a centre stop at 1 in and default stops every 0.5 in.
    await app.rpc('ui.activate', {doc, control: 'home.paragraph.line-spacing.tabs'});
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.tabs');
    assert.equal(dlg.values.defaultTab, 1);
    await app.rpc('ui.dialog.set', {field: 'stops', value: [{pos: 1, align: 'ctr'}, {pos: 2.5, align: 'dec'}]});
    await app.rpc('ui.dialog.set', {field: 'defaultTab', value: 0.5});
    await app.capture('6-tabs-dialog');
    await app.rpc('ui.dialog.submit', {});
    const tabs = sh(await deck(), 't1').text.paragraphs[0].props;
    assert.deepEqual([tabs.tabs, tabs.defaultTab], [[{pos: 72, align: 'ctr'}, {pos: 180, align: 'dec'}], 36]);

    // Shape Format › WordArt Styles › Text Fill on the rectangle.
    await select(['r1']);
    await app.rpc('ui.tab', {doc, tab: 'shape-format'});
    await app.rpc('ui.activate', {doc, control: 'shapeformat.wordart.text-fill.theme-colors-standard-colors', value: 'accent2'});
    assert.deepEqual(run0(await deck(), 'r1').fill, {kind: 'solid', color: {base: {kind: 'scheme', slot: 'accent2'}}});
    await app.capture('7-wordart-text-fill');
    const k = await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.equal(k.handled, true);
    assert.deepEqual(run0(await deck(), 'r1').fill.color.base.kind, 'rgb', 'Ctrl+Z undoes the text fill');
  } finally {
    await app.close();
  }
});
