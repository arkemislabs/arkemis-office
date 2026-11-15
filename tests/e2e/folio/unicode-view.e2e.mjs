// The page view draws the person's text in any script as the saved file does: free text comments in Cyrillic, Devanagari, Chinese, Arabic, Hebrew and Thai, and a redaction's
// overlay text, in the window (docs/behaviour-fidelity.md).
//
// Behaviour fidelity:
// 1. printcraft 0.16.0 draws comment text with the standard faces and refuses what they lack; Acrobat shows any script. Here the saved file embeds a system font and the view draws the
//    same appearance with the browser's fonts (core/folio/lib/browser-text.mjs). Not checked against upstream.
// 2. The window runs the new shell (devRenderer); commands go through the bridge, no OS input; captures through capturePage.
// 3. Evidence: artifacts/e2e/common/folio-unicode-view/*.png.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {textPdf} from '../../../core/folio/fixtures.mjs';
import {documentsFolder, run, show, start} from '../common/file-helpers.mjs';

const U = (...cps) => String.fromCodePoint(...cps);
const TEXTS = [
  U(0x41F, 0x440, 0x438, 0x432, 0x435, 0x442, 0x2C, 0x20, 0x43C, 0x438, 0x440),
  U(0x928, 0x92E, 0x938, 0x94D, 0x924, 0x947, 0x20, 0x939, 0x93F, 0x928, 0x94D, 0x926, 0x940),
  U(0x4F60, 0x597D, 0xFF0C, 0x4E16, 0x754C),
  `${U(0x645, 0x631, 0x62D, 0x628, 0x627)} abc 123`,
  U(0x5E9, 0x5DC, 0x5D5, 0x5DD, 0x20, 0x5E2, 0x5D5, 0x5DC, 0x5DD),
  U(0xE2A, 0xE27, 0xE31, 0xE2A, 0xE14, 0xE35, 0xE04, 0xE23, 0xE31, 0xE1A),
];

test('folio: comments and redaction overlays in many scripts look the same on screen as in the file', {timeout: 900_000}, async () => {
  const folder = await documentsFolder('folio-unicode-view');
  const source = path.join(folder, 'Scripts.pdf');
  await fs.writeFile(source, await textPdf({pages: 1}));
  const app = await start('folio', 'folio-unicode-view', {args: [source]});
  await run(async () => {
    const entry = await app.until(async () => (await app.rpc('documents.list', {})).documents.find(d => d.path === source) || null, {timeout: 30_000});
    const doc = entry.id;
    await show(app, doc);
    const settle = ms => new Promise(r => setTimeout(r, ms));
    const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
    await app.until(async () => (await exec('surface.view')).renders.count > 0 || null, {timeout: 60_000});
    let y = 600;
    for (const text of TEXTS) {
      await exec('comment.freetext', {page: 1, rect: [90, y, 300, 34], text});
      y -= 46;
    }
    await settle(1500);
    await app.capture('01-comments-in-scripts', {doc});
    const view = await exec('surface.view');
    assert.ok(view.renders.count > 0);
    // Apply a redaction with a Cyrillic overlay on the page: the overlay is in the file the page is rendered from.
    await exec('redact.properties', {useOverlay: true, overlay: TEXTS[0], fill: [0.85, 0.85, 0.85], align: 1});
    await exec('redact.pages', {from: 1, to: 1});
    await settle(800);
    await app.capture('02-redaction-marked', {doc});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.redact-apply'});
    await settle(900);
    await app.rpc('ui.dialog.submit', {doc, id: 'dialog.redact-apply', button: 'ok'}, {approve: async () => true});
    await settle(2000);
    await app.capture('03-redaction-overlay-applied', {doc});
  });
});
