// Test fixtures for Grid (core/kernel/testing.mjs `createTestSession('grid', {fixture})`; F:grid).
// Schema-2 workbooks built from the model's records. No DOM, no Node built-ins.

import {newSheet} from './model/workbook.mjs';

const wb = (sheets, extra = {}) => ({sheets, activeSheetId: sheets[0].id, styles: [{}], names: [], ...extra});

/** One empty sheet `Sheet1` (id s1). */
export const empty = () => wb([newSheet('s1', 'Sheet1')]);

/** Two sheets, s1 `Sheet1` with a small table of numbers and formulas, s2 `Sheet2` empty. */
export function twoSheets() {
  const s1 = newSheet('s1', 'Sheet1');
  s1.blocks = {0: {
    A1: {v: 'Item'}, B1: {v: 'Qty'}, C1: {v: 'Price'}, D1: {v: 'Total'},
    A2: {v: 'Apples'}, B2: {v: 3}, C2: {v: 1.25}, D2: {f: 'B2*C2'},
    A3: {v: 'Pears'}, B3: {v: 5}, C3: {v: 0.8}, D3: {f: 'B3*C3'},
    A4: {v: 'Total'}, D4: {f: 'SUM(D2:D3)'},
  }};
  return wb([s1, newSheet('s2', 'Sheet2')]);
}

export const fixtures = {empty, 'two-sheets': twoSheets};
export default fixtures;
// createTestSession looks fixtures up by name on this module's namespace.
export {twoSheets as 'two-sheets'};
