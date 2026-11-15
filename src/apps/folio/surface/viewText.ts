// The text set the page view draws a comment's appearance with: the browser's own fonts, measured on a scratch canvas (core/folio/lib/browser-text.mjs). A comment in Cyrillic,
// Devanagari, Arabic, Chinese... looks on screen as it does in the saved file, where a system font is embedded for it.
import {browserText, browserCss} from '../../../../core/folio/lib/browser-text.mjs';

let scratch: CanvasRenderingContext2D | null | undefined;
const measure = (text: string, size: number, style: {bold?: boolean; italic?: boolean}): number => {
  if (scratch === undefined) scratch = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!scratch) return [...text].length * size * 0.6;
  scratch.font = browserCss(style, size);
  return scratch.measureText(text).width;
};

/** One text set for every appearance the view draws (it only remembers which pseudo fonts it has named). */
export const viewText = browserText(measure);
