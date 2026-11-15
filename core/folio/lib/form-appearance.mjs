// Appearance streams for form widgets: text, comb, multi-line and password fields, drop-down and
// list boxes, check boxes and radio buttons (a drawn check, cross, circle, diamond, square or
// star), push buttons with a caption or picture, and signature fields.
//
// Translated from printcraft crates/forms/src/appearance.rs (auto_text_size, frame, round_frame,
// comb_dividers, list_rows, field_appearance_fit, check_box_states, check_mark,
// push_button_shown, placement) and author/look.rs (CheckStyle codes, BorderStyle codes, FieldFont)
// at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Streams are added to the pdf-lib document as indirect objects. No DOM, no Node built-ins.

import {PDFRef} from 'pdf-lib';
const refOf = key => { const [a, b] = key.split(' ').map(Number); return PDFRef.of(a, b); };
import {n, literal, winAnsiBytes, wrap, firstUndrawable, fontWidth, standardFontOf} from './fonts.mjs';
import {FLAG, N, dictAt, numsAt, numAt, nameAt, textAt, parseDa, borderWidth, listRowsOf, mkRotation, res, get} from './form-read.mjs';
import {formatValue} from './form-af.mjs';
import {needsUnicode, unicodeFor} from './unicode-text.mjs';

// A field's text in a script the standard faces cannot draw is set in a system font: the first pass draws what it can and notes which fields need more (`NEEDS`), then
// `redrawWithUnicode` (called by formEdit once the edit is done) embeds the font for those texts and draws those fields again with `UNI` set.
let UNI = null;
const NEEDS = new Map();
/** The fields (name -> texts) whose text a first pass could not draw; emptied by the call. */
export function takeUnicodeNeeds() { const all = [...NEEDS]; NEEDS.clear(); return all; }
export const forgetUnicodeNeeds = () => NEEDS.clear();
/** Embed a font for the texts and draw each field again through `redraw(name)`. */
export async function redrawWithUnicode(pdf, needs, redraw) {
  UNI = await unicodeFor(pdf, needs.flatMap(([, texts]) => texts));
  try { for (const [name] of needs) redraw(name); } finally { UNI = null; }
}

export const CHECK_STYLES = Object.freeze([['Check', '4'], ['Circle', 'l'], ['Cross', '8'], ['Diamond', 'u'], ['Square', 'n'], ['Star', 'H']]);
export const BORDER_STYLES = Object.freeze([['Solid', 'S'], ['Dashed', 'D'], ['Beveled', 'B'], ['Inset', 'I'], ['Underline', 'U']]);
export const FIELD_FONTS = Object.freeze([['Helvetica', 'Helv', 'Helvetica'], ['Times Roman', 'TiRo', 'Times-Roman'], ['Courier', 'Cour', 'Courier']]);

/** The mark's style of a widget: its /MK /CA, else a check for check boxes and a circle for radio buttons. */
export function checkStyleOf(ctx, wd, kind) {
  const mk = dictAt(ctx, wd, 'MK');
  const ca = mk ? textAt(ctx, mk, 'CA') : null;
  return CHECK_STYLES.find(([, code]) => code === ca)?.[0] ?? (kind === 'radio' ? 'Circle' : 'Check');
}
const codeOfStyle = name => CHECK_STYLES.find(([l]) => l === name)?.[1] ?? '4';

const colorOp = (c, stroke = false) => (c.length === 1 ? `${n(c[0])} ${stroke ? 'G' : 'g'}` : c.length === 4 ? `${c.map(n).join(' ')} ${stroke ? 'K' : 'k'}` : `${c.map(n).join(' ')} ${stroke ? 'RG' : 'rg'}`);
const strokeOpOf = fill => { const m = /^(.*) (g|rg|k)$/.exec(fill); return m ? `${m[1]} ${{g: 'G', rg: 'RG', k: 'K'}[m[2]]}` : '0 G'; };

function mkColor(ctx, mk, key) {
  const v = mk ? numsAt(ctx, mk, key) : null;
  if (!v || ![1, 3, 4].includes(v.length)) return null;
  return v;
}

