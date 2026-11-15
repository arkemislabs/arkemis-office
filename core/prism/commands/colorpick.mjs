// The Eyedropper (Font Color › Eyedropper) and Set Transparent Color (Picture Format › Color): pick a colour from the slide as the app
// draws it, never from the screen.
//
// deckcraft (crates/ui-egui/src/eyedropper.rs, crates/engine/src/cmd/file.rs `color_at`) arms a pointer mode whose click asks for the
// colour of the rendered slide under the pointer. Here `tool.eyedropper {target}` arms it (`view.tool = {kind: 'eyedropper', target}`), the
// next click on the slide reaches the pointer tools (core/prism/lib/pointer.mjs), which ask the surface for the colour under it; the
// surface draws the slide with its own renderer (src/apps/prism/lib/colorAt.ts) and answers with the same command given `color`:
//   - target `text` sets the font colour of the selected text (format.color), `fill` the shape fill, `outline` the shape outline;
//   - `tool.transparentColor` makes that colour of the selected picture transparent (picture.transparentColor).
// A colour given in `color` is applied at once (the bridge and the tests do this). Set Transparent Color is PowerPoint's: not checked against upstream.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {bad, hasSlide, UPSTREAM_COMMIT} from '../lib/text-session.mjs';
import {isSchema2} from '../model/doc.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/ui-egui/src/eyedropper.rs', 'crates/engine/src/cmd/file.rs']};
const TARGETS = ['text', 'fill', 'outline'];
const HEX = /^#?[0-9a-fA-F]{6}$/;
const armed = ctx => (ctx.view?.tool?.kind === 'eyedropper' ? ctx.view.tool : null);
const norm = c => `#${String(c).replace(/^#/, '').toUpperCase()}`;

export default defineCommands({
  family: 'colorpick',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'tool.eyedropper', label: 'Eyedropper', risk: 'edit',
      description: '{target?: text|fill|outline, color?: #RRGGBB}: Eyedropper: without `color` the next click on the slide picks the colour of the slide as drawn under it and applies it as the font colour (text, the default), shape fill or shape outline of the selection; with `color` it is applied at once.',
      params: s.object({target: s.optional(s.enum(TARGETS)), color: s.optional(s.string({max: 16}))}),
      state(ctx, p) {
        const st = hasSlide(ctx);
        if (!st.enabled) return st;
        const t = armed(ctx);
        return {enabled: true, checked: !!t && (!p?.target || t.target === p.target)};
      },
      async run(ctx, p) {
        if (!isSchema2(ctx.doc)) throw bad('tool.eyedropper', 'needs a presentation (schema 2)');
        const target = p.target ?? 'text';
        if (p.color === undefined) {
          const was = armed(ctx);
          ctx.setView({tool: was && was.target === target ? null : {kind: 'eyedropper', target}, toolDrag: null});
          return {armed: !(was && was.target === target), target};
        }
        if (!HEX.test(p.color)) throw bad('tool.eyedropper', '`color` is #RRGGBB');
        const color = norm(p.color);
        ctx.setView({tool: null, toolDrag: null});
        await ctx.run(target === 'text' ? 'format.color' : target === 'fill' ? 'shape.fill' : 'shape.line', {color});
        return {color, target};
      },
    },
    {
      id: 'tool.transparentColor', label: 'Set Transparent Color', risk: 'edit',
      description: '{color?: #RRGGBB, none?: true}: Set Transparent Color (Picture Format › Color): without `color` the next click on the slide picks the colour of the slide as drawn under it and makes that colour of the selected picture transparent; with `color` it is set at once, `none` brings the colour back.',
      params: s.object({color: s.optional(s.string({max: 16})), none: s.optional(s.boolean())}),
      state(ctx) {
        const st = hasSlide(ctx);
        if (!st.enabled) return st;
        const t = armed(ctx);
        return {enabled: true, checked: !!t && t.target === 'transparent'};
      },
      async run(ctx, p) {
        if (!isSchema2(ctx.doc)) throw bad('tool.transparentColor', 'needs a presentation (schema 2)');
        if (p.color === undefined && p.none !== true) {
          const was = armed(ctx);
          ctx.setView({tool: was?.target === 'transparent' ? null : {kind: 'eyedropper', target: 'transparent'}, toolDrag: null});
          return {armed: was?.target !== 'transparent'};
        }
        ctx.setView({tool: null, toolDrag: null});
        await ctx.run('picture.transparentColor', p.none === true ? {none: true} : {color: norm(p.color)});
        return {};
      },
    },
  ],
});
