// Edit text & images, the image half: click an image of the page to select it; move it by dragging, resize it by its corners, turn it a quarter
// either way, flip it, trim a percentage off each side, or replace it with another picture; the content stream that draws it is rewritten.
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/tools/content_ui.rs   the Image panel (rotate counterclockwise and clockwise, flip horizontal and vertical, replace, crop
//                                            with a % trimmed from each side), the image box and its handles
//   crates/edit/src/images.rs                page_images, change_image (core/folio/lib/page-images.mjs)
// The image's placement is a transform of the page as shown: turns and flips are about the centre of the box as displayed, whatever the page's
// /Rotate. What is not translated is listed in docs/spec/patches/folio/edit.json.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {editable, commit} from '../lib/page-source.mjs';
import {currentPage} from '../lib/comment-geometry.mjs';
import {userToView, userRectToView, viewRectToUser} from '../lib/geom.mjs';
import {mul, invert, at} from '../lib/redact-content.mjs';
import {modification, documentOpen, guard} from '../lib/edit-needs.mjs';
import {readOther} from '../lib/page-files.mjs';
import {markSource} from '../lib/edit-marks.mjs';
import {readImages, changeImage, rectToRect} from '../lib/page-images.mjs';
import {readSource, asCommandError, editOf, pageParam, EDIT_TOOL} from './edit_text.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/tools/content_ui.rs', 'crates/edit/src/images.rs']};

const keyParam = s.optional(s.object({name: s.string({max: 200}), rect: s.array(s.number(), {min: 4, max: 4})}, {description: 'The image as listed (its resource name and box in user space)'}));
const CHANGES = ['rotate_cw', 'rotate_ccw', 'flip_h', 'flip_v', 'crop', 'delete', 'move', 'resize'];

const noImage = {enabled: false, reason: 'Click an image of the page first'};
/** An added picture is selected (Add image): the Image controls change it through edit.added_change. */
const addedPicture = ctx => (editOf(ctx).added?.kind === 'image' ? editOf(ctx).added : null);

/** The user → view affine of a page (user space → points, y down). */
function viewAffine(page) {
  const o = userToView(page, 0, 0), ex = userToView(page, 1, 0), ey = userToView(page, 0, 1);
  return [ex[0] - o[0], ex[1] - o[1], ey[0] - o[0], ey[1] - o[1], o[0], o[1]];
}
/** A transform given in view space, as the user-space transform that does the same to the artwork. */
function inUserSpace(page, t) {
  const v = viewAffine(page), inv = invert(v);
  return mul(mul(v, t), inv);
}

const same = (a, key) => a.name === key.name && a.rect.every((v, i) => Math.abs(v - key.rect[i]) <= 0.01);
function pickImage(images, p) {
  const i = p.key ? (images[p.index ?? -1] && same(images[p.index], p.key) ? p.index : images.findIndex(x => same(x, p.key))) : p.index;
  if (i === undefined || i < 0 || !images[i]) throw new CommandError('not_found', p.key ? 'that image is no longer on the page' : 'the page has no such image', {path: p.key ? '/key' : '/index'});
  return i;
}
const listed = (page, image) => ({index: image.index, key: {name: image.name, rect: image.rect}, name: image.name, width: image.width, height: image.height, isForm: image.isForm,
  rect: userRectToView(page, image.rect), userRect: image.rect});

async function listing(ctx, pageValue) {
  const {pi, page} = currentPage(ctx, pageValue);
  const {doc} = await readSource(ctx.doc);
  let read;
  try { read = readImages(doc, doc.getPage(page.sourceIndex)); } catch (e) { throw asCommandError(e); }
  return {pi, page, read};
}

const selected = ctx => editOf(ctx).image;
const withImage = (ctx, p) => ({page: p.page ?? selected(ctx)?.page, key: p.key ?? (p.index === undefined ? selected(ctx)?.key : undefined), index: p.index ?? (p.key ? undefined : selected(ctx)?.index)});

