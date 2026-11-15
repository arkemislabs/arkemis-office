// U:grid/tables-solver: Data > Analysis > Solver (data.solver, data.solverReport, data.solverKeep) and the models
// of its dialogs (Solver Parameters, Add Constraint, Solver Options, Solver Results).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/solver.rs and cmd/solver/{problem,model,lp,nlp,evolutionary,
//    reports}.rs; their tests (cmd/solver/tests.rs) are ported below (the report sheets say "Arkemis" where the
//    upstream title carries its own name). Excel: Solver Parameters, Add Constraint, Options and Solver Results.
// 2. Ours: the same engine over the translated workbook model, one undo step per command.
// 3. These tests; the dialogs are driven in tests/e2e/grid/solver.e2e.mjs.
//
// Not ported: the row auto-fit test (solver_reports_keep_row_autofit): row heights are not recalculated by commands here.

import test from 'node:test';
import assert from 'node:assert/strict';
import {session, workbook, v, run, fails} from './edit-helpers.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {savedModel} from '../../core/grid/lib/solver-model.mjs';
import solverDialog, {solverValues} from '../../core/grid/dialogs/solver.mjs';
import {splitLine, absoluteText, limitsAvailable} from '../../core/grid/lib/solver-dialog.mjs';
import addConstraint from '../../core/grid/dialogs/addConstraint.mjs';
import solverOptions from '../../core/grid/dialogs/solverOptions.mjs';
import solverResults from '../../core/grid/dialogs/solverResults.mjs';

const blank = () => session(workbook());
const set = async (t, cells) => { for (const [c, input] of cells) await run(t, 'cell.set', {cell: c, input}); };
const n = (t, a) => v(t, a);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const savedNames = t => t.content.names.filter(x => /^solver_/.test(x.name) && x.scope === t.content.sheets[0].id).map(x => x.name);
/** The text or number at `a1` on the sheet named `name`. */
const at = (t, name, a1) => v(t, a1, t.content.sheets.findIndex(s => s.name === name));
/** The 0-based row of the first cell holding `text` on sheet `name` (as the upstream test counts). */
function rowOf(t, name, text) {
  const si = t.content.sheets.findIndex(s => s.name === name);
  for (let r = 0; r < 60; r++) for (const c of 'ABCDEFGH') if (v(t, `${c}${r + 1}`, si) === text) return r;
  throw new Error(`${text} not on ${name}`);
}
const ctxOf = t => t.session.readContext(t.docId);

test('simplex solves the Wyndor Glass LP, saves its model as hidden names, survives xlsx and solves again', async () => {
  // Hillier and Lieberman's Wyndor Glass problem: max 3x + 5y, x <= 4, 2y <= 12, 3x + 2y <= 18 -> x = 2, y = 6, Z = 36.
  const t = await blank();
  await set(t, [['A1', '0'], ['A2', '0'], ['B1', '=3*A1+5*A2'], ['B2', '=2*A2'], ['B3', '=3*A1+2*A2']]);
  const r = await run(t, 'data.solver', {objective: 'B1', goal: 'max', variables: 'A1:A2', constraints: ['A1 <= 4', 'B2 <= 12', {lhs: 'B3', op: '<=', rhs: 18}], method: 'simplex'});
  assert.equal(r.status, 'optimal', JSON.stringify(r));
  assert.ok(near(n(t, 'A1'), 2) && near(n(t, 'A2'), 6));
  assert.ok(near(n(t, 'B1'), 36));
  const names = savedNames(t);
  assert.ok(names.includes('solver_opt') && names.includes('solver_lhs3'));
  // The model survives XLSX and solves again from the names.
  const read = await readXlsx(await writeXlsx(t.content));
  const u = await session(read);
  await set(u, [['A1', '0'], ['A2', '0']]);
  const m = await run(u, 'data.solver', {});
  assert.equal(m.model.objective, 'B1');
  assert.equal(m.model.method, 'simplex');
  assert.equal(savedModel(read, 0).constraints.length, 3);
  const again = await run(u, 'data.solver', {saved: true});
  assert.equal(again.status, 'optimal');
  assert.ok(near(n(u, 'B1'), 36));
  // Minimise with keep: false leaves the cells alone.
  await set(u, [['A1', '1'], ['A2', '1']]);
  const lo = await run(u, 'data.solver', {saved: true, goal: 'min', keep: false});
  assert.equal(lo.objective, 0);
  assert.deepEqual([n(u, 'A1'), n(u, 'A2')], [1, 1]);
  // The solve is one undo step.
  const w = await blank();
  await set(w, [['A1', '1'], ['B1', '=2*A1']]);
  await run(w, 'data.solver', {objective: 'B1', variables: 'A1', constraints: ['A1 <= 4'], method: 'simplex'});
  assert.equal(n(w, 'A1'), 4);
  await w.exec('edit.undo', {});
  assert.equal(n(w, 'A1'), 1);
  assert.equal(savedNames(w).length, 0, 'the saved model goes with the solve');
});

