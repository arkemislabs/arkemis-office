// Picture Format › Adjust and Picture Styles on a bitmap: brightness, contrast, sharpen, soften, recolour,
// artistic effects, transparency, Remove Background, Compress Pictures, frames and shadows.
//
// Translated from wordcraft crates/engine/src/cmd/objects/picture.rs (`recolor`, `remove_background`,
// `clear_background`, `frame`, `picture_style`, `artistic_effect`, `blurred_span`, `gaussian_kernel`) and the
// `picture.*` closures of objects/specs.rs, with the `image` crate's brighten, contrast, blur, unsharpen and
// invert written out, at wordcraft aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// A bitmap is `{width, height, data: Uint8ClampedArray}` (RGBA, straight alpha, row by row). Every function
// returns a new bitmap and leaves its argument alone. Deviations: Compress Pictures resamples with a box
// filter (upstream: Lanczos3); unsharpen leaves alpha as it is. No DOM, no Node built-ins.

/** Most pixels a picture may have for an edit (upstream refuses what its decode budget cannot hold). */
export const MAX_PIXELS = 64_000_000;

export const bitmap = (width, height, fill = [0, 0, 0, 0]) => {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill.some(v => v)) for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return {width, height, data};
};
const copy = b => ({width: b.width, height: b.height, data: new Uint8ClampedArray(b.data)});

/** A bitmap too large to edit throws this (upstream `too_large`). */
export class TooLarge extends Error { constructor() { super('picture is too large to edit'); } }
const room = (w, h) => { if (!(w > 0 && h > 0) || w * h > MAX_PIXELS) throw new TooLarge(); };

/** image::imageops::colorops::brighten: `value` added to each colour channel. */
export function brighten(b, value) {
  const out = copy(b), d = out.data, v = Math.trunc(value);
  for (let i = 0; i < d.length; i += 4) { d[i] += v; d[i + 1] += v; d[i + 2] += v; }
  return out;
}

/** image::imageops::colorops::contrast: `percent` -100..100 (positive widens). */
export function contrast(b, percent) {
  const out = copy(b), d = out.data;
  const k = ((100 + percent) / 100) ** 2;
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = (((d[i + c] / 255 - 0.5) * k) + 0.5) * 255;
  return out;
}

/** The normalised kernel `image::imageops::blur` uses for `sigma`: odd, about 6.7 sigma wide (gaussian_kernel). */
export function gaussianKernel(sigma) {
  const size = Math.trunc(Math.max((((sigma - 0.8) / 0.3 + 1) * 2 + 1), 3)) | 1;
  const mean = Math.floor(size / 2);
  const w = Array.from({length: size}, (_, x) => Math.exp(-0.5 * ((x - mean) / sigma) ** 2));
  const total = w.reduce((a, v) => a + v, 0);
  return w.map(v => v / total);
}

/** A Gaussian blur (image::imageops::blur): separable, edges clamped. A sigma that is not positive changes nothing. */
export function blur(b, sigma) {
  if (!(sigma > 0.01) || !Number.isFinite(sigma)) return copy(b);
  const {width: w, height: h} = b, k = gaussianKernel(sigma), r = k.length >> 1;
  const tmp = new Float32Array(w * h * 4), out = copy(b);
  const src = b.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let j = 0; j < k.length; j++) acc += k[j] * src[(y * w + Math.min(w - 1, Math.max(0, x + j - r))) * 4 + c];
        tmp[(y * w + x) * 4 + c] = acc;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let j = 0; j < k.length; j++) acc += k[j] * tmp[(Math.min(h - 1, Math.max(0, y + j - r)) * w + x) * 4 + c];
        out.data[(y * w + x) * 4 + c] = acc;
      }
    }
  }
  return out;
}

/** image::imageops::unsharpen: where a channel differs from its blur by more than `threshold` it is pushed further. */
export function unsharpen(b, sigma, threshold) {
  const soft = blur(b, sigma), out = copy(b);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = b.data[i + c] - soft.data[i + c];
      if (Math.abs(diff) > threshold) out.data[i + c] = b.data[i + c] + diff;
    }
  }
  return out;
}

