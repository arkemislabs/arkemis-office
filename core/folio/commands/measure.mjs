// Measure: Distance, Perimeter and Area tools (real annotations that round-trip), the drawing scale (a ratio, a known
// distance, or typed values, kept on the page as a viewport), snapping to the drawn geometry, the list of measurements
// and their CSV export.
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/commands.rs:333       measure.* commands run measure_ui::command (open the panel, pick the tool)
//   crates/ui-egui/src/tools/measure_ui.rs   Tool (distance, perimeter, area, calibrate), MeasureView (the panel's fields:
//                                            snap options, sensitivity 6 px, label, drawing scale fields, precision, viewport),
//                                            snap_to_content, page_input (clicks add vertices, Shift constrains to 45 degrees,
//                                            Backspace takes one back, Enter or a double click finishes a perimeter or area,
//                                            a click on the first vertex closes an area, Escape cancels; a distance and a
//                                            calibration finish at two points), finish, set_ratio, parse_ratio, ratio_of_fields,
//                                            RATIOS, panel_body, export_csv
//   crates/measure/src/lib.rs, snap.rs       lib/measure.mjs
//   crates/engine/src/commands.rs            measure.distance, .perimeter, .area (Needs::Annotate), .scale, .info, .snap, .export
// The measurement is a Line (distance, intent LineDimension), PolyLine (perimeter) or Polygon (area) annotation with a
// /Measure dictionary, the label it measured and /PCMeasureValue; the drawing scale is a page viewport (/VP) so it stays in
// the file. Geospatial location (planned upstream, M12) is hidden (docs/spec/patches/folio/measure.json).
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/measure.test.mjs.
//
// Geometry in params is in the bridge convention (docs/architecture.md 14.5): page view points, origin at the top-left of
// the displayed page (crop box, rotation applied).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {PDFName, PDFArray, PDFHexString} from 'pdf-lib';
import {createAnnotation} from '../model/annots.mjs';
import {annotateState, meta, author} from '../model/index.mjs';
import {fromJson} from '../model/pdf-write.mjs';
import {viewToUser, userToView, pageRotation, viewSize} from '../lib/geom.mjs';
import {pagesOf, currentPage, annotAddress} from '../lib/comment-geometry.mjs';
import {loadSource, editable, commit} from '../lib/page-source.mjs';
import {writeOther, interactive, writeState} from '../lib/page-files.mjs';
import * as M from '../lib/measure.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/tools/measure_ui.rs', 'crates/measure/src/lib.rs', 'crates/measure/src/snap.rs']};

const noPdf = {enabled: false, reason: 'no PDF open'};
const TOOLS = ['distance', 'perimeter', 'area'];
export const SNAPS = ['endpoints', 'midpoints', 'intersections', 'paths'];
/** The panel's fields a control sets one at a time (`field` and `value`). */
const FIELDS = ['label', 'unit', 'precision', 'pageDistance', 'pageUnit', 'realDistance', 'name'];
const COLOR = [0, 0.47, 0.84];
const encoder = new TextEncoder();

/** The panel's fields (measure_ui.rs MeasureView), kept in the view: they are not part of the file. */
export const freshMeasure = () => ({
  snap: true, endpoints: true, midpoints: true, intersections: true, paths: true, sensitivity: 6, label: '',
  unit: 'in', precision: 2, pageDistance: 1, pageUnit: null, realDistance: 1, ratioText: '', scaleText: '1 in = 1 in', name: 'Drawing scale', wholePage: true, rect: [0, 0, 100, 100],
  readout: null,
});
/** Whether a view tool is one of Measure's. */
export const isMeasureTool = tool => typeof tool === 'string' && /^measure\.(distance|perimeter|area|calibrate)$/.test(tool);
/** The Measure panel is open: a measure tool is picked, or the panel was opened by itself. */
export const isMeasureOpen = view => !!view?.measurePanel || isMeasureTool(view?.tool);
const stateOf = ctx => ({...freshMeasure(), ...(ctx.view?.measure ?? {})});

