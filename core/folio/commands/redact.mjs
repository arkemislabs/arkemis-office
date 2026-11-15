// Redact: mark text and areas (the Redact tool), Redact pages, Find text and redact (a phrase, a word
// list, or phone numbers, emails, card numbers, social security numbers and dates), Redaction tool
// properties, Apply redactions, Clear marks, and Remove hidden information / Sanitize document.
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972
// (MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/engine/src/commands.rs:306-313   catalog ids, labels, Needs (Modification, Document, HasRedactions)
//   crates/ui-egui/src/commands.rs:724-764  what each id does (the tool, the dialogs, Apply, Clear, Sanitize)
//   crates/ui-egui/src/tools/redact_ui.rs   RedactPrefs (mark, overlay_text), the tool input (text selection or a
//                                           box), redact_search, redact_pages, the dialogs, remove hidden
//   crates/redact/src/** and crates/engine    lib/redact*.mjs
//
// A mark is a Redact comment (model/annots.mjs, written as a real /Subtype /Redact annotation on Save);
// Apply rewrites the page content (lib/redact.mjs) and stores the new source in one undoable change,
// with the marks and the comments under them taken out of the page records. Apply is irreversible for
// the saved file, as the confirmation says: undo restores the unredacted document in this session.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/redact.test.mjs.
//
// Geometry in params is in the bridge convention (docs/architecture.md 14.5): page view points, origin
// at the top-left of the displayed page (crop box, rotation applied).

import '../../common/lib/pdf-guard.mjs';
import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {parseTextRange} from '../../kernel/address.mjs';
import {createAnnotation} from '../model/annots.mjs';
import {defaultStyle} from '../model/types.mjs';
import {meta, author, rangeQuads, pageText} from '../model/index.mjs';
import {viewRectToQuad, pageRotation, cropBox, userRectToView} from '../lib/geom.mjs';
import {pagesOf} from '../lib/comment-geometry.mjs';
import {editable, base64} from '../lib/page-source.mjs';
import {readFields, modelFields} from '../lib/form-read.mjs';
import {PDF_MAX_BYTES} from '../../pdf-model.mjs';
import {PDFDocument} from 'pdf-lib';
import {unicodeFor, needsUnicode} from '../lib/unicode-text.mjs';
import * as R from '../lib/redact.mjs';
import * as X from '../lib/redact-patterns.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '3109bb2359759e24ef490e1cdbdba00722b20972',
  files: ['crates/engine/src/commands.rs', 'crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/tools/redact_ui.rs', 'crates/redact/src/lib.rs',
    'crates/redact/src/interp.rs', 'crates/redact/src/image.rs', 'crates/redact/src/overlay.rs', 'crates/redact/src/patterns.rs', 'crates/redact/src/codes.rs',
    'crates/redact/src/sanitize.rs', 'crates/annot/src/create.rs']};

// ── states ─────────────────────────────────────────────────────────────────────────────────────

const noPdf = {enabled: false, reason: 'no PDF open'};
const documentState = ctx => (pagesOf(ctx).length ? {enabled: true} : noPdf);
/** Needs::Modification. */
function modificationState(ctx) {
  if (!pagesOf(ctx).length) return noPdf;
  if (ctx.doc.permissions && ctx.doc.permissions.modify === false) return {enabled: false, reason: "this PDF's permissions don't allow changes"};
  if (ctx.doc.folio !== 2) return {enabled: false, reason: 'the PDF is still opening'};
  return {enabled: true};
}
/** Needs::HasRedactions. */
function hasMarksState(ctx) {
  const st = modificationState(ctx);
  if (!st.enabled) return st;
  return R.marksOf(ctx.doc).length ? {enabled: true} : {enabled: false, reason: 'there are no redaction marks'};
}

// ── Redaction tool properties (RedactPrefs) ────────────────────────────────────────────────────

