// Transition and animation tables and helpers: the Effect Options labels PowerPoint shows, the
// direction words people type for an animation option, the motion-path presets and the default
// path of each motion-path effect, the built-in transition sounds (synthesised WAVs).
// Translated from deckcraft crates/model/src/anim.rs (`transition_option_label`, `preset_path`),
// crates/engine/src/cmd/animation.rs (`resolve_option`, `default_path`), crates/anim/src/path.rs
// (`default_path`, `polygon`) and crates/engine/src/sounds.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// The tables themselves (TRANSITIONS, ANIMATIONS, animationInfo) are the ones the .pptx reader and
// writer already use (formats/pptx-read.mjs); this file adds what the commands and the ribbon need.

import {TRANSITIONS, ANIMATIONS, animationInfo} from '../formats/pptx-read.mjs';

export {TRANSITIONS, ANIMATIONS, animationInfo};
export const UPSTREAM_COMMIT = 'f893f6af7d36a5409fd804e81a34fd895cfefedf';

/** Entries of the transition gallery as objects: {id, label, category, durationMs, options}. */
export const transitionList = () => TRANSITIONS.map(([id, label, category, durationMs, options]) => ({id, label, category, durationMs, options: [...options]}));
export const transitionInfo = kind => {
  const k = String(kind).toLowerCase();
  const t = TRANSITIONS.find(x => x[0].toLowerCase() === k);
  return t ? {id: t[0], label: t[1], category: t[2], durationMs: t[3], options: [...t[4]]} : null;
};
/** Entries of the animation gallery as objects: {id, label, class, preset, durationMs, options}. */
export const animationList = () => ANIMATIONS.map(([id, label, cls, preset, durationMs, options]) => ({id, label, class: cls, preset, durationMs, options: [...options]}));
export const CLASS_LABELS = Object.freeze({entrance: 'Entrance', emphasis: 'Emphasis', exit: 'Exit', path: 'Motion Paths', media: 'Media'});
/** The effects the Animations tab's in-ribbon gallery shows (crates/ui-egui/src/ribbon/animations.rs). */
export const QUICK_ANIMATIONS = Object.freeze(['appear', 'fade', 'fly', 'float', 'split', 'wipe', 'zoom', 'pulse', 'spin', 'growShrink', 'fadeOut', 'flyOut', 'lines']);

// ---------------------------------------------------------------------------------------------
// Transition option labels (anim.rs `transition_option_label`)

const SIDE = {l: 'Left', r: 'Right', u: 'Top', d: 'Bottom'};
const side = c => SIDE[c] ?? 'Bottom';
const OPPOSITE = {l: 'r', r: 'l', u: 'd', d: 'u'};
const opposite = c => OPPOSITE[c] ?? 'u';
const MOVING = new Set(['push', 'wipe', 'cover', 'uncover', 'pan', 'vortex', 'cube', 'box', 'rotate', 'orbit', 'gallery', 'conveyor', 'ferris', 'switch', 'flip']);

/**
 * The Effect Options label PowerPoint shows for a transition option. Options are stored as the
 * file format's values: for moving transitions (Push, Wipe, Cover, Pan, Cube…) the direction things
 * move, so "l" is the effect coming "From Right"; Glitter and the preset effects (Fall Over,
 * Wind…) name the side itself; Ripple names where the wave heads.
 */
