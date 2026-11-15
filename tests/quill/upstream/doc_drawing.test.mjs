// Ported from wordcraft crates/doc/src/{effects,wordart,fill,line_dash,link,freeform,connector,wrap}.rs
// (mod tests) at aadb077e072b7de05f724e359d8db82e151f125c. Each test names the Rust test.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as FX from '../../../core/quill/model/effects.mjs';
import * as WA from '../../../core/quill/model/wordart.mjs';
import * as F from '../../../core/quill/model/fill.mjs';
import * as LD from '../../../core/quill/model/line-dash.mjs';
import * as L from '../../../core/quill/model/link.mjs';
import * as FF from '../../../core/quill/model/freeform.mjs';
import * as C from '../../../core/quill/model/connector.mjs';
import * as W from '../../../core/quill/model/wrap.mjs';
import {defaultFloat, groupRects, objectFrame} from '../../../core/quill/model/para.mjs';

const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;
const F32_MAX = 3.4028234663852886e38, F32_MIN_POSITIVE = 1.1754943508222875e-38;

// --- effects.rs ---
test('effects: bands_ramp_to_the_requested_opacity', () => {
  for (const [from, to, o] of [[-2, 2, 0.4], [-5, 0, 1], [0, 8, 0.6]]) {
    const b = FX.bands(from, to, o);
    assert.ok(b.every(([g, a]) => g > from && g < to && a >= 0 && a <= 1));
    const covered = 1 - b.reduce((acc, [, a]) => acc * (1 - a), 1);
    assert.ok(near(covered, o, 1e-4), `${covered} vs ${o}`);
  }
  assert.deepEqual(FX.bands(0, 0, 0.5), [[0, 0.5]]);
  assert.deepEqual(FX.bands(NaN, Infinity, NaN), []);
});

test('effects: hostile_numbers_are_clamped', () => {
  const s = FX.sanitizedShadow({color: [0, 0, 0], transparency: NaN, blur: 1e9, distance: -4, angle: -90, rotWithShape: false});
  assert.deepEqual([s.transparency, s.blur, s.distance, s.angle], [60, FX.MAX_BLUR, 0, 270]);
  let e = FX.sanitizedEffects({shadow: null, glow: {...FX.defaultGlow(), size: 1e9}, softEdge: -1});
  assert.equal(e.glow.size, FX.MAX_GLOW);
  assert.equal(e.softEdge, undefined);
  e = FX.sanitizedEffects({glow: {...FX.defaultGlow(), size: Infinity}});
  assert.ok(FX.shapeEffectsIsEmpty(e), 'a non-finite size is no glow');
  const [dx, dy] = FX.shadowOffset(FX.shadowPreset('offsetBottomRight'));
  assert.ok(dx > 2 && dy > 2);
});

// --- wordart.rs ---
test('wordart: hostile_values_are_reduced', () => {
  const fx = WA.sanitizedTextEffects({
    fill: {type: 'gradient', stops: Array.from({length: 50}, (_, i) => ({pos: i === 0 ? NaN : 1e9, color: [0, 0, 0], transparency: -5})), angle: Infinity},
    outline: {color: null, width: 1e9, transparency: NaN},
  });
  assert.equal(fx.fill.type, 'gradient');
  assert.equal(fx.fill.stops.length, WA.MAX_STOPS);
  assert.ok(fx.fill.stops.every(s => s.pos >= 0 && s.pos <= 100 && s.transparency === 0));
  assert.equal(fx.fill.angle, 0);
  assert.equal(fx.outline.width, WA.MAX_OUTLINE);
  assert.equal(WA.sanitizedTextFill({type: 'gradient', stops: [], angle: 0}), null);
  assert.equal(WA.textWarp('textMadeUp'), null);
  let w = WA.textWarp('textArchUp');
  for (let i = 0; i < 20; i++) w = WA.setWarpAdj(w, `adj${i}`, Number.MAX_SAFE_INTEGER);
  w = WA.setWarpAdj(w, 'bad name!', 1);
  assert.equal(w.adj.length, WA.MAX_ADJ);
  assert.ok(w.adj.every(([, v]) => v === WA.MAX_ADJ_VALUE));
  for (const [id] of WA.ART_STYLES) assert.ok(WA.artStyle(id, []), id);
});

