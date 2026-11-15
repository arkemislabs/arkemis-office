// Home › Font: Bold, Italic, Underline (single, double, accounting), Strikethrough, Superscript,
// Subscript, Font, Font Size, Increase/Decrease Font Size, Font Color, Fill Color, Borders, and the
// Format Cells… command (Cells › Format, Ctrl+1) that applies a partial style.
// Translated from gridcraft crates/engine/src/cmd/format.rs (`toggle`, `underline`, `font_name`,
// `font_size`, `step_font`, `font_color`, `fill_color`, `border_style`, `borders`, `format_cells`,
// `snake_case_keys`, `merge_json`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Toggles read the active cell's style (gridcraft `active_style`), never the whole range, as Excel
// does. Every command writes schema-2 style ids (core/grid/lib/format-ranges.mjs `applyStyle`).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import {MAX_ROWS, MAX_COLS, count} from '../../lib/addr.mjs';
import {isLegacySheet} from '../../model/store.mjs';
import {applyStyle, activeStyle, colorParam, deriveWith, protectionOf, PROTECTED, cloneStyle, styleOfId} from '../../lib/format-ranges.mjs';
import {RANGE, SHEET, ON, COLOR, UPSTREAM_COMMIT, withDoc} from '../../lib/format-params.mjs';
import {targetRanges, areaAddress, bad, failed, baseDoc} from '../../lib/edit-targets.mjs';
import {cellAt, writeCell} from '../../model/store.mjs';
import {styleIdAt} from '../../model/workbook.mjs';
import {mergeStyle} from '../../model/style.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/format.rs']};
export const UNDERLINE_STYLES = Object.freeze(['single', 'double', 'singleAccounting', 'doubleAccounting']);
/** format.rs SIZES: the steps Increase/Decrease Font Size walk. */
export const FONT_STEPS = Object.freeze([8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72, 96, 409]);
export const BORDER_PRESETS = Object.freeze(['bottom', 'top', 'left', 'right', 'none', 'all', 'outside', 'thickOutside', 'thickBottom', 'doubleBottom',
  'topBottom', 'topThickBottom', 'topDoubleBottom', 'insideHorizontal', 'insideVertical', 'inside', 'diagonalDown', 'diagonalUp']);
export const BORDER_STYLES = Object.freeze(['none', 'thin', 'medium', 'thick', 'dashed', 'dotted', 'double', 'hair', 'mediumDashed', 'dashDot',
  'mediumDashDot', 'dashDotDot', 'mediumDashDotDot', 'slantDashDot']);

const ranges = (ctx, t) => t.areas.map(a => areaAddress(ctx.doc, t.sheet, a));

/** gridcraft `toggle`. */
function toggle(id, label, shortcut, get, set, description) {
  return {
    id, label, shortcut, risk: 'edit',
    description,
    params: s.object({range: RANGE, sheet: SHEET, on: ON}),
    state: ctx => withDoc(ctx, () => ({checked: !!get(activeStyle(ctx))})),
    run(ctx, p) {
      const on = p.on ?? !get(activeStyle(ctx));
      const t = applyStyle(ctx, p, st => set(st, on));
      return {on, ranges: ranges(ctx, t)};
    },
  };
}

/** gridcraft `underline`. */
function underline(ctx, p) {
  const style = p.style === 'none' ? 'none' : UNDERLINE_STYLES.includes(p.style) ? p.style : 'single';
  const cur = activeStyle(ctx).font.underline ?? 'none';
  const on = p.on ?? cur !== style;
  const u = on ? style : 'none';
  const t = applyStyle(ctx, p, st => { st.font.underline = u; });
  return {on, style: u, ranges: ranges(ctx, t)};
}

/** format.rs `border_style`: unknown names are Thin. */
export const borderStyle = name => (BORDER_STYLES.includes(name) ? name : 'thin');

