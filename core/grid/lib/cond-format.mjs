// Conditional formatting: building a rule from what the New Formatting Rule dialog and the ribbon
// menus give, and what a rule makes of a cell (a differential format, a colour-scale fill, a data
// bar, an icon).
// Translated from gridcraft crates/engine/src/cf.rs (`CfCache::look`, `RuleStats`, `threshold`,
// `time_period_matches`, `layer_under`, `relative`) and crates/engine/src/cmd/insert/cond_format.rs
// (`preset_style`, `add_cf`, `check_cf_formula`, `check_cf_rule`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Stored rule (the shape the xlsx reader keeps, so a file round-trips):
//   sheet.conditionalFormats[i] = {id, ranges: ['A1:B9'], priority, stopIfTrue?, rule: {type, ...}}
//   rule.type: cellIs (operator between|notBetween|equal|notEqual|greaterThan|lessThan|greaterThanOrEqual|lessThanOrEqual,
//     formulas [a, b?]) | expression (formulas [f]) | containsText | notContainsText | beginsWith | endsWith (text, formulas)
//     | containsBlanks | notContainsBlanks | containsErrors | notContainsErrors | duplicateValues | uniqueValues
//     | top10 (rank, percent?, bottom?) | aboveAverage (aboveAverage?: false is below, equalAverage?, stdDev?) | timePeriod (timePeriod)
//     | colorScale {cfvo: [..], colors: [..]} | dataBar {cfvo: [min, max], color, showValue?, gradient?}
//     | iconSet {iconSet, cfvo: [..], showValue?, reverse?}
//   rule.dxf: the differential format {font?, fill?, borders?, numFmt?} of the rule (not for scales, bars and icons).
//   formulas are written for the top-left cell of the first range.
// No DOM, no Node built-ins.

import {parse, print, shiftRelative} from './formula.mjs';
import {compare, CellError, display, GArray} from './value.mjs';
import {engineFor} from '../model/calc.mjs';
import {forEachCell} from '../model/store.mjs';
import {resolveColor, DEFAULT_THEME} from '../model/style.mjs';
import {parseRange, containsRC, intersects} from './addr.mjs';
import {normalizeOp} from './data-validation.mjs';
import {iconCount} from './cf-icons.mjs';
import {datetimeFromSerial, serialInSystem, serialFromUnixMs, unixNowMs} from './date.mjs';

// ---------------------------------------------------------------------------------------------
// Names

/** The formats the Highlight Cells dialogs offer in their "with" box (cond_format.rs `preset_style`). */
export const FORMAT_PRESETS = Object.freeze([
  ['lightRedFillDarkRedText', 'Light Red Fill with Dark Red Text'],
  ['yellowFillDarkYellowText', 'Yellow Fill with Dark Yellow Text'],
  ['greenFillDarkGreenText', 'Green Fill with Dark Green Text'],
  ['lightRedFill', 'Light Red Fill'],
  ['redText', 'Red Text'],
  ['redBorder', 'Red Border'],
]);

const solid = c => ({pattern: 'solid', fg: c});
/** The differential format of a preset name (an unknown one is the default, light red with dark red text). */
export function presetDxf(name) {
  switch (name) {
    case 'redText': return {font: {color: '#9C0006'}};
    case 'yellowFill': case 'yellowFillDarkYellowText': return {font: {color: '#9C5700'}, fill: solid('#FFEB9C')};
    case 'greenFill': case 'greenFillDarkGreenText': return {font: {color: '#006100'}, fill: solid('#C6EFCE')};
    case 'lightRedFill': return {fill: solid('#FFC7CE')};
    case 'redBorder': {
      const l = {style: 'thin', color: '#C00000'};
      return {borders: {left: l, right: l, top: l, bottom: l}};
    }
    default: return {font: {color: '#9C0006'}, fill: solid('#FFC7CE')};
  }
}