/** Run a change on one image: open the source, apply, save as one change, keep the image selected. */
async function change(ctx, p, build, label) {
  guard(ctx, modification);
  const target = withImage(ctx, p);
  if (!target.key && target.index === undefined) throw new CommandError('disabled', noImage.reason);
  const {pi, page} = currentPage(ctx, target.page);
  const {doc, content} = await editable(ctx.doc, [pi]);
  const src = doc.getPage(content.pages[pi].sourceIndex);
  let read, image, spec;
  try {
    read = readImages(doc, src);
    image = read.images[pickImage(read.images, target)];
    spec = await build({page, image, doc, view: userRectToView(page, image.rect)});
    if (!spec) return {canceled: true};
    changeImage(doc, src, read, image, spec);
  } catch (e) { throw asCommandError(e); }
  await commit(ctx, doc, content, {});
  // The image after the change: the one of the same name (or the new one) nearest where it was expected.
  let after = null;
  try {
    const next = readImages(doc, src).images;
    const name = spec.replace ? `PCImg${spec.replace.objectNumber}` : image.name;
    const want = spec.transform ? (() => { const r = image.rect; const pts = [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]].map(([x, y]) => at(spec.transform, x, y)); return [Math.min(...pts.map(q => q[0])), Math.min(...pts.map(q => q[1])), Math.max(...pts.map(q => q[0])), Math.max(...pts.map(q => q[1]))]; })() : image.rect;
    const dist = x => Math.abs(x.rect[0] - want[0]) + Math.abs(x.rect[1] - want[1]) + Math.abs(x.rect[2] - want[2]) + Math.abs(x.rect[3] - want[3]);
    const candidates = next.filter(x => x.name === name).sort((a, b) => dist(a) - dist(b));
    if (!spec.delete && candidates[0]) after = listed(page, candidates[0]);
  } catch { /* the change stands; the list is read again on the next click */ }
  ctx.setView({edit: {...editOf(ctx), block: null, image: after ? {page: page.id, index: after.index, key: after.key, rect: after.rect, name: after.name, width: after.width, height: after.height} : null}});
  ctx.setUndoLabel(label);
  return {page: page.id, image: after};
}

