// Shared set-up of the Data tab's bridge E2E flows (tests/e2e/grid/data-*.e2e.mjs): a sales list, a
// second sheet, the app launched on it, and the helpers a flow drives it with. Not a flow itself.
// Driven only through the bridge: no OS mouse or keyboard, no screen capture (ui.capture).

import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {validateContent} from '../../../core/grid/schema.mjs';

const NOW = '2026-10-30T09:00:00.000Z';
export const DOC = 'grid-data';

export function seed() {
  const rows = [
    ['Region', 'Rep', 'Qty', 'Amount'],
    ['West', 'Ann', 5, 120], ['East', 'Bo', 9, 340], ['West', 'Cy', 7, 210], ['North', 'Di', 12, 480],
    ['East', 'Eli', 3, 90], ['West', 'Fay', 9, 300], ['North', 'Gus', 4, 150],
  ];
  const blocks = {};
  rows.forEach((r, i) => r.forEach((v, c) => { blocks[`${'ABCD'[c]}${i + 1}`] = {v}; }));
  blocks.F1 = {v: 'Name, Role'}; blocks.F2 = {v: 'Ada, Engineer'}; blocks.F3 = {v: 'Alan, Mathematician'};
  const content = {
    sheets: [{id: 's1', name: 'Sheet1', blocks: {0: blocks}, cols: {0: {size: 90}, 1: {size: 90}, 5: {size: 150}}},
      {id: 's2', name: 'Sheet2', blocks: {0: {A1: {v: 'West'}, B1: {v: 10}, A2: {v: 'East'}, B2: {v: 20}}}}],
    activeSheetId: 's1', styles: [{}], names: [],
  };
  return {id: DOC, schema: 2, kind: 'grid', title: 'Data flow', revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [], content: validateContent(content)};
}

/** Launches Grid on the sales list, opens it on the Data tab and returns the helpers. */
export async function startData(flow, {tab = 'data'} = {}) {
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'grid', flow, renderer, files: [seed()]});
  const doc = DOC;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
  await app.rpc('documents.open', {doc, show: true});
  await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000}).catch(e => { throw new Error(e.message + log()); });
  const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));
  await settle();
  await app.rpc('ui.tab', {doc, id: tab});
  await settle();
  const read = async (address, as = 'values') => (await app.rpc('document.read', {doc, address, as})).value;
  const h = {
    app, doc, log, settle, read,
    select: async (anchor, focus = anchor) => { await app.rpc('selection.set', {doc, ranges: [{anchor: `/sh:s1/${anchor}`, focus: `/sh:s1/${focus}`}], primary: 0}); await settle(); },
    press: async (control, value) => { await app.rpc('ui.activate', {doc, control, ...(value !== undefined ? {value} : {})}); await settle(); },
    pointer: params => app.rpc('ui.pointer', {doc, action: 'click', ...params}),
    undo: async () => { await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'}); await settle(); },
    submit: async () => { await app.rpc('ui.dialog.submit', {doc}); await settle(); },
    exec: (command, params = {}) => app.rpc('engine.execute', {doc, command, params}),
    hidden: async row => ((await read(`/sh:s1/row:${row}`, 'props'))[0] ?? {}).hidden === true,
  };
  h.hiddenRows = async (first, last) => { const out = []; for (let r = first; r <= last; r++) if (await h.hidden(r)) out.push(r); return out; };
  /** Clicks a button of the message box the worksheet shows (a Stop alert, Remove Duplicates' result, Goal Seek's status). */
  h.box = async (click, tries = 30) => {
    for (let i = 0; i < tries; i++) { try { return await h.pointer({target: 'messageBox', click}); } catch { await settle(150); } }
    throw new Error(`no message box with ${click}${log()}`);
  };
  return h;
}

export {assert};
