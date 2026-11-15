// The page view's geometry, shared by the surface (src/apps/folio/surface) and its tests:
// continuous single-page layout, virtualization, the current page, fit zoom, comment hit tests
// and text selections as document addresses.
//
// Translated from printcraft crates/ui-egui/src/canvas.rs (PT, GAP, MARGIN, SIDE; the continuous
// layout: pages stacked top to bottom with GAP between them and MARGIN above the first and below
// the last, centred; Fit Width / Fit Page; the current page), crates/ui-egui/src/tools/comments/
// geometry.rs (is_markup, resizable, reshapable, HANDLES, handle_pos, resized) and state.rs (hit:
// the topmost comment under the pointer, markup by its quads) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

import {viewSize, userRectToView, quadsOf, userToView, normalize} from './geom.mjs';
import {nameAt, nums} from './cos.mjs';
import {isCommentSubtype} from '../model/types.mjs';

/** canvas.rs `PT`: logical pixels per PDF point at 100 % (96 dpi). */
export const PT = 96 / 72;
/** canvas.rs `GAP`: between pages. */
export const GAP = 14;
/** canvas.rs `MARGIN`: above the first page and below the last. */
export const MARGIN = 28;
/** canvas.rs `SIDE`: the horizontal gutter beside the pages. */
export const SIDE = 70;
/** Zoom limits (canvas/zoom.rs: the zoom is clamped to 0.08–64, 8–6400 %). */
export const MIN_ZOOM = 8, MAX_ZOOM = 6400;

/** zoom.rs `STEPS`: the zoom of the zoom buttons and keys, in percent. */
export const ZOOM_STEPS = Object.freeze([10, 25, 33, 50, 66, 75, 100, 125, 150, 200, 300, 400, 600, 800, 1200, 1600, 3200]);
/** The next zoom step above (up) or below the percent `z`, or null at the ends (zoom_step: a step must differ by 1 %). */
export const zoomStep = (z, up) => (up ? ZOOM_STEPS.find(s => s > z * 1.01) : [...ZOOM_STEPS].reverse().find(s => s < z * 0.99)) ?? null;

/** The page display of a view: layout 'single' or 'two-up', continuous scrolling, cover page, gaps between pages. */
export const displayOf = (view = {}) => ({layout: view.layout === 'two-up' ? 'two-up' : 'single', continuous: view.continuous !== false, cover: !!view.cover, gaps: view.gaps !== false});

/** zoom.rs `spread_first`: the first page of the two-page spread page `c` is in: [0, 1], [2, 3] ... or with a cover [0], [1, 2], [3, 4] ... */
export const spreadFirst = (c, cover) => (cover ? Math.max(0, c - ((c + 1) % 2)) : c - (c % 2));

/** The pages of each row (a page, or a spread) of a display. */
export function rowsOf(n, {layout = 'single', cover = false} = {}) {
  const rows = [];
  if (layout !== 'two-up') { for (let i = 0; i < n; i++) rows.push([i]); return rows; }
  let i = 0;
  if (cover && n) { rows.push([0]); i = 1; }
  for (; i < n; i += 2) rows.push(i + 1 < n ? [i, i + 1] : [i]);
  return rows;
}

/** navigation.rs `step_page`: the page a step forward or back goes to (two-page view moves a whole spread), or null past either end. */
export function stepTarget(current, forward, count, {layout = 'single', cover = false} = {}) {
  const last = count - 1;
  let target;
  let first = current;
  if (layout === 'two-up') {
    first = spreadFirst(current, cover);
    if (forward) target = cover && current === 0 ? 1 : first + 2;
    else target = cover && first <= 1 ? 0 : Math.max(0, first - 2);
  } else target = forward ? current + 1 : Math.max(0, current - 1);
  if (forward ? target > last : first === 0) return null;
  return target;
}

/**
 * The page display at `zoom` percent: each page's top, left and size (CSS pixels) and the scroll height. Pages
 * are centred in `width` (the scroll area's width). Continuous scrolling stacks the rows (a page, or a spread
 * of two) top to bottom; otherwise each row has a slot at least as high as the view (`viewHeight`) and the scroll
 * snaps to the slots, one page or spread at a time. A cover page of a two-page view sits on the right of its spread.
 * @param {object[]} pages content pages
 * @param {number} zoom percent
 * @param {number} [width]
 * @param {{layout?: string, continuous?: boolean, cover?: boolean, gaps?: boolean, viewHeight?: number}} [display]
 */