test('integer and binary constraints use branch and bound', async () => {
  // max 5x + 4y, 6x + 4y <= 24, x + 2y <= 6: the LP optimum (3, 1.5) = 21; integers give (4, 0) = 20.
  const t = await blank();
  await set(t, [['B1', '=5*A1+4*A2'], ['B2', '=6*A1+4*A2'], ['B3', '=A1+2*A2']]);
  const base = {objective: 'B1', variables: 'A1:A2', constraints: ['B2 <= 24', 'B3 <= 6'], method: 'simplex'};
  const r = await run(t, 'data.solver', base);
  assert.ok(near(r.objective, 21));
  const r2 = await run(t, 'data.solver', {...base, constraints: [...base.constraints, 'A1:A2 int']});
  assert.equal(r2.status, 'optimal');
  assert.deepEqual([n(t, 'A1'), n(t, 'A2'), n(t, 'B1')], [4, 0, 20]);
  // 0/1 knapsack: values 10, 13, 7, weights 5, 6, 4, capacity 10 -> items 2 and 3 (20).
  await set(t, [['D1', '=10*C1+13*C2+7*C3'], ['D2', '=5*C1+6*C2+4*C3']]);
  const k = await run(t, 'data.solver', {objective: 'D1', variables: 'C1:C3', constraints: ['D2 <= 10', 'C1:C3 bin'], method: 'simplex'});
  assert.equal(k.status, 'optimal');
  assert.deepEqual([n(t, 'C1'), n(t, 'C2'), n(t, 'C3'), n(t, 'D1')], [0, 1, 1, 20]);
});

test('GRG finds smooth optima', async () => {
  // The largest rectangle with perimeter at most 20: a 5 x 5 square, area 25.
  const t = await blank();
  await set(t, [['A1', '1'], ['A2', '1'], ['B1', '=A1*A2'], ['B2', '=2*A1+2*A2']]);
  const r = await run(t, 'data.solver', {objective: 'B1', variables: 'A1:A2', constraints: ['B2 <= 20']});
  assert.equal(r.status, 'converged', JSON.stringify(r));
  assert.ok(near(n(t, 'A1'), 5, 1e-3) && near(n(t, 'A2'), 5, 1e-3), JSON.stringify(r));
  // The minimum of (x - 3)^2 + (y + 1)^2 at (3, -1) once negatives are allowed.
  await set(t, [['C1', '0'], ['C2', '0'], ['D1', '=(C1-3)^2+(C2+1)^2']]);
  await run(t, 'data.solver', {objective: 'D1', goal: 'min', variables: 'C1:C2', nonNegative: false});
  assert.ok(near(n(t, 'C1'), 3, 1e-4) && near(n(t, 'C2'), -1, 1e-4));
  // Value Of: x^3 = 8 -> x = 2.
  await set(t, [['E1', '1'], ['F1', '=E1^3']]);
  await run(t, 'data.solver', {objective: 'F1', goal: 'value', value: 8, variables: 'E1'});
  assert.ok(near(n(t, 'E1'), 2, 1e-4));
});

test('evolutionary finds the global minimum of non-smooth and multimodal models', async () => {
  const t = await blank();
  // |x - 3| + |y + 2| has a kink at its minimum (3, -2).
  await set(t, [['A1', '0'], ['A2', '0'], ['B1', '=ABS(A1-3)+ABS(A2+2)']]);
  const p = {objective: 'B1', goal: 'min', variables: 'A1:A2', constraints: ['A1:A2 >= -10', 'A1:A2 <= 10'], method: 'evolutionary'};
  const r = await run(t, 'data.solver', p);
  assert.ok(r.status === 'converged' || r.status === 'cannotImprove', JSON.stringify(r));
  assert.ok(near(n(t, 'A1'), 3, 1e-6) && near(n(t, 'A2'), -2, 1e-6), JSON.stringify(r));
  // The same seed repeats the run exactly.
  await set(t, [['A1', '0'], ['A2', '0']]);
  const again = await run(t, 'data.solver', p);
  assert.deepEqual(again.values, r.values);
  assert.equal(again.evaluations, r.evaluations);
  // Rastrigin's function on [-5.12, 5.12]^2 has its global minimum 0 at the origin among many local minima; GRG from (3.3, -2.7)
  // stops at a local one.
  await set(t, [['C1', '3.3'], ['C2', '-2.7'], ['D1', '=20+C1^2-10*COS(2*PI()*C1)+C2^2-10*COS(2*PI()*C2)']]);
  const base = {objective: 'D1', goal: 'min', variables: 'C1:C2', constraints: ['C1:C2 >= -5.12', 'C1:C2 <= 5.12']};
  await run(t, 'data.solver', base);
  assert.ok(n(t, 'D1') > 0.5, `GRG is local: ${n(t, 'D1')}`);
  await set(t, [['C1', '3.3'], ['C2', '-2.7']]);
  const e = await run(t, 'data.solver', {...base, method: 'evolutionary'});
  assert.ok(n(t, 'D1') < 1e-8 && Math.abs(n(t, 'C1')) < 1e-5 && Math.abs(n(t, 'C2')) < 1e-5, JSON.stringify(e));
  // A stepped model: ROUND makes it flat almost everywhere; the minimum is at 7.2.
  await set(t, [['E1', '0'], ['F1', '=ABS(ROUND(E1,0)-7)+ABS(E1-7.2)/100']]);
  await run(t, 'data.solver', {objective: 'F1', goal: 'min', variables: 'E1', constraints: ['E1 <= 20'], method: 'evolutionary'});
  assert.ok(near(n(t, 'E1'), 7.2, 1e-6), String(n(t, 'E1')));
});

