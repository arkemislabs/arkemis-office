// Page styles: rule lines, grids and page colours (F:slate foundation).
//
// Slate has no ArtCraft upstream; the patterns and colours are OneNote's View › Page Setup
// (docs/spec/slate.json `view.page-setup.rule-lines` and `.page-color` items). Spacing follows US
// paper ruling at 96 px per inch: narrow 1/4", college 9/32", standard 5/16", wide 11/32"; grids
// 1/6", 1/4", 1/3" and 1/2". Ruled patterns draw OneNote's red margin line; grids do not.
//
// No DOM, no Node built-ins.

import {DEFAULT_RULE_COLOR, RULE_PATTERNS} from '../schema.mjs';

export const RULES = Object.freeze({
  'none': null,
  'narrow-ruled': {kind: 'ruled', spacing: 24},
  'college-ruled': {kind: 'ruled', spacing: 27},
  'standard-ruled': {kind: 'ruled', spacing: 30},
  'wide-ruled': {kind: 'ruled', spacing: 33},
  'small-grid': {kind: 'grid', spacing: 16},
  'medium-grid': {kind: 'grid', spacing: 24},
  'large-grid': {kind: 'grid', spacing: 32},
  'very-large-grid': {kind: 'grid', spacing: 48},
});

/** Where ruled lines start and where the margin line sits (page px). */
export const RULE_TOP = 96;
export const MARGIN_LINE_X = 72;
export const MARGIN_LINE_COLOR = '#e8a0a0';

export const RULE_LINE_COLORS = Object.freeze({blue: '#9fbfe0', green: '#a9d18e', red: '#f4b183', purple: '#c5b0d5', cyan: '#9dd9e3',
  orange: '#f8cbad', magenta: '#e6a8d7', gray: '#bfbfbf', black: '#000000'});

export const PAGE_COLORS = Object.freeze({blue: '#dae3f3', yellow: '#fff2cc', green: '#e2f0d9', red: '#fbe5d6', purple: '#e4dff0',
  cyan: '#ddf2f5', orange: '#fce4d6', magenta: '#f7dcef', blueMist: '#d9e6f2', purpleMist: '#e8e2f0', silver: '#ededed',
  lemonLime: '#effad2', sunshine: '#fff5c2', tan: '#f2e9dc', white: '#ffffff'});

export const isRulePattern = p => RULE_PATTERNS.includes(p);

/** The drawing a page's rule setting asks for, or null for none. */
export function ruleDrawing(rule) {
  const spec = RULES[rule?.pattern ?? 'none'];
  if (!spec) return null;
  return {...spec, color: rule.color ?? DEFAULT_RULE_COLOR, top: spec.kind === 'ruled' ? RULE_TOP : 0,
    margin: spec.kind === 'ruled' ? {x: MARGIN_LINE_X, color: MARGIN_LINE_COLOR} : null};
}