/** appearance.rs `placement`: the upright layout box and the /Matrix that turns it onto the widget rectangle. */
export function placement(rotation, w, h) {
  switch (rotation) {
    case 90: return {lw: h, lh: w, matrix: [0, 1, -1, 0, w, 0]};
    case 180: return {lw: w, lh: h, matrix: [-1, 0, 0, -1, w, h]};
    case 270: return {lw: h, lh: w, matrix: [0, -1, 1, 0, 0, h]};
    default: return {lw: w, lh: h, matrix: null};
  }
}

function circlePath(cx, cy, r) {
  const k = 0.5523 * r;
  return `${n(cx + r)} ${n(cy)} m ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c `
    + `${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c `;
}

/** Background and border from /MK and /BS: [content, border width]. */
function frame(ctx, wd, w, h, round) {
  const mk = dictAt(ctx, wd, 'MK');
  const bs = dictAt(ctx, wd, 'BS');
  const bg = mkColor(ctx, mk, 'BG'), bc = mkColor(ctx, mk, 'BC');
  const bw = Math.max(0, bs ? numAt(ctx, bs, 'W') ?? 1 : 1);
  const style = bs ? nameAt(ctx, bs, 'S') ?? 'S' : 'S';
  let c = '';
  if (round) {
    const cx = w / 2, cy = h / 2, r = Math.max(0, Math.min(w, h)) / 2;
    if (bg) c += `${colorOp(bg)}\n${circlePath(cx, cy, r)}f\n`;
    if (bc && bw > 0 && style === 'U') return [`${c}${strokeOpOf(colorOp(bc))}\n${n(bw)} w\n0 ${n(bw / 2)} m ${n(w)} ${n(bw / 2)} l S\n`, bw];
    if (bc && bw > 0 && bw >= 2 * r) return [`${c}${colorOp(bc)}\n${circlePath(cx, cy, r)}f\n`, 2 * r];
    if (bc && bw > 0) return [`${c}${strokeOpOf(colorOp(bc))}\n${n(bw)} w\n${style === 'D' ? '[3] 0 d\n' : ''}${circlePath(cx, cy, r - bw / 2)}S\n[] 0 d\n`, bw];
    return [c, 0];
  }
  if (bg) c += `${colorOp(bg)}\n0 0 ${n(w)} ${n(h)} re f\n`;
  if (bc && bw > 0) {
    if (style === 'U') return [`${c}${strokeOpOf(colorOp(bc))}\n${n(bw)} w\n0 ${n(bw / 2)} m ${n(w)} ${n(bw / 2)} l S\n`, bw];
    c += `${strokeOpOf(colorOp(bc))}\n${n(bw)} w\n${style === 'D' ? '[3] 0 d\n' : ''}${n(bw / 2)} ${n(bw / 2)} ${n(w - bw)} ${n(h - bw)} re S\n[] 0 d\n`;
    if (style === 'B' || style === 'I') {
      const [tl, br] = style === 'B' ? ['1 g', '0.5 g'] : ['0.5 g', '0.75 g'];
      const x0 = bw, y0 = bw, x1 = w - bw, y1 = h - bw, k = bw;
      c += `${tl}\n${n(x0)} ${n(y0)} m ${n(x0)} ${n(y1)} l ${n(x1)} ${n(y1)} l ${n(x1 - k)} ${n(y1 - k)} l ${n(x0 + k)} ${n(y1 - k)} l ${n(x0 + k)} ${n(y0 + k)} l f\n`
        + `${br}\n${n(x1)} ${n(y1)} m ${n(x1)} ${n(y0)} l ${n(x0)} ${n(y0)} l ${n(x0 + k)} ${n(y0 + k)} l ${n(x1 - k)} ${n(y0 + k)} l ${n(x1 - k)} ${n(y1 - k)} l f\n`;
      return [c, 2 * bw];
    }
    return [c, bw];
  }
  return [c, 0];
}

