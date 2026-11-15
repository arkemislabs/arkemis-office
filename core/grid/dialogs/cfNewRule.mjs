// New Formatting Rule (Home > Conditional Formatting > New Rule... and More Rules...; also Edit Formatting
// Rule in the Rules Manager). Excel's six rule types with their rule descriptions; OK adds the rule to the
// selected cells.
// Translated from gridcraft crates/ui-egui/src/dialogs.rs (`cond_format` dialog: type, operator, values,
// formula, preset; submit: home.conditionalFormat) at 146161b4b450a56e5e59a083ba0478582d1e602b, completed to
// Excel's dialog (scale, data bar and icon settings; Format...). MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `init(ctx, {rule})` fills the dialog from a stored rule (Edit). Pure: no DOM.

import {defineDialog} from '../../kernel/dialog.mjs';
import {selectionText} from '../lib/data-dialog.mjs';
import {blankRuleValues, valuesFromRule, problems, specFromValues, iconRulesFor} from '../lib/cond-format-dialog.mjs';

export default defineDialog({
  id: 'dialog.cfNewRule',
  title: 'New Formatting Rule',
  command: 'home.conditionalFormat',
  init(ctx, args) {
    const v = args?.rule ? valuesFromRule(args.rule) : blankRuleValues();
    if (typeof args?.ruleType === 'string' && !args?.rule) v.ruleType = args.ruleType;
    return {...v, range: selectionText(ctx), editing: !!args?.rule, __title: args?.rule ? 'Edit Formatting Rule' : 'New Formatting Rule'};
  },
  derive(v, changed) {
    if (changed.includes('iconSet')) return {iconRules: iconRulesFor(v.iconSet)};
    return {};
  },
  validate: v => problems(v),
  toCommand: v => ({batch: [{command: 'home.conditionalFormat', params: {range: v.range, rule: specFromValues(v)}}]}),
});
