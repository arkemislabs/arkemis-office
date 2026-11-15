// Table Design › Table Styles: create, modify and delete table styles (whole table, header and
// total rows, first and last columns, banded rows and columns, corner cells), stored as table
// styles in the document's style sheet (ECMA-376 §17.7.6).
//
// Translated from wordcraft crates/engine/src/cmd/table_style.rs (PARTS, part_named,
// table_style_id, build_new, new_style, target, modify_style, build_modified, preview, delete,
// is_builtin_table_style, uses_style, restyle, apply, edit, edit_part, color_param, NO_LINE,
// LINE_STYLES, set_edges, edges_param, h_align, v_align, CELL_ALIGNS, region) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {border as mkBorder, bordersAll, charOverlaid, paraOverlaid, parseRgb, UNDERLINES, same} from '../model/props.mjs';
import {chain, findStyle, getStyle, newStyleId, style as makeStyle, styleSetTablePart, styleTablePart, tablePartsOverlaid, tableStyle,
  upsertStyle} from '../model/styles.mjs';
import * as T from '../lib/table-session.mjs';
import {tableStyleId} from './table.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/table_style.rs']};
const {failed, params: badParams} = T;

/** The parts a table style formats, by param name (PARTS). */
export const PARTS = [['wholeTable', 'wholeTable'], ['headerRow', 'firstRow'], ['firstRow', 'firstRow'], ['lastRow', 'lastRow'], ['totalRow', 'lastRow'],
  ['firstColumn', 'firstCol'], ['firstCol', 'firstCol'], ['lastColumn', 'lastCol'], ['lastCol', 'lastCol'], ['bandedRows', 'band1Horz'],
  ['band1Horz', 'band1Horz'], ['band2Horz', 'band2Horz'], ['bandedColumns', 'band1Vert'], ['band1Vert', 'band1Vert'], ['band2Vert', 'band2Vert'],
  ['neCell', 'neCell'], ['nwCell', 'nwCell'], ['seCell', 'seCell'], ['swCell', 'swCell'], ['topRightCell', 'neCell'], ['topLeftCell', 'nwCell'],
  ['bottomRightCell', 'seCell'], ['bottomLeftCell', 'swCell']];

/** The part a param name means (part_named). */
export const partNamed = name => PARTS.find(([n]) => n.toLowerCase() === String(name).toLowerCase())?.[1] ?? null;

const PART_FIELDS = ['fill', 'font', 'size', 'bold', 'italic', 'underline', 'color', 'align', 'vAlign', 'cellAlign', 'borders', 'borderColor', 'borderWidth'];
const NO_LINE = mkBorder('none', 0, null, 0);
const LINE_STYLES = ['none', 'single', 'double', 'dotted', 'dashed', 'dotDash', 'thick', 'triple', 'wave'];
export const CELL_ALIGNS = [['topLeft', 'top', 'left'], ['topCenter', 'top', 'center'], ['topRight', 'top', 'right'], ['centerLeft', 'center', 'left'],
  ['center', 'center', 'center'], ['centerRight', 'center', 'right'], ['bottomLeft', 'bottom', 'left'], ['bottomCenter', 'bottom', 'center'],
  ['bottomRight', 'bottom', 'right']];
