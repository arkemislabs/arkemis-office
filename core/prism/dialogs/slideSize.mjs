// Slide Size (submit: design.slideSize): Slides sized for (a preset or Custom), Width, Height,
// Orientation, and Maximize content (else ensure fit). The sizes are shown in inches.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_slide_size`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Not translated: Number slides from, and the Notes, Handouts and Outline orientation (nothing upstream).

import {defineDialog} from '../../kernel/dialog.mjs';
import {SLIDE_SIZES} from '../model/defaults.mjs';

const r2 = v => Math.round(v * 100) / 100;
const presetOf = (w, h) => SLIDE_SIZES.find(([, pw, ph]) => Math.abs(pw - w) < 0.01 && Math.abs(ph - h) < 0.01)?.[0] ?? 'Custom';

/** A field in points: the exact value while the number shown is still its rendering, else the number typed. */
const points = (v, k) => (typeof v[`${k}Pt`] === 'number' && r2(v[`${k}Pt`] / 72) === Number(v[k]) ? v[`${k}Pt`] : Number(v[k]) * 72);

export default defineDialog({
  id: 'dialog.slideSize',
  title: 'Slide Size',
  command: 'design.slideSize',
  init(ctx) {
    const {width: w, height: h} = ctx.doc?.slideSize ?? {width: 960, height: 540};
    // Each field keeps its exact size in points beside the two decimals shown, so a preset or an untouched field is not nudged off by the rounding (13.33 in read back would be 959.76 pt).
    return {preset: presetOf(w, h), w: r2(w / 72), h: r2(h / 72), wPt: w, hPt: h, orientation: h > w ? 'portrait' : 'landscape', max: false};
  },
  derive(v, changed) {
    if (changed.includes('preset')) {
      const hit = SLIDE_SIZES.find(([l]) => l === v.preset);
      if (hit) return {w: r2(hit[1] / 72), h: r2(hit[2] / 72), wPt: hit[1], hPt: hit[2], orientation: hit[2] > hit[1] ? 'portrait' : 'landscape'};
      return {};
    }
    if (changed.includes('w') || changed.includes('h')) {
      const w = Number(v.w), h = Number(v.h);
      return {preset: presetOf(points(v, 'w'), points(v, 'h')), orientation: h > w ? 'portrait' : 'landscape'};
    }
    if (changed.includes('orientation')) {
      const w = Number(v.w), h = Number(v.h);
      const portrait = v.orientation === 'portrait';
      if ((portrait && w > h) || (!portrait && h > w)) return {w: v.h, h: v.w, wPt: points(v, 'h'), hPt: points(v, 'w'), preset: presetOf(points(v, 'h'), points(v, 'w'))};
    }
    return {};
  },
  validate(v) {
    const out = [];
    for (const k of ['w', 'h']) {
      const n = Number(v[k]);
      if (!Number.isFinite(n) || n < 1 || n > 56) out.push({field: k, message: 'Size must be from 1 to 56 inches'});
    }
    return out;
  },
  toCommand: v => ({command: 'design.slideSize', params: {w: points(v, 'w'), h: points(v, 'h'), scale: v.max ? 'maximize' : 'ensureFit'}}),
});
