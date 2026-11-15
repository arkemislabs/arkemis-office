// Header & Footer dialog model (submit: pageLayout.headerFooter).
// gridcraft edits a header in place in Page Layout view (ribbon/insert.rs, `start_editing`; cmd/view.rs
// `header_footer`): the sections show the fields as &[Page], &[Pages], &[Date], &[Time], &[Path], &[File],
// &[Tab], &[Picture] and are stored as Excel's codes (&P, &N, ...), at most 255 characters a header or
// footer; the first page and the even pages have their own texts. Here a dialog edits the sections of the
// three headers and three footers (fields translated with codesToFields / fieldsToCodes). MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Values: left, center, right and footerLeft, footerCenter, footerRight (odd pages); firstLeft ... firstFooterRight
// (the first page); evenLeft ... evenFooterRight (even pages); differentFirst, differentOddEven, scaleWithDoc,
// alignWithMargins.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {setupOf, splitHeaderFooter, joinHeaderFooter, codesToFields, fieldsToCodes} from '../lib/page-setup.mjs';

const SIDES = ['Left', 'Center', 'Right'];
/** [stored key, dialog field prefix, command param] for every header and footer text. */
const TEXTS = [
  ['header', '', 'header'], ['footer', 'footer', 'footer'],
  ['firstHeader', 'first', 'firstHeader'], ['firstFooter', 'firstFooter', 'firstFooter'],
  ['evenHeader', 'even', 'evenHeader'], ['evenFooter', 'evenFooter', 'evenFooter'],
];
/** The dialog field for a section: header sections are `left`, `firstLeft`, `evenLeft`; footers `footerLeft`, `firstFooterLeft`, ... */
const field = (prefix, i) => (prefix === '' || prefix === 'footer' ? (prefix === '' ? SIDES[i].toLowerCase() : `footer${SIDES[i]}`) : `${prefix}${SIDES[i]}`);

/**
 * Excel's Header and Footer drop-downs: ready-made sections for the header or footer being edited. Not checked against upstream
 * (gridcraft has none): the list is Excel's own ones that need no author name. Choosing one fills the three sections, (none) clears
 * them. Values are the sections as the person edits them (fields as &[Page]).
 */
export const PRESETS = Object.freeze([
  ['(none)', ['', '', '']],
  ['Page 1', ['', 'Page &[Page]', '']],
  ['Page 1 of ?', ['', 'Page &[Page] of &[Pages]', '']],
  ['Sheet1', ['', '&[Tab]', '']],
  ['Confidential, date, Page 1', ['Confidential', '&[Date]', 'Page &[Page]']],
  ['File name', ['', '&[File]', '']],
  ['Page 1, File name', ['Page &[Page]', '', '&[File]']],
  ['Page 1, Sheet1', ['Page &[Page]', '', '&[Tab]']],
  ['File name, Sheet1, Page 1', ['&[File]', '&[Tab]', 'Page &[Page]']],
]);
/** The preset field of a header or footer: headerPreset, footerPreset, firstHeaderPreset, firstFooterPreset, evenHeaderPreset, evenFooterPreset. */
const presetField = prefix => (prefix === '' ? 'headerPreset' : prefix === 'footer' ? 'footerPreset' : `${prefix.replace(/^(first|even)(Footer)?$/, (_, w, f) => w + (f ? 'Footer' : 'Header'))}Preset`);

/** The text of one header or footer from the dialog's fields (codes, capped like Excel). */
export const textOf = (v, prefix) => joinHeaderFooter(SIDES.map((_, i) => fieldsToCodes(v[field(prefix, i)] ?? '')));

export default defineDialog({
  id: 'dialog.headerFooter',
  title: 'Header & Footer',
  command: 'pageLayout.headerFooter',
  init(ctx) {
    const hf = setupOf(baseDoc(ctx).sheets[gridSel(ctx).sheet]).headerFooter ?? {};
    const out = {differentFirst: !!hf.differentFirst, differentOddEven: !!hf.differentOddEven, scaleWithDoc: hf.scaleWithDoc !== false, alignWithMargins: hf.alignWithMargins !== false};
    for (const [key, prefix] of TEXTS) {
      splitHeaderFooter(hf[key] ?? '').forEach((raw, i) => { out[field(prefix, i)] = codesToFields(raw); });
      const now = SIDES.map((_, i) => out[field(prefix, i)]);
      out[presetField(prefix)] = (PRESETS.find(([, s]) => s.every((t, i) => t === now[i])) ?? PRESETS[0])[0];
    }
    return out;
  },
  derive(v, changed) {
    const patch = {};
    for (const [, prefix] of TEXTS) {
      const key = presetField(prefix);
      if (!changed.includes(key)) continue;
      const hit = PRESETS.find(([name]) => name === v[key]);
      if (hit) hit[1].forEach((t, i) => { patch[field(prefix, i)] = t; });
    }
    return patch;
  },
  validate: v => TEXTS.filter(([, prefix]) => [...textOf(v, prefix)].length > 255).map(([, prefix]) => ({field: field(prefix, 0), message: 'A header or footer is at most 255 characters.'})),
  toCommand: v => ({
    command: 'pageLayout.headerFooter',
    params: {
      ...Object.fromEntries(TEXTS.map(([, prefix, param]) => [param, textOf(v, prefix)])),
      differentFirst: !!v.differentFirst, differentOddEven: !!v.differentOddEven, scaleWithDoc: v.scaleWithDoc !== false, alignWithMargins: v.alignWithMargins !== false,
    },
  }),
});
