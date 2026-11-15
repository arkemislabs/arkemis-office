// The content interpreter that applies (or verifies) redaction on one content scope: a page's content
// or a form XObject's.
//
// It tracks just enough graphics state to place every glyph, image and path in user space: the CTM
// stack, the text state (font, size, spacing, scaling, rise, leading) and the text matrices. In apply
// mode it rewrites the operators:
//   text    glyphs whose boxes overlap a region are cut out of Tj / TJ / ' / ", replaced by a TJ
//           displacement of the same width so the rest of the line stays exactly where it was;
//   images  fully covered: the Do is removed; partly covered: the covered pixels are cleared in a copy
//           of the image (or the image is removed when it cannot be re-encoded here); inline images
//           under a region are removed;
//   vectors fully covered paths are removed; partly covered ones are clipped so nothing shows inside
//           the regions; shadings are clipped the same way;
//   forms   form XObjects under a region are rewritten recursively into new objects (copy on write,
//           so other pages using the original are untouched).
// In verify mode nothing changes; glyphs and inline images that still overlap a region are counted.
//
// Translated from printcraft crates/redact/src/interp.rs (Scope::glyph_hit, process, Walk::step, show,
// path handling, clip_out), image.rs (clear covered pixels) and lib.rs (redact_page_content, the
// verification pass) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. Not translated: optional content (layers) rules
// beyond Remove hidden information's, structure-tree cleaning, Type 3 glyph tables, and clearing the
// pixels of images with a mask (those are removed whole). No DOM, no Node built-ins.

import {PDFName, PDFNumber, PDFArray, PDFDict, PDFRef, PDFStream, PDFRawStream, PDFString, PDFHexString, decodePDFRawStream} from 'pdf-lib';
import {fontWidth} from './fonts.mjs';

export class RedactError extends Error {
  constructor(code, message) { super(message); this.name = 'RedactError'; this.code = code; }
}

/** How deep forms are followed; deeper ones are removed (fail closed). */
export const MAX_DEPTH = 50;
const MAX_FORMS = 20000;

// ── content stream syntax ──────────────────────────────────────────────────────────────────────

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isReg = b => !WS.has(b) && !DELIM.has(b);
const hexVal = c => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);