test('evolutionary handles integers, bounds and the saved model', async () => {
  const t = await blank();
  // The 0/1 knapsack of the branch-and-bound test: items 2 and 3, value 20.
  await set(t, [['D1', '=10*C1+13*C2+7*C3'], ['D2', '=5*C1+6*C2+4*C3']]);
  const p = {objective: 'D1', variables: 'C1:C3', constraints: ['D2 <= 10', 'C1:C3 bin'], method: 'evolutionary', populationSize: 30, randomSeed: 7};
  const r = await run(t, 'data.solver', p);
  assert.ok(r.status === 'converged' || r.status === 'cannotImprove', JSON.stringify(r));
  assert.deepEqual([n(t, 'C1'), n(t, 'C2'), n(t, 'C3'), n(t, 'D1')], [0, 1, 1, 20]);
  // The method and its options are saved, survive XLSX and solve again.
  const read = await readXlsx(await writeXlsx(t.content));
  const u = await session(read);
  const m = await run(u, 'data.solver', {});
  assert.equal(m.model.method, 'evolutionary');
  assert.deepEqual([m.model.populationSize, m.model.randomSeed], [30, 7]);
  await set(u, [['C1', '0'], ['C2', '0'], ['C3', '0']]);
  await run(u, 'data.solver', {saved: true});
  assert.equal(n(u, 'D1'), 20);
  // Integer constraints: max x + y with x + 2y <= 7 on integers in [0, 10] -> (7, 0).
  await set(t, [['A1', '0'], ['A2', '0'], ['B1', '=A1+A2'], ['B2', '=A1+2*A2']]);
  const ints = await run(t, 'data.solver', {objective: 'B1', variables: 'A1:A2', constraints: ['B2 <= 7', 'A1:A2 <= 10', 'A1:A2 int'], method: 'evolutionary'});
  assert.deepEqual([n(t, 'A1'), n(t, 'A2')], [7, 0], JSON.stringify(ints));
  // Every variable needs bounds unless requireBounds is off; then it searches around the start.
  await set(t, [['E1', '1'], ['F1', '=ABS(E1-4)']]);
  const q = {objective: 'F1', goal: 'min', variables: 'E1', method: 'evolutionary'};
  await fails(t, 'data.solver', q);
  await run(t, 'data.solver', {...q, requireBounds: false});
  assert.ok(near(n(t, 'E1'), 4, 1e-6));
  // Infeasible constraints and a tiny budget are reported without changing the cells.
  await set(t, [['E1', '1']]);
  const inf = await run(t, 'data.solver', {objective: 'F1', variables: 'E1', constraints: ['E1 <= 3', 'F1 >= 10'], method: 'evolutionary'});
  assert.equal(inf.status, 'infeasible', JSON.stringify(inf));
  const lim = await run(t, 'data.solver', {objective: 'F1', variables: 'E1', constraints: ['E1 <= 3'], method: 'evolutionary', maxEvaluations: 3});
  assert.equal(lim.status, 'iterationLimit', JSON.stringify(lim));
  assert.equal(n(t, 'E1'), 1);
});

/** Wyndor Glass with labels: doors and windows across, the three plants' hours down. */
async function wyndor() {
  const t = await blank();
  await run(t, 'range.setValues', {range: 'A1', values: [[null, 'Doors', 'Windows', 'Used', 'Available'], ['Batches', 0, 0, null, null], ['Plant 1', 1, 0, null, 4], ['Plant 2', 0, 2, null, 12], ['Plant 3', 3, 2, null, 18], ['Profit', 3, 5, null, null]]});
  for (let r = 3; r <= 6; r++) await set(t, [[`D${r}`, `=SUMPRODUCT(B${r}:C${r},$B$2:$C$2)`]]);
  return t;
}