/** Needs::Annotate with the view as it is: a turned view only looks. */
function annotate(ctx) {
  const st = annotateState(ctx.doc);
  if (!st.enabled) return st;
  return ctx.view?.rotation ? {enabled: false, reason: 'turn the view back first: a measurement is placed in the page\'s own space'} : st;
}
const documentOpen = ctx => (pagesOf(ctx).length ? {enabled: true} : noPdf);

const pointParam = s.array(s.number({min: -100000, max: 100000}), {min: 2, max: 2});
const userPoint = (page, p) => viewToUser(page, p[0], p[1]);
const pageParam = s.optional(s.union([s.string({min: 1, max: 120}), s.integer({min: 1, max: 100000})], {description: 'Page id or 1-based number (default: the page shown)'}));

// ── the scale fields (measure_ui.rs page_unit_of, ratio_of_fields, sync_ratio_text, set_ratio) ─────

/** The unit of the page side of a drawing scale: the one picked, else the real-world unit when it is pt, in, mm or cm, else points. */
export const pageUnitOf = m => m.pageUnit ?? (Object.hasOwn(M.PAGE_UNITS, m.unit.trim()) ? m.unit.trim() : 'pt');
/** The N of 1:N the fields stand for, when they are a plain drawing scale (real distance in m or mm), else null. */
export function ratioOfFields(m) {
  const unit = m.unit.trim();
  const real = unit === 'm' ? m.realDistance * 1000 : unit === 'mm' ? m.realDistance : null;
  if (real === null) return null;
  const n = real / (m.pageDistance * M.PAGE_UNITS[pageUnitOf(m)] * 25.4 / 72);
  const clean = Math.round(n * 1e6) / 1e6;
  return Number.isFinite(clean) && clean >= 1e-3 && clean <= 1e9 && Math.abs(clean - n) <= 1e-9 * n ? clean : null;
}
export const formatRatio = n => `1:${n}`;
const syncRatio = m => { const n = ratioOfFields(m); m.ratioText = n === null ? '' : formatRatio(n); return m; };
/** Fill the fields for 1:N: 1 mm on the page is N mm, shown in metres. */
export function setRatio(m, n) {
  m.unit = 'm'; m.pageUnit = 'mm'; m.pageDistance = 1; m.realDistance = n / 1000; m.ratioText = formatRatio(n);
  return m;
}

// ── reading the file ─────────────────────────────────────────────────────────────────────────────

/** The last source read for measuring (the probe runs on every pointer move, so the file is parsed once per revision). */
let cache = {src: null, doc: null, geometry: new Map()};
async function sourceDoc(content) {
  if (cache.src !== content.sourceBase64 || !cache.doc) cache = {src: content.sourceBase64, doc: await loadSource(content), geometry: new Map()};
  return cache;
}
export function releaseMeasureCache() { cache = {src: null, doc: null, geometry: new Map()}; }

/** The scale that measures at a user-space point: the last viewport of the page that holds it, else true size in inches. */
export async function scaleAtPoint(content, pageIndex, point) {
  const {doc} = await sourceDoc(content);
  const page = doc.getPage(content.pages[pageIndex].sourceIndex);
  for (const vp of [...M.viewportsOf(doc.context, page)].reverse()) {
    const b = vp.bbox;
    if (b && point[0] >= Math.min(b[0], b[2]) && point[0] <= Math.max(b[0], b[2]) && point[1] >= Math.min(b[1], b[3]) && point[1] <= Math.max(b[1], b[3])) {
      try { return {scale: M.readMeasureDict(vp.measure), name: vp.name, viewport: true}; } catch (e) { throw new CommandError('failed', e.message); }
    }
  }
  // Outside every viewport the page measures true size in inches (a /UserUnit page: its units are that many points).
  const uu = M.userUnitOf(doc.context, page);
  return {scale: uu === 1 ? {...M.DEFAULT_SCALE} : M.makeScale({x: uu / 72, unit: 'in'}), name: '', viewport: false};
}