export function transitionOptionLabel(kind, option) {
  const o = String(option ?? '');
  const corner = (opt, flip) => {
    const [h0, v0] = [...opt];
    if (h0 === undefined || v0 === undefined) return null;
    const [h, v] = flip ? [opposite(h0), opposite(v0)] : [h0, v0];
    return `From ${side(v)}-${side(h)}`;
  };
  const moving = MOVING.has(kind);
  if (o === 'horz') return 'Horizontal';
  if (o === 'vert') return 'Vertical';
  if (kind === 'split') return `${o.startsWith('horz') ? 'Horizontal' : 'Vertical'} ${o.endsWith('In') ? 'In' : 'Out'}`;
  if ((kind === 'fade' || kind === 'cut') && o === 'throughBlack') return 'Through Black';
  if (kind === 'fade') return 'Smoothly';
  if (kind === 'cut') return 'Cut';
  if (kind === 'clock') return o === 'counterClockwise' ? 'Counterclockwise' : o === 'wedge' ? 'Wedge' : 'Clockwise';
  if (kind === 'zoom' && o === 'rotate') return 'Zoom and Rotate';
  if (kind === 'ripple') return o === 'center' ? 'Center' : corner(o, true) ?? 'Center';
  if (kind === 'glitter') {
    const hex = o.startsWith('hex');
    const d = (hex ? o.slice(3) : o).toLowerCase();
    return `${hex ? 'Hexagons' : 'Diamonds'} From ${side(d[0] ?? 'l')}`;
  }
  if (kind === 'pageCurlDouble') return o === 'singleL' ? 'Single Left' : o === 'singleR' ? 'Single Right' : o === 'r' ? 'Double Right' : 'Double Left';
  if (kind === 'shred') return `${o.startsWith('particles') ? 'Particles' : 'Strips'} ${o.endsWith('Out') ? 'Out' : 'In'}`;
  if (kind === 'reveal') return `${o.startsWith('black') ? 'Through Black' : 'Smoothly'} ${o.endsWith('Right') ? 'From Right' : 'From Left'}`;
  if (kind === 'flythrough') return `${o.startsWith('out') ? 'Out' : 'In'}${o.endsWith('Bounce') ? ' with Bounce' : ''}`;
  if (kind === 'morph') return o === 'words' ? 'Words' : o === 'characters' ? 'Characters' : 'Objects';
  if (o.length === 2 && moving) return corner(o, true) ?? '';
  if (o.length === 1 && moving) return `From ${side(opposite(o))}`;
  if (o === 'l') return 'Left';
  if (o === 'r') return 'Right';
  if (o === 'u') return 'Top';
  if (o === 'd') return 'Bottom';
  if (o === 'in') return 'In';
  if (o === 'out') return 'Out';
  return o;
}

// ---------------------------------------------------------------------------------------------
// Animation option labels (the ribbon's `option_label`, crates/ui-egui/src/ribbon/transitions.rs)

/** The Effect Options label of an animation option as the Animations tab prints it (`option_label`). */
export function animationOptionLabel(option) {
  switch (option) {
    case 'l': return 'From Left';
    case 'r': return 'From Right';
    case 'u': return 'From Top';
    case 'd': return 'From Bottom';
    case 'horz': return 'Horizontal';
    case 'vert': return 'Vertical';
    case 'in': return 'In';
    case 'out': return 'Out';
    default: {
      const s = String(option ?? '');
      let out = '';
      [...s].forEach((c, i) => {
        if (i === 0) out += c.toUpperCase();
        else if (c !== c.toLowerCase()) out += ` ${c}`;
        else out += c;
      });
      return out;
    }
  }
}

/**
 * The effect option `given` as one of `allowed`. Besides the stored codes ("b", "lt", "u", …) it
 * takes the direction words people type: "fromBottom", "bottom", "fromTopLeft", "upRight". null
 * when it matches none of them: the renderer reads direction codes letter by letter, so an
 * unchecked "fromBottom" would fly in from the right and the bottom (animation.rs `resolve_option`).
 */
