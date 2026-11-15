// The New / Modify Table Style dialog's form (Table Design › Table Styles): one table style part at
// a time ("Apply formatting to"), its font, size, bold, italic, underline and colour, cell shading,
// borders (line style, width and colour, and which edges) and cell alignment. OK runs
// table.newStyle / table.modifyStyle with only what changed, part by part.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_table_style.rs (TableRegion,
// BorderPen, PARTS, EDGES, align_name, size_text, table_regions, region_of, table_style_params,
// region_changes, pick_edges, edges_on, WIDTHS, open, current_table_style; "a new style shows its
// new base's formatting") at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {border, borderVisible, rgbHex} from '../model/props.mjs';
import {findStyle, getStyle, tableStyle, tableStylePart} from '../model/styles.mjs';
import {CELL_ALIGNS} from '../commands/table_style.mjs';
import * as T from './table-session.mjs';

/** The parts "Apply formatting to" offers, in its order: [ooxml part, label] (PARTS). */
export const PARTS = [['wholeTable', 'Whole Table'], ['firstRow', 'Header Row'], ['lastRow', 'Total Row'], ['firstCol', 'First Column'],
  ['lastCol', 'Last Column'], ['band1Horz', 'Odd Banded Rows'], ['band2Horz', 'Even Banded Rows'], ['band1Vert', 'Odd Banded Columns'],
  ['band2Vert', 'Even Banded Columns'], ['nwCell', 'Top Left Cell'], ['neCell', 'Top Right Cell'], ['swCell', 'Bottom Left Cell'], ['seCell', 'Bottom Right Cell']];
/** The border picker's choices: [label, edges param] (EDGES). */
export const EDGES = [['All Borders', 'all'], ['No Border', 'none'], ['Outside Borders', 'outside'], ['Inside Borders', 'inside'], ['Top Border', 'top'],
  ['Bottom Border', 'bottom'], ['Left Border', 'left'], ['Right Border', 'right'], ['Inside Horizontal Border', 'insideH'], ['Inside Vertical Border', 'insideV']];
/** The line widths the Width box offers (WIDTHS). */
export const WIDTHS = [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6];
/** The line styles the Style box offers: [label, model style]. */
export const LINE_STYLES = [['Single', 'single'], ['Dotted', 'dotted'], ['Dashed', 'dashed'], ['Dot dash', 'dotDash'], ['Double', 'double'], ['Triple', 'triple'],
  ['Thick', 'thick'], ['Wave', 'wave']];

const hex = c => (Array.isArray(c) ? rgbHex(c) : typeof c === 'string' ? c : '');
const colorHex = c => (c && typeof c === 'object' && !Array.isArray(c) ? hex(c.Rgb ?? c.rgb ?? null) : hex(c));

/** A size in points as the box shows it (size_text). */
export const sizeText = pt => (Math.abs(pt - Math.round(pt)) < 0.01 ? String(Math.round(pt)) : pt.toFixed(1));

/** The cellAlign name for a part's alignments, '' when it sets neither (align_name). */
export function alignName(h, v) {
  if (!h && !v) return '';
  h = h ?? 'left'; v = v ?? 'top';
  if (h === 'justify' || h === 'distribute') h = 'left';
  return CELL_ALIGNS.find(([, va, ha]) => va === v && ha === h)?.[0] ?? '';
}

/** One part as the dialog shows it, resolved through the based-on chain (region_of). */
function regionOf(props, part) {
  const f = tableStylePart(props, part);
  const c = {...(props.chr ?? {}), ...(f.chr ?? {})};
  return {font: c.font ?? '', size: typeof c.size === 'number' ? sizeText(c.size) : '', bold: !!c.bold, italic: !!c.italic,
    underline: !!c.underline && c.underline !== 'none', color: colorHex(c.color), fill: hex(f.fill), borders: {...(f.borders ?? {})}, align: alignName(f.align, f.vAlign)};
}

/** The parts of table style `id` as resolved through its based-on chain, in PARTS order (table_regions). */
export function tableRegions(sheet, id) {
  const props = id ? tableStyle(sheet, id) : null;
  const blank = () => ({font: '', size: '', bold: false, italic: false, underline: false, color: '', fill: '', borders: {}, align: ''});
  return PARTS.map(([part]) => (props ? regionOf(props, part) : blank()));
}

