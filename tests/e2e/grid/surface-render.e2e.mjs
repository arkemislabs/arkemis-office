// Grid surface (F:grid): a workbook opens in the new shell with Excel's layout (Name Box and
// formula bar over the canvas grid, sheet tabs and the horizontal scrollbar under it) and paints
// what the model holds: values through number formats, formulas recalculated, a dynamic array
// spilling, fonts, fills, borders, a merged and centred title, wrapped text, text overflowing into
// empty neighbours, frozen panes, custom column widths and row heights, an error value.
//
// Driven only through the bridge (no OS or DOM input; the window is inactive and not focusable):
//   * selection.set moves the selection the canvas paints (and the Name Box shows);
//   * document.read reads cells back in canonical (/sh:<id>/B7) and friendly (Sheet1!B7) forms;
//   * engine.execute runs home.bold, and ui.key Ctrl+I runs home.italic through KeyRouter, on a
//     schema-1 workbook, which opens migrated to schema 2; the canvas then paints them;
//   * the surface's own pointer/keyboard handlers through ui.pointer / ui.type / ui.keys when
//     RendererBridge offers them (design note F-grid--integrator--ui-input); until then the
//     flow records the skip.
// Evidence: artifacts/e2e/grid/surface-render/*.png.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {validateContent} from '../../../core/grid/schema.mjs';
import {createFile} from '../../../core/model.mjs';

const NOW = '2026-10-30T09:00:00.000Z';

function seedWorkbook() {
  const styles = [
    {},
    {font: {bold: true, size: 14, color: '#FFFFFF'}, fill: {pattern: 'solid', fg: '#107C41'}, align: {h: 'center', v: 'center'}},     // 1 title
    {font: {bold: true}, fill: {pattern: 'solid', fg: '#E2EFDA'}, borders: {bottom: {style: 'medium', color: '#107C41'}}},            // 2 header
    {numFmt: '$#,##0.00'},                                                                                                              // 3 currency
    {numFmt: '0.0%'},                                                                                                                   // 4 percent
    {numFmt: 'mmm d, yyyy'},                                                                                                            // 5 date
    {align: {wrap: true, v: 'top'}},                                                                                                    // 6 wrap
    {font: {italic: true, color: '#C00000'}, borders: {top: {style: 'thin'}, bottom: {style: 'double'}}},                               // 7 total
    {numFmt: '$#,##0.00', font: {bold: true}, borders: {top: {style: 'thin'}, bottom: {style: 'double'}}},                             // 8 total money
  ];
  const blocks = {0: {
    A1: {v: 'Quarterly sales', s: 1},
    A2: {v: 'Region', s: 2}, B2: {v: 'Units', s: 2}, C2: {v: 'Price', s: 2}, D2: {v: 'Revenue', s: 2}, E2: {v: 'Share', s: 2}, F2: {v: 'Since', s: 2},
    A3: {v: 'North'}, B3: {v: 120}, C3: {v: 19.99, s: 3}, D3: {f: 'B3*C3', s: 3}, E3: {f: 'D3/$D$7', s: 4}, F3: {v: 45200, s: 5},
    A4: {v: 'South'}, B4: {v: 95}, C4: {v: 21.5, s: 3}, D4: {f: 'B4*C4', s: 3}, E4: {f: 'D4/$D$7', s: 4}, F4: {v: 45310, s: 5},
    A5: {v: 'East'}, B5: {v: 143}, C5: {v: 18.75, s: 3}, D5: {f: 'B5*C5', s: 3}, E5: {f: 'D5/$D$7', s: 4}, F5: {v: 45000, s: 5},
    A6: {v: 'West'}, B6: {v: 77}, C6: {v: 24, s: 3}, D6: {f: 'B6*C6', s: 3}, E6: {f: 'D6/$D$7', s: 4}, F6: {v: 45400, s: 5},
    A7: {v: 'Total', s: 7}, B7: {f: 'SUM(B3:B6)', s: 7}, C7: {f: 'AVERAGE(C3:C6)', s: 8}, D7: {f: 'SUM(D3:D6)', s: 8}, E7: {f: 'SUM(E3:E6)', s: 4},
    A9: {v: 'Notes'}, B9: {v: 'Revenue is units times price; share is each region over the total, recalculated as the inputs change.', s: 6},
    A11: {v: 'This long note overflows into the empty cells to its right, as in Excel.'},
    A13: {v: 'Top regions'}, B13: {f: 'SORTBY(A3:A6,D3:D6,-1)'},
    A18: {v: 'Error'}, B18: {f: '1/0'},
    H2: {v: 'Sequence', s: 2}, H3: {f: 'SEQUENCE(4,1,10,10)'},
  }};
  const content = {
    sheets: [
      {id: 's1', name: 'Sales', blocks, merges: ['A1:F1'], freeze: {rows: 2, cols: 1},
        cols: {0: {size: 96}, 1: {size: 70}, 3: {size: 92}, 5: {size: 96}}, rows: {0: {size: 30, custom: true}, 8: {size: 64, custom: true}}},
      {id: 's2', name: 'Inputs', blocks: {0: {A1: {v: 'Rate'}, B1: {v: 0.07, s: 4}}}},
      {id: 's3', name: 'Archive 2025', blocks: {}, tabColor: '#C55A11'},
    ],
    activeSheetId: 's1', styles, names: [{name: 'Rate', formula: 'Inputs!$B$1'}],
  };
  return validateContent(content);
}

const fileOf = (id, content, title, schema = 2) => ({id, schema, kind: 'grid', title, revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [], content});

