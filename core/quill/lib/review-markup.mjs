// Track Changes Options and Display for Review (U:quill/review): what markup shows and how
// revisions are drawn (a per-user preference, `prefs.markup`), and what each Display for Review
// choice (`view.markup`) asks of the layout and the page drawing.
//
// Translated from wordcraft crates/layout/src/display/options.rs (`InsertMark`, `DeleteMark`,
// `ChangeBar`, `BalloonMode`, `CommentDisplay`, `MarkupOptions::default`, `hides_deletion`) and
// crates/engine/src/cmd/review/changes.rs (`tracking_options`, `tracking_json`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Display for Review: upstream has All Markup and No Markup (`show_markup`); Word's Simple Markup
// (the final text with a red bar beside changed lines, comments in the margin) and Original (the
// text before the changes, no markup) are added as Word draws them.

export const INSERT_MARKS = Object.freeze(['underline', 'doubleUnderline', 'bold', 'italic', 'strikethrough', 'colorOnly', 'none']);
export const DELETE_MARKS = Object.freeze(['strikethrough', 'doubleStrikethrough', 'hidden', 'caret', 'hash', 'underline', 'colorOnly', 'none', 'bold', 'italic', 'doubleUnderline']);
export const CHANGE_BARS = Object.freeze(['outside', 'left', 'right', 'none']);
export const BALLOON_MODES = Object.freeze(['revisions', 'inline', 'commentsAndFormatting']);
export const COMMENT_DISPLAYS = Object.freeze(['margin', 'selected']);
export const MARKUP_VIEWS = Object.freeze(['simple', 'all', 'noMarkup', 'original']);
/** Moved text's colour (MOVE_COLOR) as RRGGBB. */
export const MOVE_HEX = '1A7F37';
/** Simple Markup's bar beside changed lines (Word draws it red). */
export const SIMPLE_BAR = 'C00000';

/** MarkupOptions::default. Colours: null = by author (insert/delete/moves), automatic (change bars). */
export const defaultMarkup = () => ({comments: true, ink: true, insertionsDeletions: true, formatting: true, balloons: 'commentsAndFormatting',
  commentDisplay: 'margin', insertMark: 'underline', insertColor: null, deleteMark: 'strikethrough', deleteColor: null, changedLines: 'outside',
  changedLinesColor: null, trackFormatting: true, moveFromMark: 'doubleStrikethrough', moveFromColor: MOVE_HEX, moveToMark: 'doubleUnderline', moveToColor: MOVE_HEX});

/** The person's Track Changes Options with defaults for anything missing. */
export function markupOf(prefs) {
  const m = prefs?.markup && typeof prefs.markup === 'object' ? prefs.markup : {};
  const out = defaultMarkup();
  for (const k of Object.keys(out)) if (m[k] !== undefined) out[k] = m[k];
  return out;
}

const RGB = /^[0-9A-Fa-f]{6}$/;
const bad = msg => Object.assign(new Error(msg), {code: 'invalid_params'});

/** Apply review.trackingOptions params to options `m` (a copy), validating each (tracking_options). */
export function applyTrackingOptions(m, v) {
  const out = {...m};
  for (const k of ['comments', 'ink', 'insertionsDeletions', 'formatting', 'trackFormatting']) if (typeof v[k] === 'boolean') out[k] = v[k];
  const pick = (k, list, msg) => { if (v[k] === undefined) return; if (!list.includes(v[k])) throw bad(msg); out[k] = v[k]; };
  pick('balloons', BALLOON_MODES, '`balloons`: revisions|inline|commentsAndFormatting');
  pick('commentDisplay', COMMENT_DISPLAYS, '`commentDisplay`: margin|selected');
  pick('insertMark', INSERT_MARKS, 'unknown `insertMark`');
  pick('deleteMark', DELETE_MARKS, 'unknown `deleteMark`');
  pick('moveFromMark', DELETE_MARKS, 'unknown `moveFromMark`');
  pick('moveToMark', INSERT_MARKS, 'unknown `moveToMark`');
  pick('changedLines', CHANGE_BARS, 'unknown `changedLines`');
  const color = (k, auto) => {
    if (v[k] === undefined) return;
    if (v[k] === auto) { out[k] = null; return; }
    if (typeof v[k] !== 'string' || !RGB.test(v[k])) throw bad(`\`${k}\`: "${auto}" or RRGGBB`);
    out[k] = v[k].toUpperCase();
  };
  color('insertColor', 'byAuthor'); color('deleteColor', 'byAuthor'); color('changedLinesColor', 'auto');
  color('moveFromColor', 'byAuthor'); color('moveToColor', 'byAuthor');
  return out;
}

/** The options as review.trackingOptions returns them (tracking_json). */
export function trackingJson(m) {
  return {...m, insertColor: m.insertColor ?? 'byAuthor', deleteColor: m.deleteColor ?? 'byAuthor', changedLinesColor: m.changedLinesColor ?? 'auto',
    moveFromColor: m.moveFromColor ?? 'byAuthor', moveToColor: m.moveToColor ?? 'byAuthor'};
}

/** The Display for Review choice of a document's view (All Markup unless chosen). */
export const markupView = view => (MARKUP_VIEWS.includes(view?.markup) ? view.markup : 'all');

/** Whether a tracked deletion takes no room with markup shown (hides_deletion). */
export const hidesDeletion = (m, movedFrom) => !m.insertionsDeletions || (movedFrom ? m.moveFromMark : m.deleteMark) === 'hidden';

/**
 * What a Display for Review choice asks of the page view: `layout` (extra layout options),
 * `look` (reviewLook options for the drawing), and which balloons the margin shows.
 */
export function reviewPresentation(view, prefs) {
  const m = markupOf(prefs);
  const mode = markupView(view);
  if (mode === 'noMarkup') return {mode, layout: {hideDeleted: true}, look: {show: false, marks: m, bars: 'none'}, balloons: {comments: false, deletions: false, formatting: false}, markupArea: false};
  if (mode === 'original') return {mode, layout: {hideInserted: true}, look: {show: false, original: true, marks: m, bars: 'none'}, balloons: {comments: false, deletions: false, formatting: false}, markupArea: false};
  if (mode === 'simple') {
    return {mode, layout: {hideDeleted: true}, look: {show: false, plainInsert: true, marks: m, bars: m.changedLines === 'none' ? 'none' : m.changedLines, barColor: SIMPLE_BAR},
      balloons: {comments: m.comments, deletions: false, formatting: false}, markupArea: m.comments};
  }
  const inBalloons = m.balloons === 'revisions';
  const inline = m.balloons === 'inline';
  const hideMarked = {plain: hidesDeletion(m, false), movedFrom: hidesDeletion(m, true)};
  return {mode, layout: {hideMarked, deletionsInBalloons: inBalloons && m.insertionsDeletions}, look: {show: true, marks: m},
    balloons: {comments: m.comments && !inline, deletions: inBalloons && m.insertionsDeletions, formatting: !inline && m.formatting}, markupArea: !inline};
}
