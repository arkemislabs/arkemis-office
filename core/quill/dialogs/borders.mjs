// Borders and Shading (Design › Page Borders opens it on Page Border; Home › Borders › Borders and
// Shading… on Borders): Word's three pages over the caret paragraph and section. OK runs only the
// parts that changed, in order, as one undo step.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_para.rs (`Setting`, `LineForm`
// `read`/`apply_setting`/`toggle`/`side_width`/`border`/`sides_param`, `STYLES`, `WIDTHS`,
// `BordersForm` `read`/`commands`/`apply`, `borders`, `lines`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Each page's line form is flat values with its own prefix (para*, page*), so the bridge reads and
// sets them like any field: <p>Setting (none|box|shadow|threeD|custom), <p>Style, <p>Color ('#RRGGBB'
// or 'auto'), <p>Width (pt), <p>Sides {top, bottom, left, right, between}.

import {defineDialog} from '../../kernel/dialog.mjs';
import {peek, focusOf} from '../lib/format-target.mjs';
import {resolvePara} from '../model/styles.mjs';
import {borderVisible, rgbHex} from '../model/props.mjs';
import {caretSection} from '../commands/page.mjs';

export const SETTINGS = Object.freeze(['none', 'box', 'shadow', 'threeD', 'custom']);
/** Line styles the dialog offers (STYLES). */
export const STYLES = Object.freeze([['single', 'Single'], ['dotted', 'Dotted'], ['dashed', 'Dashed'], ['dotDash', 'Dot dash'], ['double', 'Double'],
  ['triple', 'Triple'], ['thick', 'Thick'], ['wave', 'Wave']]);
/** Widths, points (WIDTHS). */
export const WIDTHS = Object.freeze([0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6]);
const SIDES = ['top', 'bottom', 'left', 'right', 'between'];
const noSides = () => ({top: false, bottom: false, left: false, right: false, between: false});
const isHex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/** LineForm::read: the setting, style, colour, base width and sides of a borders set. */
export function readLines(b) {
  const vis = k => (b && borderVisible(b[k]) ? b[k] : null);
  const s = Object.fromEntries(SIDES.map(k => [k, vis(k)]));
  const on = Object.fromEntries(SIDES.map(k => [k, !!s[k]]));
  const first = SIDES.map(k => s[k]).find(Boolean) ?? null;
  const w = k => s[k]?.width ?? 0;
  const four = on.top && on.bottom && on.left && on.right && !on.between;
  let setting = 'custom';
  if (!first) setting = 'none';
  else if (four && w('top') === w('left') && w('bottom') === w('right') && w('bottom') > w('top')) setting = 'shadow';
  else if (four && w('top') === w('left') && w('bottom') === w('right') && w('top') > w('bottom')) setting = 'threeD';
  else if (four && w('top') === w('bottom') && w('left') === w('right') && w('top') === w('left')) setting = 'box';
  // The base width of a heavier-sided preset is the lighter side's.
  const width = setting === 'shadow' ? w('top') : setting === 'threeD' ? w('bottom') : first?.width ?? 0.5;
  return {setting, style: STYLES.some(([k]) => k === first?.style) ? first.style : 'single', color: first?.color ? `#${rgbHex(first.color)}` : 'auto',
    width: width > 0 ? width : 0.5, sides: on};
}

/** LineForm::apply_setting. */
export function applySetting(f, setting) {
  let sides = f.sides;
  if (setting === 'none') sides = noSides();
  else if (setting === 'box' || setting === 'shadow' || setting === 'threeD') sides = {top: true, bottom: true, left: true, right: true, between: false};
  else if (setting === 'custom' && !SIDES.some(k => sides[k])) sides = {top: true, bottom: true, left: true, right: true, between: false};
  return {...f, setting, sides};
}

/** LineForm::toggle: a side clicked in the preview (or its button). */
export function toggleSide(f, side) {
  if (!SIDES.includes(side)) return f;
  const sides = {...f.sides, [side]: !f.sides[side]};
  return {...f, sides, setting: SIDES.some(k => sides[k]) ? 'custom' : 'none'};
}

/** LineForm::side_width: Shadow and 3-D double their heavier sides. */
export function sideWidth(f, side) {
  const heavy = (f.setting === 'shadow' && (side === 'bottom' || side === 'right')) || (f.setting === 'threeD' && (side === 'top' || side === 'left'));
  const w = Math.max(0.25, Math.min(6, f.width));
  return heavy ? Math.min(6, w * 2) : w;
}

/** LineForm::sides_param: the `sides` parameter of para.borders / design.pageBorders. */
export function sidesParam(f, between = true) {
  const out = {};
  for (const k of SIDES) {
    if (!f.sides[k] || (k === 'between' && !between)) continue;
    out[k] = {style: f.style, width: sideWidth(f, k)};
    if (isHex(f.color)) out[k].color = f.color.slice(1).toUpperCase();
  }
  return out;
}

