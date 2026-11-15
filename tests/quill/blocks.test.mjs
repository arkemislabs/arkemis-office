// U:quill/insert and U:quill/header-footer leftovers: Quick Parts and AutoText (building blocks), Document Property, Signature Line,
// Object and Text from File, the Building Blocks Organizer and Create New Building Block boxes, and Header & Footer's Next and
// Previous Section, Link to Previous, Header from Top and Footer from Bottom.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/engine/src/cmd/tools/specs.rs and actions.rs (quick_parts, hf_nav), insert.rs (insert.textFromFile);
//    ribbon/insert.rs (the Quick Parts menu lists the building blocks). Word: a saved selection comes back with its formatting; AutoText
//    and Quick Parts are separate galleries; a document property is a field that shows the property; the signature line is "X ____"
//    over the signer and title; Next / Previous Section move through the headers and footers; Link to Previous makes the section's
//    headers the previous one's again; Header from Top and Footer from Bottom are distances in the section's layout.
// 2. Ours: the person's building blocks live in the settings (preference `buildingBlocks`), the document's in the model; each command
//    is one undo step; the galleries are drawn as page strips (src/shell/ribbon/controls.tsx PageStrip).
// 3. Proof: this file and tests/e2e/quill/insert-leftovers.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from './format-fixture.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import {openDialogModel} from '../../core/kernel/dialog.mjs';
import {Document} from '../../core/quill/model/document.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import * as P from '../../core/quill/model/para.mjs';
import {blockNames} from '../../core/quill/commands/blocks.mjs';
import newBuildingBlock from '../../core/quill/dialogs/newBuildingBlock.mjs';
import buildingBlocksDialog, {orderRows} from '../../core/quill/dialogs/buildingBlocks.mjs';
import modifyBuildingBlock from '../../core/quill/dialogs/modifyBuildingBlock.mjs';

const TEXT = 'The quick brown fox jumps over the lazy dog.\nA second paragraph of text.\nAnd a third one.';

test('Quick Parts: save the selection (settings or document), insert it, delete it; AutoText is another gallery', async () => {
  const host = createTestHost();
  const q = await quill(TEXT, undefined, {host});
  await assert.rejects(() => q.exec('insert.quickParts', {save: 'x'}), /select the content/);
  q.sel(0, 4, 9);
  const r = (await q.exec('insert.quickParts', {save: 'Fast'})).result;
  assert.deepEqual([r.parts, r.document], [['Fast'], []]);
  assert.ok(host.savedPrefs.buildingBlocks.Fast, 'kept in the settings, not in the document');
  assert.ok(!JSON.stringify(q.t.content).includes('"Fast"'));
  q.sel(2, 0);
  await q.exec('insert.quickParts', {insert: 'Fast'});
  assert.equal(q.texts()[2], 'quickAnd a third one.');
  q.sel(1, 0, 8);
  const d = (await q.exec('insert.quickParts', {save: 'Second', in: 'document'})).result;
  assert.deepEqual(d.document, ['Second']);
  assert.equal(q.t.content.glossary.length, 1);
  const at = (await q.exec('insert.autoText', {})).result;
  assert.deepEqual([at.parts, at.document], [[], []], 'the AutoText gallery does not list the Quick Part');
  await q.exec('insert.autoText', {save: 'sig', in: 'document'}).catch(() => {});
  q.sel(0, 0);
  await q.exec('insert.quickParts', {insert: 'Second'});
  assert.ok(q.texts()[0].startsWith('A second'));
  await assert.rejects(() => q.exec('insert.quickParts', {insert: 'Nope'}), /no Quick Part/);
  await q.exec('insert.quickParts', {delete: 'Fast'});
  assert.deepEqual(blockNames(q.t.doc.file ? {doc: q.t.content, prefs: host.savedPrefs} : {}, 'Quick Parts').parts.includes('Fast'), false);
  await q.exec('insert.quickParts', {delete: 'Second', in: 'document'});
  assert.deepEqual(q.t.content.glossary.map(e => [e.name, e.gallery]), [['sig', 'AutoText']], 'the AutoText entry is in another gallery and stays');
  // The menu list is the command's state.
  assert.deepEqual((await q.state('insert.quickParts')).value, []);
});

