// DER/BER reading and DER writing for digital signatures.
//
// Translated from printcraft crates/sign/src/der.rs (tag, Form, Tlv::read/parse/parse_ber/
// parse_all/children/inner/octets/oid/u64/uint_bytes/bits/text/time, contents_len, Time
// from_pdf/to_pdf/unix/from_unix/encode/Display, oid_to_string, tlv, seq, set_of, explicit, oid,
// uint, int, octets, bit_string, null, utf8, printable, ia5, boolean, algorithm) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Bytes are Uint8Array; a Tlv's `value` and `raw` are subarrays of its input (no copies).
// No DOM, no Node built-ins.

export class SignError extends Error {
  /** @param {'malformed'|'unsupported'|'wrong_password'|'crypto'|'pdf'} kind */
  constructor(kind, message) { super(message); this.name = 'SignError'; this.kind = kind; }
}
export const bad = what => new SignError('malformed', what);
export const unsupported = what => new SignError('unsupported', `not supported: ${what}`);

export const tag = Object.freeze({
  BOOLEAN: 0x01, INTEGER: 0x02, BIT_STRING: 0x03, OCTET_STRING: 0x04, OCTET_STRING_SEGMENTS: 0x24, NULL: 0x05, OID: 0x06,
  UTF8_STRING: 0x0c, PRINTABLE_STRING: 0x13, T61_STRING: 0x14, IA5_STRING: 0x16, UTC_TIME: 0x17, GENERALIZED_TIME: 0x18,
  BMP_STRING: 0x1e, SEQUENCE: 0x30, SET: 0x31,
  ctx: n => 0xa0 | n, ctxPrim: n => 0x80 | n,
});

const DER = 'der', BER = 'ber';

/** One BER/DER element. */
export class Tlv {
  constructor(t, value, raw, form) { this.tag = t; this.value = value; this.raw = raw; this.form = form; }

  /** One DER element at the start of `input`: [tlv, rest]. */
  static parse(input) { return Tlv.read(input, DER, 0); }
  static parseBer(input) { return Tlv.read(input, BER, 0); }
  static parseAll(input) { return Tlv.only(input, DER); }
  static parseAllBer(input) { return Tlv.only(input, BER); }

  static read(input, form, depth) {
    if (input.length < 1) throw bad('truncated DER');
    const t = input[0];
    if ((t & 0x1f) === 0x1f) throw bad('multi-byte DER tags are not supported');
    if (input.length < 2) throw bad('truncated DER length');
    const first = input[1];
    let len, at = 2, trailer = 0;
    if (first < 0x80) len = first;
    else if (first === 0x80) {
      if (form === DER) throw bad('indefinite lengths are not allowed in DER');
      if ((t & 0x20) === 0) throw bad('an indefinite length needs a constructed element');
      len = contentsLen(input.subarray(2), form, depth);
      trailer = 2;
    } else {
      const n = first & 0x7f;
      if (n > 4 || input.length < 2 + n) throw bad('unsupported DER length');
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + input[2 + i];
      at = 2 + n;
    }
    const end = len + trailer;
    if (input.length - at < end) throw bad('DER element runs past the end');
    return [new Tlv(t, input.subarray(at, at + len), input.subarray(0, at + end), form), input.subarray(at + end)];
  }

  static only(input, form) {
    const [t, rest] = Tlv.read(input, form, 0);
    if (rest.length) throw bad('trailing bytes after DER element');
    return t;
  }

  isIndefinite() { return this.raw[1] === 0x80; }

  children() {
    const out = [];
    let rest = this.value;
    while (rest.length) { const [t, r] = Tlv.read(rest, this.form, 0); out.push(t); rest = r; }
    return out;
  }

  expect(t, what) {
    if (this.tag !== t) throw bad(`${what}: expected tag 0x${t.toString(16).padStart(2, '0')}, found 0x${this.tag.toString(16).padStart(2, '0')}`);
    return this;
  }

  inner() { return Tlv.only(this.value, this.form); }

  octets(what) { return this.join(what, 0); }

  join(what, depth) {
    if (this.tag === tag.OCTET_STRING) return this.value;
    if (this.tag === tag.OCTET_STRING_SEGMENTS && this.form === BER) {
      if (depth >= 16) throw bad(`${what}: OCTET STRING segments nested too deeply`);
      return concat(this.children().map(s => s.join(what, depth + 1)));
    }
    throw bad(`${what}: expected an OCTET STRING, found tag 0x${this.tag.toString(16).padStart(2, '0')}`);
  }

  oid() {
    if (this.tag !== tag.OID) throw bad('expected an OID');
    return oidToString(this.value);
  }

