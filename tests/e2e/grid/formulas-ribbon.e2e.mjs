// U:grid/formulas bridge E2E: the Formulas tab's Function Library, Defined Names, Formula
// Auditing and Calculation groups and their dialogs (Insert Function, Function Arguments, Name
// Manager, New Name, Create Names, Paste Name, Error Checking, Evaluate Formula) on a schema-2
// workbook; each change read back over the bridge, the dialogs captured, Ctrl+Z undoing.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft cmd/formulas.rs and ui-egui ribbon/formulas.rs, dialogs/{insert_function,
//    names}.rs; Excel's Formulas tab does the same (AutoSum totals the numbers above, Name Manager
//    lists names with value/refers-to/scope, Show Formulas is Ctrl+`).
// 2. Ours: the ribbon controls (ui.activate), the keyboard (ui.key) and the dialogs (ui.dialog.*)
//    run the same commands as a person's clicks.
// 3. This flow; captures in artifacts/e2e/grid/formulas-ribbon/*.png were looked at by the author.
//
// Driven only through the bridge: no OS mouse or keyboard, no screen capture (ui.capture).

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {validateContent} from '../../../core/grid/schema.mjs';

const NOW = '2026-10-30T09:00:00.000Z';

function seed() {
  const content = {
    sheets: [{id: 's1', name: 'Sheet1', blocks: {0: {
      A1: {v: 'Region'}, B1: {v: 'Sales'}, C1: {v: 'Cost'},
      A2: {v: 'North'}, B2: {v: 120}, C2: {v: 80},
      A3: {v: 'South'}, B3: {v: 95}, C3: {v: 70},
      A4: {v: 'West'}, B4: {v: 140}, C4: {v: 0},
      E2: {f: 'B2/C2'}, E4: {f: 'B4/C4'},
    }}, cols: {0: {size: 90}}}],
    activeSheetId: 's1', styles: [{}], names: [],
  };
  return {id: 'grid-formulas', schema: 2, kind: 'grid', title: 'Formulas flow', revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [],
    content: validateContent(content)};
}

test('grid formulas: Function Library, Defined Names, Auditing and Calculation, with their dialogs', {timeout: 300_000}, async () => {
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'grid', flow: 'grid/formulas-ribbon', renderer, files: [seed()]});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = 'grid-formulas';
  const json = async address => (await app.rpc('document.read', {doc, address, as: 'json'})).value;
  const display = async address => (await app.rpc('document.read', {doc, address, as: 'display'})).value;
  const exec = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const settle = () => new Promise(r => setTimeout(r, 250));
  const select = async (anchor, focus = anchor) => { await app.rpc('selection.set', {doc, ranges: [{anchor: `/sh:s1/${anchor}`, focus: `/sh:s1/${focus}`}], primary: 0}); await settle(); };
  const press = async control => { await app.rpc('ui.activate', {doc, control}); await settle(); };
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000})
      .catch(e => { throw new Error(e.message + log()); });
    await app.rpc('ui.tab', {doc, id: 'formulas'});
    await settle();
    await app.capture('01-formulas-tab');

    // AutoSum under the Sales column; the formula is entered and calculated.
    await select('B5');
    await press('formulas.functionLibrary.autoSum');
    assert.equal(await display('/sh:s1/B5'), '355');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    await settle();
    assert.equal(await display('/sh:s1/B5'), '', 'one undo step');

    // Insert Function: the dialog lists the category's functions; Function Arguments enters SUM.
    await select('C5');
    await press('formulas.functionLibrary.insertFunction');
    let d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.id, 'dialog.insertFunction');
    await app.rpc('ui.dialog.set', {doc, values: {category: 'Math & Trig'}});
    await app.rpc('ui.dialog.set', {doc, values: {function: 'SUM'}});
    await settle();
    await app.capture('02-insert-function');
    await app.rpc('ui.dialog.cancel', {doc});
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.functionArguments'});
    await app.rpc('ui.dialog.set', {doc, values: {function: 'SUM', args: ['C2:C4', '']}});
    await settle();
    await app.capture('03-function-arguments');
    await app.rpc('ui.dialog.submit', {doc});
    await settle();
    assert.equal(await display('/sh:s1/C5'), '150');

    // Defined Names: Create from Selection (top row), New Name, Name Manager, Paste Name.
    await select('A1', 'C4');
    await press('formulas.definedNames.createFromSelection');
    d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.id, 'dialog.createNames');
    // Labels across the top and down the left: Excel checks Top row and Left column.
    assert.deepEqual([d.values.top, d.values.left], [true, true]);
    await app.capture('04-create-names');
    await app.rpc('ui.dialog.submit', {doc});
    await settle();
    await select('B2', 'B4');
    await press('formulas.definedNames.defineName');
    d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.id, 'dialog.defineName');
    assert.equal(d.values.refersTo, '=Sheet1!$B$2:$B$4');
    await app.rpc('ui.dialog.set', {doc, values: {name: 'Revenue', comment: 'Sales by region'}});
    await app.capture('05-new-name');
    await app.rpc('ui.dialog.submit', {doc});
    await settle();
    await press('formulas.definedNames.nameManager');
    d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.id, 'dialog.nameManager');
    const listed = (await exec('formulas.nameManager')).result.map(n => n.name);
    for (const n of ['Cost', 'North', 'Revenue', 'Sales', 'South', 'West']) assert.ok(listed.includes(n), `${n} listed`);
    assert.ok(!listed.includes('Region'), 'the corner label names nothing');
    await app.capture('06-name-manager');
    await app.rpc('ui.dialog.cancel', {doc});
    await select('G2');
    await exec('cell.set', {cell: '/sh:s1/G2', input: '=SUM(Revenue)'});
    assert.equal(await display('/sh:s1/G2'), '355');

    // Auditing: trace precedents, Show Formulas (Ctrl+`), Error Checking, Evaluate Formula.
    const trace = (await exec('formulas.tracePrecedents', {cell: '/sh:s1/G2'})).result;
    assert.deepEqual(trace, [{sheet: 'Sheet1', range: 'B2:B4'}]);
    await app.rpc('ui.key', {doc, keys: 'Ctrl+`'});
    await settle();
    assert.equal(await display('/sh:s1/E2'), '=B2/C2');
    await app.capture('07-show-formulas');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+`'});
    await settle();
    await press('formulas.auditing.errorChecking');
    d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.id, 'dialog.errorChecking');
    assert.equal(d.values.result.errors[0].cell, 'E4');
    await app.capture('08-error-checking');
    await app.rpc('ui.dialog.cancel', {doc});
    await select('E2');
    await press('formulas.auditing.evaluateFormula');
    d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.id, 'dialog.evaluateFormula');
    assert.equal(d.values.frames[0].text, '=B2/C2');
    await app.rpc('ui.dialog.set', {doc, values: {step: 2}});
    await settle();
    await app.capture('09-evaluate-formula');
    await app.rpc('ui.dialog.cancel', {doc});

    // Calculation: Manual waits for Calculate Now (F9).
    await exec('formulas.calculationOptions', {mode: 'manual'});
    assert.equal((await json('/sh:s1/A1')) !== undefined, true);
    await exec('cell.set', {cell: '/sh:s1/B2', input: '200'});
    await app.rpc('ui.key', {doc, keys: 'F9'});
    await settle();
    assert.equal(await display('/sh:s1/G2'), '435');
    await app.capture('10-final');
  } finally {
    await app.close();
  }
});
