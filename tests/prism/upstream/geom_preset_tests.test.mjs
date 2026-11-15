// Ported upstream tests: deckcraft crates/geom/src/preset/tests.rs, the tests module of
// crates/geom/src/preset/extra.rs, crates/geom/src/lib.rs tests, crates/geom/src/squircle.rs tests
// and the resize tests in crates/engine/src/tools.rs, at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// Each test title names the Rust test it translates.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build, CATALOG, info, FillMode, handleValueAt, outline, isOpen, emuToPt, ptToEmu, parseUnit, formatUnit, xfrmAffine, xfrmBounds,
  groupChildAffine, distToSegment, squirclePathD} from '../../../core/prism/model/geom/index.mjs';
import {pt, apply, boundingBox, area, distanceToPath, rect, rectWidth, sub, hypot} from '../../../core/prism/model/geom/kurbo.mjs';
import {Pb} from '../../../core/prism/model/geom/preset/builder.mjs';
import {corner, segments} from '../../../core/prism/model/geom/squircle.mjs';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);
const onPath = (g, p, tol) => g.paths.some(sp => distanceToPath(sp.path, p, Math.min(0.01, Math.max(tol, 1e-4))) <= Math.max(tol, 1e-6) + 1e-9);

// ---- preset/tests.rs ----

test('preset::every_catalog_preset_builds_within_bounds', () => {
  for (const p of CATALOG) {
    for (const [w, h] of [[200, 100], [100, 200], [50, 50], [0, 0], [1, 300]]) {
      const g = build(p.name, w, h, []);
      assert.ok(g, `${p.name} did not build`);
      assert.ok(g.paths.length, `${p.name} has no paths`);
      for (const s of g.paths) {
        const bb = boundingBox(s.path);
        if (w > 0 && h > 0 && !p.name.includes('Connector') && !p.name.includes('allout')) {
          const tol = Math.max(w, h) * 0.35 + 1;
          assert.ok(bb.x0 >= -tol && bb.y0 >= -tol && bb.x1 <= w + tol && bb.y1 <= h + tol, `${p.name} ${w}x${h} out of bounds: ${JSON.stringify(bb)}`);
        }
        assert.ok(Number.isFinite(bb.x0) && Number.isFinite(bb.y1), `${p.name} produced non-finite geometry`);
      }
      assert.ok(Number.isFinite(g.textRect.x0) && Number.isFinite(g.textRect.y1), p.name);
    }
  }
});

test('preset::hostile_adjust_values_never_panic', () => {
  for (const p of CATALOG) for (const v of [NaN, Infinity, -1e12, 1e12, -1, 0]) assert.ok(build(p.name, 120, 80, Array(6).fill(v)), p.name);
  assert.equal(build('rect', NaN, 10, []), null);
  assert.equal(build('noSuchShape', 10, 10, []), null);
});

test('preset::catalog_names_are_unique', () => {
  const names = CATALOG.map(p => p.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.length >= 140, `catalog has ${names.length} presets`);
});

test('preset::round_rect_handle_maps_back', () => {
  const g = build('roundRect', 200, 100, [16667]);
  const h = g.handles[0];
  assert.ok(Math.abs(handleValueAt(h, h.pos) - 16667) <= 1);
  assert.equal(handleValueAt(h, pt(-50, 0)), 0);
  assert.equal(handleValueAt(h, pt(500, 0)), 50000);
});

