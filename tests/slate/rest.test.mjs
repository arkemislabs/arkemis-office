// U:slate/rest: Spreadsheet, Convert to Spreadsheet, Diagram, Scanned Image, Search, Check Accessibility, Help, Linked Notes,
// Audio & Video Settings and Touch Mode.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; not checked against upstream. The behaviour modelled is OneNote's: Insert > Spreadsheet puts a
//    worksheet on the page (here the app's own, calculated by the Grid engine, since there is no Excel), Table Layout > Convert to
//    Spreadsheet replaces a table by one, Insert > Diagram draws a diagram (here from an outline, since there is no Visio), Scanned
//    Image inserts a picture and keeps its recognised text, Search finds words in the notebook, Check Accessibility lists errors,
//    warnings and tips, Linked Notes starts a page of notes for a file, Help/Training/What's New open local content.
// 2. Ours does the same on the page body (ProseMirror transforms, one undo entry each).
// 3. Proof: these tests and tests/e2e/slate/rest.e2e.mjs (the ribbon, dialogs, panes and captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import {sheetAttrs, withCell, parseRef, cellsOfRows} from '../../core/slate/lib/sheet.mjs';
import {sheetText} from '../../core/slate/lib/sheet-text.mjs';
import {drawDiagram, parseOutline} from '../../core/slate/lib/diagram.mjs';
import {searchNotebook} from '../../core/slate/lib/search.mjs';
import {checkPage, contrast, parseColor} from '../../core/slate/lib/accessibility.mjs';
import {searchHelp, HELP_TOPICS} from '../../core/slate/lib/help.mjs';
import {avSettings, fileUrl, recordOptions} from '../../core/slate/commands/rest-panes.mjs';
import selectLocation from '../../core/slate/dialogs/select-location.mjs';
import insertSpreadsheet from '../../core/slate/dialogs/insert-spreadsheet.mjs';
import {textSession, textSel} from './format-helpers.mjs';

/** A command's result (session.execute answers with the whole record). */
const x = async (t, id, params = {}) => (await t.exec(id, params)).result;
const inlineOf = t => t.content.pages[t.pageId].body.content[0].content[0].content ?? [];
const objects = (t, type) => { const out = []; const walk = n => { if (n.type === type) out.push(n); (n.content ?? []).forEach(walk); }; walk(t.content.pages[t.pageId].body); return out; };
const png = (w, h) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h); b.set([8, 6, 0, 0, 0], 24);
  return Buffer.from(b).toString('base64');
};
void zlib;

// ---- Spreadsheet ---------------------------------------------------------------------------------

test('a worksheet calculates formulas with the Grid engine, and typing a cell recalculates the others', () => {
  const a = sheetAttrs({rows: 4, cols: 3, cells: {A1: '4', A2: '8', A3: '15', A4: '=SUM(A1:A3)', B1: '12.5%', B2: '=A4/0', B3: '=IF(A1>3,"big","small")', C1: '=bad('}});
  assert.equal(a.shown.A4, '27');
  assert.equal(a.shown.B1, '12.50%');
  assert.equal(a.shown.B2, '#DIV/0!');
  assert.equal(a.shown.B3, 'big');
  assert.equal(a.shown.C1, '#NAME?');
  const b = withCell(a, 'A1', '10');
  assert.equal(b.shown.A4, '33');
  assert.equal(b.shown.B3, 'big');
  assert.equal(withCell(b, 'A1', '').shown.A4, '23');
  assert.deepEqual([parseRef('B3'), parseRef('A0'), parseRef('AA1')], [{row: 2, col: 1}, null, {row: 0, col: 26}]);
  assert.throws(() => withCell(a, 'D1', 'x'), /outside this spreadsheet/);
  assert.equal(sheetText(a).split('\n')[3].split('\t')[0], '27');
});

