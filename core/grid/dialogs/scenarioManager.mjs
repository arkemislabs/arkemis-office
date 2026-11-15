// Scenario Manager dialog model: the scenarios of the active sheet (Show, Delete, Add, Edit, Summary).
// Excel's Scenario Manager over gridcraft's cmd/whatif/scenarios.rs (`scenario_list`, `scenario_show`,
// `scenario_delete`) at 146161b4b450a56e5e59a083ba0478582d1e602b; upstream has no dialog (its menu
// runs the command). MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: scenarios [{name, sheet, changing, values, comment}], selected (index or -1). The buttons
// live in the body (src/apps/grid/dialogs/scenarioManager.tsx): they run the scenario commands and
// open Add Scenario and Scenario Summary.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {loadScenarios} from '../commands/whatif/scenarios.mjs';

/** The scenarios of the active sheet as the dialog lists them. */
export function sheetScenarios(content, si) {
  const name = content.sheets[si]?.name ?? '';
  return loadScenarios(content).filter(sc => sc.sheet.toLowerCase() === name.toLowerCase());
}

export default defineDialog({
  id: 'dialog.scenarioManager',
  title: 'Scenario Manager',
  command: 'data.scenarioManager',
  init(ctx) {
    const scenarios = sheetScenarios(baseDoc(ctx), gridSel(ctx).sheet);
    return {scenarios, selected: scenarios.length ? 0 : -1};
  },
  validate: () => [],
  toCommand: () => ({command: 'data.scenarioManager', params: {}}),
});
