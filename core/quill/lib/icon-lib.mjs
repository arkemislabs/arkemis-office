// Insert › Icons: the library of monochrome pictograms and how one becomes a picture. Translated from wordcraft
// crates/render/src/icon_lib.rs (0.13.1, f2dfa0d): the same ids, names, categories, keywords and path data (icon-data.mjs), the same
// search, the same path language and the same drawing (a 2-unit round-capped, round-joined pen for stroked parts; filled parts are
// convex outlines), rasterised here by a small scanline filler into the PNG picture insert.icon places.
//
// Path data is a small SVG-like language in grid units (24 x 24, y grows downwards), absolute only:
//   M x y move, L x y line (more pairs repeat the line), Q cx cy x y quadratic curve, C c1x c1y c2x c2y x y cubic curve,
//   Z close the subpath; A cx cy r a0 a1 a circular arc from angle a0 to a1 in degrees (0 points right, 90 down), joined to the open
//   subpath by a line or starting one; O cx cy r a whole circle and R x y w h r a rounded rectangle, each its own closed subpath.
//
// The PNG is a palette picture (every entry the ink, the alpha the coverage): one byte a pixel, in stored deflate blocks, so no
// compressor is needed and the pixels are exact.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {ICON_ROWS} from './icon-data.mjs';

export const GRID = 24;
export const STROKE = 2;
/** The categories, in the order the picker shows them. */
export const CATEGORIES = Object.freeze(['Arrows', 'Communication', 'Office', 'People', 'Nature', 'Weather', 'Shapes', 'Symbols', 'Technology', 'Transport']);

/** @typedef {{id: string, name: string, category: string, keywords: string[], parts: string[][]}} Icon  parts: ['S' | 'F', path] */
/** @typedef {{points: number[][], closed: boolean, fill: boolean}} Piece */

/** @type {readonly Icon[]} */
export const ICONS = Object.freeze(ICON_ROWS.map(([id, name, category, keywords, parts]) => Object.freeze({id, name, category, keywords, parts})));

/** The category named `name` (case-insensitive), or null.
 * @param {unknown} name
 * @returns {string | null} */
export const parseCategory = name => CATEGORIES.find(c => c.toLowerCase() === String(name ?? '').trim().toLowerCase()) ?? null;

/** The icon with this id.
 * @param {unknown} id
 * @returns {Icon | null} */
export const findIcon = id => ICONS.find(i => i.id === String(id ?? '').trim()) ?? null;

/** Icons matching every word of `query` (in the id, name, keywords or category, any case) and, when given, in `category`.
 * @param {unknown} query
 * @param {string | null} [category]
 * @returns {Icon[]} */
export function searchIcons(query, category = null) {
  const words = String(query ?? '').split(/\s+/u).filter(Boolean).map(w => w.toLowerCase());
  return ICONS.filter(i => (!category || i.category === category)
    && words.every(w => i.id.includes(w) || i.name.toLowerCase().includes(w) || i.category.toLowerCase().includes(w) || i.keywords.some(k => k.includes(w))));
}

// ---- path data -----------------------------------------------------------------------------------------------

function tokens(d) {
  const out = [];
  const cs = [...String(d)];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (/\s/u.test(c) || c === ',') continue;
    if (/[A-Za-z]/.test(c)) { out.push(c); continue; }
    let text = c;
    while (i + 1 < cs.length && /[0-9.]/.test(cs[i + 1])) text += cs[++i];
    const v = Number(text);
    if (!Number.isFinite(v)) throw new Error(`bad number ${JSON.stringify(text)}`);
    out.push(v);
  }
  return out;
}

const ARGS = {M: 2, L: 2, Q: 4, C: 6, A: 5, R: 5, O: 3, Z: 0};
const rad = deg => (deg * Math.PI) / 180;

