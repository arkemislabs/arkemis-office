// The colour of a slide as the app draws it, at one point: the Eyedropper and Set Transparent Color read it here, never from the screen.
// The slide is the slide view's own SVG (no editor prompts) drawn to a canvas by show/raster.ts at one pixel a point, as deckcraft's
// `slide.colorAt` reads the colour of its own render (crates/ui-egui/src/eyedropper.rs).

import {rasterize} from '../show/raster';
import {currentSlideId, slideById} from '../../../../core/prism/model/doc.mjs';

type Any = any;

/** `#RRGGBB` of the slide at (`x`, `y`) points from its top left; null outside the slide. Transparent pixels read as the white of the page. */
export async function colorAt(content: Any, slide: Any, x: number, y: number): Promise<string | null> {
  const size = content.slideSize ?? {width: 960, height: 540};
  if (!(x >= 0 && y >= 0 && x < size.width && y < size.height)) return null;
  const canvas = await rasterize(content, slide, 'all', Math.round(size.width), Math.round(size.height));
  const g = canvas.getContext('2d');
  if (!g) return null;
  const d = g.getImageData(Math.min(canvas.width - 1, Math.max(0, Math.round(x))), Math.min(canvas.height - 1, Math.max(0, Math.round(y))), 1, 1).data;
  const a = d[3] / 255;
  const mix = (v: number) => Math.round(v * a + 255 * (1 - a));
  return `#${[mix(d[0]), mix(d[1]), mix(d[2])].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** What the pointer tools asked for (`ui: [{pickColor: {target, x, y}}]` of a gesture): the colour under the click, applied by the Eyedropper's own command. */
export async function applyPicks(controller: Any, docId: string, ui: Any[] | undefined): Promise<void> {
  for (const u of ui ?? []) {
    const req = u?.pickColor;
    if (!req) continue;
    const d = controller.session.get(docId);
    const slide = slideById(d.file.content, currentSlideId(d.file.content, d.selection));
    if (!slide) continue;
    const color = await colorAt(d.file.content, slide, req.x, req.y);
    if (!color) { controller.notify?.('Pick a colour on the slide', 'info'); continue; }
    if (req.target === 'transparent') await controller.run('tool.transparentColor', {color}, {origin: 'ui'});
    else await controller.run('tool.eyedropper', {target: req.target, color}, {origin: 'ui'});
  }
}