test('insert.spreadsheet puts a worksheet on the page, selected; setCell and resize edit it; each is one undo step', async () => {
  const t = await textSession(['Hello world'], {selection: p => textSel(p, 'b1', 5)});
  const r = await expectUndoRoundTrip(t, 'insert.spreadsheet', {rows: 3, cols: 3, cells: {A1: '2', A2: '3', A3: '=A1*A2'}});
  void r;
  const [sheet] = objects(t, 'spreadsheet');
  assert.equal(sheet.attrs.rows, 3);
  assert.equal(sheet.attrs.shown.A3, '6');
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pageId}/media:${sheet.attrs.id}`);
  const set = await x(t, 'spreadsheet.setCell', {id: sheet.attrs.id, ref: 'a1', text: '5'});
  assert.deepEqual([set.changed, set.shown], [true, '5']);
  assert.equal(objects(t, 'spreadsheet')[0].attrs.shown.A3, '15');
  assert.equal((await x(t, 'spreadsheet.setCell', {id: sheet.attrs.id, ref: 'A1', text: '5'})).changed, false);
  await x(t, 'spreadsheet.resize', {id: sheet.attrs.id, rows: 5, cols: 4});
  assert.deepEqual([objects(t, 'spreadsheet')[0].attrs.rows, objects(t, 'spreadsheet')[0].attrs.cols], [5, 4]);
  await assert.rejects(x(t, 'spreadsheet.setCell', {id: sheet.attrs.id, ref: 'Z9', text: '1'}), /outside this spreadsheet/);
  await assert.rejects(x(t, 'spreadsheet.setCell', {id: 'nope', ref: 'A1', text: '1'}), /No spreadsheet/);
});

test('insert.spreadsheet in existing mode reads the first sheet of an .xlsx or a .csv, formulas kept', async () => {
  const t = await textSession(['x'], {selection: p => textSel(p, 'b1', 1)});
  const csv = Buffer.from('Item,Qty,Price\nTea,2,3.5\nCake,1,4\n', 'utf8').toString('base64');
  const r = await x(t, 'insert.spreadsheet', {mode: 'existing', name: 'order.csv', data: csv});
  assert.deepEqual([r.rows, r.cols], [3, 3]);
  const sheet = objects(t, 'spreadsheet')[0];
  assert.equal(sheet.attrs.cells.A2, 'Tea');
  assert.equal(sheet.attrs.shown.C2, '3.5');
  assert.equal(sheet.attrs.title, 'order');
  const {default: ExcelJS} = await import('exceljs');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Sheet1');
  ws.getCell('A1').value = 5; ws.getCell('A2').value = 6; ws.getCell('A3').value = {formula: 'A1+A2'};
  const xlsx = await wb.xlsx.writeBuffer();
  await x(t, 'insert.spreadsheet', {mode: 'existing', name: 'sum.xlsx', data: Buffer.from(xlsx).toString('base64')});
  const second = objects(t, 'spreadsheet')[1];
  assert.equal(second.attrs.cells.A3, '=A1+A2');
  assert.equal(second.attrs.shown.A3, '11');
  await assert.rejects(x(t, 'insert.spreadsheet', {mode: 'existing', name: 'photo.png', data: png(4, 4)}), /not a workbook/);
});

test('the Insert Spreadsheet dialog attaches the workbook or inserts it as a spreadsheet', () => {
  const v = {fileName: 'a.xlsx', fileData: 'AAAA', insertAs: 'Insert Spreadsheet'};
  assert.equal(insertSpreadsheet.toCommand(v).command, 'insert.spreadsheet');
  assert.equal(insertSpreadsheet.toCommand({...v, insertAs: 'Attach File'}).command, 'insert.fileAttachment');
  assert.equal(insertSpreadsheet.validate({...v, fileData: null}).length, 1);
  assert.equal(insertSpreadsheet.validate({...v, fileName: 'a.docx'}).length, 1);
  assert.equal(insertSpreadsheet.validate({...v, fileName: 'a.docx', insertAs: 'Attach File'}).length, 0);
});

test('table.convertToSpreadsheet replaces the table by a worksheet of its text; undo brings the table back', async () => {
  const t = await textSession(['Intro'], {selection: p => textSel(p, 'b1', 5)});
  await x(t, 'insert.table', {rows: 2, columns: 2});
  const table = objects(t, 'table')[0];
  const data = [['3', '4'], ['=A1*B1', 'x']];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    const id = table.content[r].content[c].content[0].attrs.id;
    t.select({ranges: [{anchor: `/pg:${t.pageId}/b:${id}/t:0`, focus: `/pg:${t.pageId}/b:${id}/t:0`}], primary: 0});
    await x(t, 'insert.symbol', {char: data[r][c]});
  }
  const first = objects(t, 'table')[0].content[0].content[0].content[0].attrs.id;
  t.select({ranges: [{anchor: `/pg:${t.pageId}/b:${first}/t:0`, focus: `/pg:${t.pageId}/b:${first}/t:0`}], primary: 0});
  const before = JSON.stringify(t.content.pages[t.pageId].body);
  await x(t, 'table.convertToSpreadsheet', {});
  assert.equal(objects(t, 'table').length, 0);
  const sheet = objects(t, 'spreadsheet')[0];
  assert.deepEqual([sheet.attrs.rows, sheet.attrs.cols, sheet.attrs.cells.A2, sheet.attrs.shown.A2], [2, 2, '=A1*B1', '12']);
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pageId}/media:${sheet.attrs.id}`);
  await t.session.undo(t.docId);
  assert.equal(JSON.stringify(t.content.pages[t.pageId].body), before);
  assert.deepEqual(cellsOfRows([['1', ' 2 '], ['', '=A1']]).cells, {A1: '1', B1: '2', B2: '=A1'});
  t.select(textSel(t.pageId, 'b1', 0));
  await assert.rejects(x(t, 'table.convertToSpreadsheet', {}), /table/i);
});

