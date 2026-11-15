// Edit a PDF: Header & Footer, Bates numbering, Watermark and Background (add, update, remove),
// and links (Create links from URLs, Remove all links).
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt):
//  * crates/engine/src/commands.rs:298-305, 365-373 — catalog entries (ids, labels, Needs);
//  * crates/ui-egui/src/commands.rs:477-545 — what each does: Add and Update open the marks dialog
//    (Update in replace mode), Bates numbering opens Header & Footer with a Bates number in the
//    bottom-right box (6 digits from 1), Remove removes that kind of mark from every page;
//  * crates/ui-egui/src/dialogs/marks_ui.rs — MarksDraft, PageRange (all pages / from-to, subset
//    even/odd), `edit` (Fit to page makes the watermark size 0);
//  * crates/engine/src/edit/run.rs:575-600, 656-670 — AddHeaderFooter (today's date),
//    AddWatermark / AddBackground (a picture file becomes the mark's source), RemoveMarks
//    ("there is nothing to remove"), RemoveLinks ("there are no links to remove"), AddLinks
//    ("no web addresses were found");
//  * crates/engine/src/edit/labels.rs:263-286 — the undo labels;
//  * crates/edit (core/folio/lib/edit-marks.mjs, edit-place.mjs) and crates/annot links.rs
//    (core/folio/lib/edit-links.mjs).
// Marks rewrite the page content in the PDF source (one undo step: the source and the page records).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {editable, commit} from '../lib/page-source.mjs';
import {readOther, interactive} from '../lib/page-files.mjs';
import {
  addHeaderFooter, addWatermark, addBackground, removeMarks, markSource, markUnicode, defaultHeaderFooter, defaultWatermark, defaultBackground,
  FAMILIES,
} from '../lib/edit-marks.mjs';
import {documentOpen, modification, marks, guard} from '../lib/edit-needs.mjs';
import {findUrls, linkRecords, linkAnnotation, isLinkRecord} from '../lib/edit-links.mjs';
import {valuesToParams as hfValues} from '../dialogs/header-footer.mjs';
import {valuesToParams as wmValues} from '../dialogs/watermark.mjs';
import {valuesToParams as bgValues} from '../dialogs/background.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '3109bb2359759e24ef490e1cdbdba00722b20972',
  files: ['crates/engine/src/commands.rs', 'crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/dialogs/marks_ui.rs', 'crates/engine/src/edit/run.rs',
    'crates/engine/src/edit/labels.rs', 'crates/edit/src/marks.rs', 'crates/edit/src/apply.rs', 'crates/edit/src/place.rs', 'crates/annot/src/links.rs',
    'crates/ui-egui/src/tools/link_ui.rs']};

const pages = ctx => ctx.doc?.pages ?? [];

// ---------------------------------------------------------------------------------------------
// Page Range Options (marks_ui.rs PageRange; 1-based in the dialog)

const rangeParams = {
  pages: s.optional(s.array(s.integer({min: 0, max: 99999}), {min: 1, max: 10000, description: '0-based page indices (default: the page range, else every page)'})),
  from: s.optional(s.integer({min: 1, max: 100000, description: 'Pages from (1-based; default: every page)'})),
  to: s.optional(s.integer({min: 1, max: 100000, description: 'to (1-based, inclusive)'})),
  subset: s.optional(s.enum(['all', 'even', 'odd'], {description: 'All pages in range, Even pages only, Odd pages only'})),
};

/** PageRange::pages: from/to clamped to the document (all pages when neither is given), then the subset. */
export function rangePages(count, {from, to, subset = 'all'} = {}) {
  const all = from === undefined && to === undefined;
  const a = all ? 1 : Math.max(1, from ?? 1), b = all ? count : Math.min(to ?? count, count);
  const out = [];
  for (let p = a; p <= b; p++) if (subset === 'all' || (subset === 'even' ? p % 2 === 0 : p % 2 === 1)) out.push(p - 1);
  return out;
}

function targets(ctx, p) {
  const n = pages(ctx).length;
  if (p.pages) {
    const bad = p.pages.find(i => i >= n);
    if (bad !== undefined) throw new CommandError('not_found', `page ${bad + 1} does not exist`, {path: '/pages'});
    return [...new Set(p.pages)].sort((a, b) => a - b);
  }
  const list = rangePages(n, p);
  if (!list.length) throw new CommandError('invalid_params', 'the page range selects no pages');
  return list;
}

