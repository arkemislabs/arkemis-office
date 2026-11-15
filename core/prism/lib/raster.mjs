// Picture pixels for Picture Format › Remove Background and Artistic Effects: a PNG decoder and
// encoder (any colour type and bit depth, interlaced too; zlib through the platform's
// CompressionStream, so it runs in the app and in the headless bridge alike), a hook for the other
// raster formats (`host.decodeImage`, the renderer decodes them with the browser), and the pixel
// work itself: the background matte and the seven artistic effects.
// Translated from deckcraft crates/engine/src/cmd/background.rs (`matte`) and artistic.rs (`apply`:
// blur, sobel edges, pencil, line drawing, photocopy, film grain, cutout, glow edges) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// An image here is {width, height, data: Uint8ClampedArray of straight RGBA}.

/** Largest picture matted or filtered (16 megapixels), as deckcraft's background.rs; bigger ones are refused. */
export const MAX_PIXELS = 16_000_000;
/** Largest side the artistic effects work on; a bigger picture is scaled down first. */
export const MAX_SIDE = 3000;

import {inflateLimited, pngRawSize} from '../../common/lib/zip-guard.mjs';

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const isPng = b => b.length > 8 && SIG.every((v, i) => b[i] === v);
const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

async function pipe(bytes, stream) {
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}
const deflate = bytes => pipe(bytes, new CompressionStream('deflate'));

/** Size from a PNG header, or null. */
export function pngSize(b) { return isPng(b) && b.length >= 24 ? [be32(b, 16), be32(b, 20)] : null; }

const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/** Undo the scanline filters of one (sub)image; returns its raw rows. */
function unfilter(raw, at, rows, rowBytes, bpp) {
  const out = new Uint8Array(rows * rowBytes);
  for (let y = 0; y < rows; y++) {
    const f = raw[at++];
    const row = y * rowBytes, prev = row - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[at + x];
      const a = x >= bpp ? out[row + x - bpp] : 0, b = y ? out[prev + x] : 0, c = x >= bpp && y ? out[prev + x - bpp] : 0;
      let add = 0;
      if (f === 1) add = a;
      else if (f === 2) add = b;
      else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[row + x] = (v + add) & 255;
    }
    at += rowBytes;
  }
  return [out, at];
}

