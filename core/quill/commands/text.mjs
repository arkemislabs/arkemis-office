// Typing and deleting (Editing, Insert › Symbols, Layout › Breaks): text.insert and every key
// that edits text.
//
// Translated from wordcraft crates/engine/src/cmd/text.rs (`specs`) with text/autoformat.rs,
// text/enter_tab.rs, text/delete.rs, text/unicode.rs, cmd/tools/typing.rs (AutoCorrect as you type)
// and session/run.rs + session/history.rs (consecutive typing is one "Typing" undo step, closed by
// any other edit or a caret move; an automatic change is its own "AutoFormat" step) at ArtCraft
// commit aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The semantics live in core/quill/lib/text-typing.mjs, text-edit.mjs and text-autocorrect.mjs.
//
// Undo steps: the kernel records one entry per command. Where upstream records the plain typing
// (or Enter) and the AutoFormat after it as two steps, this family calls `ctx.checkpoint` when the
// kernel offers it (design note U-quill-text--integrator--undo-checkpoint); without it the
// keystroke and its AutoFormat are one "AutoFormat" step.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {Document} from '../model/document.mjs';
import {buildOp} from '../model/ops.mjs';
import {open, finish, ready, saveView, UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import * as T from '../lib/text-typing.mjs';
import {SINGLE_BYTE_CODE_PAGES, OEM_CODE_PAGES} from '../model/encoding.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/text.rs', 'crates/engine/src/cmd/text/autoformat.rs',
  'crates/engine/src/cmd/text/enter_tab.rs', 'crates/engine/src/cmd/text/delete.rs', 'crates/engine/src/cmd/text/unicode.rs',
  'crates/engine/src/cmd/tools/typing.rs', 'crates/engine/src/cmd/tools/autocorrect.rs', 'crates/engine/src/cmd.rs']};

const NONE = s.object({});
const selKey = sel => JSON.stringify(sel);
const EDIT_MARKS = 4;

/** Remember the caret as the place of an edit, for Go Back (Session::note_edit). */
export function noteEdit(ctx, S) {
  let at;
  try { at = ctx.model.addressOf(ctx, S.sel.focus); } catch { return; }
  const para = at.replace(/\/t:\d+(-\d+)?$/, '');
  const marks = [...(S.view.editMarks ?? [])];
  if (marks.length && marks[marks.length - 1].replace(/\/t:\d+(-\d+)?$/, '') === para) marks[marks.length - 1] = at;
  else { marks.push(at); while (marks.length > EDIT_MARKS) marks.shift(); }
  S.view.editMarks = marks;
  S.view.goBackStep = 0;
}

/**
 * Run one text edit as upstream's Session runs a command: open, `f(S)`, commit, sel_result.
 * `typing`: the command is typing (merges into the burst). Handles the AutoFormat undo step.
 */
export function runTextEdit(ctx, f, {typing = false, label = null} = {}) {
  const S = open(ctx);
  const before = selKey(S.sel);
  const burstKey = () => `typing:${ctx.docId}:${S.view.burst}`;
  if (typing && S.view.burstSel !== before) S.view.burst = (S.view.burst ?? 0) + 1;
  let split = false;
  // The paragraph as typed is its own undo step when an automatic change follows (autoformat.rs insert).
  S.checkpoint = name => {
    if (typeof ctx.checkpoint !== 'function') return;
    ctx.model.commit(ctx, S.d);
    if (typing) ctx.mergeUndo?.(burstKey());
    ctx.checkpoint(name);
    split = true;
  };
  // Enter's plain paragraph break first, then its AutoFormat (enter_tab.rs enter with undo_step).
  let plainContent = null;
  S.plainFirst = fn => {
    if (typeof ctx.checkpoint !== 'function') return;
    const P = {...S, d: new Document(ctx.doc), sel: {...S.sel}, view: {...S.view}};
    fn(P);
    const op = P.d.takeOp();
    if (op) ctx.change.apply(op);
    ctx.checkpoint(label ?? 'New Paragraph');
    plainContent = ctx.doc;
  };
  const out = f(S);
  if (plainContent) {
    const op = buildOp(plainContent, S.d.c, []);
    if (op) ctx.change.apply(op);
    S.d.takeOp();
  }
  const res = finish(ctx, S, {edit: true, result: out && typeof out === 'object' && !Array.isArray(out) ? out : undefined});
  if (S.autoFormat) {
    ctx.setUndoLabel('AutoFormat');
    S.view.burstSel = null;
  } else if (typing) {
    S.view.burstSel = selKey(S.sel);
    if (!split) ctx.mergeUndo?.(burstKey());
    ctx.setUndoLabel('Typing');
  } else {
    S.view.burstSel = null;
    if (label) ctx.setUndoLabel(label);
  }
  noteEdit(ctx, S);
  // finish() saved the view before the burst bookkeeping: save again.
  saveView(ctx, S);
  return res;
}

const edit = (id, label, description, f, extra = {}) => ({
  id, label, description, risk: 'edit', params: NONE,
  state: ctx => ready(ctx),
  run: ctx => runTextEdit(ctx, f),
  ...extra,
});

const char = (id, label, ch, description, extra = {}) => edit(id, label, description, S => { T.insChar(S, ch); }, extra);