/** appearance.rs `auto_text_size`: the size a 0 Tf field uses, never under 4 pt. */
export function autoTextSize(text, width, height, multiline, widthOf) {
  const w = Number.isFinite(width) ? Math.max(1, width) : 1;
  const h = Number.isFinite(height) ? height : 0;
  if (multiline) {
    let size = 12;
    while (size > 4 && wrap(text, size, w, widthOf).length * size * 1.15 > h) size -= 0.5;
    return size;
  }
  const size = Math.max(4, Math.min(h, 14400) / 1.15);
  const tw = widthOf(text, size);
  return Number.isFinite(tw) && tw > w ? Math.max(4, (size * w) / tw) : size;
}
export const combAutoTextSize = height => (Number.isFinite(height) ? Math.min(12, Math.max(4, height / 1.15)) : 4);

const fontDict = (ctx, base) => ctx.obj({Type: 'Font', Subtype: 'Type1', BaseFont: base, ...(base === 'ZapfDingbats' || base === 'Symbol' ? {} : {Encoding: 'WinAnsiEncoding'})});
const baseName = standard => String(standard);

function formStream(ctx, content, w, h, matrix, resources) {
  const dict = {Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h], Resources: resources ?? {}};
  if (matrix) dict.Matrix = matrix;
  const d = ctx.obj(dict);
  const bytes = new Uint8Array(content.length);
  for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 0xff;
  const stream = ctx.flateStream(bytes, {});
  for (const [k, v] of d.entries()) stream.dict.set(k, v);
  return ctx.register(stream);
}

/** The draw font and its measuring function for a /DA font name. */
function fontFor(ctx, da) {
  const base = standardFontOf(da.font);
  return {name: da.font, base: baseName(base), widthOf: (s, size) => (UNI && needsUnicode(s) && UNI.canDraw(s) ? UNI.width(s, size) : fontWidth(da.font, s, size))};
}

/**
 * The appearance stream of a text or choice widget showing `values`.
 * @param {PDFContext} ctx
 * @param {object} f field (form-read), @param {object} w widget, @param {PDFDict} wd the widget dictionary
 * @returns {{ref: PDFRef, undrawn: string|null}}
 */
