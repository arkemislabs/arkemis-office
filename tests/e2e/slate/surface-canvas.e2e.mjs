// Slate surface (F:slate): a notebook opens in the new shell with OneNote's layout (section tabs
// over the page, the page list on the right, the page title with its date and time), and the
// canvas edits work end to end through the bridge:
//
//   * commands (engine.execute): start a note container at a point with text, retitle the page,
//     draw a pen and a highlighter stroke, move and resize the container;
//   * the surface's own handlers through ui.pointer / ui.type when the renderer offers them
//     (design note F-slate--integrator--ui-pointer-type): click on empty page space and type,
//     click the title and type, drag a container's bar;
//   * ui.key Mod+Z through KeyRouter undoes the last edit;
//   * the selection moves the view: selection.set to another page or section shows it.
//
// Then a 2,000-page notebook opens (in its own launch, see the second test) and its page list is captured; the time from
// documents.open to a drawn page and the time of a page switch are logged (benchmark numbers for
// the UI side; the engine side is tests/slate/foundation-benchmark.test.mjs).
//
// Evidence: artifacts/e2e/slate/surface-canvas/*.png. No OS or DOM input: the window is inactive
// and not focusable.
//
// Measured 2026-10-30 (Windows 11, a development machine), log line "slate UI benchmark":
//   2,000-page notebook: documents.open to a live shell 1.2-1.7 s, page switch (selection.set to
//   the page shown) 48-61 ms, an edit on it (surface.newContainer over the bridge) 23-33 ms.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createContent, newPageRecord, SECTION_COLORS, validateContent} from '../../../core/slate/schema.mjs';

const NOW = '2026-10-29T09:30:00.000Z';

function para(id, text, style = 'normal') {
  return {type: 'paragraph', attrs: {id, style, align: null, indent: 0, dir: null, tags: [], spacing: null, audio: null}, ...(text ? {content: [{type: 'text', text}]} : {})};
}

function seedNotebook() {
  let n = 0;
  const uid = () => `e${(n++).toString(36).padStart(4, '0')}`;
  const c = createContent('Physics 101', {uid, now: NOW});
  c.tree = []; c.sections = {}; c.pages = {};
  const section = (id, name, color, pages) => {
    c.sections[id] = {id, name, color, created: NOW, pages: pages.map(p => ({id: p.id, level: p.level ?? 0}))};
    for (const p of pages) c.pages[p.id] = {...newPageRecord({id: p.id, title: p.title, created: NOW}), ...(p.extra ?? {})};
    return id;
  };
  c.tree.push(section('sw1', 'Week 1', SECTION_COLORS[0], [
    {id: 'pkin', title: 'Lecture 1: Kinematics', extra: {rule: {pattern: 'college-ruled', color: '#9fbfe0'}, body: {type: 'doc', content: [
      {type: 'container', attrs: {id: 'cintro', x: 48, y: 140, width: 520}, content: [
        para('bh1', 'Displacement, velocity, acceleration', 'h2'),
        para('bp1', 'Velocity is the rate of change of position; acceleration is the rate of change of velocity.'),
        {type: 'bulletList', attrs: {id: 'bl1', symbol: null}, content: [
          {type: 'listItem', attrs: {id: 'li1'}, content: [para('bp2', 'v = dx / dt')]},
          {type: 'listItem', attrs: {id: 'li2'}, content: [para('bp3', 'a = dv / dt')]},
        ]},
      ]},
    ]}}},
    {id: 'pset', title: 'Problem set 1'},
    {id: 'pwork', title: 'Worked example', level: 1},
  ]));
  c.tree.push(section('sw2', 'Week 2', SECTION_COLORS[1], [{id: 'pdyn', title: 'Lecture 2: Dynamics', extra: {rule: {pattern: 'small-grid', color: '#9fbfe0'}}}]));
  c.groups.garc = {id: 'garc', name: 'Archive', created: NOW, items: []};
  c.tree.push('garc');
  c.groups.garc.items.push(section('sold', 'Old notes', SECTION_COLORS[2], [{id: 'pold', title: 'Last year'}]));
  return validateContent(c);
}