test('the Answer and Limits reports describe the Wyndor Glass solution', async () => {
  const t = await wyndor();
  const solved = await run(t, 'data.solver', {objective: 'D6', variables: 'B2:C2', constraints: ['D3:D5 <= E3:E5'], method: 'simplex', reports: ['answer', 'limits']});
  assert.equal(solved.status, 'optimal', JSON.stringify(solved));
  assert.deepEqual(solved.reports, ['Answer Report 1', 'Limits Report 1']);
  assert.deepEqual(solved.original, {B2: 0, C2: 0});
  assert.deepEqual(t.content.sheets.map(x => x.name), ['Answer Report 1', 'Limits Report 1', 'Sheet1']);
  assert.equal(t.content.sheets.find(x => x.id === t.content.activeSheetId).name, 'Sheet1', "the model's sheet stays active");
  const model = t.content.sheets[2];
  assert.ok(t.content.names.some(x => x.name === 'solver_opt' && x.scope === model.id), 'the saved model follows its sheet');
  const a = 'Answer Report 1';
  assert.equal(at(t, a, 'A1'), 'Arkemis Answer Report');
  // Objective: $D$6 "Profit Used", from 0 to 36.
  let r = rowOf(t, a, '$D$6');
  assert.equal(at(t, a, `C${r + 1}`), 'Profit Used');
  assert.deepEqual([at(t, a, `D${r + 1}`), at(t, a, `E${r + 1}`)], [0, 36]);
  // Variables: doors 0 -> 2, windows 0 -> 6, continuous.
  r = rowOf(t, a, '$B$2') + 1;
  assert.equal(at(t, a, `C${r}`), 'Batches Doors');
  assert.equal(at(t, a, `E${r}`), 2);
  assert.equal(at(t, a, `F${r}`), 'Contin');
  assert.equal(at(t, a, `E${r + 1}`), 6);
  // Constraints: plant 1 has 2 hours to spare; plants 2 and 3 are binding.
  r = rowOf(t, a, '$D$3') + 1;
  assert.equal(at(t, a, `E${r}`), '$D$3<=$E$3');
  assert.deepEqual([at(t, a, `F${r}`), at(t, a, `G${r}`)], ['Not Binding', 2]);
  for (let k = 1; k <= 2; k++) assert.deepEqual([at(t, a, `F${r + k}`), at(t, a, `G${r + k}`)], ['Binding', 0]);
  // Limits with the other variable held: doors 0..2 (profit 30..36), windows 0..6 (6..36).
  const l = 'Limits Report 1';
  r = rowOf(t, l, '$B$2') + 1;
  const row = k => ['D', 'E', 'F', 'G', 'H'].map(c => at(t, l, `${c}${k}`));
  assert.deepEqual(row(r), [2, 0, 30, 2, 36]);
  assert.deepEqual(row(r + 1), [6, 0, 6, 6, 36]);
  // data.solverReport writes reports from the saved model and a given solution.
  const out = await run(t, 'data.solverReport', {reports: ['answer'], values: {B2: 2, C2: 6}, original: {B2: 1, C2: 1}});
  assert.deepEqual(out.sheets, ['Answer Report 2']);
  r = rowOf(t, 'Answer Report 2', '$D$6') + 1;
  assert.equal(at(t, 'Answer Report 2', `D${r}`), 8);
  // Undo removes the reports and keeps the solution; refused requests write nothing.
  await t.exec('edit.undo', {});
  assert.equal(t.content.sheets.length, 3);
  for (const p of [
    {}, {reports: []}, {reports: 'answer'}, {reports: ['population']}, {reports: ['answer'], values: {Z9: 1}}, {reports: ['answer'], values: {B2: 'x'}},
    {reports: ['limits'], constraints: ['D3:D5 <= E3:E5', 'B2:C2 int']}, {reports: ['limits'], method: 'evolutionary', constraints: ['D3:D5 <= E3:E5', 'B2:C2 <= 10']},
  ]) await fails(t, 'data.solverReport', p);
  assert.equal(t.content.sheets.length, 3);
  // With the solve, its reports and the saved model undone (one step), the result still describes the solution.
  await t.exec('edit.undo', {});
  assert.deepEqual([t.content.sheets.length, n(t, 'B2')], [1, 0]);
  const p = {...solved, reports: ['answer']};
  assert.deepEqual((await run(t, 'data.solverReport', p)).sheets, ['Answer Report 1']);
  r = rowOf(t, 'Answer Report 1', '$B$2') + 1;
  assert.equal(at(t, 'Answer Report 1', `E${r}`), 2);
});

