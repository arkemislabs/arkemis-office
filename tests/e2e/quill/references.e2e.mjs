// Quill's References tab (U:quill/references) end to end through the bridge, in the new shell. No OS
// input: ribbon controls through ui.activate / ui.menu, typing through ui.type, keys through ui.key,
// dialogs through ui.dialog.*, right-click menus through ui.contextMenu, and the document read back
// over the bridge.
//
// Behaviour fidelity:
// 1. ArtCraft crates/engine/src/cmd/references.rs, references/*.rs, citations.rs, citations/*.rs,
//    index.rs, fields.rs; the ribbon in crates/ui-egui/src/ribbon/references.rs and the dialogs in
//    dialogs_refs/*.rs and dialogs_notes.rs. Word: the Table of Contents gallery inserts a table
//    built from the headings with dot leaders and page numbers; Update Table asks what to update; a
//    footnote's text sits at the page bottom under a separator; Insert Citation › Add New Source…
//    cites the source and Bibliography lists it; Insert Caption numbers a figure and Cross-reference
//    points at it; Mark Entry and Insert Index build an index; right-clicking a field offers Update
//    Field, Edit Field and Toggle Field Codes.
// 2. The same commands run from the window (the person's path), each one undo step, and the page
//    view draws them (captures below).
// 3. This file; the engine side is tests/quill/references.test.mjs and tests/quill/upstream/references_tests.test.mjs.
//
// Evidence: artifacts/e2e/quill/references/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

function seedDoc(id) {
  const seed = createFile('quill', 'Report');
  seed.id = id;
  const p = text => ({type: 'paragraph', content: [{type: 'text', text}]});
  const h = (level, text) => ({type: 'heading', attrs: {level}, content: [{type: 'text', text}]});
  seed.content.doc = {type: 'doc', content: [
    p('Annual report'),
    h(1, 'Introduction'),
    p('Kilns are the heart of the studio. This year the team fired more pieces than ever before.'),
    h(2, 'Studio space'),
    p('The new presses arrived in spring and changed how the studio works.'),
    h(1, 'Results'),
    p('Sales chart'),
    p('See the chart for the figures.'),
  ]};
  return migrateFile(seed);
}

