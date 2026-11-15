// Set Up Slide Show (submit: show.setup): Show type (speaker, browsed, kiosk), Loop continuously
// until Esc, Show without narration / animation, which slides (all, a range, a custom show) and
// Use timings, if present.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_setup_show`) and
// crates/engine/src/cmd/review.rs (`setup`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. Not translated: monitor, resolution, Presenter View,
// hardware acceleration (the dialog does not offer them). Pen color and
// Laser pointer color (the pen and laser pointer of the running show, ShowStage.tsx) are PowerPoint's: not checked against upstream.

import {defineDialog} from '../../kernel/dialog.mjs';
import {defaultShowSettings} from '../model/presentation.mjs';
import {hex} from '../model/color.mjs';

const slideCount = ctx => (ctx.doc?.slides ?? []).length;

export default defineDialog({
  id: 'dialog.setupShow',
  title: 'Set Up Show',
  command: 'show.setup',
  init(ctx) {
    const sh = {...defaultShowSettings(), ...(ctx.doc?.show ?? {})};
    const n = slideCount(ctx);
    return {
      type: sh.showType ?? 'speaker', loop: !!sh.loopUntilEsc, nn: !!sh.withoutNarration, na: !!sh.withoutAnimation, ut: sh.useTimings !== false,
      slides: sh.customShow ? 'custom' : Array.isArray(sh.range) ? 'range' : 'all', custom: sh.customShow ?? '',
      from: Array.isArray(sh.range) ? sh.range[0] : 1, to: Array.isArray(sh.range) ? sh.range[1] : Math.max(n, 1),
      penColor: `#${hex(sh.penColor ?? {r: 255, g: 0, b: 0})}`, laserColor: `#${hex(sh.laserColor ?? {r: 255, g: 0, b: 0})}`,
    };
  },
  // A kiosk always loops (PowerPoint checks and locks the box).
  derive: (v, changed) => (changed.includes('type') && v.type === 'kiosk' ? {loop: true} : {}),
  validate(v) {
    const out = [];
    if (v.slides === 'range') {
      const a = Number(v.from), b = Number(v.to);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) out.push({field: 'to', message: 'Give the first slide, then a last slide that is not before it'});
    }
    if (v.slides === 'custom' && !String(v.custom ?? '').trim()) out.push({field: 'custom', message: 'Name the custom show to play'});
    return out;
  },
  toCommand: v => ({command: 'show.setup', params: {
    type: v.type, loop: v.type === 'kiosk' || !!v.loop, noNarration: !!v.nn, noAnimation: !!v.na, useTimings: !!v.ut,
    ...(/^#[0-9a-f]{6}$/i.test(v.penColor) ? {penColor: v.penColor} : {}), ...(/^#[0-9a-f]{6}$/i.test(v.laserColor) ? {laserColor: v.laserColor} : {}),
    ...(v.slides === 'range' ? {from: Number(v.from), to: Number(v.to)} : v.slides === 'custom' ? {custom: String(v.custom).trim()} : {all: true}),
  }}),
});
