// Scan & OCR > Enhance > Camera image: straighten a photographed document and clean it up. Pure pixel maths: the four corners are
// warped to a rectangle (a perspective transform), then given a look (original, colour, greyscale, black and white) at a clean-up level.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/geom/src/perspective.rs    Homography (from_points, apply), order_quad
//   crates/engine/src/camera.rs       warp (a premultiplied RGBA raster, the quadrilateral to an upright rectangle over white)
//   crates/engine/src/camera_clean.rs Look, apply, clean (background flattening, level stretch, despeckle), despeckle
// Not translated (docs/spec/patches/folio/tools.json): finding the document's edges by itself (camera_edges.rs): the corners start inset
// on the page, as upstream's do when the edges cannot be found. No DOM, no Node built-ins.

export const MAX_LEVEL = 100;
/** camera.rs MAX_PIXELS: the most pixels the straightened picture has. */
export const MAX_PIXELS = 40_000_000;
/** camera_ui.rs INSET: how far in from the page's edges the corners start, as a share of its size. */
export const INSET = 0.05;
/** camera_ui.rs DEFAULT_LEVEL: the clean-up level a page is enhanced at before the slider is touched. */
export const DEFAULT_LEVEL = 50;
export const LOOKS = ['original', 'colour', 'greyscale', 'bw'];
export const LOOK_LABELS = {original: 'Original', colour: 'Color', greyscale: 'Grayscale', bw: 'Black and white'};

const finite = v => Number.isFinite(v);

/** The 3x3 projective transform taking each of `from` to the `to` of the same index; null for collinear or non-finite points. */
export function homography(from, to) {
  if ([...from, ...to].some(p => !p.every(finite))) return null;
  const m = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    m.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const h = solve8(m);
  if (!h) return null;
  const out = [...h, 1];
  const ok = from.every((p, i) => {
    const r = applyH(out, p), q = to[i];
    const scale = 1 + Math.max(Math.abs(q[0]), Math.abs(q[1]));
    return r && Math.abs(r[0] - q[0]) <= 1e-6 * scale && Math.abs(r[1] - q[1]) <= 1e-6 * scale;
  });
  return ok ? out : null;
}

/** The image of `p` under `h`, or null where it goes to infinity. */
export function applyH(h, [x, y]) {
  const w = h[6] * x + h[7] * y + h[8];
  if (!finite(w) || Math.abs(w) < 1e-12) return null;
  const u = (h[0] * x + h[1] * y + h[2]) / w, v = (h[3] * x + h[4] * y + h[5]) / w;
  return finite(u) && finite(v) ? [u, v] : null;
}

/** Gaussian elimination with partial pivoting on an 8x8 system (the ninth column is the right-hand side). */
function solve8(m) {
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const p = m[col];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = m[r][col] / p[col];
      if (f !== 0) for (let k = 0; k < 9; k++) m[r][k] -= f * p[k];
    }
  }
  const out = [];
  for (let i = 0; i < 8; i++) { const v = m[i][8] / m[i][i]; if (!finite(v)) return null; out.push(v); }
  return out;
}

/** The corners in reading order for a y-down space: top-left, top-right, bottom-right, bottom-left; null unless they form a convex quadrilateral. */
export function orderQuad(points) {
  if (points.length !== 4 || points.some(p => !p.every(finite))) return null;
  const cx = points.reduce((a, p) => a + p[0], 0) / 4, cy = points.reduce((a, p) => a + p[1], 0) / 4;
  const q = [...points].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let first = 0;
  for (let i = 1; i < 4; i++) if (q[i][0] + q[i][1] < q[first][0] + q[first][1]) first = i;
  const r = [...q.slice(first), ...q.slice(0, first)];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const turns = r.map((_, i) => cross(r[i], r[(i + 1) % 4], r[(i + 2) % 4]));
  const area = turns.reduce((a, t) => a + t, 0) / 2;
  const xs = r.map(p => p[0]), ys = r.map(p => p[1]);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const convex = turns.every(t => t > 1e-9 * size * size);
  return convex && area > 1e-6 * size * size ? r : null;
}

/**
 * Warp the quadrilateral `quad` (raster pixels, any corner order) of a premultiplied RGBA raster to an upright rectangle as large as the
 * quadrilateral's longer sides, composited over white. Throws an Error saying what was wrong with the corners or the raster.
 * @returns {{width: number, height: number, rgb: Uint8Array}}
 */
