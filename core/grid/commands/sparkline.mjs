// Sparkline tab: Edit Data, the Type (Line, Column, Win/Loss), Markers, the points shown (High, Low, Negative, First, Last),
// Sparkline Color and Marker Color, the 36 styles, the vertical Axis options, Group and Ungroup, and Clear for the sparkline
// in the active cell (and the others of its group).
// gridcraft keeps a sparkline as {cell, source, kind, color, markers} and creates one with
// `insert.sparkline` (crates/engine/src/cmd/insert/objects.rs `insert_sparkline`, at
// 146161b4b450a56e5e59a083ba0478582d1e602b; MIT, see assets/third-party-licenses/artcraft-reference.txt).
// The edits of this tab change the stored sparkline (the same `sparklines` list Insert > Sparklines writes), as Excel's tab
// does for the one under the cursor; a group's sparklines change together. The point flags, colours, styles, axis options
// and groups are not in gridcraft: built from Excel's x14 sparkline groups (lib/sparkline-fx.mjs), not checked against upstream.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {a1, parseCell, parseRange} from '../lib/addr.mjs';
import {hasDoc, gridSel, requireSchema2} from '../lib/edit-targets.mjs';
import {setIn, deleteIn} from '../lib/edit-parts.mjs';
import {bad, failed, baseDoc} from '../lib/data-common.mjs';
import {colorParam, COLOR_DESCRIPTION} from '../lib/format-ranges.mjs';
import {colorHex} from '../model/style.mjs';
import {POINTS, COLOR_KEYS, SPARK_STYLES, sparkGroupMembers} from '../lib/sparkline-fx.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/insert/objects.rs', 'crates/engine/src/cmd/insert.rs', 'crates/chart/src/sparkline.rs']};
const KINDS = ['line', 'column', 'winLoss'];
const CELL = s.optional(s.string({min: 1, max: 40}));
const COLOR = s.union([s.string({max: 16}), s.object({theme: s.integer({min: 0, max: 11}), tint: s.optional(s.number())})]);
const sameCell = (a, b) => { const x = parseCell(String(a).replace(/\$/g, '')), y = parseCell(String(b).replace(/\$/g, '')); return !!x && !!y && x.row === y.row && x.col === y.col; };

/** The sparkline a call names (`location`), else the one in the active cell: {content, si, i, sp}. */
function locate(ctx, p, what) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  let si = sel.sheet, at = sel.active;
  if (typeof p?.location === 'string' && p.location) {
    const bang = p.location.lastIndexOf('!');
    const text = (bang >= 0 ? p.location.slice(bang + 1) : p.location).replace(/\$/g, '');
    const c = parseCell(text);
    if (!c) throw bad(what, `\`${p.location}\` is not a cell`);
    at = c;
    if (bang >= 0) {
      const name = p.location.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'");
      const i = content.sheets.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
      if (i < 0) throw bad(what, `no sheet named \`${name}\``);
      si = i;
    }
  }
  const list = content.sheets[si].sparklines ?? [];
  const i = list.findIndex(x => sameCell(x.cell, a1(at.row, at.col)));
  if (i < 0) throw failed('Select a cell with a sparkline.');
  return {content, si, i, sp: list[i]};
}
const spark = (ctx, p) => {
  if (!hasDoc(ctx).enabled) return null;
  try {
    const sel = gridSel(ctx);
    const list = ctx.doc.sheets[sel.sheet].sparklines ?? [];
    const key = typeof p?.location === 'string' && p.location ? p.location.replace(/^.*!/, '').replace(/\$/g, '') : a1(sel.active.row, sel.active.col);
    return list.find(x => sameCell(x.cell, key)) ?? null;
  } catch { return null; }
};
const onSpark = pick => (ctx, p) => {
  if (!hasDoc(ctx).enabled) return hasDoc(ctx);
  const sp = spark(ctx, p);
  return sp ? {enabled: true, ...pick(sp, p ?? {}, ctx)} : {enabled: false, reason: 'select a cell with a sparkline'};
};
const save = (ctx, L, next) => ctx.change.set(['sheets', L.si, 'sparklines', L.i], next);

/** Change the sparkline `L` names and the others of its group: `f(sparkline)` returns the new one. */
function saveGroup(ctx, L, f) {
  const list = L.content.sheets[L.si].sparklines ?? [];
  const members = new Set(sparkGroupMembers(list, L.sp));
  list.forEach((x, i) => { if (members.has(x)) ctx.change.set(['sheets', L.si, 'sparklines', i], f(x)); });
  return members.size;
}

function setType(ctx, p) {
  const L = locate(ctx, p, 'sparkline.type');
  requireSchema2(ctx, L.si);
  if (!KINDS.includes(p.type)) throw bad('sparkline.type', '`type` is line, column or winLoss');
  saveGroup(ctx, L, x => ({...x, kind: p.type}));
  return {type: p.type};
}

