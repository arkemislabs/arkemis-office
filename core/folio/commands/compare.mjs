// Compare files: choose the older version, then the Compare panel lists the differences (replaced blue, inserted green, deleted
// red), the new document's pages show them shaded, and the differences can be added as comments or written as a report.
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/engine/src/commands.rs:289        doc.compare "Compare files..." (Needs::Document) opens the Compare Files dialog
//   crates/ui-egui/src/workflows/compare_ui.rs   body (Old file, New file), panel (the counts, Show: Text, Mark as comments, Report,
//                                            Clear, the list of changes with "kind . page n"), run_compare, compare_action
//                                            (Select goes to the change's page and flashes it, Mark, Report, Clear), shading
//   crates/engine/src/compare.rs             compare (both documents must allow copying their text), compare_report, mark_differences
//                                            (a highlight over replaced and inserted text, a note where text was deleted, authored
//                                            "Compare", one undoable step "Mark differences")
//   crates/compare/src/lib.rs                lib/compare.mjs
// Differences from upstream (docs/spec/patches/folio/compare.json): the older version is read from a file (the system Open dialog or
// `path`) because this window has no other open documents to pick from, so Side by side and New file only are hidden (the old file has
// no page view of its own); the Visual differences (rendering both files page against page) are not translated; Acrobat's Filter is
// not in upstream; the report is saved as a PDF file rather than opened as a new tab.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/compare.test.mjs.
//
// Everything is in page view points (top-left origin), the convention of every folio command.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {createAnnotation} from '../model/annots.mjs';
import {defaultStyle} from '../model/types.mjs';
import {annotateState, meta, author, pageText} from '../model/index.mjs';
import {viewRectToQuad, viewToUser, pageRotation} from '../lib/geom.mjs';
import {pagesOf, annotAddress} from '../lib/comment-geometry.mjs';
import {loadOther, pageFacts, base64} from '../lib/page-source.mjs';
import {readOther, writeOther, interactive, writeState, stem} from '../lib/page-files.mjs';
import {copying, guard} from '../lib/edit-needs.mjs';
import {summaryPdf} from '../lib/comment-pdf.mjs';
import * as C from '../lib/compare.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/engine/src/commands.rs', 'crates/ui-egui/src/workflows/compare_ui.rs', 'crates/engine/src/compare.rs', 'crates/compare/src/lib.rs']};

const MAX_LISTED = 2000;
const current = ctx => ctx.view?.compare ?? null;
const open = ctx => (current(ctx) ? {enabled: true} : {enabled: false, reason: 'compare a file first (Compare files...)'});

/** The text of every page of a content, a PageText each. */
const textsOf = (content, pages) => Promise.all(pages.map(p => pageText(content, p)));