export const DEFAULT_PREFS = Object.freeze({
  fill: [0, 0, 0], useOverlay: false, overlay: '', useCode: false, codeSet: 'foia', codes: [],
  look: {font: 'Helv', size: 0, color: [1, 0, 0], align: 1, repeat: false}, outline: [0.89, 0.13, 0.13], hoverFill: [0.89, 0.13, 0.13], opacity: 1,
});
const rgb3 = v => Array.isArray(v) && v.length === 3 && v.every(x => Number.isFinite(x) && x >= 0 && x <= 1);

/** The saved properties, each taken only when it reads as what it should be; anything else keeps the default (RedactPrefs::from_json). */
export function prefsOf(ctx) {
  const saved = ctx.prefs?.redact;
  const d = structuredClone(DEFAULT_PREFS);
  if (!saved || typeof saved !== 'object') return d;
  if (saved.fill === null) d.fill = null; else if (rgb3(saved.fill)) d.fill = saved.fill;
  if (typeof saved.useOverlay === 'boolean') d.useOverlay = saved.useOverlay;
  if (typeof saved.overlay === 'string' && saved.overlay.length <= 1000) d.overlay = saved.overlay;
  if (typeof saved.useCode === 'boolean') d.useCode = saved.useCode;
  const set = X.CODE_SETS.find(c => c.id === saved.codeSet);
  if (set) { d.codeSet = set.id; d.codes = Array.isArray(saved.codes) ? saved.codes.filter(c => set.codes.includes(c)) : []; }
  const l = saved.look ?? {};
  if (['Helv', 'TiRo', 'Cour'].includes(l.font)) d.look.font = l.font;
  if (Number.isFinite(l.size) && l.size >= 0 && l.size <= 400) d.look.size = l.size;
  if (rgb3(l.color)) d.look.color = l.color;
  if ([0, 1, 2].includes(l.align)) d.look.align = l.align;
  if (typeof l.repeat === 'boolean') d.look.repeat = l.repeat;
  if (rgb3(saved.outline)) d.outline = saved.outline;
  if (rgb3(saved.hoverFill)) d.hoverFill = saved.hoverFill;
  if (Number.isFinite(saved.opacity) && saved.opacity >= 0 && saved.opacity <= 1) d.opacity = saved.opacity;
  return d;
}

/** RedactPrefs::overlay_text. */
export function overlayTextOf(p) {
  if (!p.useOverlay) return '';
  if (!p.useCode) return p.overlay;
  const set = X.CODE_SETS.find(c => c.id === p.codeSet) ?? X.CODE_SETS[0];
  return X.codesOverlay(set, p.codes);
}

/** RedactPrefs::mark: the comment record for a mark with these quads. */
function markRecord(ctx, prefs, quads, rotation) {
  const shape = {kind: 'Redact', quads, overlay: overlayTextOf(prefs), look: prefs.look};
  const style = {...defaultStyle(shape), fill: prefs.fill, color: prefs.outline, opacity: Math.min(1, Math.max(0, prefs.opacity))};
  return createAnnotation({shape, style, contents: '', author: author(ctx), rotation}, meta(ctx));
}

/** Add records to their pages as one change. `byPage`: Map(pageIndex -> records). */
function addRecords(ctx, byPage) {
  for (const [pi, records] of byPage) ctx.change.splice(['pages', pi, 'annots'], (ctx.doc.pages[pi].annots ?? []).length, 0, ...records);
}

const pageIndexById = (ctx, id) => {
  const i = pagesOf(ctx).findIndex(p => p.id === id);
  if (i < 0) throw new CommandError('not_found', `page ${id} does not exist`, {page: id});
  return i;
};

