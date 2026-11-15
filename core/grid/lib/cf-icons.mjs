// The pictures of the conditional-format icon sets, drawn on a 16 x 16 box as paths, so the grid's canvas
// (Path2D) and the ribbon's tiles (SVG) draw the very same shapes.
// Translated from gridcraft crates/ui-egui/src/grid/cell_paint.rs (`paint_cf_icon`: arrows for the
// arrow sets, a filled circle for the rest, a part-filled disc for ratings and quarters), with Excel's
// shapes and colours for the sets (traffic lights, signs, symbols, flags, stars, boxes, ratings, quarters)
// at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

/** The icons in a set (`3Arrows` is 3, `5Quarters` 5): always 3 to 5. */
export function iconCount(set) {
  const n = Number(String(set ?? '')[0]);
  return Number.isInteger(n) ? Math.min(5, Math.max(3, n)) : 3;
}

const RED = '#D6453D', YELLOW = '#F5B82E', GREEN = '#2E9E4F', GRAY = '#7F7F7F', DARK = '#2B2B2B', PINK = '#F2A3A0', BLUE = '#2B7CD3';

const f = n => Math.round(n * 100) / 100;
const poly = pts => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
const rotate = (pts, deg) => {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return pts.map(([x, y]) => [8 + (x - 8) * c - (y - 8) * s, 8 + (x - 8) * s + (y - 8) * c]);
};
const ARROW = [[8, 1], [14.5, 8.5], [10, 8.5], [10, 15], [6, 15], [6, 8.5], [1.5, 8.5]];
/** An arrow pointing `deg` degrees clockwise from up. */
const arrow = (deg, fill) => ({d: poly(rotate(ARROW, deg)), fill});
const disc = (fill, rim = false) => ({d: 'M8 1.2a6.8 6.8 0 1 0 0.001 0Z', fill, ...(rim ? {stroke: DARK, sw: 1} : {})});
const glyph = (d, sw = 1.7) => ({d, stroke: '#fff', sw, fill: 'none'});
const CHECK = 'M4.8 8.3L7 10.5L11.3 5.7', BANG = 'M8 4.6V8.8M8 11.1V11.4', CROSS = 'M5.2 5.2L10.8 10.8M10.8 5.2L5.2 10.8';
const star = (fill, stroke) => {
  const pts = [];
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 3.1 : 7.4, a = -Math.PI / 2 + i * Math.PI / 5; pts.push([8 + r * Math.cos(a), 8.4 + r * Math.sin(a)]); }
  return {d: poly(pts), fill, ...(stroke ? {stroke, sw: 1} : {})};
};
const halfStar = () => {
  const pts = [];
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 3.1 : 7.4, a = -Math.PI / 2 + i * Math.PI / 5; pts.push([8 + r * Math.cos(a), 8.4 + r * Math.sin(a)]); }
  return [star('#fff', GRAY), {d: poly([0, 9, 8, 7, 6, 5].map(i => pts[i])), fill: YELLOW}];
};
const flag = fill => ({d: 'M3.5 15V1.5M3.5 2.2H13L10.4 5.4L13 8.6H3.5', fill, stroke: fill, sw: 1.4});
/** A part-filled disc: `quarters` of four, as in Excel's Quarters and Ratings. */
const pie = quarters => {
  const parts = [{d: 'M8 1.2a6.8 6.8 0 1 0 0.001 0Z', fill: '#fff', stroke: GRAY, sw: 1}];
  if (quarters >= 4) parts.push({d: 'M8 1.2a6.8 6.8 0 1 0 0.001 0Z', fill: DARK});
  else if (quarters > 0) {
    const end = -Math.PI / 2 + quarters * Math.PI / 2;
    const x = 8 + 6.8 * Math.cos(end), y = 8 + 6.8 * Math.sin(end);
    parts.push({d: `M8 8L8 1.2A6.8 6.8 0 ${quarters > 2 ? 1 : 0} 1 ${f(x)} ${f(y)}Z`, fill: DARK});
  }
  return parts;
};
const bars = (total, filled) => Array.from({length: total}, (_, i) => {
  const w = 2.4, gap = (16 - total * w) / (total + 1), x = gap + i * (w + gap), h = 4 + i * (10 / Math.max(total - 1, 1));
  return {d: `M${f(x)} ${f(15 - h)}H${f(x + w)}V15H${f(x)}Z`, fill: i < filled ? DARK : '#fff', stroke: i < filled ? DARK : GRAY, sw: 0.8};
});
const box = quarters => {
  const parts = [{d: 'M2 2H14V14H2Z', fill: '#fff', stroke: GRAY, sw: 1}];
  const q = ['M8 2H14V8H8Z', 'M8 8H14V14H8Z', 'M2 8H8V14H2Z', 'M2 2H8V8H2Z'];
  for (let i = 0; i < quarters; i++) parts.push({d: q[i], fill: BLUE});
  return parts;
};

