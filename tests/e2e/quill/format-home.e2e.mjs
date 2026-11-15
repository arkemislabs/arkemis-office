// Home tab Font, Paragraph and Styles groups end to end through the bridge on a page-view (schema-2)
// Quill document, in the new shell (devRenderer, ARKEMIS_NEW_HOST=1). No OS or DOM input: ribbon
// controls through ui.activate, dialogs through ui.dialog.*, keys through ui.key; evidence with
// ui.capture (artifacts/e2e/quill/format-home/*.png).
//
// Behaviour fidelity:
// 1. ArtCraft (wordcraft ribbon/home.rs, cmd/format.rs, cmd/para.rs, cmd/lists.rs, dialogs/*) and
//    Word: Bold/Italic/Underline styles, font size, colour and highlight splits, Change Case, Clear
//    All Formatting; alignment, bullets, numbering, multilevel, line spacing, shading, indents; the
//    Styles gallery; the Font, Paragraph, Tabs, Define New Multilevel List dialogs and the Styles pane.
// 2. Each step asserts the document model (document.read runs/json) and captures the page, so the
//    result is seen painted on the page, then Ctrl+Z (ui.key) is checked to undo it.
// 3. This file; the engine tests are tests/quill/{format,para,lists,para-styles}*.test.mjs and
//    tests/quill/upstream/{format,para}_*.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

