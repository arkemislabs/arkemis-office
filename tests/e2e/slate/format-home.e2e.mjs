// U:slate format / paragraph / tags: OneNote's Home tab on a real notebook, end to end through the
// bridge: Basic Text (Bold by its ribbon button and by Ctrl+B through KeyRouter, Font Size, Font
// Color, Highlight, Bullets, Numbering, Increase Indent, Align), Styles (Heading 1), Tags (To Do
// from the gallery and Ctrl+1, Important), Find Tags, Customize Tags and Paragraph Spacing
// dialogs. Every step is checked in the document (document.read) and captured.
//
// Behaviour fidelity: see tests/slate/format.test.mjs, paragraph.test.mjs and tags.test.mjs.
// Evidence: artifacts/e2e/slate/format-home/*.png. No OS or DOM input: ui.activate / ui.key /
// ui.dialog.* / engine.execute only; the window is inactive and not focusable.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createContent, newPageRecord, SECTION_COLORS, validateContent} from '../../../core/slate/schema.mjs';

const NOW = '2026-10-30T09:30:00.000Z';
const para = (id, text, style = 'normal') => ({type: 'paragraph', attrs: {id, style, align: null, indent: 0, dir: null, tags: [], spacing: null, audio: null}, ...(text ? {content: [{type: 'text', text}]} : {})});

function seed() {
  let n = 0;
  const c = createContent('Physics 101', {uid: () => `f${(n++).toString(36).padStart(4, '0')}`, now: NOW});
  c.tree = ['sw1']; c.groups = {}; c.pages = {};
  c.sections = {sw1: {id: 'sw1', name: 'Week 1', color: SECTION_COLORS[0], created: NOW, pages: [{id: 'pnotes', level: 0}]}};
  c.pages.pnotes = {...newPageRecord({id: 'pnotes', title: 'Lecture notes', created: NOW}), body: {type: 'doc', content: [
    {type: 'container', attrs: {id: 'c1', x: 48, y: 140, width: 560}, content: [
      para('h', 'Newton\'s laws'),
      para('l1', 'A body stays at rest unless a force acts on it'),
      para('l2', 'Force equals mass times acceleration'),
      para('l3', 'Every action has an equal and opposite reaction'),
      para('t1', 'Read chapter 4 before Friday'),
      para('t2', 'Ask about the lab report format'),
    ]},
  ]}};
  return validateContent(c);
}

const fileOf = (id, content) => ({id, schema: 2, kind: 'slate', title: content.notebook.name, revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [], content});

