// What Presenter View shows for a slide show at slide `slide`: the slide number among the slides the show
// plays, the next slide, and the notes; and the elapsed-time clock with pause and reset.
// Translated from deckcraft crates/ui-egui/src/show/presenter.rs (`PresenterTimer`, `format_elapsed`,
// the notes size steps) and the engine's show state (`peek_next`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {ShowState} from './show-state.mjs';
import {bodyText} from '../model/text.mjs';

export const NOTES_DEFAULT = 18, NOTES_MIN = 12, NOTES_MAX = 48, NOTES_STEP = 4;

/**
 * The picture of the show at `slide`: {position (1-based among the shown slides), total, next (an index or null), notes (text)}.
 * @param {any} pres @param {number} slide @param {string | null} [custom] the custom show being played
 */
export function presenterView(pres, slide, custom = null) {
  const st = (custom ? ShowState.playCustom(pres, custom) : null) ?? ShowState.startAt(pres, 0);
  st.slide = slide;
  const order = st.visit(pres);
  const at = order.indexOf(slide);
  const next = st.nextIndex(pres);
  return {position: at >= 0 ? at + 1 : 0, total: order.length, next: next === undefined ? null : next, notes: bodyText(pres.slides?.[slide]?.notes)};
}

const finiteSecs = n => (Number.isFinite(n) && n >= 0 ? n : 0);
/** The elapsed-time clock: pausing freezes the number, the show keeps playing; reset zeroes it (a paused one stays paused). */
export class PresenterTimer {
  constructor(now) { this.origin = Number.isFinite(now) ? now : 0; this.frozen = 0; this.paused = false; }
  elapsed(now) {
    if (this.paused) return finiteSecs(this.frozen);
    const dt = now - this.origin;
    return finiteSecs(this.frozen + (Number.isFinite(dt) && dt > 0 ? dt : 0));
  }
  toggle(now) {
    if (this.paused) { this.origin = Number.isFinite(now) ? now : 0; this.paused = false; } else { this.frozen = this.elapsed(now); this.paused = true; }
  }
  reset(now) { this.frozen = 0; this.origin = Number.isFinite(now) ? now : 0; }
}
/** `hh:mm:ss`, clamped to 99:59:59. */
export function formatElapsed(secs) {
  const s = Math.min(Math.floor(finiteSecs(secs)), 99 * 3600 + 59 * 60 + 59);
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}
