// Caret movement and selection (Navigation, Home › Editing › Select).
//
// Translated from wordcraft crates/engine/src/cmd/caret.rs (`specs`: caret.left … select.collapse)
// at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c. The semantics live in
// core/quill/lib/caret-moves.mjs. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// These commands change the selection and view state only (upstream marks them `pure`), so they
// are `risk: 'read'` with no undo step. Up/Down, Home/End, Page Up/Down and Select Line read the
// layout: the page view's own when it installs one, else the translated layout run here.
// Not translated (their controls stay hidden): select.column (Alt+drag column blocks),
// select.addObject / select.objects / select.similar, select.extend (F8 extend mode),
// caret.pastCitation, and visual (bidi) Left/Right inside right-to-left lines.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {open, finish, ready, posParam, storyParam, UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import * as M from '../lib/caret-moves.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/caret.rs', 'crates/engine/src/cmd/table/select.rs']};
const EXTEND = s.object({extend: s.optional(s.boolean({description: 'Extend the selection (Shift)'}))});
const POS = s.union([
  s.string({min: 1, max: 4096}),
  s.object({story: s.optional(s.any()), path: s.array(s.integer({min: 0}), {max: 64}), off: s.integer({min: 0})}),
  s.object({block: s.integer({min: 0}), off: s.optional(s.integer({min: 0}))}),
], {description: 'An address (/body/b:<id>/t:4), {story, path, off} or {block, off}'});
const STORY = s.optional(s.any({description: '"body" or {"part": n} (default: the caret\'s story)'}));

const nav = (id, label, description, f, extra = {}) => ({
  id, label, description, risk: 'read', effect: 'view', repeatable: false,
  params: EXTEND, state: ctx => ready(ctx),
  run(ctx, p) { const S = open(ctx); f(S, p, ctx); return finish(ctx, S); },
  ...extra,
});
const sel = (id, label, description, params, f, extra = {}) => ({
  id, label, description, risk: 'read', effect: 'view', repeatable: false,
  params, state: ctx => ready(ctx),
  run(ctx, p) { const S = open(ctx); f(S, p, ctx); return finish(ctx, S); },
  ...extra,
});
const ext = p => !!p.extend;

