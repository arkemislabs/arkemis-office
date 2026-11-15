// Typed signatures: a line of text in the script face as filled outlines, and its placement on a
// page as Fill & Sign does it.
//
// Translated from printcraft crates/fonts/src/script.rs (MAX_SIGNATURE_CHARS, ScriptOutline and
// its bounds, Flatten with STEPS = 8, script_outline) and crates/engine/src/fill_sign.rs
// (typed_signature_shape, typed_signature_graphic) at 3109bb2359759e24ef490e1cdbdba00722b20972.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Upstream draws the glyphs with skrifa; here a small TrueType reader (cmap formats 4 and 12,
// head, hhea, hmtx, loca, glyf with composite glyphs) draws the default instance of the bundled
// Dancing Script (lib/sign-script-font.mjs). Not translated: the Inter fallback face for letters
// the script lacks (Cyrillic, Greek): such letters are left out, and `scriptMissing` names the
// first one so the dialog can say so. No DOM, no Node built-ins.

import {DANCING_SCRIPT_BASE64} from './sign-script-font.mjs';
import {viewMatrixFor} from './geom.mjs';
import {uprightBox} from './comment-geometry.mjs';

/** script.rs `MAX_SIGNATURE_CHARS`. */
export const MAX_SIGNATURE_CHARS = 256;
const STEPS = 8;
const MAX_POINTS = 262_144;

let face = null;

function decode(b64) {
  const s = globalThis.atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The bundled face, parsed once. */
function font() {
  if (face) return face;
  const b = decode(DANCING_SCRIPT_BASE64);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tables = {};
  const n = v.getUint16(4);
  for (let i = 0; i < n; i++) {
    const o = 12 + 16 * i;
    tables[String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])] = {off: v.getUint32(o + 8), len: v.getUint32(o + 12)};
  }
  const head = tables.head.off, hhea = tables.hhea.off, maxp = tables.maxp.off;
  const upem = v.getUint16(head + 18), longLoca = v.getInt16(head + 50) === 1;
  const numGlyphs = v.getUint16(maxp + 4), numMetrics = v.getUint16(hhea + 34);
  const ascent = v.getInt16(hhea + 4), descent = v.getInt16(hhea + 6);
  const os2 = tables['OS/2'];
  const capHeight = os2 && v.getUint16(os2.off) >= 2 ? v.getInt16(os2.off + 88) : null;
  const loca = i => (longLoca ? v.getUint32(tables.loca.off + 4 * i) : 2 * v.getUint16(tables.loca.off + 2 * i));
  const advance = gid => v.getUint16(tables.hmtx.off + 4 * Math.min(gid, numMetrics - 1));
  // cmap: a Unicode subtable, format 12 preferred, else 4.
  const cmap = tables.cmap.off;
  let f4 = null, f12 = null;
  for (let i = 0, count = v.getUint16(cmap + 2); i < count; i++) {
    const pid = v.getUint16(cmap + 4 + 8 * i), eid = v.getUint16(cmap + 6 + 8 * i), off = cmap + v.getUint32(cmap + 8 + 8 * i);
    if (!(pid === 0 || (pid === 3 && (eid === 1 || eid === 10)))) continue;
    const format = v.getUint16(off);
    if (format === 12) f12 = off; else if (format === 4) f4 = off;
  }
  const glyphOf = cp => {
    if (f12 !== null) {
      for (let i = 0, groups = v.getUint32(f12 + 12); i < groups; i++) {
        const g = f12 + 16 + 12 * i, start = v.getUint32(g), end = v.getUint32(g + 4);
        if (cp >= start && cp <= end) return v.getUint32(g + 8) + (cp - start);
      }
      return 0;
    }
    if (f4 === null || cp > 0xffff) return 0;
    const segX2 = v.getUint16(f4 + 6), ends = f4 + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let i = 0; i < segX2 / 2; i++) {
      if (cp > v.getUint16(ends + 2 * i)) continue;
      const start = v.getUint16(starts + 2 * i);
      if (cp < start) return 0;
      const delta = v.getInt16(deltas + 2 * i), ro = v.getUint16(ranges + 2 * i);
      if (!ro) return (cp + delta) & 0xffff;
      const at = ranges + 2 * i + ro + 2 * (cp - start);
      const g = v.getUint16(at);
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };
  face = {b, v, glyf: tables.glyf.off, loca, numGlyphs, upem, ascent, descent, capHeight, advance, glyphOf};
  return face;
}