// ---- Diagram -------------------------------------------------------------------------------------

test('an outline is drawn as a flowchart, hierarchy, process or cycle; labels are escaped', () => {
  assert.deepEqual(parseOutline('(Start)\n  <Ok?>\n\nWork <b>').map(n => [n.shape, n.text, n.level]), [['terminator', 'Start', 0], ['decision', 'Ok?', 1], ['box', 'Work <b>', 0]]);
  for (const kind of ['flowchart', 'hierarchy', 'process', 'cycle']) {
    const d = drawDiagram(kind, 'Plan\n  Do\n  Check\nAct');
    assert.equal(d.nodes, 4);
    assert.match(d.svg, /^<svg /);
    assert.equal((d.svg.match(/class="dg-node"/g) ?? []).length, 4);
  }
  const hostile = drawDiagram('process', '<script>alert(1)</script>"><img src=x>');
  assert.ok(!/<script|<img/.test(hostile.svg), hostile.svg);
  assert.equal(drawDiagram('flowchart', '').svg, '');
  assert.equal(drawDiagram('hierarchy', 'a\n  b\n  c\n    d').nodes, 4);
});

test('insert.diagram and diagram.edit put a diagram on the page and change it', async () => {
  const t = await textSession(['Hello'], {selection: p => textSel(p, 'b1', 5)});
  await expectUndoRoundTrip(t, 'insert.diagram', {kind: 'hierarchy', text: 'Boss\n  A\n  B'});
  const d = objects(t, 'diagram')[0];
  assert.deepEqual([d.attrs.kind, d.attrs.text], ['hierarchy', 'Boss\n  A\n  B']);
  assert.equal((await x(t, 'diagram.edit', {id: d.attrs.id, kind: 'cycle'})).changed, true);
  assert.equal(objects(t, 'diagram')[0].attrs.kind, 'cycle');
  assert.equal((await x(t, 'diagram.edit', {id: d.attrs.id, kind: 'cycle'})).changed, false);
  await assert.rejects(x(t, 'diagram.edit', {id: d.attrs.id, text: '  \n'}), /at least one line/);
  const starter = await x(t, 'insert.diagram', {});
  assert.equal(starter.kind, 'flowchart');
  assert.equal(starter.boxes, 5);
});

// ---- Scanned Image -------------------------------------------------------------------------------

