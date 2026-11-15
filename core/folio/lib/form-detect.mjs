// Prepare a form, automatic field detection: find where a printed form expects answers (underscore
// runs, rules, empty boxes, rows of comb cells, small squares) and name each new field from the label
// next to it, as Acrobat's auto-detection does.
//
// Translated from printcraft crates/forms/src/detect.rs (DetectionPath, page_shapes, label_for,
// combs, detect) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. `detect` is a pure function over the page's
// words and drawn shapes; `pageShapes` reads the shapes from a page's content stream (pdf-lib).
// The scanned-page (raster) detection of crates/forms/src/detect/raster.rs is not translated: a
// scan has no vector shapes, so such a page detects nothing. No DOM, no Node built-ins.

import {PDFName, PDFArray, PDFStream, PDFRawStream, decodePDFRawStream} from 'pdf-lib';

const MAX_RECT_POINTS = 16;
const EPS = 1e-6;

// ── content stream operators ────────────────────────────────────────────────────────────────

/** The operators of a content stream with their numeric operands: [{op, nums}]. Strings, names, arrays and inline images are skipped. */
export function contentOps(text) {
  const ops = [];
  let nums = [];
  let i = 0;
  const n = text.length;
  const isDelim = c => /[\s()<>[\]{}/%]/.test(c);
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '%') { while (i < n && text[i] !== '\n' && text[i] !== '\r') i++; continue; }
    if (c === '(') { let d = 1; i++; while (i < n && d) { if (text[i] === '\\') i++; else if (text[i] === '(') d++; else if (text[i] === ')') d--; i++; } nums = []; continue; }
    if (c === '<') { if (text[i + 1] === '<') { i += 2; nums = []; continue; } while (i < n && text[i] !== '>') i++; i++; nums = []; continue; }
    if (c === '>') { i += text[i + 1] === '>' ? 2 : 1; continue; }
    if (c === '[' || c === ']' || c === '{' || c === '}') { i++; continue; }
    if (c === '/') { i++; while (i < n && !isDelim(text[i])) i++; nums = []; continue; }
    let j = i;
    while (j < n && !isDelim(text[j])) j++;
    const tok = text.slice(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { nums.push(Number(tok)); continue; }
    if (tok === 'BI') { const e = text.indexOf('EI', i); i = e < 0 ? n : e + 2; nums = []; continue; }
    ops.push({op: tok, nums});
    nums = [];
  }
  return ops;
}

const mul = (m, c) => [m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3], m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3], m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const bboxOf = (m, r) => {
  const cs = [apply(m, r[0], r[1]), apply(m, r[2], r[1]), apply(m, r[0], r[3]), apply(m, r[2], r[3])];
  return [Math.min(...cs.map(c => c[0])), Math.min(...cs.map(c => c[1])), Math.max(...cs.map(c => c[0])), Math.max(...cs.map(c => c[1]))];
};