const hAlign = n => ({left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', justify: 'justify', both: 'justify'})[n] ?? null;
const vAlign = n => ({top: 'top', center: 'center', middle: 'center', bottom: 'bottom'})[n] ?? null;

const has = (v, k) => v && typeof v === 'object' && Object.hasOwn(v, k);

/** A colour param: "RRGGBB", or null for none (color_param). */
function colorParam(r, k) {
  if (!has(r, k) || r[k] === null) return null;
  if (typeof r[k] === 'string') { const c = parseRgb(r[k]); if (c) return c; throw badParams(`\`${k}\`: bad colour \`${r[k]}\``); }
  throw badParams(`\`${k}\` is "RRGGBB" or null`);
}

/** Set `edges` of borders `b` to `line`, as the border picker does (set_edges); returns the new borders. */
export function setEdges(b0, edges, line) {
  const b = {...(b0 ?? {})};
  switch (edges) {
    case 'all': return bordersAll(line);
    case 'none': return bordersAll(NO_LINE);
    case 'outside': case 'box': return {...b, top: line, bottom: line, left: line, right: line};
    case 'inside': return {...b, between: line, inside_v: line};
    case 'top': case 'bottom': case 'left': case 'right': return {...b, [edges]: line};
    case 'insideH': return {...b, between: line};
    case 'insideV': return {...b, inside_v: line};
    default: throw badParams(`unknown border edges \`${edges}\``);
  }
}

function edgesParam(e, b) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw badParams('`borders` is true, false, null or {"edges", "style", "width", "color"}');
  let style = 'single';
  if (has(e, 'style')) {
    if (typeof e.style !== 'string') throw badParams('border `style` is a name');
    style = LINE_STYLES.find(k => k.toLowerCase() === e.style.toLowerCase());
    if (!style) throw badParams(`unknown border style \`${e.style}\``);
  }
  const width = Math.max(0.25, Math.min(6, typeof e.width === 'number' ? e.width : 0.5));
  const line = style === 'none' ? NO_LINE : mkBorder(style, width, colorParam(e, 'color'), 0);
  let edges = 'all';
  if (has(e, 'edges')) { if (typeof e.edges !== 'string') throw badParams('border `edges` is a name'); edges = e.edges; }
  return setEdges(b, edges, line);
}

/** One part's params: borders, fill, character formatting and cell alignment (region). */
function region(r, f0) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw badParams('a part is an object');
  const f = {...f0, chr: {...(f0.chr ?? {})}};
  const chr = f.chr;
  if (has(r, 'fill')) f.fill = colorParam(r, 'fill');
  if (has(r, 'color')) { const c = colorParam(r, 'color'); if (c) chr.color = {Rgb: c}; else delete chr.color; }
  if (typeof r.bold === 'boolean') { chr.bold = r.bold; chr.boldCs = r.bold; }
  if (typeof r.italic === 'boolean') { chr.italic = r.italic; chr.italicCs = r.italic; }
  if (has(r, 'underline')) {
    const u = r.underline;
    if (u === null) delete chr.underline;
    else if (typeof u === 'boolean') chr.underline = u ? 'single' : 'none';
    else if (typeof u === 'string' && (UNDERLINES.includes(u) || u === 'none')) chr.underline = u;
    else if (typeof u === 'string') throw badParams(`unknown underline "${u}"`);
    else throw badParams('`underline` is a bool or a style name');
  }
  if (typeof r.size === 'number') { chr.size = Math.max(1, Math.min(1638, r.size)); chr.sizeCs = chr.size; }
  if (has(r, 'font')) {
    if (r.font === null) delete chr.font;
    else if (typeof r.font === 'string') { const n = r.font.trim(); if (n) chr.font = [...n].slice(0, 256).join(''); else delete chr.font; } else throw badParams('`font` is a name or null');
  }
  const name = k => {
    if (!has(r, k)) return undefined;
    if (r[k] === null) return null;
    if (typeof r[k] === 'string') return r[k];
    throw badParams(`\`${k}\` is a name or null`);
  };
  const a = name('align');
  if (a !== undefined) { if (a === null) f.align = null; else { f.align = hAlign(a); if (!f.align) throw badParams(`unknown alignment \`${a}\``); } }
  const va = name('vAlign');
  if (va !== undefined) { if (va === null) f.vAlign = null; else { f.vAlign = vAlign(va); if (!f.vAlign) throw badParams(`unknown vertical alignment \`${va}\``); } }
  const ca = name('cellAlign');
  if (ca !== undefined) {
    if (ca === null) { f.align = null; f.vAlign = null; } else {
      const hit = CELL_ALIGNS.find(([k]) => k.toLowerCase() === ca.toLowerCase());
      if (!hit) throw badParams(`unknown cell alignment \`${ca}\``);
      f.align = hit[2]; f.vAlign = hit[1];
    }
  }
  if (has(r, 'borders')) {
    const bv = r.borders;
    if (bv === true) {
      const width = Math.max(0.25, Math.min(6, typeof r.borderWidth === 'number' ? r.borderWidth : 0.5));
      f.borders = bordersAll(mkBorder('single', width, colorParam(r, 'borderColor'), 0));
    } else if (bv === false) f.borders = bordersAll(NO_LINE);
    else if (bv === null) f.borders = null;
    else if (Array.isArray(bv)) { let b = f.borders ?? {}; for (const e of bv.slice(0, 64)) b = edgesParam(e, b); f.borders = b; } else f.borders = edgesParam(bv, f.borders ?? {});
  }
  return f;
}

