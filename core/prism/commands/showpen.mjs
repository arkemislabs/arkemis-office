// The pointers of a running slide show: Arrow, Laser Pointer, Pen, Highlighter, Eraser, Erase All Ink on
// Slide, and keeping the ink drawn in the show when it ends.
//
// deckcraft (crates/ui-egui/src/show.rs `set_pen`, `set_laser`, `set_arrow`, show/keys.rs, show/ui.rs
// `draw_pen_and_hints`, at f893f6af7d36a5409fd804e81a34fd895cfefedf) has Ctrl+P (pen), Ctrl+L (laser pointer),
// Ctrl+A (arrow), E (erase the ink), the pen drawn in `doc.show.pen_color` and the laser dot (16 pt halo, 5.5 pt
// dot) in `doc.show.laser_color`; the colours are Set Up Show's Pen color and Laser pointer color
// (`show.setup {penColor, laserColor}`). The highlighter, the eraser and keeping the ink are PowerPoint's
// behaviour and not checked against upstream: the show ends with "Do you want to keep your ink annotations?"
// (Keep adds the strokes to each slide's ink layer, Discard drops them), and Discard is what show.end does.
// The show itself (src/apps/prism/show/ShowStage.tsx) draws and reads these; the commands say what to do (`showCmd`).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {isSchema2} from '../model/doc.mjs';
import {bad} from '../lib/text-session.mjs';
import {UPSTREAM_COMMIT, newId} from '../lib/shape-common.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/ui-egui/src/show.rs', 'crates/ui-egui/src/show/keys.rs', 'crates/ui-egui/src/show/ui.rs']};
const running = ctx => (ctx.view?.show ? {enabled: true} : {enabled: false, reason: 'no slide show is running'});
const pointerOf = ctx => ctx.view?.showStatus?.pointer ?? 'arrow';
const send = (ctx, kind, extra = {}) => { ctx.setView({showCmd: {kind, ...extra, n: (ctx.view?.showCmd?.n ?? 0) + 1}}); return {}; };

const POINTERS = [
  ['show.arrow', 'Arrow', 'arrow', 'Back to the arrow pointer (Ctrl+A).'],
  ['show.laser', 'Laser Pointer', 'laser', 'Toggles the laser pointer: a dot that follows the pointer and leaves no ink (Ctrl+L).'],
  ['show.pen', 'Pen', 'pen', 'Toggles the pen: drag to draw on the slide (Ctrl+P).'],
  ['show.highlighter', 'Highlighter', 'highlighter', 'Toggles the highlighter: a wide translucent yellow stroke (not checked against upstream).'],
  ['show.eraser', 'Eraser', 'eraser', 'Toggles the eraser: drag over ink to remove it (Ctrl+E, not checked against upstream).'],
];

const STROKE = s.object({
  points: s.array(s.array(s.number({min: -1e6, max: 1e6}), {min: 2, max: 3}), {min: 2, max: 20000}),
  color: s.optional(s.any()), width: s.optional(s.number({min: 0.1, max: 200})), highlighter: s.optional(s.boolean()),
});
const rgba = c => (c && Number.isInteger(c.r) && Number.isInteger(c.g) && Number.isInteger(c.b) ? {r: c.r, g: c.g, b: c.b, a: Number.isInteger(c.a) ? c.a : 255} : {r: 255, g: 0, b: 0, a: 255});

