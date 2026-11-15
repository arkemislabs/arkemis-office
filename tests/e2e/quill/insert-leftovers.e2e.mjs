// Quill's Insert tab leftovers and the Header & Footer tab (U:quill/insert, U:quill/header-footer) end to end through the bridge, in the new
// shell. No OS input: ribbon controls through ui.activate / ui.menu, dialogs through ui.dialog.*, the document read back over the bridge.
//
// Behaviour fidelity:
// 1. ArtCraft crates/engine/src/cmd/tools/specs.rs + actions.rs (Quick Parts, AutoText, Document Property, Signature Line, hf.*, Link to
//    Previous), ribbon/insert.rs (the Quick Parts menu lists the building blocks); Word: the Header, Footer, Page Number, Cover Page and Text
//    Box galleries show what they insert as a picture of the page; Quick Parts saves the selection and brings it back; the Header & Footer
//    tab moves between headers and footers and sets their distance from the page edge.
// 2. The same commands run from the window (the person's path), each one undo step (captures below).
// 3. This file; the engine side is tests/quill/blocks.test.mjs.
//
// Evidence: artifacts/e2e/quill/insert-leftovers/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

const para = text => ({type: 'paragraph', content: [{type: 'text', text}]});
function seedDoc(id) {
  const seed = createFile('quill', 'Report');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Annual report'}]},
    para('The report covers the year and what the team learned from it.'),
    para('Signed off by the board in March.'),
  ]};
  return migrateFile(seed);
}

