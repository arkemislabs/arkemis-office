// Quill's Developer tab (U:quill/developer) end to end through the bridge, in the new shell. No OS input: ribbon
// controls through ui.activate, typing through ui.type (the page view's own input handler), dialogs through
// ui.dialog.*, and the document read back over the bridge.
//
// Behaviour fidelity:
// 1. ArtCraft crates/engine/src/cmd/controls.rs, tools/actions.rs and templates.rs, the ribbon in
//    crates/ui-egui/src/ribbon/review.rs and the dialogs in dialogs_controls.rs / dialogs_templates.rs; Word: a
//    content control stands at the caret showing its placeholder, typing replaces it, Design Mode outlines every
//    control with its title, Properties edits the control at the caret, a macro replays what was recorded, the
//    document template is a setting of the document, and controls are saved to .docx as w:sdt.
// 2. The same commands run from the window (the person's path), each one undo step; the page view draws the
//    controls (captures below).
// 3. This file; the engine side is tests/quill/developer.test.mjs.
//
// Evidence: artifacts/e2e/quill/developer/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {Document} from '../../../core/quill/model/document.mjs';
import {read as readDocx} from '../../../core/quill/formats/docx-read.mjs';
import {devRenderer, launchApp} from '../harness.mjs';
import {documentsFolder, exists, binding, script} from '../common/file-helpers.mjs';

const para = text => ({type: 'paragraph', content: [{type: 'text', text}]});

