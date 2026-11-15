// Layout › Page Setup (the group's launcher, Margins › Custom Margins…, Size › More Paper Sizes…):
// Word's Page Setup dialog with its Margins, Paper, Layout and Document Grid pages over the
// section of the selection. OK runs one undo step.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs `page_setup_dialog` and
// crates/ui-egui/src/dialogs/page_setup.rs (`PAPER_LABELS`, `paper_entry`, `page_layout_commands`,
// `run_as_one_step`, `page_paper_group`, `page_valign_combo`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Upstream draws it as one page; the fields are grouped into Word's tabs here. Lengths are in
// inches, as the Paragraph dialog shows them. As in Word, choosing Landscape or Portrait turns the
// paper and the margin boxes with it.

import {defineDialog} from '../../kernel/dialog.mjs';
import {caretSection, marginsFit, MARGINS_DONT_FIT, MIN_PAGE_SIDE, MAX_PAGE_SIDE, PAPER_SIZES, paperOf} from '../commands/page.mjs';
import {gridLinesPerPage, gridCharsPerLine} from '../model/section.mjs';
import {resolveChar} from '../model/styles.mjs';

export const IN = 72;
const toIn = pt => Math.round((pt / IN) * 100) / 100;
const fromIn = v => Math.round(v * IN * 100) / 100;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
export const CUSTOM = 'custom';
export const GRID_KINDS = Object.freeze(['none', 'lines', 'linesAndChars', 'snapToChars']);
const GRID_OF = {default: 'none', lines: 'lines', linesAndChars: 'linesAndChars', snapToChars: 'snapToChars'};

/** The named paper (either orientation) w × h inches is, or 'custom' (paper_entry). */
export function paperEntry(w, h) {
  if (!isNum(w) || !isNum(h)) return CUSTOM;
  return paperOf({pageW: w * IN, pageH: h * IN}) ?? CUSTOM;
}

/** w × h turned to the orientation: the long side across in landscape. */
const turned = (land, [a, b]) => (land ? [Math.max(a, b), Math.min(a, b)] : [Math.min(a, b), Math.max(a, b)]);

/**
 * The commands OK runs for the paper, orientation and margins (page_layout_commands), all in
 * points. The size first when the section's margins fit it, else the margins first, else margins
 * of 0 in between; `layout.size` keeps the orientation and `layout.orientation` then turns the
 * page and its margins to what the dialog shows. A size equal to the opened one doesn't run.
 */
export function pageLayoutCommands(cur, paper, was, landscape, m, gutter) {
  if (!marginsFit(paper, m, gutter)) return {error: MARGINS_DONT_FIT};
  const [w0, h0] = turned(false, paper), [w1, h1] = turned(false, was);
  const newSize = Math.abs(w0 - w1) >= 0.01 || Math.abs(h0 - h1) >= 0.01;
  const size = {command: 'layout.size', params: {width: paper[0], height: paper[1]}};
  const orientation = {command: 'layout.orientation', params: {value: landscape ? 'landscape' : 'portrait'}};
  const margins = {command: 'layout.margins', params: {top: m[0], bottom: m[1], left: m[2], right: m[3]}};
  const old = [cur.marginTop, cur.marginBottom, cur.marginLeft, cur.marginRight];
  if (!newSize || marginsFit(turned(cur.landscape, paper), old, cur.gutter)) return {commands: [...(newSize ? [size] : []), orientation, margins]};
  if (marginsFit(turned(landscape, [cur.pageW, cur.pageH]), m, cur.gutter)) return {commands: [orientation, margins, size]};
  return {commands: [orientation, {command: 'layout.margins', params: {top: 0, bottom: 0, left: 0, right: 0}}, size, margins]};
}

function gridFontSize(d) {
  const size = resolveChar(d.styles, 'Normal', {}).size;
  return Number.isFinite(size) ? Math.max(1, Math.min(1584, size)) : 10.5;
}

/** The dialog's values for a section (the caret's), and the basis OK compares against. */
export function readPageSetup(ctx) {
  const {d, x, mirror, evenOdd} = caretSection(ctx);
  const fs = gridFontSize(d);
  const v = {
    top: toIn(x.marginTop), bottom: toIn(x.marginBottom), left: toIn(x.marginLeft), right: toIn(x.marginRight), gutter: toIn(x.gutter),
    orientation: x.landscape ? 'landscape' : 'portrait', multiplePages: mirror ? 'mirror' : 'normal',
    paperSize: paperOf(x) ?? CUSTOM, width: toIn(x.pageW), height: toIn(x.pageH),
    oddEven: evenOdd, firstPage: !!x.titlePage, verticalAlignment: x.valign ?? 'top',
    sectionDirection: x.rtl ? 'rtl' : 'ltr', grid: GRID_OF[x.docGrid?.type ?? 'default'] ?? 'none',
    charsPerLine: gridCharsPerLine(x, fs), linesPerPage: gridLinesPerPage(x),
  };
  return {...v, _basis: {...v}, _cur: {pageW: x.pageW, pageH: x.pageH, landscape: !!x.landscape, marginTop: x.marginTop, marginBottom: x.marginBottom,
    marginLeft: x.marginLeft, marginRight: x.marginRight, gutter: x.gutter, columns: x.columns}};
}

const LENGTHS = ['top', 'bottom', 'left', 'right', 'gutter', 'width', 'height'];

