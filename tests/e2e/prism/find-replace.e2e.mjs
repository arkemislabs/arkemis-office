// Prism Home › Editing (Find, Replace, Replace Fonts) and Paste Special through the bridge
// (U:prism/find, U:prism/text, U:prism/edit).
//
// What deckcraft does: Find (dialogs/find.rs) steps through text.find's matches in slide text,
// tables and notes with "Match n of m on slide k"; Replace… switches the dialog to replace mode,
// Replace replaces the current match and finds the next, Replace All reports the count
// (cmd/find.rs); Replace Fonts (body.rs:808) lists the deck's fonts, replaces and stays open;
// Paste Special (body.rs:897) pastes with the destination theme, the source's look or as text.
// PowerPoint: the same dialogs; Find selects the found text. What this proves end to end in the
// app: the ribbon opens each glass dialog, its fields and buttons run the commands, the deck reads
// back changed, and the dialogs are captured. Captures in artifacts/e2e/prism/find-replace/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {shape, presetGeom} from '../../../core/prism/model/presentation.mjs';
import {colorScheme, fillSolid} from '../../../core/prism/model/style.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';

const text = body => (body?.paragraphs ?? []).map(p => (p.runs ?? []).map(r => r.text ?? '').join('')).join('\n');

test('prism editing: Find, Replace, Replace Fonts and Paste Special dialogs', {timeout: 240_000}, async () => {
  const file = createFile('prism', 'Find deck', {schema: 2});
  file.id = 'prism-find';
  const s1 = file.content.slides[0];
  s1.shapes[0].text = bodyFromText('Old plan for the old team');
  const box = shape({id: 'r1', name: 'Rectangle 3', xfrm: {x: 600, y: 420, w: 220, h: 80}, geom: presetGeom('rect'), fill: fillSolid(colorScheme('accent1')),
    text: {body: {}, paragraphs: [{level: 0, runs: [{text: 'old numbers', props: {font: 'Georgia'}}]}]}});
  s1.shapes.push(box);
  s1.notes = bodyFromText('Mention the old plan');
  file.content.nextId = Math.max(file.content.nextId, 400);
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/find-replace', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const slide = async () => (await app.rpc('document.read', {doc, address: `/sl:${s1.id}`, as: 'json'})).value;
  const status = async () => (await app.rpc('ui.dialog.get', {})).values?.status;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await app.rpc('ui.tab', {doc, tab: 'home'}).catch(() => {});

    // Home › Editing › Find opens the Find dialog; Find Next selects the first match.
    await app.rpc('ui.activate', {doc, control: 'home.editing.find'});
    assert.equal((await app.rpc('ui.dialog.get', {})).id, 'dialog.find');
    await app.rpc('ui.dialog.set', {field: 'text', value: 'old'});
    await app.rpc('ui.dialog.submit', {field: 'findNext'});
    assert.equal(await status(), 'Match 1 of 4 on slide 1.');
    const sel = (await app.rpc('selection.get', {doc})).selection.ranges[0];
    assert.match(sel.anchor, /\/t:0$/);
    assert.match(sel.focus, /\/t:3$/);
    await app.capture('1-find-dialog');
    // Replace… switches to replace mode; Replace replaces the selected match and finds the next.
    await app.rpc('ui.dialog.submit', {field: 'replaceMode'});
    await app.rpc('ui.dialog.set', {field: 'with', value: 'new'});
    await app.rpc('ui.dialog.submit', {field: 'replace'});
    assert.equal(text((await slide()).shapes[0].text), 'new plan for the old team');
    assert.equal(await status(), 'Match 1 of 3 on slide 1.');
    await app.capture('2-replace-mode');
    await app.rpc('ui.dialog.submit', {field: 'replaceAll'});
    assert.equal(await status(), 'Replaced 3 occurrence(s).');
    const sl = await slide();
    assert.equal(text(sl.shapes[0].text), 'new plan for the new team');
    assert.equal(text(sl.notes), 'Mention the new plan');
    await app.rpc('ui.dialog.cancel', {});

    // Replace Fonts: Georgia → Verdana, the dialog stays open and says so.
    await app.rpc('ui.activate', {doc, control: 'home.editing.replace-fonts'});
    assert.equal((await app.rpc('ui.dialog.get', {})).id, 'dialog.replaceFonts');
    await app.rpc('ui.dialog.set', {values: {from: 'Georgia', to: 'Verdana'}});
    await app.rpc('ui.dialog.submit', {field: 'replace'});
    assert.equal((await app.rpc('ui.dialog.get', {})).values.result, 'Replaced “Georgia” with “Verdana”.');
    await app.capture('3-replace-fonts');
    await app.rpc('ui.dialog.cancel', {});
    assert.equal((await slide()).shapes.at(-1).text.paragraphs[0].runs[0].props.font, 'Verdana');

    // Copy the rectangle, then Paste Special › Keep Text Only makes a text box with its text.
    await app.rpc('selection.set', {doc, ranges: [{anchor: `/sl:${s1.id}/sp:r1`, focus: `/sl:${s1.id}/sp:r1`}]});
    await app.rpc('ui.key', {doc, keys: 'Ctrl+C'});
    await app.rpc('ui.activate', {doc, control: 'home.clipboard.paste.paste-special'});
    assert.equal((await app.rpc('ui.dialog.get', {})).id, 'dialog.pasteSpecial');
    await app.rpc('ui.dialog.set', {field: 'as', value: 'text'});
    await app.capture('4-paste-special');
    await app.rpc('ui.dialog.submit', {});
    const after = await slide();
    assert.equal(text(after.shapes.at(-1).text), 'new numbers');
    assert.equal(after.shapes.at(-1).textBox, true);
    await app.capture('5-pasted-as-text');
  } finally {
    await app.close();
  }
});
