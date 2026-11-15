// Page Layout view (View > Workbook Views > Page Layout), its Ruler, and the in-place Header & Footer editing with its
// contextual tab: Header and Footer presets, the elements (Page Number, Number of Pages, Current Date, Current Time,
// File Path, File Name, Sheet Name), Go to Header and Go to Footer.
//
// Translated from gridcraft crates/engine/src/cmd/extra/window.rs (`set_view`, `ruler`) and
// crates/ui-egui/src/paper_view.rs (`start_editing`, `begin`, `commit`, `cancel`, `insert_field`, `go_to`,
// `ribbon_tab`) at fb1e59f. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The view mode and the ruler are the document view (never an edit, as upstream's `set_view` and `ruler`); the header
// or footer being edited is the view's `hf` (core/grid/lib/hf-edit.mjs): nothing is written to the sheet until it is
// committed, one undo step, as upstream does when the person clicks elsewhere. A header picture (&[Picture]) is a field
// name only upstream (no picture is stored or printed), so Picture and Format Picture are hidden.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {hasDoc, gridSel, targetSheet} from '../../lib/edit-targets.mjs';
import {bad, baseDoc} from '../../lib/data-common.mjs';
import {openEdit, writeEdit, insertField, firstDataPage, hfKey} from '../../lib/hf-edit.mjs';
import {patchSetup} from './setup.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: 'fb1e59f', files: ['crates/engine/src/cmd/extra/window.rs', 'crates/ui-egui/src/paper_view.rs', 'crates/ui-egui/src/ribbon/view.rs']};
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const PAGE = s.optional(s.array(s.integer({min: 0, max: 100000}), {min: 2, max: 2, description: '[page row, page column]'}));
const SECTION = s.optional(s.union([s.integer({min: 0, max: 2}), s.enum(['left', 'center', 'centre', 'right'])]));
const FIELDS = ['&[Page]', '&[Pages]', '&[Date]', '&[Time]', '&[Path]', '&[File]', '&[Tab]', '&[Picture]'];

const inPaper = ctx => ctx.view?.mode === 'pageLayout';
const sectionOf = v => (typeof v === 'number' ? v : {left: 0, center: 1, centre: 1, right: 2}[v] ?? 1);
const sheetIndexOf = (ctx, id) => ctx.doc.sheets.findIndex(x => x.id === id);

/** The header and footer presets Excel lists (the ribbon_tab list): label and the text written, for a sheet and file name. */
export function presets(sheetName, file) {
  return [
    ['(none)', ''],
    ['Page 1', '&CPage &P'],
    ['Page 1 of ?', '&CPage &P of &N'],
    [sheetName, '&C&A'],
    [file, '&C&F'],
    [`${sheetName}, Page 1`, '&C&A, Page &P'],
    [`${file}, Page 1`, '&C&F, Page &P'],
  ];
}
const fileTitle = ctx => String(ctx.file?.title ?? ctx.file?.name ?? 'Book1').replace(/\.[A-Za-z0-9]+$/, '');

const needEdit = ctx => (ctx.view?.hf ? {enabled: true} : {enabled: false, reason: 'click a header or footer in Page Layout view first'});
const live = (ctx, cmd) => {
  const hf = ctx.view?.hf;
  if (!hf) throw bad(cmd, 'no header or footer is being edited: click one in Page Layout view first');
  return hf;
};

/** Writes the edit in progress (if its sheet still exists) and leaves the view without one. */
function commit(ctx) {
  const hf = ctx.view?.hf;
  if (!hf) return false;
  const si = sheetIndexOf(ctx, hf.sheet);
  const wrote = si >= 0 && writeEdit(ctx, si, hf, patchSetup);
  ctx.setView({hf: null});
  return wrote;
}

function begin(ctx, p) {
  const content = baseDoc(ctx);
  const si = p.sheet !== undefined ? targetSheet(ctx, p) : gridSel(ctx).sheet;
  const sheet = content.sheets[si];
  const hf = ctx.view?.hf;
  const page = p.page ?? firstDataPage(sheet);
  const footer = p.footer === true;
  const section = sectionOf(p.section ?? 1);
  if (hf && hf.sheet === sheet.id && hf.page[0] === page[0] && hf.page[1] === page[1] && hf.footer === footer) {
    // The same header or footer: only the section changes, the caret to its end.
    if (hf.section !== section) ctx.setView({mode: 'pageLayout', hf: {...hf, section, caret: [...hf.texts[section]].length}});
    return {page, footer, section};
  }
  commit(ctx);
  ctx.setView({mode: 'pageLayout', hf: openEdit(ctx, si, {page, footer, section})});
  return {page, footer, section};
}

