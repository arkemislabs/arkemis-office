// Pages: Organize Pages — rotate, delete, insert (blank, from file, from the page clipboard),
// duplicate, reverse, move, replace, extract, split, crop and page boxes, page labels.
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt):
//  * crates/engine/src/commands.rs:179-397 — the catalog entries (ids, labels, needs Assembly /
//    Document / Modification);
//  * crates/ui-egui/src/commands.rs:346-438 `run_page_command` — what each command does: targets
//    are the selected pages, else the current one; Insert blank page goes after the last target at
//    its size; Reverse takes two or more selected pages among themselves, else the whole document;
//    Rotate Pages… / Number pages… / Set Page Boxes… / Extract… / Split… open their dialogs;
//  * crates/ui-egui/src/editing.rs copy_pages / paste_pages (the page clipboard: Cut refuses to take
//    every page; Paste goes after the selection; pasting into the source document merges field names);
//  * crates/ui-egui/src/workflows/files.rs insert_files / start_replace / extract_selection
//    (Extract: typed ranges else the selection; separate files; delete after extracting);
//  * crates/engine/src/page_filter.rs filter_pages (Rotate Pages' parity: index 1 is page 2;
//    orientation from the shown size);
//  * crates/organize/src/lib.rs rotate_pages / delete_pages (WouldRemoveAllPages, NoSuchPage) /
//    move_pages / reverse_pages ("reversing needs at least two pages") / duplicate_pages /
//    insert_blank_page, boxes.rs set_page_box (margins inward from the media box, a box smaller
//    than a point refused, Remove pins an inherited crop box), labels.rs number_pages,
//    import.rs / import/fields.rs (core/folio/lib/page-import.mjs).
//
// Pure page-list edits (rotate, delete, move, reverse, duplicate) change the model's page records;
// edits that change page objects (blank pages, imported pages, boxes) rewrite the source through
// core/folio/lib/page-source.mjs. Either way one undo step.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {numberPdfPages, previewPdfLabel, dropDeletedPdfLabelPages} from '../../pdf-page-labels.mjs';
import {clearDeletedBookmarkTargets} from '../../pdf-bookmarks.mjs';
import {readPdfLabelRanges} from '../../pdf-label-tree.mjs';
import {writeFolioPdf} from '../model/pdf-write.mjs';
import {readFields} from '../model/pdf-read.mjs';
import {modelFields} from '../lib/form-read.mjs';
import {PDFName} from 'pdf-lib';
import {viewSize, viewRectToUser} from '../lib/geom.mjs';
import {loadSource, loadOther, editable, commit, readNewPages, usedIds, materialize, base64, bytesOf} from '../lib/page-source.mjs';
import {importPages, replacePageContent} from '../lib/page-import.mjs';
import {readOther, writeOther, readState, writeState, isPlainFileName, fileStemFromUser, stem, interactive} from '../lib/page-files.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '3109bb2359759e24ef490e1cdbdba00722b20972',
  files: ['crates/engine/src/commands.rs', 'crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/editing.rs', 'crates/ui-egui/src/workflows/files.rs',
    'crates/ui-egui/src/dialogs.rs', 'crates/engine/src/page_filter.rs', 'crates/organize/src/lib.rs', 'crates/organize/src/boxes.rs',
    'crates/organize/src/labels.rs', 'crates/organize/src/import.rs']};

const pages = ctx => ctx.doc?.pages;
const PDF_FILTER = [{name: 'Adobe PDF Files', extensions: ['pdf']}];

/** commands.rs `Needs::Document`: a PDF is open. */
function documentOpen(ctx) {
  const list = pages(ctx);
  if (!Array.isArray(list) || !list.length) return {enabled: false, reason: 'no PDF open'};
  return {enabled: true};
}
/** printcraft `Assembly`: a document is open whose permissions allow assembling pages. */
function assembly(ctx) {
  const open = documentOpen(ctx);
  if (!open.enabled) return open;
  if (ctx.doc.permissions && ctx.doc.permissions.assemble === false) return {enabled: false, reason: "this PDF's permissions don't allow assembling pages"};
  return {enabled: true};
}
/** printcraft `Modification`: the permissions allow changing the document. */
function modification(ctx) {
  const open = documentOpen(ctx);
  if (!open.enabled) return open;
  if (ctx.doc.permissions && ctx.doc.permissions.modify === false) return {enabled: false, reason: "this PDF's permissions don't allow changes"};
  return {enabled: true};
}
const both = (...states) => ctx => { for (const f of states) { const st = f(ctx); if (!st.enabled) return st; } return {enabled: true}; };
function guard(ctx, state) {
  const st = state(ctx);
  if (!st.enabled) throw new CommandError('disabled', st.reason);
}

/** Pages selected in the page view or the Organize grid (`/pg:<id>` ranges), in document order. */
export function selectedPages(ctx) {
  const list = pages(ctx) ?? [];
  const ids = new Set();
  for (const r of ctx.selection?.ranges ?? []) {
    for (const a of [r.anchor, r.focus]) {
      const m = /^\/pg:([^/]+)$/.exec(String(a ?? ''));
      if (m) ids.add(decodeURIComponent(m[1]));
    }
  }
  return list.flatMap((pg, i) => (ids.has(pg.id) ? [i] : []));
}
/** The current page (0-based). */
export function currentPage(ctx) {
  const list = pages(ctx) ?? [];
  const i = list.findIndex(pg => pg.id === ctx.doc.activePageId);
  return i < 0 ? 0 : i;
}

/** organize `check`: every index is a page. */
function check(ctx, indices) {
  const n = pages(ctx).length;
  const missing = indices.find(i => !Number.isInteger(i) || i < 0 || i >= n);
  if (missing !== undefined) throw new CommandError('not_found', `page ${missing + 1} does not exist`, {path: '/pages', page: missing});
}

