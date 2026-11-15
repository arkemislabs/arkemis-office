// The values of the conditional-format dialogs (New Formatting Rule, the Highlight Cells and Top/Bottom
// rule boxes, the Rules Manager) and the rule they make or come from.
// Translated from gridcraft crates/ui-egui/src/dialogs.rs (`cond_format` fields: type, operator, value,
// value2, text, period, formula, preset) at 146161b4b450a56e5e59a083ba0478582d1e602b, completed to Excel's
// New Formatting Rule dialog (six rule types, scale/bar/icon settings). MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

import {presetDxf, iconCount, defaultIconThresholds, TIME_PERIODS, ICON_SETS, FORMAT_PRESETS, describeRule} from './cond-format.mjs';
import {normalizeOp} from './data-validation.mjs';

export {TIME_PERIODS, ICON_SETS, FORMAT_PRESETS, describeRule};

/** Excel's six rule types, as the New Formatting Rule list shows them. */
export const RULE_TYPES = Object.freeze([
  ['scale', 'Format all cells based on their values'],
  ['cells', 'Format only cells that contain'],
  ['rank', 'Format only top or bottom ranked values'],
  ['average', 'Format only values that are above or below average'],
  ['duplicates', 'Format only unique or duplicate values'],
  ['formula', 'Use a formula to determine which cells to format'],
]);
export const FORMAT_STYLES = Object.freeze([['2color', '2-Color Scale'], ['3color', '3-Color Scale'], ['dataBar', 'Data Bar'], ['iconSet', 'Icon Sets']]);
/** Value types of a scale, bar or icon threshold (Excel's names, the stored cfvo types). */
export const VALUE_TYPES = Object.freeze([['min', 'Lowest Value'], ['num', 'Number'], ['percent', 'Percent'], ['formula', 'Formula'], ['percentile', 'Percentile'], ['max', 'Highest Value']]);
export const ICON_VALUE_TYPES = Object.freeze([['percent', 'Percent'], ['num', 'Number'], ['formula', 'Formula'], ['percentile', 'Percentile']]);
export const CELL_KINDS = Object.freeze([['cellValue', 'Cell Value'], ['text', 'Specific Text'], ['dates', 'Dates Occurring'], ['blanks', 'Blanks'], ['noBlanks', 'No Blanks'],
  ['errors', 'Errors'], ['noErrors', 'No Errors']]);
export const OPERATORS = Object.freeze([['between', 'between'], ['notBetween', 'not between'], ['equal', 'equal to'], ['notEqual', 'not equal to'], ['greaterThan', 'greater than'],
  ['lessThan', 'less than'], ['greaterThanOrEqual', 'greater than or equal to'], ['lessThanOrEqual', 'less than or equal to']]);
export const TEXT_OPS = Object.freeze([['containsText', 'containing'], ['notContainsText', 'not containing'], ['beginsWith', 'beginning with'], ['endsWith', 'ending with']]);
export const AVERAGES = Object.freeze([['above', 'above'], ['below', 'below'], ['aboveEq', 'equal or above'], ['belowEq', 'equal or below'], ['above1', '1 std dev above'],
  ['below1', '1 std dev below'], ['above2', '2 std dev above'], ['below2', '2 std dev below'], ['above3', '3 std dev above'], ['below3', '3 std dev below']]);

const ICON_SET_DEFAULT = '3TrafficLights1';

/** The values of a blank New Formatting Rule. */
export function blankRuleValues() {
  return {
    ruleType: 'scale', formatStyle: '2color',
    minType: 'min', minValue: '', minColor: '#F8696B', midType: 'percentile', midValue: '50', midColor: '#FFEB84', maxType: 'max', maxValue: '', maxColor: '#63BE7B',
    barMinType: 'min', barMinValue: '', barMaxType: 'max', barMaxValue: '', barFill: 'gradient', barColor: '#638EC6', barOnly: false,
    iconSet: ICON_SET_DEFAULT, iconReverse: false, iconOnly: false, iconRules: iconRulesFor(ICON_SET_DEFAULT),
    cellsKind: 'cellValue', operator: 'between', value: '', value2: '', textOp: 'containsText', text: '', period: 'today',
    rankDir: 'top', rank: 10, rankPercent: false, avgDir: 'above', dupKind: 'duplicate', formula: '',
    dxf: null,
  };
}

/** The icon rules of a set: one per icon but the lowest, [{type, value, gte}] from the highest icon down (Excel lists them so). */
export function iconRulesFor(set, thresholds) {
  const k = iconCount(set);
  const stops = thresholds?.length === k ? thresholds : defaultIconThresholds(set);
  return stops.slice(1).map(t => ({type: t.type ?? 'percent', value: String(t.val ?? '0'), gte: t.gte !== false})).reverse();
}