export const TIME_PERIODS = Object.freeze([
  ['yesterday', 'Yesterday'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['last7Days', 'In the last 7 days'], ['lastWeek', 'Last week'],
  ['thisWeek', 'This week'], ['nextWeek', 'Next week'], ['lastMonth', 'Last month'], ['thisMonth', 'This month'], ['nextMonth', 'Next month'],
]);

/** Excel's twenty icon sets, in the order its Icon Sets menu lists them: [name, group, label]. */
export const ICON_SETS = Object.freeze([
  ['3Arrows', 'Directional', '3 Arrows (Colored)'], ['3ArrowsGray', 'Directional', '3 Arrows (Gray)'], ['3Triangles', 'Directional', '3 Triangles'],
  ['4ArrowsGray', 'Directional', '4 Arrows (Gray)'], ['4Arrows', 'Directional', '4 Arrows (Colored)'], ['5ArrowsGray', 'Directional', '5 Arrows (Gray)'],
  ['5Arrows', 'Directional', '5 Arrows (Colored)'],
  ['3TrafficLights1', 'Shapes', '3 Traffic Lights (Unrimmed)'], ['3TrafficLights2', 'Shapes', '3 Traffic Lights (Rimmed)'], ['3Signs', 'Shapes', '3 Signs'],
  ['4TrafficLights', 'Shapes', '4 Traffic Lights'], ['4RedToBlack', 'Shapes', 'Red To Black'],
  ['3Symbols', 'Indicators', '3 Symbols (Circled)'], ['3Symbols2', 'Indicators', '3 Symbols (Uncircled)'], ['3Flags', 'Indicators', '3 Flags'],
  ['3Stars', 'Ratings', '3 Stars'], ['5Boxes', 'Ratings', '5 Boxes'], ['4Rating', 'Ratings', '4 Ratings'], ['5Rating', 'Ratings', '5 Ratings'],
  ['5Quarters', 'Ratings', '5 Quarters'],
]);

/** The scales the Color Scales menu lists (Excel's twelve), [id, label, colours low to high]. */
export const COLOR_SCALES = Object.freeze([
  ['green-yellow-red', 'Green - Yellow - Red Color Scale', ['#63BE7B', '#FFEB84', '#F8696B']],
  ['red-yellow-green', 'Red - Yellow - Green Color Scale', ['#F8696B', '#FFEB84', '#63BE7B']],
  ['green-white-red', 'Green - White - Red Color Scale', ['#63BE7B', '#FCFCFF', '#F8696B']],
  ['red-white-green', 'Red - White - Green Color Scale', ['#F8696B', '#FCFCFF', '#63BE7B']],
  ['blue-white-red', 'Blue - White - Red Color Scale', ['#5A8AC6', '#FCFCFF', '#F8696B']],
  ['red-white-blue', 'Red - White - Blue Color Scale', ['#F8696B', '#FCFCFF', '#5A8AC6']],
  ['white-red', 'White - Red Color Scale', ['#FCFCFF', '#F8696B']],
  ['red-white', 'Red - White Color Scale', ['#F8696B', '#FCFCFF']],
  ['green-white', 'Green - White Color Scale', ['#63BE7B', '#FCFCFF']],
  ['white-green', 'White - Green Color Scale', ['#FCFCFF', '#63BE7B']],
  ['green-yellow', 'Green - Yellow Color Scale', ['#63BE7B', '#FFEB84']],
  ['yellow-green', 'Yellow - Green Color Scale', ['#FFEB84', '#63BE7B']],
]);

/** The data bars the menu lists: six colours, each as a gradient and as a solid fill. */
export const DATA_BAR_COLORS = Object.freeze([
  ['blue', 'Blue', '#638EC6'], ['green', 'Green', '#63C384'], ['red', 'Red', '#FF555A'], ['orange', 'Orange', '#FFB628'],
  ['light-blue', 'Light Blue', '#008AEF'], ['purple', 'Purple', '#D6007B'],
]);

export {iconCount};
/** Excel's default icon thresholds: one per icon, the first the lower bound, then even percent steps (0, 33, 67 for three). */
export function defaultIconThresholds(set) {
  const k = iconCount(set);
  return Array.from({length: k}, (_, i) => ({type: 'percent', val: String(Math.round(i * 100 / k))}));
}

const SCALE = {min: {type: 'min'}, max: {type: 'max'}, mid: {type: 'percentile', val: '50'}};

/**
 * The stored rule of a preset the ribbon menus name: `dataBar.blue`, `dataBar.blue.solid`, `colorScale.green-yellow-red`,
 * `iconSet.3Arrows` (null when unknown).
 */
export function presetRule(id) {
  const [kind, name, flavour] = String(id).split('.');
  if (kind === 'dataBar') {
    const c = DATA_BAR_COLORS.find(x => x[0] === name);
    return c ? {type: 'dataBar', color: c[2], gradient: flavour !== 'solid'} : null;
  }
  if (kind === 'colorScale') {
    const s = COLOR_SCALES.find(x => x[0] === name);
    return s ? {type: 'colorScale', colors: [...s[2]]} : null;
  }
  if (kind === 'iconSet') return ICON_SETS.some(x => x[0] === name) ? {type: 'iconSet', set: name} : null;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Building a rule

const bad = message => Object.assign(new Error(message), {cfInvalid: true});
const q = text => `"${String(text).replaceAll('"', '""')}"`;
const FIRST = 'A1';

/** The formulas Excel writes into the file for the rules it keeps as text, written for the top-left cell `at` (an A1 name). */
function ruleFormulas(type, p, at) {
  switch (type) {
    case 'containsText': return [`NOT(ISERROR(SEARCH(${q(p.text)},${at})))`];
    case 'notContainsText': return [`ISERROR(SEARCH(${q(p.text)},${at}))`];
    case 'beginsWith': return [`LEFT(${at},LEN(${q(p.text)}))=${q(p.text)}`];
    case 'endsWith': return [`RIGHT(${at},LEN(${q(p.text)}))=${q(p.text)}`];
    case 'containsBlanks': return [`LEN(TRIM(${at}))=0`];
    case 'notContainsBlanks': return [`LEN(TRIM(${at}))>0`];
    case 'containsErrors': return [`ISERROR(${at})`];
    case 'notContainsErrors': return [`NOT(ISERROR(${at}))`];
    case 'timePeriod': {
      const d = `FLOOR(${at},1)`, w = `ROUNDDOWN(${at},0)`;
      switch (p.timePeriod) {
        case 'yesterday': return [`${d}=TODAY()-1`];
        case 'today': return [`${d}=TODAY()`];
        case 'tomorrow': return [`${d}=TODAY()+1`];
        case 'last7Days': return [`AND(TODAY()-${d}<=6,${d}<=TODAY())`];
        case 'thisMonth': return [`AND(MONTH(${at})=MONTH(TODAY()),YEAR(${at})=YEAR(TODAY()))`];
        case 'lastMonth': return [`AND(MONTH(${at})=MONTH(EDATE(TODAY(),0-1)),YEAR(${at})=YEAR(EDATE(TODAY(),0-1)))`];
        case 'nextMonth': return [`AND(MONTH(${at})=MONTH(EDATE(TODAY(),0+1)),YEAR(${at})=YEAR(EDATE(TODAY(),0+1)))`];
        case 'thisWeek': return [`AND(TODAY()-${w}<=WEEKDAY(TODAY())-1,${w}-TODAY()<=7-WEEKDAY(TODAY()))`];
        case 'lastWeek': return [`AND(TODAY()-${w}>=(WEEKDAY(TODAY())),TODAY()-${w}<(WEEKDAY(TODAY())+7))`];
        case 'nextWeek': return [`AND(${w}-TODAY()>(7-WEEKDAY(TODAY())),${w}-TODAY()<(15-WEEKDAY(TODAY())))`];
        default: return [];
      }
    }
    default: return [];
  }
}

/** One cfvo from what a dialog or an agent gives: `{type, value}` (min, max, num, percent, percentile, formula). */
export function cfvo(v, fallback) {
  if (v === undefined || v === null) return {...fallback};
  const type = {number: 'num', num: 'num', min: 'min', max: 'max', percent: 'percent', percentile: 'percentile', formula: 'formula', lowest: 'min', highest: 'max'}[v.type ?? 'num'];
  if (!type) throw bad(`unknown value type \`${v.type}\``);
  const out = {type};
  const val = v.value ?? v.val;
  if (type !== 'min' && type !== 'max') {
    if (val === undefined || val === null || String(val).trim() === '') throw bad('a value is needed');
    out.val = String(val).replace(/^=/, '');
  }
  if (v.gte === false) out.gte = false;
  return out;
}

function checkFormula(what, f) {
  const body = String(f ?? '').replace(/^=/, '');
  try { parse(body); } catch { throw bad(`invalid ${what} formula \`${f}\`: it does not parse, so Excel could not open the saved file`); }
}

/** A number, a formula or text kept as typed; other text is quoted (a cell value rule's operands, `quote` in `add_cf`). */
export function operand(v) {
  const t = String(v ?? '').trim();
  if (t === '') throw bad('a value is needed');
  if (t.startsWith('=')) return t.slice(1);
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(t) || /^".*"$/s.test(t) || /^(true|false)$/i.test(t)) return t;
  return q(t);
}

const TYPE_NAMES = {blanks: 'containsBlanks', noBlanks: 'notContainsBlanks', errors: 'containsErrors', noErrors: 'notContainsErrors',
  duplicate: 'duplicateValues', unique: 'uniqueValues'};

/**
 * The stored rule for what a person or an agent asks: `{type: 'cellIs', operator, value, value2?}`, `{type: 'expression', formula}`,
 * text and blank and error types, `{type: 'top10', rank, percent?, bottom?}`, `{type: 'aboveAverage', below?, equal?, stdDev?}`,
 * `{type: 'timePeriod', period}`, `{type: 'colorScale', colors, min?, mid?, max?}`, `{type: 'dataBar', color, gradient?, min?, max?, showValue?}`,
 * `{type: 'iconSet', set, reverse?, showValue?, thresholds?}`, with `preset` or `style` (a differential format) for the types that format cells.
 * Throws an Error with `cfInvalid` for what Excel would refuse.
 */
export function buildRule(spec, at = FIRST) {
  if (!spec || typeof spec !== 'object') throw bad('a rule is needed');
  if (typeof spec.preset === 'string' && /^(dataBar|colorScale|iconSet)\./.test(spec.preset)) {
    const p = presetRule(spec.preset);
    if (!p) throw bad(`unknown preset \`${spec.preset}\``);
    return buildRule({...p, ...spec, preset: undefined}, at);
  }
  const raw = String(spec.type ?? 'cellIs');
  const type = TYPE_NAMES[raw] ?? raw;
  const dxf = () => {
    if (spec.style && typeof spec.style === 'object') return structuredClone(spec.style);
    return presetDxf(spec.preset);
  };
  const out = {type};
  switch (type) {
    case 'cellIs': {
      const word = spec.operator ?? 'greaterThan';
      if (!isOperatorWord(word)) throw bad(`unknown operator \`${word}\``);
      const op = normalizeOp(word);
      out.operator = op;
      out.formulas = [operand(spec.value)];
      if (op === 'between' || op === 'notBetween') out.formulas.push(operand(spec.value2));
      for (const f of out.formulas) checkFormula('comparison value', f);
      out.dxf = dxf();
      return out;
    }
    case 'expression': {
      const f = String(spec.formula ?? '').trim().replace(/^=/, '');
      if (!f) throw bad('a formula is needed');
      checkFormula('rule', f);
      out.formulas = [f];
      out.dxf = dxf();
      return out;
    }
    case 'containsText': case 'notContainsText': case 'beginsWith': case 'endsWith': {
      const text = String(spec.text ?? '');
      if (text === '') throw bad('text is needed');
      out.text = text;
      out.operator = type === 'notContainsText' ? 'notContains' : type;
      out.formulas = ruleFormulas(type, {text}, at);
      out.dxf = dxf();
      return out;
    }
    case 'containsBlanks': case 'notContainsBlanks': case 'containsErrors': case 'notContainsErrors':
      out.formulas = ruleFormulas(type, {}, at);
      out.dxf = dxf();
      return out;
    case 'duplicateValues': case 'uniqueValues':
      out.dxf = dxf();
      return out;
    case 'top10': {
      const rank = Math.trunc(Number(spec.rank ?? 10));
      const percent = spec.percent === true;
      if (!(rank >= 1 && rank <= (percent ? 100 : 1000))) throw bad(percent ? 'a percent from 1 to 100 is needed' : 'a number of items from 1 to 1000 is needed');
      out.rank = rank;
      if (percent) out.percent = true;
      if (spec.bottom === true) out.bottom = true;
      out.dxf = dxf();
      return out;
    }
    case 'aboveAverage': {
      if (spec.below === true) out.aboveAverage = false;
      if (spec.equal === true) out.equalAverage = true;
      const sd = Math.trunc(Number(spec.stdDev ?? 0));
      if (sd > 0) out.stdDev = Math.min(3, sd);
      out.dxf = dxf();
      return out;
    }
    case 'timePeriod': {
      const period = String(spec.period ?? spec.timePeriod ?? 'today');
      if (!TIME_PERIODS.some(t => t[0] === period)) throw bad(`unknown date period \`${period}\``);
      out.timePeriod = period;
      out.formulas = ruleFormulas('timePeriod', {timePeriod: period}, at);
      out.dxf = dxf();
      return out;
    }
    case 'colorScale': {
      const cols = (Array.isArray(spec.colors) && spec.colors.length ? spec.colors : COLOR_SCALES[0][2]);
      if (cols.length !== 2 && cols.length !== 3) throw bad('a colour scale has two or three colours');
      const stops = cols.length === 2 ? [cfvo(spec.min, SCALE.min), cfvo(spec.max, SCALE.max)] : [cfvo(spec.min, SCALE.min), cfvo(spec.mid, SCALE.mid), cfvo(spec.max, SCALE.max)];
      for (const s of stops) if (s.type === 'formula') checkFormula('colour scale threshold', s.val);
      out.colorScale = {cfvo: stops, colors: cols.map(c => c)};
      return out;
    }
    case 'dataBar': {
      const lo = cfvo(spec.min, SCALE.min), hi = cfvo(spec.max, SCALE.max);
      for (const s of [lo, hi]) if (s.type === 'formula') checkFormula('data bar value', s.val);
      out.dataBar = {cfvo: [lo, hi], color: spec.color ?? '#638EC6', ...(spec.showValue === false ? {showValue: false} : {}), gradient: spec.gradient !== false};
      return out;
    }
    case 'iconSet': {
      const set = String(spec.set ?? '3TrafficLights1');
      if (!ICON_SETS.some(x => x[0] === set)) throw bad(`unknown icon set \`${set}\``);
      const k = iconCount(set);
      let stops = defaultIconThresholds(set);
      if (Array.isArray(spec.thresholds) && spec.thresholds.length) {
        if (spec.thresholds.length !== k - 1 && spec.thresholds.length !== k) throw bad(`an icon set of ${k} icons has ${k - 1} thresholds`);
        const given = spec.thresholds.map(t => cfvo(t, {type: 'percent', val: '0'}));
        stops = given.length === k ? given : [{type: 'percent', val: '0'}, ...given];
        for (const s of stops) if (s.type === 'formula') checkFormula('icon threshold', s.val);
      }
      out.iconSet = {iconSet: set, cfvo: stops, ...(spec.showValue === false ? {showValue: false} : {}), ...(spec.reverse === true ? {reverse: true} : {})};
      return out;
    }
    default: throw bad(`unknown rule type \`${raw}\``);
  }
}

const OPERATOR_WORDS = {between: 1, notBetween: 1, equal: 1, notEqual: 1, greater: 1, greaterThan: 1, less: 1, lessThan: 1, greaterOrEqual: 1, greaterThanOrEqual: 1,
  lessOrEqual: 1, lessThanOrEqual: 1};
export const isOperatorWord = w => Object.prototype.hasOwnProperty.call(OPERATOR_WORDS, w);

// ---------------------------------------------------------------------------------------------
// Describing a rule (Rules Manager)

const OP_TEXT = {between: 'between', notBetween: 'not between', equal: '=', notEqual: '<>', greaterThan: '>', lessThan: '<', greaterThanOrEqual: '>=', lessThanOrEqual: '<='};
const withEq = f => (/^[-+]?[\d.]+$/.test(f) || f.startsWith('"') ? f : `=${f}`);

/** The "Rule" column of the Conditional Formatting Rules Manager. */
export function describeRule(r) {
  switch (r?.type) {
    case 'cellIs': {
      const [a, b] = r.formulas ?? [];
      return r.operator === 'between' || r.operator === 'notBetween' ? `Cell Value ${OP_TEXT[r.operator]} ${a} and ${b}` : `Cell Value ${OP_TEXT[r.operator] ?? r.operator} ${a}`;
    }
    case 'expression': return `Formula: ${withEq(r.formulas?.[0] ?? '')}`;
    case 'containsText': return `Cell Value contains "${r.text}"`;
    case 'notContainsText': return `Cell Value does not contain "${r.text}"`;
    case 'beginsWith': return `Cell Value begins with "${r.text}"`;
    case 'endsWith': return `Cell Value ends with "${r.text}"`;
    case 'containsBlanks': return 'Blanks';
    case 'notContainsBlanks': return 'No Blanks';
    case 'containsErrors': return 'Errors';
    case 'notContainsErrors': return 'No Errors';
    case 'duplicateValues': return 'Duplicate Values';
    case 'uniqueValues': return 'Unique Values';
    case 'top10': return `${r.bottom ? 'Bottom' : 'Top'} ${r.rank ?? 10}${r.percent ? '%' : ''}`;
    case 'aboveAverage': return `${r.aboveAverage === false ? 'Below' : 'Above'}${r.equalAverage ? ' or equal to' : ''} average${r.stdDev ? ` (${r.stdDev} std dev)` : ''}`;
    case 'timePeriod': return `Dates occurring: ${TIME_PERIODS.find(t => t[0] === r.timePeriod)?.[1] ?? r.timePeriod}`;
    case 'colorScale': return `${r.colorScale?.colors?.length === 2 ? '2' : '3'}-Color Scale`;
    case 'dataBar': return 'Data Bar';
    case 'iconSet': return `Icon Set (${ICON_SETS.find(x => x[0] === r.iconSet?.iconSet)?.[2] ?? r.iconSet?.iconSet})`;
    default: return String(r?.type ?? 'Rule');
  }
}

// ---------------------------------------------------------------------------------------------
// Evaluation

/** Adds the parts `lower` sets that `top` leaves unset (differential formats: an unset part is absent). */
function layerUnder(top, lower) {
  const out = structuredClone(top ?? {});
  for (const k of ['font', 'borders']) {
    if (!lower?.[k]) continue;
    out[k] = {...lower[k], ...(out[k] ?? {})};
  }
  if (!out.fill && lower?.fill) out.fill = lower.fill;
  if (out.numFmt === undefined && lower?.numFmt !== undefined) out.numFmt = lower.numFmt;
  return out;
}

const parsedRanges = new WeakMap();
function rangesOf(entry) {
  let r = parsedRanges.get(entry);
  if (!r) {
    r = (Array.isArray(entry.ranges) ? entry.ranges : entry.range ? [entry.range] : []).map(x => (typeof x === 'string' ? parseRange(x) : x)).filter(Boolean);
    parsedRanges.set(entry, r);
  }
  return r;
}

/** A formula written for `first`, as seen from (row, col): relative references shifted. */
function relative(f, first, row, col) {
  if (first.row === row && first.col === col) return f;
  try { return print(shiftRelative(parse(String(f).replace(/^=/, '')), row - first.row, col - first.col)); } catch { return f; }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const rank = Math.min(1, Math.max(0, p / 100)) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  const a = sorted[lo] ?? 0, b = sorted[hi] ?? a;
  return a + (b - a) * (rank - lo);
}

const lerp = (a, b, t0) => {
  const t = Math.min(1, Math.max(0, t0));
  return [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t));
};

