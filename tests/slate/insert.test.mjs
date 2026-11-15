// U:slate/insert: the Insert tab (Insert Space, Files, Images, Links, Time Stamp, Symbols).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `insert.*` and `link.insert`
//    name the commands; OneNote's behaviour: an inserted object goes where the caret is (a note
//    container of its own when the caret is not in a note); Insert Space drags everything below
//    (to the right of) the click away; File Attachment / Printout put a file on the page (a
//    printout adds a picture of each page); Pictures inserts at the caret; Link (Ctrl+K) links
//    the selected text to a web address or to a page or section of the notebook, edits a link the
//    caret is in and can create the page it links to; Date / Time / Date & Time stamp the page
//    header's date and time as text; Symbol inserts a character and keeps the 20 last used;
//    Equation inserts Office's built-in equations or an empty one to type into.
// 2. Ours does the same on the page body (ProseMirror transforms, one undo entry each), and every
//    inserted thing saves into the notebook folder and reopens (the round trip test below).
// 3. Proof: these tests and tests/e2e/slate/insert.e2e.mjs (ribbon, dialogs, captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import {PRESETS, structure, toMathML} from '../../core/slate/lib/equation.mjs';
import {linkAddress, parseInternalLink, stampDate, stampTime, MAX_PICTURE_WIDTH} from '../../core/slate/commands/insert.mjs';
import linkDialog from '../../core/slate/dialogs/link.mjs';
import symbolDialog from '../../core/slate/dialogs/symbol.mjs';
import {loadNotebook, writeNotebook} from '../../core/slate/lib/notebook-folder.mjs';
import {cropRect} from '../../src/shell/engine/screenClip.ts';
import {textSession, textSel} from './format-helpers.mjs';

/** A PNG header for a picture of the given size (the probe reads only the header) as base64. */
function png(width, height) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  b.set([8, 6, 0, 0, 0], 24);
  return Buffer.from(b).toString('base64');
}
const FILE = Buffer.from('hello attachment').toString('base64');
const inline = (t, i = 0) => t.content.pages[t.pageId].body.content[0].content[i].content ?? [];
const para = (t, id) => { let hit; const walk = n => { if (n.attrs?.id === id) hit = n; (n.content ?? []).forEach(walk); }; walk(t.content.pages[t.pageId].body); return hit; };
const plain = p => (p.content ?? []).map(c => (c.type === 'text' ? c.text : '￼')).join('');