/** The page's /UserUnit (points per user unit, 1 when absent). */
async function userUnit(content, pageIndex) {
  const {doc} = await sourceDoc(content);
  return M.userUnitOf(doc.context, doc.getPage(content.pages[pageIndex].sourceIndex));
}

/** The measurement records of the model ({page, index, id, author, label, points, scale, reading, kind}) and those that cannot be read. */
export function listMeasurements(content) {
  const out = [];
  const unsupported = [];
  (content?.pages ?? []).forEach((page, pi) => (page.annots ?? []).forEach((r, index) => {
    const kind = M.kindOfIntent(r.dict?.IT);
    if (!kind || !r.dict.Measure) return;
    try {
      const scale = M.readMeasureDict(r.dict.Measure);
      const flat = kind === 'distance' ? r.dict.L : r.dict.Vertices;
      if (!Array.isArray(flat) || flat.length % 2) throw new M.MeasureError('invalid measurement vertices');
      const points = Array.from({length: flat.length / 2}, (_, i) => [flat[2 * i], flat[2 * i + 1]]);
      M.validateGeometry(kind, points);
      out.push({page: pi, index, id: r.id, author: r.dict.T?.$t ?? '', label: r.dict.PCMeasureLabel?.$t ?? '', points, scale, reading: M.reading(kind, points, scale), kind});
    } catch (e) { unsupported.push({page: pi, index, reason: e.message}); }
  }));
  return {measurements: out, unsupported};
}

/** lib.rs `add`: the annotation record of a new measurement. */
function measurementRecord(ctx, page, kind, points, scale, label) {
  M.validateGeometry(kind, points);
  const info = M.reading(kind, points, scale);
  if (!(info.value > 0)) throw new M.MeasureError('measurement must have a positive length or area');
  if (encoder.encode(label).length > 512) throw new M.MeasureError('measurement label must be at most 512 bytes');
  const shape = kind === 'distance' ? {kind: 'Line', from: points[0], to: points.at(-1), start: 'None', end: 'OpenArrow'}
    : kind === 'perimeter' ? {kind: 'PolyLine', vertices: points, start: 'None', end: 'None'}
      : {kind: 'Polygon', vertices: points, cloud: false};
  const style = {color: COLOR, opacity: 1, width: 1, fill: null};
  const record = createAnnotation({shape, style, contents: info.label, author: author(ctx), rotation: pageRotation(page)}, meta(ctx));
  const d = record.dict;
  d.IT = `/${{distance: 'LineDimension', perimeter: 'PolyLineDimension', area: 'PolygonDimension'}[kind]}`;
  d.Measure = M.measureDict(scale);
  d.Subj = {$t: kind};
  d.PCMeasureLabel = {$t: label};
  d.PCMeasureValue = {$t: info.label};
  if (kind === 'distance') { d.LE = ['/OpenArrow', '/OpenArrow']; d.Cap = true; d.CP = '/Top'; }
  // Room for the readable caption above the geometry.
  const v = d.Rect;
  if (Array.isArray(v) && v.length === 4) {
    const width = Math.max(info.label.length * 6, 40);
    const cx = (v[0] + v[2]) / 2;
    d.Rect = [Math.min(v[0], cx - width / 2), v[1], Math.max(v[2], cx + width / 2), v[3] + 16];
  }
  return {record, info};
}

const wrap = fn => { try { return fn(); } catch (e) { if (e instanceof M.MeasureError) throw new CommandError('invalid_params', e.message); throw e; } };

/** measure_ui.rs panel_body (seeded_page): one page unit of the page, read in the scale that holds its top left, fills the fields. */
async function seedFields(ctx, m) {
  const {pi, page} = currentPage(ctx);
  const a = viewToUser(page, 0, 0);
  try {
    const {scale} = await scaleAtPoint(ctx.doc, pi, a);
    const uu = await userUnit(ctx.doc, pi);
    const unit = pageUnitOf({...m, unit: scale.unit, pageUnit: null});
    // A view point is a user unit; a point of paper is 1 / UserUnit of it.
    const b = viewToUser(page, M.PAGE_UNITS[unit] / uu, 0);
    const r = M.reading('distance', [a, b], scale);
    m.pageDistance = 1; m.realDistance = r.value; m.unit = scale.unit; m.pageUnit = null; m.precision = scale.precision; m.scaleText = scale.ratio;
  } catch { /* the fields keep what they held */ }
  return syncRatio(m);
}

