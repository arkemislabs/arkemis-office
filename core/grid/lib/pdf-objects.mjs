// The floating objects of a sheet on a PDF page (Export as PDF): pictures (PNG and JPEG), charts (the chart renderer's drawing primitives,
// the same ones the worksheet paints), and the plain shapes (rectangle, rounded rectangle, ellipse, triangle, line, arrow, text box with
// its text). Icons, WordArt, ink, signature lines, equations and slicers are not drawn. Not in gridcraft (not checked against upstream).
// U:grid/formats-pdf-objects. No DOM, no Node built-ins.

import {rgb, degrees, pushGraphicsState, popGraphicsState, rectangle, clip, endPath} from 'pdf-lib';
import {sheetObjects, objectRect} from './objects.mjs';
import {colLeft, rowTop} from '../model/sheet.mjs';
import {resolveColor} from '../model/style.mjs';
import {resolveChart} from './chart-resolve.mjs';
import {render} from './chart-render.mjs';
import {base64ToBytes} from './image-info.mjs';

const col = (c, a = 1) => ({color: rgb(c[0] / 255, c[1] / 255, c[2] / 255), opacity: (c[3] === undefined ? 1 : c[3] / 255) * a});
const hex = (v, theme) => { const r = resolveColor(v, theme); return r ? [r[0], r[1], r[2], 255] : null; };