/** gridcraft `borders`: a border preset over every targeted cell. */
function borders(ctx, p) {
  baseDoc(ctx);
  const preset = p.preset ?? 'bottom';
  const c = colorParam(p.color);
  const color = c === undefined ? null : c;
  const base = borderStyle(p.style ?? 'thin');
  const t = targetRanges(ctx, p);
  const si = t.sheet;
  const sheet0 = ctx.doc.sheets[si];
  const prot = protectionOf(sheet0);
  if (prot && !prot.formatCells) throw failed(PROTECTED);
  if (isLegacySheet(sheet0)) {
    // The legacy editor's cells take the same preset through applyStyle (no neighbours to clear).
    applyStyle(ctx, p, st => presetOn(st.borders, preset, base, color, true, true, true, true));
    return {preset, ranges: ranges(ctx, t)};
  }
  const line = st => (st === 'none' ? null : color ? {style: st, color} : {style: st});
  for (const r of t.areas) {
    if (count(r) > 2_000_000) throw bad('home.borders', 'selection too large');
    for (let row = r.start.row; row <= r.end.row; row++) {
      for (let col = r.start.col; col <= r.end.col; col++) {
        const top = row === r.start.row, bottom = row === r.end.row, left = col === r.start.col, right = col === r.end.col;
        const sh = ctx.doc.sheets[si];
        const st = styleIdAt(sh, row, col);
        const n = deriveWith(ctx, st, s0 => presetOn(s0.borders, preset, base, color, top, bottom, left, right, line));
        if (n !== st) writeCell(ctx.change, ctx.doc, si, row, col, {...(cellAt(sh, row, col) ?? {}), s: n});
        if (preset === 'none') {
          // A shared line can be stored on either cell. Selected cells are handled by this loop;
          // remove only facing edges outside this range.
          for (const [boundary, dr, dc, edge] of [[top, -1, 0, 'bottom'], [bottom, 1, 0, 'top'], [left, 0, -1, 'right'], [right, 0, 1, 'left']]) {
            if (!boundary) continue;
            const nr = row + dr, nc = col + dc;
            if (nr < 0 || nc < 0 || nr >= MAX_ROWS || nc >= MAX_COLS) continue;
            const sh2 = ctx.doc.sheets[si];
            const ns = styleIdAt(sh2, nr, nc);
            const nn = deriveWith(ctx, ns, s0 => { s0.borders[edge] = null; });
            if (nn !== ns) writeCell(ctx.change, ctx.doc, si, nr, nc, {...(cellAt(sh2, nr, nc) ?? {}), s: nn});
          }
        }
      }
    }
  }
  return {preset, ranges: ranges(ctx, t)};
}

function presetOn(b, preset, base, color, top, bottom, left, right, line0) {
  const line = line0 ?? (st => (st === 'none' ? null : color ? {style: st, color} : {style: st}));
  switch (preset) {
    case 'none': for (const k of Object.keys(b)) b[k] = null; break;
    case 'all': b.top = line(base); b.bottom = line(base); b.left = line(base); b.right = line(base); break;
    case 'outside': case 'thickOutside': {
      const st = preset === 'thickOutside' ? 'thick' : base;
      if (top) b.top = line(st);
      if (bottom) b.bottom = line(st);
      if (left) b.left = line(st);
      if (right) b.right = line(st);
      break;
    }
    case 'inside': case 'insideHorizontal': case 'insideVertical':
      if (preset !== 'insideVertical') { if (!top) b.top = line(base); if (!bottom) b.bottom = line(base); }
      if (preset !== 'insideHorizontal') { if (!left) b.left = line(base); if (!right) b.right = line(base); }
      break;
    case 'top': if (top) b.top = line(base); break;
    case 'bottom': if (bottom) b.bottom = line(base); break;
    case 'left': if (left) b.left = line(base); break;
    case 'right': if (right) b.right = line(base); break;
    case 'thickBottom': if (bottom) b.bottom = line('thick'); break;
    case 'doubleBottom': if (bottom) b.bottom = line('double'); break;
    case 'topBottom': if (top) b.top = line(base); if (bottom) b.bottom = line(base); break;
    case 'topThickBottom': if (top) b.top = line(base); if (bottom) b.bottom = line('thick'); break;
    case 'topDoubleBottom': if (top) b.top = line(base); if (bottom) b.bottom = line('double'); break;
    case 'diagonalDown': b.diagDown = line(base); break;
    case 'diagonalUp': b.diagUp = line(base); break;
    default: break;
  }
}

// ---------------------------------------------------------------------------------------------
// Format Cells: a partial style merged in

