// U:slate/rest: Spreadsheet (new, existing, converted from a table), Diagram, Scanned Image (real offline OCR through the OCR worker),
// Search, Check Accessibility, Help / Training / What's New, Linked Notes, Audio & Video Settings and Touch Mode, on a real notebook,
// end to end through the bridge: ribbon presses, dialogs, panes, and every result read back from the document. Captures are in
// artifacts/e2e/slate/rest/*.png.
//
// Behaviour fidelity: see tests/slate/rest.test.mjs. No OS or DOM input: ui.activate / ui.menu / ui.dialog.* / ui.pointer /
// engine.execute only; the window is inactive and not focusable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {devRenderer, launchApp} from '../harness.mjs';
import {createContent, newPageRecord, SECTION_COLORS, validateContent} from '../../../core/slate/schema.mjs';

const NOW = '2026-10-30T09:30:00.000Z';
const para = (id, text, marks) => ({type: 'paragraph', attrs: {id, style: 'normal', align: null, indent: 0, dir: null, tags: [], spacing: null, audio: null}, ...(text ? {content: [{type: 'text', text, ...(marks ? {marks} : {})}]} : {})});

function seed() {
  let n = 0;
  const c = createContent('Physics 101', {uid: () => `i${(n++).toString(36).padStart(4, '0')}`, now: NOW});
  c.tree = ['sw1', 'sr1']; c.groups = {}; c.pages = {};
  c.sections = {
    sw1: {id: 'sw1', name: 'Week 1', color: SECTION_COLORS[0], created: NOW, pages: [{id: 'pnotes', level: 0}, {id: 'pext', level: 0}]},
    sr1: {id: 'sr1', name: 'Reading', color: SECTION_COLORS[2], created: NOW, pages: [{id: 'pread', level: 0}]},
  };
  c.pages.pnotes = {...newPageRecord({id: 'pnotes', title: 'Lecture notes', created: NOW}), body: {type: 'doc', content: [
    {type: 'container', attrs: {id: 'c1', x: 48, y: 110, width: 560}, content: [
      para('intro', 'Measurements from the lab session:'),
      para('faint', 'A faint remark that is hard to read', [{type: 'textStyle', attrs: {color: '#c9c9c9', fontFamily: null, fontSize: null}}]),
      para('after', 'Notes after the objects')]},
  ]}};
  c.pages.pext = {...newPageRecord({id: 'pext', title: 'Extra', created: NOW}), body: {type: 'doc', content: [
    {type: 'container', attrs: {id: 'c2', x: 48, y: 110, width: 420}, content: [para('extra', 'The pendulum swings slowly')]}]}};
  c.pages.pread = {...newPageRecord({id: 'pread', title: 'Chapter list', created: NOW}), body: {type: 'doc', content: [
    {type: 'container', attrs: {id: 'c3', x: 48, y: 110, width: 420}, content: [para('read', 'Chapters 1 to 4')]}]}};
  return validateContent(c);
}
const fileOf = (id, content) => ({id, schema: 2, kind: 'slate', title: content.notebook.name, revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [], content});