export default defineCommands({
  family: 'showpen',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    ...POINTERS.map(([id, label, kind, description]) => ({
      id, label, risk: 'read', effect: 'view', description: `${description} Acts on the running slide show.${kind === 'laser' ? ' x, y (slide points) put the laser dot there, as moving the pointer does.' : ''}`,
      params: kind === 'laser' ? s.object({x: s.optional(s.number({min: -1e6, max: 1e6})), y: s.optional(s.number({min: -1e6, max: 1e6}))}) : s.object({}),
      state: ctx => (ctx.view?.show ? {enabled: true, checked: pointerOf(ctx) === kind} : {enabled: false, reason: 'no slide show is running'}),
      run(ctx, p) { return send(ctx, id.slice(5), kind === 'laser' && p?.x !== undefined && p?.y !== undefined ? {at: [p.x, p.y]} : {}); },
    })),
    {
      id: 'show.stroke', label: 'Draw Stroke', risk: 'read', effect: 'view',
      description: 'Draws a stroke on the slide being shown as the pen (or, with highlighter: true, the highlighter) does when dragged: `points` is [[x, y], …] in slide points. Acts on the running slide show.',
      params: s.object({points: s.array(s.array(s.number({min: -1e6, max: 1e6}), {min: 2, max: 3}), {min: 2, max: 20000}), highlighter: s.optional(s.boolean())}), state: running,
      run(ctx, p) { return send(ctx, 'stroke', {points: p.points, highlighter: !!p.highlighter}); },
    },
    {
      id: 'show.pointerOptions', label: 'Pointer Options', risk: 'read', effect: 'view',
      description: 'Opens or closes the pointer menu of the running slide show (the toolbar pen button, a right click): Next, Previous, the pointers, Erase All Ink on Slide, the screens and End Show.',
      params: s.object({}), state: running,
      run(ctx) { return send(ctx, 'menu'); },
    },
    {
      id: 'show.eraseInk', label: 'Erase All Ink on Slide', risk: 'read', effect: 'view',
      description: 'Erase All Ink on Slide: take away everything drawn with the pen and highlighter on the slide being shown (E). Acts on the running slide show.',
      params: s.object({}), state: running,
      run(ctx) { return send(ctx, 'eraseInk'); },
    },
    {
      id: 'show.keepInk', label: 'Keep Ink Annotations', risk: 'read', effect: 'view',
      description: 'Answers "Do you want to keep your ink annotations?" at the end of a show that has ink: `discard: true` is Discard, otherwise Keep (the strokes join each slide\'s ink layer); `ask: true` only brings the question up, as ending the show does. Acts on the running slide show.',
      params: s.object({discard: s.optional(s.boolean()), ask: s.optional(s.boolean())}), state: running,
      run(ctx, p) { return send(ctx, p.ask ? 'askInk' : p.discard ? 'discardInk' : 'keepInk'); },
    },
    {
      id: 'show.addInk', label: 'Keep Ink', risk: 'edit',
      description: 'Internal: the ink drawn in the show joins the slides: `ink` is [{slide: index, strokes: [{points: [[x, y, pressure?]…] in slide points, color, width, highlighter}]}]; each slide has one ink layer.',
      params: s.object({ink: s.array(s.object({slide: s.integer({min: 0, max: 100000}), strokes: s.array(STROKE, {max: 10000})}), {max: 5000})}),
      state: ctx => (isSchema2(ctx.doc) && (ctx.doc.slides ?? []).length ? {enabled: true} : {enabled: false, reason: 'no slides'}),
      run(ctx, p) {
        if (!isSchema2(ctx.doc)) throw bad('show.addInk', 'needs a presentation (schema 2)');
        let added = 0;
        for (const {slide: i, strokes} of p.ink) {
          const sl = (ctx.doc.slides ?? [])[i];
          if (!sl || !strokes.length) continue;
          const made = strokes.map(k => ({points: k.points.map(([x, y, pr]) => [x, y, pr ?? 1]), color: rgba(k.color), width: k.width ?? (k.highlighter ? 18 : 2.25), highlighter: !!k.highlighter}));
          const at = (sl.shapes ?? []).findLastIndex(x => x.kind?.type === 'ink');
          if (at >= 0) ctx.change.set(['slides', i, 'shapes', at, 'kind', 'strokes'], [...(sl.shapes[at].kind.strokes ?? []), ...made]);
          else {
            const size = ctx.doc.slideSize ?? {width: 960, height: 540};
            const id = newId(ctx, 'show.addInk');
            ctx.change.splice(['slides', i, 'shapes'], (sl.shapes ?? []).length, 0, {id, name: 'Ink', xfrm: {x: 0, y: 0, w: size.width, h: size.height}, kind: {type: 'ink', strokes: made},
              geom: {kind: 'preset', name: 'rect'}, ph: null, fill: null, line: null, effects: null, style: null, text: null, hidden: false, locked: false, textBox: false, descr: '',
              title: '', decorative: false, click: null, hover: null});
          }
          added += made.length;
        }
        return {added};
      },
    },
  ],
});