export default defineCommands({
  family: 'edit_image',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'edit.images', label: 'Images of the page', risk: 'read', undo: 'none', needs: 'worker',
      description: 'List the images (and grouped artwork) the page draws: each with its box (`rect` in page view points, `userRect` in the page\'s own space), resource name, pixel size and whether it is grouped artwork. Images in headers, footers, watermarks and backgrounds this app added, inline images and images inside forms are not listed.',
      params: s.object({page: pageParam}),
      state: documentOpen,
      async run(ctx, p) {
        const {page, read} = await listing(ctx, p.page);
        return {page: page.id, images: read.images.map(i => listed(page, i))};
      },
    },
    {
      id: 'edit.image_select', label: 'Select an image', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Select an image of the page (named by `key` or `index` of `page`) so the Image controls act on it; without either, put the selection down.',
      params: s.object({page: pageParam, key: keyParam, index: s.optional(s.integer({min: 0, max: 100000}))}),
      state: documentOpen,
      async run(ctx, p) {
        if (!p.key && p.index === undefined) { ctx.setView({edit: {...editOf(ctx), image: null}}); return {image: null}; }
        const {page, read} = await listing(ctx, p.page);
        const i = pickImage(read.images, p);
        const l = listed(page, read.images[i]);
        ctx.setView({edit: {...editOf(ctx), block: null, look: {}, image: {page: page.id, index: i, key: l.key, rect: l.rect, name: l.name, width: l.width, height: l.height}}});
        return {image: l};
      },
    },
    {
      id: 'edit.image_change', label: 'Change an image', risk: 'edit', needs: 'worker',
      description: 'Change the selected image (or the one named by `page` with `key` or `index`): `rotate_cw` or `rotate_ccw` a quarter turn, `flip_h` or `flip_v` about the centre of its box as the page is shown, `crop` with `percent` (0 to 49) trimmed from each side (a clipping path around the drawing: the pixels are kept), `move` by `offset` [dx, dy] page view points, `resize` to `rect` [x0, y0, x1, y1] page view points, or `delete`. Only the stream that draws it is rewritten.',
      params: s.object({page: pageParam, key: keyParam, index: s.optional(s.integer({min: 0, max: 100000})), change: s.enum(CHANGES),
        percent: s.optional(s.union([s.number({min: 0, max: 49}), s.string({max: 12})])), offset: s.optional(s.array(s.number({min: -14400, max: 14400}), {min: 2, max: 2})),
        rect: s.optional(s.array(s.number({min: -100000, max: 100000}), {min: 4, max: 4}))}),
      state(ctx, p) {
        const st = modification(ctx);
        if (!st.enabled) return st;
        if (!p?.key && p?.index === undefined && !selected(ctx) && !addedPicture(ctx)) return noImage;
        return st;
      },
      async run(ctx, p) {
        const pic = addedPicture(ctx);
        if (pic && !p.key && p.index === undefined && !selected(ctx)) {
          return ctx.run('edit.added_change', {page: pic.page, obj: pic.obj, change: p.change, ...(p.percent !== undefined ? {percent: p.percent} : {}), ...(p.offset ? {offset: p.offset} : {}), ...(p.rect ? {rect: p.rect} : {})});
        }
        const LABEL = {rotate_cw: 'Rotate image clockwise', rotate_ccw: 'Rotate image counterclockwise', flip_h: 'Flip image horizontally', flip_v: 'Flip image vertically',
          crop: 'Crop image', delete: 'Delete image', move: 'Move image', resize: 'Resize image'}[p.change];
        return change(ctx, p, ({page, view}) => {
          const [cx, cy] = [(view[0] + view[2]) / 2, (view[1] + view[3]) / 2];
          switch (p.change) {
            case 'rotate_cw': return {transform: inUserSpace(page, [0, 1, -1, 0, cx + cy, cy - cx])};
            case 'rotate_ccw': return {transform: inUserSpace(page, [0, -1, 1, 0, cx - cy, cy + cx])};
            case 'flip_h': return {transform: inUserSpace(page, [-1, 0, 0, 1, 2 * cx, 0])};
            case 'flip_v': return {transform: inUserSpace(page, [1, 0, 0, -1, 0, 2 * cy])};
            case 'crop': {
              const percent = Number(p.percent);
              if (p.percent === undefined || p.percent === '' || !Number.isFinite(percent) || percent < 0 || percent > 49) throw new CommandError('invalid_params', 'percent is a number from 0 to 49', {path: '/percent'});
              return {crop: percent};
            }
            case 'delete': return {delete: true};
            case 'move': {
              if (!p.offset) throw new CommandError('invalid_params', 'give the offset [dx, dy] in page view points', {path: '/offset'});
              return {transform: inUserSpace(page, [1, 0, 0, 1, p.offset[0], p.offset[1]])};
            }
            case 'resize': {
              if (!p.rect) throw new CommandError('invalid_params', 'give the new rect [x0, y0, x1, y1] in page view points', {path: '/rect'});
              if (p.rect[2] - p.rect[0] < 1 || p.rect[3] - p.rect[1] < 1) throw new CommandError('invalid_params', 'the image would be smaller than a point', {path: '/rect'});
              return {transform: inUserSpace(page, rectToRect(view, p.rect))};
            }
            default: throw new CommandError('invalid_params', 'unknown change', {path: '/change'});
          }
        }, LABEL);
      },
    },
    {
      id: 'edit.image_replace', label: 'Replace image…', risk: 'edit', needs: 'worker', dialog: 'system.open-file',
      description: 'Replace the selected image (or the one named by `page` with `key` or `index`) with a PNG or JPEG picture (`path` or `base64`; from the window the system Open dialog asks): the new picture is drawn in the same place, stretched to the old box.',
      params: s.object({page: pageParam, key: keyParam, index: s.optional(s.integer({min: 0, max: 100000})), path: s.optional(s.string({min: 1, max: 4096})),
        base64: s.optional(s.string({max: 41_000_000})), name: s.optional(s.string({max: 255}))}),
      state(ctx, p) {
        const st = modification(ctx);
        if (!st.enabled) return st;
        return !p?.key && p?.index === undefined && !selected(ctx) && !addedPicture(ctx) ? noImage : st;
      },
      async run(ctx, p) {
        const pic = addedPicture(ctx);
        if (pic && !p.key && p.index === undefined && !selected(ctx)) return ctx.run('edit.added_change', {page: pic.page, obj: pic.obj, change: 'replace', ...(p.path ? {path: p.path} : {}), ...(p.base64 ? {base64: p.base64} : {}), ...(p.name ? {name: p.name} : {})});
        return change(ctx, p, async ({doc}) => {
          const got = await readOther(ctx, p, {title: 'Replace image', filters: [{name: 'Pictures', extensions: ['png', 'jpg', 'jpeg']}]});
          if (!got) return null;
          const src = await markSource(doc, {name: got.name, bytes: got.bytes});
          if (!src.image) throw new CommandError('invalid_params', `${got.name}: pick a PNG or JPEG picture`);
          return {replace: src.xobject};
        }, 'Replace image');
      },
    },
  ],
});

export {EDIT_TOOL, viewRectToUser};
