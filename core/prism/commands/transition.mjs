// Transitions tab (U:prism/transitions): the transition gallery, Effect Options, Sound, Duration,
// On Mouse Click / After, Apply To All.
//
// What deckcraft does (crates/engine/src/cmd/transition.rs; crates/ui-egui/src/ribbon/transitions.rs
// at f893f6af7d36a5409fd804e81a34fd895cfefedf): `transition.set {kind, option?, duration?, index?}`
// puts a transition on the selected slides (else the current one) with the effect's first option
// and default duration (`None` with nothing else set removes it); `transition.options` changes the
// option of slides that have a transition; `transition.timing {duration?, onClick?, after?}` sets
// the duration (≤ 59 s), Advance Slide On Mouse Click and After (ms, `null` clears it);
// `transition.sound` embeds a built-in or chosen sound (Stop Previous Sound, Loop Until Next
// Sound, No Sound); `transition.applyAll` copies the current slide's transition to every slide;
// `transition.list` lists the gallery. PowerPoint does the same. The Preview button, the thumbnail
// star and playing it in the slide show are the surface's and the show's (core/prism/lib/show-state.mjs).
// Tests: tests/prism/transition.test.mjs, tests/e2e/prism/transitions.e2e.mjs.
//
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {s} from '../../kernel/schema.mjs';
import {isSchema2} from '../model/doc.mjs';
import {defaultTransition} from '../formats/pptx-read.mjs';
import {bad, hasSlide, always, optIndex, selectionOf, UPSTREAM_COMMIT} from '../lib/text-session.mjs';
import {mediaBytes, contentType, addMedia} from '../lib/shape-common.mjs';
import {transitionList, transitionInfo, transitionOptionLabel, builtinSound, BUILTIN_SOUNDS} from '../lib/anim-tables.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/transition.rs', 'crates/ui-egui/src/ribbon/transitions.rs', 'crates/model/src/anim.rs']};
const MAX_DURATION = 59_000, MAX_AFTER = 86_400_000;
const slidesOf = c => c.slides ?? [];
const index = s.optional(s.integer({min: 0, max: 5000, description: '0-based slide index (default: the selected slides, else the current slide)'}));

/** deckcraft `slide_indices`: the `index` param, else the selected slides in document order, else the current slide. */
function slideIndices(ctx, p, cmd) {
  const given = optIndex(p, 'index', cmd);
  if (given !== undefined) return [given];
  const sel = selectionOf(ctx);
  const v = sel.slides.map(id => slidesOf(ctx.doc).findIndex(x => x.id === id)).filter(i => i >= 0);
  return v.length ? v : [sel.slideIndex];
}
const needSlide = (ctx, i, cmd) => { if (!slidesOf(ctx.doc)[i]) throw bad(cmd, `no slide ${i}`, {path: '/index'}); return slidesOf(ctx.doc)[i]; };
const v2 = (cmd, ctx) => { if (!isSchema2(ctx.doc)) throw bad(cmd, 'needs a presentation (schema 2)'); };

/** The transition of the current slide (the one the ribbon shows); null when it has none. */
export function currentTransition(ctx) {
  if (!isSchema2(ctx.doc)) return null;
  return slidesOf(ctx.doc)[selectionOf(ctx).slideIndex]?.transition ?? null;
}
const withDefaults = t => ({...defaultTransition(), sound: null, ...(t ?? {})});
/** Store a transition, or nothing for the plain default (a slide with no transition has `null`). */
const isPlain = t => t.kind === 'none' && t.advanceOnClick !== false && (t.advanceAfterMs === null || t.advanceAfterMs === undefined) && !t.sound && !t.stopSound;
const keep = t => { const o = {...t}; if (!o.soundLoop) delete o.soundLoop; if (!o.stopSound) delete o.stopSound; if (o.raw === undefined || o.raw === null) delete o.raw; return o; };