test('a refused report request preserves the document and its history', async () => {
  for (const [protectedBook, method, constraints, reports, error] of [
    [true, 'simplex', ['A1 <= 4'], ['answer'], /workbook is protected/],
    [false, 'simplex', ['A1 <= 4', 'A1 int'], ['answer', 'limits'], /integer or binary/],
    [false, 'evolutionary', ['A1 <= 4'], ['answer', 'limits'], /Simplex LP and GRG/],
  ]) {
    for (const [keep, save] of [[true, true], [false, true], [true, false], [false, false]]) {
      const t = await blank();
      await set(t, [['A1', '1'], ['B1', '=2*A1']]);
      await run(t, 'data.solver', {objective: 'B1', variables: 'A1', constraints: ['A1 <= 2'], method: 'simplex', keep: false});
      await set(t, [['C1', 'redo']]);
      await t.exec('edit.undo', {});
      if (protectedBook) await run(t, 'review.protectWorkbook', {});
      const before = {content: t.content, version: t.version, undo: t.doc.undo?.length};
      const e = await fails(t, 'data.solver', {objective: 'B1', variables: 'A1', constraints, method, reports, keep, saveModel: save});
      assert.match(e.message, error, `${method}: keep=${keep} save=${save}`);
      assert.equal(t.content, before.content, 'nothing changed');
      assert.equal(t.version, before.version);
      assert.equal(t.doc.undo?.length, before.undo);
    }
  }
});

test('reports, the solution and the saved model share one undo step', async () => {
  for (const [keep, save] of [[true, true], [false, true], [true, false], [false, false]]) {
    const t = await blank();
    await set(t, [['A1', '1'], ['B1', '=2*A1']]);
    const before = t.content;
    const out = await run(t, 'data.solver', {objective: 'B1', variables: 'A1', constraints: ['A1 <= 4'], method: 'simplex', reports: ['answer'], keep, saveModel: save});
    assert.equal(out.status, 'optimal');
    assert.deepEqual(out.reports, ['Answer Report 1']);
    assert.equal(out.model.objective, 'Sheet1!B1');
    const sheet = t.content.sheets.find(x => x.name === 'Sheet1');
    assert.equal(v(t, 'A1', t.content.sheets.indexOf(sheet)), keep ? 4 : 1);
    assert.equal(t.content.names.some(x => x.name === 'solver_opt'), save);
    assert.equal(t.content.sheets.find(x => x.id === t.content.activeSheetId).name, 'Sheet1');
    const r = rowOf(t, 'Answer Report 1', '$A$1') + 1;
    assert.equal(at(t, 'Answer Report 1', `E${r}`), 4);
    await t.exec('edit.undo', {});
    assert.deepEqual(t.content.sheets.map(x => x.name), ['Sheet1']);
    assert.equal(n(t, 'A1'), 1);
    assert.equal(t.content.names.length, before.names.length);
    await t.exec('edit.redo', {});
    assert.equal(t.content.sheets.length, 2);
    assert.equal(v(t, 'A1', t.content.sheets.findIndex(x => x.name === 'Sheet1')), keep ? 4 : 1);
  }
});

test('report insertion keeps the variable edit guards', async () => {
  const p = {objective: 'B1', variables: 'A2', constraints: ['A2 <= 4'], method: 'simplex', reports: ['answer']};
  // A protected sheet refuses the variable cell's edit.
  const t = await blank();
  await set(t, [['A2', '1'], ['B1', '=2*A2']]);
  await run(t, 'review.protectSheet', {});
  const before = t.content;
  const e = await fails(t, 'data.solver', p);
  assert.match(e.message, /protected sheet/);
  assert.equal(t.content, before);
  // A cell inside an array formula refuses it too.
  const u = await blank();
  await set(u, [['A2', '1'], ['B1', '=2*A2']]);
  await run(u, 'selection.set', {range: 'A1:A2'});
  await run(u, 'cell.set', {input: '=1', array: true});
  const was = u.content;
  const err = await fails(u, 'data.solver', p);
  assert.match(err.message, /part of an array/);
  assert.equal(u.content, was);
});

test('the Limits report of a nonlinear model', async () => {
  // The largest rectangle with perimeter at most 20 (5 x 5): with the height held at 5, the width ranges over 0..5, the area over 0..25.
  const t = await blank();
  await set(t, [['A1', '1'], ['A2', '1'], ['B1', '=A1*A2'], ['B2', '=2*A1+2*A2']]);
  const r = await run(t, 'data.solver', {objective: 'B1', variables: 'A1:A2', constraints: ['B2 <= 20'], reports: ['limits']});
  assert.deepEqual(r.reports, ['Limits Report 1'], JSON.stringify(r));
  const l = 'Limits Report 1';
  const row = rowOf(t, l, '$A$1') + 1;
  const got = ['E', 'F', 'G', 'H'].map(c => at(t, l, `${c}${row}`));
  [0, 0, 5, 25].forEach((want, i) => assert.ok(Math.abs(got[i] - want) < 1e-3, JSON.stringify(got)));
});