/** Decode a PNG to straight RGBA, or null when it is not a PNG we can read (or too large). */
export async function decodePng(bytes, maxPixels = MAX_PIXELS) {
  if (!isPng(bytes)) return null;
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  for (let i = 8; i + 12 <= bytes.length;) {
    const len = be32(bytes, i), type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]), d = i + 8;
    if (d + len > bytes.length) return null;
    if (type === 'IHDR') { width = be32(bytes, d); height = be32(bytes, d + 4); depth = bytes[d + 8]; color = bytes[d + 9]; interlace = bytes[d + 12]; }
    else if (type === 'PLTE') palette = bytes.subarray(d, d + len);
    else if (type === 'tRNS') trns = bytes.subarray(d, d + len);
    else if (type === 'IDAT') idat.push(bytes.subarray(d, d + len));
    else if (type === 'IEND') break;
    i = d + len + 4;
  }
  if (!width || !height || width * height > maxPixels || ![1, 2, 4, 8, 16].includes(depth) || ![0, 2, 3, 4, 6].includes(color) || (color === 3 && !palette)) return null;
  const chans = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color];
  const bits = chans * depth, bpp = Math.max(1, bits >> 3);
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  idat.reduce((n, c) => { joined.set(c, n); return n + c.length; }, 0);
  let raw;
  // The inflated size follows from the header: a stream that inflates past it is a bomb, not a picture.
  try { raw = await inflateLimited(joined, pngRawSize(width, height, bits, interlace) + 1024); } catch { return null; }
  const data = new Uint8ClampedArray(width * height * 4);
  const sample = (row, x, ch) => {
    if (depth === 8) return row[x * chans + ch];
    if (depth === 16) return row[(x * chans + ch) * 2];
    const bitPos = (x * chans + ch) * depth, v = (row[bitPos >> 3] >> (8 - depth - (bitPos & 7))) & ((1 << depth) - 1);
    return color === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  const trnsGray = color === 0 && trns && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
  const put = (x, y, row, sx) => {
    const o = (y * width + x) * 4;
    if (color === 3) {
      const idx = sample(row, sx, 0);
      data[o] = palette[idx * 3]; data[o + 1] = palette[idx * 3 + 1]; data[o + 2] = palette[idx * 3 + 2]; data[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
    } else if (color === 0 || color === 4) {
      const g = sample(row, sx, 0);
      data[o] = data[o + 1] = data[o + 2] = g;
      let clear = false;
      if (color === 0 && trnsGray >= 0) {
        const rawv = depth === 16 ? (row[sx * 2] << 8) | row[sx * 2 + 1] : depth === 8 ? row[sx] : (row[(sx * depth) >> 3] >> (8 - depth - ((sx * depth) & 7))) & ((1 << depth) - 1);
        clear = rawv === trnsGray;
      }
      data[o + 3] = color === 4 ? sample(row, sx, 1) : clear ? 0 : 255;
    } else {
      data[o] = sample(row, sx, 0); data[o + 1] = sample(row, sx, 1); data[o + 2] = sample(row, sx, 2); data[o + 3] = color === 6 ? sample(row, sx, 3) : 255;
    }
  };
  let at = 0;
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx), ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bits) / 8);
    if (at + ph * (rowBytes + 1) > raw.length) return null;
    const [rows, next] = unfilter(raw, at, ph, rowBytes, bpp);
    at = next;
    for (let y = 0; y < ph; y++) {
      const row = rows.subarray(y * rowBytes, (y + 1) * rowBytes);
      for (let x = 0; x < pw; x++) put(x0 + x * dx, y0 + y * dy, row, x);
    }
  }
  return {width, height, data};
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** Encode straight RGBA as a PNG. */
export async function encodePng(img) {
  const {width, height, data} = img;
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const o = y * (width * 4 + 1);
    raw[o] = 1; // Sub filter: compresses smooth pictures well
    for (let x = 0; x < width * 4; x++) {
      const v = data[y * width * 4 + x], a = x >= 4 ? data[y * width * 4 + x - 4] : 0;
      raw[o + 1 + x] = (v - a) & 255;
    }
  }
  const z = await deflate(raw);
  const chunk = (type, body) => {
    const out = new Uint8Array(12 + body.length), dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height); ihdr[8] = 8; ihdr[9] = 6;
  const parts = [Uint8Array.from(SIG), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((n, p) => { out.set(p, n); return n + p.length; }, 0);
  return out;
}

/**
 * Decode any picture the app can open: a PNG here, other formats through the host's `decodeImage`
 * (the renderer's browser decoder). Null when neither can.
 */
