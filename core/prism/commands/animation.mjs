// Animations tab and Animation Pane (U:prism/transitions): the animation gallery (Entrance,
// Emphasis, Exit, Motion Paths), Effect Options, Add Animation, Trigger, Animation Painter, Start /
// Duration / Delay, Reorder, the pane's list (remove, move, timing, Play From) and Preview.
//
// What deckcraft does (crates/engine/src/cmd/animation.rs; crates/ui-egui/src/ribbon/animations.rs;
// crates/ui-egui/src/panels/animation.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf):
// `animation.set {effect, class?, option?, ids?}` replaces the selected shapes' animations (keeping
// their place in the sequence), `animation.add` appends one effect per shape (the second shape on
// takes With Previous), `animation.remove`, `animation.move {index, to}`, `animation.timing`
// {index?, start, duration, delay, repeat, rewind, trigger}, `animation.options` {option, textBuild},
// `animation.clear`, `animation.painter` / `animation.painterApply`, `animation.list`,
// `animation.get`. PowerPoint does the same. `animation.preview` (a UI command upstream) plays the
// slide's animations on the canvas: the surface does it, this command only says when
// (`view.animPreview`). `animation.pick` is the pane's click on a row (select its shape, remember
// the row: Play From and the ribbon's Start/Duration/Delay act on it, as upstream's pane does).
// Tests: tests/prism/animation.test.mjs (ported upstream tests), tests/e2e/prism/animations.e2e.mjs.
//
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {isSchema2, selectedShapeIds} from '../model/doc.mjs';
import {defaultAnimation, animationInfo, ANIMATIONS} from '../formats/pptx-read.mjs';
import {walk, findShape} from '../model/presentation.mjs';
import {bad, hasSlide, hasSelection, always, optIndex, usizeParam, targets, selectionOf, idOf, idParam, selectShapeIds, UPSTREAM_COMMIT} from '../lib/text-session.mjs';
import {
  animationList, resolveOption, defaultPath, animationOptionLabel, QUICK_ANIMATIONS, CLASS_LABELS,
} from '../lib/anim-tables.mjs';
import {timelineFor} from '../lib/show-state.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/animation.rs', 'crates/ui-egui/src/ribbon/animations.rs', 'crates/ui-egui/src/panels/animation.rs', 'crates/model/src/anim.rs']};
const MAX_MS = 600_000;
const REPEAT_UNTIL_CLICK = 0xffffffff;
const slidesOf = c => c.slides ?? [];
const v2 = (cmd, ctx) => { if (!isSchema2(ctx.doc)) throw bad(cmd, 'needs a presentation (schema 2)'); };
const CLASSES = ['entrance', 'emphasis', 'exit', 'path', 'media', 'emph', 'motion', 'motionPath'];
const START_LABELS = {onclick: 'onClick', withprevious: 'withPrevious', afterprevious: 'afterPrevious', with: 'withPrevious', after: 'afterPrevious', click: 'onClick'};
const START_NAMES = {onClick: 'On Click', withPrevious: 'With Previous', afterPrevious: 'After Previous'};
const TEXT_BUILDS = ['asOne', 'byParagraph', 'byWord', 'byLetter'];

const classOf = c => (c === undefined ? undefined : c === 'emphasis' || c === 'emph' ? 'emphasis' : c === 'exit' ? 'exit' : c === 'path' || c === 'motion' || c === 'motionPath' ? 'path' : c === 'media' ? 'media' : 'entrance');
/** `start_of`: the stored start from an id or the label the ribbon's Start box shows ("On Click"). */
const startOf = v => { const k = String(v).replace(/[\s_-]/g, '').toLowerCase(); return START_LABELS[k] ?? 'onClick'; };

const sl = (ctx, cmd) => {
  const slide = slidesOf(ctx.doc)[selectionOf(ctx).slideIndex];
  if (!slide) throw bad(cmd, 'no slide');
  return slide;
};
const animsOf = slide => slide?.animations ?? [];

