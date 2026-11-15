// Bounded inflation of zip entries (security audit H3).
//
// A zip's central directory declares each entry's uncompressed size, but the file controls that number:
// JSZip inflates the whole entry first and only then compares. Deflate reaches roughly 1000:1, so a 30 MB
// file can ask for 30 GB. Every reader of an Office package reads entries through here instead: the entry
// is inflated as a stream, counted as it comes out, and abandoned the moment it passes the cap, whatever the
// header says. A package also has a running total, so many parts that are each fine cannot add up to a bomb.
// No DOM, no Node built-ins (JSZip works in the renderer and in Node).

export const ZIP_XML_PART = 64 * 1024 * 1024;
export const ZIP_PART = 128 * 1024 * 1024;
export const ZIP_TOTAL = 256 * 1024 * 1024;

export class ZipLimitError extends Error {
  constructor(message) { super(message); this.name = 'ZipLimitError'; this.code = 'zip_limit'; }
}

/** XML and relationship parts get the smaller cap (they are parsed into trees, which costs far more than their size). */
export const isXmlPartName = name => /\.(xml|rels|vml|xsl|xsd)$/i.test(String(name));

/** Inflate a JSZip entry as a stream, counting as it goes and abandoning it past `limit`. */
function stream(entry, limit, name, keep) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0, settled = false;
    let helper;
    try { helper = entry.internalStream('uint8array'); } catch (e) { reject(e); return; }
    const stop = () => { settled = true; try { helper.pause(); } catch { /* already finished */ } };
    helper.on('data', chunk => {
      if (settled) return;
      n += chunk.length;
      if (n > limit) { stop(); reject(new ZipLimitError(`${name} inflates past ${limit} bytes`)); return; }
      if (keep) chunks.push(chunk);
    });
    helper.on('error', e => { if (!settled) { settled = true; reject(e); } });
    helper.on('end', () => {
      if (settled) return;
      settled = true;
      if (!keep) { resolve(n); return; }
      if (chunks.length === 1) { resolve(chunks[0]); return; }
      const out = new Uint8Array(n);
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.length; }
      resolve(out);
    });
    helper.resume();
  });
}

/** The bytes of a JSZip entry; rejects with ZipLimitError when more than `limit` bytes would come out. */
export const inflateCapped = (entry, limit, name = entry?.name ?? 'part') => stream(entry, limit, name, true);
/** How many bytes an entry inflates to (nothing kept); rejects with ZipLimitError past `limit`. */
export const measureCapped = (entry, limit, name = entry?.name ?? 'part') => stream(entry, limit, name, false);

/** Per-package inflate budget: one per opened file. */
export class ZipBudget {
  constructor({total = ZIP_TOTAL, xmlPart = ZIP_XML_PART, part = ZIP_PART} = {}) {
    this.total = total; this.xmlPart = xmlPart; this.part = part; this.used = 0;
  }
  /** Room left for the next entry named `name`. */
  limitFor(name) { return Math.max(0, Math.min(isXmlPartName(name) ? this.xmlPart : this.part, this.total - this.used)); }
  /** Inflate an entry within its cap and the package's remaining budget; throws ZipLimitError past either. */
  async bytes(entry, name = entry?.name) {
    const out = await inflateCapped(entry, this.limitFor(name), name);
    this.used += out.length;
    return out;
  }
  /** The same, decoded as UTF-8 (a leading byte-order mark is kept, as JSZip's 'string' does). */
  async text(entry, name = entry?.name) {
    return new TextDecoder('utf-8', {ignoreBOM: true}).decode(await this.bytes(entry, name));
  }
}

const verified = new WeakSet();
/**
 * Load a zip and prove, by inflating every entry once with the caps and discarding the output, that it stays
 * inside them. For readers that hand the bytes to a library with no cap of its own (ExcelJS, JSZip callers
 * written as plain `async()` reads). Remembered per bytes object, so a file is proven once. Returns the zip.
 */
export async function verifyZipBytes(JSZip, bytes, {maxEntries = 20_000, budget = new ZipBudget()} = {}) {
  const zip = await JSZip.loadAsync(bytes);
  if (verified.has(bytes)) return zip;
  const entries = Object.values(zip.files).filter(f => !f.dir);
  if (entries.length > maxEntries) throw new ZipLimitError(`${entries.length} zip entries`);
  for (const f of entries) budget.used += await measureCapped(f, budget.limitFor(f.name), f.name);
  verified.add(bytes);
  return zip;
}

/**
 * Inflate a zlib stream (a PNG's IDAT, say) with DecompressionStream, stopping the moment more than `limit`
 * bytes come out. Throws ZipLimitError past the limit.
 */
export async function inflateLimited(bytes, limit, format = 'deflate') {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) { reader.cancel().catch(() => {}); throw new ZipLimitError(`the data inflates past ${limit} bytes`); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The inflated size of a PNG's image data from its header: filter byte plus packed row, for each row (and Adam7 pass). */
export function pngRawSize(width, height, bitsPerPixel, interlace) {
  const row = w => Math.ceil((w * bitsPerPixel) / 8) + 1;
  if (!interlace) return row(width) * height;
  let n = 0;
  for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) {
    const w = Math.ceil((width - x0) / dx), h = Math.ceil((height - y0) / dy);
    if (w > 0 && h > 0) n += row(w) * h;
  }
  return n;
}
