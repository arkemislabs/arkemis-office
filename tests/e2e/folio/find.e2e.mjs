// Find, end to end in the window (docs/behaviour-fidelity.md):
//   the find bar (the query, "c of n", the matches marked on the page, the current one standing out), Next and
//   Previous scrolling to the match, Advanced search in the side panel with every match and its context, a click on a
//   result going to it, Close.
//
// Behaviour fidelity:
// 1. printcraft 0.16.0: crates/ui-egui/src/canvas/find.rs (find_bar, find_step, rerun_find), panels/search_ui.rs.
//    Acrobat's Find and Advanced Search work the same way.
// 2. Here the window runs the new shell (devRenderer); the commands run as engine.execute (the bar and the panel run the
//    same ones); what the bar and the panel show is read from the page. No OS input.
// 3. Evidence: artifacts/e2e/folio/find/*.png (ui.capture -> capturePage).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {textPdf, schema1Content} from '../../../core/folio/fixtures.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

test('folio find: the bar, the matches on the page, next and previous, the Search panel, a click on a result', {timeout: 300_000}, async () => {
  const file = createFile('folio', 'Find PDF');
  file.id = 'folio-find';
  file.content = await schema1Content(await textPdf({pages: 4}), 'find.pdf');
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'folio', flow: 'folio/find', files: [file], renderer});
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

    // 1. Open the bar: it is drawn at the top right of the document.
    await exec('edit.find', {});
    await settle(600);
    await app.capture('bar-open');
    // 2. A query: the matches are marked on the page, "1 of 4" shows, and the view is on the first match.
    await exec('edit.find', {query: 'quick brown'});
    await settle(1500);
    await app.capture('matches');
    // 3. Next goes to the next page's match and scrolls there.
    await exec('find.step', {forward: true});
    await settle(1200);
    assert.equal((await surface()).current, 1, 'the second match is on page 2');
    await app.capture('next-match');
    await exec('find.step', {forward: false});
    await exec('find.step', {forward: false});
    await settle(900);
    assert.equal((await surface()).current, 3, 'previous from the first wraps round to the last');

    // 4. Advanced search: the Search panel lists every match with its context.
    await exec('edit.find', {query: 'lazy dog'});
    await exec('edit.advanced_search', {});
    await settle(1500);
    await app.capture('search-panel');
    await exec('find.goto', {match: 2});
    await settle(1000);
    assert.equal((await surface()).current, 1, 'a click on the second result goes to page 2');
    await exec('edit.advanced_search', {open: false});
    await settle(700);
    await app.capture('bar-again');
    await exec('find.close', {});
    await settle(500);
    await app.capture('closed');
  } catch (e) { e.message += log(); throw e; } finally { await app.close(); }
});