function textTarget(ctx, address) {
  const part = a => {
    const m = /^\/pg:([^/]+)\/chars:(\d+)(?:-(\d+))?$/.exec(String(a ?? ''));
    return m ? {pageId: decodeURIComponent(m[1]), ...parseTextRange(m[3] === undefined ? m[2] : `${m[2]}-${m[3]}`)} : null;
  };
  if (address) {
    const t = part(address);
    if (!t) throw new CommandError('invalid_params', 'text must be a page text range /pg:<id>/chars:<from>-<to>', {path: '/text'});
    return t;
  }
  const sel = ctx.selection?.ranges?.[ctx.selection.primary ?? 0];
  if (!sel) return null;
  const a = part(sel.anchor);
  const f = part(sel.focus);
  if (!a || !f || a.pageId !== f.pageId) return null;
  const from = Math.min(a.from, f.from, a.to, f.to);
  const to = Math.max(a.from, f.from, a.to, f.to);
  return to > from ? {pageId: a.pageId, from, to} : null;
}

const MODES = ['Single word or phrase', 'Multiple words or phrases', 'Patterns'];
const PATTERN_LABELS = X.PATTERNS.map(p => p.label);

// ── apply ──────────────────────────────────────────────────────────────────────────────────────

const rectsOverlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** The comments left on a page after removing those under the rects, their replies and Redact marks. */
function surviving(page, rects) {
  const list = page.annots ?? [];
  const gone = new Set();
  for (const r of list) {
    if (r.dict?.Subtype === '/Redact') { gone.add(r.id); continue; }
    const v = r.dict?.Rect;
    if (Array.isArray(v) && v.length === 4) {
      const box = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
      if (rects.some(x => rectsOverlap(x, box))) gone.add(r.id);
    }
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const r of list) if (!gone.has(r.id) && r.irt && gone.has(r.irt)) { gone.add(r.id); grew = true; }
  }
  return {kept: list.filter(r => !gone.has(r.id)), removed: list.filter(r => gone.has(r.id) && r.dict?.Subtype !== '/Redact').length};
}

async function applyRedactions(ctx, pageNumbers) {
  const content = ctx.doc;
  const all = R.marksOf(content);
  const wanted = pageNumbers ? new Set(pageNumbers.map(n => n - 1)) : null;
  const chosen = all.filter(m => !wanted || wanted.has(m.page));
  if (!chosen.length) throw new CommandError('failed', 'There are no redaction marks to apply.');
  const unreadable = chosen.filter(m => m.unreadable).length;
  if (unreadable) throw new CommandError('failed', `${unreadable} redaction mark(s) have no readable area (neither usable QuadPoints nor a usable Rect), so the text under them can't be known; nothing was redacted. Remove those marks or mark the text again, then apply again.`);
  const pages = [...new Set(chosen.map(m => m.page))];
  const {doc, content: base} = await editable(content, pages);
  // Marks speak of model pages; the document's pages are the source pages of the (materialized) model.
  const marks = chosen.map(m => ({...m, page: base.pages[m.page].sourceIndex}));
  let report;
  // An overlay text in a script the standard faces cannot draw is set with a system font, embedded in the document being rewritten.
  const unicode = await unicodeFor(doc, marks.map(m => m.overlay).filter(needsUnicode));
  try { report = R.applyMarks(doc, marks, {unicode}); } catch (e) { throw e instanceof R.RedactError ? new CommandError(e.code === 'undrawable' || e.code === 'vertical' || e.code === 'limit' ? 'failed' : 'failed', e.message) : e; }
  const bytes = await doc.save({updateFieldAppearances: false});
  if (bytes.length > PDF_MAX_BYTES) throw new CommandError('too_large', 'The PDF would exceed the 10 MB limit');
  // Verify: nothing readable may remain under a region (fail closed).
  const check = await PDFDocument.load(bytes, {updateMetadata: false, ignoreEncryption: true});
  const residue = R.residueOf(check, marks);
  if (residue) throw new CommandError('failed', `Redaction could not be verified: ${residue} item(s) were still found under the marks, so nothing was changed.`);
  const list = base.pages.map(p => ({...p}));
  let comments = 0;
  for (const pi of pages) {
    const rects = chosen.filter(m => m.page === pi).flatMap(m => m.rects);
    const {kept, removed} = surviving(list[pi], rects);
    comments += removed;
    list[pi] = {...list[pi], annots: kept};
  }
  ctx.change.set(['sourceBase64'], base64(bytes));
  ctx.change.set(['pages'], list);
  ctx.change.set(['fields'], modelFields(readFields(check), list));
  ctx.setUndoLabel('Apply redactions');
  return {marks: chosen.length, pages: pages.length, ...report, comments, verified: true, note: 'Save the document afterwards: saving rewrites the whole file so no trace of the removed content stays in it.'};
}

