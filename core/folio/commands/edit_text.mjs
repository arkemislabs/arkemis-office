// Edit text & images, the text half: click a paragraph of the page and change its words; the paragraph is rewrapped within its box and the
// edited content stream is written back. The Format text controls (font, size, colour, alignment, bold, italic, underline, line spacing,
// horizontal scale, character spacing) restyle the paragraph that is open.
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/commands.rs:519      edit.edit_text opens the Edit panel and picks the paragraph tool
//   crates/ui-egui/src/tools/edit_text_ui.rs  paragraph boxes (a click opens a paragraph, `editor_text` is what the box holds), applying the open
//                                            paragraph (Edit::EditTextBlock with the typed text and the BlockStyle), the Edit panel's Format text
//   crates/ui-egui/src/panels/format_text_ui.rs  the controls: font (keep source fonts, the page's fonts, the standard families), size, colour,
//                                            alignment, bold, italic, underline, line spacing, horizontal scale, character spacing; the lists,
//                                            superscript, subscript and paragraph spacing are shown disabled upstream ("planned")
//   crates/edit/src/text/blocks.rs, rewrite.rs, interp.rs, lines.rs (core/folio/lib/text-*.mjs)
// The text is read and rewritten in a worker (needs: 'worker'); nothing in the document is executed: the page's content is read as data.
// What upstream does that is not translated is listed in docs/spec/patches/folio/edit.json.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {PDFName, PDFDict} from 'pdf-lib';
import {loadSource, commitBytes, sharesSource, materialize} from '../lib/page-source.mjs';
import {callText} from '../lib/text-client.mjs';
import {currentPage, hexOf, rgbOf} from '../lib/comment-geometry.mjs';
import {userRectToView, viewToUser} from '../lib/geom.mjs';
import {modification, documentOpen, guard} from '../lib/edit-needs.mjs';
import {TextError} from '../lib/text-interp.mjs';
import {pageBlocksAsync, describeBlock} from '../lib/text-edit.mjs';
import {findBlock, blockOverlapping} from '../lib/text-blocks.mjs';
import {rewriteFrom, translateBlocks} from '../lib/text-rewrite.mjs';
import {Metrics} from '../lib/text-font.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/tools/edit_text_ui.rs', 'crates/ui-egui/src/panels/format_text_ui.rs',
  'crates/edit/src/text/blocks.rs', 'crates/edit/src/text/rewrite.rs', 'crates/edit/src/text/interp.rs', 'crates/edit/src/text/lines.rs', 'crates/edit/src/text/fallback.rs',
  'crates/edit/src/text_regions/grouping.rs', 'crates/fonts/src/pdf.rs']};

export const EDIT_TOOL = 'edit.text_edit';
const FAMILIES = ['Helvetica', 'Times', 'Courier'];
const ALIGNS = {'Align left': 'left', Left: 'left', left: 'left', Centre: 'center', Center: 'center', center: 'center', 'Align right': 'right', Right: 'right', right: 'right', Justify: 'justify', justify: 'justify'};
const TOGGLES = ['bold', 'italic', 'underline'];
const FIELDS = ['font', 'size', 'color', 'align', 'lineSpacing', 'scale', 'charSpacing'];

const fresh = () => ({block: null, look: {}, notice: null, image: null, added: null});
export const editOf = ctx => ({...fresh(), ...(ctx.view?.edit ?? {})});

/** One parsed source per revision: reading the paragraphs again on each click would parse the file each time. */
let cache = {src: null, doc: null, pages: new Map()};
export async function readSource(content) {
  if (cache.src !== content.sourceBase64 || !cache.doc) cache = {src: content.sourceBase64, doc: await loadSource(content), pages: new Map()};
  return cache;
}
export function releaseEditCache() { cache = {src: null, doc: null, pages: new Map()}; }

export const asCommandError = e => (e instanceof TextError ? new CommandError(['too_large', 'not_found'].includes(e.code) ? e.code : 'invalid_params', e.message, e.path ? {path: e.path} : undefined) : e);