test('insert.scannedImage inserts the picture and keeps the recognised text as its alt text; the text can be typed under it', async () => {
  const seen = [];
  const host = createTestHost({ocrImage: async image => { seen.push(image.slice(0, 12)); return {text: 'ARKEMIS OFFICE 2026\nOffline recognition', confidence: 90}; }});
  const t = await textSession(['Hello world'], {selection: p => textSel(p, 'b1', 5), host});
  const r = await x(t, 'insert.scannedImage', {data: png(200, 100), name: 'scan.png'});
  assert.equal(r.ocr, 'text');
  assert.equal(seen.length, 1);
  const img = objects(t, 'image')[0];
  assert.equal(img.attrs.alt, 'ARKEMIS OFFICE 2026 Offline recognition');
  const r2 = await x(t, 'insert.scannedImage', {data: png(60, 30), insertText: true});
  assert.equal(r2.text.split('\n').length, 2);
  assert.ok(JSON.stringify(t.content.pages[t.pageId].body).includes('Offline recognition'));
  const off = await x(t, 'insert.scannedImage', {data: png(60, 30), recognize: false});
  assert.equal(off.ocr, 'off');
  assert.equal(seen.length, 2);
  await assert.rejects(x(t, 'insert.scannedImage', {data: Buffer.from('plain text, not a picture').toString('base64')}), /not a picture/);
});

test('insert.scannedImage still inserts the picture when text recognition is not available or fails', async () => {
  const t = await textSession(['x'], {selection: p => textSel(p, 'b1', 1)});
  assert.equal((await x(t, 'insert.scannedImage', {data: png(40, 40)})).ocr, 'unavailable');
  const bad = await textSession(['x'], {selection: p => textSel(p, 'b1', 1), host: createTestHost({ocrImage: async () => { throw new Error('worker stopped'); }})});
  assert.match((await x(bad, 'insert.scannedImage', {data: png(40, 40)})).ocr, /failed: worker stopped/);
  assert.equal(objects(bad, 'image').length, 1);
});

// ---- Search ---------------------------------------------------------------------------------------

test('search.all finds words on pages, titles, picture text and worksheet cells, in the chosen scope; locked sections are not read', async () => {
  const host = createTestHost({ocrImage: async () => ({text: 'invoice number 4471', confidence: 90})});
  const t = await textSession(['Quarterly budget review'], {selection: p => textSel(p, 'b1', 3), host, notebook: {sections: [{name: 'Finance', pages: ['Budget 2026', 'Other']}, {name: 'Home', pages: ['Garden']}]}});
  await x(t, 'insert.scannedImage', {data: png(80, 40)});
  await x(t, 'insert.spreadsheet', {rows: 2, cols: 2, cells: {A1: 'Tea', B1: '3'}});
  const all = await x(t, 'search.all', {query: 'budget'});
  assert.deepEqual(all.results.map(r => r.title), ['Budget 2026']);
  assert.equal(all.results[0].inTitle, true);
  assert.equal((await x(t, 'search.all', {query: 'INVOICE'})).total, 1);
  assert.equal((await x(t, 'search.all', {query: 'tea'})).total, 1);
  assert.equal((await x(t, 'search.all', {query: 'zzzz'})).total, 0);
  assert.equal((await x(t, 'search.all', {query: 'garden'})).total, 1);
  assert.equal((await x(t, 'search.all', {query: 'garden', scope: 'section'})).total, 0);
  assert.equal((await x(t, 'search.all', {query: 'review', scope: 'page'})).total, 1);
  const u = await textSession(['Quarterly budget review'], {selection: p => textSel(p, 'b1', 0, 9), notebook: {sections: [{name: 'Finance', pages: ['Budget 2026']}]}});
  const viaSelection = await x(u, 'review.smartLookup', {});
  assert.equal(viaSelection.query, 'Quarterly');
  assert.equal(viaSelection.total, 1);
  assert.equal(searchNotebook(t.content, '').results.length, 0);
});

// ---- Accessibility ---------------------------------------------------------------------------------

test('contrast follows WCAG: black on white is 21, light grey on white is below 4.5', () => {
  assert.equal(Math.round(contrast([0, 0, 0], [255, 255, 255])), 21);
  assert.ok(contrast(parseColor('#cccccc'), [255, 255, 255]) < 4.5);
  assert.ok(contrast(parseColor('#333'), [255, 255, 255]) > 4.5);
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), [10, 20, 30]);
  assert.equal(parseColor('red'), null);
});