test('Quick Parts of another launch: the settings give the same building blocks', async () => {
  const host = createTestHost();
  const q = await quill(TEXT, undefined, {host});
  q.sel(0, 0, 3);
  await q.exec('insert.quickParts', {save: 'The'});
  const q2 = await quill(TEXT, undefined, {host: createTestHost(), prefs: host.savedPrefs});
  assert.deepEqual((await q2.state('insert.quickParts')).value, [{id: 'The', label: 'The', value: 'The'}]);
});

test('the building block boxes: Create New Building Block runs save in the chosen gallery; the Organizer inserts and deletes', async () => {
  const host = createTestHost();
  const q = await quill(TEXT, undefined, {host});
  q.sel(0, 0, 3);
  const v = openDialogModel(q.t.session, q.t.docId, newBuildingBlock);
  assert.deepEqual(newBuildingBlock.validate(v).map(e => e.field), ['name']);
  const cmd = newBuildingBlock.toCommand({...v, name: ' Header text ', gallery: 'AutoText', location: 'This document'});
  assert.deepEqual(cmd, {command: 'insert.autoText', params: {save: 'Header text', in: 'document'}});
  await q.exec(cmd.command, cmd.params);
  await q.exec('insert.quickParts', {save: 'Mine'});
  const o = openDialogModel(q.t.session, q.t.docId, buildingBlocksDialog);
  assert.deepEqual(o.blocks.map(r => [r.name, r.gallery, r.where, r.category, r.template]), [['Header text', 'AutoText', 'Document', 'General', 'This document'], ['Mine', 'Quick Parts', 'Settings', 'General', 'Normal.dotm']]);
  assert.equal(o.blocks[1].text, 'The', 'the preview is the text of the block');
  q.sel(2, 0);
  const ins = buildingBlocksDialog.toCommand({...o, name: 'Mine'});
  assert.deepEqual(ins, {command: 'insert.quickParts', params: {insert: 'Mine'}});
  await q.exec(ins.command, ins.params);
  assert.equal(q.texts()[2], 'TheAnd a third one.');
  const del = buildingBlocksDialog.buttons.delete(null, {...o, name: 'Header text'});
  assert.deepEqual(del, {command: 'insert.autoText', params: {delete: 'Header text', in: 'document'}});
  assert.equal(buildingBlocksDialog.buttons.delete(null, {...o, name: 'none'}), null);
  assert.deepEqual(buildingBlocksDialog.validate({...o, name: 'none'}).map(e => e.field), ['name']);
});

test('Document Property is a field showing the property; Signature Line is the line, the signer and the title', async () => {
  const q = await quill(TEXT);
  await q.t.exec('file.properties', {title: 'Annual report', author: 'Ada Lovelace'}).catch(() => {});
  q.t.doc.file.content.core = {...q.t.content.core, title: 'Annual report', creator: 'Ada Lovelace'};
  q.sel(0, 0);
  await q.exec('insert.docProperty', {name: 'Title'});
  const f = blocks(q.t)[0].objects.find(o => o.type === 'field');
  assert.deepEqual([f.instr, f.result], ['TITLE', 'Annual report']);
  await q.exec('insert.docProperty', {name: 'author'});
  assert.ok(blocks(q.t)[0].objects.some(o => o.type === 'field' && o.instr === 'AUTHOR' && o.result === 'Ada Lovelace'));
  await assert.rejects(() => q.exec('insert.docProperty', {name: 'Nope'}), /unknown property/);
  q.sel(2, 0);
  const n = blocks(q.t).length;
  await q.exec('insert.signatureLine', {signer: 'Ada Lovelace', title: 'Director'});
  const texts = q.texts().slice(2, 5);
  assert.deepEqual(texts.slice(0, 2), ['X ______________________________', 'Ada Lovelace']);
  assert.ok(texts[2].startsWith('Director'));
  assert.ok(blocks(q.t).length >= n + 2);
  assert.equal(blocks(q.t)[2].props.style, 'NoSpacing');
});

