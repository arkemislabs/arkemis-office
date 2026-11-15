// Prism dialogs as a person sees them (UI review follow-up): each dialog opened with what it acts on selected and the
// custom body given time to load, then captured. Captures in artifacts/e2e/prism/dialogs-review/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';

const DIALOGS = ['changeChartType', 'chartData', 'replaceFonts', 'reuseSlides', 'font', 'headerFooter', 'hyperlink', 'tabs', 'themeColors', 'bullets', 'autocorrect', 'photoAlbum', 'insertZoom', 'insertZoomSummary', 'insertZoomSection', 'equation', 'setupShow', 'accessibility', 'paragraph', 'columns', 'smartart', 'themeFonts', 'symbol'];

test('prism dialogs: opened and captured with their bodies loaded', {timeout: 600_000}, async () => {
  const file = createFile('prism', 'Dialog review', {schema: 2});
  file.id = 'prism-dialogs-review';
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/dialogs-review', files: [file], renderer});
  const doc = file.id;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const wait = ms => new Promise(r => setTimeout(r, ms));
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000});
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    const only = process.env.DIALOGS ? process.env.DIALOGS.split(',') : DIALOGS;
    await run('insert.chart', {});
    for (const id of only) {
      if (id === 'font' || id === 'tabs' || id === 'bullets') await run('text.edit', {id: (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value.slides[0].shapes[0].id});
      await app.rpc('ui.dialog.open', {doc, id: `dialog.${id}`});
      await wait(2500);
      await app.capture(id);
      if (id === 'headerFooter') { await app.rpc('ui.dialog.set', {tab: 1}).catch(() => {}); await wait(800); await app.capture('headerFooter-notes'); }
      if (id === 'hyperlink') { await app.rpc('ui.dialog.set', {field: 'mode', value: 'slide'}); await wait(800); await app.capture('hyperlink-slide'); }
      for (let i = 0; i < 4; i++) { const ui = await app.rpc('ui.inspect', {doc}); if (!ui.dialog) break; await app.rpc('ui.dialog.cancel', {doc}).catch(() => {}); }
    }
    await app.rpc('ui.tab', {doc, tab: 'transitions'});
    await wait(800);
    await app.capture('transitions-strip');
    await app.rpc('ui.menu', {doc, control: 'transitions.gallery'});
    await wait(1500);
    await app.capture('transitions-gallery');
  } finally {
    await app.close();
  }
});