export async function decodeImage(bytes, host) {
  const png = await decodePng(bytes);
  if (png) return png;
  if (isPng(bytes)) return null;
  if (typeof host?.decodeImage === 'function') {
    const img = await host.decodeImage(bytes);
    if (img?.data && img.width * img.height <= MAX_PIXELS) return img;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Remove Background (background.rs `matte`)

const dist = (d, i, j) => Math.hypot(d[i] - d[j], d[i + 1] - d[j + 1], d[i + 2] - d[j + 2]);

/**
 * Make the background of `img` transparent (in place) and return how many pixels it was. The
 * background is what the picture's edges reach through similar colours: a flood fill from every edge
 * pixel, each step close to the pixel before it (gradients and soft shadows) and to the edge colour it
 * started from (so it can't leak into the subject), with a one-pixel soft edge. `tolerance` is 0–100.
 */
export function matte(img, tolerance) {
  const {width: w, height: h, data: d} = img;
  if (!w || !h) return 0;
  const seedTol = Math.min(Math.max(Number.isFinite(tolerance) ? tolerance : 20, 0), 100) * 4.41;
  const stepTol = Math.max(seedTol * 0.35, 6);
  const bg = new Uint8Array(w * h);
  const seed = new Int32Array(w * h).fill(-1); // pixel index of the edge colour a background pixel was reached from
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const edge = i => { if (!bg[i]) { bg[i] = 1; seed[i] = i; queue[tail++] = i; } };
  for (let x = 0; x < w; x++) { edge(x); edge((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { edge(y * w); edge(y * w + w - 1); }
  while (head < tail) {
    const i = queue[head++], x = i % w, y = (i / w) | 0, from = seed[i];
    for (const j of [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1]) {
      if (j < 0 || bg[j]) continue;
      // Transparent pixels are background already.
      if (d[j * 4 + 3] < 16 || (dist(d, j * 4, i * 4) <= stepTol && dist(d, j * 4, from * 4) <= seedTol)) { bg[j] = 1; seed[j] = from; queue[tail++] = j; }
    }
  }
  // A background edge that is the subject's colour throughout is no background: leave such a picture alone.
  if (tail === w * h) return 0;
  const soft = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (bg[i]) continue;
    if ((x > 0 && bg[i - 1]) || (x + 1 < w && bg[i + 1]) || (y > 0 && bg[i - w]) || (y + 1 < h && bg[i + w])) soft.push(i);
  }
  for (let i = 0; i < w * h; i++) if (bg[i]) d[i * 4 + 3] = 0;
  for (const i of soft) d[i * 4 + 3] = Math.floor((d[i * 4 + 3] * 2) / 3);
  return tail;
}

// ---------------------------------------------------------------------------------------------
// Artistic Effects (artistic.rs `apply`)

/** The effects offered: `a14` element name and label. */
export const EFFECTS = Object.freeze([['artisticBlur', 'Blur'], ['artisticPencilGrayscale', 'Pencil Grayscale'], ['artisticLineDrawing', 'Line Drawing'],
  ['artisticFilmGrain', 'Film Grain'], ['artisticCutout', 'Cutout'], ['artisticGlowEdges', 'Glow Edges'], ['artisticPhotocopy', 'Photocopy']]);

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const clamp8 = v => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Box blur of `channels` interleaved planes, one pass each way. */
function boxBlur(src, w, h, ch, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const k = 2 * r + 1;
  for (let y = 0; y < h; y++) for (let c = 0; c < ch; c++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[(y * w + Math.min(Math.max(x, 0), w - 1)) * ch + c];
    for (let x = 0; x < w; x++) {
      tmp[(y * w + x) * ch + c] = sum / k;
      sum += src[(y * w + Math.min(x + r + 1, w - 1)) * ch + c] - src[(y * w + Math.max(x - r, 0)) * ch + c];
    }
  }
  for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[(Math.min(Math.max(y, 0), h - 1) * w + x) * ch + c];
    for (let y = 0; y < h; y++) {
      out[(y * w + x) * ch + c] = sum / k;
      sum += tmp[(Math.min(y + r + 1, h - 1) * w + x) * ch + c] - tmp[(Math.max(y - r, 0) * w + x) * ch + c];
    }
  }
  return out;
}
/** Three box passes approximate a Gaussian of deviation `sigma`. */
function gaussian(src, w, h, ch, sigma) {
  const r = Math.max(1, Math.round(Math.sqrt((4 * sigma * sigma) / 3 + 0.25) - 0.5));
  let cur = Float32Array.from(src);
  for (let i = 0; i < 3; i++) cur = boxBlur(cur, w, h, ch, r);
  return cur;
}

/** Sobel edge strength, 0–255, of one grey plane. */
function edges(g, w, h) {
  const at = (x, y) => g[Math.min(Math.max(y, 0), h - 1) * w + Math.min(Math.max(x, 0), w - 1)];
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
    const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
    out[y * w + x] = Math.min(Math.hypot(gx, gy) / 4, 255);
  }
  return out;
}

/** Applies `effect` to `img`; returns a new image (alpha kept), or null for an unknown effect. */
export function applyEffect(effect, img) {
  const {width: w, height: h, data: s} = img;
  if (!EFFECTS.some(([id]) => id === effect)) return null;
  const scale = Math.sqrt(w * w + h * h) / 1000;
  const out = new Uint8ClampedArray(s.length);
  const grey = () => { const g = new Float32Array(w * h); for (let i = 0; i < w * h; i++) g[i] = Math.round(clamp8(luma(s[i * 4], s[i * 4 + 1], s[i * 4 + 2]))); return g; };
  if (effect === 'artisticBlur') {
    const b = gaussian(s, w, h, 4, Math.max(6 * scale, 1));
    for (let i = 0; i < s.length; i++) out[i] = Math.round(b[i]);
    return {width: w, height: h, data: out};
  }
  if (effect === 'artisticPencilGrayscale' || effect === 'artisticLineDrawing' || effect === 'artisticPhotocopy') {
    const soft = gaussian(grey(), w, h, 1, Math.max(0.8 * scale, 0.5));
    const e = edges(soft, w, h);
    for (let i = 0; i < w * h; i++) {
      const ev = e[i], gv = soft[i];
      const v = effect === 'artisticPencilGrayscale' ? 255 - ev * 2 - (255 - gv) * 0.25
        : effect === 'artisticLineDrawing' ? (ev > 28 ? 255 - (ev - 28) * 3 : 255)
          : (ev > 40 || gv < 70 ? 0 : 255);
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = clamp8(v);
      out[i * 4 + 3] = s[i * 4 + 3];
    }
    return {width: w, height: h, data: out};
  }
  if (effect === 'artisticFilmGrain') {
    // Deterministic noise, so the same picture gives the same grain.
    let seed = 0x9e3779b9;
    for (let i = 0; i < w * h; i++) {
      seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
      const n = (seed % 61) - 30;
      for (let c = 0; c < 3; c++) out[i * 4 + c] = clamp8((s[i * 4 + c] - 128) * 1.1 + 128 + n);
      out[i * 4 + 3] = s[i * 4 + 3];
    }
    return {width: w, height: h, data: out};
  }
  if (effect === 'artisticCutout') {
    const b = gaussian(s, w, h, 4, Math.max(1.5 * scale, 0.5));
    for (let i = 0; i < w * h; i++) {
      for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.trunc((Math.round((b[i * 4 + c] / 255) * 3) / 3) * 255);
      out[i * 4 + 3] = s[i * 4 + 3];
    }
    return {width: w, height: h, data: out};
  }
  const e = edges(grey(), w, h); // artisticGlowEdges
  for (let i = 0; i < w * h; i++) {
    const k = Math.min((e[i] / 255) * 2.5, 1);
    for (let c = 0; c < 3; c++) out[i * 4 + c] = clamp8(s[i * 4 + c] * k + 255 * k * 0.3);
    out[i * 4 + 3] = s[i * 4 + 3];
  }
  return {width: w, height: h, data: out};
}

/** `img` scaled down (area average) so its longer side is at most `max`; the same image when it already is. */
export function fitWithin(img, max) {
  const {width: w, height: h, data: s} = img;
  if (Math.max(w, h) <= max) return img;
  const k = max / Math.max(w, h), nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const x0 = Math.floor(x / k), x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) / k))), y0 = Math.floor(y / k), y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) / k)));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * w + xx) * 4, al = s[i + 3]; r += s[i] * al; g += s[i + 1] * al; b += s[i + 2] * al; a += al; n++; }
    const o = (y * nw + x) * 4;
    out[o] = a ? r / a : 0; out[o + 1] = a ? g / a : 0; out[o + 2] = a ? b / a : 0; out[o + 3] = n ? a / n : 0;
  }
  return {width: nw, height: nh, data: out};
}

/** The region `[x, y, w, h]` of `img` as an image. */
export function cropImage(img, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) out.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return {width: w, height: h, data: out};
}

/** `img` scaled to `nw` × `nh` by area averaging (alpha-weighted); the same image when the size is unchanged. */
export function resizeImage(img, nw, nh) {
  const {width: w, height: h, data: s} = img;
  if (nw === w && nh === h) return img;
  const out = new Uint8ClampedArray(nw * nh * 4), kx = w / nw, ky = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * ky), y1 = Math.max(y0 + 1, Math.min(h, Math.ceil((y + 1) * ky)));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * kx), x1 = Math.max(x0 + 1, Math.min(w, Math.ceil((x + 1) * kx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * w + xx) * 4, al = s[i + 3]; r += s[i] * al; g += s[i + 1] * al; b += s[i + 2] * al; a += al; n++; }
      const o = (y * nw + x) * 4;
      out[o] = a ? r / a : 0; out[o + 1] = a ? g / a : 0; out[o + 2] = a ? b / a : 0; out[o + 3] = n ? a / n : 0;
    }
  }
  return {width: nw, height: nh, data: out};
}

/** Whether any pixel of `img` is not fully opaque. */
export const hasAlpha = img => { for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 255) return true; return false; };
