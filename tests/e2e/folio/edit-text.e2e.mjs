// Edit PDF text, end to end in the window (docs/behaviour-fidelity.md):
//   the Edit text & images tool showing the page's paragraphs as boxes, a click opening a paragraph for typing, words typed into it written back
//   through the content stream and rewrapped within the paragraph's own box, the Format text controls of the Edit panel restyling the open
//   paragraph, a drag moving a paragraph without touching its glyphs, and the file read again after the edits.
//
// Behaviour fidelity:
// 1. printcraft 0.16.0: crates/ui-egui/src/tools/edit_text_ui.rs (paragraph boxes, a click opens the paragraph, the editor holds its words,
//    applying writes the paragraph back, a drag moves it), panels/format_text_ui.rs and crates/edit/src/text (rewrap, formatting). Acrobat's Edit
//    text & images does the same.
// 2. Here the window runs the new shell (devRenderer); the page gestures go through surface.pointer (in-page pointer events at page view points,
//    the page view's own handlers), typing through ui.type into the open paragraph's box, the panel's controls through ui.activate. No OS input.
// 3. Evidence: artifacts/e2e/folio/edit-text/*.png (ui.capture -> capturePage).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {editImagePdf, REPLACEMENT_PNG, schema1Content} from '../../../core/folio/fixtures.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