test('preset::partial_circle_angle_handles_map_back', () => {
  for (const name of ['pie', 'chord', 'arc']) {
    let g = build(name, 200, 100, [0, 16200000]);
    assert.deepEqual(g.handles.map(h => h.index), [0, 1], name);
    let [s, e] = g.handles;
    assert.ok(hypot(sub(s.pos, pt(200, 50))) < 1e-6, name);
    assert.ok(hypot(sub(e.pos, pt(100, 0))) < 1e-6, name);
    assert.equal(handleValueAt(s, s.pos), 0);
    assert.equal(handleValueAt(e, e.pos), 16200000);
    assert.equal(handleValueAt(s, pt(100, 100)), 5400000);
    const k = Math.sqrt(2000);
    g = build(name, 200, 100, [2700000, 8100000]);
    [s, e] = g.handles;
    assert.ok(hypot(sub(s.pos, pt(100 + k, 50 + k))) < 1e-6, `${name} ${JSON.stringify(s.pos)}`);
    assert.ok(hypot(sub(e.pos, pt(100 - k, 50 + k))) < 1e-6, `${name} ${JSON.stringify(e.pos)}`);
    for (const [deg, h] of [[45, s], [135, e]]) {
      const on = ((h.pos.x - 100) / 100) ** 2 + ((h.pos.y - 50) / 50) ** 2;
      assert.ok(Math.abs(on - 1) < 1e-9);
      assert.ok(Math.abs(handleValueAt(h, h.pos) - deg * 60000) <= 1, `${name} ${deg}`);
    }
  }
  for (const deg of [45, 135, 200, 315]) {
    const g = build('blockArc', 200, 100, [deg * 60000, 0, 25000]);
    const start = g.handles.find(h => h.index === 0);
    const on = ((start.pos.x - 100) / 87.5) ** 2 + ((start.pos.y - 50) / 37.5) ** 2;
    assert.ok(Math.abs(on - 1) < 1e-9, `blockArc ${deg}`);
    const d = sub(start.pos, pt(100, 50));
    const a = ((Math.atan2(d.y, d.x) * 180) / Math.PI + 360) % 360;
    assert.ok(Math.abs(a - deg) < 1e-6, `blockArc ${deg}: ${a}`);
    assert.ok(Math.abs(handleValueAt(start, start.pos) - deg * 60000) <= 1);
  }
  const g = build('blockArc', 200, 100, [10800000, 0, 25000]);
  assert.equal(handleValueAt(g.handles.find(h => h.index === 0), g.handles.find(h => h.index === 0).pos), 10800000);
  const thick = g.handles.find(h => h.index === 2);
  assert.ok(Math.abs(handleValueAt(thick, thick.pos) - 25000) <= 1);
});

test('preset::presets_with_adjust_values_expose_handles', () => {
  const NO_HANDLES = new Set(['curvedConnector3', 'snip2SameRect', 'snip2DiagRect', 'snipRoundRect', 'round1Rect', 'round2SameRect', 'round2DiagRect',
    'teardrop', 'halfFrame', 'corner', 'diagStripe', 'foldedCorner', 'smileyFace', 'moon', 'gear6', 'gear9', 'bracketPair', 'bracePair', 'leftBracket',
    'rightBracket', 'leftBrace', 'rightBrace', 'leftRightArrow', 'upDownArrow', 'quadArrow', 'leftRightUpArrow', 'bentArrow', 'uturnArrow',
    'curvedRightArrow', 'curvedLeftArrow', 'curvedUpArrow', 'curvedDownArrow', 'leftUpArrow', 'bentUpArrow', 'circularArrow', 'leftCircularArrow',
    'leftRightCircularArrow', 'swooshArrow', 'rightArrowCallout', 'downArrowCallout', 'leftArrowCallout', 'upArrowCallout', 'leftRightArrowCallout',
    'upDownArrowCallout', 'quadArrowCallout', 'mathPlus', 'mathMinus', 'mathMultiply', 'mathDivide', 'mathEqual', 'mathNotEqual', 'ribbon2', 'ribbon',
    'ellipseRibbon2', 'ellipseRibbon', 'leftRightRibbon', 'verticalScroll', 'horizontalScroll', 'wave', 'doubleWave', 'borderCallout1', 'borderCallout2',
    'borderCallout3', 'accentCallout1', 'accentCallout2', 'accentCallout3', 'callout1', 'callout2', 'callout3', 'accentBorderCallout1',
    'accentBorderCallout2', 'accentBorderCallout3']);
  for (const p of CATALOG) {
    if (!p.defaults.length || NO_HANDLES.has(p.name)) continue;
    assert.ok(build(p.name, 200, 100, []).handles.length, `${p.name} has adjust values but no handles`);
  }
});

test('preset::rect_area_and_ellipse_area', () => {
  near(Math.abs(area(build('rect', 100, 50, []).paths[0].path)), 5000, 1e-6);
  const expect = Math.PI * 50 * 25;
  assert.ok(Math.abs(Math.abs(area(build('ellipse', 100, 50, []).paths[0].path)) - expect) / expect < 0.01);
});

