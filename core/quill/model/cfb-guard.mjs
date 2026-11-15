// A bytes-only check of an OLE compound file ([MS-CFB]) before a reader opens it: every reader of
// .doc, .xls and encrypted Office packages calls cfbCheck() first.
// Translated from wordcraft crates/doc/src/cfb_guard.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREE = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;
const HEADER_ENTRIES = 109;

/**
 * Check a compound file's FAT layout ([MS-CFB] §2.2 header, §2.5 DIFAT): walk the DIFAT as a
 * reader does and refuse a file that lists one FAT sector twice, or more FAT sectors than its
 * sectors need (a small header naming one sector over and over makes a reader allocate
 * gigabytes). Returns null when the file may be opened, else the reason. Anything else that is
 * wrong is left for the reader to report.
 */
export function cfbCheck(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const u16At = at => (at + 2 <= b.length ? b[at] | (b[at + 1] << 8) : null);
  const u32At = at => (at + 4 <= b.length ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0 : null);
  if (b.length < 512 || !MAGIC.every((m, i) => b[i] === m)) return null;
  const shift = u16At(0x1a);
  const sectorLen = shift === 3 ? 512 : shift === 4 ? 4096 : 0;
  if (!sectorLen || b.length < sectorLen) return null;
  const numSectors = Math.ceil(b.length / sectorLen) - 1;
  const numFatSectors = u32At(0x2c) ?? 0;
  const difat = [];
  for (let i = 0; i < HEADER_ENTRIES; i++) { const v = u32At(0x4c + i * 4); if (v !== null) difat.push(v); }
  let next = u32At(0x44) ?? END_OF_CHAIN;
  let steps = 0;
  while (next !== END_OF_CHAIN && next !== FREE) {
    steps++;
    if (steps > numSectors || next >= numSectors) return `the DIFAT chain is longer than the file or leaves it (sector ${next})`;
    const at = (next + 1) * sectorLen;
    const entries = sectorLen / 4 - 1;
    for (let i = 0; i < entries; i++) difat.push(u32At(at + i * 4) ?? FREE);
    next = u32At(at + entries * 4) ?? END_OF_CHAIN;
  }
  while (difat.length > HEADER_ENTRIES && difat.length > numFatSectors && difat[difat.length - 1] === 0) difat.pop();
  while (difat.length && difat[difat.length - 1] === FREE) difat.pop();
  const listed = difat.filter(s => s !== FREE);
  const needed = Math.ceil(numSectors / (sectorLen / 4)) + 1;
  if (listed.length > needed) return `the DIFAT lists ${listed.length} FAT sectors in a file of ${numSectors} sectors`;
  const seen = new Set();
  for (const s of listed) { if (seen.has(s)) return `the DIFAT lists FAT sector ${s} twice`; seen.add(s); }
  return null;
}

/** A ~1 MB compound file whose DIFAT chain lists one FAT sector 2048 × 127 times (regression input for readers' tests). */
export function repeatingDifatSample() {
  const S = 512, CHAIN = 2048;
  const f = new Uint8Array(S * (CHAIN + 2));
  const dv = new DataView(f.buffer);
  f.set(MAGIC, 0);
  dv.setUint16(0x18, 0x3e, true); dv.setUint16(0x1a, 3, true); dv.setUint16(0x1c, 0xfffe, true); dv.setUint16(0x1e, 9, true); dv.setUint16(0x20, 6, true);
  dv.setUint32(0x2c, 0xffffffff, true); dv.setUint32(0x38, 4096, true); dv.setUint32(0x44, 1, true); dv.setUint32(0x48, CHAIN, true);
  for (let d = 1; d <= CHAIN; d++) dv.setUint32((d + 2) * S - 4, d === CHAIN ? 0xfffffffe : d + 1, true);
  return f;
}