export function invert(b) {
  const out = copy(b);
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] = 255 - out.data[i]; out.data[i + 1] = 255 - out.data[i + 1]; out.data[i + 2] = 255 - out.data[i + 2]; }
  return out;
}

/** Nearest-neighbour resize (resize_exact with FilterType::Nearest). */
export function resizeNearest(b, w, h) {
  room(w, h);
  const out = bitmap(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(b.height - 1, Math.floor(((y + 0.5) * b.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(b.width - 1, Math.floor(((x + 0.5) * b.width) / w));
      const s = (sy * b.width + sx) * 4, o = (y * w + x) * 4;
      out.data[o] = b.data[s]; out.data[o + 1] = b.data[s + 1]; out.data[o + 2] = b.data[s + 2]; out.data[o + 3] = b.data[s + 3];
    }
  }
  return out;
}

/** A box-filter downscale to `w` × `h` (Compress Pictures; alpha-weighted so transparent pixels leave no halo). */
export function resizeBox(b, w, h) {
  room(w, h);
  const out = bitmap(w, h), sx = b.width / w, sy = b.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(b.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(b.width, Math.ceil((x + 1) * sx)));
      let r = 0, g = 0, bl = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * b.width + xx) * 4, al = b.data[i + 3];
          r += b.data[i] * al; g += b.data[i + 1] * al; bl += b.data[i + 2] * al; a += al; n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) { out.data[o] = r / a; out.data[o + 1] = g / a; out.data[o + 2] = bl / a; }
      out.data[o + 3] = a / n;
    }
  }
  return out;
}

/** Artistic Effects: one effect at a time (artistic_effect). `none` and unknown names change nothing. */
export function artisticEffect(b, effect) {
  switch (effect) {
    case 'blur': return blur(b, 3);
    case 'sharpen': return unsharpen(b, 2, 2);
    case 'invert': return invert(b);
    case 'posterize': {
      const out = copy(b);
      for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) out.data[i + c] = Math.floor(out.data[i + c] / 64) * 85;
      return out;
    }
    case 'pixelate': {
      const w = Math.max(b.width, 1), h = Math.max(b.height, 1);
      return resizeNearest(resizeNearest(b, Math.max(Math.floor(w / 12), 1), Math.max(Math.floor(h / 12), 1)), w, h);
    }
    default: return copy(b);
  }
}
export const ARTISTIC_EFFECTS = Object.freeze([['blur', 'Blur'], ['sharpen', 'Sharpen'], ['invert', 'Invert'], ['posterize', 'Posterize'], ['pixelate', 'Pixelate']].map(Object.freeze));

/** Picture Corrections: brightness and contrast -100..100 (percent), sharpen -100..100 (positive sharpens, negative softens). */
export function correct(b, {brightness = 0, contrast: c = 0, sharpen = 0}) {
  let img = b;
  if (brightness !== 0) img = brighten(img, Math.trunc(brightness * 2.55));
  if (c !== 0) img = contrast(img, c);
  if (sharpen > 0) img = unsharpen(img, 1 + sharpen / 50, 2);
  else if (sharpen < 0 && Number.isFinite(-sharpen / 25) && -sharpen / 25 > 1e-30) img = blur(img, -sharpen / 25);
  return img === b ? copy(b) : img;
}

/** Picture Color: grayscale, sepia, washout, black and white, a saturation (0..400 %) or the blue tint (recolor). */
export function recolor(b, mode, sat = 100) {
  const out = copy(b), d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], bl = d[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * bl;
    let o;
    switch (mode) {
      case 'grayscale': o = [l, l, l]; break;
      case 'sepia': o = [Math.min(0.393 * r + 0.769 * g + 0.189 * bl, 255), Math.min(0.349 * r + 0.686 * g + 0.168 * bl, 255), Math.min(0.272 * r + 0.534 * g + 0.131 * bl, 255)]; break;
      case 'washout': o = [r * 0.35 + 255 * 0.65, g * 0.35 + 255 * 0.65, bl * 0.35 + 255 * 0.65]; break;
      case 'blackAndWhite': { const v = l > 127 ? 255 : 0; o = [v, v, v]; break; }
      case 'tint': o = [l * 0.6 + 0.4 * 0x3b, l * 0.6 + 0.4 * 0x5b, l * 0.6 + 0.4 * 0xdb]; break;
      default: { const k = sat / 100; o = [l + (r - l) * k, l + (g - l) * k, l + (bl - l) * k]; }
    }
    d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2];
  }
  return out;
}

