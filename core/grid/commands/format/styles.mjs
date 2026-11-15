// Home › Styles › Cell Styles: the built-in cell styles (Good, Bad and Neutral; Data and Model;
// Titles and Headings; Themed Cell Styles; Number Format) and the workbook's own styles.
// Translated from gridcraft crates/engine/src/cmd/format/cell_styles.rs (`builtin_cell_style`,
// `CELL_STYLE_NAMES`, `cell_style`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Applying a style replaces the cell's look but keeps its number format unless the style sets
// one; the Number Format styles (Comma, Currency, Percent...) change only the number format.
// The workbook's own styles (New Cell Style…, U:grid/extra) live in `content.cellStyles`
// ({name, style}[], style in the model's sparse shape) and win over a built-in of the same name.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {applyStyle} from '../../lib/format-ranges.mjs';
import {RANGE, SHEET, UPSTREAM_COMMIT, withDoc} from '../../lib/format-params.mjs';
import {areaAddress, bad} from '../../lib/edit-targets.mjs';
import {resolveStyle, DEFAULT_THEME} from '../../model/style.mjs';
import {ACCOUNTING, COMMA} from './number.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/format/cell_styles.rs']};

export const CELL_STYLE_NAMES = Object.freeze([
  'Normal', 'Bad', 'Good', 'Neutral',
  'Calculation', 'Check Cell', 'Explanatory Text', 'Input', 'Linked Cell', 'Note', 'Output', 'Warning Text',
  'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Title', 'Total',
  '20% - Accent1', '20% - Accent2', '20% - Accent3', '20% - Accent4', '20% - Accent5', '20% - Accent6',
  '40% - Accent1', '40% - Accent2', '40% - Accent3', '40% - Accent4', '40% - Accent5', '40% - Accent6',
  '60% - Accent1', '60% - Accent2', '60% - Accent3', '60% - Accent4', '60% - Accent5', '60% - Accent6',
  'Accent1', 'Accent2', 'Accent3', 'Accent4', 'Accent5', 'Accent6',
  'Comma', 'Comma [0]', 'Currency', 'Currency [0]', 'Percent',
]);
/** The gallery's sections (galleries.rs), in order. */
export const CELL_STYLE_GROUPS = Object.freeze([
  ['Good, Bad and Neutral', ['Normal', 'Bad', 'Good', 'Neutral']],
  ['Data and Model', ['Calculation', 'Check Cell', 'Explanatory Text', 'Input', 'Linked Cell', 'Note', 'Output', 'Warning Text']],
  ['Titles and Headings', ['Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Title', 'Total']],
  ['Themed Cell Styles', CELL_STYLE_NAMES.filter(n => /Accent/.test(n))],
  ['Number Format', ['Comma', 'Comma [0]', 'Currency', 'Currency [0]', 'Percent']],
]);
const NUMBER_ONLY = new Set(['Comma', 'Comma [0]', 'Currency', 'Currency [0]', 'Percent']);