// --- fill.rs ---
const stop = (pos, color, transparency) => ({pos, color, transparency});
const grad = (stops, kind) => ({type: 'gradient', stops, kind, rotWithShape: true});

test('fill: opaque_solid_fills_are_written_as_before_and_old_documents_load', () => {
  assert.equal(JSON.stringify(F.storedFill(F.solidFill([1, 2, 3]))), '[1,2,3]');
  assert.deepEqual(F.fillForm(JSON.parse('[1,2,3]')), {type: 'solid', color: [1, 2, 3], transparency: 0});
});

test('fill: transparent_and_gradient_fills_round_trip_tagged', () => {
  const fills = [
    {type: 'solid', color: [255, 255, 255], transparency: 70},
    grad([stop(0, [9, 9, 9], 0), stop(100, [255, 255, 255], 50)], {type: 'linear', angle: 90, scaled: true}),
    {type: 'gradient', stops: [stop(0, [0, 0, 0], 0), stop(100, [255, 255, 255], 0)], kind: {type: 'path', shape: 'rect', focus: [50, 50, 50, 50]},
      tile: [-10, 0, 0, 0], rotWithShape: false, flip: 'xy'},
  ];
  for (const f of fills) {
    const json = JSON.stringify(F.storedFill(f));
    assert.ok(json.includes('"type"'), json);
    assert.deepEqual(F.fillForm(JSON.parse(json)), f);
  }
});

test('fill: hostile_fills_are_sanitized', () => {
  const many = Array.from({length: 30}, (_, i) => stop(100 - i, [0, 0, 0], NaN));
  let g = F.sanitizedFill(grad(many, {type: 'linear', angle: -450, scaled: false}));
  assert.equal(g.stops.length, WA.MAX_STOPS);
  assert.ok(g.stops.every((s, i, a) => i === 0 || a[i - 1].pos <= s.pos) && g.stops.every(s => s.transparency === 0));
  assert.deepEqual(g.kind, {type: 'linear', angle: 270, scaled: false});
  g = F.sanitizedFill(grad([stop(150, [0, 0, 0], 200), stop(-5, [255, 255, 255], 0)], {type: 'path', shape: 'circle', focus: [NaN, 1e9, -1e9, 5]}));
  assert.deepEqual([g.stops[0].pos, g.stops[1].pos, g.stops[1].transparency], [0, 100, 100]);
  assert.deepEqual(g.kind, {type: 'path', shape: 'circle', focus: [0, 1000, -1000, 5]});
  assert.deepEqual(F.sanitizedFill(grad([stop(0, [255, 255, 255], 30)], {type: 'linear', angle: 0, scaled: false})), {type: 'solid', color: [255, 255, 255], transparency: 30});
  assert.equal(F.sanitizedFill(grad([], {type: 'linear', angle: 0, scaled: false})), null);
  assert.deepEqual(F.sanitizedFill({type: 'solid', color: [0, 0, 0], transparency: NaN}), [0, 0, 0]);
});

test('fill: main_colour_is_the_middle_stop', () => {
  const g = grad([stop(0, [1, 0, 0], 0), stop(50, [2, 0, 0], 0), stop(100, [3, 0, 0], 0)], {type: 'linear', angle: 0, scaled: false});
  assert.deepEqual(F.fillMainColor(g), [2, 0, 0]);
  assert.deepEqual(F.fillMainColor(F.solidFill([255, 255, 255])), [255, 255, 255]);
});

