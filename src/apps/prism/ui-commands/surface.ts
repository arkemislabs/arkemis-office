// The slide canvas's pointer gestures as one command (F:prism foundation; docs/architecture.md 4.4).
//
// deckcraft drives every pointer tool through `Session::pointer(PointerEvent)`, from the canvas,
// its control channel (`ui.pointer {events}`) and MCP (`pointer`) alike, and each finished gesture
// is one undo step (crates/engine/src/tools.rs, tools/pointer.rs; crates/ui-egui/src/control.rs
// `ui.pointer`; crates/mcp/src/tools.rs `pointer`, at f893f6af7d36a5409fd804e81a34fd895cfefedf).
// `surface.pointer` is that entry point: the events of one gesture (press, drags, release; a
// double, triple or right click) in slide points replay through the translated tools
// (core/prism/lib/pointer.mjs) inside one kernel transaction. Selecting, moving, resizing,
// rotating, adjusting, duplicating with Alt, marquee selection, placing the caret, drawing shapes,
// text boxes, freeforms and ink all arrive here; steps deckcraft runs as commands (text.edit,
// shape.insert, guide.move, ...) run through ctx.run, so they are their families' own code.

import {defineCommands} from '../../../../core/kernel/command.mjs';
import {s} from '../../../../core/kernel/schema.mjs';
import {CommandError} from '../../../../core/kernel/errors.mjs';
import {runGesture, POINTER_KINDS} from '../../../../core/prism/lib/pointer.mjs';
import {isSchema2} from '../../../../core/prism/model/doc.mjs';
import {measure as measureText, metrics as fontMetrics} from '../surface/measure.mjs';

const UPSTREAM = {repo: 'deckcraft' as const, commit: 'f893f6af7d36a5409fd804e81a34fd895cfefedf',
  files: ['crates/engine/src/tools.rs', 'crates/engine/src/tools/pointer.rs', 'crates/ui-egui/src/control.rs']};

const coord = s.number({min: -1e6, max: 1e6, description: 'Slide points from the top left'});
const event = s.object({
  kind: s.enum(POINTER_KINDS as unknown as string[], {description: 'down, drag, up, move, doubleClick, tripleClick or contextClick'}),
  x: coord, y: coord,
  mods: s.optional(s.object({shift: s.optional(s.boolean()), alt: s.optional(s.boolean()), cmd: s.optional(s.boolean({description: 'Ctrl (Cmd on macOS)'}))})),
  pressure: s.optional(s.number({min: 0, max: 1})),
});

/**
 * Text metrics for caret placement: the canvas's own (src/apps/prism/surface/measure.ts, the font
 * stack the slide is drawn with) in the window; in a test session without a DOM, the host's
 * measureText or the layout's default.
 */
function measureFrom(ctx: any) {
  if (typeof document !== 'undefined') return {measure: (f: any, t: string) => measureText(f, t), metrics: (f: any) => fontMetrics(f)};
  const m = ctx.host?.measureText;
  if (typeof m !== 'function') return {measure: undefined, metrics: undefined};
  const spec = (f: any) => ({family: f.family, size: f.size, weight: f.bold ? 700 : 400, style: f.italic ? 'italic' : 'normal'});
  return {measure: (f: any, t: string) => Number(m(spec(f), t)?.width ?? 0), metrics: undefined};
}

export default defineCommands({
  family: 'surface',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'surface.pointer', label: 'Pointer', risk: 'edit', needs: 'view', repeatable: false,
      description: 'Drive the active tool with the pointer events of one gesture, in slide points (down/drag/up, doubleClick, tripleClick, contextClick): selects, moves, resizes, rotates, adjusts, draws and places the caret exactly like the mouse. One gesture is one undo step.',
      params: s.object({
        events: s.array(event, {min: 1, max: 5000}),
        tol: s.optional(s.number({min: 0.01, max: 200, description: 'Hit tolerance in points (about 4 screen pixels at the current zoom; default 4)'})),
      }),
      state(ctx: any) {
        if (!isSchema2(ctx.doc)) return {enabled: false, reason: 'no presentation open'};
        return ctx.doc.slides.length ? {enabled: true} : {enabled: false, reason: 'no slides'};
      },
      run(ctx: any, p: any) {
        if (!isSchema2(ctx.doc)) throw new CommandError('disabled', 'no presentation open');
        const {measure, metrics} = measureFrom(ctx);
        const out = runGesture(ctx, {events: p.events, tol: p.tol ?? 4, measure, metrics});
        return {results: out.results, label: out.label, skipped: out.deferred, ui: out.ui};
      },
    },
  ],
});
