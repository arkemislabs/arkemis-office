// Slides drawn to PNG, for the host (`renderSlides`): Insert > Zoom puts a picture of each target slide on the slide.
// The slide view's own SVG (surface/SlideView.tsx, no editor prompts) drawn to a canvas by show/raster.ts.

import {rasterize} from '../show/raster';

type Any = any;

/** PNG data URLs of the slides at `indices` of a presentation, each `width` pixels wide. */
export async function slideImages(content: Any, indices: number[], width: number): Promise<string[]> {
  const size = content.slideSize ?? {width: 960, height: 540};
  const height = Math.max(1, Math.round((width * size.height) / Math.max(size.width, 1)));
  const out: string[] = [];
  for (const i of indices) {
    const slide = content.slides?.[i];
    if (!slide) { out.push(''); continue; }
    const canvas = await rasterize(content, slide, 'all', width, height);
    out.push(canvas.toDataURL('image/png'));
  }
  return out;
}
