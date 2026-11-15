// Design › Page Background › Page Color › Fill Effects (U:quill/rest): a page background that is a gradient, a texture, a pattern or a picture.
//
// Not checked against upstream (wordcraft keeps a page picture it reads from a file and has no way to make one); follows Word. The background is
// made as a bitmap (core/quill/lib/page-fill.mjs, core/quill/lib/textures.mjs) and kept as the document's page picture, saved as w:background with
// v:fill (a gradient and a pattern are saved as pictures, not as Word's own gradient and pattern fills): `frame` stretched over the page (gradient,
// picture) or `tile` repeated (texture, pattern). A plain Page Color keeps what it is; choosing one takes the picture off.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/table-session.mjs';
import {parseRgb} from '../model/props.mjs';
import {bytesOf, base64Encode, imageExt, probe} from '../lib/insert-objects.mjs';
import {encodePng} from '../lib/picture-host.mjs';
import {textureBitmap, textureInfo} from '../lib/textures.mjs';
import {GRADIENT_STYLES, PATTERNS, gradientBitmap, patternBitmap} from '../lib/page-fill.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/doc/src/settings.rs']};
const bad = m => new CommandError('invalid_params', m);
const color = (v, dflt, what) => { if (v === undefined || v === null) return dflt; const c = parseRgb(v); if (!c) throw bad(`\`${what}\` is RRGGBB`); return c; };

async function pageFill(ctx, p) {
  const kind = p.kind ?? (p.texture ? 'texture' : p.pattern ? 'pattern' : p.data || p.path ? 'picture' : 'gradient');
  let media = null, fillType = 'frame', title = '', bytes = null, ext = 'png';
  if (kind === 'none') { /* no picture */ } else if (kind === 'gradient') {
    if (p.style !== undefined && !GRADIENT_STYLES.includes(p.style)) throw bad('`style` is ' + GRADIENT_STYLES.join(', '));
    bytes = await encodePng(ctx.host, gradientBitmap(color(p.color1, [255, 255, 255], 'color1'), color(p.color2, [0, 112, 192], 'color2'), p.style ?? 'horizontal', p.variant ?? 1));
    title = 'Gradient';
  } else if (kind === 'texture') {
    const info = textureInfo(p.texture);
    if (!info) throw bad('unknown texture `' + p.texture + '`');
    bytes = await encodePng(ctx.host, textureBitmap(info[0], 64));
    fillType = 'tile';
    title = info[1];
  } else if (kind === 'pattern') {
    const b = patternBitmap(p.pattern, color(p.fg, [0, 0, 0], 'fg'), color(p.bg, [255, 255, 255], 'bg'));
    if (!b) throw bad('unknown pattern `' + p.pattern + '`: ' + PATTERNS.map(x => x[0]).join(', '));
    bytes = await encodePng(ctx.host, b);
    fillType = 'tile';
    title = PATTERNS.find(x => x[0] === p.pattern)[1];
  } else if (kind === 'picture') {
    if (typeof p.data === 'string') { bytes = bytesOf(p.data); if (!bytes) throw bad('bad base64 data'); }
    else if (typeof p.path === 'string' && typeof ctx.host?.readFile === 'function') { const got = await ctx.host.readFile(p.path); bytes = typeof got === 'string' ? bytesOf(got) : new Uint8Array(got); }
    else throw bad('`data` (base64) is required: Picture… picks the file in the window');
    const got = probe(bytes);
    if (got.notPicture) throw new CommandError('failed', 'not a supported image');
    if (got.refused) throw new CommandError('failed', got.refused);
    ext = imageExt(bytes);
    title = 'Picture';
  } else throw bad('`kind` is gradient, texture, pattern, picture or none');
  const S = T.open(ctx);
  if (bytes) media = S.d.addMedia(base64Encode(bytes), ext);
  S.d.updateField('settings', x => { x.pagePicture = media ? {media, fillType, title} : null; });
  return T.finish(S, {kind, fillType: media ? fillType : null});
}

export default defineCommands({
  family: 'design_rest',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'design.pageFill', label: 'Fill Effects', risk: 'edit', state: T.ready, dialog: 'dialog.fillEffects',
      description: 'Fill Effects (Design › Page Color): the page background as `kind` gradient (`color1`, `color2` RRGGBB, `style` horizontal, vertical, diagonalUp, diagonalDown, fromCorner or fromCenter, `variant` 1 to 4), texture (`texture`, one of the 24 of Shape Fill), pattern (`pattern`, `fg`, `bg`) or picture (`data` base64), or `none` for no picture. Not checked against upstream.',
      params: s.object({kind: s.optional(s.enum(['gradient', 'texture', 'pattern', 'picture', 'none'])), color1: s.optional(s.string({max: 16})), color2: s.optional(s.string({max: 16})), style: s.optional(s.string({max: 32})),
        variant: s.optional(s.integer({min: 1, max: 4})), texture: s.optional(s.string({max: 40})), pattern: s.optional(s.string({max: 40})), fg: s.optional(s.string({max: 16})), bg: s.optional(s.string({max: 16})),
        data: s.optional(s.string({max: 300_000_000})), path: s.optional(s.string({max: 4096}))}),
      run: pageFill},
  ],
});
