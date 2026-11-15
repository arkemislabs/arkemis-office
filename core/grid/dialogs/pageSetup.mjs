// Page Setup dialog model (submit: pageLayout.pageSetup), Excel's four tabs: Page (orientation,
// scaling, paper size, first page number), Margins (and centring), Header/Footer, Sheet (print area,
// titles, gridlines, headings, comments, errors, page order).
// On gridcraft's page setup dialog (crates/ui-egui/src/dialogs/show.rs) and cmd/print.rs
// (`page_setup`) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {setupOf, fitsToPages, titlesParts, PAPER_NAMES} from '../lib/page-setup.mjs';

const COMMENTS = [['none', '(None)'], ['end', 'At end of sheet'], ['asDisplayed', 'As displayed on sheet']];
const ERRORS = [['displayed', 'displayed'], ['blank', '<blank>'], ['dash', '--'], ['na', '#N/A']];
const label = (list, key) => list.find(([k]) => k === key)?.[1] ?? list[0][1];
const key = (list, text) => list.find(([, l]) => l === text)?.[0] ?? list[0][0];

export default defineDialog({
  id: 'dialog.pageSetup',
  title: 'Page Setup',
  command: 'pageLayout.pageSetup',
  init(ctx) {
    const content = baseDoc(ctx);
    const sheet = content.sheets[gridSel(ctx).sheet];
    const p = setupOf(sheet), hf = p.headerFooter ?? {}, t = titlesParts(sheet.printTitles);
    return {
      orientation: p.orientation, scaling: fitsToPages(p) ? 'fit' : 'adjust', scale: p.scale ?? 100, fitWidth: p.fitWidth || 1, fitHeight: p.fitHeight || 1, paper: p.paper, firstPage: p.firstPage ? String(p.firstPage) : 'Auto',
      top: p.margins.top, headerMargin: p.margins.header, left: p.margins.left, right: p.margins.right, bottom: p.margins.bottom, footerMargin: p.margins.footer,
      centerHorizontally: !!p.centerH, centerVertically: !!p.centerV,
      header: hf.header ?? '', footer: hf.footer ?? '', differentOddEven: !!hf.differentOddEven, differentFirst: !!hf.differentFirst, scaleWithDoc: hf.scaleWithDoc !== false, alignWithMargins: hf.alignWithMargins !== false,
      printArea: sheet.printArea ?? '', printTitleRows: t.rows, printTitleColumns: t.cols, gridlines: !!p.printGridlines, blackAndWhite: !!p.blackAndWhite, draftQuality: !!p.draft, headings: !!p.printHeadings,
      comments: label(COMMENTS, p.comments ?? 'none'), errors: label(ERRORS, p.errors ?? 'displayed'), pageOrder: p.pageOrder === 'over' ? 'overThenDown' : 'downThenOver',
    };
  },
  validate(v) {
    const out = [];
    const num = (f, lo, hi, what) => { const n = Number(v[f]); if (!Number.isFinite(n) || n < lo || n > hi) out.push({field: f, message: `${what} must be ${lo} to ${hi}.`}); };
    if (v.scaling === 'fit') { num('fitWidth', 1, 32767, 'Pages wide'); num('fitHeight', 1, 32767, 'Pages tall'); } else num('scale', 10, 400, 'The scale');
    for (const [f, what] of [['top', 'Top margin'], ['left', 'Left margin'], ['right', 'Right margin'], ['bottom', 'Bottom margin'], ['headerMargin', 'Header'], ['footerMargin', 'Footer']]) num(f, 0, 50, what);
    if (!PAPER_NAMES.includes(String(v.paper))) out.push({field: 'paper', message: 'Choose a paper size.'});
    if (String(v.printTitleRows ?? '').trim() && !/^\$?\d+(:\$?\d+)?$/.test(String(v.printTitleRows).trim())) out.push({field: 'printTitleRows', message: 'Rows to repeat are like $1:$2.'});
    if (String(v.printTitleColumns ?? '').trim() && !/^\$?[A-Za-z]{1,3}(:\$?[A-Za-z]{1,3})?$/.test(String(v.printTitleColumns).trim())) out.push({field: 'printTitleColumns', message: 'Columns to repeat are like $A:$B.'});
    return out;
  },
  toCommand(v) {
    const fit = v.scaling === 'fit';
    const p = {
      orientation: v.orientation, paper: v.paper, scaling: fit ? 'fit' : 'adjust', ...(fit ? {fitWidth: Number(v.fitWidth), fitHeight: Number(v.fitHeight)} : {scale: Number(v.scale)}),
      top: Number(v.top), left: Number(v.left), right: Number(v.right), bottom: Number(v.bottom), headerMargin: Number(v.headerMargin), footerMargin: Number(v.footerMargin),
      centerHorizontally: !!v.centerHorizontally, centerVertically: !!v.centerVertically,
      header: String(v.header ?? ''), footer: String(v.footer ?? ''), differentOddEven: !!v.differentOddEven, differentFirst: !!v.differentFirst, scaleWithDoc: !!v.scaleWithDoc, alignWithMargins: !!v.alignWithMargins,
      printArea: String(v.printArea ?? '').replace(/\$/g, ''), printTitleRows: String(v.printTitleRows ?? '').replace(/\$/g, '').trim(), printTitleColumns: String(v.printTitleColumns ?? '').replace(/\$/g, '').trim(),
      gridlines: !!v.gridlines, blackAndWhite: !!v.blackAndWhite, draftQuality: !!v.draftQuality, headings: !!v.headings,
      comments: key(COMMENTS, v.comments), errors: key(ERRORS, v.errors), pageOrder: v.pageOrder === 'overThenDown' ? 'over' : 'down',
    };
    const first = String(v.firstPage ?? '').trim();
    p.firstPage = /^\d+$/.test(first) ? Number(first) : 'Auto';
    return {command: 'pageLayout.pageSetup', params: p};
  },
});