/** The pen (script.rs `Flatten`): curves flattened in STEPS straight pieces, a contour closed when it has three points. */
class Flatten {
  constructor(scale) { Object.assign(this, {contours: [], cur: [], scale, dx: 0, points: 0, tooComplex: false}); }
  pt(x, y) { return [this.dx + x * this.scale, y * this.scale]; }
  last() { return this.cur.length ? this.cur[this.cur.length - 1] : [this.dx, 0]; }
  push(p) { if (this.points >= MAX_POINTS) { this.tooComplex = true; return; } this.points++; this.cur.push(p); }
  close() { if (this.cur.length > 2) this.contours.push(this.cur); this.cur = []; }
  moveTo(x, y) { this.close(); this.push(this.pt(x, y)); }
  lineTo(x, y) { this.push(this.pt(x, y)); }
  quadTo(cx, cy, x, y) {
    const p0 = this.last(), c = this.pt(cx, cy), p = this.pt(x, y);
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS, u = 1 - t;
      this.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p[1]]);
    }
  }
}

/** One glyph's contours in font units, transformed by `m` [a b c d e f] (composites). */
function glyphContours(f, gid, m = [1, 0, 0, 1, 0, 0], depth = 0) {
  if (gid >= f.numGlyphs || depth > 8) return [];
  const start = f.loca(gid), end = f.loca(gid + 1);
  if (end <= start) return [];
  const {v} = f;
  const o = f.glyf + start;
  const nc = v.getInt16(o);
  const tf = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  if (nc >= 0) {
    const endPts = [];
    for (let i = 0; i < nc; i++) endPts.push(v.getUint16(o + 10 + 2 * i));
    const n = nc ? endPts[nc - 1] + 1 : 0;
    let p = o + 10 + 2 * nc;
    p += 2 + v.getUint16(p);
    const flags = [];
    while (flags.length < n) {
      const fl = f.b[p++];
      flags.push(fl);
      if (fl & 8) { let r = f.b[p++]; while (r-- > 0 && flags.length < n) flags.push(fl); }
    }
    const xs = [], ys = [];
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) {
      const fl = flags[i];
      if (fl & 2) { const d = f.b[p++]; x += fl & 16 ? d : -d; } else if (!(fl & 16)) { x += v.getInt16(p); p += 2; }
      xs.push(x);
    }
    for (let i = 0; i < n; i++) {
      const fl = flags[i];
      if (fl & 4) { const d = f.b[p++]; y += fl & 32 ? d : -d; } else if (!(fl & 32)) { y += v.getInt16(p); p += 2; }
      ys.push(y);
    }
    const out = [];
    let s = 0;
    for (const e of endPts) {
      const pts = [];
      for (let i = s; i <= e; i++) pts.push({p: tf(xs[i], ys[i]), on: (flags[i] & 1) === 1});
      s = e + 1;
      out.push(pts);
    }
    return out;
  }
  // Composite.
  const out = [];
  let p = o + 10, more = true;
  while (more) {
    const fl = v.getUint16(p), comp = v.getUint16(p + 2);
    p += 4;
    let dx, dy;
    if (fl & 1) { dx = v.getInt16(p); dy = v.getInt16(p + 2); p += 4; } else { dx = v.getInt8(p); dy = v.getInt8(p + 1); p += 2; }
    let a = 1, b = 0, c = 0, d = 1;
    const f2 = q => v.getInt16(q) / 16384;
    if (fl & 8) { a = d = f2(p); p += 2; } else if (fl & 0x40) { a = f2(p); d = f2(p + 2); p += 4; } else if (fl & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
    if (!(fl & 2)) { dx = 0; dy = 0; }   // point matching is not used by this face
    const inner = [a, b, c, d, dx, dy];
    const mm = [m[0] * inner[0] + m[2] * inner[1], m[1] * inner[0] + m[3] * inner[1], m[0] * inner[2] + m[2] * inner[3], m[1] * inner[2] + m[3] * inner[3],
      m[0] * inner[4] + m[2] * inner[5] + m[4], m[1] * inner[4] + m[3] * inner[5] + m[5]];
    out.push(...glyphContours(f, comp, mm, depth + 1));
    more = (fl & 0x20) !== 0;
  }
  return out;
}