/** Target pages (ViewState::target_pages): `pages` (0-based), else the selected pages, else the current page. */
export function targetPages(ctx, requested) {
  if (requested) {
    check(ctx, requested);
    return [...new Set(requested)].sort((a, b) => a - b);
  }
  const selected = selectedPages(ctx);
  return selected.length ? selected : [currentPage(ctx)];
}

/** organize `rotate_pages`: positive degrees turn clockwise; the result is in 0..360. */
export function rotated(current, degrees) {
  if (!Number.isInteger(degrees) || degrees % 90 !== 0) throw new CommandError('invalid_params', 'rotation must be a multiple of 90 degrees');
  return (((current % 360) + 360) % 360 + ((degrees % 360) + 360) % 360) % 360;
}

/** page_filter.rs filter_pages: parity counts page numbers (index 1 is page 2); orientation is the shown size. */
export function filterPages(list, indices, parity = 'both', orientation = 'both') {
  return indices.filter(p => (parity === 'even' ? p % 2 === 1 : parity === 'odd' ? p % 2 === 0 : true)).filter(p => {
    const pg = list[p];
    if (!pg) return false;
    const {width, height} = viewSize(pg);
    return orientation === 'landscape' ? width > height : orientation === 'portrait' ? width <= height : true;
  });
}

const pagesParam = s.optional(s.array(s.integer({min: 0, max: 99999}), {min: 1, max: 10000, description: '0-based page indices (default: the selected pages, else the current page)'}));

function setRotation(ctx, targets, degrees) {
  for (const i of targets) ctx.change.set(['pages', i, 'rotation'], rotated(pages(ctx)[i].rotation ?? 0, degrees));
}

function rotate(id, label, degrees) {
  return {
    id, label, risk: 'edit',
    description: `${label}: the selected pages, or the current page (pages: 0-based indices).`,
    params: s.object({pages: pagesParam}),
    state: assembly,
    run(ctx, p) {
      guard(ctx, assembly);
      const targets = targetPages(ctx, p.pages);
      setRotation(ctx, targets, degrees);
      ctx.setUndoLabel(targets.length === 1 ? 'Rotate page' : 'Rotate pages');
      return {pages: targets, rotation: targets.map(i => pages(ctx)[i].rotation)};
    },
  };
}

/** organize delete_pages over the model: labels close the gap, bookmarks to them lose their target. */
function deleteIndices(ctx, targets) {
  const list = pages(ctx);
  if (targets.length >= list.length) throw new CommandError('invalid_params', 'a document must keep at least one page');
  const gone = new Set(targets);
  const removed = targets.map(i => list[i]);
  const kept = list.filter((_, i) => !gone.has(i));
  let active = ctx.doc.activePageId;
  if (removed.some(p => p.id === active)) {
    const first = Math.min(...targets);
    const after = list.slice(first).find((_, k) => !gone.has(first + k));
    active = (after ?? kept[kept.length - 1]).id;
  }
  const fields = Array.isArray(ctx.doc.fields) ? ctx.doc.fields.map(f => ({...f, widgets: f.widgets.filter(w => !removed.some(p => p.id === w.pageId))})).filter(f => f.widgets.length) : undefined;
  ctx.change.set(['pages'], kept);
  ctx.change.set(['activePageId'], active);
  if (ctx.doc.pageLabels !== undefined) ctx.change.set(['pageLabels'], dropDeletedPdfLabelPages(ctx.doc.pageLabels, targets, kept.length));
  if (ctx.doc.bookmarks !== undefined) {
    let b = ctx.doc.bookmarks;
    for (const p of removed) b = clearDeletedBookmarkTargets(b, p.id);
    ctx.change.set(['bookmarks'], b);
  }
  if (fields) ctx.change.set(['fields'], fields);
  ctx.setSelection({ranges: [], primary: 0});
}

/** Fresh page ids. */
const newPageId = ctx => () => `pg-${ctx.host.uid()}`;

/** Copies of model pages for Duplicate: their comments get ids of their own (ids are unique in a document). */
function copyPage(ctx, page, used) {
  const id = newPageId(ctx)();
  const map = new Map((page.annots ?? []).map(r => {
    let nid = `${r.id}-${id.slice(3, 11)}`;
    while (used.has(nid)) nid += '~';
    used.add(nid);
    return [r.id, nid];
  }));
  const annots = page.annots ? page.annots.map(r => ({...r, id: map.get(r.id), src: undefined, popupSrc: undefined, edited: true,
    ...(r.irt ? {irt: map.get(r.irt) ?? r.irt} : {}), dict: {...r.dict, NM: {$t: map.get(r.id)}}})) : page.annots;
  for (const r of annots ?? []) { delete r.src; delete r.popupSrc; }
  return {...page, id, duplicateOf: page.duplicateOf ?? page.id, ...(annots ? {annots} : {})};
}

/** Insert model page records at `at` (a gap index), select them, show the first. */
function insertRecords(ctx, at, records) {
  const list = [...pages(ctx)];
  list.splice(at, 0, ...records);
  ctx.change.set(['pages'], list);
  ctx.setSelection({ranges: records.map(r => ({anchor: `/pg:${r.id}`, focus: `/pg:${r.id}`})), primary: 0});
}

/** Model fields from the source's form (pdf-read.mjs readFields), widgets by model page id. */
function fieldsFor(doc, list) {
  return modelFields(readFields(doc), list);
}

/**
 * import pages of `other` (pdf-lib document) into the source at gap `at`: the new page records with
 * their comments; form fields registered (renamed on conflict unless `conflicts` is 'merge').
 */
