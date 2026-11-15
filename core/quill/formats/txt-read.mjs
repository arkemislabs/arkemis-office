// Plain text (.txt) → Quill schema-2 content: what File > Open reads from a text file.
//
// Translated from wordcraft crates/formats/src/txt.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c): UTF-8 (with or without BOM), UTF-16 LE/BE (BOM or
// sniffed by its zero bytes), else the legacy encoding the bytes look like, Windows-1252 when
// nothing fits better; one paragraph per line; control characters other than tab and form feed
// dropped. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// What differs (docs/behaviour-fidelity.md): upstream guesses a legacy encoding with chardetng
// (Firefox's detector). Here each multibyte candidate (Shift_JIS, EUC-JP, GBK, Big5, EUC-KR) is
// decoded strictly by the platform TextDecoder and scored by the share of characters that belong
// to its script; the best clear winner is used, else Windows-1252 as upstream.
// No DOM, no Node built-ins.

import {contentFromText} from '../model/content.mjs';
import {cp1252} from '../model/encoding.mjs';

export const UPSTREAM = Object.freeze({repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/formats/src/txt.rs']});

function utf16(b, le) {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

/** UTF-16 without a BOM, told by its zero bytes: true little-endian, false big-endian, null neither. */
export function unmarkedUtf16(b) {
  if (b.length < 4 || b.length % 2) return null;
  const sample = b.subarray(0, Math.min(512, b.length));
  let even = 0, odd = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) { if (i % 2) odd++; else even++; }
  const half = Math.floor(sample.length / 2);
  if (odd * 10 >= half * 4 && even * 10 < half) return true;
  if (even * 10 >= half * 4 && odd * 10 < half) return false;
  return null;
}

/** Does `b` look like plain text (a file with an unknown extension opens as text, as Word's text import)? */
export function isText(b) {
  if ((b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) || (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return true;
  if (b.length >= 5 && String.fromCharCode(...b.subarray(0, 5)) === '%PDF-') return false;
  const sample = b.subarray(0, Math.min(b.length, 64 << 10));
  const odd = c => c === 0 || (c < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d, 0x1a, 0x1b].includes(c)) || c === 0x7f;
  const le = unmarkedUtf16(sample);
  if (le !== null) {
    let n = 0;
    const units = Math.floor(sample.length / 2);
    for (let i = 0; i + 1 < sample.length; i += 2) if (odd(le ? sample[i] | (sample[i + 1] << 8) : (sample[i] << 8) | sample[i + 1])) n++;
    return n * 100 <= units;
  }
  if (sample.includes(0)) return false;
  let n = 0;
  for (const c of sample) if (odd(c)) n++;
  return n * 100 <= sample.length;
}

const SCRIPT = {
  shift_jis: c => (c >= 0x3040 && c <= 0x30ff) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xff61 && c <= 0xff9f),
  'euc-jp': c => (c >= 0x3040 && c <= 0x30ff) || (c >= 0x4e00 && c <= 0x9fff),
  gbk: c => c >= 0x4e00 && c <= 0x9fff,
  big5: c => c >= 0x4e00 && c <= 0x9fff,
  'euc-kr': c => c >= 0xac00 && c <= 0xd7a3,
};
const SNIFF = 1 << 20;

/** Bytes that aren't UTF-8 in the legacy encoding they look like (txt.rs `legacy`). */
export function legacy(b) {
  const sample = b.subarray(0, SNIFF);
  let high = 0;
  for (const c of sample) if (c >= 0x80) high++;
  let best = null, bestScore = 0;
  if (high >= 2) {
    for (const [label, inScript] of Object.entries(SCRIPT)) {
      let s;
      try { s = new TextDecoder(label, {fatal: true}).decode(sample.length < b.length ? trimPartial(sample) : sample); } catch { continue; }
      let wide = 0, total = 0;
      for (const ch of s) { const cp = ch.codePointAt(0); if (cp >= 0x80) { total++; if (inScript(cp)) wide++; } }
      const score = total ? wide / total : 0;
      if (total >= 4 && score > bestScore + 0.05) { best = label; bestScore = score; }
    }
  }
  if (best && bestScore >= 0.6) { try { return new TextDecoder(best).decode(b); } catch { /* fall through */ } }
  let out = '';
  for (const c of b) out += cp1252(c);
  return out;
}
const trimPartial = s => s.subarray(0, Math.max(0, s.length - 4));

/** Decode text bytes: BOMs, UTF-16 without BOM, UTF-8, then the legacy encoding they look like. */
export function decode(b) {
  b = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return utf16(b.subarray(2), true);
  if (b[0] === 0xfe && b[1] === 0xff) return utf16(b.subarray(2), false);
  const le = unmarkedUtf16(b);
  if (le !== null) return utf16(b, le);
  try { return new TextDecoder('utf-8', {fatal: true}).decode(b); } catch { return legacy(b); }
}

/** Decode in a named encoding (a WHATWG label); null when the label isn't known. */
export function decodeAs(b, label) {
  try { return new TextDecoder(String(label).trim()).decode(b); } catch { return null; }
}

const isControl = c => { const cp = c.codePointAt(0); return cp < 0x20 || (cp >= 0x7f && cp < 0xa0); };

/** A document with one paragraph per line (txt.rs `import`; `import_on` when `page` is given). */
export function importText(bytes, page = null) {
  const text = decode(bytes).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let clean = '';
  for (const c of text) if (!isControl(c) || c === '\n' || c === '\t' || c === '\u000C') clean += c;
  const content = contentFromText(clean);
  if (page) content.lastSection = page;
  return content;
}

/** formats-v2 contract: schema-2 content read from a .txt file's bytes. */
export function read(bytes, _opts = {}) { return importText(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