export function fieldAppearance(ctx, f, w, wd, values, {format = true} = {}) {
  let vals = values;
  if (format && (f.kind === 'text' || f.kind === 'combo') && vals.length === 1 && f.actions.format.kind !== 'none') vals = [formatValue(f.actions.format, vals[0])];
  const rot = mkRotation(ctx, wd);
  const place = placement(rot, Math.max(1, w.rect[2] - w.rect[0]), Math.max(1, w.rect[3] - w.rect[1]));
  const {lw: width, lh: height} = place;
  const da = parseDa(textAt(ctx, wd, 'DA') ?? f.da);
  let text = f.kind === 'combo' ? vals.map(v => f.options.find(([e]) => e === v)?.[1] ?? v).join(', ') : vals[0] ?? '';
  if (f.flags & FLAG.PASSWORD) text = '*'.repeat([...text].length);
  const font = fontFor(ctx, da);
  const [frameC, bw] = frame(ctx, wd, width, height, false);
  const pad = 2 + bw;
  const innerW = Math.max(1, width - 2 * pad);
  const q = (wd.has(N('Q')) ? Math.trunc(numAt(ctx, wd, 'Q') ?? 0) : f.quadding) | 0;
  let body = '';
  let undrawn = null;
  let usedUni = false;
  let size = da.size;
  const show = (x, y, t) => {
    t = [...t].map(ch => (ch === '\n' || ch === '\r' ? ' ' : ch)).join('');
    if (needsUnicode(t)) {
      if (UNI && UNI.canDraw(t)) { usedUni = true; return `1 0 0 1 ${n(x)} ${n(y)} Tm ${UNI.ops(t, size)}`; }
      if (!UNI) NEEDS.set(f.name, [...(NEEDS.get(f.name) ?? []), t]);
    }
    undrawn ??= firstUndrawable(t);
    return `1 0 0 1 ${n(x)} ${n(y)} Tm ${literal(winAnsiBytes(t))} Tj\n`;
  };
  const xFor = (t, size) => { const tw = font.widthOf(t, size); return q === 1 ? pad + (innerW - tw) / 2 : q === 2 ? width - pad - tw : pad; };
  let c = frameC;
  if (f.kind === 'list') {
    const rows = listRowsOf(ctx, f.da, ctx.lookup(refOf(f.id)), wd);
    size = rows.size;
    let y = height - rows.inset;
    for (const [exp, disp] of f.options.slice(rows.top)) {
      if (y - rows.row < 0) break;
      if (vals.includes(exp)) c += `0.6 0.75 0.86 rg\n${n(bw)} ${n(y - rows.row)} ${n(width - 2 * bw)} ${n(rows.row)} re f\n`;
      body += show(pad, y - rows.row + size * 0.25, disp);
      y -= rows.row;
    }
  } else {
    const comb = !!(f.flags & FLAG.COMB) && !(f.flags & (FLAG.MULTILINE | FLAG.PASSWORD)) && f.maxLen > 0 && f.kind === 'text';
    if (f.kind === 'text' && f.flags & FLAG.MULTILINE) {
      if (size === 0) size = autoTextSize(text, innerW, height - 2 * pad, true, font.widthOf);
      let y = height - pad - size * 0.85;
      for (const line of wrap(text, size, innerW, font.widthOf)) {
        if (y < -size) break;
        body += show(xFor(line, size), y, line);
        y -= size * 1.15;
      }
    } else {
      if (size === 0) size = comb ? combAutoTextSize(height - 2 * pad) : autoTextSize(text, innerW, height - 2 * pad, false, font.widthOf);
      const y = (height - 0.925 * size) / 2 + 0.207 * size;
      if (comb) {
        const cells = Math.max(1, f.maxLen), cell = width / cells;
        const mk = dictAt(ctx, wd, 'MK');
        const bc = mkColor(ctx, mk, 'BC');
        const lw = Math.max(0, dictAt(ctx, wd, 'BS') ? numAt(ctx, dictAt(ctx, wd, 'BS'), 'W') ?? 1 : 1);
        if (bc && bw > 0 && lw > 0 && cells >= 2 && cells <= 500) {
          c += `${strokeOpOf(colorOp(bc))}\n${n(lw)} w\n`;
          for (let i = 1; i < cells; i++) c += `${n(cell * i)} ${n(bw)} m ${n(cell * i)} ${n(height - bw)} l\n`;
          c += 'S\n';
        }
        [...text].slice(0, cells).forEach((ch, i) => { body += show(cell * i + (cell - font.widthOf(ch, size)) / 2, y, ch); });
      } else body += show(xFor(text, size), y, text);
    }
  }
  const content = `/Tx BMC\nq\n${c}${n(bw)} ${n(bw)} ${n(width - 2 * bw)} ${n(height - 2 * bw)} re W n\nBT\n/${font.name} ${n(size)} Tf\n${da.color}\n${body}ET\nQ\nEMC\n`;
  const resources = {Font: {[font.name]: fontDict(ctx, font.base), ...(usedUni ? Object.fromEntries(UNI.fonts().map(f => [f.name, f.ref])) : {})}};
  return {ref: formStream(ctx, content, width, height, place.matrix, resources), undrawn};
}

