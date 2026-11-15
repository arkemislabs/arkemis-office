// Painting a comment's appearance on screen: the form XObject model/appearance.mjs `build` makes
// (the very stream model/pdf-write.mjs saves) run on a Canvas 2D context, placed on the
// annotation's /Rect by the algorithm of ISO 32000-2 §12.5.5.
//
// printcraft paints comments from their appearance streams through its renderer (crates/render:
// hayro interprets /AP /N on the page raster; crates/annot/src/draw.rs writes them). The page raster
// here is pdf.js's (docs/architecture.md 16.4); comments are painted over it from the model so an
// edit shows at once, without writing the file. Operators follow ISO 32000-2 §8 (graphics state,
// paths, colour) and §9 (text with the standard 14 fonts the generated appearances use), at
// printcraft 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt).
// No DOM: the caller passes a CanvasRenderingContext2D (or any object with that API).

import {Encodings} from '@pdf-lib/standard-fonts';
import {mul} from './geom.mjs';
import {textWidth} from './fonts.mjs';
import {nameAt, nums} from './cos.mjs';
import {build, displayStamp, withUnicode} from '../model/appearance.mjs';
import {browserCss, decodeUtf16, directionOf} from './browser-text.mjs';
import {NOTE_SIZE} from '../model/types.mjs';

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/**
 * Tokens of a content stream: numbers, names ('/Name'), strings ({str: binary string}), arrays,
 * dictionaries (inline, skipped) and operators ({op}).
 * @param {string} src binary string (one char per byte)
 */
export function tokenize(src) {
  const out = [];
  const stack = [out];
  let i = 0;
  const push = v => stack[stack.length - 1].push(v);
  const code = k => src.charCodeAt(k);
  while (i < src.length) {
    const c = code(i);
    if (WHITESPACE.has(c)) { i++; continue; }
    if (c === 0x25) { while (i < src.length && code(i) !== 0x0a && code(i) !== 0x0d) i++; continue; }
    if (c === 0x5b) { const arr = []; push(arr); stack.push(arr); i++; continue; }
    if (c === 0x5d) { if (stack.length > 1) stack.pop(); i++; continue; }
    if (c === 0x28) {
      let depth = 1, s = '';
      i++;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '\\') {
          const nx = src[i + 1];
          const esc = {n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\'}[nx];
          if (esc !== undefined) { s += esc; i += 2; continue; }
          if (/[0-7]/.test(nx ?? '')) { const m = /^[0-7]{1,3}/.exec(src.slice(i + 1, i + 4))[0]; s += String.fromCharCode(parseInt(m, 8) & 0xff); i += 1 + m.length; continue; }
          if (nx === '\r' || nx === '\n') { i += nx === '\r' && src[i + 2] === '\n' ? 3 : 2; continue; }
          i++;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (!depth) { i++; break; } }
        s += ch;
        i++;
      }
      push({str: s});
      continue;
    }
    if (c === 0x3c && code(i + 1) === 0x3c) {
      // An inline dictionary (BDC properties): skipped with its nesting.
      let depth = 0;
      while (i < src.length) {
        if (src.startsWith('<<', i)) { depth++; i += 2; continue; }
        if (src.startsWith('>>', i)) { depth--; i += 2; if (!depth) break; continue; }
        i++;
      }
      push({dict: true});
      continue;
    }
    if (c === 0x3c) {
      const end = src.indexOf('>', i);
      const hex = src.slice(i + 1, end < 0 ? src.length : end).replace(/\s+/g, '');
      let s = '';
      for (let k = 0; k < hex.length; k += 2) s += String.fromCharCode(parseInt((hex[k] + (hex[k + 1] ?? '0')), 16) || 0);
      push({str: s});
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === 0x2f) {
      let j = i + 1;
      while (j < src.length && !WHITESPACE.has(code(j)) && !DELIMS.has(code(j))) j++;
      push('/' + src.slice(i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
      i = j;
      continue;
    }
    let j = i;
    while (j < src.length && !WHITESPACE.has(code(j)) && !DELIMS.has(code(j))) j++;
    if (j === i) { i++; continue; }
    const word = src.slice(i, j);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) push(Number(word));
    else if (word === 'true' || word === 'false') push(word === 'true');
    else if (word === 'null') push(null);
    else push({op: word});
    i = j;
  }
  return out;
}

