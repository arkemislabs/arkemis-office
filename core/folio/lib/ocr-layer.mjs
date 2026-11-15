// Scan & OCR ▸ Recognize Text: recognised words placed in user space and written as an invisible
// text layer (Acrobat's "Searchable Image (Exact)": the page image is left untouched).
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt):
//  * crates/ocr/src/lib.rs — PlacedWord::place, BOX_EM / DESCENT / CAP_HEIGHT / X_HEIGHT,
//    ink_extent, num, text_layer (/OCR BMC, q, 3 Tr, /PCHelv 1 Tf, one Tm per word, Q, EMC),
//    LANGUAGES;
//  * crates/engine/src/ocr.rs — OcrSettings (300 dpi, skip pages with text), covered,
//    ALREADY_ON_PAGE (a word mostly covered by the page's own text is not added again);
//  * crates/engine/src/edit/run.rs:526 — AddOcrText stamps the layer on the page tagged "OCR".
// Recognition itself (pixels → words) is the host's OCR worker (Tesseract; printcraft uses ocrs):
// words arrive in page view points, top-left origin. No DOM, no Node built-ins.

import {textWidth, literal, winAnsiBytes} from './fonts.mjs';

export const LANGUAGES = Object.freeze([['en', 'English']]);
export const ALREADY_ON_PAGE = 0.5;
const BOX_EM = 0.93, DESCENT = 0.21, CAP_HEIGHT = 0.718, X_HEIGHT = 0.523;

/** OcrSettings::default. */
export const defaultOcrSettings = () => ({dpi: 300, language: 'en', skipTextPages: true});

/** PlacedWord::place: a word box [l, t, r, b] (y down) placed through `toUser`. */
export function placeWord(text, [l, t, r, b], toUser) {
  const o = toUser(l, b), br = toUser(r, b), tl = toUser(l, t);
  return {text, origin: o, across: [br[0] - o[0], br[1] - o[1]], up: [tl[0] - o[0], tl[1] - o[1]]};
}

/** ocr `ink_extent`: how far a word's ink reaches above and below the baseline (em fractions). */
export function inkExtent(text) {
  if (![...text].some(c => /[\p{L}\p{N}]/u.test(c))) return [BOX_EM - DESCENT, -DESCENT];
  const tall = [...text].some(c => (c !== c.toLowerCase() && c === c.toUpperCase()) || /[0-9]/.test(c) || 'bdfhijklt!?/\\()[]{}|\'"#$%&@'.includes(c) || (/\p{L}/u.test(c) && c.charCodeAt(0) > 127));
  const low = [...text].some(c => 'gjpqy()[]{}|_'.includes(c));
  return [tall ? CAP_HEIGHT : X_HEIGHT, low ? -DESCENT : 0];
}

/** ocr `num`: four decimals, no trailing zeros. */
export function num(v) {
  let s = (Math.abs(v) < 1e-9 ? 0 : v).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** ocr `text_layer`: invisible text fitted to each word's box, inside q … Q and /OCR marked content. */
export function textLayer(words) {
  let out = '/OCR BMC\nq\nBT\n3 Tr\n/PCHelv 1 Tf\n';
  for (const w of words) {
    const width = textWidth(w.text, 1);
    const height = Math.hypot(w.up[0], w.up[1]);
    if (width <= 0 || height <= 0) continue;
    const [top, bottom] = inkExtent(w.text);
    const em = [w.up[0] / (top - bottom), w.up[1] / (top - bottom)];
    const ax = [w.across[0] / width, w.across[1] / width];
    const o = [w.origin[0] - em[0] * bottom, w.origin[1] - em[1] * bottom];
    out += `${[ax[0], ax[1], em[0], em[1], o[0], o[1]].map(num).join(' ')} Tm ${literal(winAnsiBytes(w.text))} Tj\n`;
  }
  return out + 'ET\nQ\nEMC\n';
}

/** engine ocr.rs `covered`: how much of `word` the text boxes cover, 0–1 (view space boxes). */
export function covered(word, text) {
  const area = ([x0, y0, x1, y1]) => Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const total = area(word);
  if (!Number.isFinite(total) || total <= 0) return 0;
  let inside = 0;
  for (const g of text) {
    const a = area([Math.max(word[0], g[0]), Math.max(word[1], g[1]), Math.min(word[2], g[2]), Math.min(word[3], g[3])]);
    if (Number.isFinite(a)) inside += a;
  }
  return Math.min(1, inside / total);
}