test('preset::lines_are_open', () => {
  assert.ok(isOpen(build('line', 10, 10, [])));
  assert.ok(!isOpen(build('rect', 10, 10, [])));
});

test('preset::fixed_shapes_follow_the_standards_coordinates', () => {
  const w = 216, h = 108;
  const at = (x, y) => pt((w * x) / 21600, (h * y) / 21600);
  let g = build('lightningBolt', w, h, []);
  for (const [x, y] of [[8472, 0], [16577, 12007], [21600, 21600], [0, 3890]]) assert.ok(onPath(g, at(x, y), 1e-6), `lightningBolt ${x},${y}`);
  g = build('irregularSeal1', w, h, []);
  assert.ok(onPath(g, at(14522, 0), 1e-6) && onPath(g, at(8485, 21600), 1e-6));
  g = build('irregularSeal2', w, h, []);
  assert.ok(onPath(g, at(14790, 0), 1e-6) && onPath(g, at(4917, 21600), 1e-6));
  g = build('heart', w, h, []);
  assert.ok(onPath(g, pt(w / 2, h), 1e-6) && onPath(g, pt(w / 2, h / 4), 1e-6));
  g = build('flowChartDocument', w, h, []);
  assert.ok(onPath(g, at(21600, 17322), 1e-6) && onPath(g, at(0, 20172), 1e-6));
  g = build('flowChartPunchedTape', w, h, []);
  assert.ok(onPath(g, pt(w / 4, h / 5), 1e-3) && onPath(g, pt(w * 0.75, 0), 1e-3));
  g = build('flowChartMultidocument', w, h, []);
  assert.ok(onPath(g, at(2972, 0), 1e-6) && onPath(g, at(18595, 18022), 1e-6));
});

test('preset::notched_arrow_notch_parallels_the_head', () => {
  for (const [w, h, adj, x1] of [[200, 100, [50000, 50000], 25], [300, 120, [80000, 30000], 28.8]]) {
    const g = build('notchedRightArrow', w, h, adj);
    const notch = g.paths[0].path.find(e => (e.t === 'M' || e.t === 'L') && Math.abs(e.p.y - h / 2) < 1e-9 && e.p.x < w / 2);
    assert.ok(notch && Math.abs(notch.p.x - x1) < 1e-6, `${w}x${h}: ${JSON.stringify(notch)}`);
  }
});

test('preset::equation_shapes_match_powerpoints_outlines', () => {
  let g = build('mathMultiply', 216, 216, []);
  for (const [x, y] of [[0.32333, 0.15702], [0.5, 0.33369], [0.84298, 0.32333], [0.66631, 0.5], [0.33369, 0.5]]) assert.ok(onPath(g, pt(216 * x, 216 * y), 0.01), `multiply ${x},${y}`);
  g = build('mathEqual', 300, 120, []);
  for (const [x, y] of [[0.13255, 0.5588], [0.86745, 0.794], [0.13255, 0.206], [0.86745, 0.4412]]) assert.ok(onPath(g, pt(300 * x, 120 * y), 0.01), `equal ${x},${y}`);
  g = build('mathPlus', 216, 216, []);
  assert.ok(onPath(g, pt(216 * 0.3824, 216 * 0.13255), 0.01) && onPath(g, pt(216 * 0.86745, 216 * 0.6176), 0.01));
  g = build('mathNotEqual', 100, 260, []);
  const bb = boundingBox(g.paths[0].path);
  assert.ok(Math.abs(bb.x0 + 22.242) < 0.01 && Math.abs(bb.x1 - 122.242) < 0.01 && Math.abs(bb.y0) < 1e-6 && Math.abs(bb.y1 - 260) < 1e-6, JSON.stringify(bb));
});

