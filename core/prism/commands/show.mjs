// Slide Show tab (U:prism/transitions): Play from Start, Play from Current Slide, Set Up Slide Show,
// Custom Slide Show, Use Timings / Show Media Controls / Play Narrations, and the show's own end.
//
// What deckcraft does (crates/engine/src/cmd/review.rs `start`, `setup`, `custom_show`;
// crates/ui-egui/src/ribbon/slide_show.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf): Play from
// Start / Current Slide ask the UI to start the show at slide 0 / the current slide (`ui_requests`);
// `show.setup` writes the deck's show settings (type, loop, without narration / animation, use
// timings, media controls, range, custom show; Kiosk loops); `show.customShow {name, slides}`
// defines or deletes a custom show. PowerPoint does the same. The show itself (transitions,
// animations, keys, clicks) is src/apps/prism/show/ShowPlayer.tsx on core/prism/lib/show-state.mjs;
// these commands only say when to open it (`view.show`).
// Tests: tests/prism/show.test.mjs, tests/e2e/prism/animations.e2e.mjs.
//
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {isSchema2} from '../model/doc.mjs';
import {defaultShowSettings} from '../model/presentation.mjs';
import {fromHex} from '../model/color.mjs';
import {bad, hasSlide, hasDoc, selectionOf, UPSTREAM_COMMIT} from '../lib/text-session.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/review.rs', 'crates/ui-egui/src/ribbon/slide_show.rs', 'crates/ui-egui/src/lib.rs']};
const v2 = (cmd, ctx) => { if (!isSchema2(ctx.doc)) throw bad(cmd, 'needs a presentation (schema 2)'); };
const slidesOf = c => c.slides ?? [];
const running = ctx => (ctx.view?.show ? {enabled: true} : {enabled: false, reason: 'no slide show is running'});
const showOf = c => ({...defaultShowSettings(), ...(c.show ?? {})});

/** Ask the surface to play the show (`view.show`): from slide `from` (an index), or custom show `custom`. */
function start(ctx, from, custom = null, extra = {}) {
  const was = ctx.view?.show;
  ctx.setView({show: {from, custom, n: (was?.n ?? 0) + 1, ...extra}, showStatus: null, showCmd: null});
  return {from};
}