test('slate rest: spreadsheet, diagram, scanned image, search, accessibility, help, linked notes, audio & video settings and touch mode', {timeout: 600_000}, async () => {
  const doc = 'slate-rest';
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'slate', flow: 'slate/rest', files: [fileOf(doc, seed())], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async (address, as = 'json') => (await app.rpc('document.read', {doc, address, as})).value;
  const select = (anchor, focus = anchor) => app.rpc('selection.set', {doc, ranges: [{anchor, focus}]});
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const objects = async (type, page = 'pnotes') => { const out = []; const walk = n => { if (n.type === type) out.push(n); (n.content ?? []).forEach(walk); }; walk((await read(`/pg:${page}`)).body ?? (await read(`/pg:${page}/meta`))); return out; };
  const dialog = () => app.rpc('ui.dialog.get', {doc});
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}).catch(() => null); return ui?.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000})
      .catch(e => { throw new Error(e.message + log()); });
    await app.rpc('ui.tab', {doc, id: 'insert'});
    await settle(800);
    await select('/pg:pnotes/b:intro/t:34');

    // ---- Spreadsheet: New Spreadsheet from the ribbon, cells typed, formulas calculated -------------------------------------------
    await app.rpc('ui.menu', {doc, control: 'insert.files.spreadsheet'});
    await settle(400);
    await app.capture('01-spreadsheet-menu', {doc});
    await app.rpc('ui.menu', {doc, control: 'insert.files.spreadsheet', open: false});
    await app.rpc('ui.activate', {doc, control: 'insert.files.spreadsheet.new-spreadsheet'});
    let [sheet] = await objects('spreadsheet');
    assert.ok(sheet, 'a worksheet is on the page');
    assert.deepEqual([sheet.attrs.rows, sheet.attrs.cols], [6, 5]);
    for (const [ref, text] of [['A1', 'Item'], ['B1', 'Qty'], ['C1', 'Price'], ['D1', 'Total'], ['A2', 'Tea'], ['B2', '4'], ['C2', '2.5'], ['D2', '=B2*C2'], ['A3', 'Cake'], ['B3', '2'], ['C3', '3.75'], ['D3', '=B3*C3'], ['A4', 'Sum'], ['D4', '=SUM(D2:D3)'], ['D5', '=D4/0']]) {
      await exec('spreadsheet.setCell', {id: sheet.attrs.id, ref, text});
    }
    [sheet] = await objects('spreadsheet');
    assert.deepEqual([sheet.attrs.shown.D2, sheet.attrs.shown.D3, sheet.attrs.shown.D4, sheet.attrs.shown.D5], ['10', '7.5', '17.5', '#DIV/0!']);
    await select(`/pg:pnotes/media:${sheet.attrs.id}`);
    await settle(700);
    await app.capture('02-spreadsheet-with-formulas', {doc});

    // ---- Existing Spreadsheet: the dialog (a .csv here), then Attach File is the other choice -----------------------------------------
    await app.rpc('ui.menu', {doc, control: 'insert.files.spreadsheet'});
    await app.rpc('ui.menu', {doc, control: 'insert.files.spreadsheet', open: false});
    await app.rpc('ui.activate', {doc, control: 'insert.files.spreadsheet.existing-spreadsheet'});
    assert.equal((await dialog()).id, 'dialog.insert-spreadsheet');
    await assert.rejects(app.rpc('ui.dialog.submit', {doc}), /Choose a workbook/);
    await app.rpc('ui.dialog.set', {doc, values: {fileName: 'scores.csv', fileData: Buffer.from('Name,Score\nAda,91\nGrace,97\nTotal,188\n').toString('base64'), insertAs: 'Insert Spreadsheet'}});
    await settle(500);
    await app.capture('03-existing-spreadsheet-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    await settle(500);
    const sheets = await objects('spreadsheet');
    assert.equal(sheets.length, 2);
    assert.equal(sheets[1].attrs.shown.B4, '188');
    assert.equal(sheets[1].attrs.title, 'scores');

    // ---- Diagram: New Diagram, then the dialog changes it to a hierarchy -----------------------------------------------------------------
    await app.rpc('ui.menu', {doc, control: 'insert.files.diagram'});
    await app.rpc('ui.menu', {doc, control: 'insert.files.diagram', open: false});
    await app.rpc('ui.activate', {doc, control: 'insert.files.diagram.new-diagram'});
    const [flow] = await objects('diagram');
    assert.equal(flow.attrs.kind, 'flowchart');
    await select(`/pg:pnotes/media:${flow.attrs.id}`);
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.diagram'});
    assert.equal((await dialog()).values.id, flow.attrs.id);
    await app.rpc('ui.dialog.set', {doc, values: {kind: 'hierarchy', text: 'Lab report\n  Method\n    Apparatus\n    Procedure\n  Results\n  Discussion'}});
    await settle(400);
    await app.capture('04-diagram-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    await settle(500);
    assert.equal((await objects('diagram'))[0].attrs.kind, 'hierarchy');
    await exec('insert.diagram', {kind: 'cycle', text: 'Plan\nDo\nCheck\nAct'});
    await settle(500);
    await select(`/pg:pnotes/media:${(await objects('diagram'))[0].attrs.id}`);
    await settle(500);
    await app.capture('05-diagrams-on-page', {doc});
    // Existing Visio Diagram stays hidden: the Diagram menu offers only New Diagram.
    assert.equal((await app.rpc('ui.inspect', {doc})).controls.some(c => c.id === 'insert.files.diagram.existing-diagram'), false);

    // ---- Scanned Image: a real picture of printed text, read offline by the OCR worker ----------------------------------------------------
    const scan = `data:image/png;base64,${(await fs.readFile(new URL('../../fixtures/ocr-english.png', import.meta.url))).toString('base64')}`;
    await select('/pg:pext/b:extra/t:5');
    await app.rpc('ui.activate', {doc, control: 'insert.images.scanned-image'});
    assert.equal((await dialog()).id, 'dialog.scanned-image');
    await assert.rejects(app.rpc('ui.dialog.submit', {doc}), /Choose the image/);
    await app.rpc('ui.dialog.set', {doc, values: {fileName: 'scan.png', fileData: scan, recognize: true, insertText: true}});
    await settle(700);
    await app.capture('06-scanned-image-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    const [picture] = await objects('image', 'pext');
    assert.ok(picture, 'the scan is on the page');
    assert.match(picture.attrs.alt, /ARKEMIS OFFICE 2026/, `the recognised text is the alt text: ${picture.attrs.alt}`);
    assert.match(JSON.stringify((await read('/pg:pext')).body ?? await read('/pg:pext/meta')), /Offline recognition/);
    await select('/pg:pext');
    await settle(600);
    await app.capture('07-scanned-image-on-page', {doc});

    // ---- Search: the Review button searches the selection; the pane lists the pages and opens one ---------------------------------------------
    await app.rpc('ui.tab', {doc, id: 'review'});
    await settle(600);
    await select('/pg:pnotes/b:after/t:0', '/pg:pnotes/b:after/t:5');
    await app.rpc('ui.activate', {doc, control: 'review.insights.search'});
    await settle(700);
    await app.capture('08-search-pane-selection', {doc});
    const found = await exec('search.all', {query: 'arkemis'});
    assert.deepEqual(found.results.map(r => r.page), ['pext']);
    await settle(500);
    await app.capture('09-search-pane-picture-text', {doc});
    const two = await exec('search.all', {query: 'swings', scope: 'section'});
    assert.equal(two.total, 1);
    assert.equal((await exec('search.all', {query: 'chapters', scope: 'section'})).total, 0);
    assert.equal((await exec('search.all', {query: 'chapters'})).total, 1);

    // ---- Check Accessibility ---------------------------------------------------------------------------------------------------------------------
    await select('/pg:pnotes');
    await app.rpc('ui.activate', {doc, control: 'review.accessibility.check-accessibility'});
    await settle(700);
    const a11y = await exec('review.checkAccessibility', {});
    const rules = a11y.issues.map(i => i.rule);
    assert.ok(rules.includes('low-contrast') && !rules.includes('missing-title'), rules.join());
    await app.capture('10-accessibility-pane', {doc});
    await select('/pg:pext');
    await exec('insert.picture', {data: (await fs.readFile(new URL('../../fixtures/ocr-english.png', import.meta.url))).toString('base64'), alt: ''});
    await exec('surface.title', {page: 'pext', title: ''});
    const issues = (await exec('review.checkAccessibility', {})).issues;
    assert.deepEqual(issues.slice(0, 2).map(i => i.rule).sort(), ['missing-alt', 'missing-title']);
    const alt = issues.find(i => i.rule === 'missing-alt');
    await exec('review.accessibilitySelect', {address: alt.address});
    await settle(700);
    await app.capture('11-accessibility-errors', {doc});
    await exec('review.setAltText', {id: /media:(.+)$/.exec(alt.address)[1], alt: 'A picture of printed words'});
    assert.ok(!(await exec('review.checkAccessibility', {})).issues.some(i => i.rule === 'missing-alt'));
    await exec('surface.title', {page: 'pext', title: 'Extra'});

    // ---- Linked Notes: the Select Location dialog, a page of notes with a link to the file ---------------------------------------------------------
    await select('/pg:pnotes');
    await app.rpc('ui.activate', {doc, control: 'review.notes.linked-notes'});
    assert.equal((await dialog()).id, 'dialog.select-location');
    await assert.rejects(app.rpc('ui.dialog.submit', {doc}), /Choose the file/);
    await app.rpc('ui.dialog.set', {doc, values: {filePath: 'C:\\Users\\me\\Documents\\Lab report.docx', fileName: 'Lab report.docx', location: 'section:sr1'}});
    await settle(600);
    await app.capture('12-linked-notes-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    await settle(600);
    const sel = (await app.rpc('selection.get', {doc})).selection.ranges[0].anchor;
    const made = await read(sel);
    assert.match(JSON.stringify(made), /Notes: Lab report\.docx/);
    assert.match(JSON.stringify(await read(`${sel}`)), /file:\/\/\/C:\/Users\/me\/Documents\/Lab%20report\.docx/);
    await app.capture('13-linked-notes-page', {doc});

    // ---- Help, Show Training, What's New ---------------------------------------------------------------------------------------------------------------
    await app.rpc('ui.tab', {doc, id: 'help'});
    await settle(600);
    await app.rpc('ui.activate', {doc, control: 'help.help.help'});
    await settle(600);
    await exec('help.show', {topic: 'tables'});
    await settle(500);
    await app.capture('14-help-topic', {doc});
    await app.rpc('ui.activate', {doc, control: 'help.help.show-training'});
    await settle(500);
    await app.capture('15-training', {doc});
    await app.rpc('ui.activate', {doc, control: 'help.help.whats-new'});
    await settle(500);
    await app.capture('16-whats-new', {doc});
    await app.rpc('ui.dialog.cancel', {doc}).catch(() => {});
    await exec('history.closePane', {});

    // ---- Audio & Video Settings ---------------------------------------------------------------------------------------------------------------------------------
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.audio-video-settings'});
    assert.equal((await dialog()).values.audioQuality, 'medium');
    await app.rpc('ui.dialog.set', {doc, values: {audioQuality: 'high', videoSize: 'large'}});
    await settle(500);
    await app.capture('17-audio-video-settings', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.audio-video-settings'});
    assert.deepEqual([(await dialog()).values.audioQuality, (await dialog()).values.videoSize], ['high', 'large']);
    await app.rpc('ui.dialog.cancel', {doc});

    // ---- Convert to Spreadsheet: a table on the page becomes a worksheet --------------------------------------------------------------------------------------------
    await select('/pg:pext/b:extra/t:3');
    await exec('insert.table', {rows: 2, columns: 3});
    const table = (await objects('table', 'pext'))[0];
    const cells = [['Mass', 'Speed', 'Energy'], ['2', '3', '=A2*B2']];
    for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
      const id = table.content[r].content[c].content[0].attrs.id;
      await select(`/pg:pext/b:${id}/t:0`);
      await exec('insert.symbol', {char: cells[r][c]});
    }
    await settle(500);
    await app.rpc('ui.tab', {doc, id: (await app.rpc('ui.inspect', {doc})).tabs.find(t => /^table/.test(t))});
    await settle(600);
    await app.capture('18-table-layout-convert', {doc});
    await app.rpc('ui.activate', {doc, control: 'table.convert.convert-to-spreadsheet'});
    await settle(600);
    assert.equal((await objects('table', 'pext')).length, 0);
    const converted = (await objects('spreadsheet', 'pext'))[0];
    assert.deepEqual([converted.attrs.rows, converted.attrs.cols, converted.attrs.shown.C2], [2, 3, '6']);
    await settle(500);
    await app.capture('19-converted-spreadsheet', {doc});

    // ---- Touch mode: the QAT dropdown, larger page controls ----------------------------------------------------------------------------------------------------------
    await select('/pg:pnotes');
    await app.rpc('ui.menu', {doc, control: 'qat.touch-mouse-mode'});
    await settle(500);
    await app.capture('20-touch-mouse-menu', {doc});
    await app.rpc('ui.menu', {doc, control: 'qat.touch-mouse-mode', open: false});
    await app.rpc('ui.activate', {doc, control: 'qat.touch-mouse-mode.touch'});
    await settle(900);
    await app.capture('21-touch-mode', {doc});
    assert.equal((await exec('view.touchMode', {mode: 'touch'})).mode, 'touch');
    await app.rpc('ui.activate', {doc, control: 'qat.touch-mouse-mode.mouse'});
    await settle(600);
    await app.capture('22-mouse-mode', {doc});
  } finally {
    await app.close();
  }
});
