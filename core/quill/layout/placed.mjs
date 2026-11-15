// Things placed on a page, in page coordinates (points, y down).
//
// Translated from wordcraft crates/layout/src/placed.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). Each item is a plain object with a `kind`:
//
//   lines  {story, path, para: ParaLayout, l0, l1, x, y}   lines l0..l1; y = top of line l0, x = column left
//   fill   {rect, color}                                    shading (paragraph, cell)
//   rule   {x0, y0, x1, y1, border}                         a border line, page border, separator
//   image  {rect, media, crop, story, path, off, rot}       a picture (floating, or inline in a line)
//   shape  {rect, shape, fill, stroke, strokeWidth, rot, story, path, off}
//   cell   {rect, covered, table, row, cell, story, clip}   a table cell's area (hit testing)
//   object {rect, rot, story, path, off, textBox, wrap, origin}  a drawing's area (hit testing, handles)
//
// `story` is 'body' or a part id; `path` the paragraph path (model `Document` paths).

export const rect = (x, y, w, h) => ({x, y, w, h});
export const rectBottom = r => r.y + r.h;
export const rectRight = r => r.x + r.w;

/** Move an item by (dx, dy) (Placed::translate). */
export function translate(it, dx, dy) {
  switch (it.kind) {
    case 'lines': it.x += dx; it.y += dy; break;
    case 'rule': it.x0 += dx; it.x1 += dx; it.y0 += dy; it.y1 += dy; break;
    case 'object': it.rect = {...it.rect, x: it.rect.x + dx, y: it.rect.y + dy}; if (it.origin) it.origin = {x: it.origin.x + dx, y: it.origin.y + dy}; break;
    default: if (it.rect) it.rect = {...it.rect, x: it.rect.x + dx, y: it.rect.y + dy};
  }
  return it;
}
/** A copy of `it` moved by (dx, dy). */
export const moved = (it, dx, dy) => translate({...it}, dx, dy);

/** The bottom of lines l0..l1 of `para` placed at y (item_bottom); null without lines. */
export function itemBottom(y, para, l0, l1) {
  const f = para.lines[l0], l = para.lines[l1 - 1];
  if (!f || !l) return null;
  return y + l.top + l.height - f.top;
}

/** The vertical extent of an item (v_span). */
export function vSpan(it) {
  switch (it.kind) {
    case 'lines': return [it.y, itemBottom(it.y, it.para, it.l0, it.l1) ?? it.y];
    case 'rule': return [Math.min(it.y0, it.y1), Math.max(it.y0, it.y1)];
    default: return it.rect ? [it.rect.y, it.rect.y + it.rect.h] : [0, 0];
  }
}

/** Header/footer slot a page shows (HfSlot). */
export const HF_SLOTS = Object.freeze(['default', 'first', 'even']);

export const pathKey = path => path.join('.');
export const storyKey = story => (story === 'body' ? 'body' : `p${story}`);
