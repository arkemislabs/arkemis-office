// Measurements: calibrated distances, perimeters and areas in PDF user space (ISO 32000-2 12.9), as real annotations
// (a Line, PolyLine or Polygon with a /Measure dictionary and the measurement intent), page viewports that carry the
// drawing scale, the CSV export, and snapping to the page's drawn geometry.
//
// Translated from printcraft crates/measure/src/lib.rs (Scale: new, calibrate, ratio, validate, dictionary, read;
// reading; validate_geometry; add; list; scale_at_or; set_scale; csv; view_to_user) and snap.rs (Geometry: edge, curve,
// segment limits; snap; constrain; the path walker over a page's content and its forms) at
// 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt); the UI of
// crates/ui-egui/src/tools/measure_ui.rs (ratio parsing, RATIOS, page units) is in commands/measure.mjs.
// Not translated: compound or fractional units in a scale read from another program (those measurements are listed as
// unsupported and left as they are), and the geospatial location. No DOM, no Node built-ins.

import {PDFName, PDFArray, PDFDict, PDFStream, PDFRawStream, PDFNumber, decodePDFRawStream} from 'pdf-lib';
import {parseContent, mul, at as apply, IDENTITY} from './redact-content.mjs';
import {toJson} from '../model/pdf-read.mjs';

export class MeasureError extends Error {
  constructor(message) { super(message); this.name = 'MeasureError'; }
}
const invalid = m => new MeasureError(m);