export function resolveOption(allowed, given) {
  if (!allowed.length || allowed.includes(given)) return given;
  const low = String(given).toLowerCase();
  const exact = allowed.find(o => o.toLowerCase() === low);
  if (exact !== undefined) return exact;
  let rest = low.startsWith('from') ? low.slice(4) : low;
  rest = rest.replace(/^[-_ ]+/, '');
  const dirs = [];
  const words = [['bottom', 'b', 'd'], ['down', 'b', 'd'], ['top', 't', 'u'], ['up', 't', 'u'], ['left', 'l', 'l'], ['right', 'r', 'r'], ['-', '-', '-'], ['_', '-', '-']];
  while (rest.length) {
    const w = words.find(([x]) => rest.startsWith(x));
    if (!w) return null;
    if (w[1] !== '-') dirs.push([w[1], w[2]]);
    rest = rest.slice(w[0].length);
  }
  if (!dirs.length || dirs.length > 2) return null;
  const cands = [];
  for (const pick of [d => d[0], d => d[1]]) {
    const code = dirs.map(pick).join('');
    cands.push(code, [...code].reverse().join(''));
  }
  return cands.find(c => allowed.includes(c)) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Motion paths (anim.rs `preset_path`, path.rs `default_path`, animation.rs `default_path`)

const TAU = Math.PI * 2;
const num4 = v => { const s = (Math.round(v * 1e4) / 1e4).toFixed(4); return s === '-0.0000' ? '0.0000' : s; };

/** The path of a motion-path preset beyond Lines, Arcs, Turns, Shapes and Loops (our path syntax: `M`, `L`, `Z`, ending in `E`); null for any other effect. */
export function presetPath(effect) {
  const poly = (n, closed, f) => {
    const [x0, y0] = f(0);
    let s = 'M 0 0';
    for (let k = 1; k <= n; k++) { const [x, y] = f(k / n); s += ` L ${num4(x - x0)} ${num4(y - y0)}`; }
    if (closed) s += ' Z';
    return `${s} E`;
  };
  const pts = (p, closed) => {
    let s = 'M 0 0';
    for (const [x, y] of p) s += ` L ${num4(x)} ${num4(y)}`;
    if (closed) s += ' Z';
    return `${s} E`;
  };
  const polar = (scale, r) => poly(96, true, t => {
    const a = -Math.PI / 2 + TAU * t;
    const rr = r(a + Math.PI / 2) * scale;
    return [rr * Math.cos(a), rr * Math.sin(a)];
  });
  const star = (n, outer, inner) => {
    const p = [];
    const start = [0, -outer];
    for (let k = 1; k <= 2 * n; k++) {
      const a = -Math.PI / 2 + (Math.PI * k) / n;
      const r = k % 2 === 1 ? inner : outer;
      p.push([r * Math.cos(a) - start[0], r * Math.sin(a) - start[1]]);
    }
    return pts(p, true);
  };
  const spiral = dir => poly(120, false, t => {
    const r = 0.12 * (1 - t);
    const a = dir * 3 * TAU * t;
    return [dir * (0.12 - r * Math.cos(a)), -r * Math.sin(a)];
  });
  const bounce = dir => poly(90, false, t => [dir * 0.3 * t, 0.15 * t - 0.1 * (1 - t) * Math.abs(Math.sin(3 * Math.PI * t))]);
  switch (effect) {
    case 'diagonalDownRight': return pts([[0.2, 0.2]], false);
    case 'diagonalUpRight': return pts([[0.2, -0.2]], false);
    case 'zigzag': return pts([[0.05, 0.04], [0.1, 0], [0.15, 0.04], [0.2, 0], [0.25, 0.04], [0.3, 0]], false);
    case 'sineWave': return poly(64, false, t => [0.3 * t, 0.04 * Math.sin(2 * TAU * t)]);
    case 'pathWave': return poly(48, false, t => [0.3 * t, 0.06 * Math.sin(TAU * t)]);
    case 'decayingWave': return poly(96, false, t => [0.3 * t, 0.07 * Math.exp(-3 * t) * Math.sin(3 * TAU * t)]);
    case 'heartbeat': return pts([[0.08, 0], [0.1, -0.08], [0.13, 0.06], [0.15, 0], [0.25, 0]], false);
    case 'sCurve1': return poly(48, false, t => [0.2 * t, 0.1 - 0.1 * Math.cos(Math.PI * t)]);
    case 'sCurve2': return poly(48, false, t => [0.1 - 0.1 * Math.cos(Math.PI * t), 0.2 * t]);
    case 'stairsDown': return pts([[0.06, 0], [0.06, 0.06], [0.12, 0.06], [0.12, 0.12], [0.18, 0.12], [0.18, 0.18]], false);
    case 'bounceRight': return bounce(1);
    case 'bounceLeft': return bounce(-1);
    case 'spiralRight': return spiral(1);
    case 'spiralLeft': return spiral(-1);
    case 'spring': return poly(160, false, t => [0.3 * t + 0.03 * Math.cos(5 * TAU * t), 0.03 * Math.sin(5 * TAU * t)]);
    case 'funnel': return poly(160, false, t => {
      const r = 0.12 * (1 - t);
      return [r * Math.cos(3 * TAU * t), 0.25 * t + 0.03 * Math.sin(3 * TAU * t) * (1 - t)];
    });
    case 'swoosh': return poly(48, false, t => [0.3 * t, -0.12 * Math.sin(Math.PI * t) + 0.1 * t * t]);
    case 'star4': return star(4, 0.1, 0.04);
    case 'star5': return star(5, 0.1, 0.04);
    case 'star6': return star(6, 0.1, 0.05);
    case 'star8': return star(8, 0.1, 0.06);
    case 'heart': return poly(96, true, t => {
      const a = TAU * t;
      return [0.006 * 16 * Math.sin(a) ** 3, -0.006 * (13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a))];
    });
    case 'crescentMoon': {
      const p = [];
      for (let k = 1; k <= 32; k++) { const a = -Math.PI / 2 - (Math.PI * k) / 32; p.push([0.1 * Math.cos(a), 0.1 + 0.1 * Math.sin(a)]); }
      for (let k = 1; k <= 32; k++) { const a = Math.PI / 2 - (Math.PI * k) / 32; p.push([0.06 * Math.cos(a) - 0.03, 0.1 + 0.1 * Math.sin(a)]); }
      return pts(p, true);
    }
    case 'teardrop': return polar(0.1, a => 0.6 + 0.4 * Math.abs(Math.cos(a / 2)) ** 3);
    case 'football': return poly(64, true, t => {
      const a = TAU * t;
      return [0.12 * Math.sin(a), 0.06 * (1 - Math.cos(a)) * (1 - 0.3 * Math.abs(Math.cos(2 * a)))];
    });
    case 'plusPath': return pts([[0.04, 0], [0.04, 0.04], [0.08, 0.04], [0.08, 0.08], [0.04, 0.08], [0.04, 0.12], [0, 0.12], [0, 0.08], [-0.04, 0.08], [-0.04, 0.04], [0, 0.04]], true);
    case 'rightTriangle': return pts([[0, 0.15], [0.15, 0.15]], true);
    case 'curvedSquare': return poly(96, true, t => {
      const a = -Math.PI / 2 + TAU * t;
      const sg = v => Math.sign(v) * Math.sqrt(Math.abs(v));
      return [0.1 * sg(Math.cos(a)), 0.1 + 0.1 * sg(Math.sin(a))];
    });
    case 'figure8Horizontal': return poly(96, true, t => { const a = TAU * t; return [0.15 * Math.sin(a), 0.06 * Math.sin(2 * a)]; });
    case 'figure8Vertical': return poly(96, true, t => { const a = TAU * t; return [0.06 * Math.sin(2 * a), 0.15 * (1 - Math.cos(a))]; });
    case 'loopDeLoop': return poly(120, false, t => [0.3 * t - 0.05 * Math.sin(2 * TAU * t), -0.05 * (1 - Math.cos(2 * TAU * t))]);
    case 'bean': return polar(0.1, a => 0.75 + 0.25 * Math.cos(a) + 0.15 * Math.cos(2 * a));
    case 'peanut': return polar(0.1, a => 0.7 + 0.3 * Math.abs(Math.cos(2 * a)));
    case 'neutron': return polar(0.1, a => 0.35 + 0.65 * Math.abs(Math.cos(3 * a)));
    default: return null;
  }
}