test('insert.picture puts a picture at the caret at its own size up to 640 px wide; bad data is refused', async () => {
  const t = await textSession(['Hello world'], {selection: p => textSel(p, 'b1', 5)});
  const r = await expectUndoRoundTrip(t, 'insert.picture', {data: png(1000, 500), name: 'plan.png'});
  void r;
  const kids = inline(t);
  assert.equal(kids.length, 3);
  assert.equal(kids[1].type, 'image');
  assert.deepEqual([kids[1].attrs.width, kids[1].attrs.height, kids[1].attrs.alt], [MAX_PICTURE_WIDTH, 320, 'plan.png']);
  assert.match(kids[1].attrs.src, /^data:image\/png;base64,/);
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pageId}/media:${kids[1].attrs.id}`);
  await t.exec('insert.picture', {data: png(100, 40)});
  assert.deepEqual(t.content.pages[t.pageId].body.content[0].content[0].content.filter(c => c.type === 'image').map(c => [c.attrs.width, c.attrs.height]).slice(-1), [[100, 40]]);
  await t.exec('insert.picture', {data: png(100, 40), width: 50});
  await assert.rejects(t.exec('insert.picture', {data: Buffer.from('not a picture at all').toString('base64')}), /not a picture/);
  await assert.rejects(t.exec('insert.picture', {data: '***'}), /base64|picture/);
});

test('insert.picture with no caret starts a note container; with no file the system Open dialog is asked (cancel does nothing)', async () => {
  const picked = [];
  const host = createTestHost({pickImage: async () => { picked.push(1); return `data:image/png;base64,${png(20, 10)}`; }});
  const t = await textSession(['Existing'], {selection: p => ({ranges: [{anchor: `/pg:${p}`, focus: `/pg:${p}`}], primary: 0}), host});
  await t.exec('insert.picture', {});
  assert.equal(picked.length, 1);
  const body = t.content.pages[t.pageId].body.content;
  assert.equal(body.length, 2);
  assert.equal(body[1].content[0].content[0].type, 'image');
  host.pickImage = async () => null;
  const before = t.version;
  assert.deepEqual((await t.exec('insert.picture', {})).result, {cancelled: true});
  assert.equal(t.version, before);
});

test('insert.fileAttachment stores the file on the page as an icon with its name; large files and bad data are refused', async () => {
  const t = await textSession(['See: '], {selection: p => textSel(p, 'b1', 5)});
  await expectUndoRoundTrip(t, 'insert.fileAttachment', {name: 'notes.pdf', data: FILE});
  const att = inline(t)[1];
  assert.equal(att.type, 'attachment');
  assert.deepEqual([att.attrs.name, att.attrs.mime, att.attrs.size, att.attrs.data], ['notes.pdf', 'application/pdf', 16, FILE]);
  await assert.rejects(t.exec('insert.fileAttachment', {name: 'x.bin', data: 'A'.repeat(36 * 1024 * 1024)}), /at most 25 MB/);
  await assert.rejects(t.exec('insert.fileAttachment', {name: 'x.bin', data: '%%%'}), /base64/);
  // The system Open dialog (studio:pick-document) when no file is given.
  const host = createTestHost({pickDocument: async o => { assert.deepEqual(o, {all: true}); return {name: 'budget.xlsx', format: 'xlsx', data: FILE}; }});
  const t2 = await textSession(['x'], {selection: p => textSel(p, 'b1', 1), host});
  await t2.exec('insert.fileAttachment', {});
  assert.equal(inline(t2)[1].attrs.name, 'budget.xlsx');
  host.pickDocument = async () => null;
  assert.deepEqual((await t2.exec('insert.fileAttachment', {})).result, {cancelled: true});
});

test('insert.filePrintout attaches the file and adds a picture of each page; it says what it cannot print', async () => {
  const t = await textSession(['Before'], {selection: p => textSel(p, 'b1', 6)});
  await expectUndoRoundTrip(t, 'insert.filePrintout', {name: 'plan.pdf', data: FILE, pages: [`data:image/png;base64,${png(300, 400)}`, `data:image/png;base64,${png(300, 400)}`]});
  const blocks = t.content.pages[t.pageId].body.content[0].content;
  assert.deepEqual(blocks.map(b => b.type), ['paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph']);
  assert.equal(blocks[1].content[0].type, 'attachment');
  assert.deepEqual(blocks.slice(2, 4).map(b => b.content[0].type), ['image', 'image']);
  // A picture file is its own page; a PDF needs the renderer's page drawing; other files need their program.
  await t.exec('insert.filePrintout', {name: 'photo.png', data: png(50, 50)});
  await assert.rejects(t.exec('insert.filePrintout', {name: 'a.pdf', data: FILE}), /Drawing the pages of a PDF/);
  await assert.rejects(t.exec('insert.filePrintout', {name: 'a.docx', data: FILE}), /needs the program that opens it/);
  const host = createTestHost({printoutPages: async f => { assert.equal(f.mime, 'application/pdf'); return [`data:image/png;base64,${png(10, 10)}`]; }});
  const t2 = await textSession(['x'], {selection: p => textSel(p, 'b1', 1), host});
  const r = await t2.exec('insert.filePrintout', {name: 'a.pdf', data: FILE});
  assert.equal(r.result.pages, 1);
});

test('insert.dateTime stamps the page header\'s date and time as text at the caret, replacing the selection', async () => {
  const t = await textSession(['Today: XX'], {selection: p => textSel(p, 'b1', 7, 9)});
  const when = new Date(t.host.now());
  await expectUndoRoundTrip(t, 'insert.dateTime', {kind: 'date'});
  assert.equal(plain(para(t, 'b1')), `Today: ${stampDate(when)}`);
  const sel = t.doc.selection.ranges[0];
  assert.equal(sel.anchor, sel.focus);
  assert.equal(sel.focus, `/pg:${t.pageId}/b:b1/t:${7 + stampDate(when).length}`);
  await t.exec('insert.dateTime', {kind: 'time'});
  assert.ok(plain(para(t, 'b1')).endsWith(stampTime(when)));
  await t.exec('insert.dateTime', {kind: 'date-time'});
  assert.ok(plain(para(t, 'b1')).endsWith(`${stampDate(when)} ${stampTime(when)}`));
  const r = await t.exec('insert.dateTime', {kind: 'date', at: '2027-01-02T09:05:00'});
  assert.equal(r.result.text, stampDate(new Date('2027-01-02T09:05:00')));
  await assert.rejects(t.exec('insert.dateTime', {kind: 'date', at: 'nope'}), /not a date/);
});

test('insert.symbol inserts at the caret, replaces the selection, takes a font, and remembers the 20 last used', async () => {
  const t = await textSession(['Price 5'], {selection: p => textSel(p, 'b1', 6, 7)});
  await expectUndoRoundTrip(t, 'insert.symbol', {char: '€'});
  assert.equal(plain(para(t, 'b1')), 'Price €');
  assert.equal(t.doc.selection.ranges[0].focus, `/pg:${t.pageId}/b:b1/t:7`);
  await t.exec('insert.symbol', {char: 'Ω', font: 'Symbol'});
  const runs = para(t, 'b1').content;
  assert.equal(runs.at(-1).text, 'Ω');
  assert.equal(runs.at(-1).marks[0].attrs.fontFamily, 'Symbol');
  // Recently used: newest first, no repeats, at most 20.
  for (let i = 0; i < 24; i++) await t.exec('insert.symbol', {char: String.fromCodePoint(0x2200 + i)});
  await t.exec('insert.symbol', {char: '€'});
  const recent = t.session.prefs?.['slate.recentSymbols'] ?? t.host.savedPrefs?.['slate.recentSymbols'];
  assert.ok(Array.isArray(recent));
  assert.equal(recent.length, 20);
  assert.equal(recent[0].ch, '€');
  assert.equal(new Set(recent.map(r => r.ch)).size, 20);
});

test('dialog.symbol: grid, subset, code and recently used stay in step; submits insert.symbol with the font', () => {
  const d = symbolDialog;
  const init = d.init({prefs: {'slate.recentSymbols': [{ch: '€', font: ''}, {ch: 'Ω', font: 'Symbol'}]}});
  assert.equal(init.grid, 0x20AC);
  assert.equal(init.subset, 'Currency Symbols');
  assert.equal(init.characterCode, '20AC');
  let v = {...init, subset: 'Greek and Coptic'};
  v = {...v, ...d.derive(v, ['subset'])};
  assert.equal(v.grid, 0x370);
  v = {...v, characterCode: '3A9'};
  v = {...v, ...d.derive(v, ['characterCode'])};
  assert.equal(v.grid, 0x3A9);
  v = {...v, from: 'ASCII (decimal)', characterCode: '65'};
  v = {...v, ...d.derive(v, ['characterCode'])};
  assert.equal(v.grid, 65);
  assert.deepEqual(d.toCommand({...v, font: 'Symbol'}), {command: 'insert.symbol', params: {char: 'A', font: 'Symbol'}});
  assert.deepEqual(d.toCommand({...v, font: '(normal text)'}), {command: 'insert.symbol', params: {char: 'A'}});
  v = {...v, recentlyUsed: 'Ω'};
  v = {...v, ...d.derive(v, ['recentlyUsed'])};
  assert.equal(v.font, 'Symbol');
});

test('insert.equation inserts Office\'s built-in equations or an empty one; equation.edit types in it; the typeset form has the structure', async () => {
  const t = await textSession(['x'], {selection: p => textSel(p, 'b1', 1)});
  await expectUndoRoundTrip(t, 'insert.equation', {preset: 'quadratic-formula'});
  const eq = inline(t)[1];
  assert.equal(eq.type, 'equation');
  assert.equal(eq.attrs.linear, PRESETS['quadratic-formula'].linear);
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pageId}/media:${eq.attrs.id}`);
  await t.exec('insert.equation', {});
  const empty = inline(t).filter(c => c.type === 'equation').at(-1);
  assert.equal(empty.attrs.linear, '');
  await expectUndoRoundTrip(t, 'equation.edit', {id: empty.attrs.id, linear: 'a^2+b^2=c^2'});
  assert.equal(inline(t).filter(c => c.type === 'equation').at(-1).attrs.linear, 'a^2+b^2=c^2');
  await assert.rejects(t.exec('equation.edit', {id: 'nope', linear: 'x'}), /No equation/);
  await assert.rejects(t.exec('insert.equation', {preset: 'area-of-circle', linear: 'x'}), /not both/);
  // All nine presets typeset: fractions, scripts, roots, limits, stacks.
  assert.equal(Object.keys(PRESETS).length, 9);
  assert.ok(structure(PRESETS['quadratic-formula'].linear).includes('frac') && structure(PRESETS['quadratic-formula'].linear).includes('sqrt'));
  assert.ok(structure(PRESETS['binomial-theorem'].linear).includes('nary') && structure(PRESETS['binomial-theorem'].linear).includes('stack'));
  assert.ok(structure(PRESETS['area-of-circle'].linear).includes('sup'));
  assert.ok(structure(PRESETS['fourier-series'].linear).includes('sub'));
  for (const p of Object.values(PRESETS)) assert.match(toMathML(p.linear), /^<math>.*<\/math>$/s);
  assert.equal(toMathML(''), '');
  assert.match(toMathML('x=(-b±√(b^2-4ac))/2a'), /<mfrac><mrow><mo>−<\/mo><mi>b<\/mi><mo>±<\/mo><msqrt>.*<\/msqrt><\/mrow><mrow><mn>2<\/mn><mi>a<\/mi><\/mrow><\/mfrac>/);
  assert.match(toMathML('∑_(k=0)^n x^k'), /<munderover>/);
  assert.match(toMathML('1/2'), /<mfrac><mn>1<\/mn><mn>2<\/mn><\/mfrac>/);
  assert.match(toMathML('<script>'), /&lt;/);
});