/** Flatten path data into polylines: [{points: [[x, y]], closed}] (flatten). Throws on data that does not parse. */
export function flatten(d) {
  const toks = tokens(d);
  const subs = [];
  let cur = [];
  let i = 0;
  let last = null;
  const flush = closed => { if (cur.length >= 2) subs.push({points: cur, closed}); cur = []; };
  while (i < toks.length) {
    let cmd;
    if (typeof toks[i] === 'string') { cmd = toks[i]; i++; }
    else if (last === 'M') cmd = 'L';
    else if (last === 'L' || last === 'Q' || last === 'C') cmd = last;
    else throw new Error('number without a command');
    if (!(cmd in ARGS)) throw new Error(`unknown command ${JSON.stringify(cmd)}`);
    const argc = ARGS[cmd];
    const a = [];
    for (let k = 0; k < argc; k++) {
      if (typeof toks[i] !== 'number') throw new Error(`${cmd} needs ${argc} numbers`);
      a.push(toks[i++]);
    }
    const from = cur[cur.length - 1];
    if (cmd === 'M') { flush(false); cur.push([a[0], a[1]]); }
    else if (cmd === 'L') { if (!from) throw new Error('L without a current point'); cur.push([a[0], a[1]]); }
    else if (cmd === 'Q') {
      if (!from) throw new Error('Q without a current point');
      for (let k = 1; k <= 12; k++) {
        const t = k / 12, u = 1 - t;
        cur.push([u * u * from[0] + 2 * u * t * a[0] + t * t * a[2], u * u * from[1] + 2 * u * t * a[1] + t * t * a[3]]);
      }
    } else if (cmd === 'C') {
      if (!from) throw new Error('C without a current point');
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        const [b0, b1, b2, b3] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        cur.push([b0 * from[0] + b1 * a[0] + b2 * a[2] + b3 * a[4], b0 * from[1] + b1 * a[1] + b2 * a[3] + b3 * a[5]]);
      }
    } else if (cmd === 'A') {
      const [cx, cy, r, a0, a1] = a;
      if (r <= 0 || Math.abs(a1 - a0) > 720) throw new Error('bad arc');
      const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 7.5));
      for (let k = 0; k <= n; k++) { const t = rad(a0 + ((a1 - a0) * k) / n); cur.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
    } else if (cmd === 'O') {
      flush(false);
      const [cx, cy, r] = a;
      if (r <= 0) throw new Error('bad circle');
      subs.push({points: Array.from({length: 48}, (_, k) => [cx + r * Math.cos(rad(k * 7.5)), cy + r * Math.sin(rad(k * 7.5))]), closed: true});
    } else if (cmd === 'R') {
      flush(false);
      const [x, y, w, h] = a;
      if (w <= 0 || h <= 0) throw new Error('bad rectangle');
      const r = Math.min(Math.max(a[4], 0), Math.min(w, h) / 2);
      const pts = [];
      for (const [cx, cy, start] of [[x + w - r, y + r, -90], [x + w - r, y + h - r, 0], [x + r, y + h - r, 90], [x + r, y + r, 180]]) {
        for (let k = 0; k <= 6; k++) { const t = rad(start + 15 * k); pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
      }
      subs.push({points: pts.filter((p, k) => k === 0 || p[0] !== pts[k - 1][0] || p[1] !== pts[k - 1][1]), closed: true});
    } else flush(true);
    last = cmd;
  }
  flush(false);
  return subs;
}

const piecesCache = new Map();
/** The flattened geometry of an icon, parsed once (empty for data that does not parse).
 * @param {Icon} icon
 * @returns {Piece[]} */
export function piecesOf(icon) {
  let got = piecesCache.get(icon.id);
  if (!got) {
    got = [];
    try {
      for (const [kind, d] of icon.parts) for (const s of flatten(d)) got.push({points: s.points, closed: s.closed || kind === 'F', fill: kind === 'F'});
    } catch { got = []; }
    piecesCache.set(icon.id, got);
  }
  return got;
}

// ---- drawing ---------------------------------------------------------------------------------------------------

/** A circle as a polygon. */
const disc = (cx, cy, r, n = 24) => Array.from({length: n}, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n)]);
const area = poly => poly.reduce((s, p, k) => { const q = poly[(k + 1) % poly.length]; return s + (p[0] * q[1] - q[0] * p[1]); }, 0) / 2;

/** The polygons (pixel units, all one orientation so overlapping parts add up) that draw an icon `px` pixels wide. */
function polygonsOf(icon, px) {
  const k = px / GRID;
  const hw = (STROKE / 2) * k;
  const out = [];
  for (const piece of piecesOf(icon)) {
    const pts = piece.points.map(([x, y]) => [x * k, y * k]);
    if (piece.fill) { out.push(pts); continue; }
    const n = pts.length;
    const segs = piece.closed ? n : n - 1;
    for (let s = 0; s < segs; s++) {
      const [a, b] = [pts[s], pts[(s + 1) % n]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-9) continue;
      const nx = (-(b[1] - a[1]) / len) * hw, ny = ((b[0] - a[0]) / len) * hw;
      out.push([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]);
    }
    // Round joins and caps: a disc at every point.
    for (const [x, y] of pts) out.push(disc(x, y, hw));
  }
  return out.map(p => (area(p) < 0 ? p.slice().reverse() : p));
}

