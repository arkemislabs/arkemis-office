// What a pointer gesture on a page makes for each comment, stamp, Fill & Sign and signing tool:
// the page view (F:folio surface) asks `gestureFor(tool)` how to collect the gesture and turns
// what was collected into the command call with `callFor`.
//
// Translated from printcraft crates/ui-egui/src/tools/comments/input.rs (Gestures::draw_shape,
// click_points, callout, attach, caret, note_or_box: which gesture each tool takes, a drag of a
// few pixels being a click, Enter / double-click finishing connected lines, clicking the first
// point closing a polygon), crates/ui-egui/src/tools/comments/composer.rs (which ones then ask for
// text: note, text box, callout, insert text, replacement text), crates/ui-egui/src/tools/
// fill_sign.rs (page_input: Fill & Sign tools act on a click; Add text opens a type box),
// crates/ui-egui/src/tools/stamps_ui.rs (a click places the picked stamp) and
// crates/ui-egui/src/tools/sign_ui.rs (page_input: drag the signature area, then the Sign with a
// Digital ID dialog) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// Points are page view points (top-left origin), as every command here takes them.

/** input.rs: a drag shorter than this many view points is a click. */
export const CLICK_SLOP = 6;
/** input.rs click_points: clicking within this distance of the first point closes a polygon. */
export const CLOSE_DISTANCE = 6;

/**
 * How `tool` collects its gesture:
 *   kind 'click'   one click (`at`)
 *   kind 'drag'    press, drag, release: two points (a click when shorter than CLICK_SLOP)
 *   kind 'stroke'  press, drag along a path, release: every point (the eraser)
 *   kind 'points'  clicks add points; double-click or Enter finishes; `closes` when clicking the first point ends it
 *   composer       the text box that opens after the gesture: its placeholder, or null for none
 * Returns null for tools that are not page gestures here.
 */
export function gestureFor(tool) {
  switch (tool) {
    case 'comment.note': return {kind: 'click', composer: 'Add a comment', cursor: 'crosshair'};
    case 'comment.freetext': return {kind: 'drag', clickOk: true, composer: 'Type text', cursor: 'crosshair'};
    case 'comment.callout': return {kind: 'drag', clickOk: false, composer: 'Type text', cursor: 'crosshair'};
    case 'comment.caret': return {kind: 'click', composer: 'Text to insert', cursor: 'text'};
    case 'comment.attach': return {kind: 'click', composer: null, cursor: 'crosshair'};
    case 'comment.line': case 'comment.arrow': case 'comment.square': case 'comment.circle': return {kind: 'drag', clickOk: false, composer: null, cursor: 'crosshair'};
    case 'comment.polygon': case 'comment.cloud': return {kind: 'points', closes: true, min: 3, composer: null, cursor: 'crosshair'};
    case 'comment.polyline': return {kind: 'points', closes: false, min: 2, composer: null, cursor: 'crosshair'};
    case 'comment.eraser': return {kind: 'stroke', composer: null, cursor: 'cell'};
    case 'comment.stamp': return {kind: 'click', composer: null, cursor: 'copy'};
    case 'sign.fill.text': return {kind: 'click', composer: 'Type text', cursor: 'text'};
    case 'sign.fill.check': case 'sign.fill.cross': case 'sign.fill.dot': case 'sign.fill.line': case 'sign.fill.date':
    case 'sign.fill.signature': case 'sign.fill.initials': return {kind: 'click', composer: null, cursor: 'crosshair'};
    case 'sign.digital': case 'sign.certify': return {kind: 'drag', clickOk: false, composer: null, cursor: 'crosshair', dialog: 'dialog.sign-digital-id'};
    default: return null;
  }
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * The command call for a finished gesture on page `page` (id): `points` collected (view points),
 * `text` from the composer (when it has one), and the view's state (`stamp` picked in the palette).
 * Returns {command, params} or {dialog, init} (signing), or null when the gesture makes nothing
 * (a slip, an empty composer).
 */
export function callFor(tool, page, points, {text = null, view = {}} = {}) {
  const g = gestureFor(tool);
  if (!g || !points?.length) return null;
  const first = points[0], last = points[points.length - 1];
  const drag = points.length > 1 && dist(first, last) >= CLICK_SLOP;
  if (g.composer && !(text ?? '').trim()) return null;
  switch (tool) {
    case 'comment.note': return {command: tool, params: {page, at: first, text}};
    case 'comment.freetext': return {command: tool, params: drag
      ? {page, rect: [Math.min(first[0], last[0]), Math.min(first[1], last[1]), Math.abs(last[0] - first[0]), Math.abs(last[1] - first[1])], text}
      : {page, at: first, text}};
    case 'comment.callout': return dist(first, last) >= 8 ? {command: tool, params: {page, point: first, at: last, text}} : null;
    case 'comment.caret': return {command: tool, params: {page, at: first, text}};
    case 'comment.attach': return {command: tool, params: {page, at: first}};
    case 'comment.line': case 'comment.arrow': case 'comment.square': case 'comment.circle':
      return drag ? {command: tool, params: {page, points: [first, last]}} : null;
    case 'comment.polygon': case 'comment.cloud': case 'comment.polyline':
      return points.length >= g.min ? {command: tool, params: {page, points}} : null;
    case 'comment.eraser': return {command: tool, params: {page, path: points}};
    case 'comment.stamp': return view.stamp ? {command: tool, params: (view.stamp.startsWith?.('c') && !/^[A-Z]/.test(view.stamp)) ? {page, at: first, custom: view.stamp} : {page, at: first, stamp: view.stamp}} : null;
    case 'sign.fill.text': return {command: tool, params: {page, at: first, text}};
    case 'sign.digital': case 'sign.certify': {
      if (!drag) return null;
      const rect = [Math.min(first[0], last[0]), Math.min(first[1], last[1]), Math.abs(last[0] - first[0]), Math.abs(last[1] - first[1])];
      return {dialog: 'dialog.sign-digital-id', init: {page, rect, certify: tool === 'sign.certify' ? 2 : null}};
    }
    default: return {command: tool, params: {page, at: first}};
  }
}

/** input.rs click_points: whether a click at `p` closes the polygon being drawn. */
export const closesPolygon = (tool, points, p) => !!gestureFor(tool)?.closes && points.length >= 3 && dist(points[0], p) <= CLOSE_DISTANCE;