/** Whether a serial date falls in a period relative to today (time_period_matches). */
export function inTimePeriod(period, serial, sys = 1900, now = serialInSystem(sys, serialFromUnixMs(unixNowMs()))) {
  const today = Math.floor(now), day = Math.floor(serial);
  const at = s => datetimeFromSerial(sys, s);
  const t = at(today), d = at(day);
  const weekStart = today - (t?.weekday ?? 0);
  const monthIs = off => {
    if (!t || !d) return false;
    const m = t.month + off;
    const year = t.year + Math.floor((m - 1) / 12), month = ((m - 1) % 12 + 12) % 12 + 1;
    return d.year === year && d.month === month;
  };
  switch (period) {
    case 'yesterday': return day === today - 1;
    case 'today': return day === today;
    case 'tomorrow': return day === today + 1;
    case 'last7Days': return day > today - 7 && day <= today;
    case 'lastWeek': return day >= weekStart - 7 && day < weekStart;
    case 'thisWeek': return day >= weekStart && day < weekStart + 7;
    case 'nextWeek': return day >= weekStart + 7 && day < weekStart + 14;
    case 'lastMonth': return monthIs(-1);
    case 'thisMonth': return monthIs(0);
    case 'nextMonth': return monthIs(1);
    default: return false;
  }
}