// ── commands ───────────────────────────────────────────────────────────────────────────────────

const color3 = s.array(s.number({min: 0, max: 1}), {min: 3, max: 3});

export default defineCommands({
  family: 'redact', app: 'folio', upstream: UPSTREAM,
  commands: [
    {
      id: 'redact.mark', label: 'Redact text and images', risk: 'edit', needs: 'worker',
      description: 'Redact text and images (the Redact tool): mark the selected text (or `text`, or `page` + `rects` of lines) or a box (`page` + `area` [x, y, width, height]) for redaction with the tool\'s properties. Marks are drawn red on the page; nothing is removed until Apply redactions. With nothing to mark, picks the tool.',
      params: s.object({
        text: s.optional(s.address('text', {description: 'Page text range /pg:<id>/chars:<from>-<to> (default: the text selection)'})),
        page: s.optional(s.string({min: 1, max: 120, description: 'Page id, with rects or area'})),
        rects: s.optional(s.array(s.array(s.number(), {min: 4, max: 4}), {min: 1, max: 10000, description: 'One [x0,y0,x1,y1] per line in page view points (top-left origin)'})),
        area: s.optional(s.array(s.number({min: -100000, max: 100000}), {min: 4, max: 4, description: '[x, y, width, height] in page view points (top-left origin)'})),
      }),
      state(ctx) { const st = modificationState(ctx); return {...st, checked: ctx.view?.tool === 'redact.mark'}; },
      async run(ctx, p) {
        const prefs = prefsOf(ctx);
        let pi;
        let quads;
        if (p.rects || p.area) {
          if (!p.page) throw new CommandError('invalid_params', 'rects and area need the page they are on', {path: '/page'});
          pi = pageIndexById(ctx, p.page);
          const page = pagesOf(ctx)[pi];
          const list = p.area ? [[p.area[0], p.area[1], p.area[0] + p.area[2], p.area[1] + p.area[3]]] : p.rects;
          quads = list.map(r => viewRectToQuad(page, [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]));
        } else {
          const target = textTarget(ctx, p.text);
          if (!p.text) ctx.setView({tool: 'redact.mark', highlighter: false});
          if (!target) return {tool: 'redact.mark'};
          pi = pageIndexById(ctx, target.pageId);
          const page = pagesOf(ctx)[pi];
          const text = await pageText(ctx.doc, page);
          const g = text.glyphRange(target.from, target.to);
          if (!g) throw new CommandError('invalid_params', 'the selected range holds no text', {path: '/text'});
          quads = rangeQuads(page, text, g[0], g[1]);
        }
        const page = pagesOf(ctx)[pi];
        const record = markRecord(ctx, prefs, quads, pageRotation(page));
        addRecords(ctx, new Map([[pi, [record]]]));
        ctx.setSelection({ranges: [], primary: 0});
        ctx.setUndoLabel('Mark for redaction');
        return {id: record.id, annotation: `/pg:${encodeURIComponent(page.id)}/annot:${encodeURIComponent(record.id)}`, quads};
      },
    },
    {
      id: 'redact.pages', label: 'Redact pages…', risk: 'edit', needs: 'worker',
      description: 'Redact pages (Mark Page Range): mark whole pages for redaction, the page shown when `from` and `to` are not given, else pages `from` to `to` (1-based, inclusive).',
      params: s.object({from: s.optional(s.integer({min: 1, max: 100000})), to: s.optional(s.integer({min: 1, max: 100000}))}),
      state: modificationState,
      run(ctx, p) {
        const n = pagesOf(ctx).length;
        let first;
        let last;
        if (p.from === undefined && p.to === undefined) { const cur = pagesOf(ctx).findIndex(x => x.id === ctx.doc.activePageId); first = last = Math.max(0, cur); }
        else { first = (p.from ?? 1) - 1; last = Math.min(n, p.to ?? p.from ?? 1) - 1; }
        if (first < 0 || first >= n || last < first) throw new CommandError('invalid_params', `pages ${first + 1} to ${last + 1} do not exist (the document has ${n})`, {path: '/from'});
        const prefs = prefsOf(ctx);
        const byPage = new Map();
        for (let i = first; i <= last; i++) {
          const pg = pagesOf(ctx)[i];
          const c = cropBox(pg);
          byPage.set(i, [markRecord(ctx, prefs, [[c[0], c[1], c[2], c[1], c[0], c[3], c[2], c[3]]], pageRotation(pg))]);
        }
        addRecords(ctx, byPage);
        ctx.setUndoLabel(first === last ? 'Mark for redaction' : 'Mark pages for redaction');
        return {marked: last - first + 1};
      },
    },
    {
      id: 'redact.search', label: 'Find text and redact…', risk: 'edit', needs: 'worker',
      description: `Find text and redact: mark every match for redaction on every page. \`mode\` is "${MODES[0]}" (\`text\`), "${MODES[1]}" (\`words\`, one per line) or "${MODES[2]}" (\`pattern\`: ${PATTERN_LABELS.join(', ')}); \`wholeWords\` and \`caseSensitive\` apply to the first two. Text in images isn't found: recognise text first. Returns how many matches were marked.`,
      params: s.object({
        mode: s.optional(s.enum(MODES)), text: s.optional(s.string({max: 1000})), words: s.optional(s.string({max: 1_000_000})),
        pattern: s.optional(s.enum([...PATTERN_LABELS, 'Credit Card Numbers'])), wholeWords: s.optional(s.boolean()), caseSensitive: s.optional(s.boolean()),
      }),
      state: modificationState,
      async run(ctx, p) {
        const mode = p.mode ?? (p.pattern ? MODES[2] : p.words ? MODES[1] : MODES[0]);
        const needles = mode === MODES[0] ? (p.text?.trim() ? [p.text] : []) : mode === MODES[1] ? X.wordList(p.words ?? '') : [];
        const pattern = mode === MODES[2] ? X.patternOfLabel(p.pattern ?? PATTERN_LABELS[0]) : null;
        if (mode !== MODES[2] && !needles.length) return {marked: 0};
        const prefs = prefsOf(ctx);
        const byPage = new Map();
        let marked = 0;
        const pages = pagesOf(ctx);
        for (let pi = 0; pi < pages.length; pi++) {
          const text = await pageText(ctx.doc, pages[pi]);
          const hits = pattern
            ? text.findWith(chars => X.find(pattern.id, chars))
            : needles.flatMap(w => text.find(w, {caseSensitive: !!p.caseSensitive, wholeWords: !!p.wholeWords}));
          for (const [a, b] of hits) {
            const quads = text.lineRects(a, b).map(r => viewRectToQuad(pages[pi], r));
            if (!quads.length) continue;
            (byPage.get(pi) ?? byPage.set(pi, []).get(pi)).push(markRecord(ctx, prefs, quads, pageRotation(pages[pi])));
            marked++;
          }
        }
        if (marked) { addRecords(ctx, byPage); ctx.setUndoLabel('Mark for redaction'); }
        return {marked};
      },
    },
    {
      id: 'redact.properties', label: 'Redaction properties…', risk: 'edit', effect: 'prefs', undo: 'none', scope: 'app',
      description: 'Redaction Tool Properties: what new marks look like once applied: the box colour (`fill`, null for none), the overlay text (`overlay`, or the picked `codes` of a redaction `codeSet`: U.S. FOIA, U.S. Privacy Act), its `font` (Helv, TiRo, Cour), `size` (0 = fit the region), `color`, `align` (0 left, 1 centre, 2 right) and `repeat`; and the unapplied mark\'s `outline` colour and `opacity`. Without params, returns the properties.',
      params: s.object({
        fill: s.optional(s.union([color3, s.literal(null)])), useOverlay: s.optional(s.boolean()), overlay: s.optional(s.string({max: 1000})),
        useCode: s.optional(s.boolean()), codeSet: s.optional(s.enum(X.CODE_SETS.map(c => c.id))), codes: s.optional(s.array(s.string({max: 20}), {max: 100})),
        font: s.optional(s.enum(['Helv', 'TiRo', 'Cour'])), size: s.optional(s.number({min: 0, max: 400})), color: s.optional(color3), align: s.optional(s.integer({min: 0, max: 2})),
        repeat: s.optional(s.boolean()), outline: s.optional(color3), hoverFill: s.optional(color3), opacity: s.optional(s.number({min: 0, max: 1})),
      }),
      state: documentState,
      run(ctx, p) {
        const cur = prefsOf(ctx);
        const next = {...cur, look: {...cur.look}};
        for (const k of ['fill', 'useOverlay', 'overlay', 'useCode', 'codeSet', 'outline', 'hoverFill', 'opacity']) if (p[k] !== undefined) next[k] = p[k];
        if (p.codes !== undefined) next.codes = p.codes;
        if (p.font !== undefined) next.look.font = p.font;
        if (p.size !== undefined) next.look.size = p.size;
        if (p.color !== undefined) next.look.color = p.color;
        if (p.align !== undefined) next.look.align = p.align;
        if (p.repeat !== undefined) next.look.repeat = p.repeat;
        const set = X.CODE_SETS.find(c => c.id === next.codeSet);
        const bad = next.codes.find(c => !set.codes.includes(c));
        if (bad !== undefined) throw new CommandError('invalid_params', `${bad} is not a code of ${set.name}`, {path: '/codes'});
        if (Object.keys(p).length) ctx.updatePrefs({redact: next});
        return {...next, overlayText: overlayTextOf(next)};
      },
    },
    {
      id: 'redact.apply', label: 'Apply redactions…', risk: 'destructive', needs: 'worker',
      description: 'Apply redactions: remove, for good, the text, images and drawings under the marks (cut out of the page content, not covered), the comments, links and form fields that overlap them, then draw each mark\'s box with its overlay text. Every redacted page is read again afterwards; if anything is still under a mark nothing is changed. `pages` (1-based) limits it. Save afterwards: saving rewrites the whole file.',
      params: s.object({pages: s.optional(s.array(s.integer({min: 1, max: 100000}), {min: 1, max: 100000}))}),
      state: hasMarksState,
      // Short, like the other commands' summaries: it is the approval request's headline and the toast after an agent's approved action.
      summary: (ctx, p) => { const n = R.marksOf(ctx.doc).filter(m => !p?.pages || p.pages.includes(m.page + 1)).length; return `Apply ${n} redaction mark${n === 1 ? '' : 's'}`; },
      run: (ctx, p) => applyRedactions(ctx, p.pages),
    },
    {
      id: 'redact.clear', label: 'Clear redaction marks', risk: 'edit', needs: 'worker',
      description: 'Clear all redaction marks without applying them.',
      params: s.object({}),
      state: hasMarksState,
      run(ctx) {
        let n = 0;
        pagesOf(ctx).forEach((page, pi) => {
          const kept = (page.annots ?? []).filter(r => r.dict?.Subtype !== '/Redact');
          if (kept.length !== (page.annots ?? []).length) { n += (page.annots ?? []).length - kept.length; ctx.change.set(['pages', pi, 'annots'], kept); }
        });
        ctx.setUndoLabel('Clear redaction marks');
        return {cleared: n};
      },
    },
    {
      id: 'redact.marks', label: 'Read redaction marks', risk: 'read', effect: 'view',
      description: 'The redaction marks of the document: page, areas (user space), box colour and overlay text.',
      params: s.object({}),
      state: documentState,
      run: ctx => ({marks: R.marksOf(ctx.doc).map(({page, id, rects, fill, overlay}) => ({page: page + 1, id, rects, fill, overlay}))}),
    },
    {
      id: 'protect.remove_hidden', label: 'Remove hidden information…', risk: 'destructive', needs: 'worker',
      description: `Remove hidden information: remove the chosen categories (${R.HIDDEN.map(h => h.id).join(', ')}) from the document; with none chosen, every category with something in it. Form fields are flattened (their values stay visible), hidden text and layers are cut out of the page content. Save afterwards: saving rewrites the whole file.`,
      params: s.object({items: s.optional(s.array(s.enum(R.HIDDEN.map(h => h.id)), {max: 20}))}),
      state: modificationState,
      summary: (ctx, p) => `Remove hidden information${p?.items?.length ? ` (${p.items.join(', ')})` : ''}`,
      async run(ctx, p) { return removeHiddenCommand(ctx, p.items, 'Remove hidden information'); },
    },
    {
      id: 'redact.sanitize', label: 'Sanitize document…', risk: 'destructive', needs: 'worker',
      description: 'Sanitize document: remove hidden information of every kind: metadata, file attachments, comments, form fields (flattened), hidden text and layers, bookmarks, links, actions and scripts, and private application data. Save afterwards: saving rewrites the whole file so nothing removed stays in it.',
      params: s.object({}),
      state: modificationState,
      summary: () => 'Sanitize the document',
      async run(ctx) { return removeHiddenCommand(ctx, R.HIDDEN.map(h => h.id), 'Sanitize document'); },
    },
    {
      id: 'redact.hidden_scan', label: 'Scan for hidden information', risk: 'read', needs: 'worker',
      description: 'What Remove hidden information would remove: each category with how many items it holds.',
      params: s.object({}),
      state: documentState,
      async run(ctx) {
        const {doc} = await editable(ctx.doc);
        return {found: R.scanHidden(doc)};
      },
    },
  ],
});

