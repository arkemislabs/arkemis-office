// A shape's fill and effects in DrawingML: a:solidFill with a:alpha, a:gradFill (linear and path), and a:effectLst
// (a:outerShdw, a:glow, a:softEdge), written from and read into the model's fills and effects.
//
// Translated from wordcraft crates/docx src/read/drawing_fx.rs and src/write/story/drawing.rs (the `fill`,
// `gradient` and `effects` parts) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// The model's fill is `[r, g, b]` | `{type: 'solid', color, transparency}` | `{type: 'gradient', stops, kind, tile?,
// rotWithShape}` (model/fill.mjs); effects are `{shadow?, glow?, softEdge?}` (model/effects.mjs). A fill that names
// theme colours or a picture is not read here (the shape stays whole, as before). No DOM, no Node built-ins.

import {sanitizedFill, fillForm, fillMainColor} from '../model/fill.mjs';
import {sanitizedEffects} from '../model/effects.mjs';
import {rgbHex, parseRgb} from '../model/props.mjs';

const EMU = 12_700;
const emu = v => String(Math.round((Number.isFinite(v) ? v : 0) * EMU));
const pct = v => String(Math.round(Math.max(0, Math.min(100, v)) * 1000));
/** An inset in percent of the shape: it may be negative (a tile rectangle that reaches past the shape). */
const inset = v => String(Math.round(Math.max(-1000, Math.min(1000, Number.isFinite(v) ? v : 0)) * 1000));
const alphaOf = transparency => Math.round((1 - Math.max(0, Math.min(100, transparency ?? 0)) / 100) * 100_000);

function color(w, rgb, transparency) {
  if (transparency > 0) { w.open('a:srgbClr', [['val', rgbHex(rgb)]]); w.empty('a:alpha', [['val', String(alphaOf(transparency))]]); w.close('a:srgbClr'); } else w.empty('a:srgbClr', [['val', rgbHex(rgb)]]);
}

/** The fill of a shape or canvas background: solid (with its alpha), gradient, or no fill. */
export function writeFill(w, fill, ridOf = null) {
  const f = fillForm(fill);
  if (!f) { w.empty('a:noFill'); return; }
  if (f.type === 'picture') {
    // The picture's relationship from the writer; without one (no media in the package) the shape keeps the one colour standing for it.
    const rid = ridOf ? ridOf(f.media) : null;
    if (!rid) { w.open('a:solidFill'); color(w, fillMainColor(f), 0); w.close('a:solidFill'); return; }
    w.open('a:blipFill', [['dpi', '0'], ['rotWithShape', '1']]);
    if (f.transparency > 0) { w.open('a:blip', [['r:embed', rid]]); w.empty('a:alphaModFix', [['amt', String(Math.round((100 - f.transparency) * 1000))]]); w.close('a:blip'); } else w.empty('a:blip', [['r:embed', rid]]);
    w.empty('a:srcRect');
    if (f.tile) w.empty('a:tile', [['tx', '0'], ['ty', '0'], ['sx', String(Math.round(f.scale * 1000))], ['sy', String(Math.round(f.scale * 1000))], ['flip', 'none'], ['algn', 'tl']]);
    else { w.open('a:stretch'); w.empty('a:fillRect'); w.close('a:stretch'); }
    w.close('a:blipFill');
    return;
  }
  if (f.type === 'solid') { w.open('a:solidFill'); color(w, f.color, f.transparency); w.close('a:solidFill'); return; }
  w.open('a:gradFill', [['rotWithShape', f.rotWithShape ? '1' : '0']]);
  w.open('a:gsLst');
  for (const s of f.stops) { w.open('a:gs', [['pos', pct(s.pos)]]); color(w, s.color, s.transparency); w.close('a:gs'); }
  w.close('a:gsLst');
  if (f.kind?.type === 'path') {
    w.open('a:path', [['path', f.kind.shape]]);
    const [l, t, r, b] = f.kind.focus ?? [50, 50, 50, 50];
    w.empty('a:fillToRect', [['l', inset(l)], ['t', inset(t)], ['r', inset(r)], ['b', inset(b)]]);
    w.close('a:path');
    if (f.tile) w.empty('a:tileRect', [['l', inset(f.tile[0])], ['t', inset(f.tile[1])], ['r', inset(f.tile[2])], ['b', inset(f.tile[3])]]);
  } else {
    w.empty('a:lin', [['ang', String(Math.round(((f.kind?.angle ?? 90) % 360) * 60_000))], ['scaled', f.kind?.scaled ? '1' : '0']]);
  }
  w.close('a:gradFill');
}