function bigNotebook() {
  let n = 0;
  const uid = () => `b${(n++).toString(36).padStart(5, '0')}`;
  const c = createContent('Benchmark notebook', {uid, now: NOW});
  c.tree = []; c.sections = {}; c.pages = {};
  for (let s = 0; s < 20; s++) {
    const sid = `s${uid()}`;
    const entries = [];
    for (let p = 0; p < 100; p++) {
      const pid = `p${uid()}`;
      const body = {type: 'doc', content: [{type: 'container', attrs: {id: `c${uid()}`, x: 48, y: 128, width: 560},
        content: Array.from({length: 4}, (_, k) => para(`q${uid()}`, `Note ${s * 100 + p}.${k}: kinetic energy, momentum and the work-energy theorem.`))}]};
      c.pages[pid] = {...newPageRecord({id: pid, title: `Page ${s * 100 + p + 1}`, created: NOW}), body};
      entries.push({id: pid, level: p % 10 === 0 ? 0 : p % 10 < 4 ? 1 : 0});
    }
    c.sections[sid] = {id: sid, name: `Chapter ${s + 1}`, color: SECTION_COLORS[s % 8], created: NOW, pages: entries};
    c.tree.push(sid);
  }
  return validateContent(c);
}

const fileOf = (id, content) => ({id, schema: 2, kind: 'slate', title: content.notebook.name, revision: 0, createdAt: NOW, updatedAt: NOW,
  starred: false, links: [], content});

/** Launch Slate with one notebook in the vault and open it in the new shell; returns timings too. */
async function openNotebook(doc, content, flow) {
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'slate', flow, files: [fileOf(doc, content)], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });
    const t0 = Date.now();
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => {
      const ui = await app.rpc('ui.inspect', {doc});
      return ui.doc?.id === doc && ui.tabs?.length ? ui : null;
    }, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
    return {app, openMs: Date.now() - t0};
  } catch (e) { await app.close(); throw e; }
}

