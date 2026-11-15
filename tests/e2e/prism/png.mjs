// A small PNG reader for the E2E flows that look at what the window painted (8-bit RGB or RGBA,
// not interlaced: what Electron's capturePage writes). Pure Node; no system capture, no input.
import zlib from 'node:zlib';

export function decodePng(base64) {
  const b = Buffer.from(base64, 'base64');
  let o = 8;
  let w = 0, h = 0, depth = 0, type = 0;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const kind = b.toString('ascii', o + 4, o + 8);
    const data = b.subarray(o + 8, o + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8 || (type !== 6 && type !== 2)) throw new Error(`unsupported PNG (depth ${depth}, type ${type})`);
  const bpp = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const up = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      out[y * stride + x] = v & 255;
    }
  }
  const px = (x, y) => { const i = (Math.min(Math.max(y, 0), h - 1) * w + Math.min(Math.max(x, 0), w - 1)) * bpp; return [out[i], out[i + 1], out[i + 2]]; };
  return {width: w, height: h, px};
}

/** The share of sampled pixels in the rectangle [x0, y0, x1, y1] (fractions of the image) for which `test(r, g, b)` holds. */
export function share(img, [x0, y0, x1, y1], test, step = 6) {
  let n = 0, hit = 0;
  for (let y = Math.floor(y0 * img.height); y < y1 * img.height; y += step) {
    for (let x = Math.floor(x0 * img.width); x < x1 * img.width; x += step) { n += 1; if (test(...img.px(x, y))) hit += 1; }
  }
  return n ? hit / n : 0;
}
export const dark = (r, g, b) => r < 24 && g < 24 && b < 24;
export const light = (r, g, b) => r > 232 && g > 232 && b > 232;
