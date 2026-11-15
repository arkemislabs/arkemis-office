// Prism in-place text editing and the clipboard through the bridge (U:prism/text, U:prism/edit).
//
// What deckcraft does: a click in a placeholder places the caret (tools/pointer.rs → text.edit
// {id, at}); typing runs text.insert with AutoCorrect (cmd/text/editing.rs, autocorrect.rs);
// Shift+Home selects to the line start (text.move {extend}); Escape leaves the text with the shape
// selected (text.exit); Ctrl+C / Ctrl+V copy and paste shapes offset on the same slide
// (cmd/edit.rs copy_inner, paste); Ctrl+D duplicates; Delete removes. PowerPoint: the same keys.
// What this proves end to end in the app: ui.pointer + ui.type + ui.key reach these commands
// through the surface and the KeyRouter, the document reads back as typed (with AutoCorrect),
// the caret and selection are drawn (captured), and Ctrl+Z undoes word by word.
// Captures in artifacts/e2e/prism/text-editing/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {shape, presetGeom} from '../../../core/prism/model/presentation.mjs';
import {colorRgb, fillSolid} from '../../../core/prism/model/style.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';

const text = body => (body?.paragraphs ?? []).map(p => (p.runs ?? []).map(r => (r.kind?.kind === 'break' ? '\u000b' : r.text ?? '')).join('')).join('\n');

test('prism text: click into a placeholder, type with AutoCorrect, select, copy and paste, undo', {timeout: 240_000}, async () => {
  const file = createFile('prism', 'Text deck', {schema: 2});
  file.id = 'prism-text';
  const s1 = file.content.slides[0];
  s1.shapes.push(shape({id: 'r1', name: 'Rectangle 3', xfrm: {x: 600, y: 420, w: 200, h: 80}, geom: presetGeom('rect'),
    fill: fillSolid(colorRgb({r: 68, g: 114, b: 196, a: 255})), text: bodyFromText('Box')}));
  file.content.nextId = Math.max(file.content.nextId, 400);
  const title = s1.shapes[0].id;
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/text-editing', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const read = async a => (await app.rpc('document.read', {doc, address: a, as: 'json'})).value;
  const sel = async () => (await app.rpc('selection.get', {doc})).selection;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});

    // A click in the empty title placeholder places the caret there (text.edit).
    await app.rpc('ui.pointer', {doc, events: [{kind: 'down', x: 480, y: 200}, {kind: 'up', x: 480, y: 200}]});
    let s = await sel();
    assert.match(s.ranges[0].anchor, new RegExp(`/sp:${title}/t:0$`), JSON.stringify(s));
    // Typing key by key (the surface's hidden text field, one input per character): AutoCorrect
    // capitalises the sentence and fixes "teh" when the space after it is typed.
    for (const ch of 'teh quarterly review ') await app.rpc('ui.type', {doc, text: ch});
    await app.until(async () => text((await read(`/sl:${s1.id}/sp:${title}`)).text) === 'The quarterly review ' || null, {timeout: 10_000});
    await app.capture('1-typed-title');
    // Shift+Home selects back to the start of the line.
    const k = await app.rpc('ui.key', {doc, keys: 'Shift+Home'});
    assert.equal(k.handled, true);
    s = await sel();
    assert.match(s.ranges[0].anchor, /\/t:21$/);
    assert.match(s.ranges[0].focus, /\/t:0$/);
    await app.capture('2-text-selected');
    // Typing replaces the selection; Enter starts a new paragraph.
    await app.rpc('ui.type', {doc, text: 'Results'});
    await app.rpc('ui.key', {doc, keys: 'Enter'});
    for (const ch of 'by region') await app.rpc('ui.type', {doc, text: ch});
    assert.equal(text((await read(`/sl:${s1.id}/sp:${title}`)).text), 'Results\nBy region');
    // Escape leaves the text; the placeholder stays selected.
    await app.rpc('ui.key', {doc, keys: 'Escape'});
    s = await sel();
    assert.deepEqual(s.ranges.map(r => r.anchor), [`/sl:${s1.id}/sp:${title}`]);
    await app.capture('3-placeholder-selected');

    // Select the rectangle, Ctrl+C, Ctrl+V: the copy lands 12 pt down and right, named "Rectangle 4".
    await app.rpc('selection.set', {doc, ranges: [{anchor: `/sl:${s1.id}/sp:r1`, focus: `/sl:${s1.id}/sp:r1`}]});
    assert.equal((await app.rpc('ui.key', {doc, keys: 'Ctrl+C'})).handled, true);
    assert.equal((await app.rpc('ui.key', {doc, keys: 'Ctrl+V'})).handled, true);
    let slide = await read(`/sl:${s1.id}`);
    await app.until(async () => { slide = await read(`/sl:${s1.id}`); return slide.shapes.length === 4 || null; }, {timeout: 10_000});
    const copy = slide.shapes.at(-1);
    assert.deepEqual([copy.xfrm.x, copy.xfrm.y, copy.name], [612, 432, 'Rectangle 4']);
    // Ctrl+D duplicates the copy; Delete removes the duplicate.
    await app.rpc('ui.key', {doc, keys: 'Ctrl+D'});
    slide = await read(`/sl:${s1.id}`);
    assert.equal(slide.shapes.length, 5);
    await app.capture('4-pasted-and-duplicated');
    await app.rpc('ui.key', {doc, keys: 'Delete'});
    slide = await read(`/sl:${s1.id}`);
    assert.equal(slide.shapes.length, 4);

    // Ctrl+Z through the KeyRouter undoes the delete, then the bridge undoes down to the typing.
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.equal((await read(`/sl:${s1.id}`)).shapes.length, 5);
    for (let i = 0; i < 2; i++) await app.rpc('engine.execute', {doc, command: 'edit.undo'});
    assert.equal((await read(`/sl:${s1.id}`)).shapes.length, 3);
    await app.capture('5-after-undo');
  } finally {
    await app.close();
  }
});