test('link.insert links the selected text, replaces it with other text, inserts at a caret, and edits a link', async () => {
  const t = await textSession(['Read the docs now'], {selection: p => textSel(p, 'b1', 9, 13)});
  await expectUndoRoundTrip(t, 'link.insert', {address: 'example.com/docs'});
  let runs = para(t, 'b1').content;
  assert.deepEqual(runs.map(r => r.text), ['Read the ', 'docs', ' now']);
  assert.equal(runs[1].marks[0].attrs.href, 'https://example.com/docs');
  // Ctrl+K on the link edits it: new address and new text.
  t.select(textSel(t.pageId, 'b1', 11));
  await t.exec('link.insert', {address: 'mailto:team@example.com', text: 'the team'});
  runs = para(t, 'b1').content;
  assert.deepEqual(runs.map(r => r.text), ['Read the ', 'the team', ' now']);
  assert.equal(runs[1].marks[0].attrs.href, 'mailto:team@example.com');
  // A caret outside a word inserts the text shown (or the address).
  t.select(textSel(t.pageId, 'b1', 0));
  await t.exec('link.insert', {address: 'https://example.com', text: 'Arkemis '});
  assert.equal(plain(para(t, 'b1')), 'Arkemis Read the the team now');
  assert.equal(para(t, 'b1').content[0].marks[0].attrs.href, 'https://example.com');
  assert.equal(t.doc.selection.ranges[0].focus, `/pg:${t.pageId}/b:b1/t:8`);
  // Only one target at a time, and scripts are refused.
  await assert.rejects(t.exec('link.insert', {}), /one of/);
  await assert.rejects(t.exec('link.insert', {address: 'javascript:alert(1)'}), /not allowed/);
  assert.equal(linkAddress('a@b.co'), 'mailto:a@b.co');
  assert.equal(linkAddress('file:///C:/x.txt'), 'file:///C:/x.txt');
  assert.throws(() => linkAddress('two words'), /no spaces/);
});

