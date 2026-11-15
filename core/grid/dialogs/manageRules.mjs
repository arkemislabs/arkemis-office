// Conditional Formatting Rules Manager (Home > Conditional Formatting > Manage Rules...): the rules of the
// current selection, this worksheet or another sheet in the order they apply, with New Rule, Edit Rule,
// Delete Rule, Move Up and Move Down, the cells each applies to and Stop If True.
// Translated from gridcraft crates/engine/src/cmd/insert/cond_format.rs (`manage_cf`: list, delete, moveUp,
// moveDown) and crates/ui-egui/src/dialogs/cond_format_rules.rs at 146161b4b450a56e5e59a083ba0478582d1e602b,
// completed to Excel's manager (Show formatting rules for, Applies to, Stop If True). MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// The dialog holds every sheet's rules (`rules`: {sheetId: [{id, ranges, stopIfTrue, rule, spec?}]}); OK
// sends the sheets whose list changed to home.manageRules. Pure: no DOM.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {rangeA1} from '../lib/addr.mjs';
import {rulesOf} from '../commands/format/conditional.mjs';
import {parseRange} from '../lib/addr.mjs';

const clone = x => JSON.parse(JSON.stringify(x));
const key = list => JSON.stringify(list.map(e => [e.id, e.ranges, e.stopIfTrue === true, e.spec ?? null]));

export default defineDialog({
  id: 'dialog.manageRules',
  title: 'Conditional Formatting Rules Manager',
  command: 'home.manageRules',
  init(ctx) {
    const content = ctx.doc;
    const sel = gridSel(ctx);
    const rules = {};
    content.sheets.forEach((sh, si) => {
      rules[sh.id] = rulesOf(content, si).map(r => {
        const e = (sh.conditionalFormats ?? []).find(x => x.id === r.id);
        return {id: r.id, ranges: r.ranges.join(','), stopIfTrue: r.stopIfTrue, rule: clone(e?.rule ?? {})};
      });
    });
    const v = {
      showFor: 'selection', sheetId: content.sheets[sel.sheet]?.id, sheets: content.sheets.map(s => ({id: s.id, name: s.name})),
      selection: sel.ranges.map(rangeA1).join(','), rules, selected: 0,
    };
    v._base = JSON.stringify(Object.fromEntries(Object.entries(rules).map(([k, l]) => [k, key(l)])));
    return v;
  },
  validate(v) {
    const out = [];
    for (const [id, list] of Object.entries(v.rules ?? {})) {
      list.forEach((e, i) => {
        const parts = String(e.ranges ?? '').split(',').map(x => x.trim()).filter(Boolean);
        if (!parts.length || parts.some(p => !parseRange(p.replace(/\$/g, '')))) out.push({field: 'rules', message: `The cells in rule ${i + 1} (${e.ranges || 'empty'}) are not a valid range.`});
        void id;
      });
    }
    return out;
  },
  toCommand(v) {
    let base = {};
    try { base = JSON.parse(v._base ?? '{}'); } catch { base = {}; }
    const batch = [];
    for (const [id, list] of Object.entries(v.rules ?? {})) {
      if (key(list) === base[id]) continue;
      batch.push({command: 'home.manageRules', params: {sheet: `/sh:${id}`,
        rules: list.map(e => ({id: e.id, ranges: String(e.ranges).split(',').map(x => x.trim()).filter(Boolean), stopIfTrue: e.stopIfTrue === true, ...(e.spec ? {spec: e.spec} : {})}))}});
    }
    return {batch};
  },
});
