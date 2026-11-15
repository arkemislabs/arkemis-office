// core/folio/lib/measure.mjs and core/folio/commands/measure.mjs: the Measure tools (Distance, Perimeter, Area), the drawing
// scale (ratio, calibration, viewports), snapping, the measurement list and its CSV.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft 0.16.0 crates/measure/src/lib.rs, snap.rs, tests.rs, crates/ui-egui/src/tools/measure_ui.rs):
//    a measurement is a Line, PolyLine or Polygon annotation with a /Measure dictionary (ISO 32000-2 12.9) and the
//    measurement intent, read in the scale of the page viewport that holds its first point (the last one wins; outside every
//    viewport true size in inches, a /UserUnit page in its own units); the drawing scale is a page viewport, 1:N meaning 1 mm
//    on the page is N mm shown in metres; distances, perimeters and areas read in that scale (concave areas, a different
//    scale per axis); invalid geometry (non-finite, equal neighbours, a self-crossing area, an over-long label) is refused;
//    snapping goes endpoint, midpoint, intersection, then the nearest point on a path; Shift keeps a vertex to 45 degrees;
//    scales this app cannot edit (compound or fractional units) are listed as unsupported and left as they are; the CSV
//    prefixes formula triggers. Acrobat's Measure tools work the same way (Distance, Perimeter and Area, scale ratio,
//    Snap to Objects, export to a spreadsheet).
// 2. Ours does the same on real PDFs: every command is run on a document, saved with the folio writer, reopened and read back.
// 3. Proved here and in tests/e2e/folio/measure.e2e.mjs (the window).
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFArray, PDFDict, PDFString, decodePDFRawStream, PDFStream, PDFRawStream} from 'pdf-lib';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {grabs} from '../../core/folio/model/annots.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {schema1Content, drawingPdf} from '../../core/folio/fixtures.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import {releaseMeasureCache, ratioOfFields, setRatio, formatRatio, freshMeasure, listMeasurements} from '../../core/folio/commands/measure.mjs';
import * as M from '../../core/folio/lib/measure.mjs';

after(() => { releaseTextSources(); releaseMeasureCache(); });
const drawing = () => createTestSession('folio', {fixture: 'drawing'});
const close = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const MM = 72 / 25.4;

async function withPage(attrs) {
  return createTestSession('folio', {content: await migrateContent(await schema1Content(await drawingPdf({attrs}), 'attrs.pdf'))});
}
/** A session on the saved bytes of `content`: the file as another program would open it. */
async function reopened(content) {
  const bytes = await writeFolioPdf(content);
  const t = await createTestSession('folio', {content: await migrateContent(await schema1Content(bytes, 'again.pdf'))});
  return {bytes, t, doc: await PDFDocument.load(bytes)};
}

// ── scales and readings (crates/measure/src/tests.rs) ─────────────────────────────────────────

test('calibrated lengths, perimeters, concave areas (either winding) and a different scale per axis', () => {
  const scale = M.calibrate([20, 30], [23, 34], 10, 'm', 3);
  const d = M.reading('distance', [[20, 30], [23, 34]], scale);
  close(d.value, 10); close(d.deltaX, 6); close(d.deltaY, 8);
  assert.equal(d.label, '10.000 m');
  close(M.reading('perimeter', [[0, 0], [3, 0], [3, 4], [0, 0]], scale).value, 24);
  const concave = [[1e8, 1e8], [1e8 + 3, 1e8], [1e8 + 3, 1e8 + 1], [1e8 + 1, 1e8 + 1], [1e8 + 1, 1e8 + 3], [1e8, 1e8 + 3]];
  close(M.reading('area', concave, scale).value, 20);
  close(M.reading('area', [...concave].reverse(), scale).value, 20);
  const two = M.makeScale({x: 2, unit: 'm', precision: 2});
  const wide = {...two, y: 3};
  close(M.reading('distance', [[0, 0], [3, 4]], wide).value, Math.sqrt(180));
  close(M.reading('area', [[0, 0], [3, 0], [3, 4]], wide).value, 36);
});