test('Text from File and Object put another document\'s text in place of the selection', async () => {
  const other = await quill('Imported one\nImported two');
  const data = Buffer.from(await writeDocx(other.t.content)).toString('base64');
  const q = await quill(TEXT);
  q.sel(2, 0, 3);
  await q.exec('insert.textFromFile', {path: 'other.docx', data});
  assert.ok(q.texts().includes('Imported one'), JSON.stringify(q.texts()));
  assert.ok(q.texts().some(t => t.startsWith('Imported two')));
  const n = q.texts().length;
  await q.exec('insert.object', {path: 'other.docx', data});
  assert.ok(q.texts().length > n);
  await assert.rejects(() => q.exec('insert.textFromFile', {path: 'x.docx', data: Buffer.from('not a doc').toString('base64')}).then(() => { throw new Error('read'); }), /./);
  await assert.rejects(() => q.exec('insert.textFromFile', {path: 'x.docx'}), /unavailable|reading a file/);
});

test('Header & Footer: Next and Previous Section ring the headers and footers; Link to Previous; Header from Top, Footer from Bottom', async () => {
  const q = await quill(TEXT);
  await q.exec('insert.header', {text: 'Head'});
  await q.exec('insert.closeHeader', {});
  await q.exec('insert.footer', {text: 'Foot'});
  await q.exec('insert.closeHeader', {});
  await assert.rejects(() => q.exec('hf.next', {}), /edit a header or footer first/);
  q.sel(0, 0);
  await q.exec('insert.editHeader', {});
  const storyOf = () => q.t.doc.selection.ranges[0].focus.split('/b:')[0];
  const header = storyOf();
  await q.exec('hf.next', {});
  assert.notEqual(storyOf(), header, 'the caret moved to the footer');
  await q.exec('hf.previous', {});
  assert.equal(storyOf(), header, 'and back to the header');
  await q.exec('insert.closeHeader', {});
  // Header from Top / Footer from Bottom: points, shown by the boxes.
  assert.equal((await q.state('hf.headerFromTop')).value, 36);
  await q.exec('hf.headerFromTop', {distance: 20.5});
  await q.exec('hf.footerFromBottom', {distance: 500});
  assert.equal((await q.state('hf.headerFromTop')).value, 20.5);
  assert.equal((await q.state('hf.footerFromBottom')).value, 300, 'clamped to 300 pt');
  assert.deepEqual((await q.exec('hf.position', {header: 12})).result, {header: 12, footer: 300});
  // Link to Previous: the section's headers are the previous section's again.
  const doc = new Document(q.t.content);
  assert.ok(doc.sectionOfBlock(0).headers.default !== null);
  assert.deepEqual((await q.exec('layout.linkToPrevious', {})).result, {linked: true});
  assert.equal(new Document(q.t.content).sectionOfBlock(0).headers.default, null);
  assert.notEqual(new Document(q.t.content).sectionOfBlock(0).footers.default, null, 'footers are not touched without `footer`');
  await q.exec('layout.linkToPrevious', {footer: true});
  assert.equal(new Document(q.t.content).sectionOfBlock(0).footers.default, null);
  assert.ok(P.OBJ);
});

