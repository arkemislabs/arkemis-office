// The header or footer being edited in place in Page Layout view (the Header & Footer tab).
//
// Translated from gridcraft crates/ui-egui/src/paper_view.rs (`HfEdit`, `begin`, `commit`, `cancel`, `insert_field`,
// `go_to`, `set_option`, `page_kind`, `hf_key`) at fb1e59f, where the edit lives in the interface; here it is the
// document view's `hf` ({sheet, page: [i, j], footer, kind, section, texts, original, caret}), so the contextual tab, the
// ribbon's buttons and a script all act on the one edit. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Never an edit until it is written: the texts are in the view; `writeEdit` puts them in the sheet.

import {setupOf, splitHeaderFooter, joinHeaderFooter, codesToFields, fieldsToCodes, hfPageKind, hfText} from './page-setup.mjs';
import {PageGrid} from './paper.mjs';

/** The `headerFooter` key of a kind of page's header or footer (`hf_key`). */
export const hfKey = (kind, footer) => (kind === 'first' ? (footer ? 'firstFooter' : 'firstHeader') : kind === 'even' ? (footer ? 'evenFooter' : 'evenHeader') : footer ? 'footer' : 'header');

/** The sheet's page setup with this transaction's changes (an earlier write in the same command shows). */
export function stagedSetup(ctx, si) {
  const staged = ctx.change?.get?.(['sheets', si, 'pageSetup']);
  const sheet = ctx.doc.sheets[si];
  return setupOf(staged !== undefined ? {...sheet, pageSetup: staged} : sheet);
}

/** The page number a page shows: its printed number, 1 for the "Click to add data" pages (`page_kind`). */
export function pageNumberOf(sheet, page) {
  const pg = PageGrid.build(sheet, 0, 0);
  const n = pg?.pageNumber(page[0], page[1]);
  return n ? n[0] : 1;
}

/** The first page of the printed data, where Insert > Header & Footer starts: [row band, column band]. */
export function firstDataPage(sheet) {
  const pg = PageGrid.build(sheet, 0, 0);
  return pg ? [pg.dataRows[0], pg.dataCols[0]] : [0, 0];
}

/** A new edit of one header or footer section of `page`, texts read from the sheet as the person edits them (field names). */
export function openEdit(ctx, si, {page, footer = false, section = 1}) {
  const sheet = ctx.doc.sheets[si];
  const setup = stagedSetup(ctx, si);
  const kind = hfPageKind(setup, pageNumberOf(sheet, page));
  const texts = splitHeaderFooter(hfText(setup, kind, footer)).map(codesToFields);
  const at = Math.min(2, Math.max(0, section));
  return {sheet: sheet.id, page: [...page], footer: !!footer, kind, section: at, texts, original: [...texts], caret: [...texts[at]].length};
}

/** Writes the edited texts into the sheet when they changed (one undo step with whatever the command also does). Returns true when it wrote. */
export function writeEdit(ctx, si, hf, patchSetup) {
  if (hf.texts.every((t, i) => t === hf.original[i])) return false;
  const spec = joinHeaderFooter(hf.texts.map(fieldsToCodes));
  const sheet = ctx.doc.sheets[si];
  const staged = ctx.change?.get?.(['sheets', si, 'pageSetup']);
  const cur = {...((staged !== undefined ? staged : sheet.pageSetup)?.headerFooter ?? {})};
  const text = [...spec].slice(0, 255).join('');
  const key = hfKey(hf.kind, hf.footer);
  if (text) cur[key] = text; else delete cur[key];
  patchSetup(ctx, si, {...sheet, pageSetup: staged !== undefined ? staged : sheet.pageSetup}, {headerFooter: Object.keys(cur).length ? cur : undefined});
  return true;
}

/** Inserts a field (&[Page]...) at the caret of the section being edited. */
export function insertField(hf, field) {
  const chars = [...hf.texts[hf.section]];
  const at = Math.min(hf.caret, chars.length);
  const text = [...chars.slice(0, at), ...field, ...chars.slice(at)].join('');
  const texts = hf.texts.map((t, i) => (i === hf.section ? text : t));
  return {...hf, texts, caret: at + [...field].length};
}