/** The animation the ribbon shows: the row last clicked in the pane when its shape is still selected, else the first of the first selected shape. */
export function currentAnimation(ctx) {
  if (!isSchema2(ctx.doc)) return null;
  const slide = slidesOf(ctx.doc)[selectionOf(ctx).slideIndex];
  const sel = selectedShapeIds(ctx.doc, ctx.selection);
  const anims = animsOf(slide);
  const picked = ctx.view?.animIndex;
  if (Number.isInteger(picked) && anims[picked] && sel.includes(anims[picked].shape)) return {index: picked, anim: anims[picked]};
  const first = sel.length ? anims.findIndex(a => a.shape === sel[0]) : -1;
  return first >= 0 ? {index: first, anim: anims[first]} : null;
}

function buildAnimation(pIn, cmd) {
  if (pIn.effect === undefined) throw bad(cmd, 'missing `effect`');
  // The gallery's tiles name an effect as `<class>:<effect>` (exit:fade), so Fade as an entrance and as an exit stay apart.
  let p = pIn;
  const colon = String(p.effect).indexOf(':');
  if (colon > 0) p = {...p, class: p.class ?? String(p.effect).slice(0, colon), effect: String(p.effect).slice(colon + 1)};
  const cls = classOf(p.class);
  const info = cls ? animationInfo(p.effect, cls) : ANIMATIONS.find(a => a[0] === p.effect);
  if (!info) throw bad(cmd, `unknown effect \`${p.effect}\``, {path: '/effect'});
  const [effect, , icls, preset, dur, options] = info;
  let option = options[0] ?? '';
  if (p.option !== undefined) {
    const r = resolveOption(options, p.option);
    if (r === null) throw bad(cmd, `option \`${p.option}\` is not one of ${JSON.stringify(options)} for \`${effect}\``, {path: '/option'});
    option = r;
  }
  const a = {
    ...defaultAnimation(), class: icls, effect, option, durationMs: p.duration === undefined ? dur : Math.min(p.duration, MAX_MS),
    delayMs: p.delay === undefined ? 0 : Math.min(p.delay, MAX_MS), presetId: preset,
  };
  if (p.start !== undefined) a.start = startOf(p.start);
  if (a.class === 'path') a.path = defaultPath(effect, option);
  if (effect === 'spin') a.amount = 360;
  if (effect === 'growShrink') a.amount = 1.5;
  return a;
}

const ids = s.optional(s.array(s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]), {max: 10_000}));
const idx = s.optional(s.integer({min: 0, max: 100_000, description: 'index in the slide\'s animation list (the Animation Pane\'s order)'}));
const ms = s.integer({min: 0, max: MAX_MS});

/** The gallery tiles of the Animations tab: the quick strip, and every effect by class in the drop-down. */
export function animationGallery(cur) {
  const quick = new Set(QUICK_ANIMATIONS);
  const items = [{id: 'none', label: 'None', value: 'none', icon: 'animation-none', group: 'None', inline: true, selected: !cur}];
  for (const a of animationList()) {
    if (a.class === 'media') continue;
    items.push({id: `${a.class}:${a.id}`, label: a.label, value: `${a.class}:${a.id}`, icon: `anim-${a.id}`, group: CLASS_LABELS[a.class], inline: quick.has(a.id) && a.class !== 'exit' || a.id === 'fadeOut' || a.id === 'flyOut',
      selected: !!cur && cur.effect === a.id && cur.class === a.class});
  }
  return items;
}
/** The rows of Effect Options for the current effect (its options, as the Animations tab labels them). */
export function animationOptionRows(cur) {
  const options = cur ? animationInfo(cur.effect, cur.class)?.[5] ?? [] : [];
  return options.map(o => ({id: o, label: animationOptionLabel(o), value: o, checked: o === cur.option}));
}