let winAnsiText = null;
/** WinAnsiEncoding bytes → Unicode text (the encoding of the generated appearances' fonts). */
export function decodeWinAnsi(bytes) {
  if (!winAnsiText) {
    winAnsiText = new Map();
    for (const [unicode, [code]] of Object.entries(Encodings.WinAnsi.unicodeMappings)) if (!winAnsiText.has(code)) winAnsiText.set(code, String.fromCodePoint(Number(unicode)));
  }
  let s = '';
  for (let k = 0; k < bytes.length; k++) {
    const b = bytes.charCodeAt(k);
    s += (b >= 0x20 && b <= 0x7e) || b >= 0xa0 ? String.fromCharCode(b) : winAnsiText.get(b) ?? '';
  }
  return s;
}

/** The CSS font for a standard-14 /BaseFont. */
export function cssFont(baseFont, size) {
  const base = String(baseFont ?? 'Helvetica').replace(/^\//, '').replace(/^[A-Z]{6}\+/, '');
  const bold = /Bold/i.test(base), italic = /Italic|Oblique/i.test(base);
  const family = /^Times/i.test(base) ? '"Times New Roman", Times, serif' : /^Courier/i.test(base) ? '"Courier New", Courier, monospace'
    : /Symbol/i.test(base) ? 'Symbol, serif' : /Dingbats/i.test(base) ? '"Segoe UI Symbol", "Zapf Dingbats", sans-serif' : 'Helvetica, Arial, sans-serif';
  return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${family}`;
}

const lookup = (dict, key) => (dict && typeof dict === 'object' ? dict[key.replace(/^\//, '')] : undefined);

/**
 * §12.5.5: the matrix that places a form with `bbox` and `matrix` on the annotation's `rect`
 * (user space): the transformed box is mapped onto the rectangle.
 */
export function appearanceMatrix(bbox, matrix, rect) {
  const m = Array.isArray(matrix) && matrix.length === 6 ? matrix : [1, 0, 0, 1, 0, 0];
  const pts = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const bx0 = Math.min(...xs), by0 = Math.min(...ys), bx1 = Math.max(...xs), by1 = Math.max(...ys);
  const [rx0, ry0, rx1, ry1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  const sx = bx1 - bx0 > 1e-9 ? (rx1 - rx0) / (bx1 - bx0) : 1, sy = by1 - by0 > 1e-9 ? (ry1 - ry0) / (by1 - by0) : 1;
  const a = [sx, 0, 0, sy, rx0 - bx0 * sx, ry0 - by0 * sy];
  return mul(m, a);
}

const rgb = (r, g, b) => `rgb(${Math.round(Math.min(1, Math.max(0, r)) * 255)}, ${Math.round(Math.min(1, Math.max(0, g)) * 255)}, ${Math.round(Math.min(1, Math.max(0, b)) * 255)})`;
const cmyk = (c, m, y, k) => rgb((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));
function colorOf(ops) {
  const v = ops.filter(x => typeof x === 'number');
  if (v.length >= 4) return cmyk(v[0], v[1], v[2], v[3]);
  if (v.length === 3) return rgb(v[0], v[1], v[2]);
  if (v.length === 1) return rgb(v[0], v[0], v[0]);
  return 'rgb(0, 0, 0)';
}

/**
 * Run a form XObject `{bbox, content, resources, matrix?}` on `ctx`, whose current transform maps
 * the page's user space to the canvas, placed on `rect`. Blend modes and constant alpha come from
 * the form's /ExtGState; `opacity` multiplies them (the annotation's /CA when the form has none).
 */
export function paintForm(ctx, f, rect, {opacity = 1} = {}) {
  if (!f || typeof f.content !== 'string') return;
  ctx.save();
  const m = appearanceMatrix(f.bbox, f.matrix, rect);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  // The form's BBox clips it (§8.10.1).
  ctx.beginPath();
  ctx.rect(Math.min(f.bbox[0], f.bbox[2]), Math.min(f.bbox[1], f.bbox[3]), Math.abs(f.bbox[2] - f.bbox[0]), Math.abs(f.bbox[3] - f.bbox[1]));
  ctx.clip();
  run(ctx, tokenize(f.content), f.resources ?? {}, opacity);
  ctx.restore();
}

function run(ctx, tokens, resources, baseOpacity) {
  let operands = [];
  const states = [];
  let gs = {fill: 'rgb(0, 0, 0)', stroke: 'rgb(0, 0, 0)', ca: 1, CA: 1, blend: 'source-over', lineWidth: 1};
  let text = null;     // {tm, tlm, font, size, leading, charSpacing, wordSpacing, hScale, rise, mode}
  let tstate = {font: null, size: 0, leading: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, rise: 0, mode: 0};
  let clipRule = null;
  let pathOpen = false;
  let cur = [0, 0];
  const begin = () => { if (!pathOpen) { ctx.beginPath(); pathOpen = true; } };
  const thinnest = () => { const t = ctx.getTransform?.(); const s = t ? Math.hypot(t.a, t.b) : 1; return s > 0 ? 1 / s : 1; };
  const doFill = rule => { ctx.globalAlpha = gs.ca * baseOpacity; ctx.globalCompositeOperation = gs.blend; ctx.fillStyle = gs.fill; ctx.fill(rule); };
  const doStroke = () => {
    ctx.globalAlpha = gs.CA * baseOpacity; ctx.globalCompositeOperation = gs.blend; ctx.strokeStyle = gs.stroke;
    ctx.lineWidth = gs.lineWidth > 0 ? gs.lineWidth : thinnest();
    ctx.stroke();
  };
  const endPath = () => {
    if (clipRule) { ctx.clip(clipRule); clipRule = null; }
    pathOpen = false;
  };
  const showText = s => {
    if (!text || !tstate.font) return;
    const fontDict = lookup(resources.Font, tstate.font);
    const base = lookup(fontDict, 'BaseFont');
    // A pseudo font of the page view's text set (lib/browser-text.mjs): UTF-16 text drawn with the browser's own fonts and text engine.
    const browser = fontDict && typeof fontDict === 'object' && fontDict.PCBrowser && typeof fontDict.PCBrowser === 'object' ? fontDict.PCBrowser : null;
    const str = browser ? decodeUtf16(s) : decodeWinAnsi(s);
    const size = tstate.size;
    if (tstate.mode !== 3 && str) {
      ctx.save();
      const tm = text.tm;
      ctx.transform(tm[0], tm[1], tm[2], tm[3], tm[4], tm[5]);
      ctx.translate(0, tstate.rise);
      ctx.scale(tstate.hScale, -1);
      ctx.font = browser ? browserCss(browser, Math.abs(size)) : cssFont(base, Math.abs(size));
      ctx.textBaseline = 'alphabetic';
      if (browser) { ctx.direction = directionOf(str); ctx.textAlign = 'left'; }
      ctx.globalCompositeOperation = gs.blend;
      if (tstate.mode === 0 || tstate.mode === 2 || tstate.mode === 4 || tstate.mode === 6) { ctx.globalAlpha = gs.ca * baseOpacity; ctx.fillStyle = gs.fill; ctx.fillText(str, 0, 0); }
      if (tstate.mode === 1 || tstate.mode === 2 || tstate.mode === 5 || tstate.mode === 6) {
        ctx.globalAlpha = gs.CA * baseOpacity; ctx.strokeStyle = gs.stroke; ctx.lineWidth = gs.lineWidth > 0 ? gs.lineWidth : thinnest(); ctx.strokeText(str, 0, 0);
      }
      ctx.restore();
    }
    const bold = /Bold/i.test(String(base ?? ''));
    let advance = textWidth(str, size, bold);
    if (browser) {
      ctx.save();
      ctx.font = browserCss(browser, Math.abs(size));
      advance = ctx.measureText?.(str)?.width ?? advance;
      ctx.restore();
    }
    let width = advance + tstate.charSpacing * [...str].length + tstate.wordSpacing * (str.match(/ /g)?.length ?? 0);
    width *= tstate.hScale;
    text.tm = mul([1, 0, 0, 1, width, 0], text.tm);
  };
  const moveLine = (tx, ty) => { text.tlm = mul([1, 0, 0, 1, tx, ty], text.tlm); text.tm = text.tlm.slice(); };

  for (const tok of tokens) {
    if (!tok || typeof tok !== 'object' || Array.isArray(tok) || !('op' in tok)) { operands.push(tok); continue; }
    const o = operands;
    operands = [];
    const N = k => (typeof o[k] === 'number' ? o[k] : 0);
    switch (tok.op) {
      case 'q': ctx.save(); states.push({gs: {...gs}, tstate: {...tstate}}); break;
      case 'Q': { const s = states.pop(); if (s) { ctx.restore(); gs = s.gs; tstate = s.tstate; } break; }
      case 'cm': ctx.transform(N(0), N(1), N(2), N(3), N(4), N(5)); break;
      case 'w': gs.lineWidth = N(0); break;
      case 'J': ctx.lineCap = ['butt', 'round', 'square'][N(0)] ?? 'butt'; break;
      case 'j': ctx.lineJoin = ['miter', 'round', 'bevel'][N(0)] ?? 'miter'; break;
      case 'M': ctx.miterLimit = Math.max(1, N(0)); break;
      case 'd': ctx.setLineDash?.(Array.isArray(o[0]) ? o[0].filter(x => typeof x === 'number') : []); ctx.lineDashOffset = N(1); break;
      case 'gs': {
        const g = lookup(resources.ExtGState, String(o[0] ?? ''));
        if (g && typeof g === 'object') {
          if (typeof g.CA === 'number') gs.CA = g.CA;
          if (typeof g.ca === 'number') gs.ca = g.ca;
          if (typeof g.LW === 'number') gs.lineWidth = g.LW;
          const bm = Array.isArray(g.BM) ? g.BM[0] : g.BM;
          if (bm !== undefined) gs.blend = bm === '/Multiply' ? 'multiply' : bm === '/Screen' ? 'screen' : bm === '/Darken' ? 'darken' : bm === '/Lighten' ? 'lighten' : 'source-over';
        }
        break;
      }
      case 'm': begin(); ctx.moveTo(N(0), N(1)); cur = [N(0), N(1)]; break;
      case 'l': begin(); ctx.lineTo(N(0), N(1)); cur = [N(0), N(1)]; break;
      case 'c': begin(); ctx.bezierCurveTo(N(0), N(1), N(2), N(3), N(4), N(5)); cur = [N(4), N(5)]; break;
      case 'v': begin(); ctx.bezierCurveTo(cur[0], cur[1], N(0), N(1), N(2), N(3)); cur = [N(2), N(3)]; break;
      case 'y': begin(); ctx.bezierCurveTo(N(0), N(1), N(2), N(3), N(2), N(3)); cur = [N(2), N(3)]; break;
      case 'h': if (pathOpen) ctx.closePath(); break;
      case 're': begin(); ctx.rect(N(0), N(1), N(2), N(3)); cur = [N(0), N(1)]; break;
      case 'S': doStroke(); endPath(); break;
      case 's': ctx.closePath(); doStroke(); endPath(); break;
      case 'f': case 'F': doFill('nonzero'); endPath(); break;
      case 'f*': doFill('evenodd'); endPath(); break;
      case 'B': doFill('nonzero'); doStroke(); endPath(); break;
      case 'B*': doFill('evenodd'); doStroke(); endPath(); break;
      case 'b': ctx.closePath(); doFill('nonzero'); doStroke(); endPath(); break;
      case 'b*': ctx.closePath(); doFill('evenodd'); doStroke(); endPath(); break;
      case 'n': endPath(); break;
      case 'W': clipRule = 'nonzero'; break;
      case 'W*': clipRule = 'evenodd'; break;
      case 'g': gs.fill = colorOf(o); break;
      case 'G': gs.stroke = colorOf(o); break;
      case 'rg': gs.fill = colorOf(o); break;
      case 'RG': gs.stroke = colorOf(o); break;
      case 'k': gs.fill = colorOf(o); break;
      case 'K': gs.stroke = colorOf(o); break;
      case 'sc': case 'scn': gs.fill = colorOf(o); break;
      case 'SC': case 'SCN': gs.stroke = colorOf(o); break;
      case 'cs': case 'CS': break;
      case 'BT': text = {tm: [1, 0, 0, 1, 0, 0], tlm: [1, 0, 0, 1, 0, 0]}; break;
      case 'ET': text = null; break;
      case 'Tf': tstate.font = String(o[0] ?? ''); tstate.size = N(1); break;
      case 'Tc': tstate.charSpacing = N(0); break;
      case 'Tw': tstate.wordSpacing = N(0); break;
      case 'Tz': tstate.hScale = N(0) / 100; break;
      case 'TL': tstate.leading = N(0); break;
      case 'Ts': tstate.rise = N(0); break;
      case 'Tr': tstate.mode = N(0); break;
      case 'Td': if (text) moveLine(N(0), N(1)); break;
      case 'TD': if (text) { tstate.leading = -N(1); moveLine(N(0), N(1)); } break;
      case 'Tm': if (text) { text.tlm = [N(0), N(1), N(2), N(3), N(4), N(5)]; text.tm = text.tlm.slice(); } break;
      case 'T*': if (text) moveLine(0, -tstate.leading); break;
      case 'Tj': if (o[0]?.str !== undefined) showText(o[0].str); break;
      case "'": if (text) { moveLine(0, -tstate.leading); if (o[0]?.str !== undefined) showText(o[0].str); } break;
      case '"': if (text) { tstate.wordSpacing = N(0); tstate.charSpacing = N(1); moveLine(0, -tstate.leading); if (o[2]?.str !== undefined) showText(o[2].str); } break;
      case 'TJ':
        if (text && Array.isArray(o[0])) for (const part of o[0]) {
          if (typeof part === 'number') text.tm = mul([1, 0, 0, 1, -part / 1000 * tstate.size * tstate.hScale, 0], text.tm);
          else if (part?.str !== undefined) showText(part.str);
        }
        break;
      default: break;   // Do (pictures from the source file), marked content, shading: not drawn here
    }
  }
  while (states.length) { states.pop(); ctx.restore(); }
}

/** The user space → canvas transform for a page shown with `pageToView` (lib/geom.mjs userToView) at `scale` canvas pixels per point. */
export function userToCanvas(userToView, scale) {
  const o = userToView(0, 0), x = userToView(1, 0), y = userToView(0, 1);
  return [(x[0] - o[0]) * scale, (x[1] - o[1]) * scale, (y[0] - o[0]) * scale, (y[1] - o[1]) * scale, o[0] * scale, o[1] * scale];
}

/**
 * What the page shows for a comment record painted from the model: the appearance the writer
 * saves (model/pdf-write.mjs writeRecord: `build`, a stamp's display form, a note or attachment
 * icon pinned to a NOTE_SIZE box at the top-left of /Rect), or null (an empty appearance, or one
 * that can't be drawn here). `text` is the page view's text set (lib/browser-text.mjs): a text in a script the standard faces lack is drawn with the browser's fonts, the same text the
 * saved file draws with its embedded font.
 */
export function recordAppearance(r, text = /** @type {any} */ (null)) {
  if (r.ap === 'empty') return null;
  const d = r.dict;
  const sub = nameAt(d, 'Subtype');
  const f = withUnicode(text, () => build(d) ?? (sub === 'Stamp' ? displayStamp({...d, AP: undefined}) : null));
  if (!f) return null;
  const v = nums(d, 'Rect');
  if (!v || v.length !== 4) return null;
  let rect = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
  if (sub === 'Text' || sub === 'FileAttachment') rect = [rect[0], rect[3] - NOTE_SIZE, rect[0] + NOTE_SIZE, rect[3]];
  return {form: f, rect};
}