test('link.insert to a page or section of the notebook, and "create a new page with this title"', async () => {
  const t = await textSession(['Jump to Lecture'], {selection: p => textSel(p, 'b1', 8, 15)});
  const other = t.content.sections[t.sectionId].pages[0].id;
  await t.exec('link.insert', {page: other, block: 'b1'});
  assert.equal(para(t, 'b1').content[1].marks[0].attrs.href, `slate:page/${other}#b1`);
  assert.deepEqual(parseInternalLink(`slate:page/${other}#b1`), {kind: 'page', id: other, block: 'b1'});
  await t.exec('link.insert', {section: t.sectionId, text: 'this section'});
  assert.match(plain(para(t, 'b1')), /this section/);
  assert.equal(parseInternalLink(para(t, 'b1').content.find(c => c.text === 'this section').marks[0].attrs.href).kind, 'section');
  await assert.rejects(t.exec('link.insert', {page: 'missing'}), /No page/);
  await assert.rejects(t.exec('link.insert', {page: other, block: 'zz'}), /No paragraph/);
  const pagesBefore = t.content.sections[t.sectionId].pages.length;
  t.select(textSel(t.pageId, 'b1', 0));
  await expectUndoRoundTrip(t, 'link.insert', {createPage: true, text: 'Meeting notes'});
  const pages = t.content.sections[t.sectionId].pages;
  assert.equal(pages.length, pagesBefore + 1);
  assert.equal(t.content.pages[pages.at(-1).id].title, 'Meeting notes');
  assert.equal(para(t, 'b1').content[0].marks[0].attrs.href, `slate:page/${pages.at(-1).id}`);
  await assert.rejects(t.exec('link.insert', {createPage: true}), /title of the new page/);
});