const colorParam = s.optional(s.union([s.string({max: 16}), s.array(s.number({min: 0, max: 1}), {min: 3, max: 3})], {description: 'Text color: #RRGGBB or RGB 0-1'}));
const toRgb = v => {
  if (Array.isArray(v)) return v.map(Number);
  const h = String(v ?? '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new CommandError('invalid_params', 'the colour is #RRGGBB', {path: '/color'});
  return rgbOf(h);
};
export const pageParam = s.optional(s.union([s.string({min: 1, max: 120}), s.integer({min: 1, max: 100000})], {description: 'Page id or 1-based number (default: the page shown)'}));
const keyParam = s.optional(s.object({text: s.string({max: 4_000_000}), rect: s.array(s.number(), {min: 4, max: 4})}, {description: 'The paragraph as listed (its text and box in user space): a paragraph that no longer says that is not found'}));

const styleParams = {
  size: s.optional(s.number({min: 0.1, max: 1000, description: 'Font size in points'})),
  color: colorParam,
  align: s.optional(s.enum(['left', 'center', 'right', 'justify'])),
  family: s.optional(s.enum(FAMILIES, {description: 'A standard family'})),
  resource: s.optional(s.string({min: 1, max: 120, description: "One of the page's fonts, by resource name"})),
  bold: s.optional(s.boolean()),
  italic: s.optional(s.boolean()),
  underline: s.optional(s.boolean()),
  lineSpacing: s.optional(s.number({min: 0.5, max: 5, description: 'Line spacing as a multiple of the size (1.2 is ordinary)'})),
  charSpacing: s.optional(s.number({min: -5, max: 50, description: 'Character spacing in points'})),
  scale: s.optional(s.number({min: 10, max: 400, description: 'Horizontal scale in percent'})),
  offset: s.optional(s.array(s.number({min: -14400, max: 14400}), {min: 2, max: 2, description: 'Move the paragraph by [dx, dy] points on the page (user space)'})),
  width: s.optional(s.number({min: 1, max: 14400, description: 'Rewrap to this width in points'})),
  cover: s.optional(s.array(s.number({min: 0, max: 1}), {min: 3, max: 3, description: 'Invisible (scanned) text: fill the old area with this color first'})),
};
const styleOf = p => {
  const style = {};
  for (const k of ['size', 'align', 'family', 'resource', 'bold', 'italic', 'underline', 'lineSpacing', 'charSpacing', 'scale', 'offset', 'width', 'cover']) if (p[k] !== undefined) style[k] = p[k];
  if (p.color !== undefined) style.color = toRgb(p.color);
  return style;
};

/** The paragraphs of a page, read by the text worker (cached per revision of the file): {pi, page, blocks (user-space boxes), fonts, via}. */
const blockCache = new Map();
async function listing(ctx, pageParamValue) {
  const {pi, page} = currentPage(ctx, pageParamValue);
  const b64 = ctx.doc.sourceBase64;
  const key = `${b64.length}:${b64.slice(0, 32)}:${b64.slice(-64)}:${page.sourceIndex}`;
  let entry = blockCache.get(key);
  if (!entry) {
    try { entry = await callText('blocks', {base64: b64, sourceIndex: page.sourceIndex}); } catch (e) { throw asCommandError(e); }
    blockCache.set(key, entry);
    if (blockCache.size > 16) blockCache.delete(blockCache.keys().next().value);
  }
  return {pi, page, ...entry};
}

/** A listed paragraph as the surface reads it: its box turned to the page as shown (view space) as well as in user space. */
const listedBlock = (page, d) => ({...d, userRect: d.rect, rect: userRectToView(page, d.rect)});

/** The paragraph a command names: by key (what it says and where), else by index. */
function pick(entry, p) {
  const at = p.key ? findBlock(entry.blocks.map(d => ({text: d.key.text, rect: d.key.rect})), p.key, p.index ?? 0) : p.index;
  if (at === null || at === undefined || !entry.blocks[at]) throw new CommandError('not_found', p.key ? 'that paragraph is no longer on the page' : 'the page has no such paragraph', {path: p.key ? '/key' : '/index'});
  return at;
}

/** What the text operations read: the document's source (or, for a page shared by several model pages, the source written out apart). */
async function inputFor(ctx, pi) {
  if (sharesSource(ctx.doc, pi)) {
    const {doc, content} = await materialize(ctx.doc);
    return {content, input: {bytes: await doc.save({updateFieldAppearances: false})}, sourceIndex: content.pages[pi].sourceIndex};
  }
  return {content: ctx.doc, input: {base64: ctx.doc.sourceBase64}, sourceIndex: ctx.doc.pages[pi].sourceIndex};
}

const blockState = ctx => editOf(ctx).block;

function replaceCommand() {
  return {
    id: 'edit.text_replace', label: 'Edit text', risk: 'edit', needs: 'worker',
    description: 'Replace the words of a paragraph of the page (one listed by edit.blocks, named by `key` or `index`), rewrapped to the paragraph\'s own width and line spacing, in its own font, size and color; with the style options restyle it (family, bold and italic choose a standard face, size, color, alignment, underline, line spacing, character spacing, horizontal scale, a move by `offset`, a new `width`). `text` left out keeps the words. The font the paragraph already uses is kept when it can show every character (a subset font lacks letters it never drew); otherwise Helvetica, Times or Courier stands in and the result says so in `notice`. Text is never executed: only the page\'s drawing operators are read and written.',
    params: s.object({page: pageParam, key: keyParam, index: s.optional(s.integer({min: 0, max: 100000})), text: s.optional(s.string({max: 1_000_000})), ...styleParams}),
    state: modification,
    async run(ctx, p) {
      guard(ctx, modification);
      const {pi, page} = currentPage(ctx, p.page);
      if (p.text === undefined && !Object.keys(styleOf(p)).length) throw new CommandError('invalid_params', 'give the new `text` or a style to change');
      const {content, input, sourceIndex} = await inputFor(ctx, pi);
      let out;
      try { out = await callText('replace', {...input, sourceIndex, key: p.key, index: p.index, text: p.text, style: styleOf(p)}); } catch (e) { throw asCommandError(e); }
      commitBytes(ctx, content, out.bytes);
      const result = out.result;
      const after = out.after ? listedBlock(page, out.after) : null;
      const notice = result.substituted
        ? `The font of this text can't show the new characters, so ${result.substituted} was used for it.`
        : result.flattened ? "This paragraph had several fonts, sizes or colours: it is now set in its first run's style." : null;
      const view = editOf(ctx);
      ctx.setView({edit: {...view, block: after ? {page: page.id, index: after.index, key: after.key, size: after.size, bold: after.bold, italic: after.italic, color: after.color, font: after.font,
        scale: after.scale, charSpacing: after.charSpacing, rect: after.rect} : null, notice}});
      ctx.setUndoLabel('Edit text');
      return {page: page.id, index: after?.index ?? null, block: after, substituted: result.substituted, flattened: result.flattened, styled: !!result.styled, rows: result.rows, notice, via: out.via};
    },
  };
}

function formatCommand() {
  return {
    id: 'edit.format', label: 'Format text', risk: 'edit', needs: 'worker',
    description: 'Format the paragraph that is open (or the one named by `page` with `key` or `index`): `field` with `value` sets one of font (Keep source fonts, Helvetica, Times, Courier, or a face the page uses), size (points), color (#RRGGBB), align (left, center, right, justify), lineSpacing (a multiple of the size; Auto keeps the paragraph\'s own), scale (percent), charSpacing (points); `toggle` flips bold, italic or underline. The paragraph is rewritten at once.',
    params: s.object({page: pageParam, key: keyParam, index: s.optional(s.integer({min: 0, max: 100000})),
      field: s.optional(s.enum(FIELDS)), value: s.optional(s.union([s.string({max: 200}), s.number()])), toggle: s.optional(s.enum(TOGGLES))}),
    state(ctx, p) {
      const st = modification(ctx);
      if (!st.enabled) return st;
      const b = blockState(ctx);
      const added = editOf(ctx).added;
      if (!b && added?.kind === 'text') {
        // Added text has the standard families, size, colour, style, alignment and character spacing (format_text_ui.rs); the rest is shown disabled.
        if (p?.toggle === 'underline' || p?.field === 'lineSpacing' || p?.field === 'scale') return {enabled: false, reason: 'Not available for added text'};
        if (p?.toggle) return {...st, checked: p.toggle === 'bold' ? added.bold : p.toggle === 'italic' ? added.italic : false};
        switch (p?.field) {
          case 'font': return {...st, value: added.family};
          case 'size': return {...st, value: String(Math.round(added.size * 100) / 100)};
          case 'color': return {...st, value: added.color};
          case 'align': return {...st, value: added.align};
          case 'charSpacing': return {...st, value: String(Math.round(added.charSpacing * 100) / 100)};
          default: return st;
        }
      }
      if (!b) return {enabled: false, reason: 'Click a paragraph of the page first'};
      const look = editOf(ctx).look ?? {};
      if (p?.toggle) return {...st, checked: p.toggle === 'bold' ? !!(look.bold ?? b.bold) : p.toggle === 'italic' ? !!(look.italic ?? b.italic) : !!look.underline};
      switch (p?.field) {
        case 'font': return {...st, value: look.fontLabel ?? 'Keep source fonts'};
        case 'size': return {...st, value: String(Math.round((look.size ?? b.size) * 100) / 100)};
        case 'color': return {...st, value: look.color ?? b.color};
        case 'align': return {...st, value: look.align ?? 'left'};
        case 'lineSpacing': return {...st, value: look.lineSpacing === undefined ? 'Auto' : String(look.lineSpacing)};
        case 'scale': return {...st, value: String(Math.round(look.scale ?? b.scale))};
        case 'charSpacing': return {...st, value: String(Math.round((look.charSpacing ?? b.charSpacing) * 100) / 100)};
        default: return st;
      }
    },
    async run(ctx, p) {
      guard(ctx, modification);
      const open = blockState(ctx);
      const added = editOf(ctx).added;
      if (!open && added?.kind === 'text' && !p.key && p.index === undefined) {
        const v = p.value;
        const number = name => { const x = Number(v); if (v === undefined || v === '' || !Number.isFinite(x)) throw new CommandError('invalid_params', name + ' is a number', {path: '/value'}); return x; };
        const style = {};
        if (p.toggle === 'bold') style.bold = !added.bold;
        else if (p.toggle === 'italic') style.italic = !added.italic;
        else if (p.toggle) throw new CommandError('disabled', 'Not available for added text');
        else switch (p.field) {
          case 'font': { const name = String(v ?? ''); if (FAMILIES.includes(name)) style.family = name; else return {unchanged: true}; break; }
          case 'size': style.size = number('size'); break;
          case 'color': style.color = String(v ?? '').replace('auto', '#000000'); break;
          case 'align': { const a = ALIGNS[String(v)]; if (!a) throw new CommandError('invalid_params', 'the alignment is left, center, right or justify', {path: '/value'}); style.align = a; break; }
          case 'charSpacing': style.charSpacing = number('character spacing'); break;
          case 'lineSpacing': case 'scale': throw new CommandError('disabled', 'Not available for added text');
          default: throw new CommandError('invalid_params', 'give a field and a value, or a toggle', {path: '/field'});
        }
        return ctx.run('edit.added_change', {change: 'style', page: added.page, obj: added.obj, ...style});
      }
      const target = {page: p.page ?? open?.page, key: p.key ?? (p.index === undefined ? open?.key : undefined), index: p.index ?? (p.key ? undefined : open?.index)};
      if (!target.key && target.index === undefined) throw new CommandError('disabled', 'Click a paragraph of the page first');
      const look = {...(editOf(ctx).look ?? {})};
      const style = {};
      const v = p.value;
      const number = name => {
        const n = Number(v);
        if (v === undefined || v === '' || !Number.isFinite(n)) throw new CommandError('invalid_params', `${name} is a number`, {path: '/value'});
        return n;
      };
      let fontLabel;
      if (p.toggle) {
        const b = open ?? {};
        if (p.toggle === 'bold') { look.bold = !(look.bold ?? b.bold); style.bold = look.bold; }
        else if (p.toggle === 'italic') { look.italic = !(look.italic ?? b.italic); style.italic = look.italic; }
        else { look.underline = !look.underline; style.underline = look.underline; }
        if (p.toggle !== 'underline') style.family = look.family ?? undefined;
      } else {
        switch (p.field) {
          case 'font': {
            const name = String(v ?? '');
            if (name === 'Keep source fonts' || name === '') { delete look.family; delete look.resource; fontLabel = 'Keep source fonts'; }
            else if (FAMILIES.includes(name)) { look.family = name; delete look.resource; fontLabel = name; }
            else { look.resource = name; delete look.family; fontLabel = name; }
            break;
          }
          case 'size': { look.size = number('size'); style.size = look.size; break; }
          case 'color': { const c = String(v ?? '').replace('auto', '#000000'); style.color = toRgb(c.startsWith('#') ? c : `#${c}`); look.color = hexOf(style.color); break; }
          case 'align': { const a = ALIGNS[String(v)]; if (!a) throw new CommandError('invalid_params', 'the alignment is left, center, right or justify', {path: '/value'}); look.align = a; style.align = a; break; }
          case 'lineSpacing': { if (String(v) === 'Auto') delete look.lineSpacing; else { look.lineSpacing = number('line spacing'); style.lineSpacing = look.lineSpacing; } break; }
          case 'scale': { look.scale = number('horizontal scale'); style.scale = look.scale; break; }
          case 'charSpacing': { look.charSpacing = number('character spacing'); style.charSpacing = look.charSpacing; break; }
          default: throw new CommandError('invalid_params', 'give a field and a value, or a toggle', {path: '/field'});
        }
      }
      if (fontLabel !== undefined) look.fontLabel = fontLabel;
      // bold / italic / a family choose a face; the page's own fonts are named by resource.
      if (look.family && style.family === undefined && (p.field === 'font' || p.toggle)) style.family = look.family;
      if (look.resource && p.field === 'font') style.resource = look.resource;
      // The options already chosen for this paragraph stay in force (the rewrite keeps the paragraph's own look for the rest).
      for (const k of ['size', 'align', 'underline', 'lineSpacing', 'scale', 'charSpacing']) if (style[k] === undefined && look[k] !== undefined && p.field !== undefined) style[k] = look[k];
      if (look.color && style.color === undefined) style.color = toRgb(look.color);
      if (p.field === 'font' && style.family === undefined && style.resource === undefined) { ctx.setView({edit: {...editOf(ctx), look}}); return {look, unchanged: true}; }
      const out = await ctx.run('edit.text_replace', {...(target.page !== undefined ? {page: target.page} : {}), ...(target.key ? {key: target.key} : {index: target.index}), ...toParams(style)});
      const after = editOf(ctx);
      ctx.setView({edit: {...after, look}});
      return out;
    },
  };
}

const toParams = style => {
  const out = {...style};
  if (out.color) out.color = out.color.map(c => Math.round(c * 1e6) / 1e6);
  return out;
};

export default defineCommands({
  family: 'edit_text',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'edit.edit_text', label: 'Edit text & images', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Edit text & images: pick the paragraph tool (the page\'s paragraphs show boxes; a click opens one for typing) or, if it is already picked, put it down. With `open` true or false set it instead of flipping it.',
      params: s.object({open: s.optional(s.boolean())}),
      state(ctx) { const st = documentOpen(ctx); return st.enabled ? {...st, checked: ctx.view?.tool === EDIT_TOOL} : st; },
      run(ctx, p) {
        const on = p.open ?? ctx.view?.tool !== EDIT_TOOL;
        ctx.setView(on ? {tool: EDIT_TOOL, highlighter: false, edit: fresh()} : {tool: null, edit: fresh()});
        return {tool: on ? EDIT_TOOL : null};
      },
    },
    {
      id: 'edit.blocks', label: 'Paragraphs of the page', risk: 'read', undo: 'none', needs: 'worker',
      description: 'List the editable paragraphs of a page: each with its text as an editor shows it (a newline between rows), the text a width change reflows, its box (`rect` in page view points, `userRect` in the page\'s own space), size, bold, italic, color, font, and whether it can be edited (`editable`, else the reason in `refusal`). Text in forms is not listed; text that cannot be read or written here (vertical, right-to-left, Type 3) is listed as not editable.',
      params: s.object({page: pageParam}),
      state: documentOpen,
      async run(ctx, p) {
        const e = await listing(ctx, p.page);
        return {page: e.page.id, blocks: e.blocks.map(d => listedBlock(e.page, d)), fonts: e.fonts, via: e.via};
      },
    },
    {
      id: 'edit.select_block', label: 'Open a paragraph', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Open a paragraph of the page for formatting (the Format text controls then act on it), named by `key` or `index` of `page`; without either, close it.',
      params: s.object({page: pageParam, key: keyParam, index: s.optional(s.integer({min: 0, max: 100000}))}),
      state: documentOpen,
      async run(ctx, p) {
        if (!p.key && p.index === undefined) { ctx.setView({edit: {...editOf(ctx), block: null, look: {}}}); return {block: null}; }
        const e = await listing(ctx, p.page);
        const at = pick(e, p);
        const b = listedBlock(e.page, e.blocks[at]);
        ctx.setView({edit: {...editOf(ctx), image: null, added: null, look: {}, notice: null, block: {page: e.page.id, index: at, key: b.key, size: b.size, bold: b.bold, italic: b.italic, color: b.color, font: b.font,
          scale: b.scale, charSpacing: b.charSpacing, rect: b.rect}}});
        return {block: b};
      },
    },
    {
      id: 'edit.text_move', label: 'Move text', risk: 'edit', needs: 'worker',
      description: 'Move a paragraph of the page by `offset` [dx, dy] page view points (the way the page is shown: right and down are positive; `user` true takes the page own axes instead) without touching its glyphs, fonts or line breaks: each show operator is shifted by a TJ adjustment and the text rise, then both are put back, so the text after it stays where it was. Dragging a paragraph box does this.',
      params: s.object({page: pageParam, key: keyParam, index: s.optional(s.integer({min: 0, max: 100000})), offset: s.array(s.number({min: -14400, max: 14400}), {min: 2, max: 2}), user: s.optional(s.boolean())}),
      state: modification,
      async run(ctx, p) {
        guard(ctx, modification);
        const {pi, page} = currentPage(ctx, p.page);
        const {content, input, sourceIndex} = await inputFor(ctx, pi);
        const user = p.user ? p.offset : (() => { const a = viewToUser(page, 0, 0), b = viewToUser(page, p.offset[0], p.offset[1]); return [b[0] - a[0], b[1] - a[1]]; })();
        let out;
        try { out = await callText('move', {...input, sourceIndex, key: p.key, index: p.index, offset: user}); } catch (e) { throw asCommandError(e); }
        commitBytes(ctx, content, out.bytes);
        const after = out.after ? listedBlock(page, out.after) : null;
        ctx.setView({edit: {...editOf(ctx), block: after ? {page: page.id, index: after.index, key: after.key, size: after.size, bold: after.bold, italic: after.italic, color: after.color,
          font: after.font, scale: after.scale, charSpacing: after.charSpacing, rect: after.rect} : null}});
        ctx.setUndoLabel('Move text');
        return {page: page.id, block: after, offset: user, via: out.via};
      },
    },
    replaceCommand(),
    formatCommand(),
  ],
});
