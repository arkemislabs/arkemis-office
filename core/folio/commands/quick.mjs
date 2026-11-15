// The quick bar's property controls: the comment tool's Color, Fill colour, Opacity and Line thickness, and Fill & Sign's
// Font size.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/tools/comments/menu.rs:288-345   quick_bar_controls: the controls for the tool in use; they change that
//                                                       tool's default style (CommentPrefs set_color, set_fill, set_opacity, set_width)
//   crates/ui-egui/src/tools/comments.rs:204-243        which tools have a fill (rectangle, oval, polygon, cloud, text box, callout) and a
//                                                       thickness (the drawing tools, the point tools, text box, callout), the thinnest allowed
//   crates/ui-egui/src/canvas/bars.rs:470-495           a colour picked changes the selected comment too when the tool made it
//   crates/ui-egui/src/canvas/bars.rs:423-458           Fill & Sign's Font size (fill_text_size, MIN_TEXT_SIZE..MAX_TEXT_SIZE): the next text
//                                                       added, and the Fill & Sign text selected (#1274)
// "Keep tool selected" (the pin) is not here: the page view here has no one-shot comment tools to pin (docs/spec/patches/folio/tools.json).
//
// A tool's saved look lives in `prefs.commentStyles[tool]` (the Comment properties dialog's Make Current Properties Default writes the same).
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/quick.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {annotateState, meta, toolStyle} from '../model/index.mjs';
import {commentAt} from '../lib/comment-geometry.mjs';
import {setStyle, setFontSize, isLocked, summaries} from '../model/annots.mjs';
import {MIN_TEXT_SIZE, MAX_TEXT_SIZE, TEXT_SIZE} from '../lib/sign-fill.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/tools/comments/menu.rs', 'crates/ui-egui/src/tools/comments.rs',
  'crates/ui-egui/src/canvas/bars.rs']};

/** The sample shape of each comment tool, for its default style (comments.rs CommentTool::sample). */
const SAMPLE = {
  'comment.note': {kind: 'Note'}, 'comment.freetext': {kind: 'TextBox'}, 'comment.callout': {kind: 'Callout'},
  'comment.highlight': {kind: 'TextMarkup', markup: 'Highlight'}, 'comment.underline': {kind: 'TextMarkup', markup: 'Underline'},
  'comment.strikeout': {kind: 'TextMarkup', markup: 'StrikeOut'}, 'comment.squiggly': {kind: 'TextMarkup', markup: 'Squiggly'},
  'comment.ink': {kind: 'Ink'}, 'comment.line': {kind: 'Line'}, 'comment.arrow': {kind: 'Line'}, 'comment.square': {kind: 'Rectangle'},
  'comment.circle': {kind: 'Oval'}, 'comment.polygon': {kind: 'Polygon'}, 'comment.polyline': {kind: 'PolyLine'}, 'comment.cloud': {kind: 'Polygon'},
  'comment.caret': {kind: 'Caret'}, 'comment.replace': {kind: 'TextMarkup', markup: 'StrikeOut'}, 'comment.attach': {kind: 'Attachment'},
  'comment.eraser': {kind: 'Ink'},
};
export const COMMENT_TOOLS = Object.keys(SAMPLE);
/** comments.rs has_fill. */
export const hasFill = tool => ['comment.square', 'comment.circle', 'comment.polygon', 'comment.cloud', 'comment.freetext', 'comment.callout'].includes(tool);
/** comments.rs has_width: draws, clicks_points, TextBox, Callout. */
export const hasWidth = tool => ['comment.ink', 'comment.line', 'comment.arrow', 'comment.square', 'comment.circle', 'comment.eraser', 'comment.polygon', 'comment.polyline',
  'comment.cloud', 'comment.freetext', 'comment.callout'].includes(tool);
/** comments.rs min_width: a text box or callout may have no border. */
const minWidth = tool => (tool === 'comment.freetext' || tool === 'comment.callout' ? 0 : 0.5);

/** The comment tool in use (the view's tool), or null. */
const toolOf = ctx => (COMMENT_TOOLS.includes(ctx.view?.tool) ? ctx.view.tool : null);
const noTool = {enabled: false, reason: 'pick a comment tool first'};

/** The tool's style as the quick bar shows it: its default with the person's saved changes. */
export const styleOf = (ctx, tool) => toolStyle(ctx, tool, SAMPLE[tool]);

/** Control state of a comment tool property: needs a comment tool, and one the property applies to. */
function propertyState(ctx, applies, read) {
  if (!Array.isArray(ctx.doc?.pages) || !ctx.doc.pages.length) return {enabled: false, reason: 'no PDF open'};
  const tool = toolOf(ctx);
  if (!tool) return {...noTool, hidden: true};
  if (!applies(tool)) return {enabled: false, hidden: true, reason: 'this tool has no such property'};
  return {enabled: true, value: read(styleOf(ctx, tool), tool)};
}