/** The gallery tiles of the transition control: every effect by category, the first twelve in the ribbon's own strip. */
export function transitionGallery(current) {
  return transitionList().map((t, i) => ({id: t.id, label: t.label, value: t.id, icon: `transition-${t.id}`, group: t.category, inline: i < 12, selected: t.id === (current?.kind ?? 'none')}));
}
/** The rows of Effect Options for the current transition: the stored option, its label, and whether it is the current one. */
export function transitionOptionRows(t) {
  const info = transitionInfo(t?.kind ?? 'none');
  const cur = t?.option ?? '';
  return (info?.options ?? []).map(o => ({id: o, label: transitionOptionLabel(info.id, o), value: o, checked: o === cur}));
}
const soundName = (ctx, t) => {
  if (t?.stopSound) return 'Stop Previous Sound';
  if (!t?.sound) return 'No Sound';
  const m = (ctx.doc.media ?? []).find(x => x.id === t.sound);
  return m ? String(m.name).replace(/\.wav$/i, '') : 'No Sound';
};

export default defineCommands({
  family: 'transition',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'transition.set', label: 'Transition', risk: 'edit',
      description: 'Transition (Transitions › Transition to This Slide): put a transition on the selected slides (or the slide at `index`) with its first Effect Option and default duration; none removes it. kind: none, morph, fade, push, wipe, split, reveal, cut, randomBar, shape, uncover, cover, flash, … (transition.list).',
      params: s.object({kind: s.string({min: 1, max: 40}), option: s.optional(s.string({max: 40})), duration: s.optional(s.integer({min: 0, max: 600_000, description: 'milliseconds (at most 59000)'})), index}),
      state(ctx) {
        const st = hasSlide(ctx);
        return st.enabled ? {enabled: true, value: transitionGallery(currentTransition(ctx))} : st;
      },
      run(ctx, p) {
        v2('transition.set', ctx);
        const info = transitionInfo(p.kind);
        if (!info) throw bad('transition.set', `unknown transition \`${p.kind}\``, {path: '/kind'});
        const targets = slideIndices(ctx, p, 'transition.set');
        const option = p.option ?? info.options[0] ?? '';
        const duration = p.duration === undefined ? info.durationMs : Math.min(p.duration, MAX_DURATION);
        for (const i of targets) {
          const sl = needSlide(ctx, i, 'transition.set');
          const t = {...withDefaults(sl.transition), kind: info.id, option, durationMs: duration};
          delete t.raw;
          ctx.change.set(['slides', i, 'transition'], isPlain(t) ? null : keep(t));
        }
        return {kind: info.id};
      },
    },
    {
      id: 'transition.options', label: 'Effect Options', risk: 'edit',
      description: 'Effect Options (Transitions › Transition to This Slide): the option of the transition on the selected slides (or the slide at `index`), e.g. a direction (l, r, u, d, …) or horz, vert, in, out; slides without a transition are left alone.',
      params: s.object({option: s.string({max: 40}), index}),
      state(ctx) {
        const st = hasSlide(ctx);
        if (!st.enabled) return st;
        const rows = transitionOptionRows(currentTransition(ctx));
        return rows.length ? {enabled: true, value: rows} : {enabled: false, reason: currentTransition(ctx)?.kind && currentTransition(ctx).kind !== 'none' ? 'this transition has no options' : 'choose a transition first'};
      },
      run(ctx, p) {
        v2('transition.options', ctx);
        for (const i of slideIndices(ctx, p, 'transition.options')) {
          const sl = needSlide(ctx, i, 'transition.options');
          if (sl.transition) ctx.change.set(['slides', i, 'transition', 'option'], p.option);
        }
        return {};
      },
    },
    {
      id: 'transition.timing', label: 'Timing', risk: 'edit',
      description: 'Timing (Transitions › Timing): Duration (ms, at most 59000), Advance Slide On Mouse Click (`onClick`) and After (ms; null clears it; `afterOn` is its check box) for the selected slides (or the slide at `index`). `field` only says which value a ribbon control shows (duration, onClick, after, afterTime).',
      params: s.object({
        duration: s.optional(s.integer({min: 0, max: 600_000})), onClick: s.optional(s.boolean()),
        after: s.optional(s.nullable(s.integer({min: 0, max: 86_400_000}))), afterOn: s.optional(s.boolean({description: 'the After check box: on keeps (or starts at 0) the time, off clears it'})),
        field: s.optional(s.enum(['duration', 'onClick', 'after', 'afterTime'])), index,
      }),
      state(ctx, p) {
        const st = hasSlide(ctx);
        if (!st.enabled) return st;
        const t = currentTransition(ctx);
        switch (p?.field) {
          case 'duration': return {enabled: true, value: (t ? t.durationMs : 1000) / 1000};
          case 'onClick': return {enabled: true, checked: t ? t.advanceOnClick !== false : true};
          case 'after': return {enabled: true, checked: t?.advanceAfterMs !== null && t?.advanceAfterMs !== undefined};
          case 'afterTime': return {enabled: true, value: (t?.advanceAfterMs ?? 0) / 1000};
          default: return {enabled: true};
        }
      },
      run(ctx, p) {
        v2('transition.timing', ctx);
        for (const i of slideIndices(ctx, p, 'transition.timing')) {
          const sl = needSlide(ctx, i, 'transition.timing');
          let t = withDefaults(sl.transition);
          if (p.duration !== undefined) t = {...t, durationMs: Math.min(p.duration, MAX_DURATION)};
          if (p.onClick !== undefined) t = {...t, advanceOnClick: p.onClick};
          if (p.after !== undefined) t = {...t, advanceAfterMs: p.after === null ? null : Math.min(p.after, MAX_AFTER)};
          if (p.afterOn !== undefined) t = {...t, advanceAfterMs: p.afterOn ? t.advanceAfterMs ?? 0 : null};
          ctx.change.set(['slides', i, 'transition'], keep(t));
        }
        return {};
      },
    },
    {
      id: 'transition.sound', label: 'Sound', risk: 'edit',
      description: 'Sound (Transitions › Timing): the sound that plays as the slide comes in. {builtin: chime|click|camera|whoosh|drumRoll|laser} or {path} / {data: base64, name?} embeds a sound; {none: true} is No Sound; {stopPrevious: true} is Stop Previous Sound; {loop} is Loop Until Next Sound (`field: loop` alone toggles it); a sound chosen without `loop` keeps the slide Loop Until Next Sound setting. {pick: true} (Other Sound…) asks for the file.',
      params: s.object({
        builtin: s.optional(s.string({max: 40})), path: s.optional(s.string({max: 4096})), data: s.optional(s.string({max: 60_000_000})), name: s.optional(s.string({max: 255})),
        none: s.optional(s.boolean()), stopPrevious: s.optional(s.boolean()), loop: s.optional(s.boolean()), field: s.optional(s.enum(['loop'])), pick: s.optional(s.boolean({description: 'Other Sound…: ask for a sound file in the system Open dialog'})), index,
      }),
      state(ctx, p) {
        const st = hasSlide(ctx);
        if (!st.enabled) return st;
        const t = currentTransition(ctx);
        if (p?.field === 'loop') return t?.sound ? {enabled: true, checked: !!t.soundLoop} : {enabled: false, reason: 'choose a sound first', checked: false};
        // The menu's entries show which sound is the current one.
        if (p?.none) return {enabled: true, checked: !t?.sound && !t?.stopSound};
        if (p?.stopPrevious) return {enabled: true, checked: !!t?.stopSound};
        if (p?.builtin) {
          const hit = BUILTIN_SOUNDS.find(b => b[0] === p.builtin);
          return {enabled: true, checked: !!hit && !!t?.sound && soundName(ctx, t) === hit[1]};
        }
        return {enabled: true, value: soundName(ctx, t)};
      },
      async run(ctx, p) {
        v2('transition.sound', ctx);
        const targets = slideIndices(ctx, p, 'transition.sound');
        const apply = f => { for (const i of targets) { const sl = needSlide(ctx, i, 'transition.sound'); ctx.change.set(['slides', i, 'transition'], keep(f(withDefaults(sl.transition)))); } };
        if (p.none === true) { apply(t => ({...t, sound: null, stopSound: false, soundLoop: false})); return {sound: null}; }
        if (p.stopPrevious === true) { apply(t => ({...t, sound: null, soundLoop: false, stopSound: true})); return {sound: null, stopPrevious: true}; }
        let q = p;
        if (p.pick === true && p.path === undefined && p.data === undefined) {
          const pick = ctx.host?.pickSound;
          if (typeof pick !== 'function') throw new CommandError('unavailable', 'transition.sound: choosing a sound file needs the desktop app; send `path` or `data`');
          const f = await pick();
          if (!f) return null;
          q = {...p, data: f.data, name: f.name};
        }
        const wantsFile = q.path !== undefined || q.data !== undefined || q.builtin !== undefined;
        const was = currentTransition(ctx);
        if (!wantsFile) {
          let loop = q.loop;
          if (loop === undefined && q.field === 'loop') loop = !was?.soundLoop;
          if (loop === undefined) throw bad('transition.sound', 'give `path`, `data`, `builtin`, `none`, `stopPrevious` or `loop`');
          apply(t => ({...t, soundLoop: loop && !!t.sound}));
          return {loop};
        }
        let name, bytes;
        if (q.builtin !== undefined) {
          const hit = BUILTIN_SOUNDS.find(b => b[0].toLowerCase() === String(q.builtin).toLowerCase());
          if (!hit) throw bad('transition.sound', `unknown built-in sound \`${q.builtin}\` (one of ${BUILTIN_SOUNDS.map(b => b[0]).join(', ')})`, {path: '/builtin'});
          name = `${hit[1]}.wav`;
          bytes = builtinSound(hit[0]);
        } else ({name, bytes} = await mediaBytes(ctx, q, 'transition.sound'));
        const ct = contentType(name, bytes);
        if (!ct.startsWith('audio/')) throw bad('transition.sound', `${name} is not a sound file (${ct})`);
        const media = addMedia(ctx, 'transition.sound', name, ct, bytes);
        const loop = q.loop ?? !!was?.soundLoop;
        apply(t => ({...t, sound: media, stopSound: false, soundLoop: loop}));
        return {sound: name, media, playable: true, loop};
      },
    },
    {
      id: 'transition.applyAll', label: 'Apply To All', risk: 'edit',
      description: "Apply To All (Transitions › Timing): copy the current slide's transition (effect, option, duration, sound and advance timing) to every slide.",
      params: s.object({}),
      state: hasSlide,
      run(ctx) {
        v2('transition.applyAll', ctx);
        const t = slidesOf(ctx.doc)[selectionOf(ctx).slideIndex]?.transition ?? null;
        slidesOf(ctx.doc).forEach((_, i) => ctx.change.set(['slides', i, 'transition'], t ? structuredClone(t) : null));
        return {slides: slidesOf(ctx.doc).length};
      },
    },
    {
      id: 'transition.preview', label: 'Preview', risk: 'read', effect: 'view',
      description: "Preview (Transitions › Preview): play the current slide's transition on the slide, from the slide before it (from black for the first).",
      params: s.object({on: s.optional(s.boolean())}),
      state(ctx) {
        const st = hasSlide(ctx);
        return st.enabled ? {enabled: true, checked: !!ctx.view?.transitionPreview?.on} : st;
      },
      run(ctx, p) {
        v2('transition.preview', ctx);
        const was = ctx.view?.transitionPreview;
        const on = p.on ?? true;
        ctx.setView({transitionPreview: {on, n: (was?.n ?? 0) + 1}});
        return {on};
      },
    },
    {
      id: 'transition.list', label: 'Transition Gallery', risk: 'read', effect: 'view',
      description: 'Query: the transition gallery [{id, label, category, durationMs, options: [{id, label}]}].',
      params: s.object({}),
      state: always,
      run() { return transitionList().map(t => ({...t, options: t.options.map(o => ({id: o, label: transitionOptionLabel(t.id, o)}))})); },
    },
  ],
});