class RuleStats {
  constructor(sheet, si, engine, ranges, need) {
    this.sorted = []; this.counts = new Map();
    for (const r of ranges) {
      forEachCell(sheet, r.start.row, r.start.col, r.end.row, r.end.col, (row, col) => {
        const v0 = engine.sheetValue(si, row, col);
        const v = v0 instanceof GArray ? (v0.data[0] ?? null) : v0;
        if (need === 'numbers') { if (typeof v === 'number') this.sorted.push(v); }
        else if (v !== null && v !== undefined && v !== '') { const k = display(v).toLowerCase(); this.counts.set(k, (this.counts.get(k) ?? 0) + 1); }
        return true;
      });
    }
    this.sorted.sort((a, b) => a - b);
    const n = Math.max(this.sorted.length, 1);
    this.avg = this.sorted.reduce((a, b) => a + b, 0) / n;
    this.std = Math.sqrt(this.sorted.reduce((a, x) => a + (x - this.avg) ** 2, 0) / n);
  }
}

const NEEDS = {duplicateValues: 'counts', uniqueValues: 'counts', top10: 'numbers', aboveAverage: 'numbers', colorScale: 'numbers', dataBar: 'numbers', iconSet: 'numbers'};

/**
 * What the rules of a sheet make of its cells, for one version of the workbook content: `look(row, col)` is
 * `{dxf, fill: [r, g, b], bar: {fraction, color, gradient}, icon: {set, index}, hideValue}` or null.
 */