/** A colour as the [r, g, b] 0–1 triple the model keeps. */
const triple = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v / 255);
};
const hexOf = c => `#${c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

export default defineCommands({
  family: 'quick',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'comment.tool_style', label: 'Comment tool properties', risk: 'edit', effect: 'prefs', undo: 'auto', scope: 'app',
      description: 'The comment tool in use (or `tool`): change its color, fill color (null: no fill), opacity (10–100 %) or line thickness; the next comments it makes look so, and a color also recolors the selected comment when this tool made it (the quick bar\'s controls).',
      params: s.object({
        tool: s.optional(s.enum(COMMENT_TOOLS)),
        color: s.optional(s.color()), fill: s.optional(s.nullable(s.color())),
        opacityPercent: s.optional(s.number({min: 10, max: 100, description: 'Opacity in percent, 10–100'})),
        width: s.optional(s.number({min: 0, max: 12, description: 'Line thickness in points (0.5–12; a text box or callout may have none)'})),
      }),
      state: ctx => { const st = annotateState(ctx.doc ?? {}); return st.enabled ? (toolOf(ctx) ? st : noTool) : st; },
      run(ctx, p) {
        const tool = p.tool ?? toolOf(ctx);
        if (!tool) throw new CommandError('disabled', noTool.reason);
        if (p.color == null && p.fill === undefined && p.opacityPercent == null && p.width == null) throw new CommandError('invalid_params', 'give a colour, fill, opacity or width');
        if (p.fill !== undefined && !hasFill(tool)) throw new CommandError('invalid_params', 'this tool has no fill', {path: '/fill'});
        if (p.width != null && !hasWidth(tool)) throw new CommandError('invalid_params', 'this tool has no line thickness', {path: '/width'});
        const was = styleOf(ctx, tool);
        const saved = {color: was.color, opacity: was.opacity, ...(hasWidth(tool) ? {width: was.width} : {}), fill: was.fill};
        if (p.color != null) saved.color = triple(p.color) ?? saved.color;
        if (p.fill !== undefined) saved.fill = p.fill ? triple(p.fill) : null;
        if (p.opacityPercent != null) saved.opacity = Math.min(1, Math.max(0.1, Math.round(p.opacityPercent / 5) * 5 / 100));
        if (p.width != null) saved.width = Math.min(12, Math.max(minWidth(tool), p.width));
        ctx.updatePrefs({commentStyles: {...(ctx.prefs?.commentStyles ?? {}), [tool]: saved}});
        const out = {tool, color: hexOf(saved.color), fill: saved.fill ? hexOf(saved.fill) : null, opacityPercent: Math.round(saved.opacity * 100), width: saved.width ?? null};
        // A colour picked also recolours the selected comment, when the tool in use made it and it is not locked (bars.rs:470-495).
        if (p.color != null) {
          try {
            const t = commentAt(ctx);
            if (!isLocked(t.record) && summaryOf(t)?.tool === tool) {
              ctx.change.set(['pages', t.pi, 'annots', t.index], setStyle(t.record, {color: saved.color, opacity: null, width: null, endings: null}, meta(ctx)));
              ctx.setUndoLabel('Change comment colour');
              out.recoloured = true;
            }
          } catch { /* nothing selected */ }
        }
        return out;
      },
    },
    {
      id: 'sign.fill.text_size', label: 'Fill & Sign font size', risk: 'edit', effect: 'prefs', undo: 'auto', scope: 'app',
      description: 'The size of the next Fill & Sign text or date, in points (4–300); the Fill & Sign text selected takes it too (#1274).',
      params: s.object({size: s.number({min: MIN_TEXT_SIZE, max: MAX_TEXT_SIZE})}),
      state: ctx => {
        if (!Array.isArray(ctx.doc?.pages) || !ctx.doc.pages.length) return {enabled: false, reason: 'no PDF open'};
        const tool = ctx.view?.tool;
        if (tool !== 'sign.fill.text' && tool !== 'sign.fill.date') return {enabled: false, hidden: true, reason: 'pick Fill & Sign text or date first'};
        return {enabled: true, value: ctx.prefs?.fillSign?.textSize ?? TEXT_SIZE};
      },
      run(ctx, p) {
        const size = Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, p.size));
        ctx.updatePrefs({fillSign: {...(ctx.prefs?.fillSign ?? {}), textSize: size}});
        const out = {size};
        try {
          const t = commentAt(ctx);
          const sm = summaryOf(t);
          if (!isLocked(t.record) && sm?.fillSign && sm.subtype === 'FreeText' && annotateState(ctx.doc).enabled) {
            ctx.change.set(['pages', t.pi, 'annots', t.index], setFontSize(t.record, size, meta(ctx)));
            ctx.setUndoLabel('Change text size');
            out.resized = true;
          }
        } catch { /* nothing selected */ }
        return out;
      },
    },
    // The controls' states (the chrome shows a property only when it applies to the tool in use).
    ...[
      ['comment.tool_color', 'Color', () => true, st => hexOf(st.color)],
      ['comment.tool_fill', 'Fill colour', hasFill, st => (st.fill ? hexOf(st.fill) : null)],
      ['comment.tool_opacity', 'Opacity', () => true, st => Math.round(st.opacity * 100)],
      ['comment.tool_width', 'Line thickness', hasWidth, st => st.width],
    ].map(([id, label, applies, read]) => ({
      id, label, risk: 'edit', effect: 'prefs', undo: 'auto', scope: 'app',
      description: `${label} of the comment tool in use (the quick bar's control); the same as comment.tool_style with that one property.`,
      params: id === 'comment.tool_color' ? s.object({color: s.color()}) : id === 'comment.tool_fill' ? s.object({fill: s.nullable(s.color())})
        : id === 'comment.tool_opacity' ? s.object({percent: s.number({min: 10, max: 100})}) : s.object({width: s.number({min: 0, max: 12})}),
      state: ctx => propertyState(ctx, applies, read),
      async run(ctx, p) {
        const params = id === 'comment.tool_opacity' ? {opacityPercent: p.percent} : p;
        return ctx.run('comment.tool_style', params);
      },
    })),
  ],
});

/** The tool that makes comments like this record, and whether it is Fill & Sign text (annots.mjs summaries). */
function summaryOf(t) { return summaries({pages: [{...t.page, annots: [t.record]}]})[0] ?? null; }
