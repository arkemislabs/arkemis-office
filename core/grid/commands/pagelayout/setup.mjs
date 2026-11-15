// Page Layout > Page Setup, Scale to Fit and Sheet Options: margins, orientation, paper size, print
// area, page breaks, print titles, scaling, gridlines and headings when printed, header and footer, and
// the Page Setup dialog's one command.
// Modelled on gridcraft crates/engine/src/cmd/print.rs (`page_setup`, `print_area`, `breaks`,
// `print_titles`, `header_footer`) and crates/ui-egui/src/ribbon/page_layout.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's presets. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Everything is stored on the sheet (core/grid/lib/page-setup.mjs) and goes to .xlsx as pageSetup,
// pageMargins, printOptions, headerFooter, rowBreaks, colBreaks and the print area and title names.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {rangeA1, parseRange, isFullRows, isFullCols, a1, lettersToCol} from '../../lib/addr.mjs';
import {hasDoc, gridSel, targetSheet, requireSchema2} from '../../lib/edit-targets.mjs';
import {setIn, deleteIn} from '../../lib/edit-parts.mjs';
import {bad, baseDoc} from '../../lib/data-common.mjs';
import {writeEdit, openEdit} from '../../lib/hf-edit.mjs';
import {PAPER_NAMES, paperByName, MARGIN_PRESETS, setupOf, titlesText, titlesParts, sections, joinSections, splitHeaderFooter, joinHeaderFooter, fieldsToCodes} from '../../lib/page-setup.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/print.rs', 'crates/engine/src/cmd/print/layout.rs', 'crates/ui-egui/src/ribbon/page_layout.rs']};
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const RANGE = s.optional(s.string({min: 1, max: 4096}));
const INCHES = s.number({min: 0, max: 20});

function target(ctx, p) {
  const content = baseDoc(ctx);
  const si = p.sheet !== undefined ? targetSheet(ctx, p) : gridSel(ctx).sheet;
  requireSchema2(ctx, si);
  return {content, si, sheet: content.sheets[si]};
}
/** Writes `patch` over the sheet's page setup (a key set to undefined goes). */
function patchSetup(ctx, si, sheet, patch) {
  const next = {...(sheet.pageSetup ?? {})};
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete next[k]; else next[k] = v; }
  if (Object.keys(next).length) setIn(ctx.change, ['sheets', si, 'pageSetup'], next); else deleteIn(ctx.change, ['sheets', si, 'pageSetup']);
}
const numberOf = (v, lo, hi, what) => {
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(n) || n < lo || n > hi) throw bad('pageLayout.scaleToFit', `${what} must be ${lo} to ${hi}`);
  return n;
};
/** How many pages a Width / Height box value means: Automatic is 0, "2 pages" is 2. */
const pagesOf = v => (v === 0 || /^auto/i.test(String(v).trim()) ? 0 : numberOf(v, 1, 32767, 'pages'));

function margins(ctx, p) {
  const {content, si, sheet} = target(ctx, p);
  const cur = setupOf(sheet).margins;
  let next;
  if (p.preset === 'last') {
    next = content.pageLayout?.lastMargins;
    if (!next) throw bad('pageLayout.margins', 'no custom margins have been set yet');
  } else if (p.preset) {
    next = MARGIN_PRESETS[p.preset];
    if (!next) throw bad('pageLayout.margins', `unknown preset \`${p.preset}\` (normal, wide, narrow, last)`);
  } else {
    next = {...cur};
    for (const k of ['left', 'right', 'top', 'bottom', 'header', 'footer']) if (typeof p[k] === 'number') next[k] = p[k];
    setIn(ctx.change, ['pageLayout'], {...(content.pageLayout ?? {}), lastMargins: next});
  }
  patchSetup(ctx, si, sheet, {margins: {...next}});
  return null;
}

function orientation(ctx, p) {
  const {si, sheet} = target(ctx, p);
  // gridcraft `orientation`: landscape, anything else portrait.
  const o = p.orientation === 'landscape' ? 'landscape' : 'portrait';
  patchSetup(ctx, si, sheet, {orientation: o});
  return {orientation: o};
}

function size(ctx, p) {
  const {si, sheet} = target(ctx, p);
  const paper = paperByName(p.paper);
  if (!paper) throw bad('pageLayout.size', `unknown paper \`${p.paper}\` (${PAPER_NAMES.join(', ')})`);
  patchSetup(ctx, si, sheet, {paper: paper[0]});
  return {paper: paper[0]};
}

