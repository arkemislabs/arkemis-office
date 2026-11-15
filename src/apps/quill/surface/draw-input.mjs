// What a drag on the page does while a Draw tool is picked (U:quill/draw): a pen draws an ink stroke
// through the dragged points, the eraser deletes the strokes it passes over, the lasso draws a loop that
// selects the ink inside it (or, started inside the selection, moves it). The page view turns the pointer's
// events into one gesture (page + points in page points) and runs these commands; the bridge's `ui.pointer`
// `{action: 'stroke', page, path}` (`draw` / `points` its old name) runs the very same gesture, so tests draw without a real mouse.
//
// Translated from wordcraft crates/ui-egui/src/canvas/input.rs (the draw modes of `handle_primary_press` /
// release: `draw_stroke`, `erase_at`, `lasso_loop`, `drag_lasso`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

/** The Draw tools that take over dragging on the page. */
export const DRAW_MODES = Object.freeze(['pen', 'pencil', 'highlighter', 'eraser', 'lasso']);
export const isPen = mode => mode === 'pen' || mode === 'pencil' || mode === 'highlighter';

/** The mode the document view is in (select when no Draw tool is picked). */
export const drawModeOf = view => (DRAW_MODES.includes(view?.draw?.mode) ? view.draw.mode : 'select');

/**
 * The commands one drag runs: [[command, params]] (gesture). `lasso`: {page, rect: {x, y, w, h}} of the selection, or null.
 * @param {string} mode
 * @param {number} page
 * @param {number[][]} points
 * @param {{page: number, rect: {x: number, y: number, w: number, h: number}} | null} [lasso]
 * @returns {[string, Record<string, unknown>][]}
 */
export function gesture(mode, page, points, lasso = null) {
  const pts = points.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return [];
  if (isPen(mode)) return [['draw.stroke', {page, points: pts}]];
  if (mode === 'eraser') return pts.map(([x, y]) => ['draw.erase', {page, x, y}]);
  if (mode === 'lasso') {
    const [x, y] = pts[0];
    const r = lasso?.rect;
    if (r && lasso.page === page && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      const [lx, ly] = pts[pts.length - 1];
      return lx === x && ly === y ? [] : [['draw.lassoMove', {dx: lx - x, dy: ly - y}]];
    }
    return pts.length >= 3 ? [['draw.lasso', {page, points: pts}]] : [['draw.lasso', {clear: true}]];
  }
  return [];
}

/** Display items without the ink that is hidden (Review › Hide Ink) or not yet replayed (Ink Replay: strokes drawn after `replayMax`). */
export function visibleItems(items, hide, replayMax) {
  if (!hide && replayMax === null) return items;
  return items.filter(it => {
    const f = it.freeform;
    if (!f?.ink) return true;
    if (hide) return false;
    return (f.order ?? 0) <= replayMax;
  });
}

/** The union of the rects of `positions` on `page` in a layout, or null (lasso_bounds). */
export function lassoBounds(lay, page, positions) {
  const pg = lay?.pages?.[page];
  if (!pg) return null;
  let r = null;
  for (const it of pg.items) {
    if (it.kind !== 'object' || !positions.some(p => p.story === it.story && p.off === it.off && p.path.length === it.path.length && p.path.every((v, i) => v === it.path[i]))) continue;
    const q = it.rect;
    r = r ? {x: Math.min(r.x, q.x), y: Math.min(r.y, q.y), w: Math.max(r.x + r.w, q.x + q.w) - Math.min(r.x, q.x), h: Math.max(r.y + r.h, q.y + q.h) - Math.min(r.y, q.y)} : {x: q.x, y: q.y, w: q.w, h: q.h};
  }
  return r;
}

/** The drawing order numbers of the ink in a content's body, sorted (Ink Replay plays them in this order). */
export function inkOrders(content) {
  const out = [];
  for (const chunk of content?.body?.chunks ?? []) {
    for (const b of chunk) for (const o of b.objects ?? []) if (o.type === 'shape' && o.freeform?.ink) out.push(o.freeform.order ?? 0);
  }
  return out.sort((a, b) => a - b);
}
