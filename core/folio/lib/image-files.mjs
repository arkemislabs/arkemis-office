// Image files: a PNG writer and an uncompressed TIFF writer for raw samples, and the images a document's pages use (Export all images).
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/create/src/extract.rs     extract_images: the Image XObjects reachable from each page's resources, through forms, each once on the
//                                    first page using it; one shorter than `min_side` is skipped; a JPEG is written unchanged, other images decoded
//                                    and written as PNG with their soft mask as alpha; an image that cannot be decoded is reported, never left out
//   crates/export/src (ImageFormat)  PNG, JPEG, TIFF for page renders; file names "<name>_page_<n>.<ext>"
// Decoding goes through pdf-lib's stream filters (Flate with predictors, LZW, ASCII85, RunLength). Not translated: JBIG2, CCITT, JPEG 2000, CMYK
// JPEGs and JPEGs with a soft mask (reported as skipped), colour keys and stencil masks. No DOM, no Node built-ins: deflate is the platform's
// CompressionStream.

import {PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFRawStream, PDFNumber, PDFBool, decodePDFRawStream} from 'pdf-lib';

const N = s => PDFName.of(s);
const MAX_PIXELS = 100_000_000;

// ---- PNG ------------------------------------------------------------------------------------

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A PNG of `width` x `height` 8-bit samples with `channels` 1 (grey), 2 (grey, alpha), 3 (RGB) or 4 (RGBA) per pixel. */
export async function encodePng({width, height, channels, data}) {
  if (!(width > 0 && height > 0) || ![1, 2, 3, 4].includes(channels) || data.length !== width * height * channels) throw new Error('the picture has no samples to write');
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1); }
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
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = {1: 0, 2: 4, 3: 2, 4: 6}[channels];
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { png.set(p, at); at += p.length; }
  return png;
}

// ---- TIFF -----------------------------------------------------------------------------------

/** A baseline TIFF (little-endian, uncompressed, one strip) of 8-bit RGB samples. */
export function encodeTiff({width, height, rgb, dpi = 72}) {
  if (rgb.length !== width * height * 3) throw new Error('the picture has no samples to write');
  const entries = 12, ifdAt = 8, dataAt = ifdAt + 2 + entries * 12 + 4;
  const extra = 6 + 6 + 8; // BitsPerSample (3 x short), XResolution and YResolution (rationals)
  const stripAt = dataAt + extra;
  const out = new Uint8Array(stripAt + rgb.length), dv = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]); dv.setUint32(4, ifdAt, true);
  dv.setUint16(ifdAt, entries, true);
  let e = ifdAt + 2;
  const put = (tag, type, count, value) => { dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, count, true); if (type === 3 && count === 1) dv.setUint16(e + 8, value, true); else dv.setUint32(e + 8, value, true); e += 12; };
  put(256, 4, 1, width); put(257, 4, 1, height); put(258, 3, 3, dataAt); put(259, 3, 1, 1); put(262, 3, 1, 2);
  put(273, 4, 1, stripAt); put(277, 3, 1, 3); put(278, 4, 1, height); put(279, 4, 1, rgb.length);
  put(282, 5, 1, dataAt + 6); put(283, 5, 1, dataAt + 14); put(296, 3, 1, 2);
  dv.setUint32(e, 0, true);
  for (let i = 0; i < 3; i++) dv.setUint16(dataAt + i * 2, 8, true);
  dv.setUint32(dataAt + 6, Math.round(dpi), true); dv.setUint32(dataAt + 10, 1, true);
  dv.setUint32(dataAt + 14, Math.round(dpi), true); dv.setUint32(dataAt + 18, 1, true);
  out.set(rgb, stripAt);
  return out;
}

// ---- the images of a document ---------------------------------------------------------------

const look = (doc, v) => (v instanceof PDFRef ? doc.context.lookup(v) : v);
const num = (doc, d, name) => { const v = look(doc, d.get(N(name))); return v instanceof PDFNumber ? v.asNumber() : null; };
const nameOf = (doc, d, name) => { const v = look(doc, d.get(N(name))); return v instanceof PDFName ? v.decodeText() : null; };
const filtersOf = (doc, d) => {
  const f = look(doc, d.get(N('Filter')));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map(x => look(doc, x)).filter(x => x instanceof PDFName).map(x => x.decodeText());
  return [];
};

