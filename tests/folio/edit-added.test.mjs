// core/folio/lib/added.mjs and the edit.text, edit.image, edit.added, edit.added_select and edit.added_change commands: Add text and Add image.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft 0.16.0 crates/edit/src/added and tests.rs, ui-egui content_ui.rs): an added item is its own tagged content stream with its parameters
//    in the dictionary, so it stays editable; a click puts a 200 pt box with its top left at the click, a drag draws one; text wraps in its box and its height
//    follows it; a picture with no box is centred at 80 % of the page and never enlarged; items keep their place on a turned page; the standard fonts draw
//    Western European text only; added items are not page paragraphs. Acrobat's Add text and Add image behave the same way.
// 2. Ours does the same: real pages, the file read back after each change, a page turned 90 degrees, and the Format text and Image controls on an added item.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {schema1Content, editPdf, REPLACEMENT_PNG} from '../../core/folio/fixtures.mjs';
import {listAdded, centredBox, wrapped, textRect, defaultText} from '../../core/folio/lib/added.mjs';
import {pageStreams} from '../../core/folio/lib/text-interp.mjs';

const session = async (bytes = null, extra = {}) => createTestSession('folio', {content: {...(await migrateContent(await schema1Content(bytes ?? await editPdf(), 'add.pdf'))), ...extra}});
const near = (a, b, tol = 1e-3, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);
const nearRect = (a, b, tol = 1e-3, msg = '') => a.forEach((v, i) => near(v, b[i], tol, `${msg} [${i}]`));
const items = async t => (await t.exec('edit.added', {page: 1})).result.items;
const source = async t => PDFDocument.load(Uint8Array.from(Buffer.from(t.content.sourceBase64, 'base64')));
const streamText = async t => { const d = await source(t); return pageStreams(d, d.getPage(0)).map(x => new TextDecoder('latin1').decode(x.bytes)).join('\n'); };

test('text is added in a box: a drag draws it, a click puts a 200 point box at the click, and its height follows the words', async () => {
  const t = await session();
  const r = (await t.exec('edit.text', {page: 1, rect: [100, 300, 260, 340], text: 'Added words that wrap inside the box the person drew', size: 14})).result;
  assert.equal(r.item.kind, 'text');
  const [it] = await items(t);
  assert.equal(it.text, 'Added words that wrap inside the box the person drew');
  near(it.rect[0], 100); near(it.rect[2], 260);
  near(it.rect[1], 300, 1e-6, 'the top stays where the box was drawn');
  assert.ok(it.rect[3] - it.rect[1] >= 2 * 14 * 1.2 - 1e-6, 'two or more lines: the height follows the text');
  await t.exec('edit.text', {page: 1, at: [72, 500], text: 'Clicked', size: 10});
  const second = (await items(t))[1];
  nearRect(second.rect, [72, 500, 272, 512], 1e-3, 'a click: 200 points wide, one line high');
  assert.match(await streamText(t), /BT\s+\/PCFHelvetica 14 Tf/);
});

test('an added item is its own tagged stream, kept after a save, and is not a page paragraph', async () => {
  const t = await session();
  const before = (await t.exec('edit.blocks', {page: 1})).result.blocks.length;
  await t.exec('edit.text', {page: 1, rect: [100, 300, 300, 330], text: 'Hello added'});
  const d = await source(t);
  const found = listAdded(d, d.getPage(0));
  assert.equal(found.length, 1);
  assert.equal(found[0].content.text, 'Hello added');
  const stream = d.context.lookup(found[0].ref);
  assert.equal(stream.dict.get(PDFName.of('PCMark')).decodeText(), 'Added');
  assert.equal((await t.exec('edit.blocks', {page: 1})).result.blocks.length, before, "the text editor leaves added text to the item's own editing");
  const again = await PDFDocument.load(await d.save());
  assert.equal(listAdded(again, again.getPage(0))[0].content.text, 'Hello added');
});

test('retyping, formatting, moving, resizing and deleting an added item', async () => {
  const t = await session();
  await t.exec('edit.text', {page: 1, rect: [100, 300, 200, 320], text: 'First'});
  await t.exec('edit.added_select', {page: 1, index: 0});
  await t.exec('edit.added_change', {change: 'text', text: 'Second words here'});
  assert.equal((await items(t))[0].text, 'Second words here');
  await t.exec('edit.added_change', {change: 'style', bold: true, size: 20, color: '#cc0000', align: 'center', family: 'Times'});
  let it = (await items(t))[0];
  assert.deepEqual([it.bold, it.size, it.color, it.align, it.family], [true, 20, '#CC0000', 'center', 'Times']);
  assert.match(await streamText(t), /\/PCFTimesBold 20 Tf/);
  const before = it.rect.slice();
  await t.exec('edit.added_change', {change: 'move', offset: [30, 40]});
  it = (await items(t))[0];
  nearRect([it.rect[0], it.rect[1]], [before[0] + 30, before[1] + 40]);
  await t.exec('edit.added_change', {change: 'resize', rect: [50, 100, 400, 150]});
  it = (await items(t))[0];
  near(it.rect[0], 50); near(it.rect[2], 400); near(it.rect[1], 100);
  await t.exec('edit.added_change', {change: 'delete'});
  assert.equal((await items(t)).length, 0);
  assert.doesNotMatch(await streamText(t), /PCF/);
  await assert.rejects(() => t.exec('edit.added_change', {page: 1, index: 3, change: 'delete'}), /no such added item/);
});