export function layoutPages(pages, zoom, width = 0, display = {}) {
  const {layout, continuous, cover, gaps} = displayOf(display);
  const viewHeight = display.viewHeight ?? 0;
  const scale = PT * zoom / 100;
  const gap = gaps ? GAP : 0;
  const n = pages.length;
  const tops = new Float64Array(n), lefts = new Float64Array(n), widths = new Float64Array(n), heights = new Float64Array(n), slotTops = new Float64Array(n);
  for (let i = 0; i < n; i++) { const s = viewSize(pages[i]); widths[i] = s.width * scale; heights[i] = s.height * scale; }
  const rows = rowsOf(n, {layout, cover});
  const rowWidth = r => r.reduce((w, i) => w + widths[i], 0) + gap * (r.length - 1);
  const widest = rows.reduce((w, r) => Math.max(w, layout === 'two-up' ? Math.max(rowWidth(r), r.length === 1 ? widths[r[0]] * 2 + gap : 0) : rowWidth(r)), 0);
  const contentWidth = Math.max(width, widest + 2 * SIDE);
  let y = MARGIN;
  rows.forEach((r, k) => {
    const rowHeight = Math.max(...r.map(i => heights[i]));
    const slot = continuous ? rowHeight : Math.max(rowHeight + 2 * MARGIN, viewHeight);
    const slotTop = continuous ? y : y - MARGIN;
    const rowTop = continuous ? y : slotTop + (slot - rowHeight) / 2;
    if (r.length === 2) {
      const x = (contentWidth - rowWidth(r)) / 2;
      lefts[r[0]] = x; lefts[r[1]] = x + widths[r[0]] + gap;
    } else if (layout === 'two-up') {
      const i = r[0];
      lefts[i] = cover && k === 0 ? contentWidth / 2 + gap / 2 : contentWidth / 2 - gap / 2 - widths[i];
    } else lefts[r[0]] = (contentWidth - widths[r[0]]) / 2;
    for (const i of r) { tops[i] = rowTop; slotTops[i] = slotTop; }
    y += continuous ? rowHeight + (k + 1 < rows.length ? gap : 0) : slot;
  });
  const height = n ? (continuous ? y + MARGIN : y + MARGIN) : 0;
  return {scale, tops, widths, heights, slotTops, height, width: contentWidth, left: i => lefts[i], lefts, rows, display: {layout, continuous, cover, gaps}};
}

/** The first page whose bottom is below `y` (binary search over the tops). */
export function pageAtY(layout, y) {
  const {tops, heights} = layout;
  let lo = 0, hi = tops.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] + heights[mid] < y) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Pages that intersect [top - overscan, top + height + overscan]: [first, last] (inclusive), or null. */
export function visiblePages(layout, top, height, overscan = 0) {
  const n = layout.tops.length;
  if (!n) return null;
  const first = pageAtY(layout, top - overscan);
  let last = first;
  const bottom = top + height + overscan;
  while (last + 1 < n && layout.tops[last + 1] <= bottom) last++;
  return [first, last];
}

/**
 * canvas.rs current page: the page covering most of the view (a tie goes to the upper page,
 * PAGE_TIE); before any page is laid out, page 0.
 */
export function currentPage(layout, top, height) {
  const range = visiblePages(layout, top, height);
  if (!range) return 0;
  let best = range[0], area = -1;
  for (let i = range[0]; i <= range[1]; i++) {
    const a = Math.min(top + height, layout.tops[i] + layout.heights[i]) - Math.max(top, layout.tops[i]);
    if (a > area + 0.5) { area = a; best = i; }
  }
  return best;
}

/**
 * Fit modes of View > Zoom (zoom.rs `fit_zoom`): Fit Width fills the view's width less the side gutters with the widest
 * page (or the two pages of a spread side by side); Fit Page shows the whole current page; Fit Height its height; Fit
 * Visible the visible content of the current page (`content`: its box in view points). A single page shown on its own
 * fits that page; every other display fits its largest page, so the zoom holds still while pages of other sizes scroll.
 * Returns a percent clamped to the zoom limits.
 * @param {string} fit
 * @param {object|null} page the page (when `pages` is not given)
 * @param {number} viewWidth
 * @param {number} viewHeight
 * @param {{pages?: object[]|null, current?: number, layout?: string, continuous?: boolean, gaps?: boolean, content?: number[]|null}} [opts] all the pages with the current one, the display, the visible content's box
 */