// --- line_dash.rs ---
test('line_dash: dash_units_follow_line_width', () => {
  assert.deepEqual(LD.dashPattern('dash', 1), [4, 3]);
  assert.deepEqual(LD.dashPattern('dash', 2), [8, 6]);
  assert.deepEqual(LD.dashPattern({custom: [[200_000, 150_000]]}, 2), [4, 3]);
  assert.deepEqual(LD.dashPattern('solid', 2), []);
});
test('line_dash: old_shapes_default_to_solid', () => {
  assert.ok(LD.lineDashIsSolid(({}).dash));
  assert.ok(C.shapeExtraIsEmpty({}));
});
test('line_dash: custom_dashes_are_bounded', () => {
  const pattern = LD.dashPattern({custom: Array.from({length: LD.MAX_DASH_STOPS + 1}, () => [0, 4294967295])}, NaN);
  assert.equal(pattern.length, LD.MAX_DASH_STOPS * 2);
  assert.ok(pattern.every(v => Number.isFinite(v) && v >= 0.01 && v <= 20_000));
});

// --- link.rs ---
test('link: only_web_and_mail_links_are_followable', () => {
  for (const ok of ['https://example.com/a?b#c', 'http://example.com', 'HTTPS://EXAMPLE.COM', 'mailto:someone@example.com']) assert.ok(L.isWebOrMailLink(ok), ok);
  for (const bad of ['file:///etc/passwd', 'C:\\Windows\\System32\\calc.exe', '/usr/bin/xterm', 'javascript:alert(1)', 'ms-msdt:/id', ' https://example.com',
    'https\u0000://example.com', '', 'example.com', '#top']) assert.ok(!L.isWebOrMailLink(bad), JSON.stringify(bad));
});
test('link: exported_hrefs_allow_bookmarks_and_relative_paths_but_no_scripts', () => {
  for (const ok of ['https://example.com/x', 'mailto:a@b.c', '#top', 'other.html', 'docs/guide.html#s2', '../up.html', '?q=1']) assert.ok(L.isSafeHref(ok), ok);
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'java\nscript:alert(1)', '\tjavascript:alert(1)', ' javascript:alert(1)', 'java\u0000script:alert(1)',
    'vbscript:MsgBox(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ms-msdt:/id', '//attacker.example/share/x',
    '\\\\attacker.example\\share\\x', '/\\attacker.example\\x', ' //attacker.example/x', '']) assert.ok(!L.isSafeHref(bad), JSON.stringify(bad));
});

// --- freeform.rs ---
test('freeform: hostile_geometry_is_sanitized', () => {
  const pts = [[NaN, 1], [2, Infinity], [1, 2], [1e30, -1e30], ...Array.from({length: FF.MAX_POINTS * 2}, () => [3, 3])];
  const f = FF.sanitizedFreeform({w: NaN, h: -4, paths: [{pts, closed: false}], alpha: 7});
  assert.deepEqual([f.w, f.h, f.alpha], [0, 0, 1]);
  assert.equal(f.paths[0].pts.length, FF.MAX_POINTS);
  assert.deepEqual(f.paths[0].pts[0], [1, 2]);
  assert.deepEqual(f.paths[0].pts[1], [1e6, -1e6]);
});
test('freeform: distance_to_a_stroke_scales_with_its_frame', () => {
  const f = FF.inkFreeform('pen', 10, 10, [[0, 0], [10, 0]]);
  assert.equal(FF.freeformDistance(f, 100, 100, 20, 20, 110, 103), 3);
  assert.equal(FF.freeformDistance(FF.defaultFreeform(), 0, 0, 1, 1, 0, 0), null);
});

// --- connector.rs ---
const shape = (kind, w, h, extra = {}) => ({type: 'shape', kind, w, h, fill: null, stroke: null, strokeWidth: 1, float: defaultFloat(), story: null, freeform: null, effects: {}, extra});
const group = children => ({type: 'group', w: 200, h: 300, ch_w: 200, ch_h: 300, float: defaultFloat(), children, canvas: null});
const endsOf = c => C.ends(c.x, c.y, c.obj.w, c.obj.h, !!c.obj.float.flipH, !!c.obj.float.flipV);