/** Animation rows the pane lists: the animation, its shape's name and its place in the click sequence. */
export function paneRows(content, slide, view = {}) {
  const size = content.slideSize ?? {width: 960, height: 540};
  const pres = content;
  const i = slidesOf(content).findIndex(x => x.id === slide.id);
  const tl = timelineFor(pres, i < 0 ? 0 : i);
  const names = new Map();
  walk(slide.shapes, sh => names.set(sh.id, sh.name || `Shape ${sh.id}`));
  let click = 0;
  const timings = tl.timings();
  return animsOf(slide).map((a, k) => {
    if (a.start === 'onClick' && !a.trigger) click += 1;
    const t = timings.find(x => x.anim === k && x.sequence === (a.trigger ?? null));
    return {index: k, shape: a.shape, name: names.get(a.shape) ?? `Shape ${a.shape}`, class: a.class, effect: a.effect, start: a.start, click: a.start === 'onClick' ? click : null,
      step: t?.step ?? null, startAt: t ? t.start : 0, span: t ? t.span : a.durationMs / 1000, duration: a.durationMs / 1000, delay: a.delayMs / 1000, repeatUntilClick: a.repeat === REPEAT_UNTIL_CLICK,
      trigger: a.trigger ?? null, canPlayFrom: tl.startOf(k) !== null, picked: view.animIndex === k, slideWidth: size.width};
  });
}

function eachTarget(ctx, p, cmd, f) {
  v2(cmd, ctx);
  let index = optIndex(p, 'index', cmd);
  // The ribbon's boxes act on the row picked in the Animation Pane (PowerPoint: the selected effect), else on all of the selected shapes' effects.
  if (index === undefined && !Array.isArray(p.ids) && p.id === undefined) {
    const picked = ctx.view?.animIndex;
    const cur = Number.isInteger(picked) ? currentAnimation(ctx) : null;
    if (cur && cur.index === picked) index = picked;
  }
  const sel = index === undefined ? targets(ctx, p, cmd) : [];
  const slide = sl(ctx, cmd);
  const si = selectionOf(ctx).slideIndex;
  let n = 0;
  animsOf(slide).forEach((a, k) => {
    if (index === k || (index === undefined && sel.includes(a.shape))) {
      const next = f({...a});
      if (next) ctx.change.set(['slides', si, 'animations', k], next);
      n += 1;
    }
  });
  if (n === 0) throw bad(cmd, 'no animation to change (select an animated object or give `index`)');
  return {changed: n};
}
const setAnims = (ctx, list) => ctx.change.set(['slides', selectionOf(ctx).slideIndex, 'animations'], list);
const forgetPick = ctx => { if (ctx.view?.animIndex !== null && ctx.view?.animIndex !== undefined) ctx.setView({animIndex: null}); };