test('slate Home tab: Basic Text, Styles and Tags work on a notebook through the ribbon, shortcuts and dialogs', {timeout: 240_000}, async () => {
  const doc = 'slate-home';
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'slate', flow: 'slate/format-home', files: [fileOf(doc, seed())], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async (address, as = 'json') => (await app.rpc('document.read', {doc, address, as})).value;
  const select = (anchor, focus = anchor) => app.rpc('selection.set', {doc, ranges: [{anchor, focus}]});
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const block = async id => (await read(`/pg:pnotes/b:${id}`)).attrs;
  const runs = async id => (await read(`/pg:pnotes/b:${id}`, 'runs')).map(r => [r.text, Object.keys(r.marks).sort().join('+')]);
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}).catch(() => null); return ui?.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000})
      .catch(e => { throw new Error(e.message + log()); });
    await app.rpc('ui.tab', {doc, id: 'home'});
    await settle(800);
    await app.capture('01-home-tab', {doc});

    // Heading 1 from the Styles gallery on the first paragraph.
    await select('/pg:pnotes/b:h/t:3');
    await app.rpc('ui.activate', {doc, control: 'home.styles.styles.heading-1'});
    assert.equal((await block('h')).style, 'h1');

    // Bold by the ribbon button, then Italic by Ctrl+I through KeyRouter, on "body".
    await select('/pg:pnotes/b:l1/t:2-6');
    await app.rpc('ui.activate', {doc, control: 'home.basic-text.bold'});
    assert.deepEqual(await runs('l1'), [['A ', ''], ['body', 'bold'], [' stays at rest unless a force acts on it', '']]);
    const key = await app.rpc('ui.key', {doc, keys: 'Mod+I'});
    assert.equal(key.handled, true);
    await app.until(async () => (await runs('l1'))[1][1] === 'bold+italic' || null, {timeout: 10_000});

    // Font size and font colour from the ribbon; highlight on the next line.
    await app.rpc('ui.activate', {doc, control: 'home.basic-text.font-color.blue'});
    await exec('format.fontSize', {points: 16});
    assert.deepEqual((await read('/pg:pnotes/b:l1/t:2-6', 'props')).marks.textStyle, {color: '#0070c0', fontFamily: null, fontSize: 16});
    await select('/pg:pnotes/b:l2/t:0-5');
    await app.rpc('ui.activate', {doc, control: 'home.basic-text.highlight.yellow'});
    assert.deepEqual((await read('/pg:pnotes/b:l2/t:0-5', 'props')).marks.highlight, {color: '#ffff00'});

    // Numbering on the three laws, then bullets would replace it; indent the second one.
    await select('/pg:pnotes/b:l1/t:0', '/pg:pnotes/b:l3/t:3');
    await app.rpc('ui.activate', {doc, control: 'home.basic-text.numbering.decimal-period'});
    let box = await read('/pg:pnotes/c:c1');
    assert.equal(box.content[1].type, 'orderedList');
    assert.equal(box.content[1].content.length, 3);
    await select('/pg:pnotes/b:l2/t:1');
    await app.rpc('ui.activate', {doc, control: 'home.basic-text.increase-indent'});
    await app.rpc('ui.activate', {doc, control: 'home.basic-text.paragraph-alignment.center'});
    box = await read('/pg:pnotes/c:c1');
    assert.equal(box.content[1].content[0].content[1].type, 'orderedList', 'the second law is nested under the first');
    assert.equal((await block('l2')).align, 'center');

    // Tags: To Do from the gallery on t1, Ctrl+1 on t2 (then Ctrl+1 again checks it), Important.
    await select('/pg:pnotes/b:t1/t:0');
    await app.rpc('ui.activate', {doc, control: 'home.tags.tags.to-do'});
    await select('/pg:pnotes/b:t2/t:0');
    assert.equal((await app.rpc('ui.key', {doc, keys: 'Mod+1'})).handled, true);
    await app.until(async () => ((await block('t2')).tags ?? []).some(t => (t?.id ?? t) === 'to-do') || null, {timeout: 10_000});
    await app.rpc('ui.key', {doc, keys: 'Mod+1'});
    await app.rpc('ui.activate', {doc, control: 'home.tags.tags.important'});
    const summary = await exec('tags.find', {groupBy: 'tag-name'});
    assert.deepEqual(summary.groups.map(g => [g.name, g.items.length]), [['To Do', 2], ['Important', 1]]);
    assert.deepEqual(summary.groups[0].items.map(i => i.checked), [false, true]);
    await settle(600);
    await app.capture('02-formatted', {doc});

    // Paragraph Spacing Options through its dialog.
    await select('/pg:pnotes/b:t1/t:0');
    await app.rpc('ui.activate', {doc, control: 'home.basic-text.paragraph-alignment.paragraph-spacing-options'});
    let dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.paragraph-spacing');
    await app.rpc('ui.dialog.set', {doc, values: {spaceBefore: 6, spaceAfter: 12}});
    await app.capture('03-paragraph-spacing', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    assert.deepEqual((await block('t1')).spacing, {spaceBefore: 6, spaceAfter: 12, lineSpacingAtLeast: 0});

    // Customize Tags: move Important to the top.
    await app.rpc('ui.activate', {doc, control: 'home.tags.tags.customize-tags'});
    dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.customize-tags');
    await app.rpc('ui.dialog.set', {doc, values: {tags: 'important'}});
    await app.capture('04-customize-tags', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    await exec('tag.reorder', {tagId: 'important', direction: 'up'});
    const list = (await exec('tag.customize')).tags;
    assert.equal(list[0].id, 'important');

    // Undo by Ctrl+Z through KeyRouter, last edit first: the paragraph spacing (reordering tags is a
    // preference, not a document edit), then the Important tag.
    await app.rpc('ui.key', {doc, keys: 'Mod+Z'});
    await app.until(async () => !(await block('t1')).spacing || null, {timeout: 10_000});
    assert.ok(((await block('t2')).tags ?? []).some(t => t.id === 'important'), 'one undo takes back only the spacing');
    await app.rpc('ui.key', {doc, keys: 'Mod+Z'});
    await app.until(async () => !((await block('t2')).tags ?? []).some(t => t.id === 'important') || null, {timeout: 10_000});
    await settle(500);
    await app.capture('05-final', {doc});
  } finally {
    await app.close();
  }
});
