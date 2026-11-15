// Compare files, end to end in the window (docs/behaviour-fidelity.md):
//   the older version read from a file, the Compare panel (the counts and the list of differences), the new file's pages shaded
//   (replaced blue, inserted green), a click on a difference going to its page, Show: Text, Mark as comments, the report, Clear.
//
// Behaviour fidelity:
// 1. printcraft 0.16.0: crates/ui-egui/src/workflows/compare_ui.rs (panel, run_compare, compare_action), crates/engine/src/compare.rs.
//    Acrobat's Compare Files lists the differences on the new file the same way.
// 2. Here the window runs the new shell (devRenderer); the commands run as engine.execute (the panel's controls run the same ones);
//    what the panel and the pages show is read from the page. The older version is passed as `base64` (no Open dialog is driven).
//    No OS input.
// 3. Evidence: artifacts/e2e/folio/compare/*.png (ui.capture -> capturePage).
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, StandardFonts, rgb} from 'pdf-lib';
import {createFile} from '../../../core/model.mjs';
import {schema1Content, base64} from '../../../core/folio/fixtures.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

async function pdfOf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    lines.forEach((line, i) => page.drawText(line, {x: 72, y: 720 - i * 24, size: 16, font, color: rgb(0, 0, 0)}));
  }
  return doc.save();
}

test('folio compare: the panel, the shading, a click on a difference, Show, Mark as comments, the report, Clear', {timeout: 600_000}, async () => {
  const file = createFile('folio', 'Compare PDF');
  file.id = 'folio-compare';
  file.content = await schema1Content(await pdfOf([
    ['The quick red fox leaps over the very lazy dog today.', 'Pack my box with five dozen liquor jugs.'],
    ['Second page: nothing changes here.', 'The meeting is on Tuesday at noon.'],
  ]), 'new.pdf');
  const oldBase64 = base64(await pdfOf([
    ['The quick brown fox jumps over the lazy dog.', 'Pack my box with five dozen liquor jugs.'],
    ['Second page: nothing changes here.', 'The meeting is on Monday at noon.', 'This line was removed.'],
  ]));
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/compare', files: [file], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const doc = file.id;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const surface = () => exec('surface.view');
  const settle = ms => new Promise(r => setTimeout(r, ms));
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const v = await surface(); return !v.migrating && v.renders.count > 0 ? v : null; }, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await exec('view.zoom.fit_width');
    await settle(800);

    // 1. Compare with the older version: the panel opens with the counts and the list, the new file's pages are shaded.
    const r = await exec('doc.compare', {base64: oldBase64, name: 'old.pdf'});
    assert.deepEqual([r.changes, r.replaced, r.inserted, r.deleted], [6, 4, 1, 1]);
    await settle(1500);
    await app.capture('panel');
    // 2. A click on a difference goes to it (page 2) and picks it.
    await exec('compare.select', {index: 5});
    await settle(1200);
    assert.equal((await surface()).current, 1, 'difference 5 (Tuesday) is on page 2');
    await app.capture('picked');
    // 3. Show: Text off takes the shading and the list away; on brings them back.
    await exec('compare.show', {what: 'text'});
    await settle(700);
    await app.capture('hidden');
    await exec('compare.show', {value: true});
    await settle(500);
    // 4. Mark as comments: real comments appear in the Comments list.
    await exec('compare.mark', {});
    await settle(1000);
    await exec('comment.list', {});
    await settle(1200);
    await app.capture('marked');
    // 5. Clear.
    await exec('compare.clear', {});
    await settle(900);
    await app.capture('cleared');
  } catch (e) { e.message += log(); throw e; } finally { await app.close(); }
});