/** Icon Color: one colour everywhere, transparency kept. */
export function iconColor(b, [r, g, bl]) {
  const out = copy(b);
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = bl; }
  return out;
}

/** Transparency 0..100 %: alpha scaled, absolute from the bitmap it is given. */
export function transparency(b, percent) {
  const out = copy(b), t = Math.min(100, Math.max(0, percent));
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = Math.trunc(out.data[i] * (1 - t / 100));
  return out;
}

/** Remove Background: the border-connected region close to the corner colour becomes transparent (clear_background). */
export function removeBackground(b, tolerance = 30) {
  const out = copy(b), {width: w, height: h} = out, d = out.data;
  if (!w || !h) return out;
  const bg = [d[0], d[1], d[2], d[3]];
  const tol = Math.min(255, Math.max(0, tolerance));
  const close = i => Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2])) <= tol;
  const seen = new Uint8Array(w * h);
  const open = (x, y) => !seen[y * w + x] && close((y * w + x) * 4);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push([x, 0], [x, h - 1]); }
  for (let y = 0; y < h; y++) { stack.push([0, y], [w - 1, y]); }
  while (stack.length) {
    const [x, y] = stack.pop();
    if (!open(x, y)) continue;
    let x0 = x, x1 = x;
    while (x0 > 0 && open(x0 - 1, y)) x0--;
    while (x1 + 1 < w && open(x1 + 1, y)) x1++;
    for (let xi = x0; xi <= x1; xi++) { seen[y * w + xi] = 1; d[(y * w + xi) * 4 + 3] = 0; }
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      for (let xi = x0; xi <= x1;) {
        if (open(xi, ny)) { stack.push([xi, ny]); while (xi <= x1 && open(xi, ny)) xi++; } else xi++;
      }
    }
  }
  return out;
}

/** Compress Pictures: the longer side at most `maxPixels`. */
export function compress(b, maxPixels = 1600) {
  const m = Math.min(20000, Math.max(32, Math.trunc(maxPixels)));
  const side = Math.max(b.width, b.height);
  if (side <= m) return copy(b);
  const k = m / side;
  return resizeBox(b, Math.max(1, Math.round(b.width * k)), Math.max(1, Math.round(b.height * k)));
}

/** A bitmap grown by `pad` on every side and filled with `color`, the picture in the middle (frame). */
export function frame(b, pad, color) {
  const w = b.width + pad * 2, h = b.height + pad * 2;
  room(w, h);
  const out = bitmap(w, h, color);
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const s = (y * b.width + x) * 4, o = ((y + pad) * w + x + pad) * 4, a = b.data[s + 3] / 255;
      for (let c = 0; c < 3; c++) out.data[o + c] = b.data[s + c] * a + out.data[o + c] * (1 - a);
      out.data[o + 3] = Math.max(b.data[s + 3], out.data[o + 3]);
    }
  }
  return out;
}

/** How much of a span `len` long from `start` covers each of `n` positions once blurred (blurred_span): 0 to 1. */
export function blurredSpan(n, start, len, sigma) {
  const kernel = gaussianKernel(sigma);
  const sums = [0];
  for (const k of kernel) sums.push(sums[sums.length - 1] + k);
  const size = kernel.length, r = size >> 1;
  const sumTo = k => sums[Math.min(size, Math.max(0, k))];
  const end = start + len;
  return Array.from({length: n}, (_, i) => sumTo(end - i + r) - sumTo(start - i + r));
}