/** a:effectLst for a shape's shadow, glow and soft edges (nothing when it has none). */
export function writeEffects(w, effects) {
  const e = sanitizedEffects(effects);
  if (!e.shadow && !e.glow && !e.softEdge && !e.reflection && !e.bevel) return;
  if (e.shadow || e.glow || e.softEdge || e.reflection) writeEffectList(w, e);
  if (e.bevel) {
    // A bevel is the shape's 3-D bevel on a flat, front-on camera (a:scene3d, a:sp3d).
    w.open('a:scene3d'); w.empty('a:camera', [['prst', 'orthographicFront']]); w.empty('a:lightRig', [['rig', 'threePt'], ['dir', 't']]); w.close('a:scene3d');
    w.open('a:sp3d'); w.empty('a:bevelT', [['w', emu(e.bevel.w)], ['h', emu(e.bevel.h)], ['prst', e.bevel.preset]]); w.close('a:sp3d');
  }
}

function writeEffectList(w, e) {
  w.open('a:effectLst');
  if (e.glow) { w.open('a:glow', [['rad', emu(e.glow.size)]]); color(w, e.glow.color, e.glow.transparency); w.close('a:glow'); }
  if (e.shadow) {
    const s = e.shadow;
    w.open('a:outerShdw', [['blurRad', emu(s.blur)], ['dist', emu(s.distance)], ['dir', String(Math.round(s.angle * 60_000))], ['algn', 'ctr'], ['rotWithShape', s.rotWithShape ? '1' : '0']]);
    color(w, s.color, s.transparency);
    w.close('a:outerShdw');
  }
  if (e.reflection) {
    const r = e.reflection;
    w.empty('a:reflection', [['blurRad', emu(r.blur)], ['stA', String(Math.round(r.startAlpha * 100_000))], ['endA', String(Math.round(r.endAlpha * 100_000))], ['endPos', String(Math.round(r.endPos * 100_000))],
      ['dist', emu(r.dist)], ['dir', '5400000'], ['fadeDir', '5400000'], ['sx', '100000'], ['sy', '-100000'], ['algn', 'bl'], ['rotWithShape', '0']]);
  }
  if (e.softEdge) w.empty('a:softEdge', [['rad', emu(e.softEdge)]]);
  w.close('a:effectLst');
}

// ---- reading -------------------------------------------------------------------------------------------

const num = (e, name) => { const v = e?.attr(name); const n = v === null || v === undefined ? NaN : Number(v); return Number.isFinite(n) ? n : null; };
/** [rgb, transparency %] of the a:srgbClr under `e`, or null (theme colours are not read). */
function readColor(e) {
  const c = e?.child('a:srgbClr');
  const rgb = parseRgb(c?.attr('val'));
  if (!rgb) return null;
  const a = num(c.child('a:alpha'), 'val');
  return [rgb, a === null ? 0 : Math.max(0, Math.min(100, 100 - a / 1000))];
}

/**
 * The fill of `sp` (a:spPr or wpc:bg): `undefined` when it holds nothing this reads (a picture or pattern fill, theme
 * colours), null for no fill, else the model's fill.
 */