test('infeasible, unbounded and nonlinear models are reported', async () => {
  const t = await blank();
  await set(t, [['A1', '1'], ['B1', '=2*A1']]);
  for (const method of ['simplex', 'grg']) {
    const r = await run(t, 'data.solver', {objective: 'B1', variables: 'A1', constraints: ['A1 >= 5', 'B1 <= 6'], method});
    assert.equal(r.status, 'infeasible', `${method}: ${JSON.stringify(r)}`);
    assert.equal(r.changed, false);
    assert.equal(n(t, 'A1'), 1, 'an infeasible model leaves the cells alone');
  }
  assert.equal((await run(t, 'data.solver', {objective: 'B1', variables: 'A1', method: 'simplex'})).status, 'unbounded');
  const g = await run(t, 'data.solver', {objective: 'B1', variables: 'A1', method: 'grg', maxEvaluations: 5000});
  assert.ok(g.status === 'unbounded' || g.status === 'iterationLimit', JSON.stringify(g));
  await set(t, [['A1', '1'], ['C1', '=A1^2']]);
  assert.equal((await run(t, 'data.solver', {objective: 'C1', goal: 'min', variables: 'A1', method: 'simplex'})).status, 'notLinear');
});

test('hostile models are refused without breaking', async () => {
  const t = await blank();
  const r = await run(t, 'data.solver', {});
  assert.equal(r.model, null);
  assert.equal(t.doc.view?.dialogRequest?.id, 'dialog.solver', 'no objective: the dialog opens');
  await set(t, [['B1', '=SUM(A1:A1000)'], ['C1', '5']]);
  const many = Array.from({length: 1001}, () => 'A1 <= 1');
  for (const p of [
    {objective: 'B1', variables: 'A1:A1000'}, {objective: 'B1', variables: 'A1:XFD1048576'}, {objective: 'C1', variables: 'A1'}, {objective: 'B1:B2', variables: 'A1'},
    {objective: 'B1', variables: 'B1'}, {objective: 'B1', variables: 'A1', goal: 'sideways'}, {objective: 'B1', variables: 'A1', goal: 'value'},
    {objective: 'B1', variables: 'A1', method: 'evolutionary'}, {objective: 'B1', variables: 'A1', method: 'annealing'}, {objective: 'B1', variables: 'A1', constraints: ['A1 ?? 3']},
    {objective: 'B1', variables: 'A1', constraints: 'A1 <= 3'}, {objective: 'B1', variables: 'A1', constraints: ['A1:A3 <= C1:C2']}, {objective: 'B1', variables: 'A1', constraints: ['C1 int']},
    {objective: 'B1', variables: 'A1', constraints: ['A1:A1048576 <= 1']}, {objective: 'B1', variables: 'A1', constraints: many}, {objective: 'Nope!B1', variables: 'A1'},
  ]) await fails(t, 'data.solver', p);
  // Huge evaluation requests are capped, and a model erroring everywhere doesn't break.
  await set(t, [['D1', '=1/0+A1']]);
  const e = await run(t, 'data.solver', {objective: 'D1', variables: 'A1', maxEvaluations: 1e300});
  assert.notEqual(e.status, 'converged');
});

test('Solver Parameters: opens on the saved model, builds data.solver, keeps its constraints as text', async () => {
  const t = await wyndor();
  await run(t, 'selection.set', {cell: 'D6'});
  const fresh = solverDialog.init(ctxOf(t));
  assert.equal(fresh.objective, '$D$6', 'the active cell is the objective');
  assert.deepEqual([fresh.goal, fresh.method, fresh.nonNegative, fresh.constraints], ['max', 'grg', true, []]);
  await run(t, 'data.solver', {objective: 'D6', variables: 'B2:C2', constraints: ['D3:D5 <= E3:E5'], method: 'simplex'});
  const v1 = solverDialog.init(ctxOf(t));
  assert.deepEqual([v1.objective, v1.variables, v1.method, v1.constraints], ['$D$6', '$B$2:$C$2', 'simplex', ['$D$3:$D$5 <= $E$3:$E$5']]);
  const cmd = solverDialog.toCommand({...v1, goal: 'value', value: '30'});
  assert.equal(cmd.command, 'data.solver');
  assert.deepEqual([cmd.params.goal, cmd.params.value, cmd.params.method, cmd.params.review, cmd.params.keep], ['value', 30, 'simplex', true, false]);
  assert.deepEqual(cmd.params.constraints, ['$D$3:$D$5 <= $E$3:$E$5']);
  // Validation names the field and says what Excel says.
  assert.deepEqual(solverDialog.validate({...v1, objective: ''}).map(p => p.field), ['objective']);
  assert.deepEqual(solverDialog.validate({...v1, variables: ' '}).map(p => p.field), ['variables']);
  assert.deepEqual(solverDialog.validate({...v1, goal: 'value', value: 'abc'}).map(p => p.field), ['value']);
  assert.deepEqual(solverDialog.validate(v1), []);
  // The saved Evolutionary options come back.
  await run(t, 'data.solver', {objective: 'D6', variables: 'B2:C2', constraints: ['B2:C2 <= 10'], method: 'evolutionary', populationSize: 40, mutationRate: 0.2, randomSeed: 3});
  const ev = solverDialog.init(ctxOf(t));
  assert.deepEqual([ev.method, ev.options.populationSize, ev.options.mutationRate, ev.options.randomSeed], ['evolutionary', 40, 0.2, 3]);
  const out = solverDialog.toCommand(ev);
  assert.deepEqual([out.params.populationSize, out.params.mutationRate, out.params.randomSeed], [40, 0.2, 3]);
  assert.deepEqual(solverDialog.derive({...v1, method: 'simplex'}, ['method']).methodHelp.length > 0, true);
});