function printArea(ctx, p) {
  const {si, sheet} = target(ctx, p);
  if (p.clear === true) { deleteIn(ctx.change, ['sheets', si, 'printArea']); return null; }
  const sel = gridSel(ctx);
  const areas = typeof p.range === 'string' && p.range ? p.range.replace(/\$/g, '').split(',').map(x => parseRange(x.trim())) : sel.ranges;
  if (areas.some(r => !r)) throw bad('pageLayout.printArea', 'not a range');
  const text = areas.map(rangeA1);
  const kept = p.add === true && sheet.printArea ? String(sheet.printArea).split(',') : [];
  setIn(ctx.change, ['sheets', si, 'printArea'], [...kept, ...text].join(','));
  return null;
}

function breaks(ctx, p) {
  const {si, sheet} = target(ctx, p);
  const sel = gridSel(ctx);
  const r = sel.ranges[sel.ranges.length - 1];
  let rows = [...(sheet.pageSetup?.rowBreaks ?? [])], cols = [...(sheet.pageSetup?.colBreaks ?? [])];
  // A break goes above and to the left of the active cell; a whole row or column breaks on its own line only.
  const at = sel.active;
  const rowAt = isFullCols(r) ? null : at.row, colAt = isFullRows(r) ? null : at.col;
  if (p.reset === true) { rows = []; cols = []; }
  else if (p.remove === true) {
    if (rowAt !== null) rows = rows.filter(x => x !== rowAt);
    if (colAt !== null) cols = cols.filter(x => x !== colAt);
  } else {
    if (rowAt !== null && rowAt > 0 && !rows.includes(rowAt)) rows.push(rowAt);
    if (colAt !== null && colAt > 0 && !cols.includes(colAt)) cols.push(colAt);
  }
  rows.sort((x, y) => x - y); cols.sort((x, y) => x - y);
  patchSetup(ctx, si, sheet, {rowBreaks: rows.length ? rows : undefined, colBreaks: cols.length ? cols : undefined});
  return {rowBreaks: rows, colBreaks: cols};
}

function printTitles(ctx, p) {
  const {si, sheet} = target(ctx, p);
  if (p.clear === true) { deleteIn(ctx.change, ['sheets', si, 'printTitles']); return null; }
  const cur = titlesParts(sheet.printTitles);
  const rows = typeof p.rows === 'string' ? p.rows : cur.rows, cols = typeof p.cols === 'string' ? p.cols : cur.cols;
  const text = titlesText(sheet.name, cols, rows);
  if (text === null) throw bad('pageLayout.printTitles', 'rows are like 1:2 and columns like A:B');
  if (text) setIn(ctx.change, ['sheets', si, 'printTitles'], text); else deleteIn(ctx.change, ['sheets', si, 'printTitles']);
  return null;
}

function scaleToFit(ctx, p) {
  const {si, sheet} = target(ctx, p);
  const patch = {};
  if (p.scale !== undefined) { patch.scale = numberOf(p.scale, 10, 400, 'scale'); patch.fitWidth = undefined; patch.fitHeight = undefined; }
  if (p.width !== undefined) patch.fitWidth = pagesOf(p.width);
  if (p.height !== undefined) patch.fitHeight = pagesOf(p.height);
  if (patch.fitWidth !== undefined || patch.fitHeight !== undefined) {
    const cur = setupOf(sheet);
    patch.fitWidth ??= cur.fitWidth ?? 0;
    patch.fitHeight ??= cur.fitHeight ?? 0;
    patch.scale = undefined;
  }
  patchSetup(ctx, si, sheet, patch);
  return null;
}

const toggle = key => (ctx, p) => {
  const {si, sheet} = target(ctx, p);
  const on = typeof p.on === 'boolean' ? p.on : !setupOf(sheet)[key];
  patchSetup(ctx, si, sheet, {[key]: on ? true : undefined});
  return {on};
};

/** Excel keeps at most 255 characters per header or footer. */
const MAX_HEADER_FOOTER = 255;
const cap = t => [...String(t)].slice(0, MAX_HEADER_FOOTER).join('');
const HF_KEYS = {odd: ['header', 'footer'], even: ['evenHeader', 'evenFooter'], first: ['firstHeader', 'firstFooter']};