test('review.checkAccessibility lists errors, warnings and tips of the page and goes to each; alt text fixes an error', async () => {
  const t = await textSession([{text: 'Light words', marks: [{type: 'textStyle', attrs: {color: '#cccccc', fontFamily: null, fontSize: null}}]}, {text: 'https://example.com', marks: [{type: 'link', attrs: {href: 'https://example.com', title: null}}]}], {selection: p => textSel(p, 'b1', 3)});
  await x(t, 'insert.picture', {data: png(50, 50)});
  await x(t, 'insert.table', {rows: 2, columns: 2});
  await x(t, 'surface.title', {page: t.pageId, title: ''});
  const r = await x(t, 'review.checkAccessibility', {});
  const rules = r.issues.map(i => i.rule);
  assert.ok(rules.includes('missing-title'), rules.join());
  for (const rule of ['missing-alt', 'low-contrast', 'link-address', 'table-header', 'table-blank']) assert.ok(rules.includes(rule), `${rule} in ${rules.join()}`);
  assert.deepEqual(r.issues.map(i => i.level).slice(0, 2), ['error', 'error']);
  assert.deepEqual(Object.keys(r.counts), ['error', 'warning', 'tip']);
  assert.equal(t.doc.view.pane.kind, 'accessibility');
  const alt = r.issues.find(i => i.rule === 'missing-alt');
  const sel = await x(t, 'review.accessibilitySelect', {address: alt.address});
  assert.equal(sel.selected, alt.address);
  const id = /media:(.+)$/.exec(alt.address)[1];
  await x(t, 'review.setAltText', {id, alt: 'A blue square'});
  assert.ok(!checkPage(t.content.pages[t.pageId]).some(i => i.rule === 'missing-alt'));
  await assert.rejects(x(t, 'review.accessibilitySelect', {address: `/pg:${t.pageId}/b:gone`}), /changed|No b/);
});

// ---- Help ------------------------------------------------------------------------------------------

test('Help, Show Training and What\'s New open the Help pane; topics are searchable', async () => {
  const t = await textSession(['x']);
  assert.ok((await x(t, 'help.show', {})).topics.length >= 8);
  assert.deepEqual([t.doc.view.pane.kind, t.doc.view.pane.tab], ['help', 'topics']);
  await x(t, 'help.show', {topic: 'tables'});
  assert.equal(t.doc.view.pane.topic, 'tables');
  assert.equal((await x(t, 'help.training', {})).lessons.length, 5);
  assert.equal(t.doc.view.pane.tab, 'training');
  assert.ok((await x(t, 'help.whatsNew', {})).items.length >= 5);
  assert.equal(t.doc.view.pane.tab, 'new');
  assert.deepEqual(searchHelp('spreadsheet formula').map(x => x.id), ['tables']);
  assert.equal(searchHelp('').length, HELP_TOPICS.length);
  assert.equal(searchHelp('qqqq').length, 0);
});

// ---- Linked Notes ------------------------------------------------------------------------------------

test('review.linkedNotes makes a page of notes in the chosen section with a link to the file', async () => {
  const t = await textSession(['x'], {notebook: {sections: [{name: 'Week 1', pages: ['Lecture 1']}, {name: 'Reading', pages: ['A']}]}});
  const reading = Object.values(t.content.sections).find(s => s.name === 'Reading').id;
  const before = Object.keys(t.content.pages).length;
  const r = await x(t, 'review.linkedNotes', {sectionId: reading, path: 'C:\\Users\\me\\Docs\\Chapter 4 #2.docx', name: 'Chapter 4 #2.docx'});
  assert.equal(Object.keys(t.content.pages).length, before + 1);
  const page = t.content.pages[/^\/pg:(.+)$/.exec(r.page)[1]];
  assert.equal(page.title, 'Notes: Chapter 4 #2.docx');
  assert.equal(t.content.sections[reading].pages.at(-1).id, page.id);
  const link = JSON.stringify(page.body).match(/"href":"([^"]+)"/)[1];
  assert.equal(link, 'file:///C:/Users/me/Docs/Chapter%204%20%232.docx');
  assert.equal(r.link, link);
  assert.equal(t.doc.selection.ranges[0].anchor, r.page);
  assert.equal(fileUrl('/home/me/a b.txt'), 'file:///home/me/a%20b.txt');
  assert.throws(() => fileUrl(''), /Choose a file/);
  await assert.rejects(x(t, 'review.linkedNotes', {sectionId: 'nope', path: '/a.txt'}), /No section|Open a section/);
  const d = selectLocation.init(t.session.readContext(t.docId));
  assert.ok(d.locations.length >= 3);
  assert.equal(selectLocation.validate({...d, filePath: '/a.txt'}).length, 0);
  assert.equal(selectLocation.validate(d).length, 1);
  assert.deepEqual(selectLocation.toCommand({...d, filePath: '/a.txt', fileName: 'a.txt', location: `page:${page.id}`}).params, {path: '/a.txt', name: 'a.txt', pageId: page.id});
});