function tool(kind) {
  const id = `measure.${kind}`;
  return {
    id, label: {distance: 'Measure distance', perimeter: 'Measure perimeter', area: 'Measure area'}[kind], risk: 'edit', needs: 'worker',
    description: `Measure ${kind}: pick the tool and open the Measure panel (${kind === 'distance' ? 'click two points' : kind === 'perimeter' ? 'click the vertices; Enter or a double click finishes' : 'click the vertices; a click on the first one closes, Enter or a double click finishes'}; Shift keeps to 45 degrees, Backspace takes a vertex back, Esc cancels), or with \`page\` and \`points\` (page view points) add the measurement at once: ${kind === 'distance' ? 'a Line' : kind === 'perimeter' ? 'a PolyLine' : 'a Polygon'} annotation with a /Measure dictionary, read in the scale of the page (the last viewport holding the first point, else true size in inches) with a caption. \`label\` names it.`,
    params: s.object({page: pageParam, points: s.optional(s.array(pointParam, {min: 2, max: M.MAX_POINTS})), label: s.optional(s.string({max: 512}))}),
    state(ctx) { const st = annotate(ctx); return st.enabled ? {...st, checked: ctx.view?.tool === id} : st; },
    async run(ctx, p) {
      if (!p.points) {
        // commands.rs: picking a measure command opens the panel and makes it the quick tool (again, it starts over).
        const m = await seedFields(ctx, stateOf(ctx));
        ctx.setView({tool: id, highlighter: false, measure: {...m, readout: null, ...(p.label !== undefined ? {label: p.label} : {})}});
        return {tool: id};
      }
      const {pi, page} = currentPage(ctx, p.page);
      const points = p.points.map(pt => userPoint(page, pt));
      const {scale, viewport} = await scaleAtPoint(ctx.doc, pi, points[0]);
      const {record, info} = wrap(() => measurementRecord(ctx, page, kind, points, scale, p.label ?? stateOf(ctx).label));
      ctx.change.splice(['pages', pi, 'annots'], (page.annots ?? []).length, 0, record);
      ctx.setSelection({ranges: [{anchor: annotAddress(page, record), focus: annotAddress(page, record)}], primary: 0});
      ctx.setUndoLabel(`Add ${kind} measurement`);
      return {id: record.id, annotation: annotAddress(page, record), kind, value: info.value, unit: info.unit, label: info.label, viewport};
    },
  };
}