test('preset::sun_and_waves_match_powerpoints_outlines', () => {
  const k = 216;
  let g = build('sun', k, k, []);
  for (const [x, y] of [[0.85352, 0.14644], [0.76161, 0.33987], [0.66013, 0.23839], [0.42825, 0.79823], [0.20177, 0.57175], [0.75, 0.5], [0.5, 0.25]]) {
    assert.ok(onPath(g, pt(k * x, k * y), 0.02), `sun ${x},${y}`);
  }
  g = build('wave', k, k, []);
  for (const [x, y] of [[0.21875, 0.00484], [1, 0.125], [1, 0.875], [0, 0.875]]) assert.ok(onPath(g, pt(k * x, k * y), 0.05), `wave ${x},${y}`);
  g = build('wave', 300, 120, [20000, 8000]);
  for (const [x, y] of [[0.18375, 0.00774], [0.84, 0.2], [1, 0.8], [0.16, 0.8]]) assert.ok(onPath(g, pt(300 * x, 120 * y), 0.05), `shifted ${x},${y}`);
});

test('preset::star_text_rectangles_follow_the_standard', () => {
  const t = build('star5', 144, 144, []).textRect;
  assert.ok(Math.abs(rectWidth(t) - 55) < 1, JSON.stringify(t));
  assert.ok(Math.abs(t.y0 - 55) < 1 && Math.abs(t.y1 - 110) < 1);
  const g = build('star4', 144, 144, []);
  assert.ok(Math.abs(rectWidth(g.textRect) - 72 * 0.25 * Math.SQRT2) < 0.5);
});

test('preset::stars_are_stretched_like_the_standards', () => {
  const k = 216;
  let g = build('star5', k, k, []);
  const rx = (k / 2) * 1.05146, ry = (k / 2) * 1.10557, cy = (k / 2) * 1.10557;
  const a = (18 * Math.PI) / 180;
  assert.ok(onPath(g, pt(k / 2, 0), 1e-6));
  assert.ok(onPath(g, pt(k / 2 + rx * Math.cos(a), cy - ry * Math.sin(a)), 1e-6));
  let bb = boundingBox(g.paths[0].path);
  assert.ok(Math.abs(bb.x0) < 0.5 && Math.abs(bb.x1 - k) < 0.5 && Math.abs(bb.y1 - k) < 0.5);
  g = build('star6', k, k, []);
  bb = boundingBox(g.paths[0].path);
  assert.ok(Math.abs(bb.x0) < 0.5 && Math.abs(bb.x1 - k) < 0.5);
});

test('preset::moon_disk_and_drum_match_powerpoints_outlines', () => {
  const k = 216;
  let g = build('moon', k, k, []);
  for (const [x, y] of [[0.5, 0.5], [0.626, 0.2266], [0, 0.5], [1, 0]]) assert.ok(onPath(g, pt(k * x, k * y), 0.5), `moon ${x},${y}`);
  g = build('moon', 300, 120, [30000]);
  assert.ok(onPath(g, pt(90, 60), 0.5));
  g = build('flowChartMagneticDisk', k, k, []);
  assert.ok(onPath(g, pt(k, k / 6), 0.01) && onPath(g, pt(k / 2, k / 3), 0.5));
  g = build('flowChartMagneticDrum', k, k, []);
  assert.ok(onPath(g, pt(k / 6, 0), 0.01) && onPath(g, pt(0, k / 2), 0.01));
});

test('preset::the_cloud_fills_its_box_at_any_aspect_and_has_creases', () => {
  for (const [w, h] of [[200, 200], [300, 100], [60, 180]]) {
    const g = build('cloud', w, h, []);
    const bb = boundingBox(g.paths[0].path);
    assert.ok(Math.abs(bb.x0) < w * 0.02 && Math.abs(bb.x1 - w) < w * 0.02, `${w}x${h} ${JSON.stringify(bb)}`);
    assert.ok(Math.abs(bb.y0) < h * 0.02 && Math.abs(bb.y1 - h) < h * 0.02);
    assert.equal(g.paths.length, 2);
    assert.ok(g.paths[1].stroke && g.paths[1].fill === FillMode.None);
  }
});

test('preset::spec_arcs_take_angles_as_directions_from_the_centre', () => {
  const b = new Pb();
  b.m(0, 0).arcSpec(200, 100, 45, 45);
  const p = b.take();
  const end = p[p.length - 1].p;
  const k = 1 / Math.sqrt(1 / 40000 + 1 / 10000);
  near(end.x, -k, 1e-6);
  near(end.y, -k + 100, 1e-6);
});

