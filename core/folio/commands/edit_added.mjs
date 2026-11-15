// Edit ▸ Add content: Text (click or drag a box on the page and type) and Image (pick a picture; it lands in the middle of the page), and editing what was
// added: select it, move it, resize it (images keep their proportions), retype or format text, turn, flip, crop or replace an image, delete it.
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/commands.rs:534,539    edit.text picks the Text tool, edit.image opens the picture dialog
//   crates/ui-egui/src/tools/content_ui.rs    a click puts a 200 pt wide box with its top left at the click (to the page edge at most), a drag draws one,
//                                             the box takes the typed words when it is left; the added items are selected, moved, resized, retyped, formatted
//                                             and deleted; Edit::AddText, AddImage, UpdateContent, DeleteContent, ReplaceImage
//   crates/ui-egui/src/panels/format_text_ui.rs   added text has the standard families, size, colour, style, alignment and character spacing; line spacing,
//                                             scale and underline are shown disabled for it
//   crates/edit/src/added.rs and added/*.rs  core/folio/lib/added.mjs
// Boxes in params are in page view points (origin top-left of the page as shown); items keep display space (origin bottom-left) in the file.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {editable, commit} from '../lib/page-source.mjs';
import {currentPage, rgbOf, hexOf} from '../lib/comment-geometry.mjs';
import {displaySize} from '../lib/edit-place.mjs';
import {modification, documentOpen, guard} from '../lib/edit-needs.mjs';
import {readOther} from '../lib/page-files.mjs';
import {markSource} from '../lib/edit-marks.mjs';
import {TextError} from '../lib/text-interp.mjs';
import {listAdded, addContent, updateContent, deleteContent, defaultText, centredBox, textRect, norm, FAMILIES, clampCrop, prepareUnicode} from '../lib/added.mjs';
import {readSource, asCommandError, editOf, pageParam} from './edit_text.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/tools/content_ui.rs', 'crates/ui-egui/src/panels/format_text_ui.rs',
  'crates/edit/src/added.rs', 'crates/edit/src/added/draw.rs', 'crates/edit/src/added/layout.rs', 'crates/edit/src/added/store.rs', 'crates/edit/src/added/types.rs', 'crates/engine/src/edit/run.rs']};

export const ADD_TOOL = 'edit.add_text';
const CHANGES = ['text', 'style', 'move', 'resize', 'delete', 'rotate_cw', 'rotate_ccw', 'flip_h', 'flip_v', 'crop', 'replace'];