function* imagesIn(doc, resources, depth, forms) {
  const xo = resources instanceof PDFDict ? look(doc, resources.get(N('XObject'))) : null;
  if (!(xo instanceof PDFDict) || depth > 12) return;
  for (const [, v] of xo.entries()) {
    const stream = look(doc, v);
    if (!(stream instanceof PDFStream)) continue;
    const sub = nameOf(doc, stream.dict, 'Subtype');
    if (sub === 'Image') yield {ref: v instanceof PDFRef ? v : null, stream};
    else if (sub === 'Form') {
      const key = v instanceof PDFRef ? `${v.objectNumber}` : null;
      if (key) { if (forms.has(key)) continue; forms.add(key); }
      yield* imagesIn(doc, look(doc, stream.dict.get(N('Resources'))), depth + 1, forms);
    }
  }
}

const samplesOf = stream => (stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents());

/** The samples of an image as 8-bit grey (1), RGB (3) or null with why not; applies Indexed palettes and Decode inversion. */
function colourSamples(doc, stream, width, height) {
  const d = stream.dict;
  const bits = num(doc, d, 'BitsPerComponent') ?? 8;
  const isMask = look(doc, d.get(N('ImageMask'))) instanceof PDFBool && look(doc, d.get(N('ImageMask'))).asBoolean();
  let cs = look(doc, d.get(N('ColorSpace')));
  let space = cs instanceof PDFName ? cs.decodeText() : cs instanceof PDFArray ? look(doc, cs.get(0))?.decodeText?.() : isMask ? 'DeviceGray' : null;
  let palette = null, components = {DeviceGray: 1, CalGray: 1, DeviceRGB: 3, CalRGB: 3, DeviceCMYK: 4}[space] ?? null;
  if (space === 'ICCBased' && cs instanceof PDFArray) { const prof = look(doc, cs.get(1)); const n = prof instanceof PDFStream ? num(doc, prof.dict, 'N') : null; components = n === 1 || n === 3 || n === 4 ? n : null; }
  if (space === 'Indexed' && cs instanceof PDFArray) {
    const base = look(doc, cs.get(1)); const baseName = base instanceof PDFName ? base.decodeText() : base instanceof PDFArray ? look(doc, base.get(0))?.decodeText?.() : null;
    const baseN = {DeviceGray: 1, DeviceRGB: 3, CalRGB: 3, CalGray: 1}[baseName] ?? null;
    const lookup = look(doc, cs.get(3));
    const table = lookup instanceof PDFStream ? samplesOf(lookup) : lookup?.asBytes?.() ?? null;
    if (!baseN || !table) return {why: 'an indexed colour space it cannot read'};
    palette = {n: baseN, table}; components = 1;
  }
  if (!components) return {why: `the colour space ${space ?? 'unknown'} is not exported`};
  if (![1, 2, 4, 8].includes(bits)) return {why: `${bits} bits per component`};
  const raw = samplesOf(stream);
  const rowBytes = Math.ceil(width * components * bits / 8);
  if (raw.length < rowBytes * height) return {why: 'the image data is shorter than its size says'};
  const decode = look(doc, d.get(N('Decode')));
  const invert = decode instanceof PDFArray && decode.size() >= 2 && look(doc, decode.get(0)) instanceof PDFNumber && look(doc, decode.get(0)).asNumber() === 1 && components === 1 && !palette;
  const out = new Uint8Array(width * height * (palette ? palette.n : components === 4 ? 3 : components));
  const max = (1 << bits) - 1;
  let o = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const read = c => {
        if (bits === 8) return raw[y * rowBytes + x * components + c];
        const bit = (x * components + c) * bits; const byte = raw[y * rowBytes + (bit >> 3)];
        return (byte >> (8 - bits - (bit & 7))) & max;
      };
      if (palette) { const i = read(0); for (let k = 0; k < palette.n; k++) out[o++] = palette.table[i * palette.n + k] ?? 0; }
      else if (components === 4) { const [c, m, ye, k] = [0, 1, 2, 3].map(read); out[o++] = Math.round((255 - c) * (255 - k) / 255); out[o++] = Math.round((255 - m) * (255 - k) / 255); out[o++] = Math.round((255 - ye) * (255 - k) / 255); }
      else for (let c = 0; c < components; c++) { let v = bits === 8 ? read(c) : Math.round(read(c) * 255 / max); if (invert) v = 255 - v; out[o++] = v; }
    }
  }
  return {channels: palette ? palette.n : components === 4 ? 3 : components, data: out};
}