const cfvoToText = c => ({type: c?.type ?? 'min', value: c?.val === undefined ? '' : String(c.val)});

/** A stored rule as the dialog's values (Edit Formatting Rule). */
export function valuesFromRule(rule) {
  const v = blankRuleValues();
  const r = rule ?? {};
  v.dxf = r.dxf ?? null;
  switch (r.type) {
    case 'colorScale': {
      const cs = r.colorScale ?? {cfvo: [], colors: []};
      const three = cs.cfvo.length === 3;
      v.ruleType = 'scale'; v.formatStyle = three ? '3color' : '2color';
      const [a, b, c] = three ? cs.cfvo : [cs.cfvo[0], null, cs.cfvo[1]];
      Object.assign(v, {minType: cfvoToText(a).type, minValue: cfvoToText(a).value, maxType: cfvoToText(c).type, maxValue: cfvoToText(c).value});
      if (three) Object.assign(v, {midType: cfvoToText(b).type, midValue: cfvoToText(b).value});
      v.minColor = cs.colors[0] ?? v.minColor; v.maxColor = cs.colors[three ? 2 : 1] ?? v.maxColor;
      if (three) v.midColor = cs.colors[1] ?? v.midColor;
      break;
    }
    case 'dataBar': {
      const d = r.dataBar ?? {cfvo: []};
      v.ruleType = 'scale'; v.formatStyle = 'dataBar';
      Object.assign(v, {barMinType: cfvoToText(d.cfvo[0]).type, barMinValue: cfvoToText(d.cfvo[0]).value, barMaxType: cfvoToText(d.cfvo[1]).type, barMaxValue: cfvoToText(d.cfvo[1]).value,
        barFill: d.gradient === false ? 'solid' : 'gradient', barColor: d.color ?? v.barColor, barOnly: d.showValue === false});
      break;
    }
    case 'iconSet': {
      const d = r.iconSet ?? {};
      v.ruleType = 'scale'; v.formatStyle = 'iconSet';
      v.iconSet = d.iconSet ?? ICON_SET_DEFAULT; v.iconReverse = d.reverse === true; v.iconOnly = d.showValue === false;
      v.iconRules = iconRulesFor(v.iconSet, d.cfvo);
      break;
    }
    case 'cellIs': v.ruleType = 'cells'; v.cellsKind = 'cellValue'; v.operator = normalizeOp(r.operator); v.value = r.formulas?.[0] ?? ''; v.value2 = r.formulas?.[1] ?? ''; break;
    case 'containsText': case 'notContainsText': case 'beginsWith': case 'endsWith': v.ruleType = 'cells'; v.cellsKind = 'text'; v.textOp = r.type; v.text = r.text ?? ''; break;
    case 'timePeriod': v.ruleType = 'cells'; v.cellsKind = 'dates'; v.period = r.timePeriod ?? 'today'; break;
    case 'containsBlanks': v.ruleType = 'cells'; v.cellsKind = 'blanks'; break;
    case 'notContainsBlanks': v.ruleType = 'cells'; v.cellsKind = 'noBlanks'; break;
    case 'containsErrors': v.ruleType = 'cells'; v.cellsKind = 'errors'; break;
    case 'notContainsErrors': v.ruleType = 'cells'; v.cellsKind = 'noErrors'; break;
    case 'top10': v.ruleType = 'rank'; v.rankDir = r.bottom ? 'bottom' : 'top'; v.rank = r.rank ?? 10; v.rankPercent = r.percent === true; break;
    case 'aboveAverage': {
      v.ruleType = 'average';
      const below = r.aboveAverage === false;
      v.avgDir = r.stdDev ? `${below ? 'below' : 'above'}${r.stdDev}` : `${below ? 'below' : 'above'}${r.equalAverage ? 'Eq' : ''}`;
      break;
    }
    case 'duplicateValues': v.ruleType = 'duplicates'; v.dupKind = 'duplicate'; break;
    case 'uniqueValues': v.ruleType = 'duplicates'; v.dupKind = 'unique'; break;
    case 'expression': v.ruleType = 'formula'; v.formula = r.formulas?.[0] ?? ''; break;
    default: break;
  }
  return v;
}

const needText = (value, what) => (String(value ?? '').trim() ? null : `Enter ${what}.`);

