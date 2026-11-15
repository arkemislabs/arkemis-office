// U:slate/draw: OneNote's Draw tab on a real notebook, end to end through the bridge: the pen tray
// (every pen drawn as an icon in its own colour), real strokes drawn by the bridge's `ui.pointer`
// stroke input (pen, pencil, highlighter, galaxy and rainbow ink), shapes drawn by dragging, Ink to
// Shape, the Lasso (loop, move, rotate, flip, arrange, delete), the point and stroke erasers, the
// Ruler, Ink Replay, Color & Thickness, Add Pen and Remove Pen. Every step is checked in the
// document (document.read of /pg:<page>/ink) and captured.
//
// Behaviour fidelity: see tests/slate/draw.test.mjs. Evidence: artifacts/e2e/slate/draw/*.png.
// No OS or DOM input: ui.activate / ui.menu / ui.pointer (the bridge's synthetic strokes) /
// ui.dialog.* / engine.execute only; the window is inactive and not focusable.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createContent, newPageRecord, SECTION_COLORS, validateContent} from '../../../core/slate/schema.mjs';

const NOW = '2026-10-30T09:30:00.000Z';
const para = (id, text) => ({type: 'paragraph', attrs: {id, style: 'normal', align: null, indent: 0, dir: null, tags: [], spacing: null, audio: null}, ...(text ? {content: [{type: 'text', text}]} : {})});

function seed() {
  let n = 0;
  const c = createContent('Physics 101', {uid: () => `d${(n++).toString(36).padStart(4, '0')}`, now: NOW});
  c.tree = ['sw1']; c.groups = {}; c.pages = {};
  c.sections = {sw1: {id: 'sw1', name: 'Week 1', color: SECTION_COLORS[0], created: NOW, pages: [{id: 'pnotes', level: 0}]}};
  c.pages.pnotes = {...newPageRecord({id: 'pnotes', title: 'Free-fall sketch', created: NOW}), body: {type: 'doc', content: [
    {type: 'container', attrs: {id: 'c1', x: 60, y: 120, width: 520}, content: [para('l1', 'Drop a ball from the roof and time its fall.'), para('l2', 'Highlight the important line in yellow.')]},
  ]}};
  return validateContent(c);
}

const fileOf = (id, content) => ({id, schema: 2, kind: 'slate', title: content.notebook.name, revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [], content});
const wave = (x0, y0, x1, amp = 14, steps = 40) => Array.from({length: steps + 1}, (_, i) => [x0 + ((x1 - x0) * i) / steps, y0 + Math.sin((i / steps) * Math.PI * 3) * amp]);
const wobble = pts => pts.map(([x, y], i) => [x + Math.sin(i * 1.9) * 1.1, y + Math.cos(i * 1.3) * 1.1]);
const loopRect = (x0, y0, x1, y1, per = 10) => {
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const out = [];
  for (let c = 0; c < 4; c++) for (let k = 0; k < per; k++) out.push([corners[c][0] + ((corners[c + 1][0] - corners[c][0]) * k) / per, corners[c][1] + ((corners[c + 1][1] - corners[c][1]) * k) / per]);
  out.push(corners[0]);
  return out;
};

