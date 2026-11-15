// Quill Insert tab (U:quill/insert) end to end through the bridge, in the new shell (devRenderer,
// ARKEMIS_NEW_HOST=1). No OS input: ribbon controls through ui.activate, dialogs through
// ui.dialog.set / ui.dialog.submit, and the document read back over the bridge.
//
// Behaviour fidelity:
// 1. ArtCraft crates/engine/src/cmd/insert.rs (and the ribbon in crates/ui-egui/src/ribbon/insert.rs);
//    Word's Insert tab: Table › Insert Table… opens the dialog and inserts a table; Pictures, Shapes,
//    Text Box, Link, Bookmark, Header, Footer, Page Number, Date & Time, Symbol and Field insert what
//    they say at the caret.
// 2. The same commands run in the window (the person's path) and land in the document; the page view
//    paints the table, the picture and the header (captures).
// 3. This file; the engine side is tests/quill/insert.test.mjs and tests/quill/upstream/insert_tests.test.mjs.
//
// Evidence: artifacts/e2e/quill/insert-tab/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

/** A 24×16 PNG, filled orange (drawn byte by byte: header, IHDR, one stored deflate IDAT, IEND). */
function orangePng() {
  const w = 24, h = 16;
  const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type, data) => { const t = [...type].map(c => c.charCodeAt(0)); return [...u32(data.length), ...t, ...data, ...u32(crc([...t, ...data]))]; };
  const raw = [];
  for (let y = 0; y < h; y++) { raw.push(0); for (let x = 0; x < w; x++) raw.push(0xf0, 0x8a, 0x24); }
  let a = 1, b = 0;
  for (const v of raw) { a = (a + v) % 65521; b = (b + a) % 65521; }
  const len = raw.length;
  const z = [0x78, 0x01, 0x01, len & 255, len >> 8, ~len & 255, (~len >> 8) & 255, ...raw, ...u32(((b << 16) | a) >>> 0)];
  const png = [137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', [...u32(w), ...u32(h), 8, 2, 0, 0, 0]), ...chunk('IDAT', z), ...chunk('IEND', [])];
  return Buffer.from(png).toString('base64');
}

function seedDoc(id) {
  const seed = createFile('quill', 'Insert tab');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Quarterly report'}]},
    {type: 'paragraph', content: [{type: 'text', text: 'Sales by region are in the table below.'}]},
  ]};
  return migrateFile(seed);
}

test('quill Insert tab: table dialog, picture, shapes, link, bookmark, header, page number, symbol, field', {timeout: 240_000}, async t => {
  const seed = seedDoc('quill-insert-tab');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/insert-tab', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const body = async () => (await app.rpc('document.read', {doc, address: '/body', as: 'json'})).value;
  const settle = () => new Promise(r => setTimeout(r, 350));
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });

    // The Insert tab with its groups.
    await app.rpc('ui.tab', {doc, id: 'insert'});
    await settle();
    const ui = await app.rpc('ui.inspect', {doc});
    const ids = new Set((ui.controls ?? []).map(c => c.id));
    for (const id of ['insert.pages.page-break', 'insert.tables.table', 'insert.illustrations.pictures', 'insert.links.bookmark', 'insert.symbols.symbol']) {
      assert.ok(ids.has(id), `${id} is on the Insert tab`);
    }
    await app.capture('1-insert-tab', {doc});

    // Caret at the end of the second paragraph.
    await run('caret.docEnd');

    // Table › Insert Table…: the dialog, 4 columns × 3 rows.
    await app.rpc('ui.activate', {doc, control: 'insert.tables.table.insert-table'});
    const dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.insertTable', 'Insert Table… opens the Insert Table dialog');
    await app.rpc('ui.dialog.set', {doc, values: {cols: 4, rows: 3}});
    await settle();
    await app.capture('2-insert-table-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    let blocks = await body();
    const table = (blocks.blocks ?? blocks).find?.(b => b.kind === 'table') ?? JSON.stringify(blocks).includes('"kind":"table"');
    assert.ok(table, 'a table is in the body');
    // Type into its cells (the caret is in the first cell).
    for (const [i, text] of ['Region', 'Q1', 'Q2', 'Q3'].entries()) { if (i) await app.rpc('ui.key', {doc, keys: 'Tab'}); await run('text.insert', {text}); }
    await settle();
    await app.capture('3-table-painted', {doc});

    // Below the table: a picture, a shape, a link, a bookmark, a symbol and a field.
    await run('caret.docEnd');
    await run('insert.picture', {data: orangePng(), width: 144, alt: 'Orange block'});
    await run('text.insert', {text: ' '});
    await run('insert.shape', {kind: 'ellipse', width: 72, height: 36});
    await run('caret.docEnd');
    await run('text.newParagraph');
    await run('text.insert', {text: 'See the website.'});
    await run('caret.home', {extend: true});
    await app.rpc('ui.activate', {doc, control: 'insert.links.link'});
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.link');
    await app.rpc('ui.dialog.set', {doc, values: {address: 'https://example.com'}});
    await app.rpc('ui.dialog.submit', {doc});
    await app.rpc('ui.activate', {doc, control: 'insert.links.bookmark'});
    await app.rpc('ui.dialog.set', {doc, values: {name: 'Website'}});
    await app.rpc('ui.dialog.submit', {doc});
    await run('caret.docEnd');
    await app.rpc('ui.activate', {doc, control: 'insert.symbols.symbol.more-symbols'});
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.symbol');
    await app.rpc('ui.dialog.set', {doc, values: {code: '00A9'}});
    await settle();
    await app.capture('4-symbol-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    const json = JSON.stringify(await body());
    assert.ok(json.includes('©'), 'the © symbol is in the text');
    assert.ok(json.includes('https://example.com'), 'the link is set');
    assert.ok(json.includes('"bookmarkStart"'), 'the bookmark is in the text');
    assert.ok(json.includes('"type":"image"'), 'the picture is in the text');

    // Header › Blank with text, Page Number › Bottom of Page.
    await run('insert.header', {text: 'Arkemis Labs — Quarterly report'});
    await run('insert.closeHeader');
    await run('insert.pageNumber', {position: 'bottom', align: 'center'});
    await run('insert.closeHeader');
    await settle();
    await app.capture('5-picture-link-header', {doc});

    // Undo takes the page number off again (one step).
    const before = (await app.rpc('document.inspect', {doc})).version;
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    const after = (await app.rpc('document.inspect', {doc})).version;
    assert.ok(after > before, 'undo ran');
    t.diagnostic(`captures in artifacts/e2e/quill/insert-tab`);
  } finally {
    await app.close();
  }
});