  /** A non-negative INTEGER that fits in a safe integer. */
  u64() {
    const v = this.value;
    if (this.tag !== tag.INTEGER || !v.length || v.length > 9 || (v[0] & 0x80)) throw bad('expected a small non-negative INTEGER');
    let n = 0;
    for (const b of v) n = n * 256 + b;
    if (!Number.isSafeInteger(n)) throw bad('expected a small non-negative INTEGER');
    return n;
  }

  uintBytes() { const v = this.value; return v.length > 1 && v[0] === 0 ? v.subarray(1) : v; }

  bits() {
    if (this.tag !== tag.BIT_STRING || this.value[0] !== 0) throw bad('expected a whole-byte BIT STRING');
    return this.value.subarray(1);
  }

  text() {
    const v = this.value;
    switch (this.tag) {
      case tag.UTF8_STRING: case tag.PRINTABLE_STRING: case tag.IA5_STRING: return new TextDecoder('utf-8').decode(v);
      case tag.T61_STRING: return String.fromCharCode(...v);
      case tag.BMP_STRING: { let s = ''; for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode((v[i] << 8) | v[i + 1]); return s; }
      default: return null;
    }
  }

  time() {
    let s = latin1(this.value);
    if (!s.endsWith('Z')) throw bad('times must be in UTC (Z)');
    s = s.slice(0, -1);
    const num = (a, b) => { const x = s.slice(a, b); if (x.length !== b - a || !/^\d+$/.test(x)) throw bad('time'); return Number(x); };
    let year, rest;
    if (this.tag === tag.UTC_TIME) { const y = num(0, 2); year = y >= 50 ? 1900 + y : 2000 + y; rest = 2; }
    else if (this.tag === tag.GENERALIZED_TIME) { year = num(0, 4); rest = 4; }
    else throw bad('expected a time');
    return new Time(year, num(rest, rest + 2), num(rest + 2, rest + 4), num(rest + 4, rest + 6), num(rest + 6, rest + 8),
      s.length >= rest + 10 ? num(rest + 8, rest + 10) : 0);
  }
}