/** Draw TrueType contours (on/off-curve quadratic points) with the pen. */
function drawContours(pen, contours) {
  for (const pts of contours) {
    if (!pts.length) continue;
    // Start on an on-curve point (or the midpoint of two off-curve ones).
    let first = pts.findIndex(q => q.on);
    let start;
    if (first < 0) { start = [(pts[0].p[0] + pts[1 % pts.length].p[0]) / 2, (pts[0].p[1] + pts[1 % pts.length].p[1]) / 2]; first = 0; } else start = pts[first].p;
    pen.moveTo(start[0], start[1]);
    let ctrl = null;
    for (let k = 1; k <= pts.length; k++) {
      const q = pts[(first + k) % pts.length];
      const target = k === pts.length ? {p: start, on: true} : q;
      if (target.on) {
        if (ctrl) pen.quadTo(ctrl[0], ctrl[1], target.p[0], target.p[1]); else pen.lineTo(target.p[0], target.p[1]);
        ctrl = null;
      } else if (ctrl) {
        const mid = [(ctrl[0] + target.p[0]) / 2, (ctrl[1] + target.p[1]) / 2];
        pen.quadTo(ctrl[0], ctrl[1], mid[0], mid[1]);
        ctrl = target.p;
      } else ctrl = target.p;
    }
    pen.close();
  }
}

/** script.rs `ScriptOutline::bounds`: layout bounds including overhangs. */
export function outlineBounds(o) {
  const b = [0, o.descent, o.width, o.ascent];
  for (const c of o.contours) for (const p of c) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }
  return b;
}

/** script.rs `script_outline`: `text` at a font size of 1 (em units), baseline at y = 0. */
export function scriptOutline(text) {
  const empty = {contours: [], width: 0, ascent: 0, descent: 0};
  const chars = Array.from(String(text));
  if (chars.length > MAX_SIGNATURE_CHARS) return empty;
  const f = font();
  const scale = 1 / Math.max(1, f.upem);
  const pen = new Flatten(scale);
  for (const ch of chars) {
    const gid = f.glyphOf(ch.codePointAt(0));
    if (!gid) continue;
    drawContours(pen, glyphContours(f, gid));
    pen.dx += f.advance(gid) * scale;
  }
  pen.close();
  if (pen.tooComplex) return empty;
  return {contours: pen.contours, width: pen.dx, ascent: f.ascent * scale, descent: f.descent * scale};
}

/** script.rs `script_missing`: the first letter the face can't draw (no fallback face here). */
export function scriptMissing(text) {
  const f = font();
  for (const ch of String(text)) if (!/\s/.test(ch) && !f.glyphOf(ch.codePointAt(0))) return ch;
  return null;
}

/**
 * fill_sign.rs `typed_signature_shape`: `text` as a typed signature, its displayed left edge at
 * `at` (user space, vertically centred), `height` points tall, upright on a page turned by
 * `rotation`. null for text with no outlines.
 */
export function typedSignatureShape(at, text, height, rotation) {
  const o = scriptOutline(text);
  const [left, bottom, right, top] = outlineBounds(o);
  const span = Math.max(top - bottom, 0.1), width = right - left;
  if (!o.contours.length || o.width <= 0 || !(width > 0 && height > 0)) return null;
  const k = height / span;
  const rect = uprightBox(rotation, at, width * k, height);
  if (!rect) return null;
  const [a, b, c, d] = viewMatrixFor(rotation, [0, 0, 0, 0]);
  const toUser = (nx, ny) => [a * nx + c * ny + Math.max(-a, 0) + Math.max(-c, 0), b * nx + d * ny + Math.max(-b, 0) + Math.max(-d, 0)];
  const contours = o.contours.map(cn => cn.map(p => toUser((p[0] - left) / width, (p[1] - bottom) / span)));
  return {kind: 'TypedSignature', rect, contours};
}

/** fill_sign.rs `place` (Typed): the height of a typed signature or initials, kept within a 150 pt width. */
export function typedHeight(text, initials) {
  const [left, bottom, right, top] = outlineBounds(scriptOutline(text));
  const h = initials ? 24 : 32;
  return Math.min(h, 150 * Math.max(top - bottom, 0.1) / Math.max(right - left, 0.01));
}

/** fill_sign.rs `typed_signature_graphic`: the outlines as a digital signature's graphic. */
export function typedSignatureGraphic(text) {
  const o = scriptOutline(text);
  return o.contours.some(c => c.length > 2) ? {outlines: o.contours} : null;
}