export default defineCommands({
  family: 'animation',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'animation.set', label: 'Animation Styles', risk: 'edit',
      description: "Animation Styles (Animations › Animation): replace the selected shapes' animations with one effect (keeping their place in the sequence); none removes them. effect: appear, fade, fly, zoom, wipe, spin, pulse, fadeOut, lines, … (animation.list); class: entrance, emphasis, exit, path.",
      params: s.object({effect: s.string({min: 1, max: 60}), class: s.optional(s.enum(CLASSES)), option: s.optional(s.string({max: 40})), ids}),
      state(ctx) {
        const st = hasSelection(ctx);
        // Nothing selected: the tiles are still drawn, greyed.
        return st.enabled ? {enabled: true, value: animationGallery(currentAnimation(ctx)?.anim ?? null)} : {...st, value: animationGallery(null)};
      },
      run(ctx, p) {
        v2('animation.set', ctx);
        const sel = targets(ctx, p, 'animation.set');
        const si = selectionOf(ctx).slideIndex;
        const slide = sl(ctx, 'animation.set');
        if (p.effect === 'none') {
          const out = animsOf(slide).filter(a => !sel.includes(a.shape));
          setAnims(ctx, out);
          forgetPick(ctx);
          return {count: out.length};
        }
        const a = buildAnimation(p, 'animation.set');
        const out = [], placed = [];
        for (const x of animsOf(slide)) {
          if (sel.includes(x.shape)) {
            if (!placed.includes(x.shape)) { placed.push(x.shape); out.push({...a, shape: x.shape, start: x.start}); }
          } else out.push(x);
        }
        for (const id of sel) if (!placed.includes(id)) out.push({...a, shape: id});
        ctx.change.set(['slides', si, 'animations'], out);
        forgetPick(ctx);
        return {count: out.length};
      },
    },
    {
      id: 'animation.add', label: 'Add Animation', risk: 'edit',
      description: 'Add Animation (Animations › Advanced Animation): add one more effect to the selected shapes (the second shape on starts With Previous). {effect, class?, option?, start?: onClick|withPrevious|afterPrevious, duration?: ms, delay?: ms, ids?}',
      params: s.object({effect: s.string({min: 1, max: 60}), class: s.optional(s.enum(CLASSES)), option: s.optional(s.string({max: 40})), start: s.optional(s.string({max: 30})), duration: s.optional(ms), delay: s.optional(ms), ids}),
      state(ctx) {
        const st = hasSelection(ctx);
        const value = animationGallery(null).filter(i => i.id !== 'none').map(i => ({...i, inline: true, selected: false}));
        return st.enabled ? {enabled: true, value} : {...st, value};
      },
      run(ctx, p) {
        v2('animation.add', ctx);
        const sel = targets(ctx, p, 'animation.add');
        const a = buildAnimation(p, 'animation.add');
        const slide = sl(ctx, 'animation.add');
        const si = selectionOf(ctx).slideIndex;
        const out = [...animsOf(slide)];
        sel.forEach((id, k) => out.push({...a, shape: id, start: k > 0 ? 'withPrevious' : a.start}));
        ctx.change.set(['slides', si, 'animations'], out);
        return {count: out.length};
      },
    },
    {
      id: 'animation.remove', label: 'Remove Animation', risk: 'edit',
      description: "Remove Animation (Animation Pane): remove the animation at `index`, else all of the selected shapes' (or `ids`') animations.",
      params: s.object({index: idx, ids}),
      state: hasSlide,
      run(ctx, p) {
        v2('animation.remove', ctx);
        const index = optIndex(p, 'index', 'animation.remove');
        const sel = index === undefined ? targets(ctx, p, 'animation.remove') : [];
        const slide = sl(ctx, 'animation.remove');
        const list = animsOf(slide);
        if (index !== undefined) {
          if (index >= list.length) throw bad('animation.remove', 'no such animation');
          setAnims(ctx, list.filter((_, k) => k !== index));
        } else setAnims(ctx, list.filter(a => !sel.includes(a.shape)));
        forgetPick(ctx);
        return {};
      },
    },
    {
      id: 'animation.move', label: 'Reorder Animation', risk: 'edit',
      description: 'Reorder Animation (Animations › Timing, Animation Pane): move the animation at `index` (default: the current one) to `to`, or one place earlier / later with `by` (-1 / 1).',
      params: s.object({index: idx, to: s.optional(s.integer({min: 0, max: 100_000})), by: s.optional(s.integer({min: -100_000, max: 100_000}))}),
      state(ctx, p) {
        const st = hasSlide(ctx);
        if (!st.enabled) return st;
        const cur = currentAnimation(ctx);
        const n = animsOf(slidesOf(ctx.doc)[selectionOf(ctx).slideIndex]).length;
        if (p?.by && !cur) return {enabled: false, reason: 'select an animated object first'};
        if (p?.by && cur && (cur.index + p.by < 0 || cur.index + p.by >= n)) return {enabled: false, reason: p.by < 0 ? 'already first' : 'already last'};
        return {enabled: true};
      },
      run(ctx, p) {
        v2('animation.move', ctx);
        const slide = sl(ctx, 'animation.move');
        const list = [...animsOf(slide)];
        let i = optIndex(p, 'index', 'animation.move');
        if (i === undefined) { const cur = currentAnimation(ctx); if (!cur) throw bad('animation.move', 'missing `index` (select an animated object)'); i = cur.index; }
        let to = usizeParam(p, 'to');
        if (to === undefined && p.by !== undefined) to = i + p.by;
        if (to === undefined) throw bad('animation.move', 'missing `to`');
        if (i >= list.length) throw bad('animation.move', 'no such animation');
        const [a] = list.splice(i, 1);
        to = Math.min(Math.max(to, 0), list.length);
        list.splice(to, 0, a);
        setAnims(ctx, list);
        forgetPick(ctx);
        return {index: to};
      },
    },
    {
      id: 'animation.timing', label: 'Timing', risk: 'edit',
      description: "Timing (Animations › Timing, Trigger): Start (onClick|withPrevious|afterPrevious), Duration and Delay (ms), repeat (n, 4294967295 = until next click), rewind, and the trigger shape (null: part of the click sequence) of the animation at `index` (else the selected shapes' animations). `field` only says which value a ribbon control shows (start, duration, delay, trigger).",
      params: s.object({
        index: idx, start: s.optional(s.string({max: 30})), duration: s.optional(ms), delay: s.optional(ms), repeat: s.optional(s.integer({min: 0, max: 0xffffffff})), rewind: s.optional(s.boolean()),
        trigger: s.optional(s.nullable(s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]))), ids,
        field: s.optional(s.enum(['start', 'duration', 'delay', 'trigger'])),
      }),
      state(ctx, p) {
        const st = hasSlide(ctx);
        if (!st.enabled) return st;
        const cur = currentAnimation(ctx);
        if (p?.field || p?.trigger !== undefined || !Object.keys(p ?? {}).length) {
          if (!cur) return {enabled: false, reason: 'select an animated object first'};
          const a = cur.anim;
          switch (p.field) {
            case 'start': return {enabled: true, value: START_NAMES[a.start] ?? 'On Click'};
            case 'duration': return {enabled: true, value: a.durationMs / 1000};
            case 'delay': return {enabled: true, value: a.delayMs / 1000};
            case 'trigger': {
              const slide = slidesOf(ctx.doc)[selectionOf(ctx).slideIndex];
              const rows = [];
              walk(slide?.shapes ?? [], sh => { if (sh.id !== a.shape) rows.push({id: sh.id, label: `On Click of ${sh.name || `Shape ${sh.id}`}`, value: sh.id, checked: a.trigger === sh.id}); });
              return {enabled: true, value: rows};
            }
            default: return {enabled: true, checked: p.trigger === null ? !a.trigger : idOf(p.trigger) === a.trigger};
          }
        }
        return {enabled: true};
      },
      run(ctx, p) {
        return eachTarget(ctx, p, 'animation.timing', a => {
          if (p.start !== undefined) a.start = startOf(p.start);
          if (p.duration !== undefined) a.durationMs = Math.min(p.duration, MAX_MS);
          if (p.delay !== undefined) a.delayMs = Math.min(p.delay, MAX_MS);
          if (p.repeat !== undefined) a.repeat = p.repeat;
          if (p.rewind !== undefined) a.rewind = p.rewind;
          if (p.trigger !== undefined) a.trigger = p.trigger === null ? null : idOf(p.trigger);
          return a;
        });
      },
    },
    {
      id: 'animation.options', label: 'Effect Options', risk: 'edit',
      description: "Effect Options (Animations › Animation): the option (direction, shape, …; the direction words people type work too: fromBottom, upRight) and the text build (asOne, byParagraph, byWord, byLetter) of the animation at `index` (else the selected shapes' animations).",
      params: s.object({option: s.optional(s.string({max: 40})), textBuild: s.optional(s.enum(TEXT_BUILDS)), index: idx, ids}),
      state(ctx, p) {
        const st = hasSlide(ctx);
        if (!st.enabled) return st;
        const cur = currentAnimation(ctx);
        if (!cur) return {enabled: false, reason: 'select an animated object first'};
        if (p?.textBuild) return {enabled: true, checked: (cur.anim.textBuild ?? 'asOne') === p.textBuild};
        return {enabled: true, value: animationOptionRows(cur.anim)};
      },
      run(ctx, p) {
        return eachTarget(ctx, p, 'animation.options', a => {
          if (p.option !== undefined) {
            // Each target takes the option in its own effect's terms; one it has no such option for keeps its own.
            const allowed = animationInfo(a.effect, a.class)?.[5] ?? [];
            const o = resolveOption(allowed, p.option);
            if (o !== null) { if (a.class === 'path') a.path = defaultPath(a.effect, o); a.option = o; }
          }
          if (p.textBuild !== undefined) a.textBuild = p.textBuild;
          return a;
        });
      },
    },
    {
      id: 'animation.clear', label: 'Remove All Animations', risk: 'destructive',
      description: 'Remove All Animations: clear every animation of the slide at `index` (default: the current slide).',
      params: s.object({index: s.optional(s.integer({min: 0, max: 5000}))}),
      state: hasSlide,
      summary: (ctx, p) => `Remove every animation from slide ${(p?.index ?? selectionOf(ctx).slideIndex) + 1}`,
      run(ctx, p) {
        v2('animation.clear', ctx);
        const i = usizeParam(p, 'index') ?? selectionOf(ctx).slideIndex;
        if (slidesOf(ctx.doc)[i]) ctx.change.set(['slides', i, 'animations'], []);
        forgetPick(ctx);
        return {};
      },
    },
    {
      id: 'animation.painter', label: 'Animation Painter', risk: 'read', effect: 'view', shortcut: 'Alt+Shift+C',
      description: "Animation Painter (Animations › Advanced Animation): pick the animations of the selected (or `id`) shape to paint onto other shapes; `sticky` keeps it on. Clicking it again with it on turns it off.",
      params: s.object({sticky: s.optional(s.boolean()), id: s.optional(s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]))}),
      state(ctx) {
        const st = hasSelection(ctx);
        return st.enabled ? {enabled: true, checked: !!ctx.view?.animPainter} : st;
      },
      run(ctx, p) {
        v2('animation.painter', ctx);
        if (ctx.view?.animPainter && p.id === undefined && p.sticky === undefined) { ctx.setView({animPainter: null}); return {armed: false}; }
        const id = idParam(p, 'id', 'animation.painter') ?? selectedShapeIds(ctx.doc, ctx.selection)[0];
        if (id === undefined) throw bad('animation.painter', 'select an animated shape first');
        const anims = animsOf(sl(ctx, 'animation.painter')).filter(a => a.shape === id).map(a => structuredClone(a));
        if (!anims.length) throw bad('animation.painter', `shape ${id} has no animations to copy`);
        ctx.setView({animPainter: {anims, sticky: !!p.sticky}});
        return {armed: true, count: anims.length};
      },
    },
    {
      id: 'animation.painterApply', label: 'Apply Animation', risk: 'edit', shortcut: 'Alt+Shift+V',
      description: "Apply Animation: paint the picked animations onto the selected shapes (or `ids`), replacing those shapes' own; an effect on a paragraph the target lacks animates the whole shape.",
      params: s.object({ids}),
      state: hasSelection,
      run(ctx, p) {
        v2('animation.painterApply', ctx);
        const armed = ctx.view?.animPainter;
        if (!armed) throw bad('animation.painterApply', 'pick animations with the Animation Painter first');
        if (!armed.sticky) ctx.setView({animPainter: null});
        const sel = targets(ctx, p, 'animation.painterApply');
        if (!sel.length) throw bad('animation.painterApply', 'no target shapes selected');
        const slide = sl(ctx, 'animation.painterApply');
        const out = animsOf(slide).filter(a => !sel.includes(a.shape));
        let added = 0;
        for (const id of sel) {
          const paras = findShape(slide.shapes, id)?.text?.paragraphs?.length ?? 0;
          for (const a of armed.anims) {
            const c = {...structuredClone(a), shape: id};
            if (c.paragraph !== null && c.paragraph !== undefined && c.paragraph >= paras) c.paragraph = null;
            out.push(c); added += 1;
          }
        }
        setAnims(ctx, out);
        forgetPick(ctx);
        return {applied: added};
      },
    },
    {
      id: 'animation.pick', label: 'Select Animation', risk: 'read', effect: 'view',
      description: "Animation Pane: click a row. Selects the animation's shape and remembers the row: Play From starts there, and Start, Duration, Delay, Effect Options and Reorder act on it.",
      params: s.object({index: s.integer({min: 0, max: 100_000})}),
      state: hasSlide,
      run(ctx, p) {
        v2('animation.pick', ctx);
        const slide = sl(ctx, 'animation.pick');
        const a = animsOf(slide)[p.index];
        if (!a) throw bad('animation.pick', 'no such animation', {path: '/index'});
        selectShapeIds(ctx, slide.id, [a.shape]);
        ctx.setView({animIndex: p.index});
        return {shape: a.shape};
      },
    },
    {
      id: 'animation.preview', label: 'Preview Animations', risk: 'read', effect: 'view',
      description: "Preview (Animations › Preview, Animation Pane › Play): play the current slide's animations on the slide. {on?: bool (false stops), from?: effect index (Play From)}.",
      params: s.object({on: s.optional(s.boolean()), from: s.optional(s.integer({min: 0, max: 100_000}))}),
      state(ctx) {
        const st = hasSlide(ctx);
        return st.enabled ? {enabled: true, checked: !!ctx.view?.animPreview?.on} : st;
      },
      run(ctx, p) {
        v2('animation.preview', ctx);
        const was = ctx.view?.animPreview;
        const on = p.on ?? !was?.on;
        ctx.setView({animPreview: {on, from: on && p.from !== undefined ? p.from : null, n: (was?.n ?? 0) + 1}});
        return {on};
      },
    },
    {
      id: 'animation.pane', label: 'Animation Pane', risk: 'read', effect: 'view',
      description: 'Animation Pane (Animations › Advanced Animation): show or hide the pane listing the effects of the slide with their timing bars; without `on` it toggles. The surface opens or closes the pane; `view.panes.animation` mirrors whether it is open.',
      params: s.object({on: s.optional(s.boolean()), mirror: s.optional(s.boolean({description: 'the surface reporting a pane the person closed or opened itself'}))}),
      state: ctx => ({enabled: true, checked: !!ctx.view?.panes?.animation}),
      run(ctx, p) {
        v2('animation.pane', ctx);
        const on = p.on ?? !ctx.view?.panes?.animation;
        ctx.setView({panes: {...(ctx.view?.panes ?? {}), animation: on}, ...(p.mirror ? {} : {paneRequest: {pane: 'animation', on, n: (ctx.view?.paneRequest?.n ?? 0) + 1}})});
        return {on};
      },
    },
    {
      id: 'animation.list', label: 'Animation Gallery', risk: 'read', effect: 'view',
      description: 'Query: the animation gallery [{id, label, class, preset, durationMs, options}].',
      params: s.object({}),
      state: always,
      run() { return animationList().map(a => ({...a, options: [...a.options]})); },
    },
    {
      id: 'animation.get', label: 'Animations on Slide', risk: 'read', effect: 'view',
      description: 'Query: the animations of the slide at `slide` (default: the current one), in the Animation Pane\'s order.',
      params: s.object({slide: s.optional(s.integer({min: 0, max: 5000}))}),
      state: hasSlide,
      run(ctx, p) {
        v2('animation.get', ctx);
        const i = usizeParam(p, 'slide') ?? selectionOf(ctx).slideIndex;
        const slide = slidesOf(ctx.doc)[i];
        if (!slide) throw bad('animation.get', 'no such slide', {path: '/slide'});
        return structuredClone(animsOf(slide));
      },
    },
  ],
});