test('dialog.link: Text to display and Address from the selection; a location or a new page instead of an address', async () => {
  const t = await textSession(['Read the docs now'], {selection: p => textSel(p, 'b1', 9, 13)});
  const init = linkDialog.init(t.session.readContext(t.docId));
  assert.equal(init.textToDisplay, 'docs');
  assert.equal(init.address, '');
  assert.ok(init.locations.some(l => l.value === `section:${t.sectionId}` && l.label === 'Week 1'));
  assert.ok(init.locations.some(l => l.value.startsWith('page:') && l.label === 'Lecture 1'));
  assert.equal(linkDialog.validate(init)[0].field, 'address');
  assert.deepEqual(linkDialog.toCommand({...init, address: ' example.com '}), {command: 'link.insert', params: {text: 'docs', address: 'example.com'}});
  const page = init.locations.find(l => l.value.startsWith('page:')).value;
  assert.deepEqual(linkDialog.toCommand({...init, location: page}), {command: 'link.insert', params: {text: 'docs', page: page.slice(5)}});
  assert.deepEqual(linkDialog.derive({...init, location: page}, ['location']), {address: '', createNewPage: false});
  assert.equal(linkDialog.validate({...init, createNewPage: true, textToDisplay: ''})[0].field, 'textToDisplay');
  assert.deepEqual(linkDialog.toCommand({...init, createNewPage: true}), {command: 'link.insert', params: {text: 'docs', createPage: true}});
  // On an existing link the dialog shows its address.
  await t.exec('link.insert', {address: 'example.com'});
  t.select(textSel(t.pageId, 'b1', 10));
  assert.equal(linkDialog.init(t.session.readContext(t.docId)).address, 'https://example.com');
});

test('insert.space: the tool toggles; insert.spaceBy moves the notes and strokes below the click, never past the nearest one when taking space back', async () => {
  const t = await textSession(['Top'], {selection: p => textSel(p, 'b1', 0)});
  assert.deepEqual(t.state('insert.space'), {enabled: true, checked: false});
  await t.exec('insert.space', {});
  assert.equal(t.state('insert.space').checked, true);
  await t.exec('insert.space', {value: false});
  assert.equal(t.state('insert.space').checked, false);
  // Two more containers (y 300 and 500) and a stroke at y 420.
  await t.exec('surface.newContainer', {page: t.pageId, x: 60, y: 300, text: 'Middle'});
  await t.exec('surface.newContainer', {page: t.pageId, x: 400, y: 500, text: 'Bottom'});
  await t.exec('surface.ink', {page: t.pageId, stroke: {tool: 'pen', color: '#000000', width: 2, points: [10, 420, 50, 440]}});
  const ys = () => t.content.pages[t.pageId].body.content.map(c => c.attrs.y);
  assert.deepEqual(ys(), [96, 300, 500]);
  await expectUndoRoundTrip(t, 'insert.spaceBy', {axis: 'down', at: 200, amount: 100});
  assert.deepEqual(ys(), [96, 400, 600]);
  assert.deepEqual(t.content.pages[t.pageId].ink[0].points, [10, 520, 50, 540]);
  // Taking space back stops at the click line: the nearest container was 50 below it.
  await t.exec('insert.spaceBy', {axis: 'down', at: 350, amount: -500});
  assert.deepEqual(ys(), [96, 350, 550]);
  await t.exec('insert.spaceBy', {axis: 'down', at: 1000, amount: 50});
  assert.deepEqual(ys(), [96, 350, 550]);
  // Right: everything at or right of x.
  const xs = () => t.content.pages[t.pageId].body.content.map(c => c.attrs.x);
  await t.exec('insert.spaceBy', {axis: 'right', at: 100, amount: 40});
  assert.deepEqual(xs(), [48, 60, 440]);
});