const editPart = (st, part, r) => styleSetTablePart(st, part, region(r, styleTablePart(st, part)));

/** Apply the formatting params to style `st`; returns the new style (edit). */
function edit(st0, v) {
  let st = st0;
  for (const [key, part] of PARTS) if (has(v, key)) st = editPart(st, part, v[key]);
  if (!has(v, 'part')) {
    const k = PART_FIELDS.find(x => has(v, x));
    if (k) throw badParams(`\`${k}\` is a part field: give \`part\`, or put it in a part (\`wholeTable\`, \`headerRow\`…)`);
  } else if (typeof v.part === 'string') {
    const part = partNamed(v.part);
    if (!part) throw badParams(`no table style part \`${v.part}\``);
    st = editPart(st, part, v);
  } else throw badParams('`part` is a part name');
  if (has(v, 'parts')) {
    if (!Array.isArray(v.parts)) throw badParams('`parts` is a list');
    for (const r of v.parts.slice(0, 64)) {
      if (typeof r?.part !== 'string') throw badParams('each of `parts` names its `part`');
      const part = partNamed(r.part);
      if (!part) throw badParams(`no table style part \`${r.part}\``);
      st = editPart(st, part, r);
    }
  }
  if (has(v, 'bandSize')) {
    const parts = {...(st.table ?? {})};
    parts.bandSize = typeof v.bandSize === 'number' ? Math.max(1, Math.min(1000, Math.floor(v.bandSize))) : null;
    if (parts.bandSize === null) delete parts.bandSize;
    st = {...st, table: Object.keys(parts).length ? parts : null};
  }
  if (has(v, 'para')) {
    if (!v.para || typeof v.para !== 'object') throw badParams('para: an object');
    const para = paraOverlaid(st.para ?? {}, v.para);
    delete para.style;
    delete para.numbering;
    st = {...st, para};
  }
  return st;
}

/** The style table.newStyle would add for `v`, validated (build_new). */
function buildNew(sheet, v) {
  const name = String(v.name ?? '').trim();
  if (!name) throw badParams('name is empty');
  if (findStyle(sheet, name)) throw failed(`a style named \`${name}\` already exists`);
  let basedOn;
  if (typeof v.basedOn === 'string') { basedOn = tableStyleId(sheet, v.basedOn); if (!basedOn) throw badParams(`no table style \`${v.basedOn}\``); } else basedOn = tableStyleId(sheet, 'TableGrid') ?? tableStyleId(sheet, 'TableNormal');
  let st = makeStyle({id: newStyleId(sheet, name), name, kind: 'table', basedOn, priority: 99});
  // Bands of one row and one column unless the style it's based on sets them (#3415).
  const base = basedOn ? tableStyle(sheet, basedOn)?.parts ?? {} : {};
  if (base.bandSize === undefined || base.bandSize === null || base.colBandSize === undefined || base.colBandSize === null) {
    const parts = {...(st.table ?? {})};
    if (base.bandSize === undefined || base.bandSize === null) parts.bandSize = 1;
    if (base.colBandSize === undefined || base.colBandSize === null) parts.colBandSize = 1;
    st = {...st, table: parts};
  }
  return edit(st, v);
}

/** The table style `v` names, else the current table's (target). */
function target(S, v) {
  if (typeof v.style === 'string') {
    const id = tableStyleId(S.d.c.styles, v.style);
    if (!id) throw badParams(`no table style \`${v.style}\``);
    return id;
  }
  const cl = T.cellOfPos(S.sel.focus);
  const id = cl ? S.d.table(S.sel.focus.story, cl[0])?.props?.style ?? null : null;
  if (!id) throw T.disabled('the cursor isn\'t in a table with a style');
  return id;
}