async function insertFrom(ctx, other, srcPages, at, conflicts) {
  const doc = await loadSource(ctx.doc);
  const {indices, renamed} = await importPages(doc, other, srcPages, {conflicts});
  const records = readNewPages(doc, indices, {used: usedIds(ctx.doc), newId: newPageId(ctx)});
  const list = [...pages(ctx)];
  list.splice(at, 0, ...records);
  await commit(ctx, doc, ctx.doc, {pages: list});
  if (Array.isArray(ctx.doc.fields) || renamed.length || records.some(r => r.annots.some(a => a.dict?.Subtype === '/Widget'))) ctx.change.set(['fields'], fieldsFor(doc, list));
  ctx.setSelection({ranges: records.map(r => ({anchor: `/pg:${r.id}`, focus: `/pg:${r.id}`})), primary: 0});
  return {records, renamed};
}

/** The PDF bytes of model pages `indices` (in that order), with their comments, labels and bookmarks (files.rs extract). */
export async function extractBytes(content, indices) {
  const sub = {...content, pages: indices.map(i => content.pages[i])};
  sub.activePageId = sub.pages[0].id;
  if (content.pageLabels !== undefined) {
    const gone = content.pages.map((_, i) => i).filter(i => !indices.includes(i));
    try { sub.pageLabels = dropDeletedPdfLabelPages(content.pageLabels, gone, indices.length); } catch { delete sub.pageLabels; }
  }
  if (content.bookmarks !== undefined) {
    let b = content.bookmarks;
    for (const i of content.pages.keys()) if (!indices.includes(i)) b = clearDeletedBookmarkTargets(b, content.pages[i].id);
    sub.bookmarks = b;
  }
  // Replies whose parent is not extracted lose /IRT (a reply needs its parent).
  const kept = new Set(sub.pages.flatMap(p => (p.annots ?? []).map(r => r.id)));
  sub.pages = sub.pages.map(p => (p.annots ? {...p, annots: p.annots.filter(r => !r.irt || kept.has(r.irt))} : p));
  return writeFolioPdf(sub);
}

// ---------------------------------------------------------------------------------------------
// Page ranges typed in dialogs ("1-3, 5"), 1-based → 0-based (extract_draft.pages_to_extract).

/** Parse "1-3, 5, 8-6" (1-based, ranges may run backwards) into 0-based page indices in the order typed. */
export function parseRanges(text, count) {
  const out = [];
  for (const part of String(text ?? '').split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(t);
    if (!m) throw new CommandError('invalid_params', `"${t}" is not a page range: use page numbers and ranges such as 1-3, 5`, {path: '/ranges'});
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    if (a < 1 || b < 1 || a > count || b > count) throw new CommandError('invalid_params', `page ${Math.max(a, b) > count ? Math.max(a, b) : Math.min(a, b)} does not exist`, {path: '/ranges'});
    const step = a <= b ? 1 : -1;
    for (let p = a; p !== b + step; p += step) out.push(p - 1);
  }
  return out;
}

// Module-level page clipboard (editing.rs `page_clipboard`): one per app process, like upstream's.
let clipboard = null;
/** The page clipboard (tests). */
export const pageClipboard = () => clipboard;
export const clearPageClipboard = () => { clipboard = null; };

const LABEL_STYLES = {decimal: 'D', 'lower-roman': 'r', 'upper-roman': 'R', 'lower-alpha': 'a', 'upper-alpha': 'A', none: null};

const BOXES = {crop: 'CropBox', trim: 'TrimBox', bleed: 'BleedBox', art: 'ArtBox', media: 'MediaBox'};

function boxesOf(page) {
  const rect = b => (b ? [Math.min(b.x, b.x + b.width), Math.min(b.y, b.y + b.height), Math.max(b.x, b.x + b.width), Math.max(b.y, b.y + b.height)] : null);
  const media = rect(page.getMediaBox());
  const inter = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const crop = inter(rect(page.getCropBox()), media);
  return {media, crop, bleed: inter(rect(page.getBleedBox()), media), trim: inter(rect(page.getTrimBox()), media), art: inter(rect(page.getArtBox()), media)};
}

/** boxes.rs set_page_box on pdf-lib pages (validated for every page first). */
export function setPageBox(doc, sourceIndices, which, spec) {
  if (which === 'media' && spec.kind === 'remove') throw new CommandError('invalid_params', "the media box can't be removed");
  const plan = [];
  for (const i of sourceIndices) {
    const page = doc.getPage(i);
    const {media} = boxesOf(page);
    let rect = null;
    if (spec.kind === 'rect') {
      const r = spec.rect;
      if (!r.every(Number.isFinite)) throw new CommandError('invalid_params', 'the rectangle is not a number');
      const n = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
      rect = which === 'media' ? n : [Math.max(n[0], media[0]), Math.max(n[1], media[1]), Math.min(n[2], media[2]), Math.min(n[3], media[3])];
    } else if (spec.kind === 'margins') {
      const m = spec.margins;   // left, bottom, right, top
      if (!m.every(x => Number.isFinite(x) && x >= 0)) throw new CommandError('invalid_params', 'margins must be zero or more');
      rect = [media[0] + m[0], media[1] + m[1], media[2] - m[2], media[3] - m[3]];
    }
    if (rect && (rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1)) throw new CommandError('invalid_params', `page ${plan.length + 1} would be smaller than a point`);
    plan.push({page, rect, media});
  }
  const key = BOXES[which];
  for (const {page, rect, media} of plan) {
    if (rect) page.node.set(pdfName(key), page.node.context.obj(rect));
    else if (which === 'crop' && page.node.get(pdfName(key)) === undefined) page.node.set(pdfName(key), page.node.context.obj(media));   // an inherited crop box would come back
    else page.node.delete(pdfName(key));
  }
}
const pdfName = k => PDFName.of(k);

