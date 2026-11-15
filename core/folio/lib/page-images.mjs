// The images a page draws (Image and Form XObjects painted by `Do` in its content streams) and changing one: move, resize, turn and flip (the `Do`
// is wrapped in `q ... cm ... Q` with the extra transform, or the `cm` it already sits in is folded), crop (a clip inside its own scope), replace
// (it draws another image in the same place) and delete. Only the stream that draws it is rewritten, as a new object.
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/edit/src/images.rs   PageImage, page_images (the `Do`s of the page's streams: matrix, box, name, object, pixel size, Form artwork),
//                               ImageChange (Transform, Crop, Replace, Delete), rect_to_rect, turn_about_centre, change_image,
//                               transform_image (a transform folded into the `q cm Do Q` the image already sits in), crop_image
//   crates/ui-egui/src/tools/content_ui.rs   the Image panel: rotate counterclockwise and clockwise, flip horizontal and vertical, replace, crop
//                               (% trimmed from each side)
// Not translated (docs/spec/patches/folio/edit.json): the path-clip hit test (visible_rect, clip_rect: an image is hit by its whole box), images
// drawn inside Form XObjects (not listed), inline images, a Form's crop, translate_images' repeated-move folding beyond one `q cm Do Q` level,
// image_transform_scope's search of outer scopes (an image under a shared clip is wrapped where it is drawn). No DOM, no Node built-ins.

import {PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFStream} from 'pdf-lib';
import {parseContent, mul, at, invert} from './redact-content.mjs';
import {pageStreams, pageResources, mk, numA, nameA, TextError} from './text-interp.mjs';
import {writeStreams} from './text-rewrite.mjs';

const N = s => PDFName.of(s);
const MAX_PAGE_IMAGES = 100_000;
const invalid = message => new TextError(message);
const ID = [1, 0, 0, 1, 0, 0];
const finite = v => v.every(x => Number.isFinite(x));
const bboxOf = (m, b) => {
  const pts = [at(m, b[0], b[1]), at(m, b[2], b[1]), at(m, b[0], b[3]), at(m, b[2], b[3])];
  return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
};
const numbers = (context, array, n) => {
  if (!(array instanceof PDFArray) || array.size() !== n) return null;
  const out = array.asArray().map(x => { const v = context.lookup(x); return v instanceof PDFNumber ? v.asNumber() : NaN; });
  return out.every(Number.isFinite) ? out : null;
};

/** Whether a stream is part of added content (a header, footer, watermark or background): those are not the page's own images. */
function isMark(doc, ref) {
  const s = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
  const d = s?.dict;
  return d instanceof PDFDict && d.get(N('PCMark')) instanceof PDFName;
}

/** page_images: the images (and grouped artwork) the page's own streams draw, in drawing order. */
export function readImages(doc, page) {
  const streams = pageStreams(doc, page);
  const ops = [];
  streams.forEach((s, si) => { for (const op of parseContent(s.bytes)) { op.stream = si; ops.push(op); } });
  const resources = pageResources(page);
  const xo = resources instanceof PDFDict ? doc.context.lookup(resources.get(N('XObject'))) : null;
  const marked = streams.map(s => isMark(doc, s.ref));
  const images = [];
  let ctm = ID;
  const stack = [];
  ops.forEach((op, i) => {
    if (op.op === 'q') stack.push(ctm);
    else if (op.op === 'Q') { if (stack.length) ctm = stack.pop(); }
    else if (op.op === 'cm') {
      const v = [0, 1, 2, 3, 4, 5].map(k => numA(op, k));
      if (v.every(x => x !== undefined) && finite(v)) ctm = mul(v, ctm);
    } else if (op.op === 'Do' && xo instanceof PDFDict && !marked[op.stream]) {
      const name = nameA(op, 0);
      if (name === undefined) return;
      const raw = xo.get(N(name));
      const obj = doc.context.lookup(raw);
      if (!(obj instanceof PDFStream)) return;
      const subtype = obj.dict.get(N('Subtype'));
      const isForm = subtype instanceof PDFName && subtype.decodeText() === 'Form';
      let matrix = ctm, bounds = [0, 0, 1, 1];
      if (isForm) {
        const bbox = numbers(doc.context, doc.context.lookup(obj.dict.get(N('BBox'))), 4);
        if (!bbox) return;
        const m = obj.dict.has(N('Matrix')) ? numbers(doc.context, doc.context.lookup(obj.dict.get(N('Matrix'))), 6) : ID;
        if (!m) return;
        matrix = mul(m, ctm);
        bounds = bbox;
      } else if (!(subtype instanceof PDFName && subtype.decodeText() === 'Image')) return;
      const rect = bboxOf(matrix, bounds);
      if (!finite([...bounds, ...matrix, ...rect]) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1] || rect[2] <= rect[0] || rect[3] <= rect[1]) return;
      if (images.length >= MAX_PAGE_IMAGES) throw invalid(`the page draws more than ${MAX_PAGE_IMAGES} images`);
      const dim = k => { const v = doc.context.lookup(obj.dict.get(N(k))); return v instanceof PDFNumber ? Math.max(0, Math.round(v.asNumber())) : 0; };
      images.push({index: images.length, rect, matrix, name, object: raw instanceof PDFRef ? raw.objectNumber : null, isForm, width: isForm ? 0 : dim('Width'), height: isForm ? 0 : dim('Height'), op: i, stream: op.stream, draw: ctm});
    }
  });
  return {streams, ops, images, resources};
}