export default defineCommands({
  family: 'pagelayout/paper',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'view.pageLayout', label: 'Page Layout', risk: 'read', effect: 'view',
      description: 'Show the sheet in Page Layout view: the printed pages on a desk with margins, headers, footers and rulers; a header or footer is edited by clicking it.', params: s.object({}),
      state: ctx => ({...hasDoc(ctx), checked: inPaper(ctx)}),
      run: ctx => { ctx.setView({mode: 'pageLayout'}); return {view: 'pageLayout'}; }},
    {id: 'view.ruler', label: 'Ruler', risk: 'read', effect: 'view',
      description: 'Show or hide the rulers of Page Layout view (`on`, default: the other state).', params: s.object({on: s.optional(s.boolean())}),
      state: ctx => (inPaper(ctx) ? {enabled: true, checked: !ctx.view?.hideRuler} : {...hasDoc(ctx), enabled: false, reason: 'the rulers belong to Page Layout view', checked: !ctx.view?.hideRuler}),
      run(ctx, p) { const on = typeof p.on === 'boolean' ? p.on : !!ctx.view?.hideRuler; ctx.setView({hideRuler: !on}); return {on}; }},
    {id: 'pageLayout.headerFooterEdit', label: 'Edit Header or Footer', risk: 'edit',
      description: 'Edit a header or footer in place (switches to Page Layout view): `page` as [page row, page column] (default the first printed page), `footer`, and the `section` (left, center, right). Writes the one being edited first.',
      params: s.object({sheet: SHEET, page: PAGE, footer: s.optional(s.boolean()), section: SECTION}), state: hasDoc, run: begin},
    {id: 'pageLayout.headerFooterText', label: 'Header and Footer Text', risk: 'read', effect: 'view',
      description: 'Set the text of a section of the header or footer being edited (as the person sees it: &[Page] for the page number) and where the caret is.',
      params: s.object({text: s.string({max: 2000}), section: SECTION, caret: s.optional(s.integer({min: 0, max: 2000}))}), state: needEdit,
      run(ctx, p) {
        const hf = live(ctx, 'pageLayout.headerFooterText');
        const section = p.section !== undefined ? sectionOf(p.section) : hf.section;
        const texts = hf.texts.map((t, i) => (i === section ? p.text : t));
        ctx.setView({hf: {...hf, section, texts, caret: Math.min(p.caret ?? [...p.text].length, [...p.text].length)}});
        return {section};
      }},
    {id: 'pageLayout.headerFooterField', label: 'Insert Header and Footer Element', risk: 'read', effect: 'view',
      description: 'Insert a field (&[Page], &[Pages], &[Date], &[Time], &[Path], &[File], &[Tab] or a combination such as &[Path]&[File]) at the caret of the section being edited.',
      params: s.object({insertField: s.string({min: 2, max: 40})}), state: needEdit,
      run(ctx, p) {
        const hf = live(ctx, 'pageLayout.headerFooterField');
        const rest = p.insertField.replaceAll(/&\[[A-Za-z]+\]/g, m => (FIELDS.includes(m) ? '' : m));
        if (rest) throw bad('pageLayout.headerFooterField', `\`insertField\` is made of ${FIELDS.join(', ')}`);
        const next = insertField(hf, p.insertField);
        ctx.setView({hf: next});
        return {section: next.section, text: next.texts[next.section]};
      }},
    {id: 'pageLayout.headerFooterGoTo', label: 'Go to Header or Footer', risk: 'edit',
      description: 'Move the edit to the header (`footer` false) or the footer of the same page, keeping the section.', params: s.object({footer: s.boolean()}), state: needEdit,
      run(ctx, p) {
        const hf = live(ctx, 'pageLayout.headerFooterGoTo');
        if (hf.footer === p.footer) return {footer: hf.footer};
        return begin(ctx, {page: hf.page, footer: p.footer, section: hf.section, sheet: sheetIndexOf(ctx, hf.sheet)});
      }},
    {id: 'pageLayout.headerFooterEnd', label: 'End Header and Footer Edit', risk: 'edit',
      description: 'End editing the header or footer: write it when it changed (one undo step), or leave it as it was (`cancel`).', params: s.object({cancel: s.optional(s.boolean())}),
      state: needEdit,
      run(ctx, p) { if (p.cancel === true) { ctx.setView({hf: null}); return {wrote: false}; } return {wrote: commit(ctx)}; }},
    {id: 'pageLayout.headerFooterPreset', label: 'Header and Footer Presets', risk: 'edit',
      description: 'Set the header or footer being edited (or the first page\'s, `part`) to one of the presets (`preset` 0 to 6: none, Page 1, Page 1 of ?, the sheet name, the file name, sheet and page, file and page), or to a `spec` as Excel writes it; ends the edit without writing it first. Without `preset` and `spec` returns the list.',
      params: s.object({sheet: SHEET, part: s.optional(s.enum(['header', 'footer'])), preset: s.optional(s.integer({min: 0, max: 6})), spec: s.optional(s.string({max: 255}))}),
      state(ctx, p) {
        const r = hasDoc(ctx);
        if (!r.enabled) return r;
        const sheet = ctx.doc.sheets[gridSel(ctx).sheet];
        return {enabled: true, value: presets(sheet.name, fileTitle(ctx)).map(([label], i) => ({id: i, label, value: i}))};
      },
      run(ctx, p) {
        const sheet0 = ctx.doc.sheets[gridSel(ctx).sheet];
        if (p.preset === undefined && p.spec === undefined) return {presets: presets(sheet0.name, fileTitle(ctx)).map(([label, spec]) => ({label, spec}))};
        const hf = ctx.view?.hf;
        const si = p.sheet !== undefined ? targetSheet(ctx, p) : hf ? sheetIndexOf(ctx, hf.sheet) : gridSel(ctx).sheet;
        const sheet = ctx.doc.sheets[si];
        const footer = p.part ? p.part === 'footer' : hf ? hf.footer : false;
        const kind = hf?.kind ?? 'odd';
        const spec = p.spec ?? presets(sheet.name, fileTitle(ctx))[p.preset][1];
        // The edit in progress is dropped, not written (upstream `cancel`), then the text is set as pageLayout.headerFooter does.
        ctx.setView({hf: null});
        const cur = {...(sheet.pageSetup?.headerFooter ?? {})};
        const key = hfKey(kind, footer);
        const text = [...spec].slice(0, 255).join('');
        if (text) cur[key] = text; else delete cur[key];
        patchSetup(ctx, si, sheet, {headerFooter: Object.keys(cur).length ? cur : undefined});
        return {key, spec: text};
      }},
  ],
});