function polygonPath(n, r, rot0) {
  let s = 'M 0 0';
  const c = [0, r];
  const a0 = -Math.PI / 2 + rot0;
  const start = [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)];
  for (let k = 1; k <= n; k++) {
    const a = a0 + (TAU * k) / n;
    s += ` L ${num4(c[0] + r * Math.cos(a) - start[0])} ${num4(c[1] + r * Math.sin(a) - start[1])}`;
  }
  return `${s} E`;
}

/** crates/anim/src/path.rs `default_path`: the path a preset motion-path effect plays when the animation has none of its own. */
export function motionDefaultPath(effect, option) {
  let sx = 1, sy = 1, swap = false;
  if (option === 'up') { sy = -1; } else if (option === 'right') { swap = true; } else if (option === 'left') { sx = -1; swap = true; }
  const tr = pts => pts.map(([x, y]) => (swap ? [y * sx, x * sy] : [x * sx, y * sy]));
  const fmt = (head, pts) => `${head}${pts.map(([x, y]) => ` ${num4(x)} ${num4(y)}`).join('')} E`;
  switch (effect) {
    case 'lines': return fmt('M 0 0 L', tr([[0, 0.25]]));
    case 'arcs': return fmt('M 0 0 C', tr([[0.1, 0.05], [0.1, 0.2], [0, 0.25]]));
    case 'turns': {
      const p = tr([[0, 0.12], [0, 0.2], [0.05, 0.25], [0.12, 0.25]]);
      let s = 'M 0 0';
      if (p.length) s += ` L ${num4(p[0][0])} ${num4(p[0][1])} C`;
      for (const [x, y] of p.slice(1)) s += ` ${num4(x)} ${num4(y)}`;
      return `${s} E`;
    }
    case 'shapes':
      switch (option) {
        case 'diamond': return polygonPath(4, 0.1, 0);
        case 'hexagon': return polygonPath(6, 0.1, 0);
        case 'triangle': return polygonPath(3, 0.1, 0);
        case 'square': return polygonPath(4, 0.1, Math.PI / 4);
        case 'octagon': return polygonPath(8, 0.1, 0);
        case 'pentagon': return polygonPath(5, 0.1, 0);
        case 'trapezoid': return 'M 0 0 L 0.1 0 L 0.15 0.15 L -0.05 0.15 Z E';
        case 'parallelogram': return 'M 0 0 L 0.15 0 L 0.1 0.15 L -0.05 0.15 Z E';
        default: return 'M 0 0 C 0.0552 0 0.1 0.0448 0.1 0.1 C 0.1 0.1552 0.0552 0.2 0 0.2 C -0.0552 0.2 -0.1 0.1552 -0.1 0.1 C -0.1 0.0448 -0.0552 0 0 0 Z E';
      }
    case 'loops': return 'M 0 0 C 0.08 -0.1 0.16 0 0.08 0.05 C 0 0.1 -0.08 0.1 -0.08 0 C -0.08 -0.1 0 -0.05 0 0 E';
    default: return presetPath(effect) ?? '';
  }
}

