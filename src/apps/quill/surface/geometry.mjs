// Page placement for Quill's Print Layout page view: where each page sits on the canvas at the
// current zoom, which page is under a point, which page is in view, and the ruler graduations.
//
// Translated from wordcraft crates/ui-egui/src/canvas/geometry.rs (`place_pages`, `columns_for`,
// `sane_dim`, `geometry`'s fit scales, `on_page_gap`, `on_visible_page`), canvas/navigation.rs
// (`page_at`, `nearest_page`, `top_page`, `viewed_page`), canvas/input.rs (`press_count`,
// `edge_scroll`) and canvas/rulers.rs (`ruler_density`, `ruler_marks`, `ruler_x`, `ruler_d`,
// `ruler_scale`) at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Pure functions over numbers (no DOM): screen units are CSS pixels, document units points.

/** Screen pixels per point at 100% zoom (canvas.rs PX_PER_PT). */
export const PX_PER_PT = 96 / 72;
/** Space around and between pages (canvas.rs GAP, screen px). */
export const GAP = 18;
/** Ruler thickness (canvas.rs RULER, screen px). */
export const RULER = 22;
/** Page tiles are painted in strips this tall (canvas.rs TILE_HEIGHT_PX). */
export const TILE_HEIGHT_PX = 1024;
/** Width of the markup area beside each page for comment balloons (geometry.rs markup_width, points). */
export const MARKUP_WIDTH = 216;

