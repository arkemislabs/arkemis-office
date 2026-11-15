// Home › Paragraph › Paragraph › Tabs… (submit: para.tabs, one undo step).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_para.rs `TabsForm` (`read`,
// `new_stop`, `set_pos`, `remove_stop`, `clear_all`, `params`) and `tabs` at
// aadb077e072b7de05f724e359d8db82e151f125c, in Word's arrangement: the Tab stop position box over
// the list, Alignment and Leader for the stop, Set / Clear / Clear All, Default tab stops, Tab stops
// to be cleared. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The `stops` value is the whole form: {stops: [{pos, align, leader}] (points), cleared: [points],
// clearAll, selected}. The Set / Clear / Clear All buttons are pure edits of it (`setStop`,
// `clearStop`, `clearAll` below), so the bridge and the dialog's view drive the same thing.

import {defineDialog} from '../../kernel/dialog.mjs';
import {peek, focusOf} from '../lib/format-target.mjs';
import {resolvePara} from '../model/styles.mjs';
import {toIn, fromIn, isNum} from '../lib/format-dialogs.mjs';

/** Positions this close are the same stop (upstream `SAME_POS`). */
export const SAME_POS = 0.05;
export const MAX_STOPS = 64;
export const ALIGNS = Object.freeze(['left', 'center', 'right', 'decimal', 'bar']);
export const LEADERS = Object.freeze(['none', 'dot', 'hyphen', 'underscore', 'middleDot']);

const same = (a, b) => Math.abs(a - b) < SAME_POS;
const sorted = list => [...list].sort((a, b) => a.pos - b.pos);

/** `TabsForm::read`: the caret paragraph's stops (resolved through its style) and the default interval. */
export function readTabs(ctx) {
  const d = peek(ctx);
  const p = d.paraAt(focusOf(ctx, d));
  const rp = resolvePara(d.styles, p?.props ?? {});
  const stops = (rp.tabs ?? []).filter(t => t.align !== 'clear' && Number.isFinite(t.pos)).slice(0, MAX_STOPS)
    .map(t => ({pos: t.pos, align: ALIGNS.includes(t.align) ? t.align : 'left', leader: LEADERS.includes(t.leader) ? t.leader : 'none'}));
  return {form: {stops, cleared: [], clearAll: false, selected: stops.length ? 0 : null}, basis: stops, defaultTab: ctx.doc?.settings?.defaultTab ?? 36};
}

/** Word's Set: a stop at `pos` points with the alignment and leader (replacing one at the same place). */
export function setStop(form, pos, align = 'left', leader = 'none') {
  if (!isNum(pos)) return form;
  const p = Math.max(-1584, Math.min(1584, pos));
  if (!form.stops.some(t => same(t.pos, p)) && form.stops.length >= MAX_STOPS) return form;
  const stops = sorted([...form.stops.filter(t => !same(t.pos, p)), {pos: p, align: ALIGNS.includes(align) ? align : 'left', leader: LEADERS.includes(leader) ? leader : 'none'}]);
  return {...form, stops, cleared: form.cleared.filter(c => !same(c, p)), selected: stops.findIndex(t => same(t.pos, p))};
}

/** `TabsForm::new_stop`: the next free multiple of the default interval after the last stop. */
export function newStop(form, defaultTabPt) {
  const step = isNum(defaultTabPt) && defaultTabPt > 0 ? defaultTabPt : 36;
  const taken = p => form.stops.some(t => same(t.pos, p)) || form.cleared.some(c => same(c, p));
  const last = form.stops.reduce((m, t) => Math.max(m, t.pos), 0);
  let p = Math.floor(last / step) * step + step;
  while (taken(p) && p <= 1584) p += step;
  if (!Number.isFinite(p) || p > 1584 || form.stops.length >= MAX_STOPS) return form;
  return setStop(form, p);
}

/** `TabsForm::remove_stop` (Word's Clear): the stop goes to "to be cleared". */
export function clearStop(form, i) {
  if (!Number.isInteger(i) || i < 0 || i >= form.stops.length) return form;
  const t = form.stops[i];
  const sel = form.selected === i ? null : form.selected !== null && form.selected > i ? form.selected - 1 : form.selected;
  return {...form, stops: form.stops.filter((_, k) => k !== i), cleared: [...form.cleared, t.pos], selected: sel};
}

/** `TabsForm::clear_all`. */
export function clearAll(form) {
  return {...form, stops: [], cleared: [...form.cleared, ...form.stops.map(t => t.pos)], clearAll: true, selected: null};
}

/** `TabsForm::params`: para.tabs parameters for what changed, or null. */
export function tabsParams(form, basis, defaultIn, basisDefaultIn) {
  const out = {};
  if (form.clearAll) {
    out.clearAll = true;
    if (form.stops.length) out.set = form.stops;
  } else {
    const has = (list, t) => list.some(x => same(x.pos, t.pos) && x.align === t.align && x.leader === t.leader);
    const set = form.stops.filter(t => !has(basis, t));
    const clear = basis.filter(b => !form.stops.some(t => same(t.pos, b.pos))).map(b => b.pos);
    if (set.length) out.set = set;
    if (clear.length) out.clear = clear;
  }
  if (isNum(defaultIn) && Math.abs(defaultIn - basisDefaultIn) > 1e-4) out.default = fromIn(defaultIn);
  return Object.keys(out).length ? out : null;
}

/** "Tab stops to be cleared:" as Word lists them ("All" after Clear All). */
export const clearedText = form => (form.clearAll ? 'All' : form.cleared.map(p => `${toIn(p)}"`).join(', '));

export default defineDialog({
  id: 'dialog.tabs',
  title: 'Tabs',
  command: 'para.tabs',
  init(ctx) {
    const {form, basis, defaultTab} = readTabs(ctx);
    return {stops: form, defaultTab: toIn(defaultTab), clearedText: '', _basis: basis, _basisDefault: toIn(defaultTab)};
  },
  derive(v) {
    return {clearedText: clearedText(v.stops ?? {cleared: [], clearAll: false})};
  },
  validate(v) {
    const out = [];
    if (!isNum(v.defaultTab) || v.defaultTab <= 0 || v.defaultTab > 22) out.push({field: 'defaultTab', message: 'The measurement must be between 0.01" and 22".'});
    const f = v.stops;
    if (!f || !Array.isArray(f.stops) || f.stops.some(t => !isNum(t.pos) || Math.abs(t.pos) > 1584)) out.push({field: 'stops', message: 'Tab stops must be within ±22".'});
    return out;
  },
  toCommand(v) {
    const params = tabsParams(v.stops, v._basis ?? [], v.defaultTab, v._basisDefault);
    return params ? {command: 'para.tabs', params} : null;
  },
});