function markers(ctx, p) {
  const L = locate(ctx, p, 'sparkline.markers');
  requireSchema2(ctx, L.si);
  const on = typeof p.on === 'boolean' ? p.on : !L.sp.markers;
  saveGroup(ctx, L, x => ({...x, markers: on}));
  return {on};
}

function setColor(ctx, p) {
  const L = locate(ctx, p, 'sparkline.color');
  requireSchema2(ctx, L.si);
  const c = colorParam(p.color);
  if (c === undefined) throw bad('sparkline.color', `\`color\` is ${COLOR_DESCRIPTION}`);
  // Automatic is the default sparkline colour (accent 1).
  saveGroup(ctx, L, x => ({...x, color: c === null ? {theme: 4, tint: 0} : c}));
  return {color: c};
}

/** High Point, Low Point, Negative Points, First Point and Last Point: whether the sparkline marks them. */
function points(ctx, p) {
  const L = locate(ctx, p, 'sparkline.points');
  requireSchema2(ctx, L.si);
  if (!POINTS.includes(p.point)) throw bad('sparkline.points', `\`point\` is ${POINTS.join(', ')}`);
  const on = typeof p.on === 'boolean' ? p.on : !L.sp.flags?.[p.point];
  saveGroup(ctx, L, x => {
    const flags = {...(x.flags ?? {})};
    if (on) flags[p.point] = true; else delete flags[p.point];
    const next = {...x};
    if (Object.keys(flags).length) next.flags = flags; else delete next.flags;
    return next;
  });
  return {point: p.point, on};
}

/** Marker Color: the colour of the negative points, the markers or the high, low, first or last point. */
function markerColor(ctx, p) {
  const L = locate(ctx, p, 'sparkline.markerColor');
  requireSchema2(ctx, L.si);
  if (!COLOR_KEYS.includes(p.which)) throw bad('sparkline.markerColor', `\`which\` is ${COLOR_KEYS.join(', ')}`);
  const c = colorParam(p.color);
  if (c === undefined) throw bad('sparkline.markerColor', `\`color\` is ${COLOR_DESCRIPTION}`);
  saveGroup(ctx, L, x => {
    const colors = {...(x.colors ?? {})};
    if (c === null) delete colors[p.which]; else colors[p.which] = c;
    const next = {...x};
    if (Object.keys(colors).length) next.colors = colors; else delete next.colors;
    return next;
  });
  return {which: p.which, color: c};
}

/** One of the 36 styles: the series colour and the colours of the negative points, markers, high, low, first and last points. */
function styleGallery(ctx, p) {
  const L = locate(ctx, p, 'sparkline.style');
  requireSchema2(ctx, L.si);
  const st = SPARK_STYLES[p.style];
  if (!st) throw bad('sparkline.style', `\`style\` is 0 to ${SPARK_STYLES.length - 1}`);
  saveGroup(ctx, L, x => ({...x, color: st.series, style: p.style, colors: {negative: st.negative, markers: st.markers, first: st.first, last: st.last, high: st.high, low: st.low}}));
  return {style: st.label};
}

const AXIS_TYPES = ['auto', 'same', 'custom'];
/** Axis: show the horizontal axis, plot right to left, and the vertical axis minimum and maximum (automatic for each, the same for all, or a value). */
function axis(ctx, p) {
  const L = locate(ctx, p, 'sparkline.axis');
  requireSchema2(ctx, L.si);
  const patch = {};
  // A menu item with `toggle` (show, rtl) flips that option.
  if (typeof p.show === 'boolean') patch.show = p.show;
  if (typeof p.rtl === 'boolean') patch.rtl = p.rtl;
  if (p.toggle === 'show') patch.show = !L.sp.axis?.show;
  if (p.toggle === 'rtl') patch.rtl = !L.sp.axis?.rtl;
  for (const [key, type, value] of [['min', p.minType, p.min], ['max', p.maxType, p.max]]) {
    if (type === undefined) continue;
    if (!AXIS_TYPES.includes(type)) throw bad('sparkline.axis', '`minType` and `maxType` are auto, same or custom');
    if (type === 'custom') {
      if (!Number.isFinite(value)) throw bad('sparkline.axis', `\`${key}\` is the custom value`);
      patch[key] = value;
    } else patch[key] = type;
  }
  if (!Object.keys(patch).length) throw bad('sparkline.axis', 'nothing to change');
  saveGroup(ctx, L, x => {
    const ax = {...(x.axis ?? {}), ...patch};
    for (const k of ['min', 'max']) if (ax[k] === 'auto') delete ax[k];
    for (const k of ['show', 'rtl']) if (ax[k] === false) delete ax[k];
    const next = {...x};
    if (Object.keys(ax).length) next.axis = ax; else delete next.axis;
    return next;
  });
  return patch;
}

