// Page setup in an Excel workbook: printOptions, pageMargins, pageSetup (paper, orientation, scale or
// fit to pages, first page number, comments, errors, page order), headerFooter, rowBreaks and
// colBreaks of a worksheet, and the `fitToPage` mark of its sheetPr.
// Modelled on gridcraft crates/xlsx/src/sheet_read.rs and sheet_write.rs (page setup and print
// options) at 146161b4b450a56e5e59a083ba0478582d1e602b, with the element order of ECMA-376 18.3.1.99.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:grid/formats-xlsx. No DOM, no Node built-ins.

import {PAPERS, paperByCode, paperByName, MARGIN_PRESETS, fitsToPages, setupOf} from './page-setup.mjs';

const esc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const num = n => String(Math.round(n * 1000) / 1000);
const COMMENTS = {none: 'none', end: 'atEnd', asDisplayed: 'asDisplayed'};
const ERRORS = {displayed: 'displayed', blank: 'blank', dash: 'dash', na: 'NA'};

/** Whether the sheet's setup asks for `<pageSetUpPr fitToPage="1"/>`. */
export const needsFitToPage = sheet => fitsToPages(setupOf(sheet));

/** The page setup elements of a worksheet, in schema order (always the margins, as Excel writes them). */
export function pageSetupXml(sheet) {
  const p = setupOf(sheet), m = p.margins;
  let s = '';
  if (p.centerH || p.centerV || p.printHeadings || p.printGridlines) {
    s += `<printOptions${p.centerH ? ' horizontalCentered="1"' : ''}${p.centerV ? ' verticalCentered="1"' : ''}${p.printHeadings ? ' headings="1"' : ''}${p.printGridlines ? ' gridLines="1"' : ''}/>`;
  }
  s += `<pageMargins left="${num(m.left)}" right="${num(m.right)}" top="${num(m.top)}" bottom="${num(m.bottom)}" header="${num(m.header)}" footer="${num(m.footer)}"/>`;
  const set = sheet.pageSetup ?? {};
  if (Object.keys(set).some(k => k !== 'margins' && k !== 'headerFooter' && k !== 'rowBreaks' && k !== 'colBreaks' && k !== 'printGridlines' && k !== 'printHeadings' && k !== 'centerH' && k !== 'centerV')) {
    const paper = paperByName(p.paper);
    let a = paper && paper[1] ? ` paperSize="${paper[1]}"` : '';
    if (fitsToPages(p)) a += ` fitToWidth="${p.fitWidth ?? 0}" fitToHeight="${p.fitHeight ?? 0}"`; else if (p.scale !== 100) a += ` scale="${p.scale}"`;
    if (p.firstPage) a += ` firstPageNumber="${p.firstPage}" useFirstPageNumber="1"`;
    a += ` orientation="${p.orientation}"`;
    if (p.blackAndWhite) a += ' blackAndWhite="1"';
    if (p.draft) a += ' draft="1"';
    if (p.comments && p.comments !== 'none') a += ` cellComments="${COMMENTS[p.comments]}"`;
    if (p.errors && p.errors !== 'displayed') a += ` errors="${ERRORS[p.errors]}"`;
    if (p.pageOrder === 'over') a += ' pageOrder="overThenDown"';
    s += `<pageSetup${a}/>`;
  }
  const hf = set.headerFooter;
  if (hf && (hf.header || hf.footer || hf.evenHeader || hf.evenFooter || hf.firstHeader || hf.firstFooter || hf.differentOddEven || hf.differentFirst || hf.scaleWithDoc === false || hf.alignWithMargins === false)) {
    let a = '';
    if (hf.differentOddEven) a += ' differentOddEven="1"';
    if (hf.differentFirst) a += ' differentFirst="1"';
    if (hf.scaleWithDoc === false) a += ' scaleWithDoc="0"';
    if (hf.alignWithMargins === false) a += ' alignWithMargins="0"';
    const part = (tag, text) => (text ? `<${tag}>${esc(text)}</${tag}>` : '');
    s += `<headerFooter${a}>${part('oddHeader', hf.header)}${part('oddFooter', hf.footer)}${part('evenHeader', hf.evenHeader)}${part('evenFooter', hf.evenFooter)}${part('firstHeader', hf.firstHeader)}${part('firstFooter', hf.firstFooter)}</headerFooter>`;
  }
  const brk = (list, tag, max) => (list?.length ? `<${tag} count="${list.length}" manualBreakCount="${list.length}">${list.map(i => `<brk id="${i}" max="${max}" man="1"/>`).join('')}</${tag}>` : '');
  s += brk(set.rowBreaks, 'rowBreaks', 16383) + brk(set.colBreaks, 'colBreaks', 1048575);
  return s;
}