async function removeHiddenCommand(ctx, items, label) {
  const content = ctx.doc;
  const {doc, content: base} = await editable(content);
  const ids = items?.length ? items : R.scanHidden(doc).filter(x => x.count > 0).map(x => x.id);
  if (!ids.length) return {removed: {}, nothing: true};
  const {removed} = R.removeHidden(doc, ids);
  const bytes = await doc.save({updateFieldAppearances: false});
  if (bytes.length > PDF_MAX_BYTES) throw new CommandError('too_large', 'The PDF would exceed the 10 MB limit');
  const reread = await PDFDocument.load(bytes, {updateMetadata: false, ignoreEncryption: true});
  const list = base.pages.map(p => ({...p}));
  if (ids.includes('comments')) list.forEach((p, i) => { list[i] = {...p, annots: (p.annots ?? []).filter(r => r.dict?.Subtype === '/Redact')}; });
  if (ids.includes('attachments')) list.forEach((p, i) => { list[i] = {...p, annots: (p.annots ?? []).filter(r => r.dict?.Subtype !== '/FileAttachment')}; });
  if (ids.includes('links-actions-scripts')) list.forEach((p, i) => { list[i] = {...p, annots: (p.annots ?? []).filter(r => r.dict?.Subtype !== '/Link')}; });
  ctx.change.set(['sourceBase64'], base64(bytes));
  ctx.change.set(['pages'], list);
  ctx.change.set(['fields'], modelFields(readFields(reread), list));
  if (ids.includes('bookmarks') && content.bookmarks !== undefined) ctx.change.set(['bookmarks'], []);
  ctx.setUndoLabel(label);
  return {removed, note: 'Save the document afterwards: saving rewrites the whole file so nothing removed stays in it.'};
}

export {userRectToView};