const finite = (v, d) => (Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A page dimension (points) safe to lay out: finite, at least 1 pt, at most `cap` (sane_dim). */
export function saneDim(v, cap) {
  return Number.isFinite(v) ? clamp(v, 1, cap) : 72;
}

/**
 * How many pages fit side by side (columns_for): as many slots of `slotPx` as the width holds with
 * a gap around each. At least `minCols`, never more than `pages`.
 */
export function columnsFor(availW, slotPx, pages, minCols, auto) {
  const fit = auto && Number.isFinite(availW) && Number.isFinite(slotPx) && slotPx > 0 ? Math.max(1, Math.floor((availW - GAP) / (slotPx + GAP))) : 1;
  return Math.max(1, Math.min(Math.max(fit, minCols), Math.max(pages, 1)));
}

/**
 * Place pages (sizes in points) in rows of `cols`, each in a slot as wide as the widest page plus
 * `markup`, centred in `availW` (place_pages). Returns {rects: [{x, y, w, h}] (content px), size: {w, h}}.
 */
export function placePages(sizes, markup, scale, cols, avail) {
  cols = Math.max(1, cols | 0);
  scale = Number.isFinite(scale) ? clamp(scale, 0.01, 10) : PX_PER_PT;
  markup = Number.isFinite(markup) ? clamp(markup, 0, 10_000) : 0;
  const aw = Math.max(0, finite(avail.w, 0)), ah = Math.max(0, finite(avail.h, 0));
  const maxw = Math.max(72, ...sizes.map(([w]) => saneDim(w, 1e5))) + markup;
  const slot = maxw * scale;
  const rowW = cols * slot + (cols - 1) * GAP;
  const contentW = Math.max(rowW + 2 * GAP, aw);
  const rects = [];
  let y = GAP;
  for (let i = 0; i < sizes.length; i += cols) {
    let x = (contentW - rowW) / 2;
    let h = 0;
    for (const [w0, h0] of sizes.slice(i, i + cols)) {
      const w = saneDim(w0, 1e5), ph = saneDim(h0, 1e6);
      // Pages narrower than the widest keep their markup area beside them.
      const px = x + Math.max(maxw - markup - w, 0) * scale / 2;
      rects.push({x: px, y, w: w * scale, h: ph * scale});
      h = Math.max(h, ph * scale);
      x += slot + GAP;
    }
    y += h + GAP;
  }
  return {rects, size: {w: contentW, h: Math.max(y, ah)}};
}

/**
 * The page geometry for a layout's pages (geometry): `view` is the document's view state
 * ({zoom: percent, fit, multiPage, singleColumn}), `avail` the scroll area's size in px.
 * Returns {rects, size, scale, cols}.
 */
export function geometry(pages, view, avail, markup = 0) {
  const maxw = Math.max(72, ...pages.map(p => saneDim(p.w, 1e5))) + markup;
  const maxh = Math.max(72, ...pages.map(p => saneDim(p.h, 20_000)));
  const mode = view?.mode ?? 'print';
  // Read Mode: the reading columns in one row at the reading text size (U:quill/view).
  if (view?.readMode) {
    const scale = clamp(finite(view?.readZoom, 1), 0.75, 1.5) * PX_PER_PT;
    const {rects, size} = placeReadPages(pages.map(p => [p.w, p.h]), scale, avail);
    return {rects, size, scale, cols: Math.max(pages.length, 1)};
  }
  const zoom = clamp(finite((view?.zoom ?? 100) / 100, 1), 0.1, 5);
  let scale = zoom * PX_PER_PT;
  // Immersive Reader: one column, centred, at the reading text size.
  if (view?.immersive) scale = clamp(finite(view?.readZoom, 1), 0.75, 1.5) * PX_PER_PT;
  const web = mode !== 'print' || !!view?.immersive;
  const fit = web ? '' : view?.fit ?? '';
  if (fit === 'pageWidth') scale = clamp((avail.w - 2 * GAP - 20) / maxw, 0.1, 6);
  else if (fit === 'onePage') scale = clamp(Math.min((avail.h - 2 * GAP) / maxh, (avail.w - 2 * GAP) / maxw), 0.05, 6);
  else if (fit === 'multiplePages') scale = clamp(Math.min((avail.h - 2 * GAP) / maxh, (avail.w - 3 * GAP) / (2 * maxw)), 0.05, 6);
  // Text width (Word): the text column, not the page, as wide as the window (the margins scroll off).
  else if (fit === 'textWidth') scale = clamp((avail.w - 2 * GAP - 20) / Math.max(36, ...pages.map(p => saneDim(p.body?.w ?? p.w, 1e5))), 0.1, 6);
  if (!Number.isFinite(scale)) scale = PX_PER_PT;
  // Web Layout: the sheet runs from side to side of the work area, no centred page with grey margins.
  if (mode === 'web' && !view?.immersive) {
    const rects = [];
    let y = 0;
    for (const p of pages) { const r = {x: 0, y, w: saneDim(p.w, 1e5) * scale, h: saneDim(p.h, 1e6) * scale}; rects.push(r); y += r.h; }
    return {rects, size: {w: Math.max(avail.w, ...rects.map(r => r.x + r.w)), h: Math.max(y, avail.h)}, scale, cols: 1};
  }
  // Side to Side (Page Movement): every page in one row, turned like a book.
  if (!web && view?.pageMovement === 'sideToSide') {
    const {rects, size} = placePages(pages.map(p => [p.w, p.h]), markup, scale, Math.max(pages.length, 1), avail);
    return {rects, size, scale, cols: Math.max(pages.length, 1)};
  }
  // Pages flow side by side whenever more than one fits across; One Page and Page Width show one per row.
  const [minCols, auto] = web || fit === 'onePage' || fit === 'pageWidth' || fit === 'textWidth' || view?.singleColumn ? [1, false]
    : view?.multiPage || fit === 'multiplePages' ? [2, true] : [1, true];
  const cols = columnsFor(avail.w, maxw * scale, pages.length, minCols, auto);
  const placed = placePages(pages.map(p => [p.w, p.h]), markup, scale, cols, avail);
  if (view?.hideWhiteSpace && !web && cols === 1 && pages.length > 1) return {...collapseWhiteSpace(placed.rects, pages, scale, avail), scale, cols};
  return {rects: placed.rects, size: placed.size, scale, cols};
}

/** Gap between two pages whose white space is hidden (px). */
export const HIDDEN_GAP = 3;

/**
 * View › Hide White Space: pages in a column lose the bottom margin (with its footer) and the next page's top margin
 * (with its header) where they meet; the first page keeps its top margin and the last its bottom one. A rect keeps its
 * page origin (page points still map by `rect.y`) and says how many px are cut off its top (`ct`) and bottom (`cb`).
 */
export function collapseWhiteSpace(rects, pages, scale, avail) {
  const out = [];
  let y = GAP;
  const n = rects.length;
  rects.forEach((r, i) => {
    const pg = pages[i];
    const s = pageScale(r, pg, scale);
    const body = pg.body ?? {y: 0, h: pg.h};
    const ct = i === 0 ? 0 : clamp(finite(body.y, 0) * s, 0, r.h * 0.45);
    const cb = i === n - 1 ? 0 : clamp((saneDim(pg.h, 1e6) - finite(body.y, 0) - finite(body.h, pg.h)) * s, 0, r.h * 0.45);
    out.push({...r, y: y - ct, ct, cb});
    y += r.h - ct - cb + HIDDEN_GAP;
  });
  const end = out.length ? y - HIDDEN_GAP + GAP : GAP;
  return {rects: out, size: {w: Math.max(avail.w, ...out.map(r => r.x + r.w + GAP)), h: Math.max(end, avail.h)}};
}

// ---- Read Mode and Web Layout (canvas/reading.rs) -------------------------------------------

/** Height kept free under Read Mode's columns for the page-turn bar (READ_NAV_BAR, px). */
export const READ_NAV_BAR = 44;

/** Web Layout's text width in points for a work area `availPx` wide at `scale` (web_layout_width). */
export function webLayoutWidth(availPx, scale) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : PX_PER_PT;
  const w = availPx / s;
  return Number.isFinite(w) ? clamp(w, 144, 20_000) : 800;
}