test('Add Constraint: validates the cell, the relation and the value; hands the constraint to Solver Parameters', async () => {
  const t = await wyndor();
  const v1 = addConstraint.init(ctxOf(t), null);
  assert.deepEqual([v1.lhs, v1.op, v1.rhs, v1.index], ['', '<=', '', -1]);
  assert.deepEqual(addConstraint.validate({...v1, lhs: '', rhs: '1'}).map(p => p.field), ['lhs']);
  assert.deepEqual(addConstraint.validate({...v1, lhs: 'B2:C2', rhs: ''}).map(p => p.field), ['rhs']);
  assert.deepEqual(addConstraint.validate({...v1, lhs: 'B2:C2', op: 'int'}), [], 'int and bin take no value');
  assert.deepEqual(addConstraint.validate({...v1, lhs: 'B2:C2', op: 'dif'}).map(p => p.field), ['op'], 'alldifferent is not supported by the solving methods');
  const next = addConstraint.derive({...v1, lhs: '$B$2:$C$2', op: '<=', rhs: ' 10 '}, ['rhs']);
  assert.equal(next.value.text, '$B$2:$C$2 <= 10');
  assert.equal(addConstraint.derive({...v1, lhs: 'B2', op: 'bin'}, ['op']).value.text, '$B$2 bin');
  assert.equal(addConstraint.derive({...v1, lhs: 'D3:D5', op: '>=', rhs: '=E3:E5'}, ['rhs']).value.text, '$D$3:$D$5 >= $E$3:$E$5');
  assert.equal(addConstraint.derive({...v1, lhs: '', op: '<=', rhs: '1'}, ['rhs']).value, null, 'nothing to hand over without a cell');
  // The text it makes is a constraint data.solver reads.
  await set(t, [['G1', '=B2+C2']]);
  const r = await run(t, 'data.solver', {objective: 'D6', variables: 'B2:C2', constraints: [next.value.text, 'D3:D5 <= E3:E5'], method: 'simplex'});
  assert.equal(r.status, 'optimal');
});

test('Solver Options: the options the engine honours, saved with the model', async () => {
  const v1 = solverOptions.init(ctxOf(await blank()), {method: 'evolutionary', options: {populationSize: 60, convergence: 0.001}});
  assert.deepEqual([v1.populationSize, v1.convergence, v1.mutationRate, v1.randomSeed, v1.requireBounds], [60, 0.001, 0.075, 0, true]);
  assert.deepEqual(solverOptions.validate({...v1, populationSize: 5}).map(p => p.field), ['populationSize']);
  assert.deepEqual(solverOptions.validate({...v1, mutationRate: 2}).map(p => p.field), ['mutationRate']);
  assert.deepEqual(solverOptions.validate({...v1, maxEvaluations: 0}).map(p => p.field), ['maxEvaluations']);
  assert.deepEqual(solverOptions.validate({...v1, integerOptimality: 120}).map(p => p.field), ['integerOptimality']);
  assert.deepEqual(solverOptions.validate(v1), []);
  const out = solverOptions.derive(v1);
  assert.equal(out.value.populationSize, 60);
  assert.equal(out.value.maxEvaluations, 20000);
});