test('connector: older_shape_json_defaults_to_flat_caps', () => {
  assert.equal(C.lineCapFromOoxml(undefined), 'flat');
  assert.ok(C.shapeExtraIsEmpty({}));
  for (const cap of ['square', 'round']) assert.equal(C.lineCapFromOoxml(C.lineCapOoxml(cap)), cap);
});
test('connector: route_and_ends_are_inverse', () => {
  for (const [s, e] of [[[0, 0], [10, 5]], [[10, 5], [0, 0]], [[3, 9], [7, 1]]]) {
    const f = C.route(s, e);
    assert.deepEqual(C.ends(f.x, f.y, f.w, f.h, f.flipH, f.flipV), [s, e]);
  }
});
test('connector: corner_radius_follows_the_shorter_side', () => {
  assert.ok(near(C.cornerRadius(null, 200, 100), 16));
  assert.ok(near(C.cornerRadius(0, 200, 100), 0));
  assert.ok(near(C.cornerRadius(3_565, 100, 200), 3.565));
  assert.ok(near(C.cornerRadius(C.MAX_CORNER, 200, 100), 50));
  assert.ok(near(C.cornerRadius(4294967295, 200, 100), 50));
  assert.ok(near(C.cornerRadius(10_000, NaN, 100), 0));
  assert.ok(near(C.cornerRadius(10_000, -5, 100), 0));
});

function transformedReroute(kind, rot, flipH, flipV, free, freeStart) {
  const attached = {id: 7, site: 3};
  const [start, end] = freeStart ? [free, attached] : [attached, free];
  const obj = shape(kind, 40, 20, {start, end});
  obj.float = {...obj.float, rot, flipH, flipV};
  const sign = freeStart ? -1 : 1;
  const dx = sign * (flipH ? -20 : 20), dy = sign * (flipV ? -10 : 10);
  const r = rot * Math.PI / 180;
  const expected = [30 + dx * Math.cos(r) - dy * Math.sin(r), 40 + dx * Math.sin(r) + dy * Math.cos(r)];
  let g = group([{x: 100, y: 200, obj: shape('rectangle', 40, 20, {id: 7})}, {x: 10, y: 30, obj}]);
  const g2 = C.rerouteGroup(g);
  assert.notEqual(g2, g);
  const c = g2.children[1];
  const [s, e] = endsOf(c);
  const [fr, at] = freeStart ? [s, e] : [e, s];
  assert.ok(near(fr[0], expected[0]) && near(fr[1], expected[1]), `${kind} ${rot} ${flipH} ${flipV} ${freeStart}: ${fr} != ${expected}`);
  assert.deepEqual(at, [140, 210]);
  assert.equal(c.obj.float.rot ?? 0, 0);
  assert.equal(C.rerouteGroup(g2), g2, 'rerouting must settle');
}

test('connector: rerouting_preserves_transformed_free_and_unresolved_ends', () => {
  for (const kind of ['straightConnector', 'elbowConnector', 'curvedConnector'])
    for (const rot of [0, 30, 90, 180, 270, -90, 450])
      for (const [fh, fv] of [[false, false], [true, false], [false, true], [true, true]])
        for (const free of [null, {id: 404, site: 0}, {id: 7, site: 99}])
          for (const fs of [false, true]) transformedReroute(kind, rot, fh, fv, free, fs);
});

test('connector: rerouting_preserves_both_unresolved_ends', () => {
  const obj = shape('straightConnector', 40, 20, {start: {id: 404, site: 0}, end: {id: 7, site: 99}});
  obj.float = {...obj.float, rot: 90};
  const g = C.rerouteGroup(group([{x: 100, y: 200, obj: shape('rectangle', 40, 20, {id: 7})}, {x: 10, y: 30, obj}]));
  const [s, e] = endsOf(g.children[1]);
  assert.ok(near(s[0], 40) && near(s[1], 20));
  assert.ok(near(e[0], 20) && near(e[1], 60));
  assert.equal(g.children[1].obj.float.rot ?? 0, 0);
  assert.equal(C.rerouteGroup(g), g);
});