export default defineCommands({
  family: 'text',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'text.insert', label: 'Type Text', risk: 'edit', repeatable: false,
      description: 'Type text at the selection as the keyboard does: smart quotes, lists from "* " / "1. ", dashes and AutoCorrect unless raw; with paragraphs, each line is a paragraph (one undo step, at most 10000 lines).',
      params: s.object({
        text: s.string({max: 16 << 20}),
        raw: s.optional(s.boolean({description: 'No smart quotes, AutoCorrect or AutoFormat'})),
        paragraphs: s.optional(s.boolean({description: 'Each line a paragraph, Enter between'})),
      }),
      state: ctx => ready(ctx),
      run(ctx, p) {
        return runTextEdit(ctx, S => {
          const r = T.insert(S, p.text, {raw: !!p.raw, paragraphs: !!p.paragraphs});
          return r?.transformed ? {transformed: true} : undefined;
        }, {typing: !p.paragraphs});
      },
    },
    edit('text.newParagraph', 'New Paragraph', 'Enter: split the paragraph (an empty list item leaves the list or moves up a level; =rand() and =lorem() type sample text; border, table and heading lines AutoFormat).',
      S => { T.newParagraph(S); }, {shortcut: 'Enter'}),
    char('text.lineBreak', 'Line Break', '\n', 'Shift+Enter: a manual line break.', {shortcut: 'Shift+Enter'}),
    char('text.pageBreak', 'Page Break', String.fromCharCode(0x0C), 'Ctrl+Enter: a page break.', {shortcut: 'Mod+Enter'}),
    char('text.columnBreak', 'Column Break', String.fromCharCode(0x0E), 'Ctrl+Shift+Enter: a column break.', {shortcut: 'Mod+Shift+Enter'}),
    edit('text.tab', 'Tab', 'Tab: the next table cell (a row is added after the last), a list item one level down, an indent at a line start, or a tab character.',
      S => { T.tab(S); }, {shortcut: 'Tab'}),
    edit('text.backTab', 'Shift+Tab', 'Shift+Tab: the previous table cell, a list item one level up, or decrease indent.', S => { T.backTab(S); }, {shortcut: 'Shift+Tab'}),
    char('text.insertTab', 'Tab Character', '\t', 'A tab character, even in a table cell (where Tab moves to the next cell).', {shortcut: 'Mod+Tab'}),
    edit('text.backspace', 'Backspace', 'Delete the selection or the character before the caret; at a paragraph start remove the list number, outdent or join the previous paragraph.',
      S => { T.backspace(S); }, {shortcut: 'Backspace'}),
    edit('text.delete', 'Delete', 'Delete the selection or the character after the caret; at a paragraph end join the next paragraph.', S => { T.del(S); }, {shortcut: 'Delete'}),
    edit('text.deleteWordBack', 'Delete Previous Word', 'Delete back to the start of the word.', S => { T.deleteWordBack(S); }, {shortcut: ['Mod+Backspace', 'Alt+Backspace']}),
    edit('text.deleteWordForward', 'Delete Next Word', 'Delete to the end of the word.', S => { T.deleteWordForward(S); }, {shortcut: ['Mod+Delete', 'Alt+Delete']}),
    char('text.nbsp', 'Nonbreaking Space', '\u00A0', 'A nonbreaking space.', {shortcut: 'Mod+Shift+Space'}),
    char('text.nbHyphen', 'Nonbreaking Hyphen', '\u2011', 'A nonbreaking hyphen.', {shortcut: 'Mod+Shift+-'}),
    char('text.optionalHyphen', 'Optional Hyphen', '\u00AD', 'An optional hyphen (shown only where the line breaks).', {shortcut: 'Mod+-'}),
    edit('text.toggleUnicode', 'Toggle Unicode Character', 'Alt+X: the hex code before the caret (or selected, U+ optional) becomes its character; otherwise the character before the caret becomes its code.',
      S => { T.toggleUnicode(S); }, {shortcut: 'Alt+X'}),
    {
      id: 'text.typeCode', label: 'Type Character Code', risk: 'edit',
      description: 'Alt+numpad: type the character a decimal code names (leading 0: the ANSI code page; otherwise 1–255 the OEM code page; above 255 Unicode).',
      params: s.object({
        code: s.string({min: 1, max: 16, description: 'Decimal digits as typed on the keypad, e.g. "0233"'}),
        ansi: s.optional(s.enum(SINGLE_BYTE_CODE_PAGES, {description: 'The leading-0 code page (default 1252)'})),
        oem: s.optional(s.enum(OEM_CODE_PAGES, {description: 'The OEM code page (default from the locale)'})),
      }),
      state: ctx => ready(ctx),
      run: (ctx, p) => runTextEdit(ctx, S => ({char: T.insertCode(S, p)})),
    },
    char('text.emDash', 'Em Dash', '\u2014', 'An em dash.', {shortcut: 'Mod+Alt+-'}),
    char('text.copyright', 'Copyright Sign', '\u00A9', 'The copyright sign.', {shortcut: 'Mod+Alt+C'}),
    char('text.registered', 'Registered Sign', '\u00AE', 'The registered sign.', {shortcut: 'Mod+Alt+R'}),
    char('text.trademark', 'Trademark Sign', '\u2122', 'The trademark sign.', {shortcut: 'Mod+Alt+T'}),
    char('text.ellipsis', 'Ellipsis', '\u2026', 'An ellipsis.', {shortcut: 'Mod+Alt+.'}),
  ],
});