export default defineCommands({
  family: 'caret',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    nav('caret.left', 'Left', 'Move the caret one character left (Shift extends); a selection collapses to its edge.', (S, p) => M.lr(S, true, ext(p)), {shortcut: 'Left'}),
    nav('caret.right', 'Right', 'Move the caret one character right (Shift extends); a selection collapses to its edge.', (S, p) => M.lr(S, false, ext(p)), {shortcut: 'Right'}),
    nav('caret.up', 'Up', 'Move the caret up a line, keeping its column.', (S, p) => M.vert(S, -1, ext(p)), {shortcut: 'Up'}),
    nav('caret.down', 'Down', 'Move the caret down a line, keeping its column.', (S, p) => M.vert(S, 1, ext(p)), {shortcut: 'Down'}),
    nav('caret.wordLeft', 'Word Left', 'Move the caret to the start of the word (the previous word at a word start).', (S, p) => M.word(S, true, ext(p)),
      {shortcut: ['Mod+Left', 'Alt+Left']}),
    nav('caret.wordRight', 'Word Right', 'Move the caret past the end of the word.', (S, p) => M.word(S, false, ext(p)), {shortcut: ['Mod+Right', 'Alt+Right']}),
    nav('caret.home', 'Line Start', 'Move the caret to the start of its line.', (S, p) => M.line(S, true, ext(p)), {shortcut: 'Home'}),
    nav('caret.end', 'Line End', 'Move the caret to the end of its line.', (S, p) => M.line(S, false, ext(p)), {shortcut: 'End'}),
    nav('caret.paraUp', 'Paragraph Up', 'Move the caret to the start of the paragraph, or of the previous one.', (S, p) => M.mv(S, ext(p), M.paraUp),
      {shortcut: ['Mod+Up', 'Alt+Up']}),
    nav('caret.paraDown', 'Paragraph Down', 'Move the caret to the start of the next paragraph.', (S, p) => M.mv(S, ext(p), M.paraDown), {shortcut: ['Mod+Down', 'Alt+Down']}),
    nav('caret.docStart', 'Document Start', 'Move the caret to the start of the story.', (S, p) => M.mv(S, ext(p), T => T.d.startOf(T.sel.focus.story)), {shortcut: 'Mod+Home'}),
    nav('caret.docEnd', 'Document End', 'Move the caret to the end of the story.', (S, p) => M.mv(S, ext(p), T => T.d.endOf(T.sel.focus.story)), {shortcut: 'Mod+End'}),
    nav('caret.pageUp', 'Page Up', 'Move the caret to the same place on the previous page.', (S, p) => M.page(S, -1, ext(p)), {shortcut: 'PageUp'}),
    nav('caret.pageDown', 'Page Down', 'Move the caret to the same place on the next page.', (S, p) => M.page(S, 1, ext(p)), {shortcut: 'PageDown'}),
    sel('caret.set', 'Set Caret', 'Put the caret at a position, or at the text nearest a point on a page (page 0-based, x/y in points).',
      s.object({pos: s.optional(POS), extend: s.optional(s.boolean()), page: s.optional(s.integer({min: 0})), x: s.optional(s.number()), y: s.optional(s.number()), story: STORY}),
      (S, p, ctx) => M.setCaret(S, {...p, pos: posParam(ctx, p.pos, 'pos'), story: p.story === undefined ? undefined : storyParam(S, p)})),
    sel('select.all', 'Select All', 'Select the whole story the caret is in; inside a table the cell, then its row, then the table first (whole: the story at once).',
      s.object({whole: s.optional(s.boolean())}), (S, p) => M.selectAll(S, !!p.whole), {shortcut: 'Mod+A'}),
    sel('select.range', 'Select Range', 'Select from one position to another.', s.object({anchor: POS, focus: POS}),
      (S, p, ctx) => M.selectRange(S, posParam(ctx, p.anchor, 'anchor'), posParam(ctx, p.focus, 'focus'))),
    sel('select.word', 'Select Word', 'Select the word at the caret (a double-click).', s.object({}), S => M.selectUnit(S, 'word')),
    sel('select.sentence', 'Select Sentence', 'Select the sentence at the caret (Ctrl+click).', s.object({}), S => M.selectUnit(S, 'sentence')),
    sel('select.paragraph', 'Select Paragraph', 'Select the paragraph at the caret with its mark (a triple-click; with cell, the whole table cell on its last paragraph).',
      s.object({cell: s.optional(s.boolean())}), (S, p) => M.selectParagraph(S, !!p.cell)),
    sel('select.dragUnit', 'Extend Selection by Units', 'Grow a word, sentence, line or paragraph selection by whole units to a position (dragging after a double- or triple-click).',
      s.object({unit: s.enum(M.UNITS), start: POS, end: POS, pos: POS}),
      (S, p, ctx) => M.dragUnit(S, p.unit, posParam(ctx, p.start, 'start'), posParam(ctx, p.end, 'end'), posParam(ctx, p.pos, 'pos'))),
    sel('select.line', 'Select Line', 'Select the line at a position (a click in the selection bar), with the paragraph mark on a last line.',
      s.object({pos: s.optional(POS)}), (S, p, ctx) => M.selectLine(S, posParam(ctx, p.pos, 'pos'))),
    sel('select.text', 'Select Text', 'Select the n-th occurrence of some text in a story (default the caret\'s).',
      s.object({text: s.string({min: 1, max: 10_000}), occurrence: s.optional(s.integer({min: 1})), story: STORY}),
      (S, p) => M.selectText(S, p.text, p.occurrence ?? 1, storyParam(S, p))),
    sel('select.collapse', 'Collapse Selection', 'Collapse the selection to its start (or its end with end:true).', s.object({end: s.optional(s.boolean())}),
      (S, p) => M.collapse(S, !!p.end), {shortcut: 'Escape'}),
  ],
});