export default defineDialog({
  id: 'dialog.pageSetup',
  title: 'Page Setup',
  command: 'layout.pageSetup',
  init: ctx => readPageSetup(ctx),
  derive(v, changed) {
    const out = {};
    const land = v.orientation === 'landscape';
    if (changed.includes('orientation')) {
      // The paper follows the orientation (the wide side is the width in landscape), and Word turns
      // the margin boxes with the page as layout.orientation turns the section's margins.
      const [w, h] = turned(land, [v.width, v.height]);
      if (w !== v.width) {
        Object.assign(out, {width: w, height: h});
        const {top: t, bottom: b, left: l, right: r} = v;
        Object.assign(out, land ? {top: l, bottom: r, left: b, right: t} : {left: t, right: b, bottom: l, top: r});
      }
    }
    if (changed.includes('paperSize') && v.paperSize !== CUSTOM) {
      const hit = PAPER_SIZES.find(([n]) => n === v.paperSize);
      if (hit) { const [w, h] = turned(land, [toIn(hit[1]), toIn(hit[2])]); Object.assign(out, {width: w, height: h}); }
    }
    if (changed.includes('width') || changed.includes('height')) {
      // A typed size that is wider than tall turns the orientation to landscape.
      if (isNum(v.width) && isNum(v.height) && v.width !== v.height) out.orientation = v.width > v.height ? 'landscape' : 'portrait';
      if (v.paperSize !== CUSTOM || paperEntry(v.width, v.height) !== CUSTOM) out.paperSize = paperEntry(v.width, v.height);
    }
    return out;
  },
  validate(v) {
    const out = [];
    for (const k of LENGTHS) if (!isNum(v[k]) || v[k] < 0) out.push({field: k, message: 'Enter a measurement of 0 or more.'});
    if (out.length) return out;
    for (const k of ['width', 'height']) {
      if (v[k] * IN < MIN_PAGE_SIDE - 0.01 || v[k] * IN > MAX_PAGE_SIDE + 0.01) out.push({field: k, message: 'The page must be between 0.1" and 22".'});
    }
    if (out.length) return out;
    const m = ['top', 'bottom', 'left', 'right'].map(k => fromIn(v[k]));
    if (!marginsFit([fromIn(v.width), fromIn(v.height)], m, fromIn(v.gutter))) out.push({field: 'top', message: MARGINS_DONT_FIT});
    if (v.grid !== 'none') {
      if (!isNum(v.linesPerPage) || v.linesPerPage < 1 || v.linesPerPage > 1000) out.push({field: 'linesPerPage', message: 'Enter a number from 1 to 1000.'});
      if (v.grid !== 'lines' && (!isNum(v.charsPerLine) || v.charsPerLine < 1 || v.charsPerLine > 1000)) out.push({field: 'charsPerLine', message: 'Enter a number from 1 to 1000.'});
    }
    return out;
  },
  preview(_ctx, v) {
    const land = v.orientation === 'landscape';
    const [w, h] = turned(land, [isNum(v.width) ? v.width : 8.5, isNum(v.height) ? v.height : 11]);
    const cols = v._cur?.columns ?? {count: 1};
    return {pageW: w, pageH: h, top: v.top, bottom: v.bottom, left: v.left, right: v.right, gutter: v.gutter, mirror: v.multiplePages === 'mirror',
      columns: Math.max(1, Math.min(12, cols.count ?? 1)), valign: v.verticalAlignment};
  },
  toCommand(v) {
    const b = v._basis ?? {}, cur = v._cur;
    const changed = k => JSON.stringify(v[k]) !== JSON.stringify(b[k]);
    const batch = [];
    const pageKeys = ['top', 'bottom', 'left', 'right', 'gutter', 'orientation', 'multiplePages', 'paperSize', 'width', 'height'];
    if (cur && pageKeys.some(changed)) {
      const land = v.orientation === 'landscape';
      const paper = turned(land, [fromIn(v.width), fromIn(v.height)]);
      const was = [cur.pageW, cur.pageH];
      const m = ['top', 'bottom', 'left', 'right'].map(k => fromIn(v[k]));
      const got = pageLayoutCommands(cur, paper, was, land, m, fromIn(v.gutter));
      if (got.error) return {batch: [{command: 'layout.margins', params: {top: m[0], bottom: m[1], left: m[2], right: m[3], gutter: fromIn(v.gutter)}}]};
      // Mirror margins and the gutter go with the margins (#1181).
      const last = [...got.commands].reverse().find(c => c.command === 'layout.margins');
      last.params = {...last.params, mirror: v.multiplePages === 'mirror', gutter: fromIn(v.gutter)};
      batch.push(...got.commands);
    }
    if (['grid', 'linesPerPage', 'charsPerLine'].some(changed)) {
      const p = {type: v.grid};
      if (v.grid !== 'none' && changed('linesPerPage')) p.linesPerPage = v.linesPerPage;
      if ((v.grid === 'linesAndChars' || v.grid === 'snapToChars') && changed('charsPerLine')) p.charsPerLine = v.charsPerLine;
      batch.push({command: 'layout.documentGrid', params: p});
    }
    if (changed('sectionDirection')) batch.push({command: 'layout.sectionRtl', params: {value: v.sectionDirection === 'rtl'}});
    if (changed('verticalAlignment')) batch.push({command: 'layout.verticalAlign', params: {value: v.verticalAlignment}});
    if (changed('oddEven')) batch.push({command: 'layout.differentOddEven', params: {value: !!v.oddEven}});
    if (changed('firstPage')) batch.push({command: 'layout.differentFirstPage', params: {value: !!v.firstPage}});
    return {batch};
  },
});