function contentsLen(input, form, depth) {
  if (depth >= 48) throw bad('BER elements nested too deeply');
  let rest = input;
  for (;;) {
    if (!rest.length) throw bad('an indefinite length with no end-of-contents');
    if (rest.length >= 2 && rest[0] === 0 && rest[1] === 0) return input.length - rest.length;
    rest = Tlv.read(rest, form, depth + 1)[1];
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** A UTC time (der.rs `Time`). */
export class Time {
  constructor(year, month, day, hour = 0, minute = 0, second = 0) { Object.assign(this, {year, month, day, hour, minute, second}); }

  /** From a PDF date (`D:YYYYMMDDHHmmSS±HH'mm'`), converted to UTC. */
  static fromPdf(s) {
    s = String(s ?? '');
    if (s.startsWith('D:')) s = s.slice(2);
    const d = (a, b, def) => { const x = s.slice(a, b); if (!x) return def; return /^\d+$/.test(x) ? Number(x) : NaN; };
    const parts = [d(0, 4, 0), d(4, 6, 1), d(6, 8, 1), d(8, 10, 0), d(10, 12, 0), d(12, 14, 0)];
    if (parts.some(Number.isNaN) || parts[0] === 0) return null;
    let t = new Time(...parts);
    const tz = s.slice(14);
    const sign = tz[0] === '+' ? -1 : tz[0] === '-' ? 1 : 0;
    if (sign) {
      const h = Number(tz.slice(1, 3)) || 0, m = Number(tz.slice(4, 6)) || 0;
      t = t.addSeconds(sign * (h * 3600 + m * 60));
    }
    return t;
  }

  toPdf() { return `D:${pad(this.year, 4)}${pad(this.month)}${pad(this.day)}${pad(this.hour)}${pad(this.minute)}${pad(this.second)}Z`; }
  unix() { return Math.floor(Date.UTC(this.year, this.month - 1, this.day, this.hour, this.minute, this.second) / 1000); }
  static fromUnix(t) {
    const d = new Date(t * 1000);
    return new Time(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  }
  addSeconds(s) { return Time.fromUnix(this.unix() + s); }
  compare(o) { return this.unix() - o.unix(); }

  /** UTCTime before 2050, GeneralizedTime from then on (RFC 5280 §4.1.2.5). */
  encode() {
    const body = `${pad(this.month)}${pad(this.day)}${pad(this.hour)}${pad(this.minute)}${pad(this.second)}Z`;
    if (this.year >= 1950 && this.year < 2050) return tlv(tag.UTC_TIME, ascii(`${pad(this.year % 100)}${body}`));
    return tlv(tag.GENERALIZED_TIME, ascii(`${pad(this.year, 4)}${body}`));
  }

  toString() { return `${pad(this.year, 4)}.${pad(this.month)}.${pad(this.day)} ${pad(this.hour)}:${pad(this.minute)}:${pad(this.second)} UTC`; }
}

function oidToString(v) {
  const arcs = [];
  let acc = 0n;
  for (let i = 0; i < v.length; i++) {
    const b = v[i];
    acc = (acc << 7n) | BigInt(b & 0x7f);
    if (!(b & 0x80)) {
      if (!arcs.length) { const first = acc / 40n > 2n ? 2n : acc / 40n; arcs.push(first, acc - first * 40n); } else arcs.push(acc);
      acc = 0n;
    } else if (i + 1 === v.length) throw bad('truncated OID');
  }
  return arcs.map(String).join('.');
}

// ── writing ─────────────────────────────────────────────────────────────────────────────────

export const ascii = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
export const latin1 = b => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };
export const utf8Bytes = s => new TextEncoder().encode(s);

/** Concatenate byte arrays. */
export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function tlv(t, value) {
  const n = value.length;
  let head;
  if (n < 0x80) head = [t, n];
  else { const bytes = []; for (let x = n; x > 0; x = Math.floor(x / 256)) bytes.unshift(x & 0xff); head = [t, 0x80 | bytes.length, ...bytes]; }
  const out = new Uint8Array(head.length + n);
  out.set(head, 0);
  out.set(value, head.length);
  return out;
}

export const seq = parts => tlv(tag.SEQUENCE, concat(parts));

const compareBytes = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };
/** A SET OF, in DER order (sorted encodings, X.690 §11.6). */
export const setOf = parts => tlv(tag.SET, concat([...parts].sort(compareBytes)));
export const explicit = (n, inner) => tlv(tag.ctx(n), inner);

export function oid(dotted) {
  const arcs = String(dotted).split('.').map(a => { if (!/^\d+$/.test(a)) throw bad('invalid OID arc'); return BigInt(a); });
  if (arcs.length < 2 || arcs[0] > 2n || (arcs[0] < 2n && arcs[1] >= 40n)) throw bad('invalid OID prefix');
  const body = [];
  const push = v => { const tmp = [Number(v & 0x7fn)]; v >>= 7n; while (v > 0n) { tmp.push(0x80 | Number(v & 0x7fn)); v >>= 7n; } body.push(...tmp.reverse()); };
  push(arcs[0] * 40n + arcs[1]);
  for (const a of arcs.slice(2)) push(a);
  return tlv(tag.OID, Uint8Array.from(body));
}

export function uint(bytes) {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  const b = i === bytes.length ? Uint8Array.of(0) : bytes.subarray(i);
  return b[0] & 0x80 ? tlv(tag.INTEGER, concat([Uint8Array.of(0), b])) : tlv(tag.INTEGER, b);
}

export function int(n) {
  const bytes = [];
  let x = BigInt(n);
  do { bytes.unshift(Number(x & 0xffn)); x >>= 8n; } while (x > 0n);
  return uint(Uint8Array.from(bytes));
}

export const octets = b => tlv(tag.OCTET_STRING, b);
export const bitString = b => tlv(tag.BIT_STRING, concat([Uint8Array.of(0), b]));
export const nul = () => Uint8Array.of(tag.NULL, 0);
export const utf8 = s => tlv(tag.UTF8_STRING, utf8Bytes(s));
export const printable = s => tlv(tag.PRINTABLE_STRING, ascii(s));
export const ia5 = s => tlv(tag.IA5_STRING, ascii(s));
export const boolean = b => tlv(tag.BOOLEAN, Uint8Array.of(b ? 0xff : 0));
export const algorithm = (o, params = null) => (params ? seq([oid(o), params]) : seq([oid(o)]));

/** Hex (upper case) of bytes. */
export const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
export function fromHex(s) {
  const d = String(s).replace(/\s+/g, '');
  if (d.length % 2 || /[^0-9a-f]/i.test(d)) return null;
  const out = new Uint8Array(d.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(d.slice(2 * i, 2 * i + 2), 16);
  return out;
}
export const equalBytes = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

export function toBase64(b) {
  if (typeof btoa === 'function') return btoa(latin1(b));
  return globalThis.Buffer.from(b).toString('base64');
}
export function fromBase64(s) {
  if (typeof atob === 'function') return ascii(atob(String(s)));
  return new Uint8Array(globalThis.Buffer.from(String(s), 'base64'));
}