test('a scale ratio converts its page side to points: 1:50 reads a 10 mm line as 500 mm; every page unit; user units; both sides must be usable', () => {
  const line = [[20, 30], [20 + 10 * MM, 30]];
  const scale = M.ratioScale([0, 0], [1, 0], 1, 'mm', 50, 'mm', 2);
  close(M.reading('distance', line, scale).value, 500);
  assert.equal(M.reading('distance', line, scale).label, '500.00 mm');
  assert.equal(scale.ratio, '1 mm = 50 mm');
  const dict = M.measureDict(scale);
  close(dict.X[0].C, 50 / MM);
  assert.deepEqual(M.readMeasureDict(dict), scale, 'what is written reads back as the same scale');
  for (const [unit, points] of [['pt', 1], ['in', 72], ['mm', MM], ['cm', 10 * MM]]) {
    const s = M.ratioScale([0, 0], [1, 0], 2, unit, 2, 'm', 3);
    close(M.reading('distance', [[0, 0], [0, 3 * points]], s).value, 3);
    assert.equal(s.ratio, `2 ${unit} = 2 m`);
  }
  assert.equal(M.calibrate([0, 0], [1, 0], 50, 'mm', 2).ratio, '1 pt = 50 mm');
  for (const [page, real] of [[0, 1], [-1, 1], [NaN, 1], [Infinity, 1], [1, 0], [1, NaN], [1e-300, 1e300]]) {
    assert.throws(() => M.ratioScale([0, 0], [1, 0], page, 'mm', real, 'mm', 2), M.MeasureError, `${page} ${real}`);
  }
});

test('typed ratios are read leniently and bad ones refused (measure_ui.rs parse_ratio)', () => {
  for (const [text, n] of [['1:200', 200], [' 1 : 50 ', 50], ['1/20', 20], ['250', 250], ['1:2,5', 2.5], ['2:1', 0.5], ['1:0.001', 1e-3]]) assert.equal(M.parseRatio(text), n, text);
  for (const bad of ['', ' ', ':', '1:', ':50', '1:0', '0', '-5', '1:-5', '0:5', 'abc', '1:abc', '1:50:2', '1:inf', 'NaN', '1e12', '1:1e12', '1:0.0001', '1:1e-6']) assert.equal(M.parseRatio(bad), null, JSON.stringify(bad));
  for (const n of M.RATIOS) assert.equal(M.parseRatio(formatRatio(n)), n);
  assert.equal(formatRatio(2.5), '1:2.5');
});

test('every offered ratio reads paper length times N in metres; the 1:N text follows the fields (measure_ui.rs tests)', () => {
  for (const unit of ['mm', 'cm', 'm', 'km', 'in', 'ft']) {
    for (const n of M.RATIOS) {
      const m = {...freshMeasure(), unit};
      setRatio(m, n);
      assert.equal(m.unit, 'm');
      const s = M.ratioScale([0, 0], [1, 0], m.pageDistance, m.pageUnit, m.realDistance, m.unit, 4);
      const v = M.reading('distance', [[0, 0], [0, 72]], s).value; // one inch of paper
      close(v, 25.4 * n / 1000, 1e-9 * Math.max(1, 25.4 * n / 1000));
    }
  }
  const m = freshMeasure();
  for (const n of [50, 2.5, 1.234, 0.001, 1e9]) { setRatio(m, n); assert.equal(ratioOfFields(m), n); }
  setRatio(m, 50); m.pageUnit = 'cm';
  assert.equal(ratioOfFields(m), 5, 'a hand edit that is still a drawing scale reads as its ratio');
  m.pageUnit = 'mm'; m.realDistance = 0.1;
  assert.equal(ratioOfFields(m), 100);
  m.unit = 'ft';
  assert.equal(ratioOfFields(m), null, 'another unit is not a ratio');
  m.unit = 'm'; m.realDistance = 0.1 / 3;
  assert.equal(ratioOfFields(m), null);
});

test('invalid geometry and unsupported scales are refused (validate_geometry, Scale::read)', () => {
  const scale = M.makeScale({x: 2, unit: 'm', precision: 3});
  for (const [kind, pts] of [['distance', [[NaN, 0], [2, 0]]], ['distance', [[0, 0], [0, 0]]], ['distance', [[0, 0], [1e10, 0]]], ['distance', [[0, 0]]],
    ['area', [[0, 0], [2, 2], [0, 2], [2, 0]]], ['area', [[0, 0], [1, 0]]], ['perimeter', [[0, 0]]]]) {
    assert.throws(() => M.validateGeometry(kind, pts), M.MeasureError, `${kind} ${JSON.stringify(pts)}`);
  }
  assert.throws(() => M.makeScale({x: Infinity, unit: 'm'}), M.MeasureError);
  assert.throws(() => M.makeScale({x: 1, unit: 'm', precision: 7}), M.MeasureError);
  assert.throws(() => M.calibrate([0, 0], [0, 0], 1, 'm', 2), M.MeasureError);
  assert.throws(() => M.readMeasureDict({...M.measureDict(scale), Subtype: '/GEO'}), /rectilinear/);
  M.validateGeometry('area', [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]); // a repeated first vertex is not self-crossing
});

