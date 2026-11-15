// Data Analysis dialog model (submit: data.analysisToolPak).
// Translated from gridcraft crates/ui-egui/src/dialogs/analysis.rs (the Analysis ToolPak dialog: the tool
// list, then the chosen tool's fields per `toolpak_fields`, the overwrite confirm) and
// crates/engine/src/cmd/analysis.rs (the command's parameters and `OVERWRITE_ERROR`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's two boxes: the Data Analysis list (Analysis
// Tools, OK, Cancel), then the tool's own dialog (Input Range, Grouped By, Labels, Alpha, the tool's
// options, Output options). MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: step (pick | tool), tool, range, groupedBy, labels, range1, range2, inputY, inputX, alpha,
// hypothesizedDifference, summary, confidenceOn/confidence, kthLargestOn/kthLargest, kthSmallestOn/kthSmallest,
// bins, pareto, cumulative, constantZero, residuals, standardizedResiduals, normalProbability, interval,
// damping, standardErrors, outputTo (range | newSheet), output, newSheet, overwrite.
// Excel's New Workbook output and the chart options (Chart Output, Residual Plots, Line Fit Plots, Normal
// Probability Plots) are not offered: one workbook per window, and the report is static values.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {rangeA1} from '../lib/addr.mjs';
import {TOOLS, OVERWRITE_ERROR} from '../lib/analysis-tools.mjs';

/** The Analysis Tools list: {value, label} in Excel's order. */
export const TOOL_LIST = TOOLS.map(([value, label]) => ({value, label}));

/** Whether a command error is the output-range-holds-data refusal, so the dialog asks before replacing. */
export const isOverwriteError = message => String(message ?? '').includes(OVERWRITE_ERROR);

/** What a tool's own dialog asks for, besides the output options. */
export const TOOL_FORMS = {
  anovaSingle: {input: 'range', grouped: true, labels: 'Labels in First Row', alpha: true},
  correlation: {input: 'range', grouped: true, labels: 'Labels in First Row'},
  covariance: {input: 'range', grouped: true, labels: 'Labels in First Row'},
  descriptive: {input: 'range', grouped: true, labels: 'Labels in First Row', descriptive: true},
  exponentialSmoothing: {input: 'range', labels: 'Labels', damping: true, standardErrors: true},
  fTest: {input: 'two', labels: 'Labels', alpha: true},
  histogram: {input: 'range', bins: true, labels: 'Labels', histogram: true},
  movingAverage: {input: 'range', labels: 'Labels in First Row', interval: true, standardErrors: true},
  rankPercentile: {input: 'range', grouped: true, labels: 'Labels in First Row'},
  regression: {input: 'regression', labels: 'Labels', regression: true},
  tTestPaired: {input: 'two', labels: 'Labels', alpha: true, difference: true},
  tTestEqual: {input: 'two', labels: 'Labels', alpha: true, difference: true},
  tTestUnequal: {input: 'two', labels: 'Labels', alpha: true, difference: true},
};

const text = x => String(x ?? '').trim();
const numberOf = x => { const t = text(x).replace(/%$/, '').trim(); const n = t === '' ? NaN : Number(t); return Number.isFinite(n) ? n : null; };
const BAD_SHEET = /[[\]:*?/\\]/;

