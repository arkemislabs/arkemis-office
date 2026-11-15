// Ported from deckcraft crates/anim/src/transition_tests.rs and crates/anim/src/tests.rs
// (`every_transition_finite_and_complete`, `transitions_hostile_t`, `fade_and_push_shapes`,
// `mid_transitions_mix_sources`, `random_is_deterministic`) and mesh.rs tests at
// f893f6af7d36a5409fd804e81a34fd895cfefedf: the transition frames match the positions and curves
// measured on PowerPoint's own video export.
//
// 1. ArtCraft: crates/anim/src/{transition,transition_fx,transition_geom,mesh}.rs; PowerPoint:
//    the Transitions gallery (Subtle, Exciting, Dynamic Content) and its Effect Options.
// 2. Ours: core/prism/lib/transition-fx.mjs, the same layers and numbers.
// 3. These tests; the transitions drawn in the app: tests/e2e/prism/transitions.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {transitionFrame, usesSlideParts, layerMesh, layerFull} from '../../../core/prism/lib/transition-fx.mjs';
import {ease} from '../../../core/prism/lib/anim-timeline.mjs';
import {TRANSITIONS} from '../../../core/prism/formats/pptx-read.mjs';

const A = 16 / 9;
const layersOf = (kind, o, t) => transitionFrame(kind, o, t, A);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const of = (ls, src) => ls.filter(l => l.source === src);
const left = l => Math.min(...l.quad.map(p => p[0]));
const top = l => Math.min(...l.quad.map(p => p[1]));
const q2 = x => ease(x, 0.5, 0.5, 0);
const ss = x => x * x * (3 - 2 * x);
const edge = (c, p, w) => Math.min(Math.max((c - p) / w + 0.5, 0), 1);
const powInout = (x, n) => (x < 0.5 ? 0.5 * (2 * x) ** n : 1 - 0.5 * (2 - 2 * x) ** n);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function coversAtEnd(ls) {
  return ls.some(l => l.source === 'new' && Math.abs(l.alpha - 1) < 1e-9 && same(l.quad, [[0, 0], [1, 0], [1, 1], [0, 1]]) && same(l.uv, [[0, 0], [1, 0], [1, 1], [0, 1]]));
}

test('fade_follows_powerpoints_s_curve', () => {
  for (const [t, want] of [[0.25, 0.155], [0.5, 0.49], [0.75, 0.82]]) {
    const n = of(layersOf('fade', 'smoothly', t), 'new');
    assert.ok(near(n[0].alpha, want, 0.04), `t=${t}: ${n[0].alpha}`);
  }
  assert.ok(layersOf('fade', 'throughBlack', 0.5).every(l => l.source === 'black'));
  assert.ok(near(of(layersOf('fade', 'throughBlack', 0.25), 'old')[0].alpha, 0.5, 0.01));
});

test('push_moves_both_slides_with_an_eased_curve', () => {
  for (const [o, dx, dy] of [['l', -1, 0], ['r', 1, 0], ['u', 0, -1], ['d', 0, 1]]) {
    for (const t of [0.25, 0.5, 0.75]) {
      const ls = layersOf('push', o, t);
      const [old, nw] = [of(ls, 'old')[0], of(ls, 'new')[0]];
      const s = q2(t);
      assert.ok(near(old.quad[0][0], dx * s, 1e-9) && near(old.quad[0][1], dy * s, 1e-9), `${o} ${t}`);
      assert.ok(near(nw.quad[0][0], dx * (s - 1), 1e-9) && near(nw.quad[0][1], dy * (s - 1), 1e-9), `${o} ${t}`);
    }
  }
  assert.ok(q2(0.1) < 0.05 && q2(0.9) > 0.95 && near(q2(0.5), 0.5, 1e-9));
});

test('cover_and_uncover_match_measured_positions', () => {
  for (const [t, off] of [[0.445, 0.655], [0.495, 0.512], [0.544, 0.359], [0.643, 0.134], [0.742, 0.046]]) {
    assert.ok(near(left(of(layersOf('cover', 'l', t), 'new')[0]), off, 0.05), `cover t=${t}`);
  }
  for (const [t, off] of [[0.244, -0.06], [0.343, -0.14], [0.442, -0.32], [0.508, -0.5], [0.558, -0.63]]) {
    assert.ok(near(left(of(layersOf('uncover', 'l', t), 'old')[0]), off, 0.05), `uncover t=${t}`);
  }
  for (const [t, off] of [[0.142, 0.728], [0.257, 0.49], [0.356, 0.29], [0.455, 0.146], [0.604, 0.053]]) {
    const n = of(layersOf('cover', 'lu', t), 'new')[0];
    assert.ok(near(left(n), off, 0.06) && near(top(n), off, 0.06), `cover lu t=${t}`);
  }
  assert.ok(near(powInout(0.25, 3), 0.0625, 1e-9));
});