/** The user-space transform that maps box `from` onto box `to` (move and resize). */
export function rectToRect(from, to) {
  const [fw, fh] = [Math.max(from[2] - from[0], 1e-6), Math.max(from[3] - from[1], 1e-6)];
  const [sx, sy] = [(to[2] - to[0]) / fw, (to[3] - to[1]) / fh];
  return [sx, 0, 0, sy, to[0] - from[0] * sx, to[1] - from[1] * sy];
}
/** turn_about_centre in a y-up space: a quarter turn clockwise (`quarters` 1, 2, 3) about the centre of `rect`, or a flip. */
export function turnAboutCentre(rect, quarters, flipH, flipV) {
  const [cx, cy] = [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];
  const [a0, b0, c0, d0] = [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0]][((quarters % 4) + 4) % 4];
  const [fx, fy] = [flipH ? -1 : 1, flipV ? -1 : 1];
  const [a, b, c, d] = [a0 * fx, b0 * fy, c0 * fx, d0 * fy];
  return [a, b, c, d, cx - a * cx - c * cy, cy - b * cx - d * cy];
}

/** The `cm` to put before a `Do` drawn in `draw` so that the user-space transform `t` is applied to what it draws (draw · t = local · draw). */
function localTransform(draw, t) {
  const inv = invert(draw);
  if (!inv) throw invalid('the image is drawn in a space that cannot be changed');
  return mul(mul(draw, t), inv);
}

/**
 * image_transform_scope: the saved graphics-state scope that holds just this image and its crop (`q re W n Do Q`), so a transform put around that scope
 * moves the clipping path as well as the pixels; a shared clip stays where it is. {start, end, placement}: the scope's `q` and `Q` and the CTM before it.
 * An unclipped image is its own scope (placement = its CTM). null when no scope qualifies.
 */