test('preset::brackets_and_braces_fill_out_to_their_straight_side', () => {
  for (const name of ['leftBracket', 'rightBracket', 'leftBrace', 'rightBrace']) {
    const g = build(name, 40, 100, []);
    const filled = g.paths.filter(s => s.fill !== FillMode.None);
    assert.equal(filled.length, 1, name);
    assert.ok(!filled[0].stroke, name);
    const ar = Math.abs(area(filled[0].path));
    assert.ok(ar > 40 * 100 * 0.4 && ar < 40 * 100, `${name}: ${ar}`);
    assert.ok(g.paths.some(s => s.stroke && s.fill === FillMode.None));
  }
});

test('preset::wedge_callout_mirrors_with_its_tip', () => {
  const w = 240, h = 120;
  const vertices = path => path.filter(e => e.t === 'M' || e.t === 'L').map(e => e.p);
  const sorted = v => {
    const s = [...v].sort((a, b) => a.x - b.x || a.y - b.y);
    return s.filter((p, i) => i === 0 || hypot(sub(p, s[i - 1])) >= 1e-9);
  };
  for (const [right, left, flipX] of [[[10000, 80000], [-10000, 80000], true], [[80000, 10000], [80000, -10000], false]]) {
    const a = sorted(vertices(build('wedgeRectCallout', w, h, right).paths[0].path));
    const b = sorted(vertices(build('wedgeRectCallout', w, h, left).paths[0].path).map(p => (flipX ? pt(w - p.x, p.y) : pt(p.x, h - p.y))));
    assert.equal(a.length, b.length);
    a.forEach((p, i) => assert.ok(hypot(sub(p, b[i])) < 1e-6));
  }
  const a = vertices(build('wedgeRectCallout', w, h, [10000, 80000]).paths[0].path);
  for (const x of [(w * 7) / 12, (w * 10) / 12]) assert.ok(a.some(p => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - h) < 1e-6));
});

// ---- preset/extra.rs tests ----

const NEW = ['lineInv', 'nonIsoscelesTrapezoid', 'pieWedge', 'leftRightArrowCallout', 'upDownArrowCallout', 'quadArrowCallout', 'circularArrow',
  'leftCircularArrow', 'leftRightCircularArrow', 'curvedRightArrow', 'curvedLeftArrow', 'curvedUpArrow', 'curvedDownArrow', 'swooshArrow', 'callout1',
  'callout2', 'callout3', 'accentCallout1', 'accentCallout2', 'accentCallout3', 'borderCallout2', 'borderCallout3', 'accentBorderCallout1',
  'accentBorderCallout2', 'accentBorderCallout3', 'ellipseRibbon', 'ellipseRibbon2', 'leftRightRibbon', 'flowChartOfflineStorage', 'gear6', 'gear9',
  'funnel', 'cornerTabs', 'squareTabs', 'plaqueTabs', 'chartX', 'chartStar', 'chartPlus'];
const on = (name, w, h, adj, pts) => {
  const path = outline(build(name, w, h, adj));
  for (const [x, y] of pts) {
    const d = distanceToPath(path, pt(x, y), 0.01);
    assert.ok(d < 1, `${name} ${w}x${h} ${JSON.stringify(adj)}: (${x}, ${y}) is ${d.toFixed(2)} from the outline`);
  }
};

test('extra::new_presets_are_in_the_catalog', () => {
  for (const n of NEW) assert.ok(info(n)?.label, `${n} missing`);
  assert.ok(CATALOG.length >= 183);
});