const SUB = 8;
/**
 * The coverage of `icon` in a `px` x `px` square: {width, height, alpha} with alpha 0 to 255 a pixel (SUB sample rows a pixel, the
 * exact span along each, nonzero winding so overlapping parts of the pen and filled outlines join).
 */
export function renderIcon(icon, px) {
  const side = Math.max(8, Math.min(4096, Math.round(px)));
  const polys = polygonsOf(icon, side);
  const rows = side * SUB;
  const crossings = Array.from({length: rows}, () => []);
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      let [x0, y0] = poly[i];
      let [x1, y1] = poly[(i + 1) % poly.length];
      if (y0 === y1) continue;
      const dir = y1 > y0 ? 1 : -1;
      if (dir < 0) { [x0, y0, x1, y1] = [x1, y1, x0, y0]; }
      const from = Math.max(0, Math.ceil(y0 * SUB - 0.5));
      const to = Math.min(rows - 1, Math.ceil(y1 * SUB - 0.5) - 1);
      for (let r = from; r <= to; r++) {
        const y = (r + 0.5) / SUB;
        crossings[r].push([x0 + ((x1 - x0) * (y - y0)) / (y1 - y0), dir]);
      }
    }
  }
  const acc = new Float32Array(side * side);
  for (let r = 0; r < rows; r++) {
    const xs = crossings[r];
    if (!xs.length) continue;
    xs.sort((p, q) => p[0] - q[0]);
    const row = Math.floor(r / SUB) * side;
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i][1];
      if (wind === 0) continue;
      const xa = Math.max(0, xs[i][0]), xb = Math.min(side, xs[i + 1][0]);
      if (xb <= xa) continue;
      const ia = Math.floor(xa), ib = Math.min(side - 1, Math.floor(xb));
      if (ia === ib) { acc[row + ia] += xb - xa; continue; }
      acc[row + ia] += ia + 1 - xa;
      for (let x = ia + 1; x < ib; x++) acc[row + x] += 1;
      acc[row + ib] += xb - ib;
    }
  }
  const alpha = new Uint8Array(side * side);
  for (let i = 0; i < alpha.length; i++) alpha[i] = Math.max(0, Math.min(255, Math.round((acc[i] / SUB) * 255)));
  return {width: side, height: side, alpha};
}

// ---- PNG -------------------------------------------------------------------------------------------------------

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
const be32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function chunk(type, data) {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  out.set(be32(data.length), 0);
  out.set(body, 4);
  out.set(be32(crc32(body)), 8 + data.length);
  return out;
}

/** zlib data holding `raw` in stored (uncompressed) deflate blocks. */
function zlibStored(raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const part = raw.subarray(b * 65535, Math.min(raw.length, (b + 1) * 65535));
    out[o++] = b === blocks - 1 ? 1 : 0;
    out[o++] = part.length & 255; out[o++] = part.length >>> 8;
    out[o++] = ~part.length & 255; out[o++] = (~part.length >>> 8) & 255;
    out.set(part, o); o += part.length;
  }
  out.set(be32(adler32(raw)), o);
  return out;
}

/** The PNG of an icon `px` pixels square in `ink` ([r, g, b]): a palette picture whose alpha is the coverage. */
export function iconPng(icon, px, ink = [0, 0, 0]) {
  const {width, height, alpha} = renderIcon(icon, px);
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(alpha.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const plte = new Uint8Array(768);
  for (let i = 0; i < 256; i++) { plte[i * 3] = ink[0]; plte[i * 3 + 1] = ink[1]; plte[i * 3 + 2] = ink[2]; }
  const trns = Uint8Array.from({length: 256}, (_, i) => i);
  const ihdr = Uint8Array.from([...be32(width), ...be32(height), 8, 3, 0, 0, 0]);
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', trns), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { png.set(p, o); o += p.length; }
  return png;
}