export function warp(rgba, width, height, quad) {
  const w = width, h = height;
  if (!(w > 0 && h > 0) || w * h * 4 !== rgba.length) throw new Error('the page could not be read as a picture');
  const ordered = orderQuad(quad);
  if (!ordered) throw new Error('the four corners must enclose an area (a convex quadrilateral)');
  const [tl, tr, br, bl] = ordered;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let ow = Math.max(dist(tl, tr), dist(bl, br)), oh = Math.max(dist(tl, bl), dist(tr, br));
  const k = Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(ow * oh, 1)));
  ow = Math.max(1, Math.floor(ow * k)); oh = Math.max(1, Math.floor(oh * k));
  if (!finite(ow) || !finite(oh)) throw new Error('the corners are out of range');
  const toSrc = homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], [tl, tr, br, bl]);
  if (!toSrc) throw new Error('the four corners must not be in a line');
  const rgb = new Uint8Array(ow * oh * 3);
  const px = (x, y, c) => rgba[(y * w + x) * 4 + c];
  const clamp = (v, n) => Math.min(Math.max(v, 0), n - 1);
  let o = 0;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      // Sampled at the pixel's centre; outside the page is white.
      const c = [0, 0, 0, 0];
      const s = applyH(toSrc, [x + 0.5, y + 0.5]);
      if (s) {
        const fx = s[0] - 0.5, fy = s[1] - 0.5;
        if (fx > -1 && fy > -1 && fx < w && fy < h) {
          const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
          const xa = clamp(x0, w), xb = clamp(x0 + 1, w), ya = clamp(y0, h), yb = clamp(y0 + 1, h);
          for (let i = 0; i < 4; i++) {
            const top = px(xa, ya, i) * (1 - ax) + px(xb, ya, i) * ax;
            const bottom = px(xa, yb, i) * (1 - ax) + px(xb, yb, i) * ax;
            c[i] = top * (1 - ay) + bottom * ay;
          }
        }
      }
      // Premultiplied over white: colour + (1 - alpha) x white.
      for (let i = 0; i < 3; i++) rgb[o++] = Math.min(255, Math.max(0, Math.round(c[i] + 255 - c[3])));
    }
  }
  return {width: ow, height: oh, rgb};
}

// ---------------------------------------------------------------------------------------------
// Clean-up (camera_clean.rs)

const lum = (r, g, b) => Math.floor((r * 299 + g * 587 + b * 114) / 1000);

/**
 * Give a straightened photo a look at a level: 'original' as photographed, 'colour' and 'greyscale' cleaned at `level` (0 = as photographed to
 * 100 = white paper, strong contrast, no specks), 'bw' thresholded (the level is the threshold).
 * @returns {{kind: 'rgb'|'grey', data: Uint8Array}|null}
 */
export function applyLook(rgb, width, height, look, level) {
  const w = width, h = height;
  if (!(w > 0 && h > 0) || w * h * 3 !== rgb.length) return null;
  if (look === 'original') return {kind: 'rgb', data: Uint8Array.from(rgb)};
  if (look === 'colour') return {kind: 'rgb', data: clean(rgb, w, h, level)};
  if (look === 'greyscale') {
    const c = clean(rgb, w, h, level);
    const grey = new Uint8Array(w * h);
    for (let i = 0; i < grey.length; i++) grey[i] = lum(c[i * 3], c[i * 3 + 1], c[i * 3 + 2]);
    return {kind: 'grey', data: grey};
  }
  if (look === 'bw') {
    const even = clean(rgb, w, h, 50);
    const t = 0.45 + 0.4 * Math.min(level, MAX_LEVEL) / MAX_LEVEL;
    const grey = new Uint8Array(w * h);
    for (let i = 0; i < grey.length; i++) grey[i] = lum(even[i * 3], even[i * 3 + 1], even[i * 3 + 2]) / 255 < t ? 0 : 255;
    despeckleGrey(grey, w, h);
    return {kind: 'grey', data: grey};
  }
  return null;
}

