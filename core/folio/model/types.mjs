// Comment kinds, styles and flags.
//
// Translated from printcraft crates/annot/src/types.rs (Markup, NoteIcon, LineEnding, AttachIcon,
// StampKind, Style::default_for, the annotation flags, NOTE_SIZE) and crates/annot/src/info.rs
// (is_comment_subtype) and crates/ui-egui/src/tools/comments.rs (SWATCHES, CommentTool, tool_for)
// at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A shape (types.rs `Shape`) is a plain object `{kind, ...}`: `{kind:'TextMarkup', markup, quads}`,
// `{kind:'Ink', strokes, highlighter?}`, `{kind:'Rectangle', rect}`, ... with the fields upstream names.
// No DOM, no Node built-ins.

/** Text markup kinds (§12.5.6.10) → subtype. */
export const MARKUP = Object.freeze({Highlight: 'Highlight', Underline: 'Underline', StrikeOut: 'StrikeOut', Squiggly: 'Squiggly'});

export const NOTE_ICONS = Object.freeze(['Comment', 'Note', 'Help', 'Insert', 'Key', 'NewParagraph', 'Paragraph', 'Check', 'Circle', 'Cross',
  'CrossHairs', 'Star', 'RightArrow', 'UpArrow']);
export const LINE_ENDINGS = Object.freeze(['None', 'Square', 'Circle', 'Diamond', 'OpenArrow', 'ClosedArrow', 'Butt', 'ROpenArrow', 'RClosedArrow', 'Slash']);
export const ATTACH_ICONS = Object.freeze(['PushPin', 'Paperclip', 'Graph', 'Tag']);
export const REVIEW_STATES = Object.freeze(['None', 'Accepted', 'Rejected', 'Cancelled', 'Completed']);

/** Annotation flags (§12.5.3). */
export const FLAG = Object.freeze({HIDDEN: 2, PRINT: 4, NO_ZOOM: 8, NO_ROTATE: 16, NO_VIEW: 32, LOCKED: 128});

/** Size of a note icon (points, unscaled by zoom). */
export const NOTE_SIZE = 20;

/** types.rs `StampKind`: [kind, label, /Name, group, colour]. */
const G = {D: 'Dynamic', S: 'SignHere', B: 'StandardBusiness'};
const GREEN = [0.13, 0.55, 0.13], RED = [0.80, 0.10, 0.10], ORANGE = [0.85, 0.35, 0.05], BLUE = [0.10, 0.30, 0.70];
export const STAMPS = Object.freeze([
  ['DynApproved', 'APPROVED', 'PCDynApproved', G.D, GREEN], ['DynConfidential', 'CONFIDENTIAL', 'PCDynConfidential', G.D, RED],
  ['DynReceived', 'RECEIVED', 'PCDynReceived', G.D, GREEN], ['DynReviewed', 'REVIEWED', 'PCDynReviewed', G.D, GREEN],
  ['DynRevised', 'REVISED', 'PCDynRevised', G.D, BLUE],
  ['Accepted', 'ACCEPTED', 'PCAccepted', G.S, GREEN], ['InitialHere', 'INITIAL HERE', 'PCInitialHere', G.S, ORANGE],
  ['Rejected', 'REJECTED', 'PCRejected', G.S, RED], ['SignHere', 'SIGN HERE', 'PCSignHere', G.S, ORANGE], ['Witness', 'WITNESS', 'PCWitness', G.S, ORANGE],
  ['Approved', 'APPROVED', 'Approved', G.B, GREEN], ['Completed', 'COMPLETED', 'PCCompleted', G.B, GREEN],
  ['Confidential', 'CONFIDENTIAL', 'Confidential', G.B, RED], ['Draft', 'DRAFT', 'Draft', G.B, BLUE], ['Final', 'FINAL', 'Final', G.B, GREEN],
  ['ForComment', 'FOR COMMENT', 'ForComment', G.B, BLUE], ['ForPublicRelease', 'FOR PUBLIC RELEASE', 'ForPublicRelease', G.B, BLUE],
  ['InformationOnly', 'INFORMATION ONLY', 'PCInformationOnly', G.B, BLUE], ['NotApproved', 'NOT APPROVED', 'NotApproved', G.B, RED],
  ['NotForPublicRelease', 'NOT FOR PUBLIC RELEASE', 'NotForPublicRelease', G.B, RED],
  ['PreliminaryResults', 'PRELIMINARY RESULTS', 'PCPreliminaryResults', G.B, BLUE], ['Void', 'VOID', 'PCVoid', G.B, RED],
].map(([kind, label, pdfName, group, color]) => Object.freeze({kind, label, name: pdfName, group, color})));
export const stampByName = n => STAMPS.find(s => s.name === n) ?? null;