function headerFooter(ctx, p) {
  const {si, sheet} = target(ctx, p);
  // A header or footer being edited in Page Layout view is written first (set_option commits, then runs the command, then edits the same page again).
  const live = ctx.view?.hf && ctx.view.hf.sheet === sheet.id ? ctx.view.hf : null;
  if (live) writeEdit(ctx, si, live, patchSetup);
  const staged = ctx.change.get(['sheets', si, 'pageSetup']);
  const cur = {...((staged !== undefined ? staged : sheet.pageSetup)?.headerFooter ?? {})};
  const put = (key, text) => { const v = cap(text); if (v) cur[key] = v; else delete cur[key]; };
  // One section edited in place: {page: odd|even|first, part: header|footer, section: left|center|right, text} (field names or codes).
  if (p.part !== undefined || p.section !== undefined) {
    const part = p.part ?? 'header', section = p.section ?? 'center', page = p.page ?? 'odd';
    const idx = {left: 0, center: 1, centre: 1, right: 2}[section];
    if (idx === undefined) throw bad('pageLayout.headerFooter', 'section must be left, center or right');
    const keys = HF_KEYS[page];
    const key = keys[part === 'footer' ? 1 : 0];
    const parts = splitHeaderFooter(cur[key] ?? '');
    parts[idx] = fieldsToCodes(p.text ?? '');
    put(key, joinHeaderFooter(parts));
  }
  for (const k of ['firstHeader', 'firstFooter', 'evenHeader', 'evenFooter']) if (typeof p[k] === 'string') put(k, p[k]);
  const section = (text, left, center, right) => (typeof text === 'string' ? text : left !== undefined || center !== undefined || right !== undefined ? joinSections({left, center, right}) : undefined);
  const header = section(p.header, p.headerLeft, p.headerCenter, p.headerRight), footer = section(p.footer, p.footerLeft, p.footerCenter, p.footerRight);
  if (header !== undefined) put('header', header);
  if (footer !== undefined) put('footer', footer);
  for (const k of ['differentOddEven', 'differentFirst', 'scaleWithDoc', 'alignWithMargins']) if (typeof p[k] === 'boolean') { if (p[k] === (k === 'scaleWithDoc' || k === 'alignWithMargins')) delete cur[k]; else cur[k] = p[k]; }
  patchSetup(ctx, si, {...sheet, pageSetup: staged !== undefined ? staged : sheet.pageSetup}, {headerFooter: Object.keys(cur).length ? cur : undefined});
  if (live) ctx.setView({hf: openEdit(ctx, si, {page: live.page, footer: live.footer, section: live.section})});
  return {header: cur.header ?? '', footer: cur.footer ?? '', differentFirst: !!cur.differentFirst, differentOddEven: !!cur.differentOddEven, scaleWithDoc: cur.scaleWithDoc !== false, alignWithMargins: cur.alignWithMargins !== false,
    firstHeader: cur.firstHeader ?? '', firstFooter: cur.firstFooter ?? '', evenHeader: cur.evenHeader ?? '', evenFooter: cur.evenFooter ?? ''};
}