function seedDoc(id) {
  const seed = createFile('quill', 'Intake form');
  seed.id = id;
  seed.content.doc = {type: 'doc', content: [
    {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Visitor intake form'}]},
    para('Name: '),
    para('Visiting on: '),
    para('Department: '),
    para('I have read the safety notes: '),
    para('Notes: '),
  ]};
  return migrateFile(seed);
}

const textOf = x => JSON.stringify(x);

test('quill Developer tab: content controls, Design Mode, Properties, macros, document template, Restrict Editing, .docx', {timeout: 600_000}, async () => {
  const seed = seedDoc('quill-developer');
  const folder = await documentsFolder('quill-developer');
  const target = path.join(folder, 'Intake.docx');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'quill', flow: 'quill/developer', files: [seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = seed.id;
  const run = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = () => app.rpc('document.read', {doc, address: '/body', as: 'json'});
  const settle = (ms = 450) => new Promise(r => setTimeout(r, ms));
  const inspect = () => app.rpc('ui.inspect', {doc});
  const control = async id => (await inspect()).controls?.find(c => c.id === id) ?? null;
  const activate = (id, value) => app.rpc('ui.activate', {doc, control: id, ...(value === undefined ? {} : {value})});
  const controlsIn = async () => {
    const v = (await read()).value;
    const out = [];
    const walk = x => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') {
        if (x.type === 'controlStart' && x.control) out.push(x.control);
        Object.values(x).forEach(walk);
      }
    };
    walk(v);
    return out;
  };
  const byTag = async tag => (await controlsIn()).find(c => c.tag === tag);
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await inspect(); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });

    // The Developer tab: every group; the controls with no upstream engine are hidden.
    await app.rpc('ui.tab', {doc, id: 'developer'});
    await settle();
    const ids = new Set(((await inspect()).controls ?? []).map(c => c.id));
    for (const id of ['developer.code.macros', 'developer.code.record-macro', 'developer.controls.rich-text-content-control', 'developer.controls.plain-text-content-control',
      'developer.controls.picture-content-control', 'developer.controls.building-block-gallery-content-control', 'developer.controls.check-box-content-control',
      'developer.controls.combo-box-content-control', 'developer.controls.drop-down-list-content-control', 'developer.controls.date-picker-content-control',
      'developer.controls.repeating-section-content-control', 'developer.controls.design-mode', 'developer.controls.properties', 'developer.protect.restrict-editing',
      'developer.templates.document-template']) assert.ok(ids.has(id), `${id} is on the Developer tab`);
    for (const id of ['developer.code.visual-basic', 'developer.code.pause-recording', 'developer.code.macro-security', 'developer.add-ins.add-ins', 'developer.add-ins.word-add-ins',
      'developer.add-ins.com-add-ins', 'developer.controls.group', 'developer.mapping.xml-mapping-pane', 'developer.protect.block-authors']) {
      assert.ok(!ids.has(id), `${id} has no upstream engine here and stays hidden`);
    }
    assert.ok(ids.has('developer.controls.legacy-tools'), 'Legacy Tools holds the legacy form fields now (U:quill/rest)');
    assert.equal((await control('developer.controls.properties'))?.enabled, false, 'Properties needs a control at the caret');
    await app.capture('1-developer-tab', {doc});

    // Insert each control at the end of its line: the caret goes to the end of paragraph n.
    const caretAt = async (n, off) => run('caret.set', {pos: {block: n, off}});
    await caretAt(1, 'Name: '.length);
    await activate('developer.controls.plain-text-content-control');
    await run('developer.properties', {tag: 'name', title: 'Name', placeholder: 'Type the visitor\'s name'});
    assert.equal((await byTag('name')).showingPlaceholder, true);
    // Typing replaces the placeholder (through the page view's own input).
    await app.rpc('ui.type', {doc, text: 'Ada Lovelace'});
    assert.equal(textOf(await read()).includes('Ada Lovelace'), true, 'typed text is in the control');
    assert.equal((await byTag('name')).showingPlaceholder, false);

    await caretAt(2, 'Visiting on: '.length);
    await activate('developer.controls.date-picker-content-control');
    await run('developer.properties', {tag: 'when', title: 'Visit date', format: 'MMMM d, yyyy'});
    await run('developer.setDate', {control: 'when', date: '2026-11-02'});
    assert.ok(textOf(await read()).includes('November 2, 2026'));

    await caretAt(3, 'Department: '.length);
    await activate('developer.controls.drop-down-list-content-control');
    await run('developer.properties', {tag: 'dept', title: 'Department', items: ['Engineering', {display: 'Customer Care', value: 'cc'}, 'Finance']});
    await run('developer.chooseItem', {control: 'dept', value: 'cc'});
    assert.ok(textOf(await read()).includes('Customer Care'));

    await caretAt(4, 'I have read the safety notes: '.length);
    await activate('developer.controls.check-box-content-control');
    const boxes = (await controlsIn()).filter(c => c.kind?.type === 'checkBox');
    assert.equal(boxes.length, 1);
    // The caret is after a check box; `at` names the control by a position inside it.
    await run('developer.properties', {at: {block: 4, off: 'I have read the safety notes: '.length + 1}, tag: 'safety', title: 'Safety notes read'});
    await run('developer.toggleCheckBox', {control: 'safety'});
    assert.equal((await byTag('safety')).kind.checked, true);

    await caretAt(5, 'Notes: '.length);
    await activate('developer.controls.rich-text-content-control');
    await run('developer.properties', {tag: 'notes', title: 'Notes'});
    await settle();
    await app.capture('2-controls-inserted', {doc});

    // Design Mode: every control is outlined with its title.
    await activate('developer.controls.design-mode');
    assert.equal((await control('developer.controls.design-mode'))?.checked, true, 'Design Mode is on');
    await settle();
    await app.capture('3-design-mode', {doc});
    await activate('developer.controls.design-mode');
    assert.equal((await control('developer.controls.design-mode'))?.checked, false);

    // Properties: the dialog for the control at the caret (the drop-down list).
    const dept = await byTag('dept');
    assert.ok(dept, 'the drop-down list is there');
    await run('caret.set', {pos: {block: 3, off: 'Department: '.length + 3}});
    assert.equal((await control('developer.controls.properties'))?.enabled, true);
    await activate('developer.controls.properties');
    let dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.controlProperties');
    assert.equal(dlg.values.kind, 'dropDown');
    assert.equal(dlg.values.title, 'Department');
    assert.deepEqual(dlg.values.entries, [{display: 'Engineering', value: 'Engineering'}, {display: 'Customer Care', value: 'cc'}, {display: 'Finance', value: 'Finance'}]);
    assert.equal(dlg.values.appearance, 'Bounding Box');
    await settle();
    await app.capture('4-control-properties', {doc});
    await app.rpc('ui.dialog.set', {doc, values: {title: 'Team', appearance: 'Start/End Tag', color: '#2F5597', lockDelete: true,
      entries: [...dlg.values.entries, {display: 'People', value: 'People'}]}});
    await settle();
    await app.capture('4b-control-properties-set', {doc});
    // Use a style: the Style drop-down beside New Style… is for a ticked box only, and then holds a character style.
    await app.rpc('ui.dialog.set', {doc, values: {useStyle: true}});
    await settle();
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.ok(String(dlg.values.style), 'ticking Use a style picks a style');
    await app.capture('4c-control-properties-style', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    const team = await byTag('dept');
    assert.equal(team.title, 'Team');
    assert.equal(team.kind.items.length, 4);
    assert.equal(team.lock, 'sdtLocked');
    assert.deepEqual([team.appearance, team.color], ['tags', '2F5597'], 'Show as and Color are kept');

    // Macros: record typing, stop, replay it from the Macros dialog.
    await caretAt(5, 'Notes: '.length + 1);
    await activate('developer.code.record-macro');
    assert.equal((await control('developer.code.record-macro'))?.checked, true, 'recording');
    await app.rpc('ui.type', {doc, text: ' (checked in)'});
    await activate('developer.code.record-macro');
    assert.equal((await control('developer.code.record-macro'))?.checked, false);
    const macros = Object.entries(await run('tools.macros', {})).map(([name, steps]) => ({name, steps: steps.length}));
    assert.equal(macros.length, 1, JSON.stringify(macros));
    assert.equal(macros[0].steps, ' (checked in)'.length, 'one step for each command run while recording');
    await activate('developer.code.macros');
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.macros');
    assert.equal(dlg.values.name, macros[0].name);
    await settle();
    await app.capture('5-macros-dialog', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    const typedTwice = textOf(await read()).split('(checked in)').length - 1;
    assert.equal(typedTwice, 2, 'the macro typed the text again');

    // Document Template.
    await activate('developer.templates.document-template');
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.templates');
    await app.rpc('ui.dialog.set', {doc, values: {template: 'Visitor Forms.dotx', linkStyles: false}});
    await settle();
    await app.capture('6-document-template', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    assert.deepEqual(await run('tools.templates', {}), {template: 'Visitor Forms.dotx', linkStyles: false});

    // Restrict Editing: the pane; with form filling enforced the document takes no new controls.
    await activate('developer.protect.restrict-editing');
    await settle(900);
    await app.capture('7-restrict-editing', {doc});
    await run('review.restrict', {mode: 'forms'});
    await caretAt(1, 0);
    await assert.rejects(() => run('developer.richText', {}), /protection|protected/);
    await run('review.restrict', {stop: true});

    // Save as .docx: the controls are w:sdt and read back.
    await script(app, {type: 'save', path: target});
    const key = await app.rpc('ui.key', {doc, keys: 'Ctrl+S'});
    assert.equal(key.command, 'file.save');
    await app.until(() => exists(target), {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.until(async () => (await binding(app, doc))?.path === target || null, {timeout: 30_000});
    const bytes = new Uint8Array(await fs.readFile(target));
    const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string');
    for (const tag of ['<w:sdt>', '<w:alias w:val="Team"/>', '<w:dropDownList', '<w14:checkbox>', '<w:date', '<w:lock w:val="sdtLocked"/>']) assert.ok(xml.includes(tag), `${tag} in the .docx`);
    const settings = await (await JSZip.loadAsync(bytes)).file('word/settings.xml').async('string');
    assert.ok(settings.includes('w:attachedTemplate'), 'the template is in the settings');
    const back = new Document(await readDocx(bytes));
    const read2 = back.controlRanges('body').filter(r => Number.isInteger(r.start.off));
    assert.equal(read2.length, 5, 'five controls read back');
    assert.equal(read2.find(r => r.control.tag === 'dept').control.kind.items.length, 4);
  } finally {
    await app.close();
  }
  await fs.rm(folder, {recursive: true, force: true});
});