/** Picture Styles: Simple Frame, Thick Frame, Rounded, Soft Edge and Shadow (picture_style). */
export function pictureStyle(b, style) {
  const m = Math.max(Math.floor(Math.max(b.width, b.height) / 40), 4);
  const WHITE = [255, 255, 255, 255], DARK = [40, 40, 40, 255];
  switch (style) {
    case 'thickFrame': return frame(frame(b, m * 2, WHITE), Math.floor(m / 2), DARK);
    case 'rounded': case 'softEdge': {
      const out = copy(b), {width: w, height: h} = out;
      const r = Math.min(w, h) * (style === 'rounded' ? 0.12 : 0);
      const feather = style === 'softEdge' ? Math.max(Math.min(w, h) * 0.08, 2) : 1.5;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const fx = x + 0.5, fy = y + 0.5;
          const dx = Math.max(r - fx, fx - (w - r), 0), dy = Math.max(r - fy, fy - (h - r), 0);
          const edge = Math.min(Math.min(fx, w - fx), Math.min(fy, h - fy));
          const inside = r > 0 && dx > 0 && dy > 0 ? r - Math.hypot(dx, dy) : edge;
          const k = Math.min(1, Math.max(0, inside / feather));
          const o = (y * w + x) * 4 + 3;
          out.data[o] = Math.trunc(out.data[o] * k);
        }
      }
      return out;
    }
    case 'shadow': {
      const w = b.width, h = b.height, off = m, pw = w + off, ph = h + off;
      room(pw, ph);
      const out = bitmap(pw, ph);
      const sigma = off / 2, start = off + Math.floor(off / 2);
      const xs = blurredSpan(pw, start, w, sigma), ys = blurredSpan(ph, start, h, sigma);
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) out.data[(y * pw + x) * 4 + 3] = Math.round(90 * (xs[x] ?? 0) * (ys[y] ?? 0));
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const s = (y * w + x) * 4, o = (y * pw + x) * 4, a = b.data[s + 3] / 255, oa = out.data[o + 3] / 255;
          const ra = a + oa * (1 - a);
          for (let c = 0; c < 3; c++) out.data[o + c] = ra > 0 ? (b.data[s + c] * a) / ra : 0;
          out.data[o + 3] = ra * 255;
        }
      }
      return out;
    }
    default: return frame(b, m, WHITE);
  }
}
export const PICTURE_STYLES = Object.freeze([['simpleFrame', 'Simple Frame'], ['thickFrame', 'Thick Frame'], ['rounded', 'Rounded'], ['softEdge', 'Soft Edge'], ['shadow', 'Shadow']].map(Object.freeze));

/** What Artistic Effects, a Picture Style and a Picture Border drew: the effect, then the style, then the border (relook). */
export function relookBitmap(b, {effect, style, border}) {
  let img = effect ? artisticEffect(b, effect) : b;
  if (style) img = pictureStyle(img, style);
  if (border) img = frame(img, border[3], [border[0], border[1], border[2], 255]);
  return img === b ? copy(b) : img;
}

// ---- Color Tone, Set Transparent Color, Crop to Shape (U:quill/rest; not checked against upstream) --------------------------------

/** The temperatures Picture Format › Color › Color Tone offers, in kelvin (6500 is the picture as it is). */
export const TEMPERATURES = Object.freeze([4700, 5300, 5900, 6500, 7200, 8800, 10500, 11200]);

/**
 * Color Tone: the picture lit by a light of `kelvin` instead of daylight (6500 K): lower is cooler (bluer), higher warmer (more orange),
 * as Word's temperature presets. Absolute from the bitmap it is given.
 */
export function temperature(b, kelvin = 6500) {
  const out = copy(b), d = out.data;
  const w = Math.max(-1, Math.min(1, (kelvin - 6500) / 5000));
  const kr = 1 + 0.35 * w, kg = 1 + 0.05 * w, kb = 1 - 0.45 * w;
  for (let i = 0; i < d.length; i += 4) { d[i] *= kr; d[i + 1] *= kg; d[i + 2] *= kb; }
  return out;
}