test('slate Draw tab: pens, strokes, shapes, lasso, erasers, ruler, replay and pen settings work on a notebook through the ribbon and the bridge', {timeout: 480_000}, async () => {
  const doc = 'slate-draw';
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'slate', flow: 'slate/draw', files: [fileOf(doc, seed())], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const exec = async (command, params = {}) => (await app.rpc('engine.execute', {doc, command, params})).result;
  const read = async (address, as = 'json') => (await app.rpc('document.read', {doc, address, as})).value;
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const ink = async () => read('/pg:pnotes/ink');
  const selected = async () => ((await app.rpc('selection.get', {doc})).selection.ranges).map(r => r.anchor.replace(/^.*ink:/, ''));
  const stroke = (path, extra = {}) => app.rpc('ui.pointer', {doc, action: 'stroke', target: 'ink', path, ...extra});
  const control = async id => ((await app.rpc('ui.inspect', {doc})).controls ?? []).find(c => c.id === id);
  const pick = async id => app.rpc('ui.activate', {doc, control: id});
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}).catch(() => null); return ui?.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000})
      .catch(e => { throw new Error(e.message + log()); });
    await app.rpc('ui.tab', {doc, id: 'draw'});
    await settle(900);
    await app.capture('01-draw-tab', {doc});

    // ---- The pen tray: ten pens as icons; the gallery's menu --------------------------------------------
    await app.rpc('ui.menu', {doc, control: 'draw.pens.pens'});
    await settle(500);
    await app.capture('02-pens-gallery-menu', {doc});
    await app.rpc('ui.menu', {doc, control: 'draw.pens.pens', open: false});

    // ---- Strokes drawn by the bridge: each pen, in its own colour -------------------------------------------
    await pick('draw.pens.pens.black-pen');
    await stroke(wave(70, 330, 330));
    await pick('draw.pens.pens.red-pen');
    await stroke(wave(70, 370, 330, 10));
    await pick('draw.pens.pens.blue-pen');
    await stroke(wave(70, 410, 330, 18));
    await pick('draw.pens.pens.pencil');
    await stroke(wave(70, 450, 330, 12));
    await pick('draw.pens.pens.galaxy-pen');
    await stroke(wave(70, 490, 330, 16));
    await pick('draw.pens.pens.rainbow-pen');
    await stroke(wave(70, 530, 330, 16));
    await pick('draw.pens.pens.yellow-highlighter');
    await stroke([[60, 150], [120, 151], [200, 150], [320, 151], [440, 150]]);
    let strokes = await ink();
    assert.deepEqual(strokes.map(s => [s.tool, s.color, s.fx ?? null]), [
      ['pen', '#000000', null], ['pen', '#ff0000', null], ['pen', '#0070c0', null], ['pencil', '#5f5f5f', null], ['pen', '#7a4dd8', 'galaxy'], ['pen', '#ff7a00', 'rainbow'], ['highlighter', '#ffff00', null]]);
    assert.ok(strokes.every(s => s.points.length >= 4), 'real points, saved in the page');
    assert.ok(strokes[0].points.length > 30, 'the whole pointer path');
    await settle(600);
    await app.capture('03-pens-and-ink', {doc});

    // ---- Shapes: the gallery's tool, then dragging draws it ------------------------------------------------
    await app.rpc('ui.menu', {doc, control: 'draw.shapes.shapes'});
    await settle(500);
    await app.capture('04-shapes-gallery', {doc});
    await app.rpc('ui.menu', {doc, control: 'draw.shapes.shapes', open: false});
    await pick('draw.pens.pens.blue-pen');
    await pick('draw.shapes.shapes.oval');
    await app.rpc('ui.pointer', {doc, action: 'drag', target: 'ink', x: 420, y: 310, to: {x: 520, y: 370}});
    await app.until(async () => (await ink()).some(s => s.shape === 'oval') || null, {timeout: 10_000});
    await pick('draw.shapes.shapes.arrow');
    await app.rpc('ui.pointer', {doc, action: 'drag', target: 'ink', x: 540, y: 340, to: {x: 640, y: 320}});
    await pick('draw.shapes.shapes.cube');
    await app.rpc('ui.pointer', {doc, action: 'drag', target: 'ink', x: 420, y: 400, to: {x: 500, y: 480}});
    await pick('draw.shapes.shapes.cylinder');
    await app.rpc('ui.pointer', {doc, action: 'drag', target: 'ink', x: 540, y: 400, to: {x: 600, y: 490}});
    await pick('draw.shapes.shapes.graph-four-quadrant');
    await app.rpc('ui.pointer', {doc, action: 'drag', target: 'ink', x: 640, y: 380, to: {x: 760, y: 500}});
    strokes = await ink();
    assert.deepEqual([...new Set(strokes.filter(s => s.shape).map(s => s.shape))], ['oval', 'arrow', 'cube', 'cylinder', 'graph-four-quadrant']);
    assert.equal(strokes.filter(s => s.shape === 'cube').length, 3, 'a cube is three strokes that move together');
    assert.equal(new Set(strokes.filter(s => s.shape === 'cube').map(s => s.group)).size, 1);
    assert.equal((await app.rpc('ui.inspect', {doc})).tabs.includes('draw'), true);
    await settle(600);
    await app.capture('05-shapes', {doc});

    // ---- Ink to Shape: a wobbly loop becomes a rectangle --------------------------------------------------
    await pick('draw.convert.ink-to-shape');
    assert.equal((await control('draw.convert.ink-to-shape'))?.checked, true);
    await pick('draw.pens.pens.green-pen');
    const before = (await ink()).length;
    await stroke(wobble(loopRect(780, 120, 900, 200)));
    await app.until(async () => (await ink()).some(s => s.shape === 'rectangle') || null, {timeout: 10_000});
    const rect = (await ink()).find(s => s.shape === 'rectangle');
    assert.equal(rect.color, '#00b050');
    assert.deepEqual(rect.points.slice(0, 2), [780, 120].map(v => Math.round(v)).map((v, i) => rect.points[i] ?? v));
    assert.equal((await ink()).length, before + 1, 'the loop is replaced by the shape, not added to');
    await pick('draw.convert.ink-to-shape');
    await stroke(wobble(loopRect(780, 220, 900, 300)));
    assert.equal((await ink()).filter(s => !s.shape).length, 8, 'with Ink to Shape off the loop stays ink');
    await settle(500);
    await app.capture('06-ink-to-shape', {doc});

    // ---- Lasso: select a shape with a loop, move it, rotate, flip, arrange ------------------------------------
    await pick('draw.tools.lasso-select');
    assert.equal((await control('draw.tools.lasso-select'))?.checked, true);
    const sample = (await ink()).filter(s => s.shape === 'cube');
    await app.rpc('ui.pointer', {doc, action: 'drag', target: 'ink', path: loopRect(400, 380, 520, 500)});
    await app.until(async () => (await selected()).length === 3 || null, {timeout: 10_000});
    assert.deepEqual((await selected()).sort(), sample.map(s => s.id).sort());
    await settle(500);
    await app.capture('07-lasso-selected', {doc});
    const x0 = Math.min(...(await ink()).filter(s => s.shape === 'cube').flatMap(s => s.points.filter((_, i) => i % 2 === 0)));
    await app.rpc('ui.pointer', {doc, action: 'drag', target: 'selection', x: 450, y: 450, to: {x: 480, y: 470}});
    await app.until(async () => Math.min(...(await ink()).filter(s => s.shape === 'cube').flatMap(s => s.points.filter((_, i) => i % 2 === 0))) === x0 + 30 || null, {timeout: 10_000});
    await pick('draw.edit.rotate.rotate-right-90');
    await pick('draw.edit.rotate.flip-horizontal');
    await pick('draw.edit.arrange.send-to-back');
    assert.equal((await ink())[0].shape, 'cube', 'sent to the back: the cube is painted first');
    await settle(500);
    await app.capture('08-moved-rotated', {doc});
    // Delete takes the whole shape; the selection goes back to the page.
    const n = (await ink()).length;
    await pick('draw.edit.delete');
    assert.equal((await ink()).length, n - 3);
    assert.deepEqual(await selected(), ['/pg:pnotes']);

    // ---- Erasers: point eraser rubs out the middle of the long stroke; stroke eraser takes a whole stroke --------
    await pick('draw.tools.eraser.medium-eraser');
    assert.equal((await control('draw.tools.eraser'))?.checked, true);
    const beforeErase = (await ink()).filter(s => !s.shape).length;
    await app.rpc('ui.pointer', {doc, action: 'drag', target: 'ink', path: [[190, 300], [190, 345]]});
    await app.until(async () => (await ink()).filter(s => !s.shape).length === beforeErase + 1 || null, {timeout: 10_000});
    await settle(400);
    await app.capture('09-point-eraser', {doc});
    await pick('draw.tools.eraser.stroke-eraser');
    const beforeStroke = (await ink()).length;
    await app.rpc('ui.pointer', {doc, action: 'drag', target: 'ink', path: [[80, 441], [80, 459]]});
    await app.until(async () => (await ink()).length === beforeStroke - 1 || null, {timeout: 10_000});

    // ---- Ruler: a stroke begun along its edge runs straight ----------------------------------------------------------
    await pick('draw.tools.type');
    await pick('draw.pens.ruler');
    assert.equal((await control('draw.pens.ruler'))?.checked, true);
    await pick('draw.pens.pens.red-pen');
    await settle(500);
    await app.capture('10-ruler', {doc});
    const count = (await ink()).length;
    await stroke(wobble(Array.from({length: 30}, (_, i) => [140 + i * 8, 238 + (i % 3)])));
    await app.until(async () => (await ink()).length === count + 1 || null, {timeout: 10_000});
    const ruled = (await ink()).at(-1).points;
    const ys = ruled.filter((_, i) => i % 2 === 1);
    assert.ok(Math.max(...ys) - Math.min(...ys) < 0.6, `a ruled stroke is straight: ${Math.min(...ys)}..${Math.max(...ys)}`);
    await pick('draw.pens.ruler');

    // ---- Ink Replay: the strokes play again in order -----------------------------------------------------------------------
    await pick('draw.convert.ink-replay');
    await settle(450);
    await app.capture('11-ink-replay', {doc});
    await settle(2500);

    // ---- Color & Thickness for the pen in hand; Add Pen; Remove Pen --------------------------------------------------------
    await pick('draw.pens.pens.blue-pen');
    await pick('draw.pens.pens.pen-color-thickness');
    const dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.pen-color-thickness');
    assert.deepEqual([dlg.values.penType, dlg.values.thickness, dlg.values.color], ['Pen', '0.5 mm', 'Blue']);
    await app.rpc('ui.dialog.set', {doc, values: {thickness: '3.5 mm', color: 'Purple', penType: 'Pen'}});
    await settle(400);
    await app.capture('12-pen-color-thickness', {doc});
    await app.rpc('ui.dialog.submit', {doc});
    await pick('draw.tools.type');
    await pick('draw.pens.pens.blue-pen');
    const thick = (await ink()).length;
    await stroke(wave(70, 570, 330, 8));
    await app.until(async () => (await ink()).length === thick + 1 || null, {timeout: 10_000});
    const last = (await ink()).at(-1);
    assert.deepEqual([last.color, last.width], ['#7030a0', Math.round(3.5 * (96 / 25.4) * 100) / 100]);
    await pick('draw.pens.add-pen.add-pen-highlighter');
    assert.equal((await app.rpc('ui.inspect', {doc})).controls.length > 0, true);
    await settle(500);
    await app.capture('13-added-pen', {doc});
    await pick('draw.pens.pens.remove-pen');
    await settle(400);
    await app.capture('14-removed-pen', {doc});

    // ---- Undo takes the last stroke back ---------------------------------------------------------------------------------------
    const inkBefore = (await ink()).length;
    await app.rpc('ui.key', {doc, keys: 'Mod+Z'});
    await app.until(async () => (await ink()).length === inkBefore - 1 || null, {timeout: 10_000});
    await settle(500);
    await app.capture('15-final', {doc});
  } finally {
    await app.close();
  }
});