/** Reads one page setup element of a worksheet into `sheet.pageSetup`; `fit` says sheetPr marked fit to page. */
export function readPageSetupElement(e, sheet, fit) {
  const p = (sheet.pageSetup ??= {});
  switch (e.name) {
    case 'printOptions':
      if (e.flag('horizontalCentered', false)) p.centerH = true;
      if (e.flag('verticalCentered', false)) p.centerV = true;
      if (e.flag('headings', false)) p.printHeadings = true;
      if (e.flag('gridLines', false)) p.printGridlines = true;
      break;
    case 'pageMargins': {
      const m = {...MARGIN_PRESETS.normal};
      for (const k of ['left', 'right', 'top', 'bottom', 'header', 'footer']) { const v = e.num(k); if (v !== undefined && v >= 0) m[k] = Math.round(v * 1000) / 1000; }
      if (JSON.stringify(m) !== JSON.stringify(MARGIN_PRESETS.normal)) p.margins = m;
      break;
    }
    case 'pageSetup': {
      const paper = paperByCode(e.num('paperSize') ?? 1);
      if (paper && paper[0] !== 'Letter') p.paper = paper[0];
      else if (!paper && e.num('paperSize') !== undefined) p.paper = 'Letter';
      if (e.attr('orientation') === 'landscape') p.orientation = 'landscape';
      if (fit) { p.fitWidth = e.num('fitToWidth') ?? 1; p.fitHeight = e.num('fitToHeight') ?? 1; }
      else { const sc = e.num('scale'); if (sc !== undefined && sc >= 10 && sc <= 400 && sc !== 100) p.scale = Math.round(sc); }
      if (e.flag('useFirstPageNumber', false) && e.num('firstPageNumber') > 0) p.firstPage = e.num('firstPageNumber');
      if (e.flag('blackAndWhite', false)) p.blackAndWhite = true;
      if (e.flag('draft', false)) p.draft = true;
      const cc = Object.entries(COMMENTS).find(([, v]) => v === e.attr('cellComments'))?.[0];
      if (cc && cc !== 'none') p.comments = cc;
      const er = Object.entries(ERRORS).find(([, v]) => v === e.attr('errors'))?.[0];
      if (er && er !== 'displayed') p.errors = er;
      if (e.attr('pageOrder') === 'overThenDown') p.pageOrder = 'over';
      break;
    }
    case 'headerFooter': {
      const hf = {};
      const header = e.child('oddHeader')?.text, footer = e.child('oddFooter')?.text;
      if (header) hf.header = header;
      if (footer) hf.footer = footer;
      for (const key of ['evenHeader', 'evenFooter', 'firstHeader', 'firstFooter']) { const text = e.child(key)?.text; if (text) hf[key] = text; }
      if (e.flag('differentOddEven', false)) hf.differentOddEven = true;
      if (e.flag('differentFirst', false)) hf.differentFirst = true;
      if (!e.flag('scaleWithDoc', true)) hf.scaleWithDoc = false;
      if (!e.flag('alignWithMargins', true)) hf.alignWithMargins = false;
      if (Object.keys(hf).length) p.headerFooter = hf;
      break;
    }
    case 'rowBreaks': case 'colBreaks': {
      const ids = e.kids('brk').map(b => b.num('id')).filter(i => Number.isInteger(i) && i > 0).sort((a, b) => a - b);
      if (ids.length) p[e.name] = ids;
      break;
    }
    default: break;
  }
  if (!Object.keys(p).length) delete sheet.pageSetup;
}

export {PAPERS};