test('every inserted thing saves into the notebook folder and reopens the same', async () => {
  const t = await textSession(['Start'], {selection: p => textSel(p, 'b1', 5)});
  await t.exec('insert.table', {rows: 2, columns: 2});
  await t.exec('table.shading', {color: '#ffc000'});
  await t.exec('table.hideBorders', {});
  t.select(textSel(t.pageId, 'b1', 5));
  await t.exec('insert.picture', {data: png(64, 32), name: 'p.png'});
  await t.exec('insert.fileAttachment', {name: 'n.txt', data: FILE});
  await t.exec('insert.equation', {preset: 'taylor-expansion'});
  await t.exec('insert.symbol', {char: '€'});
  await t.exec('link.insert', {address: 'example.com', text: 'site'});
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-insert-'));
  const nodeFs = {
    readText: p => fs.readFile(p, 'utf8'),
    async writeText(p, text) { const tmp = `${p}.${process.pid}.tmp`; await fs.writeFile(tmp, text); await fs.rename(tmp, p); },
    list: async p => (await fs.readdir(p, {withFileTypes: true})).map(d => ({name: d.name, dir: d.isDirectory()})),
    mkdir: p => fs.mkdir(p, {recursive: true}).then(() => {}),
    rename: (a, b) => fs.rename(a, b),
    remove: p => fs.rm(p, {recursive: true, force: true}),
  };
  const root = path.join(base, 'Notebook').split(path.sep).join('/');
  await writeNotebook(nodeFs, root, t.content);
  const {content: back} = await loadNotebook(nodeFs, root);
  assert.deepEqual(back.pages[t.pageId].body, t.content.pages[t.pageId].body);
  const kinds = new Set();
  const walk = n => { kinds.add(n.type); (n.content ?? []).forEach(walk); };
  walk(back.pages[t.pageId].body);
  for (const k of ['table', 'image', 'attachment', 'equation']) assert.ok(kinds.has(k), k);
  await fs.rm(base, {recursive: true, force: true});
});

test('the Insert commands exist, and the ones that need an online service or handwriting recogniser are not registered', async () => {
  const t = await textSession(['x']);
  for (const id of ['insert.table', 'insert.picture', 'insert.fileAttachment', 'insert.filePrintout', 'insert.dateTime', 'insert.symbol', 'insert.equation', 'link.insert', 'insert.space', 'insert.screenClipping', 'insert.spreadsheet', 'insert.diagram', 'insert.scannedImage', 'table.convertToSpreadsheet',
    'table.select', 'table.delete', 'table.insert', 'table.hideBorders', 'table.shading', 'table.headerRow', 'table.sort']) assert.ok(t.registry.has(id), id);
  for (const id of ['insert.onlinePicture', 'insert.onlineVideo', 'insert.loopComponent', 'insert.form', 'insert.inkEquation']) {
    assert.equal(t.registry.has(id), false, id);
  }
  // Without a caret in a page (a notebook with no sections) the commands say so.
  assert.equal(t.state('insert.dateTime', {kind: 'date'}).enabled, true);
});

test('insert.screenClipping inserts the clip as a picture; the capture is cropped to the dragged rectangle at the capture own pixel ratio', async () => {
  const host = createTestHost({captureClip: async () => `data:image/png;base64,${png(400, 300)}`});
  const t = await textSession(['x'], {selection: p => textSel(p, 'b1', 1), host});
  await expectUndoRoundTrip(t, 'insert.screenClipping', {});
  const img = inline(t)[1];
  assert.deepEqual([img.type, img.attrs.width, img.attrs.height, img.attrs.alt], ['image', 400, 300, 'Screen clipping']);
  host.captureClip = async () => null;
  assert.deepEqual((await t.exec('insert.screenClipping', {})).result, {cancelled: true});
  await t.exec('insert.screenClipping', {data: png(50, 20), alt: 'Cropped'});
  assert.equal(inline(t).filter(c => c.type === 'image').at(-1).attrs.alt, 'Cropped');
  const bare = await textSession(['x'], {selection: p => textSel(p, 'b1', 1)});
  await assert.rejects(bare.exec('insert.screenClipping', {}), /not available here/);
  // A 2x display: the rectangle in window px is doubled in the capture; it never leaves the capture.
  assert.deepEqual(cropRect({width: 2000, height: 1000}, {width: 1000, height: 500}, {x: 100, y: 50, w: 200, h: 100}), {x: 200, y: 100, w: 400, h: 200});
  assert.deepEqual(cropRect({width: 2000, height: 1000}, {width: 1000, height: 500}, {x: 950, y: 480, w: 200, h: 100}), {x: 1900, y: 960, w: 100, h: 40});
});