/** The shapes of one icon of a set (`index` 0 is the lowest), each {d, fill, stroke?, sw?} on a 16 x 16 box. */
export function iconShapes(set, index) {
  const k = iconCount(set), i = Math.min(Math.max(index, 0), k - 1);
  const s = String(set);
  const tri = [GREEN, YELLOW, RED];
  switch (s) {
    case '3Arrows': return [[arrow(180, RED)], [arrow(90, YELLOW)], [arrow(0, GREEN)]][i];
    case '3ArrowsGray': return [[arrow(180, GRAY)], [arrow(90, GRAY)], [arrow(0, GRAY)]][i];
    case '4Arrows': return [[arrow(180, RED)], [arrow(135, YELLOW)], [arrow(45, YELLOW)], [arrow(0, GREEN)]][i];
    case '4ArrowsGray': return [[arrow(180, GRAY)], [arrow(135, GRAY)], [arrow(45, GRAY)], [arrow(0, GRAY)]][i];
    case '5Arrows': return [[arrow(180, RED)], [arrow(135, YELLOW)], [arrow(90, YELLOW)], [arrow(45, YELLOW)], [arrow(0, GREEN)]][i];
    case '5ArrowsGray': return [[arrow(180, GRAY)], [arrow(135, GRAY)], [arrow(90, GRAY)], [arrow(45, GRAY)], [arrow(0, GRAY)]][i];
    case '3Triangles': return [[{d: 'M8 14.5L14.5 2.5H1.5Z', fill: RED}], [{d: 'M2 6.5H14V9.5H2Z', fill: YELLOW}], [{d: 'M8 1.5L14.5 13.5H1.5Z', fill: GREEN}]][i];
    case '3TrafficLights1': return [[disc(RED)], [disc(YELLOW)], [disc(GREEN)]][i];
    case '3TrafficLights2': return [[disc(RED, true)], [disc(YELLOW, true)], [disc(GREEN, true)]][i];
    case '4TrafficLights': return [[disc(DARK)], [disc(RED)], [disc(YELLOW)], [disc(GREEN)]][i];
    case '4RedToBlack': return [[disc(DARK)], [disc(GRAY)], [disc(PINK)], [disc(RED)]][i];
    case '3Signs': return [[{d: 'M8 1L15 8L8 15L1 8Z', fill: RED}], [{d: 'M8 1.5L15 14H1Z', fill: YELLOW}], [disc(GREEN)]][i];
    case '3Symbols': return [[disc(RED), glyph(CROSS)], [disc(YELLOW), glyph(BANG)], [disc(GREEN), glyph(CHECK)]][i];
    case '3Symbols2': return [[{d: CROSS, stroke: RED, sw: 2.6, fill: 'none'}], [{d: 'M8 3V9.5M8 12V12.4', stroke: YELLOW, sw: 2.6, fill: 'none'}], [{d: 'M3.2 8.4L6.6 11.8L12.8 4.4', stroke: GREEN, sw: 2.6, fill: 'none'}]][i];
    case '3Flags': return [[flag(RED)], [flag(YELLOW)], [flag(GREEN)]][i];
    case '3Stars': return [[star('#fff', GRAY)], halfStar(), [star(YELLOW, '#C99A10')]][i];
    case '5Boxes': return [box(0), box(1), box(2), box(3), box(4)][i];
    case '4Rating': return bars(4, i + 1);
    case '5Rating': return bars(4, i);
    case '5Quarters': return pie(i);
    default: return [disc(tri[2 - Math.min(i, 2)] ?? GRAY)];
  }
}

/** The shapes of a whole set, lowest first (the ribbon draws a row of them). */
export const iconRow = set => Array.from({length: iconCount(set)}, (_, i) => iconShapes(set, i));