/** Parse content stream bytes into operators: [{op, args}] with inline images as {op: 'BI', dict, data}. */
export function parseContent(data) {
  let p = 0;
  const n = data.length;
  const ops = [];
  const skipWs = () => {
    while (p < n) {
      if (WS.has(data[p])) p++;
      else if (data[p] === 0x25) { while (p < n && data[p] !== 10 && data[p] !== 13) p++; } else break;
    }
  };
  const literal = () => {
    p++;
    const out = [];
    let depth = 1;
    while (p < n && depth) {
      const c = data[p++];
      if (c === 0x5c) {
        const e = data[p++];
        if (e === 0x6e) out.push(10); else if (e === 0x72) out.push(13); else if (e === 0x74) out.push(9); else if (e === 0x62) out.push(8); else if (e === 0x66) out.push(12);
        else if (e >= 48 && e <= 55) { let v = e - 48; for (let k = 0; k < 2 && data[p] >= 48 && data[p] <= 55; k++) v = v * 8 + data[p++] - 48; out.push(v & 255); }
        else if (e === 13) { if (data[p] === 10) p++; } else if (e === 10) { /* line continuation */ } else if (e !== undefined) out.push(e);
      } else if (c === 0x28) { depth++; out.push(c); }
      else if (c === 0x29) { depth--; if (depth) out.push(c); }
      else out.push(c);
    }
    return {k: 'str', b: Uint8Array.from(out)};
  };
  const hexString = () => {
    p++;
    const out = [];
    let hi = -1;
    while (p < n && data[p] !== 0x3e) {
      const v = hexVal(data[p++]);
      if (v < 0) continue;
      if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
    }
    if (hi >= 0) out.push(hi * 16);
    p++;
    return {k: 'str', b: Uint8Array.from(out)};
  };
  const nameTok = () => {
    p++;
    let s = '';
    while (p < n && isReg(data[p])) {
      if (data[p] === 0x23 && hexVal(data[p + 1]) >= 0 && hexVal(data[p + 2]) >= 0) { s += String.fromCharCode(hexVal(data[p + 1]) * 16 + hexVal(data[p + 2])); p += 3; }
      else s += String.fromCharCode(data[p++]);
    }
    return {k: 'name', v: s};
  };
  const operand = () => {
    skipWs();
    if (p >= n) return null;
    const c = data[p];
    if (c === 0x28) return literal();
    if (c === 0x3c) {
      if (data[p + 1] === 0x3c) {
        p += 2;
        const entries = [];
        for (;;) {
          skipWs();
          if (p >= n) break;
          if (data[p] === 0x3e && data[p + 1] === 0x3e) { p += 2; break; }
          if (data[p] !== 0x2f) { p++; continue; }
          const key = nameTok();
          const val = operand();
          entries.push([key.v, val]);
        }
        return {k: 'dict', entries};
      }
      return hexString();
    }
    if (c === 0x5b) {
      p++;
      const items = [];
      for (;;) {
        skipWs();
        if (p >= n) break;
        if (data[p] === 0x5d) { p++; break; }
        const x = operand();
        if (x === null) break;
        if (x.k === 'op') continue;
        items.push(x);
      }
      return {k: 'arr', a: items};
    }
    if (c === 0x2f) return nameTok();
    if (c === 0x29 || c === 0x3e || c === 0x5d || c === 0x7b || c === 0x7d) { p++; return operand(); }
    let q = p;
    while (q < n && isReg(data[q])) q++;
    const tok = String.fromCharCode(...data.subarray(p, q));
    p = q;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) return {k: 'num', v: Number(tok)};
    if (tok === 'true' || tok === 'false' || tok === 'null') return {k: 'lit', v: tok};
    return {k: 'op', v: tok};
  };
  let args = [];
  for (;;) {
    const x = operand();
    if (x === null) break;
    if (x.k !== 'op') { args.push(x); continue; }
    if (x.v === 'BI') {
      const dict = [];
      for (;;) {
        skipWs();
        if (p >= n) break;
        if (data[p] === 0x2f) { const key = nameTok(); dict.push([key.v, operand()]); continue; }
        let q = p;
        while (q < n && isReg(data[q])) q++;
        const kw = String.fromCharCode(...data.subarray(p, q));
        p = q;
        if (kw === 'ID') break;
      }
      if (p < n && WS.has(data[p])) p++;
      const start = p;
      let end = n;
      for (let q = start; q < n - 1; q++) {
        if (data[q] === 0x45 && data[q + 1] === 0x49 && (q === start || WS.has(data[q - 1])) && (q + 2 >= n || WS.has(data[q + 2]) || DELIM.has(data[q + 2]))) { end = q; p = q + 2; break; }
      }
      if (end === n) p = n;
      ops.push({op: 'BI', args: [], dict, data: data.slice(start, end)});
      args = [];
      continue;
    }
    ops.push({op: x.v, args});
    args = [];
  }
  return ops;
}

const fmt = v => {
  if (Number.isInteger(v)) return String(v);
  const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};
const hexOf = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const nameOut = v => `/${Array.from(v).map(c => (/[A-Za-z0-9_.+-]/.test(c) ? c : `#${c.charCodeAt(0).toString(16).padStart(2, '0')}`)).join('')}`;

function argOut(a) {
  switch (a.k) {
    case 'num': return fmt(a.v);
    case 'str': return a.b.every(x => x >= 0x20 && x <= 0x7e) ? `(${Array.from(a.b, x => String.fromCharCode(x)).join('').replace(/[\\()]/g, '\\$&')})` : `<${hexOf(a.b)}>`;
    case 'name': return nameOut(a.v);
    case 'arr': return `[${a.a.map(argOut).join(' ')}]`;
    case 'dict': return `<<${a.entries.map(([k, v]) => `${nameOut(k)} ${v ? argOut(v) : 'null'}`).join(' ')}>>`;
    default: return String(a.v);
  }
}

/** Serialize operators back to content stream bytes. */
export function serializeContent(ops) {
  const parts = [];
  const enc = new TextEncoder();
  for (const o of ops) {
    if (o.op === 'BI') {
      parts.push(enc.encode(`BI ${o.dict.map(([k, v]) => `${nameOut(k)} ${v ? argOut(v) : 'null'}`).join(' ')} ID `), o.data, enc.encode('\nEI\n'));
    } else parts.push(enc.encode(`${o.args.map(argOut).join(' ')}${o.args.length ? ' ' : ''}${o.op}\n`));
  }
  const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let at = 0;
  for (const x of parts) { out.set(x, at); at += x.length; }
  return out;
}