test('connector: rerouting_nonuniform_group_preserves_both_unresolved_ends', () => {
  const obj = shape('straightConnector', 40, 20, {start: {id: 404, site: 0}, end: {id: 7, site: 99}});
  obj.float = {...obj.float, rot: 90};
  const g0 = {...group([{x: 100, y: 200, obj: shape('rectangle', 40, 20, {id: 7})}, {x: 10, y: 30, obj}]), w: 400, h: 150};
  const g = C.rerouteGroup(g0);
  const [s, e] = endsOf(g.children[1]);
  assert.ok(near(s[0], 32.5) && near(s[1], -40));
  assert.ok(near(e[0], 27.5) && near(e[1], 120));
  assert.equal(C.rerouteGroup(g), g);
});

test('connector: rerouting_preserves_fallback_when_group_display_cap_prevents_route', () => {
  for (const freeStart of [false, true]) {
    const attached = {id: 7, site: 3};
    const [start, end] = freeStart ? [null, attached] : [attached, null];
    const obj = shape('straightConnector', 40, 0, {start, end});
    obj.float = {...obj.float, flipH: freeStart};
    const g = {...group([{x: 0, y: 0, obj: shape('rectangle', 40, 20, {id: 7})}, {x: 3000, y: 10, obj}]), w: 400};
    const visualFree = gr => {
      const [[x, y, w, h], o] = groupRects(gr, 0, 0, 400, 300)[1];
      const spin = C.floatSpin(objectFrame(o)[2]);
      const [px, py] = freeStart ? [x, y] : [x + w, y + h];
      return spin.apply(x + w / 2, y + h / 2, px, py);
    };
    const before = visualFree(g);
    assert.deepEqual(before, [6080, 10]);
    const g2 = C.rerouteGroup(g);
    assert.deepEqual(visualFree(g2), before);
    assert.equal(g2, g, 'an unrepresentable fallback route must leave the connector unchanged');
  }
});

test('connector: rerouting_group_handles_degenerate_dimensions_without_nonfinite_writes', () => {
  for (const dims of [[0, 300, 200, 300], [200, 0, 200, 300], [-200, 300, 200, 300], [NaN, 300, 200, 300], [200, Infinity, 200, 300],
    [F32_MAX, 300, F32_MIN_POSITIVE, 300], [F32_MIN_POSITIVE, 300, F32_MAX, 300], [20000, F32_MIN_POSITIVE, 200, 300], [200, 300, 0, 0],
    [200, 300, NaN, Infinity], [200, 300, -200, -300]]) {
    const obj = shape('straightConnector', 40, 20, {start: {id: 7, site: 3}});
    obj.float = {...obj.float, rot: 90};
    const g0 = {...group([{x: 100, y: 200, obj: shape('rectangle', 40, 20, {id: 7})}, {x: 10, y: 30, obj}]), w: dims[0], h: dims[1], ch_w: dims[2], ch_h: dims[3]};
    const g = C.rerouteGroup(g0);
    assert.equal(g !== g0, dims[2] <= 0 || !Number.isFinite(dims[2]), JSON.stringify(dims));
    const c = g.children[1];
    assert.ok([c.x, c.y, c.obj.w, c.obj.h, c.obj.float.rot ?? 0].every(Number.isFinite));
    assert.equal(C.rerouteGroup(g), g, `rerouting must settle: ${dims}`);
  }
  const lone = shape('rectangle', 40, 20, {});
  assert.equal(C.rerouteGroup(lone), lone);
});