export class CfEvaluator {
  constructor(content, si) {
    this.content = content; this.si = si;
    this.sheet = content.sheets[si];
    this.engine = engineFor(content);
    this.theme = content.theme ?? DEFAULT_THEME;
    this.sys = content.dateSystem === 1904 ? 1904 : 1900;
    this.stats = new Map(); this.memo = new Map();
    const list = Array.isArray(this.sheet?.conditionalFormats) ? this.sheet.conditionalFormats : [];
    this.entries = list.filter(e => e?.rule && rangesOf(e).length).map((e, i) => ({e, i, ranges: rangesOf(e)}));
    this.entries.sort((a, b) => (a.e.priority ?? a.i + 1) - (b.e.priority ?? b.i + 1) || a.i - b.i);
  }

  get empty() { return this.entries.length === 0; }

  /** The ranges the rules cover (the paint visits the empty cells of these that a rule colours). */
  areas() { return (this._areas ??= this.entries.flatMap(en => en.ranges)); }

  statsFor(en, need) {
    let s = this.stats.get(en.e);
    if (!s) { s = new RuleStats(this.sheet, this.si, this.engine, en.ranges, need); this.stats.set(en.e, s); }
    return s;
  }

  value(row, col) {
    const v = this.engine.sheetValue(this.si, row, col);
    return v instanceof GArray ? (v.data[0] ?? null) : v;
  }

