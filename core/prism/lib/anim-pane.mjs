// Animation Pane advanced timeline: the ruler, the scale and the drag-to-retime maths.
// Translated from deckcraft crates/ui-egui/src/panels/animtimeline.rs (`ruler_seconds`,
// `pixels_per_second`, `dragged_delay`, `dragged_duration`, `label`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Pure functions: the layout and the drag results are tested without a frame. No DOM.

/** Drags snap to this step (milliseconds), like PowerPoint's 0.05 s granularity. */
export const SNAP_MS = 50;
/** Shortest duration a drag can produce (milliseconds). */
export const MIN_DURATION_MS = 50;
/** Upper bound for delay and duration, matching `animation.timing`'s clamp. */
export const MAX_MS = 600_000;
const MIN_PPS = 8, MAX_PPS = 120;

/** Seconds the ruler must show: the longest bar end, at least one second, rounded up. `bars`: [{start, span}] (null: no bar). */
export function rulerSeconds(bars) {
  let end = 1;
  for (const b of bars) if (b) end = Math.max(end, b.start + b.span);
  const s = Math.min(Math.ceil(end), MAX_MS / 1000);
  return Number.isFinite(s) && s >= 1 ? s : 1;
}
/** Pixels per second so `seconds` fit in `width`. */
export function pixelsPerSecond(width, seconds) {
  const secs = Math.max(seconds, 1);
  const pps = Number.isFinite(width) ? width / secs : MIN_PPS;
  return Math.min(Math.max(pps, MIN_PPS), MAX_PPS);
}
function snap(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  const snapped = Math.round(ms / SNAP_MS) * SNAP_MS;
  return snapped >= MAX_MS ? MAX_MS : snapped;
}
const deltaMs = (dx, pps) => (!Number.isFinite(dx) || !Number.isFinite(pps) || pps <= 0 ? 0 : (dx / pps) * 1000);
/** New delay after dragging a bar's body `dx` pixels. */
export const draggedDelay = (delayMs, dx, pps) => snap(delayMs + deltaMs(dx, pps));
/** New duration after dragging a bar's right edge `dx` pixels. The bar shows all repeats (auto-reverse doubles each), so the edge moves `factor` times as fast as one iteration. */
export function draggedDuration(durationMs, dx, pps, factor) {
  const f = Number.isFinite(factor) && factor >= 1 ? factor : 1;
  return Math.max(snap(durationMs + deltaMs(dx, pps) / f), MIN_DURATION_MS);
}
/** Tooltip text for a bar: `Start: 0.50s, End: 2.50s`. */
export const barLabel = bar => `Start: ${bar.start.toFixed(2)}s, End: ${(bar.start + bar.span).toFixed(2)}s`;