const ENUMS = {
  underline: UNDERLINE_STYLES.concat('none'),
  vert: ['baseline', 'superscript', 'subscript'],
  h: ['general', 'left', 'center', 'right', 'fill', 'justify', 'centerAcross', 'distributed'],
  v: ['top', 'center', 'bottom', 'justify', 'distributed'],
  pattern: ['none', 'solid', 'mediumGray', 'darkGray', 'lightGray', 'darkHorizontal', 'darkVertical', 'darkDown', 'darkUp', 'darkGrid', 'darkTrellis',
    'lightHorizontal', 'lightVertical', 'lightDown', 'lightUp', 'lightGrid', 'lightTrellis', 'gray125', 'gray0625'],
};
/** format.rs `snake_case_keys` the other way: the documented camelCase and the style's snake_case both reach the model's keys. */
const camel = k => (/^[a-z]/.test(k) ? k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()) : k);
const enumValue = (kind, v, path) => {
  if (typeof v !== 'string') throw bad('home.formatCells', `${path}: expected text`);
  const hit = ENUMS[kind].find(x => x.toLowerCase() === v.replace(/[_\s-]/g, '').toLowerCase());
  if (!hit) throw bad('home.formatCells', `${path}: unknown value ${JSON.stringify(v)}`);
  return hit;
};
const color = (v, path) => {
  if (v === null) return null;
  const c = colorParam(v);
  if (c === undefined) throw bad('home.formatCells', `${path}: not a colour`);
  return c;
};
const bool = (v, path) => { if (typeof v !== 'boolean') throw bad('home.formatCells', `${path}: expected true or false`); return v; };
const number = (v, path, lo, hi) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw bad('home.formatCells', `${path}: expected a number from ${lo} to ${hi}`);
  return v;
};
function borderLine(v, path) {
  if (v === null) return null;
  if (typeof v !== 'object') throw bad('home.formatCells', `${path}: expected {style, color?}`);
  const out = {};
  for (const [k0, x] of Object.entries(v)) {
    const k = camel(k0);
    if (k === 'style') {
      const st = BORDER_STYLES.find(n => n.toLowerCase() === String(x).toLowerCase());
      if (!st) throw bad('home.formatCells', `${path}.style: unknown border style ${JSON.stringify(x)}`);
      out.style = st;
    } else if (k === 'color') out.color = color(x, `${path}.color`);
    else throw bad('home.formatCells', `${path}: unknown key ${k0}`);
  }
  return out;
}
/** Validates a partial style (camelCase or snake_case keys) into the model's shape. */
export function normalizeStylePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('home.formatCells', 'style: expected an object');
  const out = {};
  for (const [k0, v] of Object.entries(patch)) {
    const k = camel(k0);
    const path = `style.${k}`;
    if (k === 'numFmt') {
      if (typeof v !== 'string' || !v || v.length > 255) throw bad('home.formatCells', `${path}: a format code of 1 to 255 characters`);
      out.numFmt = v;
      continue;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('home.formatCells', `${path}: expected an object`);
    const part = {};
    for (const [j0, x] of Object.entries(v)) {
      const j = camel(j0);
      const at = `${path}.${j}`;
      switch (`${k}.${j}`) {
        case 'font.name': if (typeof x !== 'string' || !x.trim() || x.length > 200) throw bad('home.formatCells', `${at}: a font name`); part.name = x; break;
        case 'font.size': part.size = Math.round(number(x, at, 1, 409) * 2) / 2; break;
        case 'font.bold': case 'font.italic': case 'font.strike': case 'align.wrap': case 'align.shrink':
        case 'protection.locked': case 'protection.hidden': part[j] = bool(x, at); break;
        case 'font.underline': part.underline = enumValue('underline', x, at); break;
        case 'font.vert': part.vert = enumValue('vert', x, at); break;
        case 'font.color': part.color = color(x, at); break;
        case 'fill.pattern': part.pattern = enumValue('pattern', x, at); break;
        case 'fill.fg': case 'fill.bg': part[j] = color(x, at); break;
        case 'align.h': part.h = enumValue('h', x, at); break;
        case 'align.v': part.v = enumValue('v', x, at); break;
        case 'align.indent': part.indent = Math.trunc(number(x, at, 0, 250)); break;
        case 'align.rotation': part.rotation = x === 255 ? 255 : Math.trunc(number(x, at, -90, 90)); break;
        default:
          if (k === 'borders' && ['left', 'right', 'top', 'bottom', 'diagDown', 'diagUp'].includes(j)) { part[j] = borderLine(x, at); break; }
          throw bad('home.formatCells', `${at}: unknown style key`);
      }
    }
    if (!['font', 'fill', 'borders', 'align', 'protection'].includes(k)) throw bad('home.formatCells', `${path}: unknown style key`);
    out[k] = part;
  }
  return out;
}
/** Merges a normalized patch into a full style (objects merge, values replace). */
export function mergeInto(st, patch) {
  const next = mergeStyle(st, patch);
  for (const k of ['font', 'fill', 'borders', 'align', 'protection']) st[k] = next[k];
  st.numFmt = next.numFmt;
  if (patch.fill && patch.fill.pattern === undefined && (patch.fill.fg || patch.fill.bg) && st.fill.pattern === 'none') st.fill.pattern = 'solid';
}

