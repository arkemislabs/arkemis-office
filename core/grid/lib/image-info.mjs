// Which kind of picture some bytes are, and how large (the header only, no decoding).
// Translated from gridcraft crates/engine/src/io.rs (`image_size`) and crates/xlsx/src/drawing.rs
// (`image_ext`, `image_content_type`, `mime_for`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u16le = (b, i) => b[i] | (b[i + 1] << 8);

/** [width, height] of a PNG, JPEG, GIF or BMP, or null. */
export function imageSize(b) {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return [u32be(b, 16), u32be(b, 20)];
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return [u16le(b, 6), u16le(b, 8)];
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4D) return [(b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24)) >>> 0, Math.abs(b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24))];
  if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i += 1; continue; }
      const marker = b[i + 1];
      if (marker === 0xFF) { i += 1; continue; }
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      const len = u16be(b, i + 2);
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) return [u16be(b, i + 7), u16be(b, i + 5)];
      i += 2 + len;
    }
  }
  return null;
}

/** The MIME type of the bytes by their signature, or null. */
export function sniffMime(b) {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
  return null;
}

export const EXT_FOR_MIME = Object.freeze({'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/svg+xml': 'svg',
  'image/x-emf': 'emf', 'image/x-wmf': 'wmf', 'image/webp': 'webp'});
export const MIME_FOR_EXT = Object.freeze({png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  svg: 'image/svg+xml', emf: 'image/x-emf', wmf: 'image/x-wmf', webp: 'image/webp'});

/** Base64 text to bytes and back (no Buffer: the model runs in the renderer too). */
export function base64ToBytes(text) {
  const clean = String(text).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  const bin = typeof atob === 'function' ? atob(clean) : Buffer.from(clean, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
}