/** animation.rs `default_path`: the path stored on a new motion-path animation, in slide fractions from the shape. */
export function defaultPath(effect, option) {
  let dx = 0, dy = 0.25;
  if (option === 'up') { dy = -0.25; } else if (option === 'right') { dx = 0.25; dy = 0; } else if (option === 'left') { dx = -0.25; dy = 0; }
  const g = v => String(Math.round(v * 1e9) / 1e9);
  switch (effect) {
    case 'arcs': return `M 0 0 C ${g(dx * 0.1 + dy * 0.5)} ${g(dy * 0.1 - dx * 0.5)} ${g(dx * 0.9 + dy * 0.5)} ${g(dy * 0.9 - dx * 0.5)} ${g(dx)} ${g(dy)} E`;
    case 'turns': return `M 0 0 L ${g(dx * 0.5)} ${g(dy * 0.5)} C ${g(dx)} ${g(dy * 0.5)} ${g(dx)} ${g(dy * 0.75)} ${g(dx)} ${g(dy)} E`;
    case 'shapes': return 'M 0 0 C 0.1 0 0.1 0.15 0 0.15 C -0.1 0.15 -0.1 0 0 0 Z E';
    case 'loops': return 'M 0 0 C 0.1 -0.1 0.2 0.1 0.1 0.1 C 0 0.1 0.1 -0.1 0.25 0 E';
    default: return presetPath(effect) ?? `M 0 0 L ${g(dx)} ${g(dy)} E`;
  }
}

