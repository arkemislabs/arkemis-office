// WordArt on text in .docx: the w14 text effects of a run (w14:textFill, w14:textOutline, w14:shadow, w14:glow,
// w14:reflection, [MS-DOCX] §2.6.4) written from and read into the run's `textEffects`.
//
// Translated from wordcraft crates/docx src/read/wordart.rs and src/write/wordart.rs at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `textEffects` is `{fill?, outline?, shadow?, glow?, reflection?, xml?}` (model/wordart.mjs); `xml` keeps the effects
// this does not read (theme colours, 3-D) as their markup so a save writes them back. No DOM, no Node built-ins.

import {sanitizedTextEffects} from '../model/wordart.mjs';
import {rgbHex, parseRgb} from '../model/props.mjs';

const EMU = 12_700;
const emu = v => String(Math.round((Number.isFinite(v) ? v : 0) * EMU));
const alphaOf = t => String(Math.round((1 - Math.max(0, Math.min(100, t ?? 0)) / 100) * 100_000));

function color(w, rgb, transparency) {
  if (transparency > 0) { w.open('w14:srgbClr', [['w14:val', rgbHex(rgb)]]); w.empty('w14:alpha', [['w14:val', alphaOf(transparency)]]); w.close('w14:srgbClr'); } else w.empty('w14:srgbClr', [['w14:val', rgbHex(rgb)]]);
}

/** The run's structured effects as w14 elements. */
export function writeTextEffects(w, fx) {
  if (!fx) return;
  const e = sanitizedTextEffects(fx);
  if (e.glow) { w.open('w14:glow', [['w14:rad', emu(e.glow.size)]]); color(w, e.glow.color, e.glow.transparency); w.close('w14:glow'); }
  if (e.shadow) {
    const s = e.shadow;
    w.open('w14:shadow', [['w14:blurRad', emu(s.blur)], ['w14:dist', emu(s.distance)], ['w14:dir', String(Math.round(s.angle * 60_000))], ['w14:sx', '100000'], ['w14:sy', '100000'], ['w14:kx', '0'], ['w14:ky', '0'], ['w14:algn', 'tl']]);
    color(w, s.color, s.transparency);
    w.close('w14:shadow');
  }
  if (e.reflection) {
    const r = e.reflection;
    w.empty('w14:reflection', [['w14:blurRad', emu(r.blur)], ['w14:stA', String(Math.round((100 - r.transparency) * 1000))], ['w14:stPos', '0'], ['w14:endA', '0'], ['w14:endPos', String(Math.round(r.size * 1000))],
      ['w14:dist', emu(r.distance)], ['w14:dir', '5400000'], ['w14:fadeDir', '5400000'], ['w14:sx', '100000'], ['w14:sy', '-100000'], ['w14:kx', '0'], ['w14:ky', '0'], ['w14:algn', 'bl']]);
  }
  if (e.outline) {
    const o = e.outline;
    if (o.color) {
      w.open('w14:textOutline', [['w14:w', emu(o.width)], ['w14:cap', 'flat'], ['w14:cmpd', 'sng'], ['w14:algn', 'ctr']]);
      w.open('w14:solidFill'); color(w, o.color, o.transparency); w.close('w14:solidFill');
      w.empty('w14:prstDash', [['w14:val', 'solid']]); w.empty('w14:round');
      w.close('w14:textOutline');
    } else { w.open('w14:textOutline', [['w14:w', '0']]); w.empty('w14:noFill'); w.close('w14:textOutline'); }
  }
  if (e.fill) {
    const f = e.fill;
    w.open('w14:textFill');
    if (f.type === 'none') w.empty('w14:noFill');
    else if (f.type === 'solid') { w.open('w14:solidFill'); color(w, f.color, f.transparency); w.close('w14:solidFill'); }
    else {
      w.open('w14:gradFill');
      w.open('w14:gsLst');
      for (const s of f.stops) { w.open('w14:gs', [['w14:pos', String(Math.round(s.pos * 1000))]]); color(w, s.color, s.transparency); w.close('w14:gs'); }
      w.close('w14:gsLst');
      w.empty('w14:lin', [['w14:ang', String(Math.round((f.angle ?? 90) * 60_000))], ['w14:scaled', '0']]);
      w.close('w14:gradFill');
    }
    w.close('w14:textFill');
  }
}