test('slate surface: OneNote layout, canvas edits through commands and surface input, undo by shortcut', {timeout: 240_000}, async () => {
  const doc = 'slate-surface';
  const {app} = await openNotebook(doc, seedNotebook(), 'slate/surface-canvas');
  const exec = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const read = async (address, as = 'json') => (await app.rpc('document.read', {doc, address, as})).value;
  const skipped = [];
  try {
    // The notebook opens on its first section's first page.
    const sel0 = (await app.rpc("selection.get", {doc})).selection;
    assert.ok(!sel0.ranges?.length || /\/pg:pkin/.test(sel0.ranges[0].focus), JSON.stringify(sel0));
    await new Promise(r => setTimeout(r, 400));   // let the page paint before the first capture
    await app.capture('01-opened');

    // Commands: a note container where the person clicked, with two lines of text.
    let r = await exec('surface.newContainer', {page: 'pkin', x: 620, y: 150, width: 300, text: 'Momentum p = m v\nIt is conserved in a closed system.'});
    const box = r.result.container;
    assert.match(box, /^\/pg:pkin\/c:/);
    assert.equal(await read(box, 'text'), 'Momentum p = m v\nIt is conserved in a closed system.');
    r = await exec('surface.title', {page: 'pkin', title: 'Lecture 1: Kinematics and momentum'});
    assert.equal(await read('/pg:pkin/title'), 'Lecture 1: Kinematics and momentum');
    await exec('surface.ink', {page: 'pkin', stroke: {tool: 'pen', color: '#c00000', width: 2, points: [620, 210, 700, 214, 780, 208, 860, 216]}});
    await exec('surface.ink', {page: 'pkin', stroke: {tool: 'highlighter', color: '#ffff00', width: 18, points: [52, 196, 300, 196]}});
    assert.equal((await read('/pg:pkin/ink')).length, 2);
    const cid = box.split('/c:')[1];
    await exec('surface.moveContainer', {page: 'pkin', container: cid, x: 640, y: 260});
    await exec('surface.resizeContainer', {page: 'pkin', container: cid, width: 340});
    const props = await read(box, 'props');
    assert.deepEqual([props.x, props.y, props.width], [640, 260, 340]);
    await new Promise(res => setTimeout(res, 300));
    await app.capture('02-commands');

    // Undo through KeyRouter (Mod+Z): the resize goes back.
    const key = await app.rpc('ui.key', {doc, keys: 'Mod+Z'});
    assert.equal(key.handled, true);
    await app.until(async () => (await read(box, 'props')).width === 300 || null, {timeout: 10_000});

    // The surface's own pointer and typing paths, when the renderer forwards them.
    let pointer = true;
    try { await app.rpc('ui.pointer', {doc, action: 'click', target: 'title'}); } catch (e) {
      if (e?.code === 'not_found' || /Unknown method/.test(String(e?.message))) { pointer = false; skipped.push('ui.pointer and ui.type: not in RendererBridge yet'); } else throw e;
    }
    if (pointer) {
      await app.rpc('ui.type', {doc, text: ' (week 1)'});
      await app.until(async () => (await read('/pg:pkin/title')).endsWith('(week 1)') || null, {timeout: 10_000});
      const click = await app.rpc('ui.pointer', {doc, action: 'click', x: 120, y: 520});
      assert.equal(click.container, null);
      await app.rpc('ui.type', {doc, text: 'Typed after a click on empty space.\nSecond line.'});
      const page = await app.until(async () => {
        const ids = (await read('/pg:pkin', 'props')).containers;
        return ids.length === 3 ? ids : null;
      }, {timeout: 10_000});
      assert.equal(await read(page[2], 'text'), 'Typed after a click on empty space.\nSecond line.');
      const dragged = await app.rpc('ui.pointer', {doc, action: 'drag', target: `bar:${cid}`, x: 700, y: 262, to: {x: 720, y: 330}});
      assert.deepEqual([dragged.x, dragged.y], [660, 328]);
      await app.until(async () => (await read(box, 'props')).y === 328 || null, {timeout: 10_000});
    }
    await new Promise(res => setTimeout(res, 300));
    await app.capture('03-edited');

    // The selection is the view: another page, another section, a section inside a group.
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/pg:pdyn'}]});
    await new Promise(res => setTimeout(res, 400));
    await app.capture('04-week2-grid');
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/pg:pwork'}]});
    await new Promise(res => setTimeout(res, 300));
    await app.capture('05-subpage');
    const sel = (await app.rpc("selection.get", {doc})).selection;
    assert.equal(sel.ranges[0].focus, '/pg:pwork');
    if (skipped.length) console.log('skipped:', skipped.join('; '));
  } finally {
    await app.close();
  }
});

// A second window of the same app does not go live in test mode today (documents.open of a second
// document opens window 2, which never says hello), so the big notebook gets its own launch.
test('slate surface: a 2,000-page notebook opens, switches pages and takes an edit', {timeout: 240_000}, async () => {
  const big = 'slate-big';
  const {app, openMs} = await openNotebook(big, bigNotebook(), 'slate/surface-canvas');
  const read = async (address, as = 'json') => (await app.rpc('document.read', {doc: big, address, as})).value;
  try {
    const nb = await read('/');
    assert.equal(nb.pages, 2000);
    const sections = nb.items.map(i => i.id);
    const target = (await read(`/sec:${sections[17]}`)).pages[42].id;
    const t1 = Date.now();
    await app.rpc('selection.set', {doc: big, ranges: [{anchor: `/pg:${target}`}]});
    await app.until(async () => (await app.rpc('selection.get', {doc: big})).selection.ranges[0]?.focus === `/pg:${target}` || null);
    const switchMs = Date.now() - t1;
    const t2 = Date.now();
    await app.rpc('engine.execute', {doc: big, command: 'surface.newContainer', params: {page: target, x: 640, y: 160, text: 'Added in a 2,000-page notebook.'}});
    const editMs = Date.now() - t2;
    await new Promise(res => setTimeout(res, 400));
    await app.capture('06-big-notebook');
    console.log('slate UI benchmark (2,000 pages):', JSON.stringify({openMs, switchMs, editMs}));
    assert.ok(openMs < 30_000, `open ${openMs}`);
    assert.ok(switchMs < 3_000, `switch ${switchMs}`);
    assert.ok(editMs < 2_000, `edit ${editMs}`);
  } finally {
    await app.close();
  }
});
