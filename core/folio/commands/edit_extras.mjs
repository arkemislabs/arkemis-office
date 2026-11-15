// Edit ▸ Add content: Link (drag a rectangle on the page, choose its web address and look in Link Properties; existing links show their outlines, a click selects
// one, Delete removes it) and Attach a file (a file attached to the whole document, shown in the Attachments panel).
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/tools/link_ui.rs       the Link tool: a drag draws a rectangle (at least 4 px each way) and opens Link Properties, a click selects a link,
//                                             a double click edits it, Delete removes it; LinkDraft (web, url, target, style)
//   crates/annot/src/links.rs and crates/engine run.rs   AddLink, SetLink, DeleteLink (checked_rect: at least 2 points each way), the link's border and highlight
//   crates/ui-egui/src/app/files.rs attach_file, crates/organize/src/attachments.rs   Edit::AddAttachment (core/folio/lib/attachments.mjs)
// Links are page annotations (core/folio/lib/edit-links.mjs); boxes in params are in page view points (origin top-left of the page as shown).
// Not translated (docs/spec/patches/folio/edit-content.json): a link that goes to a page of the document (needs the target page's object, which the model does not
// hold; existing ones are kept as they are) and a link's other actions.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {editable, commit} from '../lib/page-source.mjs';
import {currentPage} from '../lib/comment-geometry.mjs';
import {viewRectToUser, userRectToView} from '../lib/geom.mjs';
import {modification, documentOpen, guard} from '../lib/edit-needs.mjs';
import {readOther, interactive} from '../lib/page-files.mjs';
import {linkAnnotation, gotoAnnotation, linkRecords, defaultLinkStyle, styleDict, checkedRect, uriHex, HIGHLIGHTS} from '../lib/edit-links.mjs';
import {addAttachment, mimeForName, listAttachments} from '../lib/attachments.mjs';
import {meta} from '../model/index.mjs';
import {valuesToParams} from '../dialogs/link-properties.mjs';
import {pageParam, editOf} from './edit_text.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/tools/link_ui.rs', 'crates/annot/src/links.rs', 'crates/ui-egui/src/app/files.rs', 'crates/organize/src/attachments.rs', 'crates/engine/src/edit/run.rs']};
export const LINK_TOOL = 'edit.add_link';

const rgbParam = s.optional(s.array(s.number({min: 0, max: 1}), {min: 3, max: 3}));
const styleParams = {
  visible: s.optional(s.boolean({description: 'Show the link rectangle'})), color: rgbParam, width: s.optional(s.number({min: 0.5, max: 12})),
  line: s.optional(s.enum(['solid', 'dashed', 'underline'])), highlight: s.optional(s.enum(Object.keys(HIGHLIGHTS))),
};
const styleOf = p => {
  const st = defaultLinkStyle();
  if (p.visible !== undefined) st.visible = p.visible;
  if (p.color) st.color = p.color;
  if (p.width !== undefined) st.width = p.width;
  if (p.line) { st.dashed = p.line === 'dashed'; st.underline = p.line === 'underline'; }
  if (p.highlight) st.highlight = p.highlight;
  return st;
};
const pagesOf = ctx => ctx.doc?.pages ?? [];
const noLink = {enabled: false, reason: 'Click a link of the page first'};
const selected = ctx => editOf(ctx).link;

/** The link tool's list: the page's links with their boxes in page view points. */
function listLinks(page) {
  return linkRecords(page).map((l, i) => ({index: i, id: l.id, uri: l.uri, goto: l.goto, rect: userRectToView(page, l.rect), userRect: l.rect}));
}

