// Pictures for Insert › Pictures: base64, the media extension by magic bytes, and the natural size
// of an encoded raster picture read from its header (the picture probe).
//
// Translated from wordcraft crates/engine/src/cmd/insert/objects.rs (`base64_decode`,
// `base64_encode`, `image_ext`) and the header part of crates/geom/src/picture.rs (`probe`: which
// formats are taken, TIFF compressions that can't be read) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Not translated: the pixel-memory budget (`Refusal::TooLarge`, the decoder is the renderer's
// <img>) and metafiles (WMF/EMF: wordcraft_metafile + render `metafile_size`); a metafile is refused
// with upstream's "not a supported image" message. No DOM, no Node built-ins.

/** Decode base64 (standard or URL alphabet, padding optional, whitespace ignored); null if bad. */
export function base64Decode(s) {
  const out = [];
  let buf = 0, n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let v;
    if (c >= 65 && c <= 90) v = c - 65;
    else if (c >= 97 && c <= 122) v = c - 97 + 26;
    else if (c >= 48 && c <= 57) v = c - 48 + 52;
    else if (c === 43 || c === 45) v = 62;
    else if (c === 47 || c === 95) v = 63;
    else if (c === 61 || c === 32 || c === 10 || c === 13 || c === 9) continue;
    else return null;
    buf = (buf << 6) | v;
    n += 6;
    if (n >= 8) { n -= 8; out.push((buf >> n) & 0xff); buf &= (1 << n) - 1; }
  }
  return Uint8Array.from(out);
}

const T64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Standard base64 with padding. */
export function base64Encode(b) {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    const len = Math.min(3, b.length - i);
    for (let k = 0; k < 4; k++) out += k <= len ? T64[(n >> (18 - 6 * k)) & 63] : '=';
  }
  return out;
}

/** A data URL's or plain base64 text's bytes (the system picker hands a data URL). */
export function bytesOf(data) {
  const m = /^data:[^,]*;base64,/i.exec(data);
  return base64Decode(m ? data.slice(m[0].length) : data);
}

/** The media extension of an encoded picture by its magic bytes (image_ext). */
export function imageExt(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)) return 'tiff';
  return 'png';
}

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const i32le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);

/** TIFF compressions the decoder reads (none, LZW, PackBits, Deflate). */
const TIFF_OK = new Set([1, 5, 8, 32773, 32946]);

/**
 * Probe an encoded picture: {width, height} in pixels, or {refused: message} (probe). Metafiles,
 * SVG and other bytes are "not a picture".
 */
export function probe(b) {
  const bad = why => ({refused: `the picture is damaged (${why})`});
  if (b.length < 8) return {notPicture: true};
  const ext = imageExt(b);
  const magic = b[0] === 0x89 || (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x47 && b[1] === 0x49) || (b[0] === 0x52 && b[1] === 0x49)
    || (b[0] === 0x42 && b[1] === 0x4d) || b[0] === 0x49 || b[0] === 0x4d;
  if (!magic) return {notPicture: true};
  if (ext === 'png') {
    if (b.length < 24) return bad('short header');
    return {width: u32be(b, 16), height: u32be(b, 20)};
  }
  if (ext === 'gif') return {width: u16le(b, 6), height: u16le(b, 8)};
  if (ext === 'bmp') {
    if (b.length < 26) return bad('short header');
    const hs = i32le(b, 14);
    if (hs === 12) return {width: u16le(b, 18), height: u16le(b, 20)};
    return {width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22))};
  }
  if (ext === 'webp') {
    if (b.length < 30 || String.fromCharCode(...b.slice(8, 12)) !== 'WEBP') return {notPicture: true};
    const kind = String.fromCharCode(...b.slice(12, 16));
    if (kind === 'VP8 ') return {width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff};
    if (kind === 'VP8L') { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return {width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1}; }
    if (kind === 'VP8X') return {width: u24le(b, 24) + 1, height: u24le(b, 27) + 1};
    return bad('unknown WebP chunk');
  }
  if (ext === 'jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      const len = u16be(b, i + 2);
      if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return {width: u16be(b, i + 7), height: u16be(b, i + 5)};
      i += 2 + len;
    }
    return bad('no frame header');
  }
  // TIFF: the first IFD's width, height and compression.
  const le = b[0] === 0x49;
  const r16 = i => (le ? u16le(b, i) : u16be(b, i));
  const r32 = i => (le ? (u16le(b, i) + u16le(b, i + 2) * 65536) : u32be(b, i));
  const ifd = r32(4);
  if (ifd + 2 > b.length) return bad('no IFD');
  const n = r16(ifd);
  let width = 0, height = 0, compression = 1;
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > b.length) break;
    const tag = r16(e), type = r16(e + 2);
    const val = type === 3 ? r16(e + 8) : r32(e + 8);
    if (tag === 256) width = val; else if (tag === 257) height = val; else if (tag === 259) compression = val;
  }
  if (!TIFF_OK.has(compression)) return {refused: 'TIFF pictures with JPEG or an unknown compression can\'t be read'};
  if (!width || !height) return bad('no size');
  return {width, height};
}