function imageTransformScope(ops, target) {
  const stack = [];
  let matrix = ID, clipped = false, path = false, pendingClip = false, text = false;
  let atImage = null, isolated = null, outermost = null;
  const PAINT = new Set(['Do', 'Tj', 'TJ', "'", '"', 'sh', 'BI', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    switch (op.op) {
      case 'q':
        if (stack.length >= 256) throw invalid('the image graphics state is too deeply nested to transform');
        stack.push({start: index, matrix, inheritedClip: clipped, inheritedPath: path, selected: false, otherPaint: false});
        break;
      case 'Q': {
        const scope = stack.pop();
        if (scope) {
          if (scope.selected && !scope.otherPaint && !scope.inheritedPath) {
            if (!scope.inheritedClip && !isolated) isolated = {start: scope.start, end: index, placement: scope.matrix};
            outermost = {start: scope.start, end: index, placement: scope.matrix};
          }
          matrix = scope.matrix;
          clipped = scope.inheritedClip;
        }
        break;
      }
      case 'cm': { const v = [0, 1, 2, 3, 4, 5].map(k => numA(op, k)); if (v.every(x => x !== undefined)) matrix = mul(v, matrix); break; }
      case 'BT': text = true; break;
      case 'ET': text = false; break;
      case 'm': case 'l': case 'c': case 'v': case 'y': case 're': path = true; break;
      case 'W': case 'W*': pendingClip = true; break;
      default: break;
    }
    if (index === target) {
      if (text) throw invalid('an image inside a text object cannot be transformed');
      atImage = {matrix, clipped};
      for (const scope of stack) scope.selected = true;
    } else if (PAINT.has(op.op)) for (const scope of stack) scope.otherPaint = true;
    if (['n', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*'].includes(op.op)) { clipped ||= pendingClip; pendingClip = false; path = false; }
  }
  if (!atImage) throw invalid('the image operation is missing');
  if (!atImage.clipped) return {start: target, end: target, placement: atImage.matrix};
  return isolated ?? outermost;
}

/** enclosing_transform: the `q cm ... Q` whose only content after its `cm` is start..end: the index and value of that `cm`. */
function enclosingTransform(ops, start, end) {
  const [cm, q, close] = [ops[start - 1], ops[start - 2], ops[end + 1]];
  if (!cm || !q || !close || q.op !== 'q' || close.op !== 'Q' || cm.op !== 'cm' || cm.args.length !== 6) return null;
  const m = [0, 1, 2, 3, 4, 5].map(k => numA(cm, k));
  return m.every(v => v !== undefined && Number.isFinite(v)) ? {at: start - 1, cm: m} : null;
}

/**
 * change_image: change image `image` (from readImages). `change`: {transform: [6]} (user space, after its placement), {crop: percent} (trim that
 * percent of its width and height from each side), {replace: PDFRef} (draw that image XObject in the same place) or {delete: true}.
 */
export function changeImage(doc, page, read, image, change) {
  const {ops} = read;
  const op = ops[image.op];
  if (!op || op.op !== 'Do') throw invalid('the image operation is missing');
  const drops = new Set();
  const inserts = new Map();
  const at1 = k => ops[k];
  if (change.delete) drops.add(image.op);
  else if (change.transform) {
    if (!change.transform.every(v => Number.isFinite(v) && Math.abs(v) <= 1e12)) throw invalid('the image transform must be finite and no larger than 1e12');
    const scope = imageTransformScope(ops, image.op) ?? {start: image.op, end: image.op, placement: image.draw};
    const local = localTransform(scope.placement, change.transform);
    const enclosing = enclosingTransform(ops, scope.start, scope.end);
    if (enclosing) {
      // Already alone in a `q cm ... Q` (its own placement, or the wrapper an earlier change added): change that `cm` in place.
      const folded = mul(local, enclosing.cm);
      if (!folded.every(v => Number.isFinite(v) && Math.abs(v) <= 1e12)) throw invalid('the image transform is too large');
      drops.add(enclosing.at);
      inserts.set(enclosing.at, [mk.op('cm', ...folded.map(mk.num))]);
    } else if (scope.start === scope.end) {
      drops.add(image.op);
      inserts.set(image.op, [mk.op('q'), mk.op('cm', ...local.map(mk.num)), op, mk.op('Q')]);
    } else {
      // Around the whole scope: the clip moves with the pixels.
      inserts.set(scope.start, [mk.op('q'), mk.op('cm', ...local.map(mk.num))]);
      drops.add(scope.end);
      inserts.set(scope.end, [ops[scope.end], mk.op('Q')]);
    }
  } else if (change.crop !== undefined) {
    if (image.isForm) throw invalid('grouped artwork can be moved, resized, turned, flipped or deleted; cropping it is not supported');
    const p = Math.min(Math.max(change.crop / 100, 0), 0.49);
    drops.add(image.op);
    inserts.set(image.op, [mk.op('q'), mk.op('re', mk.num(p), mk.num(p), mk.num(1 - 2 * p), mk.num(1 - 2 * p)), mk.op('W'), mk.op('n'), op, mk.op('Q')]);
  } else if (change.replace) {
    if (image.isForm) throw invalid('grouped artwork can be moved, resized, turned, flipped or deleted; replacing it with a bitmap is not supported');
    const ctx = doc.context;
    const name = `PCImg${change.replace.objectNumber}`;
    const inherited = page.node.Resources();
    const res = inherited ? inherited.clone(ctx) : ctx.obj({});
    const x = res.lookup(N('XObject'));
    const xo = x instanceof PDFDict ? x.clone(ctx) : ctx.obj({});
    xo.set(N(name), change.replace);
    res.set(N('XObject'), xo);
    page.node.set(N('Resources'), res);
    drops.add(image.op);
    inserts.set(image.op, [mk.op('Do', mk.name(name))]);
  } else throw invalid('nothing to change');
  writeStreams(doc, page, read, drops, inserts);
  return {};
}

export {TextError};
