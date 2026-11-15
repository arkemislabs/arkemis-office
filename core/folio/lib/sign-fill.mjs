// Fill & Sign: typed text and dates, marks, and placing a saved signature or initials.
//
// Translated from printcraft crates/ui-egui/src/tools/fill_sign.rs (FillTool and its commands,
// labels and marks, TEXT_SIZE, valid_text_size, typed, signature_at, place, SigDraft::new
// initials from the name, SavedSig and its graphic, page_input: typed text starts 0.6 em above the
// click as displayed), crates/engine/src/dates.rs (DEFAULT_DATE_FORMAT, DATE_FORMATS and the
// m/d/yyyy pattern language) and crates/engine/src/signature_image.rs (SignatureImage::rect: at
// most 150 pt wide, 32 pt tall for a signature, 24 for initials) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

import {viewMatrixFor} from './geom.mjs';
import {displayedOffset, uprightBox, textBoxRect, markRectAt} from './comment-geometry.mjs';
import {typedSignatureShape, typedHeight, typedSignatureGraphic, MAX_SIGNATURE_CHARS} from './sign-script.mjs';

export const TEXT_SIZE = 10, MIN_TEXT_SIZE = 4, MAX_TEXT_SIZE = 300;
export const validTextSize = v => (Number.isFinite(v) && v >= MIN_TEXT_SIZE && v <= MAX_TEXT_SIZE ? v : null);

/** fill_sign.rs FillTool: command → [label, mark]. */
export const FILL_TOOLS = Object.freeze({
  'sign.fill.text': ['Add text', null], 'sign.fill.check': ['Checkmark', 'Check'], 'sign.fill.cross': ['Cross', 'Cross'], 'sign.fill.dot': ['Dot', 'Dot'],
  'sign.fill.line': ['Line', 'Line'], 'sign.fill.date': ['Date', null], 'sign.fill.signature': ['Sign', null], 'sign.fill.initials': ['Initials', null],
});
/** labels.rs add_annotation for the marks. */
export const MARK_LABELS = Object.freeze({Check: 'Add checkmark', Cross: 'Add cross', Dot: 'Add dot', Line: 'Add line'});

export const DEFAULT_DATE_FORMAT = 'm/d/yyyy';
export const DATE_FORMATS = Object.freeze(['m/d/yyyy', 'mm/dd/yyyy', 'd/m/yyyy', 'dd/mm/yyyy', 'dd.mm.yyyy', 'yyyy-mm-dd', 'yyyy.mm.dd.', 'yyyy/mm/dd', 'yyyy/m/d',
  'd mmm yyyy', 'd mmmm yyyy', 'mmm d, yyyy', 'mmmm d, yyyy', 'dddd, mmmm d, yyyy']);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** dates.rs: a date in a pattern of yyyy / yy, mmmm / mmm / mm / m, dddd / ddd / dd / d (English names). */
export function formatDate(ms, fmt = DEFAULT_DATE_FORMAT) {
  const pattern = String(fmt || DEFAULT_DATE_FORMAT).slice(0, 64);
  const d = new Date(ms);
  const y = d.getFullYear(), mo = d.getMonth(), day = d.getDate(), wd = d.getDay();
  return pattern.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d/g, t => ({
    yyyy: String(y), yy: String(y % 100).padStart(2, '0'), mmmm: MONTHS[mo], mmm: MONTHS[mo].slice(0, 3), mm: String(mo + 1).padStart(2, '0'), m: String(mo + 1),
    dddd: DAYS[wd], ddd: DAYS[wd].slice(0, 3), dd: String(day).padStart(2, '0'), d: String(day),
  })[t]);
}

/** fill_sign.rs page_input: typed text starts a little above the click, as displayed. */
export const typedTop = (rotation, at, size) => displayedOffset(rotation, at, 0, size * 0.6);

/** fill_sign.rs `typed`: a typewriter annotation sized to its text, displayed top-left at `top`. */
export function typedShape(top, text, size, rotation) {
  return {kind: 'Typewriter', rect: textBoxRect(top, text, size, rotation), fontSize: size};
}

/** types.rs FillMark::rect_at. */
export const markShape = (mark, at, rotation) => ({kind: 'Mark', mark, rect: markRectAt(mark, at, rotation)});

/** fill_sign.rs SigDraft::new: initials are the first letters of the name's words. */
export const initialsOf = name => String(name ?? '').split(/\s+/).filter(Boolean).map(w => Array.from(w)[0]).join('');

/**
 * fill_sign.rs `signature_at`: drawn strokes (normalised 0–1 across, y up, in units of the pad's
 * width) placed with the displayed left edge at `at`, 150 pt wide, upright on a turned page.
 */
export function signatureShape(at, strokes, rotation) {
  const w = 150;
  const all = strokes.flat();
  if (!all.length) return null;
  const minY = Math.min(...all.map(p => p[1])), maxY = Math.max(...all.map(p => p[1]));
  const h = Math.max(maxY - minY, 0.05) * w;
  const [a, b, c, d] = viewMatrixFor(rotation, [0, 0, 0, 0]);
  const out = strokes.filter(s => s.length).map(s => s.map(p => {
    const dx = p[0] * w, dy = (p[1] - minY) * w - h / 2;
    return [at[0] + a * dx + c * dy, at[1] + b * dx + d * dy];
  }));
  return out.length ? {kind: 'Signature', strokes: out} : null;
}

/** signature_image.rs SignatureImage::rect: the picture's box, at most 150 pt wide and 32 (24 for initials) tall. */
export function imageRect(rotation, at, width, height, initials) {
  if (!at.every(Number.isFinite) || !(width > 0 && height > 0)) return null;
  const scale = Math.min(150 / width, (initials ? 24 : 32) / height);
  return uprightBox(rotation, at, width * scale, height * scale);
}

/** A saved signature as the person keeps it (prefs.fillSign.signature / .initials), validated. */
export function savedSig(v) {
  if (!v || typeof v !== 'object') return null;
  if (typeof v.typed === 'string' && v.typed.trim() && Array.from(v.typed).length <= MAX_SIGNATURE_CHARS) return {typed: v.typed.trim()};
  if (Array.isArray(v.drawn) && v.drawn.some(s => Array.isArray(s) && s.length > 1)) return {drawn: v.drawn.map(s => s.filter(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))};
  if (typeof v.image === 'string' && v.image.length) return {image: v.image, width: v.width, height: v.height};
  return null;
}

/** fill_sign.rs SavedSig::graphic: the saved signature as a visible digital signature's graphic. */
export function savedGraphic(sig) {
  if (!sig) return null;
  if (sig.drawn) return {strokes: sig.drawn};
  if (sig.typed) return typedSignatureGraphic(sig.typed);
  if (sig.image) return {encoded: Uint8Array.from(globalThis.atob(sig.image), c => c.charCodeAt(0))};
  return null;
}

/** fill_sign.rs `place` for a typed signature: the shape at `at`. */
export const typedPlacement = (at, text, rotation, initials) => typedSignatureShape(at, text, typedHeight(text, initials), rotation);