  threshold(st, v, row, col, first) {
    const min = st.sorted[0] ?? 0, max = st.sorted[st.sorted.length - 1] ?? 0;
    const val = Number(v.val);
    switch (v.type) {
      case 'min': return min;
      case 'max': return max;
      case 'num': return Number.isFinite(val) ? val : 0;
      case 'percent': return min + (max - min) * (Number.isFinite(val) ? val : 0) / 100;
      case 'percentile': return percentile(st.sorted, Number.isFinite(val) ? val : 0);
      case 'formula': {
        const r = this.engine.evaluate(this.si, {row, col}, relative(String(v.val ?? ''), first, row, col));
        const s = r instanceof GArray ? r.data[0] : r;
        return typeof s === 'number' ? s : 0;
      }
      default: return 0;
    }
  }

  /** The formula of a rule's operand at a cell. */
  evalAt(f, first, row, col) {
    const r = this.engine.evaluate(this.si, {row, col}, relative(String(f), first, row, col));
    return r instanceof GArray ? (r.data[0] ?? null) : r;
  }

  /** Whether a rule of the "format cells" kinds holds at a cell. */
  matches(en, rule, row, col, v, first) {
    const isErr = v instanceof CellError;
    const text = () => display(v ?? '');
    switch (rule.type) {
      case 'cellIs': {
        if (isErr) return false;
        const a = this.evalAt(rule.formulas?.[0] ?? '0', first, row, col);
        const op = rule.operator;
        if (op === 'between' || op === 'notBetween') {
          const b = this.evalAt(rule.formulas?.[1] ?? '0', first, row, col);
          const [lo, hi] = compare(a, b) > 0 ? [b, a] : [a, b];
          const within = compare(v, lo) >= 0 && compare(v, hi) <= 0;
          return op === 'between' ? within : !within;
        }
        const c = compare(v, a);
        switch (op) {
          case 'equal': return c === 0;
          case 'notEqual': return c !== 0;
          case 'greaterThan': return c > 0;
          case 'lessThan': return c < 0;
          case 'greaterThanOrEqual': return c >= 0;
          case 'lessThanOrEqual': return c <= 0;
          default: return false;
        }
      }
      case 'expression': {
        const r = this.evalAt(rule.formulas?.[0] ?? 'FALSE', first, row, col);
        if (typeof r === 'boolean') return r;
        if (typeof r === 'number') return r !== 0;
        return false;
      }
      case 'containsText': return !isErr && text().toLowerCase().includes(String(rule.text ?? '').toLowerCase());
      case 'notContainsText': return isErr || !text().toLowerCase().includes(String(rule.text ?? '').toLowerCase());
      case 'beginsWith': return !isErr && text().toLowerCase().startsWith(String(rule.text ?? '').toLowerCase());
      case 'endsWith': return !isErr && text().toLowerCase().endsWith(String(rule.text ?? '').toLowerCase());
      case 'containsBlanks': return v === null || v === undefined || text().trim() === '';
      case 'notContainsBlanks': return !(v === null || v === undefined || text().trim() === '');
      case 'containsErrors': return isErr;
      case 'notContainsErrors': return !isErr;
      case 'duplicateValues': return v !== null && v !== undefined && v !== '' && (this.statsFor(en, 'counts').counts.get(text().toLowerCase()) ?? 0) > 1;
      case 'uniqueValues': return v !== null && v !== undefined && v !== '' && (this.statsFor(en, 'counts').counts.get(text().toLowerCase()) ?? 0) === 1;
      case 'top10': {
        if (typeof v !== 'number') return false;
        const st = this.statsFor(en, 'numbers');
        if (!st.sorted.length) return false;
        const n = st.sorted.length;
        const k0 = rule.percent ? Math.max(1, Math.floor(n * (rule.rank ?? 10) / 100)) : (rule.rank ?? 10);
        const k = Math.min(n, Math.max(1, k0));
        return rule.bottom ? v <= st.sorted[k - 1] : v >= st.sorted[n - k];
      }
      case 'aboveAverage': {
        if (typeof v !== 'number') return false;
        const st = this.statsFor(en, 'numbers');
        const below = rule.aboveAverage === false;
        const thr = st.avg + (below ? -1 : 1) * st.std * (rule.stdDev ?? 0);
        return below ? v < thr || (rule.equalAverage === true && v === thr) : v > thr || (rule.equalAverage === true && v === thr);
      }
      case 'timePeriod': return typeof v === 'number' && inTimePeriod(rule.timePeriod, v, this.sys);
      default: return false;
    }
  }