test('quill References tab: table of contents, footnotes, citations, captions, cross-reference, index, their dialogs', {timeout: 300_000}, async () => {
  const seed = seedDoc('quill-references');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/references', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async () => JSON.stringify(await app.rpc('document.read', {doc, address: '/body', as: 'json'}));
  const settle = () => new Promise(r => setTimeout(r, 450));
  const blocks = async () => (await app.rpc('document.read', {doc, address: '/body', as: 'json'}));
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });

    // The References tab: Word's groups and controls; Researcher and Search stay hidden.
    await app.rpc('ui.tab', {doc, id: 'references'});
    await settle();
    const ui = await app.rpc('ui.inspect', {doc});
    const ids = new Set((ui.controls ?? []).map(c => c.id));
    for (const id of ['references.table-of-contents.table-of-contents', 'references.table-of-contents.add-text', 'references.table-of-contents.update-table',
      'references.footnotes.insert-footnote', 'references.footnotes.insert-endnote', 'references.footnotes.next-footnote', 'references.footnotes.show-notes',
      'references.citations-bibliography.insert-citation', 'references.citations-bibliography.manage-sources', 'references.citations-bibliography.style',
      'references.citations-bibliography.bibliography', 'references.captions.insert-caption', 'references.captions.insert-table-of-figures',
      'references.captions.update-table', 'references.captions.cross-reference', 'references.index.mark-entry', 'references.index.insert-index',
      'references.index.update-index', 'references.table-of-authorities.mark-citation', 'references.table-of-authorities.insert-table-of-authorities',
      'references.table-of-authorities.update-table']) {
      assert.ok(ids.has(id), `${id} is on the References tab`);
    }
    assert.ok(!ids.has('references.research.researcher') && !ids.has('references.research.search'), 'Research needs an online service: hidden');
    await app.capture('1-references-tab', {doc});

    // Table of Contents gallery, drawn as pictures; Automatic Table 1 above the title.
    await app.rpc('ui.menu', {doc, control: 'references.table-of-contents.table-of-contents'});
    await settle();
    await app.capture('2-toc-gallery', {doc});
    await app.rpc('ui.menu', {doc, control: 'references.table-of-contents.table-of-contents', open: false});
    await run('caret.set', {pos: {block: 0, off: 0}});
    await app.rpc('ui.activate', {doc, control: 'references.table-of-contents.table-of-contents.automatic-1'});
    let body = await read();
    assert.ok(body.includes('Introduction\\t1') && body.includes('Studio space\\t1') && body.includes('Results\\t1'), body.slice(0, 2000));
    await run('caret.set', {pos: {block: 0, off: 0}});
    await settle();
    await app.capture('3-toc-inserted', {doc});

    // A new heading on page 2, then Update Table › Update entire table.
    await run('caret.docEnd');
    await run('text.newParagraph');
    await run('insert.pageBreak');
    await app.rpc('ui.type', {doc, text: 'Outlook'});
    await run('para.style', {style: 'Heading1'});
    await app.rpc('ui.activate', {doc, control: 'references.table-of-contents.update-table'});
    let dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.updateToc');
    await settle();
    await app.capture('4-update-table-dialog', {doc});
    await app.rpc('ui.dialog.set', {doc, values: {mode: 'entire'}});
    await app.rpc('ui.dialog.submit', {doc});
    body = await read();
    assert.ok(body.includes('Outlook\\t2'), 'the new heading is listed with its page');
    await run('caret.set', {pos: {block: 0, off: 0}});
    await settle();
    await app.capture('5-toc-updated', {doc});

    // Right-click in the table: Update Field for the whole table; on a field: Update / Edit / Toggle Field Codes.
    let menu = await app.rpc('ui.contextMenu', {doc, target: 'tableOfContents'});
    assert.ok(menu.items.some(i => i.label === 'Update Field' && i.command === 'references.updateToc'), JSON.stringify(menu.items));
    await app.rpc('ui.contextMenu', {doc, open: false});
    menu = await app.rpc('ui.contextMenu', {doc, target: 'field'});
    assert.deepEqual(menu.items.filter(i => /Field/.test(i.label)).map(i => i.command), ['references.updateFields', 'fields.setCode', 'fields.toggleCode']);
    await app.rpc('ui.contextMenu', {doc, open: false});

    // Insert Footnote (Ctrl+Alt+F): the caret moves into the note at the page bottom.
    const at = async text => {
      const b = await blocks();
      const list = Array.isArray(b) ? b : b?.chunks?.flat?.() ?? b?.body?.chunks?.flat?.() ?? b?.blocks ?? b?.value ?? b?.node?.chunks?.flat?.() ?? [];
      const i = list.findIndex(x => typeof x?.text === 'string' && x.text.includes(text));
      if (i < 0) throw new Error(`no block with ${text}: ${JSON.stringify(b).slice(0, 300)}`);
      return i;
    };
    const iKilns = await at('Kilns are the heart');
    await run('caret.set', {pos: {block: iKilns, off: 34}});
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Alt+F'});
    await app.rpc('ui.type', {doc, text: 'Two gas kilns and one electric kiln.'});
    const notes = await run('references.notes');
    assert.equal(notes.length, 1);
    assert.ok(notes[0].text.includes('Two gas kilns'), JSON.stringify(notes));
    await run('view.zoom', {value: 'onePage'});
    await run('caret.set', {pos: {block: iKilns, off: 0}});
    await settle();
    await app.capture('6-footnote-page-bottom', {doc});
    await run('view.zoom', {value: 100});

    // Footnote and Endnote dialog from the group launcher.
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.noteOptions'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.values.footnotePos, 'pageBottom');
    await settle();
    await app.capture('7-footnote-endnote-dialog', {doc});
    await app.rpc('ui.dialog.cancel', {doc});

    // Insert Citation › Add New Source…: the source is cited; Bibliography lists it.
    const iStudio = await at('changed how the studio works');
    await run('caret.set', {pos: {block: iStudio, off: 'The new presses arrived in spring and changed how the studio works'.length}});
    await app.rpc('ui.menu', {doc, control: 'references.citations-bibliography.insert-citation'});
    await app.rpc('ui.activate', {doc, control: 'references.citations-bibliography.insert-citation.add-source'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.source');
    await app.rpc('ui.dialog.set', {doc, values: {kind: 'book', author: 'Rivera, Alex', title: 'Shared Spaces', year: '2021', city: 'Portland', publisher: 'Harbor Books'}});
    await settle();
    await app.capture('8-create-source-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    body = await read();
    assert.ok(body.includes('(Rivera, 2021)'), 'the citation shows in APA');
    await run('caret.docEnd');
    await run('text.newParagraph');
    await app.rpc('ui.menu', {doc, control: 'references.citations-bibliography.bibliography'});
    await settle();
    await app.capture('9-bibliography-gallery', {doc});
    await app.rpc('ui.activate', {doc, control: 'references.citations-bibliography.bibliography.works-cited'});
    body = await read();
    assert.ok(body.includes('Works Cited') && body.includes('Rivera, A. (2021). Shared Spaces. Harbor Books.'), 'the bibliography lists the source');
    await app.rpc('ui.activate', {doc, control: 'references.citations-bibliography.manage-sources'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.sourceManager');
    await app.rpc('ui.dialog.set', {doc, values: {list: 'Riv21'}});
    await settle();
    await app.capture('10-source-manager', {doc});
    await app.rpc('ui.dialog.cancel', {doc});

    // Insert Caption on the chart paragraph, then a cross-reference to it.
    const iChart = await at('Sales chart');
    await run('caret.set', {pos: {block: iChart, off: 0}});
    await app.rpc('ui.activate', {doc, control: 'references.captions.insert-caption'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.caption');
    await app.rpc('ui.dialog.set', {doc, values: {text: 'Sales by quarter'}});
    await settle();
    await app.capture('11-caption-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    body = await read();
    assert.ok(body.includes('Figure ') && body.includes(': Sales by quarter'));
    const iSee = await at('See the chart');
    await run('caret.set', {pos: {block: iSee, off: 8}});
    await app.rpc('ui.activate', {doc, control: 'references.captions.cross-reference'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.crossReference');
    await app.rpc('ui.dialog.set', {doc, values: {to: 'figure'}});
    await app.rpc('ui.dialog.set', {doc, values: {show: 'number'}});
    await settle();
    await app.capture('12-cross-reference-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    body = await read();
    assert.ok(/REF _Ref\d+ \\\\h/.test(body), 'a REF field to the caption\'s bookmark');
    await app.rpc('ui.type', {doc, text: ' '});
    await run('caret.set', {pos: {block: iChart, off: 0}});
    await settle();
    await app.capture('13-caption-and-cross-reference', {doc});

    // Mark Entry (Alt+Shift+X) on "Kilns", then Insert Index at the end.
    await run('select.range', {anchor: {block: iKilns, off: 0}, focus: {block: iKilns, off: 5}});
    await app.rpc('ui.key', {doc, keys: 'Alt+Shift+X'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.markEntry');
    assert.equal(dlg.values.entry, 'Kilns');
    await settle();
    await app.capture('14-mark-entry-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    await run('caret.docEnd');
    await run('text.newParagraph');
    await app.rpc('ui.activate', {doc, control: 'references.index.insert-index'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.index');
    await settle();
    await app.capture('15-index-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    body = await read();
    assert.ok(body.includes('Kilns, 1'), 'the index lists the entry');
    await run('caret.docEnd');
    await settle();
    await app.capture('16-index', {doc});

    // Custom Table of Contents and Table of Figures dialogs.
    await app.rpc('ui.menu', {doc, control: 'references.table-of-contents.table-of-contents'});
    await app.rpc('ui.activate', {doc, control: 'references.table-of-contents.table-of-contents.custom'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.toc');
    assert.equal(dlg.values.levels, 3);
    await settle();
    await app.capture('17-custom-toc-dialog', {doc});
    await app.rpc('ui.dialog.cancel', {doc});
    await app.rpc('ui.activate', {doc, control: 'references.captions.insert-table-of-figures'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.tableOfFigures');
    await settle();
    await app.capture('18-table-of-figures-dialog', {doc});
    await app.rpc('ui.dialog.cancel', {doc});

    // Every one of these was one undo step: Ctrl+Z takes the index back.
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.ok(!(await read()).includes('Kilns, 1'), 'undo removes the index');
  } catch (e) {
    throw new Error(`${e.stack ?? e.message}${log()}`);
  } finally {
    await app.close();
  }
});