test('Solver Results: Keep or Restore, reports, back to Solver Parameters', async () => {
  const t = await wyndor();
  const req = await run(t, 'data.solver', {objective: 'D6', variables: 'B2:C2', constraints: ['D3:D5 <= E3:E5'], method: 'simplex', review: true, keep: false});
  assert.equal(req.changed, false);
  assert.deepEqual([n(t, 'B2'), n(t, 'C2')], [0, 0], 'a review leaves the cells to Solver Results');
  const dr = t.doc.view.dialogRequest;
  assert.equal(dr.id, 'dialog.solverResults');
  assert.equal(dr.init.status, 'optimal');
  const init = {...solverResults.init(ctxOf(t), null), ...dr.init};
  assert.deepEqual([init.restore, init.answerReport, init.limitsReport, init.returnToParams], [false, false, false, false]);
  assert.match(init.message, /optimal solution/);
  // OK keeps the solution.
  const keep = solverResults.toCommand(init);
  assert.equal(keep.command, 'data.solverKeep');
  await t.exec(keep.command, keep.params);
  assert.deepEqual([n(t, 'B2'), n(t, 'C2'), n(t, 'D6')], [2, 6, 36]);
  await t.exec('edit.undo', {});
  assert.deepEqual([n(t, 'B2'), n(t, 'C2')], [0, 0]);
  // Restore Original Values with an Answer report writes the report, not the values.
  const withReport = solverResults.toCommand({...init, restore: true, answerReport: true, limitsReport: true});
  assert.deepEqual(withReport.params.reports, ['answer', 'limits']);
  const done = await run(t, withReport.command, withReport.params);
  assert.deepEqual(done.sheets, ['Answer Report 1', 'Limits Report 1']);
  assert.equal(done.kept, false);
  assert.deepEqual([at(t, 'Sheet1', 'B2'), at(t, 'Sheet1', 'C2')], [0, 0]);
  const r = rowOf(t, 'Answer Report 1', '$B$2') + 1;
  assert.equal(at(t, 'Answer Report 1', `E${r}`), 2, 'the report describes the solution that was not kept');
  // Return to Solver Parameters asks for that dialog again; restore with nothing else to do writes nothing.
  const back = solverResults.toCommand({...init, restore: true, returnToParams: true});
  await run(t, back.command, back.params);
  assert.equal(t.doc.view.dialogRequest.id, 'dialog.solver');
  const nothing = solverResults.toCommand({...init, restore: true});
  assert.deepEqual(nothing, {batch: []});
  // No solution (infeasible): Keep and the reports have nothing to do; the dialog says why.
  const bad = await run(t, 'data.solver', {objective: 'D6', variables: 'B2:C2', constraints: ['B2 >= 5', 'D3 <= 4'], method: 'simplex', review: true, keep: false});
  assert.equal(bad.status, 'infeasible');
  const none = {...solverResults.init(ctxOf(t), null), ...t.doc.view.dialogRequest.init};
  assert.deepEqual(none.values, {});
  assert.deepEqual(solverResults.toCommand({...none, answerReport: true}), {batch: []});
});

test('Solver commands are registered', async () => {
  const t = await blank();
  for (const id of ['data.solver', 'data.solverReport', 'data.solverKeep']) assert.ok(t.session.registry.has(id), id);
});

test('Solver Parameters takes the constraint and options the nested dialogs hand back', async () => {
  const t = await wyndor();
  await run(t, 'data.solver', {objective: 'D6', variables: 'B2:C2', constraints: ['D3:D5 <= E3:E5'], method: 'simplex'});
  const v1 = solverDialog.init(ctxOf(t));
  // A new constraint is appended and picked; a changed one replaces its line; the hand-over field is emptied.
  const added = solverDialog.derive({...v1, constraintEdit: {text: '$B$2:$C$2 <= 10', index: -1}}, ['constraintEdit']);
  assert.deepEqual(added.constraints, ['$D$3:$D$5 <= $E$3:$E$5', '$B$2:$C$2 <= 10']);
  assert.deepEqual([added.selected, added.constraintEdit], [1, null]);
  const changed = solverDialog.derive({...v1, constraintEdit: {text: '$B$2 bin', index: 0}}, ['constraintEdit']);
  assert.deepEqual(changed.constraints, ['$B$2 bin']);
  assert.equal(changed.constraintEdit, null);
  const opts = solverDialog.derive({...v1, optionsEdit: {populationSize: 55}}, ['optionsEdit']);
  assert.equal(opts.options.populationSize, 55);
  assert.equal(opts.options.maxEvaluations, 20000, 'the other options stay');
  // The nested Add Constraint dialog's line goes back through splitLine for Change.
  assert.deepEqual(splitLine('$B$2:$C$2 <= 10'), {lhs: '$B$2:$C$2', op: '<=', rhs: '10'});
  assert.deepEqual(splitLine('$B$2 bin'), {lhs: '$B$2', op: 'bin', rhs: ''});
  assert.deepEqual(splitLine('A1 >= B1'), {lhs: 'A1', op: '>=', rhs: 'B1'});
  assert.equal(absoluteText('Sheet1!B2:B4 >= C2 + 1e3'), 'Sheet1!$B$2:$B$4 >= $C$2 + 1e3');
  // Reset All's blank model keeps no saved constraints.
  const blankValues = solverValues(t.content, 0, {row: 5, col: 3}, true);
  assert.deepEqual([blankValues.objective, blankValues.constraints, blankValues.method], ['$D$6', [], 'grg']);
  // The Limits report is offered for the methods and models it works for.
  assert.equal(limitsAvailable({method: 'simplex', constraints: ['A1 <= 2']}), true);
  assert.equal(limitsAvailable({method: 'grg', constraints: ['A1 int']}), false);
  assert.equal(limitsAvailable({method: 'evolutionary', constraints: []}), false);
  // Solve through the dialog's own command: Solver Results opens, the cells wait.
  await set(t, [['B2', '0'], ['C2', '0']]);
  const out = solverDialog.toCommand(solverDialog.init(ctxOf(t)));
  await run(t, out.command, out.params);
  assert.equal(t.doc.view.dialogRequest.id, 'dialog.solverResults');
  assert.deepEqual([n(t, 'B2'), n(t, 'C2')], [0, 0]);
});