export default defineCommands({
  family: 'edit_extras',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'edit.link', label: 'Add or edit links', risk: 'edit',
      description: 'Add or edit links: with no `rect` pick the Link tool (a drag on the page draws a rectangle and opens Link Properties; existing links show their outlines, a click selects one, Delete removes it) or, if it is picked, put it down. With `rect` [x0, y0, x1, y1] in page view points of `page` and `uri` add a link to that web address at once (without `uri` the window asks in Link Properties), with `visible`, `color`, `width`, `line` (solid, dashed, underline) and `highlight` (None, Invert, Outline, Inset) for its look.',
      params: s.object({page: pageParam, rect: s.optional(s.array(s.number({min: -100000, max: 100000}), {min: 4, max: 4})), uri: s.optional(s.string({max: 8192})), gotoPage: s.optional(s.integer({min: 0, max: 99999, description: '0-based page of this document the link goes to (instead of a web address)'})), ...styleParams}),
      state(ctx) { const st = modification(ctx); return st.enabled ? {...st, checked: ctx.view?.tool === LINK_TOOL} : st; },
      async run(ctx, p) {
        guard(ctx, modification);
        if (!p.rect) {
          const on = ctx.view?.tool !== LINK_TOOL;
          ctx.setView(on ? {tool: LINK_TOOL, highlighter: false, edit: {...editOf(ctx), block: null, image: null, added: null, link: null}} : {tool: null, edit: {...editOf(ctx), link: null}});
          return {tool: on ? LINK_TOOL : null};
        }
        const {pi, page} = currentPage(ctx, p.page);
        let uri = p.uri;
        let params = p;
        if (uri === undefined && p.gotoPage === undefined && interactive(ctx) && typeof ctx.host?.openDialog === 'function') {
          const v = await ctx.host.openDialog('dialog.link-properties', {__page: page.id, __rect: p.rect});
          if (!v) return {canceled: true};
          params = {...p, ...valuesToParams(v)};
          uri = params.uri;
        }
        const wantsPage = params.gotoPage !== undefined && !String(uri ?? '').trim();
        const target = wantsPage ? ctx.doc.pages[params.gotoPage] : null;
        if (wantsPage && !target) throw new CommandError('not_found', `page ${params.gotoPage + 1} does not exist`, {path: '/gotoPage'});
        if (!target && (uri === undefined || !String(uri).trim())) throw new CommandError('invalid_params', 'type the web address first', {path: '/uri'});
        const r = checkedRect(viewRectToUser(page, p.rect));
        const id = `lnk-${ctx.host.uid()}`;
        const record = target ? gotoAnnotation(id, r, target.id, styleOf(params)) : linkAnnotation(id, r, uri, styleOf(params));
        ctx.change.splice(['pages', pi, 'annots'], (page.annots ?? []).length, 0, record);
        ctx.setView({edit: {...editOf(ctx), link: {page: page.id, id}}});
        ctx.setUndoLabel('Add link');
        return target ? {page: page.id, id, goto: target.id} : {page: page.id, id, uri: String(uri).trim()};
      },
    },
    {
      id: 'edit.links', label: 'Links of the page', risk: 'read', undo: 'none',
      description: 'List the links of a page: each with its web address (null for another action) and its box in page view points (`rect`).',
      params: s.object({page: pageParam}),
      state: documentOpen,
      run(ctx, p) {
        const {page} = currentPage(ctx, p.page);
        return {page: page.id, links: listLinks(page)};
      },
    },
    {
      id: 'edit.link_select', label: 'Select a link', risk: 'read', effect: 'view', undo: 'none',
      description: 'Select a link of the page (by `id`) so Delete and Link Properties act on it; without one, put the selection down.',
      params: s.object({page: pageParam, id: s.optional(s.string({max: 200}))}),
      state: documentOpen,
      run(ctx, p) {
        if (!p.id) { ctx.setView({edit: {...editOf(ctx), link: null}}); return {link: null}; }
        const {page} = currentPage(ctx, p.page);
        const l = listLinks(page).find(x => x.id === p.id);
        if (!l) throw new CommandError('not_found', 'that link is no longer on the page', {path: '/id'});
        ctx.setView({edit: {...editOf(ctx), link: {page: page.id, id: p.id}}});
        return {link: l};
      },
    },
    {
      id: 'edit.link_change', label: 'Change a link', risk: 'edit',
      description: 'Change a link (the selected one, or `id` of `page`): `set` with `uri`, `rect` and the look fields rewrites it (SetLink); `delete` removes it (DeleteLink).',
      params: s.object({page: pageParam, id: s.optional(s.string({max: 200})), change: s.enum(['set', 'delete']), uri: s.optional(s.string({max: 8192})), gotoPage: s.optional(s.integer({min: 0, max: 99999})),
        rect: s.optional(s.array(s.number({min: -100000, max: 100000}), {min: 4, max: 4})), ...styleParams}),
      state(ctx, p) { const st = modification(ctx); return st.enabled && !p?.id && !selected(ctx) ? noLink : st; },
      run(ctx, p) {
        guard(ctx, modification);
        const sel = selected(ctx);
        const id = p.id ?? sel?.id;
        if (!id) throw new CommandError('disabled', noLink.reason);
        const {pi, page} = currentPage(ctx, p.page ?? sel?.page);
        const annots = page.annots ?? [];
        const at = annots.findIndex(r => r.id === id);
        if (at < 0 || annots[at].dict?.Subtype !== '/Link') throw new CommandError('not_found', 'that link is no longer on the page', {path: '/id'});
        if (p.change === 'delete') {
          ctx.change.set(['pages', pi, 'annots'], annots.filter((_, i) => i !== at));
          ctx.setView({edit: {...editOf(ctx), link: null}});
          ctx.setUndoLabel('Delete link');
          return {deleted: id};
        }
        const old = annots[at];
        const dict = {...old.dict};
        if (p.rect) dict.Rect = checkedRect(viewRectToUser(page, p.rect));
        if (p.uri !== undefined) {
          if (!String(p.uri).trim()) throw new CommandError('invalid_params', 'type the web address first', {path: '/uri'});
          dict.A = {S: '/URI', URI: {$x: uriHex(p.uri)}};
        } else if (p.gotoPage !== undefined) {
          const target = ctx.doc.pages[p.gotoPage];
          if (!target) throw new CommandError('not_found', `page ${p.gotoPage + 1} does not exist`, {path: '/gotoPage'});
          dict.A = {S: '/GoTo', D: [{$pg: target.id}, '/Fit']};
        }
        if (['visible', 'color', 'width', 'line', 'highlight'].some(k => p[k] !== undefined)) Object.assign(dict, styleDict(styleOf(p)));
        ctx.change.set(['pages', pi, 'annots', at], {...old, dict, edited: true});
        ctx.setUndoLabel('Edit link');
        return {id};
      },
    },
    {
      id: 'edit.attach', label: 'Attach a file…', risk: 'edit', needs: 'worker', dialog: 'system.open-file',
      description: 'Attach a file to the document (`path` or `base64` with `name`; from the window the system Open dialog asks): it is stored in the document\'s attachments under its file name, made unique with " (2)", " (3)" when taken, with its type and size. `description` describes it.',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096})), base64: s.optional(s.string({max: 41_000_000})), name: s.optional(s.string({max: 255})), description: s.optional(s.string({max: 2000}))}),
      state: modification,
      async run(ctx, p) {
        guard(ctx, modification);
        const file = await readOther(ctx, p, {title: 'Attach a file', filters: [{name: 'All files', extensions: ['*']}]});
        if (!file) return {canceled: true};
        const {doc, content} = await editable(ctx.doc, []);
        const key = addAttachment(doc, {name: file.name, bytes: file.bytes, description: p.description ?? null, mime: mimeForName(file.name), date: meta(ctx).date});
        await commit(ctx, doc, content, {});
        ctx.setUndoLabel('Attach file');
        return {name: key, size: file.bytes.length};
      },
    },
    {
      id: 'edit.attachments', label: 'Attachments', risk: 'read', undo: 'none', needs: 'worker',
      description: 'List the files attached to the document: name, size, type and description.',
      params: s.object({}),
      state: documentOpen,
      async run(ctx) {
        const {doc} = await editable(ctx.doc, []);
        return {attachments: listAttachments(doc)};
      },
    },
  ],
});

export {pagesOf};