/** Fill & Sign marks: /Name of the stamp PdfCraft draws and the label. */
export const FILL_MARKS = Object.freeze({Check: ['PCCheck', 'Checkmark'], Cross: ['PCCross', 'Cross'], Dot: ['PCDot', 'Dot'], Line: ['PCLine', 'Line']});

/** types.rs `Shape::subtype`. */
export function subtypeOf(shape) {
  switch (shape.kind) {
    case 'Note': return 'Text';
    case 'TextMarkup': return MARKUP[shape.markup] ?? 'Highlight';
    case 'Rectangle': return 'Square';
    case 'Oval': return 'Circle';
    case 'Line': return 'Line';
    case 'Ink': case 'Signature': return 'Ink';
    case 'TextBox': case 'Typewriter': case 'Callout': return 'FreeText';
    case 'Mark': case 'Stamp': case 'CustomStamp': case 'TypedSignature': return 'Stamp';
    case 'Redact': return 'Redact';
    case 'Polygon': return 'Polygon';
    case 'PolyLine': return 'PolyLine';
    case 'Caret': return 'Caret';
    case 'Attachment': return 'FileAttachment';
    default: return null;
  }
}

/**
 * types.rs `Style::default_for`: the default look of each commenting tool.
 * The highlighter pen (an Arkemis tool, drawn like Acrobat's highlighter: Ink with Multiply
 * blending, a fixed broad nib) takes the highlight colour and a 12 pt nib.
 */
export function defaultStyle(shape) {
  const s = (color, width, fill = null) => ({color, opacity: 1, width, fill});
  switch (shape.kind) {
    case 'Note': return s([1, 0.82, 0], 1);
    case 'TextMarkup':
      return s({Highlight: [1, 0.94, 0], Underline: [0, 0.47, 0.84], StrikeOut: [0.89, 0.13, 0.13], Squiggly: [0.18, 0.62, 0.36]}[shape.markup] ?? [1, 0.94, 0], 1);
    case 'Rectangle': case 'Oval': case 'Line': case 'Polygon': case 'PolyLine': return s([0.89, 0.13, 0.13], 2);
    case 'Callout': return s([0, 0, 0], 1);
    case 'Caret': case 'Attachment': return s([0, 0.47, 0.84], 1);
    case 'Ink': return shape.highlighter ? s([1, 0.94, 0], HIGHLIGHTER_WIDTH) : s([0, 0.4, 0.87], 2);
    case 'TextBox': case 'Typewriter': return s([0, 0, 0], 0);
    case 'Mark': return s([0, 0, 0], 1.5);
    case 'Signature': return s([0, 0, 0], 1.5);
    case 'Stamp': return s(stampByName(shape.stamp)?.color ?? BLUE, 2);
    case 'CustomStamp': case 'TypedSignature': return s([0, 0, 0], 0);
    case 'Redact': return {color: [0.89, 0.13, 0.13], opacity: 1, width: 1, fill: [0, 0, 0]};
    default: return s([1, 0.82, 0], 1);
  }
}