export const MAX_POINTS = 2048;
const MAX_COORD = 1e9;
export const KINDS = Object.freeze(['distance', 'perimeter', 'area']);
const INTENT = {distance: 'LineDimension', perimeter: 'PolyLineDimension', area: 'PolygonDimension'};
export const kindOfIntent = it => ({LineDimension: 'distance', PolyLineDimension: 'perimeter', PolygonDimension: 'area'})[String(it ?? '').replace(/^\//, '')] ?? null;

export const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function checkPoints(points) {
  if (points.length > MAX_POINTS || points.some(p => p.some(v => !Number.isFinite(v) || Math.abs(v) > MAX_COORD))) throw invalid('measurement geometry must be finite, within 1e9 user units, and have at most 2048 vertices');
}

// ── scales ─────────────────────────────────────────────────────────────────────────────────────

/** The unit of the page side of a scale ratio. */
export const PAGE_UNITS = Object.freeze({pt: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54});

const ratioNumber = v => { const f = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''); return f === '0' || f.length > 24 ? v.toExponential() : f; };

/** A scale: user units to real units, X and Y, the unit, the distance and area factors, the precision and the ratio text. */
export function makeScale({x, y = x, unit, distanceFactor = 1, areaFactor = 1, areaUnit = `sq ${unit}`, precision = 2, ratio}) {
  const scale = {x, y, unit, distanceFactor, areaFactor, areaUnit, precision, ratio: ratio ?? `1 pt = ${x} ${unit}`};
  validateScale(scale);
  return scale;
}
export const DEFAULT_SCALE = Object.freeze({x: 1 / 72, y: 1 / 72, unit: 'in', distanceFactor: 1, areaFactor: 1, areaUnit: 'sq in', precision: 2, ratio: '1 in = 1 in'});

export function validateScale(s) {
  for (const f of [s.x, s.y, s.distanceFactor, s.areaFactor]) if (!Number.isFinite(f) || f < 1e-12 || f > 1e12) throw invalid('scale factors must be finite and between 1e-12 and 1e12');
  if (!Number.isInteger(s.precision) || s.precision < 0 || s.precision > 6) throw invalid('precision must be between 0 and 6 decimal places');
  for (const u of [s.unit, s.areaUnit]) if (!String(u).trim() || Array.from(u).length > 24 || /[\u0000-\u001f\u007f]/.test(u)) throw invalid('unit labels must be 1 to 24 printable characters');
  if (String(s.ratio).length > 256 || /[\u0000-\u001f\u007f]/.test(s.ratio)) throw invalid('invalid scale ratio');
}

/** Scale::calibrate: `a` and `b` are the two ends of a known real distance in user space. */
export function calibrate(a, b, realDistance, unit, precision) {
  checkPoints([a, b]);
  if (!Number.isFinite(realDistance) || realDistance <= 0) throw invalid('calibration distance must be finite and positive');
  const length = distance(a, b);
  if (length < 1e-6) throw invalid('calibration needs two distinct points');
  return makeScale({x: realDistance / length, unit, precision});
}

/** Scale::ratio: `page` `pageUnit` on the page is `real` `unit` in the real world ("1 mm = 50 mm" at 1:50); `a` and `b` are the user-space ends of one display point. */
export function ratioScale(a, b, page, pageUnit, real, unit, precision) {
  if (!Number.isFinite(page) || page <= 0 || !Number.isFinite(real) || real <= 0) throw invalid('both sides of a scale ratio must be finite and positive');
  const out = calibrate(a, b, real / (page * (PAGE_UNITS[pageUnit] ?? 1)), unit, precision);
  out.ratio = `${ratioNumber(page)} ${pageUnit} = ${ratioNumber(real)} ${unit}`;
  validateScale(out);
  return out;
}

/** "1:200", "1/200", "1 : 200" or a bare "200" (a comma works as the decimal mark): the N of 1:N, or null (measure_ui.rs parse_ratio). */
export function parseRatio(text) {
  const t = String(text).trim().replace(',', '.');
  const m = /^([^:/]+)[:/](.+)$/.exec(t);
  const n = m ? Number(m[2].trim()) / Number(m[1].trim()) : Number(t);
  return Number.isFinite(n) && n >= 1e-3 && n <= 1e9 ? n : null;
}
/** The drawing scales an architect's rule offers, as the N of 1:N. */
export const RATIOS = Object.freeze([1, 5, 10, 20, 25, 50, 100, 200, 500, 1000]);

const fmtNum = (unit, factor, precision) => [{Type: '/NumberFormat', U: {$t: unit}, C: factor, F: precision === 0 ? '/R' : '/D', ...(precision > 0 ? {D: 10 ** precision} : {}), FD: true, SS: {$t: ''}}];

/** Scale::dictionary as the model's JSON form of a /Measure dictionary. */
export function measureDict(s) {
  validateScale(s);
  const d = {Type: '/Measure', Subtype: '/RL', R: {$t: s.ratio}, X: fmtNum(s.unit, s.x, s.precision)};
  if (s.x !== s.y) { d.Y = fmtNum(s.unit, s.y, s.precision); d.CYX = 1; }
  d.D = fmtNum(s.unit, s.distanceFactor, s.precision);
  d.A = fmtNum(s.areaUnit, s.areaFactor, s.precision);
  return d;
}

/** Scale::read from the model's JSON /Measure dictionary: single-unit decimal scales only. */
export function readMeasureDict(d) {
  if (!d || typeof d !== 'object') throw invalid('invalid measure dictionary');
  if (d.Subtype && d.Subtype !== '/RL') throw invalid('only rectilinear measurement scales are supported');
  const format = key => {
    const a = d[key];
    if (!Array.isArray(a)) throw invalid('measurement scale lacks a number format');
    if (a.length !== 1) throw invalid('compound measurement units are not supported yet');
    const f = a[0];
    if (!f || typeof f !== 'object') throw invalid('invalid number format dictionary');
    let precision;
    if (f.F === '/R') precision = 0;
    else if (f.F === undefined || f.F === '/D') {
      const denom = f.D ?? 100;
      precision = [0, 1, 2, 3, 4, 5, 6].find(p => 10 ** p === denom);
      if (precision === undefined) throw invalid('unsupported measurement precision');
    } else throw invalid('fractional measurement formats are not supported yet');
    if (typeof f.C !== 'number') throw invalid('missing conversion factor');
    return [f.U?.$t ?? '', f.C, precision];
  };
  const [unit, x] = format('X');
  const y = d.Y ? format('Y')[1] * (typeof d.CYX === 'number' ? d.CYX : (() => { throw invalid('Y scale requires CYX for lengths and areas'); })()) : x;
  const [dUnit, distanceFactor, precision] = format('D');
  if (unit !== dUnit) throw invalid('different coordinate and distance units are not supported yet');
  const [areaUnit, areaFactor] = format('A');
  const s = {x, y, unit, distanceFactor, areaFactor, areaUnit, precision, ratio: d.R?.$t ?? ''};
  validateScale(s);
  return s;
}

// ── readings ───────────────────────────────────────────────────────────────────────────────────

/** reading(): live readings allow incomplete paths. */
export function reading(kind, points, scale) {
  checkPoints(points);
  validateScale(scale);
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot((points[i][0] - points[i - 1][0]) * scale.x, (points[i][1] - points[i - 1][1]) * scale.y);
  let area = 0;
  if (points.length >= 3) {
    const o = points[0];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      area += ((a[0] - o[0]) * (b[1] - o[1]) - (b[0] - o[0]) * (a[1] - o[1])) * 0.5;
    }
    area = Math.abs(area) * scale.x * scale.y * scale.areaFactor;
  }
  const first = points[0] ?? [0, 0], last = points.at(-1) ?? [0, 0];
  const dx = (last[0] - first[0]) * scale.x, dy = (last[1] - first[1]) * scale.y;
  length *= scale.distanceFactor;
  const value = kind === 'area' ? area : length;
  const unit = kind === 'area' ? scale.areaUnit : scale.unit;
  if (!Number.isFinite(value)) throw invalid('measurement overflows its scale');
  return {kind, value, unit, label: `${value.toFixed(scale.precision)} ${unit}`, deltaX: dx, deltaY: dy, angle: Math.atan2(dy, dx) * 180 / Math.PI, length, area};
}

