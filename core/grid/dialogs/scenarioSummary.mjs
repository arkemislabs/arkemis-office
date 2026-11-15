// Scenario Summary dialog model (submit: data.scenarioSummary): the result cells to report.
// Excel's Scenario Summary dialog over gridcraft's cmd/whatif/scenarios.rs (`scenario_summary`:
// resultCells) at 146161b4b450a56e5e59a083ba0478582d1e602b; the PivotTable report type is not offered
// (upstream has no such report). MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.scenarioSummary',
  title: 'Scenario Summary',
  command: 'data.scenarioSummary',
  init: () => ({resultCells: ''}),
  validate: () => [],
  toCommand: v => ({command: 'data.scenarioSummary', params: String(v.resultCells ?? '').trim() ? {resultCells: String(v.resultCells).trim()} : {}}),
});