export default defineCommands({
  family: 'page',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    rotate('page.rotate', 'Rotate pages clockwise', 90),
    rotate('page.rotate_ccw', 'Rotate pages counterclockwise', -90),
    {
      id: 'page.rotate_dialog', label: 'Rotate pages…', risk: 'edit', dialog: 'dialog.rotate-pages',
      description: 'Rotate Pages: a direction for all pages, the selection or a range, filtered to even/odd and landscape/portrait pages.',
      params: s.object({
        degrees: s.enum([90, 180, 270, -90], {description: 'Clockwise degrees (270 = counterclockwise 90)'}),
        pages: pagesParam,
        which: s.optional(s.enum(['all', 'selection', 'range']), 'all'),
        from: s.optional(s.integer({min: 1, max: 100000, description: '1-based first page of the range'})),
        to: s.optional(s.integer({min: 1, max: 100000, description: '1-based last page of the range'})),
        parity: s.optional(s.enum(['both', 'even', 'odd']), 'both'),
        orientation: s.optional(s.enum(['both', 'landscape', 'portrait']), 'both'),
      }),
      state: assembly,
      run(ctx, p) {
        guard(ctx, assembly);
        const n = pages(ctx).length;
        let range;
        if (p.pages) range = targetPages(ctx, p.pages);
        else if (p.which === 'selection') range = targetPages(ctx);
        else if (p.which === 'range') {
          const from = p.from ?? 1, to = Math.max(from, p.to ?? n);
          if (to > n) throw new CommandError('not_found', `page ${to} does not exist`, {path: '/to'});
          range = Array.from({length: to - from + 1}, (_, k) => from - 1 + k);
        } else range = Array.from({length: n}, (_, k) => k);
        const targets = filterPages(pages(ctx), range, p.parity, p.orientation);
        if (!targets.length) return {pages: [], rotation: []};
        setRotation(ctx, targets, p.degrees);
        ctx.setUndoLabel(targets.length === 1 ? 'Rotate page' : 'Rotate pages');
        return {pages: targets, rotation: targets.map(i => pages(ctx)[i].rotation)};
      },
    },
    {
      id: 'page.delete', label: 'Delete pages', risk: 'edit', shortcut: 'Delete', shortcutContext: 'organize',
      description: 'Delete the selected pages (or the current page). A document keeps at least one page.',
      params: s.object({pages: pagesParam}),
      state: assembly,
      run(ctx, p) {
        guard(ctx, assembly);
        const targets = targetPages(ctx, p.pages);
        deleteIndices(ctx, targets);
        ctx.setUndoLabel(targets.length === 1 ? 'Delete page' : 'Delete pages');
        return {deleted: targets, pages: pages(ctx).length};
      },
    },
    {
      id: 'page.insert_blank', label: 'Insert blank page', risk: 'edit',
      description: 'Insert a blank page after the selection (or the current page), the size of the page before it.',
      params: s.object({at: s.optional(s.integer({min: 0, max: 100000, description: '0-based position (default: after the selection)'})),
        width: s.optional(s.number({min: 1, max: 14400})), height: s.optional(s.number({min: 1, max: 14400}))}),
      state: assembly,
      async run(ctx, p) {
        guard(ctx, assembly);
        const targets = targetPages(ctx);
        const last = targets[targets.length - 1];
        const ref = pages(ctx)[p.at !== undefined ? Math.max(0, Math.min(p.at, pages(ctx).length) - 1) : last];
        // commands.rs: the crop box size of the page the blank one follows.
        const w = p.width ?? Math.max(1, Math.abs(ref.box ? ref.box[2] - ref.box[0] : ref.width));
        const h = p.height ?? Math.max(1, Math.abs(ref.box ? ref.box[3] - ref.box[1] : ref.height));
        const at = Math.min(p.at ?? last + 1, pages(ctx).length);
        const doc = await loadSource(ctx.doc);
        doc.addPage([w, h]);
        const [record] = readNewPages(doc, [doc.getPageCount() - 1], {used: usedIds(ctx.doc), newId: newPageId(ctx)});
        const list = [...pages(ctx)];
        list.splice(at, 0, record);
        await commit(ctx, doc, ctx.doc, {pages: list});
        ctx.setSelection({ranges: [{anchor: `/pg:${record.id}`, focus: `/pg:${record.id}`}], primary: 0});
        ctx.setUndoLabel('Insert blank page');
        return {at, page: record.id, width: w, height: h};
      },
    },
    {
      id: 'page.duplicate', label: 'Duplicate pages', risk: 'edit',
      description: 'Insert copies of the selected pages (or the current page) after the last of them, or at `at`.',
      params: s.object({pages: pagesParam, at: s.optional(s.integer({min: 0, max: 100000}))}),
      state: assembly,
      run(ctx, p) {
        guard(ctx, assembly);
        const targets = targetPages(ctx, p.pages);
        const used = usedIds(ctx.doc);
        const copies = targets.map(i => copyPage(ctx, pages(ctx)[i], used));
        const at = Math.min(p.at ?? targets[targets.length - 1] + 1, pages(ctx).length);
        insertRecords(ctx, at, copies);
        ctx.setUndoLabel(copies.length === 1 ? 'Duplicate page' : 'Duplicate pages');
        return {at, pages: copies.map(c => c.id)};
      },
    },
    {
      // printcraft commands.rs `page.organize` and DocView::open_organize (canvas/organize.rs): the page
      // grid opens on the page being read; a selection that leaves that page out is dropped.
      id: 'page.organize', label: 'Organize pages', risk: 'read', effect: 'view', undo: 'none',
      description: 'Organize Pages (All tools ▸ Organize pages): the page thumbnail grid, opened on the page being read; `open: false` closes it.',
      params: s.object({open: s.optional(s.boolean())}),
      state: ctx => { const st = documentOpen(ctx); return st.enabled ? {enabled: true, checked: !!ctx.view?.organize} : st; },
      run(ctx, p) {
        const open = p.open ?? !ctx.view?.organize;
        if (open) {
          const list = pages(ctx) ?? [];
          const cur = list[currentPage(ctx)];
          const chosen = selectedPages(ctx);
          if (cur && chosen.length && !chosen.includes(currentPage(ctx))) {
            const a = `/pg:${encodeURIComponent(cur.id)}`;
            ctx.setSelection({ranges: [{anchor: a, focus: a}], primary: 0});
          }
        }
        ctx.setView({organize: open});
        return {organize: open};
      },
    },
    {
      id: 'page.reverse', label: 'Reverse pages', risk: 'edit',
      description: 'Reverse two or more selected pages among the positions they hold, or every page when fewer are selected.',
      params: s.object({pages: pagesParam}),
      state: assembly,
      run(ctx, p) {
        guard(ctx, assembly);
        const chosen = p.pages ? targetPages(ctx, p.pages) : selectedPages(ctx);
        // Explicit pages go straight to organize reverse_pages; the UI's selection falls back to every page.
        const slots = p.pages || chosen.length >= 2 ? chosen : pages(ctx).map((_, i) => i);
        if (slots.length < 2) throw new CommandError('invalid_params', 'reversing needs at least two pages');
        const list = [...pages(ctx)];
        const moving = slots.map(i => list[i]).reverse();
        slots.forEach((slot, k) => { list[slot] = moving[k]; });
        ctx.change.set(['pages'], list);
        ctx.setUndoLabel('Reverse pages');
        return {pages: slots};
      },
    },
    {
      id: 'page.move', label: 'Move pages', risk: 'edit',
      description: 'Move pages (kept in their order) so they start at position `to` of the result (Organize: drag thumbnails).',
      params: s.object({pages: pagesParam, to: s.integer({min: 0, max: 100000, description: '0-based position in the resulting order'})}),
      state: assembly,
      run(ctx, p) {
        guard(ctx, assembly);
        const sorted = targetPages(ctx, p.pages);
        const list = pages(ctx);
        const moving = sorted.map(i => list[i]);
        const rest = list.filter((_, i) => !sorted.includes(i));
        const at = Math.min(p.to, rest.length);
        rest.splice(at, 0, ...moving);
        ctx.change.set(['pages'], rest);
        ctx.setSelection({ranges: moving.map(m => ({anchor: `/pg:${m.id}`, focus: `/pg:${m.id}`})), primary: 0});
        ctx.setUndoLabel(moving.length === 1 ? 'Move page' : 'Move pages');
        return {pages: moving.map(m => m.id), to: at};
      },
    },
    {
      id: 'page.copy', label: 'Copy pages', risk: 'read', undo: 'none',
      description: 'Copy the selected pages (or the current page) to the page clipboard, for Paste pages here or in another PDF.',
      params: s.object({pages: pagesParam}),
      state: documentOpen,
      async run(ctx, p) {
        guard(ctx, documentOpen);
        const targets = targetPages(ctx, p.pages);
        const bytes = await extractBytes(ctx.doc, targets);
        clipboard = {from: ctx.docId, name: ctx.doc.sourceName || ctx.file?.title || 'Untitled.pdf', base64: base64(bytes), pages: targets.length};
        return {copied: targets.length};
      },
    },
    {
      id: 'page.cut', label: 'Cut pages', risk: 'edit',
      description: 'Copy the selected pages to the page clipboard and delete them (a document keeps at least one page).',
      params: s.object({pages: pagesParam}),
      state: assembly,
      async run(ctx, p) {
        guard(ctx, assembly);
        const targets = targetPages(ctx, p.pages);
        if (targets.length >= pages(ctx).length) throw new CommandError('invalid_params', 'A document needs at least one page: copy instead');
        const bytes = await extractBytes(ctx.doc, targets);
        clipboard = {from: ctx.docId, name: ctx.doc.sourceName || 'Untitled.pdf', base64: base64(bytes), pages: targets.length};
        deleteIndices(ctx, targets);
        ctx.setUndoLabel(targets.length === 1 ? 'Cut page' : 'Cut pages');
        return {cut: targets.length};
      },
    },
    {
      id: 'page.paste', label: 'Paste pages', risk: 'edit',
      description: 'Insert the copied pages after the selection (or the current page).',
      params: s.object({at: s.optional(s.integer({min: 0, max: 100000}))}),
      state: ctx => { const st = assembly(ctx); return st.enabled && !clipboard ? {enabled: false, reason: 'Copy or cut pages first'} : st; },
      async run(ctx, p) {
        guard(ctx, assembly);
        if (!clipboard) throw new CommandError('disabled', 'Copy or cut pages first');
        const other = await loadOther(bytesOf(clipboard.base64), clipboard.name);
        const at = Math.min(p.at ?? Math.max(...targetPages(ctx)) + 1, pages(ctx).length);
        const {records} = await insertFrom(ctx, other, other.getPageIndices(), at, clipboard.from === ctx.docId ? 'merge' : 'rename');
        ctx.setUndoLabel(records.length === 1 ? 'Paste page' : 'Paste pages');
        return {at, pages: records.map(r => r.id)};
      },
    },
    {
      id: 'page.insert', label: 'Insert pages from file…', risk: 'edit', dialog: 'system.open-file',
      description: 'Insert the pages of a PDF (all, or `pages` of it) after the selection, or at `at`; colliding form field names are renamed.',
      params: s.object({
        path: s.optional(s.string({min: 1, max: 4096, description: 'Absolute path of the PDF to insert'})),
        base64: s.optional(s.string({max: 41_000_000, description: 'The PDF bytes, base64 (instead of path)'})),
        name: s.optional(s.string({max: 500})),
        at: s.optional(s.integer({min: 0, max: 100000, description: '0-based position (default: after the selection)'})),
        pages: s.optional(s.array(s.integer({min: 0, max: 99999}), {min: 1, max: 10000, description: '0-based pages of the file (default: all)'})),
      }),
      state: both(assembly, readState),
      async run(ctx, p) {
        guard(ctx, assembly);
        const file = await readOther(ctx, p, {title: 'Select File To Insert', filters: PDF_FILTER});
        if (!file) return {inserted: 0, canceled: true};
        const other = await loadOther(file.bytes, file.name);
        const at = Math.min(p.at ?? Math.max(...targetPages(ctx)) + 1, pages(ctx).length);
        const {records, renamed} = await insertFrom(ctx, other, p.pages ?? other.getPageIndices(), at, 'rename');
        ctx.setUndoLabel(`Insert pages from ${file.name}`);
        return {at, inserted: records.length, pages: records.map(r => r.id), renamedFields: renamed};
      },
    },
    {
      id: 'page.replace', label: 'Replace pages…', risk: 'edit', dialog: 'dialog.replace-pages',
      description: 'Replace what pages from..to show with pages of another PDF; their links, comments, form fields and bookmarks stay.',
      params: s.object({
        path: s.optional(s.string({min: 1, max: 4096})), base64: s.optional(s.string({max: 41_000_000})), name: s.optional(s.string({max: 500})),
        from: s.optional(s.integer({min: 1, max: 100000, description: '1-based first page to replace (default: the selection)'})),
        to: s.optional(s.integer({min: 1, max: 100000})),
        srcFrom: s.optional(s.integer({min: 1, max: 100000, description: '1-based first page of the replacement file'}), 1),
      }),
      state: both(assembly, readState),
      async run(ctx, p) {
        guard(ctx, assembly);
        const file = await readOther(ctx, p, {title: 'Select File With New Pages', filters: PDF_FILTER});
        if (!file) return {replaced: 0, canceled: true};
        const other = await loadOther(file.bytes, file.name);
        const sel = targetPages(ctx);
        const from = (p.from ?? sel[0] + 1) - 1, to = (p.to ?? (p.from ?? sel[sel.length - 1] + 1)) - 1;
        if (to < from) throw new CommandError('invalid_params', 'the last page comes before the first', {path: '/to'});
        check(ctx, [from, to]);
        const targets = Array.from({length: to - from + 1}, (_, k) => from + k);
        const srcStart = p.srcFrom - 1;
        if (srcStart + targets.length > other.getPageCount()) throw new CommandError('invalid_params', `${file.name} has ${other.getPageCount()} pages: not enough to replace ${targets.length} from page ${p.srcFrom}`, {path: '/srcFrom'});
        const {doc, content} = await editable(ctx.doc, targets);
        await replacePageContent(doc, targets.map(i => content.pages[i].sourceIndex), other, targets.map((_, k) => srcStart + k));
        await commit(ctx, doc, content, {refresh: targets});
        ctx.setUndoLabel(targets.length === 1 ? 'Replace page' : 'Replace pages');
        return {replaced: targets.length, pages: targets};
      },
    },
    {
      id: 'page.extract', label: 'Extract pages…', risk: 'edit', dialog: 'dialog.extract',
      description: 'Extract pages (typed ranges, else the selection) to a new PDF, or one PDF per page; optionally delete them afterwards.',
      params: s.object({
        ranges: s.optional(s.string({max: 2000, description: '1-based ranges such as "1-3, 5" (default: the selected pages)'})),
        pages: pagesParam,
        fileName: s.optional(s.string({max: 255})),
        delete: s.optional(s.boolean(), false),
        separate: s.optional(s.boolean(), false),
        path: s.optional(s.string({min: 1, max: 4096, description: 'Where to write the PDF (separate files: a folder)'})),
        open: s.optional(s.boolean({description: 'Open the extracted PDF in a window (default: when saved interactively)'})),
      }),
      state: both(documentOpen, writeState),
      async run(ctx, p) {
        guard(ctx, documentOpen);
        const n = pages(ctx).length;
        const chosen = p.ranges && p.ranges.trim() ? parseRanges(p.ranges, n) : targetPages(ctx, p.pages);
        if (!chosen.length) throw new CommandError('invalid_params', 'no pages to extract', {path: '/ranges'});
        const docStem = stem(ctx.doc.sourceName || ctx.file?.title || 'Document');
        const typed = fileStemFromUser(p.fileName ?? '');
        if (typed && !isPlainFileName(`${typed}.pdf`)) throw new CommandError('invalid_params', 'the name is not a plain file name', {path: '/fileName'});
        const renamed = typed && typed !== fileStemFromUser(docStem);
        const base = typed || docStem;
        const outputs = [];
        if (p.separate) {
          for (const i of chosen) {
            const bytes = await extractBytes(ctx.doc, [i]);
            const name = renamed && chosen.length === 1 ? `${base}.pdf` : `${base} (page ${i + 1}).pdf`;
            const target = p.path ? `${p.path.replace(/[\\/]+$/, '')}/${name}` : undefined;
            outputs.push({name, ...(await writeOther(ctx, {path: target}, bytes, {title: 'Choose a folder for the extracted pages', name, filters: PDF_FILTER}))});
            if (outputs.at(-1).canceled) return {extracted: 0, canceled: true};
          }
        } else {
          const bytes = await extractBytes(ctx.doc, chosen);
          const name = renamed ? `${base}.pdf` : `${docStem} (extract).pdf`;
          const out = await writeOther(ctx, {path: p.path}, bytes, {title: 'Save Extracted Pages As', name, filters: PDF_FILTER});
          if (out.canceled) return {extracted: 0, canceled: true};
          outputs.push({name, ...out});
          // Acrobat opens the extracted pages as a document of their own.
          if (out.path && (p.open ?? interactive(ctx)) && typeof ctx.host.files?.open === 'function') await ctx.host.files.open(out.path, {kind: 'folio', show: true}).catch(() => null);
        }
        if (p.delete) {
          const doomed = [...new Set(chosen)].sort((a, b) => a - b);
          if (doomed.length >= n) throw new CommandError('invalid_params', 'The pages were extracted but not deleted: a document must keep at least one page');
          deleteIndices(ctx, doomed);
          ctx.setUndoLabel(doomed.length === 1 ? 'Delete page' : 'Delete pages');
        }
        return {extracted: chosen.length, files: outputs};
      },
    },
    {
      id: 'page.split', label: 'Split document…', risk: 'read', undo: 'none', dialog: 'dialog.split',
      description: 'Split into files of N pages, at most a size, at the top-level bookmarks, or before each selected page.',
      params: s.object({
        mode: s.enum(['pages', 'size', 'bookmarks', 'selection']),
        every: s.optional(s.integer({min: 1, max: 100000}), 1),
        sizeMb: s.optional(s.number({min: 0.01, max: 10000})),
        folder: s.optional(s.string({min: 1, max: 4096, description: 'Folder the parts are written to'})),
      }),
      state: both(documentOpen, writeState),
      async run(ctx, p) {
        guard(ctx, documentOpen);
        const parts = await splitPlan(ctx, p);
        const docStem = stem(ctx.doc.sourceName || ctx.file?.title || 'Document');
        const written = [];
        for (let k = 0; k < parts.length; k++) {
          const bytes = await extractBytes(ctx.doc, parts[k].pages);
          const name = `${docStem}_Part${k + 1}.pdf`;
          const target = p.folder ? `${p.folder.replace(/[\\/]+$/, '')}/${name}` : undefined;
          const out = await writeOther(ctx, {path: target}, bytes, {title: 'Choose a folder for the split files', name, filters: PDF_FILTER});
          if (out.canceled) return {files: written, canceled: true};
          written.push({name, pages: parts[k].pages.length, ...out});
        }
        return {files: written};
      },
    },
    {
      id: 'page.crop', label: 'Crop pages', risk: 'edit', dialog: 'dialog.page-boxes',
      description: 'Crop pages to a rectangle (page view points from the top-left of the shown page) or by margins from the media box.',
      params: s.object({
        pages: pagesParam,
        rect: s.optional(s.array(s.number({min: -100000, max: 100000}), {min: 4, max: 4, description: '[x, y, width, height] in page view points (crop-box relative, top-left)'})),
        margins: s.optional(s.array(s.number({min: 0, max: 100000}), {min: 4, max: 4, description: '[left, bottom, right, top] points inward from the media box'})),
      }),
      state: assembly,
      async run(ctx, p) {
        guard(ctx, assembly);
        if (!p.rect && !p.margins) throw new CommandError('invalid_params', 'give rect or margins', {path: '/rect'});
        const targets = targetPages(ctx, p.pages);
        const {doc, content} = await editable(ctx.doc, targets);
        if (p.rect) {
          for (const i of targets) {
            const pg = content.pages[i];
            const [x, y, w, h] = p.rect;
            setPageBox(doc, [pg.sourceIndex], 'crop', {kind: 'rect', rect: viewRectToUser(pg, [x, y, x + w, y + h])});
          }
        } else setPageBox(doc, targets.map(i => content.pages[i].sourceIndex), 'crop', {kind: 'margins', margins: p.margins});
        await commit(ctx, doc, content, {refresh: targets});
        ctx.setUndoLabel(targets.length === 1 ? 'Crop page' : 'Crop pages');
        return {pages: targets, boxes: targets.map(i => pages(ctx)[i].box)};
      },
    },
    {
      id: 'page.boxes', label: 'Set page boxes…', risk: 'edit', dialog: 'dialog.page-boxes',
      description: 'Set Page Boxes: set the crop, trim, bleed, art or media box of pages by margins from the media box, or reset it.',
      params: s.object({
        box: s.optional(s.enum(['crop', 'trim', 'bleed', 'art', 'media']), 'crop'),
        margins: s.optional(s.array(s.number({min: 0, max: 100000}), {min: 4, max: 4, description: '[left, bottom, right, top] points'})),
        rect: s.optional(s.array(s.number({min: -100000, max: 100000}), {min: 4, max: 4, description: '[x0, y0, x1, y1] in PDF user space'})),
        remove: s.optional(s.boolean()),
        pages: pagesParam,
        which: s.optional(s.enum(['all', 'current', 'range'])),
        from: s.optional(s.integer({min: 1, max: 100000})), to: s.optional(s.integer({min: 1, max: 100000})),
      }),
      state: assembly,
      async run(ctx, p) {
        guard(ctx, assembly);
        const n = pages(ctx).length;
        const targets = p.pages ? targetPages(ctx, p.pages)
          : p.which === 'all' ? Array.from({length: n}, (_, k) => k)
            : p.which === 'range' ? rangeOf(ctx, p.from, p.to)
              : [currentPage(ctx)];
        const spec = p.remove ? {kind: 'remove'} : p.rect ? {kind: 'rect', rect: p.rect} : p.margins ? {kind: 'margins', margins: p.margins} : null;
        if (!spec) throw new CommandError('invalid_params', 'give margins, rect or remove', {path: '/margins'});
        const {doc, content} = await editable(ctx.doc, targets);
        setPageBox(doc, targets.map(i => content.pages[i].sourceIndex), p.box, spec);
        await commit(ctx, doc, content, {refresh: targets});
        ctx.setUndoLabel('Set page boxes');
        return {pages: targets, box: p.box};
      },
    },
    {
      id: 'page.number', label: 'Number pages…', risk: 'edit', dialog: 'dialog.number-pages',
      description: 'Page labels: number pages from..to in a style with a prefix, starting at a number; later pages keep their labels.',
      params: s.object({
        from: s.integer({min: 1, max: 100000, description: '1-based first page'}),
        to: s.integer({min: 1, max: 100000, description: '1-based last page'}),
        style: s.optional(s.enum(['decimal', 'lower-roman', 'upper-roman', 'lower-alpha', 'upper-alpha', 'none']), 'decimal'),
        prefix: s.optional(s.string({max: 200}), ''),
        start: s.optional(s.integer({min: 1, max: 2147483647}), 1),
        extend: s.optional(s.boolean({description: 'Extend the numbering of the preceding section to these pages'})),
      }),
      state: modification,
      async run(ctx, p) {
        guard(ctx, modification);
        const n = pages(ctx).length;
        if (p.to < p.from) throw new CommandError('invalid_params', 'the last page comes before the first', {path: '/to'});
        if (p.to > n) throw new CommandError('not_found', `page ${p.to} does not exist`, {path: '/to'});
        const current = await currentLabels(ctx);
        let style = LABEL_STYLES[p.style], prefix = p.prefix, start = p.start;
        if (p.extend && p.from > 1) {
          // Acrobat: Extend numbering used in preceding section to selected pages.
          const prev = [...current].sort((a, b) => a.start - b.start).filter(r => r.start <= p.from - 2).at(-1);
          if (prev) { style = prev.style; prefix = prev.prefix; start = prev.first + (p.from - 1 - prev.start); }
        }
        const next = numberPdfPages(current, n, p.from - 1, p.to - 1, style, prefix, start);
        ctx.change.set(['pageLabels'], next);
        ctx.setUndoLabel('Number pages');
        return {labels: next, preview: previewPdfLabel(style, start)};
      },
    },
  ],
});