/** An area's vertices without a repeated closing vertex. */
export function openPolygon(points) {
  const n = points.length;
  return n >= 4 && distance(points[0], points[n - 1]) < 1e-6 ? points.slice(0, -1) : points;
}

/** The point where two segments cross, or null. */
export function intersection(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (!Number.isFinite(den) || Math.abs(den) < 1e-12) return null;
  const q = [c[0] - a[0], c[1] - a[1]];
  const t = (q[0] * s[1] - q[1] * s[0]) / den, u = (q[0] * r[1] - q[1] * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + t * r[0], a[1] + t * r[1]] : null;
}

/** validate_geometry. */
export function validateGeometry(kind, pointsIn) {
  checkPoints(pointsIn);
  const points = kind === 'area' ? openPolygon(pointsIn) : pointsIn;
  if (kind === 'distance' && points.length !== 2) throw invalid('distance needs exactly two points');
  if (kind === 'perimeter' && points.length < 2) throw invalid('perimeter needs at least two points');
  if (kind === 'area' && points.length < 3) throw invalid('area needs at least three points');
  for (let i = 1; i < points.length; i++) if (distance(points[i - 1], points[i]) < 1e-6) throw invalid('adjacent measurement vertices must be distinct');
  if (kind === 'area') {
    const n = points.length;
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
      if (i === 0 && j + 1 === n) continue;
      if (intersection(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) throw invalid('area boundary must not intersect itself');
    }
  }
}

/** The CSV of measurements: spreadsheet formula triggers are prefixed (quoting alone does not stop them). */
export function csv(list) {
  const field = s => `"${(/^\s*[=+\-@]/.test(s) || /^[\t\r]/.test(s) ? "'" : '') + String(s).replace(/"/g, '""')}"`;
  let out = 'Page,Index,Type,Value,Unit,Label,Author,Scale\r\n';
  for (const m of list) out += `${m.page + 1},${m.index + 1},${m.reading.kind},${m.reading.value},${field(m.reading.unit)},${field(m.label)},${field(m.author)},${field(m.scale.ratio)}\r\n`;
  return out;
}

// ── snapping ───────────────────────────────────────────────────────────────────────────────────

const MAX_SEGMENTS = 20_000;
const MAX_TARGETS = 2 * MAX_SEGMENTS;
const nearest = (p, a, b) => {
  const v = [b[0] - a[0], b[1] - a[1]];
  const len = v[0] * v[0] + v[1] * v[1];
  if (len < 1e-18) return a;
  const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]) / len));
  return [a[0] + v[0] * t, a[1] + v[1] * t];
};