/**
 * Reading columns (reading_size): readable text at the chosen size; the window holds roughly 3–5
 * columns (Auto) or the chosen width; the columns end above the page-turn bar. Returns [w, h] points.
 */
export function readingSize(avail, scale, requested) {
  const width = Number.isFinite(avail.w) ? Math.max(avail.w, 0) : 0;
  const height = Number.isFinite(avail.h) ? Math.max(avail.h, 0) : 0;
  let px;
  if (Number.isFinite(requested)) px = Math.min(clamp(requested, 144, 612) * scale, Math.max(width - 2 * GAP, 144));
  else {
    const count = clamp(Math.round(width / 295), 1, 5);
    px = Math.max((width - (count + 1) * GAP) / count, 192);
  }
  return [px / scale, Math.max(height - GAP - READ_NAV_BAR, 192) / scale];
}

/** A single horizontal row of reflowed reading pages (place_read_pages); extra room lets the last column sit at the left. */
export function placeReadPages(sizes, scale, avail) {
  let x = GAP;
  const rects = [];
  for (const [w0, h0] of sizes) {
    const w = saneDim(w0, 20_000) * scale, h = saneDim(h0, 20_000) * scale;
    rects.push({x, y: GAP, w, h});
    x += w + GAP;
  }
  const end = rects.length ? rects[rects.length - 1].x + avail.w - GAP : avail.w;
  return {rects, size: {w: Math.max(x, end, avail.w), h: Math.max(avail.h, 0)}};
}

/** How far one reading column turn moves (turn_read_page): a column and its gap, px. */
export const readStep = (rects) => (rects.length > 1 ? rects[1].x - rects[0].x : (rects[0]?.w ?? 0) + GAP);

/** The scale a page is drawn at (page_screen_scale): its rect's width over its width in points. */
export function pageScale(rect, page, fallback) {
  const s = rect.w / Math.max(saneDim(page.w, 1e5), 1);
  return Number.isFinite(s) && s > 0 ? s : fallback;
}