/** Even out the light and lift the paper to white, stretching the ink to black as the level grows. */
export function clean(rgb, w, h, level) {
  level = Math.min(Math.max(0, level | 0), MAX_LEVEL);
  if (level === 0) return Uint8Array.from(rgb);
  const k = level / MAX_LEVEL;
  const bg = background(rgb, w, h);
  const flatten = Math.min(2 * k, 1), white = 1 - 0.12 * k, black = 0.30 * k;
  const out = new Uint8Array(rgb.length);
  const cell = [0, 0, 0];
  for (let i = 0; i < w * h; i++) {
    bg.at(i % w, Math.floor(i / w), cell);
    for (let c = 0; c < 3; c++) {
      const v = rgb[i * 3 + c] / 255;
      const b = Math.max(cell[c], 0.05);
      const even = Math.min(v / b, 1);
      const flat = v + (even - v) * flatten;
      const stretched = Math.min(1, Math.max(0, (flat - black) / Math.max(white - black, 0.05)));
      out[i * 3 + c] = Math.round(stretched * 255);
    }
  }
  if (level >= 60) despeckle(out, w, h);
  return out;
}

/** The paper's colour over the page: a coarse grid of the 90th-percentile of each block, lifted by its neighbours' paper and smoothed. */
function background(rgb, w, h) {
  const block = Math.min(Math.max(Math.floor(Math.min(w, h) / 16), 8), 128);
  const cols = Math.ceil(w / block), rows = Math.ceil(h / block);
  let cells = [];
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
      let n = 0;
      for (let y = by * block; y < Math.min((by + 1) * block, h); y++) {
        for (let x = bx * block; x < Math.min((bx + 1) * block, w); x++) {
          const i = (y * w + x) * 3;
          hist[0][rgb[i]]++; hist[1][rgb[i + 1]]++; hist[2][rgb[i + 2]]++;
          n++;
        }
      }
      const want = Math.floor(n * 0.9);
      cells.push([0, 1, 2].map(c => {
        let seen = 0;
        for (let v = 0; v < 256; v++) { seen += hist[c][v]; if (seen > want) return v / 255; }
        return 1;
      }));
    }
  }
  const get = (arr, x, y) => arr[Math.min(Math.max(y, 0), rows - 1) * cols + Math.min(Math.max(x, 0), cols - 1)];
  const lifted = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const own = get(cells, x, y);
      lifted.push([0, 1, 2].map(c => {
        const around = [];
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) around.push(get(cells, x + dx, y + dy)[c]);
        around.sort((a, b) => a - b);
        return Math.max(own[c], around[18] ?? 1);
      }));
    }
  }
  cells = lifted;
  for (let pass = 0; pass < 2; pass++) {
    const next = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const sum = [0, 0, 0];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = get(cells, x + dx, y + dy); for (let c = 0; c < 3; c++) sum[c] += v[c] / 9; }
        next.push(sum);
      }
    }
    cells = next;
  }
  return {
    at(x, y, out) {
      const fx = (x + 0.5) / block - 0.5, fy = (y + 0.5) / block - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
      const a = get(cells, x0, y0), b = get(cells, x0 + 1, y0), c = get(cells, x0, y0 + 1), d = get(cells, x0 + 1, y0 + 1);
      for (let i = 0; i < 3; i++) out[i] = (a[i] * (1 - ax) + b[i] * ax) * (1 - ay) + (c[i] * (1 - ax) + d[i] * ax) * ay;
    },
  };
}

function despeckleGrey(grey, w, h) {
  const rgb = new Uint8Array(grey.length * 3);
  for (let i = 0; i < grey.length; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = grey[i];
  despeckle(rgb, w, h);
  for (let i = 0; i < grey.length; i++) grey[i] = rgb[i * 3];
}

/** A dark pixel with at most one dark neighbour is a speck: it becomes white. */
function despeckle(rgb, w, h) {
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = lum(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) < 128 ? 1 : 0;
  const isDark = (x, y) => x >= 0 && y >= 0 && x < w && y < h && dark[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isDark(x, y)) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && isDark(x + dx, y + dy)) n++;
      if (n <= 1) { const i = (y * w + x) * 3; rgb[i] = rgb[i + 1] = rgb[i + 2] = 255; }
    }
  }
}

/** camera_ui.rs CameraQuad::inset: a page of w x h view points inset by INSET on every side, as [tl, tr, br, bl]. */
export function insetCorners(w, h) {
  const dx = w * INSET, dy = h * INSET;
  return [[dx, dy], [w - dx, dy], [w - dx, h - dy], [dx, h - dy]];
}