const rgb = (r, g, b) => `#${[r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const theme = (i, tint = 0) => (tint ? {theme: i, tint: tint / 1000} : {theme: i});
const box = (style, color) => ({left: {style, color}, right: {style, color}, top: {style, color}, bottom: {style, color}});

/** cell_styles.rs `builtin_cell_style`: the sparse style of a built-in name, or null. */
export function builtinCellStyle(name, th = DEFAULT_THEME) {
  const solid = c => ({pattern: 'solid', fg: c});
  switch (name) {
    case 'Normal': return {};
    case 'Good': return {fill: solid(rgb(0xC6, 0xEF, 0xCE)), font: {color: rgb(0x00, 0x61, 0x00)}};
    case 'Bad': return {fill: solid(rgb(0xFF, 0xC7, 0xCE)), font: {color: rgb(0x9C, 0x00, 0x06)}};
    case 'Neutral': return {fill: solid(rgb(0xFF, 0xEB, 0x9C)), font: {color: rgb(0x9C, 0x57, 0x00)}};
    case 'Calculation': return {fill: solid(rgb(0xF2, 0xF2, 0xF2)), font: {color: rgb(0xFA, 0x7D, 0x00), bold: true}, borders: box('thin', rgb(0x7F, 0x7F, 0x7F))};
    case 'Check Cell': return {fill: solid(rgb(0xA5, 0xA5, 0xA5)), font: {color: rgb(0xFF, 0xFF, 0xFF), bold: true}, borders: box('double', rgb(0x3F, 0x3F, 0x3F))};
    case 'Explanatory Text': return {font: {italic: true, color: rgb(0x7F, 0x7F, 0x7F)}};
    case 'Input': return {fill: solid(rgb(0xFF, 0xCC, 0x99)), font: {color: rgb(0x3F, 0x3F, 0x76)}, borders: box('thin', rgb(0x7F, 0x7F, 0x7F))};
    case 'Linked Cell': return {font: {color: rgb(0xFA, 0x7D, 0x00)}, borders: {bottom: {style: 'double', color: rgb(0xFF, 0x80, 0x01)}}};
    case 'Note': return {fill: solid(rgb(0xFF, 0xFF, 0xCC)), borders: box('thin', rgb(0xB2, 0xB2, 0xB2))};
    case 'Output': return {fill: solid(rgb(0xF2, 0xF2, 0xF2)), font: {color: rgb(0x3F, 0x3F, 0x3F), bold: true}, borders: box('thin', rgb(0x3F, 0x3F, 0x3F))};
    case 'Warning Text': return {font: {color: rgb(0xFF, 0x00, 0x00)}};
    case 'Title': return {font: {size: 18, color: theme(3), name: th.majorFont ?? DEFAULT_THEME.majorFont}};
    case 'Heading 1': return {font: {size: 15, bold: true, color: theme(3)}, borders: {bottom: {style: 'thick', color: theme(4)}}};
    case 'Heading 2': return {font: {size: 13, bold: true, color: theme(3)}, borders: {bottom: {style: 'thick', color: theme(4, 500)}}};
    case 'Heading 3': return {font: {bold: true, color: theme(3)}, borders: {bottom: {style: 'medium', color: theme(4, 400)}}};
    case 'Heading 4': return {font: {bold: true, color: theme(3)}};
    case 'Total': return {font: {bold: true}, borders: {top: {style: 'thin', color: theme(4)}, bottom: {style: 'double', color: theme(4)}}};
    case 'Currency': return {numFmt: ACCOUNTING};
    case 'Comma': return {numFmt: COMMA};
    case 'Percent': return {numFmt: '0%'};
    case 'Currency [0]': return {numFmt: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)'};
    case 'Comma [0]': return {numFmt: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)'};
    default: {
      // AccentN, 20%/40%/60% - AccentN
      const m = /^(?:(\d+)% - )?Accent(\d+)$/.exec(String(name));
      if (!m) return null;
      const i = Number(m[2]);
      if (!(i >= 1 && i <= 6)) return null;
      if (m[1] === undefined) return {fill: solid(theme(3 + i)), font: {color: theme(0)}};
      const pct = Number(m[1]);
      return {fill: solid(theme(3 + i, Math.max(0, Math.min(1000, 1000 - pct * 10)))), font: {color: pct >= 60 ? theme(0) : theme(1)}};
    }
  }
}

/** The style a name applies: the workbook's own first (case-insensitive), else the built-in. */
export function cellStyleNamed(content, name) {
  const own = (Array.isArray(content?.cellStyles) ? content.cellStyles : []).find(x => String(x?.name ?? '').toLowerCase() === String(name).toLowerCase());
  if (own) return own.style ?? {};
  const builtin = CELL_STYLE_NAMES.find(n => n.toLowerCase() === String(name).toLowerCase());
  return builtinCellStyle(builtin ?? name, content?.theme ?? DEFAULT_THEME);
}

/** The parts a workbook style of this name sets (New Cell Style > Style Includes), or null for all of them. */
export function cellStyleIncludes(content, name) {
  const own = (Array.isArray(content?.cellStyles) ? content.cellStyles : []).find(x => String(x?.name ?? '').toLowerCase() === String(name).toLowerCase());
  return Array.isArray(own?.includes) ? own.includes : null;
}

/** Gallery items: the workbook's own styles (Custom), then the built-ins. */
export function cellStyleItems(content) {
  const own = (Array.isArray(content?.cellStyles) ? content.cellStyles : []).map(x => ({id: x.name, label: x.name, value: x.name, group: 'Custom'}));
  const builtins = CELL_STYLE_GROUPS.flatMap(([group, names]) => names.map(n => ({id: n, label: n, value: n, group})));
  return [...own, ...builtins];
}

export default defineCommands({
  family: 'format/styles',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'home.cellStyle', label: 'Cell Styles', risk: 'edit',
      description: 'Apply a cell style (Good, Bad, Neutral, Heading 1, Title, Total, Accent1..6, 20%/40%/60% - AccentN, Comma, Currency, Percent, Normal, or a workbook style) to a range (default: the selection).',
      params: s.object({range: RANGE, sheet: SHEET, name: s.optional(s.string({min: 1, max: 255})), value: s.optional(s.string({min: 1, max: 255}))}),
      state: ctx => withDoc(ctx, () => ({value: cellStyleItems(ctx.doc)})),
      run(ctx, p) {
        const name = p.name ?? p.value ?? 'Normal';
        const sparse = cellStyleNamed(ctx.doc, name);
        if (!sparse) throw bad('home.cellStyle', `unknown cell style \`${name}\``);
        const style = resolveStyle(sparse);
        // Number-format styles only change the number format.
        const onlyFmt = NUMBER_ONLY.has(CELL_STYLE_NAMES.find(n => n.toLowerCase() === name.toLowerCase()) ?? '');
        const inc = cellStyleIncludes(ctx.doc, name);
        const take = k => !inc || inc.includes(k);
        const t = applyStyle(ctx, p, st => {
          if (onlyFmt) { st.numFmt = style.numFmt; return; }
          const keep = st.numFmt;
          if (take('font')) st.font = {...style.font};
          if (take('fill')) st.fill = {...style.fill};
          if (take('borders')) st.borders = {...style.borders};
          if (take('align')) st.align = {...style.align};
          if (take('protection')) st.protection = {...style.protection};
          if (take('numFmt')) { st.numFmt = style.numFmt; if (style.numFmt === 'General' && !inc) st.numFmt = keep; }
        });
        return {name, ranges: t.areas.map(a => areaAddress(ctx.doc, t.sheet, a))};
      },
    },
  ],
});