/** The page whose rect is under (or nearest to) a point (nearest_page). */
export function nearestPage(rects, x, y) {
  let best = -1, bd = Infinity;
  rects.forEach((r, i) => {
    let d;
    // With white space hidden a page shows only its band (ct and cb px are cut off the top and bottom).
    const top = r.y + (r.ct ?? 0), bottom = r.y + r.h - (r.cb ?? 0);
    if (x >= r.x && x <= r.x + r.w && y >= top && y <= bottom) d = 1e-3 * Math.abs(y - (top + bottom) / 2) / Math.max(bottom - top, 1);
    else {
      const dx = Math.max(r.x - x, x - (r.x + r.w), 0);
      const dy = Math.max(top - y, y - bottom, 0);
      d = dx + dy * 2;
    }
    if (d < bd) { bd = d; best = i; }
  });
  return best < 0 ? null : best;
}

/** Page index and page coordinates (points) under a content point (page_at). */
export function pageAt(rects, pages, scale, x, y) {
  const i = nearestPage(rects, x, y);
  if (i === null) return null;
  const r = rects[i];
  const s = pages[i] ? pageScale(r, pages[i], scale) : scale;
  return {page: i, x: (x - r.x) / s, y: (y - r.y) / s};
}

/** The page at the top of a window scrolled to `y` (top_page). */
export function topPage(rects, y) {
  const i = rects.findIndex(r => r.y + r.h - (r.cb ?? 0) > y);
  return i < 0 ? Math.max(rects.length - 1, 0) : i;
}

/** The page being looked at (viewed_page): the caret's page while it is in the window, else the top page. */
export function viewedPage(caret, rects, top, height) {
  if (caret && caret.bottom >= top && caret.top <= top + height) return caret.page;
  return topPage(rects, top);
}

/** True when a point is on the space between two pages (on_page_gap; Word's double-click there). */
export function onPageGap(rects, x, y) {
  for (let i = 0; i + 1 < rects.length; i++) {
    const a = rects[i], b = rects[i + 1];
    const inX = x >= Math.min(a.x, b.x) && x <= Math.max(a.x + a.w, b.x + b.w);
    if (inX && y >= a.y + a.h - (a.cb ?? 0) && y <= b.y + (b.ct ?? 0)) return true;
  }
  return false;
}

/** Pages (indexes) whose rect meets the band top..top+height, widened by `margin` px each way. */
export function visiblePages(rects, top, height, margin = 0) {
  const out = [];
  const lo = top - margin, hi = top + height + margin;
  rects.forEach((r, i) => { if (r.y + r.h - (r.cb ?? 0) >= lo && r.y + (r.ct ?? 0) <= hi) out.push(i); });
  return out;
}

/** The tile strips of a page rect (content px) that meet the band lo..hi: [[index, top, height]]. */
export function visibleTiles(rect, lo, hi, tile = TILE_HEIGHT_PX) {
  const out = [];
  const n = Math.max(1, Math.ceil(rect.h / tile));
  for (let k = 0; k < n; k++) {
    const t = rect.y + k * tile, b = Math.min(rect.y + rect.h, t + tile);
    if (b >= lo && t <= hi) out.push([k, k * tile, b - t]);
  }
  return out;
}

/**
 * Clicks in a row for a press at (x, y) at time `now` (ms) after `last` = {time, x, y, n}: within
 * the double-click delay and distance it counts up to 3 (a triple-click), else 1 (press_count).
 */
export function pressCount(last, now, x, y, delay = 500, dist = 6) {
  if (last && now - last.time >= 0 && now - last.time < delay && Math.hypot(last.x - x, last.y - y) <= dist) return Math.min(last.n + 1, 3);
  return 1;
}

/** Drag-select auto-scroll margin and speeds (input.rs EDGE_MARGIN, EDGE_SPEED_MIN/MAX, EDGE_MAX_DT). */
export const EDGE_MARGIN = 32, EDGE_SPEED_MIN = 45, EDGE_SPEED_MAX = 720, EDGE_MAX_DT = 0.1;

/**
 * The drag auto-scroll along one axis for a pointer at `p` inside lo..hi over `dt` seconds
 * (edge_scroll): positive moves the view toward the document's start.
 */