/** The sparklines inside the selection (or the active cell's), with their positions. */
function inSelection(ctx, content, si) {
  const sel = gridSel(ctx);
  const list = content.sheets[si].sparklines ?? [];
  const rects = sel.ranges?.length ? sel.ranges : [{start: sel.active, end: sel.active}];
  return list.map((x, i) => ({x, i, at: parseCell(x.cell)})).filter(({at}) => at && rects.some(r => at.row >= r.start.row && at.row <= r.end.row && at.col >= r.start.col && at.col <= r.end.col));
}

/** Group: the sparklines of the selected cells share one look from now on (the first one's type, colours, flags and axis). */
function group(ctx) {
  const content = baseDoc(ctx);
  const si = gridSel(ctx).sheet;
  requireSchema2(ctx, si);
  const hits = inSelection(ctx, content, si);
  if (hits.length < 2) throw failed('Select two or more cells that have sparklines.');
  const id = `g${hits[0].i}-${hits.length}-${Date.now().toString(36)}`;
  const first = hits[0].x;
  for (const {x, i} of hits) {
    const next = {...x, group: id, kind: first.kind, color: first.color, markers: first.markers};
    for (const k of ['flags', 'colors', 'axis', 'style']) { if (first[k] !== undefined) next[k] = first[k]; else delete next[k]; }
    ctx.change.set(['sheets', si, 'sparklines', i], next);
  }
  return {group: id, count: hits.length};
}

/** Ungroup: the sparklines of the selected cells (and their group's) stand alone again, each keeping the look it has. */
function ungroup(ctx) {
  const content = baseDoc(ctx);
  const si = gridSel(ctx).sheet;
  requireSchema2(ctx, si);
  const list = content.sheets[si].sparklines ?? [];
  const ids = new Set(inSelection(ctx, content, si).map(({x}) => x.group).filter(Boolean));
  if (!ids.size) throw failed('Select a cell with a grouped sparkline.');
  let n = 0;
  list.forEach((x, i) => { if (ids.has(x.group)) { const {group: _g, ...rest} = x; ctx.change.set(['sheets', si, 'sparklines', i], rest); n++; } });
  return {ungrouped: n};
}

/** Edit Data: the data range (and, with `newLocation`, the cell) of the sparkline. */
function edit(ctx, p) {
  const L = locate(ctx, p, 'sparkline.edit');
  requireSchema2(ctx, L.si);
  const range = typeof p.range === 'string' ? p.range.trim().replace(/\$/g, '') : '';
  const body = range.replace(/^.*!/, '');
  if (!range || !parseRange(body)) throw bad('sparkline.edit', '`range` is the data range, for example B2:M2');
  let cell = L.sp.cell;
  if (typeof p.newLocation === 'string' && p.newLocation) {
    const c = parseCell(p.newLocation.replace(/\$/g, '').replace(/^.*!/, ''));
    if (!c) throw bad('sparkline.edit', '`newLocation` is a cell, for example N2');
    cell = a1(c.row, c.col);
    // One sparkline per cell: the one that was there goes.
    const others = (L.content.sheets[L.si].sparklines ?? []).filter((x, i) => i !== L.i && !sameCell(x.cell, cell));
    setIn(ctx.change, ['sheets', L.si, 'sparklines'], [...others, {...L.sp, cell, source: range}]);
    return {cell, range};
  }
  save(ctx, L, {...L.sp, source: range});
  return {cell, range};
}

function clear(ctx, p) {
  const L = locate(ctx, p, 'sparkline.clear');
  requireSchema2(ctx, L.si);
  // Clear Selected Sparklines removes this one; Clear Selected Sparkline Groups (`group`) its whole group.
  const drop = p.group === true && L.sp.group ? new Set(sparkGroupMembers(L.content.sheets[L.si].sparklines ?? [], L.sp)) : new Set([L.sp]);
  const rest = (L.content.sheets[L.si].sparklines ?? []).filter(x => !drop.has(x));
  if (rest.length) setIn(ctx.change, ['sheets', L.si, 'sparklines'], rest); else deleteIn(ctx.change, ['sheets', L.si, 'sparklines']);
  return {cleared: L.sp.cell, count: drop.size};
}

const styleTiles = (ctx, sp) => SPARK_STYLES.map((st, i) => {
  const c = k => colorHex(st[k], ctx.doc?.theme);
  return {id: `style${i}`, label: st.label, value: i, selected: sp?.style === i, iconOnly: true,
    art: {kind: 'sparkline', series: c('series'), negative: c('negative'), markers: c('markers'), first: c('first'), last: c('last'), high: c('high'), low: c('low')}};
});
const axisChecked = (sp, key, type) => { const v = sp.axis?.[key]; return type === 'custom' ? typeof v === 'number' : (v ?? 'auto') === type; };
const FLAG = s.optional(s.boolean());