test('extra::new_presets_build_within_bounds_at_many_sizes_and_adjusts', () => {
  const sizes = [[480, 300], [300, 300], [200, 460], [100, 460], [1, 1], [0, 0], [0, 50], [60, 0]];
  const adjusts = [[], Array(8).fill(0), Array(8).fill(100000), Array(8).fill(-50000), [1e12, -1e12, 1e12, -1e12, 1e12, -1e12, 1e12, -1e12],
    [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE],
    [NaN, Infinity, -Infinity, NaN, 5, 6, 7, 8], [30000, 60000, 20000, 9000000, 20000, 40000, 120000, -30000]];
  for (const n of NEW) {
    const callout = n.includes('allout') && !n.includes('Arrow');
    for (const [w, h] of sizes) for (const adj of adjusts) {
      const g = build(n, w, h, adj);
      assert.ok(g && g.paths.length, `${n} did not build`);
      for (const s of g.paths) {
        const bb = boundingBox(s.path);
        assert.ok([bb.x0, bb.y0, bb.x1, bb.y1].every(Number.isFinite), `${n} ${w}x${h} ${JSON.stringify(adj)}: ${JSON.stringify(bb)}`);
        if (!callout) {
          const spill = n.includes('ircular') ? 0.5 : 0.01;
          const tol = 0.5 + Math.max(w, h) * spill;
          assert.ok(bb.x0 >= -tol && bb.y0 >= -tol && bb.x1 <= w + tol && bb.y1 <= h + tol, `${n} ${w}x${h} ${JSON.stringify(adj)} out of bounds: ${JSON.stringify(bb)}`);
        }
      }
      const t = g.textRect;
      assert.ok([t.x0, t.y0, t.x1, t.y1].every(Number.isFinite), `${n} text rect`);
    }
    assert.ok(outline(build(n, 480, 300, [])).length >= 2);
  }
});

test('extra::simple_new_presets_match_reference_points', () => {
  on('lineInv', 480, 300, [], [[0, 300], [480, 0]]);
  on('nonIsoscelesTrapezoid', 480, 300, [], [[75, 0], [405, 0], [0, 300]]);
  on('nonIsoscelesTrapezoid', 200, 460, [80000, 20000], [[100, 0], [160, 0]]);
  on('pieWedge', 480, 300, [], [[64.3, 150], [0, 300], [480, 0]]);
  on('flowChartOfflineStorage', 480, 300, [], [[240, 300], [192, 240], [288, 240]]);
  on('squareTabs', 480, 300, [], [[28.3, 28.3], [451.7, 271.7]]);
  on('cornerTabs', 480, 300, [], [[23.3, 5]]);
  on('plaqueTabs', 480, 300, [], [[27.85, 5]]);
  on('chartStar', 480, 300, [], [[240, 0], [240, 300], [48, 30]]);
  on('chartPlus', 480, 300, [], [[0, 150], [240, 0]]);
  for (const n of ['chartX', 'callout1', 'accentCallout2']) assert.ok(!build(n, 100, 100, []).paths[0].stroke, n);
});

test('extra::line_callouts_follow_their_adjusts', () => {
  on('callout3', 480, 300, [], [[-40, 56.25], [-80, 56.25], [-80, 300], [-40, 338.9]]);
  const adj = [50000, 110000, 20000, 120000, -20000, 80000, 30000, 40000];
  const g = build('accentBorderCallout3', 480, 300, adj);
  assert.equal(g.paths.length, 3);
  assert.ok(g.paths[0].stroke);
  const accent = boundingBox(g.paths[1].path);
  assert.ok(Math.abs(accent.x0 - 528) < 1e-6 && accent.y0 === 0 && accent.y1 === 300);
  on('accentBorderCallout3', 480, 300, adj, [[576, 60], [384, -60], [192, 90]]);
});

test('extra::arrow_callouts_match_reference_points', () => {
  on('leftRightArrowCallout', 480, 300, [], [[0, 150], [75, 75], [124.5, 0], [355.5, 300], [480, 150]]);
  on('leftRightArrowCallout', 200, 460, [], [[50, 180], [52, 0], [148, 460]]);
  on('upDownArrowCallout', 480, 300, [], [[240, 0], [0, 77.8], [480, 222.2], [240, 300]]);
  on('quadArrowCallout', 480, 300, [], [[0, 150], [124.5, 77.8], [240, 0], [480, 150], [240, 300]]);
});

test('extra::curved_arrows_match_reference_points', () => {
  on('curvedRightArrow', 480, 300, [], [[480, 0], [480, 75], [480, 225], [405, 149], [405, 299], [100, 151.5], [300, 6.7]]);
  on('curvedRightArrow', 200, 460, [30000, 60000, 40000], [[200, 400], [120, 324.5], [120, 443.5], [200, 60]]);
  on('curvedRightArrow', 200, 460, [60000, 30000, 80000], [[200, 60]]);
  on('curvedLeftArrow', 480, 300, [], [[0, 225], [0, 0]]);
  on('curvedUpArrow', 480, 300, [], [[405, 0], [0, 0], [75, 0]]);
  on('curvedDownArrow', 480, 300, [], [[405, 300], [0, 300]]);
  assert.equal(build('curvedRightArrow', 480, 300, []).paths[0].fill, FillMode.DarkenLess);
});