/** The Page Setup dialog's command: every box of its four tabs at once. */
function pageSetup(ctx, p) {
  const {si, sheet} = target(ctx, p);
  const patch = {};
  if (p.orientation) patch.orientation = p.orientation;
  if (p.paper) { const paper = paperByName(p.paper); if (!paper) throw bad('pageLayout.pageSetup', `unknown paper \`${p.paper}\``); patch.paper = paper[0]; }
  if (p.scaling === 'fit') {
    patch.fitWidth = pagesOf(p.fitWidth ?? 1); patch.fitHeight = pagesOf(p.fitHeight ?? 1); patch.scale = undefined;
  } else if (p.scaling === 'adjust' || p.scale !== undefined) {
    patch.scale = numberOf(p.scale ?? 100, 10, 400, 'scale'); patch.fitWidth = undefined; patch.fitHeight = undefined;
  }
  const m = {...setupOf(sheet).margins};
  let touched = false;
  // gridcraft takes the margins as an object too: {left, right, top, bottom, header, footer}.
  for (const [k, from] of [['left', 'left'], ['right', 'right'], ['top', 'top'], ['bottom', 'bottom'], ['header', 'headerMargin'], ['footer', 'footerMargin']]) {
    const v = typeof p[from] === 'number' ? p[from] : typeof p.margins?.[k] === 'number' ? p.margins[k] : undefined;
    if (v !== undefined) { m[k] = Math.min(20, Math.max(0, v)); touched = true; }
  }
  if (touched) { patch.margins = m; setIn(ctx.change, ['pageLayout'], {...(ctx.doc.pageLayout ?? {}), lastMargins: m}); }
  for (const [k, from] of [['centerH', 'centerHorizontally'], ['centerV', 'centerVertically'], ['printGridlines', 'gridlines'], ['blackAndWhite', 'blackAndWhite'], ['draft', 'draftQuality'], ['printHeadings', 'headings']]) {
    if (typeof p[from] === 'boolean') patch[k] = p[from] ? true : undefined;
  }
  if (p.fitToPage === true) { patch.fitWidth = 1; patch.fitHeight = 1; patch.scale = undefined; } else if (p.fitToPage === false) { patch.fitWidth = undefined; patch.fitHeight = undefined; }
  for (const [k, from] of [['centerH', 'centerH'], ['centerV', 'centerV'], ['printGridlines', 'gridlines'], ['printHeadings', 'headings']]) if (typeof p[from] === 'boolean') patch[k] = p[from] ? true : undefined;
  if (Array.isArray(p.rowBreaks)) { const v = [...new Set(p.rowBreaks.map(x => Number(x)).filter(r => Number.isInteger(r) && r >= 2 && r <= 1048576).map(r => r - 1))].sort((a, b) => a - b).slice(0, 1026); patch.rowBreaks = v.length ? v : undefined; }
  if (Array.isArray(p.colBreaks)) { const v = [...new Set(p.colBreaks.map(x => (typeof x === 'string' ? lettersToCol(x.trim().replace(/^\$/, '')) : Number(x) - 1)).filter(c => Number.isInteger(c) && c >= 1 && c < 16384))].sort((a, b) => a - b).slice(0, 1026); patch.colBreaks = v.length ? v : undefined; }
  if (p.comments) patch.comments = p.comments === 'none' ? undefined : p.comments;
  if (p.errors) patch.errors = p.errors === 'displayed' ? undefined : p.errors;
  if (p.pageOrder) patch.pageOrder = p.pageOrder === 'down' ? undefined : p.pageOrder;
  if (p.firstPage !== undefined) patch.firstPage = String(p.firstPage).trim() === '' || /^auto/i.test(String(p.firstPage)) ? undefined : Number(p.firstPage);
  patchSetup(ctx, si, sheet, patch);
  const hf = ['header', 'footer', 'differentOddEven', 'differentFirst', 'scaleWithDoc', 'alignWithMargins'].filter(k => p[k] !== undefined);
  if (hf.length) {
    const cur = {...(ctx.change.get(['sheets', si, 'pageSetup'])?.headerFooter ?? {})};
    if (p.header !== undefined) { if (p.header) cur.header = cap(p.header); else delete cur.header; }
    if (p.footer !== undefined) { if (p.footer) cur.footer = cap(p.footer); else delete cur.footer; }
    for (const k of ['differentOddEven', 'differentFirst', 'scaleWithDoc', 'alignWithMargins']) if (typeof p[k] === 'boolean') { if (p[k] === (k === 'scaleWithDoc' || k === 'alignWithMargins')) delete cur[k]; else cur[k] = p[k]; }
    const now = ctx.change.get(['sheets', si, 'pageSetup']) ?? {};
    const next = {...now}; if (Object.keys(cur).length) next.headerFooter = cur; else delete next.headerFooter;
    if (Object.keys(next).length) setIn(ctx.change, ['sheets', si, 'pageSetup'], next); else deleteIn(ctx.change, ['sheets', si, 'pageSetup']);
  }
  if (p.printArea !== undefined) {
    if (String(p.printArea).trim()) printArea(ctx, {range: String(p.printArea), sheet: si}); else deleteIn(ctx.change, ['sheets', si, 'printArea']);
  }
  const titleRows = p.printTitleRows ?? p.titleRows, titleCols = p.printTitleColumns ?? p.titleCols;
  if (titleRows !== undefined || titleCols !== undefined) printTitles(ctx, {rows: titleRows === null ? '' : String(titleRows ?? titlesParts(sheet.printTitles).rows), cols: titleCols === null ? '' : String(titleCols ?? titlesParts(sheet.printTitles).cols), sheet: si});
  return null;
}

const PRESET = s.optional(s.enum(['normal', 'wide', 'narrow', 'last']));
const SECTION = s.optional(s.string({max: 10000}));