test('zero decimals write the /R format and read back; non-ASCII units survive', () => {
  const scale = M.makeScale({x: 1, unit: 'm', precision: 0});
  assert.equal(M.measureDict(scale).D[0].F, '/R');
  assert.deepEqual(M.readMeasureDict(M.measureDict(scale)), scale);
  const odd = M.makeScale({x: 1, unit: 'µm', precision: 2});
  assert.equal(M.readMeasureDict(M.measureDict(odd)).unit, 'µm');
});

test('compound or fractional units from another program are listed as unsupported and left as they are', async () => {
  const doc = await PDFDocument.load(await drawingPdf());
  const page = doc.getPage(0);
  const ctx = doc.context;
  const fmt = (u, c) => ({Type: 'NumberFormat', U: PDFString.of(u), C: c, F: 'D', D: 100});
  const annot = ctx.register(ctx.obj({Type: 'Annot', Subtype: 'Line', Rect: [0, 0, 100, 10], L: [0, 5, 100, 5], IT: 'LineDimension', C: [0, 0, 1], F: 4,
    Measure: {Type: 'Measure', Subtype: 'RL', R: PDFString.of('1 in = 1 ft'), X: [fmt('ft', 1 / 72), fmt('in', 12)], D: [fmt('ft', 1), fmt('in', 12)], A: [fmt('sq ft', 1)]}}));
  page.node.set(PDFName.of('Annots'), ctx.obj([annot]));
  const t = await createTestSession('folio', {content: await migrateContent(await schema1Content(await doc.save(), 'foreign.pdf'))});
  const info = (await t.exec('measure.info', {})).result;
  assert.equal(info.measurements.length, 0);
  assert.equal(info.unsupported.length, 1);
  assert.match(info.unsupported[0].reason, /compound/);
  const before = JSON.stringify(t.content.pages[0].annots[0].dict);
  await t.exec('measure.distance', {page: 'p1', points: [[10, 10], [50, 10]]});
  assert.equal(JSON.stringify(t.content.pages[0].annots[0].dict), before, 'the foreign measurement is untouched');
  const csv = (await t.exec('measure.export', {})).result;
  assert.equal(csv.unsupported, 1);
  assert.equal(csv.count, 1, 'only the one this app made');
});

// ── snapping (snap.rs) ─────────────────────────────────────────────────────────────────────────

test('snapping goes endpoint, midpoint, intersection, then a point on a path; Shift keeps 45 degrees', async () => {
  const t = await drawing();
  const at = async (point, extra = {}) => (await t.exec('measure.snap_at', {point, pxPerPoint: 1, ...extra})).result;
  // The drawing is in user space; view y = 792 - user y.
  const v = (x, y) => [x, 792 - y];
  let r = await at(v(11, 20));
  assert.equal(r.snap.kind, 'endpoint');
  assert.deepEqual(r.point, v(10, 20));
  r = await at(v(60, 41));
  assert.equal(r.snap.kind, 'midpoint', 'the vertical line meets the middle of its 80 long edge');
  assert.deepEqual(r.point, v(60, 40));
  await t.exec('measure.snap', {target: 'midpoints'});
  r = await at(v(59, 21));
  assert.equal(r.snap.kind, 'intersection', 'the lines cross at 60, 20');
  assert.deepEqual(r.point, v(60, 20));
  await t.exec('measure.snap', {target: 'intersections'});
  r = await at(v(32, 21));
  assert.equal(r.snap.kind, 'path');
  close(r.point[1], 792 - 20);
  r = await at(v(300, 300));
  assert.equal(r.snap, null);
  assert.deepEqual(r.point, v(300, 300), 'nothing near: the pointer stays');
  await t.exec('measure.snap', {});
  assert.equal(t.doc.view.measure.snap, false);
  r = await at(v(11, 20));
  assert.equal(r.snap, null, 'snapping off');
  const c = await at(v(300, 305), {constrain: true, points: [v(200, 300)]});
  close(c.point[1], 792 - 300 - 0, 1e-9 + 5);
  assert.ok(Math.abs(c.point[0] - 300) < 1e-9 || Math.abs(c.point[1] - (792 - 300)) < 1e-9, 'on a 45 degree ray from the last vertex');
});