async function open(app, doc) {
  await app.rpc('documents.open', {doc, show: true});
  await app.until(async () => {
    const ui = await app.rpc('ui.inspect', {doc});
    return ui.doc?.id === doc && ui.tabs?.length ? ui : null;
  }, {timeout: 60_000});
}

test('grid surface: Excel layout, painting from the model, selection, bridge edits and shortcuts', {timeout: 300_000}, async () => {
  const legacy = createFile('grid', 'Legacy workbook');
  legacy.id = 'grid-legacy';
  legacy.content.sheets[0].id = 'l1';
  legacy.content.activeSheetId = 'l1';
  legacy.content.sheets[0].cells = {A1: {value: 'Revenue'}, B1: {value: '1200'}, A2: {value: 'Costs'}, B2: {value: '=B1*0.4'}};
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'grid', flow: 'grid/surface-render', renderer,
    files: [fileOf('grid-surface', seedWorkbook(), 'Quarterly sales'), legacy]});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const skipped = [];
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });
    const doc = 'grid-surface';
    await open(app, doc).catch(e => { throw new Error(e.message + log()); });
    const read = async (address, as = 'values') => (await app.rpc('document.read', {doc, address, as})).value;
    await new Promise(r => setTimeout(r, 500));
    await app.capture('01-opened');

    // The model's values, read back in both address forms.
    assert.equal(await read('/sh:s1/D7'), 120 * 19.99 + 95 * 21.5 + 143 * 18.75 + 77 * 24);
    assert.equal(await read('Sales!E7'), 1);
    assert.equal(await read('/sh:s1/C3', 'display'), '$19.99');
    assert.deepEqual(await read('/sh:s1/B13:B16'), [['East'], ['North'], ['South'], ['West']]);
    assert.deepEqual(await read('/sh:s1/H3:H6'), [[10], [20], [30], [40]]);
    assert.deepEqual(await read('/sh:s1/B18'), {e: '#DIV/0!'});
    assert.equal(await read('Sales!D3', 'formulas'), '=B3*C3');
    // Reads return both forms (14.3). The kernel echoes the input as given today
    // (design note F-grid--integrator--canonical-echo); the resolver's props carry both.
    const props = await read('Sales!D3', 'props');
    assert.equal(props.address, '/sh:s1/D3');
    assert.equal(props.a1, 'Sales!D3');
    assert.equal(props.numFmt, '$#,##0.00');

    // Selection: a multi-area selection the canvas paints, the active cell in the Name Box.
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:s1/B3', focus: '/sh:s1/C6'}, {anchor: '/sh:s1/E3', focus: '/sh:s1/E6'}], primary: 1});
    await new Promise(r2 => setTimeout(r2, 300));
    await app.capture('02-selection');
    const sel = (await app.rpc('selection.get', {doc})).selection;
    assert.equal(sel.ranges.length, 2);

    // Another sheet through the selection: the tabs follow.
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:s2/B1', focus: '/sh:s2/B1'}]});
    await new Promise(r2 => setTimeout(r2, 300));
    await app.capture('03-inputs-sheet');
    await app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:s1/A1', focus: '/sh:s1/A1'}]});

    // The surface's own input, when the bridge offers it.
    let pointer = true;
    try { await app.rpc('ui.pointer', {doc, action: 'click', cell: 'D4'}); } catch (e) {
      if (e?.code === 'not_found' || /Unknown method/.test(String(e?.message))) { pointer = false; skipped.push('ui.pointer / ui.type / ui.keys: not in RendererBridge yet'); } else throw e;
    }
    if (pointer) {
      const s2 = (await app.rpc('selection.get', {doc})).selection;
      assert.equal(s2.ranges[0].anchor, '/sh:s1/D4');
      await app.rpc('ui.pointer', {doc, action: 'drag', cell: 'B3', to: {cell: 'C5'}});
      const s3 = (await app.rpc('selection.get', {doc})).selection;
      assert.deepEqual(s3.ranges[0], {anchor: '/sh:s1/B3', focus: '/sh:s1/C5'});
      await app.capture('04-pointer-drag');
    }

    // A schema-1 workbook in the same surface (migrated to schema 2 as it opens): home.bold through the bridge, Ctrl+I through KeyRouter.
    const old = 'grid-legacy';
    await open(app, old);
    const readOld = async (address, as = 'json') => (await app.rpc('document.read', {doc: old, address, as})).value;
    assert.equal(await readOld('/sh:l1/B2', 'values'), 480);
    await app.rpc('selection.set', {doc: old, ranges: [{anchor: '/sh:l1/A1', focus: '/sh:l1/B1'}]});
    await app.rpc('engine.execute', {doc: old, command: 'home.bold', params: {}});
    assert.equal((await readOld('/sh:l1/A1', 'props')).bold, true);
    await app.rpc('selection.set', {doc: old, ranges: [{anchor: '/sh:l1/A2', focus: '/sh:l1/B2'}]});
    const key = await app.rpc('ui.key', {doc: old, keys: 'Ctrl+I'});
    assert.equal(key.command, 'home.italic');
    await app.until(async () => (await readOld('/sh:l1/A2', 'props')).italic === true || null, {timeout: 10_000});
    assert.equal((await readOld('/sh:l1/B2', 'props')).italic, true);
    await new Promise(r2 => setTimeout(r2, 300));
    await app.capture('05-legacy-bold-italic');
    if (skipped.length) console.log(`[grid surface] skipped: ${skipped.join('; ')}`);
  } finally {
    await app.close();
  }
});