test('extra::swoosh_matches_reference_points', () => {
  on('swooshArrow', 480, 300, [], [[0, 300], [425.8, 0], [480, 59.7], [442.8, 150], [202, 105.5], [202, 159]]);
  on('swooshArrow', 480, 300, [40000, 16667], [[480, 82.2], [447.8, 195]]);
  on('swooshArrow', 200, 460, [], [[163.9, 0], [200, 59.4]]);
});

test('extra::ribbons_match_reference_points', () => {
  on('ellipseRibbon', 480, 300, [], [[0, 0], [120, 28.1], [60, 128.9], [240, 300], [120, 66.1], [180, 72.2], [180, 35.2]]);
  on('ellipseRibbon', 480, 300, [30000, 60000, 20000], [[120, 45], [240, 300], [96, 68.4]]);
  on('ellipseRibbon', 480, 300, [80000, 20000, 60000], [[240, 240], [1, 61.75]]);
  on('ellipseRibbon2', 480, 300, [], [[0, 300], [240, 0]]);
  on('leftRightRibbon', 480, 300, [], [[0, 125], [150, 0], [150, 50], [255, 62.5], [225, 87.5], [480, 175], [330, 300]]);
  on('leftRightRibbon', 480, 300, [90000, 10000, 60000], [[0, 100], [480, 200], [240, 300]]);
});

test('extra::gears_and_funnel_match_reference_points', () => {
  on('gear6', 300, 300, [], [[150, 3.5], [133.7, 3.5], [166.3, 3.5], [45, 150]]);
  on('gear9', 300, 300, [], [[150, 1], [30, 150]]);
  on('gear6', 480, 300, [], [[240, 3.5], [201, 3.5]]);
  on('funnel', 480, 300, [], [[240, 0], [0, 75], [240, 15], [15, 75], [240, 300], [60.5, 150]]);
  assert.ok(build('funnel', 480, 300, []).paths[0].evenOdd);
});

test('extra::circular_arrows_match_reference_points', () => {
  on('circularArrow', 300, 300, [], [[19, 150], [56.5, 150], [150, 19], [262.4, 150], [218.6, 113.4], [293.6, 113.4]]);
  on('circularArrow', 300, 300, [20000, 1800000, 18000000, 5400000, 20000], [[150, 270], [150, 210], [247, 42.1], [143, 102.1], [227.9, 105]]);
  on('leftCircularArrow', 300, 300, [], [[37.6, 150], [262.4, 150], [150, 281]]);
  on('leftRightCircularArrow', 300, 300, [], [[262.4, 150], [37.6, 150], [150, 19]]);
  on('circularArrow', 300, 300, [25000, 1142319, 20457681, 10800000, 5000], [[0, 150], [30, 150]]);
});

// ---- geom lib.rs tests ----

test('geom::emu_roundtrip_is_exact', () => {
  for (const emu of [0, 1, 12699, 12700, 914400, 12192000, 6858000, -5, 123456789]) assert.equal(ptToEmu(emuToPt(emu)), emu);
  assert.equal(ptToEmu(NaN), 0);
  assert.equal(ptToEmu(Infinity), 0);
});

test('geom::unit_parse_and_format', () => {
  assert.equal(parseUnit('inches', '2'), 144);
  assert.equal(parseUnit('inches', '2"'), 144);
  near(parseUnit('inches', '2.54 cm'), 72, 1e-9);
  assert.equal(parseUnit('inches', '36pt'), 36);
  assert.equal(parseUnit('inches', 'abc'), null);
  assert.equal(parseUnit('inches', ''), null);
  assert.equal(formatUnit('inches', 150), '2.08"');
});