const sameBorder = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The params for what changed in one part (region_changes). */
export function regionChanges(r, basis) {
  const color = c => (c ? c : null);
  const v = {};
  if (r.font.trim() !== basis.font.trim()) v.font = r.font.trim() ? r.font.trim() : null;
  if (r.size.trim() !== basis.size.trim()) { const pt = Number(r.size.trim()); if (Number.isFinite(pt) && pt > 0) v.size = pt; }
  for (const k of ['bold', 'italic', 'underline']) if (r[k] !== basis[k]) v[k] = r[k];
  if (r.color !== basis.color) v.color = color(r.color);
  if (r.fill !== basis.fill) v.fill = color(r.fill);
  if (r.align !== basis.align) v.cellAlign = r.align ? r.align : null;
  const edges = b => [['top', b.top], ['bottom', b.bottom], ['left', b.left], ['right', b.right], ['insideH', b.between], ['insideV', b.inside_v]];
  const changed = [];
  const eb = edges(basis.borders);
  edges(r.borders).forEach(([e, a], i) => {
    if (sameBorder(a, eb[i][1])) return;
    // An explicit "no line" edge differs from an unset one: it hides the lines a lower part draws.
    if (a && borderVisible(a)) changed.push({edges: e, style: a.style, width: a.width, color: a.color ? hex(a.color) : null});
    else if (a) changed.push({edges: e, style: 'none'});
  });
  if (changed.length) v.borders = changed;
  return v;
}

/** The params table.newStyle / table.modifyStyle take: only what changed from `basis` (table_style_params). */
export function tableStyleParams(id, name, basedOn, regions, basis) {
  const v = {name: name.trim(), basedOn};
  PARTS.forEach(([part], i) => { const ch = regionChanges(regions[i], basis[i]); if (Object.keys(ch).length) v[part] = ch; });
  if (id) v.style = id;
  return v;
}