export default defineCommands({
  family: 'measure', app: 'folio', upstream: UPSTREAM,
  commands: [
    ...TOOLS.map(tool),
    {
      id: 'measure.panel', label: 'Measure objects', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Open the Measure panel (Drawing scale, Snap to drawing, Measurement information, Saved measurements) without picking a tool; with `open: false` close it, which also puts a measure tool down. commands.rs:333 opens the panel for every measure.* command.',
      params: s.object({open: s.optional(s.boolean())}),
      state(ctx) { const st = documentOpen(ctx); return st.enabled ? {...st, checked: isMeasureOpen(ctx.view)} : st; },
      async run(ctx, p) {
        const m = stateOf(ctx);
        if (p.open === false) {
          ctx.setView({measurePanel: false, ...(isMeasureTool(ctx.view?.tool) ? {tool: null} : {}), measure: {...m, readout: null}});
          return {open: false};
        }
        const seeded = await seedFields(ctx, m);
        ctx.setView({measurePanel: true, measure: {...seeded, readout: null}});
        return {open: true};
      },
    },
    {
      id: 'measure.calibrate', label: 'Calibrate from two points', risk: 'edit', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Pick the calibration tool: click the two ends of a distance the page shows; the drawing distance field then holds that distance (in the page unit), to be set equal to the real distance and applied with the drawing scale. With `points` (two page view points) the field is set at once.',
      params: s.object({points: s.optional(s.array(pointParam, {min: 2, max: 2}))}),
      state(ctx) { const st = annotate(ctx); return st.enabled ? {...st, checked: ctx.view?.tool === 'measure.calibrate'} : st; },
      async run(ctx, p) {
        const m = stateOf(ctx);
        if (!p.points) { const seeded = await seedFields(ctx, m); ctx.setView({tool: 'measure.calibrate', highlighter: false, measure: {...seeded, readout: null}}); return {tool: 'measure.calibrate'}; }
        const d = Math.hypot(p.points[1][0] - p.points[0][0], p.points[1][1] - p.points[0][1]);
        if (!(d > 1e-6)) throw new CommandError('invalid_params', 'calibration needs two distinct points');
        // Paper points: a view point is a user unit, a point of paper 1 / UserUnit of it.
        // The page unit it was measured in stays picked, so typing the real unit after it does not change what the distance means.
        m.pageUnit = pageUnitOf(m);
        m.pageDistance = d * await userUnit(ctx.doc, currentPage(ctx).pi) / M.PAGE_UNITS[m.pageUnit];
        ctx.setView({tool: null, measure: {...syncRatio(m), readout: null}});
        return {pageDistance: m.pageDistance, pageUnit: pageUnitOf(m)};
      },
    },
    {
      id: 'measure.scale', label: 'Set measurement scale', risk: 'edit', needs: 'worker',
      description: 'Apply the drawing scale of a page (Measure > Drawing scale), kept on the page as a viewport so it stays in the file: measurements read in the last viewport that holds their first point. Give `ratio` ("1:50", "1/200" or 200: 1 mm on the page is N mm, shown in metres; it fills the fields and applies at once), else the fields apply as the Measure panel holds them (`measure.options`: the drawing distance in its page unit is the real distance in the unit, with `precision` decimals). The viewport is the whole page, or the panel\'s `rect` in page view points. Returns the scale and its ratio text.',
      params: s.object({page: pageParam, ratio: s.optional(s.union([s.string({min: 1, max: 40}), s.number()]))}),
      state(ctx, p) {
        const st = annotate(ctx);
        if (!st.enabled) return st;
        const m = stateOf(ctx);
        return {...st, value: m.ratioText || m.scaleText, ...(p && typeof p.ratio === 'number' ? {checked: m.ratioText === formatRatio(p.ratio)} : {})};
      },
      async run(ctx, p) {
        const {pi, page} = currentPage(ctx, p.page);
        const m = {...stateOf(ctx)};
        if (p.ratio !== undefined) {
          const n = typeof p.ratio === 'number' ? (p.ratio >= 1e-3 && p.ratio <= 1e9 ? p.ratio : null) : M.parseRatio(p.ratio);
          if (n === null) throw new CommandError('invalid_params', 'Enter a scale such as 1:50.', {path: '/ratio'});
          setRatio(m, n);
        }
        // One point of paper in user space (the scale is per user-space unit).
        const uu = await userUnit(ctx.doc, pi);
        const a = viewToUser(page, 0, 0);
        const b = viewToUser(page, 1 / uu, 0);
        const scale = wrap(() => M.ratioScale(a, b, m.pageDistance, pageUnitOf(m), m.realDistance, m.unit, m.precision));
        const size = viewSize(page);
        const box = m.wholePage ? [0, 0, size.width, size.height] : [m.rect[0], m.rect[1], m.rect[0] + m.rect[2], m.rect[1] + m.rect[3]];
        const c1 = viewToUser(page, box[0], box[1]);
        const c2 = viewToUser(page, box[2], box[3]);
        const bbox = [Math.min(c1[0], c2[0]), Math.min(c1[1], c2[1]), Math.max(c1[0], c2[0]), Math.max(c1[1], c2[1])];
        if (!(bbox[2] > bbox[0] && bbox[3] > bbox[1]) || encoder.encode(m.name).length > 256) throw new CommandError('invalid_params', 'the viewport needs a positive rectangle and a name of at most 256 bytes');
        const {doc, content: base} = await editable(ctx.doc, [pi]);
        const sp = doc.getPage(base.pages[pi].sourceIndex);
        const context = doc.context;
        let list = context.lookup(sp.node.get(PDFName.of('VP')));
        if (!(list instanceof PDFArray)) { list = context.obj([]); sp.node.set(PDFName.of('VP'), list); }
        if (list.size() >= 1024) throw new CommandError('too_large', 'the page has too many measurement viewports');
        list.push(context.obj({Type: 'Viewport', BBox: bbox, Name: PDFHexString.fromText(m.name), Measure: fromJson(context, M.measureDict(scale))}));
        await commit(ctx, doc, base);
        ctx.setView({measure: {...syncRatio(m), scaleText: scale.ratio}});
        ctx.setUndoLabel('Set measurement scale');
        return {scale, ratio: scale.ratio, ratioText: m.ratioText, bbox};
      },
    },
    {
      id: 'measure.options', label: 'Measurement options', risk: 'read', effect: 'view', undo: 'none',
      description: 'Set the fields of the Measure panel (they are view state, not part of the file): `label` for the next measurement, `unit` (up to 12 characters), `precision` (decimals, 0 to 6), `pageDistance` in `pageUnit` (pt, in, mm or cm) as `realDistance` of the unit, the viewport (`wholePage`, `toggle: "wholePage"` flips it; `rect` [x, y, width, height] in page points and `name`). The 1:N text follows the fields. Nothing is applied until Measure > Drawing scale is.',
      params: s.object({
        label: s.optional(s.string({max: 128})), unit: s.optional(s.string({min: 1, max: 12})), precision: s.optional(s.integer({min: 0, max: 6})),
        pageDistance: s.optional(s.number({min: 0.000001, max: 1e9})), pageUnit: s.optional(s.enum(Object.keys(M.PAGE_UNITS))), realDistance: s.optional(s.number({min: 0.000001, max: 1e12})),
        wholePage: s.optional(s.boolean()), toggle: s.optional(s.enum(['wholePage'])), rect: s.optional(s.array(s.number({min: 0, max: 1e9}), {min: 4, max: 4})),
        name: s.optional(s.string({min: 1, max: 128})),
        field: s.optional(s.enum(FIELDS)), value: s.optional(s.union([s.string({max: 128}), s.number()])),
        readout: s.optional(s.nullable(s.object({label: s.optional(s.string({max: 200})), angle: s.optional(s.number()), deltaX: s.optional(s.number()), deltaY: s.optional(s.number()), ratio: s.optional(s.string({max: 256}))}))),
      }),
      state(ctx, p) {
        const st = documentOpen(ctx);
        if (!st.enabled) return st;
        const m = stateOf(ctx);
        const key = p?.field ?? FIELDS.find(k => p && p[k] !== undefined);
        return {...st, ...(key ? {value: key === 'pageUnit' ? pageUnitOf(m) : key === 'label' && !m.label ? 'None' : m[key]} : {}), ...(p?.toggle === 'wholePage' ? {checked: m.wholePage} : {})};
      },
      run(ctx, params) {
        let p = params;
        if (params.field) {
          // One field a control sets (a spinner gives a number, a combo its text).
          const v = params.value;
          const num = ['precision', 'pageDistance', 'realDistance'].includes(params.field);
          const n = num ? Number(v) : NaN;
          if (num && (v === undefined || v === '' || !Number.isFinite(n))) throw new CommandError('invalid_params', `${params.field} is a number`, {path: '/value'});
          if (params.field === 'precision' && !(Number.isInteger(n) && n >= 0 && n <= 6)) throw new CommandError('invalid_params', 'precision is 0 to 6 decimals', {path: '/value'});
          if (params.field === 'pageUnit' && !Object.hasOwn(M.PAGE_UNITS, String(v))) throw new CommandError('invalid_params', 'the page unit is pt, in, mm or cm', {path: '/value'});
          if (params.field === 'unit' && (!String(v).trim() || String(v).length > 12)) throw new CommandError('invalid_params', 'the unit is 1 to 12 characters', {path: '/value'});
          if ((params.field === 'pageDistance' && !(n >= 0.000001 && n <= 1e9)) || (params.field === 'realDistance' && !(n >= 0.000001 && n <= 1e12))) throw new CommandError('invalid_params', `${params.field} is out of range`, {path: '/value'});
          p = {...params, [params.field]: num ? n : params.field === 'label' && v === 'None' ? '' : String(v ?? '')};
        }
        const m = {...stateOf(ctx)};
        for (const k of ['label', 'unit', 'precision', 'pageDistance', 'pageUnit', 'realDistance', 'wholePage', 'rect', 'name']) if (p[k] !== undefined) m[k] = p[k];
        if (p.toggle === 'wholePage') m.wholePage = !m.wholePage;
        if (p.unit !== undefined) m.unit = p.unit.trim() || stateOf(ctx).unit;
        if (p.readout !== undefined) m.readout = p.readout;
        else if (['unit', 'pageDistance', 'pageUnit', 'realDistance'].some(k => p[k] !== undefined)) syncRatio(m);
        ctx.setView({measure: m});
        const {readout, ...fields} = m;
        void readout;
        return fields;
      },
    },
    {
      id: 'measure.info', label: 'Measurement information', risk: 'read', needs: 'worker',
      description: 'Measurement information: the scale in force at `point` (page view points, default the page\'s top left) of `page` (default the page shown), the live reading of the measurement being drawn, and every measurement of the document with its type, value, unit, label and points; measurements whose scale this app does not edit (compound or fractional units from another program) are listed as unsupported and left untouched.',
      params: s.object({page: pageParam, point: s.optional(pointParam)}),
      state(ctx) {
        const st = documentOpen(ctx);
        const a = stateOf(ctx).readout?.angle;
        return st.enabled ? {...st, value: typeof a === 'number' ? `${a.toFixed(2)}°` : '–'} : st;
      },
      async run(ctx, p) {
        const {pi, page} = currentPage(ctx, p.page);
        const at = userPoint(page, p.point ?? [0, 0]);
        const {scale, name, viewport} = await scaleAtPoint(ctx.doc, pi, at);
        const {measurements, unsupported} = listMeasurements(ctx.doc);
        const {readout, ...fields} = stateOf(ctx);
        return {scale, name, viewport, options: fields, readout, measurements: measurements.map(x => ({...x, page: x.page + 1, index: x.index + 1})), unsupported: unsupported.map(u => ({...u, page: u.page + 1, index: u.index + 1}))};
      },
    },
    {
      id: 'measure.snap', label: 'Snap to drawing', risk: 'read', effect: 'view', undo: 'none',
      description: 'Snapping to the page\'s drawn geometry: with no params turn it on or off. `target` (endpoints, midpoints, intersections, paths) flips that target (`value` sets it), `enabled` sets snapping, `sensitivity` (pixels, 1 to 20) sets how near a point must be; the Measure tool then snaps its vertices (an endpoint or midpoint first, then an intersection, then the nearest point on a path).',
      params: s.object({enabled: s.optional(s.boolean()), target: s.optional(s.enum(['snap', ...SNAPS])), value: s.optional(s.boolean()), sensitivity: s.optional(s.number({min: 1, max: 20}))}),
      state(ctx, p) {
        const st = documentOpen(ctx);
        if (!st.enabled) return st;
        const m = stateOf(ctx);
        // The sensitivity spinner's value and the toggles' check mark: which one a control reads is the one it shows.
        return {...st, checked: p?.target && p.target !== 'snap' ? !!m[p.target] : m.snap, value: m.sensitivity};
      },
      run(ctx, p) {
        const m = {...stateOf(ctx)};
        if (p.target && p.target !== 'snap') m[p.target] = p.value ?? !m[p.target];
        else if (p.target === 'snap') m.snap = p.value ?? !m.snap;
        else if (p.enabled !== undefined) m.snap = p.enabled;
        else if (p.sensitivity === undefined) m.snap = !m.snap;
        if (p.sensitivity !== undefined) m.sensitivity = p.sensitivity;
        ctx.setView({measure: m});
        return {snap: m.snap, endpoints: m.endpoints, midpoints: m.midpoints, intersections: m.intersections, paths: m.paths, sensitivity: m.sensitivity};
      },
    },
    {
      id: 'measure.snap_at', label: 'Snap a point', risk: 'read', needs: 'worker',
      description: 'What the Measure tool does with a pointer at `point` (page view points) of `page`: the point snapped to the page\'s drawn geometry within the sensitivity (pixels at `pxPerPoint`, default 96/72) with the current snap options, or with `constrain` kept to 45 degrees from the last of `points` (the vertices placed so far); and, with `kind` and `points`, the reading of the measurement so far including this point (label, value, unit, angle). Returns {point, snap: {kind, distance} | null, reading | null, warning}.',
      params: s.object({
        page: pageParam, point: pointParam, pxPerPoint: s.optional(s.number({min: 0.01, max: 100})),
        constrain: s.optional(s.boolean()), kind: s.optional(s.enum(TOOLS)), points: s.optional(s.array(pointParam, {max: M.MAX_POINTS})),
      }),
      state: documentOpen,
      async run(ctx, p) {
        const {pi, page} = currentPage(ctx, p.page);
        const m = stateOf(ctx);
        const placed = (p.points ?? []).map(pt => userPoint(page, pt));
        let at = userPoint(page, p.point);
        let snap = null;
        let warning = null;
        // measure_ui.rs page_input: the pointer snaps first, then Shift keeps the vertex to 45 degrees from the last one.
        if (m.snap) {
          const {doc, geometry} = await sourceDoc(ctx.doc);
          const sp = ctx.doc.pages[pi].sourceIndex;
          if (!geometry.has(sp)) geometry.set(sp, M.pageGeometry(doc.context, doc.getPage(sp)));
          const g = geometry.get(sp);
          const hit = g.snap(at, m.sensitivity / (p.pxPerPoint ?? 96 / 72), m);
          if (hit) { at = hit.point; snap = {kind: hit.kind, distance: hit.distance}; }
          warning = g.truncated ? 'This drawing exceeds the snapping limit; only the first paths are used.' : g.unreadable ? 'Some page content couldn\'t be read; snapping uses the rest.' : null;
        }
        if (p.constrain && placed.length) at = M.constrain(placed.at(-1), at);
        let reading = null;
        if (p.kind) {
          const path = placed.length && M.distance(placed.at(-1), at) <= 1e-6 ? placed : [...placed, at];
          const {scale} = await scaleAtPoint(ctx.doc, pi, path[0]);
          try { const r = M.reading(p.kind, path, scale); reading = {label: r.label, value: r.value, unit: r.unit, angle: r.angle, deltaX: r.deltaX, deltaY: r.deltaY, ratio: scale.ratio}; } catch { reading = null; }
        }
        return {point: userToView(page, at[0], at[1]), snap, reading, warning};
      },
    },
    {
      id: 'measure.export', label: 'Export measurements as CSV', risk: 'read', needs: 'worker',
      description: 'Export the measurements of the document as CSV (Page, Index, Type, Value, Unit, Label, Author, Scale; spreadsheet formula triggers are prefixed with an apostrophe; measurements this app does not read are left out and counted in `unsupported`): to `path`, or from the window to the file picked in the system Save dialog; from a program without a path the CSV comes back as `csv`.',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096}))}),
      state(ctx) { const st = documentOpen(ctx); return st.enabled ? writeState(ctx) : st; },
      async run(ctx, p) {
        const {measurements, unsupported} = listMeasurements(ctx.doc);
        const text = M.csv(measurements);
        if (!p.path && !interactive(ctx)) return {count: measurements.length, unsupported: unsupported.length, csv: text};
        const w = await writeOther(ctx, p, encoder.encode(text), {title: 'Export measurements', name: 'measurements.csv', filters: [{name: 'CSV', extensions: ['csv']}]});
        return w.canceled ? {canceled: true} : {count: measurements.length, unsupported: unsupported.length, path: w.path};
      },
    },
  ],
});