export function fitZoom(fit, page, viewWidth, viewHeight, opts = {}) {
  const {pages = null, current = 0, layout = 'single', continuous = true, gaps = true, content = null} = opts;
  const list = pages ?? (page ? [page] : []);
  if (!list.length) return 100;
  const sizes = list.map(viewSize);
  const single = layout === 'single' && !continuous;
  const shown = single ? [sizes[Math.min(current, sizes.length - 1)] ?? sizes[0]] : sizes;
  let w = Math.max(1, ...shown.map(s => s.width)), h = Math.max(1, ...shown.map(s => s.height));
  if (fit === 'visible' && content && content[2] > content[0] && content[3] > content[1]) { w = content[2] - content[0]; h = content[3] - content[1]; }
  const perRow = layout === 'two-up' ? 2 : 1;
  const gap = gaps ? GAP : 0;
  const aw = Math.max(100, viewWidth - 2 * SIDE);
  const byWidth = (aw - gap * (perRow - 1)) / (w * PT * perRow) * 100;
  const byHeight = Math.max(1, viewHeight - 2 * MARGIN) / (h * PT) * 100;
  const z = fit === 'width' || fit === 'pageWidth' || fit === 'textWidth' ? byWidth
    : fit === 'height' ? byHeight
      : fit === 'page' || fit === 'onePage' || fit === 'fit' || fit === 'multiplePages' || fit === 'visible' ? Math.min(byWidth, byHeight) : 100;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

// ── comments on the page (tools/comments/geometry.rs, state.rs) ─────────────────────────────

export const isMarkup = subtype => subtype === 'Highlight' || subtype === 'Underline' || subtype === 'StrikeOut' || subtype === 'Squiggly';

/** geometry.rs `resizable`: rectangles, ovals, text boxes, stamps and drawings; a callout only moves. */
export const resizable = r => ['Square', 'Circle', 'FreeText', 'Stamp', 'Ink'].includes(nameAt(r.dict, 'Subtype')) && nameAt(r.dict, 'IT') !== 'FreeTextCallout';

/** geometry.rs `reshapable`: lines, connected lines, polygons and clouds (not measurements, not locked). */
export function reshapable(r) {
  const sub = nameAt(r.dict, 'Subtype');
  if (!['Line', 'PolyLine', 'Polygon'].includes(sub)) return false;
  if (((Number.isInteger(r.dict.F) ? r.dict.F : 0) & 128) !== 0) return false;
  return !String(nameAt(r.dict, 'IT') ?? '').endsWith('Dimension') && pointsOf(r).length > 0;
}

/** The points a line, connected lines or polygon is drawn through (user space). */
export function pointsOf(r) {
  const sub = nameAt(r.dict, 'Subtype');
  const v = sub === 'Line' ? nums(r.dict, 'L') : nums(r.dict, 'Vertices');
  const out = [];
  if (v) for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i], v[i + 1]]);
  return out;
}

/** input.rs: a comment moves unless it is text markup (it stays with its text), a reply or locked. */
export const movable = r => !isMarkup(nameAt(r.dict, 'Subtype')) && !(r.irt && nameAt(r.dict, 'RT') !== 'Group') && ((Number.isInteger(r.dict.F) ? r.dict.F : 0) & 128) === 0;

/** Comments on the page (info.rs is_comment_subtype): not links or widgets, not hidden (flag 2), not replies. */
export const shownOnPage = r => isCommentSubtype(nameAt(r.dict, 'Subtype') ?? '') && ((Number.isInteger(r.dict.F) ? r.dict.F : 0) & 2) === 0 && !(r.irt && nameAt(r.dict, 'RT') !== 'Group');