/** The on-state mark for `style`, centred on (cx, cy) in a box whose smaller side is `s`, in colour operation `color`. */
function checkMark(style, cx, cy, s, color) {
  const fill = color, stroke = strokeOpOf(color);
  const polygon = pts => `${fill}\n${pts.map(([x, y], i) => `${n(x)} ${n(y)} ${i === 0 ? 'm' : 'l'}`).join(' ')} h f\n`;
  const line = n(Math.max(1, s * 0.1));
  switch (style) {
    case 'Cross': { const d = s * 0.25; return `${stroke}\n${line} w 1 J\n${n(cx - d)} ${n(cy - d)} m ${n(cx + d)} ${n(cy + d)} l S\n${n(cx - d)} ${n(cy + d)} m ${n(cx + d)} ${n(cy - d)} l S\n`; }
    case 'Square': { const d = s * 0.22; return `${fill}\n${n(cx - d)} ${n(cy - d)} ${n(2 * d)} ${n(2 * d)} re f\n`; }
    case 'Diamond': { const d = s * 0.3; return polygon([[cx, cy + d], [cx + d, cy], [cx, cy - d], [cx - d, cy]]); }
    case 'Star': {
      const outer = s * 0.32, inner = outer * 0.382;
      return polygon(Array.from({length: 10}, (_, i) => { const a = Math.PI / 2 + (i * Math.PI) / 5; const r = i % 2 === 0 ? outer : inner; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }));
    }
    case 'Circle': { const r = s * 0.25; return `${fill}\n${circlePath(cx, cy, r)}f\n`; }
    default: return `${stroke}\n${line} w 1 J 1 j\n${n(cx - s * 0.28)} ${n(cy)} m ${n(cx - s * 0.08)} ${n(cy - s * 0.22)} l ${n(cx + s * 0.3)} ${n(cy + s * 0.25)} l S\n`;
  }
}

/** The on/off appearance dictionary entries for a check box or radio button: {N: {on: ref, Off: ref}}. */
export function checkBoxStates(ctx, f, w, wd, onName) {
  const rot = mkRotation(ctx, wd);
  const place = placement(rot, Math.max(1, w.rect[2] - w.rect[0]), Math.max(1, w.rect[3] - w.rect[1]));
  const {lw: width, lh: height} = place;
  const [frameC] = frame(ctx, wd, width, height, f.kind === 'radio');
  const style = checkStyleOf(ctx, wd, f.kind);
  const da = parseDa(textAt(ctx, wd, 'DA') ?? f.da);
  const s = Math.min(width, height);
  const mark = checkMark(style, width / 2, height / 2, s, da.color);
  const on = formStream(ctx, `${frameC}${mark}`, width, height, place.matrix);
  const off = formStream(ctx, frameC, width, height, place.matrix);
  return ctx.obj({N: {[onName]: on, Off: off}});
}

/** A push button's appearance: /MK background and border with its caption centred (appearance.rs `push_button_shown`). */
export function pushButtonAppearance(ctx, f, w, wd) {
  const rot = mkRotation(ctx, wd);
  const place = placement(rot, Math.max(1, w.rect[2] - w.rect[0]), Math.max(1, w.rect[3] - w.rect[1]));
  const {lw: width, lh: height} = place;
  const [frameC] = frame(ctx, wd, width, height, false);
  const mk = dictAt(ctx, wd, 'MK');
  const caption = mk ? textAt(ctx, mk, 'CA') ?? '' : '';
  const tp = mk ? numAt(ctx, mk, 'TP') : undefined;
  let content = frameC;
  let fonts = {};
  if (caption && tp !== 1) {
    const da = parseDa(textAt(ctx, wd, 'DA') ?? f.da);
    const font = fontFor(ctx, da);
    const size = da.size > 0 ? da.size : Math.min(14, Math.max(4, (height - 4) * 0.6));
    const tw = font.widthOf(caption, size);
    const x = Math.max(2, (width - tw) / 2), y = (height - 0.925 * size) / 2 + 0.207 * size;
    content += `q\nBT\n/${font.name} ${n(size)} Tf\n${da.color}\n1 0 0 1 ${n(x)} ${n(y)} Tm ${literal(winAnsiBytes(caption))} Tj\nET\nQ\n`;
    fonts = {[font.name]: fontDict(ctx, font.base)};
  }
  return formStream(ctx, content, width, height, place.matrix, {Font: fonts});
}

/** A signature field's (empty) appearance: its /MK background and border. */
export function signatureAppearance(ctx, w, wd) {
  const place = placement(mkRotation(ctx, wd), Math.max(1, w.rect[2] - w.rect[0]), Math.max(1, w.rect[3] - w.rect[1]));
  const [frameC] = frame(ctx, wd, place.lw, place.lh, false);
  return formStream(ctx, frameC, place.lw, place.lh, place.matrix);
}

export {codeOfStyle, colorOp, formStream};