/** The highlighter pen's nib: fixed, pressure-insensitive (points). */
export const HIGHLIGHTER_WIDTH = 12;
/** The Arkemis private key marking an Ink comment as a highlighter stroke (drawn with Multiply). */
export const HIGHLIGHTER_KEY = 'AKHighlighter';

/** info.rs `is_comment_subtype`. */
export const isCommentSubtype = subtype => !['Link', 'Widget', 'Popup', 'Screen', 'Movie', 'RichMedia', '3D', 'PrinterMark', 'TrapNet', 'Watermark'].includes(subtype);

/** comments.rs `SWATCHES`: the comment colour swatches. */
export const SWATCHES = Object.freeze([
  ['Yellow', [1, 0.94, 0]], ['Orange', [1, 0.54, 0]], ['Red', [0.89, 0.13, 0.13]], ['Pink', [1, 0.37, 0.64]], ['Purple', [0.54, 0.25, 0.82]],
  ['Blue', [0, 0.47, 0.84]], ['Light blue', [0.36, 0.75, 0.98]], ['Green', [0.18, 0.62, 0.36]], ['Gray', [0.5, 0.5, 0.5]], ['Black', [0, 0, 0]],
]);

/** create.rs `subject`: Acrobat's /Subj for each tool. */
export function subjectOf(shape) {
  switch (shape.kind) {
    case 'Note': return 'Sticky Note';
    case 'TextMarkup': return {Highlight: 'Highlight', Underline: 'Underline', StrikeOut: 'Strikethrough', Squiggly: 'Squiggly'}[shape.markup] ?? 'Highlight';
    case 'Rectangle': return 'Rectangle';
    case 'Oval': return 'Oval';
    case 'Line': return shape.start === 'None' && shape.end === 'OpenArrow' ? 'Arrow' : 'Line';
    case 'Ink': return shape.highlighter ? 'Highlighter' : 'Pencil';
    case 'TextBox': return 'Text Box';
    case 'Typewriter': return 'Typewriter';
    case 'Mark': return FILL_MARKS[shape.mark]?.[1] ?? 'Mark';
    case 'Signature': case 'TypedSignature': return 'Signature';
    case 'Redact': return 'Redact';
    case 'Stamp': { const g = stampByName(shape.stamp)?.group; return g === G.D ? 'Dynamic stamp' : g === G.S ? 'Sign Here' : 'Stamp'; }
    case 'CustomStamp': return 'Stamp';
    case 'Polygon': return shape.cloud ? 'Cloud' : 'Polygon';
    case 'PolyLine': return 'Polygonal Line';
    case 'Callout': return 'Callout';
    case 'Caret': return 'Inserted Text';
    case 'Attachment': return 'File Attachment';
    default: return 'Comment';
  }
}

/** comments.rs `tool_for`: the comment tool whose command makes comments like this dictionary. */
export function toolFor(subtype, intent, highlighter = false) {
  switch (subtype) {
    case 'Text': return 'comment.note';
    case 'FreeText': return intent === 'FreeTextCallout' ? 'comment.callout' : intent === 'FreeTextTypeWriter' ? null : 'comment.freetext';
    case 'Highlight': return 'comment.highlight';
    case 'Underline': return 'comment.underline';
    case 'StrikeOut': return intent === 'StrikeOutTextEdit' ? 'comment.replace' : 'comment.strikeout';
    case 'Squiggly': return 'comment.squiggly';
    case 'Ink': return highlighter ? 'comment.ink' : 'comment.ink';
    case 'Line': return 'comment.line';
    case 'Square': return 'comment.square';
    case 'Circle': return 'comment.circle';
    case 'Polygon': return intent === 'PolygonCloud' ? 'comment.cloud' : 'comment.polygon';
    case 'PolyLine': return 'comment.polyline';
    case 'Caret': return 'comment.caret';
    case 'FileAttachment': return 'comment.attach';
    default: return null;
  }
}
