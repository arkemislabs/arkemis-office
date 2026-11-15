// View tab, the rest: Black and White (View > Color/Grayscale), Cascade and Move Split (View > Window).
// PowerPoint's behaviour, not checked against upstream (deckcraft has none of the three).
//
// - Black and White draws the slides in pure black and white (the surface thresholds the drawing); it
//   is one of Color, Grayscale and Black and White, so each of the three switches the others off.
// - Cascade lays the open windows out in a cascade (host windows, as Arrange All does).
// - Move Split moves the split bars between the slide pane, the slide and the notes with the arrow
//   keys, as PowerPoint's View > Move Split does; `dx` and `dy` move them by that many pixels
//   (the bridge's way), and with neither the surface arms its arrow keys (Enter or Esc ends it).

import {defineCommands} from '../../kernel/command.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {s} from '../../kernel/schema.mjs';
import {isSchema2} from '../model/doc.mjs';
import {bad, hasDoc, UPSTREAM_COMMIT} from '../lib/text-session.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: []};

function windowsApi(ctx) {
  const w = ctx.host?.windows;
  if (!w || typeof w.arrange !== 'function') throw new CommandError('unavailable', 'Windows are only available in the app window');
  return w;
}

export default defineCommands({
  family: 'viewextra',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'view.blackWhite', label: 'Black and White', risk: 'read', effect: 'view',
      description: 'Black and White (View › Color/Grayscale): draw the slides in pure black and white; `on: false` is Color. Not checked against upstream.',
      params: s.object({on: s.optional(s.boolean())}),
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: !!ctx.view?.blackWhite} : hasDoc(ctx)),
      run(ctx, p) {
        if (!isSchema2(ctx.doc)) throw bad('view.blackWhite', 'needs a presentation (schema 2)');
        const on = typeof p.on === 'boolean' ? p.on : !ctx.view?.blackWhite;
        ctx.setView({blackWhite: on, ...(on ? {grayscale: false} : {})});
        return {on};
      },
    },
    {
      id: 'view.cascade', label: 'Cascade', risk: 'read', effect: 'view',
      description: 'Cascade (View › Window): the open windows overlapped, each a little down and right of the one before. Not checked against upstream.',
      params: s.object({}),
      state(ctx) {
        const st = hasDoc(ctx);
        if (!st.enabled) return st;
        const w = ctx.host?.windows;
        return w && typeof w.arrange === 'function' ? {enabled: true} : {enabled: false, reason: 'only in the app window'};
      },
      async run(ctx) { return windowsApi(ctx).arrange({mode: 'cascade'}); },
    },
    {
      id: 'view.moveSplit', label: 'Move Split', risk: 'read', effect: 'view',
      description: 'Move Split (View › Window): move the split bars with the arrow keys. {dx?, dy?}: move the bar between the slide pane and the slide by dx px, and the one above the notes by dy px; without either the arrow keys are armed (Enter or Esc ends it). Not checked against upstream.',
      params: s.object({dx: s.optional(s.number({min: -5000, max: 5000})), dy: s.optional(s.number({min: -5000, max: 5000})), end: s.optional(s.boolean())}),
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: !!ctx.view?.moveSplit} : hasDoc(ctx)),
      run(ctx, p) {
        if (!isSchema2(ctx.doc)) throw bad('view.moveSplit', 'needs a presentation (schema 2)');
        if (p.end) { ctx.setView({moveSplit: false}); return {armed: false}; }
        if (p.dx === undefined && p.dy === undefined) { const armed = !ctx.view?.moveSplit; ctx.setView({moveSplit: armed}); return {armed}; }
        const n = (ctx.view?.splitMove?.n ?? 0) + 1;
        ctx.setView({splitMove: {n, dx: p.dx ?? 0, dy: p.dy ?? 0}});
        return {n};
      },
    },
  ],
});