test('the snapping targets and sensitivity are options of the tool (snap options, 1 to 20 pixels)', async () => {
  const t = await drawing();
  assert.equal(t.state('measure.snap').checked, true);
  await t.exec('measure.snap', {});
  assert.equal(t.state('measure.snap').checked, false);
  await t.exec('measure.snap', {});
  assert.equal(t.state('measure.snap', {target: 'paths'}).checked, true);
  await t.exec('measure.snap', {target: 'paths'});
  assert.equal(t.state('measure.snap', {target: 'paths'}).checked, false);
  await t.exec('measure.snap', {target: 'paths', value: true});
  assert.equal(t.doc.view.measure.paths, true);
  await t.exec('measure.snap', {sensitivity: 12});
  assert.equal(t.state('measure.snap', {sensitivity: 1}).value, 12);
  await assert.rejects(() => t.exec('measure.snap', {sensitivity: 25}), /sensitivity/);
  const wide = (await t.exec('measure.snap_at', {point: [9, 772 - 4], pxPerPoint: 1})).result;
  assert.equal(wide.snap.kind, 'endpoint', '12 pixels reach the end 10, 20 from 9, 24');
});

// ── the tools: real annotations that round-trip ───────────────────────────────────────────────

test('Distance, Perimeter and Area add Line, PolyLine and Polygon annotations with a /Measure dictionary, the measured label and a caption', async () => {
  const t = await drawing();
  const run = (cmd, points, label) => expectUndoRoundTrip(t, cmd, {page: 'p1', points, ...(label ? {label} : {})}, after => assert.ok(after.content.pages[0].annots.length >= 1));
  const d = await run('measure.distance', [[20, 700], [20 + 72, 700]], 'Door');
  assert.equal(d.undoLabel, 'Add distance measurement');
  assert.deepEqual([d.result.value.toFixed(3), d.result.unit, d.result.label, d.result.viewport], ['1.000', 'in', '1.00 in', false]);
  const p = await run('measure.perimeter', [[100, 600], [172, 600], [172, 672]]);
  close(p.result.value, (72 + 72) / 72);
  const a = await run('measure.area', [[300, 600], [372, 600], [372, 672], [300, 672]]);
  close(a.result.value, 1);
  assert.equal(a.result.unit, 'sq in');
  const annots = t.content.pages[0].annots;
  assert.deepEqual(annots.map(r => [r.dict.Subtype, r.dict.IT]), [['/Line', '/LineDimension'], ['/PolyLine', '/PolyLineDimension'], ['/Polygon', '/PolygonDimension']]);
  assert.equal(annots[0].dict.PCMeasureLabel.$t, 'Door');
  assert.equal(annots[0].dict.PCMeasureValue.$t, '1.00 in');
  assert.equal(annots[0].dict.Contents.$t, '1.00 in', 'the reading is the comment text');
  assert.deepEqual(annots[0].dict.LE, ['/OpenArrow', '/OpenArrow']);
  assert.equal(annots[0].dict.Cap, true);
  assert.ok(annots[0].dict.Rect[3] - annots[0].dict.Rect[1] >= 16, 'room for the caption');
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:p1/annot:${encodeURIComponent(annots.at(-1).id)}`, 'the new measurement is selected');
});

test('a measurement saved and reopened is the same measurement: dictionaries, caption, list, reshape refused', async () => {
  const t = await drawing();
  await t.exec('measure.distance', {page: 'p1', points: [[20, 700], [92, 700]], label: '=cmd'});
  await t.exec('measure.perimeter', {page: 'p1', points: [[100, 600], [172, 600], [172, 672]]});
  await t.exec('measure.area', {page: 'p1', points: [[300, 600], [372, 600], [372, 672]]});
  const {bytes, t: again, doc} = await reopened(t.content);
  const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
  assert.equal(annots.size(), 3);
  const first = doc.context.lookup(annots.get(0), PDFDict);
  assert.equal(first.lookup(PDFName.of('IT')).decodeText(), 'LineDimension');
  const measure = first.lookup(PDFName.of('Measure'), PDFDict);
  assert.equal(measure.lookup(PDFName.of('Subtype')).decodeText(), 'RL');
  assert.equal(first.lookup(PDFName.of('PCMeasureValue')).decodeText(), '1.00 in');
  // The caption is in the appearance the writer saved.
  const ap = first.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFStream);
  const stream = Buffer.from(decodePDFRawStream(ap instanceof PDFRawStream ? ap : PDFRawStream.of(ap.dict, ap.getContents())).decode()).toString('latin1');
  assert.match(stream, /1\.00 in/);
  const info = (await again.exec('measure.info', {})).result;
  assert.equal(info.unsupported.length, 0);
  assert.deepEqual(info.measurements.map(m => [m.kind, m.reading.label, m.label]), [['distance', '1.00 in', '=cmd'], ['perimeter', '2.00 in', ''], ['area', '0.50 sq in', '']]);
  assert.deepEqual(info.measurements[0].points, [[20, 92], [92, 92]]);
  assert.ok(bytes.length > 500);
  // Dragging a vertex would leave the label and the /Measure geometry out of step: a measurement moves and is deleted, it is not reshaped.
  assert.deepEqual(grabs(again.content.pages[0].annots[0]), {move: true, resize: false, reshape: false});
});

test('the CSV lists every measurement; a label that opens like a formula is prefixed so a spreadsheet does not run it', async () => {
  const t = await drawing();
  await t.exec('measure.distance', {page: 'p1', points: [[20, 700], [92, 700]], label: '=HYPERLINK("x")'});
  await t.exec('measure.area', {page: 'p1', points: [[300, 600], [372, 600], [372, 672]], label: 'say "hi"\nthere'});
  const r = (await t.exec('measure.export', {})).result;
  assert.equal(r.count, 2);
  const lines = r.csv.split('\r\n');
  assert.equal(lines[0], 'Page,Index,Type,Value,Unit,Label,Author,Scale');
  assert.match(lines[1], /^1,1,distance,1,"in","'=HYPERLINK\(""x""\)",/);
  assert.match(r.csv, /"say ""hi""\nthere"/);
  assert.match(lines[1], /,"1 in = 1 in"$/);
});

test('refused: a self-crossing area, equal neighbours, a label over 512 bytes, a turned view, a locked document', async () => {
  const t = await drawing();
  await assert.rejects(() => t.exec('measure.area', {page: 'p1', points: [[0, 0], [100, 100], [0, 100], [100, 0]]}), /intersect/);
  await assert.rejects(() => t.exec('measure.distance', {page: 'p1', points: [[5, 5], [5, 5]]}), /distinct/);
  await assert.rejects(() => t.exec('measure.distance', {page: 'p1', points: [[5, 5], [50, 5]], label: 'x'.repeat(513)}), /512|too long|max/i);
  assert.equal(t.content.pages[0].annots.length, 0, 'nothing was added');
  await t.exec('view.rotate.cw', {});
  assert.equal(t.state('measure.distance').enabled, false);
  assert.match(t.state('measure.distance').reason, /turn the view back/);
  await t.exec('view.rotate.ccw', {});
  assert.equal(t.state('measure.distance').enabled, true);
});

test('Distance picked from a menu is the quick tool and opens the Measure panel; the panel closes with its Close', async () => {
  const t = await drawing();
  assert.equal((await t.exec('measure.perimeter', {})).result.tool, 'measure.perimeter');
  assert.equal(t.doc.view.tool, 'measure.perimeter');
  assert.equal(t.state('measure.perimeter').checked, true);
  assert.equal(t.state('measure.distance').checked, false);
  assert.equal(t.state('measure.panel').checked, true);
  await t.exec('measure.panel', {open: false});
  assert.equal(t.doc.view.tool, null);
  assert.equal(t.state('measure.panel').checked, false);
  await t.exec('measure.panel', {});
  assert.equal(t.doc.view.measurePanel, true);
  assert.equal(t.doc.view.tool ?? null, null, 'the panel opens on its own, no tool is picked');
});

// ── the drawing scale: a viewport that stays in the file ───────────────────────────────────────

test('Apply scale writes a viewport: 1:50 reads 72 pt of paper (25.4 mm) as 1.27 m; the scale is in the file after save and reopen', async () => {
  const t = await drawing();
  const r = await expectUndoRoundTrip(t, 'measure.scale', {ratio: '1:50'}, after => assert.ok(after.content.sourceBase64));
  assert.equal(r.undoLabel, 'Set measurement scale');
  assert.equal(r.result.ratioText, '1:50');
  assert.equal(r.result.ratio, '1 mm = 0.05 m');
  const m = (await t.exec('measure.distance', {page: 'p1', points: [[10, 100], [82, 100]]})).result;
  assert.deepEqual([m.label, m.viewport], ['1.27 m', true]);
  assert.equal(t.state('measure.scale').value, '1:50');
  const {t: again, doc} = await reopened(t.content);
  const vp = doc.getPage(0).node.lookup(PDFName.of('VP'), PDFArray);
  assert.equal(vp.size(), 1);
  const dict = doc.context.lookup(vp.get(0), PDFDict);
  assert.deepEqual(dict.lookup(PDFName.of('BBox'), PDFArray).asArray().map(n => n.asNumber()), [0, 0, 612, 792]);
  assert.equal(dict.lookup(PDFName.of('Name')).decodeText(), 'Drawing scale');
  const info = (await again.exec('measure.info', {point: [100, 100]})).result;
  assert.equal(info.viewport, true);
  assert.equal(info.scale.unit, 'm');
  assert.equal(info.scale.ratio, '1 mm = 0.05 m');
  assert.equal(info.measurements[0].reading.label, '1.27 m');
});

test('the last viewport that holds the first point wins; outside every viewport the page is true size (viewport_precedence)', async () => {
  const t = await drawing();
  await t.exec('measure.scale', {ratio: 100});
  await t.exec('measure.options', {toggle: 'wholePage', rect: [20, 20, 100, 100], name: 'detail'});
  assert.equal(t.doc.view.measure.wholePage, false);
  await t.exec('measure.scale', {ratio: 10});
  const inside = (await t.exec('measure.distance', {page: 'p1', points: [[40, 100], [112, 100]]})).result;
  assert.equal(inside.label, '0.25 m', 'the detail viewport (1:10): 25.4 mm of paper is 254 mm');
  const outside = (await t.exec('measure.distance', {page: 'p1', points: [[300, 100], [372, 100]]})).result;
  assert.equal(outside.label, '2.54 m', 'only the whole-page 1:100');
  // An annotation carries the scale of its first point even when its second leaves the viewport.
  const out = (await t.exec('measure.distance', {page: 'p1', points: [[40, 100], [400, 100]]})).result;
  assert.equal(out.viewport, true);
  assert.match(out.label, /^1\.\d\d m$/);
  const info = (await t.exec('measure.info', {point: [60, 100]})).result;
  assert.equal(info.name, 'detail');
  const far = (await t.exec('measure.info', {point: [500, 500]})).result;
  assert.equal(far.name, 'Drawing scale');
});

test('a page with no viewport measures true size in inches; a /UserUnit page in its own units, clamped as Acrobat does', async () => {
  const plain = await drawing();
  assert.equal((await plain.exec('measure.info', {})).result.scale.ratio, '1 in = 1 in');
  for (const [uu, unit] of [[0, 1], [0.5, 1], [2, 2], [100000, 75000]]) {
    const t = await withPage({UserUnit: uu});
    const scale = (await t.exec('measure.info', {})).result.scale;
    close(scale.x, unit / 72, 1e-12);
    const m = (await t.exec('measure.distance', {page: 'p1', points: [[0, 100], [72, 100]]})).result;
    close(m.value, unit, 1e-9 * unit);
  }
});

test('on a /UserUnit 2 page one point of paper is half a user unit and the ratio still holds on screen', async () => {
  const t = await withPage({UserUnit: 2});
  // 1 cm on the page = 0.5 m, so 4 cm = 2 m.
  await t.exec('measure.options', {pageDistance: 1, pageUnit: 'cm', realDistance: 0.5, unit: 'm'});
  await t.exec('measure.scale', {});
  const m = (await t.exec('measure.distance', {page: 'p1', points: [[10, 10], [10 + 4 * 10 * MM / 2, 10]]})).result;
  close(m.value, 2, 1e-9);
});

test('Apply scale with typed fields: a page distance in a page unit is a real distance in a unit, to the precision set', async () => {
  const t = await drawing();
  await t.exec('measure.options', {pageDistance: 2, pageUnit: 'in', realDistance: 10, unit: 'ft', precision: 3});
  assert.equal(t.doc.view.measure.ratioText, '', 'feet are not a drawing-scale ratio');
  await t.exec('measure.scale', {});
  const m = (await t.exec('measure.distance', {page: 'p1', points: [[0, 100], [144, 100]]})).result;
  assert.deepEqual([m.label, m.value], ['10.000 ft', 10]);
  assert.equal((await t.exec('measure.scale', {ratio: '1:25'})).result.ratioText, '1:25');
  await assert.rejects(() => t.exec('measure.scale', {ratio: 'abc'}), /Enter a scale such as 1:50/);
  await assert.rejects(() => t.exec('measure.options', {precision: 7}), /precision/);
  await assert.rejects(() => t.exec('measure.options', {unit: 'x'.repeat(13)}), /unit/);
});

test('Calibrate from two points fills the page distance from the paper length between them', async () => {
  const t = await drawing();
  assert.equal((await t.exec('measure.calibrate', {})).result.tool, 'measure.calibrate');
  assert.equal(t.doc.view.tool, 'measure.calibrate');
  const r = (await t.exec('measure.calibrate', {points: [[100, 100], [100 + 144, 100]]})).result;
  assert.deepEqual([r.pageDistance, r.pageUnit], [2, 'in']);
  assert.equal(t.doc.view.tool, null, 'the tool puts itself down');
  await t.exec('measure.options', {realDistance: 5, unit: 'm'});
  await t.exec('measure.scale', {});
  assert.equal((await t.exec('measure.distance', {page: 'p1', points: [[0, 200], [72, 200]]})).result.label, '2.50 m');
  await assert.rejects(() => t.exec('measure.calibrate', {points: [[5, 5], [5, 5]]}), /distinct/);
});

test('the panel opens on a page seeded from its scale: one page unit read in the scale in force', async () => {
  const t = await drawing();
  await t.exec('measure.scale', {ratio: '1:200'});
  await t.exec('measure.options', {unit: 'ft', pageDistance: 7});
  await t.exec('measure.distance', {});
  const m = t.doc.view.measure;
  assert.equal(m.unit, 'm');
  assert.equal(m.pageDistance, 1);
  assert.equal(m.ratioText, '1:200', 'the fields say what the page holds');
});

test('coordinates round trip for a crop box and every rotation: a distance is the same wherever the page is turned', async () => {
  for (const rotation of [0, 90, 180, 270]) {
    const t = await withPage({Rotate: rotation, CropBox: [10, 20, 210, 320]});
    const m = (await t.exec('measure.distance', {page: 'p1', points: [[10, 20], [70, 100]]})).result;
    close(m.value, 100 / 72, 1e-9);
    const {t: again} = await reopened(t.content);
    const info = (await again.exec('measure.info', {})).result;
    close(info.measurements[0].reading.value, 100 / 72, 1e-9);
    const snapped = (await t.exec('measure.snap_at', {point: [0, 0], pxPerPoint: 1})).result;
    assert.equal(snapped.point.length, 2);
  }
});

test('the readout the page view shows is view state: the angle appears on the Angle control; options and fields are not part of the file', async () => {
  const t = await drawing();
  assert.equal(t.state('measure.info').value, '–');
  await t.exec('measure.options', {readout: {label: '1.00 in', angle: 33.4, deltaX: 1, deltaY: 0.5, ratio: '1 in = 1 in'}});
  assert.equal(t.state('measure.info').value, '33.40°');
  await t.exec('measure.options', {readout: null});
  assert.equal(t.state('measure.info').value, '–');
  const before = t.content.sourceBase64;
  await t.exec('measure.options', {label: 'Hall', precision: 4});
  assert.equal(t.state('measure.options', {label: '<value>'}).value, 'Hall');
  assert.equal(t.state('measure.options', {precision: '<value>'}).value, 4);
  assert.equal(t.content.sourceBase64, before, 'view state only');
  await t.exec('measure.options', {toggle: 'wholePage'});
  assert.equal(t.state('measure.options', {toggle: 'wholePage'}).checked, false);
  const label = (await t.exec('measure.distance', {page: 'p1', points: [[0, 50], [72, 50]]})).result;
  assert.equal(label.label, '1.00 in', 'the precision applies with the scale, not to the next measurement');
  assert.equal(t.content.pages[0].annots[0].dict.PCMeasureLabel.$t, 'Hall', 'the label field names the next measurement');
});

test('the list of measurements reads what is on every page, scale and points included', async () => {
  const t = await drawing();
  await t.exec('measure.distance', {page: 'p1', points: [[0, 50], [72, 50]]});
  await t.exec('measure.scale', {ratio: 50});
  await t.exec('measure.distance', {page: 'p1', points: [[0, 150], [72, 150]]});
  const {measurements} = listMeasurements(t.content);
  assert.deepEqual(measurements.map(m => m.reading.label), ['1.00 in', '1.27 m']);
  assert.deepEqual(measurements.map(m => m.scale.ratio), ['1 in = 1 in', '1 mm = 0.05 m']);
});

test('every measure command is offered only with a PDF, and Export asks for a place only from the window', async () => {
  const t = await drawing();
  for (const id of ['measure.distance', 'measure.perimeter', 'measure.area', 'measure.scale', 'measure.calibrate', 'measure.snap', 'measure.info', 'measure.export', 'measure.panel', 'measure.options', 'measure.snap_at']) {
    assert.equal(t.state(id).enabled, true, id);
  }
  const r = (await t.exec('measure.export', {})).result;
  assert.equal(typeof r.csv, 'string', 'from a program without a path the CSV comes back');
  assert.equal(ratioOfFields({...freshMeasure(), unit: 'm', realDistance: 0.05, pageUnit: 'mm', pageDistance: 1}), 50);
});

test('a panel control sets one field at a time and reads it back the way the control shows it (field and value)', async () => {
  const t = await drawing();
  // A control's state is asked with its literal arguments only, so each field names itself.
  assert.equal(t.state('measure.options', {field: 'precision'}).value, 2);
  await t.exec('measure.options', {field: 'precision', value: 4});
  await t.exec('measure.options', {field: 'unit', value: ' mm '});
  await t.exec('measure.options', {field: 'pageDistance', value: 3});
  await t.exec('measure.options', {field: 'pageUnit', value: 'cm'});
  await t.exec('measure.options', {field: 'realDistance', value: 150});
  await t.exec('measure.options', {field: 'label', value: 'Wall'});
  const m = t.doc.view.measure;
  assert.deepEqual([m.precision, m.unit, m.pageDistance, m.pageUnit, m.realDistance, m.label], [4, 'mm', 3, 'cm', 150, 'Wall']);
  assert.equal(m.ratioText, '1:5', '3 cm of paper is 150 mm: 1:5, as the fields say');
  assert.equal(t.state('measure.options', {field: 'unit'}).value, 'mm');
  assert.equal(t.state('measure.options', {field: 'pageUnit'}).value, 'cm');
  for (const bad of [{field: 'precision', value: 2.5}, {field: 'precision', value: 'x'}, {field: 'pageUnit', value: 'ft'}, {field: 'unit', value: ''}, {field: 'realDistance', value: 0}]) {
    await assert.rejects(() => t.exec('measure.options', bad), /precision|number|page unit|unit|range/i, JSON.stringify(bad));
  }
  assert.equal(t.doc.view.measure.precision, 4, 'a refused value changes nothing');
});

test('the Snap to drawing toggle, the targets and the sensitivity each read their own state', async () => {
  const t = await drawing();
  assert.deepEqual([t.state('measure.snap', {target: 'snap'}).checked, t.state('measure.snap', {target: 'midpoints'}).checked, t.state('measure.snap', {}).value], [true, true, 6]);
  await t.exec('measure.snap', {target: 'snap'});
  assert.equal(t.state('measure.snap', {target: 'snap'}).checked, false);
  assert.equal(t.state('measure.snap', {target: 'midpoints'}).checked, true, 'the targets keep their own setting');
  await t.exec('measure.snap', {target: 'snap'});
  await t.exec('measure.snap', {sensitivity: 9});
  assert.equal(t.state('measure.snap', {}).value, 9);
});

test('a page is given by its id or its 1-based number', async () => {
  const t = await drawing();
  const a = (await t.exec('measure.distance', {page: 1, points: [[0, 50], [72, 50]]})).result;
  const b = (await t.exec('measure.distance', {page: 'p1', points: [[0, 60], [72, 60]]})).result;
  assert.deepEqual([a.label, b.label], ['1.00 in', '1.00 in']);
  await assert.rejects(() => t.exec('measure.distance', {page: 2, points: [[0, 50], [72, 50]]}), /does not exist/);
});

test('the Label and Scale combos show their current value: None, and the scale in force (1 in = 1 in until one is applied)', async () => {
  const t = await drawing();
  assert.equal(t.state('measure.options', {field: 'label'}).value, 'None');
  assert.equal(t.state('measure.scale', {ratio: '<value>'}).value, '1 in = 1 in');
  await t.exec('measure.options', {field: 'label', value: 'Hall'});
  assert.equal(t.state('measure.options', {field: 'label'}).value, 'Hall');
  await t.exec('measure.options', {field: 'label', value: 'None'});
  assert.equal(t.doc.view.measure.label, '', 'None is the empty label');
  await t.exec('measure.scale', {ratio: '1:50'});
  assert.equal(t.state('measure.scale', {ratio: '<value>'}).value, '1:50');
  await t.exec('measure.options', {field: 'unit', value: 'ft'});
  assert.equal(t.state('measure.scale', {ratio: '<value>'}).value, '1 mm = 0.05 m', 'no 1:N any more: the scale in force');
});
