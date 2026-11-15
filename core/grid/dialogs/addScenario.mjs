// Add Scenario / Edit Scenario dialog model (submit: data.scenarioAdd).
// Excel's Add Scenario (Scenario name, Changing cells, Comment) with its Scenario Values step, over
// gridcraft's cmd/whatif/scenarios.rs (`scenario_add`: name, changing, values, comment, replace) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: name, changing (the box), comment, vals (one text per changing cell, in the order the cells
// are listed), edit (an existing scenario's name: OK replaces it).

import {defineDialog} from '../../kernel/dialog.mjs';
import {selectionText} from '../lib/data-dialog.mjs';

const numeric = t => (typeof t === 'string' && t.trim() !== '' && Number.isFinite(Number(t)) ? Number(t) : t);

export default defineDialog({
  id: 'dialog.addScenario',
  title: 'Add Scenario',
  command: 'data.scenarioAdd',
  init: ctx => ({name: '', changing: selectionText(ctx), comment: '', vals: null, edit: ''}),
  validate(v) {
    const out = [];
    if (!String(v.name ?? '').trim()) out.push({field: 'name', message: 'Enter a name for the scenario.'});
    if (!String(v.changing ?? '').trim()) out.push({field: 'changing', message: 'Enter the changing cells.'});
    return out;
  },
  toCommand(v) {
    const p = {name: String(v.name).trim(), changing: String(v.changing).trim(), comment: String(v.comment ?? '')};
    if (Array.isArray(v.vals)) p.values = v.vals.map(numeric);
    if (v.edit) p.replace = true;
    return {command: 'data.scenarioAdd', params: p};
  },
});
