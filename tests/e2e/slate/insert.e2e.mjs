// U:slate/insert: OneNote's Insert tab and Table Layout tab on a real notebook, end to end through
// the bridge: Insert Table (the grid picker's menu and the Insert Table dialog), the Table Layout
// tab (it appears with the caret in a table; Select, Insert, Delete, Hide Borders, Header Row,
// Shading, Sort), Date and Time stamps, Symbol (the recent gallery and the Symbol dialog),
// Equation (built-in and a new one to type into), Pictures, File Attachment, File Printout, Link
// (the dialog, a page link and its click), Insert Space (the tool and its drag) and Screen
// Clipping's crop. Every step is checked in the document (document.read) and captured.
//
// Behaviour fidelity: see tests/slate/insert.test.mjs and table.test.mjs.
// Evidence: artifacts/e2e/slate/insert/*.png. No OS or DOM input: ui.activate / ui.key / ui.menu /
// ui.pointer / ui.dialog.* / engine.execute only; the window is inactive and not focusable.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import {devRenderer, launchApp} from '../harness.mjs';
import {createContent, newPageRecord, SECTION_COLORS, validateContent} from '../../../core/slate/schema.mjs';

const NOW = '2026-10-30T09:30:00.000Z';
const para = (id, text) => ({type: 'paragraph', attrs: {id, style: 'normal', align: null, indent: 0, dir: null, tags: [], spacing: null, audio: null}, ...(text ? {content: [{type: 'text', text}]} : {})});

function seed() {
  let n = 0;
  const c = createContent('Physics 101', {uid: () => `i${(n++).toString(36).padStart(4, '0')}`, now: NOW});
  c.tree = ['sw1']; c.groups = {}; c.pages = {};
  c.sections = {sw1: {id: 'sw1', name: 'Week 1', color: SECTION_COLORS[0], created: NOW, pages: [{id: 'pnotes', level: 0}, {id: 'plab', level: 0}]}};
  c.pages.pnotes = {...newPageRecord({id: 'pnotes', title: 'Lecture notes', created: NOW}), body: {type: 'doc', content: [
    {type: 'container', attrs: {id: 'c1', x: 48, y: 120, width: 520}, content: [para('intro', 'Measurements from the lab session:'), para('after', 'Notes after the table')]},
    {type: 'container', attrs: {id: 'c2', x: 48, y: 560, width: 420}, content: [para('later', 'Homework: read chapter 4')]},
  ]}};
  c.pages.plab = {...newPageRecord({id: 'plab', title: 'Lab report', created: NOW}), body: {type: 'doc', content: [
    {type: 'container', attrs: {id: 'c3', x: 48, y: 120, width: 420}, content: [para('labline', 'See the lecture notes')]},
  ]}};
  return validateContent(c);
}

const fileOf = (id, content) => ({id, schema: 2, kind: 'slate', title: content.notebook.name, revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [], content});

/** A real PNG (RGBA, gradient with a frame) the page can draw. */
function makePng(w, h, rgb = [64, 120, 200]) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      const edge = x < 3 || y < 3 || x >= w - 3 || y >= h - 3;
      const k = edge ? 0.35 : 0.6 + 0.4 * (x / w);
      raw[o] = rgb[0] * k; raw[o + 1] = rgb[1] * k; raw[o + 2] = rgb[2] * k; raw[o + 3] = 255;
    }
  }
  const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