export function edgeScroll(p, lo, hi, dt) {
  if (![p, lo, hi, dt].every(Number.isFinite) || hi <= lo) return 0;
  dt = clamp(dt, 0, EDGE_MAX_DT);
  const speed = into => EDGE_SPEED_MIN + (EDGE_SPEED_MAX - EDGE_SPEED_MIN) * clamp(into / EDGE_MARGIN, 0, 1);
  if (p < lo + EDGE_MARGIN) return speed(lo + EDGE_MARGIN - p) * dt;
  if (p > hi - EDGE_MARGIN) return -speed(p - (hi - EDGE_MARGIN)) * dt;
  return 0;
}

// ---- Rulers (rulers.rs) -------------------------------------------------------------------

export const UNIT_TICK = 7;
export const RULER_LABEL_PX = 30;
const RULER_TICK_PX = 4;
export const RULER_SPARSEST = 1 << 20;
export const RULER_MAX_MARKS = 2000;
const PT_PER_CM = 72 / 2.54;

/**
 * A ruler's graduation for a unit (ruler_scale): [points per numbered step, divisions, count per step].
 * @param {string} unit
 * @returns {[number, number, number]}
 */
export function rulerScale(unit) {
  switch (unit) {
    case 'cm': case 'centimeters': return [PT_PER_CM, 4, 1];
    case 'mm': case 'millimeters': return [PT_PER_CM, 4, 10];
    case 'pt': case 'points': return [72, 8, 72];
    case 'pi': case 'picas': return [72, 8, 6];
    default: return [72, 8, 1];
  }
}

/** How a ruler thins out as the page shrinks on screen (ruler_density). */
export function rulerDensity(pxPerUnit, div) {
  const px = Number.isFinite(pxPerUnit) ? Math.max(pxPerUnit, 0) : 0;
  const every = (v, room) => { let n = 1; while (v * n < room && n < RULER_SPARSEST) n *= 2; return n; };
  return {labelEvery: every(px, RULER_LABEL_PX), tickEvery: every(px / Math.max(div, 1), RULER_TICK_PX)};
}

/**
 * The marks of a ruler with their distance from the page's start edge (ruler_marks): ticks from
 * the page edge to `width` on the grid of the start margin `origin`, numbered in whole units across
 * the `text` area. Each mark is [d, {label: n} | {tick: len}].
 */
export function rulerMarks(origin, text, width, [unit, div, step], scale) {
  div = Math.max(div, 2);
  const marks = [];
  if (![unit, origin, text, width, scale].every(Number.isFinite) || unit <= 0) return marks;
  const density = rulerDensity(scale * unit, div);
  const perLabel = div * density.labelEvery;
  const edge = -(clamp(Math.ceil(origin / unit), -1e6, 1e6) * div);
  const floorDiv = (a, b) => Math.floor(a / b);
  let k = floorDiv(edge, density.tickEvery) * density.tickEvery;
  const mod = (a, b) => ((a % b) + b) % b;
  for (let i = 0; i < RULER_MAX_MARKS; i++) {
    const d = origin + k * unit / div;
    if (d > width + 1e-3) break;
    if (d >= -1e-3 && k !== 0) {
      const inText = k > 0 && d <= origin + text + 1e-3;
      let mark;
      if (mod(k, perLabel) === 0 && inText) mark = {label: Math.trunc(k / div) * step};
      else if (mod(k, div) === 0) mark = {tick: UNIT_TICK};
      else if (mod(k, div / 2) === 0) mark = {tick: 5};
      else if (div >= 8 && mod(k, div / 4) === 0) mark = {tick: 3};
      else mark = {tick: 1.5};
      marks.push([d, mark]);
    }
    k += density.tickEvery;
  }
  return marks;
}

/** Screen x of a point `d` points from the page's start edge (ruler_x); RTL mirrors. */
export const rulerX = (d, x0, scale, pageW, rtl) => (rtl ? x0 + (pageW - d) * scale : x0 + d * scale);
/** The inverse of rulerX (ruler_d). */
export const rulerD = (x, x0, scale, pageW, rtl) => (rtl ? pageW - (x - x0) / scale : (x - x0) / scale);