/**
 * The images of `pages` (0-based; each image once, on the first page that uses it), at least `minSide` pixels on the shorter side.
 * @returns {Promise<{images: {page: number, index: number, width: number, height: number, ext: 'jpg'|'png', bytes: Uint8Array}[], skipped: {page: number, why: string}[]}>}
 */
export async function extractImages(doc, pages, minSide = 0) {
  const all = doc.getPages();
  const seen = new Set();
  const images = [], skipped = [];
  for (const pi of pages) {
    const page = all[pi];
    if (!page) continue;
    const resources = look(doc, page.node.get(N('Resources')));
    for (const {ref, stream} of imagesIn(doc, resources, 0, new Set())) {
      const id = ref ? `${ref.objectNumber} ${ref.generationNumber}` : null;
      if (id) { if (seen.has(id)) continue; seen.add(id); }
      const width = num(doc, stream.dict, 'Width') ?? 0, height = num(doc, stream.dict, 'Height') ?? 0;
      if (width <= 0 || height <= 0 || Math.min(width, height) < minSide) continue;
      if (width * height > MAX_PIXELS) { skipped.push({page: pi, why: 'the image is too large to export'}); continue; }
      const filters = filtersOf(doc, stream.dict);
      try {
        if (filters.length === 1 && filters[0] === 'DCTDecode') {
          const smask = look(doc, stream.dict.get(N('SMask')));
          const cs = look(doc, stream.dict.get(N('ColorSpace')));
          const cmyk = cs instanceof PDFName && cs.decodeText() === 'DeviceCMYK';
          if (smask instanceof PDFStream || cmyk) { skipped.push({page: pi, why: smask instanceof PDFStream ? 'a JPEG with transparency is not exported' : 'a CMYK JPEG is not exported'}); continue; }
          images.push({page: pi, index: images.length + 1, width, height, ext: 'jpg', bytes: stream instanceof PDFRawStream ? stream.contents : stream.getContents()});
          continue;
        }
        if (filters.some(f => ['JBIG2Decode', 'CCITTFaxDecode', 'JPXDecode', 'DCTDecode'].includes(f))) { skipped.push({page: pi, why: `${filters.at(-1)} images are not exported`}); continue; }
        const px = colourSamples(doc, stream, width, height);
        if (!px.data) { skipped.push({page: pi, why: px.why}); continue; }
        let {channels, data} = px;
        const smask = look(doc, stream.dict.get(N('SMask')));
        if (smask instanceof PDFStream && (num(doc, smask.dict, 'Width') ?? 0) === width && (num(doc, smask.dict, 'Height') ?? 0) === height && (num(doc, smask.dict, 'BitsPerComponent') ?? 8) === 8) {
          const alpha = samplesOf(smask);
          if (alpha.length >= width * height) {
            const withAlpha = new Uint8Array(width * height * (channels + 1));
            for (let i = 0; i < width * height; i++) { for (let c = 0; c < channels; c++) withAlpha[i * (channels + 1) + c] = data[i * channels + c]; withAlpha[i * (channels + 1) + channels] = alpha[i]; }
            data = withAlpha; channels += 1;
          }
        }
        images.push({page: pi, index: images.length + 1, width, height, ext: 'png', bytes: await encodePng({width, height, channels, data})});
      } catch (e) { skipped.push({page: pi, why: e?.message ?? 'the image could not be decoded'}); }
    }
  }
  return {images, skipped};
}