export default defineCommands({
  family: 'show',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'show.fromStart', label: 'Play from Start', risk: 'read', effect: 'view', shortcut: 'Ctrl+Shift+Enter',
      description: 'Play from Start (Slide Show › Start Slide Show): play the slide show from the first slide, with its transitions and animations.',
      params: s.object({}),
      state: hasSlide,
      run(ctx) { v2('show.fromStart', ctx); return start(ctx, 0); },
    },
    {
      id: 'show.fromCurrent', label: 'Play from Current Slide', risk: 'read', effect: 'view', shortcut: 'Ctrl+Enter',
      description: 'Play from Current Slide (Slide Show › Start Slide Show): play the slide show from the current slide.',
      params: s.object({}),
      state: hasSlide,
      run(ctx) { v2('show.fromCurrent', ctx); return start(ctx, selectionOf(ctx).slideIndex); },
    },
    {
      id: 'show.start', label: 'Slide Show', risk: 'read', effect: 'view', shortcut: 'F5',
      description: 'Slide Show: play the show from slide `from` (default: the first slide of the show), or the custom show named `custom`.',
      params: s.object({from: s.optional(s.integer({min: 0, max: 5000})), custom: s.optional(s.string({max: 255}))}),
      state: hasSlide,
      run(ctx, p) {
        v2('show.start', ctx);
        if (p.custom !== undefined && !(ctx.doc.customShows ?? []).some(c => c.name === p.custom)) throw bad('show.start', `no custom show \`${p.custom}\``, {path: '/custom'});
        return start(ctx, p.from ?? 0, p.custom ?? null);
      },
    },
    {
      id: 'show.rehearse', label: 'Rehearse Timings', risk: 'read', effect: 'view',
      description: 'Rehearse Timings (Slide Show › Set Up, Record › From Beginning): play the show from slide `from` (default: the first; `current: true` the current slide) with a clock; the time of each slide is kept when the show ends (show.rehearsed).',
      params: s.object({from: s.optional(s.integer({min: 0, max: 5000})), current: s.optional(s.boolean())}),
      state: hasSlide,
      run(ctx, p) { v2('show.rehearse', ctx); return start(ctx, p.from ?? (p.current ? selectionOf(ctx).slideIndex : 0), null, {rehearse: true}); },
    },
    {
      id: 'show.rehearsed', label: 'Record Slide Timings', risk: 'edit',
      description: 'The end of a rehearsal: `timings` is [[slide index, milliseconds]…]; each becomes the Advance Slide After time of that slide (transition.timing), the show ends and the last slide is current.',
      params: s.object({timings: s.array(s.array(s.integer({min: 0, max: 86_400_000}), {min: 2, max: 2}), {max: 5000})}),
      state: hasDoc,
      async run(ctx, p) {
        v2('show.rehearsed', ctx);
        const n = slidesOf(ctx.doc).length;
        for (const [i, ms] of p.timings) if (i < n) await ctx.run('transition.timing', {index: i, after: ms});
        ctx.setView({show: null, showStatus: null, showCmd: null});
        const last = p.timings.at(-1)?.[0];
        if (last !== undefined && last < n) await ctx.run('slide.go', {index: last});
        return {recorded: p.timings.length};
      },
    },
    {
      id: 'show.presenter', label: 'Presenter View', risk: 'read', effect: 'view',
      description: 'Presenter View (Slide Show › Start Slide Show, Monitors): a second window beside the running show with the current slide, the next slide, the notes, a timer and the slide count; Next and Previous there drive the show. `on` sets it (default: toggle); it opens with the show.',
      params: s.object({on: s.optional(s.boolean())}),
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: !!ctx.view?.presenter} : hasDoc(ctx)),
      run(ctx, p) { v2('show.presenter', ctx); const on = typeof p.on === 'boolean' ? p.on : !ctx.view?.presenter; ctx.setView({presenter: on}); return {on}; },
    },
    {
      id: 'show.presenterState', label: 'Presenter View State', risk: 'read', effect: 'view', journal: false, state: hasDoc,
      description: 'The presenter window reports itself: {open, slide?, info?: {count, notes, next}} (what it has drawn). show.status returns it.',
      params: s.object({open: s.boolean(), slide: s.optional(s.integer({min: 0, max: 5000})), info: s.optional(s.any())}),
      run(ctx, p) { ctx.setView({presenterWindow: p.open ? {open: true, slide: p.slide ?? null, ...(p.info && typeof p.info === 'object' ? {count: String(p.info.count ?? ''), notes: String(p.info.notes ?? ''), next: Number.isInteger(p.info.next) ? p.info.next : null} : {})} : null}); return {}; },
    },
    {
      id: 'show.end', label: 'End Show', risk: 'read', effect: 'view',
      description: 'End Show: close the running slide show.',
      params: s.object({}),
      state: ctx => (ctx.view?.show ? {enabled: true} : {enabled: false, reason: 'no slide show is running'}),
      run(ctx) { ctx.setView({show: null, showStatus: null, showCmd: null}); return {}; },
    },
    ...[
      ['show.next', 'Next', 'Advances one build step or slide; after the last slide ends the show (the Right arrow, Space, Enter, Page Down, N, a click).'],
      ['show.previous', 'Previous', 'Goes back one build step or slide (the Left arrow, Backspace, Page Up, P).'],
      ['show.first', 'First Slide', 'Jumps to the first shown slide (Home).'],
      ['show.last', 'Last Slide', 'Jumps to the last shown slide (End).'],
      ['show.blackScreen', 'Black Screen', 'Toggles a black screen (B or .).'],
      ['show.whiteScreen', 'White Screen', 'Toggles a white screen (W or ,).'],
    ].map(([id, label, description]) => ({
      id, label, risk: 'read', effect: 'view', description: `${description} Acts on the running slide show.`, params: s.object({}),
      state: running,
      run(ctx) { ctx.setView({showCmd: {kind: id.slice(5), n: (ctx.view?.showCmd?.n ?? 0) + 1}}); return {}; },
    })),
    {
      id: 'show.goto', label: 'Go to Slide', risk: 'read', effect: 'view',
      description: 'Go to Slide: jump to the slide at the 0-based `index` in the running slide show (typed digits then Enter); a hidden slide is shown when jumped to.',
      params: s.object({index: s.integer({min: 0, max: 5000})}),
      state: running,
      run(ctx, p) { ctx.setView({showCmd: {kind: 'goto', index: p.index, n: (ctx.view?.showCmd?.n ?? 0) + 1}}); return {}; },
    },
    {
      id: 'show.report', label: 'Slide Show State', risk: 'read', effect: 'view', journal: false,
      description: 'Internal: the running slide show reports where it is (slide index, step, whether a step plays, a transition running, a blank screen, the end screen); show.status reads it back.',
      params: s.object({slide: s.integer({min: 0, max: 100000}), step: s.integer({min: 0, max: 100000}), playing: s.boolean(), ended: s.boolean(), transition: s.optional(s.nullable(s.string({max: 60}))), blank: s.optional(s.nullable(s.string({max: 10}))),
        pointer: s.optional(s.string({max: 16})), ink: s.optional(s.integer({min: 0, max: 1000000})), keepAsk: s.optional(s.boolean())}),
      state: running,
      run(ctx, p) { ctx.setView({showStatus: {...p}}); return {}; },
    },
    {
      id: 'show.status', label: 'Slide Show State', risk: 'read', effect: 'view',
      description: 'Query: where the running slide show is: {slide, step, playing, ended, transition, blank, presenter?: {open, slide} (with Presenter View on)}, or null when no show is running.',
      params: s.object({}),
      state: () => ({enabled: true}),
      run(ctx) { const st = ctx.view?.show ? ctx.view.showStatus ?? null : null; return st && ctx.view?.presenter ? {...st, presenter: ctx.view.presenterWindow ?? {open: false}} : st; },
    },
    {
      id: 'show.setup', label: 'Set Up Slide Show…', risk: 'edit',
      description: "Set Up Slide Show… (Slide Show › Set Up): show type (speaker, browsed, kiosk: loops), loop until Esc, show without narration / animation, use timings, show media controls, the range of slides (`from`, `to`, or `all`) and the custom show to play.",
      params: s.object({
        type: s.optional(s.enum(['speaker', 'browsed', 'kiosk'])), loop: s.optional(s.boolean()), noNarration: s.optional(s.boolean()), noAnimation: s.optional(s.boolean()),
        useTimings: s.optional(s.boolean()), showMediaControls: s.optional(s.boolean()), from: s.optional(s.integer({min: 1, max: 5000})), to: s.optional(s.integer({min: 1, max: 5000})),
        all: s.optional(s.boolean()), custom: s.optional(s.string({max: 255})), playNarrations: s.optional(s.boolean({description: 'the Play Narrations check box: the opposite of noNarration'})),
        field: s.optional(s.enum(['useTimings', 'noNarration', 'showMediaControls'])),
        penColor: s.optional(s.any({description: '#RRGGBB or {r, g, b}: Pen color'})), laserColor: s.optional(s.any({description: '#RRGGBB or {r, g, b}: Laser pointer color'})),
      }),
      state(ctx, p) {
        const st = hasDoc(ctx);
        if (!st.enabled) return st;
        const sh = showOf(ctx.doc);
        if (p?.field === 'useTimings') return {enabled: true, checked: !!sh.useTimings};
        if (p?.field === 'noNarration') return {enabled: true, checked: !sh.withoutNarration};
        if (p?.field === 'showMediaControls') return {enabled: true, checked: !!sh.showMediaControls};
        return {enabled: true};
      },
      run(ctx, p) {
        v2('show.setup', ctx);
        const sh = showOf(ctx.doc);
        if (p.type !== undefined) { sh.showType = p.type; if (p.type === 'kiosk') sh.loopUntilEsc = true; }
        if (p.loop !== undefined) sh.loopUntilEsc = p.loop;
        if (p.noNarration !== undefined) sh.withoutNarration = p.noNarration;
        if (p.playNarrations !== undefined) sh.withoutNarration = !p.playNarrations;
        if (p.noAnimation !== undefined) sh.withoutAnimation = p.noAnimation;
        if (p.useTimings !== undefined) sh.useTimings = p.useTimings;
        if (p.showMediaControls !== undefined) sh.showMediaControls = p.showMediaControls;
        if (p.from !== undefined && p.to !== undefined) sh.range = [p.from, p.to];
        else if (p.all !== undefined && p.from === undefined && p.to === undefined) sh.range = null;
        if (p.all === true) { sh.range = null; sh.customShow = null; }
        for (const [key, v] of [['penColor', p.penColor], ['laserColor', p.laserColor]]) {
          if (v === undefined) continue;
          const c = typeof v === 'string' ? fromHex(v) : v && [v.r, v.g, v.b].every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? {r: v.r, g: v.g, b: v.b, a: 255} : null;
          if (!c) throw bad('show.setup', `${key} is a colour: #RRGGBB or {r, g, b}`);
          sh[key] = {r: c.r, g: c.g, b: c.b, a: 255};
        }
        if (p.custom !== undefined) { sh.customShow = p.custom === '' ? null : p.custom; if (sh.customShow) sh.range = null; }
        ctx.change.set(['show'], sh);
        return sh;
      },
    },
    {
      id: 'show.customShow', label: 'Custom Slide Show', risk: 'edit',
      description: 'Custom Slide Show (Slide Show › Start Slide Show): define the custom show `name` from the slides at the 0-based indices `slides`, or delete it with `delete`.',
      params: s.object({name: s.string({min: 1, max: 255}), slides: s.optional(s.array(s.integer({min: 0, max: 5000}), {max: 5000})), delete: s.optional(s.boolean())}),
      state: hasDoc,
      run(ctx, p) {
        v2('show.customShow', ctx);
        const keep = (ctx.doc.customShows ?? []).filter(c => c.name !== p.name);
        if (!p.delete) {
          const slides = (p.slides ?? []).map(i => slidesOf(ctx.doc)[i]?.id).filter(id => id !== undefined);
          keep.push({name: p.name, slides});
        }
        ctx.change.set(['customShows'], keep);
        return {};
      },
    },
  ],
});
