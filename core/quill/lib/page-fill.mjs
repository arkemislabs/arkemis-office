// Design › Page Color › Fill Effects (U:quill/rest): a page background that is a gradient, a texture, a pattern or a picture, made as a bitmap and kept as the
// document's page picture (`settings.pagePicture` {media, fillType: 'frame' | 'tile', title}, saved as Word's w:background v:fill). Our own drawings of
// what Word's boxes offer; not checked against upstream. No DOM, no Node built-ins.

import {bitmap} from './picture-pixels.mjs';

/** The gradient styles of Word's Gradient tab, with the four variants of each (1 and 2 run one way and back, 3 and 4 there and back again). */
export const GRADIENT_STYLES = Object.freeze(['horizontal', 'vertical', 'diagonalUp', 'diagonalDown', 'fromCorner', 'fromCenter']);

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A gradient from `c1` to `c2` in `style` and `variant` (1 to 4), `w` x `h` pixels (it is stretched over the page). */
export function gradientBitmap(c1, c2, style = 'horizontal', variant = 1, w = 160, h = 208) {
  const b = bitmap(w, h);
  const along = (u, v) => {
    switch (style) {
      case 'vertical': return u;
      case 'diagonalUp': return (u + (1 - v)) / 2;
      case 'diagonalDown': return (u + v) / 2;
      case 'fromCorner': return Math.min(1, Math.hypot(u, v) / Math.SQRT2);
      case 'fromCenter': return Math.min(1, Math.hypot(u - 0.5, v - 0.5) * Math.SQRT2);
      default: return v;
    }
  };
  const [from, to] = variant === 2 || variant === 4 ? [c2, c1] : [c1, c2];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let t = along((x + 0.5) / w, (y + 0.5) / h);
      if (variant >= 3) t = t < 0.5 ? t * 2 : (1 - t) * 2;
      const c = mix(from, to, Math.max(0, Math.min(1, t)));
      b.data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  }
  return b;
}

/** Pattern fills: [id, label, covers(x, y) over an 8 x 8 tile]. */
export const PATTERNS = Object.freeze([
  ['percent5', '5%', (x, y) => x % 4 === 0 && y % 4 === 0],
  ['percent10', '10%', (x, y) => x % 4 === 0 && y % 2 === 0],
  ['percent25', '25%', (x, y) => (x + y) % 2 === 0 && x % 2 === 0],
  ['percent50', '50%', (x, y) => (x + y) % 2 === 0],
  ['percent75', '75%', (x, y) => (x + y) % 2 === 0 || x % 2 === 0],
  ['lightHorizontal', 'Light horizontal', (x, y) => y % 4 === 0],
  ['lightVertical', 'Light vertical', (x, y) => x % 4 === 0],
  ['darkHorizontal', 'Dark horizontal', (x, y) => y % 4 < 2],
  ['darkVertical', 'Dark vertical', (x, y) => x % 4 < 2],
  ['lightDownwardDiagonal', 'Light downward diagonal', (x, y) => (x + y) % 4 === 0],
  ['lightUpwardDiagonal', 'Light upward diagonal', (x, y) => (x - y + 8) % 4 === 0],
  ['smallCheckerBoard', 'Small checker board', (x, y) => (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0],
  ['largeCheckerBoard', 'Large checker board', (x, y) => (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0],
  ['smallGrid', 'Small grid', (x, y) => x % 4 === 0 || y % 4 === 0],
  ['dottedGrid', 'Dotted grid', (x, y) => (x % 4 === 0 && y % 2 === 0) || (y % 4 === 0 && x % 2 === 0)],
  ['trellis', 'Trellis', (x, y) => (x + y) % 4 < 2 && (x - y + 8) % 4 < 2],
].map(Object.freeze));

/** An 8 x 8 pattern tile in `fg` on `bg`, or null for an unknown id. */
export function patternBitmap(id, fg, bg) {
  const hit = PATTERNS.find(p => p[0] === id);
  if (!hit) return null;
  const b = bitmap(8, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) b.data.set([...(hit[2](x, y) ? fg : bg), 255], (y * 8 + x) * 4);
  return b;
}