test('connector: group_connectors_follow_their_shapes', () => {
  const link = {start: {id: 7, site: 3}, end: {id: 9, site: 2}};
  const conn = shape('elbowConnector', 1, 1, link);
  conn.float = {...conn.float, rot: 90, flipH: true, flipV: true};
  const g0 = group([{x: 0, y: 0, obj: shape('rectangle', 20, 10, {id: 7})}, {x: 100, y: 50, obj: shape('ellipse', 20, 10, {id: 9})}, {x: 0, y: 0, obj: conn}]);
  const g = C.rerouteGroup(g0);
  const c = g.children[2];
  assert.deepEqual([c.x, c.y, c.obj.w, c.obj.h, !!c.obj.float.flipH, !!c.obj.float.flipV], [20, 5, 80, 50, false, false]);
  assert.equal(C.rerouteGroup(g), g, 'settled');
  for (const [w, h] of [[400, 150], [0, 0], [NaN, Infinity]]) {
    const sc = {...g, w, h, children: g.children.map((ch, i) => (i === 2 ? {...ch, obj: {...ch.obj, float: {...ch.obj.float, rot: 90}}} : ch))};
    const out = C.rerouteGroup(sc);
    assert.notEqual(out, sc);
    assert.deepEqual(endsOf(out.children[2]), [[20, 5], [100, 55]]);
    assert.equal(C.rerouteGroup(out), out);
  }
  const broken = {...g, children: g.children.map((ch, i) => (i === 2 ? {...ch, obj: {...ch.obj, extra: {start: {id: 7, site: 99}, end: {id: 404, site: 0}}}} : ch))};
  assert.equal(C.rerouteGroup(broken), broken);
});

// --- wrap.rs ---
test('wrap: polygon_caps_and_clamps', () => {
  assert.equal(W.wrapPolygon(false, [[0, 0], [1, 1]]), null);
  const p = W.wrapPolygon(true, Array.from({length: 5000}, (_, i) => [i, Number.MAX_SAFE_INTEGER]));
  assert.equal(p.points.length, W.MAX_WRAP_POINTS);
  assert.ok(p.points.every(([, y]) => y === W.WRAP_SPACE * 4));
  assert.equal(W.wrapPolygonFromUnit(false, [[NaN, 0], [0, 0], [1, 0], [0.5, 1]]).points.length, 3);
});
test('wrap: arrow_outlines_point_the_right_way', () => {
  const tip = kind => W.shapeOutline(kind, 100, 100, null)[3];
  assert.deepEqual(tip('arrow'), [1, 0.5]);
  assert.deepEqual(tip('arrowLeft'), [0, 0.5]);
  assert.deepEqual(tip('arrowUp'), [0.5, 0]);
  assert.deepEqual(tip('arrowDown'), [0.5, 1]);
});
test('wrap: shape_outlines_stay_in_the_frame', () => {
  for (const kind of ['ellipse', 'roundedRectangle', 'triangle', 'rightTriangle', 'diamond', 'arrow', 'arrowLeft', 'arrowUp', 'arrowDown', 'star', 'heart'])
    for (const [w, h] of [[100, 50], [0, 0], [NaN, 10]])
      for (const corner of [null, 0, 3_565, 4294967295]) {
        const pts = W.shapeOutline(kind, w, h, corner);
        assert.ok(pts.length >= 3 && pts.length <= W.MAX_DERIVED_POINTS, kind);
        assert.ok(pts.every(([x, y]) => x >= -0.001 && x <= 1.001 && y >= -0.001 && y <= 1.001), kind);
      }
  assert.equal(W.shapeOutline('rectangle', 10, 10, null), null);
  const cornerPt = corner => W.shapeOutline('roundedRectangle', 100, 50, corner)[6];
  assert.ok(cornerPt(0)[0] > 0.999 && cornerPt(0)[1] > 0.999);
  assert.ok(near(cornerPt(null)[0], 0.92));
});
test('wrap: alpha_outline_is_the_hull_of_opaque_cells', () => {
  const disc = (x, y) => { const dx = x + 0.5 - 10, dy = y + 0.5 - 10; return dx * dx + dy * dy < 64; };
  const pts = W.alphaOutline(20, 20, disc);
  assert.ok(pts.length >= 8 && pts.length <= W.MAX_DERIVED_POINTS);
  assert.ok(pts.every(([x, y]) => x >= 0.05 && x <= 0.95 && y >= 0.05 && y <= 0.95));
  assert.equal(W.alphaOutline(20, 20, () => true), null);
  assert.equal(W.alphaOutline(20, 20, () => false), null);
  const noisy = W.alphaOutline(1024, 1024, (x, y) => { const dx = x - 512, dy = y - 512; return dx * dx + dy * dy < 500 * 500; });
  assert.ok(noisy.length <= W.MAX_DERIVED_POINTS);
});
