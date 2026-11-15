// The page view's side of the caret, select, text, edit and paste families.
//
// Those families are model commands now (core/quill/commands/{caret,text,edit,paste}.mjs, translated
// from wordcraft crates/engine/src/cmd/{caret,text,edit,paste}.rs at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c), so they run the same in the window, headless and over
// the bridge. In a window, Up/Down, Home/End, Page Up/Down, Select Line and Go To must read the
// layout the person sees and draw the caret on the page the command chose: this module installs
// the page view's layout (src/apps/quill/surface/live.mjs `layoutOf`) as the commands' layout
// provider and keeps the page hint in step both ways. It registers no command of its own (the
// interim ui-command translation it replaces is gone: design note F-quill-surface--caret--handover).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../../../core/kernel/command.mjs';
import {setLayoutProvider, setViewSync} from '../../../../core/quill/lib/caret-session.mjs';
import {layoutOf, viewOf, touch} from '../surface/live.mjs';

setLayoutProvider((ctx: any, content: any) => layoutOf(ctx?.docId ?? '', content, ctx?.view ?? null));
setViewSync({
  read: (ctx: any) => ({pageHint: viewOf(ctx?.docId ?? '').pageHint}),
  write(ctx: any, view: any) {
    const id = ctx?.docId ?? '';
    const live = viewOf(id);
    if (Number.isInteger(view?.pageHint) && live.pageHint !== view.pageHint) {
      live.pageHint = view.pageHint;
      touch(id);
    }
  },
});

export default defineCommands({
  family: 'caret',
  app: 'quill',
  upstream: {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/session/layout.rs']},
  commands: [],
});