test('quill Insert leftovers and Header & Footer: galleries drawn as pages, Quick Parts, Signature Line, header and footer navigation', {timeout: 600_000}, async () => {
  const seed = seedDoc('quill-insert-leftovers');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/insert-leftovers', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async () => JSON.stringify((await app.rpc('document.read', {doc, address: '/body', as: 'json'})).value);
  const settle = (ms = 450) => new Promise(r => setTimeout(r, ms));
  const inspect = () => app.rpc('ui.inspect', {doc});
  const control = async id => (await inspect()).controls?.find(c => c.id === id) ?? null;
  const activate = (id, value) => app.rpc('ui.activate', {doc, control: id, ...(value === undefined ? {} : {value})});
  const menu = async (id, open = true) => app.rpc('ui.menu', {doc, control: id, ...(open ? {} : {open: false})});
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await inspect(); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });

    // The Insert tab: what is translated shows, what upstream has no engine for (or does not draw yet) stays hidden.
    await app.rpc('ui.tab', {doc, id: 'insert'});
    await settle();
    const ids = new Set(((await inspect()).controls ?? []).map(c => c.id));
    for (const id of ['insert.pages.cover-page', 'insert.tables.table', 'insert.illustrations.pictures', 'insert.illustrations.shapes', 'insert.links.link', 'insert.links.bookmark',
      'insert.links.cross-reference', 'insert.comments.comment', 'insert.header-footer.header', 'insert.header-footer.footer', 'insert.header-footer.page-number', 'insert.text.text-box',
      'insert.text.quick-parts', 'insert.text.drop-cap', 'insert.text.signature-line', 'insert.text.date-time', 'insert.text.object', 'insert.symbols.symbol', 'insert.illustrations.icons', 'insert.illustrations.chart', 'insert.symbols.equation']) assert.ok(ids.has(id), `${id} is on the Insert tab`);
    for (const id of ['insert.illustrations.3d-models', 'insert.illustrations.screenshot', 'insert.add-ins.get-add-ins', 'insert.media.online-video',
      'insert.illustrations.smartart', 'insert.text.wordart']) assert.ok(!ids.has(id), `${id} stays hidden`);
    await app.capture('1-insert-tab', {doc});

    // The galleries are drawn as pages.
    for (const [id, name] of [['insert.header-footer.header', '2-header-gallery'], ['insert.header-footer.footer', '3-footer-gallery'], ['insert.header-footer.page-number', '4-page-number-gallery'],
      ['insert.pages.cover-page', '5-cover-page-gallery'], ['insert.text.text-box', '6-text-box-gallery']]) {
      await menu(id);
      await settle();
      await app.capture(name, {doc});
      await menu(id, false);
    }

    // Quick Parts: save the selection through Word's Create New Building Block, then insert it from the menu's gallery.
    await run('select.range', {anchor: {block: 1, off: 4}, focus: {block: 1, off: 10}});
    await menu('insert.text.quick-parts');
    await settle();
    await app.capture('7-quick-parts-menu', {doc});
    await menu('insert.text.quick-parts', false);
    await activate('insert.text.quick-parts.save-selection');
    let dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.newBuildingBlock');
    await app.rpc('ui.dialog.set', {doc, values: {name: 'Report word', gallery: 'Quick Parts', category: 'Reports', description: 'The word report from the opening paragraph'}});
    await settle();
    await app.capture('8-new-building-block', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    assert.deepEqual((await run('insert.quickParts', {})).parts, ['Report word']);
    await run('caret.set', {pos: {block: 2, off: 0}});
    await menu('insert.text.quick-parts');
    await settle();
    await app.capture('9-quick-parts-with-block', {doc});
    await menu('insert.text.quick-parts', false);
    await activate('insert.text.quick-parts.gallery', 'Report word');
    assert.ok((await read()).includes('Report word') === false && (await read()).includes('Signed off'), 'the building block went in: its text (not its name) is in the paragraph');
    // The Building Blocks Organizer.
    await activate('insert.text.quick-parts.building-blocks-organizer');
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.buildingBlocks');
    assert.deepEqual(dlg.values.blocks.map(r => [r.name, r.gallery, r.category, r.description, r.template, r.text]),
      [['Report word', 'Quick Parts', 'Reports', 'The word report from the opening paragraph', 'Normal.dotm', 'report']]);
    await settle();
    await app.capture('10-building-blocks-organizer', {doc});
    // Sorted by a column heading (the arrow shows), then Edit Properties: Modify Building Block with the block's own fields.
    await app.rpc('ui.dialog.set', {doc, values: {sort: 'category', desc: true}});
    await settle();
    await app.capture('10b-organizer-sorted', {doc});
    await app.rpc('ui.dialog.cancel', {doc});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.modifyBuildingBlock'});
    await app.rpc('ui.dialog.set', {doc, values: {_name: 'Report word', _from: 'settings', _gallery: 'Quick Parts', name: 'Report word', gallery: 'Quick Parts', category: 'Reports', description: 'The word report from the opening paragraph', location: 'Settings (all documents)'}});
    await settle();
    await app.capture('10c-modify-building-block', {doc});
    await app.rpc('ui.dialog.set', {doc, values: {name: 'Sign-off', gallery: 'AutoText', category: 'Closing'}});
    await app.rpc('ui.dialog.submit', {doc});
    assert.deepEqual((await run('insert.quickParts', {})).parts, [], 'moved to the AutoText gallery');
    assert.deepEqual((await run('insert.autoText', {})).parts, ['Sign-off']);
    await activate('insert.text.quick-parts.building-blocks-organizer');
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.deepEqual(dlg.values.blocks.map(r => [r.name, r.gallery, r.category]), [['Sign-off', 'AutoText', 'Closing']]);
    await app.rpc('ui.dialog.cancel', {doc});

    // Document Property (a field), Signature Line.
    await run('caret.set', {pos: {block: 2, off: 0}});
    await activate('insert.text.quick-parts.document-property.title');
    assert.ok((await read()).includes('TITLE'), 'a TITLE field is in the document');
    await run('caret.set', {pos: {block: 2, off: 0}});
    await activate('insert.text.signature-line');
    assert.ok((await read()).includes('X ______________________________'));
    await settle();
    await app.capture('11-signature-line', {doc});

    // Icons: the picker (search, categories, the grid drawn from the library), then a picture of the chosen icon in the document.
    await run('caret.set', {pos: {block: 0, off: 0}});
    await activate('insert.illustrations.icons');
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.icons');
    await settle();
    await app.capture('11b-icons-picker', {doc});
    await app.rpc('ui.dialog.set', {doc, values: {category: 'Weather', selected: 'sun'}});
    await settle();
    await app.capture('11c-icons-weather', {doc});
    await app.rpc('ui.dialog.set', {doc, values: {category: '', query: 'envelope', selected: 'mail'}});
    await app.rpc('ui.dialog.submit', {doc});
    assert.ok((await read()).includes('"type":"image"'), 'a picture of the icon is in the heading');
    await settle();
    await app.capture('11d-icon-inserted', {doc});

    // The Header & Footer tab: in a header, Previous / Next, Link to Previous and the distances from the page edge.
    await run('caret.set', {pos: {block: 1, off: 0}});
    await activate('insert.header-footer.header.blank');
    await run('insert.footer', {text: 'Page footer'});
    await run('insert.editHeader', {});
    await app.rpc('ui.tab', {doc, id: 'header-and-footer'});
    await settle();
    const hf = new Set(((await inspect()).controls ?? []).map(c => c.id));
    for (const id of ['header-footer.header-footer.header', 'header-footer.header-footer.footer', 'header-footer.header-footer.page-number', 'header-footer.insert.date-time', 'header-footer.insert.document-info',
      'header-footer.insert.quick-parts', 'header-footer.insert.pictures', 'header-footer.navigation.go-to-header', 'header-footer.navigation.go-to-footer', 'header-footer.navigation.previous',
      'header-footer.navigation.next', 'header-footer.navigation.link-to-previous', 'header-footer.options.different-first-page', 'header-footer.options.different-odd-even-pages',
      'header-footer.position.header-from-top', 'header-footer.position.footer-from-bottom', 'header-footer.close.close-header-and-footer']) assert.ok(hf.has(id), `${id} is on the Header & Footer tab`);
    for (const id of ['header-footer.options.show-document-text', 'header-footer.position.insert-alignment-tab', 'header-footer.insert.online-pictures']) assert.ok(!hf.has(id), `${id} stays hidden`);
    assert.equal((await control('header-footer.position.header-from-top'))?.value, 36);
    await app.capture('12-header-footer-tab', {doc});
    await activate('header-footer.navigation.next');
    const where = async () => JSON.stringify(await app.rpc('selection.get', {doc}));
    assert.ok((await where()).includes('/ftr:'), `Next goes to the footer: ${await where()}`);
    await activate('header-footer.navigation.previous');
    assert.ok((await where()).includes('/hdr:'));
    await activate('header-footer.position.header-from-top', '18');
    assert.equal((await control('header-footer.position.header-from-top'))?.value, 18);
    await menu('header-footer.insert.document-info');
    await settle();
    await app.capture('13-document-info', {doc});
    await menu('header-footer.insert.document-info', false);
    await activate('header-footer.close.close-header-and-footer');
  } finally {
    await app.close();
  }
});