// ---------------------------------------------------------------------------------------------
// Built-in transition sounds (sounds.rs): short mono 16-bit WAVs, synthesised on demand

/** (id, label) of the built-in sounds, in menu order. */
export const BUILTIN_SOUNDS = Object.freeze([['chime', 'Chime'], ['click', 'Click'], ['camera', 'Camera'], ['whoosh', 'Whoosh'], ['drumRoll', 'Drum Roll'], ['laser', 'Laser']]);
const RATE = 22050;
const u32 = v => v >>> 0;

/** The upstream's small deterministic noise source (-1..1). */
function lcg(seed) {
  let s = u32(seed);
  return () => { s = u32(Math.imul(s, 1664525) + 1013904223); return (s >>> 8) / (1 << 23) - 1; };
}
const tone = (secs, f) => Array.from({length: Math.floor(secs * RATE)}, (_, i) => f(i / RATE));
const attack = (t, len) => Math.min(t / len, 1);

/** The WAV bytes of built-in sound `id`, or null for an unknown id. */
export function builtinSound(id) {
  const noise = lcg(0x9e3779b9);
  let samples;
  switch (id) {
    case 'chime': samples = tone(1.2, t => Math.exp(-t * 3) * attack(t, 0.005) * (0.6 * Math.sin(TAU * 880 * t) + 0.3 * Math.sin(TAU * 1318.5 * t) + 0.15 * Math.sin(TAU * 1760 * t))); break;
    case 'click': samples = tone(0.03, t => Math.exp(-t * 300) * noise()); break;
    case 'camera': samples = tone(0.35, t => {
      const a = Math.exp(-t * 250);
      const b = t > 0.18 ? Math.exp(-(t - 0.18) * 180) : 0;
      return (a + 0.8 * b) * noise();
    }); break;
    case 'whoosh': {
      let lp = 0;
      samples = tone(0.7, t => {
        const k = 0.02 + 0.25 * Math.sin((Math.PI * t) / 0.7);
        lp += k * (noise() - lp);
        return 3 * lp * Math.sin((Math.PI * t) / 0.7);
      });
      break;
    }
    case 'drumRoll': samples = tone(1.4, t => {
      const beat = ((t * 24) % 1) / 24;
      const swell = 0.4 + 0.6 * (t / 1.4);
      return swell * Math.exp(-beat * 90) * (0.7 * noise() + 0.5 * Math.sin(TAU * 110 * t));
    }); break;
    case 'laser': {
      let phase = 0;
      samples = tone(0.5, t => {
        phase += (TAU * (2400 * Math.exp(-t * 5) + 200)) / RATE;
        return Math.exp(-t * 4) * attack(t, 0.003) * Math.sign(Math.sin(phase)) * 0.35;
      });
      break;
    }
    default: return null;
  }
  return wav(samples);
}

function wav(samples) {
  const dataLen = samples.length * 2;
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const tag = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); tag(8, 'WAVE'); tag(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, RATE, true); dv.setUint32(28, RATE * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); tag(36, 'data'); dv.setUint32(40, dataLen, true);
  samples.forEach((s, i) => dv.setInt16(44 + i * 2, Math.trunc(Math.min(Math.max(s, -1), 1) * 0.8 * 32767), true));
  return out;
}