export class Geometry {
  constructor() { this.segments = []; this.endpoints = []; this.midpoints = []; this.truncated = false; this.unreadable = 0; }
  segment(a, b) {
    if (this.segments.length >= MAX_SEGMENTS) { this.truncated = true; return false; }
    if ([a, b].every(p => p.every(v => Number.isFinite(v) && Math.abs(v) <= MAX_COORD)) && distance(a, b) > 1e-9) { this.segments.push([a, b]); return true; }
    return false;
  }
  edge(a, b) {
    if (!this.segment(a, b)) return;
    if (this.endpoints.length + this.midpoints.length >= MAX_TARGETS) { this.truncated = true; return; }
    this.endpoints.push(a, b);
    this.midpoints.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  }
  curve([a, b, c, d], depth = 0) {
    if (this.segments.length >= MAX_SEGMENTS) { this.truncated = true; return; }
    if (depth >= 12 || Math.max(distance(b, nearest(b, a, d)), distance(c, nearest(c, a, d))) <= 0.2) { this.segment(a, d); return; }
    const avg = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const ab = avg(a, b), bc = avg(b, c), cd = avg(c, d), abc = avg(ab, bc), bcd = avg(bc, cd), mid = avg(abc, bcd);
    this.curve([a, ab, abc, mid], depth + 1);
    this.curve([mid, bcd, cd, d], depth + 1);
  }
  /** Geometry::intersection_limited: dense intersection searches are capped. */
  intersectionLimited(p, tolerance) { return this.segments.filter(([a, b]) => distance(p, nearest(p, a, b)) <= tolerance).slice(0, 257).length > 256; }
  /** Geometry::snap: the nearest endpoint, midpoint, intersection or point on a path within `tolerance` user units. */
  snap(p, tolerance, options = {}) {
    const {endpoints = true, midpoints = true, intersections = true, paths = true} = options;
    checkPoints([p]);
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 10_000) throw invalid('snap tolerance must be between 0 and 10000 user units');
    let best = null;
    const consider = (q, kind) => { const d = distance(p, q); if (d <= tolerance && (!best || d < best.distance - 1e-9)) best = {point: q, kind, distance: d}; };
    if (endpoints) for (const q of this.endpoints) consider(q, 'endpoint');
    if (midpoints) for (const q of this.midpoints) consider(q, 'midpoint');
    if (intersections) {
      const local = this.segments.filter(([a, b]) => distance(p, nearest(p, a, b)) <= tolerance).slice(0, 256);
      for (let i = 0; i < local.length; i++) for (let j = i + 1; j < local.length; j++) { const q = intersection(...local[i], ...local[j]); if (q) consider(q, 'intersection'); }
    }
    if (paths && !best) for (const [a, b] of this.segments) consider(nearest(p, a, b), 'path');
    return best;
  }
}

/** snap::constrain: rotate a proposed vertex onto the nearest 45-degree ray from the last vertex. */
export function constrain(last, point) {
  const v = [point[0] - last[0], point[1] - last[1]];
  const len = Math.hypot(v[0], v[1]);
  const angle = Math.round(Math.atan2(v[1], v[0]) / (Math.PI / 4)) * (Math.PI / 4);
  return [last[0] + len * Math.cos(angle), last[1] + len * Math.sin(angle)];
}

/**
 * The drawn geometry of a page (and the forms it draws) in user space: the straight edges of its paths, curves flattened,
 * with their endpoints and midpoints. `stream` decodes one content or form stream to bytes (null when it cannot).
 */
export function pageGeometry(context, page) {
  const g = new Geometry();
  const bytesOf = s => { try { return decodePDFRawStream(s instanceof PDFRawStream ? s : PDFRawStream.of(s.dict, s.getContents())).decode(); } catch { g.unreadable++; return null; } };
  const contents = page.node.get(PDFName.of('Contents'));
  const parts = [];
  const collect = o => { const v = context.lookup(o); if (v instanceof PDFArray) v.asArray().forEach(collect); else if (v instanceof PDFStream) { const b = bytesOf(v); if (b) { parts.push(b); parts.push(Uint8Array.of(32)); } } };
  if (contents) collect(contents);
  const res = page.node.Resources?.();
  const walk = (data, resources, matrix, depth) => {
    if (depth > 8 || g.truncated) return;
    const stack = [];
    let m = matrix, cur = null, start = null, closures = [], path = new Geometry();
    const pt = (x, y) => apply(m, x, y);
    const flush = painted => {
      for (const [a, b] of path.segments) g.edge(a, b);
      if (painted) for (const [a, b] of closures) g.edge(a, b);
      path = new Geometry(); closures = []; cur = null; start = null;
    };
    const close = () => { if (cur && start && distance(cur, start) > 1e-9) closures.push([cur, start]); };
    for (const op of parseContent(data)) {
      if (g.segments.length + path.segments.length >= MAX_SEGMENTS) { g.truncated = true; break; }
      const a = op.args.map(x => (x.k === 'num' ? x.v : 0));
      switch (op.op) {
        case 'q': stack.push(m); break;
        case 'Q': m = stack.pop() ?? matrix; break;
        case 'cm': m = mul(a.slice(0, 6), m); break;
        case 'm': close(); cur = start = pt(a[0], a[1]); break;
        case 'l': { const p = pt(a[0], a[1]); if (cur) path.edge(cur, p); cur = p; break; }
        case 'c': { const p1 = pt(a[0], a[1]), p2 = pt(a[2], a[3]), p3 = pt(a[4], a[5]); if (cur) path.curve([cur, p1, p2, p3]); cur = p3; break; }
        case 'v': { const p2 = pt(a[0], a[1]), p3 = pt(a[2], a[3]); if (cur) path.curve([cur, cur, p2, p3]); cur = p3; break; }
        case 'y': { const p1 = pt(a[0], a[1]), p3 = pt(a[2], a[3]); if (cur) path.curve([cur, p1, p3, p3]); cur = p3; break; }
        case 'h': if (cur && start) { if (distance(cur, start) > 1e-9) path.edge(cur, start); cur = start; } break;
        case 're': {
          const p0 = pt(a[0], a[1]), p1 = pt(a[0] + a[2], a[1]), p2 = pt(a[0] + a[2], a[1] + a[3]), p3 = pt(a[0], a[1] + a[3]);
          path.edge(p0, p1); path.edge(p1, p2); path.edge(p2, p3); path.edge(p3, p0);
          cur = start = p0; break;
        }
        case 'S': case 's': case 'B': case 'B*': case 'b': case 'b*': case 'f': case 'F': case 'f*': case 'n': {
          if (['s', 'b', 'b*'].includes(op.op) && cur && start && distance(cur, start) > 1e-9) path.edge(cur, start);
          const fills = ['B', 'B*', 'b', 'b*', 'f', 'F', 'f*'].includes(op.op);
          flush(fills);
          break;
        }
        case 'Do': {
          const name = op.args[0]?.k === 'name' ? op.args[0].v : null;
          const xs = resources ? context.lookup(resources.get(PDFName.of('XObject'))) : null;
          const xo = name && xs instanceof PDFDict ? context.lookup(xs.get(PDFName.of(name))) : null;
          if (xo instanceof PDFStream && context.lookup(xo.dict.get(PDFName.of('Subtype')))?.decodeText?.() === 'Form') {
            const mt = context.lookup(xo.dict.get(PDFName.of('Matrix')));
            const mm = mt instanceof PDFArray ? mt.asArray().map(x => (context.lookup(x) instanceof PDFNumber ? context.lookup(x).asNumber() : 0)) : IDENTITY;
            const inner = context.lookup(xo.dict.get(PDFName.of('Resources')));
            const body = bytesOf(xo);
            if (body) walk(body, inner instanceof PDFDict ? inner : resources, mul(mm.length === 6 ? mm : IDENTITY, m), depth + 1);
          }
          break;
        }
        default: break;
      }
    }
    flush(false);
  };
  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { joined.set(p, off); off += p.length; }
  walk(joined, res instanceof PDFDict ? res : null, IDENTITY, 0);
  return g;
}