// ── geometry ───────────────────────────────────────────────────────────────────────────────────

const ID = [1, 0, 0, 1, 0, 0];
const mul = (m, c) => [m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3], m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3], m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5]];
const at = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const bboxOfPoints = pts => [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
const boxUnder = (m, r) => bboxOfPoints([at(m, r[0], r[1]), at(m, r[2], r[1]), at(m, r[0], r[3]), at(m, r[2], r[3])]);
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
const overlaps = (a, b, tol = 0) => a[0] < b[2] + tol && b[0] < a[2] + tol && a[1] < b[3] + tol && b[1] < a[3] + tol;
const contains = (outer, inner, tol = 0) => inner[0] >= outer[0] - tol && inner[1] >= outer[1] - tol && inner[2] <= outer[2] + tol && inner[3] <= outer[3] + tol;

// ── fonts ──────────────────────────────────────────────────────────────────────────────────────

const nameOf = v => (v instanceof PDFName ? v.decodeText() : undefined);
const numOf = v => (v instanceof PDFNumber ? v.asNumber() : undefined);

/** Widths and vertical extent of one font resource, as the page shows it. */
export function buildFont(context, fd) {
  const get = (d, k) => context.lookup(d.get(PDFName.of(k)));
  const subtype = nameOf(get(fd, 'Subtype'));
  let descriptor;
  const info = {codeLen: 1, vertical: false, widthOf: () => 500, ascent: 0.8, descent: -0.2, base: nameOf(get(fd, 'BaseFont')) ?? ''};
  if (subtype === 'Type0') {
    const descendants = get(fd, 'DescendantFonts');
    const cid = descendants instanceof PDFArray ? context.lookup(descendants.get(0)) : null;
    info.codeLen = 2;
    const enc = get(fd, 'Encoding');
    if (enc instanceof PDFName) info.vertical = enc.decodeText().endsWith('-V');
    else if (enc instanceof PDFStream) info.vertical = numOf(context.lookup(enc.dict.get(PDFName.of('WMode')))) === 1;
    if (cid instanceof PDFDict) {
      const dw = numOf(get(cid, 'DW')) ?? 1000;
      const w = new Map();
      const wa = get(cid, 'W');
      if (wa instanceof PDFArray) {
        const items = wa.asArray().map(x => context.lookup(x));
        for (let i = 0; i < items.length;) {
          const first = numOf(items[i]);
          const second = items[i + 1];
          if (second instanceof PDFArray) {
            second.asArray().forEach((x, k) => w.set(first + k, numOf(context.lookup(x)) ?? dw));
            i += 2;
          } else {
            const last = numOf(second);
            const width = numOf(items[i + 2]);
            if (first !== undefined && last !== undefined && width !== undefined && last - first < 70000) for (let c = first; c <= last; c++) w.set(c, width);
            i += 3;
          }
        }
      }
      info.widthOf = code => w.get(code) ?? dw;
      descriptor = get(cid, 'FontDescriptor');
    }
  } else {
    const first = numOf(get(fd, 'FirstChar')) ?? 0;
    const widths = get(fd, 'Widths');
    descriptor = get(fd, 'FontDescriptor');
    const missing = descriptor instanceof PDFDict ? numOf(get(descriptor, 'MissingWidth')) ?? 0 : 0;
    if (widths instanceof PDFArray) {
      const list = widths.asArray().map(x => numOf(context.lookup(x)) ?? 0);
      const matrix = get(fd, 'FontMatrix');
      const scale = subtype === 'Type3' && matrix instanceof PDFArray ? (numOf(context.lookup(matrix.get(0))) ?? 0.001) * 1000 : 1;
      info.widthOf = code => (code >= first && code - first < list.length ? list[code - first] * scale : missing * scale);
    } else {
      // One of the standard fonts: their own metrics.
      info.widthOf = code => fontWidth(info.base, String.fromCharCode(code), 1000);
    }
  }
  if (descriptor instanceof PDFDict) {
    const a = numOf(get(descriptor, 'Ascent'));
    const d = numOf(get(descriptor, 'Descent'));
    if (a > 0) info.ascent = a / 1000;
    if (d !== undefined && d !== 0) info.descent = -Math.abs(d) / 1000;
  }
  return info;
}

// ── the interpreter ────────────────────────────────────────────────────────────────────────────

const PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const FALLBACK_FONT = {codeLen: 1, vertical: false, widthOf: () => 500, ascent: 0.8, descent: -0.2, base: ''};
const num = (a, i) => (a[i]?.k === 'num' ? a[i].v : 0);

/**
 * One processing pass over content scopes of a document.
 * @param {{context: import('pdf-lib').PDFContext, rects: number[][], mode?: 'apply'|'verify', hiddenText?: number[]|null, everywhere?: boolean}} opts
 *   hiddenText: the page box; text drawn invisibly or wholly outside it counts as under a region (Remove hidden information).
 */
export class Redactor {
  constructor({context, rects, mode = 'apply', hiddenText = null, everywhere = false}) {
    this.context = context;
    this.rects = rects;
    this.mode = mode;
    this.hiddenText = hiddenText;
    this.everywhere = everywhere || !!hiddenText;
    this.report = {glyphs: 0, imagesRemoved: 0, imagesCleared: 0, pathsRemoved: 0, pathsClipped: 0, formsRewritten: 0, hiddenText: 0};
    this.residue = 0;
    this.forms = 0;
    this.fresh = 0;
    this.doomed = [];      // original objects replaced by cleaned copies
    this.fonts = new Map();
  }

  hits(b) { return this.rects.some(r => overlaps(r, b, 0)); }
  covered(b) { return this.rects.some(r => contains(r, b, 0.01)); }

  /** printcraft glyph_hit: any real overlap (more than a fifth of the glyph or a point, whichever is less, both ways). */
  glyphHit(b, origin) {
    const gw = b[2] - b[0];
    const gh = b[3] - b[1];
    if (gw < 0.01 || gh < 0.01) return this.rects.some(r => origin[0] >= r[0] && origin[0] <= r[2] && origin[1] >= r[1] && origin[1] <= r[3]);
    const mx = Math.min(gw * 0.2, 1);
    const my = Math.min(gh * 0.2, 1);
    return this.rects.some(r => Math.min(b[2], r[2]) - Math.max(b[0], r[0]) > mx && Math.min(b[3], r[3]) - Math.max(b[1], r[1]) > my);
  }

  lookup(o) { return this.context.lookup(o); }

  fontFor(resources, name) {
    const fonts = resources ? this.lookup(resources.get(PDFName.of('Font'))) : null;
    const ref = fonts instanceof PDFDict ? fonts.get(PDFName.of(name)) : null;
    if (!ref) return FALLBACK_FONT;
    const key = ref instanceof PDFRef ? `${ref.objectNumber}` : null;
    if (key && this.fonts.has(key)) return this.fonts.get(key);
    const fd = this.lookup(ref);
    const info = fd instanceof PDFDict ? buildFont(this.context, fd) : FALLBACK_FONT;
    if (key) this.fonts.set(key, info);
    return info;
  }

  /**
   * Process a scope: `ops` are the parsed operators, `resources` the scope's resource dictionary (PDFDict),
   * `gs` the graphics state to start from. Returns the rewritten operators, the resource entries it
   * added and the names it no longer uses.
   */
  process(ops, resources, gs, depth = 0) {
    const out = [];
    const added = [];          // [name, ref]
    const replaced = new Set();
    const state = {
      ctm: gs.ctm, font: gs.font ?? FALLBACK_FONT, size: gs.size ?? 0, tc: gs.tc ?? 0, tw: gs.tw ?? 0, tr: gs.tr ?? 0, th: gs.th ?? 1, tl: gs.tl ?? 0, rise: gs.rise ?? 0,
      tm: ID, tlm: ID,
    };
    const stack = [];
    let path = [];
    let pathBox = null;
    let clipPending = false;
    const vertical = () => {
      if (state.font.vertical && this.rects.length && this.mode === 'apply') throw new RedactError('vertical', 'A page has vertical-writing text while a redaction mark is pending, and Arkemis PDF cannot tell whether that text lies under the mark yet, so nothing was changed.');
    };
    const grow = (x, y) => {
      const p = at(state.ctm, x, y);
      pathBox = pathBox ? [Math.min(pathBox[0], p[0]), Math.min(pathBox[1], p[1]), Math.max(pathBox[2], p[0]), Math.max(pathBox[3], p[1])] : [p[0], p[1], p[0], p[1]];
    };
    const clipOut = () => {
      const inv = invert(state.ctm);
      if (!inv) return null;
      const poly = r => {
        const pts = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]].map(([x, y]) => at(inv, x, y));
        return [{op: 'm', args: [{k: 'num', v: pts[0][0]}, {k: 'num', v: pts[0][1]}]}, ...pts.slice(1).map(p => ({op: 'l', args: [{k: 'num', v: p[0]}, {k: 'num', v: p[1]}]})), {op: 'h', args: []}];
      };
      const ops2 = [...poly([-1e6, -1e6, 1e6, 1e6]), ...this.rects.flatMap(poly), {op: 'W*', args: []}, {op: 'n', args: []}];
      return ops2;
    };
    const flushPath = (paintOp) => {
      const pending = path;
      path = [];
      const box = pathBox;
      pathBox = null;
      const wasClip = clipPending;
      clipPending = false;
      if (paintOp.op === 'n' || !pending.length || !box || !this.rects.length || this.mode === 'verify') { out.push(...pending, paintOp); return; }
      const stroke = ['S', 's', 'B', 'B*', 'b', 'b*'].includes(paintOp.op);
      const scale = Math.sqrt(Math.abs(state.ctm[0] * state.ctm[3] - state.ctm[1] * state.ctm[2])) || 1;
      const width = stroke ? (state.lineWidth ?? 1) * scale / 2 : 0;
      const b = [box[0] - width, box[1] - width, box[2] + width, box[3] + width];
      if (!this.hits(b)) { out.push(...pending, paintOp); return; }
      if (this.covered(b)) {
        this.report.pathsRemoved++;
        if (wasClip) out.push(...pending, {op: 'n', args: []});
        return;
      }
      if (wasClip) { this.report.pathsRemoved++; out.push(...pending, {op: 'n', args: []}); return; }
      const clip = clipOut();
      if (!clip) { this.report.pathsRemoved++; return; }
      this.report.pathsClipped++;
      out.push({op: 'q', args: []}, ...clip, ...pending, paintOp, {op: 'Q', args: []});
    };

    for (const op of ops) {
      const a = op.args;
      switch (op.op) {
        case 'q': stack.push({...state, ctm: state.ctm}); out.push(op); break;
        case 'Q': { const s = stack.pop(); if (s) Object.assign(state, s); out.push(op); break; }
        case 'cm': state.ctm = mul([num(a, 0), num(a, 1), num(a, 2), num(a, 3), num(a, 4), num(a, 5)], state.ctm); out.push(op); break;
        case 'w': state.lineWidth = num(a, 0); out.push(op); break;
        case 'gs': {
          const eg = this.lookup(resources?.get(PDFName.of('ExtGState')));
          const g = eg instanceof PDFDict && a[0]?.k === 'name' ? this.lookup(eg.get(PDFName.of(a[0].v))) : null;
          if (g instanceof PDFDict) {
            const f = this.lookup(g.get(PDFName.of('Font')));
            if (f instanceof PDFArray) { const fd = this.lookup(f.get(0)); if (fd instanceof PDFDict) { state.font = buildFont(this.context, fd); state.size = numOf(this.lookup(f.get(1))) ?? state.size; } }
            const lw = numOf(this.lookup(g.get(PDFName.of('LW'))));
            if (lw !== undefined) state.lineWidth = lw;
          }
          out.push(op);
          break;
        }
        case 'BT': state.tm = ID; state.tlm = ID; out.push(op); break;
        case 'ET': out.push(op); break;
        case 'Tc': state.tc = num(a, 0); out.push(op); break;
        case 'Tw': state.tw = num(a, 0); out.push(op); break;
        case 'Tz': state.th = num(a, 0) / 100; out.push(op); break;
        case 'TL': state.tl = num(a, 0); out.push(op); break;
        case 'Ts': state.rise = num(a, 0); out.push(op); break;
        case 'Tr': state.tr = num(a, 0); out.push(op); break;
        case 'Tf': state.font = a[0]?.k === 'name' ? this.fontFor(resources, a[0].v) : FALLBACK_FONT; state.size = num(a, 1); out.push(op); break;
        case 'Td': state.tlm = mul([1, 0, 0, 1, num(a, 0), num(a, 1)], state.tlm); state.tm = state.tlm; out.push(op); break;
        case 'TD': state.tl = -num(a, 1); state.tlm = mul([1, 0, 0, 1, num(a, 0), num(a, 1)], state.tlm); state.tm = state.tlm; out.push(op); break;
        case 'Tm': state.tlm = [num(a, 0), num(a, 1), num(a, 2), num(a, 3), num(a, 4), num(a, 5)]; state.tm = state.tlm; out.push(op); break;
        case 'T*': state.tlm = mul([1, 0, 0, 1, 0, -state.tl], state.tlm); state.tm = state.tlm; out.push(op); break;
        case 'Tj': case 'TJ': case "'": case '"': {
          vertical();
          const pre = [];
          let items;
          if (op.op === '"') {
            state.tw = num(a, 0); state.tc = num(a, 1);
            pre.push({op: 'Tw', args: [a[0]]}, {op: 'Tc', args: [a[1]]});
            items = [a[2]];
          } else items = op.op === 'TJ' ? (a[0]?.a ?? []) : [a[0]];
          if (op.op === "'" || op.op === '"') { state.tlm = mul([1, 0, 0, 1, 0, -state.tl], state.tlm); state.tm = state.tlm; pre.push({op: 'T*', args: []}); }
          const result = this.show(state, items.filter(Boolean));
          if (result.changed && this.mode === 'apply') out.push(...pre, {op: 'TJ', args: [{k: 'arr', a: result.items}]});
          else out.push(op);
          break;
        }
        case 'm': case 'l': path.push(op); grow(num(a, 0), num(a, 1)); break;
        case 'c': path.push(op); grow(num(a, 0), num(a, 1)); grow(num(a, 2), num(a, 3)); grow(num(a, 4), num(a, 5)); break;
        case 'v': case 'y': path.push(op); grow(num(a, 0), num(a, 1)); grow(num(a, 2), num(a, 3)); break;
        case 'h': path.push(op); break;
        case 're': { path.push(op); const [x, y, w, h] = [num(a, 0), num(a, 1), num(a, 2), num(a, 3)]; grow(x, y); grow(x + w, y + h); break; }
        case 'W': case 'W*': path.push(op); clipPending = true; break;
        default:
          if (PAINT.has(op.op)) { flushPath(op); break; }
          if (op.op === 'sh') {
            if (this.rects.length && this.mode === 'apply') {
              const clip = clipOut();
              if (clip) { this.report.pathsClipped++; out.push({op: 'q', args: []}, ...clip, op, {op: 'Q', args: []}); } else this.report.pathsRemoved++;
            } else out.push(op);
            break;
          }
          if (op.op === 'Do') { this.xobject(op, resources, state, out, added, replaced, depth); break; }
          if (op.op === 'BI') {
            const dict = Object.fromEntries(op.dict.map(([k, v]) => [k, v]));
            void dict;
            const b = boxUnder(state.ctm, [0, 0, 1, 1]);
            if (this.hits(b)) {
              if (this.mode === 'verify') this.residue++;
              else { this.report.imagesRemoved++; break; }
            }
            out.push(op);
            break;
          }
          out.push(op);
      }
    }
    if (path.length) out.push(...path);
    // Names this scope no longer draws.
    const used = new Set(out.filter(o => o.op === 'Do' && o.args[0]?.k === 'name').map(o => o.args[0].v));
    const unused = [...replaced].filter(n => !used.has(n));
    return {ops: out, added, unused, state};
  }

  /** Lay out a shown string: the items to write, whether any glyph was cut, and the text state advance. */
  show(state, items) {
    const font = state.font;
    const out = [];
    let changed = false;
    let pending = 0;     // displacement waiting to be written (thousandths)
    let buffer = [];
    const flushBuffer = () => { if (buffer.length) { out.push({k: 'str', b: Uint8Array.from(buffer)}); buffer = []; } };
    const flushAdj = () => { if (pending) { flushBuffer(); out.push({k: 'num', v: pending}); pending = 0; } };
    const size = state.size;
    for (const item of items) {
      if (item.k === 'num') {
        const tx = -item.v / 1000 * size * state.th;
        state.tm = mul([1, 0, 0, 1, tx, 0], state.tm);
        flushBuffer();
        pending += item.v;
        continue;
      }
      if (item.k !== 'str') continue;
      const bytes = item.b;
      for (let i = 0; i < bytes.length;) {
        const len = Math.min(font.codeLen, bytes.length - i);
        let code = 0;
        for (let k = 0; k < len; k++) code = code * 256 + bytes[i + k];
        const w = font.widthOf(code);
        const spaceCode = font.codeLen === 1 && code === 32;
        const adv = ((w / 1000) * size + state.tc + (spaceCode ? state.tw : 0)) * state.th;
        // Where the glyph sits: its box in user space.
        const trm = mul([size * state.th, 0, 0, size, 0, state.rise], mul(state.tm, state.ctm));
        const box = boxUnder(trm, [0, font.descent, w / 1000, font.ascent]);
        const origin = at(trm, 0, 0);
        let hit = false;
        if (this.rects.length && this.glyphHit(box, origin)) hit = true;
        if (!hit && this.hiddenText) {
          if (state.tr === 3 || state.tr === 7 || !overlaps(box, this.hiddenText, 0)) { hit = true; this.report.hiddenText++; }
        }
        if (hit && this.mode === 'verify') this.residue++;
        if (hit && this.mode === 'apply') {
          this.report.glyphs++;
          changed = true;
          if (size > 0) pending += -((w) + ((state.tc + (spaceCode ? state.tw : 0)) * 1000) / size);
        } else {
          flushAdj();
          for (let k = 0; k < len; k++) buffer.push(bytes[i + k]);
        }
        state.tm = mul([1, 0, 0, 1, adv, 0], state.tm);
        i += len;
      }
    }
    flushBuffer();
    if (pending) out.push({k: 'num', v: pending});
    return {changed, items: out};
  }

  /** Do: images are removed or cleared where under a region, forms are rewritten. */
  xobject(op, resources, state, out, added, replaced, depth) {
    const name = op.args[0]?.k === 'name' ? op.args[0].v : null;
    const dict = this.lookup(resources?.get(PDFName.of('XObject')));
    const ref = name && dict instanceof PDFDict ? dict.get(PDFName.of(name)) : null;
    const xo = ref ? this.lookup(ref) : null;
    if (!(xo instanceof PDFStream)) { out.push(op); return; }
    const subtype = nameOf(this.lookup(xo.dict.get(PDFName.of('Subtype'))));
    if (subtype === 'Image') {
      const b = boxUnder(state.ctm, [0, 0, 1, 1]);
      if (!this.rects.length || !this.hits(b)) { out.push(op); return; }
      if (this.mode === 'verify') { out.push(op); return; }
      if (this.covered(b)) { this.report.imagesRemoved++; this.doomed.push(ref); replaced.add(name); return; }
      const cleared = this.clearImage(xo, state.ctm);
      if (!cleared) { this.report.imagesRemoved++; this.doomed.push(ref); replaced.add(name); return; }
      const fresh = this.freshName(dict, added);
      added.push([fresh, cleared]);
      replaced.add(name);
      this.doomed.push(ref);
      this.report.imagesCleared++;
      out.push({op: 'Do', args: [{k: 'name', v: fresh}]});
      return;
    }
    if (subtype === 'Form') {
      if (depth >= MAX_DEPTH || ++this.forms > MAX_FORMS) { this.report.imagesRemoved++; replaced.add(name); this.doomed.push(ref); return; }
      const matrix = this.numbers(xo.dict.get(PDFName.of('Matrix'))) ?? ID;
      const bbox = this.numbers(xo.dict.get(PDFName.of('BBox')));
      const ctm = mul(matrix, state.ctm);
      const b = bbox && bbox.length === 4 ? boxUnder(ctm, bbox) : null;
      if (!this.everywhere && b && !this.hits(b)) { out.push(op); return; }
      if (!this.everywhere && !this.rects.length) { out.push(op); return; }
      let content;
      try { content = decodePDFRawStream(xo).decode(); } catch { throw new RedactError('unreadable', 'A form on the page has content that can\'t be read, so the page can\'t be redacted safely.'); }
      const inner = this.lookup(xo.dict.get(PDFName.of('Resources')));
      const res = inner instanceof PDFDict ? inner : resources;
      const sub = this.process(parseContent(content), res, {ctm, font: state.font, size: state.size, tc: state.tc, tw: state.tw, tr: state.tr, th: state.th, tl: state.tl, rise: state.rise}, depth + 1);
      if (this.mode === 'verify') { out.push(op); return; }
      const bytes = serializeContent(sub.ops);
      const entries = {};
      for (const [k, v] of xo.dict.entries()) {
        const key = k.decodeText();
        if (!['Length', 'Filter', 'DecodeParms', 'Resources'].includes(key)) entries[key] = v;
      }
      const stream = this.context.flateStream(bytes, entries);
      const newRes = this.cloneResources(res, sub);
      stream.dict.set(PDFName.of('Resources'), newRes);
      const newRef = this.context.register(stream);
      const fresh = this.freshName(dict, added);
      added.push([fresh, newRef]);
      replaced.add(name);
      this.doomed.push(ref);
      this.report.formsRewritten++;
      out.push({op: 'Do', args: [{k: 'name', v: fresh}]});
      return;
    }
    out.push(op);
  }

  numbers(o) {
    const a = this.lookup(o);
    return a instanceof PDFArray ? a.asArray().map(x => numOf(this.lookup(x)) ?? 0) : null;
  }

  freshName(dict, added) {
    for (;;) {
      this.fresh++;
      const n = `PCRedacted${this.fresh}`;
      if (!(dict instanceof PDFDict && dict.has(PDFName.of(n))) && !added.some(([k]) => k === n)) return n;
    }
  }

  /** A copy of `res` with the added XObject entries in and the unused ones out. */
  cloneResources(res, sub) {
    const copy = res instanceof PDFDict ? res.clone() : this.context.obj({});
    const xo = this.lookup(copy.get(PDFName.of('XObject')));
    const xoCopy = xo instanceof PDFDict ? xo.clone() : this.context.obj({});
    for (const n of sub.unused) xoCopy.delete(PDFName.of(n));
    for (const [n, ref] of sub.added) xoCopy.set(PDFName.of(n), ref);
    copy.set(PDFName.of('XObject'), xoCopy);
    return copy;
  }

  /** A copy of an image with the pixels under the regions cleared, or null when this cannot be done here. */
  clearImage(xo, ctm) {
    const d = xo.dict;
    const get = k => this.lookup(d.get(PDFName.of(k)));
    if (d.has(PDFName.of('SMask')) || d.has(PDFName.of('Mask')) || numOf(get('BitsPerComponent')) !== 8 || get('ImageMask')?.asBoolean?.()) return null;
    const cs = nameOf(get('ColorSpace'));
    const comps = cs === 'DeviceGray' || cs === 'CalGray' ? 1 : cs === 'DeviceRGB' || cs === 'CalRGB' ? 3 : cs === 'DeviceCMYK' ? 4 : 0;
    const W = numOf(get('Width'));
    const H = numOf(get('Height'));
    if (!comps || !W || !H || W * H * comps > 64e6) return null;
    let pixels;
    try { pixels = decodePDFRawStream(xo).decode(); } catch { return null; }
    if (pixels.length < W * H * comps) return null;
    pixels = Uint8Array.from(pixels.subarray(0, W * H * comps));
    const inv = invert(ctm);
    if (!inv) return null;
    // Candidate pixel range from the regions in image space, then test each pixel's centre.
    const clearTo = comps === 4 ? 255 : 0;
    for (const r of this.rects) {
      const corners = [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]].map(([x, y]) => at(inv, x, y));
      const bx = bboxOfPoints(corners);
      const c0 = Math.max(0, Math.floor(bx[0] * W) - 1);
      const c1 = Math.min(W - 1, Math.ceil(bx[2] * W) + 1);
      const r0 = Math.max(0, Math.floor((1 - bx[3]) * H) - 1);
      const r1 = Math.min(H - 1, Math.ceil((1 - bx[1]) * H) + 1);
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          const [ux, uy] = at(ctm, (col + 0.5) / W, 1 - (row + 0.5) / H);
          if (ux >= r[0] && ux <= r[2] && uy >= r[1] && uy <= r[3]) {
            const o = (row * W + col) * comps;
            for (let k = 0; k < comps; k++) pixels[o + k] = clearTo;
          }
        }
      }
    }
    const entries = {};
    for (const [k, v] of d.entries()) {
      const key = k.decodeText();
      if (!['Length', 'Filter', 'DecodeParms'].includes(key)) entries[key] = v;
    }
    return this.context.register(this.context.flateStream(pixels, entries));
  }
}

export {ID as IDENTITY, mul, at, boxUnder, invert, overlaps, contains};
export {PDFString, PDFHexString};
