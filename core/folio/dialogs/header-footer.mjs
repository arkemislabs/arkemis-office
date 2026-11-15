// Add / Update Header and Footer (submit: edit.header_footer; Update and Bates numbering collect it
// through host.openDialog). Font, size, underline, colour, margins; six text boxes; Insert Page
// Number / Insert Date type the chosen format's token into the box last typed in; Start page
// number; Shrink; Page Range Options; the preview steps through the pages the range selects.
//
// Translated from printcraft crates/ui-egui/src/dialogs/marks_ui.rs (`body` for HeaderFooter,
// PAGE_FORMATS, DATE_FORMATS, BOX_NAMES, focused_box, `edit`, `undrawable`) and
// crates/edit/src/marks.rs (HeaderFooter defaults, bands) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {defaultHeaderFooter, bands} from '../lib/edit-marks.mjs';
import {draftOf, keepDraft, rangeValues, rangeParams, rangeProblems, hexOf, rgbOf, previewFrame} from '../lib/edit-mark-dialog.mjs';

export const PAGE_FORMATS = ['<<1>>', '<<1 of n>>', '<<1/n>>', '<<Page 1>>', '<<Page 1 of n>>'];
export const DATE_FORMATS = ['<<m/d/yyyy>>', '<<mm/dd/yyyy>>', '<<d/m/yyyy>>', '<<yyyy-mm-dd>>', '<<m/d/yy>>', '<<mmmm d, yyyy>>', '<<yyyy/mm/dd>>', '<<yyyy/m/d>>',
  '<<dd.mm.yyyy>>', '<<d.m.yyyy>>', '<<dd.mm.yy>>'];
export const BOXES = ['left-header-text', 'center-header-text', 'right-header-text', 'left-footer-text', 'center-footer-text', 'right-footer-text'];
const bare = t => t.replace(/^<<|>>$/g, '');

const countOf = ctx => (ctx.doc?.pages ?? []).length;

function fresh(count) {
  const d = defaultHeaderFooter();
  const v = {font: d.font, size: d.fontSize, underline: d.underline, color: hexOf(d.color),
    'margin-top': d.margins[0], 'margin-bottom': d.margins[1], 'margin-left': d.margins[2], 'margin-right': d.margins[3],
    'page-format': bare(PAGE_FORMATS[0]), 'insert-page': 0, 'date-format': bare(DATE_FORMATS[0]), 'insert-date': 0,
    start: d.startNumber, shrink: d.shrink, ...rangeValues(count), __focus: 1, __replace: false, __preview: null};
  BOXES.forEach(b => { v[b] = ''; });
  return v;
}

/** Dialog values → edit.header_footer params. */
export function valuesToParams(v) {
  return {
    ...rangeParams(v),
    text: BOXES.map(b => String(v[b] ?? '')),
    font: ['Helvetica', 'Times', 'Courier'].includes(v.font) ? v.font : 'Helvetica',
    fontSize: Number(v.size) || 8,
    color: rgbOf(v.color, [0, 0, 0]),
    underline: !!v.underline,
    margins: ['margin-top', 'margin-bottom', 'margin-left', 'margin-right'].map(k => Math.max(0, Number(v[k]) || 0)),
    startNumber: Math.max(1, Math.round(Number(v.start) || 1)),
    shrink: !!v.shrink,
    ...(v.__replace ? {replace: true} : {}),
  };
}

const settings = v => ({text: BOXES.map(b => String(v[b] ?? '')), fontSize: Number(v.size) || 8,
  margins: ['margin-top', 'margin-bottom', 'margin-left', 'margin-right'].map(k => Number(v[k]) || 0)});

export default defineDialog({
  id: 'dialog.header-footer',
  title: 'Add Header and Footer',
  command: 'edit.header_footer',
  init(ctx) {
    const count = countOf(ctx);
    const kept = draftOf('HeaderFooter');
    // The draft is kept between openings (marks_ui.rs MarksDraft); `to` shows the last page.
    const v = kept ? {...kept, to: Math.min(Math.max(1, Number(kept.to) || count), Math.max(1, count))} : fresh(count);
    return {...v, __replace: false, __preview: null, __count: count, 'insert-page': 0, 'insert-date': 0};
  },
  derive(v, changed) {
    const out = {};
    for (const f of changed) {
      const k = BOXES.indexOf(f);
      if (k >= 0) out.__focus = k;
    }
    const focus = BOXES[out.__focus ?? v.__focus ?? 1] ?? BOXES[1];
    // Insert Page Number / Insert Date: the chosen format's token at the end of the focused box.
    if (changed.includes('insert-page')) {
      const t = PAGE_FORMATS.find(x => bare(x) === v['page-format']) ?? PAGE_FORMATS[0];
      out[focus] = `${v[focus] ?? ''}${t}`;
    }
    if (changed.includes('insert-date')) {
      const t = DATE_FORMATS.find(x => bare(x) === v['date-format']) ?? DATE_FORMATS[0];
      out[focus] = `${v[focus] ?? ''}${t}`;
    }
    if (changed.some(f => ['scope', 'from', 'to', 'subset'].includes(f))) out.__preview = null;
    return out;
  },
  validate(v) {
    const out = [];
    const st = settings(v);
    // A character the standard faces lack is drawn with a system font when the mark is added; a character no font has is refused then.
    if (st.text.every(t => !t.trim())) out.push({field: 'center-header-text', message: 'Type the header or footer text first'});
    const size = Number(v.size);
    if (!(size >= 4 && size <= 72)) out.push({field: 'size', message: 'Type a size from 4 to 72 points'});
    for (const k of ['margin-top', 'margin-bottom', 'margin-left', 'margin-right']) if (!(Number(v[k]) >= 0 && Number(v[k]) <= 720)) out.push({field: k, message: 'Type a margin from 0 to 10 inches'});
    if (!(Number.isInteger(Number(v.start)) && Number(v.start) >= 1 && Number(v.start) <= 999999)) out.push({field: 'start', message: 'Type a start page number from 1 to 999999'});
    out.push(...rangeProblems(v, Number(v.__count) || 1));
    return out;
  },
  preview(ctx, v) {
    const frame = previewFrame(ctx, v);
    const st = settings(v);
    const [top, bottom] = bands(st);
    return {...frame, kind: 'HeaderFooter', font: v.font, size: st.fontSize, color: v.color, underline: !!v.underline, margins: st.margins,
      boxes: st.text.map(t => t.replace(/<<|>>/g, '')), shrink: v.shrink ? {top, bottom} : null, replace: !!v.__replace};
  },
  toCommand(v) {
    keepDraft('HeaderFooter', v);
    return {command: 'edit.header_footer', params: valuesToParams(v)};
  },
});