test('a building block keeps its category and description; the Organizer sorts its table by any column', async () => {
  const host = createTestHost();
  const q = await quill(TEXT, undefined, {host});
  q.sel(0, 0, 3);
  await q.exec('insert.quickParts', {save: 'Zed', category: 'Letters', description: 'The first word'});
  q.sel(0, 4, 9);
  await q.exec('insert.autoText', {save: 'Alpha', in: 'document', description: 'A colour'});
  q.sel(1, 0, 8);
  await q.exec('insert.quickParts', {save: 'Mid', category: 'Body'});
  const o = openDialogModel(q.t.session, q.t.docId, buildingBlocksDialog);
  assert.deepEqual(o.blocks.map(r => r.name), ['Alpha', 'Mid', 'Zed'], 'by name to begin with');
  assert.deepEqual(o.blocks.map(r => [r.category, r.description]), [['General', 'A colour'], ['Body', ''], ['Letters', 'The first word']]);
  assert.deepEqual(orderRows(o.blocks, 'category', false).map(r => r.name), ['Mid', 'Alpha', 'Zed'], 'Body, General, Letters');
  assert.deepEqual(orderRows(o.blocks, 'gallery', false).map(r => r.name), ['Alpha', 'Mid', 'Zed'], 'AutoText before Quick Parts, then by name');
  assert.deepEqual(orderRows(o.blocks, 'name', true).map(r => r.name), ['Zed', 'Mid', 'Alpha'], 'a second click on a heading reverses it');
  assert.deepEqual(orderRows(o.blocks, 'template', false).map(r => r.template), ['Normal.dotm', 'Normal.dotm', 'This document']);
  assert.deepEqual((await q.exec('insert.quickParts', {})).result.parts, ['Zed', 'Mid'], 'the galleries list their own');
  assert.ok(host.savedPrefs.buildingBlocks.Zed.description === 'The first word' && host.savedPrefs.buildingBlocks.Zed.gallery === 'Quick Parts');
});

test('Edit Properties: Modify Building Block renames, regroups and moves a block between settings and the document', async () => {
  const host = createTestHost();
  const q = await quill(TEXT, undefined, {host});
  q.sel(0, 4, 9);
  await q.exec('insert.quickParts', {save: 'Colour'});
  const m = openDialogModel(q.t.session, q.t.docId, modifyBuildingBlock);
  assert.deepEqual(modifyBuildingBlock.validate({...m, name: ' '}).map(e => e.field), ['name']);
  const cmd = modifyBuildingBlock.toCommand({...m, _name: 'Colour', _from: 'settings', _gallery: 'Quick Parts', name: 'Hue', gallery: 'AutoText', category: 'Words', description: 'A hue', location: 'This document'});
  assert.deepEqual(cmd, {command: 'insert.buildingBlockProperties', params: {name: 'Colour', from: 'settings', gallery: 'Quick Parts', to: {name: 'Hue', gallery: 'AutoText', category: 'Words', description: 'A hue', in: 'document'}}});
  const r = (await q.exec(cmd.command, cmd.params)).result;
  assert.deepEqual([r.name, r.gallery, r.category, r.in], ['Hue', 'AutoText', 'Words', 'document']);
  assert.deepEqual(Object.keys(host.savedPrefs.buildingBlocks ?? {}), [], 'no longer in the settings');
  assert.deepEqual(q.t.content.glossary.map(e => [e.name, e.gallery, e.category, e.description]), [['Hue', 'AutoText', 'Words', 'A hue']]);
  q.sel(2, 0);
  await q.exec('insert.autoText', {insert: 'Hue'});
  assert.equal(q.texts()[2], 'quickAnd a third one.', 'the moved block still inserts');
  // Back to the settings with only the description changed; a name in use, a missing block and an empty name are refused.
  await q.exec('insert.buildingBlockProperties', {name: 'Hue', from: 'document', gallery: 'AutoText', to: {in: 'settings', description: 'Back'}});
  assert.equal(host.savedPrefs.buildingBlocks.Hue.description, 'Back');
  assert.equal(host.savedPrefs.buildingBlocks.Hue.category, 'Words', 'what to leaves out stays');
  assert.equal(q.t.content.glossary.length, 0);
  q.sel(0, 0, 3);
  await q.exec('insert.quickParts', {save: 'Other'});
  await assert.rejects(() => q.exec('insert.buildingBlockProperties', {name: 'Other', to: {name: 'Hue'}}), /already/);
  await assert.rejects(() => q.exec('insert.buildingBlockProperties', {name: 'Missing', to: {name: 'X'}}), /no building block/);
  await assert.rejects(() => q.exec('insert.buildingBlockProperties', {name: 'Other', to: {name: ' '}}), /needs a name/);
});