export default defineCommands({
  family: 'pagelayout/setup',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'pageLayout.margins', label: 'Margins', risk: 'edit', dialog: 'dialog.pageSetup',
      description: 'Set the page margins: preset normal|wide|narrow|last (the last custom setting), or left, right, top, bottom, header, footer in inches.',
      params: s.object({sheet: SHEET, preset: PRESET, left: s.optional(INCHES), right: s.optional(INCHES), top: s.optional(INCHES), bottom: s.optional(INCHES), header: s.optional(INCHES), footer: s.optional(INCHES)}),
      state: hasDoc, run: margins,
    },
    {
      id: 'pageLayout.orientation', label: 'Orientation', risk: 'edit',
      description: 'Portrait or landscape (with none given, portrait).',
      params: s.object({sheet: SHEET, orientation: s.optional(s.enum(['portrait', 'landscape']))}),
      state: ctx => ({...hasDoc(ctx), value: hasDoc(ctx).enabled ? setupOf(ctx.doc.sheets[gridSel(ctx).sheet]).orientation : null}),
      run: orientation,
    },
    {
      id: 'pageLayout.size', label: 'Size', risk: 'edit',
      description: `The paper size: ${PAPER_NAMES.join(', ')}.`,
      params: s.object({sheet: SHEET, paper: s.string({min: 1, max: 60})}),
      state: ctx => ({...hasDoc(ctx), value: hasDoc(ctx).enabled ? setupOf(ctx.doc.sheets[gridSel(ctx).sheet]).paper : null}),
      run: size,
    },
    {
      id: 'pageLayout.printArea', label: 'Print Area', risk: 'edit',
      description: 'Set the print area to `range` (default: the selection), add the selection to it (add: true) or clear it (clear: true).',
      params: s.object({sheet: SHEET, range: RANGE, add: s.optional(s.boolean()), clear: s.optional(s.boolean())}),
      state: hasDoc, run: printArea,
    },
    {
      id: 'pageLayout.breaks', label: 'Breaks', risk: 'edit',
      description: 'Insert a page break above and left of the active cell (insert: true), remove the break there (remove: true) or remove every manual break (reset: true).',
      params: s.object({sheet: SHEET, insert: s.optional(s.boolean()), remove: s.optional(s.boolean()), reset: s.optional(s.boolean())}),
      state: hasDoc, run: breaks,
    },
    {
      id: 'pageLayout.printTitles', label: 'Print Titles', risk: 'edit', dialog: 'dialog.pageSetup',
      description: 'The rows (1:2) and columns (A:B) repeated on every printed page; clear: true removes them. Without them the Page Setup dialog opens on its Sheet tab.',
      params: s.object({sheet: SHEET, rows: s.optional(s.string({max: 30})), cols: s.optional(s.string({max: 30})), clear: s.optional(s.boolean())}),
      state: hasDoc, run: printTitles,
    },
    {
      id: 'pageLayout.scaleToFit', label: 'Scale to Fit', risk: 'edit',
      description: 'Scale the printout: width and height in pages (Automatic or 1 to 9 pages), or scale as a percentage (10 to 400).',
      params: s.object({sheet: SHEET, width: s.optional(s.union([s.integer({min: 0, max: 32767}), s.string({max: 30})])), height: s.optional(s.union([s.integer({min: 0, max: 32767}), s.string({max: 30})])),
        scale: s.optional(s.union([s.integer({min: 10, max: 400}), s.string({max: 30})]))}),
      state: ctx => ({...hasDoc(ctx), value: hasDoc(ctx).enabled ? (setupOf(ctx.doc.sheets[gridSel(ctx).sheet]).scale ?? 100) : null}), run: scaleToFit,
    },
    {
      id: 'pageLayout.printGridlines', label: 'Gridlines: Print', risk: 'edit',
      description: 'Print the gridlines (on, default: the other state).',
      params: s.object({sheet: SHEET, on: s.optional(s.boolean())}),
      state: ctx => ({...hasDoc(ctx), checked: hasDoc(ctx).enabled && !!setupOf(ctx.doc.sheets[gridSel(ctx).sheet]).printGridlines}),
      run: toggle('printGridlines'),
    },
    {
      id: 'pageLayout.printHeadings', label: 'Headings: Print', risk: 'edit',
      description: 'Print the row and column headings (on, default: the other state).',
      params: s.object({sheet: SHEET, on: s.optional(s.boolean())}),
      state: ctx => ({...hasDoc(ctx), checked: hasDoc(ctx).enabled && !!setupOf(ctx.doc.sheets[gridSel(ctx).sheet]).printHeadings}),
      run: toggle('printHeadings'),
    },
    {
      id: 'pageLayout.headerFooter', label: 'Header & Footer', risk: 'edit', dialog: 'dialog.headerFooter',
      description: 'The printed header and footer: header and footer as Excel writes them (&L left, &C centre, &R right; &P page, &N pages, &A sheet, &F file, &D date), or the sections one by one; differentOddEven, differentFirst, scaleWithDoc, alignWithMargins.',
      params: s.object({sheet: SHEET, header: SECTION, footer: SECTION, firstHeader: SECTION, firstFooter: SECTION, evenHeader: SECTION, evenFooter: SECTION,
        page: s.optional(s.enum(['odd', 'even', 'first'])), part: s.optional(s.enum(['header', 'footer'])), section: s.optional(s.enum(['left', 'center', 'centre', 'right'])), text: s.optional(s.string({max: 2000})), headerLeft: SECTION, headerCenter: SECTION, headerRight: SECTION, footerLeft: SECTION, footerCenter: SECTION, footerRight: SECTION,
        differentOddEven: s.optional(s.boolean()), differentFirst: s.optional(s.boolean()), scaleWithDoc: s.optional(s.boolean()), alignWithMargins: s.optional(s.boolean())}),
      state: hasDoc, run: headerFooter,
    },
    {
      id: 'pageLayout.pageSetup', label: 'Page Setup', risk: 'edit', dialog: 'dialog.pageSetup',
      description: 'Every box of the Page Setup dialog: orientation, paper, scaling (adjust|fit) with scale, fitWidth, fitHeight, margins, centering, header and footer, print area, titles, gridlines, headings, comments, errors, page order.',
      params: s.object({sheet: SHEET, orientation: s.optional(s.enum(['portrait', 'landscape'])), paper: s.optional(s.string({max: 60})), tab: s.optional(s.union([s.string({max: 40}), s.integer({min: 0, max: 10})])), scaling: s.optional(s.enum(['adjust', 'fit'])),
        scale: s.optional(s.union([s.integer({min: 10, max: 400}), s.string({max: 30})])), fitWidth: s.optional(s.union([s.integer({min: 0, max: 32767}), s.string({max: 30})])), fitHeight: s.optional(s.union([s.integer({min: 0, max: 32767}), s.string({max: 30})])),
        left: s.optional(INCHES), right: s.optional(INCHES), top: s.optional(INCHES), bottom: s.optional(INCHES), headerMargin: s.optional(INCHES), footerMargin: s.optional(INCHES), header: SECTION, footer: SECTION,
        centerHorizontally: s.optional(s.boolean()), centerVertically: s.optional(s.boolean()), differentOddEven: s.optional(s.boolean()), differentFirst: s.optional(s.boolean()),
        scaleWithDoc: s.optional(s.boolean()), alignWithMargins: s.optional(s.boolean()), printArea: s.optional(s.string({max: 4096})), printTitleRows: s.optional(s.string({max: 30})), printTitleColumns: s.optional(s.string({max: 30})),
        margins: s.optional(s.object({left: s.optional(INCHES), right: s.optional(INCHES), top: s.optional(INCHES), bottom: s.optional(INCHES), header: s.optional(INCHES), footer: s.optional(INCHES)})),
        fitToPage: s.optional(s.boolean()), centerH: s.optional(s.boolean()), centerV: s.optional(s.boolean()), titleRows: s.optional(s.nullable(s.string({max: 30}))), titleCols: s.optional(s.nullable(s.string({max: 30}))),
        rowBreaks: s.optional(s.array(s.union([s.integer({min: 1, max: 1048576}), s.string({max: 10})]), {max: 1026})), colBreaks: s.optional(s.array(s.union([s.integer({min: 1, max: 16384}), s.string({max: 5})]), {max: 1026})),
        gridlines: s.optional(s.boolean()), blackAndWhite: s.optional(s.boolean()), draftQuality: s.optional(s.boolean()), headings: s.optional(s.boolean()),
        comments: s.optional(s.enum(['none', 'end', 'asDisplayed'])), errors: s.optional(s.enum(['displayed', 'blank', 'dash', 'na'])), pageOrder: s.optional(s.enum(['down', 'over'])), firstPage: s.optional(s.union([s.integer({min: 1, max: 32767}), s.string({max: 20})]))}),
      state: hasDoc, run: pageSetup,
    },
  ],
});

export {a1, sections, patchSetup};
