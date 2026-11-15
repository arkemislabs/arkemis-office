// Format: Home › Basic Text character formatting (U:slate/format).
//
// Slate has no ArtCraft upstream: ids, args and summaries are docs/spec/slate.json `format.*`
// (sourceRef core/slate-format.mjs); behaviour is OneNote's Home › Basic Text group:
//   * Font / Font Size boxes set the face and size of the selection (OneNote's default text is
//     Calibri 11 pt); Grow/Shrink Font (Ctrl+Shift+> / <) step every run through Office's size
//     list 8 9 10 11 12 14 16 18 20 22 24 26 28 36 48 72, then by 10 pt up to 1638;
//   * Bold, Italic, Underline, Strikethrough, Subscript, Superscript toggle: on when any of the
//     selection lacks it, off when all of it has it; subscript and superscript exclude each other;
//   * Text Highlight Color (Ctrl+Alt+H, yellow by default; No Color clears) and Font Color
//     (Automatic clears the colour);
//   * Clear All Formatting (Ctrl+Shift+N) removes character formatting and returns the
//     paragraphs to the Normal style;
//   * with a caret inside a word the word is formatted, as OneNote does.
// Edits are ProseMirror transforms on the page body (core/slate/lib/format-text.mjs).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {schema} from '../schema.mjs';
import {charRange, editPage, inlineSegments, markAttr, markState, needRange, setTextStyle, textRange, textState, textblocksIn} from '../lib/format-text.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/format.*', 'core/slate-format.mjs']};

export const DEFAULT_FONT = 'Calibri';
export const DEFAULT_SIZE = 11;
/** Office's Grow/Shrink Font list (pt); past 72 the step is 10 pt, up to 1638. */
export const FONT_SIZES = Object.freeze([8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]);
export const MAX_SIZE = 1638;
/** Point sizes of OneNote's paragraph styles (Normal and Page Title differ; the rest as Heading 1–6 etc.). */
export const STYLE_SIZES = Object.freeze({normal: 11, h1: 16, h2: 13.5, h3: 12, h4: 12, h5: 11, h6: 11, pageTitle: 20, citation: 9, quote: 11, code: 10});

/** Next size up: below 8 pt by 1 pt, then the list, past 72 to the next multiple of 10 (max 1638). */
export function growSize(pt) {
  if (pt < 8) return Math.min(8, Math.floor(pt) + 1);
  if (pt >= 72) return Math.min(MAX_SIZE, Math.floor(pt / 10) * 10 + 10);
  return FONT_SIZES.find(x => x > pt);
}
/** Next size down: past 72 to the previous multiple of 10 (not below 72), then the list, below 8 pt by 1 pt (min 1). */
export function shrinkSize(pt) {
  if (pt > 72) return Math.max(72, Math.ceil(pt / 10) * 10 - 10);
  if (pt <= 8) return Math.max(1, Math.ceil(pt) - 1);
  return [...FONT_SIZES].reverse().find(x => x < pt);
}

/** The range character formatting acts on, or a result saying there is none (a caret between words). */
function target(ctx) {
  const range = needRange(ctx);
  const r = charRange(range);
  return {range, r};
}

/** Font size of an inline node: its textStyle size, else its paragraph style's size. */
function sizeAt(doc, pos, node) {
  const own = schema.marks.textStyle.isInSet(node.marks)?.attrs.fontSize;
  if (own) return own;
  const style = doc.resolve(pos).parent.attrs?.style ?? 'normal';
  return STYLE_SIZES[style] ?? DEFAULT_SIZE;
}

const toggle = (id, label, mark, shortcut, extra = {}) => ({
  id, label, shortcut, risk: 'edit',
  description: `Toggle ${label.toLowerCase()} on the selected text (a caret formats the word it is in).`,
  params: s.object({value: s.optional(s.boolean({description: 'Turn it on (true) or off (false) instead of toggling'}))}),
  state(ctx) {
    const range = textRange(ctx);
    if (!range) return textState(ctx);
    const r = charRange(range) ?? range;
    return {enabled: true, checked: markState(range.doc, r.from, r.to, schema.marks[mark])};
  },
  run(ctx, p) {
    const {range, r} = target(ctx);
    if (!r) return {changed: 0, value: null, reason: 'The caret is not in a word'};
    const type = schema.marks[mark];
    const on = p.value ?? markState(range.doc, r.from, r.to, type) !== true;
    editPage(ctx, range.pageId, tr => {
      if (on) {
        for (const ex of extra.excludes ?? []) tr.removeMark(r.from, r.to, schema.marks[ex]);
        tr.addMark(r.from, r.to, type.create());
      } else tr.removeMark(r.from, r.to, type);
    }, range.doc);
    return {changed: r.to - r.from, value: on};
  },
});