test('wipe_has_a_wide_soft_edge', () => {
  const c = -0.4 + 1.8 * 1.05 * 0.5;
  assert.ok(near(edge(c, 0.6, 0.8), 0.49, 0.1));
  assert.ok(edge(c, 1, 0.8) < 0.1);
  assert.ok(edge(c, 0.2, 0.8) > 0.8);
  const first = o => {
    const n = of(layersOf('wipe', o, 0.15), 'new');
    assert.ok(n.length > 0, o);
    return [n.reduce((s, l) => s + (l.quad[0][0] + l.quad[2][0]) / 2, 0) / n.length, n.reduce((s, l) => s + (l.quad[0][1] + l.quad[2][1]) / 2, 0) / n.length];
  };
  assert.ok(first('r')[0] < 0.3 && first('l')[0] > 0.7);
  assert.ok(first('u')[1] > 0.7 && first('d')[1] < 0.3);
  const ru = first('ru');
  assert.ok(ru[0] < 0.4 && ru[1] > 0.6, JSON.stringify(ru));
});

test('split_and_shape_open_from_the_middle', () => {
  for (const o of ['horzOut', 'vertOut']) {
    const n = of(layersOf('split', o, 0.2), 'new');
    assert.ok(n.every(l => {
      const c = [(l.quad[0][0] + l.quad[2][0]) / 2, (l.quad[0][1] + l.quad[2][1]) / 2];
      return o.startsWith('horz') ? Math.abs(c[1] - 0.5) < 0.4 : Math.abs(c[0] - 0.5) < 0.4;
    }));
  }
  assert.equal(of(layersOf('shape', 'in', 0.55), 'old').length, 0);
  assert.equal(of(layersOf('shape', 'out', 0.45), 'new').length, 0);
});

test('dynamic_content_curves', () => {
  for (const [t, off] of [[0.6, 0.134], [0.7, 0.086], [0.8, 0.039], [0.9, 0.011]]) {
    assert.ok(near(left(of(layersOf('pan', 'l', t), 'newContent')[0]), off, 0.07), `pan t=${t}`);
  }
  const ls = layersOf('pan', 'l', 0.5);
  assert.equal(ls[0].source, 'oldBack');
  assert.ok(of(ls, 'newBack')[0].alpha > 0.5);
  for (const [t, dy] of [[0.147, 0.06], [0.246, 0.17], [0.345, 0.36], [0.444, 0.7]]) {
    const q = of(layersOf('ferris', 'l', t), 'oldContent')[0].quad;
    const cy = q.reduce((s, p) => s + p[1], 0) / 4 - 0.5;
    assert.ok(near(cy, dy, 0.08), `ferris t=${t}: ${cy}`);
  }
  for (const k of ['pan', 'ferris', 'conveyor', 'rotate', 'window', 'orbit', 'flythrough']) assert.ok(usesSlideParts(k, ''), k);
  assert.ok(usesSlideParts('reveal', 'smoothlyLeft') && !usesSlideParts('reveal', 'blackLeft'));
  assert.ok(!usesSlideParts('cube', 'l') && !usesSlideParts('push', 'l'));
});

test('cube_turns_toward_the_option', () => {
  const ls = layersOf('cube', 'l', 0.5);
  const [o, n] = [of(ls, 'old')[0], of(ls, 'new')[0]];
  const oRight = Math.max(...o.quad.map(p => p[0]));
  assert.ok(near(oRight, left(n), 0.02), `shared edge: ${oRight} vs ${left(n)}`);
  assert.ok(oRight > 0.3 && oRight < 0.7);
  const up = layersOf('cube', 'u', 0.5);
  assert.ok(top(of(up, 'new')[0]) > top(of(up, 'old')[0]));
});

test('switch_swaps_the_cards_past_halfway', () => {
  const order = t => { const ls = layersOf('switch', 'l', t); return [ls.findIndex(l => l.source === 'old'), ls.findIndex(l => l.source === 'new')]; };
  let [o, n] = order(0.3);
  assert.ok(o > n, 'old in front early');
  [o, n] = order(0.8);
  assert.ok(n > o, 'new in front late');
});

test('clock_hand_sweeps_at_constant_speed', () => {
  const area = t => of(layersOf('clock', 'clockwise', t), 'new').reduce((s, l) => {
    const [a, b, c] = l.quad;
    return s + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2 * (l.fade[0] + l.fade[1] + l.fade[2]) / 3;
  }, 0);
  const [a1, a2, a3] = [area(0.25), area(0.5), area(0.75)];
  assert.ok(near(a2 - a1, a3 - a2, 0.08), `${a1} ${a2} ${a3}`);
  assert.ok(near(a2, 0.5, 0.08), String(a2));
});

