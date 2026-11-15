// Review › Tracking launcher: Track Changes Options — Show (Comments, Ink, Insertions and
// Deletions, Formatting), Balloons, Comments, Advanced (Insertions, Deletions, Changed lines with
// their colours), Moves (Moved from, Moved to with their colours) and Track formatting; OK runs one
// review.trackingOptions (the person's preference, as in Word).
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_lists.rs (`TrackForm`,
// `INSERT_MARKS`, `DELETE_MARKS`, `MOVE_TO_MARKS`, `track_options`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {markupOf} from '../lib/review-markup.mjs';

const COLOR_KEYS = ['insertColor', 'deleteColor', 'changedLinesColor', 'moveFromColor', 'moveToColor'];
const BOOLS = ['comments', 'ink', 'insertionsDeletions', 'formatting', 'trackFormatting'];
const CHOICES = ['balloons', 'commentDisplay', 'insertMark', 'deleteMark', 'changedLines', 'moveFromMark', 'moveToMark'];

/** The dialog's values from the person's options: colours as #RRGGBB, or "" for By author / Automatic. */
export function trackValues(prefs, doc) {
  const m = markupOf(prefs);
  const out = {};
  for (const k of [...BOOLS, ...CHOICES]) out[k] = m[k];
  for (const k of COLOR_KEYS) out[k] = m[k] ? `#${String(m[k]).toUpperCase()}` : '';
  out.trackMoves = doc?.settings?.trackMoves ?? true;
  return out;
}

/** review.trackingOptions params from the dialog's values (TrackForm::params). */
export function trackParams(v) {
  const p = {};
  for (const k of BOOLS) if (typeof v[k] === 'boolean') p[k] = v[k];
  for (const k of CHOICES) if (typeof v[k] === 'string' && v[k]) p[k] = v[k];
  for (const k of COLOR_KEYS) {
    const c = typeof v[k] === 'string' ? v[k].trim().replace(/^#/, '') : '';
    p[k] = /^[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : k === 'changedLinesColor' ? 'auto' : 'byAuthor';
  }
  if (typeof v.trackMoves === 'boolean') p.trackMoves = v.trackMoves;
  return p;
}

export default defineDialog({
  id: 'dialog.trackChangesOptions',
  title: 'Track Changes Options',
  command: 'review.trackingOptions',
  init: ctx => trackValues(ctx.prefs, ctx.doc),
  validate(v) {
    return COLOR_KEYS.filter(k => typeof v[k] === 'string' && v[k].trim() && !/^#?[0-9a-f]{6}$/i.test(v[k].trim()))
      .map(k => ({field: k, message: 'Choose a colour or Automatic.'}));
  },
  toCommand: v => ({command: 'review.trackingOptions', params: trackParams(v)}),
});
