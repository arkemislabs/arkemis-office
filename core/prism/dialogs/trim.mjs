// Trim Media (submit: media.options): start time, end trim, fade in and fade out of the selected
// audio or video, in seconds.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_trim`) and
// crates/ui-egui/src/dialogs/trim.rs (`trim_seed`, `TrimSeed::from_clip`, `seconds_text_to_ms`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// PowerPoint's timeline with play and frame stepping is not offered: deckcraft's dialog has the four fields.

import {defineDialog} from '../../kernel/dialog.mjs';
import {findShape} from '../model/presentation.mjs';
import {currentSlideId, slideById, selectedShapeIds} from '../model/doc.mjs';

/** `seconds_text_to_ms`: seconds (negative and bad values are 0) as whole milliseconds, capped at u32. */
export function secondsToMs(v) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : Number.parseFloat(String(v ?? '').trim());
  const ms = Math.round(Math.max(Number.isFinite(n) ? n : 0, 0) * 1000);
  return Math.min(ms, 4294967295);
}

/** `trim_seed`: the first selected media clip's trims and fades in seconds, else zeros. */
export function trimSeed(ctx) {
  const c = ctx.doc;
  const sl = slideById(c, currentSlideId(c, ctx.selection));
  for (const id of selectedShapeIds(c, ctx.selection)) {
    const m = findShape(sl?.shapes, id)?.kind;
    if (m?.type === 'media') return {start: m.trimStartMs / 1000, end: m.trimEndMs / 1000, fin: m.fadeInMs / 1000, fout: m.fadeOutMs / 1000};
  }
  return {start: 0, end: 0, fin: 0, fout: 0};
}

export default defineDialog({
  id: 'dialog.trim',
  title: 'Trim Media',
  command: 'media.options',
  init: ctx => trimSeed(ctx),
  validate: () => [],
  toCommand: v => ({command: 'media.options', params: {trimStart: secondsToMs(v.start), trimEnd: secondsToMs(v.end), fadeIn: secondsToMs(v.fin),
    fadeOut: secondsToMs(v.fout)}}),
});