export default defineCommands({
  family: 'compare', app: 'folio', upstream: UPSTREAM,
  commands: [
    {
      id: 'doc.compare', label: 'Compare files...', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Compare files: this document (the new file) with an older version, read from `path` (a PDF; `base64` and `name` from a program) or picked in the system Open dialog. The text is compared word by word and the differences are shown on the new file: replaced (blue), inserted (green), deleted (red), listed in the Compare panel. Both files must allow copying their text. Returns the counts.',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096})), base64: s.optional(s.string({min: 1})), name: s.optional(s.string({min: 1, max: 255}))}),
      state: copying,
      async run(ctx, p) {
        guard(ctx, copying);
        const f = await readOther(ctx, p, {title: 'Compare Files: choose the older version'});
        if (!f) return {canceled: true};
        const old = await loadOther(f.bytes, f.name);
        const oldContent = {sourceBase64: base64(f.bytes), pages: old.getPages().map((pg, i) => ({id: `old${i + 1}`, sourceIndex: i, ...pageFacts(pg), rotation: 0}))};
        const [a, b] = await Promise.all([textsOf(oldContent, oldContent.pages), textsOf(ctx.doc, pagesOf(ctx))]);
        const result = C.compare(C.wordsOf(a), C.wordsOf(b));
        const newName = ctx.doc.sourceName ?? 'Untitled.pdf';
        ctx.setView({compare: {oldName: f.name, newName, oldWords: result.oldWords, newWords: result.newWords, changes: result.changes, selected: null, showText: true, rev: 0}});
        const n = result.changes.length;
        return {
          changes: n, replaced: C.count(result, 'Replaced'), inserted: C.count(result, 'Inserted'), deleted: C.count(result, 'Deleted'),
          identical: n === 0, oldWords: result.oldWords, newWords: result.newWords, oldName: f.name,
          message: n === 0 ? 'The text is the same' : n === 1 ? '1 difference found' : `${n} differences found`,
        };
      },
    },
    {
      id: 'compare.select', label: 'Go to a difference', risk: 'read', effect: 'view', undo: 'none',
      description: 'Select difference `index` (1-based) of the Compare panel: the view goes to its page in the new file and flashes it.',
      params: s.object({index: s.integer({min: 1, max: 1000000})}),
      state: open,
      run(ctx, p) {
        const c = current(ctx);
        const ch = c.changes[p.index - 1];
        if (!ch) throw new CommandError('not_found', `there is no difference ${p.index}`, {path: '/index'});
        ctx.setView({compare: {...c, selected: p.index - 1, rev: c.rev + 1}});
        return {index: p.index, kind: ch.kind, page: ch.new.page + 1, rect: ch.new.rects[0] ?? ch.new.near ?? null, oldPage: ch.old.page + 1};
      },
    },
    {
      id: 'compare.show', label: 'Show differences', risk: 'read', effect: 'view', undo: 'none',
      description: 'Show: whether the text differences are listed and shaded on the pages (the command toggles `what` "text"; `value` sets it).',
      params: s.object({what: s.optional(s.enum(['text'])), value: s.optional(s.boolean())}),
      state(ctx) { const st = open(ctx); return st.enabled ? {...st, checked: current(ctx).showText, value: current(ctx).showText ? 'Text' : 'Nothing'} : st; },
      run(ctx, p) {
        const c = current(ctx);
        const showText = p.value ?? !c.showText;
        ctx.setView({compare: {...c, showText}});
        return {showText};
      },
    },
    {
      id: 'compare.mark', label: 'Mark as comments', risk: 'edit', needs: 'worker',
      description: 'Mark the differences in the new file as comments: a highlight over replaced (blue) and inserted (green) text and a note where text was deleted (red), authored "Compare", saying what changed. One undoable step; returns how many comments were added.',
      params: s.object({}),
      state(ctx) {
        const o = open(ctx);
        if (!o.enabled) return o;
        const a = annotateState(ctx.doc);
        return a.enabled ? {enabled: true} : a;
      },
      run(ctx) {
        const c = current(ctx);
        const pages = pagesOf(ctx);
        const added = pages.map(() => 0);
        let n = 0;
        for (const ch of c.changes) {
          const page = pages[ch.new.page];
          if (!page) continue;
          const text = ch.kind === 'Replaced' ? `Replaced: "${ch.old.text}" with "${ch.new.text}"` : ch.kind === 'Inserted' ? `Inserted: "${ch.new.text}"` : `Deleted: "${ch.old.text}"`;
          let shape;
          if (ch.new.rects.length) shape = {kind: 'TextMarkup', markup: 'Highlight', quads: ch.new.rects.map(r => viewRectToQuad(page, r))};
          else if (ch.new.near) shape = {kind: 'Note', at: viewToUser(page, ch.new.near[0], ch.new.near[1])};
          else continue;
          const style = {...defaultStyle(shape), color: C.colour(ch.kind)};
          const record = createAnnotation({shape, style, contents: text, author: 'Compare', rotation: pageRotation(page)}, meta(ctx));
          ctx.change.splice(['pages', ch.new.page, 'annots'], (page.annots ?? []).length + added[ch.new.page]++, 0, record);
          n++;
        }
        if (n) ctx.setUndoLabel('Mark differences');
        return {added: n, message: n === 1 ? 'Added 1 comment' : `Added ${n} comments`};
      },
    },
    {
      id: 'compare.report', label: 'Report...', risk: 'read', needs: 'worker',
      description: 'The compare report as a PDF: the old and new file names, how many changes of each kind, then each change with its pages and text. Saved to `path`, or from the window to the file picked in the system Save dialog; from a program without a path the PDF comes back as `base64`.',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096}))}),
      state(ctx) { const o = open(ctx); return o.enabled ? writeState(ctx) : o; },
      async run(ctx, p) {
        const c = current(ctx);
        const text = C.report(c, c.oldName, c.newName);
        const bytes = await summaryPdf(text, 'Compare Report');
        const w = await writeOther(ctx, p, bytes, {title: 'Save Compare Report', name: 'Compare Report.pdf'});
        void stem; void interactive;
        return w.canceled ? {canceled: true} : {...w, changes: c.changes.length, text};
      },
    },
    {
      id: 'compare.clear', label: 'Clear', risk: 'read', effect: 'view', undo: 'none',
      description: 'Clear the comparison: the shading and the Compare panel go away.',
      params: s.object({}),
      state: open,
      run(ctx) { ctx.setView({compare: null}); return {cleared: true}; },
    },
  ],
});

export {MAX_LISTED};