test('options_change_the_frame', () => {
  for (const [id, , , , opts] of TRANSITIONS) {
    if (['morph', 'none', 'random'].includes(id) || opts.length < 2) continue;
    opts.forEach((a, i) => opts.slice(i + 1).forEach(b => {
      assert.ok([0.2, 0.35, 0.5, 0.8].some(t => !same(layersOf(id, a, t), layersOf(id, b, t))), `${id}: ${a} vs ${b}`);
    }));
  }
});

test('frames_stay_cheap', () => {
  for (const [id, , , , opts] of TRANSITIONS) {
    for (const o of [...opts, '']) {
      for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const tris = layersOf(id, o, t).reduce((s, l) => s + layerMesh(l).triangles.length, 0);
        assert.ok(tris < 30_000, `${id}/${o} t=${t}: ${tris} triangles`);
      }
    }
  }
});

test('hostile_aspects_are_safe', () => {
  for (const a of [NaN, 0, -3, 1e9, Infinity]) {
    for (const [id] of TRANSITIONS) {
      for (const l of transitionFrame(id, '', 0.4, a)) {
        assert.ok(l.quad.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1])));
        assert.ok(l.fade.every(f => f >= 0 && f <= 1));
      }
    }
  }
  assert.ok(near(ss(0.5), 0.5, 1e-12));
});

test('every_transition_finite_and_complete', () => {
  for (const [id, , , , opts] of TRANSITIONS) {
    for (const o of [...opts, '']) {
      for (const t of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1]) {
        const ls = layersOf(id, o, t);
        assert.ok(ls.length > 0, `${id} ${o} ${t}`);
        assert.ok(ls.length < 5000, `${id} ${o} ${t}`);
        for (const l of ls) {
          assert.ok(Number.isFinite(l.alpha) && l.alpha >= 0 && l.alpha <= 1);
          assert.ok([...l.quad, ...l.uv].every(p => Number.isFinite(p[0]) && Number.isFinite(p[1])));
        }
      }
      assert.ok(coversAtEnd(layersOf(id, o, 1)), `${id} ${o}`);
      assert.ok(layersOf(id, o, 0).some(l => l.source === 'old' && l.alpha === 1), `${id} ${o}`);
    }
  }
});

test('transitions_hostile_t', () => {
  for (const [id] of TRANSITIONS) for (const t of [NaN, Infinity, -Infinity, -5, 1e12]) assert.ok(transitionFrame(id, 'bogus-option', t, A).length > 0);
  assert.ok(transitionFrame('no-such-kind', '', 0.5, A).length > 0);
});

test('fade_and_push_shapes', () => {
  let ls = layersOf('fade', 'smoothly', 0.5);
  assert.equal(ls.length, 2);
  assert.equal(ls[1].source, 'new');
  assert.ok(Math.abs(ls[1].alpha - 0.5) < 1e-9);
  ls = layersOf('push', 'l', 0.5);
  assert.ok(ls.find(l => l.source === 'new').quad[0][0] > 0, 'pushing left: the new slide comes from the right');
  assert.ok(layersOf('fade', 'throughBlack', 0.25).every(l => l.source !== 'new'));
});

test('mid_transitions_mix_sources', () => {
  for (const [id] of TRANSITIONS.filter(t => !['none', 'cut', 'flip'].includes(t[0]))) {
    const ls = layersOf(id, '', 0.5);
    assert.ok(ls.some(l => l.source !== 'new') || ls.length > 1, id);
  }
});

test('random_is_deterministic', () => {
  assert.ok(same(layersOf('random', 'x', 0.4), layersOf('random', 'x', 0.4)));
  assert.ok(same(layersOf('dissolve', '', 0.4), layersOf('dissolve', '', 0.4)));
});

test('mesh: a rectangle is two triangles; a trapezoid is subdivided projectively; degenerate quads stay finite', () => {
  const r = layerMesh(layerFull('new', 1));
  assert.deepEqual([r.vertices.length, r.triangles.length], [4, 2]);
  const q = [[0, 0], [0.6, 0.2], [0.6, 0.8], [0, 1]];
  const t = layerMesh({source: 'old', src: [0, 0, 1, 1], quad: q, uv: [[0, 0], [1, 0], [1, 1], [0, 1]], alpha: 1, fade: [1, 1, 1, 1]});
  assert.equal(t.vertices.length, 81);
  assert.equal(t.triangles.length, 128);
  assert.deepEqual(t.vertices[0].pos, q[0]);
  assert.ok(t.vertices[4].pos[0] > 0.3, 'foreshortening: the middle column sits nearer the far edge than halfway');
  const d = layerMesh({source: 'old', src: [0, 0, 1, 1], quad: Array(4).fill([0.5, 0.5]), uv: [[0, 0], [1, 0], [1, 1], [0, 1]], alpha: 1, fade: [1, 1, 1, 1]});
  assert.ok(d.vertices.every(v => v.pos.every(Number.isFinite)));
});