const colorParam = s.string({pattern: '^#[0-9a-fA-F]{6}$', description: '#RRGGBB'});

export default defineCommands({
  family: 'format',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'format.fontFamily', label: 'Font', risk: 'edit',
      description: 'Set the font family of the selection.',
      params: s.object({family: s.string({min: 1, max: 120, trim: true, description: 'Font name, e.g. Calibri'})}),
      state(ctx) {
        const range = textRange(ctx);
        if (!range) return textState(ctx);
        const r = charRange(range) ?? range;
        const values = new Set(inlineSegments(range.doc, r.from, Math.max(r.to, r.from)).map(sg => schema.marks.textStyle.isInSet(sg.marks)?.attrs.fontFamily ?? DEFAULT_FONT));
        const value = r.from === r.to ? markAttr(range.doc, r.from, r.to, schema.marks.textStyle, 'fontFamily') ?? DEFAULT_FONT : values.size > 1 ? null : [...values][0] ?? DEFAULT_FONT;
        return {enabled: true, value};
      },
      run(ctx, p) {
        const {range, r} = target(ctx);
        if (!r) return {changed: 0, reason: 'The caret is not in a word'};
        const family = p.family === DEFAULT_FONT ? null : p.family;
        editPage(ctx, range.pageId, tr => setTextStyle(tr, r.from, r.to, {fontFamily: family}), range.doc);
        return {changed: r.to - r.from, family: p.family};
      },
    },
    {
      id: 'format.fontSize', label: 'Font Size', risk: 'edit',
      description: 'Set the font size of the selection in points (1–1638, half points allowed).',
      params: s.object({points: s.number({min: 1, max: MAX_SIZE, description: 'Size in points'})}),
      state(ctx) {
        const range = textRange(ctx);
        if (!range) return textState(ctx);
        const r = charRange(range) ?? range;
        if (r.from === r.to) {
          const $p = range.doc.resolve(r.from);
          const own = schema.marks.textStyle.isInSet($p.marks())?.attrs.fontSize;
          return {enabled: true, value: own ?? STYLE_SIZES[$p.parent.attrs?.style] ?? DEFAULT_SIZE};
        }
        const sizes = new Set(inlineSegments(range.doc, r.from, r.to).map(sg => sizeAt(range.doc, sg.from, sg.node)));
        return {enabled: true, value: sizes.size === 1 ? [...sizes][0] : null};
      },
      run(ctx, p) {
        const {range, r} = target(ctx);
        if (!r) return {changed: 0, reason: 'The caret is not in a word'};
        const pt = Math.round(p.points * 2) / 2;
        editPage(ctx, range.pageId, tr => setTextStyle(tr, r.from, r.to, {fontSize: pt}), range.doc);
        return {changed: r.to - r.from, points: pt};
      },
    },
    ...[['format.growFont', 'Grow Font', 'Mod+Shift+.', growSize, 'Increase'], ['format.shrinkFont', 'Shrink Font', 'Mod+Shift+,', shrinkSize, 'Decrease']].map(([id, label, shortcut, step, verb]) => ({
      id, label, shortcut, risk: 'edit',
      description: `${verb} the font size of every run in the selection to the ${verb === 'Increase' ? 'next' : 'previous'} size in the list.`,
      params: s.object({}),
      state: textState,
      run(ctx) {
        const {range, r} = target(ctx);
        if (!r) return {changed: 0, reason: 'The caret is not in a word'};
        const segs = inlineSegments(range.doc, r.from, r.to).map(sg => ({...sg, size: step(sizeAt(range.doc, sg.from, sg.node))}));
        editPage(ctx, range.pageId, tr => { for (const sg of segs) setTextStyle(tr, sg.from, sg.to, {fontSize: sg.size}); }, range.doc);
        return {changed: r.to - r.from, sizes: [...new Set(segs.map(sg => sg.size))]};
      },
    })),
    toggle('format.bold', 'Bold', 'bold', 'Mod+B'),
    toggle('format.italic', 'Italic', 'italic', 'Mod+I'),
    toggle('format.underline', 'Underline', 'underline', 'Mod+U'),
    toggle('format.strikethrough', 'Strikethrough', 'strike', 'Mod+-'),
    toggle('format.subscript', 'Subscript', 'subscript', 'Mod+=', {excludes: ['superscript']}),
    toggle('format.superscript', 'Superscript', 'superscript', 'Mod+Shift+=', {excludes: ['subscript']}),
    {
      id: 'format.highlight', label: 'Text Highlight Color', shortcut: 'Mod+Alt+H', risk: 'edit',
      description: 'Highlight the selected text in a colour (default yellow); null (No Color) removes the highlight.',
      params: s.object({color: s.optional(s.nullable(colorParam))}),
      state(ctx) {
        const range = textRange(ctx);
        if (!range) return textState(ctx);
        const r = charRange(range) ?? range;
        return {enabled: true, value: markAttr(range.doc, r.from, r.to, schema.marks.highlight, 'color')};
      },
      run(ctx, p) {
        const {range, r} = target(ctx);
        if (!r) return {changed: 0, reason: 'The caret is not in a word'};
        const color = p.color === undefined ? '#ffff00' : p.color === null ? null : p.color.toLowerCase();
        const type = schema.marks.highlight;
        editPage(ctx, range.pageId, tr => {
          tr.removeMark(r.from, r.to, type);
          if (color) tr.addMark(r.from, r.to, type.create({color}));
        }, range.doc);
        return {changed: r.to - r.from, color};
      },
    },
    {
      id: 'format.fontColor', label: 'Font Color', risk: 'edit', dialog: 'dialog.colors',
      description: 'Set the colour of the selected text; "auto" (Automatic) returns it to the default colour.',
      params: s.object({color: s.union([colorParam, s.literal('auto')], {description: '#RRGGBB or auto'})}),
      state(ctx) {
        const range = textRange(ctx);
        if (!range) return textState(ctx);
        const r = charRange(range) ?? range;
        return {enabled: true, value: markAttr(range.doc, r.from, r.to, schema.marks.textStyle, 'color') ?? 'auto'};
      },
      run(ctx, p) {
        const {range, r} = target(ctx);
        if (!r) return {changed: 0, reason: 'The caret is not in a word'};
        const color = p.color === 'auto' ? null : p.color.toLowerCase();
        editPage(ctx, range.pageId, tr => setTextStyle(tr, r.from, r.to, {color}), range.doc);
        return {changed: r.to - r.from, color: color ?? 'auto'};
      },
    },
    {
      id: 'format.clear', label: 'Clear All Formatting', shortcut: 'Mod+Shift+N', risk: 'edit',
      description: 'Remove character formatting from the selection and return its paragraphs to the Normal style.',
      params: s.object({}),
      state: textState,
      run(ctx) {
        const range = needRange(ctx);
        // OneNote clears the whole paragraph at a caret (Ctrl+Shift+N works on the paragraph).
        const blocks = textblocksIn(range.doc, range.from, range.to);
        if (!blocks.length) throw new CommandError('disabled', 'There is no text to clear');
        const from = range.from === range.to ? blocks[0].pos + 1 : range.from;
        const to = range.from === range.to ? blocks[0].pos + 1 + blocks[0].node.content.size : range.to;
        const keep = new Set(['link']);
        const tr = editPage(ctx, range.pageId, t => {
          for (const name of Object.keys(schema.marks)) if (!keep.has(name)) t.removeMark(from, to, schema.marks[name]);
          for (const b of blocks) {
            if (b.node.type.name !== 'paragraph') continue;
            if (b.node.attrs.style !== 'normal') t.setNodeAttribute(b.pos, 'style', 'normal');
          }
        }, range.doc);
        if (!tr) throw new CommandError('failed', 'The selection has no formatting to clear');
        return {paragraphs: blocks.length};
      },
    },
  ],
});