/** The style table.modifyStyle would store for `v`, validated (build_modified). */
function buildModified(S, v) {
  const sheet = S.d.c.styles;
  const id = target(S, v);
  const rename = typeof v.name === 'string' && v.name.trim() ? v.name.trim() : null;
  if (rename) { const other = findStyle(sheet, rename); if (other && other.id !== id) throw failed(`a style named \`${rename}\` already exists`); }
  let basedOn = null;
  if (typeof v.basedOn === 'string') {
    basedOn = tableStyleId(sheet, v.basedOn);
    if (!basedOn) throw badParams(`no table style \`${v.basedOn}\``);
    if (chain(sheet, basedOn).some(x => x.id === id)) throw badParams('a style can\'t be based on itself');
  }
  let st = getStyle(sheet, id);
  if (!st) throw badParams('no such style');
  st = {...st};
  if (rename) st.name = rename;
  if (basedOn) st.basedOn = basedOn;
  return edit(st, v);
}

/** Apply style `id` to the table at the caret, if any (apply). */
function applyTo(S, id) {
  const cl = T.cellOfPos(S.sel.focus);
  if (!cl) return;
  S.d.updateTable(S.sel.focus.story, cl[0], t => ({...t, props: {...(t.props ?? {}), style: id}}));
}

/**
 * How a table style would look with the formatting params of table.modifyStyle / table.newStyle
 * applied, for the dialog's live preview (preview); null when the params don't validate.
 */
export function previewStyle(ctx, v) {
  if (!v || typeof v !== 'object') return null;
  try {
    const S = T.open(ctx);
    let st;
    if (typeof v.style === 'string') { const w = {...v}; delete w.name; st = buildModified(S, w); } else st = buildNew(S.d.c.styles, {...v, name: '\u0001preview'});
    const sheet = upsertStyle(S.d.c.styles, st);
    return tableStyle(sheet, st.id);
  } catch { return null; }
}

/** Whether `st` is one of Word's built-in table styles (is_builtin_table_style). */
export function isBuiltinTableStyle(st) {
  return !!st.builtin || ['tablegrid', 'tablenormal'].includes(st.id.toLowerCase()) || ['table grid', 'normal table', 'table normal'].includes(st.name.toLowerCase());
}

const MAX_DEPTH = 32;
function usesStyle(t, id, depth) {
  return t.props?.style === id || (depth < MAX_DEPTH && t.rows.some(r => r.cells.some(c => c.blocks.some(b => b.kind === 'table' && usesStyle(b, id, depth + 1)))));
}
/** Give every table in `blocks` that uses style `from` style `to`: [blocks, count] (restyle). */
function restyle(blocks, from, to, depth) {
  let n = 0;
  const out = blocks.map(b => {
    if (b.kind !== 'table' || !usesStyle(b, from, depth)) return b;
    let t = b;
    if (t.props?.style === from) { const props = {...t.props}; if (to) props.style = to; else delete props.style; t = {...t, props}; n++; }
    if (depth < MAX_DEPTH) {
      t = {...t, rows: t.rows.map(r => ({...r, cells: r.cells.map(c => { const [bl, k] = restyle(c.blocks, from, to, depth + 1); n += k; return k ? {...c, blocks: bl} : c; })}))};
    }
    return t;
  });
  return [out, n];
}

/** Delete table style `id` (delete): children re-based with its formatting folded in, tables fall back to Table Grid. */
export function deleteTableStyle(S, id) {
  const sheet = S.d.c.styles;
  const st = getStyle(sheet, id);
  if (!st) throw badParams('no such style');
  if (st.kind !== 'table') throw badParams(`\`${st.name}\` isn't a table style`);
  if (isBuiltinTableStyle(st)) throw failed(`\`${st.name}\` is a built-in table style and can't be deleted`);
  const rebased = [];
  const styles = sheet.styles.filter(x => x.id !== id).map(child => {
    if (child.basedOn !== id) return child;
    const out = {...child, para: paraOverlaid(st.para ?? {}, child.para ?? {}), chr: charOverlaid(st.chr ?? {}, child.chr ?? {}), basedOn: st.basedOn ?? null};
    if (child.kind === 'table') {
      const parts = child.table ? tablePartsOverlaid(st.table ?? {}, child.table) : {...(st.table ?? {})};
      out.table = Object.keys(parts).length && !same(parts, {}) ? parts : null;
    }
    rebased.push(child.id);
    return out;
  });
  S.d.setField('styles', {...sheet, styles});
  const fallback = tableStyleId(S.d.c.styles, 'TableGrid');
  let tables = 0;
  const body = S.d.story('body');
  for (let i = 0; i < body.len(); i++) {
    const b = body.get(i);
    if (b.kind !== 'table' || !usesStyle(b, id, 0)) continue;
    const [[nb], k] = restyle([b], id, fallback, 0);
    S.d.setBlock('body', [i], nb);
    tables += k;
  }
  for (const pid of Object.keys(S.d.c.parts).map(Number)) {
    const part = S.d.c.parts[pid];
    if (!part.blocks.some(b => b.kind === 'table' && usesStyle(b, id, 0))) continue;
    part.blocks.forEach((b, i) => {
      if (b.kind !== 'table' || !usesStyle(b, id, 0)) return;
      const [[nb], k] = restyle([b], id, fallback, 0);
      S.d.setBlock(pid, [i], nb);
      tables += k;
    });
  }
  return {deleted: id, tables, rebased};
}