function formatCells(ctx, p) {
  const patch = normalizeStylePatch(p.style);
  // Validate by merging into the active style once.
  mergeInto(cloneStyle(activeStyle(ctx)), patch);
  const t = applyStyle(ctx, p, st => mergeInto(st, patch));
  return {ranges: ranges(ctx, t)};
}

const sizeOf = (ctx, p) => {
  const v = p.size ?? p.value;
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  if (n === undefined || n === null || (typeof v === 'string' && v.trim() === '')) throw bad('home.fontSize', 'missing `size`');
  if (!Number.isFinite(n) || n < 1 || n > 409) throw new CommandError('invalid_params', 'The number must be between 1 and 409.', {path: '/size'});
  return Math.round(n * 2) / 2;
};

export default defineCommands({
  family: 'format/font',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    toggle('home.bold', 'Bold', ['Mod+B', 'Ctrl+2'], st => st.font.bold, (st, v) => { st.font.bold = v; }, 'Bold on or off for a range (default: the selection).'),
    toggle('home.italic', 'Italic', ['Mod+I', 'Ctrl+3'], st => st.font.italic, (st, v) => { st.font.italic = v; }, 'Italic on or off for a range (default: the selection).'),
    {
      id: 'home.underline', label: 'Underline', shortcut: ['Mod+U', 'Ctrl+4'], risk: 'edit',
      description: 'Underline a range (default: the selection): single, double or an accounting style.',
      params: s.object({range: RANGE, sheet: SHEET, on: ON, style: s.optional(s.enum([...UNDERLINE_STYLES, 'none']))}),
      state: ctx => withDoc(ctx, () => { const u = activeStyle(ctx).font.underline; return {checked: !!u && u !== 'none', value: u && u !== 'none' ? u : null}; }),
      run: underline,
    },
    {
      id: 'home.doubleUnderline', label: 'Double Underline', risk: 'edit',
      description: 'Double underline on or off for a range (default: the selection).',
      params: s.object({range: RANGE, sheet: SHEET, on: ON}),
      state: ctx => withDoc(ctx, () => ({checked: activeStyle(ctx).font.underline === 'double'})),
      run: (ctx, p) => underline(ctx, {...p, style: 'double'}),
    },
    toggle('home.strikethrough', 'Strikethrough', ['Mod+Shift+X', 'Ctrl+5'], st => st.font.strike, (st, v) => { st.font.strike = v; },
      'Strikethrough on or off for a range (default: the selection).'),
    toggle('home.superscript', 'Superscript', undefined, st => st.font.vert === 'superscript', (st, v) => { st.font.vert = v ? 'superscript' : 'baseline'; },
      'Superscript on or off for a range (default: the selection).'),
    toggle('home.subscript', 'Subscript', undefined, st => st.font.vert === 'subscript', (st, v) => { st.font.vert = v ? 'subscript' : 'baseline'; },
      'Subscript on or off for a range (default: the selection).'),
    {
      id: 'home.fontName', label: 'Font', risk: 'edit',
      description: 'Set the font of a range (default: the selection).',
      params: s.object({range: RANGE, sheet: SHEET, name: s.optional(s.string({min: 1, max: 200})), value: s.optional(s.string({min: 1, max: 200}))}),
      state: ctx => withDoc(ctx, () => ({value: activeStyle(ctx).font.name})),
      run(ctx, p) {
        const name = (p.name ?? p.value ?? '').trim();
        if (!name) throw bad('home.fontName', 'missing `name`');
        const t = applyStyle(ctx, p, st => { st.font.name = name; });
        return {name, ranges: ranges(ctx, t)};
      },
    },
    {
      id: 'home.fontSize', label: 'Font Size', risk: 'edit',
      description: 'Set the font size (1 to 409 points, in halves) of a range (default: the selection).',
      params: s.object({range: RANGE, sheet: SHEET, size: s.optional(s.number()), value: s.optional(s.union([s.number(), s.string({max: 20})]))}),
      state: ctx => withDoc(ctx, () => ({value: String(activeStyle(ctx).font.size)})),
      run(ctx, p) {
        const size = sizeOf(ctx, p);
        const t = applyStyle(ctx, p, st => { st.font.size = size; });
        return {size, ranges: ranges(ctx, t)};
      },
    },
    ...[['home.increaseFontSize', 'Increase Font Size', 'Mod+Shift+>', true], ['home.decreaseFontSize', 'Decrease Font Size', 'Mod+Shift+<', false]].map(([id, label, shortcut, up]) => ({
      id, label, shortcut, risk: 'edit',
      description: `${up ? 'Make the text bigger' : 'Make the text smaller'}: the next size in the list after the active cell's.`,
      params: s.object({range: RANGE, sheet: SHEET}),
      state: ctx => withDoc(ctx, () => ({})),
      run(ctx, p) {
        const cur = activeStyle(ctx).font.size;
        const next = up ? FONT_STEPS.find(x => x > cur) ?? 409 : [...FONT_STEPS].reverse().find(x => x < cur) ?? 1;
        const t = applyStyle(ctx, p, st => { st.font.size = next; });
        return {size: next, ranges: ranges(ctx, t)};
      },
    })),
    {
      id: 'home.fontColor', label: 'Font Color', risk: 'edit',
      description: 'Set the text colour of a range (default: the selection): "#C00000", "auto" or a theme colour {theme, tint}.',
      params: s.object({range: RANGE, sheet: SHEET, color: COLOR}),
      state: ctx => withDoc(ctx, () => ({value: activeStyle(ctx).font.color ?? null})),
      run(ctx, p) {
        const c = colorParam(p.color);
        if (c === undefined) throw bad('home.fontColor', 'missing or invalid `color`');
        const t = applyStyle(ctx, p, st => { st.font.color = c; });
        return {color: c, ranges: ranges(ctx, t)};
      },
    },
    {
      id: 'home.fillColor', label: 'Fill Color', risk: 'edit',
      description: 'Fill a range (default: the selection) with a colour, or "none" for No Fill.',
      params: s.object({range: RANGE, sheet: SHEET, color: COLOR}),
      state: ctx => withDoc(ctx, () => { const f = activeStyle(ctx).fill; return {value: f.pattern === 'solid' ? f.fg ?? null : null}; }),
      run(ctx, p) {
        const c = colorParam(p.color);
        if (c === undefined) throw bad('home.fillColor', 'missing or invalid `color`');
        const t = applyStyle(ctx, p, st => { st.fill = c === null ? {pattern: 'none', fg: null, bg: null} : {pattern: 'solid', fg: c, bg: null}; });
        return {color: c, ranges: ranges(ctx, t)};
      },
    },
    {
      id: 'home.borders', label: 'Borders', risk: 'edit',
      description: 'Apply a border preset (bottom, all, outside, thickOutside, none, ...) to a range (default: the selection), with a line style and colour.',
      params: s.object({range: RANGE, sheet: SHEET, preset: s.optional(s.enum(BORDER_PRESETS)), style: s.optional(s.enum(BORDER_STYLES)), color: s.optional(COLOR)}),
      state: ctx => withDoc(ctx, () => ({})),
      run: borders,
    },
    {
      id: 'home.formatCells', label: 'Format Cells…', shortcut: 'Mod+1', risk: 'edit', dialog: 'dialog.formatCells',
      description: 'Apply a partial style {font?, fill?, borders?, align?, numFmt?, protection?} to a range (default: the selection); without it the Format Cells dialog opens.',
      params: s.object({range: RANGE, sheet: SHEET, style: s.record(s.any())}),
      state: ctx => withDoc(ctx, () => ({})),
      run: formatCells,
    },
  ],
});

export {styleOfId};