/** Apply the border picker's choice to borders `b` with the pen: All, None, Outside and Inside set their edges; a single edge toggles (pick_edges). */
export function pickEdges(b0, edges, pen) {
  const b = {...(b0 ?? {})};
  const none = border('none', 0, null, 0);
  const line = border(pen.style, pen.width, pen.color ? parseHex(pen.color) : null, 0);
  const toggle = k => { b[k] = b[k] && borderVisible(b[k]) ? none : line; };
  switch (edges) {
    case 'all': return {top: line, bottom: line, left: line, right: line, between: line, inside_v: line};
    case 'none': return {top: none, bottom: none, left: none, right: none, between: none, inside_v: none};
    case 'outside': return {...b, top: line, bottom: line, left: line, right: line};
    case 'inside': return {...b, between: line, inside_v: line};
    case 'top': case 'bottom': case 'left': case 'right': toggle(edges); return b;
    case 'insideH': toggle('between'); return b;
    case 'insideV': toggle('inside_v'); return b;
    default: return b;
  }
}
const parseHex = s => { const m = /^#?([0-9a-f]{6})$/i.exec(String(s)); return m ? [0, 2, 4].map(i => Number.parseInt(m[1].slice(i, i + 2), 16)) : null; };

/** The style of the table at the caret, when it is a table style (current_table_style). */
export function currentTableStyle(S) {
  const cl = T.cellOfPos(S.sel.focus);
  const id = cl ? S.d.table(S.sel.focus.story, cl[0])?.props?.style ?? null : null;
  return id && getStyle(S.d.c.styles, id)?.kind === 'table' ? id : null;
}

const REGION_FIELDS = ['font', 'size', 'bold', 'italic', 'underline', 'fontColor', 'fill', 'alignment'];
// The colour fields hold "#RRGGBB" (or "auto"); the form's parts hold upstream's "RRGGBB" ('' for none).
const toColorField = h => (h ? `#${h}` : 'auto');
const fromColorField = c => { const m = /^#?([0-9a-f]{6})$/i.exec(String(c ?? '')); return m ? m[1].toUpperCase() : ''; };
const toFields = r => ({font: r.font, size: r.size, bold: r.bold, italic: r.italic, underline: r.underline, fontColor: toColorField(r.color), fill: toColorField(r.fill), alignment: r.align});
const fromFields = (r, v) => ({...r, font: String(v.font ?? ''), size: String(v.size ?? ''), bold: !!v.bold, italic: !!v.italic, underline: !!v.underline,
  color: fromColorField(v.fontColor), fill: fromColorField(v.fill), align: String(v.alignment ?? '')});

/** The dialog's values for `newTableStyle` (mode 'new') or `modifyTableStyle` ('modify') (open). */
export function openForm(ctx, mode) {
  const S = T.open(ctx);
  const sheet = S.d.c.styles;
  const current = currentTableStyle(S);
  let id = null, name, basedOn, regions;
  if (mode === 'new') {
    basedOn = current ?? 'TableGrid';
    for (let i = 1; i < 1000; i++) if (!findStyle(sheet, `Table Style ${i}`)) { name = `Table Style ${i}`; break; }
    regions = tableRegions(sheet, basedOn);
  } else {
    if (!current) throw T.disabled('the cursor isn\'t in a table with a style');
    id = current;
    const st = getStyle(sheet, id);
    name = st.name; basedOn = st.basedOn ?? '';
    regions = tableRegions(sheet, id);
  }
  const options = sheet.styles.filter(s => s.kind === 'table' && s.id !== id && !s.hidden).map(s => ({value: s.id, label: s.name}));
  // A new style shows its new base's formatting: every base's parts, read now (derive has no context).
  const baseRegions = mode === 'new' ? Object.fromEntries(options.map(o => [o.value, tableRegions(sheet, o.value)])) : null;
  return {mode, styleId: id, name: name ?? '', basedOn, region: 0, regions, basis: structuredClone(regions), basedOnOptions: options, baseRegions,
    ...toFields(regions[0]), borderStyle: 'single', borderWidth: 0.5, borderColor: 'auto', borders: null};
}

/** Keep the shown fields and the part they belong to in step (dialog derive). */
export function deriveForm(v, changed) {
  const regions = v.regions.map(r => ({...r, borders: {...r.borders}}));
  const i = Number.isInteger(v.region) ? v.region : 0;
  if (changed.includes('region')) {
    // The fields now show the newly chosen part.
    return {regions, ...toFields(regions[i] ?? regions[0])};
  }
  if (changed.includes('basedOn') && v.mode === 'new' && v.baseRegions?.[v.basedOn]) {
    // A new style shows its new base's formatting.
    const fresh = structuredClone(v.baseRegions[v.basedOn]);
    return {regions: fresh, basis: structuredClone(fresh), ...toFields(fresh[i] ?? fresh[0])};
  }
  if (changed.includes('borders') && v.borders) {
      regions[i] = {...regions[i], borders: pickEdges(regions[i].borders, v.borders, {style: v.borderStyle ?? 'single', width: Number(v.borderWidth) || 0.5, color: fromColorField(v.borderColor) || null})};
    return {regions, borders: null};
  }
  if (changed.some(k => REGION_FIELDS.includes(k))) {
    regions[i] = fromFields(regions[i], v);
    return {regions};
  }
  return {};
}

export function validateForm(v) {
  const out = [];
  if (!String(v.name ?? '').trim()) out.push({field: 'name', message: 'Type a name for the style.'});
  if (String(v.size ?? '').trim() && !(Number(v.size) > 0 && Number(v.size) <= 1638)) out.push({field: 'size', message: 'The size must be between 1 and 1638 points.'});
  return out;
}

export function formCommand(v) {
  const regions = v.regions.map((r, i) => (i === v.region ? fromFields(r, v) : r));
  const params = tableStyleParams(v.styleId, String(v.name ?? ''), v.basedOn ?? '', regions, v.basis);
  if (!params.basedOn) delete params.basedOn;
  return {command: v.mode === 'new' ? 'table.newStyle' : 'table.modifyStyle', params};
}

/** Options for the Apply formatting to / Borders / Width / Style / Alignment boxes. */
export const formOptions = {
  region: PARTS.map(([, label], i) => ({value: i, label})),
  borders: EDGES.map(([label, value]) => ({value, label})),
  borderWidth: WIDTHS.map(w => ({value: w, label: `${w} pt`})),
  borderStyle: LINE_STYLES.map(([label, value]) => ({value, label})),
  alignment: [{value: '', label: '(not set)'}, ...CELL_ALIGNS.map(([k]) => ({value: k, label: k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())}))],
};