function rangeOf(ctx, from, to) {
  const n = pages(ctx).length;
  const a = (from ?? 1) - 1, b = (to ?? n) - 1;
  if (b < a) throw new CommandError('invalid_params', 'the last page comes before the first', {path: '/to'});
  check(ctx, [a, b]);
  return Array.from({length: b - a + 1}, (_, k) => a + k);
}

/** The document's page label ranges: the model's, else the file's (labels.rs page_label_ranges). */
async function currentLabels(ctx) {
  if (ctx.doc.pageLabels !== undefined) return ctx.doc.pageLabels;
  try {
    const doc = await loadSource(ctx.doc);
    const ranges = readPdfLabelRanges(doc);
    // Source labels are by source page; only usable while the model shows the source in order.
    const inOrder = ctx.doc.pages.length === doc.getPageCount() && ctx.doc.pages.every((pg, i) => pg.sourceIndex === i);
    return inOrder ? ranges : [];
  } catch { return []; }
}

/** dialogs.rs Split: the parts, as model page lists. */
async function splitPlan(ctx, p) {
  const n = pages(ctx).length;
  const all = Array.from({length: n}, (_, k) => k);
  const chunks = cuts => {
    const starts = [0, ...cuts.filter(c => c > 0 && c < n)].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
    return starts.map((s0, k) => ({pages: all.slice(s0, starts[k + 1] ?? n)}));
  };
  if (p.mode === 'pages') {
    const cuts = [];
    for (let k = p.every; k < n; k += p.every) cuts.push(k);
    if (!cuts.length) throw new CommandError('invalid_params', `the document has ${n} pages: nothing to split into files of ${p.every}`, {path: '/every'});
    return chunks(cuts);
  }
  if (p.mode === 'selection') {
    const cuts = selectedPages(ctx);
    if (!cuts.filter(c => c > 0).length) throw new CommandError('invalid_params', 'Select the pages to split before in Organize Pages (not the first page)');
    return chunks(cuts);
  }
  if (p.mode === 'bookmarks') {
    const top = (ctx.doc.bookmarks ?? []).map(b => pages(ctx).findIndex(pg => pg.id === b.pageId)).filter(i => i > 0);
    if (!top.length) throw new CommandError('invalid_params', 'the document has no top-level bookmarks that point at pages after the first');
    return chunks(top);
  }
  // size: greedily add pages while the part stays under the limit.
  if (!p.sizeMb) throw new CommandError('invalid_params', 'give sizeMb', {path: '/sizeMb'});
  const limit = p.sizeMb * 1024 * 1024;
  const parts = [];
  let current = [];
  for (const i of all) {
    const trial = [...current, i];
    const size = (await extractBytes(ctx.doc, trial)).length;
    if (size > limit && current.length) { parts.push({pages: current}); current = [i]; } else current = trial;
  }
  if (current.length) parts.push({pages: current});
  if (parts.length < 2) throw new CommandError('invalid_params', `the document is under ${p.sizeMb} MB: nothing to split`, {path: '/sizeMb'});
  return parts;
}

export {materialize};