test('folio edit text and images: boxes, a click opens a paragraph, typing reflows it in its box, formatting, a drag moves it, an image is turned, flipped, cropped, replaced and moved', {timeout: 600_000}, async () => {
  const file = createFile('folio', 'Edit PDF text');
  file.id = 'folio-edit-text';
  file.content = await schema1Content(await editImagePdf(), 'report.pdf');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/edit-text', files: [file], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const doc = file.id;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const surface = () => exec('surface.view');
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const click = async (x, y, extra = {}) => { await exec('surface.pointer', {page: 1, action: 'click', x, y, ...extra}); await settle(700); };
  const blocks = async () => (await exec('edit.blocks', {page: 1})).blocks;
  const flat = b => b.text.replace(/\n/g, ' ');
  // View space: origin top-left, y down; the page is 792 high.
  const center = b => [(b.rect[0] + b.rect[2]) / 2, (b.rect[1] + b.rect[3]) / 2];
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const s = await surface(); return !s.migrating && s.renders.count > 0 ? s : null; }, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await exec('view.zoom.fit_width');
    await settle(800);

    // 1. The paragraphs of the page are listed: the heading, the three-row body (one paragraph), the outlook line and the footer.
    let list = await blocks();
    assert.deepEqual(list.map(flat), [
      'Quarterly Report',
      'Revenue grew steadily across every region this quarter, led by the new subscription plans. Costs stayed flat while support tickets fell by a third.',
      'Outlook: expect a similar pattern in the next quarter.',
      'Confidential - for the board only',
      'Mixed styles: bold red and plain words.']);
    assert.equal((await exec('edit.blocks', {page: 1})).via, 'worker', 'the page is read in the folio text worker, not on the window thread');
    assert.equal(list[1].rows, 3);
    assert.ok(list.every(b => b.editable));
    assert.equal(list.length, 5, 'the picture is not a paragraph');
    const bodyWidth = list[1].rect[2] - list[1].rect[0];

    // 2. The Edit mode shows the Format text controls; picking Edit text & images shows the paragraph boxes.
    await app.rpc('ui.tab', {doc, id: 'edit'});
    await settle(600);
    await app.rpc('ui.activate', {doc, control: 'quick.bar.edit-text'});
    await settle(900);
    assert.equal((await exec('surface.view')).migrating, false);
    await app.capture('tool-boxes');

    // 3. A click inside the body paragraph opens it for typing.
    await click(...center(list[1]));
    await app.capture('open');
    // 4. Words typed at the end are written back when the paragraph is left; the rows rewrap within the paragraph's own width.
    await app.rpc('ui.type', {doc, text: ' Margins improved by two points and the team grew by five people.'});
    await settle(500);
    await app.capture('typed');
    await click(560, 400);
    await settle(900);
    list = await blocks();
    assert.equal(flat(list[1]), 'Revenue grew steadily across every region this quarter, led by the new subscription plans. Costs stayed flat while support tickets fell by a third. Margins improved by two points and the team grew by five people.');
    assert.ok(list[1].rows >= 4, `the longer text wraps onto more rows: ${list[1].rows}`);
    assert.ok(list[1].text.split(String.fromCharCode(10)).slice(0, -1).every(r => r.length >= 40), `a short row was kept as a break instead of the flow rewrapping: ${JSON.stringify(list[1].text)}`);
    assert.ok(list[1].rect[2] - list[1].rect[0] <= bodyWidth + 1, 'the rows stay inside the paragraph box');
    assert.equal(flat(list[2]), 'Outlook: expect a similar pattern in the next quarter.', 'the paragraph below is untouched');
    await settle(1200);
    await app.capture('written-back');

    // 5. Format text acts on the open paragraph: a click opens it; the controls of the panel (run as the panel runs them) restyle it.
    await click(...center(list[2]));
    await click(560, 400);
    await settle(600);
    await exec('edit.select_block', {page: 1, key: list[2].key});
    await app.rpc('ui.activate', {doc, control: 'edit.format.bold'});
    await settle(900);
    list = await blocks();
    assert.equal(list[2].bold, true);
    assert.match(list[2].font, /Bold/);
    await exec('edit.format', {field: 'size', value: 16});
    await settle(500);
    await exec('edit.format', {field: 'color', value: '#cc0000'});
    await settle(500);
    list = await blocks();
    assert.equal(list[2].size, 16);
    assert.equal(list[2].color, '#cc0000');
    await settle(1500);
    await app.capture('formatted');
    await exec('edit.select_block', {});

    // 6. A drag on a paragraph box moves it: the glyphs are not re-encoded (the words and their font stay). The outlook line is in the window.
    const outlook = list[2];
    const before = outlook.rect.slice();
    const [fx, fy] = center(outlook);
    await exec('surface.pointer', {page: 1, action: 'drag', x: fx, y: fy, to: {x: fx + 40, y: fy + 60}});
    await settle(1100);
    list = await blocks();
    const moved = list.find(b => b.text === outlook.text);
    assert.ok(moved, 'the outlook line is still a paragraph');
    assert.ok(Math.abs(moved.rect[0] - before[0] - 40) < 1.5 && Math.abs(moved.rect[1] - before[1] - 60) < 1.5, `moved by (40, 60): ${before} -> ${moved.rect}`);
    assert.equal(moved.font, outlook.font);
    assert.equal(moved.size, outlook.size);
    assert.equal(list.length, 5, 'no paragraph was lost or split');
    await settle(1200);
    await app.capture('moved');

    // 7. The picture beside the paragraph: a click selects it (its frame and corner handles), the Image controls of the panel act on it.
    const picture = async () => (await exec('edit.images', {page: 1})).images;
    let [pic] = await picture();
    assert.deepEqual([pic.name, pic.width, pic.height], ['Im1', 16, 12]);
    const start = pic.rect.slice();
    await click((start[0] + start[2]) / 2, (start[1] + start[3]) / 2);
    await settle(800);
    await app.capture('image-selected');
    await app.rpc('ui.activate', {doc, control: 'edit.image.rotate-cw'});
    await settle(900);
    [pic] = await picture();
    const [pw, ph] = [start[2] - start[0], start[3] - start[1]];
    const [cx, cy] = [(start[0] + start[2]) / 2, (start[1] + start[3]) / 2];
    for (const [got, want] of pic.rect.map((v, i) => [v, [cx - ph / 2, cy - pw / 2, cx + ph / 2, cy + pw / 2][i]])) assert.ok(Math.abs(got - want) < 0.01, `a quarter turn clockwise about the centre: ${pic.rect}`);
    await settle(1200);
    await app.capture('image-turned');
    await app.rpc('ui.activate', {doc, control: 'edit.image.rotate-ccw'});
    await app.rpc('ui.activate', {doc, control: 'edit.image.flip-h'});
    await exec('edit.image_change', {change: 'crop', percent: 10});
    await settle(1500);
    await app.capture('image-flipped-cropped');
    await exec('edit.image_replace', {base64: REPLACEMENT_PNG, name: 'red.png'});
    await settle(1500);
    [pic] = await picture();
    assert.match(pic.name, /^PCImg/);
    assert.equal(pic.width, 1);
    await app.capture('image-replaced');
    // A drag on the picture moves it.
    const here = pic.rect.slice();
    await exec('surface.pointer', {page: 1, action: 'drag', x: (here[0] + here[2]) / 2, y: (here[1] + here[3]) / 2, to: {x: (here[0] + here[2]) / 2 - 60, y: (here[1] + here[3]) / 2 + 120}});
    await settle(1200);
    [pic] = await picture();
    assert.ok(Math.abs(pic.rect[0] - (here[0] - 60)) < 1.5 && Math.abs(pic.rect[1] - (here[1] + 120)) < 1.5, `moved by (-60, 120): ${here} -> ${pic.rect}`);
    await app.capture('image-moved');

    // 8. A paragraph of several styles keeps each run's style when its words change (the styled path).
    list = await blocks();
    const mixed = list.find(b => flat(b).startsWith('Mixed styles'));
    const styledEdit = await exec('edit.text_replace', {page: 1, key: mixed.key, text: 'Mixed words: bold red and plain words here.'});
    assert.equal(styledEdit.styled, true);
    assert.equal(styledEdit.flattened, false);
    assert.equal(styledEdit.via, 'worker');
    await settle(1500);
    await app.capture('styled');

    // 9. The handle on a paragraph's right edge rewraps it to the width it is dragged to; the words stay.
    list = await blocks();
    const body = list[1];
    const [ex, ey] = [body.rect[2], (body.rect[1] + body.rect[3]) / 2];
    await exec('surface.pointer', {page: 1, action: 'drag', x: ex, y: ey, to: {x: ex - 90, y: ey}});
    await settle(1300);
    list = await blocks();
    assert.ok(list[1].rows > body.rows, `narrower: more rows (${body.rows} -> ${list[1].rows})`);
    assert.equal(flat(list[1]), flat(body), 'the same words');
    assert.ok(list[1].rect[2] - list[1].rect[0] <= body.rect[2] - body.rect[0] - 80, 'the box is narrower');
    await app.capture('rewrapped');

    // 10. Add text: with the tool picked, a drag draws a box and typing fills it; a click puts a 200 point box there.
    await exec('edit.text', {});
    await settle(700);
    await exec('surface.pointer', {page: 1, action: 'drag', x: 100, y: 380, to: {x: 300, y: 420}});
    await settle(700);
    await app.rpc('ui.type', {doc, text: 'Added by the Add text tool, wrapping inside the box that was drawn'});
    await settle(500);
    await app.capture('added-typing');
    await exec('surface.pointer', {page: 1, action: 'click', x: 100, y: 470});
    await settle(900);
    await app.rpc('ui.type', {doc, text: 'Clicked box'});
    await settle(300);
    await exec('edit.text', {});
    await settle(1200);
    let added = (await exec('edit.added', {page: 1})).items;
    assert.equal(added.length, 2);
    assert.equal(added[0].text, 'Added by the Add text tool, wrapping inside the box that was drawn');
    assert.ok(Math.abs(added[0].rect[0] - 100) < 1 && Math.abs(added[0].rect[2] - 300) < 1, `the drawn box: ${added[0].rect}`);
    assert.equal(added[1].text, 'Clicked box');
    assert.ok(Math.abs(added[1].rect[2] - added[1].rect[0] - 200) < 1, 'a click: 200 points wide');
    assert.equal((await blocks()).length, 5, 'added text is not a page paragraph');
    await app.capture('added-text');

    // 11. Add image: the picture lands where it is put and is an item of its own.
    await exec('edit.image', {page: 1, base64: REPLACEMENT_PNG, name: 'red.png', rect: [350, 380, 450, 440]});
    await settle(1500);
    added = (await exec('edit.added', {page: 1})).items;
    assert.equal(added.length, 3);
    assert.equal(added[2].kind, 'image');
    await app.capture('added-image');

    // 12. The Link tool shows the page's links, a click selects one (Delete would remove it), a drag draws a rectangle and Link Properties asks for its
    // address inside the dialog (an empty address is refused there, not in a toast over the page).
    await exec('edit.link', {page: 1, rect: [100, 500, 260, 528], uri: 'https://example.com/report', visible: true});
    await exec('edit.link', {});
    await settle(900);
    await click(180, 514);
    await settle(500);
    await app.capture('link-tool');
    await exec('surface.pointer', {page: 1, action: 'drag', x: 300, y: 500, to: {x: 420, y: 528}});
    await settle(900);
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.link-properties');
    await app.capture('link-dialog');
    await assert.rejects(app.rpc('ui.dialog.submit', {doc}), /web address/i);
    await app.rpc('ui.dialog.set', {doc, values: {url: 'https://example.com/second'}});
    await app.rpc('ui.dialog.submit', {doc});
    await settle(900);
    assert.deepEqual((await exec('edit.links', {page: 1})).links.map(l => l.uri), ['https://example.com/report', 'https://example.com/second']);
    await app.capture('link-drag');
    await exec('edit.link', {});
    await settle(500);

    // 13. Attach a file: a document-level attachment under its name.
    const attached = await exec('edit.attach', {base64: 'aGVsbG8gd29ybGQ=', name: 'notes.txt', description: 'Notes'});
    assert.equal(attached.name, 'notes.txt');
    assert.deepEqual((await exec('edit.attachments', {})).attachments.map(a => [a.name, a.size, a.type]), [['notes.txt', 11, 'text/plain']]);

    // 14. Put the tool down: the boxes go.
    await exec('edit.edit_text', {open: false});
    await settle(500);
    await app.capture('closed');
  } catch (e) { e.message += log(); throw e; } finally { await app.close(); }
});