/** Today's date (marks.rs Context) from the host clock. */
function today(ctx) {
  const d = new Date(typeof ctx.host?.now === 'function' ? ctx.host.now() : Date.now());
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

const rgbParam = s.optional(s.array(s.number({min: 0, max: 1}), {min: 3, max: 3, description: 'RGB, 0–1 each'}));
const toRgb = v => {
  if (Array.isArray(v)) return v.map(Number);
  const h = String(v ?? '').replace('#', '');
  return /^[0-9a-f]{6}$/i.test(h) ? [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255) : null;
};

/**
 * Open the source for the target pages and run `edit(doc, sourceIndices, extraRotation)`, then
 * commit the new source as one change (page.mjs does the same for page objects).
 */
async function onSource(ctx, list, edit) {
  const {doc, content} = await editable(ctx.doc, list);
  const src = list.map(i => content.pages[i].sourceIndex);
  const extra = new Map(list.map(i => [content.pages[i].sourceIndex, content.pages[i].rotation ?? 0]));
  const out = await edit(doc, src, si => extra.get(si) ?? 0);
  await commit(ctx, doc, content, {refresh: list});
  return out;
}

// ---------------------------------------------------------------------------------------------
// Header & Footer

const hfParams = s.object({
  ...rangeParams,
  text: s.optional(s.array(s.string({max: 2000}), {min: 6, max: 6, description: 'Left, center, right header text, then left, center, right footer text; tokens <<1>>, <<n>>, <<Page 1 of n>>, dates such as <<m/d/yyyy>>, <<Bates Number#6#1#PRE#SUF>>'})),
  font: s.optional(s.enum(FAMILIES)),
  fontSize: s.optional(s.number({min: 0.1, max: 200})),
  color: rgbParam,
  underline: s.optional(s.boolean()),
  margins: s.optional(s.array(s.number({min: 0, max: 14400}), {min: 4, max: 4, description: 'Top, bottom, left, right in points'})),
  startNumber: s.optional(s.integer({min: 1, max: 4294967295})),
  shrink: s.optional(s.boolean({description: 'Shrink the page content to make room for the header and footer'})),
  replace: s.optional(s.boolean({description: 'Update: replace the existing header and footer on those pages'})),
});

function hfOf(p) {
  const d = defaultHeaderFooter();
  return {text: p.text ?? d.text, font: p.font ?? d.font, fontSize: p.fontSize ?? d.fontSize, color: toRgb(p.color) ?? d.color, underline: p.underline ?? d.underline,
    margins: p.margins ?? d.margins, startNumber: p.startNumber ?? d.startNumber, shrink: p.shrink ?? d.shrink};
}

/** The dialog's values for a mode (marks_ui.rs: the draft is kept between openings, Update replaces). */
async function collect(ctx, dialog, init) {
  if (!interactive(ctx) || typeof ctx.host?.openDialog !== 'function') return undefined;
  const v = await ctx.host.openDialog(dialog, init);
  return v ?? null;
}

function headerFooter(id, label, {replace = false, bates = false} = {}) {
  return {
    id, label, risk: 'edit', ...(replace || bates ? {} : {dialog: 'dialog.header-footer'}),
    description: replace ? 'Replace the header and footer on the page range with these settings.'
      : bates ? 'Add Bates numbers (a header & footer token, 6 digits from 1 in the bottom-right box by default).'
        : 'Add a header and footer: six text boxes with page-number, date and Bates tokens, font, size, colour, margins and page range.',
    params: bates ? s.object({...hfParams.properties, digits: s.optional(s.integer({min: 1, max: 15})), start: s.optional(s.integer({min: 0})),
      prefix: s.optional(s.string({max: 200})), suffix: s.optional(s.string({max: 200})), box: s.optional(s.integer({min: 0, max: 5}))}) : hfParams,
    state: replace ? marks('HeaderFooter') : modification,
    async run(ctx, p) {
      guard(ctx, replace ? marks('HeaderFooter') : modification);
      let params = p;
      if (p.text === undefined && (replace || bates)) {
        const init = {__replace: replace};
        if (bates) Object.assign(init, {'right-footer-text': '<<Bates Number#6#1##>>', __focus: 5});
        const v = await collect(ctx, 'dialog.header-footer', init);
        if (v === null) return {canceled: true};
        if (v) params = {...p, ...hfValues(v, pages(ctx).length)};
      }
      if (bates && params.text === undefined) {
        const t = ['', '', '', '', '', ''];
        t[params.box ?? 5] = `<<Bates Number#${params.digits ?? 6}#${params.start ?? 1}#${params.prefix ?? ''}#${params.suffix ?? ''}>>`;
        params = {...params, text: t};
      }
      const hf = hfOf(params);
      const list = targets(ctx, params);
      const rep = replace || !!params.replace;
      await onSource(ctx, list, async (doc, src, extra) => addHeaderFooter(doc, src, hf, rep, today(ctx), extra, await markUnicode(doc, hf.text)));
      ctx.setUndoLabel(rep ? 'Update header & footer' : 'Add header & footer');
      return {pages: list, replace: rep};
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Watermark and Background

const fileParam = s.optional(s.object({
  path: s.optional(s.string({max: 4096})),
  base64: s.optional(s.string({max: 41_000_000})),
  name: s.optional(s.string({max: 255})),
  page: s.optional(s.integer({min: 1, max: 100000, description: 'Page number of a PDF (1-based)'})),
}, {description: 'Source ▸ File: a PDF page or a PNG/JPEG picture'}));

const wmParams = s.object({
  ...rangeParams,
  text: s.optional(s.string({max: 2000})),
  file: fileParam,
  scale: s.optional(s.number({min: 0.01, max: 10, description: 'Pictures: size relative to the page (1 fits the page)'})),
  fontSize: s.optional(s.number({min: 0, max: 300, description: '0 = fit to page'})),
  color: rgbParam,
  opacity: s.optional(s.number({min: 0, max: 1})),
  rotation: s.optional(s.number({min: -360, max: 360, description: 'Degrees counter-clockwise'})),
  behind: s.optional(s.boolean({description: 'Appear behind page (else on top)'})),
  offset: s.optional(s.array(s.number({min: -20000, max: 20000}), {min: 2, max: 2, description: 'Offset from centre, points (right, up)'})),
  replace: s.optional(s.boolean()),
});
const bgParams = s.object({
  ...rangeParams,
  color: rgbParam,
  opacity: s.optional(s.number({min: 0, max: 1})),
  file: fileParam,
  scale: s.optional(s.number({min: 0.01, max: 10})),
  replace: s.optional(s.boolean()),
});

async function pictureOf(ctx, doc, file) {
  if (!file) return null;
  const got = await readOther(ctx, file, {title: 'Browse', filters: [{name: 'PDF or image', extensions: ['pdf', 'png', 'jpg', 'jpeg']}]});
  if (!got) return undefined;
  return markSource(doc, {name: got.name, bytes: got.bytes, page: (file.page ?? 1) - 1});
}

function watermark(id, label, replace) {
  return {
    id, label, risk: 'edit', ...(replace ? {} : {dialog: 'dialog.watermark'}),
    description: replace ? 'Replace the watermark on the page range.' : 'Add a text or picture watermark: size (or fit), color, rotation, opacity, behind or on top, offset, page range.',
    params: wmParams,
    state: replace ? marks('Watermark') : modification,
    async run(ctx, p) {
      guard(ctx, replace ? marks('Watermark') : modification);
      let params = p;
      if (replace && p.text === undefined && !p.file) {
        const v = await collect(ctx, 'dialog.watermark', {__replace: true});
        if (v === null) return {canceled: true};
        if (v) params = {...p, ...wmValues(v, pages(ctx).length)};
      }
      const d = defaultWatermark();
      const wm = {text: params.text ?? '', source: null, scale: params.scale ?? d.scale, fontSize: params.fontSize ?? d.fontSize, color: toRgb(params.color) ?? d.color,
        opacity: params.opacity ?? d.opacity, rotation: params.rotation ?? d.rotation, behind: params.behind ?? d.behind, offset: params.offset ?? d.offset};
      const list = targets(ctx, params);
      const rep = replace || !!params.replace;
      let canceled = false;
      await onSource(ctx, list, async (doc, src, extra) => {
        if (params.file) {
          const pic = await pictureOf(ctx, doc, params.file);
          if (pic === undefined) { canceled = true; throw new CommandError('canceled', 'canceled'); }
          wm.source = pic;
        }
        addWatermark(doc, src, wm, rep, extra, wm.source ? null : await markUnicode(doc, [wm.text]));
      }).catch(e => { if (!canceled) throw e; });
      if (canceled) return {canceled: true};
      ctx.setUndoLabel(rep ? 'Update watermark' : 'Add watermark');
      return {pages: list, replace: rep};
    },
  };
}

function background(id, label, replace) {
  return {
    id, label, risk: 'edit', ...(replace ? {} : {dialog: 'dialog.background'}),
    description: replace ? 'Replace the background on the page range.' : 'Add a background color or picture behind the page content.',
    params: bgParams,
    state: replace ? marks('Background') : modification,
    async run(ctx, p) {
      guard(ctx, replace ? marks('Background') : modification);
      let params = p;
      if (replace && p.color === undefined && !p.file) {
        const v = await collect(ctx, 'dialog.background', {__replace: true});
        if (v === null) return {canceled: true};
        if (v) params = {...p, ...bgValues(v, pages(ctx).length)};
      }
      const d = defaultBackground();
      const bg = {color: toRgb(params.color) ?? d.color, opacity: params.opacity ?? d.opacity, source: null, scale: params.scale ?? d.scale};
      const list = targets(ctx, params);
      const rep = replace || !!params.replace;
      let canceled = false;
      await onSource(ctx, list, async (doc, src, extra) => {
        if (params.file) {
          const pic = await pictureOf(ctx, doc, params.file);
          if (pic === undefined) { canceled = true; throw new CommandError('canceled', 'canceled'); }
          bg.source = pic;
        }
        addBackground(doc, src, bg, rep, extra);
      }).catch(e => { if (!canceled) throw e; });
      if (canceled) return {canceled: true};
      ctx.setUndoLabel(rep ? 'Update background' : 'Add background');
      return {pages: list, replace: rep};
    },
  };
}

const REMOVE_LABEL = {HeaderFooter: 'Remove header & footer', Watermark: 'Remove watermark', Background: 'Remove background'};
function remove(id, label, kind) {
  return {
    id, label, risk: 'edit',
    description: `${label} from every page.`,
    params: s.object({}),
    state: marks(kind),
    async run(ctx) {
      guard(ctx, marks(kind));
      const list = pages(ctx).map((_, i) => i);
      const removed = await onSource(ctx, list, (doc, src) => removeMarks(doc, src, kind));
      if (!removed) throw new CommandError('invalid_params', 'there is nothing to remove');
      ctx.setUndoLabel(REMOVE_LABEL[kind]);
      return {removed};
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Links (annot links.rs add_many / remove_all over the model's annotation records)

function linksFromUrls() {
  return {
    id: 'edit.links_from_urls', label: 'Create links from URLs', risk: 'edit',
    description: 'Turn every web address in the page text into a link (Acrobat: Create links from URLs).',
    params: s.object({pages: rangeParams.pages}),
    state: modification,
    async run(ctx, p) {
      guard(ctx, modification);
      const list = p.pages ?? pages(ctx).map((_, i) => i);
      const used = new Set(pages(ctx).flatMap(pg => (pg.annots ?? []).map(r => r.id)));
      let made = 0;
      for (const i of list) {
        const pg = pages(ctx)[i];
        if (!pg) throw new CommandError('not_found', `page ${i + 1} does not exist`, {path: '/pages'});
        const found = await findUrls(ctx.doc, pg);
        const existing = linkRecords(pg);
        const fresh = found.filter(f => !existing.some(r => r.uri === f.uri && overlaps(r.rect, f.rect)));
        if (!fresh.length) continue;
        const annots = [...(pg.annots ?? [])];
        for (const f of fresh) {
          let id = `lnk-${ctx.host.uid()}`;
          while (used.has(id)) id += '~';
          used.add(id);
          annots.push(linkAnnotation(id, f.rect, f.uri));
          made++;
        }
        ctx.change.set(['pages', i, 'annots'], annots);
      }
      if (!made) throw new CommandError('invalid_params', 'no web addresses were found');
      ctx.setUndoLabel(made === 1 ? 'Create link' : 'Create links');
      return {created: made};
    },
  };
}
const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

function removeLinks() {
  return {
    id: 'edit.remove_links', label: 'Remove all links', risk: 'edit',
    description: 'Remove every link annotation (on the given pages, else in the whole document).',
    params: s.object({pages: rangeParams.pages}),
    state: modification,
    run(ctx, p) {
      guard(ctx, modification);
      const list = p.pages ?? pages(ctx).map((_, i) => i);
      let removed = 0;
      for (const i of list) {
        const pg = pages(ctx)[i];
        if (!pg) throw new CommandError('not_found', `page ${i + 1} does not exist`, {path: '/pages'});
        const annots = pg.annots ?? [];
        const kept = annots.filter(r => !isLinkRecord(r));
        if (kept.length !== annots.length) { removed += annots.length - kept.length; ctx.change.set(['pages', i, 'annots'], kept); }
      }
      if (!removed) throw new CommandError('invalid_params', 'there are no links to remove');
      ctx.setUndoLabel('Remove all links');
      return {removed};
    },
  };
}

export {documentOpen};

export default defineCommands({
  family: 'edit',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    headerFooter('edit.header_footer', 'Add header & footer…'),
    headerFooter('edit.header_footer.update', 'Update header & footer…', {replace: true}),
    remove('edit.header_footer.remove', 'Remove header & footer', 'HeaderFooter'),
    headerFooter('edit.bates', 'Add Bates numbering…', {bates: true}),
    watermark('edit.watermark', 'Add watermark…', false),
    watermark('edit.watermark.update', 'Update watermark…', true),
    remove('edit.watermark.remove', 'Remove watermark', 'Watermark'),
    background('edit.background', 'Add background…', false),
    background('edit.background.update', 'Update background…', true),
    remove('edit.background.remove', 'Remove background', 'Background'),
    linksFromUrls(),
    removeLinks(),
  ],
});
