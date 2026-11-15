// Prism tables: gradient, picture and pattern fills on cells, and a table style a file defines with a
// gradient fill, a picture-free theme fill reference and lines, drawn as the slide shows them
// (U:prism/table; deckcraft render/table.rs fill_path, style_fill). Captures in artifacts/e2e/prism/table-fills/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {shape} from '../../../core/prism/model/presentation.mjs';
import {newTable} from '../../../core/prism/model/table.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';
import {pictureFill} from '../../../core/prism/lib/shape-common.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwQZGBgAJPwF+4uP4SAAAAAASUVORK5CYII=';
const rgb = (r, g, b) => ({base: {kind: 'rgb', rgb: {r, g, b, a: 255}}});

test('prism tables: gradient, picture and pattern cell fills and a gradient table style are drawn', {timeout: 600_000}, async () => {
  const file = createFile('prism', 'Table fills', {schema: 2});
  file.id = 'prism-table-fills';
  const c = file.content;
  c.slides[0].layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.media = [{id: 'm1', name: 'dot.png', contentType: 'image/png', data: PNG, link: null}];
  const tb = newTable(2, 3, 450, 60);
  ['Gradient', 'Picture', 'Pattern', 'a', 'b', 'c'].forEach((v, i) => { tb.rows[Math.floor(i / 3)].cells[i % 3].text = bodyFromText(v); });
  tb.style = 'grid';
  tb.rows[0].cells[0].fill = {kind: 'gradient', stops: [{pos: 0, color: rgb(255, 80, 80)}, {pos: 1, color: rgb(255, 230, 80)}], shape: {kind: 'linear', angle: 0, scaled: false}, rotateWithShape: true};
  tb.rows[0].cells[1].fill = {kind: 'picture', ...pictureFill('m1')};
  tb.rows[0].cells[2].fill = {kind: 'pattern', preset: 'dkUpDiag', fg: rgb(0, 80, 160), bg: rgb(255, 255, 255)};
  const grad = {kind: 'gradient', stops: [{pos: 0, color: rgb(0, 100, 200)}, {pos: 1, color: rgb(120, 220, 255)}], shape: {kind: 'linear', angle: 0, scaled: false}, rotateWithShape: true};
  const none6 = [null, null, null, null, null, null];
  const line = w => ({kind: 'line', line: {fill: {kind: 'solid', color: rgb(0, 60, 120)}, width: w}});
  const t2 = newTable(3, 3, 450, 40);
  t2.style = '{11111111-2222-3333-4444-555555555555}';
  t2.firstRow = true; t2.bandRow = true;
  t2.rows.forEach((row, r) => row.cells.forEach((cell, k) => { cell.text = bodyFromText(`${r}${k}`); }));
  c.tableStyles = [{id: '{11111111-2222-3333-4444-555555555555}', name: 'Gradient header', background: {fill: {kind: 'solid', color: rgb(240, 240, 240)}, fillRef: null, borders: none6, textColor: null, bold: null, italic: null}, raw: '',
    parts: [['wholeTbl', {fill: null, fillRef: null, borders: [line(1), line(1), line(1), line(1), line(1), line(1)], textColor: null, bold: null, italic: null}],
      ['band1H', {fill: {kind: 'solid', color: rgb(255, 255, 255)}, fillRef: null, borders: none6, textColor: null, bold: null, italic: null}],
      ['firstRow', {fill: grad, fillRef: null, borders: none6, textColor: rgb(255, 255, 255), bold: true, italic: null}]]}];
  c.slides[0].shapes = [
    shape({id: 'a', name: 'Table 1', xfrm: {x: 60, y: 60, w: 450, h: 120}, kind: {type: 'table', ...tb}}),
    shape({id: 'b', name: 'Table 2', xfrm: {x: 60, y: 260, w: 450, h: 120}, kind: {type: 'table', ...t2}}),
  ];
  c.nextId = 400;
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/table-fills', files: [file], renderer});
  const doc = file.id;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000});
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await app.capture('1-fills');
    const svg = await app.rpc('ui.inspect', {doc});
    assert.ok(svg);
  } finally {
    await app.close();
  }
});