const STYLE_PARAMS = {basedOn: s.optional(s.string({max: 256})), part: s.optional(s.string()), parts: s.optional(s.array(s.any(), {max: 64})),
  bandSize: s.optional(s.integer({min: 1, max: 1000})), para: s.optional(s.any()), apply: s.optional(s.boolean()),
  ...Object.fromEntries(PARTS.map(([k]) => [k, s.optional(s.any())])), ...Object.fromEntries(PART_FIELDS.map(k => [k, s.optional(s.any())]))};

const tableStyleState = ctx => {
  const st = T.ready(ctx);
  if (!st.enabled) return st;
  return st;
};

export default defineCommands({
  family: 'table_style',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'table.newStyle', label: 'New Table Style', risk: 'edit', dialog: 'dialog.tableStyle', state: tableStyleState,
      description: 'New Table Style (Table Design › Table Styles): a table style with formatting per part (whole table, header row, banded rows…), applied to the caret\'s table.',
      params: s.object({name: s.string({min: 1, max: 256}), ...STYLE_PARAMS}),
      run(ctx, v) {
        const S = T.open(ctx);
        const st = buildNew(S.d.c.styles, v);
        S.d.setField('styles', upsertStyle(S.d.c.styles, st));
        if (v.apply ?? true) applyTo(S, st.id);
        T.finish(S);
        return {id: st.id};
      }},
    {id: 'table.modifyStyle', label: 'Modify Table Style', risk: 'edit', dialog: 'dialog.modifyTableStyle',
      description: 'Modify Table Style (Table Design › Table Styles): change a table style\'s formatting per part (default: the caret table\'s style).',
      params: s.object({style: s.optional(s.string({max: 256})), name: s.optional(s.string({max: 256})), ...STYLE_PARAMS}),
      state(ctx) {
        const st = T.ready(ctx);
        if (!st.enabled) return st;
        try { target(T.open(ctx), {}); return st; } catch (e) { return {enabled: false, reason: e.message}; }
      },
      run(ctx, v) {
        const S = T.open(ctx);
        const st = buildModified(S, v);
        S.d.setField('styles', upsertStyle(S.d.c.styles, st));
        if (v.apply ?? false) applyTo(S, st.id);
        T.finish(S);
        return {id: st.id};
      }},
    {id: 'table.deleteStyle', label: 'Delete Table Style', risk: 'edit',
      description: 'Delete Table Style (Table Design › Table Styles): a custom table style goes; tables using it take Table Grid.',
      params: s.object({style: s.optional(s.string({max: 256}))}),
      state(ctx) {
        const st = T.ready(ctx);
        if (!st.enabled) return st;
        try {
          const S = T.open(ctx);
          const id = target(S, {});
          const x = getStyle(S.d.c.styles, id);
          return x && isBuiltinTableStyle(x) ? {enabled: false, reason: `\`${x.name}\` is a built-in table style and can't be deleted`} : st;
        } catch (e) { return {enabled: false, reason: e.message}; }
      },
      run(ctx, v) {
        const S = T.open(ctx);
        const out = deleteTableStyle(S, target(S, v ?? {}));
        T.finish(S);
        return out;
      }},
  ],
});