test('the Format text controls act on the selected added text, and say what is not available for it', async () => {
  const t = await session();
  await t.exec('edit.text', {page: 1, rect: [100, 300, 300, 330], text: 'Formatted'});
  assert.equal((await t.state('edit.format', {field: 'size'})).value, '12');
  await t.exec('edit.format', {field: 'size', value: 18});
  await t.exec('edit.format', {toggle: 'italic'});
  await t.exec('edit.format', {field: 'font', value: 'Courier'});
  await t.exec('edit.format', {field: 'align', value: 'right'});
  await t.exec('edit.format', {field: 'color', value: '#0000ff'});
  const it = (await items(t))[0];
  assert.deepEqual([it.size, it.italic, it.family, it.align, it.color], [18, true, 'Courier', 'right', '#0000FF']);
  assert.equal((await t.state('edit.format', {toggle: 'italic'})).checked, true);
  for (const args of [{toggle: 'underline'}, {field: 'lineSpacing'}, {field: 'scale'}]) {
    const st = await t.state('edit.format', args);
    assert.equal(st.enabled, false, JSON.stringify(args));
    assert.match(st.reason, /added text/);
  }
});

test('text no installed font can draw, and empty or too narrow boxes, are refused with nothing written', async () => {
  const t = await session();
  await assert.rejects(() => t.exec('edit.text', {page: 1, rect: [100, 300, 300, 330], text: `Private ${String.fromCodePoint(0x10FFFD)}`}), /standard fonts can't draw/);   // every script an installed font has is drawn (unicode-text and shaping tests); a character no font has is refused
  await assert.rejects(() => t.exec('edit.text', {page: 1, rect: [100, 300, 300, 330], text: '   '}), /type some text/);
  await assert.rejects(() => t.exec('edit.text', {page: 1, rect: [100, 300, 100.2, 330], text: 'x'}), /too narrow/);
  await assert.rejects(() => t.exec('edit.text', {page: 1, text: 'x'}), /box|starts/);
  assert.equal((await items(t)).length, 0);
});

test('on a page turned 90 degrees the item keeps the box it was given as the page shows it', async () => {
  const doc = await PDFDocument.load(await editPdf());
  doc.getPage(0).setRotation({type: 'degrees', angle: 90});
  const t = await session(await doc.save());
  await t.exec('edit.text', {page: 1, rect: [100, 200, 300, 230], text: 'Upright on a turned page'});
  const [it] = await items(t);
  nearRect([it.rect[0], it.rect[1], it.rect[2]], [100, 200, 300], 1e-3);
  const d = await source(t);
  assert.equal(listAdded(d, d.getPage(0))[0].content.text, 'Upright on a turned page');
});

test('a picture is added in the middle of the page, never enlarged, and is turned, flipped, cropped, replaced and deleted as an item', async () => {
  const page = (await PDFDocument.load(await editPdf())).getPage(0);
  nearRect(centredBox(page, 0, [100, 50]), [256, 371, 356, 421], 1e-6, 'at its own size, centred (612 x 792)');
  const big = centredBox(page, 0, [2000, 1000]);
  near(big[2] - big[0], 612 * 0.8, 1e-6, 'a large picture is brought to 80 % of the page');
  const t = await session();
  const r = (await t.exec('edit.image', {page: 1, base64: REPLACEMENT_PNG, name: 'red.png', rect: [100, 100, 200, 160]})).result;
  assert.equal(r.item.kind, 'image');
  await t.exec('edit.image_change', {change: 'rotate_cw'});
  assert.equal((await items(t))[0].rotation, 3);
  near((await items(t))[0].rect[2] - (await items(t))[0].rect[0], 60, 1e-6, 'the box swaps its sides about its centre');
  await t.exec('edit.image_change', {change: 'flip_h'});
  assert.equal((await items(t))[0].flipH, true);
  await t.exec('edit.image_change', {change: 'crop', percent: 10});
  assert.deepEqual((await items(t))[0].crop.map(v => +v.toFixed(3)), [0.1, 0.1, 0.1, 0.1]);
  await assert.rejects(() => t.exec('edit.image_change', {change: 'crop', percent: 48}), /47\.5/);
  const old = await source(t);
  const was = listAdded(old, old.getPage(0))[0].content.image.objectNumber;
  await t.exec('edit.image_replace', {base64: REPLACEMENT_PNG, name: 'again.png'});
  const next = await source(t);
  assert.notEqual(listAdded(next, next.getPage(0))[0].content.image.objectNumber, was, 'another picture is drawn');
  await t.exec('edit.image_change', {change: 'delete'});
  assert.equal((await items(t)).length, 0);
  await assert.rejects(() => t.exec('edit.image', {page: 1, base64: Buffer.from('not a picture').toString('base64'), name: 'x.png', rect: [1, 1, 50, 50]}), /PNG|JPEG|picture/);
});

test('the Add text tool is a toggle that puts the selection down; protected documents refuse adding', async () => {
  const t = await session();
  assert.equal((await t.exec('edit.text', {})).result.tool, 'edit.add_text');
  assert.equal((await t.state('edit.text', {})).checked, true);
  assert.equal((await t.exec('edit.text', {})).result.tool, null);
  const locked = await session(null, {permissions: {modify: false}});
  await assert.rejects(() => locked.exec('edit.text', {page: 1, rect: [1, 1, 100, 30], text: 'x'}), /security settings/);
});

test('layout: words wrap at the box width, every newline is a paragraph, and the height is 1.2 lines of the size', () => {
  const nl = String.fromCharCode(10);
  const t = {...defaultText(), rect: [0, 100, 60, 100], text: `one two three${nl}four`, size: 10};
  const lines = wrapped(t);
  assert.ok(lines.length >= 3);
  assert.deepEqual(lines.map(l => l[2]).filter((v, i, a) => a.indexOf(v) === i), [0, 1], 'two paragraphs');
  const r = textRect(t);
  near(r[3], 100); near(r[3] - r[1], lines.length * 12);
});