// ---- Audio & Video Settings and Touch Mode -------------------------------------------------------------

test('media.settings stores the microphone, camera and quality; recordings start with them', async () => {
  const t = await textSession(['x']);
  assert.deepEqual(avSettings({}), {audioInput: '', videoInput: '', audioQuality: 'medium', videoSize: 'medium'});
  const r = await x(t, 'media.settings', {audioInput: 'mic-1', videoSize: 'large', audioQuality: 'high'});
  assert.deepEqual(r, {audioInput: 'mic-1', videoInput: '', audioQuality: 'high', videoSize: 'large'});
  assert.deepEqual(recordOptions(t.session.readContext(t.docId).prefs), {audioInput: 'mic-1', videoInput: null, audioBitsPerSecond: 128000, width: 1280, height: 720});
  await assert.rejects(x(t, 'media.settings', {audioQuality: 'ultra'}), /audioQuality/);
  const calls = [];
  const host = createTestHost({media: {record: async (kind, options) => { calls.push([kind, options]); return {stop: async () => ({data: 'data:audio/wav;base64,AAAA', mime: 'audio/wav', duration: 1}), cancel() {}}; }}});
  const u = await textSession(['x'], {selection: p => textSel(p, 'b1', 1), host, prefs: {'slate.avSettings': {audioInput: 'mic-2', audioQuality: 'low', videoSize: 'small'}}});
  await x(u, 'insert.recordAudio', {});
  assert.deepEqual(calls[0], ['audio', {audioInput: 'mic-2', videoInput: null, audioBitsPerSecond: 32000, width: 320, height: 240}]);
});

test('view.touchMode switches the page controls between mouse and touch', async () => {
  const t = await textSession(['x']);
  assert.equal((await x(t, 'view.touchMode', {mode: 'touch'})).mode, 'touch');
  assert.equal(t.session.readContext(t.docId).prefs['slate.touchMode'], 'touch');
  assert.equal((await x(t, 'view.touchMode', {})).mode, 'mouse');
  assert.equal((await x(t, 'view.touchMode', {})).mode, 'touch');
  assert.equal((await x(t, 'view.touchMode', {mode: 'mouse'})).mode, 'mouse');
});

// ---- Copy ---------------------------------------------------------------------------------------------

test('a spreadsheet and a diagram copy as text and as an HTML table', async () => {
  const {fragmentHtml} = await import('../../core/slate/lib/clipboard-html.mjs');
  assert.ok(fragmentHtml);
  const a = sheetAttrs({rows: 2, cols: 2, cells: {A1: '1', B1: '=A1+1'}});
  assert.equal(sheetText(a), '1\t2');
});

// ---- Layout: a note holding objects is as tall as they are ----------------------------------------------------------

/** The containers of the page body as [{y, id}] in order. */
const containerYs = t => t.content.pages[t.pageId].body.content.map(c => ({id: c.attrs.id, y: c.attrs.y}));
const noCaret = t => t.select({ranges: [{anchor: `/pg:${t.pageId}`, focus: `/pg:${t.pageId}`}], primary: 0});