  compute(row, col) {
    const v = this.value(row, col);
    let out = null;
    const ensure = () => (out ??= {dxf: null, fill: null, bar: null, icon: null, hideValue: false});
    for (const en of this.entries) {
      if (!en.ranges.some(r => containsRC(r, row, col))) continue;
      const rule = en.e.rule;
      const first = en.ranges[0].start;
      const need = NEEDS[rule.type];
      if (need && rule.type !== 'top10' && rule.type !== 'aboveAverage' && rule.type !== 'duplicateValues' && rule.type !== 'uniqueValues') {
        // colour scales, data bars and icon sets read the numbers
        if (typeof v !== 'number') continue;
        const st = this.statsFor(en, 'numbers');
        if (rule.type === 'colorScale' && rule.colorScale) {
          if (ensure().fill) continue;
          const pts = rule.colorScale.cfvo.map((c, i) => [this.threshold(st, c, row, col, first), resolveColor(rule.colorScale.colors[i], this.theme) ?? [255, 255, 255]]);
          let rgb;
          if (pts.length === 2) { const [[a, ca], [b, cb]] = pts; rgb = lerp(ca, cb, b > a ? (v - a) / (b - a) : 0); }
          else {
            const [[a, ca], [m, cm], [b, cb]] = pts;
            rgb = v <= m ? lerp(ca, cm, m > a ? (v - a) / (m - a) : 0) : lerp(cm, cb, b > m ? (v - m) / (b - m) : 1);
          }
          out.fill = rgb;
        } else if (rule.type === 'dataBar' && rule.dataBar) {
          if (ensure().bar) continue;
          const [loV, hiV] = rule.dataBar.cfvo;
          let lo = this.threshold(st, loV ?? SCALE.min, row, col, first);
          const hi = this.threshold(st, hiV ?? SCALE.max, row, col, first);
          if (lo > 0 && (loV?.type ?? 'min') === 'min') lo = 0;
          const frac = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 1;
          out.bar = {fraction: frac * 0.9 + (frac > 0 ? 0.1 : 0), color: resolveColor(rule.dataBar.color, this.theme) ?? [0x63, 0x8E, 0xC6], gradient: rule.dataBar.gradient !== false};
          if (rule.dataBar.showValue === false) out.hideValue = true;
        } else if (rule.type === 'iconSet' && rule.iconSet) {
          if (ensure().icon) continue;
          const set = rule.iconSet.iconSet ?? '3TrafficLights1', k = iconCount(set);
          const stops = rule.iconSet.cfvo?.length ? rule.iconSet.cfvo : defaultIconThresholds(set);
          const lower = stops.length === k ? stops.slice(1) : stops.length + 1 === k ? stops : defaultIconThresholds(set).slice(1);
          let idx = lower.filter(c => { const cut = this.threshold(st, c, row, col, first); return c.gte === false ? v > cut : v >= cut; }).length;
          idx = Math.min(idx, k - 1);
          if (rule.iconSet.reverse) idx = k - 1 - idx;
          out.icon = {set, index: idx};
          if (rule.iconSet.showValue === false) out.hideValue = true;
        }
        continue;
      }
      if (!this.matches(en, rule, row, col, v, first)) continue;
      ensure();
      out.dxf = out.dxf ? layerUnder(out.dxf, rule.dxf) : structuredClone(rule.dxf ?? {});
      if (en.e.stopIfTrue) break;
    }
    return out;
  }

  /** The look of a cell, or null when no rule shows on it. */
  look(row, col) {
    if (!this.entries.length) return null;
    const k = row * 16384 + col;
    if (this.memo.has(k)) return this.memo.get(k);
    let r = null;
    try { r = this.compute(row, col); } catch { r = null; }
    this.memo.set(k, r);
    return r;
  }
}

const evaluators = new WeakMap();
/** The evaluator of a sheet for this version of the content (a new version of the content, a new evaluator). */
export function cfFor(content, si) {
  let per = evaluators.get(content);
  if (!per) { per = new Map(); evaluators.set(content, per); }
  let ev = per.get(si);
  if (!ev) { ev = new CfEvaluator(content, si); per.set(si, ev); }
  return ev;
}

/** Whether a sheet has any conditional format (a cheap test before the paint asks for looks). */
export const hasCf = sheet => Array.isArray(sheet?.conditionalFormats) && sheet.conditionalFormats.length > 0;

/** The rule entries of a sheet that cover any cell of `areas` ({start, end} ranges). */
export function entriesTouching(sheet, areas) {
  return (Array.isArray(sheet?.conditionalFormats) ? sheet.conditionalFormats : []).filter(e => rangesOf(e).some(r => areas.some(a => intersects(r, a))));
}

