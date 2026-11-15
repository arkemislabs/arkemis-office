// Fonts the person added (Home › Font): `font.list`.
// Translated from wordcraft crates/engine/src/cmd/font.rs (`list`, `font_json`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Arkemis reads fonts through the host (`host.fonts()`: the installed families the main process
// enumerates, core/installed-fonts.cjs). Adding or removing a font file (`font.add`, `font.remove`)
// needs a main-process font store the host does not offer yet, and `font.loadSystem` (the web
// shell's Local Font Access prompt) has nothing to do on the desktop, where installed fonts are
// always listed; those three stay unregistered, so their controls stay hidden.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {UPSTREAM_COMMIT} from '../lib/format-target.mjs';

export default defineCommands({
  family: 'font',
  app: 'quill',
  upstream: {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/font.rs']},
  commands: [
    {
      id: 'font.list', label: 'Added Fonts', risk: 'read', scope: 'app',
      description: 'Added Fonts (Home › Font): the fonts the person added and where they are kept; `all` also lists every available family.',
      params: s.object({all: s.optional(s.boolean({description: 'also every available family'}))}),
      async run(ctx, p) {
        const out = {fonts: [], folder: null};
        if (p.all) {
          const list = await (ctx.host?.fonts?.() ?? []);
          const families = [...new Set((list ?? []).map(f => (typeof f === 'string' ? f : f?.family)).filter(f => typeof f === 'string' && f.trim()))];
          families.sort((a, b) => a.localeCompare(b, 'en', {sensitivity: 'base'}));
          out.families = families;
        }
        return out;
      },
    },
  ],
});