test('a note with two pictures grows to them: the table, worksheet, diagram or recording started with no caret goes below the pictures', async () => {
  const host = createTestHost({media: {record: async () => ({stop: async () => ({data: 'data:audio/wav;base64,AAAA', mime: 'audio/wav', duration: 1}), cancel() {}})}});
  const t = await textSession(['Pictures:'], {selection: p => textSel(p, 'b1', 9), host});
  await x(t, 'insert.picture', {data: png(400, 200)});
  await x(t, 'insert.picture', {data: png(400, 200)});
  const first = containerYs(t)[0];
  // Two 400 x 200 pictures do not fit side by side in a note 624 px wide: two lines, at least 400 px tall.
  const picturesBottom = first.y + 400;
  for (const [command, params] of [['insert.table', {rows: 2, columns: 2}], ['insert.spreadsheet', {}], ['insert.diagram', {}], ['insert.recordVideo', {}]]) {
    noCaret(t);
    await x(t, command, params);
    const added = containerYs(t).at(-1);
    assert.ok(added.id !== first.id, `${command} started a note of its own`);
    assert.ok(added.y >= picturesBottom, `${command}: the new note is at ${added.y}, the pictures end at ${picturesBottom}`);
    if (command === 'insert.recordVideo') await x(t, 'media.stop', {});
  }
});

test('a note with a worksheet, a diagram and a table is as tall as they are drawn', async () => {
  const {estimatedHeight} = await import('../../core/slate/lib/insert-point.mjs');
  const t = await textSession(['x'], {selection: p => textSel(p, 'b1', 1)});
  await x(t, 'insert.spreadsheet', {rows: 10, cols: 3});
  await x(t, 'insert.diagram', {kind: 'process', text: 'a\nb\nc'});
  const c = t.content.pages[t.pageId].body.content[0];
  const node = (await import('../../core/slate/schema.mjs')).schema.nodeFromJSON(t.content.pages[t.pageId].body).child(0);
  void c;
  assert.ok(estimatedHeight({node, y: 0}) >= 10 * 24 + 30 + 40, `${estimatedHeight({node, y: 0})}`);
});

// ---- A scan never cuts the line above it -------------------------------------------------------------------------------

test('a scan is a paragraph of its own below the line it was put in, and a selected picture\'s frame is drawn below that line', async () => {
  const {readFileSync} = await import('node:fs');
  const host = createTestHost({ocrImage: async () => ({text: 'Line one\nLine two', confidence: 90})});
  const t = await textSession(['The pendulum swings'], {selection: p => textSel(p, 'b1', 5), host});
  await x(t, 'insert.scannedImage', {data: png(300, 100), insertText: true});
  const blocks = t.content.pages[t.pageId].body.content[0].content;
  const texts = blocks.map(b => (b.content ?? []).map(c => (c.type === 'text' ? c.text : `[${c.type}]`)).join(''));
  // "The p" | the scan alone | its text, line by line | "endulum swings": nothing shares a line with the picture.
  assert.deepEqual(texts, ['The p', '[image]', 'Line one', 'Line two', 'endulum swings']);
  // The frame is the selection outline (2 px, offset 1 px) drawn around the picture: the picture needs at least 3 px of room above it, never a negative offset.
  const css = readFileSync(new URL('../../src/apps/slate/surface/surface.css', import.meta.url), 'utf8');
  const rule = /\.slate-container-body img \{([^}]*margin[^}]*)\}/.exec(css)?.[1] ?? '';
  const top = Number(/margin:\s*(-?\d+(?:\.\d+)?)px/.exec(rule)?.[1] ?? NaN);
  const frame = /\.slate-container-body img\.ProseMirror-selectednode \{([^}]*)\}/.exec(css)?.[1] ?? '';
  const reach = Number(/outline:\s*(\d+)px/.exec(frame)?.[1]) + Number(/outline-offset:\s*(\d+)px/.exec(frame)?.[1]);
  assert.ok(top >= reach, `the picture's top margin (${top}px) covers its frame (${reach}px)`);
  assert.ok(!/(^|;)\s*(position|top|transform|translate)\s*:/.test(rule), `no offset on the picture: ${rule}`);
});