export const MAX_VIEWPORTS = 1024;

/** The page's /UserUnit as Acrobat reads it: below 1 or not a number counts as 1, over 75000 as 75000 (one unit is that many points). */
export function userUnitOf(context, page) {
  const v = context.lookup(page.node.get(PDFName.of('UserUnit')));
  return v instanceof PDFNumber ? Math.min(75000, Math.max(1, v.asNumber())) : 1;
}

// ── scales on the page (viewports) ─────────────────────────────────────────────────────────────

/** A pdf-lib object as the model's JSON form with references followed (a number format array or dictionary may be indirect). */
function resolved(context, obj, depth = 0) {
  if (depth > 12) return null;
  const o = context.lookup(obj);
  if (o instanceof PDFArray) return o.asArray().map(x => resolved(context, x, depth + 1));
  if (o instanceof PDFDict) {
    const out = {};
    for (const [k, v] of o.entries()) out[k.decodeText()] = resolved(context, v, depth + 1);
    return out;
  }
  return toJson(o);
}

/** The viewports of a page ([{bbox, name, measure}]), last drawn last; `measure` is the /Measure dictionary in the model's JSON form. */
export function viewportsOf(context, page) {
  const raw = page.node.get(PDFName.of('VP'));
  const vp = context.lookup(raw);
  const out = [];
  if (raw === undefined) return out;
  if (!(vp instanceof PDFArray)) throw invalid('invalid page viewports');
  const num = o => { const v = context.lookup(o); return v instanceof PDFNumber ? v.asNumber() : NaN; };
  // The last viewports win; a page holds at most MAX_VIEWPORTS of its own.
  for (const e of vp.asArray().slice(-MAX_VIEWPORTS)) {
    const d = context.lookup(e);
    if (!(d instanceof PDFDict)) continue;
    const bbox = context.lookup(d.get(PDFName.of('BBox')));
    const b = bbox instanceof PDFArray ? bbox.asArray().map(num) : [];
    const nm = context.lookup(d.get(PDFName.of('Name')));
    out.push({bbox: b.length === 4 && b.every(Number.isFinite) ? b : null, measure: resolved(context, d.get(PDFName.of('Measure'))), name: nm && typeof nm.decodeText === 'function' ? nm.decodeText() : ''});
  }
  return out;
}
