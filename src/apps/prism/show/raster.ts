// A slide as a bitmap, for the transitions (deckcraft renders the old and new slides to textures
// and draws transition frames from them): the slide's SVG (SlideView, the same picture the editor
// draws, minus its prompts) is serialised and drawn to a canvas at the show's pixel size.
// `parts` draws the background with the master's and layout's graphics alone, or the slide's own
// shapes alone over transparency (the transitions that move contents over backgrounds).

import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SlideView, type AnimFrame, type SlideParts} from '../surface/SlideView';

type Any = any;

/** The SVG text of a slide at `width` × `height` pixels. */
export function slideSvg(content: Any, slide: Any, parts: SlideParts, width: number, height: number, anim: AnimFrame | null = null): string {
  const markup = renderToStaticMarkup(createElement(SlideView, {content, slide, parts, anim}));
  return markup.replace(/^<svg /, `<svg width="${Math.round(width)}" height="${Math.round(height)}" `);
}

/** Draw a slide to a canvas `width` × `height` pixels. Resolves with the canvas. */
export async function rasterize(content: Any, slide: Any, parts: SlideParts, width: number, height: number, anim: AnimFrame | null = null): Promise<HTMLCanvasElement> {
  const svg = slideSvg(content, slide, parts, width, height, anim);
  const url = URL.createObjectURL(new Blob([svg], {type: 'image/svg+xml;charset=utf-8'}));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(width));
    c.height = Math.max(1, Math.round(height));
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}