test('slate Insert tab and Table Layout tab work on a notebook through the ribbon, dialogs and the page', {timeout: 360_000}, async () => {
  const doc = 'slate-insert';
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'slate', flow: 'slate/insert', files: [fileOf(doc, seed())], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async (address, as = 'json') => (await app.rpc('document.read', {doc, address, as})).value;
  const select = (anchor, focus = anchor) => app.rpc('selection.set', {doc, ranges: [{anchor, focus}]});
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const body = async (page = 'pnotes') => (await read(`/pg:${page}`)).body ?? (await read(`/pg:${page}/meta`));
  const container = async id => read(`/pg:pnotes/c:${id}`);
  const tableOf = async () => (await container('c1')).content.find(n => n.type === 'table');
  const cellText = n => (n.content ?? []).map(c => (c.type === 'text' ? c.text : cellText(c))).join('');
  const grid = async () => (await tableOf()).content.map(r => r.content.map(cellText));
  const tabs = async () => (await app.rpc('ui.inspect', {doc})).tabs;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}).catch(() => null); return ui?.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000})
      .catch(e => { throw new Error(e.message + log()); });
    await app.rpc('ui.tab', {doc, id: 'insert'});
    await settle(800);
    await select('/pg:pnotes/b:intro/t:34');
    await app.capture('01-insert-tab', {doc});

    // ---- Insert Table: the grid picker's menu, then the Insert Table dialog -------------------------
    await app.rpc('ui.menu', {doc, control: 'insert.tables.table'});
    await settle(500);
    await app.capture('02-table-menu-grid-picker', {doc});
    await app.rpc('ui.menu', {doc, control: 'insert.tables.table', open: false});
    await app.rpc('ui.activate', {doc, control: 'insert.tables.table.insert-table'});
    let dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.insert-table');
    assert.deepEqual([dlg.values.columns, dlg.values.rows], [2, 2]);
    await app.rpc('ui.dialog.set', {doc, values: {columns: 3, rows: 4}});
    await app.capture('03-insert-table-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    assert.deepEqual((await grid()).map(r => r.length), [3, 3, 3, 3]);
    // The Table Layout tab comes with the caret in the table.
    const ctxTab = await app.until(async () => (await tabs()).find(t => /^table/.test(t)) || null, {timeout: 10_000})
      .catch(async () => { throw new Error(`The Table Layout tab did not show: ${JSON.stringify(await tabs())} ${JSON.stringify(await app.rpc('selection.get', {doc}))}`); });
    assert.ok(ctxTab);
    await settle(600);
    await app.capture('04-table-layout-tab', {doc});

    // Fill the table by typing into its cells (the page's own keyboard path), then format it.
    const tbl = await tableOf();
    const data = [['Trial', 'Mass (kg)', 'Time (s)'], ['3', '2.5', '1.9'], ['1', '1.2', '2.4'], ['2', '4.8', '1.1']];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
      const id = tbl.content[r].content[c].content[0].attrs.id;
      await select(`/pg:pnotes/b:${id}/t:0`);
      await settle(150);
      await app.rpc('ui.type', {doc, text: data[r][c]});
      await app.until(async () => (await cellText((await tableOf()).content[r].content[c])) === data[r][c] || null, {timeout: 10_000})
        .catch(async () => { throw new Error(`cell ${r},${c} did not take its text: ${JSON.stringify(await grid())} ${JSON.stringify((await app.rpc('selection.get', {doc})).selection)}`); });
    }
    assert.deepEqual(await grid(), data);
    await settle(400);
    await app.capture('05-table-filled', {doc});

    // Header Row, Hide Borders on and off, Shading on a selected row, Select Columns.
    await app.rpc('ui.activate', {doc, control: 'table.format.header-row'});
    assert.equal((await tableOf()).attrs.headerRow, true);
    await app.rpc('ui.activate', {doc, control: 'table.format.hide-borders'});
    assert.equal((await tableOf()).attrs.hideBorders, true);
    await settle(300);
    await app.capture('06-hide-borders', {doc});
    await app.rpc('ui.activate', {doc, control: 'table.format.hide-borders'});
    const t2 = await tableOf();
    await select(`/pg:pnotes/b:${t2.content[0].content[0].content[0].attrs.id}/t:0`);
    await app.rpc('ui.activate', {doc, control: 'table.select.select-rows'});
    assert.equal((await app.rpc('selection.get', {doc})).selection.ranges.length, 3);
    await app.rpc('ui.activate', {doc, control: 'table.format.shading.light-blue'});
    assert.deepEqual((await tableOf()).content.map(r => r.content.map(c => c.attrs.shading)), [['#00b0f0', '#00b0f0', '#00b0f0'], [null, null, null], [null, null, null], [null, null, null]]);
    await settle(400);
    await app.capture('07-row-shaded-selected', {doc});
    const t3 = await tableOf();
    await select(`/pg:pnotes/b:${t3.content[1].content[1].content[0].attrs.id}/t:0`);
    await app.rpc('ui.activate', {doc, control: 'table.select.select-columns'});
    await settle(400);
    await app.capture('08-column-selected', {doc});

    // Sort by the Mass column (caret in it), insert a row below and a column right, delete them again.
    await select(`/pg:pnotes/b:${t3.content[1].content[1].content[0].attrs.id}/t:0`);
    await app.rpc('ui.activate', {doc, control: 'table.data.sort.sort-ascending'});
    assert.deepEqual((await grid()).map(r => r[1]), ['Mass (kg)', '1.2', '2.5', '4.8']);
    await app.rpc('ui.activate', {doc, control: 'table.insert.insert-below'});
    await app.rpc('ui.activate', {doc, control: 'table.insert.insert-right'});
    assert.deepEqual((await grid()).map(r => r.length), [4, 4, 4, 4, 4]);
    await settle(400);
    await app.capture('09-row-and-column-added', {doc});
    assert.equal((await app.rpc('ui.key', {doc, keys: 'Mod+Enter'})).handled, true);
    await app.until(async () => (await grid()).length === 6 || null, {timeout: 10_000});
    await app.rpc('ui.activate', {doc, control: 'table.delete.delete-rows'});
    await app.rpc('ui.activate', {doc, control: 'table.delete.delete-columns'});
    await app.rpc('ui.activate', {doc, control: 'table.delete.delete-rows'});
    assert.deepEqual((await grid()).map(r => r.length), [3, 3, 3, 3]);

    // ---- Date, Time, Date & Time stamps in the paragraph after the table ------------------------------
    await select('/pg:pnotes/b:after/t:22');
    await app.rpc('ui.activate', {doc, control: 'insert.time-stamp.date'});
    await app.rpc('ui.activate', {doc, control: 'insert.time-stamp.time'});
    assert.equal((await app.rpc('ui.key', {doc, keys: 'Alt+Shift+F'})).handled, true);
    await app.until(async () => (await read('/pg:pnotes/b:after', 'text')).split(/\d{1,2}:\d{2}/).length >= 3 || null, {timeout: 10_000});

    // ---- Symbol: the recent gallery, then the Symbol dialog -------------------------------------------
    await select('/pg:pnotes/b:later/t:25');
    await app.rpc('ui.activate', {doc, control: 'insert.symbols.symbol.recent-4'});
    assert.ok((await read('/pg:pnotes/b:later', 'text')).endsWith('©'));
    await app.rpc('ui.activate', {doc, control: 'insert.symbols.symbol.more-symbols'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.symbol');
    await app.rpc('ui.dialog.set', {doc, values: {subset: 'Greek and Coptic', characterCode: '3A9'}});
    assert.equal((await app.rpc('ui.dialog.get', {doc})).values.grid, 0x3A9);
    await settle(400);
    await app.capture('10-symbol-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    assert.ok((await read('/pg:pnotes/b:later', 'text')).endsWith('©Ω'));

    // ---- Equation: a built-in one typeset, then a new one typed into -----------------------------------
    await select('/pg:pnotes/b:after/t:0');
    await app.rpc('ui.activate', {doc, control: 'insert.symbols.equation.quadratic-formula'});
    assert.equal((await container('c1')).content.at(-1).content[0].type, 'equation');
    await app.rpc('ui.activate', {doc, control: 'insert.symbols.equation.insert-new-equation'});
    await settle(700);
    await app.capture('11-equations', {doc});
    const eqs = [];
    const walk = n => { if (n.type === 'equation') eqs.push(n); (n.content ?? []).forEach(walk); };
    walk(await container('c1'));
    assert.deepEqual(eqs.map(e => e.attrs.linear).filter(Boolean), ['x=(-b±√(b^2-4ac))/2a']);
    await exec('equation.edit', {id: eqs.at(-1).attrs.id, linear: 'a^2+b^2=c^2'});

    // ---- Pictures, File Attachment, File Printout --------------------------------------------------------
    await select('/pg:plab/b:labline/t:21');
    await settle(500);
    await exec('insert.picture', {data: makePng(240, 120), name: 'Free-fall diagram'});
    await exec('insert.fileAttachment', {name: 'lab-data.csv', data: Buffer.from('trial,mass,time\n1,1.2,2.4\n').toString('base64')});
    await exec('insert.filePrintout', {name: 'worksheet.pdf', data: Buffer.from('%PDF-1.4 stub').toString('base64'), pages: [`data:image/png;base64,${makePng(180, 230, [180, 90, 60])}`]});
    // A real PDF is drawn page by page in the renderer (pdf.js), the window's own capture is clipped as a picture.
    const pdf = ['%PDF-1.4', '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj', '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 220 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
      '4 0 obj<</Length 44>>stream', 'BT /F1 24 Tf 20 50 Td (Hello PDF) Tj ET', 'endstream endobj', '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
      'trailer<</Root 1 0 R/Size 6>>', '%%EOF'].join('\n');
    const printed = await exec('insert.filePrintout', {name: 'hello.pdf', data: Buffer.from(pdf).toString('base64')});
    assert.equal(printed.pages, 1);
    const clip = await app.capture('clip-source', {doc});
    if (clip.file) {
      const clipped = await exec('insert.screenClipping', {data: (await fs.readFile(clip.file)).toString('base64')});
      assert.ok(clipped.width > 100 && clipped.height > 100);
    }
    await settle(900);
    await app.capture('12-picture-attachment-printout', {doc});
    const kinds = new Set();
    const walkKinds = n => { kinds.add(n.type); (n.content ?? []).forEach(walkKinds); };
    walkKinds(await read('/pg:plab/c:c3'));
    for (const k of ['image', 'attachment']) assert.ok(kinds.has(k), k);
    const pictures = [];
    const walkImages = n => { if (n.type === 'image') pictures.push(n); (n.content ?? []).forEach(walkImages); };
    walkImages(await read('/pg:plab/c:c3'));
    assert.ok(pictures.length >= 4, `the picture, the printout pages and the clip: ${pictures.length}`);
    assert.equal((await app.rpc('ui.inspect', {doc})).tabs.length > 0, true);

    // ---- Link: the dialog on selected text, then a page link and its click -------------------------------
    await select('/pg:pnotes/b:intro/t:0-12');
    await settle(500);
    assert.equal((await app.rpc('ui.key', {doc, keys: 'Mod+K'})).handled, true);
    dlg = await app.rpc('ui.dialog.get', {doc}).catch(() => null);
    assert.equal(dlg?.id, 'dialog.link');
    assert.equal(dlg.values.textToDisplay, 'Measurements');
    await app.rpc('ui.dialog.set', {doc, values: {search: 'lab'}});
    await settle(300);
    await app.capture('13-link-dialog', {doc});
    const plab = dlg.values.locations.find(l => l.value === 'page:plab');
    assert.ok(plab, 'the notebook tree lists the pages');
    await app.rpc('ui.dialog.set', {doc, values: {location: 'page:plab'}});
    await app.rpc('ui.dialog.submit', {doc});
    const linked = (await read('/pg:pnotes/b:intro')).content[0];
    assert.equal(linked.marks[0].attrs.href, 'slate:page/plab');
    await settle(500);
    await app.capture('14-linked-text', {doc});

    // ---- Insert Space: the tool, a drag below the first note, Esc ------------------------------------------
    const y2 = () => container('c2').then(c => c.attrs.y);
    const before = await y2();
    await app.rpc('ui.activate', {doc, control: 'insert.insert.insert-space'});
    const ui = await app.rpc('ui.inspect', {doc});
    const space = (ui.controls ?? []).find(c => c.id === 'insert.insert.insert-space');
    assert.ok(space, `Insert Space is on the ribbon: ${Object.keys(ui)}`);
    assert.equal(space.checked, true);
    await settle(400);
    await app.capture('15a-insert-space-tool-on', {doc});
    await app.rpc('ui.pointer', {doc, action: 'drag', target: 'space', x: 300, y: 500, to: {x: 300, y: 620}});
    await app.until(async () => (await y2()) === before + 120 || null, {timeout: 10_000});
    assert.equal(await (async () => (await app.rpc('engine.execute', {doc, command: 'insert.space', params: {value: false}})).result.value)(), false);
    await settle(400);
    await app.capture('15-insert-space', {doc});

    // ---- Undo takes the last insertion back --------------------------------------------------------------------
    await app.rpc('ui.key', {doc, keys: 'Mod+Z'});
    await app.until(async () => (await y2()) === before || null, {timeout: 10_000});
    await settle(500);
    await app.capture('16-final', {doc});
  } finally {
    await app.close();
  }
});