class Path {
  constructor() { this.points = []; this.rules = []; this.complex = false; this.closed = false; }
  finish(paths) {
    const p = Object.assign(new Path(), this);
    this.points = []; this.rules = []; this.complex = false; this.closed = false;
    if (p.rules.length || (!p.complex && p.points.length >= 4)) paths.push(p);
  }
  rectangle(implicitlyClosed) {
    if (this.complex) return null;
    if (this.points.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return null;
    const near = (a, b) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
    let pts = this.points.map(p => [...p]);
    const repeated = pts.length > 1 && near(pts[0], pts[pts.length - 1]);
    if (repeated) pts.pop();
    if (!(this.closed || implicitlyClosed || repeated)) return null;
    const between = (a, m, b) => Math.min(a, b) - EPS <= m && m <= Math.max(a, b) + EPS;
    let i = 0;
    while (pts.length > 4 && i < pts.length) {
      const nn = pts.length, a = pts[(i + nn - 1) % nn], m = pts[i], b = pts[(i + 1) % nn];
      const onRow = Math.abs(a[1] - m[1]) < EPS && Math.abs(m[1] - b[1]) < EPS && between(a[0], m[0], b[0]);
      const onCol = Math.abs(a[0] - m[0]) < EPS && Math.abs(m[0] - b[0]) < EPS && between(a[1], m[1], b[1]);
      if (onRow || onCol) { pts.splice(i, 1); i = 0; } else i++;
    }
    if (pts.length !== 4) return null;
    const horizontal = [];
    for (let k = 0; k < 4; k++) {
      const a = pts[k], b = pts[(k + 1) % 4];
      const h = Math.abs(a[1] - b[1]) < EPS, v = Math.abs(a[0] - b[0]) < EPS;
      if (h === v) return null;
      horizontal.push(h);
    }
    if (horizontal.some((h, k) => h === horizontal[(k + 1) % 4])) return null;
    return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
  }
}

/** The rectangles and horizontal segments a page content stream draws (stroked or filled), in user space. */
export function shapesOfContent(text) {
  const out = {boxes: [], rules: []};
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let pathBoxes = [], subpaths = [];
  let path = new Path();
  let cur = null;
  for (const {op, nums} of contentOps(text)) {
    switch (op) {
      case 'q': stack.push(ctm); break;
      case 'Q': ctm = stack.pop() ?? ctm; break;
      case 'cm': if (nums.length === 6) ctm = mul(nums, ctm); break;
      case 're': {
        path.finish(subpaths);
        if (nums.length === 4) {
          const [x, y, w, h] = nums;
          pathBoxes.push(bboxOf(ctm, [Math.min(x, x + w), Math.min(y, y + h), Math.max(x, x + w), Math.max(y, y + h)]));
          cur = apply(ctm, x, y);
          path.complex = true;
          path.points.push(cur);
        }
        break;
      }
      case 'm': path.finish(subpaths); cur = nums.length === 2 ? apply(ctm, nums[0], nums[1]) : null; if (cur) path.points.push(cur); break;
      case 'l': {
        if (cur && nums.length === 2) {
          if (path.closed) path.complex = true;
          const b = apply(ctm, nums[0], nums[1]);
          if (!path.complex) {
            if (path.points.length > MAX_RECT_POINTS) path.complex = true;
            else { if (!path.points.length) path.points.push(cur); path.points.push(b); }
          }
          if (Math.abs(cur[1] - b[1]) < 0.5 && Math.abs(cur[0] - b[0]) > 1) path.rules.push([Math.min(cur[0], b[0]), cur[1], Math.max(cur[0], b[0]), cur[1]]);
          cur = b;
        }
        break;
      }
      case 'c': case 'v': case 'y': {
        path.complex = true;
        const end = op === 'c' ? (nums.length === 6 ? [nums[4], nums[5]] : null) : nums.length === 4 ? [nums[2], nums[3]] : null;
        if (end) cur = apply(ctm, end[0], end[1]);
        break;
      }
      case 'h': path.closed = true; cur = path.points[0] ?? cur; break;
      case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': {
        if (op === 's' || op === 'b' || op === 'b*') path.closed = true;
        path.finish(subpaths);
        const filled = op !== 'S' && op !== 's';
        const pathRules = [];
        for (const sp of subpaths) { const r = sp.rectangle(filled); if (r) pathBoxes.push(r); else pathRules.push(...sp.rules); }
        subpaths = [];
        for (const r of pathBoxes) {
          if (r[3] - r[1] < 1.5 && r[2] - r[0] > 1) out.rules.push([r[0], (r[1] + r[3]) / 2, r[2], (r[1] + r[3]) / 2]);
          else out.boxes.push(r);
        }
        pathBoxes = [];
        out.rules.push(...pathRules);
        cur = null;
        break;
      }
      case 'n': pathBoxes = []; subpaths = []; path = new Path(); cur = null; break;
      default: break;
    }
  }
  return out;
}

/** The decoded content stream text of a pdf-lib page. */
export function pageContentText(pdf, page) {
  const ctx = pdf.context;
  const c = page.node.lookup(PDFName.of('Contents'));
  const list = c instanceof PDFArray ? c.asArray().map(o => ctx.lookup(o)) : c ? [c] : [];
  let text = '';
  for (const s of list) {
    try {
      if (s instanceof PDFRawStream) text += `${new TextDecoder('latin1').decode(decodePDFRawStream(s).decode())}\n`;
      else if (s instanceof PDFStream) text += `${new TextDecoder('latin1').decode(s.getUnencodedContents())}\n`;
    } catch { /* an undecodable stream draws nothing here */ }
  }
  return text;
}

/** The shapes a pdf-lib page draws. */
export const pageShapes = (pdf, pageIndex) => shapesOfContent(pageContentText(pdf, pdf.getPage(pageIndex)));

// ── labels and candidates ───────────────────────────────────────────────────────────────────

const mid = r => (r[1] + r[3]) / 2;
const overlaps = (a, b) => a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1;

/** A label's words made into a field name: letters, digits, spaces, hyphens and slashes. */
function clean(label) {
  const s = [...label].map(c => (/[\p{L}\p{N} \-/]/u.test(c) ? c : ' ')).join('').split(/\s+/).filter(Boolean).join(' ');
  return [...s].slice(0, 40).join('').trim();
}

