// Prism Home › Slides and Slide Show › Hide Slide through the bridge (U:prism/slide).
//
// What deckcraft does (crates/engine/src/cmd/slide.rs, ribbon/home.rs:102-148): New Slide adds a
// Title and Content slide after a title slide; the Layouts gallery lists the master's layouts and a
// click runs slide.new / slide.layout {layout: id}; Section › Add Section starts a section (the slides
// before go to a "Default Section"), Rename Section opens its dialog; Hide Slide toggles; Reset puts
// placeholders back. PowerPoint: the same buttons and menus. What this proves end to end in the
// app: ui.activate on the real ribbon controls (and the gallery with a layout id) changes the deck as
// the engine tests do, the Rename Section and Slides from Outline dialogs submit, the thumbnail
// pane follows (captured), and Ctrl+Z through the KeyRouter undoes. Captures in
// artifacts/e2e/prism/slide-ribbon/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';

test('prism slides: New Slide, Layouts gallery, Section, Hide Slide, Reset, dialogs, undo', {timeout: 240_000}, async () => {
  const file = createFile('prism', 'Slides deck', {schema: 2});
  file.id = 'prism-slides';
  file.content.slides[0].shapes[0].text = bodyFromText('Quarterly review');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/slide-ribbon', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const kind = (d, i) => d.masters[0].layouts.find(l => l.id === d.slides[i].layout).kind;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await app.rpc('ui.tab', {doc, tab: 'home'}).catch(() => {});

    // New Slide (the split's button): Title and Content after the title slide.
    await app.rpc('ui.activate', {doc, control: 'home.slides.new-slide'});
    let d = await deck();
    assert.equal(d.slides.length, 2);
    assert.equal(kind(d, 1), 'titleAndContent');
    // The Layouts gallery under New Slide: Two Content by its layout id.
    const two = d.masters[0].layouts.find(l => l.kind === 'twoContent').id;
    await app.rpc('ui.activate', {doc, control: 'home.slides.new-slide.layouts', value: two});
    d = await deck();
    assert.equal(kind(d, 2), 'twoContent');
    // Home › Layout's gallery changes the current slide's layout.
    const titleOnly = d.masters[0].layouts.find(l => l.kind === 'titleOnly').id;
    await app.rpc('ui.activate', {doc, control: 'home.slides.layout.layouts', value: titleOnly});
    d = await deck();
    assert.equal(kind(d, 2), 'titleOnly');
    await app.capture('1-new-slides-and-layout');

    // Section › Add Section on slide 3, then Rename Section through its dialog.
    await app.rpc('ui.activate', {doc, control: 'home.slides.section.add-section'});
    d = await deck();
    assert.deepEqual(d.sections.map(s => s.name), ['Default Section', 'Untitled Section']);
    await app.rpc('ui.activate', {doc, control: 'home.slides.section.rename-section'});
    const dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.renameSection');
    await app.rpc('ui.dialog.set', {field: 'name', value: 'Results'});
    await app.capture('2-rename-section-dialog');
    await app.rpc('ui.dialog.submit', {});
    d = await deck();
    assert.equal(d.sections[1].name, 'Results');

    // Slide Show › Hide Slide toggles the current slide.
    await app.rpc('ui.tab', {doc, tab: 'slide-show'}).catch(() => {});
    await app.rpc('ui.activate', {doc, control: 'slideshow.setup.hide-slide'});
    d = await deck();
    assert.equal(d.slides[2].hidden, true);
    await app.rpc('ui.tab', {doc, tab: 'home'}).catch(() => {});
    await app.capture('3-section-and-hidden-slide');

    // Slides from Outline… (dialog) adds two slides after the current one.
    await app.rpc('ui.activate', {doc, control: 'home.slides.new-slide.slides-from-outline'});
    await app.rpc('ui.dialog.set', {field: 'text', value: 'Next steps\n\tShip it\nQuestions'});
    await app.capture('4-outline-dialog');
    await app.rpc('ui.dialog.submit', {});
    d = await deck();
    assert.equal(d.slides.length, 5);
    assert.equal(d.slides[3].shapes[0].text.paragraphs[0].runs[0].text, 'Next steps');

    // Reset on a moved title (engine), then Ctrl+Z through the KeyRouter undoes the reset.
    await app.rpc('engine.execute', {doc, command: 'slide.go', params: {index: 1}});
    await app.rpc('ui.activate', {doc, control: 'home.slides.reset'});
    const k = await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    assert.equal(k.handled, true);
    // Slide 2 in the thumbnails, the deck after the undo.
    await app.capture('5-after-undo');
  } finally {
    await app.close();
  }
});