/** Chart primitives (origin at the object's top-left, y down, units are sheet pixels) onto the page. */
function drawPrims(pg, prims, ox, oy, k, fontFor) {
  const X = x => ox + x * k, Y = y => oy - y * k;
  const arcPt = (cx, cy, r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  for (const p of prims) {
    try {
      if (p.t === 'rect') {
        const o = {x: X(p.x), y: Y(p.y + p.h), width: p.w * k, height: p.h * k};
        if (p.fill) Object.assign(o, {color: col(p.fill).color, opacity: col(p.fill).opacity});
        if (p.stroke) Object.assign(o, {borderColor: col(p.stroke[0]).color, borderWidth: Math.max(0.25, p.stroke[1] * k), borderOpacity: col(p.stroke[0]).opacity});
        if (p.fill || p.stroke) pg.drawRectangle(o);
      } else if (p.t === 'line') {
        for (let i = 1; i < p.pts.length; i++) {
          const o = {start: {x: X(p.pts[i - 1][0]), y: Y(p.pts[i - 1][1])}, end: {x: X(p.pts[i][0]), y: Y(p.pts[i][1])}, thickness: Math.max(0.25, p.width * k), color: col(p.color).color, opacity: col(p.color).opacity};
          if (p.dash) o.dashArray = [4 * k, 3 * k];
          pg.drawLine(o);
        }
      } else if (p.t === 'poly' && p.pts.length > 2) {
        const d = `${p.pts.map((q, i) => `${i ? 'L' : 'M'}${q[0]} ${q[1]}`).join(' ')} Z`;
        const o = {x: ox, y: oy, scale: k};
        if (p.fill) Object.assign(o, {color: col(p.fill).color, opacity: col(p.fill).opacity});
        if (p.stroke) Object.assign(o, {borderColor: col(p.stroke[0]).color, borderWidth: Math.max(0.25, p.stroke[1] * k)});
        pg.drawSvgPath(d, o);
      } else if (p.t === 'wedge') {
        const large = (p.a1 - p.a0) % (Math.PI * 2) > Math.PI ? 1 : 0;
        const [x0, y0] = arcPt(p.cx, p.cy, p.ro, p.a0), [x1, y1] = arcPt(p.cx, p.cy, p.ro, p.a1);
        let d = `M${x0} ${y0} A${p.ro} ${p.ro} 0 ${large} 1 ${x1} ${y1}`;
        if (p.ri > 0) { const [x2, y2] = arcPt(p.cx, p.cy, p.ri, p.a1), [x3, y3] = arcPt(p.cx, p.cy, p.ri, p.a0); d += ` L${x2} ${y2} A${p.ri} ${p.ri} 0 ${large} 0 ${x3} ${y3}`; } else d += ` L${p.cx} ${p.cy}`;
        const o = {x: ox, y: oy, scale: k};
        if (p.fill) Object.assign(o, {color: col(p.fill).color, opacity: col(p.fill).opacity});
        if (p.stroke) Object.assign(o, {borderColor: col(p.stroke[0]).color, borderWidth: Math.max(0.25, p.stroke[1] * k)});
        pg.drawSvgPath(`${d} Z`, o);
      } else if (p.t === 'circle') {
        const o = {x: X(p.cx), y: Y(p.cy), xScale: p.r * k, yScale: p.r * k};
        if (p.fill) Object.assign(o, {color: col(p.fill).color, opacity: col(p.fill).opacity});
        if (p.stroke) Object.assign(o, {borderColor: col(p.stroke[0]).color, borderWidth: Math.max(0.25, p.stroke[1] * k)});
        pg.drawEllipse(o);
      } else if (p.t === 'text' && p.text) {
        const font = fontFor(!!p.bold), size = Math.max(3, p.size * k), t = font.clean(p.text);
        if (!t) continue;
        const w = font.widthOfTextAtSize(t, size);
        const along = p.align === 'center' ? -w / 2 : p.align === 'right' ? -w : 0;
        const down = p.valign === 'middle' ? size * 0.35 : p.valign === 'bottom' ? 0 : size * 0.8;
        const th = p.rotation ?? 0, c = Math.cos(th), s = Math.sin(th);
        // Along the text is (c, -s) on the page, and its baseline lies `down` below the anchor, perpendicular to that.
        const px = X(p.x) + along * c - down * s, py = Y(p.y) - along * s - down * c;
        font.draw(pg, t, {x: px, y: py, size, ...col(p.color), rotate: degrees(-th * 180 / Math.PI)});
      }
    } catch { /* one primitive that cannot be drawn does not lose the page */ }
  }
}

function drawShape(pg, shape, rect, k, x, y, theme, fontFor) {
  const w = rect.w * k, h = rect.h * k;
  const fill = shape.fill === 'none' ? null : hex(shape.fill, theme) ?? [68, 114, 196, 255];
  const line = shape.line === 'none' ? null : hex(shape.line, theme) ?? [47, 82, 143, 255];
  const lw = Math.max(0.5, (shape.lineWidth ?? 1) * k);
  const base = {};
  if (fill) Object.assign(base, {color: col(fill).color, opacity: col(fill).opacity});
  if (line) Object.assign(base, {borderColor: col(line).color, borderWidth: lw});
  const kind = shape.kind;
  if (kind === 'line' || kind === 'arrow') {
    const a = {x, y}, b = {x: x + w, y: y - h};
    pg.drawLine({start: a, end: b, thickness: lw, color: col(line ?? [0, 0, 0, 255]).color});
    if (kind === 'arrow') {
      const ang = Math.atan2(b.y - a.y, b.x - a.x), s = 6 * k;
      pg.drawLine({start: b, end: {x: b.x - s * Math.cos(ang - 0.45), y: b.y - s * Math.sin(ang - 0.45)}, thickness: lw, color: col(line ?? [0, 0, 0, 255]).color});
      pg.drawLine({start: b, end: {x: b.x - s * Math.cos(ang + 0.45), y: b.y - s * Math.sin(ang + 0.45)}, thickness: lw, color: col(line ?? [0, 0, 0, 255]).color});
    }
    return;
  }
  if (kind === 'ellipse') pg.drawEllipse({x: x + w / 2, y: y - h / 2, xScale: w / 2, yScale: h / 2, ...base});
  else if (kind === 'triangle') pg.drawSvgPath(`M${rect.w / 2} 0 L${rect.w} ${rect.h} L0 ${rect.h} Z`, {x, y, scale: k, ...base});
  else if (kind === 'rectangle' || kind === 'roundedRectangle' || kind === 'textBox') pg.drawRectangle({x, y: y - h, width: w, height: h, ...base});
  else return;
  const f = shape.format ?? {};
  const size = Math.max(4, (f.fontSize ?? 11) * 96 / 72 * k);
  const font = fontFor(!!f.bold);
  const text = font.clean(shape.text);
  if (!text) return;
  const color = hex(f.color, theme) ?? (kind === 'textBox' ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  const tw = font.widthOfTextAtSize(text, size);
  font.draw(pg, text, {x: kind === 'textBox' && (f.align ?? 'left') === 'left' ? x + 3 * k : x + (w - Math.min(tw, w)) / 2, y: y - h / 2 - size * 0.3, size, ...col(color)});
}

/**
 * Draws the sheet's objects that fall on the band of cells a page prints. `grid` holds the page's geometry: the band's top-left
 * (bandX, bandTop), its far corner (right, bottom), the scale in points per pixel `k`, and the first column and row of the band.
 */
export async function drawObjects(pdf, pg, cache, {content, si, sheet, eng, theme, k, band, fontFor}) {
  const objects = sheetObjects(sheet);
  if (!objects.length) return;
  const x0px = colLeft(sheet, band.firstCol), y0px = rowTop(sheet, band.firstRow);
  pg.pushOperators(pushGraphicsState(), rectangle(band.x, band.bottom, band.right - band.x, band.top - band.bottom), clip(), endPath());
  for (const {kind, object} of objects) {
    const r = objectRect(sheet, object.anchor ?? object);
    const x = band.x + (r.x - x0px) * k, y = band.top - (r.y - y0px) * k;
    if (x > band.right || x + r.w * k < band.x || y < band.bottom || y - r.h * k > band.top) continue;
    try {
      if (kind === 'image') {
        let img = cache.get(object);
        if (!img) {
          const bytes = base64ToBytes(object.data ?? '');
          if (!bytes) continue;
          img = /png/i.test(object.mime ?? '') ? await pdf.embedPng(bytes) : /jpe?g/i.test(object.mime ?? '') ? await pdf.embedJpg(bytes) : null;
          if (!img) continue;
          cache.set(object, img);
        }
        pg.drawImage(img, {x, y: y - r.h * k, width: r.w * k, height: r.h * k});
      } else if (kind === 'chart') {
        const prims = render(object, resolveChart(content, si, object, eng), r.w, r.h, {textWidth: (t, size, bold) => fontFor(!!bold).widthOfTextAtSize(t, size)});
        drawPrims(pg, prims, x, y, k, fontFor);
      } else if (kind === 'shape') drawShape(pg, object, r, k, x, y, theme, fontFor);
    } catch { /* an object that cannot be drawn is left out, not the page */ }
  }
  pg.pushOperators(popGraphicsState());
}

/** The texts the objects of a sheet print (shape text, chart titles, labels and axes), for finding their fonts before they are measured. */
export function objectTexts(content, si, sheet, eng) {
  const out = [];
  for (const {kind, object} of sheetObjects(sheet)) {
    try {
      if (kind === 'shape' && object.text) out.push(object.text);
      else if (kind === 'chart') {
        const r = objectRect(sheet, object.anchor ?? object);
        for (const p of render(object, resolveChart(content, si, object, eng), Math.max(1, r.w), Math.max(1, r.h))) if (p.t === 'text') out.push(p.text);
      }
    } catch { /* an object that cannot be drawn has no text to find */ }
  }
  return out;
}
