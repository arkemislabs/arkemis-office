// The text family's page-view side. Typing, Enter, Tab, Backspace and the typed symbols are model
// commands now (core/quill/commands/text.mjs, translated from wordcraft crates/engine/src/cmd/text.rs
// at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c); they read the page view's layout
// through src/apps/quill/ui-commands/caret.ts. This module registers no command of its own: it stays
// so imports of the interim translation keep resolving until F:quill surface drops them
// (design note U-quill-caret--quill-surface--handover-done).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../../../core/kernel/command.mjs';

export default defineCommands({
  family: 'text',
  app: 'quill',
  upstream: {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/text.rs']},
  commands: [],
});