export function readFill(sp, mediaFor = null) {
  if (sp.child('a:noFill')) return null;
  const blip = sp.child('a:blipFill');
  if (blip) {
    // A picture or texture fill: the image part by its relationship, stretched or tiled (a:tile, sx/sy in thousandths of a percent).
    const b = blip.child('a:blip');
    const media = b && mediaFor ? mediaFor(b.attr('r:embed')) : null;
    if (!media) return undefined;
    const tile = blip.child('a:tile');
    const amt = num(b.child('a:alphaModFix'), 'amt');
    return sanitizedFill({type: 'picture', media, tile: !!tile, scale: tile ? (num(tile, 'sx') ?? 100_000) / 1000 : 100, transparency: amt === null ? 0 : 100 - amt / 1000}) ?? undefined;
  }
  const solid = sp.child('a:solidFill');
  if (solid) { const c = readColor(solid); return c ? sanitizedFill(c[1] ? {type: 'solid', color: c[0], transparency: c[1]} : c[0]) : undefined; }
  const g = sp.child('a:gradFill');
  if (!g) return undefined;
  const stops = [];
  for (const gs of g.child('a:gsLst')?.elList() ?? []) {
    if (gs.name !== 'a:gs') continue;
    const c = readColor(gs);
    const pos = num(gs, 'pos');
    if (!c || pos === null) return undefined;
    stops.push({pos: pos / 1000, color: c[0], transparency: c[1]});
  }
  let kind;
  const path = g.child('a:path');
  if (path) {
    const r = path.child('a:fillToRect');
    kind = {type: 'path', shape: path.attr('path') === 'rect' ? 'rect' : path.attr('path') === 'shape' ? 'shape' : 'circle', focus: ['l', 't', 'r', 'b'].map(k => (num(r, k) ?? 0) / 1000)};
  } else {
    const lin = g.child('a:lin');
    kind = {type: 'linear', angle: (num(lin, 'ang') ?? 0) / 60_000, scaled: lin?.attr('scaled') === '1'};
  }
  const tr = g.child('a:tileRect');
  const out = {type: 'gradient', stops, kind, rotWithShape: g.attr('rotWithShape') === '1'};
  if (tr) out.tile = ['l', 't', 'r', 'b'].map(k => (num(tr, k) ?? 0) / 1000);
  return sanitizedFill(out) ?? undefined;
}

/** The shadow, glow and soft edges of `sp`'s a:effectLst; `undefined` when it holds anything else (reflection, blur, inner shadow). */
export function readEffects(sp) {
  const out = {};
  // A bevel on a flat front-on camera; any other 3-D (extrusion, rotation) keeps the shape whole.
  const s3 = sp.child('a:sp3d');
  if (s3) {
    const bt = s3.child('a:bevelT');
    if (!bt || s3.elList().length !== 1 || s3.attr('extrusionH') || s3.attr('contourW')) return undefined;
    out.bevel = {preset: bt.attr('prst') ?? 'circle', w: (num(bt, 'w') ?? 76_200) / EMU, h: (num(bt, 'h') ?? 76_200) / EMU};
  }
  const cam = sp.child('a:scene3d')?.child('a:camera');
  if (sp.child('a:scene3d') && (cam?.attr('prst') !== 'orthographicFront' || cam.child('a:rot'))) return undefined;
  const list = sp.child('a:effectLst');
  if (!list) return sanitizedEffects(out);
  for (const e of list.elList()) {
    if (e.name === 'a:outerShdw') {
      const c = readColor(e);
      if (!c) return undefined;
      out.shadow = {color: c[0], transparency: c[1], blur: (num(e, 'blurRad') ?? 0) / EMU, distance: (num(e, 'dist') ?? 0) / EMU, angle: (num(e, 'dir') ?? 0) / 60_000, rotWithShape: e.attr('rotWithShape') === '1'};
    } else if (e.name === 'a:glow') {
      const c = readColor(e);
      if (!c) return undefined;
      out.glow = {color: c[0], size: (num(e, 'rad') ?? 0) / EMU, transparency: c[1]};
    } else if (e.name === 'a:reflection') {
      out.reflection = {blur: (num(e, 'blurRad') ?? 0) / EMU, startAlpha: (num(e, 'stA') ?? 100_000) / 100_000, endAlpha: (num(e, 'endA') ?? 0) / 100_000, endPos: (num(e, 'endPos') ?? 100_000) / 100_000, dist: (num(e, 'dist') ?? 0) / EMU};
    } else if (e.name === 'a:softEdge') out.softEdge = (num(e, 'rad') ?? 0) / EMU;
    else return undefined;
  }
  return sanitizedEffects(out);
}