/** The rectangles a comment covers on the page, in view points: one per quad for text markup, else /Rect. */
export function viewRects(page, r) {
  const sub = nameAt(r.dict, 'Subtype');
  if (isMarkup(sub)) {
    const qs = quadsOf(r.dict.QuadPoints);
    if (qs.length) {
      return qs.map(q => {
        const pts = [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]].map(([x, y]) => userToView(page, x, y));
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      });
    }
  }
  const rect = nums(r.dict, 'Rect');
  return rect && rect.length === 4 ? [userRectToView(page, normalize(rect))] : [];
}

/** state.rs `hit`: the topmost comment shown on the page whose area holds view point (vx, vy), with `slop` points around thin ones. */
export function hitComment(page, vx, vy, slop = 2) {
  const list = page.annots ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (!shownOnPage(r)) continue;
    for (const [x0, y0, x1, y1] of viewRects(page, r)) if (vx >= x0 - slop && vx <= x1 + slop && vy >= y0 - slop && vy <= y1 + slop) return r;
  }
  return null;
}

/** geometry.rs `HANDLES`: the eight resize handles, clockwise from the top-left. */
export const HANDLES = Object.freeze([[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]);

/** geometry.rs `handle_pos`. */
export function handlePos(r, [hx, hy]) {
  return [hx < 0 ? r[0] : hx === 0 ? (r[0] + r[2]) / 2 : r[2], hy < 0 ? r[1] : hy === 0 ? (r[1] + r[3]) / 2 : r[3]];
}

/** geometry.rs `resized`: a view rect dragged by a handle by (dx, dy); with a ratio, corners keep the proportions. */
export function resized(r, [hx, hy], dx, dy, ratio = null) {
  if (hx !== 0 && hy !== 0 && Number.isFinite(ratio) && ratio > 0) {
    const width = Math.max(r[2] - r[0] + hx * dx, (r[3] - r[1] + hy * dy) * ratio, 4, 4 * ratio);
    const anchor = handlePos(r, [-hx, -hy]);
    return normalize([anchor[0], anchor[1], anchor[0] + hx * width, anchor[1] + hy * width / ratio]);
  }
  const out = r.slice();
  if (hx === -1) out[0] += dx; else if (hx === 1) out[2] += dx;
  if (hy === -1) out[1] += dy; else if (hy === 1) out[3] += dy;
  return normalize(out);
}

// ── text selection ↔ document addresses (docs/architecture.md 14.5) ────────────────────────

const pageAddress = pageId => `/pg:${encodeURIComponent(pageId)}`;

/**
 * A run selection from glyph `anchor` to glyph `head` (selection.rs `Span::Run`, inclusive) as a
 * session selection range over the page text: anchor and focus are carets at the run's ends.
 */
export function runSelection(pageId, text, anchor, head) {
  const [from, to] = text.charRange(Math.min(anchor, head), Math.max(anchor, head));
  const a = `${pageAddress(pageId)}/chars:${head >= anchor ? from : to}`, f = `${pageAddress(pageId)}/chars:${head >= anchor ? to : from}`;
  return {anchor: a, focus: f};
}

/** The run a session selection holds on a page: {pageId, first, last, anchorGlyph, headGlyph} in glyphs, or null. */
export function selectionRun(selection, pageTexts) {
  const r = selection?.ranges?.[selection.primary ?? 0];
  if (!r) return null;
  const re = /^\/pg:([^/]+)\/chars:(\d+)(?:-(\d+))?$/;
  const a = re.exec(String(r.anchor ?? '')), f = re.exec(String(r.focus ?? ''));
  if (!a || !f || a[1] !== f[1]) return null;
  const pageId = decodeURIComponent(a[1]);
  const text = pageTexts(pageId);
  if (!text) return null;
  const nums = [a[2], a[3], f[2], f[3]].filter(x => x !== undefined).map(Number);
  const from = Math.min(...nums), to = Math.max(...nums);
  if (to <= from) return null;
  const g = text.glyphRange(from, to);
  if (!g) return null;
  const forward = Number(a[2]) <= Number(f[2]);
  return {pageId, first: g[0], last: g[1], anchorGlyph: forward ? g[0] : g[1], headGlyph: forward ? g[1] : g[0]};
}

/** selection.rs `click_unit`: two clicks the word, three the line, more the page. */
export function clickUnit(text, clicks, glyph) {
  if (clicks === 2) return text.wordAt(glyph);
  if (clicks === 3) return text.lineAt(glyph);
  return text.glyphs.length ? [0, text.glyphs.length - 1] : null;
}