/** What is wrong with the dialog's values, as [{field, message}] (what Excel refuses before it closes). */
export function problems(v) {
  const out = [];
  const add = (field, message) => { if (message) out.push({field, message}); };
  const numeric = (t, val, field, what) => {
    if (t === 'min' || t === 'max') return;
    if (!String(val ?? '').trim()) { add(field, `Enter a value for the ${what}.`); return; }
    if ((t === 'num' || t === 'percent' || t === 'percentile') && !Number.isFinite(Number(String(val).replace(/^=/, '')))) {
      if (!String(val).startsWith('=')) add(field, `The ${what} must be a number.`);
    }
    if (t === 'percent' && Number(val) < 0 || Number(val) > 100 && t === 'percent') add(field, 'A percent must be from 0 to 100.');
  };
  switch (v.ruleType) {
    case 'scale':
      if (v.formatStyle === '2color' || v.formatStyle === '3color') {
        numeric(v.minType, v.minValue, 'minValue', 'minimum');
        if (v.formatStyle === '3color') numeric(v.midType, v.midValue, 'midValue', 'midpoint');
        numeric(v.maxType, v.maxValue, 'maxValue', 'maximum');
      } else if (v.formatStyle === 'dataBar') {
        numeric(v.barMinType, v.barMinValue, 'barMinValue', 'minimum');
        numeric(v.barMaxType, v.barMaxValue, 'barMaxValue', 'maximum');
      } else (v.iconRules ?? []).forEach((r, i) => numeric(r.type, r.value, `iconRules.${i}`, 'icon rule'));
      break;
    case 'cells':
      if (v.cellsKind === 'cellValue') {
        add('value', needText(v.value, 'a value'));
        if (v.operator === 'between' || v.operator === 'notBetween') add('value2', needText(v.value2, 'a second value'));
      } else if (v.cellsKind === 'text') add('text', needText(v.text, 'the text to look for'));
      break;
    case 'rank': {
      const n = Number(v.rank);
      if (!(Number.isInteger(n) && n >= 1 && n <= (v.rankPercent ? 100 : 1000))) add('rank', v.rankPercent ? 'Enter a percent from 1 to 100.' : 'Enter a number of items from 1 to 1000.');
      break;
    }
    case 'formula': add('formula', needText(v.formula, 'a formula')); break;
    default: break;
  }
  return out;
}

/** The rule spec (what `buildRule` takes) the dialog's values make. */
export function specFromValues(v, {presetName} = {}) {
  const style = v.dxf && Object.keys(v.dxf).length ? v.dxf : presetName ? presetDxf(presetName) : (v.dxf ?? {});
  switch (v.ruleType) {
    case 'scale':
      if (v.formatStyle === '2color') return {type: 'colorScale', colors: [v.minColor, v.maxColor], min: textToVo2(v.minType, v.minValue), max: textToVo2(v.maxType, v.maxValue)};
      if (v.formatStyle === '3color') return {type: 'colorScale', colors: [v.minColor, v.midColor, v.maxColor], min: textToVo2(v.minType, v.minValue), mid: textToVo2(v.midType, v.midValue), max: textToVo2(v.maxType, v.maxValue)};
      if (v.formatStyle === 'dataBar') return {type: 'dataBar', color: v.barColor, gradient: v.barFill !== 'solid', showValue: v.barOnly !== true, min: textToVo2(v.barMinType, v.barMinValue), max: textToVo2(v.barMaxType, v.barMaxValue)};
      return {type: 'iconSet', set: v.iconSet, reverse: v.iconReverse === true, showValue: v.iconOnly !== true,
        thresholds: [...(v.iconRules ?? [])].reverse().map(r => ({type: r.type, value: r.value, gte: r.gte !== false}))};
    case 'cells':
      switch (v.cellsKind) {
        case 'cellValue': return {type: 'cellIs', operator: v.operator, value: v.value, value2: v.value2, style};
        case 'text': return {type: v.textOp, text: v.text, style};
        case 'dates': return {type: 'timePeriod', period: v.period, style};
        case 'blanks': return {type: 'blanks', style};
        case 'noBlanks': return {type: 'noBlanks', style};
        case 'errors': return {type: 'errors', style};
        default: return {type: 'noErrors', style};
      }
    case 'rank': return {type: 'top10', rank: Number(v.rank), percent: v.rankPercent === true, bottom: v.rankDir === 'bottom', style};
    case 'average': {
      const m = /^(above|below)(Eq|\d)?$/.exec(v.avgDir ?? 'above');
      return {type: 'aboveAverage', below: m?.[1] === 'below', equal: m?.[2] === 'Eq', stdDev: m?.[2] && m[2] !== 'Eq' ? Number(m[2]) : 0, style};
    }
    case 'duplicates': return {type: v.dupKind === 'unique' ? 'unique' : 'duplicate', style};
    default: return {type: 'expression', formula: v.formula, style};
  }
}
const textToVo2 = (type, value) => (type === 'min' || type === 'max' ? {type} : {type, value});