export default defineCommands({
  family: 'sparkline',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'sparkline.type', label: 'Sparkline Type', risk: 'edit', description: 'Change the sparkline in the active cell (or `location`), and its group, to line, column or winLoss.',
      params: s.object({location: CELL, type: s.enum(KINDS)}), state: onSpark((sp, p) => ({checked: (sp.kind ?? 'line') === p.type})), run: setType},
    {id: 'sparkline.markers', label: 'Markers', risk: 'edit', description: 'Show or hide the markers of the line sparkline in the active cell (`on`).',
      params: s.object({location: CELL, on: s.optional(s.boolean())}), state: onSpark(sp => ({checked: !!sp.markers})), run: markers},
    {id: 'sparkline.points', label: 'Show Points', risk: 'edit', description: 'Mark or unmark the high, low, negative, first or last points (`point`, `on`) of the sparkline in the active cell and its group.',
      params: s.object({location: CELL, point: s.enum(POINTS), on: FLAG}), state: onSpark((sp, p) => ({checked: !!sp.flags?.[p.point]})), run: points},
    {id: 'sparkline.color', label: 'Sparkline Color', risk: 'edit', description: `Set the colour of the sparkline in the active cell: ${COLOR_DESCRIPTION}.`,
      params: s.object({location: CELL, color: COLOR}), state: onSpark((sp, p, ctx) => ({value: colorHex(sp.color, ctx.doc?.theme)})), run: setColor},
    {id: 'sparkline.markerColor', label: 'Marker Color', risk: 'edit', description: `Set the colour of the negative points, markers or the high, low, first or last point (\`which\`): ${COLOR_DESCRIPTION}.`,
      params: s.object({location: CELL, which: s.enum(COLOR_KEYS), color: COLOR}), state: onSpark((sp, p, ctx) => ({value: p.which && sp.colors?.[p.which] ? colorHex(sp.colors[p.which], ctx.doc?.theme) : null})), run: markerColor},
    {id: 'sparkline.style', label: 'Sparkline Styles', risk: 'edit', description: 'Apply one of the 36 sparkline styles (`style` 0 to 35): the series colour and the colours of the marked points.',
      params: s.object({location: CELL, style: s.integer({min: 0, max: SPARK_STYLES.length - 1})}), state: (ctx, p) => { const st = onSpark(() => ({}))(ctx, p); return st.enabled ? {...st, value: styleTiles(ctx, spark(ctx, p))} : st; }, run: styleGallery},
    {id: 'sparkline.axis', label: 'Axis', risk: 'edit',
      description: 'Axis options: `show` the horizontal axis, `rtl` plot data right to left, `minType` and `maxType` auto (each sparkline its own), same (all the group\'s) or custom (with `min` / `max`).',
      params: s.object({location: CELL, show: FLAG, rtl: FLAG, toggle: s.optional(s.enum(['show', 'rtl'])), minType: s.optional(s.enum(AXIS_TYPES)), maxType: s.optional(s.enum(AXIS_TYPES)), min: s.optional(s.number()), max: s.optional(s.number())}),
      state: onSpark((sp, p) => ({checked: p.toggle === 'show' || p.show !== undefined ? !!sp.axis?.show : p.toggle === 'rtl' || p.rtl !== undefined ? !!sp.axis?.rtl : p.minType ? axisChecked(sp, 'min', p.minType) : p.maxType ? axisChecked(sp, 'max', p.maxType) : undefined})), run: axis},
    {id: 'sparkline.group', label: 'Group', risk: 'edit', description: 'Group the sparklines of the selected cells: they share the first one\'s type, colours, points and axis and change together.',
      params: s.object({}), state: ctx => (hasDoc(ctx).enabled ? {enabled: true} : hasDoc(ctx)), run: group},
    {id: 'sparkline.ungroup', label: 'Ungroup', risk: 'edit', description: 'Ungroup the sparklines of the selected cells\' group; each keeps the look it has.',
      params: s.object({}), state: onSpark(sp => (sp.group ? {} : {enabled: false, reason: 'the sparkline is not in a group'})), run: ungroup},
    {id: 'sparkline.edit', label: 'Edit Sparklines', risk: 'edit', dialog: 'dialog.editSparklines', description: 'Change the data range of the sparkline in the active cell (or `location`), and with `newLocation` the cell it sits in.',
      params: s.object({location: CELL, range: s.string({min: 1, max: 4096}), newLocation: CELL}), state: onSpark(() => ({})), run: edit},
    {id: 'sparkline.clear', label: 'Clear', risk: 'edit', description: 'Remove the sparkline in the active cell (or `location`); `group` true removes its whole group.',
      params: s.object({location: CELL, group: FLAG}), state: onSpark(() => ({})), run: clear},
  ],
});

export {colorParam};