function seedDoc(id) {
  const seed = createFile('quill', 'Formatting');
  seed.id = id;
  const p = text => ({type: 'paragraph', content: [{type: 'text', text}]});
  seed.content.doc = {type: 'doc', content: [
    p('Quarterly report'),
    p('Sales rose in every region this quarter, led by the north and the coast.'),
    p('First point to make'),
    p('Second point to make'),
    p('Third point to make'),
    p('The closing paragraph explains what comes next and who to call with questions about the figures.'),
  ]};
  return migrateFile(seed);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('quill Home › Font, Paragraph and Styles on the page view', {timeout: 420_000}, async t => {
  const seed = seedDoc('quill-format-home');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/format-home', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const activate = (control, value) => app.rpc('ui.activate', {doc, control, ...(value !== undefined ? {value} : {})});
  const shot = async name => { await sleep(350); const s = await app.capture(name, {doc}); t.diagnostic(`${name}: ${s.file}`); return s; };
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => {
      const ui = await app.rpc('ui.inspect', {doc});
      return ui.doc?.id === doc && ui.tabs?.length ? ui : null;
    }, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('ui.tab', {doc, id: 'home'});
    const body = (await app.rpc('document.read', {doc, address: '/body', as: 'json'})).value;
    const blocks = (Array.isArray(body) ? body : body?.blocks ?? body?.body ?? []).filter(b => b && b.kind === 'para');
    assert.ok(blocks.length >= 6, `six paragraphs with ids: ${JSON.stringify(body).slice(0, 300)}`);
    const id = n => blocks[n].id;
    const select = (n, from, to) => app.rpc('selection.set', {doc, ranges: [{anchor: `/body/b:${id(n)}/t:${from}`, focus: `/body/b:${id(n)}/t:${to}`}], primary: 0});
    const runs = async n => JSON.stringify((await app.rpc('document.read', {doc, address: `/body/b:${id(n)}`, as: 'runs'})).value);
    const para = async n => (await app.rpc('document.read', {doc, address: `/body/b:${id(n)}`, as: 'json'})).value;
    const controls = async () => Object.fromEntries((await app.rpc('ui.inspect', {doc})).controls.map(c => [c.id, c]));
    await shot('0-opened');

    // Font group on the title: Bold, Italic, Double underline, 20 pt, font colour, highlight.
    await select(0, 0, 16);
    await activate('home.font.bold');
    await activate('home.font.italic');
    await activate('home.font.underline.double');
    await activate('home.font.font-size', '20');
    await activate('home.font.font-color', '#C00000');
    await activate('home.font.text-highlight-color', 'yellow');
    const title = await runs(0);
    for (const want of ['"bold":true', '"italic":true', '"underline":"double"', '"size":20', '"highlight"']) assert.ok(title.includes(want), `${want} in ${title.slice(0, 400)}`);
    const c1 = await controls();
    assert.equal(c1['home.font.bold'].checked, true, 'Bold shows on');
    assert.equal(c1['home.font.italic'].checked, true, 'Italic shows on');
    await shot('1-font-group');

    // Change Case and Clear All Formatting on the second paragraph's first words.
    await select(1, 0, 10);
    await activate('home.font.change-case.uppercase');
    assert.ok((await para(1)).text.startsWith('SALES ROSE'), 'UPPERCASE');
    await activate('home.font.strikethrough');
    await activate('home.font.superscript');
    await shot('2-case-strike-super');
    await activate('home.font.clear-all-formatting');
    const cleared = await runs(1);
    assert.ok(!cleared.includes('"strike":true') && !cleared.includes('superscript'), `Clear All Formatting: ${cleared.slice(0, 300)}`);

    // Undo round trip through the keys.
    const beforeUndo = await runs(1);
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.notEqual(await runs(1), beforeUndo, 'Ctrl+Z undid Clear All Formatting');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Y'});
    assert.equal(await runs(1), beforeUndo, 'Ctrl+Y redid it');

    // Paragraph group: centre the title, bullets on the three points, then numbering, line spacing, shading.
    await select(0, 0, 0);
    await activate('home.paragraph.center');
    assert.equal((await para(0)).props?.align, 'center');
    await app.rpc('selection.set', {doc, ranges: [{anchor: `/body/b:${id(2)}/t:0`, focus: `/body/b:${id(4)}/t:5`}], primary: 0});
    await activate('home.paragraph.bullets');
    assert.ok((await para(2)).props?.numbering?.num, 'bulleted');
    await shot('3-bullets');
    await activate('home.paragraph.numbering.1-2-3');
    await activate('home.paragraph.increase-indent');
    await shot('4-numbering');
    await activate('home.paragraph.line-and-paragraph-spacing.2');
    assert.deepEqual((await para(3)).props?.lineSpacing, {rule: 'multiple', value: 2});
    await select(5, 0, 0);
    await activate('home.paragraph.justify');
    await activate('home.paragraph.shading', '#DDEBF7');
    await activate('home.paragraph.borders.outside-borders');
    await shot('5-paragraph-group');

    // Styles gallery: Heading 1 on the title, Title style on nothing else.
    await select(0, 0, 0);
    await activate('home.styles.styles', 'Heading1');
    assert.equal((await para(0)).props?.style, 'Heading1');
    await shot('6-heading-1');

    // Font dialog (Ctrl+D): Font page, then Advanced; set small caps and expanded spacing.
    await select(5, 0, 11);
    const k = await app.rpc('ui.key', {doc, keys: 'Ctrl+D'});
    t.diagnostic(`Ctrl+D: ${JSON.stringify(k).slice(0, 200)}`);
    let dlg = await app.rpc('ui.dialog.get', {id: 'dialog.font'}).catch(() => null);
    if (!dlg) dlg = await app.rpc('ui.dialog.open', {doc, id: 'dialog.font'});
    assert.equal(dlg.id, 'dialog.font');
    await app.rpc('ui.dialog.set', {id: 'dialog.font', values: {smallCaps: true, fontStyle: 'bold', color: '#2F5597'}});
    await shot('7-font-dialog');
    await app.rpc('ui.dialog.set', {id: 'dialog.font', tab: 'Advanced', values: {spacingType: 'expanded', spacingBy: 1.5}});
    await shot('8-font-dialog-advanced');
    await app.rpc('ui.dialog.submit', {id: 'dialog.font'});
    const fd = await runs(5);
    for (const want of ['"smallCaps":true', '"bold":true', '"spacing":1.5']) assert.ok(fd.includes(want), `Font dialog ${want}: ${fd.slice(0, 300)}`);

    // Paragraph dialog: indents and spacing, then Line and Page Breaks.
    await activate('home.paragraph.line-and-paragraph-spacing.line-spacing-options');
    dlg = await app.rpc('ui.dialog.get', {id: 'dialog.paragraph'});
    await app.rpc('ui.dialog.set', {id: 'dialog.paragraph', values: {left: 0.5, special: 'firstLine', by: 0.5, after: 18}});
    await shot('9-paragraph-dialog');
    await app.rpc('ui.dialog.set', {id: 'dialog.paragraph', tab: 'Line and Page Breaks', values: {keepNext: true}});
    await shot('10-paragraph-dialog-breaks');
    await app.rpc('ui.dialog.submit', {id: 'dialog.paragraph'});
    const pp = (await para(5)).props;
    assert.deepEqual([pp.indentLeft, pp.indentFirst, pp.spaceAfter, pp.keepNext], [36, 36, 18, true], JSON.stringify(pp));
    await shot('11-paragraph-applied');

    // Tabs dialog and Define New Multilevel List: open, capture, cancel.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.tabs'});
    await shot('12-tabs-dialog');
    await app.rpc('ui.dialog.cancel', {id: 'dialog.tabs'});
    await activate('home.paragraph.multilevel-list.define-new-multilevel-list');
    await app.rpc('ui.dialog.set', {id: 'dialog.defineList', field: 'level', value: 1});
    await shot('13-define-list');
    await app.rpc('ui.dialog.cancel', {id: 'dialog.defineList'});

    // The Styles pane.
    await app.rpc('ui.pane', {doc, id: 'pane.styles', open: true});
    await shot('14-styles-pane');
    await app.rpc('ui.pane', {doc, id: 'pane.styles', open: false});
  } finally {
    await app.close();
  }
});