function labelFor(words, rect, rightOf) {
  const h = Math.max(rect[3] - rect[1], 8);
  const sameLine = w => Math.abs(mid(w.rect) - mid(rect)) < Math.max(h, 10) * 0.7;
  let left = rightOf
    ? words.filter(w => sameLine(w) && w.rect[0] >= rect[2] - 1 && w.rect[0] - rect[2] < 200)
    : words.filter(w => sameLine(w) && w.rect[2] <= rect[0] + 1 && rect[0] - w.rect[2] < 250);
  left.sort((a, b) => a.rect[0] - b.rect[0]);
  if (rightOf) {
    const picked = [];
    let x = rect[2];
    for (const w of left) { if (w.rect[0] - x > 24) break; picked.push(w.text); x = w.rect[2]; }
    return clean(picked.join(' '));
  }
  const picked = [];
  let x = rect[0];
  for (const w of [...left].reverse()) {
    if (x - w.rect[2] > 24 && picked.length) break;
    if (/^_+$/.test(w.text)) break;
    picked.unshift(w.text);
    x = w.rect[0];
  }
  const l = clean(picked.join(' '));
  if (l) return l;
  const above = words.filter(w => w.rect[1] >= rect[3] - 1 && w.rect[1] - rect[3] < 24 && w.rect[0] < rect[2] && w.rect[2] > rect[0] - 4);
  if (!above.length) return '';
  const line = Math.min(...above.map(w => mid(w.rect)));
  const on = above.filter(w => Math.abs(mid(w.rect) - line) < 3).sort((a, b) => a.rect[0] - b.rect[0]);
  return clean(on.map(w => w.text).join(' '));
}

/** Rows of two or more touching cells of one size: [{rect, cells}]. */
function combs(boxes) {
  const cells = boxes.filter(r => { const w = r[2] - r[0], h = r[3] - r[1]; return w >= 5 && w <= 30 && h >= 8 && h <= 40 && w <= h * 1.2; });
  const follows = (a, b) => Math.abs(b[0] - a[2]) <= 1 && Math.abs(b[1] - a[1]) <= 0.5 && Math.abs(b[3] - a[3]) <= 0.5 && Math.abs((b[2] - b[0]) - (a[2] - a[0])) <= 0.5;
  const out = [];
  for (const first of cells) {
    if (cells.some(a => follows(a, first))) continue;
    let last = first, n = 1;
    for (;;) { const b = cells.find(x => follows(last, x)); if (!b || n >= cells.length) break; last = b; n++; }
    if (n >= 2) out.push({rect: [first[0], first[1], last[2], first[3]], cells: n});
  }
  return out;
}

/**
 * Propose fields for a page. `words`: [{text, rect}] (user space, y up); `shapes`: {boxes, rules};
 * `existing`: the page's widget rectangles (no candidate overlaps them); `taken`: names in use.
 * Returns [{kind: 'text'|'checkbox'|'comb', cells?, rect, name}].
 */
export function detect(words, shapes, existing, taken) {
  let out = [];
  const push = (kind, rect, name, extra = {}) => {
    if ([...existing, ...out.map(c => c.rect)].some(e => overlaps(e, rect))) return;
    out.push({kind, rect, name, ...extra});
  };
  const blanks = words.filter(w => w.text.length >= 3 && /^_+$/.test(w.text));
  const labels = words.filter(w => !(w.text.length >= 3 && /^_+$/.test(w.text)));
  for (const b of blanks) {
    const h = Math.max(b.rect[3] - b.rect[1], 10);
    const rect = [b.rect[0], b.rect[1], b.rect[2], b.rect[1] + Math.min(22, Math.max(12, h * 1.4))];
    push('text', rect, labelFor(labels, rect, false));
  }
  for (const {rect, cells} of combs(shapes.boxes)) {
    if (labels.some(x => overlaps(x.rect, rect))) continue;
    push('comb', rect, labelFor(labels, rect, false), {cells});
  }
  for (const r of shapes.boxes) {
    const w = r[2] - r[0], h = r[3] - r[1];
    if (w >= 5 && w <= 20 && h >= 5 && h <= 20 && Math.abs(w / h - 1) < 0.25) push('checkbox', r, labelFor(labels, r, true));
  }
  for (const r of shapes.boxes) {
    const w = r[2] - r[0], h = r[3] - r[1];
    const hasText = labels.some(x => overlaps(x.rect, r));
    if (w >= 40 && h >= 12 && h <= 60 && !hasText) push('text', [r[0] + 1, r[1] + 1, r[2] - 1, r[3] - 1], labelFor(labels, r, false));
  }
  for (const r of shapes.rules) {
    if (r[2] - r[0] < 40) continue;
    const rect = [r[0], r[1] + 1, r[2], r[1] + 17];
    if (labels.some(x => overlaps(x.rect, rect))) continue;
    push('text', rect, labelFor(labels, rect, false));
  }
  // Reading order: rows whose middles are within 8 pt of the row's first, top to bottom, left to right.
  out.sort((a, b) => mid(b.rect) - mid(a.rect));
  let row = 0, start = Infinity;
  const keyed = out.map(c => { if (start - mid(c.rect) > 8) { row++; start = mid(c.rect); } return [row, c]; });
  keyed.sort((a, b) => a[0] - b[0] || a[1].rect[0] - b[1].rect[0]);
  out = keyed.map(k => k[1]);
  const used = [...taken];
  for (const c of out) {
    const base = c.name || (c.kind === 'checkbox' ? 'Check Box' : 'Text');
    let name = c.name ? base : `${base}1`;
    let n = 1;
    while (used.includes(name)) { n++; name = `${base}${n}`; }
    used.push(name);
    c.name = name;
  }
  return out;
}