// ---- reading -------------------------------------------------------------------------------------------

const num = (e, name) => { const v = e?.attr(name); const n = v === null || v === undefined ? NaN : Number(v); return Number.isFinite(n) ? n : null; };
/** [rgb, transparency %] of the w14:srgbClr under `e`, or null (theme colours stay markup). */
function readColor(e) {
  const c = e?.child('w14:srgbClr');
  const rgb = parseRgb(c?.attr('w14:val'));
  if (!rgb) return null;
  const a = num(c.child('w14:alpha'), 'w14:val');
  return [rgb, a === null ? 0 : Math.max(0, Math.min(100, 100 - a / 1000))];
}

/** One w14 effect element as `{key, value}` for textEffects, or null when it holds more than this reads. */
export function readTextEffect(k) {
  switch (k.name) {
    case 'w14:glow': { const c = readColor(k); return c ? {key: 'glow', value: {color: c[0], size: (num(k, 'w14:rad') ?? 0) / EMU, transparency: c[1]}} : null; }
    case 'w14:shadow': {
      const c = readColor(k);
      return c ? {key: 'shadow', value: {color: c[0], transparency: c[1], blur: (num(k, 'w14:blurRad') ?? 0) / EMU, distance: (num(k, 'w14:dist') ?? 0) / EMU, angle: (num(k, 'w14:dir') ?? 0) / 60_000, rotWithShape: false}} : null;
    }
    case 'w14:reflection': {
      if ((num(k, 'w14:endA') ?? 0) > 1000 || (num(k, 'w14:stPos') ?? 0) !== 0) return null;
      return {key: 'reflection', value: {transparency: 100 - (num(k, 'w14:stA') ?? 100_000) / 1000, size: (num(k, 'w14:endPos') ?? 100_000) / 1000, distance: (num(k, 'w14:dist') ?? 0) / EMU, blur: (num(k, 'w14:blurRad') ?? 0) / EMU}};
    }
    case 'w14:textOutline': {
      if (k.child('w14:noFill')) return {key: 'outline', value: {color: null, width: (num(k, 'w14:w') ?? 0) / EMU, transparency: 0}};
      const c = readColor(k.child('w14:solidFill'));
      if (!c || k.child('w14:gradFill') || (k.child('w14:prstDash') && k.child('w14:prstDash').attr('w14:val') !== 'solid')) return null;
      return {key: 'outline', value: {color: c[0], width: (num(k, 'w14:w') ?? 9525) / EMU, transparency: c[1]}};
    }
    case 'w14:textFill': {
      if (k.child('w14:noFill')) return {key: 'fill', value: {type: 'none'}};
      const solid = k.child('w14:solidFill');
      if (solid) { const c = readColor(solid); return c ? {key: 'fill', value: {type: 'solid', color: c[0], transparency: c[1]}} : null; }
      const g = k.child('w14:gradFill');
      if (!g) return null;
      const stops = [];
      for (const gs of g.child('w14:gsLst')?.elList() ?? []) {
        const c = readColor(gs), pos = num(gs, 'w14:pos');
        if (gs.name !== 'w14:gs' || !c || pos === null) return null;
        stops.push({pos: pos / 1000, color: c[0], transparency: c[1]});
      }
      if (stops.length < 2 || g.child('w14:path')) return null;
      return {key: 'fill', value: {type: 'gradient', stops, angle: (num(g.child('w14:lin'), 'w14:ang') ?? 5_400_000) / 60_000}};
    }
    default: return null;
  }
}