export default defineDialog({
  id: 'dialog.analysisToolPak',
  title: 'Data Analysis',
  command: 'data.analysisToolPak',
  /** Excel titles the tool's own box with the tool's name. */
  titleFor: v => (v.step === 'tool' ? TOOLS.find(([id]) => id === v.tool)?.[1] ?? 'Data Analysis' : 'Data Analysis'),
  init(ctx) {
    const sel = gridSel(ctx);
    const first = sel.ranges[0];
    return {
      step: 'pick', tool: TOOLS[0][0],
      range: first ? rangeA1(first) : '', groupedBy: 'columns', labels: false, range1: '', range2: '', inputY: '', inputX: '',
      alpha: '0.05', hypothesizedDifference: '0',
      summary: true, confidenceOn: false, confidence: '95', kthLargestOn: false, kthLargest: '1', kthSmallestOn: false, kthSmallest: '1',
      bins: '', pareto: false, cumulative: false,
      constantZero: false, residuals: false, standardizedResiduals: false, normalProbability: false,
      interval: '3', damping: '0.3', standardErrors: false,
      outputTo: 'newSheet', output: '', newSheet: '', overwrite: false,
    };
  },
  validate(v) {
    // On the list OK has nothing to run: the dialog's body moves on to the tool's own box when it sees this.
    if (v.step !== 'tool') return [{field: 'step', message: ''}];
    const form = TOOL_FORMS[v.tool];
    if (!form) return [{field: 'tool', message: 'Choose an analysis tool.'}];
    const out = [];
    const need = (field, message) => { if (!text(v[field])) out.push({field, message}); };
    if (form.input === 'range') need('range', 'Enter the input range.');
    if (form.input === 'regression') { need('inputY', 'Enter the Input Y range.'); need('inputX', 'Enter the Input X range.'); }
    if (form.input === 'two') { need('range1', 'Enter the Variable 1 range.'); need('range2', 'Enter the Variable 2 range.'); }
    if (form.alpha) { const a = numberOf(v.alpha); if (a !== null ? !(a > 0 && a < 1) : text(v.alpha) !== '') out.push({field: 'alpha', message: 'Alpha must be between 0 and 1.'}); }
    if (form.difference && text(v.hypothesizedDifference) !== '' && numberOf(v.hypothesizedDifference) === null) out.push({field: 'hypothesizedDifference', message: 'Hypothesized Mean Difference must be a number.'});
    if (form.interval && text(v.interval) !== '') { const n = numberOf(v.interval); if (n === null || n < 1 || n !== Math.trunc(n)) out.push({field: 'interval', message: 'Interval must be a whole number of 1 or more.'}); }
    if (form.damping && text(v.damping) !== '') { const n = numberOf(v.damping); if (n === null || n < 0 || n > 1) out.push({field: 'damping', message: 'Damping factor must be between 0 and 1.'}); }
    if (form.descriptive) {
      if (!v.summary && !v.confidenceOn && !v.kthLargestOn && !v.kthSmallestOn) out.push({field: 'summary', message: 'Choose at least one of Summary statistics, Confidence Level for Mean, Kth Largest or Kth Smallest.'});
    }
    if ((form.descriptive || form.regression) && v.confidenceOn) { const n = numberOf(v.confidence); if (n === null || !(n > 0 && n < 100)) out.push({field: 'confidence', message: 'Confidence level must be between 0 and 100.'}); }
    if (form.descriptive) {
      for (const [on, field, label] of [['kthLargestOn', 'kthLargest', 'Kth Largest'], ['kthSmallestOn', 'kthSmallest', 'Kth Smallest']]) {
        if (!v[on]) continue;
        const n = numberOf(v[field]);
        if (n === null || n < 1 || n !== Math.trunc(n)) out.push({field, message: `${label} must be a whole number of 1 or more.`});
      }
    }
    if (v.outputTo === 'range') need('output', 'Enter the output range.');
    else if (text(v.newSheet) && (text(v.newSheet).length > 31 || BAD_SHEET.test(text(v.newSheet)) || /^'|'$/.test(text(v.newSheet)))) out.push({field: 'newSheet', message: "A sheet name can't be longer than 31 characters or contain : \\ / ? * [ ]."});
    return out;
  },
  toCommand(v) {
    const form = TOOL_FORMS[v.tool] ?? {};
    const p = {tool: v.tool};
    if (form.input === 'range') p.range = text(v.range);
    if (form.input === 'regression') { p.inputY = text(v.inputY); p.inputX = text(v.inputX); }
    if (form.input === 'two') { p.range1 = text(v.range1); p.range2 = text(v.range2); }
    if (form.bins && text(v.bins)) p.bins = text(v.bins);
    if (form.grouped) p.groupedBy = v.groupedBy === 'rows' ? 'rows' : 'columns';
    p.labels = v.labels === true;
    if (form.alpha) p.alpha = numberOf(v.alpha) ?? 0.05;
    if (form.difference) p.hypothesizedDifference = numberOf(v.hypothesizedDifference) ?? 0;
    if (form.descriptive) {
      p.summary = v.summary === true;
      if (v.confidenceOn) p.confidence = numberOf(v.confidence);
      if (v.kthLargestOn) p.kthLargest = numberOf(v.kthLargest);
      if (v.kthSmallestOn) p.kthSmallest = numberOf(v.kthSmallest);
    }
    if (form.regression) {
      if (v.confidenceOn) p.confidence = numberOf(v.confidence);
      for (const k of ['constantZero', 'residuals', 'standardizedResiduals', 'normalProbability']) if (v[k]) p[k] = true;
    }
    if (form.histogram) for (const k of ['pareto', 'cumulative']) if (v[k]) p[k] = true;
    if (form.interval && text(v.interval)) p.interval = numberOf(v.interval);
    if (form.damping && text(v.damping)) p.damping = numberOf(v.damping);
    if (form.standardErrors && v.standardErrors) p.standardErrors = true;
    p.outputTo = v.outputTo === 'range' ? 'range' : 'newSheet';
    if (p.outputTo === 'range') p.output = text(v.output);
    else if (text(v.newSheet)) p.newSheet = text(v.newSheet);
    if (v.overwrite === true) p.overwrite = true;
    return {command: 'data.analysisToolPak', params: p};
  },
});