const formOf = (v, p) => ({setting: v[`${p}Setting`], style: v[`${p}Style`], color: v[`${p}Color`], width: Number(v[`${p}Width`]), sides: v[`${p}Sides`] ?? noSides()});
const valuesOf = (f, p) => ({[`${p}Setting`]: f.setting, [`${p}Style`]: f.style, [`${p}Color`]: f.color, [`${p}Width`]: f.width, [`${p}Sides`]: f.sides});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** BordersForm::read. */
export function readBorders(ctx) {
  const d = peek(ctx);
  const p = d.paraAt(focusOf(ctx, d));
  const rp = resolvePara(d.styles, p?.props ?? {});
  const {x} = caretSection(ctx);
  const para = readLines(rp.borders ?? null);
  const page = readLines(x.pageBorders ?? null);
  page.sides = {...page.sides, between: false};
  const v = {...valuesOf(para, 'para'), paraApplyTo: 'paragraph', ...valuesOf(page, 'page'), pageApplyTo: 'document',
    fill: rp.shading ? `#${rgbHex(rp.shading)}` : 'auto', fillApplyTo: 'paragraph'};
  return {...v, _basis: structuredClone(v)};
}

/** BordersForm::commands: the commands OK runs, in order, only for the parts that changed. */
export function bordersCommands(v) {
  const b = v._basis ?? {};
  const changed = keys => keys.some(k => !same(v[k], b[k]));
  const out = [];
  const para = formOf(v, 'para');
  if (changed(['paraSetting', 'paraStyle', 'paraColor', 'paraWidth', 'paraSides', 'paraApplyTo'])) {
    if (v.paraApplyTo === 'text') {
      const first = ['top', 'left', 'bottom', 'right'].find(k => para.sides[k]);
      const border = first ? {style: para.style, width: sideWidth(para, first), color: isHex(para.color) ? para.color.slice(1).toUpperCase() : null, space: 0}
        : {style: 'none', width: 0, color: null, space: 0};
      out.push({command: 'format.set', params: {props: {border}}});
    } else {
      out.push({command: 'para.borders', params: {sides: sidesParam(para)}});
    }
  }
  if (changed(['pageSetting', 'pageStyle', 'pageColor', 'pageWidth', 'pageSides', 'pageApplyTo'])) {
    out.push({command: 'design.pageBorders', params: {sides: sidesParam(formOf(v, 'page'), false), applyTo: v.pageApplyTo === 'section' ? 'section' : 'document'}});
  }
  if (changed(['fill', 'fillApplyTo'])) {
    const color = isHex(v.fill) ? v.fill.slice(1).toUpperCase() : null;
    out.push({command: v.fillApplyTo === 'text' ? 'format.shading' : 'para.shading', params: {color}});
  }
  return out;
}

export default defineDialog({
  id: 'dialog.borders',
  title: 'Borders and Shading',
  command: 'design.pageBorders',
  init: ctx => readBorders(ctx),
  derive(v, changed) {
    const out = {};
    for (const p of ['para', 'page']) {
      if (changed.includes(`${p}Setting`)) Object.assign(out, valuesOf(applySetting(formOf(v, p), v[`${p}Setting`]), p));
      else if (changed.includes(`${p}Sides`)) {
        const f = formOf(v, p);
        // A side switched in the preview makes it a custom (or no) border, as upstream's toggle.
        const any = SIDES.some(k => f.sides[k]);
        if (!any) out[`${p}Setting`] = 'none';
        else if (!(f.setting === 'box' || f.setting === 'shadow' || f.setting === 'threeD') || !same(f.sides, {top: true, bottom: true, left: true, right: true, between: false})) out[`${p}Setting`] = 'custom';
      }
    }
    if (changed.includes('pageSides') && v.pageSides?.between) out.pageSides = {...v.pageSides, between: false};
    return out;
  },
  validate(v) {
    const out = [];
    for (const p of ['para', 'page']) {
      if (!WIDTHS.includes(Number(v[`${p}Width`]))) out.push({field: `${p}Width`, message: 'Choose a width.'});
      if (!STYLES.some(([k]) => k === v[`${p}Style`])) out.push({field: `${p}Style`, message: 'Choose a style.'});
    }
    return out;
  },
  preview(_ctx, v) {
    return {para: {...formOf(v, 'para'), widths: Object.fromEntries(SIDES.map(k => [k, sideWidth(formOf(v, 'para'), k)]))},
      page: {...formOf(v, 'page'), widths: Object.fromEntries(SIDES.map(k => [k, sideWidth(formOf(v, 'page'), k)]))},
      fill: isHex(v.fill) ? v.fill : null, paraText: v.paraApplyTo === 'text', fillText: v.fillApplyTo === 'text'};
  },
  toCommand: v => ({batch: bordersCommands(v)}),
});