/** The colour of the pixel at fractions (fx, fy) of the bitmap, as [r, g, b, a]. */
export function pixelAt(b, fx, fy) {
  const x = Math.min(b.width - 1, Math.max(0, Math.floor(fx * b.width))), y = Math.min(b.height - 1, Math.max(0, Math.floor(fy * b.height)));
  const i = (y * b.width + x) * 4;
  return [b.data[i], b.data[i + 1], b.data[i + 2], b.data[i + 3]];
}

/** Set Transparent Color: every pixel within `tolerance` (0..255, per channel) of `rgb` becomes transparent. Returns the bitmap and how many pixels went. */
export function transparentColor(b, [r, g, bl], tolerance = 12) {
  const out = copy(b), d = out.data, tol = Math.min(255, Math.max(0, tolerance));
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] && Math.abs(d[i] - r) <= tol && Math.abs(d[i + 1] - g) <= tol && Math.abs(d[i + 2] - bl) <= tol) { d[i + 3] = 0; n++; }
  }
  out.cleared = n;
  return out;
}

/** An outline's drawing steps (M, L, Q, C, Z with points {x, y}) as closed polygons of straight edges. */
export function flattenSteps(steps) {
  const polys = [];
  let cur = null, start = null;
  const push = p => { if (cur) cur.push([p.x, p.y]); };
  for (const s of steps) {
    if (s.t === 'M') { if (cur && cur.length > 2) polys.push(cur); cur = [[s.p.x, s.p.y]]; start = s.p; }
    else if (s.t === 'L') push(s.p);
    else if (s.t === 'Q' && cur) { const [x0, y0] = cur[cur.length - 1]; for (let k = 1; k <= 12; k++) { const t = k / 12, u = 1 - t; push({x: u * u * x0 + 2 * u * t * s.p1.x + t * t * s.p.x, y: u * u * y0 + 2 * u * t * s.p1.y + t * t * s.p.y}); } }
    else if (s.t === 'C' && cur) { const [x0, y0] = cur[cur.length - 1]; for (let k = 1; k <= 20; k++) { const t = k / 20, u = 1 - t; push({x: u * u * u * x0 + 3 * u * u * t * s.p1.x + 3 * u * t * t * s.p2.x + t * t * t * s.p.x, y: u * u * u * y0 + 3 * u * u * t * s.p1.y + 3 * u * t * t * s.p2.y + t * t * t * s.p.y}); } }
    else if (s.t === 'Z' && cur && start) { push(start); }
  }
  if (cur && cur.length > 2) polys.push(cur);
  return polys;
}

/**
 * Crop to Shape: what lies outside `steps` (an outline drawn in a vw x vh frame) becomes transparent, with the frame laid on the
 * bitmap's rectangle (x0, y0, vw, vh) (the part a crop shows); the edge is anti-aliased with 4 sub-scanlines and exact span ends.
 */
export function maskToShape(b, steps, {x0 = 0, y0 = 0, vw = b.width, vh = b.height} = {}) {
  room(b.width, b.height);
  const out = copy(b), {width: w, height: h} = out;
  const polys = flattenSteps(steps).map(p => p.map(([x, y]) => [x + x0, y + y0]));
  const cov = new Float32Array(w);
  const SUB = 4;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y0 + vh)); y++) {
    cov.fill(0);
    for (let s = 0; s < SUB; s++) {
      const yy = y + (s + 0.5) / SUB, xs = [];
      for (const poly of polys) {
        for (let i = 0, n = poly.length; i < n; i++) {
          const a = poly[i], c = poly[(i + 1) % n];
          if ((a[1] > yy) !== (c[1] > yy)) xs.push(a[0] + ((yy - a[1]) / (c[1] - a[1])) * (c[0] - a[0]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, xs[k]), xb = Math.min(w, xs[k + 1]);
        for (let x = Math.floor(xa); x < Math.ceil(xb) && x < w; x++) cov[x] += (Math.min(xb, x + 1) - Math.max(xa, x)) / SUB;
      }
    }
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x0 + vw)); x++) {
      const i = (y * w + x) * 4 + 3;
      out.data[i] = Math.round(out.data[i] * Math.min(1, cov[x]));
    }
  }
  return out;
}
