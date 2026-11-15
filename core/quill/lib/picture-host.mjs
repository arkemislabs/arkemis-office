// Decoding a picture to pixels and writing pixels back as a PNG, for Picture Format's pixel edits.
//
// Upstream decodes with the `image` crate (picture.rs `adjust_media`); here the window decodes: the renderer's
// canvas reads any format the browser does (PNG, JPEG, GIF, WebP, BMP), and `ctx.host.decodeImage(bytes)` /
// `ctx.host.encodePng(bitmap)` may stand in for it (a test host, or a window without OffscreenCanvas). Where
// neither is there, a PNG is read and written in plain JavaScript with the standard
// DecompressionStream / CompressionStream (8-bit grey, grey+alpha, RGB, RGBA and palette, not interlaced).
// No DOM and no Node built-ins are named here: the canvas is looked up on globalThis when it exists.

import {MAX_PIXELS, TooLarge} from './picture-pixels.mjs';
import {inflateLimited} from '../../common/lib/zip-guard.mjs';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = b => SIGNATURE.every((v, i) => b[i] === v);
const u32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

async function pipe(bytes, stream) {
  const w = stream.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  const parts = [];
  const r = stream.readable.getReader();
  for (;;) {
    const {done, value} = await r.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** A PNG read in plain JavaScript; null when it is a kind this does not read. */
export async function decodePngJs(bytes) {
  if (!isPng(bytes) || typeof DecompressionStream !== 'function') return null;
  let p = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (p + 8 <= bytes.length) {
    const len = u32(bytes, p), name = String.fromCharCode(...bytes.subarray(p + 4, p + 8)), body = bytes.subarray(p + 8, p + 8 + len);
    if (name === 'IHDR') { width = u32(body, 0); height = u32(body, 4); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (name === 'PLTE') palette = body;
    else if (name === 'tRNS') trns = body;
    else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    p += 12 + len;
  }
  if (!width || !height || depth !== 8 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(type)) return null;
  if (width * height > MAX_PIXELS) throw new TooLarge();
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of idat) { joined.set(c, o); o += c.length; }
  const bpp = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[type], stride = width * bpp;
  // The inflated size follows from the header: a stream that inflates past it is a bomb, not a picture.
  let raw;
  try { raw = await inflateLimited(joined, (stride + 1) * height + 1024); } catch (e) { if (e?.code === 'zip_limit') throw new TooLarge(); throw e; }
  if (raw.length < (stride + 1) * height) return null;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[dst + x - bpp] : 0, b = y ? rows[dst - stride + x] : 0, c = x >= bpp && y ? rows[dst - stride + x - bpp] : 0;
      const v = raw[src + x];
      let r;
      switch (f) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        default: { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      }
      rows[dst + x] = r & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * bpp, d = i * 4;
    if (type === 6) data.set(rows.subarray(s, s + 4), d);
    else if (type === 2) { data[d] = rows[s]; data[d + 1] = rows[s + 1]; data[d + 2] = rows[s + 2]; data[d + 3] = 255; }
    else if (type === 0) { data[d] = data[d + 1] = data[d + 2] = rows[s]; data[d + 3] = 255; }
    else if (type === 4) { data[d] = data[d + 1] = data[d + 2] = rows[s]; data[d + 3] = rows[s + 1]; }
    else { const k = rows[s]; data[d] = palette?.[k * 3] ?? 0; data[d + 1] = palette?.[k * 3 + 1] ?? 0; data[d + 2] = palette?.[k * 3 + 2] ?? 0; data[d + 3] = trns?.[k] ?? 255; }
  }
  return {width, height, data};
}

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const be32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** Pixels as a PNG in plain JavaScript (RGBA, filter 0). */
export async function encodePngJs({width, height, data}) {
  const stride = width * 4, raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const z = await pipe(raw, new CompressionStream('deflate'));
  const chunk = (name, body) => {
    const head = Uint8Array.from([...name].map(c => c.charCodeAt(0)));
    const crcIn = new Uint8Array(4 + body.length);
    crcIn.set(head); crcIn.set(body, 4);
    return Uint8Array.from([...be32(body.length), ...crcIn, ...be32(crc32(crcIn))]);
  };
  const parts = [Uint8Array.from(SIGNATURE), chunk('IHDR', Uint8Array.from([...be32(width), ...be32(height), 8, 6, 0, 0, 0])), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** What the canvas decodes: createImageBitmap and an OffscreenCanvas (the renderer), or null. */
async function decodeCanvas(bytes) {
  const g = globalThis;
  if (typeof g.createImageBitmap !== 'function' || typeof g.OffscreenCanvas !== 'function' || typeof g.Blob !== 'function') return null;
  const bmp = await g.createImageBitmap(new g.Blob([bytes]));
  try {
    if (bmp.width * bmp.height > MAX_PIXELS) throw new TooLarge();
    const c = new g.OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d', {willReadFrequently: true});
    x.drawImage(bmp, 0, 0);
    const im = x.getImageData(0, 0, bmp.width, bmp.height);
    return {width: im.width, height: im.height, data: im.data};
  } finally { bmp.close?.(); }
}

/** Decode `bytes` (a picture) to a bitmap: the host's decoder, the canvas, or a PNG read by hand. */
export async function decodeImage(host, bytes) {
  if (typeof host?.decodeImage === 'function') return host.decodeImage(bytes);
  const viaCanvas = await decodeCanvas(bytes).catch(e => { if (e instanceof TooLarge) throw e; return null; });
  if (viaCanvas) return viaCanvas;
  const png = await decodePngJs(bytes);
  if (png) return png;
  throw new Error("can't decode the picture");
}

/** A bitmap as PNG bytes: the host's encoder, the canvas, or a PNG written by hand. */
export async function encodePng(host, bitmap) {
  if (typeof host?.encodePng === 'function') return host.encodePng(bitmap);
  const g = globalThis;
  if (typeof g.OffscreenCanvas === 'function') {
    try {
      const c = new g.OffscreenCanvas(bitmap.width, bitmap.height), x = c.getContext('2d');
      x.putImageData(new g.ImageData(bitmap.data, bitmap.width, bitmap.height), 0, 0);
      const blob = await c.convertToBlob({type: 'image/png'});
      return new Uint8Array(await blob.arrayBuffer());
    } catch { /* write it by hand */ }
  }
  return encodePngJs(bitmap);
}