test('geom::xfrm_affine_rotation_about_center', () => {
  const x = {x: 10, y: 20, w: 100, h: 50, rot: 90};
  const c = apply(xfrmAffine(x), pt(50, 25));
  near(c.x, 60, 1e-9); near(c.y, 45, 1e-9);
  const b = xfrmBounds(x);
  near(b.x1 - b.x0, 50, 1e-9); near(b.y1 - b.y0, 100, 1e-9);
});

test('geom::flips_mirror_local_space', () => {
  const p = apply(xfrmAffine({x: 0, y: 0, w: 100, h: 50, flipH: true}), pt(0, 0));
  near(p.x, 100, 1e-9); near(p.y, 0, 1e-9);
});

test('geom::group_child_mapping', () => {
  const a = groupChildAffine({x: 100, y: 100, w: 200, h: 100}, rect(0, 0, 100, 50));
  const p = apply(a, pt(100, 50));
  near(p.x, 300, 1e-9); near(p.y, 200, 1e-9);
});

test('geom::segment_distance', () => {
  near(distToSegment(pt(5, 5), pt(0, 0), pt(10, 0)), 5, 1e-9);
  near(distToSegment(pt(0, 3), pt(0, 0), pt(0, 0)), 3, 1e-9);
});

// ---- squircle.rs tests ----

const numbers = d => d.split(/\s+/).map(Number).filter(Number.isFinite);

test('squircle::no_radius_is_a_rectangle', () => {
  assert.equal(squirclePathD(100, 50, 0, 0.6), 'M 0 0 L 100 0 L 100 50 L 0 50 Z');
});

test('squircle::edge_curve_meets_the_arc', () => {
  for (const s of [0, 0.3, 0.6, 1]) {
    const c = corner(10, s);
    const seg = segments(c);
    const e3 = [c.p - c.a - c.b - c.c, c.d];
    assert.ok(Math.abs(seg[3][0] - e3[0]) < 1e-6 && Math.abs(seg[3][1] - e3[1]) < 1e-6, `s=${s}`);
    assert.ok(Math.abs(seg[3][0] - seg[6][1]) < 1e-9 && Math.abs(seg[3][1] - seg[6][0]) < 1e-9);
  }
});

test('squircle::zero_smoothing_is_a_circular_corner', () => {
  const c = corner(10, 0);
  const seg = segments(c);
  near(c.p, 10, 1e-9);
  assert.ok(Math.abs(seg[3][0] - 10) < 1e-9 && Math.abs(seg[3][1]) < 1e-9);
  assert.ok(Math.abs(seg[6][0]) < 1e-9 && Math.abs(seg[6][1] - 10) < 1e-9);
});

test('squircle::smoothing_uses_more_of_the_edge', () => {
  const d0 = numbers(squirclePathD(200, 100, 20, 0));
  const d6 = numbers(squirclePathD(200, 100, 20, 0.6));
  assert.deepEqual([d0[0], d0[1]], [180, 0]);
  assert.deepEqual([d6[0], d6[1]], [168, 0]);
});

test('squircle::stays_inside_and_reduces_smoothing_when_the_rectangle_is_small', () => {
  for (const [w, h, r, s] of [[100, 40, 20, 1], [40, 40, 50, 0.8], [10, 300, 4, 0.6], [300, 120, 30, 0.6]]) {
    const n = numbers(squirclePathD(w, h, r, s));
    for (let i = 0; i < n.length; i += 2) assert.ok(n[i] >= -1e-6 && n[i] <= w + 1e-6 && n[i + 1] >= -1e-6 && n[i + 1] <= h + 1e-6, `${w}x${h} r${r} s${s}`);
    assert.ok(n[0] >= w / 2 - 1e-6);
  }
  assert.ok(numbers(squirclePathD(NaN, 10, Infinity, NaN)).every(Number.isFinite));
});

test('squircle::four_symmetric_corners', () => {
  const n = numbers(squirclePathD(120, 80, 16, 0.6));
  assert.equal(n.length, 80);
  const pts = [];
  for (let i = 0; i < n.length; i += 2) pts.push([n[i], n[i + 1]]);
  for (const [x, y] of pts) assert.ok(pts.some(q => Math.abs(q[0] - (120 - x)) < 0.01 && Math.abs(q[1] - (80 - y)) < 0.01), `${x},${y}`);
});