const colorParam = s.optional(s.union([s.string({max: 16}), s.array(s.number({min: 0, max: 1}), {min: 3, max: 3})]));
const rectParam = s.optional(s.array(s.number({min: -100000, max: 100000}), {min: 4, max: 4}));
const toRgb = v => (Array.isArray(v) ? v.map(Number) : /^#?[0-9a-f]{6}$/i.test(String(v)) ? rgbOf(String(v).replace('#', '')) : (() => { throw new CommandError('invalid_params', 'the colour is #RRGGBB', {path: '/color'}); })());
const textStyle = {
  family: s.optional(s.enum(FAMILIES)), bold: s.optional(s.boolean()), italic: s.optional(s.boolean()), size: s.optional(s.number({min: 1, max: 500})), color: colorParam,
  align: s.optional(s.enum(['left', 'center', 'right', 'justify'])), charSpacing: s.optional(s.number({min: -500, max: 500})),
};
const itemKey = {index: s.optional(s.integer({min: 0, max: 100000})), obj: s.optional(s.integer({min: 1, max: 100000000}))};

/** The page as the commands see it: the editable source, its pdf-lib page and the displayed rotation the model adds. */
const rotationOf = (content, pi) => content.pages[pi].rotation ?? 0;

/** An item for the surface: its box in page view points (top-left origin) and its look. */
function listed(src, extra, entry, index) {
  const [, H] = displaySize(src, extra);
  const c = entry.content;
  const r = c.kind === 'text' ? textRect(c) : norm(c.rect);
  const base = {index, obj: entry.objectNumber, kind: c.kind, rect: [r[0], H - r[3], r[2], H - r[1]]};
  if (c.kind === 'text') return {...base, text: c.text, family: c.family, bold: c.bold, italic: c.italic, size: c.size, color: hexOf(c.color), align: c.align, charSpacing: c.charSpacing, editable: true};
  return {...base, rotation: c.rotation, flipH: c.flipH, flipV: c.flipV, crop: c.crop};
}

function pick(items, p) {
  const at = p.obj !== undefined ? items.findIndex(x => x.objectNumber === p.obj) : p.index;
  if (at === undefined || at < 0 || !items[at]) throw new CommandError('not_found', 'the page has no such added item', {path: p.obj !== undefined ? '/obj' : '/index'});
  return at;
}

const selectedOf = ctx => editOf(ctx).added;
const noItem = {enabled: false, reason: 'Click an added item first'};

async function listing(ctx, pageValue) {
  const {pi, page} = currentPage(ctx, pageValue);
  const {doc} = await readSource(ctx.doc);
  const src = doc.getPage(page.sourceIndex);
  const extra = rotationOf(ctx.doc, pi);
  const items = listAdded(doc, src);
  return {pi, page, src, extra, items};
}

const describe = (page, listedItem) => ({page: page.id, index: listedItem.index, obj: listedItem.obj, kind: listedItem.kind, rect: listedItem.rect,
  ...(listedItem.kind === 'text' ? {size: listedItem.size, bold: listedItem.bold, italic: listedItem.italic, color: listedItem.color, family: listedItem.family, align: listedItem.align,
    charSpacing: listedItem.charSpacing} : {})});

/** Run an edit on the page's source: `build(doc, src, extra, ...)` changes it; one undo step. */
async function onPage(ctx, pageValue, build) {
  guard(ctx, modification);
  const {pi, page} = currentPage(ctx, pageValue);
  const {doc, content} = await editable(ctx.doc, [pi]);
  const src = doc.getPage(content.pages[pi].sourceIndex);
  const extra = rotationOf(content, pi);
  let result;
  try { result = await build({doc, src, extra, page, pi}); } catch (e) { throw asCommandError(e); }
  if (result?.canceled) return result;
  await commit(ctx, doc, content, {});
  return {page, doc, src, extra, ...result};
}

/** Select item `ref` of the page just written: the view's selection follows an edit. */
function reselect(ctx, done, objectNumber) {
  const items = listAdded(done.doc, done.src);
  const at = items.findIndex(x => x.objectNumber === objectNumber);
  if (at < 0) { ctx.setView({edit: {...editOf(ctx), added: null}}); return null; }
  const l = listed(done.src, done.extra, items[at], at);
  ctx.setView({edit: {...editOf(ctx), block: null, image: null, added: describe(done.page, l)}});
  return l;
}

/** The text item's new look after `p`'s style fields. */
function styled(c, p) {
  const out = {...c};
  for (const k of ['family', 'bold', 'italic', 'size', 'align', 'charSpacing']) if (p[k] !== undefined) out[k] = p[k];
  if (p.color !== undefined) out.color = toRgb(p.color);
  return out;
}

export default defineCommands({
  family: 'edit_added',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'edit.text', label: 'Add text', risk: 'edit', needs: 'worker',
      description: 'Add text: with no `text` pick the Text tool (a click on the page puts a 200 point wide box there, a drag draws one, and typing fills it) or, if it is picked, put it down. With `text` add a box at once: `rect` [x0, y0, x1, y1] or `at` [x, y] (its top left) in page view points of `page`, in a standard family (Helvetica, Times or Courier), `size` (1 to 500 points), `color`, `align`, `bold`, `italic` and `charSpacing`. The box wraps its text and its height follows it; it stays editable (edit.added_change). The standard fonts draw Western European characters only.',
      params: s.object({page: pageParam, text: s.optional(s.string({max: 1_000_000})), rect: rectParam, at: s.optional(s.array(s.number({min: -100000, max: 100000}), {min: 2, max: 2})), ...textStyle}),
      state(ctx) { const st = modification(ctx); return st.enabled ? {...st, checked: ctx.view?.tool === ADD_TOOL} : st; },
      async run(ctx, p) {
        if (p.text === undefined) {
          guard(ctx, modification);
          const on = ctx.view?.tool !== ADD_TOOL;
          ctx.setView(on ? {tool: ADD_TOOL, highlighter: false, edit: {block: null, look: {}, notice: null, image: null, added: null}} : {tool: null, edit: {block: null, look: {}, notice: null, image: null, added: null}});
          return {tool: on ? ADD_TOOL : null};
        }
        let number = null;
        const done = await onPage(ctx, p.page, async ({doc, src, extra}) => {
          await prepareUnicode(doc, [p.text]);
          const [W, H] = displaySize(src, extra);
          const t = styled(defaultText(), p);
          t.text = p.text;
          // content_ui.rs: a click puts a 200 pt box with its top left there, as far as the page goes.
          const view = p.rect ?? (p.at ? [p.at[0], p.at[1], Math.min(p.at[0] + 200, W), p.at[1] + t.size * 1.2] : null);
          if (!view) throw new TextError('give the box (`rect`) or where it starts (`at`)');
          t.rect = [Math.min(view[0], view[2]), H - Math.max(view[1], view[3]), Math.max(view[0], view[2]), H - Math.min(view[1], view[3])];
          number = addContent(doc, src, t, extra).objectNumber;
          return {};
        });
        if (done.canceled) return done;
        const l = reselect(ctx, done, number);
        ctx.setUndoLabel('Add text');
        return {page: done.page.id, item: l};
      },
    },
    {
      id: 'edit.image', label: 'Add image…', risk: 'edit', needs: 'worker', dialog: 'system.open-file',
      description: 'Add image: a PNG or JPEG picture (`path` or `base64`; from the window the system Open dialog asks) on `page`, in `rect` [x0, y0, x1, y1] page view points or, without one, centred at its own size (80 % of the page at most, never enlarged). It stays editable (edit.added_change).',
      params: s.object({page: pageParam, path: s.optional(s.string({min: 1, max: 4096})), base64: s.optional(s.string({max: 41_000_000})), name: s.optional(s.string({max: 255})), rect: rectParam}),
      state: modification,
      async run(ctx, p) {
        guard(ctx, modification);
        const file = await readOther(ctx, p, {title: 'Add image', filters: [{name: 'Pictures', extensions: ['png', 'jpg', 'jpeg']}]});
        if (!file) return {canceled: true};
        let number = null;
        const done = await onPage(ctx, p.page, async ({doc, src, extra}) => {
          const pic = await markSource(doc, {name: file.name, bytes: file.bytes});
          if (!pic.image) throw new TextError(`${file.name}: pick a PNG or JPEG picture`);
          const [, H] = displaySize(src, extra);
          const rect = p.rect ? [Math.min(p.rect[0], p.rect[2]), H - Math.max(p.rect[1], p.rect[3]), Math.max(p.rect[0], p.rect[2]), H - Math.min(p.rect[1], p.rect[3])] : centredBox(src, extra, pic.size);
          number = addContent(doc, src, {kind: 'image', rect, image: pic.xobject, rotation: 0, flipH: false, flipV: false, crop: [0, 0, 0, 0]}, extra).objectNumber;
          return {};
        });
        if (done.canceled) return done;
        const l = reselect(ctx, done, number);
        ctx.setUndoLabel('Add image');
        return {page: done.page.id, item: l};
      },
    },
    {
      id: 'edit.added', label: 'Added items of the page', risk: 'read', undo: 'none', needs: 'worker',
      description: 'List the text and pictures added to a page (Add text, Add image): each with its kind, its box in page view points (`rect`), and for text its words, family, bold, italic, size, color, alignment and character spacing.',
      params: s.object({page: pageParam}),
      state: documentOpen,
      async run(ctx, p) {
        const {page, src, extra, items} = await listing(ctx, p.page);
        return {page: page.id, items: items.map((e, i) => listed(src, extra, e, i))};
      },
    },
    {
      id: 'edit.added_select', label: 'Select an added item', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Select an added item (named by `index` or `obj` of `page`) so the Format text and Image controls act on it; without either, put the selection down.',
      params: s.object({page: pageParam, ...itemKey}),
      state: documentOpen,
      async run(ctx, p) {
        if (p.index === undefined && p.obj === undefined) { ctx.setView({edit: {...editOf(ctx), added: null}}); return {item: null}; }
        const {page, src, extra, items} = await listing(ctx, p.page);
        const at = pick(items, p);
        const l = listed(src, extra, items[at], at);
        ctx.setView({edit: {...editOf(ctx), block: null, image: null, look: {}, added: describe(page, l)}});
        return {item: l};
      },
    },
    {
      id: 'edit.added_change', label: 'Change an added item', risk: 'edit', needs: 'worker',
      description: 'Change an added item (the selected one, or `index` or `obj` of `page`): `text` retypes it (`text`), `style` sets the style fields, `move` by `offset` [dx, dy] page view points, `resize` to `rect` [x0, y0, x1, y1] page view points, `delete`; for a picture `rotate_cw`, `rotate_ccw`, `flip_h`, `flip_v`, `crop` (`percent` trimmed from each side, up to 47.5) and `replace` (`path` or `base64`). One undo step.',
      params: s.object({page: pageParam, ...itemKey, change: s.enum(CHANGES), text: s.optional(s.string({max: 1_000_000})), ...textStyle, offset: s.optional(s.array(s.number({min: -14400, max: 14400}), {min: 2, max: 2})),
        rect: rectParam, percent: s.optional(s.union([s.number({min: 0, max: 49}), s.string({max: 12})])), path: s.optional(s.string({min: 1, max: 4096})),
        base64: s.optional(s.string({max: 41_000_000})), name: s.optional(s.string({max: 255}))}),
      state(ctx, p) {
        const st = modification(ctx);
        if (!st.enabled) return st;
        return p?.index === undefined && p?.obj === undefined && !selectedOf(ctx) ? noItem : st;
      },
      async run(ctx, p) {
        const sel = selectedOf(ctx);
        const target = {page: p.page ?? sel?.page, index: p.index, obj: p.obj ?? (p.index === undefined ? sel?.obj : undefined)};
        if (target.index === undefined && target.obj === undefined) throw new CommandError('disabled', noItem.reason);
        let number = null;
        let file = null;
        if (p.change === 'replace') {
          file = await readOther(ctx, p, {title: 'Replace image', filters: [{name: 'Pictures', extensions: ['png', 'jpg', 'jpeg']}]});
          if (!file) return {canceled: true};
        }
        const done = await onPage(ctx, target.page, async ({doc, src, extra}) => {
          const items = listAdded(doc, src);
          const at = pick(items, target);
          const entry = items[at];
          const c = entry.content;
          await prepareUnicode(doc, [c.text, p.text]);
          const [, H] = displaySize(src, extra);
          const display = view => [Math.min(view[0], view[2]), H - Math.max(view[1], view[3]), Math.max(view[0], view[2]), H - Math.min(view[1], view[3])];
          if (p.change === 'delete') { deleteContent(doc, src, entry.ref); return {}; }
          let next = {...c};
          const need = kind => { if (c.kind !== kind) throw new TextError(kind === 'text' ? 'that item is a picture' : 'that item is text'); };
          switch (p.change) {
            case 'text': need('text'); next = {...styled(c, p), text: p.text ?? c.text, rect: [...c.rect]}; break;
            case 'style': need('text'); next = styled(c, p); break;
            case 'move': {
              if (!p.offset) throw new CommandError('invalid_params', 'give the offset [dx, dy] in page view points', {path: '/offset'});
              const r = c.kind === 'text' ? textRect(c) : norm(c.rect);
              next.rect = [r[0] + p.offset[0], r[1] - p.offset[1], r[2] + p.offset[0], r[3] - p.offset[1]];
              break;
            }
            case 'resize': {
              if (!p.rect) throw new CommandError('invalid_params', 'give the new rect in page view points', {path: '/rect'});
              next.rect = display(p.rect);
              break;
            }
            case 'rotate_cw': case 'rotate_ccw': {
              need('image');
              const turn = p.change === 'rotate_ccw' ? 1 : 3;
              next.rotation = (c.rotation + turn) % 4;
              // The turned picture keeps its place: the box swaps its sides about its centre, so the picture is not stretched.
              const r = norm(c.rect), [cx, cy, w, h] = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2, r[2] - r[0], r[3] - r[1]];
              next.rect = [cx - h / 2, cy - w / 2, cx + h / 2, cy + w / 2];
              break;
            }
            case 'flip_h': need('image'); next.flipH = !c.flipH; break;
            case 'flip_v': need('image'); next.flipV = !c.flipV; break;
            case 'crop': {
              need('image');
              const percent = Number(p.percent);
              if (p.percent === undefined || p.percent === '' || !Number.isFinite(percent) || percent < 0 || percent > 47.5) throw new CommandError('invalid_params', 'percent is a number from 0 to 47.5', {path: '/percent'});
              next.crop = clampCrop([percent / 100, percent / 100, percent / 100, percent / 100]);
              break;
            }
            case 'replace': {
              need('image');
              const pic = await markSource(doc, {name: file.name, bytes: file.bytes});
              if (!pic.image) throw new TextError(`${file.name}: pick a PNG or JPEG picture`);
              next.image = pic.xobject;
              break;
            }
            default: throw new CommandError('invalid_params', 'unknown change', {path: '/change'});
          }
          number = updateContent(doc, src, entry.ref, next, extra).objectNumber;
          return {};
        });
        if (done.canceled) return done;
        const LABEL = {text: 'Edit added text', style: 'Format added text', move: 'Move added item', resize: 'Resize added item', delete: 'Delete added item', rotate_cw: 'Rotate image clockwise',
          rotate_ccw: 'Rotate image counterclockwise', flip_h: 'Flip image horizontally', flip_v: 'Flip image vertically', crop: 'Crop image', replace: 'Replace image'}[p.change];
        ctx.setUndoLabel(LABEL);
        if (p.change === 'delete') { ctx.setView({edit: {...editOf(ctx), added: null}}); return {deleted: true}; }
        const l = reselect(ctx, done, number ?? target.obj);
        return {page: done.page.id, item: l};
      },
    },
  ],
});
