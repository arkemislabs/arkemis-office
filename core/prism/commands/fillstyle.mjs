// Shape Fill > Texture and Shape Outline > Sketched. PowerPoint's behaviour, not checked against upstream (deckcraft has neither).
//
// - `shape.texture {name}` fills the selected shapes with one of the 24 textures the suite draws (core/quill/lib/textures.mjs): a 128 px tile with no seam,
//   put on the shape as a tiled picture fill (the same fill Format Shape > Fill > Picture or texture fill > Tile picture as texture makes), so it
//   is kept in the file as an ordinary tiled picture.
// - `shape.sketch {style}` draws the selected shapes' outline as if by hand (None, Curved, Freehand, Scribble): the line is the same line,
//   `line.sketch` says how it wobbles (src/apps/prism/surface/SlideView.tsx), and the file keeps it in the line's extension list.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {UPSTREAM_COMMIT, bad, hasSelection, editShapes, lineDefault, applyDeep} from '../lib/shape-common.mjs';
import {TEXTURES, textureInfo, textureBitmap} from '../../quill/lib/textures.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/shape/appearance.rs']};
export const SKETCHES = Object.freeze(['none', 'curved', 'freehand', 'scribble']);
const base64 = bytes => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const IDS = {ids: s.optional(s.array(s.any(), {max: 5000})), id: s.optional(s.any())};

export default defineCommands({
  family: 'fillstyle',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'shape.texture', label: 'Texture', risk: 'edit',
      state: ctx => { const st = hasSelection(ctx); return st.enabled ? {...st, value: TEXTURES.map(([id, label]) => ({id, label, value: id, art: {kind: 'texture', id}, iconOnly: false}))} : st; },
      description: '{name: papyrus|canvas|denim|woven-mat|… (the 24 textures of the suite), ids?}: Shape Fill › Texture: fill the selected shapes with a texture, a tiled picture drawn by the app (nothing is downloaded). Not checked against upstream.',
      params: s.object({name: s.string({max: 32}), ...IDS}),
      async run(ctx, p) {
        const t = textureInfo(p.name);
        if (!t) throw bad('shape.texture', 'unknown texture ' + p.name + ': ' + TEXTURES.map(x => x[0]).join(', '));
        const {encodePng} = await import('../../folio/lib/image-files.mjs');
        const bmp = textureBitmap(t[0], 128);
        const png = await encodePng({width: bmp.width, height: bmp.height, channels: 4, data: bmp.data});
        await ctx.run('shape.fill', {...(p.ids ? {ids: p.ids} : {}), ...(p.id !== undefined ? {id: p.id} : {}), picture: base64(png), name: t[1] + '.png', pictureProps: {tile: true, scaleX: 1, scaleY: 1}});
        return {texture: t[0]};
      },
    },
    {
      id: 'shape.sketch', label: 'Sketched', risk: 'edit', state: hasSelection,
      description: '{style: none|curved|freehand|scribble, ids?}: Shape Outline › Sketched: draw the outline of the selected shapes as if by hand; `none` draws it straight again. Not checked against upstream.',
      params: s.object({style: s.string({max: 12}), ...IDS}),
      run(ctx, p) {
        if (!SKETCHES.includes(p.style)) throw bad('shape.sketch', '`style` is none, curved, freehand or scribble');
        return editShapes(ctx, p, 'shape.sketch', top => applyDeep(top, sh => {
          if (p.style === 'none') { if (sh.line?.sketch) { sh.line = {...sh.line}; delete sh.line.sketch; } return; }
          sh.line = {...(sh.line ?? lineDefault()), sketch: p.style};
        }));
      },
    },
  ],
});
